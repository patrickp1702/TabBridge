/**
 * mcp-server.ts — a minimal, dependency-free MCP server (JSON-RPC 2.0) that
 * runs INSIDE the extension service worker.
 *
 * The connector shell script is only a byte relay; every MCP method is
 * answered here: initialize, ping, tools/list, tools/call (+ empty
 * resources/prompts lists for lenient clients). No chrome.* usage — the
 * caller injects tool access — so this file is unit-testable in plain Node.
 */
import type { ExposedTool } from "../utils/mcp";

export const SERVER_INFO = { name: "tabbridge", version: "1.0.0" }; // No I18N
export const STATUS_TOOL_NAME = "tabbridge_status"; // No I18N
const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"]; // No I18N
/** Batches larger than this are rejected (each tools/call may open a tab). */
export const MAX_BATCH = 10;

export interface McpServerDeps {
  /** Current tool list (enabled domains × enabled tools). */
  listTools(): Promise<ExposedTool[]>;
  /** Runs a tool; throws on failure. */
  callTool(tool: ExposedTool, args: Record<string, unknown>): Promise<unknown>;
  /** Extra fields merged into the status tool's output. */
  status(): Promise<Record<string, unknown>>;
  /** Optional: a specific, user-relayable reason why `name` is not callable right now (e.g. expired ToolBridge grant). */
  unavailableReason?(name: string): Promise<string | null>;
}

interface JsonRpcRequest { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> }
interface JsonRpcResponse { jsonrpc: "2.0"; id: string | number | null; result?: unknown; error?: { code: number; message: string; data?: unknown } }

const err = (id: string | number | null, code: number, message: string, data?: unknown): JsonRpcResponse =>
  ({ jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } }); // No I18N
const ok = (id: string | number | null, result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id, result }); // No I18N

function textResult(value: unknown, isError = false): unknown {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2); // No I18N
  return { content: [{ type: "text", text }], isError }; // No I18N
}

export function createMcpServer(deps: McpServerDeps) {
  async function handleOne(msg: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") { // No I18N
      return err((msg as JsonRpcRequest)?.id ?? null, -32600, "Invalid Request"); // No I18N
    }
    const isNotification = !("id" in msg) || msg.id === undefined;
    const id = msg.id ?? null;
    const params = msg.params ?? {};

    // Notifications never get a reply.
    if (msg.method.startsWith("notifications/")) return null; // No I18N
    if (isNotification) return null;

    switch (msg.method) {
      case "initialize": { // No I18N
        const requested = String(params["protocolVersion"] ?? ""); // No I18N
        const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0];
        return ok(id, {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          instructions: `Tools are executed inside the user's Chrome session by the TabBridge. Call ${STATUS_TOOL_NAME} if tools are missing.`, // No I18N
        });
      }
      case "ping": return ok(id, {}); // No I18N
      case "resources/list": return ok(id, { resources: [] }); // No I18N
      case "prompts/list": return ok(id, { prompts: [] }); // No I18N
      case "tools/list": { // No I18N
        const tools = await deps.listTools();
        return ok(id, {
          tools: [
            {
              name: STATUS_TOOL_NAME,
              description: "Reports the TabBridge bridge state and lists the domain tools it currently exposes. Call this first if other tools are missing or failing.", // No I18N
              inputSchema: { type: "object", properties: {}, additionalProperties: false }, // No I18N
            },
            // `defer_loading` is a Claude (API / Claude Code) tool-definition hint, not an MCP field: marked tools are
            // kept out of the initial context and found via Tool Search. Emitted top-level (where Claude reads it)
            // and under _meta (the protocol's extension slot); other clients ignore both.
            ...tools.map((t) => ({ name: t.name, description: `[${t.domain}] ${t.description}`, inputSchema: t.inputSchema, ...(t.deferLoading ? { defer_loading: true, _meta: { defer_loading: true } } : {}) })), // No I18N
          ],
        });
      }
      case "tools/call": { // No I18N
        const name = String(params["name"] ?? ""); // No I18N
        const args = (params["arguments"] as Record<string, unknown> | undefined) ?? {}; // No I18N
        if (name === STATUS_TOOL_NAME) {
          const tools = await deps.listTools();
          return ok(id, textResult({ connected: true, tools: tools.map((t) => ({ name: t.name, domain: t.domain, description: t.description })), ...(await deps.status()) }));
        }
        const tool = (await deps.listTools()).find((t) => t.name === name);
        if (!tool) {
          const reason = deps.unavailableReason ? await deps.unavailableReason(name) : null;
          return ok(id, textResult(reason ?? `Unknown tool '${name}'. Call ${STATUS_TOOL_NAME} to see what is exposed.`, true)); // No I18N
        }
        try {
          return ok(id, textResult((await deps.callTool(tool, args)) ?? null));
        } catch (e) {
          return ok(id, textResult(String(e), true));
        }
      }
      default: return err(id, -32601, `Method not found: ${msg.method}`); // No I18N
    }
  }

  return {
    /** Handles one parsed JSON-RPC message (or a batch). Returns null when nothing should be sent back. */
    async handle(message: unknown): Promise<unknown | null> {
      if (Array.isArray(message)) {
        if (!message.length) return err(null, -32600, "Invalid Request: empty batch"); // No I18N
        if (message.length > MAX_BATCH) return err(null, -32600, `Batch too large (max ${MAX_BATCH})`); // No I18N
        // Sequential on purpose: tools may open / reuse tabs and must not race each other.
        const out: JsonRpcResponse[] = [];
        for (const m of message) { const r = await handleOne(m as JsonRpcRequest); if (r) out.push(r); }
        return out.length ? out : null;
      }
      return handleOne(message as JsonRpcRequest);
    },
    /** Error reply for a request the relay sent with a bad / stale token. */
    rejected(message: unknown, reason: string, code = -32001): unknown | null {
      const list = (Array.isArray(message) ? message : [message]) as (JsonRpcRequest | undefined)[];
      const out = list.filter((m) => m && m.id !== undefined && m.id !== null).map((m) => err(m!.id!, code, reason));
      return out.length ? (Array.isArray(message) ? out : out[0]) : null;
    },
  };
}

export type McpServer = ReturnType<typeof createMcpServer>;
