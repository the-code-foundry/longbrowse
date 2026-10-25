# longbrowse core — implementation

One Node process inside one container: Chromium (Playwright, launched in-process), an MCP server
(streamable HTTP), a plugin loader. No CDP port; `/mcp` on `PORT` (default 8931) is the only
listener.

## Files

| file | what |
|---|---|
| `core/server.js` | HTTP endpoint `/mcp`; one `McpServer` per MCP session; sessions tracked by `mcp-session-id` |
| `core/snapfilter.js` | snapshot post-filters (query/depth/interactive) and screenshot box math — pure functions |
| `core/registry.js` | central tool table; live sessions attach to it; add/remove after connect emits `tools/list_changed` |
| `core/tools.js` | generic tools: `navigate`, `snapshot` (filters: `query`, `query_role`, `max_depth`, `child_depth`, `interactive`, `max_lines`), `click`, `type`, `press`, `screenshot`, `screenshot_box` (corners `x1,y1,x2,y2` or centered `x,y,width,height`, clamped), `screenshot_element` (selector + padding), `upload`, `download`, `tabs`, `events_tail` |
| `core/contexts.js` | one `launchPersistentContext` per profile under `PROFILES_DIR/<name>` |
| `core/loader.js` | scans `PLUGINS_DIR`, imports `tools.js`/`watch.js` per plugin, hot-reloads on file change (ESM cache-bust query) |
| `core/events.js` | append-only JSONL per plugin under `DATA_DIR/events/` |
| `core/queue.js` | disk queue, one JSON file per item under `DATA_DIR/queue/<plugin>/` |
| `core/notifications.js` | Web Notification capture: permission granted + `window.Notification` shim in every context; in-memory store (cap 1000) behind the `notifications` tool; plugins get `api.notifications.list/dismiss/on` scoped to their profile |
| `core/config.js` | env knobs: `PORT`, `HOST`, `PLUGINS_DIR`, `DATA_DIR`, `PROFILES_DIR`, `HEADLESS`, `KIOSK`, `SCREEN`, `MAX_TABS` (default 3), `STICKY_TAB` (default 1: tab 0 not closable) |

Tabs: `tabs new` refuses past `MAX_TABS`; a tab the site opens beyond the limit is auto-closed
and logged as a `popup_closed` event. Manifest `max_tabs`/`sticky_tab` override per plugin.

## Plugin contract

A plugin is a folder in `PLUGINS_DIR` (mounted volume):

- `manifest.json` — `{"name", "profile"?, "start_url"?, "autostart"?, "max_tabs"?, "sticky_tab"?}`;
  `name` must match `^[a-z0-9_-]+$`. `autostart: true` opens `start_url` at load.
- `tools.js` — `export async function register(api)`; add tools via `api.tools.add(short, {description, inputSchema}, handler)`; the tool's public name is `<plugin>_<short>`.
- `watch.js` (optional) — `export async function watch(api)`; long-running observer, stop on `api.signal` abort (fires at unload/reload).
- `selectors.json` (optional) — every DOM selector in one file, passed as `api.selectors`.
- `config.ini` (optional) — flat `key = value` machine values, passed as `api.config`; never committed.

`api` also carries: `z` (zod — plugins have no node_modules of their own), `page()`, `context()`,
`open()` (navigate the profile to `start_url` if not there), `events.append/tail`, `queue`
(disk queue under `DATA_DIR/queue/<plugin>/`: `push`, `take`, `peek`, `list`), `onToolCall(fn)`
(observe every tool call `{tool, args, error?}`, auto-unsubscribed at unload), `manifest`,
`selectors`, `config`, `signal`, `log`. Outbound HTTP: plugins run in-process, global `fetch`
works — the container egress firewall is the boundary.

Plugins are trusted in-process code with full browser access. Containment is at the container
boundary (egress firewall), not in the loader. Tool handlers and watchers are try/catch-wrapped —
a throwing plugin cannot take the server down; a plugin that blocks the event loop can. If that
ever happens in practice, the evolution path is: Chromium exposes CDP **inside the container
only**, each plugin moves to its own subprocess connecting via `chromium.connectOverCDP`, and the
api object stays identical — plugins never import playwright, so they do not change.

## Run

```
docker compose up -d      # MCP: 127.0.0.1:${LONGBROWSE_PORT:-41931} -> 8931
                          # live view: http://127.0.0.1:${LONGBROWSE_VNC_PORT:-41932}/vnc.html
bash tests/run.sh         # unit always; integration where Playwright Chromium exists
```

Headful by default on an Xvnc display, viewable in any browser through noVNC (the VNC session is
full control of every logged-in site — keep the port loopback-only, tunnel over SSH for remote
viewing). `HEADLESS=1` skips the display entirely; `KIOSK=1` launches Chromium with `--kiosk`
(fullscreen, no browser chrome — fits the one-site-per-profile model; with several plugins on the
one display their windows stack). `SCREEN=WxH` sets the display size.

## MCP transport

Streamable HTTP: `POST /mcp` `initialize` → `mcp-session-id` response header → client sends
`notifications/initialized` → `tools/list`, `tools/call` with the header. Responses may be plain
JSON or SSE (`data:` lines). `GET /mcp` with the header opens the server-notification stream
(`tools/list_changed` arrives there).
