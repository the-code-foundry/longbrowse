// Longbrowse core: streamable-HTTP MCP server + Chromium (Playwright, in-process)
// + plugin loader. One McpServer per MCP session, all fed from one ToolRegistry so
// plugin hot-reloads reach every live session as tools/list_changed.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { cfg } from './config.js';
import { ToolRegistry } from './registry.js';
import { Contexts } from './contexts.js';
import { EventStore } from './events.js';
import { registerGenericTools } from './tools.js';
import { Loader } from './loader.js';
import { HelpStore } from './help.js';
import { ApiServer } from './api.js';
import { PluginFs } from './pluginfs.js';
import { NotificationStore } from './notifications.js';
import { ProxyStore } from './proxies.js';
import { Egress } from './egress.js';
import { Human } from './human.js';
import { z } from 'zod';
import { join } from 'node:path';

const started = Date.now();
const registry = new ToolRegistry();
const notifications = new NotificationStore();
const proxies = new ProxyStore(join(cfg.dataDir, 'proxies.json'));
const events = new EventStore(join(cfg.dataDir, 'events'), { keep: cfg.eventsKeep });
const egress = new Egress({ mode: cfg.egressMode, file: join(cfg.dataDir, 'egress.json'), events });
const human = new Human({ baseApm: cfg.humanBaseApm, capApm: cfg.humanCapApm });
const contexts = new Contexts({ ...cfg, notifications, proxies, egress }); // cfg carries maxTabs/stickyTab defaults
const help = new HelpStore(new URL('../help', import.meta.url).pathname);
registerGenericTools(registry, contexts, events, cfg, help, notifications, proxies, egress);
const pluginFs = new PluginFs(cfg.pluginsDir);
const api = cfg.apiEnabled ? new ApiServer({
  token: cfg.apiToken,
  callTool: (name, args) => registry.call(name, args),
  pluginFs,
  pluginEditing: cfg.apiPluginEditing,
  defaultRedirect: cfg.defaultRedirect,
  status: () => ({
    uptime_s: Math.round((Date.now() - started) / 1000),
    tools: [...registry.tools.keys()],
    plugins: [...loader.plugins.entries()].map(([n, s]) => ({ name: n, tools: s.toolNames })),
    profiles: [...contexts.contexts.entries()].map(([n, c]) => ({ name: n, tabs: c.pages().map((p) => p.url()) })),
    routes: [...api.routes.keys()],
    help: help.list(),
    mcp_sessions: transports.size,
  }),
}) : null;
const loader = new Loader({ pluginsDir: cfg.pluginsDir, registry, contexts, events, help, api, notifications, human, egress, dataDir: cfg.dataDir });

// Plugin editing over MCP, gated: writing a plugin is code execution in here.
if (cfg.mcpPluginEditing) {
  const text = (s) => ({ content: [{ type: 'text', text: s }] });
  registry.add('plugin_list', {
    description: 'List plugin folders and their files.', inputSchema: {},
  }, async () => text(JSON.stringify(pluginFs.list(), null, 2)));
  registry.add('plugin_read', {
    description: 'Read a file of a plugin.',
    inputSchema: { plugin: z.string(), file: z.string() },
  }, async (a) => text(pluginFs.read(a.plugin, a.file)));
  registry.add('plugin_write', {
    description: 'Write a plugin file (creates the plugin folder if new). The loader hot-reloads it.',
    inputSchema: { plugin: z.string(), file: z.string(), content: z.string() },
  }, async (a) => text(pluginFs.write(a.plugin, a.file, a.content)));
  registry.add('plugin_delete', {
    description: 'Delete a plugin file, or the whole plugin when file is omitted.',
    inputSchema: { plugin: z.string(), file: z.string().optional() },
  }, async (a) => { pluginFs.remove(a.plugin, a.file); return text('deleted'); });
}

await loader.loadAll();
loader.watch();
if (cfg.watchdog) loader.watchdog();

const transports = new Map(); // session id -> transport

async function newSession() {
  const server = new McpServer({ name: 'longbrowse', version: '0.1.0' });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sid) => transports.set(sid, transport),
  });
  transport.onclose = () => {
    if (transport.sessionId) transports.delete(transport.sessionId);
    registry.detach(server);
  };
  registry.attach(server);
  await server.connect(transport);
  return transport;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 10e6) reject(new Error('body too large')); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const http = createServer(async (req, res) => {
  try {
    if (req.url !== '/mcp' && req.url !== '/') {
      res.writeHead(404).end();
      return;
    }
    if (cfg.mcpToken && req.headers.authorization !== `Bearer ${cfg.mcpToken}`) {
      res.writeHead(401, { 'content-type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'unauthorized' }, id: null }));
      return;
    }
    const body = req.method === 'POST' ? JSON.parse(await readBody(req) || 'null') : undefined;
    const sid = req.headers['mcp-session-id'];
    let transport = sid && transports.get(sid);
    if (!transport) {
      if (req.method === 'POST' && isInitializeRequest(body)) transport = await newSession();
      else {
        res.writeHead(400, { 'content-type': 'application/json' })
          .end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'no session; initialize first' }, id: null }));
        return;
      }
    }
    await transport.handleRequest(req, res, body);
  } catch (e) {
    console.error('request failed:', e);
    if (!res.headersSent) res.writeHead(500).end(JSON.stringify({ error: e.message }));
  }
});

http.listen(cfg.port, cfg.host, () => {
  console.error(`longbrowse: MCP on http://${cfg.host}:${cfg.port}/mcp, ` +
    `plugins=${cfg.pluginsDir}, profiles=${cfg.profilesDir}, headless=${cfg.headless}`);
});

if (api) {
  api.listen(cfg.apiPort, cfg.host);
  console.error(`longbrowse: API on http://${cfg.host}:${cfg.apiPort}/ ` +
    (cfg.apiToken ? '(bearer token required)' : '(OPEN - no API_TOKEN set)'));
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await contexts.closeAll();
    process.exit(0);
  });
}
