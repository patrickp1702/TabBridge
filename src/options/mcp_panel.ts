/**
 * mcp_panel.ts — the "Web MCP" tab of the settings page.
 *
 *  - Master switch + live bridge status (service worker owns the native port).
 *  - Connector scripts: pick a profile + lifetime, choose the file name in a
 *    dialog, download. Each download is a Connector (own token, baked into a
 *    pure-bash script, never shown here). Connectors stay listed — active,
 *    expired or deactivated — until Delete; Extend / Reactivate gives the SAME
 *    script a new validity window (the plugin, not the file, decides validity).
 *  - Page access: which page origins (in-page agent) get which profile.
 *    Pages not listed get no tools at all.
 *  - ToolBridge: each connector and each page grant has its own 2-hour switch
 *    that exposes the built-in tool-building tools to THAT caller only.
 */
import type { AuditEntry, Connector, McpBridgeConfig, McpBridgeStatus, PageAccess, StoredDomain, ToolProfile } from "../types/plugin.types";
import { clampDays, CONNECTOR_LABEL_RE, deactivateConnector, DEFAULT_BRIDGE_CONFIG, isInsecureOrigin, RESERVED_CONNECTOR_LABELS, extendConnector, hashToken, isConnectorExpired, isConnectorLive, labelFromFilename, MAX_LIFETIME_DAYS, normalizeOrigin, resolveProfileTools, slugify } from "../utils/profiles";
import { BUILTIN_DOMAIN_NAME, isBuilderActive, withBuilderGrant } from "../utils/builtin";
import type { BuilderGrant } from "../types/plugin.types";
import { AUDIT_KEY, CONNECTOR_STATS_KEY, clearAudit, loadAudit, loadBridgeConfig, loadConnectorStats, loadDomains, loadProfiles, newId, saveBridgeConfig, type ConnectorStats } from "../utils/storage";
import { buildConnectorScript, connectorFilename } from "./connector_script";

const STATUS_KEY = "mcpBridgeStatus"; // No I18N
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

let cfg: McpBridgeConfig = { ...DEFAULT_BRIDGE_CONFIG };
let profiles: ToolProfile[] = [];
let domains: StoredDomain[] = [];
let stats: Record<string, ConnectorStats> = {};

type Child = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string | boolean | undefined> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === "class") el.className = String(v); else if (k === "text") el.textContent = String(v); else if (v === true) el.setAttribute(k, ""); else el.setAttribute(k, String(v)); // No I18N
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}
function button(label: string, cls: string, onClick: () => void, title?: string): HTMLButtonElement {
  const b = h("button", { class: `btn btn--sm ${cls}`, text: label, title }); // No I18N
  b.addEventListener("click", onClick);
  return b;
}
const fmt = (ms: number): string => new Date(ms).toLocaleString();
const profileName = (id: string): string => profiles.find((p) => p.id === id)?.name ?? "(deleted profile)"; // No I18N
const profileToolCount = (id: string): number => resolveProfileTools(profiles.find((p) => p.id === id), domains).length;

/**
 * The per-caller ToolBridge switch: on = this connector / page may create and edit
 * tools for the next 2 hours (every change still needs your Allow); auto-off after.
 */
function builderSwitch<T extends BuilderGrant>(caller: T, label: string, disabled: boolean, onChange: (next: T) => Promise<void>): HTMLElement {
  const active = isBuilderActive(caller);
  const cb = h("input", { type: "checkbox" }) as HTMLInputElement; // No I18N
  cb.checked = active; cb.disabled = disabled;
  cb.addEventListener("change", async () => {
    if (cb.checked && !confirm(`Let ${label} CREATE and EDIT tools through ${BUILTIN_DOMAIN_NAME} for the next 2 hours?\n\nHigh-risk capability: an agent can add scripts that run inside your browser session on any configured domain. Each add/edit still opens an approval window you must Allow. The switch turns itself off after 2 hours.`)) { cb.checked = false; return; } // No I18N
    await onChange(withBuilderGrant(caller, cb.checked));
  });
  const left = Math.max(0, (caller.builderUntil ?? 0) - Date.now());
  const mins = Math.ceil(left / 60_000);
  const status = active ? `active · ${mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} m` : `${mins} m`} left` : caller.builderUntil ? "expired" : "off"; // No I18N
  return h("div", { class: "builder" + (active ? " builder--on" : "") }, // No I18N
    h("label", { class: "toggle toggle--sm", title: disabled ? "Only live connectors can build tools" : "Expose the ToolBridge tools (create / edit tools) to this caller for 2 hours" }, cb, h("span", { class: "toggle__slider" })), // No I18N
    h("span", { class: "builder__label", text: `🔒 ${BUILTIN_DOMAIN_NAME}` }), // No I18N
    h("span", { class: `pill pill--${active ? "on" : "muted"}`, text: status }), // No I18N
    active && button("Renew 2 h", "btn--ghost", () => { void onChange(withBuilderGrant(caller, true)); }, "Restart the 2-hour window from now"), // No I18N
  );
}

// ─── Status ──────────────────────────────────────────────────────────────────

const STATUS_LABEL: Record<McpBridgeStatus["state"], string> = {
  disabled: "Disabled", setup: "Setup needed", connecting: "Connecting…", connected: "Connected", error: "Error", expired: "Expired", // No I18N
};

function renderStatus(status: McpBridgeStatus | undefined): void {
  const s: McpBridgeStatus = status ?? { state: "disabled", connectorCount: 0, updatedAt: 0 }; // No I18N
  const dotKind = s.state === "expired" || s.state === "error" ? "error" : s.state === "setup" ? "connecting" : s.state; // No I18N
  $("mcp-status-dot").className = `status__dot status__dot--${dotKind}`; // No I18N
  let text = STATUS_LABEL[s.state];
  if (s.state === "connected") text += ` — serving ${s.connectorCount} active connector(s)`; // No I18N
  $("mcp-status-text").textContent = text; // No I18N
  $("mcp-status-detail").textContent = s.detail ?? ""; // No I18N
  $("btn-retry").style.display = s.state === "setup" || s.state === "connecting" || s.state === "error" ? "" : "none"; // No I18N
}

// ─── Profile selects ─────────────────────────────────────────────────────────

function fillProfileSelect(sel: HTMLSelectElement, keep?: string): void {
  const prev = keep ?? sel.value;
  sel.innerHTML = ""; // No I18N
  if (!profiles.length) { sel.append(h("option", { value: "", text: "— create a profile first —" })); sel.disabled = true; return; } // No I18N
  sel.disabled = false;
  for (const p of profiles) sel.append(h("option", { value: p.id, text: `${p.name} (${profileToolCount(p.id)} tools)` })); // No I18N
  if (profiles.some((p) => p.id === prev)) sel.value = prev;
}

// ─── Connectors ──────────────────────────────────────────────────────────────

function triggerDownload(filename: string, content: string): void {
  const blob = new Blob([content], { type: "application/x-sh" }); // No I18N
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Step 1: open the dialog with a proposed file name; step 2 (dialog submit) mints the connector and downloads. */
function openDownloadDialog(): void {
  const err = $("mcp-download-error"), ok = $("mcp-download-ok"); // No I18N
  err.style.display = "none"; ok.style.display = "none"; // No I18N
  const profileId = $<HTMLSelectElement>("mcp-profile").value; // No I18N
  const profile = profiles.find((p) => p.id === profileId);
  if (!profile) { err.textContent = "Choose a profile (create one in the Profiles tab)."; err.style.display = ""; return; } // No I18N
  const dlg = $<HTMLDialogElement>("dl-dialog"); // No I18N
  const labelInput = $<HTMLInputElement>("dl-label"); // No I18N
  labelInput.value = `${slugify(profile.name)}-${newId(3)}`; // No I18N
  $("dl-profile-line").textContent = `Profile ${profile.name} · ${profileToolCount(profileId)} tool(s) · valid ${clampDays(Number($<HTMLInputElement>("mcp-lifetime").value))} day(s), extendable later`; // No I18N
  $("dl-error").style.display = "none"; // No I18N
  const refreshKey = (): void => { $("dl-key").textContent = `tabbridge-${labelFromFilename(labelInput.value) || "…"}`; }; // No I18N
  refreshKey();
  labelInput.oninput = refreshKey;
  dlg.returnValue = ""; // No I18N
  dlg.showModal();
  labelInput.focus(); labelInput.select();
}

async function finishDownload(): Promise<void> {
  const err = $("mcp-download-error"), ok = $("mcp-download-ok"); // No I18N
  const profileId = $<HTMLSelectElement>("mcp-profile").value; // No I18N
  const profile = profiles.find((p) => p.id === profileId);
  if (!profile) return;
  const label = labelFromFilename($<HTMLInputElement>("dl-label").value); // No I18N
  if (!CONNECTOR_LABEL_RE.test(label)) { err.textContent = "File name must contain only letters, digits and dashes (1–48 chars)."; err.style.display = ""; return; } // No I18N
  if (RESERVED_CONNECTOR_LABELS.has(label)) { err.textContent = `"${label}" is reserved; pick another name.`; err.style.display = ""; return; } // No I18N
  if (cfg.connectors.some((c) => c.label === label)) { err.textContent = `A connector named "${label}" already exists — pick another name or delete the old one.`; err.style.display = ""; return; } // No I18N
  const days = clampDays(Number($<HTMLInputElement>("mcp-lifetime").value)); // No I18N
  const nowSec = Math.floor(Date.now() / 1000);
  const token = newId(24);                       // exists only here and in the downloaded file
  const connector: Connector = {
    id: newId(), label, profileId, tokenHash: await hashToken(token),
    issuedAt: nowSec * 1000, expiresAt: (nowSec + days * 86_400) * 1000, active: true,
  };
  const script = buildConnectorScript({
    token, extensionId: chrome.runtime.id, connectorId: connector.label, profileName: profile.name,
    issuedAt: nowSec, expiresAt: nowSec + days * 86_400, version: chrome.runtime.getManifest().version,
  });
  cfg = { ...cfg, lifetimeDays: days, connectors: [...cfg.connectors, connector] };
  await saveBridgeConfig(cfg);
  triggerDownload(connectorFilename(connector.label), script);
  ok.textContent = `Downloaded ${connectorFilename(connector.label)} (profile ${profile.name}, ${profileToolCount(profileId)} tools, valid ${days} day(s)). Now run it once:  bash ~/Downloads/${connectorFilename(connector.label)}`; // No I18N
  ok.style.display = ""; // No I18N
  void chrome.runtime.sendMessage({ type: "MCP_BRIDGE_RECONNECT" }).catch(() => {}); // No I18N
  renderConnectors();
}

/** Extend / Reactivate dialog for one connector. */
function openExtendDialog(c: Connector): void {
  const dlg = $<HTMLDialogElement>("ext-dialog"); // No I18N
  const expired = isConnectorExpired(c), live = isConnectorLive(c);
  $("ext-title").textContent = live ? `Extend ${c.label}` : `Reactivate ${c.label}`; // No I18N
  $("ext-line").textContent = `Profile ${profileName(c.profileId)} · currently ${expired ? "expired " + fmt(c.expiresAt) : c.active ? "active until " + fmt(c.expiresAt) : "deactivated"}`; // No I18N
  $("ext-confirm").textContent = live ? "Extend" : "Reactivate"; // No I18N
  $<HTMLInputElement>("ext-days").value = String(clampDays(cfg.lifetimeDays)); // No I18N
  dlg.onclose = async () => {
    if (dlg.returnValue !== "extend") return; // No I18N
    const days = clampDays(Number($<HTMLInputElement>("ext-days").value)); // No I18N
    cfg = { ...cfg, connectors: cfg.connectors.map((x) => (x.id === c.id ? extendConnector(x, days) : x)) };
    await saveBridgeConfig(cfg);
    void chrome.runtime.sendMessage({ type: "MCP_BRIDGE_RECONNECT" }).catch(() => {}); // No I18N
    renderConnectors();
  };
  dlg.showModal();
}

function renderConnectors(): void {
  const list = $("connector-list"); // No I18N
  list.innerHTML = ""; // No I18N
  const now = Date.now();
  const rows = [...cfg.connectors].sort((a, b) => b.issuedAt - a.issuedAt);
  if (!rows.length) { list.append(h("p", { class: "card__hint", text: "No connector scripts yet." })); return; } // No I18N
  for (const c of rows) {
    const live = isConnectorLive(c, now), expired = isConnectorExpired(c, now);
    const hoursLeft = Math.max(0, Math.round((c.expiresAt - now) / 36e5));
    const state = expired ? "Expired" : c.active ? "Active" : "Deactivated"; // No I18N
    const validity = expired ? `expired ${fmt(c.expiresAt)}` : `valid until ${fmt(c.expiresAt)} (~${hoursLeft} h)`; // No I18N
    const row = h("div", { class: "conn" + (live ? " conn--live" : " conn--off") }, // No I18N
      h("div", { class: "conn__main" },
        h("div", { class: "conn__title" }, h("span", { class: "chip--mono", text: c.label }), h("span", { class: `pill pill--${live ? "on" : "off"}`, text: state })), // No I18N
        h("div", { class: "conn__meta", text: `profile ${profileName(c.profileId)} · ${profileToolCount(c.profileId)} tools · downloaded ${fmt(c.issuedAt)} · ${validity}${c.extendedAt ? ` · extended ${fmt(c.extendedAt)}` : ""} · ${stats[c.id]?.requests ?? 0} request(s)${stats[c.id]?.lastSeenAt ? ` · last seen ${fmt(stats[c.id].lastSeenAt)}` : ""}` }), // No I18N
        h("div", { class: "conn__meta", text: `file: ${connectorFilename(c.label)} · MCP key: tabbridge-${c.label}` }), // No I18N
        builderSwitch(c, `connector ${c.label}`, !live, async (next) => { cfg = { ...cfg, connectors: cfg.connectors.map((x) => (x.id === c.id ? next : x)) }; await saveBridgeConfig(cfg); renderConnectors(); }), // No I18N
      ),
      h("div", { class: "conn__actions" },
        button(live ? "⟳ Extend" : "⟳ Reactivate", "btn--primary", () => openExtendDialog(c), live ? "Give this script more time" : "Make this script valid again — no new download"), // No I18N
        live && button("✕ Deactivate", "btn--ghost", async () => { // No I18N
          if (!confirm(`Deactivate connector ${c.label}? Agents using it are refused immediately. You can reactivate it later.`)) return; // No I18N
          cfg = { ...cfg, connectors: cfg.connectors.map((x) => (x.id === c.id ? deactivateConnector(x) : x)) };
          await saveBridgeConfig(cfg); renderConnectors();
        }, "Refuse this script from now on (reversible)"), // No I18N
        button("🗑 Delete", "btn--danger", async () => { // No I18N
          if (!confirm(`Delete connector ${c.label} for good?\n\nThe downloaded script will be refused forever and cannot be reactivated. Agents configured with it must be given a new connector.`)) return; // No I18N
          cfg = { ...cfg, connectors: cfg.connectors.filter((x) => x.id !== c.id) };
          await saveBridgeConfig(cfg); renderConnectors();
        }, "Forget this connector permanently"), // No I18N
      ),
    );
    list.append(row);
  }
}

// ─── Page access ─────────────────────────────────────────────────────────────

async function addPageAccess(): Promise<void> {
  const err = $("page-error"); err.style.display = "none"; // No I18N
  const origin = normalizeOrigin($<HTMLInputElement>("page-origin").value); // No I18N
  const profileId = $<HTMLSelectElement>("page-profile").value; // No I18N
  if (!origin) { err.textContent = "Enter a valid http(s) origin, e.g. https://app.example.com"; err.style.display = ""; return; } // No I18N
  if (isInsecureOrigin(origin) && !cfg.allowHttpOrigins) { err.textContent = `${origin} is plain http. Switch on "Allow plain http:// page origins" below first (read the warning).`; err.style.display = ""; return; } // No I18N
  if (!profiles.some((p) => p.id === profileId)) { err.textContent = "Choose a profile."; err.style.display = ""; return; } // No I18N
  const grant: PageAccess = { id: newId(), origin, profileId, createdAt: Date.now() };
  cfg = { ...cfg, pageAccess: [...cfg.pageAccess.filter((g) => g.origin !== origin), grant] }; // one profile per origin
  await saveBridgeConfig(cfg);
  $<HTMLInputElement>("page-origin").value = ""; // No I18N
  renderPageAccess();
}

function renderPageAccess(): void {
  const list = $("page-list"); // No I18N
  list.innerHTML = ""; // No I18N
  if (!cfg.pageAccess.length) { list.append(h("p", { class: "card__hint", text: "No pages have access. The in-page agent gets no tools until its page origin is added here." })); return; } // No I18N
  for (const g of cfg.pageAccess) {
    list.append(h("div", { class: "conn conn--live" }, // No I18N
      h("div", { class: "conn__main" },
        h("div", { class: "conn__title" }, h("span", { class: "chip--mono", text: g.origin }),
          isInsecureOrigin(g.origin) && h("span", { class: `pill pill--${cfg.allowHttpOrigins ? "off" : "muted"}`, text: cfg.allowHttpOrigins ? "http · insecure" : "http · blocked (switch below)", title: "Plain-http origin: script can be injected by anyone on the network path" })), // No I18N
        h("div", { class: "conn__meta", text: `profile ${profileName(g.profileId)} · ${profileToolCount(g.profileId)} tools · added ${fmt(g.createdAt)}` }), // No I18N
        builderSwitch(g, `pages at ${g.origin}`, false, async (next) => { cfg = { ...cfg, pageAccess: cfg.pageAccess.map((x) => (x.id === g.id ? next : x)) }; await saveBridgeConfig(cfg); renderPageAccess(); }), // No I18N
      ),
      h("div", { class: "conn__actions" }, button("✕ Remove", "btn--danger", async () => { cfg = { ...cfg, pageAccess: cfg.pageAccess.filter((x) => x !== g) }; await saveBridgeConfig(cfg); renderPageAccess(); }, "Pages at this origin lose all tools")), // No I18N
    ));
  }
}

// ─── Audit log ───────────────────────────────────────────────────────────────

async function renderAudit(): Promise<void> {
  const list = $("audit-list"); // No I18N
  const entries = (await loadAudit()).slice().reverse();
  list.innerHTML = ""; // No I18N
  if (!entries.length) { list.append(h("p", { class: "card__hint", text: "No agent tool calls yet." })); return; } // No I18N
  for (const e of entries.slice(0, 500)) {
    list.append(h("div", { class: "audit" + (e.ok ? "" : " audit--err") }, // No I18N
      h("span", { class: "audit__time", text: new Date(e.t).toLocaleTimeString() }),
      h("span", { class: "chip--mono", text: e.caller }),
      h("span", { class: "audit__tool", text: `${e.domain}/${e.tool}` }), // No I18N
      h("span", { class: "audit__args", text: e.argsPreview || "{}", title: e.argsPreview }), // No I18N
      h("span", { class: `pill pill--${e.ok ? "on" : "off"}`, text: e.ok ? `ok ${e.ms} ms` : "error" }), // No I18N
      !e.ok && h("span", { class: "audit__err", text: e.error ?? "" }),
    ));
  }
}

// ─── Wiring ──────────────────────────────────────────────────────────────────

async function reload(): Promise<void> {
  [cfg, profiles, domains, stats] = await Promise.all([loadBridgeConfig(), loadProfiles(), loadDomains(), loadConnectorStats()]);
  $<HTMLInputElement>("mcp-enabled").checked = cfg.enabled; // No I18N
  $<HTMLInputElement>("mcp-lifetime").value = String(clampDays(cfg.lifetimeDays)); // No I18N
  $<HTMLInputElement>("mcp-rate").value = String(cfg.rateLimitPerMinute); // No I18N
  fillProfileSelect($<HTMLSelectElement>("mcp-profile")); // No I18N
  fillProfileSelect($<HTMLSelectElement>("page-profile")); // No I18N
  $<HTMLInputElement>("allow-http-pages").checked = cfg.allowHttpOrigins; // No I18N
  $("http-warning").style.display = cfg.allowHttpOrigins ? "" : "none"; // No I18N — warning shown while the toggle is on
  renderConnectors(); renderPageAccess();
  await renderAudit();
}

/** Wires the Web MCP tab. Call once. */
export async function initMcpPanel(): Promise<void> {
  $<HTMLInputElement>("mcp-lifetime").max = String(MAX_LIFETIME_DAYS); // No I18N
  await reload();
  renderStatus(((await chrome.storage.session.get(STATUS_KEY))[STATUS_KEY]) as McpBridgeStatus | undefined);

  $("mcp-enabled").addEventListener("change", async () => { cfg = { ...cfg, enabled: $<HTMLInputElement>("mcp-enabled").checked }; await saveBridgeConfig(cfg); }); // No I18N
  $("mcp-lifetime").addEventListener("change", async () => { cfg = { ...cfg, lifetimeDays: clampDays(Number($<HTMLInputElement>("mcp-lifetime").value)) }; await saveBridgeConfig(cfg); }); // No I18N
  $("mcp-rate").addEventListener("change", async () => { const v = Math.max(0, Math.min(1000, Math.round(Number($<HTMLInputElement>("mcp-rate").value) || 0))); $<HTMLInputElement>("mcp-rate").value = String(v); cfg = { ...cfg, rateLimitPerMinute: v }; await saveBridgeConfig(cfg); }); // No I18N
  $("btn-clear-audit").addEventListener("click", async () => { await clearAudit(); await renderAudit(); }); // No I18N
  $("allow-http-pages").addEventListener("change", async () => { // No I18N
    const on = $<HTMLInputElement>("allow-http-pages").checked; // No I18N
    if (on && !confirm("Allow tool access for pages served over plain HTTP?\n\nAnyone on the same network can inject script into such a page and call every tool its profile exposes. Only do this on networks you trust.")) { $<HTMLInputElement>("allow-http-pages").checked = false; return; } // No I18N
    cfg = { ...cfg, allowHttpOrigins: on };
    await saveBridgeConfig(cfg);
    $("http-warning").style.display = on ? "" : "none"; // No I18N
    renderPageAccess();
  });
  $("btn-download-script").addEventListener("click", () => openDownloadDialog()); // No I18N
  const dlDialog = $<HTMLDialogElement>("dl-dialog"); // No I18N
  dlDialog.addEventListener("close", () => { if (dlDialog.returnValue === "download") void finishDownload(); }); // No I18N
  $("btn-add-page").addEventListener("click", () => { void addPageAccess(); }); // No I18N
  $("page-origin").addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") void addPageAccess(); }); // No I18N
  $("btn-retry").addEventListener("click", () => { void chrome.runtime.sendMessage({ type: "MCP_BRIDGE_RECONNECT" }).catch(() => {}); }); // No I18N

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "session" && changes[STATUS_KEY]) renderStatus(changes[STATUS_KEY].newValue as McpBridgeStatus | undefined); // No I18N
    if (area === "local" && (changes["mcpBridge"] || changes["profiles"] || changes["domains"] || changes[CONNECTOR_STATS_KEY])) void reload(); // No I18N
    if (area === "local" && changes[AUDIT_KEY]) void renderAudit();
  });
  setInterval(renderConnectors, 60_000); // keep "~N h" honest
}
