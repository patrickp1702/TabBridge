/**
 * connector_script.ts — fills the downloadable connector shell script.
 *
 * The script (connector.template.sh) is pure bash: it registers itself as a
 * Chrome Native Messaging host and relays MCP stdio lines to the extension,
 * which is the actual MCP server. Each download is one Connector with its own
 * token (baked in, never shown), profile and lifetime; the extension serves
 * only that profile's tools and can deactivate the connector at any time.
 */
import template from "./connector.template.sh?raw";
import { MCP_SERVER_KEY, NATIVE_HOST_NAME } from "../utils/mcp";

export interface ConnectorScriptInput {
  token: string;
  extensionId: string;
  /** Connector label `<profile-slug>-<hex>` — also the MCP server key suffix. */
  connectorId: string;
  profileName: string;
  /** Epoch seconds. */
  issuedAt: number;
  /** Epoch seconds. */
  expiresAt: number;
  version: string;
}

/** Download file name for a connector. */
export const connectorFilename = (connectorId: string): string => `tabbridge-connector-${connectorId}.sh`; // No I18N

/** Placeholders are `@@NAME@@`; values must be safe inside single quotes (hex / ids / ISO dates only). */
export function buildConnectorScript(i: ConnectorScriptInput): string {
  const values: Record<string, string> = {
    TOKEN: i.token,
    EXT_ID: i.extensionId,
    HOST_NAME: NATIVE_HOST_NAME,
    SERVER_KEY: `${MCP_SERVER_KEY}-${i.connectorId}`, // No I18N — distinct key per connector so several coexist in one agent
    CONNECTOR_ID: i.connectorId,
    PROFILE_NAME: i.profileName.replace(/["'\\\n]/g, " "), // No I18N — display only
    ISSUED_AT: String(i.issuedAt),
    EXPIRES_AT: String(i.expiresAt),
    VERSION: i.version,
    ISSUED_ISO: new Date(i.issuedAt * 1000).toISOString(),
    EXPIRES_ISO: new Date(i.expiresAt * 1000).toISOString(),
  };
  for (const [k, v] of Object.entries(values)) {
    if (/['\\\n]/.test(v)) throw new Error(`connector script value ${k} must not contain quotes, backslashes or newlines`); // No I18N
  }
  const out = template.replace(/@@([A-Z_]+)@@/g, (_, k: string) => {
    if (!(k in values)) throw new Error(`connector template: unknown placeholder ${k}`); // No I18N
    return values[k];
  });
  if (/@@[A-Z_]+@@/.test(out)) throw new Error("connector template: unreplaced placeholder"); // No I18N
  return out;
}
