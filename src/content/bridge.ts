/**
 * bridge.ts — runs in ISOLATED world on every page (manifest matches), but
 * only pages whose origin has a page-access grant ever receive tools.
 *
 * Responsibilities:
 *  1. Asks the service worker (PAGE_TOOLS) which tools THIS page may use. The
 *     worker decides from sender.origin (set by Chrome, unspoofable) → page-access
 *     grant → profile. Pages without a grant get an empty list.
 *  2. Posts EXT_TOOLS (metadata only — never scripts) to MAIN world so
 *     page-injected.ts can rebuild window.__ext_mcp_tools.
 *  3. Forwards EXT_TOOL_CALL from MAIN world to the worker as TOOL_EXECUTE and
 *     posts back EXT_TOOL_RESULT. The worker re-authorises every call.
 *  4. Re-fetches when the worker says TOOLS_CHANGED (it pushes that only to
 *     tabs whose origin has a grant). This file never touches chrome.storage:
 *     storage.local is TRUSTED_CONTEXTS-only, so a compromised renderer cannot
 *     read scripts or grant itself access through the content script.
 */
import type { ExtToolCallMsg, ExtToolsMsg, RtPageToolsResponse, RtToolExecuteMsg, RtToolsChangedMsg, RuntimeResponse } from "../utils/message";

let lastToolsJson = "";

async function pushTools(force = false): Promise<void> {
  let tools: ExtToolsMsg["tools"] = [];
  try {
    const res = (await chrome.runtime.sendMessage({ type: "PAGE_TOOLS" })) as RtPageToolsResponse | undefined; // No I18N
    if (res?.ok) tools = res.tools;
  } catch { /* worker unavailable (extension reloaded) — leave the page without tools */ }
  const json = JSON.stringify(tools);
  if (!force && json === lastToolsJson) return;
  lastToolsJson = json;
  // Nothing granted and nothing previously pushed → stay silent on unrelated sites.
  if (!tools.length && !force) return;
  const msg: ExtToolsMsg = { type: "EXT_TOOLS", tools }; // No I18N
  window.postMessage(msg, window.location.origin);
}

// Tool calls from MAIN world → worker. Same-window only; the worker authorises by sender origin.
window.addEventListener("message", async (event: MessageEvent) => {
  if (event.source !== window) return;
  const msg = event.data as ExtToolCallMsg;
  if (msg?.type !== "EXT_TOOL_CALL") return; // No I18N

  const rtMsg: RtToolExecuteMsg = { type: "TOOL_EXECUTE", id: msg.id, domain: msg.domain, toolName: msg.toolName, args: msg.args }; // No I18N
  try {
    const response: RuntimeResponse = await chrome.runtime.sendMessage(rtMsg);
    window.postMessage({ type: "EXT_TOOL_RESULT", id: msg.id, ok: response.ok, result: response.result, error: response.error }, window.location.origin); // No I18N
  } catch (err) {
    window.postMessage({ type: "EXT_TOOL_RESULT", id: msg.id, ok: false, error: String(err) }, window.location.origin); // No I18N
  }
});

// Live updates: the worker pings granted tabs when domains / profiles / grants change.
chrome.runtime.onMessage.addListener((msg: RtToolsChangedMsg) => {
  if (msg?.type === "TOOLS_CHANGED") void pushTools(lastToolsJson !== ""); // No I18N
});

// MAIN world signals its listener is registered → (re)send.
window.addEventListener("ext:page-ready", () => { void pushTools(true); }); // No I18N

void pushTools();
