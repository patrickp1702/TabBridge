/**
 * domains_view.ts — "Domains & Tools" tab of the settings page.
 *
 * Left: every registered domain. Right: the selected domain's details and each
 * of its tools as a card showing the COMPLETE definition (description, MCP
 * name, input schema, tool script). Each card can:
 *   - Run: schema-driven argument form → TOOL_EXECUTE via the service worker
 *     (same path the in-page agent and the Web MCP bridge use) → output shown inline.
 *   - Edit: inline form for every field (name, description, schema, script,
 *     enabled) with Save / Cancel / Delete.
 * Domains themselves can be added, edited, toggled and deleted here too.
 *
 * State lives in chrome.storage.local["domains"]; the view re-renders on
 * storage changes unless an edit form is open (then it defers until closed).
 */
import { toMcpToolName } from "../utils/mcp";
import { builtinDomain } from "../utils/builtin";
import type { StoredDomain, StoredTool } from "../types/plugin.types";
import type { RtToolExecuteMsg, RuntimeResponse } from "../utils/message";
import { BUILTIN_DOMAIN_NAME, isBuiltinDomain, withBuiltinDomain } from "../utils/builtin";
import { exportDomainsJson, exportFilename, previewImport } from "../utils/import_export";
import { DC_LIST_TOOL, formatDcLines, groupToolsByUrl, isHttpUrl, isRelativeUrl, parseDcLines, validateDomains } from "../utils/profiles";
import { DEFAULT_SCHEMA_JSON, blankDomain, blankTool, loadDomains, saveDomains } from "../utils/storage";

// ─── Tiny DOM helper ─────────────────────────────────────────────────────────

type Child = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Partial<Record<string, string | boolean>> & { class?: string; text?: string } = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === "class") el.className = String(v); // No I18N
    else if (k === "text") el.textContent = String(v); // No I18N
    else if (v === true) el.setAttribute(k, ""); // No I18N
    else el.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c);
  }
  return el;
}

function toggle(checked: boolean, small: boolean, onChange: (v: boolean) => void): HTMLLabelElement {
  const cb = h("input", { type: "checkbox" }); // No I18N
  cb.checked = checked;
  cb.addEventListener("change", () => onChange(cb.checked));
  return h("label", { class: "toggle" + (small ? " toggle--small" : "") }, cb, h("span", { class: "toggle__slider" })); // No I18N
}

// ─── View state ──────────────────────────────────────────────────────────────

type ToolMode = "view" | "run" | "edit"; // No I18N
interface ToolUiState {
  mode: ToolMode;
  /** Last run output (kept across re-renders). */
  output?: { ok: boolean; text: string; ms: number; at: number };
  /** Draft arg values typed in the run form, keyed by property name. */
  argDraft?: Record<string, string | boolean>;
}

let domains: StoredDomain[] = [];
let selected: string | null = null;        // domain name
let domainEditing = false;                 // inline domain form open
let creatingDomain = false;                // "+ Add Domain" form open
let creatingTool = false;                  // "+ Add Tool" form open
const toolUi = new Map<string, ToolUiState>(); // key `${domain}/${tool}`
let deferredReload = false;

const uiKey = (d: string, t: string): string => `${d}/${t}`; // No I18N
function ui(d: string, t: string): ToolUiState {
  const k = uiKey(d, t);
  let s = toolUi.get(k);
  if (!s) { s = { mode: "view" }; toolUi.set(k, s); } // No I18N
  return s;
}
const anyEditOpen = (): boolean =>
  domainEditing || creatingDomain || creatingTool || [...toolUi.values()].some((s) => s.mode === "edit"); // No I18N

const $nav = (): HTMLElement => document.getElementById("domain-nav")!; // No I18N
const $detail = (): HTMLElement => document.getElementById("domain-detail")!; // No I18N

// ─── Persistence ─────────────────────────────────────────────────────────────

async function persist(): Promise<void> {
  try {
    await saveDomains(domains);
  } catch (e) {
    alert(String((e as Error).message)); // storage rejected the write — never pretend it saved
    domains = await loadDomains();
    render();
    throw e;
  }
}

function setHash(): void {
  const target = selected ? `#domains/${encodeURIComponent(selected)}` : "#domains"; // No I18N
  if (location.hash !== target) history.replaceState(null, "", target); // No I18N
}

// ─── Sidebar ─────────────────────────────────────────────────────────────────

function renderNav(): void {
  const nav = $nav();
  nav.innerHTML = ""; // No I18N
  for (const d of withBuiltinDomain(domains)) {
    const enabledTools = d.tools.filter((t) => t.enabled).length;
    const builtin = isBuiltinDomain(d.name);
    const li = h("li", { class: "domain-nav__item" + (d.name === selected ? " domain-nav__item--active" : "") + (builtin ? " domain-nav__item--builtin" : "") }, // No I18N
      h("span", { class: "domain-nav__dot" + (d.enabled ? " domain-nav__dot--on" : ""), title: d.enabled ? "Enabled" : "Disabled" }), // No I18N
      h("span", { class: "domain-nav__name", text: (builtin ? "🔒 " : "") + d.name }), // No I18N
      h("span", { class: "domain-nav__count", text: `${enabledTools}/${d.tools.length}` }), // No I18N
    );
    li.addEventListener("click", () => { selected = d.name; creatingDomain = false; setHash(); render(); });
    nav.append(li);
  }
}

// ─── Domain detail ───────────────────────────────────────────────────────────

function renderDetail(): void {
  const root = $detail();
  root.innerHTML = ""; // No I18N

  if (creatingDomain) { root.append(domainForm(blankDomain(), true)); return; }

  if (selected && isBuiltinDomain(selected)) { renderBuiltinDetail(root); return; }
  const d = domains.find((x) => x.name === selected);
  if (!d) {
    root.append(h("div", { class: "card" }, h("p", { class: "loading", text: domains.length ? "Select a domain on the left." : "Add a domain to get started." }))); // No I18N
    return;
  }

  // Header card
  if (domainEditing) {
    root.append(domainForm(d, false));
  } else {
    const head = h("div", { class: "card" },
      h("div", { class: "domain-head" },
        h("div", { class: "domain-head__title", text: d.name }),
        h("div", { class: "domain-head__actions" },
          h("span", { class: "card__hint", text: d.enabled ? "Enabled — tools are offered to the in-page agent / Web MCP" : "Disabled — tools hidden" }), // No I18N
          toggle(d.enabled, false, async (v) => {
            d.enabled = v;
            await persist();
            chrome.runtime.sendMessage({ type: v ? "OPEN_DOMAIN_TAB" : "CLOSE_DOMAIN_TAB", domainName: d.name }); // No I18N
            render();
          }),
          button("✎ Edit domain", "btn--ghost", () => { domainEditing = true; render(); }), // No I18N
        ),
      ),
      h("dl", { class: "kv" },
        h("dt", { text: "Base URL" }), h("dd", { class: "mono", text: d.baseUrl }), // No I18N
        h("dt", { text: "Start URL" }), h("dd", { class: "mono", text: d.startScript }), // No I18N
        h("dt", { text: "Data centres" }), h("dd", { class: "mono" }, ...(d.dcs?.length ? d.dcs.map((x) => h("div", { text: `${x.name} → ${x.baseUrl}` })) : [h("span", { class: "card__hint", text: "none — tools run on the base URL only" })])), // No I18N
        d.dcs?.length ? h("dt", { text: "Extra MCP tool" }) : null, d.dcs?.length ? h("dd", {}, h("span", { class: "chip--mono", text: toMcpToolName(d.name, DC_LIST_TOOL) }), h("span", { class: "card__hint", text: ` · every tool here also takes a "dc" argument` })) : null, // No I18N
        h("dt", { text: "Tools" }), h("dd", { text: `${d.tools.length} (${d.tools.filter((t) => t.enabled).length} enabled)` }), // No I18N
      ),
      codeBlock("Domain script (runs once per tab session)", d.domainScript || "// none", d.domainScript ? "" : "muted"), // No I18N
    );
    root.append(head);
  }

  // Tools header
  root.append(h("div", { class: "tools-head" },
    h("span", { class: "section-title", text: `Tools in ${d.name}` }), // No I18N
    button("+ Add Tool", "btn--primary", () => { creatingTool = true; render(); }), // No I18N
  ));

  if (creatingTool) root.append(toolCardEdit(d, blankTool(), -1));

  if (!d.tools.length && !creatingTool) {
    root.append(h("div", { class: "card" }, h("p", { class: "loading", text: "No tools yet." }))); // No I18N
  }
  const card = (t: StoredTool): HTMLElement => ui(d.name, t.name).mode === "edit" ? toolCardEdit(d, t, d.tools.indexOf(t)) : toolCard(d, t); // No I18N
  const { top, groups } = groupToolsByUrl(d.tools);
  for (const t of top) root.append(card(t));
  for (const g of groups) {
    root.append(h("details", { class: "url-group", open: "" }, // No I18N
      h("summary", { class: "url-group__head" }, h("span", { class: "url-group__chev" }), h("span", { class: "url-group__label", text: "Page" }), h("code", { class: "url-group__url", text: g.url }), h("span", { class: "url-group__count", text: `${g.tools.length} tool${g.tools.length === 1 ? "" : "s"}` })), // No I18N
      h("div", { class: "url-group__body" }, ...g.tools.map(card)), // No I18N
    ));
  }
}

/** The built-in ToolBridge domain: fixed name, no edit/add/delete, tools runnable from here (you are the user). */
function renderBuiltinDetail(root: HTMLElement): void {
  const d = builtinDomain();
  root.append(h("div", { class: "card" },
    h("div", { class: "domain-head" },
      h("div", { class: "domain-head__title", text: `🔒 ${d.name}` }),
      h("span", { class: "pill pill--on", text: "built-in" }), // No I18N
    ),
    h("div", { class: "card__hint", style: "margin-top:8px" }, // No I18N
      "Tools handled by the extension itself: they let an agent create or edit tools in a domain and enable them in a profile — nothing else (no deletes, no page access, no connectors). ", // No I18N
      h("b", { text: "Not part of any profile: switched on per connector script or per page grant in Web MCP, for 2 hours at a time" }), ", and every create/edit/enable asks you to Allow in an approval window. This domain cannot be edited or removed."), // No I18N
  ));
  root.append(h("div", { class: "tools-head" }, h("span", { class: "section-title", text: `Tools in ${d.name}` }))); // No I18N
  for (const t of d.tools) root.append(toolCard(d, t));
}

function button(label: string, cls: string, onClick: () => void, attrs: Record<string, string> = {}): HTMLButtonElement {
  const b = h("button", { class: `btn btn--sm ${cls}`, text: label, ...attrs }); // No I18N
  b.addEventListener("click", onClick);
  return b;
}

function codeBlock(label: string, code: string, extraClass = "", labelRight?: Node): HTMLElement {
  return h("div", { class: "block" }, // No I18N
    h("div", { class: "block__label" }, h("span", { text: label }), labelRight), // No I18N
    h("pre", { class: `code ${extraClass}`.trim(), text: code }), // No I18N
  );
}

function errorLine(): HTMLElement {
  const p = h("p", { class: "form-error" }); // No I18N
  p.style.display = "none"; // No I18N
  return p;
}
function showError(el: HTMLElement, msg: string): void { el.textContent = msg; el.style.display = ""; } // No I18N

// ─── Domain form (create / edit) ─────────────────────────────────────────────

function domainForm(d: StoredDomain, isNew: boolean): HTMLElement {
  const name = h("input", { class: "field__input", type: "text", placeholder: "e.g. LogsLocal" }); name.value = d.name; // No I18N
  const baseUrl = h("input", { class: "field__input", type: "text", placeholder: "https://logs.example.com" }); baseUrl.value = d.baseUrl; // No I18N
  const start = h("input", { class: "field__input", type: "text", placeholder: "https://logs.example.com/" }); start.value = d.startScript; // No I18N
  const script = h("textarea", { class: "field__textarea field__textarea--code", placeholder: "// optional bootstrap JS, runs once per tab session" }); script.value = d.domainScript; // No I18N
  const dcs = h("textarea", { class: "field__textarea field__textarea--dcs", placeholder: "eu = https://logs.eu.example.com\nin = https://logs.in.example.com", spellcheck: "false" }); dcs.value = formatDcLines(d.dcs); // No I18N
  const err = errorLine();

  const close = (): void => { domainEditing = false; creatingDomain = false; render(); };
  const save = async (): Promise<void> => {
    const n = name.value.trim(), b = baseUrl.value.trim(), s = start.value.trim();
    if (!n || !b || !s) { showError(err, "Name, Base URL and Start URL are required."); return; } // No I18N
    if (!isHttpUrl(b) || !isHttpUrl(s)) { showError(err, "Base URL and Start URL must be absolute http(s) URLs (e.g. https://logs.example.com)."); return; } // No I18N
    if (isBuiltinDomain(n)) { showError(err, `"${BUILTIN_DOMAIN_NAME}" is reserved for the built-in domain.`); return; } // No I18N
    if (domains.some((x) => x !== d && x.name === n)) { showError(err, `A domain named "${n}" already exists.`); return; } // No I18N
    const parsedDcs = parseDcLines(dcs.value);
    if (parsedDcs.error) { showError(err, parsedDcs.error); return; }
    const draft: StoredDomain = { ...d, name: n, baseUrl: b, startScript: s, domainScript: script.value, dcs: parsedDcs.dcs.length ? parsedDcs.dcs : undefined };
    const dcProblem = validateDomains([draft]).find((m) => /dcs/.test(m)); // No I18N
    if (dcProblem) { showError(err, dcProblem.replace(/^domains\[0\]\./, "")); return; } // No I18N
    if (isNew) {
      domains.push(draft);
    } else {
      // Rename: carry tool UI state across so open run panels survive.
      if (d.name !== n) for (const t of d.tools) { const st = toolUi.get(uiKey(d.name, t.name)); if (st) { toolUi.delete(uiKey(d.name, t.name)); toolUi.set(uiKey(n, t.name), st); } }
      Object.assign(d, draft);
      if (!draft.dcs) delete d.dcs;
    }
    selected = n;
    await persist();
    setHash();
    close();
  };
  const del = async (): Promise<void> => {
    if (!confirm(`Delete domain "${d.name}" and its ${d.tools.length} tool(s)? This cannot be undone.`)) return; // No I18N
    domains = domains.filter((x) => x !== d);
    selected = domains[0]?.name ?? null;
    await persist();
    setHash();
    close();
  };

  return h("div", { class: "card" },
    h("div", { class: "domain-head" }, h("div", { class: "domain-head__title", text: isNew ? "New domain" : `Edit ${d.name}` })), // No I18N
    h("div", { class: "edit" },
      field("Name", name), field("Base URL", "Used to match an open tab to this domain", baseUrl), field("Start URL", "Opened when the domain is enabled", start), // No I18N
      field("Domain script", "Optional JS run once per tab session (auth setup, reading page state)", script), // No I18N
      field("Other data centres", "Optional, one per line: name = https://origin. Adds a get_dc_list tool and a dc argument to every tool; a dc call runs on that origin instead of the base URL", dcs), // No I18N
      err,
      h("div", { class: "edit__actions" },
        button("Save domain", "btn--primary", () => { void save(); }), // No I18N
        button("Cancel", "btn--ghost", close), // No I18N
        h("span", { class: "spacer" }),
        !isNew && button("Delete domain", "btn--danger", () => { void del(); }), // No I18N
      ),
    ),
  );
}

function field(label: string, hintOrInput: string | HTMLElement, input?: HTMLElement): HTMLElement {
  const hint = typeof hintOrInput === "string" ? hintOrInput : undefined;
  const control = input ?? (hintOrInput as HTMLElement);
  return h("label", { class: "field" }, // No I18N
    h("span", { class: "field__label" }, label, hint ? h("span", { class: "field__hint", text: ` (${hint})` }) : null), // No I18N
    control,
  );
}

// ─── Tool card (view + run) ──────────────────────────────────────────────────

function toolCard(d: StoredDomain, t: StoredTool): HTMLElement {
  const st = ui(d.name, t.name);
  const builtin = isBuiltinDomain(d.name);
  const runBtn = button("▶ Run", st.mode === "run" ? "btn--active" : "btn--ghost", () => { st.mode = st.mode === "run" ? "view" : "run"; render(); }); // No I18N
  const editBtn = button("✎ Edit", "btn--ghost", () => { st.mode = "edit"; render(); }); // No I18N

  const card = h("div", { class: "tool-card" + (t.enabled ? "" : " tool-card--disabled") }, // No I18N
    h("div", { class: "tool-card__head" },
      h("div", { class: "tool-card__title" },
        h("span", { class: "tool-card__name", text: t.name }),
        h("span", { class: "chip--mono", text: toMcpToolName(d.name, t.name), title: "Name exposed over Web MCP" }), // No I18N
        t.requireConfirmation && h("span", { class: "pill pill--on", text: "confirm", title: "Agent calls need your approval" }), // No I18N
        t.createdBy && h("span", { class: "pill pill--off", text: `added by ${t.createdBy}`, title: `Created through ToolBridge.add_tool${t.createdAt ? ` on ${new Date(t.createdAt).toLocaleString()}` : ""}` }), // No I18N
        t.updatedBy && h("span", { class: "pill pill--off", text: `edited by ${t.updatedBy}`, title: `Changed through ToolBridge.update_tool${t.updatedAt ? ` on ${new Date(t.updatedAt).toLocaleString()}` : ""}` }), // No I18N
        builtin && h("span", { class: "pill pill--on", text: "built-in" }), // No I18N
        t.url && h("span", { class: "chip--mono", text: t.url, title: "Page this tool needs — the tab is navigated there before the script runs" }), // No I18N
        t.deferLoading && h("span", { class: "pill pill--off", text: "deferred", title: "defer_loading: Claude clients load this tool on demand via Tool Search" }), // No I18N
      ),
      h("div", { class: "tool-card__actions" },
        !builtin && h("span", { class: "card__hint", text: t.enabled ? "Enabled" : "Disabled" }), // No I18N
        !builtin && toggle(t.enabled, true, async (v) => { t.enabled = v; await persist(); render(); }),
        runBtn, !builtin && editBtn,
      ),
    ),
    h("div", { class: "tool-card__desc", text: t.description || "(no description)" }), // No I18N
    codeBlock("Input schema", JSON.stringify(t.inputSchema, null, 2)), // No I18N
    !builtin && codeBlock("Tool script", t.toolScript, "", h("span", { class: "card__hint", text: "`args` in scope · async · must return a JSON value" })), // No I18N
  );
  if (st.mode === "run") card.append(runPanel(d, t, st)); // No I18N
  return card;
}

// ─── Run panel ───────────────────────────────────────────────────────────────

type SchemaProp = { type?: string; description?: string; enum?: unknown[]; default?: unknown };

function runPanel(d: StoredDomain, t: StoredTool, st: ToolUiState): HTMLElement {
  const props = (t.inputSchema?.properties ?? {}) as Record<string, SchemaProp>;
  const required = new Set(t.inputSchema?.required ?? []);
  st.argDraft ??= {};
  const controls = new Map<string, HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>();

  const argsBox = h("div", { class: "run__args" }); // No I18N
  const names = Object.keys(props);
  if (!names.length) argsBox.append(h("p", { class: "run__empty", text: "This tool takes no arguments." })); // No I18N

  for (const name of names) {
    const p = props[name] ?? {};
    const type = p.type ?? "string"; // No I18N
    const draft = st.argDraft[name];
    let control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    let wrapper: HTMLElement;

    if (Array.isArray(p.enum) && p.enum.length) {
      const sel = h("select", { class: "field__input" }); // No I18N
      if (!required.has(name)) sel.append(h("option", { value: "", text: "(omit)" })); // No I18N
      for (const v of p.enum) sel.append(h("option", { value: String(v), text: String(v) }));
      sel.value = typeof draft === "string" ? draft : (p.default !== undefined ? String(p.default) : sel.options[0]?.value ?? "");
      control = sel;
    } else if (type === "boolean") { // No I18N
      const cb = h("input", { type: "checkbox" }); // No I18N
      cb.checked = typeof draft === "boolean" ? draft : Boolean(p.default);
      control = cb;
    } else if (type === "number" || type === "integer") { // No I18N
      const inp = h("input", { class: "field__input", type: "number", step: type === "integer" ? "1" : "any" }); // No I18N
      inp.value = typeof draft === "string" ? draft : (p.default !== undefined ? String(p.default) : "");
      control = inp;
    } else if (type === "object" || type === "array") { // No I18N
      const ta = h("textarea", { class: "field__textarea field__textarea--schema", placeholder: type === "array" ? "[ … ] JSON" : "{ … } JSON" }); // No I18N
      ta.value = typeof draft === "string" ? draft : (p.default !== undefined ? JSON.stringify(p.default, null, 2) : "");
      control = ta;
    } else {
      const inp = h("input", { class: "field__input", type: "text" }); // No I18N
      inp.value = typeof draft === "string" ? draft : (p.default !== undefined ? String(p.default) : "");
      control = inp;
    }
    controls.set(name, control);
    control.addEventListener("input", () => { st.argDraft![name] = control instanceof HTMLInputElement && control.type === "checkbox" ? control.checked : control.value; }); // No I18N
    control.addEventListener("change", () => { st.argDraft![name] = control instanceof HTMLInputElement && control.type === "checkbox" ? control.checked : control.value; }); // No I18N

    const label = h("div", { class: "arg__label" },
      h("span", { class: "chip--mono", text: name }),
      h("span", { class: "arg__type", text: type }),
      required.has(name) && h("span", { class: "arg__req", text: "required" }), // No I18N
    );
    const desc = p.description ? h("div", { class: "arg__desc", text: p.description }) : null;
    wrapper = type === "boolean" // No I18N
      ? h("div", { class: "arg" }, label, h("label", { class: "arg__check" }, control, h("span", { text: p.description ?? "true / false" }))) // No I18N
      : h("div", { class: "arg" }, label, desc, control);
    argsBox.append(wrapper);
  }

  const meta = h("span", { class: "run__meta" }); // No I18N
  const out = h("pre", { class: "code" }); // No I18N
  out.style.display = "none"; // No I18N
  const outBlock = h("div", { class: "block" }, h("div", { class: "block__label" }, h("span", { text: "Output" }), meta), out); // No I18N

  const paint = (): void => {
    if (!st.output) { out.style.display = "none"; meta.textContent = ""; return; } // No I18N
    out.style.display = ""; // No I18N
    out.textContent = st.output.text;
    out.className = "code " + (st.output.ok ? "code--ok" : "code--err"); // No I18N
    meta.className = "run__meta" + (st.output.ok ? "" : " run__meta--err"); // No I18N
    meta.textContent = `${st.output.ok ? "ok" : "error"} · ${st.output.ms} ms · ${new Date(st.output.at).toLocaleTimeString()}`; // No I18N
  };
  paint();

  const collect = (): Record<string, unknown> => {
    const args: Record<string, unknown> = {};
    for (const [name, c] of controls) {
      const p = props[name] ?? {};
      const type = p.type ?? "string"; // No I18N
      if (c instanceof HTMLInputElement && c.type === "checkbox") { args[name] = c.checked; continue; } // No I18N
      const raw = c.value;
      if (raw === "") { if (required.has(name)) throw new Error(`"${name}" is required.`); continue; } // No I18N
      if (type === "number" || type === "integer") { // No I18N
        const n = Number(raw);
        if (Number.isNaN(n)) throw new Error(`"${name}" must be a number.`); // No I18N
        args[name] = n;
      } else if (type === "object" || type === "array") { // No I18N
        try { args[name] = JSON.parse(raw); } catch { throw new Error(`"${name}" must be valid JSON.`); } // No I18N
      } else {
        args[name] = raw;
      }
    }
    return args;
  };

  const runNow = async (): Promise<void> => {
    let args: Record<string, unknown>;
    try { args = collect(); } catch (e) { st.output = { ok: false, text: String((e as Error).message), ms: 0, at: Date.now() }; paint(); return; }
    exec.disabled = true;
    exec.replaceChildren(h("span", { class: "spinner" }), " Running…"); // No I18N
    meta.textContent = `calling ${t.name} in ${d.name}…`; // No I18N
    const started = performance.now();
    try {
      const msg: RtToolExecuteMsg = { type: "TOOL_EXECUTE", id: crypto.randomUUID(), domain: d.name, toolName: t.name, args }; // No I18N
      const res = (await chrome.runtime.sendMessage(msg)) as RuntimeResponse | undefined;
      const ms = Math.round(performance.now() - started);
      if (!res) throw new Error("No response from the service worker (reload the extension)."); // No I18N
      st.output = res.ok
        ? { ok: true, text: typeof res.result === "string" ? res.result : JSON.stringify(res.result ?? null, null, 2), ms, at: Date.now() } // No I18N
        : { ok: false, text: res.error ?? "Tool failed", ms, at: Date.now() }; // No I18N
    } catch (e) {
      st.output = { ok: false, text: String(e), ms: Math.round(performance.now() - started), at: Date.now() };
    }
    exec.disabled = false;
    exec.textContent = "▶ Execute"; // No I18N
    paint();
  };

  const exec = button("▶ Execute", "btn--primary", () => { void runNow(); }); // No I18N
  const copyBtn = button("Copy output", "btn--ghost", () => { if (st.output) void navigator.clipboard.writeText(st.output.text).catch(() => {}); }); // No I18N
  const clearBtn = button("Clear", "btn--ghost", () => { st.output = undefined; paint(); }); // No I18N
  const argsJsonBtn = button("Show args JSON", "btn--ghost", () => { // No I18N
    try { st.output = { ok: true, text: JSON.stringify(collect(), null, 2), ms: 0, at: Date.now() }; } catch (e) { st.output = { ok: false, text: String((e as Error).message), ms: 0, at: Date.now() }; }
    paint();
  });

  return h("div", { class: "run" }, // No I18N
    h("div", { class: "block__label" }, h("span", { text: "Run tool" }), h("span", { class: "card__hint", text: d.enabled ? "Runs in the domain tab (opens it if needed)" : "Domain is disabled — run still works, but page agent / MCP won't see this tool" })), // No I18N
    argsBox,
    h("div", { class: "run__bar" }, exec, argsJsonBtn, copyBtn, clearBtn), // No I18N
    outBlock,
  );
}

// ─── Tool card (edit) ────────────────────────────────────────────────────────

function toolCardEdit(d: StoredDomain, t: StoredTool, idx: number): HTMLElement {
  const isNew = idx === -1;
  const name = h("input", { class: "field__input", type: "text", placeholder: "e.g. fetchLogs" }); name.value = t.name; // No I18N
  const desc = h("input", { class: "field__input", type: "text", placeholder: "What this tool does — shown to the AI" }); desc.value = t.description; // No I18N
  const schema = h("textarea", { class: "field__textarea field__textarea--schema", placeholder: DEFAULT_SCHEMA_JSON }); schema.value = JSON.stringify(t.inputSchema, null, 2); // No I18N
  const script = h("textarea", { class: "field__textarea field__textarea--code", placeholder: "// `args` is in scope, await works, must `return` a JSON value" }); script.value = t.toolScript; // No I18N
  const enabledCb = h("input", { type: "checkbox" }); enabledCb.checked = t.enabled; // No I18N
  const confirmCb = h("input", { type: "checkbox" }); confirmCb.checked = !!t.requireConfirmation; // No I18N
  const deferCb = h("input", { type: "checkbox" }); deferCb.checked = !!t.deferLoading; // No I18N
  const url = h("input", { class: "field__input", type: "text", placeholder: "/app/reports (optional)", spellcheck: "false" }); url.value = t.url ?? ""; // No I18N
  const err = errorLine();
  const mcpPreview = h("span", { class: "chip--mono", text: toMcpToolName(d.name, t.name || "…") }); // No I18N
  name.addEventListener("input", () => { mcpPreview.textContent = toMcpToolName(d.name, name.value || "…"); }); // No I18N

  const close = (): void => {
    if (isNew) creatingTool = false; else ui(d.name, t.name).mode = "view"; // No I18N
    render();
  };
  const save = async (): Promise<void> => {
    const n = name.value.trim();
    if (!n) { showError(err, "Name is required."); return; } // No I18N
    if (!script.value.trim()) { showError(err, "Tool script is required."); return; } // No I18N
    if (d.tools.some((x) => x !== t && x.name === n)) { showError(err, `A tool named "${n}" already exists in ${d.name}.`); return; } // No I18N
    let inputSchema: StoredTool["inputSchema"];
    try {
      const parsed = JSON.parse(schema.value.trim() || DEFAULT_SCHEMA_JSON) as StoredTool["inputSchema"];
      if (typeof parsed !== "object" || parsed === null || parsed.type !== "object") throw new Error(); // No I18N
      parsed.properties ??= {};
      parsed.required ??= [];
      parsed.additionalProperties ??= false;
      inputSchema = parsed;
    } catch { showError(err, 'Input schema must be valid JSON with "type": "object".'); return; } // No I18N
    const u = url.value.trim();
    if (u && !isRelativeUrl(u)) { showError(err, 'Page URL must be relative to the domain and start with "/" (e.g. /app/reports).'); return; } // No I18N

    const next: StoredTool = { name: n, description: desc.value.trim(), inputSchema, toolScript: script.value, enabled: enabledCb.checked, requireConfirmation: confirmCb.checked, url: u || undefined, deferLoading: deferCb.checked || undefined };
    if (isNew) {
      d.tools.push(next);
      creatingTool = false;
    } else {
      const oldKey = uiKey(d.name, t.name);
      Object.assign(t, next);
      if (!next.url) delete t.url;
      if (!next.deferLoading) delete t.deferLoading;
      const st = toolUi.get(oldKey); toolUi.delete(oldKey);
      toolUi.set(uiKey(d.name, n), { ...(st ?? { mode: "view" }), mode: "view" }); // No I18N
    }
    await persist();
    render();
  };
  const del = async (): Promise<void> => {
    if (!confirm(`Delete tool "${t.name}"?`)) return; // No I18N
    d.tools.splice(idx, 1);
    toolUi.delete(uiKey(d.name, t.name));
    await persist();
    render();
  };

  return h("div", { class: "tool-card" },
    h("div", { class: "tool-card__head" },
      h("div", { class: "tool-card__title" }, h("span", { class: "tool-card__name", text: isNew ? "New tool" : `Edit ${t.name}` }), mcpPreview), // No I18N
      h("div", { class: "tool-card__actions" },
        h("label", { class: "arg__check" }, enabledCb, h("span", { text: "Enabled" })), // No I18N
        h("label", { class: "arg__check", title: "Agent calls (connectors, granted pages) show an approval window you must Allow first" }, confirmCb, h("span", { text: "Require confirmation" })), // No I18N
        h("label", { class: "arg__check", title: "Emits defer_loading in the MCP definition: Claude clients keep the tool out of the initial context and load it on demand via Tool Search" }, deferCb, h("span", { text: "Defer loading" })), // No I18N
      ),
    ),
    h("div", { class: "edit" },
      field("Name", name), field("Description", "Shown to the in-page agent / MCP clients — be specific", desc), // No I18N
      field("Page URL", "Optional relative path (starts with /) the tool only works on; the tab is navigated there before the script runs", url), // No I18N
      field("Input schema", "JSON Schema object; properties drive the Run form", schema), // No I18N
      field("Tool script", "Function body run inside the domain tab", script), // No I18N
      err,
      h("div", { class: "edit__actions" },
        button(isNew ? "Create tool" : "Save tool", "btn--primary", () => { void save(); }), // No I18N
        button("Cancel", "btn--ghost", close), // No I18N
        h("span", { class: "spacer" }),
        !isNew && button("Delete tool", "btn--danger", () => { void del(); }), // No I18N
      ),
    ),
  );
}

// ─── Render + init ───────────────────────────────────────────────────────────

function render(): void {
  if (selected && !isBuiltinDomain(selected) && !domains.some((d) => d.name === selected)) selected = null;
  if (!selected && !creatingDomain) selected = domains[0]?.name ?? BUILTIN_DOMAIN_NAME;
  renderNav();
  renderDetail();
}

async function reload(): Promise<void> {
  if (anyEditOpen()) { deferredReload = true; return; }
  domains = await loadDomains();
  render();
}

/** Select a domain from the URL hash (#domains/<name>). */
export function selectFromHash(hash: string): void {
  const m = /^#domains\/(.+)$/.exec(hash); // No I18N
  if (m) {
    let name = ""; try { name = decodeURIComponent(m[1]); } catch { return; }
    if (isBuiltinDomain(name) || domains.some((d) => d.name === name)) { selected = name; render(); }
  }
}

/** Wires the Domains & Tools tab. Call once. */
export async function initDomainsView(): Promise<void> {
  domains = await loadDomains();
  selectFromHash(location.hash);
  render();

  document.getElementById("btn-new-domain")!.addEventListener("click", () => { creatingDomain = true; domainEditing = false; render(); }); // No I18N

  // Export / Import (moved here from the popup; the popup is read-only now).
  const msgEl = document.getElementById("import-msg")!; // No I18N
  const say = (text: string, isError: boolean): void => { msgEl.textContent = text; msgEl.className = isError ? "card__hint form-error" : "card__hint form-success"; msgEl.style.display = ""; }; // No I18N
  document.getElementById("btn-export")!.addEventListener("click", () => { // No I18N
    const url = URL.createObjectURL(new Blob([exportDomainsJson(domains)], { type: "application/json" })); // No I18N
    const a = document.createElement("a"); a.href = url; a.download = exportFilename(); document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5_000);
  });
  const fileInput = document.getElementById("input-import-file") as HTMLInputElement; // No I18N
  document.getElementById("btn-import")!.addEventListener("click", () => { fileInput.value = ""; fileInput.click(); }); // No I18N
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      const preview = previewImport(await file.text(), domains);
      if (!preview.added) { say("Nothing new to merge — all items already exist.", false); return; } // No I18N
      if (!confirm(`Import ${preview.added} item(s)?\n\n${preview.summary}\n\nImported tool scripts run inside your browser with your cookies once enabled. Only import files you trust.`)) return; // No I18N
      domains = preview.next;
      await persist();
      say(`Merged ${preview.added} new item(s) — all disabled until you enable them.`, false); // No I18N
    } catch (e) {
      say(String((e as Error).message), true);
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes["domains"]) void reload(); // No I18N
  });

  // Edits closed → apply any storage change we skipped while a form was open.
  setInterval(() => { if (deferredReload && !anyEditOpen()) { deferredReload = false; void reload(); } }, 1000);
}
