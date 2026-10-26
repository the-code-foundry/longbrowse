// Central place for every environment knob, so the rest of the code reads one object.
export const cfg = {
  port: parseInt(process.env.PORT ?? '8931', 10),
  host: process.env.HOST ?? '0.0.0.0', // inside the container; docker publishes on loopback
  pluginsDir: process.env.PLUGINS_DIR ?? '/plugins',
  dataDir: process.env.DATA_DIR ?? '/data',
  profilesDir: process.env.PROFILES_DIR ?? '/profiles',
  headless: process.env.HEADLESS === '1',
  maxTabs: parseInt(process.env.MAX_TABS ?? '3', 10),
  stickyTab: process.env.STICKY_TAB !== '0',
  mcpToken: process.env.MCP_TOKEN ?? '', // bearer on /mcp; empty = no auth
  toolPrefix: process.env.TOOL_PREFIX ?? '', // namespaces every tool name (e.g. 'cg_') for multi-container setups
  apiEnabled: process.env.API_ENABLED !== '0',
  apiPort: parseInt(process.env.API_PORT ?? '8932', 10),
  apiToken: process.env.API_TOKEN ?? '', // empty = no auth
  apiPluginEditing: process.env.API_PLUGIN_EDITING_ALLOWED === '1',
  defaultRedirect: process.env.DEFAULT_REDIRECT ?? '', // '/' goes here; empty = auto (/ui when pages exist)
  mcpPluginEditing: process.env.MCP_PLUGIN_EDITING_ALLOWED === '1',
  eventsKeep: parseInt(process.env.EVENTS_KEEP ?? '10000', 10), // rows kept per plugin
  egressMode: process.env.EGRESS ?? 'off', // off | log | enforce (SOCKS5 per profile)
  watchdog: process.env.WATCHDOG !== '0',
  pluginPoll: parseFloat(process.env.PLUGIN_POLL ?? '5'), // seconds between plugin-folder mtime rescans (hot-reload fallback); 0 = disabled
  pluginWatch: process.env.PLUGIN_WATCH !== '0', // 0 = no inotify watcher (rely on the poll and/or plugins_rescan)
  humanBaseApm: parseFloat(process.env.HUMAN_BASE_APM ?? '8'),
  humanCapApm: parseFloat(process.env.HUMAN_CAP_APM ?? '20'),
};
