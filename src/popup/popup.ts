/**
 * popup.ts — read-only overview of the current tab. Editing lives in the settings page.
 *
 * Layout: app bar · site chip · two accordions · footer status bar.
 *  - "Tools this page can use" (collapsed): the summary pill states the verdict —
 *    No access, or Granted · <profile> · N tools (+ a 🔒 pill while this origin's
 *    ToolBridge grant is active). Body lists the tools or how to grant.
 *  - "Tools this page provides" (expanded): if the site is a configured domain, its
 *    tools with full MCP name, badges, 2-line description + See more.
 *  - Footer: bridge status · active connector scripts · pages granted · Web MCP link.
 */
import type { McpBridgeConfig, McpBridgeStatus, StoredDomain, ToolProfile } from "../types/plugin.types";
import { toMcpToolName } from "../utils/mcp";
import { findPageAccess, groupToolsByUrl, isConnectorLive, resolveExposedTools, sameOrigin } from "../utils/profiles";
import { isBuilderActive } from "../utils/builtin";
import { loadBridgeConfig, loadDomains, loadProfiles } from "../utils/storage";

type Child = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string | undefined> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined) continue;
    if (k === "class") el.className = v; else if (k === "text") el.textContent = v; else el.setAttribute(k, v); // No I18N
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}
const $ = (id: string): HTMLElement => document.getElementById(id)!;
const SETTINGS = "options/options.html"; // No I18N
const openSettings = (hash: string): void => { void chrome.tabs.create({ url: chrome.runtime.getURL(`${SETTINGS}${hash}`) }); };
const settingsLink = (text: string, hash: string): HTMLAnchorElement => {
  const a = h("a", { class: "link", href: "#", text }); // No I18N
  a.addEventListener("click", (e) => { e.preventDefault(); openSettings(hash); });
  return a;
};
const pill = (text: string, kind: "ok" | "muted" | "off" | "accent", title?: string): HTMLElement => h("span", { class: `pill pill--${kind}`, text, title }); // No I18N

/** Tool row: full MCP name, badges, description clamped to 2 lines with See more / See less. */
function toolRow(mcpName: string, description: string, badges: Child[] = []): HTMLElement {
  const desc = h("div", { class: "tool__desc tool__desc--clamp", text: description || "(no description)" }); // No I18N
  const more = h("button", { class: "tool__more", type: "button", text: "See more" }); // No I18N
  more.addEventListener("click", () => {
    const clamped = desc.classList.toggle("tool__desc--clamp"); // No I18N
    more.textContent = clamped ? "See more" : "See less"; // No I18N
  });
  const row = h("div", { class: "tool" }, h("div", { class: "tool__head" }, h("span", { class: "tool__name", text: mcpName }), ...badges), desc); // No I18N
  requestAnimationFrame(() => { if (desc.scrollHeight > desc.clientHeight + 2) row.append(more); });
  return row;
}

async function activeOrigin(): Promise<string | null> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) return null;
    const o = new URL(tab.url).origin;
    return o !== "null" && /^https?:\/\//.test(o) ? o : null; // No I18N
  } catch { return null; }
}

// ─── Site chip ───────────────────────────────────────────────────────────────

function renderSite(origin: string | null): void {
  $("site-host").textContent = origin ? new URL(origin).host : "not a web page"; // No I18N
  $("site").title = origin ?? ""; // No I18N
}

// ─── 1. Tools this page can use ──────────────────────────────────────────────

function renderAccess(origin: string | null, domains: StoredDomain[], profiles: ToolProfile[], cfg: McpBridgeConfig): void {
  const meta = $("access-meta"), body = $("access-body"); // No I18N
  meta.innerHTML = ""; body.innerHTML = ""; // No I18N
  if (!origin) {
    meta.append(pill("n/a", "muted")); // No I18N
    body.append(h("p", { class: "hint", text: "Open a web page to see which tools it can use." })); // No I18N
    return;
  }
  const grant = findPageAccess(cfg, origin);
  if (!grant) {
    meta.append(pill("No access", "muted", "No page-access grant for this origin")); // No I18N
    body.append(h("p", { class: "hint" }, "This page has no access to tools. To grant it, add this origin under ", settingsLink("Web MCP → Page access", "#mcp"), " and pick a profile.")); // No I18N
    return;
  }
  const profile = profiles.find((p) => p.id === grant.profileId);
  const tools = resolveExposedTools(profile, domains, grant);
  const profileName = profile?.name ?? "(deleted profile)"; // No I18N
  const builder = isBuilderActive(grant);
  meta.append(pill(`Granted · ${profileName} · ${tools.length} tool${tools.length === 1 ? "" : "s"}`, tools.length ? "ok" : "off", `Profile ${profileName}`)); // No I18N
  if (builder) meta.append(pill("🔒", "accent", `ToolBridge on: this page may create/edit tools until ${new Date(grant.builderUntil!).toLocaleTimeString()}`)); // No I18N
  body.append(h("div", { class: "kv" }, h("span", { class: "kv__k", text: "Profile" }), h("span", { class: "kv__v", text: profileName }), settingsLink("Manage →", "#profiles"), builder && settingsLink("ToolBridge on →", "#mcp"))); // No I18N
  if (!tools.length) { body.append(h("p", { class: "hint", text: "The granted profile exposes no tools right now." })); return; } // No I18N
  const list = h("div", { class: "tools" }); // No I18N
  for (const t of tools) list.append(toolRow(t.name, t.description));
  body.append(list);
}

// ─── 2. Tools this page provides ─────────────────────────────────────────────

function renderProvides(origin: string | null, domains: StoredDomain[]): void {
  const meta = $("provides-meta"), body = $("provides-body"); // No I18N
  meta.innerHTML = ""; body.innerHTML = ""; // No I18N
  const domain = origin ? domains.find((d) => sameOrigin(d.baseUrl, origin)) : undefined;
  if (!domain) {
    meta.append(pill("Not a domain", "muted")); // No I18N
    body.append(h("p", { class: "hint" }, origin ? "This site is not configured as a TabBridge domain. " : "Open a web page to see the tools it provides. ", origin && settingsLink("Add it in Domains & Tools →", "#domains"))); // No I18N
    return;
  }
  const enabled = domain.tools.filter((t) => t.enabled).length;
  meta.append(pill(`${domain.name} · ${enabled}/${domain.tools.length} enabled`, domain.enabled && enabled ? "accent" : "muted")); // No I18N
  body.append(h("div", { class: "kv" }, h("span", { class: "kv__k", text: "Domain" }), h("span", { class: "kv__v", text: domain.name }), !domain.enabled && pill("domain disabled", "off"), settingsLink("Details →", `#domains/${encodeURIComponent(domain.name)}`))); // No I18N
  if (!domain.tools.length) { body.append(h("p", { class: "hint", text: "No tools in this domain yet." })); return; } // No I18N
  const row = (t: StoredDomain["tools"][number]): HTMLElement => toolRow(toMcpToolName(domain.name, t.name), t.description, [
    !t.enabled && pill("off", "off", "Disabled globally"), // No I18N
    t.requireConfirmation && pill("confirm", "ok", "Agent calls need your approval"), // No I18N
    t.deferLoading && pill("deferred", "muted", "defer_loading: loaded on demand via Tool Search"), // No I18N
    t.createdBy && pill("by agent", "accent", `Added by ${t.createdBy}`), // No I18N
  ]);
  const { top, groups } = groupToolsByUrl(domain.tools);
  if (top.length) body.append(h("div", { class: "tools" }, ...top.map(row))); // No I18N
  for (const g of groups) {
    body.append(h("details", { class: "url-group", open: "" }, // No I18N
      h("summary", { class: "url-group__head" }, h("span", { class: "acc__chev" }), h("code", { class: "url-group__url", text: g.url }), h("span", { class: "url-group__count", text: String(g.tools.length) })), // No I18N
      h("div", { class: "tools url-group__body" }, ...g.tools.map(row)), // No I18N
    ));
  }
}

// ─── Footer status bar ───────────────────────────────────────────────────────

function renderStatus(status: McpBridgeStatus | undefined, cfg: McpBridgeConfig): void {
  const s: McpBridgeStatus = status ?? { state: "disabled", connectorCount: 0, updatedAt: 0 }; // No I18N
  const kind = s.state === "expired" || s.state === "error" ? "error" : s.state === "setup" ? "connecting" : s.state; // No I18N
  $("mcp-dot").className = `status__dot status__dot--${kind}`; // No I18N
  const label: Record<McpBridgeStatus["state"], string> = { disabled: "Web MCP off", setup: "Setup needed", connecting: "Connecting…", connected: "Connected", error: "Error", expired: "Expired" }; // No I18N
  const live = cfg.connectors.filter((c) => isConnectorLive(c)).length;
  $("mcp-summary").textContent = `${label[s.state]} · ${live} active connector${live === 1 ? "" : "s"} · ${cfg.pageAccess.length} page${cfg.pageAccess.length === 1 ? "" : "s"} granted`; // No I18N
  $("mcp-summary").title = s.detail ?? ""; // No I18N
}

// ─── Init ────────────────────────────────────────────────────────────────────

async function refresh(): Promise<void> {
  const [domains, profiles, cfg, origin, status] = await Promise.all([
    loadDomains(), loadProfiles(), loadBridgeConfig(), activeOrigin(),
    chrome.storage.session.get("mcpBridgeStatus").then((r) => r["mcpBridgeStatus"] as McpBridgeStatus | undefined), // No I18N
  ]);
  renderSite(origin);
  renderAccess(origin, domains, profiles, cfg);
  renderProvides(origin, domains);
  renderStatus(status, cfg);
}

(async () => {
  $("btn-settings").addEventListener("click", () => openSettings("")); // No I18N
  $("mcp-link").addEventListener("click", (e) => { e.preventDefault(); openSettings("#mcp"); }); // No I18N
  await refresh();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && (changes["domains"] || changes["profiles"] || changes["mcpBridge"])) void refresh(); // No I18N
    if (area === "session" && changes["mcpBridgeStatus"]) void refresh(); // No I18N
  });
})();
