# REST API (separate port from MCP)

Default container port 8932 (host: LONGBROWSE_API_PORT, default 41933). When the env `API_TOKEN`
is set, every request needs `Authorization: Bearer <token>`; unset = open.

- `GET /` — status page (HTML); `GET /status.json` — same as JSON: uptime, tools, plugins,
  profiles with their tabs, routes, help pages, MCP session count.
- `POST /api/tool/<name>` — call ANY MCP tool, body = the tool's arguments as JSON, response =
  the MCP result (`{content: [...], isError?}`). Example:
  `curl -X POST :41933/api/tool/snapshot -d '{"profile":"mail","max_lines":20}'`
- `POST /api/<plugin>/<route>` — endpoints a plugin registered with `api.http.route`.
- Plugin editing, only when `API_PLUGIN_EDITING_ALLOWED=1`:
  - `GET /api/plugins` — all plugins and files
  - `GET /api/plugins/<p>/<file>` — `{content}`
  - `PUT /api/plugins/<p>/<file>` body `{content}` — write (hot-reload applies it)
  - `DELETE /api/plugins/<p>[/<file>]`

Equivalent MCP tools `plugin_list/read/write/delete` exist when `MCP_PLUGIN_EDITING_ALLOWED=1`.
Writing a plugin is code execution inside the container — leave both gates off unless needed.
