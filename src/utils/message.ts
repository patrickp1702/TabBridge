import type { PageToolMeta } from "../types/plugin.types";

// ─── window.postMessage types (page ↔ content script) ───────────────────────

/** Sent by tool handler (MAIN world) → picked up by bridge.ts (isolated). */
export interface ExtToolCallMsg {
  type: "EXT_TOOL_CALL"; // No I18N
  id: string;
  domain: string;
  toolName: string;
  args: Record<string, unknown>;
}

/** Sent by bridge.ts (isolated) → resolves pending promise in MAIN world. */
export interface ExtToolResultMsg {
  type: "EXT_TOOL_RESULT"; // No I18N
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/**
 * Sent by bridge.ts (isolated) → triggers tool rebuild in page-injected.ts (MAIN).
 * Metadata only: the tools the page's origin is granted via page access +
 * profile. Never carries scripts.
 */
export interface ExtToolsMsg {
  type: "EXT_TOOLS"; // No I18N
  tools: PageToolMeta[];
}

export type WindowMessage = ExtToolCallMsg | ExtToolResultMsg | ExtToolsMsg;

// ─── chrome.runtime message types (content script ↔ background) ──────────────

export interface RtToolExecuteMsg {
  type: "TOOL_EXECUTE"; // No I18N
  id: string;
  domain: string;
  toolName: string;
  args: Record<string, unknown>;
}

/** Content script asks which tools its page may use; the worker decides from sender.origin (top frame of a real tab). */
export interface RtPageToolsMsg {
  type: "PAGE_TOOLS"; // No I18N
}

/** Worker → content script of a granted tab: config changed, ask PAGE_TOOLS again. Carries no data. */
export interface RtToolsChangedMsg {
  type: "TOOLS_CHANGED"; // No I18N
}

/** Extension pages ask the worker which build it runs, to detect a stale (not reloaded) worker. */
export interface RtGetBuildIdMsg {
  type: "GET_BUILD_ID"; // No I18N
}

export interface RtPageToolsResponse {
  ok: boolean;
  tools: PageToolMeta[];
}

export interface RtOpenDomainTabMsg {
  type: "OPEN_DOMAIN_TAB"; // No I18N
  domainName: string;
}

export interface RtCloseDomainTabMsg {
  type: "CLOSE_DOMAIN_TAB"; // No I18N
  domainName: string;
}

export type RuntimeMessage =
  | RtToolExecuteMsg
  | RtPageToolsMsg
  | RtGetBuildIdMsg
  | RtOpenDomainTabMsg
  | RtCloseDomainTabMsg;

export interface RuntimeResponse {
  ok: boolean;
  result?: unknown;
  error?: string;
}
