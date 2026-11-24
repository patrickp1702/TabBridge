/**
 * profiles.ts — pure (chrome-free) logic for profiles, connectors and page
 * access. Every exposure decision in the extension goes through here so the
 * rules live in one place. Unit-testable in plain Node.
 *
 * Exposure model (design choices, in order):
 *  - A PROFILE is only a named collection of page tools ("*" or a list per
 *    domain). It carries no time windows and never includes ToolBridge.
 *  - A CALLER is a connector script or a page-access grant. It names one
 *    profile and may carry its own `builderUntil` (2-hour ToolBridge grant).
 *    Granting per caller — not per profile — means switching tool-building on
 *    for one agent never widens any other connector or page using the same
 *    profile. The grant is all-or-nothing: all ToolBridge tools or none.
 *  - resolveProfileTools(profile, domains)  = the profile's tools (global
 *    domain/tool toggles act as a kill switch; the profile is what exposes).
 *  - resolveExposedTools(profile, domains, caller) = the above + ToolBridge
 *    while the caller's grant is active. Both connectors (native-bridge) and
 *    pages (service-worker) use it on every tools/list AND every tools/call.
 *  - Multi-DC domains: tools gain an optional `dc` argument and a synthetic
 *    `<Domain>__get_dc_list` tool at exposure time (withDcArg); the worker
 *    strips `dc` before validating and routes the call to that DC's origin.
 *  - A tool's relative `url` and `deferLoading` are carried through untouched:
 *    `url` is used by the worker (navigate first) and the views (grouping),
 *    `deferLoading` becomes `defer_loading` in the MCP tool definition.
 */
import type { Connector, McpBridgeConfig, PageAccess, StoredDomain, StoredTool, ToolProfile, DomainDc } from "../types/plugin.types";
import { type BuilderCallerKind, builtinDomain, isBuilderActive, isBuiltinDomain } from "./builtin";
import type { BuilderGrant } from "../types/plugin.types";
import { MCP_TOOL_NAME_RE, toMcpToolName, type ExposedTool } from "./mcp";

export const MAX_LIFETIME_DAYS = 7;
export const DEFAULT_LIFETIME_DAYS = 1;

export const DEFAULT_RATE_LIMIT_PER_MINUTE = 60;

export const DEFAULT_BRIDGE_CONFIG: McpBridgeConfig = {
  enabled: false,
  lifetimeDays: DEFAULT_LIFETIME_DAYS,
  rateLimitPerMinute: DEFAULT_RATE_LIMIT_PER_MINUTE,
  allowHttpOrigins: false,
  connectors: [],
  pageAccess: [],
};

/**
 * Shapes whatever is in storage into a valid config: missing fields get their
 * defaults, out-of-range numbers are clamped, and records that could never be
 * matched or trusted are dropped. Storage is TRUSTED_CONTEXTS-only, so this is
 * robustness against a half-written or hand-edited value, not a migration.
 */
export function normalizeBridgeConfig(raw: Partial<McpBridgeConfig> | undefined): McpBridgeConfig {
  return {
    enabled: raw?.enabled ?? false,
    lifetimeDays: clampDays(raw?.lifetimeDays ?? DEFAULT_LIFETIME_DAYS),
    rateLimitPerMinute: typeof raw?.rateLimitPerMinute === "number" && Number.isFinite(raw.rateLimitPerMinute) ? Math.max(0, Math.round(raw.rateLimitPerMinute)) : DEFAULT_RATE_LIMIT_PER_MINUTE,
    allowHttpOrigins: raw?.allowHttpOrigins === true,
    // A connector without a token hash can never be matched by lookupConnector: drop it rather than list a dead row.
    connectors: Array.isArray(raw?.connectors) ? raw!.connectors.filter((c) => typeof (c as Connector).tokenHash === "string").map(normalizeGrant) : [], // No I18N
    pageAccess: Array.isArray(raw?.pageAccess) ? raw!.pageAccess.map(normalizeGrant) : [],
  };
}

/** `builderUntil` must be a finite number or absent. */
function normalizeGrant<T extends BuilderGrant>(c: T): T {
  if (c.builderUntil === undefined) return c;
  if (typeof c.builderUntil === "number" && Number.isFinite(c.builderUntil)) return c;
  const { builderUntil: _drop, ...rest } = c; void _drop;
  return rest as T;
}



export function clampDays(v: number): number {
  if (!Number.isFinite(v)) return DEFAULT_LIFETIME_DAYS;
  return Math.min(MAX_LIFETIME_DAYS, Math.max(1, Math.round(v)));
}

/** URL-safe lowercase slug for labels and MCP server keys. */
export function slugify(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""); // No I18N
  return s || "profile"; // No I18N
}

/**
 * Resolves a profile against the current domain config.
 * A tool is exposed when it is in the profile AND still globally enabled
 * (domain + tool toggles act as a kill switch; the profile is what exposes).
 */
/** Name of the synthetic per-domain tool that lists data centres (only for domains with `dcs`). */
export const DC_LIST_TOOL = "get_dc_list"; // No I18N
/** Name of the optional argument added to every tool of a multi-DC domain. */
export const DC_ARG = "dc"; // No I18N

/** Adds the optional `dc` enum argument to a tool's schema for a multi-DC domain. */
export function withDcArg(schema: StoredTool["inputSchema"], d: StoredDomain): StoredTool["inputSchema"] {
  if (!d.dcs?.length) return schema;
  return {
    ...schema,
    properties: { ...schema.properties, [DC_ARG]: { type: "string", description: `Data centre to run in: one of ${d.dcs.map((x) => x.name).join(", ")}. Omit for the default (${d.baseUrl}). Call ${d.name}__${DC_LIST_TOOL} to list them.` } }, // No I18N
  };
}

export function resolveProfileTools(profile: ToolProfile | undefined, domains: StoredDomain[]): ExposedTool[] {
  if (!profile) return [];
  const out: ExposedTool[] = [];
  for (const d of domains) {
    // ToolBridge is never stored and never a profile matter (granted per caller, see resolveExposedTools);
    // a stored domain carrying its name is an impostor and contributes nothing.
    if (isBuiltinDomain(d.name)) continue;
    const sel = profile.domains[d.name];
    if (!sel || !d.enabled) continue;
    let any = false;
    for (const t of d.tools) {
      if (!t.enabled) continue;
      if (sel !== "*" && !sel.includes(t.name)) continue; // No I18N
      const name = toMcpToolName(d.name, t.name);
      if (!MCP_TOOL_NAME_RE.test(name)) continue;
      any = true;
      out.push({ name, domain: d.name, toolName: t.name, description: t.description, inputSchema: withDcArg(t.inputSchema, d), deferLoading: t.deferLoading || undefined });
    }
    // Multi-DC domain: expose the DC list alongside its tools.
    if (any && d.dcs?.length) {
      out.push({
        name: toMcpToolName(d.name, DC_LIST_TOOL), domain: d.name, toolName: DC_LIST_TOOL,
        description: `Lists the data centres available for ${d.name} (default + ${d.dcs.map((x) => x.name).join(", ")}). Pass one as the \`${DC_ARG}\` argument of this domain's tools to run them there.`, // No I18N
        inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false }, // No I18N
      });
    }
  }
  return out;
}

/** The built-in ToolBridge tools as exposed tools (all of them — the grant is all-or-nothing). */
export function builtinExposedTools(): ExposedTool[] {
  const d = builtinDomain();
  return d.tools.map((t) => ({ name: toMcpToolName(d.name, t.name), domain: d.name, toolName: t.name, description: t.description, inputSchema: t.inputSchema }));
}

/**
 * Everything ONE caller (a connector script or a page-access grant) may list
 * and call: its profile's tools, plus the ToolBridge tools while that caller's
 * own 2-hour `builderUntil` grant is active. This is the function every
 * exposure decision for agents goes through.
 */
export function resolveExposedTools(profile: ToolProfile | undefined, domains: StoredDomain[], caller: BuilderGrant | undefined, now = Date.now()): ExposedTool[] {
  const out = resolveProfileTools(profile, domains);
  return isBuilderActive(caller, now) ? [...out, ...builtinExposedTools()] : out;
}

/** True when `domain/toolName` is exposed to the caller (same rule as resolveExposedTools). */
export function isToolAllowed(profile: ToolProfile | undefined, domains: StoredDomain[], caller: BuilderGrant | undefined, domain: string, toolName: string): boolean {
  return resolveExposedTools(profile, domains, caller).some((t) => t.domain === domain && t.toolName === toolName);
}

export type { BuilderCallerKind };

export const isConnectorExpired = (c: Connector, now = Date.now()): boolean => now >= c.expiresAt;
export const isConnectorLive = (c: Connector, now = Date.now()): boolean => c.active && !isConnectorExpired(c, now);

export type ConnectorLookup =
  | { ok: true; connector: Connector }
  | { ok: false; reason: "unknown" | "deactivated" | "expired"; message: string; connector?: Connector }; // No I18N

/** SHA-256 hex of a connector token (the only form the extension ever stores). */
export async function hashToken(token: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)); // No I18N
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join(""); // No I18N
}

/** Finds the connector a (hashed) script token belongs to and says whether it may be served. */
export function lookupConnector(cfg: McpBridgeConfig, tokenHash: string, now = Date.now()): ConnectorLookup {
  const c = tokenHash ? cfg.connectors.find((x) => x.tokenHash === tokenHash) : undefined;
  if (!c) {
    return { ok: false, reason: "unknown", message: "This connector script is not known to the plugin (removed, or from another install). Download a new one from the plugin\u2019s Web MCP page." }; // No I18N
  }
  if (!c.active) {
    return { ok: false, reason: "deactivated", connector: c, message: `Sorry \u2014 connector ${c.label} has been deactivated in the plugin\u2019s Web MCP page. The user can re-activate it there (Connectors → Reactivate); the same script keeps working.` }; // No I18N
  }
  if (isConnectorExpired(c, now)) {
    return { ok: false, reason: "expired", connector: c, message: `Connector ${c.label} expired on ${new Date(c.expiresAt).toISOString()}. The user can extend it in the TabBridge settings (Web MCP → Connectors → Extend) — the same script keeps working; no new download needed.` }; // No I18N
  }
  return { ok: true, connector: c };
}

/** Connector label rule: what the user types in the download dialog, minus prefix/suffix. */
export const CONNECTOR_LABEL_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
/**
 * Caller names the worker uses for non-connector callers ("settings" = the
 * extension's own pages, "page" = a granted page whose origin could not be
 * read). A connector may never be labelled like them, so audit rows and
 * createdBy tags stay unambiguous. Trust itself is NOT derived from the
 * label (executeTool takes an explicit `trusted` flag).
 */
export const RESERVED_CONNECTOR_LABELS: ReadonlySet<string> = new Set(["settings", "page", "tabbridge", "toolbridge"]); // No I18N

/** Derives a connector label from a file name like `tabbridge-connector-<label>.sh` (or a bare label). */
export function labelFromFilename(input: string): string {
  let v = input.trim().toLowerCase();
  v = v.replace(/\.sh$/, "").replace(/^tabbridge-connector-/, ""); // No I18N
  return v.replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48); // No I18N
}

/**
 * Extends (or re-activates) a connector for `days` more days from now. Works on
 * active, deactivated and expired connectors alike — validity is decided here,
 * never by the downloaded script.
 */
/**
 * Extend / Reactivate: new validity window for the SAME script. The ToolBridge
 * grant is deliberately dropped — a connector that comes back from Deactivate
 * or expiry must not silently return with tool-building rights.
 */
export function extendConnector(c: Connector, days: number, now = Date.now()): Connector {
  const { builderUntil: _drop, ...rest } = c; void _drop;
  return { ...rest, active: true, expiresAt: now + clampDays(days) * 86_400_000, extendedAt: now, deactivatedAt: undefined };
}

/** Deactivate: refused from now on, and the ToolBridge grant goes with it (see extendConnector). */
export function deactivateConnector(c: Connector, now = Date.now()): Connector {
  const { builderUntil: _drop, ...rest } = c; void _drop;
  return { ...rest, active: false, deactivatedAt: now };
}

/** Normalises user input ("https://host:1234/path?x") to an origin, or null when invalid. */
export function normalizeOrigin(input: string): string | null {
  const v = input.trim();
  if (!v) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${v}`); // No I18N
    if (u.protocol !== "https:" && u.protocol !== "http:") return null; // No I18N
    // Chrome's URL parser percent-encodes some junk ("not a url" → not%20a%20url); only accept real host names / IPs.
    if (!/^[a-z0-9.-]+$|^\[[0-9a-f:.]+\]$/i.test(u.hostname)) return null; // No I18N
    return u.origin;
  } catch {
    return null;
  }
}

/** The page-access grant for a page origin, if any. */
/** http:// origins other than loopback: script can be injected by anyone on the network path. */
export function isInsecureOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    if (u.protocol !== "http:") return false; // No I18N
    return !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) && !u.hostname.endsWith(".localhost"); // No I18N
  } catch { return false; }
}

/**
 * The grant for an origin, or undefined. A grant on a plain-http origin is
 * ignored unless `allowHttpOrigins` is on, so switching the toggle off
 * neutralises existing http grants immediately (worker and popup both use this).
 */
export function findPageAccess(cfg: McpBridgeConfig, origin: string): PageAccess | undefined {
  if (isInsecureOrigin(origin) && !cfg.allowHttpOrigins) return undefined;
  return cfg.pageAccess.find((p) => p.origin === origin);
}

// ─── Argument validation (F8) ────────────────────────────────────────────────

type SchemaProp = { type?: string; enum?: unknown[] };

function matchesType(v: unknown, type: string | undefined): boolean {
  switch (type) {
    case "string": return typeof v === "string"; // No I18N
    case "number": return typeof v === "number" && Number.isFinite(v); // No I18N
    case "integer": return typeof v === "number" && Number.isInteger(v); // No I18N
    case "boolean": return typeof v === "boolean"; // No I18N
    case "array": return Array.isArray(v); // No I18N
    case "object": return typeof v === "object" && v !== null && !Array.isArray(v); // No I18N
    case "null": return v === null; // No I18N
    default: return true; // unknown / missing type → not enforced
  }
}

/**
 * Minimal structural validation of tool arguments against the stored input
 * schema. Returns a message describing the first violation, or null when OK.
 * Also rejects prototype-polluting keys regardless of schema.
 */
const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

export function validateArgs(schema: StoredTool["inputSchema"] | undefined, args: unknown): string | null {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return "arguments must be a JSON object"; // No I18N
  const a = args as Record<string, unknown>;
  for (const k of Object.keys(a)) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") return `argument name "${k}" is not allowed`; // No I18N
  }
  if (!schema || typeof schema !== "object") return null;
  const props = (schema.properties ?? {}) as Record<string, SchemaProp>;
  for (const r of schema.required ?? []) {
    if (!hasOwn(a, r)) return `missing required argument "${r}"`; // No I18N
  }
  for (const [k, v] of Object.entries(a)) {
    // Own-property lookups only: "toString", "hasOwnProperty", … must not count as declared (inherited from Object.prototype).
    const p = hasOwn(props, k) ? props[k] : undefined;
    if (!p) {
      if (schema.additionalProperties === false) return `unexpected argument "${k}"`; // No I18N
      continue;
    }
    if (!matchesType(v, p.type)) return `argument "${k}" must be of type ${p.type}`; // No I18N
    if (Array.isArray(p.enum) && !p.enum.some((e) => e === v)) return `argument "${k}" must be one of ${p.enum.map(String).join(", ")}`; // No I18N
  }
  return null;
}

// ─── Domain / tool config validation (F7 import, F3 URL shape) ───────────────

export const DC_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,15}$/;

/** Relative page path inside a domain: starts with "/", no scheme/host, optional query. */
export function isRelativeUrl(v: unknown): v is string {
  return typeof v === "string" && /^\/(?!\/)[^\s#]*$/.test(v);
}

/** Absolute http(s) URL check used for baseUrl / startScript. */
export function isHttpUrl(v: unknown): v is string {
  if (typeof v !== "string") return false;
  try { const u = new URL(v); return u.protocol === "http:" || u.protocol === "https:"; } catch { return false; } // No I18N
}

/** True when two URLs share scheme + host + port. Opaque ("null") origins never match anything. */
export function sameOrigin(a: string, b: string): boolean {
  try {
    const oa = new URL(a).origin, ob = new URL(b).origin;
    return oa !== "null" && oa === ob; // No I18N
  } catch { return false; }
}

/** Max age of a relay envelope; older ones are replays of files that sat in the spool (N5). */
export const ENVELOPE_MAX_AGE_S = 120;

/** Sliding-window rate limiter keyed by caller (connector label or page origin). In-memory; the native port keeps the worker alive. */
/**
 * Caps how many FAILED-call audit rows one caller may write per minute, so a
 * granted page or connector cannot flush the 500-row ring with junk calls.
 * Successful calls are never throttled. Suppressed rows are counted and the
 * count is attached to the caller's next written row.
 */
export class DenialThrottle {
  private readonly state = new Map<string, { minute: number; written: number; suppressed: number }>();
  private readonly perMinute: number;
  constructor(perMinute = 5) { this.perMinute = perMinute; }
  /** Returns the number of previously suppressed rows to mention (0 = none), or -1 when this row must be suppressed. */
  admit(caller: string, now = Date.now()): number {
    const minute = Math.floor(now / 60_000);
    let s = this.state.get(caller);
    if (!s || s.minute !== minute) { s = { minute, written: 0, suppressed: s?.suppressed ?? 0 }; this.state.set(caller, s); }
    if (s.written >= this.perMinute) { s.suppressed++; return -1; }
    s.written++;
    const mention = s.suppressed; s.suppressed = 0;
    return mention;
  }
}

export class RateLimiter {
  private readonly windows = new Map<string, number[]>();
  /** Returns null when allowed, or a message when the limit is hit. */
  hit(key: string, perMinute: number, now = Date.now()): string | null {
    if (!perMinute) return null;
    const win = (this.windows.get(key) ?? []).filter((t) => now - t < 60_000);
    if (win.length >= perMinute) { this.windows.set(key, win); return `Rate limit: ${key} may make at most ${perMinute} tool calls per minute.`; } // No I18N
    win.push(now);
    this.windows.set(key, win);
    return null;
  }
}

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]); // No I18N

/**
 * Validates an imported / edited domain list. Returns the list of problems
 * (empty = valid). Strict on types and URL shape, tolerant on optional fields.
 */
export function validateDomains(input: unknown): string[] {
  const problems: string[] = [];
  if (!Array.isArray(input)) return ["domains must be an array"]; // No I18N
  const seen = new Set<string>();
  input.forEach((d, i) => {
    const where = `domains[${i}]`; // No I18N
    if (typeof d !== "object" || d === null || Array.isArray(d)) { problems.push(`${where} is not an object`); return; } // No I18N
    const dom = d as Record<string, unknown>;
    for (const k of Object.keys(dom)) if (FORBIDDEN_KEYS.has(k)) problems.push(`${where} has forbidden key ${k}`); // No I18N
    if (typeof dom["name"] !== "string" || !dom["name"].trim()) problems.push(`${where}.name must be a non-empty string`); // No I18N
    else if (isBuiltinDomain(dom["name"].trim())) problems.push(`"${dom["name"]}" is reserved for the built-in domain`); // No I18N
    else if (seen.has(dom["name"])) problems.push(`duplicate domain name "${dom["name"]}"`); // No I18N
    else seen.add(dom["name"]);
    if (!isHttpUrl(dom["baseUrl"])) problems.push(`${where}.baseUrl must be an absolute http(s) URL`); // No I18N
    if (!isHttpUrl(dom["startScript"])) problems.push(`${where}.startScript must be an absolute http(s) URL`); // No I18N
    if (dom["domainScript"] !== undefined && typeof dom["domainScript"] !== "string") problems.push(`${where}.domainScript must be a string`); // No I18N
    if (dom["enabled"] !== undefined && typeof dom["enabled"] !== "boolean") problems.push(`${where}.enabled must be a boolean`); // No I18N
    if (dom["dcs"] !== undefined) { // No I18N
      if (!Array.isArray(dom["dcs"])) problems.push(`${where}.dcs must be an array`); // No I18N
      else {
        const names = new Set<string>();
        (dom["dcs"] as unknown[]).forEach((dc, k) => {
          const dw = `${where}.dcs[${k}]`; // No I18N
          if (typeof dc !== "object" || dc === null) { problems.push(`${dw} is not an object`); return; } // No I18N
          const o = dc as Record<string, unknown>;
          if (typeof o["name"] !== "string" || !DC_NAME_RE.test(o["name"])) problems.push(`${dw}.name must match ${DC_NAME_RE}`); // No I18N
          else if (names.has(o["name"]) || o["name"] === "default") problems.push(`${dw}.name "${o["name"]}" is duplicated or reserved`); // No I18N
          else names.add(o["name"]);
          if (!isHttpUrl(o["baseUrl"])) problems.push(`${dw}.baseUrl must be an absolute http(s) URL`); // No I18N
          else if (typeof dom["baseUrl"] === "string" && isHttpUrl(dom["baseUrl"]) && sameOrigin(o["baseUrl"] as string, dom["baseUrl"])) problems.push(`${dw}.baseUrl must differ from the domain's baseUrl`); // No I18N
        });
      }
    }
    if (!Array.isArray(dom["tools"])) { problems.push(`${where}.tools must be an array`); return; } // No I18N
    const toolNames = new Set<string>();
    (dom["tools"] as unknown[]).forEach((t, j) => {
      const tw = `${where}.tools[${j}]`; // No I18N
      if (typeof t !== "object" || t === null || Array.isArray(t)) { problems.push(`${tw} is not an object`); return; } // No I18N
      const tool = t as Record<string, unknown>;
      for (const k of Object.keys(tool)) if (FORBIDDEN_KEYS.has(k)) problems.push(`${tw} has forbidden key ${k}`); // No I18N
      if (typeof tool["name"] !== "string" || !tool["name"].trim()) problems.push(`${tw}.name must be a non-empty string`); // No I18N
      else if (toolNames.has(tool["name"])) problems.push(`${where}: duplicate tool name "${tool["name"]}"`); // No I18N
      else toolNames.add(tool["name"]);
      if (tool["description"] !== undefined && typeof tool["description"] !== "string") problems.push(`${tw}.description must be a string`); // No I18N
      if (typeof tool["toolScript"] !== "string") problems.push(`${tw}.toolScript must be a string`); // No I18N
      if (tool["enabled"] !== undefined && typeof tool["enabled"] !== "boolean") problems.push(`${tw}.enabled must be a boolean`); // No I18N
      if (tool["requireConfirmation"] !== undefined && typeof tool["requireConfirmation"] !== "boolean") problems.push(`${tw}.requireConfirmation must be a boolean`); // No I18N
      if (tool["deferLoading"] !== undefined && typeof tool["deferLoading"] !== "boolean") problems.push(`${tw}.deferLoading must be a boolean`); // No I18N
      if (tool["url"] !== undefined && tool["url"] !== "" && !isRelativeUrl(tool["url"])) problems.push(`${tw}.url must be a relative path starting with "/" (no scheme or host)`); // No I18N
      if (typeof tool["name"] === "string" && tool["name"] === DC_LIST_TOOL) problems.push(`${tw}.name "${DC_LIST_TOOL}" is reserved`); // No I18N
      const sch = tool["inputSchema"];
      if (sch !== undefined && (typeof sch !== "object" || sch === null || (sch as Record<string, unknown>)["type"] !== "object")) problems.push(`${tw}.inputSchema must be an object schema with type "object"`); // No I18N
    });
  });
  // MCP names are derived (sanitised + truncated), so distinct domain/tool pairs can collide; the first match would
  // silently win in tools/call and run another domain's script. Refuse the config instead.
  if (!problems.length) {
    const mcp = new Map<string, string>();
    for (const d of input as StoredDomain[]) {
      const names = d.tools.map((t) => t.name).concat(d.dcs?.length ? [DC_LIST_TOOL] : []);
      for (const n of names) {
        const key = toMcpToolName(d.name, n), pair = `${d.name}/${n}`;
        const prev = mcp.get(key);
        if (prev) problems.push(`MCP tool name "${key}" is produced by both ${prev} and ${pair}; rename one`); // No I18N
        else mcp.set(key, pair);
      }
    }
  }
  return problems;
}

/**
 * Fills optional fields so downstream code can rely on them. Call after validateDomains passed.
 * With `quarantine` (imports) every domain and tool comes in DISABLED and with confirmation on,
 * so a shared file can never be exposed to agents before the user looked at it.
 */
export function normalizeDomains(input: StoredDomain[], quarantine = false): StoredDomain[] {
  return input.map((d) => ({
    name: d.name.trim(),
    baseUrl: d.baseUrl,
    startScript: d.startScript,
    domainScript: d.domainScript ?? "",
    enabled: quarantine ? false : (d.enabled ?? false),
    dcs: d.dcs?.map((x) => ({ name: x.name.trim(), baseUrl: x.baseUrl })),
    tools: d.tools.map((t) => ({
      name: t.name.trim(),
      description: t.description ?? "",
      inputSchema: t.inputSchema ?? { type: "object", properties: {}, required: [], additionalProperties: false }, // No I18N
      toolScript: t.toolScript,
      enabled: quarantine ? false : (t.enabled ?? true),
      requireConfirmation: quarantine ? true : (t.requireConfirmation ?? false),
      url: t.url || undefined,
      deferLoading: t.deferLoading || undefined,
    })),
  }));
}

/**
 * Group tools for display: tools bound to no page first, then one group per
 * relative `url` (insertion order). Views render each group as a collapsible
 * sub-heading, open by default.
 */
export function groupToolsByUrl<T extends { url?: string }>(tools: readonly T[]): { top: T[]; groups: Array<{ url: string; tools: T[] }> } {
  const top: T[] = [];
  const byUrl = new Map<string, T[]>();
  for (const t of tools) {
    if (!t.url) { top.push(t); continue; }
    const list = byUrl.get(t.url) ?? [];
    list.push(t);
    byUrl.set(t.url, list);
  }
  return { top, groups: [...byUrl].map(([url, list]) => ({ url, tools: list })) };
}

/** Parse the DC editor textarea: one `name = https://origin` per line; blank lines and `#` comments ignored. */
export function parseDcLines(text: string): { dcs: DomainDc[]; error?: string } {
  const dcs: DomainDc[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue; // No I18N
    const m = /^([^=\s]+)\s*=\s*(\S+)$/.exec(line);
    if (!m) return { dcs, error: `Bad DC line "${line}" — use  name = https://host` }; // No I18N
    dcs.push({ name: m[1]!, baseUrl: m[2]! });
  }
  return { dcs };
}

export function formatDcLines(dcs: DomainDc[] | undefined): string {
  return (dcs ?? []).map((d) => `${d.name} = ${d.baseUrl}`).join("\n"); // No I18N
}
