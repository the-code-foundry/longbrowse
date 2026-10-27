// Plugin loader. A plugin is a mounted folder /plugins/<name>/ with:
//   manifest.json   {"name": "...", "profile": "...", "start_url": "..."}  (name required)
//   tools.js        export async function register(api) — adds MCP tools
//   watch.js        optional: export async function watch(api) — background observer
//   selectors.json  optional: every DOM selector the plugin uses, in one file
//   config.ini      optional, machine values, flat "key = value" lines ([sections] ignored)
// Plugins run trusted in-process and get no node_modules of their own: everything
// they need (zod, the page, the event store) comes through the api object.
import { existsSync, readdirSync, readFileSync, statSync, watch as fsWatch } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { DiskQueue } from './queue.js';
import { BROWSER_TOOLS } from './tools.js';
import { Settings, SETTINGS_FILE, SETTINGS_FILE_RX, settingsFileName } from './settings.js';

export function parseIni(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const l = line.trim();
    if (!l || l.startsWith(';') || l.startsWith('#') || l.startsWith('[')) continue;
    const i = l.indexOf('=');
    if (i > 0) out[l.slice(0, i).trim()] = l.slice(i + 1).trim();
  }
  return out;
}

export class Loader {
  constructor({ pluginsDir, registry, contexts, events, help, api, notifications, human = null, egress = null, dataDir = '/data', log = console.error, pollSeconds = 5, watchEnabled = true }) {
    Object.assign(this, { pluginsDir, registry, contexts, events, help, api, notifications, human, egress, dataDir, log, pollSeconds, watchEnabled });
    this.mtimes = new Map(); // plugin folder -> newest code mtime (settings files excluded)
    this.plugins = new Map(); // name -> {toolNames: [], abort: AbortController}
  }

  async loadAll() {
    if (!existsSync(this.pluginsDir)) return;
    for (const entry of readdirSync(this.pluginsDir)) {
      const dir = join(this.pluginsDir, entry);
      if (statSync(dir).isDirectory() && existsSync(join(dir, 'manifest.json'))) {
        await this.load(dir).catch((e) => this.log(`plugin ${entry}: load failed: ${e.message}`));
      }
    }
  }

  async load(dir) {
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    const name = manifest.name;
    if (!/^[a-z0-9_-]+$/.test(name)) throw new Error(`bad plugin name in manifest: ${name}`);
    if (this.plugins.has(name)) this.unload(name);

    const profile = manifest.profile ?? name;
    const selectors = existsSync(join(dir, 'selectors.json'))
      ? JSON.parse(readFileSync(join(dir, 'selectors.json'), 'utf8')) : {};
    const config = existsSync(join(dir, 'config.ini'))
      ? parseIni(readFileSync(join(dir, 'config.ini'), 'utf8')) : {};

    const state = { toolNames: [], hiddenNames: [], abort: new AbortController(), folder: basename(dir) };
    this.contexts.setLimits?.(profile, {
      ...(manifest.max_tabs !== undefined && { maxTabs: manifest.max_tabs }),
      ...(manifest.sticky_tab !== undefined && { stickyTab: manifest.sticky_tab }),
      onOverflow: (url) => {
        this.events.append(name, { type: 'popup_closed', url });
        this.log(`plugin ${name}: popup auto-closed: ${url}`);
      },
    });
    const api = {
      z,
      manifest,
      selectors,
      config,
      signal: state.abort.signal,
      page: () => this.contexts.page(profile),
      context: () => this.contexts.context(profile),
      open: async () => { // navigate the profile to the plugin's site
        const p = await this.contexts.page(profile);
        if (manifest.start_url && !p.url().startsWith(manifest.start_url)) {
          await p.goto(manifest.start_url, { waitUntil: 'domcontentloaded' });
        }
        return p;
      },
      events: {
        append: (ev) => this.events.append(name, ev),
        tail: (since, limit) => this.events.tail(name, since, limit),
      },
      queue: new DiskQueue(join(this.dataDir, 'queue', name)),
      settings: (() => { // per-key get/set/delete/all on plugin-settings.json
        const s = new Settings(join(dir, SETTINGS_FILE));
        s.named = (n) => new Settings(join(dir, settingsFileName(n))); // plugin's settings.<n>.json
        s.global = (n = 'global') => new Settings(join(this.pluginsDir, settingsFileName(n))); // shared across plugins
        return s;
      })(),
      help: {
        // published as "<plugin>/<relpath>", listed by the help tool, dropped at unload
        add: (relpath, text) => this.help?.add(`${name}/${relpath}`, text),
      },
      http: {
        // POST /api/<plugin>/<path> on the API port; handler({body, query, req, res}) -> JSON
        route: (method, path, handler) => this.api?.route(name, method, path, handler),
      },
      ui: {
        // GET /ui/<plugin>/<path> on the API port; handler({query, req, res}) -> html string.
        // When at least one page exists, / redirects to /ui (the page index).
        page: (path, handler) => this.api?.page(name, path, handler),
      },
      human: { // pacing for this plugin's profile: suggested delays, wave-drifting rate
        ms: () => this.human?.ms(profile) ?? 0,
        delay: () => this.human?.delay(profile) ?? Promise.resolve(),
        rate: () => this.human?.rate(profile) ?? Infinity,
      },
      egress: { // per-profile allowlist (active when the core runs with EGRESS=log|enforce)
        allow: (hosts) => this.egress?.allow(profile, hosts),
        list: () => this.egress?.list()[profile] ?? [],
      },
      onToolCall: (fn) => { // observe every tool call; auto-unsubscribed at unload
        const off = this.registry.onCall(fn);
        state.abort.signal.addEventListener('abort', off, { once: true });
      },
      notifications: {
        list: (opts = {}) => this.notifications?.list({ ...opts, profile }) ?? [],
        dismiss: (opts = {}) => this.notifications?.dismiss({ ...opts, profile }) ?? 0,
        // fires on each captured notification of this plugin's profile; off at unload
        on: (fn) => {
          const off = this.notifications?.onPush((row) => { if (row.profile === profile) fn(row); });
          if (off) state.abort.signal.addEventListener('abort', off, { once: true });
        },
      },
      tools: {
        add: (short, def, handler) => {
          // manifest tool_prefix overrides the <plugin>_ namespace; "" = flat names
          // (one deployment per integration rarely needs per-plugin prefixes; the
          // registry still throws on a duplicate)
          const full = `${manifest.tool_prefix ?? `${name}_`}${short}`;
          this.registry.add(full, def, handler);
          state.toolNames.push(full);
        },
        // hide core (or any) tools from MCP while this plugin is loaded - a wrapper
        // plugin exposing safe high-level tools can pull the raw browser tools from
        // the agent surface. true = the browser tool set; or an explicit name list.
        // Refcounted in the registry; auto-unhidden at unload. REST keeps working.
        hide: (names) => {
          for (const t of names === true ? BROWSER_TOOLS : names) {
            this.registry.hide(t);
            state.hiddenNames.push(t);
          }
        },
        unhide: (names) => {
          for (const t of names === true ? BROWSER_TOOLS : names) {
            this.registry.unhide(t);
            const i = state.hiddenNames.indexOf(t);
            if (i >= 0) state.hiddenNames.splice(i, 1);
          }
        },
        // intercept every tool call before it runs: fn({tool, raw, args}) returns
        // nothing (continue) | {args} (rewrite) | {result} (answer) | {error}.
        // Lower priority first (default 100). Unregistered at unload.
        intercept: (fn, priority) => {
          const off = this.registry.intercept(fn, priority);
          state.abort.signal.addEventListener('abort', off, { once: true });
          return off;
        },
      },
      log: (msg) => this.log(`[${name}] ${msg}`),
    };

    if (manifest.domains?.length) this.egress?.allow(profile, manifest.domains);
    if (manifest.hide_core) api.tools.hide(manifest.hide_core === true ? true : manifest.hide_core);

    const bust = `?v=${Date.now()}`; // ESM caches by URL; a changed query forces a re-import
    const toolsMod = await import(pathToFileURL(join(dir, 'tools.js')).href + bust);
    await toolsMod.register(api);
    if (existsSync(join(dir, 'watch.js'))) {
      const watchMod = await import(pathToFileURL(join(dir, 'watch.js')).href + bust);
      watchMod.watch(api).catch((e) => this.log(`plugin ${name}: watcher died: ${e.message}`));
    }
    state.manifest = manifest;
    state.api = api;
    this.plugins.set(name, state);
    this.log(`plugin ${name}: loaded (${state.toolNames.length} tools)`);
    if (manifest.autostart) {
      // open the browser to start_url right away (QR logins, always-on sites)
      api.open().then(
        () => this.log(`plugin ${name}: autostarted ${manifest.start_url ?? ''}`),
        (e) => this.log(`plugin ${name}: autostart failed: ${e.message}`),
      );
    }
  }

  unload(name) {
    const state = this.plugins.get(name);
    if (!state) return;
    state.abort.abort();
    for (const t of state.toolNames) this.registry.remove(t);
    for (const t of state.hiddenNames) this.registry.unhide(t);
    this.help?.removePrefix(`${name}/`);
    this.api?.removePlugin(name);
    this.plugins.delete(name);
    this.log(`plugin ${name}: unloaded`);
  }

  // Relaunch dead contexts of autostart plugins (browser crash, OOM kill): the
  // next tick reopens start_url and appends a context_restarted event.
  watchdog(periodMs = 15000) {
    setInterval(async () => {
      for (const [name, st] of this.plugins) {
        const m = st.manifest;
        if (!m?.autostart) continue;
        const profile = m.profile ?? name;
        if (this.contexts.contexts.has(profile) || this.contexts.launching?.has(profile)) continue;
        try {
          await st.api.open();
          this.events.append(name, { type: 'context_restarted', url: m.start_url ?? null });
          this.log(`watchdog: relaunched profile ${profile} for ${name}`);
        } catch (e) {
          this.log(`watchdog: relaunch ${profile} failed: ${e.message}`);
        }
      }
    }, periodMs).unref();
  }

  // Reload a plugin folder when anything in it changes (debounced). Linux
  // recursive fs.watch is inotify-based and lossy - directory churn can silently
  // drop the watch for a sibling folder - so the watcher re-arms on error AND a
  // 5s mtime poll catches anything inotify loses.
  watch() {
    if (!existsSync(this.pluginsDir)) return;
    const timers = new Map();
    const schedule = (top) => {
      clearTimeout(timers.get(top));
      timers.set(top, setTimeout(() => {
        const dir = join(this.pluginsDir, top);
        if (existsSync(join(dir, 'manifest.json'))) {
          this.load(dir).catch((e) => this.log(`plugin ${top}: reload failed: ${e.message}`));
        } else {
          // folder (or its manifest) gone: drop whichever plugin came from it
          for (const [name, st] of this.plugins) if (st.folder === top) this.unload(name);
        }
      }, 500));
    };
    const arm = () => {
      try {
        this.watcher?.close();
        this.watcher = fsWatch(this.pluginsDir, { recursive: true }, (_ev, file) => {
          const top = (file ?? '').split('/')[0];
          if (!top) return;
          if (SETTINGS_FILE_RX.test(basename(file ?? ''))) return; // settings writes are not code changes
          schedule(top);
        });
        this.watcher.on('error', (e) => {
          this.log(`plugin watcher error: ${e.message}; re-arming`);
          setTimeout(arm, 1000);
        });
      } catch (e) {
        this.log(`plugin watcher failed to start: ${e.message}; retrying`);
        setTimeout(arm, 5000);
      }
    };
    if (this.watchEnabled) arm(); // PLUGIN_WATCH=0: no inotify (it can be absent or lossy)
    this.rescan(true); // prime mtimes without reloading anything
    if (this.pollSeconds > 0) { // PLUGIN_POLL=0: no periodic rescans
      setInterval(() => {
        const r = this.rescan();
        for (const t of [...r.reloaded, ...r.unloaded]) this.log(`plugin ${t}: change found by poll`);
      }, this.pollSeconds * 1000).unref();
    }
  }

  #folderMtime(dir) {
    let max = 0;
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      if (SETTINGS_FILE_RX.test(f.name)) continue;
      const p = join(dir, f.name);
      try { max = Math.max(max, f.isDirectory() ? this.#folderMtime(p) : statSync(p).mtimeMs); } catch { /* raced a delete */ }
    }
    return max;
  }

  // Compare every plugin folder's newest code mtime with the last known one and
  // load/reload/unload accordingly. The poll calls this; the plugins_rescan tool
  // exposes it, so a deployment can run with no local watching at all
  // (PLUGIN_WATCH=0 PLUGIN_POLL=0) and reload purely on demand.
  rescan(prime = false) {
    const out = { loaded: [], reloaded: [], unloaded: [] };
    try {
      const seen = new Set();
      for (const f of readdirSync(this.pluginsDir, { withFileTypes: true })) {
        if (!f.isDirectory()) continue;
        const top = f.name;
        const dir = join(this.pluginsDir, top);
        if (!existsSync(join(dir, 'manifest.json'))) continue;
        seen.add(top);
        const m = this.#folderMtime(dir);
        const known = this.mtimes.get(top);
        this.mtimes.set(top, m);
        if (prime) continue;
        const isLoaded = [...this.plugins.values()].some((st) => st.folder === top);
        if (!isLoaded) out.loaded.push(top);
        else if (known !== undefined && known !== m) out.reloaded.push(top);
        else continue;
        this.load(dir).catch((e) => this.log(`plugin ${top}: reload failed: ${e.message}`));
      }
      for (const [name, st] of [...this.plugins]) {
        if (!seen.has(st.folder)) { out.unloaded.push(name); this.unload(name); }
      }
      for (const top of [...this.mtimes.keys()]) if (!seen.has(top)) this.mtimes.delete(top);
    } catch { /* plugins dir vanished mid-scan */ }
    return out;
  }
}
