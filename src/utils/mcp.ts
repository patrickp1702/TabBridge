/**
 * mcp.ts — MCP-facing metadata helpers + the native-messaging contract shared by
 * the service worker, the settings page and the connector-script generator.
 */
import type { StoredDomain, StoredTool } from "../types/plugin.types";

/** Native messaging host name (manifest file = `<name>.json`). */
export const NATIVE_HOST_NAME = "com.tabbridge.connector"; // No I18N

/** Name the agent sees in its MCP config. */
export const MCP_SERVER_KEY = "tabbridge"; // No I18N

/** MCP tool names must match /^[a-zA-Z0-9_-]{1,64}$/ (Claude enforces this). */
export const MCP_TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Builds the MCP-facing tool name `<domain>__<tool>`; tool names in storage are
 * only unique per domain, so the domain prefix prevents collisions.
 * Invalid characters become `_` and the result is capped at 64 chars.
 */
export function toMcpToolName(domain: string, toolName: string): string {
  const raw = `${domain}__${toolName}`; // No I18N
  return raw.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64); // No I18N
}

/** A tool as advertised over MCP. Metadata only — the script stays in storage. */
export interface ExposedTool {
  name: string;
  domain: string;
  toolName: string;
  description: string;
  inputSchema: StoredTool["inputSchema"];
  /** Emitted as `defer_loading` for Claude clients. */
  deferLoading?: boolean;
}

/** Enabled domains × enabled tools → MCP-facing metadata list. */
export function buildExposedTools(domains: StoredDomain[]): ExposedTool[] {
  const out: ExposedTool[] = [];
  for (const d of domains) {
    if (!d.enabled) continue;
    for (const t of d.tools) {
      if (!t.enabled) continue;
      const name = toMcpToolName(d.name, t.name);
      if (!MCP_TOOL_NAME_RE.test(name)) continue;
      out.push({ name, domain: d.name, toolName: t.name, description: t.description, inputSchema: t.inputSchema });
    }
  }
  return out;
}

// ─── Native messaging envelopes (script ↔ extension) ─────────────────────────

/** Host → extension: one JSON-RPC line from an agent, wrapped by the relay. */
export interface NativeRequestEnvelope {
  /** 32 hex chars, minted by the relay; also the spool file name. */
  id: string;
  token: string;
  /** The raw JSON-RPC message the agent sent (already parsed by Chrome). */
  line: unknown;
}

/** Host → extension keep-alive, sent every ~20 s so the MV3 worker stays up. */
export interface NativePingEnvelope { type: "ping" } // No I18N

/**
 * Extension → host. Serialised by Chrome as `{"id":"<id>","line":<json>}` —
 * key order matters: the bash host strips that exact prefix instead of parsing
 * JSON. `line` is `null` for notifications (nothing to send back).
 */
export interface NativeResponseEnvelope {
  id: string;
  line: unknown | null;
}
