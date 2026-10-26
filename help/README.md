# longbrowse — usage (for agents)

Browser automation MCP server. Chromium runs headful in this container; every tool takes an
optional `profile` (default `"default"`) — a profile is an isolated browser with its own cookies
and logins, one per site plugin (e.g. `mail`). Don't cross profiles: a site's tools belong to
its profile.

## Reading a page

1. `snapshot {profile}` — ARIA tree as YAML. On big pages ALWAYS filter:
   - `query: "text"` or `query: "/regex/"` — hits with ancestors + `child_depth` children, blocks split by `---`
   - `query_role: "button"` — by role; combine with `query`
   - `interactive: true` — only buttons/links/inputs + ancestors
   - `max_depth`, `max_lines` — caps
2. `screenshot {full_page?}`, `screenshot_box {x1,y1,x2,y2 | x,y,width,height}` (centered mode),
   `screenshot_element {selector, padding?}` — PNG saved under /data/screenshots, path returned.

The snapshot sees the whole DOM, including content scrolled out of view.

## Acting

- `navigate {url}` — returns final URL + title
- `click {selector}` / `type {selector, text, submit?}` / `press {key}` — selectors are CSS or
  Playwright (`text=`, `role=`); targets are auto-scrolled into view
- `upload {selector, path}` / `download {selector}` — files live under /data
- `tabs {action: list|new|close|select, index?, url?}` — capped by MAX_TABS; tab 0 is sticky
  (not closable) by default; site-opened tabs over the cap are auto-closed and logged

## Events and queues

- `events_tail {plugin, since?, limit?}` — what a plugin's watcher recorded (incoming messages,
  closed popups...). Every row has a `seq`; poll with `since` = last seen `seq`.
- `notifications {action: list|dismiss|count, profile?, since?, seq?}` — Web Notifications the
  sites fired (new-message alerts): every context has notification permission and a shim that
  captures them. `list` with `since` = last seen seq; `dismiss` one `seq` or all matching.
- Plugins may keep disk queues under /data/queue/<plugin>/ — their own tools expose them.

## Cookies and proxy

- `cookies {action: list|set|delete, profile, domain?, url?, name?, cookies?}` — list filters by
  domain substring or url; set takes an array of cookie objects (same name+domain+path
  overwrites = update); delete by domain and/or name, neither = clear all.
- `proxy {action: get|list|set|clear, profile, server?, bypass?, username?, password?}` —
  per-profile, persisted. Chromium reads proxy at launch, so set/clear closes that profile's
  browser; the next tool call relaunches it with the new proxy (tabs are reset).
- `egress {action: list|allow|remove, profile?, hosts?, host?}` — per-profile allowlists
  (exact host, ip, or `*.suffix`). Active when the core runs with EGRESS=log (allow all,
  log misses) or EGRESS=enforce (refuse): browser traffic passes a loopback SOCKS5 check
  per profile, DNS resolves at the proxy. Misses/denials: `events_tail {plugin: "egress"}`.
  A user-set `proxy` on a profile wins; egress is skipped there.

## Guardrails and pacing

- Auth knobs (all optional envs): MCP_TOKEN (bearer on /mcp), API_TOKEN (bearer on the API
  port), VNC_PASSWORD (noVNC/VNC password, first 8 chars count). Unset = open.
- TOOL_PREFIX (default empty): prepended to every tool name (generic and plugin) — several
  longbrowse containers can register behind one MCP aggregator without collisions. REST
  `/api/tool/<name>` uses the prefixed name too.
- Watchdog (WATCHDOG=1 default): relaunches a dead browser of autostart plugins and reloads
  crashed pages; appends a `context_restarted` event to the plugin's stream.
- Human pacing: plugins can space visible actions with `api.human.ms()/delay()` — a per-profile
  wave-drifting rate (HUMAN_BASE_APM, default 8 actions/min) with jitter and backpressure above
  HUMAN_CAP_APM (default 20/min).
- Session lock (`session_lock` / `session_unlock` / `session_status`): one driver at a time.
  `session_lock {owner, ttl?}` returns a token; while locked every other caller's tool calls
  fail (help/events_tail stay open), the holder passes `_lock: <token>` in each call (stripped
  before the handler). Re-lock as the same owner extends; `session_unlock {token}` releases
  (`force: true` breaks); ttl default 900 s auto-expires.
- Stealth: Chromium is driven through rebrowser-playwright (CDP Runtime.enable leak patched) and
  launches with `--disable-blink-features=AutomationControlled` (navigator.webdriver false).
  TIMEZONE / LOCALE envs align the browser clock and language with the egress IP.
  STEALTH_PROFILES (csv of profiles, or `*`) skips the window.Notification capture shim — a
  non-native override a bot check can spot — trading notification capture for stealth.

## Help

- `help {}` — this file plus the list of every help page (disk and plugin-provided)
- `help {path: "plugins.md"}` — a specific page; plugin pages are `<plugin>/<name>.md`

## Files

See `plugins.md` for the plugin contract (writing a new site plugin).
