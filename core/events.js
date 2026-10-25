// Event store in sqlite (<dir>/events.db), seq per plugin. Events let plugin
// watchers record incoming activity (a message arrived, a QR appeared) that an
// agent later reads with events_tail; MCP cannot push. Legacy <dir>/<plugin>.jsonl
// files are imported once (seq = line number, so old cursors stay valid), then
// ignored. `keep` caps rows per plugin; older rows are pruned on append.
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export class EventStore {
  constructor(dir, { keep = 10000 } = {}) {
    mkdirSync(dir, { recursive: true });
    this.keep = keep;
    this.db = new DatabaseSync(join(dir, 'events.db'));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS events (
        plugin TEXT NOT NULL, seq INTEGER NOT NULL, ts TEXT NOT NULL, data TEXT NOT NULL,
        PRIMARY KEY (plugin, seq));`);
    this.q = {
      put: this.db.prepare(`INSERT INTO events (plugin, seq, ts, data)
        VALUES (?, coalesce((SELECT max(seq) FROM events WHERE plugin = ?), 0) + 1, ?, ?)`),
      tail: this.db.prepare('SELECT seq, ts, data FROM events WHERE plugin = ? AND seq > ? ORDER BY seq DESC LIMIT ?'),
      max: this.db.prepare('SELECT max(seq) AS m FROM events WHERE plugin = ?'),
      prune: this.db.prepare('DELETE FROM events WHERE plugin = ? AND seq <= ?'),
      any: this.db.prepare('SELECT 1 FROM events WHERE plugin = ? LIMIT 1'),
    };
    this.#migrate(dir);
  }

  #check(plugin) {
    if (!/^[a-z0-9_-]+$/i.test(plugin)) throw new Error(`bad plugin name: ${plugin}`);
  }

  #migrate(dir) {
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.jsonl'))) {
      const plugin = f.slice(0, -'.jsonl'.length);
      if (!/^[a-z0-9_-]+$/i.test(plugin) || this.q.any.get(plugin)) continue;
      const lines = readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean);
      for (const l of lines) {
        try {
          const { ts, ...data } = JSON.parse(l);
          this.q.put.run(plugin, plugin, ts ?? new Date().toISOString(), JSON.stringify(data));
        } catch { /* skip a corrupt line */ }
      }
      if (lines.length) console.error(`events: migrated ${f} -> sqlite (${lines.length} rows)`);
    }
  }

  append(plugin, event) {
    this.#check(plugin);
    const row = { ts: new Date().toISOString(), ...event };
    const { ts, ...data } = row;
    this.q.put.run(plugin, plugin, ts, JSON.stringify(data));
    const max = this.q.max.get(plugin).m;
    if (max % 200 === 0) this.q.prune.run(plugin, max - this.keep);
    return row;
  }

  // Events after sequence number `since` (0 = all), newest last, at most limit.
  // seq is per plugin, 1-based — stable across restarts, no same-millisecond
  // loss that a timestamp cursor would have.
  tail(plugin, since = 0, limit = 100) {
    this.#check(plugin);
    return this.q.tail.all(plugin, Number(since), limit)
      .map((r) => ({ seq: r.seq, ts: r.ts, ...JSON.parse(r.data) }))
      .reverse();
  }
}
