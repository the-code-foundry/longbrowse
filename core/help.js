// Help pages: markdown files shipped in help/ plus virtual pages plugins publish
// at run time. One MCP tool reads both, so an agent can self-document the server.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, normalize } from 'node:path';

export class HelpStore {
  constructor(dir) {
    this.dir = dir;
    this.virtual = new Map(); // path -> text
  }

  #diskFiles(sub = '') {
    const base = join(this.dir, sub);
    if (!existsSync(base)) return [];
    const out = [];
    for (const e of readdirSync(base)) {
      const rel = sub ? `${sub}/${e}` : e;
      if (statSync(join(base, e)).isDirectory()) out.push(...this.#diskFiles(rel));
      else if (e.endsWith('.md')) out.push(rel);
    }
    return out;
  }

  list() {
    return [...this.#diskFiles(), ...this.virtual.keys()].sort();
  }

  read(path) {
    if (this.virtual.has(path)) return this.virtual.get(path);
    const clean = normalize(path).replace(/\\/g, '/');
    if (clean.startsWith('..') || clean.startsWith('/')) throw new Error(`bad help path: ${path}`);
    const file = join(this.dir, clean);
    if (!existsSync(file)) throw new Error(`no help page ${path}; available:\n${this.list().join('\n')}`);
    return readFileSync(file, 'utf8');
  }

  add(path, text) {
    this.virtual.set(path, text);
  }

  removePrefix(prefix) {
    for (const k of this.virtual.keys()) if (k.startsWith(prefix)) this.virtual.delete(k);
  }
}
