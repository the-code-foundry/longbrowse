// Plain-HTTP side door, separate from MCP: "/" status page, "/status.json",
// "/api/<plugin>/<route>" for plugin-defined endpoints. If a token is configured,
// every request must carry "Authorization: Bearer <token>"; no token set = open.
import { createServer } from 'node:http';

export class ApiServer {
  constructor({ token, status, callTool, pluginFs, pluginEditing = false, defaultRedirect = '' }) {
    this.token = token;
    this.defaultRedirect = defaultRedirect;
    this.status = status; // () => object for the status page
    this.callTool = callTool; // async (name, args) -> MCP result
    this.pluginFs = pluginFs;
    this.pluginEditing = pluginEditing;
    this.routes = new Map(); // "METHOD <plugin>/<path>" -> handler({body, query, req, res})
    this.pages = new Map(); // "<plugin>/<path>" -> handler({query, req, res}) -> html string
  }

  route(plugin, method, path, handler) {
    const key = `${method.toUpperCase()} ${plugin}/${path.replace(/^\//, '')}`;
    this.routes.set(key, handler);
    return () => this.routes.delete(key);
  }

  page(plugin, path, handler) {
    const key = `${plugin}/${path.replace(/^\//, '')}`.replace(/\/$/, '');
    this.pages.set(key, handler);
    return () => this.pages.delete(key);
  }

  removePlugin(plugin) {
    for (const k of this.routes.keys()) if (k.split(' ')[1].startsWith(`${plugin}/`)) this.routes.delete(k);
    for (const k of this.pages.keys()) if (k.startsWith(`${plugin}/`)) this.pages.delete(k);
  }

  listen(port, host) {
    this.server = createServer((req, res) => this.#handle(req, res).catch((e) => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }));
    this.server.listen(port, host);
    return this.server;
  }

  async #handle(req, res) {
    if (this.token) {
      const got = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      if (got !== this.token) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'missing or wrong bearer token' }));
        return;
      }
    }
    const url = new URL(req.url, 'http://x');
    const json = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj, null, 2));
    };

    const html = (code, body) => {
      res.writeHead(code, { 'content-type': 'text/html' });
      res.end(body);
    };

    if (url.pathname === '/' || url.pathname === '/status.json') {
      // DEFAULT_REDIRECT overrides; else once any plugin page exists, / redirects to /ui.
      // The status page keeps /status.json either way.
      const target = this.defaultRedirect || (this.pages.size ? '/ui' : '');
      if (url.pathname === '/' && target) {
        res.writeHead(302, { location: target }).end();
        return;
      }
      const s = this.status();
      if (url.pathname === '/status.json') return json(200, s);
      return html(200, `<!doctype html><title>longbrowse</title><h1>longbrowse</h1><pre>${JSON.stringify(s, null, 2)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>`);
    }

    if (url.pathname === '/ui' || url.pathname === '/ui/') {
      const links = [...this.pages.keys()].sort()
        .map((k) => `<li><a href="/ui/${k}">${k}</a></li>`).join('');
      return html(200, `<!doctype html><title>longbrowse ui</title><h1>Pages</h1><ul>${links || '<li>(none)</li>'}</ul><p><a href="/status.json">status</a></p>`);
    }

    const pg = url.pathname.match(/^\/ui\/(.+?)\/?$/);
    if (pg) {
      const handler = this.pages.get(pg[1]);
      if (!handler) return json(404, { error: `no page ${pg[1]}`, pages: [...this.pages.keys()] });
      const body = await handler({ query: Object.fromEntries(url.searchParams), req, res });
      if (!res.headersSent) html(200, String(body ?? ''));
      return;
    }

    const m = url.pathname.match(/^\/api\/(.+)$/);
    if (!m) return json(404, { error: 'not found', routes: [...this.routes.keys()] });

    let body;
    if (req.method !== 'GET') {
      const raw = await new Promise((resolve, reject) => {
        let d = '';
        req.on('data', (c) => { d += c; if (d.length > 10e6) reject(new Error('body too large')); });
        req.on('end', () => resolve(d));
        req.on('error', reject);
      });
      body = raw ? JSON.parse(raw) : undefined;
    }

    // every MCP tool as REST: POST /api/tool/<name> {args}
    const tool = m[1].match(/^tool\/(.+)$/);
    if (tool) {
      if (req.method !== 'POST') return json(405, { error: 'POST only' });
      return json(200, await this.callTool(tool[1], body ?? {}));
    }

    // plugin editing: gated by API_PLUGIN_EDITING_ALLOWED
    const pf = m[1].match(/^plugins(?:\/([a-z0-9_-]+)(?:\/(.+))?)?$/i);
    if (pf) {
      if (!this.pluginEditing) return json(403, { error: 'plugin editing disabled (API_PLUGIN_EDITING_ALLOWED)' });
      const [, plugin, file] = pf;
      if (req.method === 'GET' && !plugin) return json(200, this.pluginFs.list());
      if (req.method === 'GET' && plugin && !file) return json(200, this.pluginFs.list()[plugin] ?? []);
      if (req.method === 'GET') return json(200, { content: this.pluginFs.read(plugin, file) });
      if (req.method === 'PUT' || req.method === 'POST') {
        if (!plugin || !file) return json(400, { error: 'PUT /api/plugins/<plugin>/<file> with {content}' });
        this.pluginFs.write(plugin, file, body?.content ?? '');
        return json(200, { ok: true });
      }
      if (req.method === 'DELETE') {
        if (!plugin) return json(400, { error: 'DELETE /api/plugins/<plugin>[/<file>]' });
        this.pluginFs.remove(plugin, file);
        return json(200, { ok: true });
      }
      return json(405, { error: 'method not allowed' });
    }

    const handler = this.routes.get(`${req.method} ${m[1]}`);
    if (!handler) return json(404, { error: `no route ${req.method} ${m[1]}`, routes: [...this.routes.keys()] });
    const result = await handler({ body, query: Object.fromEntries(url.searchParams), req, res });
    if (!res.headersSent) json(200, result ?? { ok: true });
  }
}
