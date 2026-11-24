/**
 * profiles_view.ts — "Profiles" tab of the settings page.
 *
 * A profile is a named selection of tools: per domain either all tools
 * (including ones added later), a hand-picked list, or none. Profiles are what
 * connector scripts and page-access grants expose — nothing outside a profile
 * is ever listed or callable. Edits save immediately and apply live.
 * The built-in ToolBridge domain is NOT a profile matter: it is switched on per
 * connector / per page grant in the Web MCP tab (2-hour window).
 */
import type { StoredDomain, ToolProfile } from "../types/plugin.types";
import { toMcpToolName } from "../utils/mcp";
import { resolveProfileTools } from "../utils/profiles";
import { blankProfile, loadBridgeConfig, loadDomains, loadProfiles, saveProfiles } from "../utils/storage";

type Child = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string | boolean | undefined> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === "class") el.className = String(v); // No I18N
    else if (k === "text") el.textContent = String(v); // No I18N
    else if (v === true) el.setAttribute(k, ""); // No I18N
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}
function button(label: string, cls: string, onClick: () => void): HTMLButtonElement {
  const b = h("button", { class: `btn btn--sm ${cls}`, text: label }); // No I18N
  b.addEventListener("click", onClick);
  return b;
}

let profiles: ToolProfile[] = [];
let domains: StoredDomain[] = [];
let usage = new Map<string, { connectors: number; pages: number }>();
let selectedId: string | null = null;
let renaming = false;

const $nav = (): HTMLElement => document.getElementById("profile-nav")!; // No I18N
const $detail = (): HTMLElement => document.getElementById("profile-detail")!; // No I18N

async function persist(): Promise<void> { await saveProfiles(profiles); }

function selected(): ToolProfile | undefined { return profiles.find((p) => p.id === selectedId); }

// ─── Sidebar ─────────────────────────────────────────────────────────────────

function renderNav(): void {
  const nav = $nav();
  nav.innerHTML = ""; // No I18N
  if (!profiles.length) { nav.append(h("li", { class: "domain-nav__empty", text: "No profiles yet. Click + New Profile." })); return; } // No I18N
  for (const p of profiles) {
    const n = resolveProfileTools(p, domains).length;
    const li = h("li", { class: "domain-nav__item" + (p.id === selectedId ? " domain-nav__item--active" : "") }, // No I18N
      h("span", { class: "domain-nav__dot" + (n ? " domain-nav__dot--on" : "") }), // No I18N
      h("span", { class: "domain-nav__name", text: p.name || "(unnamed)" }), // No I18N
      h("span", { class: "domain-nav__count", text: `${n} tool${n === 1 ? "" : "s"}` }), // No I18N
    );
    li.addEventListener("click", () => { selectedId = p.id; renaming = false; render(); });
    nav.append(li);
  }
}

// ─── Detail ──────────────────────────────────────────────────────────────────

function renderDetail(): void {
  const root = $detail();
  root.innerHTML = ""; // No I18N
  const p = selected();
  if (!p) { root.append(h("div", { class: "card" }, h("p", { class: "loading", text: profiles.length ? "Select a profile." : "Create a profile to choose which tools agents may use." }))); return; } // No I18N

  const use = usage.get(p.id) ?? { connectors: 0, pages: 0 };
  const exposed = resolveProfileTools(p, domains);

  // Header
  const head = h("div", { class: "card" });
  if (renaming) {
    const name = h("input", { class: "field__input", type: "text", placeholder: "Profile name" }); name.value = p.name; // No I18N
    const desc = h("input", { class: "field__input", type: "text", placeholder: "What this profile is for (optional)" }); desc.value = p.description; // No I18N
    const err = h("p", { class: "form-error" }); err.style.display = "none"; // No I18N
    head.append(
      h("div", { class: "domain-head__title", text: "Edit profile" }), // No I18N
      h("div", { class: "edit" },
        h("label", { class: "field" }, h("span", { class: "field__label", text: "Name" }), name), // No I18N
        h("label", { class: "field" }, h("span", { class: "field__label", text: "Description" }), desc), // No I18N
        err,
        h("div", { class: "edit__actions" },
          button("Save", "btn--primary", async () => { // No I18N
            const n = name.value.trim();
            if (!n) { err.textContent = "Name is required."; err.style.display = ""; return; } // No I18N
            if (profiles.some((x) => x !== p && x.name.toLowerCase() === n.toLowerCase())) { err.textContent = `A profile named "${n}" already exists.`; err.style.display = ""; return; } // No I18N
            p.name = n; p.description = desc.value.trim(); renaming = false; await persist(); render();
          }),
          button("Cancel", "btn--ghost", () => { renaming = false; render(); }), // No I18N
          h("span", { class: "spacer" }),
          button("Delete profile", "btn--danger", async () => { // No I18N
            const warn = use.connectors || use.pages ? ` It is used by ${use.connectors} connector(s) and ${use.pages} page grant(s); those will stop exposing tools.` : ""; // No I18N
            if (!confirm(`Delete profile "${p.name}"?${warn}`)) return; // No I18N
            profiles = profiles.filter((x) => x !== p); selectedId = profiles[0]?.id ?? null; renaming = false; await persist(); render();
          }),
        ),
      ),
    );
  } else {
    head.append(
      h("div", { class: "domain-head" },
        h("div", {},
          h("div", { class: "domain-head__title", text: p.name }),
          p.description && h("div", { class: "card__hint", text: p.description }),
        ),
        h("div", { class: "domain-head__actions" },
          h("span", { class: "card__hint", text: `${exposed.length} tool(s) exposed · used by ${use.connectors} connector(s), ${use.pages} page grant(s)` }), // No I18N
          button("✎ Rename", "btn--ghost", () => { renaming = true; render(); }), // No I18N
        ),
      ),
      h("div", { class: "card__hint", style: "margin-top:8px" }, "Tick a whole domain to include every tool in it (also ones added later), or pick tools individually. Tools switched off globally in Domains & Tools are greyed and never exposed. ", h("b", { text: "🔒 ToolBridge (agents creating tools) is not part of a profile" }), " — switch it on per connector or per page in Web MCP."), // No I18N
    );
  }
  root.append(head);

  // One card per domain with tri-state selection
  for (const d of domains) {
    const sel = p.domains[d.name];
    const all = sel === "*"; // No I18N
    const list = Array.isArray(sel) ? sel : [];
    const pickedCount = all ? d.tools.length : list.filter((n) => d.tools.some((t) => t.name === n)).length;

    const allCb = h("input", { type: "checkbox" }); // No I18N
    allCb.checked = all;
    allCb.indeterminate = !all && pickedCount > 0;
    allCb.addEventListener("change", async () => {
      if (allCb.checked) p.domains[d.name] = "*"; else delete p.domains[d.name]; // No I18N
      await persist(); render();
    });

    const card = h("div", { class: "tool-card" + (d.enabled ? "" : " tool-card--disabled") }, // No I18N
      h("div", { class: "tool-card__head" },
        h("label", { class: "arg__check" }, allCb, h("span", { class: "tool-card__name", text: d.name }), h("span", { class: "card__hint", text: all ? "all tools (incl. future ones)" : `${pickedCount}/${d.tools.length} selected` })), // No I18N
        !d.enabled && h("span", { class: "card__hint", text: "domain disabled globally — nothing exposed" }), // No I18N
      ),
    );
    const grid = h("div", { class: "pick-grid" }); // No I18N
    for (const t of d.tools) {
      const cb = h("input", { type: "checkbox" }); // No I18N
      cb.checked = all || list.includes(t.name);
      cb.disabled = all;
      cb.addEventListener("change", async () => {
        const cur = Array.isArray(p.domains[d.name]) ? [...(p.domains[d.name] as string[])] : [];
        const next = cb.checked ? [...new Set([...cur, t.name])] : cur.filter((n) => n !== t.name);
        if (next.length) p.domains[d.name] = next; else delete p.domains[d.name];
        await persist(); render();
      });
      grid.append(h("label", { class: "pick" + (t.enabled ? "" : " pick--off") }, cb, // No I18N
        h("span", { class: "pick__name", text: t.name }),
        h("span", { class: "chip--mono", text: toMcpToolName(d.name, t.name) }),
        h("span", { class: "pick__desc", text: t.enabled ? t.description : "(disabled globally)" }), // No I18N
      ));
    }
    if (!d.tools.length) grid.append(h("span", { class: "card__hint", text: "No tools in this domain." })); // No I18N
    card.append(grid);
    root.append(card);
  }
}

function render(): void {
  if (selectedId && !profiles.some((p) => p.id === selectedId)) selectedId = null;
  if (!selectedId && profiles.length) selectedId = profiles[0].id;
  renderNav(); renderDetail();
}

async function reload(): Promise<void> {
  const [p, d, cfg] = await Promise.all([loadProfiles(), loadDomains(), loadBridgeConfig()]);
  profiles = p; domains = d;
  usage = new Map();
  for (const x of profiles) usage.set(x.id, { connectors: cfg.connectors.filter((c) => c.profileId === x.id && c.active).length, pages: cfg.pageAccess.filter((g) => g.profileId === x.id).length });
  render();
}

/** Wires the Profiles tab. Call once. */
export async function initProfilesView(): Promise<void> {
  await reload();
  document.getElementById("btn-new-profile")!.addEventListener("click", async () => { // No I18N
    let n = 1; while (profiles.some((p) => p.name === `Profile ${n}`)) n++; // No I18N
    const p = blankProfile(`Profile ${n}`); // No I18N
    profiles.push(p); selectedId = p.id; renaming = true; await persist(); render();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (renaming) return;
    if (area === "local" && (changes["profiles"] || changes["domains"] || changes["mcpBridge"])) void reload(); // No I18N
  });
  setInterval(() => { if (!renaming) render(); }, 60_000);   // keep the "N m left" pill honest
}
