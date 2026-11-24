/**
 * page-injected.ts — runs in MAIN world (declared in manifest with "world": "MAIN").
 *
 * Receives EXT_TOOLS (metadata only) from bridge.ts, attaches a generic
 * dispatch handler to each tool and publishes window.__ext_mcp_tools for
 * the in-page agent, then fires "tabbridge:tools:update". Pages without a page-access
 * grant never receive EXT_TOOLS and so never get a tool list.
 */
import { dispatchToolCall } from "../data/domains";
import type { ExtToolsMsg } from "../utils/message";
import type { ExtMcpTool } from "../types/plugin.types";

declare global {
  interface Window {
    __ext_mcp_tools?: ExtMcpTool[];
  }
}

function rebuildMcpTools(tools: ExtToolsMsg["tools"]): void {
  const mcpTools: ExtMcpTool[] = tools.map((t) => ({
    name: t.toolName,
    description: t.description,
    inputSchema: t.inputSchema,
    handler: (args: Record<string, unknown>, _ctx: unknown) => dispatchToolCall(t.domain, t.toolName, args),
  }));
  window.__ext_mcp_tools = mcpTools;
  window.dispatchEvent(new CustomEvent("tabbridge:tools:update", { detail: { tools: mcpTools } })); // No I18N
}

window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window) return;
  const msg = event.data as ExtToolsMsg;
  if (msg?.type === "EXT_TOOLS") rebuildMcpTools(msg.tools); // No I18N
});

// Signal bridge.ts that the MAIN world listener is now registered and ready.
window.dispatchEvent(new CustomEvent("ext:page-ready")); // No I18N
