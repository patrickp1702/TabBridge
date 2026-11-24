# TabBridge — guide for agents and maintainers

This document explains TabBridge to another AI agent (or a new engineer): what it is for, how every piece connects, what the downloaded connector script does, which security controls exist and where they are enforced, and how to build, test and extend it. `README.md` is the end-user guide; this file is the architecture and threat-model reference. Keep both in sync when behaviour changes.

Everything in this folder is self-contained: no imports leave `tabbridge/`, nothing from the surrounding repository is used, and only Vite, TypeScript and `@types/chrome` are dev dependencies.

---

## 1. Purpose

TabBridge is a Chrome MV3 extension that turns **JavaScript snippets running inside the user's logged-in browser tabs** into **MCP tools** (Model Context Protocol), so AI agents can act with the user's session without being given credentials.

Two audiences can call the tools:

| Audience | Path | Trust anchor |
|---|---|---|
| **In-page agent** (a chat assistant embedded in a web page) | `window.__ext_mcp_tools` on that page | A **page-access grant**: origin → profile |
| **External MCP client** (Claude Code, Claude Desktop, Cursor, …) | A downloaded **connector script** (pure bash) registered as a Chrome Native Messaging host | A **connector**: hashed token + profile + lifetime |

In both cases the set of tools is decided by a **profile** (a named selection of tools). Nothing outside the governing profile is listed or callable.

A built-in domain, **ToolBridge**, additionally lets an agent *create* tools (with the user's approval and a 2-hour grant on the calling connector or page origin).

---

## 2. Vocabulary

| Term | Meaning | Stored in |
|---|---|---|
| **Domain** | A website the user is logged into: `name`, `baseUrl` (origin used to match tabs), `startScript` (URL opened to establish the session), optional `domainScript` (JS run once per tab), `enabled`, `tools[]`. | `storage.local["domains"]` |
| **Tool** | `name`, `description`, `inputSchema` (JSON Schema object), `toolScript` (JS function body; `args` in scope, `await` allowed, must `return` a JSON value), `enabled`, `requireConfirmation`, optional `createdBy`/`createdAt` provenance. | inside its domain |
| **MCP tool name** | `<domain>__<tool>` sanitised to `[A-Za-z0-9_-]{1,64}` (`toMcpToolName`). | derived |
| **Profile** | Named selection of page tools: per domain `"*"` (all tools, incl. future ones) or `[toolNames]`. Never includes ToolBridge. | `storage.local["profiles"]` |
| **Page access grant** | `origin → profileId`. Only pages at that exact origin receive tools. | `storage.local["mcpBridge"].pageAccess` |
| **Connector** | One downloaded script: `label` (chosen in the download dialog, default `<profile-slug>-<6 hex>`), `profileId`, `tokenHash` (SHA-256), `issuedAt`, `expiresAt`, `active`, `extendedAt?`. Never removed automatically; Extend / Reactivate rewrites `expiresAt` + `active`. | `storage.local["mcpBridge"].connectors` |
| **Bridge config** | `enabled` (master switch), `lifetimeDays` (1–7), `rateLimitPerMinute`, `allowHttpOrigins` (default false; `findPageAccess` ignores grants on non-loopback `http:` origins while off — `isInsecureOrigin`), `connectors`, `pageAccess`. Connectors and page grants carry an optional `builderUntil` (their own 2-hour ToolBridge grant). | `storage.local["mcpBridge"]` |
| **Connector stats** | `requests`, `lastSeenAt` per connector id (kept apart so bookkeeping can never overwrite user actions). | `storage.local["connectorStats"]` |
| **Audit log** | Ring buffer (500, oldest dropped) of agent calls and denials: caller, domain, tool, 160-char args preview, ok, ms, error. | `storage.local["mcpAudit"]` |
| **Bridge status** | Live state for the UI: `disabled / setup / connecting / connected / error / expired`, `connectorCount`, `detail`. | `storage.session["mcpBridgeStatus"]` |
| **Session tabs** | `domainName` or `domainName@dc` → `tabId` of the tab currently used for that origin; `ownedTabs` = tab ids the extension opened (the only ones ever mapped); `tabGroupId` = the "TabBridge" tab group. | `storage.session` |
| **ToolBridge** | Virtual, read-only built-in domain whose tools are handled natively. Never stored. | code (`utils/builtin.ts`) |

Everything is in `chrome.storage.local`, never `sync` (scripts may contain CSRF tokens; sync also has an 8 KB/item quota), and the worker locks it to `TRUSTED_CONTEXTS`.

---

## 3. Components and files

```
tabbridge/
├── public/
│   ├── manifest.json            MV3 manifest (permissions below)
│   ├── icons/icon128.png        extension icon
│   ├── popup/popup.html         read-only overview (app bar · site chip · two accordions · footer status bar)
│   ├── approve/approve.html     approval window (Allow / Deny) for agent-initiated changes
│   └── options/options.html     settings page: Domains & Tools · Profiles · Web MCP
├── src/
│   ├── background/
│   │   ├── service-worker.ts    orchestrator: storage lock-down, domain tabs, executeTool / executeAgentCall,
│   │   │                        page authorisation, audit, ToolBridge dispatch, alarms
│   │   ├── native-bridge.ts     Native Messaging port to the connector script; per-connector MCP serving
│   │   ├── mcp-server.ts        dependency-free MCP (JSON-RPC 2.0) server — the extension IS the server
│   │   ├── builtin-tools.ts     native handlers for the ToolBridge domain (dependency-injected, Node-testable)
│   │   └── confirm.ts           Allow/Deny via a dedicated approval window (approve/), fails closed
│   ├── content/
│   │   ├── bridge.ts            ISOLATED world on every page: asks the worker which tools THIS origin may use, relays calls
│   │   └── page-injected.ts     MAIN world: builds window.__ext_mcp_tools from metadata, fires tabbridge:tools:update
│   ├── data/domains.ts          MAIN-world postMessage dispatcher (pending-call registry)
│   ├── options/
│   │   ├── options.ts           tab router (#domains[/name] · #profiles · #mcp)
│   │   ├── domains_view.ts      browse / run / edit tools, export / import
│   │   ├── profiles_view.ts     profile editor (plain tool collections)
│   │   ├── mcp_panel.ts         connectors, page access (each with its 2-hour ToolBridge switch), rate limit, audit
│   │   ├── connector.template.sh  the pure-bash connector (relay + native host + installer)
│   │   └── connector_script.ts  fills the template's @@PLACEHOLDERS@@
│   ├── popup/popup.ts           read-only overview
│   ├── approve/approve.ts       approval window logic
│   ├── ui/theme.css             design tokens + shared primitives (Metronic-inspired night theme) used by all three pages
│   ├── types/plugin.types.ts    all stored shapes
│   └── utils/
│       ├── mcp.ts               toMcpToolName, ExposedTool, native-messaging envelope types, NATIVE_HOST_NAME, MCP_SERVER_KEY
│       ├── profiles.ts          PURE exposure logic: resolveProfileTools / resolveExposedTools / isToolAllowed / lookupConnector /
│       │                        validateArgs / validateDomains / normalizeDomains / normalizeOrigin / sameOrigin / RateLimiter
│       ├── builtin.ts           ToolBridge domain + tools, isBuilderActive / withBuilderGrant / purgeExpiredBuilderGrants (per caller), agent-facing messages
│       ├── import_export.ts     validated, quarantined, previewed import; export
│       └── storage.ts           the ONLY accessor for chrome.storage.* (domains, profiles, bridge config, stats, audit)
├── scripts/build.mjs            5 Vite IIFE bundles + static copies → dist/
└── examples/sample-domain.json  importable sample (arrives disabled)
```

**Manifest**: permissions `tabs, storage, userScripts, alarms, nativeMessaging, tabGroups`; `host_permissions: <all_urls>` (content scripts must be able to run on any page the user might grant); content scripts `content/bridge.js` (ISOLATED) and `content/page-injected.js` (MAIN) at `document_idle`; `minimum_chrome_version: 135` (needed for `chrome.userScripts.execute`); CSP `script-src 'self'; object-src 'self'`; `options_ui` opens in a tab.

**Prerequisite in Chrome**: the user must turn on **Allow user scripts** for the extension (chrome://extensions → Details). Without it `chrome.userScripts` is absent and every tool run fails with an explanatory error.

---

## 4. How a tool runs (`executeTool`)

`service-worker.ts: executeTool(domain, toolName, args, caller)`

1. Resolve the stored domain and tool (scripts are read at call time, so edits are live). `toolName === "get_dc_list"` is answered by the worker itself (default origin + `dcs`), no tab involved.
2. Strip the `dc` envelope argument (`""`/`"default"` = none; a `dc` on a domain without `dcs` is an error), then `validateArgs(inputSchema, toolArgs)` — object required; required keys present (own-property check); declared primitive types; `enum`; extras rejected when `additionalProperties:false`; `__proto__`/`constructor`/`prototype` always rejected.
3. `targetFor(domain, dc)` → `{ key, origin, startUrl }`: the base URL, or the named DC's origin with `startScript`'s path re-based onto it (unknown DC → error naming `get_dc_list`). Session tabs are keyed `<Domain>` or `<Domain>@<dc>`.
4. `getOrOpenTab(target)` — reuse the mapped tab if its **current URL has exactly the target origin**, otherwise drop the mapping and open `startUrl` in a background tab (`openDomainTab`: records the id in `SessionState.ownedTabs` and adds it to the "TabBridge" tab group when `chrome.tabGroups` exists — best-effort, cosmetic), wait for `status === "complete"`, re-check the origin. A tab that lands elsewhere (login redirect) is closed and the call fails with guidance.
5. `ensureToolPage` — if the tool has a relative `url` and the tab is not on it (`tabOnPage`: same origin, same path, same query when the url has one), `chrome.tabs.update` to `origin + url`, wait for load, forget the tab's init flag (page reloaded) and verify the tab actually reached that page (a same-origin login redirect fails the call).
6. `ensureDomainInit` — run `domainScript` once per tab; the flag is also cleared on every `loading` tab update, so a self-navigated or reloaded tab is bootstrapped again.
7. Final re-check right before injection: origin, and for page-bound tools the path too. Then `runScriptInTab`: `chrome.userScripts.execute({ target:{tabId}, world:"MAIN", js:[{ code }] })` where
   `code = (async function(args){ if (location.origin !== "<expected>") throw …; <toolScript> })(<args as JSON literal>)`.
   `location.origin` is unforgeable, so a navigation between the check and the run throws instead of executing elsewhere. Args are a JSON literal, not `JSON.parse` (which a page could patch).
8. The returned value (JSON-serialisable) is the result.

Tabs are mapped to targets by `chrome.tabs.onUpdated` (exact origin of the base URL or of a configured DC, no content script involved) **only when the tab id is in `ownedTabs`** — a tab another site opened on the domain origin via `window.open` is never adopted, because its opener could pre-load a page, navigate it between check and run (the guard checks origin only) or close it. Mappings and ownership are dropped on `tabs.onRemoved`.

`executeTool(domain, tool, args, caller, trusted)`: `trusted` is an explicit boolean set only by the `TOOL_EXECUTE` branch for extension pages (`isExtensionPage`). It makes ToolBridge calls skip the approval window (the user is the caller). Trust is never derived from the caller string; `settings` / `page` / `tabbridge` / `toolbridge` are reserved connector labels (`RESERVED_CONNECTOR_LABELS`) so audit rows and `createdBy` tags cannot impersonate those callers either.

**Exposure side of DCs / defer_loading (`profiles.ts: resolveProfileTools`)**: for a domain with `dcs`, each exposed tool's schema gets an optional string `dc` property (`withDcArg`, enum names in the description) and a synthetic `<Domain>__get_dc_list` tool is appended whenever at least one tool of that domain is exposed. `StoredTool.deferLoading` is carried onto `ExposedTool.deferLoading`; `mcp-server.ts` `tools/list` emits it as `defer_loading: true` plus `_meta.defer_loading` (a Claude-client hint, not MCP protocol). `StoredTool.url` is a display/execution attribute only: views group tools by it (`groupToolsByUrl`), and `ensureToolPage` navigates to it. Validation lives in `validateDomains` (`DC_NAME_RE`, unique, not `default`, http(s), different origin from `baseUrl`; `isRelativeUrl` = `/…` without `//`, whitespace or `#`; `get_dc_list` is a reserved tool name; derived MCP names must be unique across all domains, since sanitising/truncation could otherwise make two tools collide and the first match would win).

If `domain === "ToolBridge"` the call is dispatched to `builtin-tools.ts` instead (section 8).

### Agent path: `executeAgentCall(caller, domain, tool, args)`

Used for connectors and granted pages (never for the settings page's own **Run**, which is the user). In order:

1. Rate limit per caller (`RateLimiter`, `rateLimitPerMinute`, 0 = unlimited).
2. Tool lookup (including ToolBridge) and `validateArgs` — **before** any prompt.
3. If `tool.requireConfirmation`: `confirmWithUser(...)` opens the approval window with the full arguments; deny / timeout / closed → error.
4. `executeTool`.
5. Always append an **audit entry** (ok or error, duration). Denials that happen before this function (not granted, not in profile, stale envelope) are audited via `auditDenied`.

---

## 5. Path A — in-page agent (`window.__ext_mcp_tools`)

```
page (MAIN)  page-injected.ts ──EXT_TOOL_CALL (postMessage, same window)──▶ bridge.ts (ISOLATED)
                                                                              │ TOOL_EXECUTE (runtime message)
                                                                              ▼
                                                        service worker: authorizePageCall → executeAgentCall
                                                                              │
page (MAIN)  ◀──EXT_TOOL_RESULT──────────────────────────────────────────── bridge.ts
```

- `bridge.ts` runs on every page but **never touches storage**. On load (and on `ext:page-ready`, and when the worker pings `TOOLS_CHANGED`) it sends `PAGE_TOOLS`; the worker answers from `sender.origin` (set by Chrome, unspoofable; top frame of a real tab required) → `findPageAccess` → `resolveExposedTools(profile, domains, grant)`. Pages without a grant get `[]` and nothing is posted. Only **metadata** (name, domain, description, inputSchema) ever reaches a page — never scripts.
- `page-injected.ts` publishes `window.__ext_mcp_tools = [{ name, description, inputSchema, handler }]` and dispatches `CustomEvent("tabbridge:tools:update")`. `handler(args)` posts `EXT_TOOL_CALL`; `data/domains.ts` resolves the matching `EXT_TOOL_RESULT` by UUID.
- Every `TOOL_EXECUTE` from a page is re-authorised in the worker (`authorizePageCall`): grant for the exact origin → profile → tool allowed (`resolveExposedTools` with the grant as caller). A denial from an origin with **no grant at all is not audited** (`audit:false`): any site can post `EXT_TOOL_CALL`, and the 200-row ring plus storage quota must not be floodable from outside. Denials from granted origins are audited through `appendAuditThrottled`: failed-call rows are capped at 5 per caller per minute (`DenialThrottle`; suppressed count attached to the caller's next failure row), successful calls are always written, and `boundAudit` bounds every field. So neither an ungranted site nor a granted-but-hostile caller can flush the 500-row ring. Denials come back as errors and are audited.
- `postMessage` uses `window.location.origin` as target, not `"*"`.
- Live updates: the worker listens to `storage.onChanged` and sends a data-less `TOOLS_CHANGED` to tabs whose origin has (or just lost) a grant; they re-ask `PAGE_TOOLS`.

The consumer on the host application's side reads `window.__ext_mcp_tools` and listens for `tabbridge:tools:update`. That is the only coupling to the outside world.

---

## 6. Path B — external MCP clients via the connector script

### 6.1 Why a bash script, and why the extension is the server

A browser extension cannot listen on a port, and users should not need Node. So the download is a **pure bash script** (bash 3.2+, coreutils only; macOS/Linux) and **the extension is the MCP server**. The script only moves bytes:

```
agent ──MCP over stdio──▶ connector.sh --stdio            (RELAY, spawned by the agent)
                             │ writes  ~/.tabbridge/spool/<id>.req
                             ▼
                          connector.sh chrome-extension://<id>/   (NATIVE HOST, spawned by Chrome — same file)
                             │ Chrome Native Messaging: 4-byte little-endian length + JSON
                             ▼
                          service worker: native-bridge.ts → lookupConnector → mcp-server.ts → executeAgentCall
                             │ reply envelope → host writes <id>.res → relay prints the JSON-RPC line to stdout
```

### 6.2 Download (settings → Web MCP)

`mcp_panel.ts: downloadConnector()`:
1. Mint `token` (24 random bytes, hex) — exists **only** in the downloaded file.
2. Store a `Connector { label, profileId, tokenHash: sha256(token), issuedAt, expiresAt = now + lifetimeDays, active:true }`.
3. Fill `connector.template.sh` placeholders (`@@TOKEN@@ @@EXT_ID@@ @@HOST_NAME@@ @@SERVER_KEY@@ @@CONNECTOR_ID@@ @@PROFILE_NAME@@ @@ISSUED_AT@@ @@EXPIRES_AT@@ @@VERSION@@ @@ISSUED_ISO@@ @@EXPIRES_ISO@@`) and download `tabbridge-connector-<label>.sh`. Values are validated to contain no quotes/backslashes/newlines.
4. Ask the worker to reconnect (`MCP_BRIDGE_RECONNECT`).

Several connectors can be active at once (different profiles, different agents).

### 6.3 The script's three roles (`connector.template.sh`)

| Invocation | Role | What it does |
|---|---|---|
| `bash tabbridge-connector-X.sh` | **setup + print** | `install_host` (`install_self`: copy the script to `~/.tabbridge/bin/<name>.sh`, `chmod 700` (the macOS quarantine flag is deliberately left alone: it does not block script execution and stripping it trips endpoint security) — `~/Downloads`, `~/Desktop`, `~/Documents` are TCC-protected and other apps spawning bash there get "Operation not permitted"; `mkdir -p` + `chmod 700` `~/.tabbridge` and `spool`; write the Native Messaging manifest `com.tabbridge.connector.json` into every Chromium-family profile dir found — Chrome, Beta, Canary, Chromium, Brave, Edge, Vivaldi, Arc on macOS; the `~/.config/*` equivalents on Linux — with `path` = the **installed copy** and `allowed_origins = ["chrome-extension://<EXT_ID>/"]`); then prints the `mcpServers` JSON (`command: bash`, `args: [<installed copy>, "--stdio"]`, key `tabbridge-<label>`) on **stdout** and guidance on **stderr**. |
| `bash … --stdio` | **relay** (the agent runs this) | `host_registered || install_host` (register only if no usable registration exists: manifest present, target file exists, same `VERSION`); install traps; `hello_check`; then loop: read one JSON-RPC line from stdin → write envelope → wait for `<id>.res` (poll 50 ms, up to `TABBRIDGE_TIMEOUT_S`, default 90) → strip the `{"id":"<id>","line":` prefix and the trailing `}` → print the line (unless `null`, i.e. a notification). On timeout: JSON-RPC error `-32000` with guidance. |
| `connector.sh chrome-extension://<id>/` | **native host** (Chrome runs this) | Refuses any origin other than `chrome-extension://<EXT_ID>/` (exit 6). Reader subshell: `read_frame` (4-byte header via `dd bs=1 count=4`, body via `dd` loop — never `head -c`, which over-reads pipes) → if body starts with `{"id":"` and the 32-hex id is valid, write it to `<id>.res`. Writer loop: every 100 ms forward each `<id>.req` as a frame; every ~20 s send `{"type":"ping"}` (keeps the MV3 worker alive) and prune `*.res/*.req/*.tmp` older than 2 min. Exits when Chrome closes stdin. No expiry check in this role (see "Security" §N3). |
| `bash … --uninstall` | cleanup | Removes the manifests, the spool and the installed copy. |

**Envelope written by the relay** (agent line first, relay's keys last so a line that tries to break out of the slot cannot override them — JSON parsers keep the last duplicate):
`{"line":<raw JSON-RPC line>,"ts":<epoch s>,"id":"<32 hex>","token":"<token>"}`
Hello: `{"hello":true,"ts":…,"id":…,"token":…}`.

**Reply envelope from the extension** (key order is a contract; Chrome preserves insertion order for native-messaging ports): `{"id":"<id>","line":<JSON-RPC response | null>}`. Hello reply: `{"ok":true,…}` or `{"ok":false,"reason":…,"message":…}`; the relay checks the `{"ok":true` prefix only.

**Exit codes**: `5` refused by the plugin at hello (expired / deactivated / unknown / stale — the script never decides validity itself; `EXPIRES_AT` in the file is informational), `6` native host launched by a different extension, `129/130/143` HUP/INT/TERM after cleanup.

**Env**: `TABBRIDGE_HOME` (default `~/.tabbridge`; must match for relay and host), `TABBRIDGE_TIMEOUT_S` (digits only, else 90). Layout under `~/.tabbridge`: `bin/` (installed connector scripts), `spool/` (request/reply files), all `0700`.

### 6.4 Extension side (`native-bridge.ts`)

- When `mcpBridge.enabled` and ≥1 connector exists, the worker calls `chrome.runtime.connectNative("com.tabbridge.connector")`. Chrome launches the registered script. Disconnect reasons map to status: *not found* → `setup` (user has not run a script), *forbidden* → `error` (manifest for another extension id), else `connecting` with backoff 5 s → 60 s. A 1-minute alarm reconnects, purges expired connectors and refreshes status.
- Per incoming envelope: ignore `ping`; reject if `ts` older than 120 s (stale replay) — `-32002`; `lookupConnector(cfg, sha256(token))` → unknown / deactivated / expired → hello `{ok:false}` or JSON-RPC `-32001` with a human-readable message; otherwise build an MCP server **bound to that connector's profile** (`resolveProfileTools` re-read on every call, so profile edits apply live) and `handle(line)`.
- `mcp-server.ts` answers `initialize` (protocol negotiation), `ping`, `tools/list` (`tabbridge_status` + profile tools), `tools/call`, empty `resources/list` / `prompts/list`; notifications get no reply; batches capped at 10 and processed sequentially; `unavailableReason` lets the bridge return the ToolBridge NOT AUTHORIZED text instead of "unknown tool".
- `tabbridge_status` reports connector label, profile, expiry, requests served, extension version — never tokens.
- The relay cannot receive `tools/list_changed` (stdio relay has no push channel), so new tools appear only after the agent restarts the MCP connection; success messages say so.

### 6.5 Lifecycle controls (settings → Web MCP)

- **Deactivate** a connector: `active=false`; next hello/call is refused with a "Sorry — connector … has been deactivated" message (script exits 5 at start; a running agent gets `-32001`). **Extend / Reactivate** (`extendConnector`, 1–7 days from now) makes the same script valid again. Expired connectors stay listed until the user clicks Delete.
- **Lifetime** 1–7 days chosen at download, enforced by the extension only (per token hash); the script carries the initial value for information.
- **Rate limit** per caller per minute.
- **Retry now** forces a reconnect.

---

## 7. Profiles and page access (the exposure rule)

`utils/profiles.ts` is the single place the rule lives:

- `resolveProfileTools(profile, domains)`: for each domain (stored ones + the virtual ToolBridge), include a tool iff the profile selects it (`"*"` or by name) **and** the domain is enabled **and** the tool is enabled (global toggles are a kill switch) **and**, for ToolBridge, the 2-hour grant is active.
- `resolveExposedTools(profile, domains, caller)`: the profile's tools **plus all ToolBridge tools while the caller's own `builderUntil > now`** (`builtinExposedTools`). The caller is the `Connector` or `PageAccess` record.
- Both connectors and pages go through `resolveExposedTools`, re-evaluated on every `tools/list` and every `tools/call`. The connector record is re-read from storage per call: a Deactivate, Delete, Extend or ToolBridge switch flipped after `hello` takes effect on the very next call, mid-batch included (a missing or non-live connector exposes `[]`). Deactivate and Extend/Reactivate both drop `builderUntil`, so a connector never comes back with tool-building rights it was not re-granted.
- Profiles are edited in the **Profiles** tab (whole domain / individual tools / none; rename, delete with usage warning). Page access grants (`origin → profile`, one profile per origin, origin normalised and validated) are managed in **Web MCP → Page access**. By default **no page has access**.

---

## 8. ToolBridge — letting an agent build tools

Virtual domain `🔒 ToolBridge` (`utils/builtin.ts`, handlers in `background/builtin-tools.ts`). Tools:

| Tool | Effect |
|---|---|
| `list_domains` | Domains, URLs, enabled flags, tool names/descriptions — **never scripts**. |
| `list_profiles` | Profiles and their selections. |
| `add_tool` | Creates a tool in a domain; creates the domain when given `baseUrl` + `startUrl` (absolute http(s), same origin); optional `profile` to enable it in the same step. |
| `update_tool` | Edits an existing tool: `newName`, `description`, `inputSchema`, `script` (omitted fields unchanged). Same validation as `add_tool`; approval window shows the full new script; a rename rewrites profile selections; sets `updatedBy/updatedAt`. Cannot touch ToolBridge, enabled/requireConfirmation, or move domains. |
| `enable_tool_in_profile` | Adds an existing tool to a profile. Refuses ToolBridge's own tools (only the user may grant builder rights). |

Deliberately absent: delete, disable/enable flags, moving tools between domains, page access, connectors, profile creation.

Guards, in order of evaluation:
1. **Exposure**: a caller (connector script or page-access grant) sees these tools only while **its own** `builderUntil > now`. Profiles are not involved. The user flips the 🔒 ToolBridge switch on the connector row / page row in the Web MCP tab (`withBuilderGrant` → `now + 2 h`, "Renew 2 h" button, confirm dialog on enable; disabled for non-live connectors). A worker alarm (`purgeExpiredBuilderGrants(cfg)`) clears elapsed grants every minute so the switch visibly turns off; `isBuilderActive` ignores elapsed grants regardless.
2. **Call-time re-check**: an agent that cached the tools from an earlier `tools/list` and calls after expiry receives the **NOT AUTHORIZED** text (`builderDeniedMessage(kind, label)`) naming the connector label or page origin and the exact user steps (Settings → Web MCP → row → switch on 🔒 ToolBridge; 2 hours; restart the MCP connection if the tools are missing from the list).
3. **Validation before the approval window opens**: names `^[A-Za-z][A-Za-z0-9_-]{0,47}$`, description and script required, script must contain `return`, schema must be an object schema, reserved name rejected, duplicate tool rejected, unknown profile rejected, new-domain URLs validated and same-origin, whole result validated with `validateDomains`. Invalid calls never open the approval window.
4. **User approval**: `confirmWithUser(request)` opens `approve/approve.html` in a focused popup window naming the caller (connector label / page origin), action and target, with description, domain URL, target profile, argument list, the **complete script**, a **"Runs on"** line (base URL + every DC origin the script can be sent to) and the honest **"Callable right away by"** line on `add_tool`, `update_tool` and `enable_tool_in_profile` (`immediateExposure`: every profile whose selection covers the tool — `"*"` or a stale explicit entry — and the live connectors / page origins bound to them; new tools arrive enabled and edited scripts go live at once, so the window says who gets them); 40 s countdown.
   **Lost-update safety**: the window can stay open 40 s. Every mutating ToolBridge tool re-loads storage AFTER approval and applies only its own change (new tool appended; edited fields copied onto the current tool; profile entry added), re-validates, then saves — a toggle the user flipped meanwhile, or another agent's approved change, is never overwritten. If the target vanished or a name collided meanwhile, nothing is saved and the agent is told. Deny / timeout / window closed / window failed to open ⇒ refused, nothing saved.
5. **Provenance**: created tools get `createdBy` (caller) and `createdAt`, shown as a badge in Domains & Tools; they arrive `enabled:true, requireConfirmation:false` (the creation itself was approved) and can be tightened or deleted by the user like any tool.
6. **Messages**: successful replies carry `message` with an **IMPORTANT — tell the user** restart note and the MCP tool name, written to be relayed verbatim.
7. The settings page's own **Run** of ToolBridge tools skips the approval window (caller `"settings"`, which only `isExtensionPage` senders can reach).

---

## 9. Settings page and popup

- **Popup** (`popup/`): read-only — current tab's origin with its grant/profile/tools, bridge status line, one card per domain (tools, disabled greyed, `confirm` badge) with **Details →** into the settings page, ⚙ Settings.
- **Domains & Tools** (`domains_view.ts`): sidebar of domains (+ pinned 🔒 ToolBridge), domain detail with edit/delete (URLs must be absolute http(s); reserved name refused), tool cards with the full definition, **Run** (schema-driven form: string/number/integer/boolean/enum→select/object|array→JSON textarea; output with timing), **Edit** (name, description, schema validated, script, enabled, require confirmation), add/delete tools; **Export** / **Import** (section 10). Storage write failures surface as alerts.
- **Profiles** (`profiles_view.ts`): sidebar of profiles with exposed-tool counts; per-domain tri-state selection; no ToolBridge card (granted per caller in Web MCP).
- **Web MCP** (`mcp_panel.ts`): master switch + status + Retry; connector download (profile, lifetime) and list (Deactivate / Remove); rate limit; page access grants; a 🔒 ToolBridge switch (2 h, confirm on enable, Renew) on every connector row and page row; recent agent activity (audit, Clear).

---

## 10. Export / import (`utils/import_export.ts`)

- Export: `{ domains, exportedAt }` JSON (`tabbridge-config-<timestamp>.json`). Contains scripts — treat the file as sensitive.
- Import: parse → `validateDomains` (types, absolute http(s) URLs, no `__proto__`/`constructor`/`prototype` keys, duplicate names, reserved name, schema shape) → `normalizeDomains(…, quarantine=true)` (every domain and tool **disabled**, `requireConfirmation:true`) → merge preview (new domains, new tools in existing domains; existing items never overwritten) → `confirm()` listing what comes in and that scripts run with the user's session once enabled → atomic save of the merged copy.

---

## 11. Security controls — where each one is enforced

| Threat | Control | Code |
|---|---|---|
| Any website calling tools / reading scripts | Page tools only via grant for the **exact origin** from `sender.origin` (Chrome-set), top frame of a real tab; metadata only; every call re-authorised | `service-worker.ts` `senderOrigin`, `toolsForSender`, `authorizePageCall` |
| Compromised renderer abusing the content script | `storage.local.setAccessLevel("TRUSTED_CONTEXTS")`; content script never reads storage; worker pushes data-less `TOOLS_CHANGED` only to granted tabs; `postMessage` to own origin | `service-worker.ts`, `content/bridge.ts` |
| Attacker page posing as a domain tab | Only extension-opened tabs (`ownedTabs`) are mapped; exact-origin mapping via `tabs.onUpdated`; path re-checked for page-bound tools; a failed page navigation drops and closes the tab (`dropTab`); opaque origins never match; origin re-checked before execution; unforgeable `location.origin` guard inside injected code; args as JSON literal; redirecting start URL closed | `service-worker.ts` `getOrOpenTab`, `runScriptInTab`; `profiles.ts` `sameOrigin` |
| Over-eager / prompt-injected agent | Per-tool **Require confirmation** (fails closed); per-caller **rate limit**; **audit log** incl. denials from granted callers (ungranted pages are not logged, fields bounded); arg validation before prompts; batch cap 10, sequential | `executeAgentCall`, `confirm.ts`, `RateLimiter`, `mcp-server.ts` |
| Agent escalating via ToolBridge | Per-caller (connector / page origin) 2 h grant checked at call time, never inherited through a profile; off by default; user Allow per create/edit/enable; `enable_tool_in_profile` cannot grant ToolBridge; validation before prompt; provenance | `builtin.ts`, `builtin-tools.ts`, `resolveExposedTools` |
| Stolen `chrome.storage` | Connector tokens stored as SHA-256 only; stats under a separate key | `profiles.ts` `hashToken`, `storage.ts` |
| Old / stolen connector script | Per-connector token hash, lifetime and Deactivate enforced by the extension on every call; hello handshake at start; Delete is permanent; envelope `ts` ≤ 120 s | `native-bridge.ts`, `connector.template.sh` |
| Local processes / stale files | `umask 077`; spool `0700`; `.req/.res/.tmp` pruned after 2 min; relay removes its pending request on exit; native host serves only its own extension id; `--stdio` registers only when the registered host is missing / expired / other version; duplicate-key injection loses (relay keys last) | `connector.template.sh` |
| Malicious import | Validation + quarantine + preview + confirm + atomic apply; popup cannot edit | `import_export.ts`, `domains_view.ts` |
| Sync leakage / quota | Everything in `storage.local`, nothing ever written to sync; write failures surfaced | `storage.ts` |
| Env/argument injection in the script | Timeout env digits-only; `$SELF` JSON-escaped; `${VAR:?}` guards on every `rm` | `connector.template.sh` |

**Residual, by design** (documented in README): the native host process is a trust anchor (whoever controls the registered script path sees tool results); tools run in the MAIN world of the legitimate domain page; the token travels inside each `.req` file in the `0700` spool; a malformed or >1 MB line from a local agent can make Chrome drop the shared native port (it reconnects); the bash relay serves one agent's requests sequentially. **Per-connector profiles isolate agents only from each other's MCP endpoints, not from the filesystem**: tokens are baked into user-readable scripts and spool files, so an agent with shell access as the user can run any other connector (including one whose ToolBridge window is open). The README tells users to give such agents the profile they would give themselves.

---

## 12. Message and storage contracts (quick reference)

Runtime messages (`utils/message.ts`): `TOOL_EXECUTE {id, domain, toolName, args}` → `RuntimeResponse {ok, result?, error?}`; `PAGE_TOOLS` → `{ok, tools: PageToolMeta[]}`; `TOOLS_CHANGED` (worker → tab, no data); `OPEN_DOMAIN_TAB` / `CLOSE_DOMAIN_TAB {domainName}` (extension pages only); `MCP_BRIDGE_RECONNECT`.
Window messages (same window only): `EXT_TOOLS {tools}`, `EXT_TOOL_CALL {id, domain, toolName, args}`, `EXT_TOOL_RESULT {id, ok, result?, error?}`; DOM events `ext:page-ready`, `tabbridge:tools:update`.
Native messaging: request `{line, ts, id, token}` / `{hello:true, ts, id, token}` / `{type:"ping"}`; reply `{id, line}`.
Alarms: `mcp-bridge-keepalive` (1 min), `builder-grant-expiry` (1 min).
Identifiers: native host `com.tabbridge.connector`; MCP server name `tabbridge`; MCP key per connector `tabbridge-<label>`; status tool `tabbridge_status`; built-in domain `ToolBridge`.

---

## 13. Build, test, verify

```bash
cd jsapps/tabbridge
npm install            # vite, typescript, @types/chrome only
npm run check          # typecheck + build → dist/ (load this folder unpacked)
npm run build:zip      # tabbridge.zip
```

Tests are not wired into npm yet. The pure modules (`utils/profiles.ts`, `utils/builtin.ts`, `background/mcp-server.ts`, `background/builtin-tools.ts`) have no Chrome dependency and run under `node --experimental-strip-types` after rewriting relative imports to `.ts`. The bash template is exercised end-to-end by driving a fake Chrome (framed native messaging over a pipe) and a fake agent (JSON-RPC lines over stdio) — see git history of the review sessions for the harnesses. UI is checked by serving `dist/` with a `chrome.*` stub.

Manual verification checklist in real Chrome after a change: reload the extension → **Allow user scripts** on → import `examples/sample-domain.json`, enable, create a profile → Web MCP: switch on, download a connector, `bash ~/Downloads/tabbridge-connector-<label>.sh`, paste the config into an agent → `tabbridge_status`, a tool call, a confirmation-flagged tool, a ToolBridge `add_tool` with the grant on and off.

---

## 14a. Publishing hygiene (this is a public repository)

- **Commit identity**: author and committer are always `patrickp1702 <48005784+patrickp1702@users.noreply.github.com>`. Never a personal or employer e-mail address, in commits, docs, comments or sample data.
- **No internal references**: no internal hostnames, mirrors, app ids, machine paths or company names anywhere in the tree. Sample data uses `example.com`; the only absolute local path in docs is the placeholder `/Users/you/...`.
- **Lockfile**: every `resolved` URL in `package-lock.json` points at `https://registry.npmjs.org/`. If a lockfile is regenerated behind a private npm mirror, rewrite the host before committing.
- Before every push, grep the tree and `git log --format='%an <%ae>%n%cn <%ce>%n%B'` for the items above.

## 14. Extending safely

- Any new way to **expose** a tool must go through `resolveExposedTools`; any new way to **run** one must go through `executeAgentCall` (not `executeTool`) unless the caller is the extension's own UI.
- New stored fields: add to `plugin.types.ts`, default them in `normalizeBridgeConfig` / `normalizeDomains`, validate them in `validateDomains`.
- New envelope fields: the relay must keep its own keys **last**; the reply prefix `{"id":"<id>","line":` is a bash contract.
- New built-in tools: add to `BUILTIN_TOOLS`, handle in `runBuiltinTool`, validate before `deps.confirm`, write the result `message` for the agent to relay, never return scripts.
- Never reintroduce `chrome.storage.sync`, `postMessage("*")`, `startsWith(baseUrl)`, `head -c` in the host, content-script storage access, trust derived from a caller label, or adoption of tabs the extension did not open.
