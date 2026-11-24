/**
 * native-bridge.ts — connects the in-extension MCP server to connector shell
 * scripts through Chrome Native Messaging.
 *
 *   agent ──stdio──▶ connector.sh (relay) ──spool files──▶ connector.sh (native host, spawned by Chrome)
 *                                                            ──native messaging──▶ this file ──▶ mcp-server.ts ──▶ executeTool
 *
 * Every envelope carries the token of ONE connector (= one download, one
 * profile). We look the connector up, refuse it when unknown / deactivated /
 * expired, and otherwise serve an MCP server whose tool list is that
 * connector's profile resolved against the live domain config. Profile edits
 * therefore apply immediately; tools outside the profile are neither listed
 * nor callable.
 *
 * Lifecycle: the host pings every ~20 s, which keeps the MV3 worker alive; a
 * 1-minute alarm re-connects after the worker is recycled and refreshes the
 * status. Reconnects back off 5 s → 60 s. The port is kept open as long as ANY
 * connector exists — expired or deactivated ones included — so a refused
 * script gets an immediate, explicit answer instead of a timeout.
 */
import { createMcpServer } from "./mcp-server";
import type { Connector, McpBridgeConfig, McpBridgeStatus, ToolProfile } from "../types/plugin.types";
import { NATIVE_HOST_NAME, type NativePingEnvelope, type NativeRequestEnvelope, type NativeResponseEnvelope } from "../utils/mcp";
import { BUILTIN_DOMAIN_NAME, builderDeniedMessage, isBuiltinDomain } from "../utils/builtin";
import { DEFAULT_BRIDGE_CONFIG, ENVELOPE_MAX_AGE_S, hashToken, isConnectorLive, lookupConnector, resolveExposedTools } from "../utils/profiles";
import { MCP_BRIDGE_CONFIG_KEY, auditDenied, bumpConnectorStats, loadBridgeConfig, loadConnectorStats, loadDomains, loadProfiles } from "../utils/storage";

export const MCP_BRIDGE_STATUS_KEY = "mcpBridgeStatus"; // No I18N
const KEEPALIVE_ALARM = "mcp-bridge-keepalive"; // No I18N
const RECONNECT_MIN_MS = 5_000;
const RECONNECT_MAX_MS = 60_000;

/** executeAgentCall(caller, domain, toolName, args) — confirmation + audit happen inside. */
export type ToolExecutor = (caller: string, domain: string, toolName: string, args: Record<string, unknown>) => Promise<unknown>;

async function publishStatus(status: Omit<McpBridgeStatus, "updatedAt">): Promise<void> {
  const full: McpBridgeStatus = { ...status, updatedAt: Date.now() };
  await chrome.storage.session.set({ [MCP_BRIDGE_STATUS_KEY]: full });
}

const SETUP_DETAIL = "Finish setup: run a downloaded connector script once in a terminal (bash ~/Downloads/<connector>.sh)."; // No I18N

/** Hello handshake reply — the bash relay only checks the `{"ok":true` prefix. */
interface HelloReply { ok: boolean; reason?: string; message?: string; connector?: string; profile?: string; tools?: number }

class NativeBridge {
  private port: chrome.runtime.Port | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = RECONNECT_MIN_MS;
  private config: McpBridgeConfig = { ...DEFAULT_BRIDGE_CONFIG };
  private generation = 0;

  constructor(private readonly execute: ToolExecutor) {}

  private liveCount(): number { return this.config.connectors.filter((c) => isConnectorLive(c)).length; }

  /** Reads config and converges: connect, reconnect, or tear down. */
  async sync(): Promise<void> {
    this.config = await loadBridgeConfig();
    this.generation++;
    this.clearReconnect();
    this.closePort();

    if (!this.config.enabled) {
      await chrome.alarms.clear(KEEPALIVE_ALARM);
      await publishStatus({ state: "disabled", connectorCount: 0 }); // No I18N
      return;
    }
    await chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 1 });
    if (!this.config.connectors.length) {
      await publishStatus({ state: "setup", detail: "No connector script downloaded yet — download one below and run it once.", connectorCount: 0 }); // No I18N
      return;
    }
    this.reconnectDelay = RECONNECT_MIN_MS;
    this.connect(this.generation);
  }

  /** Alarm / "Retry now": connect if we should be connected but are not. */
  async ensureConnected(immediate = false): Promise<void> {
    this.config = await loadBridgeConfig();
    if (!this.config.enabled || !this.config.connectors.length) return;
    if (this.port) { await publishStatus({ state: "connected", connectorCount: this.liveCount() }); return; } // No I18N
    if (immediate) { this.clearReconnect(); this.reconnectDelay = RECONNECT_MIN_MS; }
    if (this.reconnectTimer) return;
    this.connect(this.generation);
  }

  private connect(gen: number): void {
    void publishStatus({ state: "connecting", detail: "Launching the connector…", connectorCount: this.liveCount() }); // No I18N
    let port: chrome.runtime.Port;
    try {
      port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    } catch (e) {
      void publishStatus({ state: "setup", detail: `${SETUP_DETAIL} (${String(e)})`, connectorCount: this.liveCount() }); // No I18N
      this.scheduleReconnect(gen);
      return;
    }
    this.port = port;
    let gotAnything = false;

    port.onMessage.addListener((raw: unknown) => {
      if (gen !== this.generation) return;
      if (!gotAnything) {
        gotAnything = true;
        this.reconnectDelay = RECONNECT_MIN_MS;
        void publishStatus({ state: "connected", connectorCount: this.liveCount() }); // No I18N
      }
      void this.handle(raw, port);
    });

    port.onDisconnect.addListener(() => {
      if (gen !== this.generation) return;
      const reason = chrome.runtime.lastError?.message ?? "";
      this.port = null;
      if (/not found/i.test(reason)) { // No I18N — manifest missing: user has not run a script yet
        void publishStatus({ state: "setup", detail: SETUP_DETAIL, connectorCount: this.liveCount() }); // No I18N
      } else if (/forbidden/i.test(reason)) { // No I18N — manifest allows a different extension id
        void publishStatus({ state: "error", detail: "The registered connector was downloaded for a different extension install. Download a new script and run it once.", connectorCount: this.liveCount() }); // No I18N
      } else {
        void publishStatus({ state: "connecting", detail: reason ? `Connector exited (${reason}). Retrying…` : "Connector exited. Retrying…", connectorCount: this.liveCount() }); // No I18N
      }
      this.scheduleReconnect(gen);
    });
  }

  /** MCP server bound to one connector; tool list (profile + this connector's own ToolBridge grant) resolved live per call. */
  private serverFor(connector: Connector) {
    const listTools = async () => {
      const [profiles, domains, cfg] = await Promise.all([loadProfiles(), loadDomains(), loadBridgeConfig()]);
      // Re-read the connector on EVERY call: Deactivate / Delete / Extend and the ToolBridge switch must take
      // effect mid-batch, not just at the next hello. A deleted or no-longer-live connector exposes nothing.
      const live = cfg.connectors.find((c) => c.id === connector.id);
      if (!live || !isConnectorLive(live)) return [];
      return resolveExposedTools(profiles.find((p) => p.id === live.profileId), domains, live);
    };
    const denied = () => builderDeniedMessage("connector", connector.label); // No I18N
    return createMcpServer({
      listTools,
      // ToolBridge tools stay in the agent's cached list after the 2-hour grant expires: explain instead of "unknown tool".
      unavailableReason: async (name) => (name.startsWith(`${BUILTIN_DOMAIN_NAME}__`) ? denied() : null), // No I18N
      callTool: async (tool, args) => {
        // Re-check at call time: the profile (or this connector's ToolBridge window) may have changed since tools/list.
        if (!(await listTools()).some((t) => t.name === tool.name)) {
          const reason = isBuiltinDomain(tool.domain) ? denied() : `Tool '${tool.name}' is not enabled in profile for connector ${connector.label}.`; // No I18N
          auditDenied(connector.label, tool.domain, tool.toolName, args, reason);
          throw new Error(reason);
        }
        // Rate limit, validation, confirmation and audit happen inside executeAgentCall.
        return this.execute(connector.label, tool.domain, tool.toolName, args);
      },
      status: async () => {
        const profile = (await loadProfiles()).find((p) => p.id === connector.profileId);
        const stats = (await loadConnectorStats())[connector.id];
        return {
          connector: connector.label,
          profile: profile?.name ?? "(deleted)", // No I18N
          expiresAt: new Date(connector.expiresAt).toISOString(),
          requestsServed: stats?.requests ?? 0,
          extensionVersion: chrome.runtime.getManifest().version,
          build: __BUILD_ID__,
        };
      },
    });
  }

  private lastStatsWrite = new Map<string, number>();

  /** Usage bookkeeping under its own storage key — never rewrites mcpBridge (lost-update race, N4). Throttled to one write per 5 s per connector. */
  private touch(connector: Connector): void {
    const now = Date.now();
    if (now - (this.lastStatsWrite.get(connector.id) ?? 0) < 5_000) return;
    this.lastStatsWrite.set(connector.id, now);
    void bumpConnectorStats(connector.id).catch(() => {});
  }

  private async handle(raw: unknown, port: chrome.runtime.Port): Promise<void> {
    const msg = raw as Partial<NativeRequestEnvelope & NativePingEnvelope & { hello?: boolean; ts?: number }>;
    if (!msg || msg.type === "ping") return; // No I18N — keep-alive only
    if (typeof msg.id !== "string") return;

    let line: unknown | null = null;
    const rejectedServer = () => createMcpServer({ listTools: async () => [], callTool: async () => null, status: async () => ({}) });
    try {
      // Envelope age: a .req that sat in the spool while the host was down must not execute hours later (N5).
      const ageS = typeof msg.ts === "number" ? Math.abs(Date.now() / 1000 - msg.ts) : Infinity;
      if (ageS > ENVELOPE_MAX_AGE_S) {
        const reason = `Stale request (${Number.isFinite(ageS) ? Math.round(ageS) + " s old" : "no timestamp"}) ignored. Re-run the connector script.`; // No I18N
        line = msg.hello ? ({ ok: false, reason: "stale", message: reason } satisfies HelloReply) : rejectedServer().rejected(msg.line, reason, -32002); // No I18N
      } else {
        this.config = await loadBridgeConfig();   // always decide on the latest connectors / deactivations
        const found = lookupConnector(this.config, msg.token ? await hashToken(String(msg.token)) : "");
        if (msg.hello) {
          if (found.ok) {
            const profile: ToolProfile | undefined = (await loadProfiles()).find((p) => p.id === found.connector.profileId);
            const tools = resolveExposedTools(profile, await loadDomains(), found.connector);
            this.touch(found.connector);
            line = { ok: true, connector: found.connector.label, profile: profile?.name ?? "(deleted)", tools: tools.length } satisfies HelloReply; // No I18N
          } else {
            line = { ok: false, reason: found.reason, message: found.message } satisfies HelloReply;
          }
        } else if (!found.ok) {
          line = rejectedServer().rejected(msg.line, found.message);
        } else if (typeof msg.line !== "object" || msg.line === null) {
          line = rejectedServer().rejected(msg.line, "Malformed request line", -32600); // No I18N
        } else {
          this.touch(found.connector);
          line = await this.serverFor(found.connector).handle(msg.line);
        }
      }
    } catch (e) {
      line = { jsonrpc: "2.0", id: null, error: { code: -32603, message: `Internal error: ${String(e)}` } }; // No I18N
    }
    const envelope: NativeResponseEnvelope = { id: msg.id, line: line ?? null }; // key order = contract with the bash host
    try { port.postMessage(envelope); } catch { /* port gone; relay times out */ }
  }

  private scheduleReconnect(gen: number): void {
    if (!this.config.enabled || gen !== this.generation || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (gen !== this.generation || !this.config.enabled) return;
      this.connect(gen);
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
  }

  private closePort(): void {
    const p = this.port;
    this.port = null;
    if (p) { try { p.disconnect(); } catch { /* ignore */ } }
  }
}

/** Wires the bridge into the service worker. Call once at top level. */
export function installNativeBridge(execute: ToolExecutor): void {
  const bridge = new NativeBridge(execute);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[MCP_BRIDGE_CONFIG_KEY]) { // No I18N
      const prev = changes[MCP_BRIDGE_CONFIG_KEY].oldValue as McpBridgeConfig | undefined;
      const next = changes[MCP_BRIDGE_CONFIG_KEY].newValue as McpBridgeConfig | undefined;
      // Only re-connect when something that affects the port changed; lastSeen/requests bookkeeping must not bounce it.
      const portRelevant = prev?.enabled !== next?.enabled || (prev?.connectors.length ?? 0) !== (next?.connectors.length ?? 0);
      if (portRelevant) void bridge.sync(); else void bridge.ensureConnected();
    }
  });

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === KEEPALIVE_ALARM) void bridge.ensureConnected();
  });

  chrome.runtime.onMessage.addListener((message: { type?: string }, _sender, sendResponse) => {
    if (message?.type === "MCP_BRIDGE_RECONNECT") { // No I18N
      void bridge.ensureConnected(true).then(() => sendResponse({ ok: true }));
      return true;
    }
    return false;
  });

  void bridge.sync();
}
