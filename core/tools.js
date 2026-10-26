// The generic browser tools, registered once at boot. Every tool takes an optional
// `profile` so an agent can drive any plugin's context (or the shared "default").
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { filterSnapshot, computeBox } from './snapfilter.js';

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const profileArg = z.string().optional().describe('browser profile (plugin name); default "default"');

// the raw browser-driving tools a wrapper plugin may hide (manifest hide_core: true
// or api.tools.hide(true)); the observability tools (events_tail, help, ...) stay
export const BROWSER_TOOLS = ['navigate', 'snapshot', 'click', 'type', 'press', 'screenshot',
  'screenshot_box', 'screenshot_element', 'upload', 'download', 'tabs', 'cookies', 'proxy'];

export function registerGenericTools(registry, contexts, events, { dataDir }, help, notifications, proxies, egress = null) {
  // session lock: one driver at a time. The holder of session_lock gets a token and
  // passes it as `_lock` in every call (an interceptor strips it); anyone else's
  // calls fail until session_unlock or ttl expiry. Advisory but enforced here, so
  // two agents cannot interleave clicks on the same browser.
  const lock = { owner: null, token: null, expires: 0 };
  const LOCK_EXEMPT = new Set(['session_lock', 'session_unlock', 'session_status', 'help', 'events_tail']);
  registry.intercept(({ raw, args }) => {
    if (LOCK_EXEMPT.has(raw)) return;
    if (!lock.token || Date.now() > lock.expires) return;
    if (args?._lock === lock.token) {
      const { _lock, ...rest } = args;
      return { args: rest };
    }
    return { error: `session locked by "${lock.owner}" until ${new Date(lock.expires).toISOString()} - pass _lock from session_lock, or wait` };
  }, 0);

  registry.add('session_lock', {
    description: 'Take the exclusive driving lock. Returns a token; pass it as `_lock` in every tool call while locked. Re-locking as the same owner extends the ttl. ttl seconds, default 900.',
    inputSchema: { owner: z.string().describe('who is locking (shown to whoever is refused)'), ttl: z.number().int().positive().optional() },
  }, async ({ owner, ttl = 900 }) => {
    const now = Date.now();
    if (lock.token && now < lock.expires && lock.owner !== owner) {
      throw new Error(`locked by "${lock.owner}" until ${new Date(lock.expires).toISOString()}`);
    }
    if (lock.owner !== owner || now > lock.expires) lock.token = randomUUID();
    lock.owner = owner;
    lock.expires = now + ttl * 1000;
    events.append('session', { type: 'lock', owner, expires: new Date(lock.expires).toISOString() });
    return text(JSON.stringify({ token: lock.token, owner, expires: new Date(lock.expires).toISOString() }));
  });

  registry.add('session_unlock', {
    description: 'Release the driving lock. Needs the token from session_lock (or force: true to break a lock).',
    inputSchema: { token: z.string().optional(), force: z.boolean().optional() },
  }, async ({ token, force }) => {
    if (!lock.token || Date.now() > lock.expires) { lock.token = null; return text('already unlocked'); }
    if (!force && token !== lock.token) throw new Error('wrong token (use force: true to break the lock)');
    const was = lock.owner;
    lock.token = null; lock.owner = null; lock.expires = 0;
    events.append('session', { type: 'unlock', owner: was, forced: !!force });
    return text(`unlocked (was "${was}")`);
  });

  registry.add('session_status', {
    description: 'Driving-lock state: locked/free, owner, seconds left.',
    inputSchema: {},
  }, async () => {
    const left = Math.max(0, Math.round((lock.expires - Date.now()) / 1000));
    return text(JSON.stringify(lock.token && left ? { locked: true, owner: lock.owner, expires_in_s: left } : { locked: false }));
  });

  registry.add('cookies', {
    description: 'Manage a profile\'s cookies. list (optionally by domain substring or url), set (array of {name, value, domain, path?, expires?, httpOnly?, secure?, sameSite?} — or url instead of domain; overwrites = update), delete (by domain and/or name; both omitted clears all).',
    inputSchema: {
      action: z.enum(['list', 'set', 'delete']),
      profile: profileArg,
      domain: z.string().optional(),
      url: z.string().optional(),
      name: z.string().optional().describe('for delete'),
      cookies: z.array(z.object({
        name: z.string(), value: z.string(),
        domain: z.string().optional(), url: z.string().optional(), path: z.string().optional(),
        expires: z.number().optional(), httpOnly: z.boolean().optional(), secure: z.boolean().optional(),
        sameSite: z.enum(['Strict', 'Lax', 'None']).optional(),
      })).optional().describe('for set'),
    },
  }, async (a) => {
    const ctx = await contexts.context(a.profile);
    if (a.action === 'set') {
      if (!a.cookies?.length) throw new Error('set needs cookies: [...]');
      await ctx.addCookies(a.cookies.map((c) => ({ path: '/', ...(!c.url && !c.domain && a.domain && { domain: a.domain }), ...c })));
      return text(`set ${a.cookies.length}`);
    }
    if (a.action === 'delete') {
      await ctx.clearCookies({ ...(a.domain && { domain: a.domain }), ...(a.name && { name: a.name }) });
      return text('deleted');
    }
    let rows = await ctx.cookies(a.url ? [a.url] : undefined);
    if (a.domain) rows = rows.filter((c) => c.domain.includes(a.domain));
    return text(rows.map((c) => JSON.stringify(c)).join('\n') || '(no cookies)');
  });

  registry.add('proxy', {
    description: 'Per-profile proxy. get/list; set {server: "http://host:port" or "socks5://host:port", bypass?, username?, password?}; clear. Chromium reads proxy at launch: set/clear CLOSES the profile\'s browser (tabs reset), next use relaunches with the new setting.',
    inputSchema: {
      action: z.enum(['get', 'list', 'set', 'clear']),
      profile: profileArg,
      server: z.string().optional(),
      bypass: z.string().optional(),
      username: z.string().optional(),
      password: z.string().optional(),
    },
  }, async (a) => {
    const profile = a.profile ?? 'default';
    if (a.action === 'list') return text(JSON.stringify(proxies.all(), null, 2));
    if (a.action === 'get') return text(JSON.stringify(proxies.get(profile)));
    if (a.action === 'set') {
      proxies.set(profile, {
        server: a.server,
        ...(a.bypass && { bypass: a.bypass }),
        ...(a.username && { username: a.username }),
        ...(a.password && { password: a.password }),
      });
    } else proxies.clear(profile);
    await contexts.close(profile);
    return text(`${a.action}: profile ${profile} browser closed, relaunches with new proxy on next use`);
  });

  registry.add('notifications', {
    description: 'Captured Web Notifications (new-message alerts etc.). Actions: list (since = last seen seq), dismiss (one seq or all matching), count.',
    inputSchema: {
      action: z.enum(['list', 'dismiss', 'count']),
      profile: z.string().optional(),
      seq: z.number().int().optional().describe('for dismiss: one notification'),
      since: z.number().int().optional(),
      include_dismissed: z.boolean().optional(),
      limit: z.number().int().optional(),
    },
  }, async (a) => {
    if (a.action === 'dismiss') return text(`dismissed ${notifications.dismiss(a)}`);
    const rows = notifications.list(a);
    if (a.action === 'count') return text(String(rows.length));
    return text(rows.map((r) => JSON.stringify(r)).join('\n') || '(no notifications)');
  });

  registry.add('help', {
    description: 'Self-documentation. No args: main usage page + list of all help pages (disk and plugin-provided). With path: that page, e.g. {path: "plugins.md"} or {path: "mail/usage.md"}.',
    inputSchema: { path: z.string().optional() },
  }, async (a) => {
    if (a.path) return text(help.read(a.path));
    return text(`${help.read('README.md')}\n\n## Available help pages\n\n${help.list().map((f) => `- ${f}`).join('\n')}`);
  });

  const page = (a) => contexts.page(a.profile);

  registry.add('navigate', {
    description: 'Open a URL in the profile\'s active page. Returns final URL and title.',
    inputSchema: { url: z.string(), profile: profileArg },
  }, async (a) => {
    const p = await page(a);
    await p.goto(a.url, { waitUntil: 'domcontentloaded' });
    return text(`${p.url()} — ${await p.title()}`);
  });

  registry.add('snapshot', {
    description: 'Accessibility snapshot (ARIA tree, YAML) of the active page — the cheap way to read a screen. ' +
      'Filters: query (text or /regex/, returns each hit with ancestors + child_depth children, blocks separated by ---), ' +
      'query_role (button, textbox, link, ...), max_depth, interactive (keep only actionable elements), max_lines.',
    inputSchema: {
      selector: z.string().optional().describe('limit to this CSS selector; default body'),
      query: z.string().optional(),
      query_role: z.string().optional(),
      max_depth: z.number().int().positive().optional(),
      child_depth: z.number().int().min(0).optional().describe('children under each query hit; default 1'),
      interactive: z.boolean().optional(),
      max_lines: z.number().int().positive().optional(),
      profile: profileArg,
    },
  }, async (a) => {
    const p = await page(a);
    const yaml = await p.locator(a.selector ?? 'body').ariaSnapshot();
    const filtered = filterSnapshot(yaml, a);
    return text(`url: ${p.url()}\ntitle: ${await p.title()}\n---\n${filtered}`);
  });

  registry.add('click', {
    description: 'Click the first element matching a CSS selector (or role=/text= Playwright selector).',
    inputSchema: { selector: z.string(), profile: profileArg },
  }, async (a) => {
    const p = await page(a);
    await p.locator(a.selector).first().click();
    return text(`clicked ${a.selector}`);
  });

  registry.add('type', {
    description: 'Fill an input/contenteditable matching the selector with text; optionally press Enter.',
    inputSchema: { selector: z.string(), text: z.string(), submit: z.boolean().optional(), profile: profileArg },
  }, async (a) => {
    const p = await page(a);
    const loc = p.locator(a.selector).first();
    await loc.fill(a.text);
    if (a.submit) await loc.press('Enter');
    return text(`typed into ${a.selector}${a.submit ? ' and submitted' : ''}`);
  });

  registry.add('press', {
    description: 'Send a key (e.g. "Enter", "Escape", "Control+a") to the active page.',
    inputSchema: { key: z.string(), profile: profileArg },
  }, async (a) => {
    const p = await page(a);
    await p.keyboard.press(a.key);
    return text(`pressed ${a.key}`);
  });

  registry.add('screenshot', {
    description: 'Screenshot the active page to the shared data volume; returns the container path.',
    inputSchema: { full_page: z.boolean().optional(), profile: profileArg },
  }, async (a) => {
    const p = await page(a);
    const dir = join(dataDir, 'screenshots');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${a.profile ?? 'default'}-${Date.now()}.png`);
    await p.screenshot({ path: file, fullPage: a.full_page ?? false });
    return text(file);
  });

  registry.add('screenshot_box', {
    description: 'Screenshot a region: corners x1,y1,x2,y2 OR a box of width,height centered on x,y. Clamped to the page.',
    inputSchema: {
      x1: z.number().optional(), y1: z.number().optional(),
      x2: z.number().optional(), y2: z.number().optional(),
      x: z.number().optional(), y: z.number().optional(),
      width: z.number().optional(), height: z.number().optional(),
      profile: profileArg,
    },
  }, async (a) => {
    const p = await page(a);
    const vp = p.viewportSize() ?? await p.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    const clip = computeBox(a, vp.width, vp.height);
    const dir = join(dataDir, 'screenshots');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${a.profile ?? 'default'}-box-${Date.now()}.png`);
    await p.screenshot({ path: file, clip });
    return text(file);
  });

  registry.add('screenshot_element', {
    description: 'Screenshot the first element matching a selector, with padding (px, default 8) around it.',
    inputSchema: { selector: z.string(), padding: z.number().min(0).optional(), profile: profileArg },
  }, async (a) => {
    const p = await page(a);
    const box = await p.locator(a.selector).first().boundingBox();
    if (!box) throw new Error(`no visible element for ${a.selector}`);
    const pad = a.padding ?? 8;
    const vp = p.viewportSize() ?? await p.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    const clip = computeBox({
      x1: box.x - pad, y1: box.y - pad,
      x2: box.x + box.width + pad, y2: box.y + box.height + pad,
    }, vp.width, vp.height);
    const dir = join(dataDir, 'screenshots');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${a.profile ?? 'default'}-el-${Date.now()}.png`);
    await p.screenshot({ path: file, clip });
    return text(file);
  });

  registry.add('upload', {
    description: 'Set a file (path inside the container, e.g. under /data) on a file input matching the selector.',
    inputSchema: { selector: z.string(), path: z.string(), profile: profileArg },
  }, async (a) => {
    const p = await page(a);
    await p.locator(a.selector).first().setInputFiles(a.path);
    return text(`uploaded ${a.path}`);
  });

  registry.add('download', {
    description: 'Click a selector that triggers a download; the file is saved under /data/downloads. Returns the path.',
    inputSchema: { selector: z.string(), profile: profileArg },
  }, async (a) => {
    const p = await page(a);
    const dir = join(dataDir, 'downloads');
    mkdirSync(dir, { recursive: true });
    const [dl] = await Promise.all([
      p.waitForEvent('download', { timeout: 60000 }),
      p.locator(a.selector).first().click(),
    ]);
    const file = join(dir, dl.suggestedFilename() || `download-${Date.now()}`);
    await dl.saveAs(file);
    return text(file);
  });

  registry.add('tabs', {
    description: 'List, open, close or select tabs of a profile. Actions: list | new | close | select.',
    inputSchema: {
      action: z.enum(['list', 'new', 'close', 'select']),
      index: z.number().int().optional(),
      url: z.string().optional().describe('for action=new'),
      profile: profileArg,
    },
  }, async (a) => {
    const ctx = await contexts.context(a.profile);
    const pages = ctx.pages();
    if (a.action === 'list') {
      const rows = await Promise.all(pages.map(async (p, i) => `${i}: ${p.url()} — ${await p.title()}`));
      return text(rows.join('\n') || '(no tabs)');
    }
    const { maxTabs, stickyTab } = contexts.limits(a.profile ?? 'default');
    if (a.action === 'new') {
      if (pages.length >= maxTabs) throw new Error(`tab limit ${maxTabs} reached`);
      const p = await ctx.newPage();
      if (a.url) await p.goto(a.url, { waitUntil: 'domcontentloaded' });
      return text(`tab ${ctx.pages().length - 1}: ${p.url()}`);
    }
    const idx = a.index ?? pages.length - 1;
    const p = pages[idx];
    if (!p) throw new Error(`no tab ${a.index}`);
    if (a.action === 'close') {
      if (stickyTab && idx === 0) throw new Error('tab 0 is sticky (STICKY_TAB)');
      await p.close();
      return text(`closed tab ${idx}`);
    }
    await p.bringToFront();
    return text(`selected tab ${idx}: ${p.url()}`);
  });

  registry.add('events_tail', {
    description: 'Read a plugin\'s recorded events with seq > since. Poll with since = the last seq you saw. Denied/logged egress connections are under plugin "egress".',
    inputSchema: { plugin: z.string(), since: z.number().int().optional(), limit: z.number().int().optional() },
  }, async (a) => text(events.tail(a.plugin, a.since ?? 0, a.limit ?? 100).map((r) => JSON.stringify(r)).join('\n') || '(no events)'));

  registry.add('egress', {
    description: 'Egress allowlists per profile (active when EGRESS=log|enforce; browser traffic passes a per-profile SOCKS5 check). list; allow {profile, hosts: ["x.com","*.y.net","1.2.3.4"]}; remove {profile, host}. Denials: events_tail plugin=egress.',
    inputSchema: {
      action: z.enum(['list', 'allow', 'remove']),
      profile: z.string().optional(),
      hosts: z.array(z.string()).optional(),
      host: z.string().optional(),
    },
  }, async (a) => {
    if (!egress) throw new Error('egress not wired');
    if (a.action === 'allow') egress.allow(a.profile ?? 'default', a.hosts ?? []);
    if (a.action === 'remove') egress.remove(a.profile ?? 'default', a.host);
    return text(JSON.stringify({ mode: egress.mode, rules: egress.list() }, null, 2));
  });
}
