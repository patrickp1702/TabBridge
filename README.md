# TabBridge

A Chrome MV3 extension that turns scripts running in your logged-in browser tabs into **MCP tools** — for an agent embedded in a web page, or for external agents (Claude Code, Claude Desktop, Cursor, …) through a downloadable connector.  
Each tool is a plain JavaScript snippet that runs inside a real browser tab — with your session cookies, CSRF tokens, and page globals intact — and returns its result to the agent that called it.

---

> Architecture, threat model and contracts for maintainers and AI agents: [AGENTS.md](AGENTS.md).

## How it works (briefly)

```
in-page agent calls tool.handler(args)
  → content script forwards to background service worker
  → service worker opens (or reuses) the domain tab
  → your tool script executes inside that tab via chrome.userScripts
  → result is returned back to the in-page agent
```

Tools are stored in `chrome.storage.local` as plain JSON (device-local — scripts may hold CSRF tokens, so they are never synced to the Google account; share via Export / Import). You write them in the popup or the settings page — no rebuild needed.

---

## Prerequisites

| Requirement | Details |
|---|---|
| **Chrome 135+** | Required for `chrome.userScripts.execute()` which runs tool scripts CSP-free |
| **Developer mode** | `chrome://extensions` → toggle top-right |
| **"Allow user scripts"** | Per extension — see setup below |

---

## Installation

### 1. Build

From the plugin directory:

```bash
cd jsapps/tabbridge
npm run build
```

Output goes to `dist/`.

### 2. Load in Chrome

1. Go to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `dist/` folder

### 3. Enable "Allow user scripts" (required)

1. On `chrome://extensions`, find **TabBridge**
2. Click **Details**
3. Scroll to **Allow user scripts** → turn it **on**
4. Click the extension's reload icon (↺)

> Without this toggle, `chrome.userScripts` is entirely absent and tool scripts cannot execute.

---

## Settings page (browse · run · edit tools)

Popup → **⚙ Settings** (or `chrome://extensions` → Details → **Extension options**). Opens in a full tab with two tabs:

**Domains & Tools** (`#domains`)
- Left: every registered domain with enabled dot and `enabled/total` tool count. **+ Add Domain** opens an inline form.
- Right: the selected domain — Base URL, Start URL, domain script, enable toggle, **✎ Edit domain** (rename / URLs / script / delete).
- One card per tool with the **complete definition**: name, Web-MCP name (`<domain>__<tool>`), description, input schema, tool script, enable toggle.
- **▶ Run**: a form generated from the input schema (string / number / integer / boolean / enum → select / object & array → JSON textarea, required markers). **Execute** calls the tool through the service worker exactly like the in-page agent does (opens the domain tab if needed) and shows the output, status, and timing. **Show args JSON** previews the payload without running.
- **✎ Edit**: inline editor for name, description, schema (validated JSON, `"type": "object"` enforced), script, enabled flag and **Require confirmation** (agent calls must be approved in an approval window), with Save / Cancel / Delete. Domain URLs must be absolute http(s). Changes land in `chrome.storage.local` and propagate live to the in-page agent and the Web MCP bridge.

**Profiles** (`#profiles`)
- A profile is a named set of tools: per domain tick *all tools* (includes tools added later) or pick tools individually. Nothing outside a profile is ever listed or callable by an agent. Tools switched off in Domains & Tools are greyed and never exposed (global kill switch).
- Profiles are referenced by connector scripts and page-access grants; edits apply live.

**Web MCP** (`#mcp`) — connectors and page access, see below.

Deep link to a domain: `options/options.html#domains/<DomainName>`.

---

## Using the popup

Click the extension icon in the Chrome toolbar to open the popup. It is a **read-only overview** of the current tab; all editing happens in the settings page (**⚙ Settings**).

- **Tools this page can use** (collapsed accordion): a verdict pill — No access, or Granted · profile · N tools, plus a 🔒 pill when this page origin's ToolBridge switch is on. Expand for the list or the how-to.
- **Tools this page provides** (expanded): if the site is a configured domain, its tools with full MCP name, badges (`off`, `confirm`, `deferred`, `by agent`) and a 2-line description with See more. Tools bound to a page path are grouped under that path. **Details →** opens the settings page at that domain.
- **Footer**: bridge status · active connector scripts · pages granted · Web MCP link.

### Domain edit view (settings page)

| Field | Description |
|---|---|
| **Name** | Unique identifier, e.g. `LogsLocal` |
| **Base URL** | Used to match a tab to this domain, e.g. `https://logs.example.com` |
| **Start Script (URL)** | The URL that gets opened when you enable the domain, e.g. `https://logs.example.com/` |
| **Domain Script** | Optional JS run once per tab session after the tab loads. Useful for auth setup or reading page state. Leave empty if not needed. |
| **Other data centres** | Optional, one per line as `name = https://origin` (e.g. `eu = https://logs.eu.example.com`). Same product, same tools, different host. See *Multi-DC domains* below. |

Under the domain form, you manage that domain's tools. Tools that declare a **Page URL** are listed under a collapsible sub-heading per page (open by default); tools without one come first.

### Tool edit view

| Field | Description |
|---|---|
| **Name** | Unique identifier for the tool, e.g. `fetchLogs` |
| **Description** | Shown to the in-page agent — describe what the tool does clearly |
| **Input Schema** | JSON Schema for the tool's inputs. Use `{}` properties for no-arg tools |
| **Tool Script** | The JS that runs in the domain tab (see below) |
| **Page URL** | Optional. A path **relative to the domain, starting with `/`** (e.g. `/app/reports`) on which the tool works. Before the script runs, the domain tab is navigated there if it is not already on that path (the domain script re-runs after the navigation). Absolute URLs and `//host` forms are rejected. |
| **Defer loading** | Optional flag emitted as `defer_loading: true` in the MCP tool definition. Claude clients (Claude Code, the Claude API with Tool Search) then keep the tool out of the initial context and load it on demand when the model searches for it — useful for large or rarely used tool sets. Other MCP clients ignore it. |

### Multi-DC domains

Some products run the same web app on several data-centre hosts (`logs.example.com`, `logs.eu.example.com`, …) with identical tools. Instead of duplicating the domain per host, add the extra hosts under **Other data centres**. When a domain has at least one DC:

- an extra MCP tool `<Domain>__get_dc_list` appears (whenever any tool of the domain is exposed) and returns the default origin plus the configured DCs;
- every tool of that domain gets an optional string argument **`dc`**. Omit it (or pass `default`) and the tool runs on the base URL as before; pass a DC name and the tool runs in a tab on that DC's origin (the start URL is re-based onto that origin, the domain script runs there once, and the tool's Page URL, if any, is opened there).

The `dc` argument never reaches your tool script — it is stripped before validation and execution. DC names are lowercase `[a-z0-9_-]`, max 16 chars, unique, and `default` is reserved; each DC must be a different origin from the base URL. The popup and the in-page agent list the same tools; only the MCP definition gains `get_dc_list` and `dc`.

---

### Rules

- **`args`** is always in scope — it's the object the in-page agent passed when calling the tool
- **`await` works** — the script runs inside an `async function`
- **Must `return`** a JSON-serialisable value — this is what the in-page agent receives as the result
- The script string is a function body, not a full module — no `import`/`export`

### Minimal example

```js
// No args, returns a value
return { hello: "world" };
```

### Fetch with browser session

```js
const resp = await fetch(
  'https://logs.example.com/api/some-endpoint',
  {
    method: 'GET',
    credentials: 'include',          // sends your session cookies
    headers: {
      'accept': 'application/json',
      'x-requested-with': 'UI',  
    },
  }
);
if (!resp.ok) throw new Error('HTTP ' + resp.status);
return resp.json();
```

### Using args

```js
// Tool input schema has: { "query": { "type": "string" } }
const resp = await fetch(`/api/search?q=${encodeURIComponent(args.query)}`, {
  credentials: 'include',
});
return resp.json();
```

## Adding a new domain + tool — step by step

1. Open the popup → **+ Add Domain**
2. Fill in **Name**, **Base URL**, **Start Script URL** → **Save Domain**
3. Click **+ Add Tool**
4. Fill in **Name**, **Description**, **Input Schema** (JSON), **Tool Script** → **Save Tool**
5. Back on the list view, toggle the domain **on** — the tab opens in background
6. Open a page that has been granted access, reload it (hard refresh: `Cmd+Shift+R`)
7. the in-page agent now has your tool in `window.__ext_mcp_tools` and can call it

---

## Export / Import

Both live in the settings page, **Domains & Tools** tab (left column, bottom).

### Export

Click **⬇ Export**. Downloads `tabbridge-config-<timestamp>.json` containing all your domains and tools (enabled or disabled).

Use this to:
- Back up your config before making changes
- Share a set of tools with a teammate

### Import

Click **⬆ Import**, select a `.json` file previously exported from this plugin.

The import is **validated** (types, absolute http(s) URLs, no prototype keys), **previewed** in a confirm dialog, and applied atomically with a **merge** strategy:
- Domains that don't exist yet → added
- Tools that don't exist in an existing domain → added
- Existing domains and tools → **never overwritten** (your local edits are preserved)
- **Everything imported arrives disabled with "Require confirmation" on** — nothing from a shared file can reach an agent before you review and enable it.

---

## Example domain

TabBridge ships with **no domains or tools**. To try it, import [`examples/sample-domain.json`](examples/sample-domain.json) (Settings → Domains & Tools → ⬆ Import). It contains one domain with two tools; like every import they arrive **disabled with confirmation on** — review the scripts, enable what you want, then create a profile that includes them.

---

## How the in-page agent picks up the tools

The extension writes to `window.__ext_mcp_tools` on the granted page — the in-page agent reads this automatically.

When you enable/disable a domain or edit a tool in the popup, the change propagates **live** without a page refresh (the extension listens for storage changes and re-pushes the tool list via a `tabbridge:tools:update` event).

If you reload the extension, **hard-refresh** the granted page (`Cmd+Shift+R`) to reconnect the content scripts.

---


## ToolBridge — let an agent build tools

A built-in, read-only domain **🔒 ToolBridge** appears in Domains & Tools. Its tools have no script; the extension handles them natively:

| Tool | Does |
|---|---|
| `list_domains` | Domains with base URL, enabled state and tool names/descriptions. Never returns scripts. |
| `list_profiles` | Profiles and what each exposes. |
| `add_tool` | Creates a tool in a domain (creates the domain too when given `baseUrl` + `startUrl`), optionally enabling it in a profile in the same step. |
| `update_tool` | Edits an existing tool (description, schema, script, rename). Fields left out stay as they are. For fixing a tool after the target site changed. |
| `enable_tool_in_profile` | Adds an existing tool to a profile. |

That is the whole surface: no delete, no moving tools between domains, no enabled/confirmation flag changes, no page access, no connectors, no profile creation.

**Guard rails**
- **ToolBridge is granted per caller, not per profile.** A profile is only a collection of page tools. Each connector script row and each page-access row in **Web MCP** has its own **🔒 ToolBridge** switch (off by default, asks for confirmation). Switching it on exposes the five ToolBridge tools to **that connector or that page origin only, for 2 hours**; then the switch turns itself off and the tools stop resolving. **Renew 2 h** restarts the window. Other connectors and pages using the same profile are unaffected, and a connector can never grow its own permissions.
- An agent that still has the ToolBridge tools cached from an earlier `tools/list` gets a clear **NOT AUTHORIZED** reply instead of "unknown tool": it names the connector (or page origin) and tells the agent exactly what the user must do (Settings → Web MCP → find the row → switch on 🔒 ToolBridge, lasts 2 hours, restart the MCP connection if the tools are missing from the list).
- A page origin without its switch on never sees the ToolBridge tools through `window.__ext_mcp_tools`; a page that calls one anyway is told so.
- Successful `add_tool` / `enable_tool_in_profile` replies carry an **IMPORTANT — tell the user** note: the tool is saved but will not show up in the agent's tool list until the MCP connection is restarted (the bash relay cannot push `tools/list_changed`). Every later addition needs another restart.
- Every `add_tool` / `enable_tool_in_profile` shows an **approval window** naming the connector, domain, tool, description, profile and the full script. New tools arrive **enabled**, so the window also states **who can call it right away**: every profile that selects it (a whole-domain `*` selection counts) and the live connectors / page origins bound to those profiles. Deny or 40 s timeout = refused. Invalid calls are rejected before any prompt.
- `update_tool` shows the **complete new script**, the origins it can run on and **who can call it right away** (an edited script goes live at once for every profile, connector and page that already has the tool); a rename also rewrites profile selections so nothing silently drops out. Edited tools are tagged **edited by `<connector>`**.
- All three mutating tools **re-read storage after you click Allow** and apply only their own change, so a toggle you flipped while the window was open is never undone.
- Agent-created tools are tagged **added by `<connector>`** in Domains & Tools, arrive enabled with confirmation off (you approved the creation), and can be tightened or deleted there like any other tool. The domain name `ToolBridge` is reserved and cannot be created, renamed or imported.

Typical prompt: *"Open https://logs.example.com and build me a `searchLogs(query, from, to)` tool that calls its search API with my session; enable it in the Analyst profile."* The agent calls `list_domains`, then `add_tool` with the script it wrote, you click **Allow**, and the tool is callable through the Analyst connector immediately.

---

## Web MCP — use the tools from Claude Code (or any MCP client)

Besides feeding an agent embedded in a web page, the plugin can expose the same tools to an **external** MCP client such as Claude Code, Claude Desktop or Cursor, so you can ask an agent to pull data through your browser session and build a report.

### For plugin users — three steps

1. **Profiles** tab: create a profile and tick the tools an agent may use.
2. **Web MCP** tab: turn on **Expose tools via Web MCP**, choose the profile and a lifetime (1–7 days), click **⬇ Download connector script**. The connector appears in the list as `<profile>-<id>`.
3. Run the script once:
   ```bash
   bash ~/Downloads/tabbridge-connector-<profile>-<id>.sh
   ```
   It installs itself into `~/.tabbridge/bin/` (plain copy + `chmod 700`; no quarantine stripping), registers that copy with Chrome and prints a ready-to-paste block (stdout only, so `| pbcopy` works). The config points at the installed copy, never at `~/Downloads` — macOS blocks other apps from reading Downloads/Desktop/Documents ("Operation not permitted"), so the downloaded file can be deleted afterwards.
   ```json
   {
     "mcpServers": {
       "tabbridge-logs-analyst-3f9a1c": {
         "command": "bash",
         "args": ["/Users/you/.tabbridge/bin/tabbridge-connector-logs-analyst-3f9a1c.sh", "--stdio"],
         "env": {}
       }
     }
   }
   ```
   Paste it into the agent's MCP config. The key is unique per connector, so several connectors (and profiles) can live in one agent.

**Requirements: bash + coreutils (macOS / Linux). Nothing to install.** No Node, no Python, no repo checkout.

### Connectors

Every download is its own **connector** with its own token, profile and lifetime. The Web MCP tab lists them with profile, tool count, expiry, request count and last-seen time.

- **Plain http:// page origins** are refused by default (anyone on the network path can inject script into an http page and inherit its tools). The **Allow plain http:// page origins** switch under Page access (off by default, confirm on enable, warning shown while on) lets you grant them; switching it off again ignores existing http grants immediately. `localhost` is always allowed.
- **Rate limit** (calls per minute per caller — connector label or page origin — default 60, 0 = unlimited) and **Recent agent activity** (audit log) live on the same tab.
- **Validity is decided by the plugin, not the file.** The script asks at start (and the plugin re-checks every call). Expired or deactivated → the script prints the reason and exits 5; a running agent gets JSON-RPC `-32001`. **Extend / Reactivate** (pick 1–7 days) makes the *same* script valid again — no new download, no agent config change.
- **Deactivate (✕)** refuses the script immediately, even mid-batch (reversible), and switches its ToolBridge grant off. **Extend / Reactivate** also start without a ToolBridge grant — switch it on again if needed. **Delete (🗑)** forgets the connector for good — nothing is ever removed automatically; expired ones stay listed until you delete them.
- The download dialog proposes a file name (`tabbridge-connector-<profile>-<id>.sh`) you can edit; the name becomes the connector's label and its MCP key `tabbridge-<label>`.
- Only tools in the connector's profile are returned by `tools/list` and accepted by `tools/call`; the profile is re-read on every call, so edits apply live.
- **🔒 ToolBridge** switch per row: lets *this* connector create/edit tools for 2 hours (confirm on enable, Renew 2 h, auto-off; disabled for expired or deactivated connectors). See *ToolBridge* above.
- `tabbridge_status` reports the connector label, profile and expiry.

### Page access (in-page agent)

The in-page tool list is **off by default for every site**. Add `origin → profile` grants in the Web MCP tab (e.g. `https://app.example.com → Default`). Only pages at a granted origin receive tools (metadata only, never scripts), only that profile's tools, and the service worker re-authorises every call against `sender.url` — a value set by Chrome that a page cannot spoof. Remove a grant with ✕.

### How it works

The script is pure bash and the **extension is the MCP server**. The script only moves bytes:

```
agent ──MCP stdio──▶ connector.sh --stdio (relay)
                        │ writes ~/.tabbridge/spool/<id>.req
                        ▼
                     connector.sh (native host — Chrome launches this same file)
                        │ Chrome Native Messaging (4-byte length + JSON)
                        ▼
                     extension service worker: native-bridge.ts → mcp-server.ts → executeTool → domain tab
                        │ reply → spool/<id>.res → relay → agent stdout
```

- Running the script with no args writes a Native Messaging host manifest (`com.tabbridge.connector.json`) into every Chromium-family profile dir it finds (Chrome, Beta, Canary, Chromium, Brave, Edge, Vivaldi, Arc) with `allowed_origins` = this extension's id, and `chmod 700`s itself. `--uninstall` removes them.
- When "Expose tools" is on, the service worker calls `chrome.runtime.connectNative()`; Chrome spawns the script as the host. The host pings every ~20 s (keeps the MV3 worker alive) and exits when Chrome closes the port.
- `mcp-server.ts` answers `initialize`, `ping`, `tools/list`, `tools/call` (+ empty `resources/list` / `prompts/list`). Tool names are `<domain>__<tool>`; `tabbridge_status` is always present.
- Latency per call ≈ 100–200 ms of polling on top of the tool itself. Requests from one agent are served sequentially.

**Token rules**
- Each connector's token is baked into its script and never shown. The extension looks the token up per request: unknown / deactivated / expired → refused with a human-readable reason (the bash relay prints it and exits 5; agents see `-32001`).
- Lifetime is chosen at download (1–7 days) and extended any time from the Web MCP tab; only the plugin decides validity.
- Script exit codes: `5` = refused by the plugin (deactivated / unknown / stale), `6` = launched by a different extension. Unanswered requests return `-32000` after 90 s (`TABBRIDGE_TIMEOUT_S` overrides).
- `--stdio` registers the script as the native host only when no working registration exists; the explicit no-arg run always re-registers.

Not supported: Windows (no bash), HTTP transport, server-initiated `tools/list_changed` notifications.

### Security model (what is enforced where)

| Threat | Control |
|---|---|
| Any website calling tools / reading scripts | Pages get tools only via a **page-access grant** for their exact origin (decided from `sender.url`, set by Chrome). Pages receive metadata only, never scripts. Every call is re-authorised against the grant's profile. |
| Attacker page posing as a domain tab (`logs.example.com.evil`) | **Only tabs TabBridge opened itself** are ever used to run tools — a tab another site opened on the domain origin (`window.open`) is never adopted, so an outside page cannot pre-load a page in it or close it (a popup the domain page itself opens without `noopener` could still navigate it, which is why origin and path are re-checked right before every injection). Tabs are matched by **exact origin** (opaque origins never match), re-checked before execution (origin and, for page-bound tools, the path), and the injected code itself starts with an unforgeable `location.origin` guard, so a navigation between check and run throws instead of executing elsewhere. Args are a JSON literal. A start URL that redirects elsewhere (login) is closed, not retried. Where the browser supports tab groups, TabBridge's tabs are collected in a **TabBridge** tab group so you can see which tabs belong to agents. |
| Over-eager agent | Per-tool **Require confirmation** → approval window (Allow / Deny with the full arguments shown, auto-deny after 40 s), shown only after the args passed validation. **Rate limit** per caller (connector label or page origin) per minute. **Audit log** of every agent call *and every denial* (Web MCP tab, last 500). Tool **arguments are validated** against the schema with own-property checks (required, types, enum, no extras when `additionalProperties:false`, no `__proto__`/inherited names). Batches capped at 10 and run sequentially. Denied calls from pages **without any grant are not logged** (any site can post a tool call; logging them would let it flood the audit ring), failed calls from granted callers are **capped at 5 audit rows per caller per minute** (the rest are counted and noted on the next row), successful calls are always logged, and every audit field is length-bounded. The settings page's own Run is trusted through an explicit flag, never through its caller name; `settings` and `page` are reserved connector labels. |
| Stolen `chrome.storage` / compromised renderer | `storage.local` is **TRUSTED_CONTEXTS only** — content scripts (which run on every site) cannot read scripts or write grants; the worker pushes a data-less `TOOLS_CHANGED` ping to granted tabs instead. Connector tokens are stored only as **SHA-256 hashes**; usage stats live under their own key so bookkeeping can never undo a Deactivate. |
| Local processes / stale files | Script runs with `umask 077`; spool dir is `0700`; uncollected replies and requests are pruned after 2 minutes; a killed relay removes its own pending request; every envelope carries a timestamp and the extension refuses ones older than 120 s; the native host serves only `chrome-extension://<this id>/`; `--stdio` re-registers only when the registered host is missing, expired or a different version. |
| Malicious import file | Import is **validated**, **previewed**, **confirmed**, applied atomically, and **quarantined** (disabled + confirmation on). The popup cannot edit anything any more; the settings page validates URLs on save. Storage write failures are surfaced, never swallowed. |
| Sync leakage / 8 KB quota | All config lives in `chrome.storage.local`; nothing is ever written to `storage.sync`. |

Residual (documented, not fixed): the native host process is a trust anchor — whoever controls the registered script path can see tool results; tools run in the MAIN world, so a compromised *legitimate* domain page could interfere with its own tools; the token travels in each spool request file (0700 dir, pruned); a malformed or >1 MB line from a local agent can make Chrome drop the shared native port (reconnects automatically). **Profiles separate agents only when the agent cannot read this user's files**: connector tokens live in `~/.tabbridge/bin/*.sh` and in the spool, so an agent with shell access as you (Claude Code, Cursor, …) can run any other connector you downloaded, including one whose ToolBridge window is open. Give such agents the profile you would give yourself.

### Troubleshooting (Web MCP)

| Symptom | Fix |
|---|---|
| Status **Setup needed** | Chrome cannot find the native host manifest. Run the downloaded script once (`bash ~/Downloads/tabbridge-connector-<id>.sh`), then **Retry now**. |
| Agent log shows `/bin/bash: …/Downloads/…: Operation not permitted` | The agent config points at the copy in `~/Downloads`, which macOS privacy settings hide from other apps. Re-run the script once and use the printed path (`~/.tabbridge/bin/…`) in the agent config. |
| Status **Error** — different extension install | The manifest allows another extension id (e.g. you re-loaded the unpacked extension from a new folder). Download a new script and run it once. |
| Script prints *Sorry — connector … deactivated* (exit 5) / agent gets `-32001` | The connector was deactivated (→ **Reactivate**) or deleted (→ download a new one) in the Web MCP tab. |
| Agent lists fewer tools than expected | Check the connector's profile in the Profiles tab; tools disabled in Domains & Tools are never exposed. |
| The in-page agent shows no tools on the granted page | Add the page origin under Web MCP → Page access with a profile. |
| Agent gets `-32000 … did not answer` | **Expose tools via Web MCP** is off, or the host is not registered. Check the settings page. |
| Script prints *expired* (exit 5) / agent gets `-32001 … expired` | Lifetime elapsed. Web MCP → Connectors → **Extend** — the same script works again, nothing to re-download or reconfigure. |
| Tool call errors with *Allow user scripts* | Same requirement as the in-page agent — enable it in `chrome://extensions` → Details. |

---

## Troubleshooting

### Tools not appearing in the in-page agent / `window.__ext_mcp_tools` is empty
- Open the popup → make sure the domain is **enabled** (toggle on)
- Make sure the individual tools inside are enabled
- Hard-refresh the granted page after enabling

### `chrome.userScripts` is undefined / tool call fails immediately
- Go to `chrome://extensions` → extension Details → enable **Allow user scripts**
- Reload the extension, then hard-refresh the granted page

### Tool returns a 400 error
- The server requires headers your fetch isn't sending
- Add `'x-requested-with': 'UI'` and `'x-zcsrf-token': <value from page global>` to your fetch headers
- Check the actual request in the domain tab's Network panel to see which headers the page sends

### A new tab opens every time a tool is called

TabBridge reuses only tabs it opened itself. A tab you opened by hand on the same site is never used (that is deliberate: a tab a web page opened could be steered). Let the extension open its own tab once; it stays in the **TabBridge** tab group and is reused.

#### Other causes
- Reload the extension after enabling a domain in the popup for the first time
- The session tab mapping is set when the domain tab loads — a reload ensures it's registered

### "Extension context invalidated" error in console
- The extension was reloaded but the granted page was not
- Hard-refresh the granted page (`Cmd+Shift+R`)

### Tool script returns `null`
- Make sure your script has a `return` statement
- Make sure any async operation is `await`-ed before returning

---

## Project structure (for developers)

```
tabbridge/
├── public/
│   ├── manifest.json          # MV3 manifest — permissions, content scripts
│   └── popup/popup.html       # Popup UI shell
├── src/
│   ├── background/
│   │   └── service-worker.ts  # Orchestrator — storage lock-down, origin-checked domain tabs, arg validation, rate limit, confirmation, audit
│   ├── content/
│   │   ├── bridge.ts          # ISOLATED world — asks SW which tools THIS origin may use, relays calls
│   │   └── page-injected.ts   # MAIN world — builds window.__ext_mcp_tools from metadata (no scripts)
│   ├── data/
│   │   └── domains.ts         # MAIN world dispatch — postMessage bridge
│   ├── background/native-bridge.ts # Web MCP: Chrome Native Messaging port to the connector script
│   ├── background/mcp-server.ts    # Dependency-free MCP (JSON-RPC) server; the extension IS the server
│   ├── options/               # Settings page: options.ts (tabs) · domains_view.ts · profiles_view.ts · mcp_panel.ts (connectors + page access)
│   │                          #   connector.template.sh (pure-bash relay + native host) · connector_script.ts (fills it)
│   ├── ui/theme.css           # Design tokens + shared primitives (night theme) for popup, settings and approval window
│   ├── popup/
│   │   ├── popup.ts           # Read-only overview: tools this page can use · tools it provides · footer status
│   │   └── popup.css
│   ├── types/
│   │   └── plugin.types.ts    # StoredDomain, StoredTool, PluginStorage
│   └── utils/
│       ├── message.ts         # All message type contracts
│       ├── mcp.ts             # toMcpToolName, native-messaging envelope types
│       ├── builtin.ts         # The virtual ToolBridge domain + its tool definitions
│       ├── profiles.ts        # PURE exposure logic: resolveProfileTools / isToolAllowed / lookupConnector / validateArgs / RateLimiter
│       ├── import_export.ts   # Validated, quarantined, previewed config import; export
│       └── storage.ts         # loadDomains/saveDomains — single accessor for chrome.storage.local (domains, profiles, bridge config, stats, audit)
├── scripts/
│   └── build.mjs              # Builds 6 IIFE bundles into dist/
└── dist/                      # Load this folder in Chrome
```

