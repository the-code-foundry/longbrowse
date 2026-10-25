// Integration: boots the real server (random port, temp dirs), speaks MCP over
// HTTP, drives the example plugin in real Chromium. tests/run.sh skips this file
// when no Playwright Chromium is installed.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const tmp = mkdtempSync(join(tmpdir(), 'lb-it-'));
const port = 40000 + Math.floor(Math.random() * 1000);

const srv = spawn('node', ['core/server.js'], {
  cwd: root,
  env: {
    ...process.env, PORT: String(port), HOST: '127.0.0.1', HEADLESS: '1',
    PLUGINS_DIR: join(root, 'tests/fixtures/plugins'), DATA_DIR: join(tmp, 'data'), PROFILES_DIR: join(tmp, 'profiles'),
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});

const url = `http://127.0.0.1:${port}/mcp`;
let sid;
let id = 0;

async function rpc(method, params, { notify = false } = {}) {
  const body = { jsonrpc: '2.0', method, ...(params ? { params } : {}), ...(notify ? {} : { id: ++id }) };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(sid ? { 'mcp-session-id': sid } : {}),
    },
    body: JSON.stringify(body),
  });
  sid = res.headers.get('mcp-session-id') ?? sid;
  if (notify) return null;
  const text = await res.text();
  const data = text.startsWith('event:') || text.includes('\ndata:')
    ? JSON.parse(text.split('\n').find((l) => l.startsWith('data:')).slice(5))
    : JSON.parse(text);
  if (data.error) throw new Error(`${method}: ${data.error.message}`);
  return data.result;
}

try {
  // wait for the port
  for (let i = 0; ; i++) {
    try { await fetch(url, { method: 'GET' }); break; } catch {
      if (i > 50) throw new Error('server did not come up');
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  const init = await rpc('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  });
  assert.equal(init.serverInfo.name, 'longbrowse');
  await rpc('notifications/initialized', undefined, { notify: true });

  const tools = await rpc('tools/list', {});
  const names = tools.tools.map((t) => t.name);
  for (const t of ['navigate', 'snapshot', 'click', 'type', 'screenshot', 'tabs', 'events_tail', 'example_greeting', 'example_echo']) {
    assert.ok(names.includes(t), `missing tool ${t}`);
  }

  const greet = await rpc('tools/call', { name: 'example_greeting', arguments: {} });
  assert.equal(greet.content[0].text, 'hello from example');

  const echo = await rpc('tools/call', { name: 'example_echo', arguments: { text: 'ping pong' } });
  assert.equal(echo.content[0].text, 'ping pong');

  const snap = await rpc('tools/call', { name: 'snapshot', arguments: { profile: 'example' } });
  assert.match(snap.content[0].text, /hello from example/);

  const ev = await rpc('tools/call', { name: 'events_tail', arguments: { plugin: 'example' } });
  assert.match(ev.content[0].text, /"type":"read"/);

  console.log('integration: ok');
} finally {
  srv.kill('SIGTERM');
  rmSync(tmp, { recursive: true, force: true });
}
