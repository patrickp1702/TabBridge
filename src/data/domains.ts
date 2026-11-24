/**
 * domains.ts — MAIN-world dispatch layer only.
 *
 * Domain/tool definitions live in chrome.storage.local and are managed on the
 * settings page; this file carries no data. It gives the in-page agent's tool
 * handlers a Promise-based call into the service worker via bridge.ts.
 */
import type { ExtToolCallMsg, ExtToolResultMsg } from "../utils/message";

/**
 * Pending call registry.
 * Key = request UUID → Value = resolve fn of the awaiting Promise.
 * Lives in MAIN world (page context) via page-injected.ts bundle.
 */
const pendingCalls = new Map<string, (result: unknown) => void>();

// Only register in page context (MAIN world). Service workers have no `window`.
if (typeof window !== "undefined") { // No I18N
  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== window) return;
    const msg = event.data as ExtToolResultMsg;
    if (msg?.type !== "EXT_TOOL_RESULT") return; // No I18N
    const resolve = pendingCalls.get(msg.id);
    if (!resolve) return;
    pendingCalls.delete(msg.id);
    resolve(msg.ok ? msg.result : { error: msg.error });
  });
}

/**
 * Posts an EXT_TOOL_CALL to bridge.ts and returns a Promise that resolves
 * when the tool script has finished executing in the domain tab.
 */
export function dispatchToolCall(
  domainName: string,
  toolName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const id = crypto.randomUUID();

  const msg: ExtToolCallMsg = {
    type: "EXT_TOOL_CALL", // No I18N
    id,
    domain: domainName,
    toolName,
    args,
  };

  window.postMessage(msg, window.location.origin);
  return new Promise((resolve) => pendingCalls.set(id, resolve));
}
