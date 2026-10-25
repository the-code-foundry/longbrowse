// Disk queue: one folder per plugin under <dataDir>/queue/, one JSON file per item,
// named <ms>-<seq>.json so directory order is arrival order. take() removes — a
// consumer crash after take() loses that item; acceptable for now.
// shortcut: no claim/ack, single-consumer assumed; add claim files when two consumers appear.
import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

let seq = 0;

export class DiskQueue {
  constructor(dir) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  push(item) {
    const name = `${Date.now()}-${(seq++).toString().padStart(6, '0')}.json`;
    writeFileSync(join(this.dir, name), JSON.stringify(item));
    return name;
  }

  list() {
    return readdirSync(this.dir).filter((f) => f.endsWith('.json')).sort();
  }

  // Oldest item, removed from the queue; null when empty.
  take() {
    const [first] = this.list();
    if (!first) return null;
    const file = join(this.dir, first);
    const item = JSON.parse(readFileSync(file, 'utf8'));
    unlinkSync(file);
    return item;
  }

  peek() {
    const [first] = this.list();
    return first ? JSON.parse(readFileSync(join(this.dir, first), 'utf8')) : null;
  }
}
