/**
 * builtin.ts — the read-only "ToolBridge" domain.
 *
 * Its tools have no script; the service worker handles them natively
 * (builtin-tools.ts). They let an agent create tools and enable them in a
 * profile, or edit an existing one — nothing else (no delete, no page access, no connectors).
 *
 * The domain is virtual: never stored, appended by withBuiltinDomain() for
 * display. It is NOT part of any profile (profiles are plain tool collections):
 * it is exposed to one connector script or one page-access grant while that
 * caller's `builderUntil` is in the future (Web MCP tab switch, 2 hours), and
 * every create/edit/enable still needs the user's Allow in an approval window.
 */
import type { BuilderGrant, McpBridgeConfig, StoredDomain, StoredTool } from "../types/plugin.types";

export const BUILTIN_DOMAIN_NAME = "ToolBridge"; // No I18N

/** How long a ToolBridge grant on a connector / page grant stays active after the user switches it on. */
export const BUILDER_GRANT_MS = 2 * 60 * 60 * 1000;

/** True while the caller's ToolBridge grant is inside its 2-hour window. */
export function isBuilderActive(grant: BuilderGrant | undefined, now = Date.now()): boolean {
  return !!grant && typeof grant.builderUntil === "number" && grant.builderUntil > now;
}

/** Caller with the grant switched on for the next 2 hours (or cleared). */
export function withBuilderGrant<T extends BuilderGrant>(caller: T, on: boolean, now = Date.now()): T {
  const { builderUntil: _drop, ...rest } = caller; void _drop;
  return on ? ({ ...rest, builderUntil: now + BUILDER_GRANT_MS } as T) : (rest as T);
}

/** Clears elapsed ToolBridge grants on connectors and page grants (so the Web MCP switches visibly turn off). */
export function purgeExpiredBuilderGrants(cfg: McpBridgeConfig, now = Date.now()): { cfg: McpBridgeConfig; changed: boolean } {
  let changed = false;
  const clear = <T extends BuilderGrant>(c: T): T => {
    if (c.builderUntil === undefined || isBuilderActive(c, now)) return c;
    changed = true;
    return withBuilderGrant(c, false, now);
  };
  const connectors = cfg.connectors.map(clear), pageAccess = cfg.pageAccess.map(clear);
  return { cfg: changed ? { ...cfg, connectors, pageAccess } : cfg, changed };
}

export type BuilderCallerKind = "connector" | "page";

/**
 * What an agent gets when it calls a ToolBridge tool without an active grant.
 * Written to be relayed to the user verbatim.
 */
export function builderDeniedMessage(kind: BuilderCallerKind, label: string): string {
  const where = kind === "connector" ? `connector script "${label}" (Web MCP → Connectors)` : `page ${label} (Web MCP → Page access)`; // No I18N
  return (
    `NOT AUTHORIZED to create or edit tools: ToolBridge is not active for ${where} — it was never switched on, or its 2-hour window has expired. ` + // No I18N
    `Tell the user to do this: open the TabBridge extension → ⚙ Settings → Web MCP → find "${label}" in the list → switch on "🔒 ToolBridge". ` + // No I18N
    `That enables tool creation for 2 hours for this ${kind} only. Then retry this call. ` + // No I18N
    `If ToolBridge tools are missing from your tool list entirely, the user must also restart this MCP connection (restart the agent / reconnect the "tabbridge" MCP server) after enabling.` // No I18N
  );
}

/** Appended to successful add/enable results — the relay cannot push list_changed, so the agent must be restarted. */
export function restartNote(mcpName: string): string {
  return (
    `IMPORTANT — tell the user: the tool was saved, but it will NOT appear in this agent's tool list until the MCP connection is restarted ` + // No I18N
    `(restart the agent, or disconnect/reconnect the "tabbridge" MCP server). After the restart, call it as "${mcpName}". ` + // No I18N
    `If more tools are added later, restart again each time.` // No I18N
  );
}

const SCHEMA = (properties: Record<string, { type: string; description: string }>, required: string[]): StoredTool["inputSchema"] =>
  ({ type: "object", properties, required, additionalProperties: false }); // No I18N

export const BUILTIN_TOOLS: StoredTool[] = [
  {
    name: "list_domains", // No I18N
    description: "Lists the domains configured in TabBridge with their base URL, enabled state and tool names/descriptions. Scripts are never returned. Use this before add_tool to pick an existing domain or confirm a new one is needed.", // No I18N
    inputSchema: SCHEMA({}, []),
    toolScript: "",
    enabled: true,
  },
  {
    name: "list_profiles", // No I18N
    description: "Lists TabBridge profiles (name, description, which domains/tools each exposes). Use this to choose the profile to enable a new tool in.", // No I18N
    inputSchema: SCHEMA({}, []),
    toolScript: "",
    enabled: true,
  },
  {
    name: "add_tool", // No I18N
    description:
      "Creates a new tool in a TabBridge domain (and creates the domain if it does not exist — then baseUrl and startUrl are required). The script is a JavaScript function body that runs inside a tab of that domain with the user's session; `args` is in scope, `await` works, it must `return` a JSON value. Optionally enables the tool in a profile in the same step. REQUIRES the user to have switched on ToolBridge for THIS connector or page (Web MCP tab) within the last 2 hours (otherwise you get a NOT AUTHORIZED message with instructions to relay) AND to approve the creation in an approval window. New tools only appear in your tool list after the MCP connection is restarted — tell the user. Cannot delete tools (use update_tool to edit), cannot touch page access or connectors.", // No I18N
    inputSchema: SCHEMA({
      domain: { type: "string", description: "Domain name, e.g. \"Logs\". Existing name or a new one (letters, digits, _ -)." }, // No I18N
      baseUrl: { type: "string", description: "Required only for a new domain: origin of the site, e.g. https://logs.example.com" }, // No I18N
      startUrl: { type: "string", description: "Required only for a new domain: URL opened to establish the session, e.g. https://logs.example.com/app" }, // No I18N
      name: { type: "string", description: "Tool name (letters, digits, _ -), unique within the domain" }, // No I18N
      description: { type: "string", description: "What the tool does, written for an AI agent: inputs, output shape, side effects" }, // No I18N
      inputSchema: { type: "object", description: "JSON Schema of the tool's arguments: {type:\"object\", properties:{...}, required:[...]}. Omit for a no-argument tool." }, // No I18N
      script: { type: "string", description: "JavaScript function body. `args` holds the arguments; use fetch with credentials:'include'; return a JSON-serialisable value." }, // No I18N
      url: { type: "string", description: "Optional relative page path (starts with /) the tool needs, e.g. /app/reports — the tab is navigated there before the script runs." }, // No I18N
      deferLoading: { type: "boolean", description: "Optional. true = Claude clients load this tool on demand via Tool Search instead of upfront (emitted as defer_loading)." }, // No I18N
      profile: { type: "string", description: "Optional profile name to enable the new tool in (same approval)." }, // No I18N
    }, ["domain", "name", "description", "script"]), // No I18N
    toolScript: "",
    enabled: true,
  },
  {
    name: "update_tool", // No I18N
    description:
      "Edits an EXISTING tool of a TabBridge domain: any of description, inputSchema, script and/or a new name. Fields you omit stay unchanged. Use it to fix a tool after the target website changed its UI. Requires that the user switched on ToolBridge for THIS connector or page (Web MCP tab, 2-hour window) and the user's approval in an approval window that shows the full new script; the user must click Allow. Cannot move a tool to another domain, cannot delete, cannot change enabled/requireConfirmation flags, cannot touch the built-in ToolBridge domain. After a script change the running agent can call the tool immediately (no restart); after a rename, restart the MCP connection.", // No I18N
    inputSchema: SCHEMA({
      domain: { type: "string", description: "Domain name the tool belongs to" }, // No I18N
      tool: { type: "string", description: "Current tool name" }, // No I18N
      newName: { type: "string", description: "Optional new tool name (letters, digits, _ -), unique within the domain" }, // No I18N
      description: { type: "string", description: "Optional new description" }, // No I18N
      inputSchema: { type: "object", description: "Optional new JSON Schema object for the arguments" }, // No I18N
      script: { type: "string", description: "Optional new JavaScript function body (`args` in scope, must return a JSON value)" }, // No I18N
      url: { type: "string", description: "Optional new relative page path (starts with /); empty string clears it" }, // No I18N
      deferLoading: { type: "boolean", description: "Optional new defer_loading hint" }, // No I18N
    }, ["domain", "tool"]), // No I18N
    toolScript: "",
    enabled: true,
  },
  {
    name: "enable_tool_in_profile", // No I18N
    description: "Enables an existing tool of a domain in a profile so connectors and pages using that profile can call it. Requires that the user switched on ToolBridge for THIS connector or page (Web MCP tab, 2-hour window) and the user's approval in an approval window. The tool appears in the agent's list only after the MCP connection is restarted — tell the user.", // No I18N
    inputSchema: SCHEMA({
      domain: { type: "string", description: "Domain name" }, // No I18N
      tool: { type: "string", description: "Tool name within the domain" }, // No I18N
      profile: { type: "string", description: "Profile name" }, // No I18N
    }, ["domain", "tool", "profile"]), // No I18N
    toolScript: "",
    enabled: true,
  },
];

export const isBuiltinDomain = (name: string): boolean => name === BUILTIN_DOMAIN_NAME;

/** The virtual domain as it appears in UIs and in profile resolution. */
export function builtinDomain(): StoredDomain {
  return {
    name: BUILTIN_DOMAIN_NAME,
    baseUrl: "chrome-extension://tabbridge", // No I18N — display only; never opened
    startScript: "", // No I18N
    domainScript: "",
    enabled: true,
    tools: BUILTIN_TOOLS,
  };
}

/** Stored domains + the virtual ToolBridge domain (stored copies of that name are dropped defensively). */
export function withBuiltinDomain(domains: StoredDomain[]): StoredDomain[] {
  return [...domains.filter((d) => !isBuiltinDomain(d.name)), builtinDomain()];
}
