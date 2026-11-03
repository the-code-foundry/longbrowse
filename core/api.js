// Plain-HTTP side door, separate from MCP: "/" status page, "/status.json",
// "/api/<plugin>/<route>" for plugin-defined endpoints. If a token is configured,
// every request must carry "Authorization: Bearer <token>"; no token set = open.
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

const BRAND_DIR = new URL('../brand', import.meta.url).pathname;

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
    // keys a plugin marked {public: true}: reachable without API_TOKEN; the plugin
    // authenticates those requests itself (its own login, device tokens)
    this.publicKeys = new Set();
  }

  route(plugin, method, path, handler, { public: pub = false } = {}) {
    const key = `${method.toUpperCase()} ${plugin}/${path.replace(/^\//, '')}`;
    this.routes.set(key, handler);
    if (pub) this.publicKeys.add(`api ${key}`);
    return () => { this.routes.delete(key); this.publicKeys.delete(`api ${key}`); };
  }

  page(plugin, path, handler, { public: pub = false } = {}) {
    const key = `${plugin}/${path.replace(/^\//, '')}`.replace(/\/$/, '');
    this.pages.set(key, handler);
    if (pub) this.publicKeys.add(`ui ${key}`);
    return () => { this.pages.delete(key); this.publicKeys.delete(`ui ${key}`); };
  }

  // a request that needs no API_TOKEN: a public plugin route/page, or "/" when it
  // only redirects to a public page
  #isPublic(req) {
    const p = new URL(req.url, 'http://x').pathname;
    const ui = p.match(/^\/ui\/(.+?)\/?$/);
    if (ui) return this.publicKeys.has(`ui ${ui[1]}`);
    const a = p.match(/^\/api\/(.+)$/);
    if (a) return this.publicKeys.has(`api ${req.method} ${a[1]}`);
    if (p === '/' && this.defaultRedirect) {
      const t = this.defaultRedirect.match(/^\/ui\/(.+?)\/?$/);
      return !!t && this.publicKeys.has(`ui ${t[1]}`);
    }
    return false;
  }

  #brand(req, res) {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname.slice('/brand/'.length));
    const type = { '.png': 'image/png', '.css': 'text/css', '.svg': 'image/svg+xml', '.html': 'text/html' }[extname(rel)];
    const file = normalize(join(BRAND_DIR, rel));
    if (!type || rel.includes('..') || !file.startsWith(BRAND_DIR + '/') || !existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': type, 'cache-control': 'public, max-age=3600' });
    res.end(readFileSync(file));
  }

  removePlugin(plugin) {
    for (const k of this.routes.keys()) if (k.split(' ')[1].startsWith(`${plugin}/`)) this.routes.delete(k);
    for (const k of this.pages.keys()) if (k.startsWith(`${plugin}/`)) this.pages.delete(k);
    for (const k of this.publicKeys) {
      const [kind, ...rest] = k.split(' ');
      const key = rest.join(' ');
      if ((kind === 'ui' ? key : key.split(' ')[1]).startsWith(`${plugin}/`)) this.publicKeys.delete(k);
    }
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
    // brand assets (logo, LB frame) are public and read-only, so plugin login pages can show them
    if (req.method === 'GET' && req.url.startsWith('/brand/')) return this.#brand(req, res);
    // health probes (load balancers, pool managers) run without credentials
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (this.token && !this.#isPublic(req)) {
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
