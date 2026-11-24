/**
 * storage.ts — the one place that reads/writes the plugin's config. Shared by
 * popup, settings page, content scripts and the service worker so the shape
 * never drifts.
 *
 * Everything lives in chrome.storage.local, never storage.sync: tool scripts
 * may embed CSRF tokens / internal URLs, so they must not sync to the Google
 * account, and sync's 8 KB-per-item quota would make saves fail silently.
 * Sharing is done through Export / Import on the settings page. The worker
 * sets the access level to TRUSTED_CONTEXTS, so content scripts can never
 * read or write any of this.
 */
import type { AuditEntry, McpBridgeConfig, PluginStorage, StoredDomain, StoredTool, ToolProfile } from "../types/plugin.types";
import { DenialThrottle, normalizeBridgeConfig } from "./profiles";

export const DOMAINS_KEY = "domains"; // No I18N

export async function loadDomains(): Promise<StoredDomain[]> {
  const storage = (await chrome.storage.local.get(DOMAINS_KEY)) as Partial<PluginStorage>;
  return storage.domains ?? [];
}

/** Persists domains. Throws a readable Error when Chrome rejects the write (quota, etc.). */
export async function saveDomains(domains: StoredDomain[]): Promise<void> {
  try {
    await chrome.storage.local.set({ domains } satisfies PluginStorage);
  } catch (e) {
    throw new Error(`Could not save: ${chrome.runtime.lastError?.message ?? String(e)}`); // No I18N
  }
}

export function blankDomain(): StoredDomain {
  return { name: "", baseUrl: "", startScript: "", domainScript: "", enabled: false, tools: [] };
}

export function blankTool(): StoredTool {
  return {
    name: "",
    description: "",
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false }, // No I18N
    toolScript: "",
    enabled: true,
  };
}

/** Default schema text shown in empty schema editors. */
export const DEFAULT_SCHEMA_JSON = '{\n  "type": "object",\n  "properties": {},\n  "required": [],\n  "additionalProperties": false\n}'; // No I18N

// ─── Profiles (chrome.storage.local["profiles"]) ─────────────────────────────

export const PROFILES_KEY = "profiles"; // No I18N

export async function loadProfiles(): Promise<ToolProfile[]> {
  const stored = (await chrome.storage.local.get(PROFILES_KEY))[PROFILES_KEY] as ToolProfile[] | undefined;
  return Array.isArray(stored) ? stored : [];
}

export async function saveProfiles(profiles: ToolProfile[]): Promise<void> {
  await chrome.storage.local.set({ [PROFILES_KEY]: profiles });
}

export function newId(bytes = 8): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(""); // No I18N
}

export function blankProfile(name = ""): ToolProfile {
  return { id: newId(), name, description: "", domains: {}, createdAt: Date.now() };
}

// ─── Web MCP bridge config (chrome.storage.local["mcpBridge"]) ───────────────

export const MCP_BRIDGE_CONFIG_KEY = "mcpBridge"; // No I18N

export async function loadBridgeConfig(): Promise<McpBridgeConfig> {
  const stored = (await chrome.storage.local.get(MCP_BRIDGE_CONFIG_KEY))[MCP_BRIDGE_CONFIG_KEY] as Partial<McpBridgeConfig> | undefined;
  return normalizeBridgeConfig(stored);
}

export async function saveBridgeConfig(cfg: McpBridgeConfig): Promise<void> {
  await chrome.storage.local.set({ [MCP_BRIDGE_CONFIG_KEY]: cfg });
}

// ─── Connector usage stats (chrome.storage.local["connectorStats"]) ──────────
// Kept apart from mcpBridge so bookkeeping writes can never overwrite a
// Deactivate / Remove / grant change the user made meanwhile (lost-update race).

export const CONNECTOR_STATS_KEY = "connectorStats"; // No I18N
export interface ConnectorStats { requests: number; lastSeenAt: number }

export async function loadConnectorStats(): Promise<Record<string, ConnectorStats>> {
  const stored = (await chrome.storage.local.get(CONNECTOR_STATS_KEY))[CONNECTOR_STATS_KEY] as Record<string, ConnectorStats> | undefined;
  return stored && typeof stored === "object" ? stored : {};
}

export async function bumpConnectorStats(connectorId: string): Promise<void> {
  const all = await loadConnectorStats();
  const cur = all[connectorId] ?? { requests: 0, lastSeenAt: 0 };
  all[connectorId] = { requests: cur.requests + 1, lastSeenAt: Date.now() };
  await chrome.storage.local.set({ [CONNECTOR_STATS_KEY]: all });
}

// ─── Agent call audit log (chrome.storage.local["mcpAudit"]) ─────────────────

export const AUDIT_KEY = "mcpAudit"; // No I18N
/** Ring size: once full, the oldest rows are dropped on every append. */
export const AUDIT_MAX = 500;

export async function loadAudit(): Promise<AuditEntry[]> {
  const stored = (await chrome.storage.local.get(AUDIT_KEY))[AUDIT_KEY] as AuditEntry[] | undefined;
  return Array.isArray(stored) ? stored : [];
}

let auditQueue: Promise<void> = Promise.resolve();

/** Audit rows are written for caller-supplied names too; bound every field so no caller can bloat storage. */
function boundAudit(e: AuditEntry): AuditEntry {
  return { ...e, caller: String(e.caller).slice(0, 128), domain: String(e.domain).slice(0, 64), tool: String(e.tool).slice(0, 64), argsPreview: String(e.argsPreview).slice(0, 160), error: e.error === undefined ? undefined : String(e.error).slice(0, 300) };
}

/** Failed-call rows per caller per minute (successful calls are always written). */
const denialThrottle = new DenialThrottle(5);

/**
 * Writes an audit row, but failed calls go through the per-caller throttle:
 * beyond 5 failures a minute the row is dropped and counted, and the count is
 * appended to that caller's next written failure. Keeps the ring meaningful
 * under a flood of bogus calls from a granted page or connector.
 */
export function appendAuditThrottled(entry: AuditEntry): Promise<void> {
  if (entry.ok) return appendAudit(entry);
  const mention = denialThrottle.admit(String(entry.caller));
  if (mention < 0) return Promise.resolve();
  return appendAudit(mention ? { ...entry, error: `${entry.error ?? ""} (+${mention} earlier failure${mention === 1 ? "" : "s"} from this caller not logged)` } : entry); // No I18N
}

/** Appends serially so concurrent calls cannot lose entries (read-modify-write); keeps the newest AUDIT_MAX rows. */
export function appendAudit(entryIn: AuditEntry): Promise<void> {
  const entry = boundAudit(entryIn);
  auditQueue = auditQueue.then(async () => {
    const list = await loadAudit();
    list.push(entry);
    await chrome.storage.local.set({ [AUDIT_KEY]: list.slice(-AUDIT_MAX) });
  }).catch(() => {});
  return auditQueue;
}

/** Audit a call refused before execution (not granted / not in profile / stale). */
export function auditDenied(caller: string, domain: string, toolName: string, args: unknown, reason: string): void {
  void appendAuditThrottled({ t: Date.now(), caller, domain, tool: toolName, argsPreview: JSON.stringify(args ?? {}).slice(0, 160), ok: false, ms: 0, error: reason.slice(0, 300) });
}

export async function clearAudit(): Promise<void> {
  await chrome.storage.local.remove(AUDIT_KEY);
}
