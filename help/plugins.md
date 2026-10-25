# Writing a plugin

A plugin is a folder mounted at /plugins/<name>/ — hot-reloaded on any file change:

- `manifest.json` — `{"name", "profile"?, "start_url"?, "autostart"?, "max_tabs"?, "sticky_tab"?}`
- `tools.js` — `export async function register(api)`; `api.tools.add(short, {description,
  inputSchema}, handler)` registers MCP tool `<name>_<short>`
- `watch.js` (optional) — `export async function watch(api)`; background observer, stop on
  `api.signal`
- `selectors.json` (optional) — every DOM selector in one file → `api.selectors`
- `config.ini` (optional) — flat machine values → `api.config`

The api object: `z` (zod), `page()`, `context()`, `open()` (go to start_url if elsewhere),
`events.append/tail`, `queue` (push/take/peek/list), `settings` (per-key `get(key, fallback?)`,
`set`, `delete`, `all` on the plugin's own `plugin-settings.json`; `settings.named("x")` → the
plugin's `settings.x.json`; `settings.global("x"?)` → `settings.x.json` shared at the plugins
root, default name `global` — none of these writes trigger a reload; gitignore them in plugin
repos, they are runtime state), `notifications.list/dismiss/on`,
`onToolCall(fn)`, `help.add(relpath, text)` (publish a help page as `<plugin>/<relpath>`),
`http.route(method, path, handler)` (REST endpoint `/api/<plugin>/<path>`),
`ui.page(path, handler)` (HTML page at `/ui/<plugin>/<path>` on the API port; handler returns an
HTML string; `/ui` lists all pages and `/` redirects there once any page exists),
`human.ms()/delay()/rate()` (wave-paced delays for visible actions, per profile),
`egress.allow(hosts)/list()` (the profile's egress allowlist; a manifest `domains: [...]` array
is allowed automatically at load), `manifest`, `log`.
Plugins import nothing from node_modules; node builtins (`node:fs`, `node:sqlite`, ...) and
global `fetch` are fine.

Keep every selector in selectors.json: a site redesign is then a one-file fix.
