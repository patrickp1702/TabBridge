/** Full tool config stored in chrome.storage.local["domains"] — includes the script. */
export interface StoredTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, { type: string; description: string }>;
    required: string[];
    additionalProperties: boolean;
  };
  /** JS function body executed in the domain tab's MAIN world via chrome.userScripts. `args` is in scope. */
  toolScript: string;
  enabled: boolean;
  /** Agent calls (connector or page) must be approved in the approval window first. */
  requireConfirmation?: boolean;
  /**
   * Relative URL (starts with "/") of the page inside the domain this tool needs.
   * Before running, the domain tab is navigated there when it is not already on it.
   */
  url?: string;
  /**
   * Hint for Claude clients: load this tool on demand via Tool Search instead of
   * upfront (emitted as `defer_loading` in tools/list). Not part of the MCP protocol.
   */
  deferLoading?: boolean;
  /** Set when an agent created the tool through ToolBridge.add_tool: the connector label / page origin. */
  createdBy?: string;
  createdAt?: number;
  /** Set when an agent last changed the tool through ToolBridge.update_tool. */
  updatedBy?: string;
  updatedAt?: number;
}

/** Full domain config stored in chrome.storage.local["domains"]. */
export interface StoredDomain {
  name: string;
  baseUrl: string;
  /** URL opened when domain is activated. */
  startScript: string;
  /** JS snippet run once per domain tab session (bootstrap). Empty = skip. */
  domainScript: string;
  enabled: boolean;
  tools: StoredTool[];
  /**
   * Other data centres hosting the same application. When present every tool
   * gets an optional `dc` argument and a `get_dc_list` tool appears; a call with
   * `dc` runs in a tab of that DC's origin, otherwise in `baseUrl`.
   */
  dcs?: DomainDc[];
}

/** One alternative data centre for a domain. */
export interface DomainDc {
  /** Short name used as the `dc` argument value, e.g. "eu", "in". */
  name: string;
  /** Origin of that DC, e.g. https://logs.eu.example.com */
  baseUrl: string;
}

/** Root shape of chrome.storage.local["domains"]. */
export interface PluginStorage {
  domains: StoredDomain[];
}

/** Session-scoped tab state stored in chrome.storage.session. */
export interface SessionState {
  /** `domainName` (default origin) or `domainName@dc` (a data centre) → Chrome tabId of the tab used for it. */
  sessionTabs: Record<string, number>;
  /**
   * Tab ids this extension opened itself. Only these may ever become a tool
   * tab: a tab some website opened on the domain origin (window.open) is never
   * adopted, so an outside page cannot pre-load or close the tab tools run in.
   * (A popup the domain page itself opens without `noopener` could still
   * navigate it through `opener`; the origin and, for page-bound tools, the
   * path are re-checked right before every injection.)
   */
  ownedTabs?: number[];
  /** chrome.tabGroups id that collects the owned tabs (browsers that support tab groups only). */
  tabGroupId?: number;
}

/** Minimal McpToolDefinition shape expected by in-page agent's window.__ext_mcp_tools. */
export interface ExtMcpTool {
  name: string;
  description: string;
  inputSchema: StoredTool["inputSchema"];
  handler: (args: Record<string, unknown>, ctx: unknown) => Promise<unknown>;
  getPiList?: (result: unknown, args: unknown) => { value: unknown; path: string; type: string }[];
}

// ─── Profiles, connectors, page access ────────────────────────────────────────

/**
 * A named selection of tools. Per domain either every tool ("*", including
 * ones added later) or an explicit list of tool names. Domains not listed
 * contribute nothing. Stored in chrome.storage.local["profiles"].
 */
export interface ToolProfile {
  id: string;
  name: string;
  description: string;
  domains: Record<string, "*" | string[]>;
  createdAt: number;
}

/**
 * ToolBridge (agent creates/edits tools) is granted per CALLER, never per
 * profile: a connector script or a page-access grant carries `builderUntil`,
 * epoch ms until which the built-in ToolBridge tools are exposed to it. The
 * user switches it on in the Web MCP tab (now + 2 h); the service worker
 * clears it once elapsed so the switch visibly turns off.
 */
export interface BuilderGrant {
  builderUntil?: number;
}

/**
 * One downloaded connector script. Each download mints its own token and
 * lifetime; several may be active at once. Connectors are NEVER removed
 * automatically — expired and deactivated ones stay listed (and can be
 * extended / re-activated) until the user clicks Delete. Stored (device-local,
 * never synced) in chrome.storage.local["mcpBridge"].connectors.
 */
export interface Connector extends BuilderGrant {
  id: string;
  /** `<profile-slug>-<6 hex>` — shown in the UI, baked into the script, used as the MCP server key suffix. */
  label: string;
  profileId: string;
  /** SHA-256 hex of the token baked into the script. The token itself is never stored. */
  tokenHash: string;
  issuedAt: number;
  expiresAt: number;
  /** False once the user clicked Deactivate; the script is refused from then on (until Extend/Reactivate). */
  active: boolean;
  deactivatedAt?: number;
  /** Last Extend / Reactivate from the Web MCP tab. */
  extendedAt?: number;
}

/** Grants the pages of one origin (in-page agent) the tools of one profile. */
export interface PageAccess extends BuilderGrant {
  id: string;
  /** Normalised origin, e.g. https://app.example.com */
  origin: string;
  profileId: string;
  createdAt: number;
}

/** Web MCP bridge settings — chrome.storage.local["mcpBridge"]. */
export interface McpBridgeConfig {
  /** Master switch: serve MCP to connector scripts. */
  enabled: boolean;
  /** Lifetime chosen for the next download, in days (1–7). */
  lifetimeDays: number;
  /** Max agent tool calls per caller (connector label or page origin) per minute; 0 = unlimited. */
  rateLimitPerMinute: number;
  /**
   * Whether page-access grants for plain http:// origins (other than loopback)
   * are honoured. Default false: anyone on the network path can inject script
   * into an http page and would inherit its tools. Localhost is always allowed.
   */
  allowHttpOrigins: boolean;
  connectors: Connector[];
  pageAccess: PageAccess[];
}

/** One agent tool call, kept in chrome.storage.local["mcpAudit"] (ring buffer). */
export interface AuditEntry {
  t: number;
  /** Connector label or page origin. */
  caller: string;
  domain: string;
  tool: string;
  /** First 160 chars of the JSON args. */
  argsPreview: string;
  ok: boolean;
  ms: number;
  error?: string;
}

/** Live bridge state — chrome.storage.session["mcpBridgeStatus"], written by the service worker. */
export interface McpBridgeStatus {
  /** `setup` = native host not registered yet (user has not run a script). */
  state: "disabled" | "setup" | "connecting" | "connected" | "error" | "expired";
  detail?: string;
  /** Active, unexpired connectors. */
  connectorCount: number;
  updatedAt: number;
}

/** Tool metadata handed to pages / MCP clients — never includes the script. */
export interface PageToolMeta {
  name: string;
  domain: string;
  toolName: string;
  description: string;
  inputSchema: StoredTool["inputSchema"];
}
