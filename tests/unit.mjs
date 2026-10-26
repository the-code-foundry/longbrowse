// Offline unit tests: no browser, no network. Run via tests/run.sh.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../core/events.js';
import { ToolRegistry } from '../core/registry.js';
import { Loader, parseIni } from '../core/loader.js';
import { DiskQueue } from '../core/queue.js';
import { filterSnapshot, computeBox } from '../core/snapfilter.js';
import { HelpStore } from '../core/help.js';
import { PluginFs } from '../core/pluginfs.js';
import { ApiServer } from '../core/api.js';
import { NotificationStore } from '../core/notifications.js';
import { ProxyStore } from '../core/proxies.js';
import { Settings, SETTINGS_FILE_RX, settingsFileName } from '../core/settings.js';
import { Human } from '../core/human.js';
import { Egress, hostAllowed } from '../core/egress.js';

// parseIni: flat keys, comments and sections ignored
{
  const ini = parseIni('; c\n[sec]\na = 1\nb=two words\n# x\nbad\n');
  assert.deepEqual(ini, { a: '1', b: 'two words' });
}

// EventStore: append, tail since/limit, name validation
{
  const dir = mkdtempSync(join(tmpdir(), 'lb-ev-'));
  const ev = new EventStore(dir);
  ev.append('p1', { type: 'x' });
  ev.append('p1', { type: 'y' });
  assert.equal(ev.tail('p1').length, 2);
  assert.deepEqual(ev.tail('p1', 1).map((r) => r.type), ['y']); // seq cursor, same-ms safe
  assert.equal(ev.tail('p1', 0, 1).length, 1);
  assert.equal(ev.tail('other').length, 0);
  assert.throws(() => ev.append('../evil', {}));
  rmSync(dir, { recursive: true, force: true });
}

// ToolRegistry: attach/add/remove propagate to live fake servers
{
  const reg = new ToolRegistry();
  const calls = [];
  const fakeServer = () => ({
    registerTool: (name) => { calls.push(`add:${name}`); return { remove: () => calls.push(`rm:${name}`) }; },
  });
  const s1 = fakeServer();
  reg.attach(s1);
  reg.add('t1', { description: 'd' }, async () => {});
  assert.deepEqual(calls, ['add:t1']);
  const s2 = fakeServer();
  reg.attach(s2); // late session gets existing tools
  assert.deepEqual(calls, ['add:t1', 'add:t1']);
  assert.throws(() => reg.add('t1', { description: 'dup' }, async () => {}));
  reg.remove('t1');
  assert.deepEqual(calls, ['add:t1', 'add:t1', 'rm:t1', 'rm:t1']);
  reg.detach(s2);
}

// ToolRegistry prefix: names exposed and called prefixed, remove takes the bare name
{
  const reg = new ToolRegistry('cg_');
  const calls = [];
  reg.attach({ registerTool: (name) => { calls.push(`add:${name}`); return { remove: () => calls.push(`rm:${name}`) }; } });
  reg.add('t1', { description: 'd' }, async () => ({ content: [{ type: 'text', text: 'ok' }] }));
  assert.deepEqual(calls, ['add:cg_t1']);
  assert.equal((await reg.call('cg_t1')).content[0].text, 'ok');
  assert.equal((await reg.call('t1')).isError, true); // bare name is not exposed
  reg.remove('t1');
  assert.deepEqual(calls, ['add:cg_t1', 'rm:cg_t1']);
}

// DiskQueue: push/take in order, empty -> null
{
  const dir = mkdtempSync(join(tmpdir(), 'lb-q-'));
  const q = new DiskQueue(dir);
  q.push({ n: 1 });
  q.push({ n: 2 });
  assert.equal(q.list().length, 2);
  assert.deepEqual(q.peek(), { n: 1 });
  assert.deepEqual(q.take(), { n: 1 });
  assert.deepEqual(q.take(), { n: 2 });
  assert.equal(q.take(), null);
  rmSync(dir, { recursive: true, force: true });
}

// Registry call hooks: fire after handler, observe errors, never break the call
{
  const reg = new ToolRegistry();
  const seen = [];
  const off = reg.onCall((c) => seen.push(c));
  reg.onCall(() => { throw new Error('bad observer'); });
  let registered;
  reg.attach({ registerTool: (_n, _d, wrapped) => { registered = wrapped; return { remove() {} }; } });
  reg.add('t', { description: 'd' }, async ({ boom }) => { if (boom) throw new Error('x'); return { content: [] }; });
  await registered({});
  const errRes = await registered({ boom: true });
  assert.equal(errRes.isError, true);
  assert.equal(seen.length, 2);
  assert.equal(seen[0].error, undefined);
  assert.equal(seen[1].error, 'x');
  off();
  await registered({});
  assert.equal(seen.length, 2);
}

// Loader: loads the shipped example plugin into the registry, unload removes
{
  const reg = new ToolRegistry();
  const ev = { append: () => {}, tail: () => [] };
  const fakeContexts = { page: async () => { throw new Error('no browser in unit tests'); }, context: async () => {} };
  const dataDir = mkdtempSync(join(tmpdir(), 'lb-ld-'));
  const loader = new Loader({
    pluginsDir: new URL('fixtures/plugins', import.meta.url).pathname,
    registry: reg, contexts: fakeContexts, events: ev, dataDir, log: () => {},
  });
  await loader.loadAll();
  assert.ok(reg.tools.has('example_greeting'));
  assert.ok(reg.tools.has('example_echo'));
  loader.unload('example');
  assert.ok(!reg.tools.has('example_greeting'));
  rmSync(dataDir, { recursive: true, force: true });
}

// snapshot filters
{
  const yaml = [
    '- banner:',
    '  - link "Home"',
    '- main:',
    '  - heading "Chats" [level=1]',
    '  - list:',
    '    - listitem:',
    '      - text: Alice',
    '      - button "Open Alice"',
    '    - listitem:',
    '      - text: Bob',
    '- contentinfo:',
    '  - text: footer',
  ].join('\n');

  // max_depth keeps only shallow levels
  const shallow = filterSnapshot(yaml, { max_depth: 2 });
  assert.ok(shallow.includes('- heading "Chats"'));
  assert.ok(!shallow.includes('listitem'));

  // query returns hit + ancestors + children, blocks separated by ---
  const q = filterSnapshot(yaml, { query: 'Alice', child_depth: 0 });
  assert.ok(q.includes('- main:'));
  assert.ok(q.includes('text: Alice'));
  assert.ok(q.includes('button "Open Alice"')); // second hit, own block
  assert.ok(q.includes('\n---\n'));
  assert.ok(!q.includes('Bob'));

  // query_role
  const btns = filterSnapshot(yaml, { query_role: 'button' });
  assert.ok(btns.includes('button "Open Alice"') && !btns.includes('Bob'));

  // interactive keeps actionable + ancestors only
  const inter = filterSnapshot(yaml, { interactive: true });
  assert.ok(inter.includes('link "Home"') && inter.includes('button "Open Alice"'));
  assert.ok(!inter.includes('footer'));

  // regex + max_lines truncation
  const rx = filterSnapshot(yaml, { query: '/ali|bob/' });
  assert.ok(rx.includes('Alice') && rx.includes('Bob'));
  const cut = filterSnapshot(yaml, { max_lines: 3 });
  assert.ok(cut.split('\n').length === 4 && cut.includes('truncated'));

  // no match
  assert.equal(filterSnapshot(yaml, { query: 'zzz' }), '(no match)');
}

// computeBox: corner and centered modes, clamping, mode exclusivity
{
  assert.deepEqual(computeBox({ x1: 10, y1: 20, x2: 110, y2: 70 }, 1280, 900),
    { x: 10, y: 20, width: 100, height: 50 });
  assert.deepEqual(computeBox({ x2: 10, y2: 20, x1: 110, y1: 70 }, 1280, 900),
    { x: 10, y: 20, width: 100, height: 50 }); // corners any order
  assert.deepEqual(computeBox({ x: 100, y: 100, width: 50, height: 20 }, 1280, 900),
    { x: 75, y: 90, width: 50, height: 20 }); // centered
  const clamped = computeBox({ x: 0, y: 0, width: 100, height: 100 }, 1280, 900);
  assert.deepEqual(clamped, { x: 0, y: 0, width: 100, height: 100 }); // clamped into page
  assert.throws(() => computeBox({ x1: 1, y1: 1 }, 100, 100));
  assert.throws(() => computeBox({ x1: 1, y1: 1, x2: 2, y2: 2, x: 1, y: 1, width: 2, height: 2 }, 100, 100));
}

// HelpStore: disk + virtual pages, traversal rejected, prefix removal
{
  const help = new HelpStore(new URL('../help', import.meta.url).pathname);
  assert.ok(help.list().includes('README.md') && help.list().includes('plugins.md'));
  assert.match(help.read('README.md'), /longbrowse/);
  help.add('demo/usage.md', 'hi');
  assert.ok(help.list().includes('demo/usage.md'));
  assert.equal(help.read('demo/usage.md'), 'hi');
  help.removePrefix('demo/');
  assert.ok(!help.list().includes('demo/usage.md'));
  assert.throws(() => help.read('../package.json'));
  assert.throws(() => help.read('nope.md'), /available/);
}

// PluginFs: write/read/list/remove, traversal rejected
{
  const dir = mkdtempSync(join(tmpdir(), 'lb-pf-'));
  const pf = new PluginFs(dir);
  pf.write('demo', 'tools.js', 'x');
  pf.write('demo', 'sub/sel.json', '{}');
  assert.deepEqual(Object.keys(pf.list()), ['demo']);
  assert.equal(pf.read('demo', 'tools.js'), 'x');
  assert.throws(() => pf.read('demo', '../../etc/passwd'));
  assert.throws(() => pf.write('../up', 'f', 'x'));
  pf.remove('demo', 'tools.js');
  assert.throws(() => pf.read('demo', 'tools.js'));
  pf.remove('demo');
  assert.deepEqual(pf.list(), {});
  rmSync(dir, { recursive: true, force: true });
}

// ApiServer: bearer auth, status, tool dispatch, plugin-editing gate
{
  const dir = mkdtempSync(join(tmpdir(), 'lb-api-'));
  const api = new ApiServer({
    token: 'sekret',
    status: () => ({ ok: 1 }),
    callTool: async (name, args) => ({ content: [{ type: 'text', text: `${name}:${args.x}` }] }),
    pluginFs: new PluginFs(dir),
    pluginEditing: false,
  });
  const srv = api.listen(0, '127.0.0.1');
  await new Promise((r) => srv.on('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const get = (p, h = {}) => fetch(base + p, { headers: h });
  const auth = { authorization: 'Bearer sekret' };

  assert.equal((await get('/status.json')).status, 401);
  assert.equal((await get('/status.json', auth)).status, 200);
  const tool = await fetch(`${base}/api/tool/echo`, {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: '{"x":7}',
  });
  assert.equal((await tool.json()).content[0].text, 'echo:7');
  assert.equal((await get('/api/plugins', auth)).status, 403); // editing gated off
  api.pluginEditing = true;
  assert.equal((await get('/api/plugins', auth)).status, 200);

  // ui pages: / serves status until a page exists, then redirects to /ui
  const home0 = await fetch(base + '/', { headers: auth, redirect: 'manual' });
  assert.equal(home0.status, 200);
  const off2 = api.page('demo', 'board', async ({ query }) => `<h1>board ${query.x ?? ''}</h1>`);
  const home1 = await fetch(base + '/', { headers: auth, redirect: 'manual' });
  assert.equal(home1.status, 302);
  assert.equal(home1.headers.get('location'), '/ui');
  assert.match(await (await get('/ui', auth)).text(), /demo\/board/);
  assert.match(await (await get('/ui/demo/board?x=7', auth)).text(), /board 7/);
  assert.equal((await get('/ui/demo/nope', auth)).status, 404);
  off2();
  assert.equal((await fetch(base + '/', { headers: auth, redirect: 'manual' })).status, 200);
  // DEFAULT_REDIRECT override beats the auto /ui target
  api.defaultRedirect = '/ui/demo/board';
  const home2 = await fetch(base + '/', { headers: auth, redirect: 'manual' });
  assert.equal(home2.status, 302);
  assert.equal(home2.headers.get('location'), '/ui/demo/board');
  api.defaultRedirect = '';
  srv.close();
  rmSync(dir, { recursive: true, force: true });
}

// NotificationStore: push/list/dismiss/count, since cursor, profile scope, listener
{
  const ns = new NotificationStore(3);
  const seen = [];
  const off = ns.onPush((r) => seen.push(r.seq));
  ns.push('wa', { title: 'Alice', body: 'hi' });
  ns.push('wa', { title: 'Bob', body: 'yo' });
  ns.push('cg', { title: 'other', body: '' });
  assert.equal(ns.list().length, 3);
  assert.equal(ns.list({ profile: 'wa' }).length, 2);
  assert.deepEqual(ns.list({ since: 2 }).map((r) => r.title), ['other']);
  assert.equal(ns.dismiss({ seq: 1 }), 1);
  assert.equal(ns.list({ profile: 'wa' }).length, 1);
  assert.equal(ns.list({ profile: 'wa', include_dismissed: true }).length, 2);
  assert.equal(ns.dismiss({ profile: 'wa' }), 1); // dismiss-all for a profile
  assert.throws(() => ns.dismiss({ seq: 999 }));
  assert.deepEqual(seen, [1, 2, 3]);
  off();
  ns.push('wa', { title: 'x' }); // cap=3: oldest dropped, listener off
  assert.equal(ns.list({ include_dismissed: true }).length, 3);
  assert.deepEqual(seen, [1, 2, 3]);
}

// ProxyStore: set/get/clear/all, persistence across instances, validation
{
  const dir = mkdtempSync(join(tmpdir(), 'lb-px-'));
  const file = join(dir, 'proxies.json');
  const px = new ProxyStore(file);
  assert.equal(px.get('wa'), null);
  px.set('wa', { server: 'socks5://192.0.2.1:1080', bypass: 'localhost' });
  assert.throws(() => px.set('wa', { bypass: 'x' })); // no server
  const px2 = new ProxyStore(file); // reload from disk
  assert.equal(px2.get('wa').server, 'socks5://192.0.2.1:1080');
  assert.deepEqual(Object.keys(px2.all()), ['wa']);
  px2.clear('wa');
  assert.equal(new ProxyStore(file).get('wa'), null);
  rmSync(dir, { recursive: true, force: true });
}

// Settings: per-key get/set/delete/all, fallback, persistence
{
  const dir = mkdtempSync(join(tmpdir(), 'lb-st-'));
  const s = new Settings(join(dir, 'plugin-settings.json'));
  assert.equal(s.get('missing', 'fb'), 'fb');
  s.set('mirror', true);
  s.set('last_chat', 'Alice');
  assert.equal(new Settings(s.file).get('mirror'), true); // persisted
  assert.deepEqual(s.all(), { mirror: true, last_chat: 'Alice' });
  assert.equal(s.delete('mirror'), true);
  assert.equal(s.delete('mirror'), false);
  assert.deepEqual(s.all(), { last_chat: 'Alice' });
  // named files + watcher exclusion pattern
  assert.equal(settingsFileName('sync-state'), 'settings.sync-state.json');
  assert.throws(() => settingsFileName('../evil'));
  assert.ok(SETTINGS_FILE_RX.test('plugin-settings.json'));
  assert.ok(SETTINGS_FILE_RX.test('settings.sync-state.json'));
  assert.ok(!SETTINGS_FILE_RX.test('tools.js'));
  assert.ok(!SETTINGS_FILE_RX.test('settings.json')); // plain settings.json is not a store
  rmSync(dir, { recursive: true, force: true });
}

// Loader-shaped settings api: named (per plugin) and global (plugins root)
{
  const pluginsDir = mkdtempSync(join(tmpdir(), 'lb-gs-'));
  const dir = join(pluginsDir, 'demo');
  mkdirSync(dir, { recursive: true });
  const s = new Settings(join(dir, 'plugin-settings.json'));
  s.named = (n) => new Settings(join(dir, settingsFileName(n)));
  s.global = (n = 'global') => new Settings(join(pluginsDir, settingsFileName(n)));
  s.named('sync').set('cursor', 7);
  assert.equal(new Settings(join(dir, 'settings.sync.json')).get('cursor'), 7);
  s.global().set('theme', 'dark');
  assert.equal(new Settings(join(pluginsDir, 'settings.global.json')).get('theme'), 'dark');
  rmSync(pluginsDir, { recursive: true, force: true });
}

// EventStore: jsonl migration keeps seq; prune caps rows per plugin
{
  const dir = mkdtempSync(join(tmpdir(), 'lb-ev2-'));
  writeFileSync(join(dir, 'old.jsonl'), '{"ts":"t1","type":"a"}\n{"ts":"t2","type":"b"}\n');
  const ev = new EventStore(dir, { keep: 3 });
  assert.deepEqual(ev.tail('old').map((r) => [r.seq, r.type]), [[1, 'a'], [2, 'b']]);
  const ev2 = new EventStore(dir, { keep: 3 }); // reopen: no double import
  assert.equal(ev2.tail('old').length, 2);
  for (let i = 0; i < 400; i++) ev2.append('p', { type: 'x', i });
  const rows = ev2.tail('p', 0, 1000);
  assert.ok(rows.length <= 3 + 200, `pruned (${rows.length})`); // keep=3, prune every 200
  assert.equal(rows.at(-1).seq, 400); // seq keeps counting past prunes
  rmSync(dir, { recursive: true, force: true });
}

// Human: wave stays within base*(1±amp); jitter positive; backpressure over cap
{
  let t = 0;
  const seq = [0.3, 0.7, 0.9, 0.2, 0.5, 0.8];
  let i = 0;
  const h = new Human({ baseApm: 6, amp: 0.5, capApm: 3, now: () => t, rand: () => seq[i++ % seq.length] });
  const r = h.rate('p');
  assert.ok(r >= 3 && r <= 9, `rate in band: ${r}`);
  const d1 = h.ms('p');
  assert.ok(d1 > 0);
  t += 1000; h.ms('p');
  t += 1000; h.ms('p');
  t += 1000; const d4 = h.ms('p'); // 4th action in a minute, cap 3 -> backpressure
  assert.ok(d4 >= 2000, `backpressure applied: ${d4}`);
  t += 120e3;
  assert.ok(h.ms('p') < 60e3); // window cleared
}

// Egress: allowlist matching (exact, wildcard suffix, ip), rules persist
{
  assert.ok(hostAllowed('web.whatsapp.com', ['web.whatsapp.com']));
  assert.ok(hostAllowed('cdn.whatsapp.net', ['*.whatsapp.net']));
  assert.ok(hostAllowed('whatsapp.net', ['*.whatsapp.net'])); // bare domain matches its own wildcard
  assert.ok(!hostAllowed('evil.com', ['*.whatsapp.net', 'web.whatsapp.com']));
  assert.ok(!hostAllowed('notwhatsapp.net', ['*.whatsapp.net']));
  assert.ok(hostAllowed('1.2.3.4', ['1.2.3.4']));
  const dir = mkdtempSync(join(tmpdir(), 'lb-eg-'));
  const f = join(dir, 'egress.json');
  const eg = new Egress({ mode: 'enforce', file: f });
  eg.allow('p1', ['a.com', '*.b.net']);
  eg.allow('p1', ['a.com']); // dedupe
  assert.deepEqual(new Egress({ mode: 'log', file: f }).list(), { p1: ['a.com', '*.b.net'] });
  eg.remove('p1', 'a.com');
  assert.deepEqual(eg.list().p1, ['*.b.net']);
  rmSync(dir, { recursive: true, force: true });
}

console.log('unit: ok');
