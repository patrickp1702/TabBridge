/**
 * builtin-tools.ts — native handlers for the read-only "ToolBridge" domain.
 *
 * Dependency-injected (storage + confirm) so the logic is unit-testable in
 * plain Node. Every mutating call (add_tool, update_tool, enable_tool_in_profile)
 * requires the user's Allow in the approval window; read calls never return
 * scripts. Whether a caller may reach these tools at all is decided earlier,
 * by its own 2-hour ToolBridge grant (resolveExposedTools) — not here.
 */
import type { StoredDomain, StoredTool, ToolProfile, McpBridgeConfig } from "../types/plugin.types";
import { BUILTIN_DOMAIN_NAME, isBuiltinDomain, restartNote } from "../utils/builtin";
import { toMcpToolName } from "../utils/mcp";
import { isConnectorLive, isHttpUrl, isRelativeUrl, resolveProfileTools, sameOrigin, validateDomains } from "../utils/profiles";

export interface BuiltinDeps {
  loadDomains(): Promise<StoredDomain[]>;
  saveDomains(d: StoredDomain[]): Promise<void>;
  loadProfiles(): Promise<ToolProfile[]>;
  saveProfiles(p: ToolProfile[]): Promise<void>;
  /** Ask the user (approval window); resolves false on deny / timeout / closed. */
  confirm(req: ConfirmInput): Promise<boolean>;
  /** Optional: lets add_tool tell the user which connectors / pages can call the new tool right away. */
  loadBridgeConfig?(): Promise<McpBridgeConfig>;
}

/** Mirrors confirm.ts ConfirmRequest without the deadline (kept local so this module stays chrome-free). */
export interface ConfirmInput { title: string; caller: string; fields: Record<string, string>; code?: string; codeLabel?: string }

const NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,47}$/;
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : ""); // No I18N

function toolSummary(d: StoredDomain) {
  return { name: d.name, baseUrl: d.baseUrl, startUrl: d.startScript, enabled: d.enabled, dcs: (d.dcs ?? []).map((x) => ({ name: x.name, baseUrl: x.baseUrl })), tools: d.tools.map((t) => ({ name: t.name, description: t.description, enabled: t.enabled, requireConfirmation: !!t.requireConfirmation, url: t.url ?? null, deferLoading: !!t.deferLoading, createdBy: t.createdBy ?? null, mcpName: toMcpToolName(d.name, t.name) })) };
}

/**
 * Who can call `domain/tool` the moment it is saved: every profile that
 * selects it (a `"*"` domain selection or a stale explicit entry counts), and
 * the live connectors / page origins bound to those profiles. New tools arrive
 * enabled, so this is shown in the approval window instead of a misleading
 * "not callable until enabled".
 */
export function immediateExposure(candidate: StoredDomain[], domain: string, tool: string, profiles: ToolProfile[], cfg: McpBridgeConfig | undefined, alsoProfileId?: string): { profiles: string[]; callers: string[]; text: string } {
  const exposing = profiles.filter((p) => p.id === alsoProfileId || resolveProfileTools(p, candidate).some((t) => t.domain === domain && t.toolName === tool));
  const ids = new Set(exposing.map((p) => p.id));
  const callers = [
    ...(cfg?.connectors ?? []).filter((c) => ids.has(c.profileId) && isConnectorLive(c)).map((c) => `connector ${c.label}`), // No I18N
    ...(cfg?.pageAccess ?? []).filter((g) => ids.has(g.profileId)).map((g) => `page ${g.origin}`), // No I18N
  ];
  const names = exposing.map((p) => p.name);
  const text = !names.length
    ? "nobody yet — no profile selects it (enable it in a profile to expose it)" // No I18N
    : `profile${names.length > 1 ? "s" : ""} ${names.join(", ")} → ${callers.length ? callers.join(", ") : "no connector or page uses these profiles yet"}`; // No I18N
  return { profiles: names, callers, text };
}

/** Origins a script of this domain can be sent to: the base URL plus every configured data centre. */
function runsOn(d: StoredDomain): string {
  const origins = [d.baseUrl, ...(d.dcs ?? []).map((x) => `${x.baseUrl} (dc ${x.name})`)]; // No I18N
  return origins.join(", ");
}

function addToProfile(profile: ToolProfile, domain: string, tool: string): boolean {
  const sel = profile.domains[domain];
  if (sel === "*") return false; // No I18N — already covered
  const list = Array.isArray(sel) ? sel : [];
  if (list.includes(tool)) return false;
  profile.domains[domain] = [...list, tool];
  return true;
}

export async function runBuiltinTool(deps: BuiltinDeps, caller: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
  switch (toolName) {
    case "list_domains": { // No I18N
      return { domains: (await deps.loadDomains()).map(toolSummary), note: `The built-in domain "${BUILTIN_DOMAIN_NAME}" is not listed; it cannot be modified.` }; // No I18N
    }
    case "list_profiles": { // No I18N
      return { profiles: (await deps.loadProfiles()).map((p) => ({ name: p.name, description: p.description, domains: p.domains })) };
    }
    case "add_tool": return addTool(deps, caller, args); // No I18N
    case "update_tool": return updateTool(deps, caller, args); // No I18N
    case "enable_tool_in_profile": return enableToolInProfile(deps, caller, args); // No I18N
    default: throw new Error(`Unknown built-in tool: ${toolName}`); // No I18N
  }
}

async function addTool(deps: BuiltinDeps, caller: string, args: Record<string, unknown>): Promise<unknown> {
  const domainName = str(args["domain"]), name = str(args["name"]), description = str(args["description"]), script = typeof args["script"] === "string" ? args["script"] : ""; // No I18N
  const profileName = str(args["profile"]); // No I18N
  if (!NAME_RE.test(domainName)) throw new Error("domain must be 1–48 chars: letters, digits, _ or -, starting with a letter"); // No I18N
  if (isBuiltinDomain(domainName)) throw new Error(`"${BUILTIN_DOMAIN_NAME}" is the built-in domain and cannot receive tools`); // No I18N
  if (!NAME_RE.test(name)) throw new Error("name must be 1–48 chars: letters, digits, _ or -, starting with a letter"); // No I18N
  if (!description) throw new Error("description is required"); // No I18N
  if (!script.trim()) throw new Error("script is required"); // No I18N
  if (!/\breturn\b/.test(script)) throw new Error("script must `return` a value"); // No I18N
  const schemaIn = args["inputSchema"]; // No I18N
  const inputSchema: StoredTool["inputSchema"] = schemaIn === undefined || schemaIn === null
    ? { type: "object", properties: {}, required: [], additionalProperties: false } // No I18N
    : (schemaIn as StoredTool["inputSchema"]);
  if (typeof inputSchema !== "object" || inputSchema.type !== "object") throw new Error('inputSchema must be an object schema with type "object"'); // No I18N
  inputSchema.properties ??= {}; inputSchema.required ??= []; inputSchema.additionalProperties ??= false;

  const domains = await deps.loadDomains();
  let domain = domains.find((d) => d.name === domainName);
  let createdDomain = false;
  if (!domain) {
    const baseUrl = str(args["baseUrl"]), startUrl = str(args["startUrl"]); // No I18N
    if (!isHttpUrl(baseUrl) || !isHttpUrl(startUrl)) throw new Error(`Domain "${domainName}" does not exist; pass baseUrl and startUrl (absolute http(s) URLs) to create it`); // No I18N
    if (!sameOrigin(baseUrl, startUrl)) throw new Error("startUrl must be on the same origin as baseUrl"); // No I18N
    domain = { name: domainName, baseUrl, startScript: startUrl, domainScript: "", enabled: true, tools: [] };
    createdDomain = true;
  } else if (domain.tools.some((t) => t.name === name)) {
    throw new Error(`Tool "${name}" already exists in domain "${domainName}". Pick another name, or call update_tool to change the existing one.`); // No I18N
  }

  let profile: ToolProfile | undefined;
  if (profileName) {
    profile = (await deps.loadProfiles()).find((p) => p.name === profileName);
    if (!profile) throw new Error(`Profile "${profileName}" not found. Call list_profiles.`); // No I18N
  }

  const url = str(args["url"]); // No I18N
  if (url && !isRelativeUrl(url)) throw new Error('url must be a relative path starting with "/" (no scheme or host)'); // No I18N
  const tool: StoredTool = { name, description, inputSchema, toolScript: script, enabled: true, requireConfirmation: false, createdBy: caller, createdAt: Date.now(), url: url || undefined, deferLoading: args["deferLoading"] === true || undefined }; // No I18N
  const candidate = [...domains.filter((d) => d !== domain), { ...domain, tools: [...domain.tools, tool] }];
  const problems = validateDomains(candidate);
  if (problems.length) throw new Error(`Rejected: ${problems.slice(0, 3).join("; ")}`); // No I18N
  const exposure = immediateExposure(candidate, domainName, name, await deps.loadProfiles(), deps.loadBridgeConfig ? await deps.loadBridgeConfig() : undefined, profile?.id);

  const fields: Record<string, string> = {
    Domain: createdDomain ? `${domainName} (NEW — ${domain.baseUrl}, opens ${domain.startScript})` : domainName, // No I18N
    Tool: `${name}  →  MCP name ${toMcpToolName(domainName, name)}`, // No I18N
    Description: description,
    Page: url || "any page of the domain", // No I18N
    "Defer loading": tool.deferLoading ? "yes (Tool Search)" : "no", // No I18N
    Arguments: Object.keys(inputSchema.properties).length ? Object.entries(inputSchema.properties).map(([k, v]) => `${k} (${(v as { type?: string }).type ?? "any"})${inputSchema.required.includes(k) ? " *" : ""}`).join(", ") : "none", // No I18N
    "Enable in profile": profile ? profile.name : "none requested", // No I18N
    "Runs on": runsOn(domain), // No I18N
    "Callable right away by": exposure.text, // New tools arrive enabled: say who sees it, honestly. // No I18N
  };
  const approved = await deps.confirm({
    title: `${caller} wants to add tool "${name}"${createdDomain ? ` and create domain "${domainName}"` : ` to ${domainName}`}`, // No I18N
    caller, fields, code: script, codeLabel: "Tool script — runs in a tab of this domain with your session", // No I18N
  });
  if (!approved) throw new Error("The user did not approve adding this tool."); // No I18N

  // The approval window can stay open for 40 s. Re-load and apply ONLY this change on top of whatever is stored
  // now, so a toggle the user flipped meanwhile (or another agent's approved change) is never overwritten.
  const fresh = await deps.loadDomains();
  let target = fresh.find((d) => d.name === domainName);
  if (!target) {
    if (!createdDomain) throw new Error(`Domain "${domainName}" was removed while waiting for approval; nothing saved.`); // No I18N
    target = { ...domain, tools: [] }; fresh.push(target);
  }
  if (target.tools.some((t) => t.name === name)) throw new Error(`A tool named "${name}" appeared in "${domainName}" while waiting for approval; nothing saved.`); // No I18N
  target.tools.push(tool);
  const lateProblems = validateDomains(fresh);
  if (lateProblems.length) throw new Error(`Rejected after approval: ${lateProblems.slice(0, 3).join("; ")}`); // No I18N
  await deps.saveDomains(fresh);
  let enabledInProfile = false;
  if (profile) {
    const profiles = await deps.loadProfiles();
    const p = profiles.find((x) => x.id === profile!.id);
    if (p) { enabledInProfile = addToProfile(p, domainName, name); await deps.saveProfiles(profiles); }
  }
  const mcpName = toMcpToolName(domainName, name);
  return {
    ok: true,
    createdDomain,
    domain: domainName,
    tool: name,
    mcpName,
    enabledInProfile: profile ? profile.name : null,
    exposedTo: exposure.profiles,
    message:
      `Added tool "${name}" to domain "${domainName}"${createdDomain ? " (domain created)" : ""}` + // No I18N
      (profile ? (enabledInProfile ? ` and enabled it in profile "${profile.name}". ` : `; profile "${profile.name}" already covered it. `) : ". ") + // No I18N
      (exposure.profiles.length ? `Exposed to ${exposure.text}. ` : "No profile selects it yet — call enable_tool_in_profile, or the user can tick it in Settings → Profiles. ") + // No I18N
      restartNote(mcpName),
  };
}

async function updateTool(deps: BuiltinDeps, caller: string, args: Record<string, unknown>): Promise<unknown> {
  const domainName = str(args["domain"]), toolName = str(args["tool"]); // No I18N
  if (isBuiltinDomain(domainName)) throw new Error(`Built-in ${BUILTIN_DOMAIN_NAME} tools cannot be edited.`); // No I18N
  const domains = await deps.loadDomains();
  const domain = domains.find((d) => d.name === domainName);
  if (!domain) throw new Error(`Domain "${domainName}" not found. Call list_domains.`); // No I18N
  const idx = domain.tools.findIndex((t) => t.name === toolName);
  if (idx < 0) throw new Error(`Tool "${toolName}" not found in domain "${domainName}".`); // No I18N
  const current = domain.tools[idx];

  const changes: string[] = [];
  const next: StoredTool = { ...current };
  if (args["newName"] !== undefined) { // No I18N
    const n = str(args["newName"]); // No I18N
    if (!NAME_RE.test(n)) throw new Error("newName must be 1–48 chars: letters, digits, _ or -, starting with a letter"); // No I18N
    if (n !== current.name && domain.tools.some((t) => t.name === n)) throw new Error(`A tool named "${n}" already exists in domain "${domainName}".`); // No I18N
    if (n !== current.name) { next.name = n; changes.push(`name: ${current.name} → ${n}`); } // No I18N
  }
  if (args["description"] !== undefined) { // No I18N
    const d = str(args["description"]); // No I18N
    if (!d) throw new Error("description cannot be empty"); // No I18N
    if (d !== current.description) { next.description = d; changes.push("description"); } // No I18N
  }
  if (args["inputSchema"] !== undefined && args["inputSchema"] !== null) { // No I18N
    const sch = args["inputSchema"] as StoredTool["inputSchema"]; // No I18N
    if (typeof sch !== "object" || sch.type !== "object") throw new Error('inputSchema must be an object schema with type "object"'); // No I18N
    sch.properties ??= {}; sch.required ??= []; sch.additionalProperties ??= false;
    next.inputSchema = sch; changes.push("inputSchema"); // No I18N
  }
  if (args["script"] !== undefined) { // No I18N
    const sc = typeof args["script"] === "string" ? args["script"] : ""; // No I18N
    if (!sc.trim()) throw new Error("script cannot be empty"); // No I18N
    if (!/\breturn\b/.test(sc)) throw new Error("script must `return` a value"); // No I18N
    if (sc !== current.toolScript) { next.toolScript = sc; changes.push("script"); } // No I18N
  }
  if (args["url"] !== undefined) { // No I18N
    const u = str(args["url"]); // No I18N
    if (u && !isRelativeUrl(u)) throw new Error('url must be a relative path starting with "/" (no scheme or host)'); // No I18N
    if ((u || undefined) !== current.url) { next.url = u || undefined; changes.push(`url: ${current.url ?? "(any)"} → ${u || "(any)"}`); } // No I18N
  }
  if (args["deferLoading"] !== undefined) { // No I18N
    const dl = args["deferLoading"] === true; // No I18N
    if (dl !== !!current.deferLoading) { next.deferLoading = dl || undefined; changes.push(`deferLoading: ${dl}`); } // No I18N
  }
  if (!changes.length) return { ok: true, changed: false, message: `Nothing to change for ${domainName}/${toolName}.` }; // No I18N
  next.updatedBy = caller; next.updatedAt = Date.now();

  const candidate = domains.map((d) => (d !== domain ? d : { ...d, tools: d.tools.map((t, i) => (i === idx ? next : t)) }));
  const problems = validateDomains(candidate);
  if (problems.length) throw new Error(`Rejected: ${problems.slice(0, 3).join("; ")}`); // No I18N
  // An edited script goes live at once for everyone who already has the tool: say so in the window.
  const exposure = immediateExposure(candidate, domainName, next.name, await deps.loadProfiles(), deps.loadBridgeConfig ? await deps.loadBridgeConfig() : undefined);

  const approved = await deps.confirm({
    title: `${caller} wants to edit tool "${toolName}" in ${domainName}`, // No I18N
    caller,
    fields: {
      Domain: domainName,
      Tool: next.name === current.name ? toolName : `${toolName} → ${next.name}`, // No I18N
      Changes: changes.join(", "), // No I18N
      Description: next.description,
      Arguments: Object.keys(next.inputSchema.properties).length ? Object.entries(next.inputSchema.properties).map(([k, v]) => `${k} (${(v as { type?: string }).type ?? "any"})${next.inputSchema.required.includes(k) ? " *" : ""}`).join(", ") : "none", // No I18N
      "Runs on": runsOn(domain), // No I18N
      "Callable right away by": current.enabled ? exposure.text : `nobody — the tool is switched off globally (${exposure.text} once switched on)`, // No I18N
      "Created by": current.createdBy ?? "user (settings page)", // No I18N
    },
    code: changes.includes("script") ? next.toolScript : undefined, codeLabel: "NEW tool script — replaces the current one", // No I18N
  });
  if (!approved) throw new Error("The user did not approve editing this tool."); // No I18N

  // Re-load and apply only the approved field changes on top of the CURRENT tool (see addTool for why).
  const fresh = await deps.loadDomains();
  const freshDomain = fresh.find((d) => d.name === domainName);
  const freshIdx = freshDomain?.tools.findIndex((t) => t.name === current.name) ?? -1;
  if (!freshDomain || freshIdx < 0) throw new Error(`${domainName}/${current.name} was removed or renamed while waiting for approval; nothing saved.`); // No I18N
  if (next.name !== current.name && freshDomain.tools.some((t) => t.name === next.name)) throw new Error(`A tool named "${next.name}" appeared meanwhile; nothing saved.`); // No I18N
  const applied: StoredTool = { ...freshDomain.tools[freshIdx] };
  for (const k of ["name", "description", "inputSchema", "toolScript", "url", "deferLoading", "updatedBy", "updatedAt"] as const) {
    if (next[k] !== current[k]) (applied as unknown as Record<string, unknown>)[k] = next[k];
  }
  freshDomain.tools[freshIdx] = applied;
  const lateProblems = validateDomains(fresh);
  if (lateProblems.length) throw new Error(`Rejected after approval: ${lateProblems.slice(0, 3).join("; ")}`); // No I18N
  await deps.saveDomains(fresh);
  // Keep profile selections pointing at a renamed tool.
  if (next.name !== current.name) {
    const profiles = await deps.loadProfiles();
    let touched = false;
    for (const p of profiles) {
      const sel = p.domains[domainName];
      if (Array.isArray(sel) && sel.includes(current.name)) { p.domains[domainName] = sel.map((n) => (n === current.name ? next.name : n)); touched = true; }
    }
    if (touched) await deps.saveProfiles(profiles);
  }
  const mcpName = toMcpToolName(domainName, next.name);
  return {
    ok: true, changed: true, domain: domainName, tool: next.name, changes, mcpName,
    message: `Updated ${domainName}/${toolName} (${changes.join(", ")}). ` + (next.name !== current.name
      ? `The tool was renamed: ${restartNote(mcpName)}` // No I18N
      : `Script/metadata changes apply immediately — call "${mcpName}" again now, no restart needed.`), // No I18N
  };
}

async function enableToolInProfile(deps: BuiltinDeps, caller: string, args: Record<string, unknown>): Promise<unknown> {
  const domainName = str(args["domain"]), toolName = str(args["tool"]), profileName = str(args["profile"]); // No I18N
  if (isBuiltinDomain(domainName)) throw new Error(`Built-in ${BUILTIN_DOMAIN_NAME} tools can only be enabled by the user in the Profiles tab.`); // No I18N
  const domain = (await deps.loadDomains()).find((d) => d.name === domainName);
  if (!domain) throw new Error(`Domain "${domainName}" not found. Call list_domains.`); // No I18N
  const tool = domain.tools.find((t) => t.name === toolName);
  if (!tool) throw new Error(`Tool "${toolName}" not found in domain "${domainName}".`); // No I18N
  const profiles = await deps.loadProfiles();
  const profile = profiles.find((p) => p.name === profileName);
  if (!profile) throw new Error(`Profile "${profileName}" not found. Call list_profiles.`); // No I18N
  if (profile.domains[domainName] === "*" || (Array.isArray(profile.domains[domainName]) && (profile.domains[domainName] as string[]).includes(toolName))) { // No I18N
    return { ok: true, changed: false, mcpName: toMcpToolName(domainName, toolName), message: `Profile "${profileName}" already exposes ${domainName}/${toolName}. If it is missing from your tool list, the user must restart the MCP connection.` }; // No I18N
  }
  const cfg = deps.loadBridgeConfig ? await deps.loadBridgeConfig() : undefined;
  const exposure = immediateExposure(await deps.loadDomains(), domainName, toolName, profiles, cfg, profile.id);
  const ok = await deps.confirm({
    title: `${caller} wants to enable ${domainName}/${toolName} in profile "${profileName}"`, // No I18N
    caller,
    fields: { Domain: domainName, Tool: toolName, Description: tool.description, Profile: profileName, "Runs on": runsOn(domain), "Callable right away by": tool.enabled ? exposure.text : `nobody — the tool is switched off globally (${exposure.text} once switched on)` }, // No I18N
    code: tool.toolScript, codeLabel: "Tool script", // No I18N
  });
  if (!ok) throw new Error("The user did not approve enabling this tool."); // No I18N
  // Re-load: profiles may have changed while the window was open (see addTool).
  const freshProfiles = await deps.loadProfiles();
  const freshProfile = freshProfiles.find((p) => p.id === profile.id);
  if (!freshProfile) throw new Error(`Profile "${profileName}" was deleted while waiting for approval; nothing saved.`); // No I18N
  addToProfile(freshProfile, domainName, toolName);
  await deps.saveProfiles(freshProfiles);
  const mcpName = toMcpToolName(domainName, toolName);
  return { ok: true, changed: true, mcpName, message: `Enabled ${domainName}/${toolName} in profile "${profileName}". ${restartNote(mcpName)}` }; // No I18N
}
