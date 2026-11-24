/**
 * service-worker.ts — MV3 background service worker.
 *
 * Responsibilities:
 *  1. Storage: everything in chrome.storage.local, locked to TRUSTED_CONTEXTS.
 *     (No domains are seeded — import examples/sample-domain.json or add your own.)
 *  2. TOOL_EXECUTE: ONLY from extension pages (settings "Run") or from a page
 *     whose origin has a page-access grant whose profile includes the tool.
 *     Agent calls (pages, connectors) go through executeAgentCall: schema
 *     validation → optional user confirmation (approval window) → audit
 *     log → executeTool.
 *  3. executeTool: resolve stored scripts → open / reuse the domain tab (origin
 *     re-checked right before running) → chrome.userScripts.execute() in the
 *     MAIN world → result.
 *  4. chrome.tabs.onUpdated: map a loaded tab to a domain by exact origin.
 *  5. OPEN_DOMAIN_TAB / CLOSE_DOMAIN_TAB (extension pages only).
 *  6. Web MCP bridge (native-bridge.ts + mcp-server.ts).
 */
import type { RuntimeMessage, RuntimeResponse, RtPageToolsResponse } from "../utils/message";
import type { AuditEntry, PluginStorage, SessionState, StoredDomain } from "../types/plugin.types";
import { installNativeBridge } from "./native-bridge";
import { runBuiltinTool } from "./builtin-tools";
import { confirmWithUser } from "./confirm";
import { builderDeniedMessage, builtinDomain, isBuiltinDomain, purgeExpiredBuilderGrants, withBuiltinDomain } from "../utils/builtin";
import { DC_ARG, DC_LIST_TOOL, findPageAccess, RateLimiter, resolveExposedTools, sameOrigin, validateArgs } from "../utils/profiles";
import { appendAuditThrottled, auditDenied, loadBridgeConfig, saveBridgeConfig, loadDomains, loadProfiles, MCP_BRIDGE_CONFIG_KEY, saveDomains, saveProfiles } from "../utils/storage";

// ─── Default domains ──────────────────────────────────────────────────────────

/** TabBridge ships no domains. Import `examples/sample-domain.json` or add your own in Settings. */
const DEFAULT_DOMAINS: StoredDomain[] = [];

// ─── Storage helpers ──────────────────────────────────────────────────────────

async function getStoredDomains(): Promise<StoredDomain[]> {
  const storage = (await chrome.storage.local.get("domains")) as Partial<PluginStorage>; // No I18N
  return storage.domains ?? DEFAULT_DOMAINS;
}

async function getSessionTabs(): Promise<Record<string, number>> {
  const result = (await chrome.storage.session.get("sessionTabs")) as Partial<SessionState>; // No I18N
  return result.sessionTabs ?? {};
}

async function setSessionTabs(tabs: Record<string, number>): Promise<void> {
  await chrome.storage.session.set({ sessionTabs: tabs }); // No I18N
}

// ─── Owned tabs + tab group ──────────────────────────────────────────────────
// Only tabs this extension created are ever used to run tools (see
// SessionState.ownedTabs). They are also collected in one "TabBridge" tab group
// where the browser supports tab groups, so the user sees at a glance which tabs
// belong to agents. Grouping is best-effort: a failure never fails a tool call.

const TAB_GROUP_TITLE = "TabBridge"; // No I18N

async function getOwnedTabs(): Promise<Set<number>> {
  const r = (await chrome.storage.session.get("ownedTabs")) as Partial<SessionState>; // No I18N
  return new Set(r.ownedTabs ?? []);
}

async function markOwned(tabId: number, owned: boolean): Promise<void> {
  const set = await getOwnedTabs();
  if (owned) set.add(tabId); else set.delete(tabId);
  await chrome.storage.session.set({ ownedTabs: [...set] }); // No I18N
}

/** Adds the tab to the extension's tab group, creating the group when missing or gone. */
async function groupOwnedTab(tabId: number): Promise<void> {
  const api = chrome as unknown as { tabGroups?: { update(id: number, p: { title?: string; color?: string }): Promise<unknown> }; tabs: { group?(o: { tabIds: number[]; groupId?: number }): Promise<number> } };
  if (!api.tabGroups || !api.tabs.group) return;   // browser without tab groups
  try {
    const r = (await chrome.storage.session.get("tabGroupId")) as Partial<SessionState>; // No I18N
    let groupId = r.tabGroupId;
    if (groupId !== undefined) {
      try { await api.tabs.group({ tabIds: [tabId], groupId }); return; } catch { /* group was closed: create a new one */ }
    }
    groupId = await api.tabs.group({ tabIds: [tabId] });
    await api.tabGroups.update(groupId, { title: TAB_GROUP_TITLE, color: "blue" }); // No I18N
    await chrome.storage.session.set({ tabGroupId: groupId }); // No I18N
  } catch { /* grouping is cosmetic */ }
}

// ─── Install / update: merge built-in defaults (currently none) ──────────────

async function mergeDefaults(): Promise<void> {
  const existing = await loadDomains();
  if (!existing.length) { await saveDomains(DEFAULT_DOMAINS); return; }
  let dirty = false;
  const merged = [...existing];
  for (const defaultDomain of DEFAULT_DOMAINS) {
    const stored = merged.find((d) => d.name === defaultDomain.name);
    if (!stored) { merged.push(defaultDomain); dirty = true; continue; }
    for (const defaultTool of defaultDomain.tools) {
      if (!stored.tools.find((t) => t.name === defaultTool.name)) { stored.tools.push(defaultTool); dirty = true; }
    }
  }
  if (dirty) await saveDomains(merged);
}

chrome.runtime.onInstalled.addListener(() => { void mergeDefaults(); });

// ToolBridge grants (per connector / per page grant) expire after 2 h: clear them so the
// Web MCP switches visibly turn off. Resolution ignores elapsed grants regardless. Runs at start and every minute.
const BUILDER_EXPIRY_ALARM = "builder-grant-expiry"; // No I18N
async function purgeBuilderGrants(): Promise<void> {
  const { cfg, changed } = purgeExpiredBuilderGrants(await loadBridgeConfig());
  if (changed) await saveBridgeConfig(cfg);
}
void chrome.alarms.create(BUILDER_EXPIRY_ALARM, { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === BUILDER_EXPIRY_ALARM) void purgeBuilderGrants(); });
void purgeBuilderGrants();

// storage.local holds scripts, grants and token hashes. Content scripts run on
// every site; a compromised renderer must not be able to read or rewrite that.
// With TRUSTED_CONTEXTS only extension pages and this worker can access it.
void chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }).catch(() => {}); // No I18N

// Push "config changed" to tabs whose origin has (or just lost) a page-access grant,
// so their content script re-asks PAGE_TOOLS. The message carries no data.
async function notifyGrantedTabs(origins: Set<string>): Promise<void> {
  if (!origins.size) return;
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map(async (t) => {
    if (!t.id || !t.url) return;
    let origin: string;
    try { origin = new URL(t.url).origin; } catch { return; }
    if (!origins.has(origin)) return;
    try { await chrome.tabs.sendMessage(t.id, { type: "TOOLS_CHANGED" }); } catch { /* no content script in this tab */ } // No I18N
  }));
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return; // No I18N
  const origins = new Set<string>();
  const bridgeChange = changes[MCP_BRIDGE_CONFIG_KEY];
  if (bridgeChange) {
    for (const v of [bridgeChange.oldValue, bridgeChange.newValue] as (Partial<import("../types/plugin.types").McpBridgeConfig> | undefined)[]) {
      for (const g of v?.pageAccess ?? []) origins.add(g.origin);
    }
  }
  if (changes["domains"] || changes["profiles"]) { // No I18N
    void loadBridgeConfig().then((cfg) => notifyGrantedTabs(new Set([...origins, ...cfg.pageAccess.map((g) => g.origin)])));
    return;
  }
  if (origins.size) void notifyGrantedTabs(origins);
});

// ─── Domain tabs ──────────────────────────────────────────────────────────────

const domainInitializedTabs = new Set<number>();

/**
 * Where a call runs: the domain's default origin, or one of its data centres.
 * `key` is the session-tab map key; `origin` the origin the tab must be on;
 * `startUrl` the page opened to establish the session (domain startScript
 * re-based onto the DC origin).
 */
interface Target { key: string; name: string; origin: string; startUrl: string }

function targetFor(domain: StoredDomain, dc?: string): Target {
  const base = new URL(domain.baseUrl);
  if (!dc) return { key: domain.name, name: domain.name, origin: base.origin, startUrl: domain.startScript };
  const d = domain.dcs?.find((x) => x.name === dc);
  if (!d) throw new Error(`Unknown dc "${dc}" for ${domain.name}. Call ${domain.name}__${DC_LIST_TOOL}.`); // No I18N
  const dcOrigin = new URL(d.baseUrl).origin;
  const start = new URL(domain.startScript);
  return { key: `${domain.name}@${dc}`, name: `${domain.name} (${dc})`, origin: dcOrigin, startUrl: dcOrigin + start.pathname + start.search }; // No I18N
}

async function openDomainTab(t: Target): Promise<number> {
  const tab = await chrome.tabs.create({ url: t.startUrl, active: false });
  await markOwned(tab.id!, true);
  await groupOwnedTab(tab.id!);
  return tab.id!;
}

async function waitForTabLoad(tabId: number, timeoutMs = 15_000): Promise<chrome.tabs.Tab> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let tab: chrome.tabs.Tab;
    try { tab = await chrome.tabs.get(tabId); } catch { throw new Error(`Tab ${tabId} not found while waiting for load`); } // No I18N
    if (tab.status === "complete") return tab; // No I18N
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Tab ${tabId} did not finish loading within ${timeoutMs}ms`); // No I18N
}

/** Tab currently at the target origin — a cached tab that navigated away is dropped and a fresh one opened. */
async function tabOnOrigin(tabId: number, origin: string): Promise<boolean> {
  try {
    const tab = await chrome.tabs.get(tabId);
    return !!tab.url && sameOrigin(tab.url, origin);
  } catch { return false; }
}

async function getOrOpenTab(t: Target): Promise<number> {
  const tabs = await getSessionTabs();
  const existingTabId = tabs[t.key];
  if (existingTabId !== undefined) {
    try {
      await waitForTabLoad(existingTabId);
      if (await tabOnOrigin(existingTabId, t.origin)) return existingTabId;
    } catch { /* fall through: open a new one */ }
    domainInitializedTabs.delete(existingTabId);
    delete tabs[t.key];
    await setSessionTabs(tabs);
  }
  const tabId = await openDomainTab(t);
  tabs[t.key] = tabId;
  await setSessionTabs(tabs);
  await waitForTabLoad(tabId);
  if (!(await tabOnOrigin(tabId, t.origin))) {
    // Landed on another origin (SSO redirect?): drop it so every call does not spawn one more tab.
    delete tabs[t.key];
    await setSessionTabs(tabs);
    try { await chrome.tabs.remove(tabId); } catch { /* already gone */ }
    throw new Error(`Tab for ${t.name} did not land on ${t.origin} (redirected to a login page?). Sign in to that domain first.`); // No I18N
  }
  return tabId;
}

/**
 * Tools can declare the page they need (relative `url`). If the tab is not on it,
 * navigate there and wait; the page reloads, so the domain bootstrap must run again.
 */
/** True when the tab is on `origin + relUrl` (path, and query when the url has one). No relUrl = any page. */
async function tabOnPage(tabId: number, t: Target, relUrl: string | undefined): Promise<boolean> {
  if (!relUrl) return true;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url || !sameOrigin(tab.url, t.origin)) return false;
    const cur = new URL(tab.url), want = new URL(t.origin + relUrl);
    return cur.pathname === want.pathname && (!want.search || cur.search === want.search);
  } catch { return false; }
}

async function ensureToolPage(tabId: number, t: Target, relUrl: string | undefined): Promise<void> {
  if (!relUrl || (await tabOnPage(tabId, t, relUrl))) return;
  await chrome.tabs.update(tabId, { url: t.origin + relUrl });
  await new Promise((r) => setTimeout(r, 300));
  try {
    await waitForTabLoad(tabId);
    domainInitializedTabs.delete(tabId);
    // A same-origin redirect (login page) is not the requested page: fail instead of running there.
    if (!(await tabOnPage(tabId, t, relUrl))) throw new Error(`Tab for ${t.name} did not reach ${relUrl} (redirected?). Sign in to that domain first.`); // No I18N
  } catch (e) {
    // Never leave an owned tab parked wherever the navigation ended (possibly a foreign origin): drop and close it,
    // exactly like getOrOpenTab does for a start URL that redirects away.
    await dropTab(t.key, tabId);
    throw e;
  }
}

/** Forgets and closes a tool tab (mapping, ownership, bootstrap flag). */
async function dropTab(key: string, tabId: number): Promise<void> {
  domainInitializedTabs.delete(tabId);
  const tabs = await getSessionTabs();
  if (tabs[key] === tabId) { delete tabs[key]; await setSessionTabs(tabs); }
  await markOwned(tabId, false);
  try { await chrome.tabs.remove(tabId); } catch { /* already gone */ }
}

// Map loaded tabs to targets by EXACT origin — but only tabs this extension opened.
// A tab some website opened on the domain origin is never adopted (the opener could
// pre-load a chosen page, navigate it between check and run, or close it).
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === "loading") domainInitializedTabs.delete(tabId);   // page reloaded / navigated: bootstrap again // No I18N
  if (info.status !== "complete" || !tab.url) return; // No I18N
  void (async () => {
    if (!(await getOwnedTabs()).has(tabId)) return;
    const domains = await getStoredDomains();
    let target: Target | undefined;
    for (const d of domains) {
      if (sameOrigin(tab.url!, d.baseUrl)) { target = targetFor(d); break; }
      const dc = d.dcs?.find((x) => sameOrigin(tab.url!, x.baseUrl));
      if (dc) { target = targetFor(d, dc.name); break; }
    }
    if (!target) return;
    const tabs = await getSessionTabs();
    const current = tabs[target.key];
    if (current !== undefined && current !== tabId && (await tabOnOrigin(current, target.origin))) return; // keep the existing live tab
    tabs[target.key] = tabId;
    await setSessionTabs(tabs);
  })();
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  domainInitializedTabs.delete(tabId);
  await markOwned(tabId, false);
  const tabs = await getSessionTabs();
  const domainName = Object.keys(tabs).find((k) => tabs[k] === tabId);
  if (domainName) { delete tabs[domainName]; await setSessionTabs(tabs); }
});

// ─── Script runner ────────────────────────────────────────────────────────────

/**
 * Runs a snippet with `args` in scope inside the domain tab via
 * chrome.userScripts.execute() (Chrome 135+, "Allow user scripts" toggle).
 * MAIN world: tools need the page's globals (CSRF tokens etc.).
 * `args` is embedded as a JSON literal — valid JS, no JSON.parse the page could patch.
 */
async function runScriptInTab(tabId: number, scriptStr: string, args: Record<string, unknown>, expectedOrigin: string): Promise<unknown> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userScriptsApi = (chrome as any).userScripts as { execute: (i: unknown) => Promise<Array<{ result?: unknown; error?: unknown }>> } | undefined;
  if (!userScriptsApi?.execute) {
    throw new Error( // No I18N
      "Script execution requires 'Allow user scripts' to be enabled.\n" + // No I18N
      "Go to chrome://extensions → click this extension → enable 'Allow user scripts'.\n" + // No I18N
      "Then reload the extension and refresh the page." // No I18N
    );
  }
  // The tab was origin-checked a moment ago, but it may navigate in between (TOCTOU). `location.origin`
  // is [LegacyUnforgeable], so this guard holds even in the MAIN world of a hostile document.
  const guard = `if (location.origin !== ${JSON.stringify(expectedOrigin)}) throw new Error("TabBridge: domain tab is at " + location.origin + ", expected ${expectedOrigin}");`; // No I18N
  const code = `(async function(args){ ${guard}\n${scriptStr}\n})(${JSON.stringify(args)})`; // No I18N
  const [injection] = await userScriptsApi.execute({
    target: { tabId },
    world: "MAIN", // No I18N
    injectImmediately: true,
    js: [{ code }],
  });
  // A script that throws (or whose promise rejects) comes back as `error`, not as a rejected
  // execute() call. Surface it — swallowing it made failures look like a `null` result.
  const err = (injection as { error?: unknown } | undefined)?.error;
  if (err) {
    const msg = typeof err === "object" && err !== null && "message" in err ? String((err as { message: unknown }).message) : String(err);
    throw new Error(`Tool script failed in the domain tab: ${msg}`); // No I18N
  }
  if (!injection) throw new Error("Tool script produced no result (the domain tab navigated or closed while it was running)."); // No I18N
  return injection.result ?? null;
}

async function ensureDomainInit(tabId: number, domain: StoredDomain, origin: string): Promise<void> {
  if (domainInitializedTabs.has(tabId)) return;
  if (domain.domainScript.trim()) await runScriptInTab(tabId, domain.domainScript, {}, origin);
  domainInitializedTabs.add(tabId);
}

// ─── Tool execution (settings page, granted pages, Web MCP connectors) ─────────

/**
 * Resolves the stored domain/tool, validates args against the schema, opens or
 * reuses the domain tab (origin-checked), runs the domain bootstrap once, then
 * executes the tool script. Scripts are read at call time so edits are live.
 */
/**
 * `trusted` is true ONLY for the extension's own pages (settings "Run"): the
 * user is the caller, so ToolBridge actions skip the approval window. It is an
 * explicit flag, never derived from the caller label — a connector cannot earn
 * it by being named "settings" (that label is reserved anyway).
 */
export async function executeTool(domain: string, toolName: string, args: Record<string, unknown>, caller: string, trusted = false): Promise<unknown> {
  if (isBuiltinDomain(domain)) {
    const tool = builtinDomain().tools.find((t) => t.name === toolName);
    if (!tool) throw new Error(`Tool not found: ${toolName}`); // No I18N
    const problem = validateArgs(tool.inputSchema, args);
    if (problem) throw new Error(`Invalid arguments for ${toolName}: ${problem}`); // No I18N
    return runBuiltinTool(
      { loadDomains, saveDomains, loadProfiles, saveProfiles, loadBridgeConfig, confirm: trusted ? async () => true : confirmWithUser },
      caller, toolName, args,
    );
  }
  const domains = await getStoredDomains();
  const storedDomain = domains.find((d) => d.name === domain);
  if (!storedDomain) throw new Error(`Domain not found: ${domain}`); // No I18N
  // Synthetic per-domain tool: list the data centres (no tab involved).
  if (toolName === DC_LIST_TOOL) {
    if (!storedDomain.dcs?.length) throw new Error(`${domain} has no data centres configured.`); // No I18N
    return { domain, default: { name: "default", baseUrl: new URL(storedDomain.baseUrl).origin }, dcs: storedDomain.dcs.map((x) => ({ name: x.name, baseUrl: new URL(x.baseUrl).origin })), note: `Pass one of the dc names as the "${DC_ARG}" argument of ${domain} tools; omit it for the default.` }; // No I18N
  }
  const storedTool = storedDomain.tools.find((t) => t.name === toolName);
  if (!storedTool) throw new Error(`Tool not found: ${toolName}`); // No I18N
  // `dc` is an envelope argument added for multi-DC domains; it never reaches the script.
  const { [DC_ARG]: dcRaw, ...toolArgs } = (args ?? {}) as Record<string, unknown>;
  const dc = dcRaw === undefined || dcRaw === null || dcRaw === "" || dcRaw === "default" ? undefined : String(dcRaw); // No I18N
  if (dc && !storedDomain.dcs?.length) throw new Error(`${domain} has no data centres; drop the "${DC_ARG}" argument.`); // No I18N
  const problem = validateArgs(storedTool.inputSchema, toolArgs);
  if (problem) throw new Error(`Invalid arguments for ${toolName}: ${problem}`); // No I18N
  const target = targetFor(storedDomain, dc);
  const tabId = await getOrOpenTab(target);
  await ensureToolPage(tabId, target, storedTool.url);
  await ensureDomainInit(tabId, storedDomain, target.origin);
  // Last check before injection: still on the origin AND (for page-bound tools) still on the page.
  if (!(await tabOnOrigin(tabId, target.origin))) throw new Error(`Tab for ${target.name} navigated away before the tool could run.`); // No I18N
  if (!(await tabOnPage(tabId, target, storedTool.url))) throw new Error(`Tab for ${target.name} left ${storedTool.url} before the tool could run.`); // No I18N
  return runScriptInTab(tabId, storedTool.toolScript, toolArgs, target.origin);
}

/**
 * Agent path (connector or granted page): optional user confirmation via a
 * approval window, then executeTool, always audited.
 */
const agentRateLimiter = new RateLimiter();

export async function executeAgentCall(caller: string, domain: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
  const started = Date.now();
  const entry: AuditEntry = { t: started, caller, domain, tool: toolName, argsPreview: JSON.stringify(args ?? {}).slice(0, 160), ok: false, ms: 0 };
  try {
    const limited = agentRateLimiter.hit(caller, (await loadBridgeConfig()).rateLimitPerMinute);
    if (limited) throw new Error(limited);
    const storedDomain = withBuiltinDomain(await getStoredDomains()).find((d) => d.name === domain);
    const tool = storedDomain?.tools.find((t) => t.name === toolName);
    if (toolName !== DC_LIST_TOOL) {
      if (!tool) throw new Error(`Tool not found: ${toolName}`); // No I18N
      // Validate BEFORE asking the user, so they never approve a call that is going to be rejected anyway.
      const { [DC_ARG]: _dc, ...rest } = (args ?? {}) as Record<string, unknown>; void _dc;
      const problem = validateArgs(tool.inputSchema, rest);
      if (problem) throw new Error(`Invalid arguments for ${toolName}: ${problem}`); // No I18N
    }
    if (tool?.requireConfirmation) {
      const allowed = await confirmWithUser({
        title: `Allow ${caller} to run ${toolName}?`, // No I18N
        caller,
        fields: { Domain: domain, Tool: toolName, Description: tool?.description || "—" }, // No I18N
        code: JSON.stringify(args ?? {}, null, 2).slice(0, 8_000), codeLabel: "Call arguments", // No I18N
      });
      if (!allowed) throw new Error(`Call to ${toolName} was not approved by the user.`); // No I18N
    }
    const result = await executeTool(domain, toolName, args, caller);
    entry.ok = true;
    return result;
  } catch (e) {
    entry.error = String(e).slice(0, 300);
    throw e;
  } finally {
    entry.ms = Date.now() - started;
    void appendAuditThrottled(entry).catch(() => {});   // failures throttled per caller; successes always written
  }
}

// ─── Page authorisation (fixes "every site can call every tool") ─────────────

/** True for the extension's own pages (settings page "Run", popup). */
function isExtensionPage(sender: chrome.runtime.MessageSender): boolean {
  return !!sender.url && sender.url.startsWith(`chrome-extension://${chrome.runtime.id}/`); // No I18N
}

/**
 * Origin of a page sender. Both fields are set by Chrome, never by the page.
 * Prefer sender.origin: it is the real (possibly opaque) origin, so a sandboxed
 * document served from a granted origin is NOT treated as that origin. Only the
 * top frame of a real tab may call tools (content scripts run in top frames only,
 * but be explicit).
 */
function senderOrigin(sender: chrome.runtime.MessageSender): string | null {
  if (!sender.tab || sender.frameId !== 0) return null;
  const o = sender.origin ?? (() => { try { return sender.url ? new URL(sender.url).origin : null; } catch { return null; } })();
  return o && o !== "null" ? o : null; // No I18N
}

/** Tools a page may use: its origin's page-access grant → that profile, resolved live. */
async function toolsForSender(sender: chrome.runtime.MessageSender) {
  const origin = senderOrigin(sender);
  if (!origin) return [];
  const cfg = await loadBridgeConfig();
  const grant = findPageAccess(cfg, origin);
  if (!grant) return [];
  const [profiles, domains] = await Promise.all([loadProfiles(), getStoredDomains()]);
  return resolveExposedTools(profiles.find((p) => p.id === grant.profileId), domains, grant);
}

/**
 * Page authorisation. `denied` is the message for the page (null = allowed).
 * `audit` is false when the origin has no grant at all: such a page is not a
 * caller, and any website can post EXT_TOOL_CALL, so logging it would let an
 * arbitrary site flood the 500-row audit ring and grow storage.
 */
async function authorizePageCall(sender: chrome.runtime.MessageSender, domain: string, toolName: string): Promise<{ denied: string | null; audit: boolean }> {
  const origin = senderOrigin(sender);
  const cfg = await loadBridgeConfig();
  const grant = origin ? findPageAccess(cfg, origin) : undefined;
  if (!grant) return { denied: `Tool calls are not enabled for ${origin ?? "this page"}. Add the page origin under Settings → Web MCP → Page access.`, audit: false }; // No I18N
  const [profiles, domains] = await Promise.all([loadProfiles(), getStoredDomains()]);
  const profile = profiles.find((p) => p.id === grant.profileId);
  if (!resolveExposedTools(profile, domains, grant).some((t) => t.domain === domain && t.toolName === toolName)) {
    if (isBuiltinDomain(domain)) return { denied: builderDeniedMessage("page", grant.origin), audit: true }; // No I18N
    return { denied: `Tool ${domain}/${toolName} is not enabled in the profile granted to ${origin}.`, audit: true }; // No I18N
  }
  return { denied: null, audit: true };
}

// ─── Message router ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message: RuntimeMessage, sender, sendResponse) => {
  if (message.type === "TOOL_EXECUTE") { // No I18N
    const { domain, toolName, args } = message;
    if (typeof domain !== "string" || typeof toolName !== "string") { sendResponse({ ok: false, error: "domain and toolName must be strings" } satisfies RuntimeResponse); return false; } // No I18N
    const run = isExtensionPage(sender)
      ? executeTool(domain, toolName, args, "settings", true)      // settings page "Run": the user is the caller — trusted, unaudited // No I18N
      : authorizePageCall(sender, domain, toolName).then(({ denied, audit }) => {
          const caller = senderOrigin(sender) ?? "page"; // No I18N
          if (denied) { if (audit) auditDenied(caller, domain, toolName, args, denied); throw new Error(denied); }
          return executeAgentCall(caller, domain, toolName, args);
        });
    run
      .then((result) => sendResponse({ ok: true, result } satisfies RuntimeResponse))
      .catch((err: unknown) => sendResponse({ ok: false, error: String(err) } satisfies RuntimeResponse));
    return true;
  }

  if (message.type === "GET_BUILD_ID") { // No I18N
    sendResponse({ ok: true, buildId: __BUILD_ID__ });
    return false;
  }

  if (message.type === "PAGE_TOOLS") { // No I18N
    toolsForSender(sender)
      .then((tools) => sendResponse({ ok: true, tools } satisfies RtPageToolsResponse))
      .catch(() => sendResponse({ ok: false, tools: [] } satisfies RtPageToolsResponse));
    return true;
  }

  if (message.type === "OPEN_DOMAIN_TAB") { // No I18N
    if (!isExtensionPage(sender)) { sendResponse({ ok: false, error: "Not allowed" }); return false; } // No I18N
    getStoredDomains()
      .then(async (domains) => {
        const domain = domains.find((d) => d.name === message.domainName);
        if (!domain) throw new Error(`Unknown domain: ${message.domainName}`); // No I18N
        const tabId = await openDomainTab(targetFor(domain));
        const tabs = await getSessionTabs();
        tabs[domain.name] = tabId;
        await setSessionTabs(tabs);
        sendResponse({ ok: true, tabId });
      })
      .catch((err: unknown) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (message.type === "CLOSE_DOMAIN_TAB") { // No I18N
    if (!isExtensionPage(sender)) { sendResponse({ ok: false, error: "Not allowed" }); return false; } // No I18N
    getSessionTabs()
      .then(async (tabs) => {
        const tabId = tabs[message.domainName];
        if (tabId !== undefined) {
          try { await chrome.tabs.remove(tabId); } catch { /* already closed */ }
          delete tabs[message.domainName];
          await setSessionTabs(tabs);
        }
        sendResponse({ ok: true });
      })
      .catch((err: unknown) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  return false;
});

// ─── Web MCP bridge (external MCP clients via connector scripts) ─────────────

installNativeBridge(executeAgentCall);
