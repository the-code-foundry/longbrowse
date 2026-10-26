# longbrowse

A persistent browser for AI agents: one container with Chromium (Playwright), an MCP server
(streamable HTTP), a REST API, a live noVNC view, and hot-reloaded site plugins.

The idea: your agent keeps long-lived, logged-in browser sessions (web chat apps, webmail,
Jira, Confluence — any site that allows automation), and site-specific logic lives in small
plugin folders you can edit while the server runs.
Each plugin gets its own browser profile — logins never bleed between sites — and registers its
own MCP tools next to the generic browser tools.

## Features

- **MCP server, no wrapper** — streamable HTTP on `/mcp`, written directly against the MCP SDK.
  Generic tools: `navigate`, `snapshot` (accessibility tree with query/depth/interactive
  filters), `click`, `type`, `press`, `screenshot` / `screenshot_box` / `screenshot_element`,
  `upload`, `download`, `tabs`, `cookies`, `proxy`, `events_tail`, `egress`.
- **Plugins, hot-reloaded** — a plugin is a folder with `manifest.json` + `tools.js`; drop it in
  `plugins/`, tools appear (`tools/list_changed`); edit a file, it reloads. No build step, no
  node_modules per plugin. See [help/plugins.md](help/plugins.md).
- **One profile per plugin** — `launchPersistentContext` per profile dir; sessions survive
  restarts via a docker volume.
- **Live view** — headful Chromium on Xvnc, watchable (and drivable) from a browser via noVNC.
  Optional `VNC_PASSWORD`, kiosk mode, configurable screen size. `HEADLESS=1` to skip it.
- **REST API** — every MCP tool also at `POST /api/tool/<name>`, plus a status page and
  per-plugin HTTP routes and UI pages. Bearer auth via `API_TOKEN`; MCP auth via `MCP_TOKEN`.
- **Event store and disk queues** — per-plugin append-only events (SQLite, pruned, cursorable
  with `events_tail`) and a crash-safe disk queue, so agents can poll or be webhooked instead of
  holding a connection.
- **Egress control** — optional per-profile SOCKS5 layer inside the process: every browser
  connection is checked against a per-profile allowlist (`EGRESS=log` or `enforce`), with denied
  hosts logged as events. A plugin manifest can declare its `domains`.
- **Human pacing & watchdog** — per-profile action pacing on a slow random wave (for sites that
  frown on robots), and a watchdog that relaunches a crashed profile browser.

## Quick start

```sh
docker compose up -d
# MCP endpoint:   http://127.0.0.1:41931/mcp
# live view:      http://127.0.0.1:41932/vnc.html
# REST + status:  http://127.0.0.1:41933/
bash tests/run.sh   # unit tests always; integration tests where Chromium exists (or in the image)
```

Everything binds loopback by default. The MCP endpoint, the VNC view and the REST API are all
full control of every logged-in site — set `MCP_TOKEN`, `API_TOKEN` and `VNC_PASSWORD` before
exposing any port beyond localhost.

## Writing a plugin

```
plugins/hello/
  manifest.json    {"name": "hello", "profile": "hello", "start_url": "https://example.com"}
  tools.js         export async function register(api) {
                     api.tools.add('shout', {description: 'read the h1'}, async () => {
                       const page = await api.page();
                       return await page.locator('h1').innerText();
                     });
                   }
```

That registers the MCP tool `hello_shout`. The `api` object also gives you `z` (zod schemas),
`events`, `queue`, `settings`, `notifications` (captured Web Notifications), `http.route`,
`ui.page`, `human` (paced delays), `egress`, and `selectors.json` support so a site redesign is a
one-file fix. Full contract: [help/plugins.md](help/plugins.md) and [docs/index.md](docs/index.md).

Plugins are trusted, in-process code. Containment is the container boundary and the egress
layer, not the loader.

## Configuration

All knobs are environment variables (see `docker-compose.yml` and `core/config.js`):
`HEADLESS`, `KIOSK`, `SCREEN`, `MAX_TABS`, `STICKY_TAB`, `MCP_TOKEN`, `API_TOKEN`,
`TOOL_PREFIX` (namespace all tool names, for several containers behind one MCP aggregator),
`VNC_PASSWORD`, `EGRESS` (`off|log|enforce`), `WATCHDOG`, `EVENTS_KEEP`, `HUMAN_BASE_APM`,
`HUMAN_CAP_APM`, `API_PLUGIN_EDITING_ALLOWED`, `MCP_PLUGIN_EDITING_ALLOWED`.

## Docs

- [docs/index.md](docs/index.md) — how the core works, file by file
- [help/plugins.md](help/plugins.md) — the plugin contract
- [help/api.md](help/api.md) — the REST API
- `help` MCP tool — the same pages, queryable by the agent at run time

## License

[MIT](LICENSE)
