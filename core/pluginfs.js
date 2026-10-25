// Read/write access to the mounted plugins folder, for remote plugin editing
// (gated by env). Writing a plugin is arbitrary code execution in this container —
// the gates and the API token are the only locks.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

export class PluginFs {
  constructor(dir) {
    this.dir = dir;
  }

  #safe(plugin, file = '') {
    if (!/^[a-z0-9_-]+$/i.test(plugin)) throw new Error(`bad plugin name: ${plugin}`);
    const rel = normalize(join(plugin, file)).replace(/\\/g, '/');
    if (rel.startsWith('..') || rel.startsWith('/')) throw new Error(`bad path: ${file}`);
    return join(this.dir, rel);
  }

  list() {
    if (!existsSync(this.dir)) return {};
    const out = {};
    for (const p of readdirSync(this.dir)) {
      const d = join(this.dir, p);
      if (!statSync(d).isDirectory()) continue;
      out[p] = readdirSync(d, { recursive: true }).map(String).filter((f) => statSync(join(d, f)).isFile());
    }
    return out;
  }

  read(plugin, file) {
    return readFileSync(this.#safe(plugin, file), 'utf8');
  }

  write(plugin, file, content) {
    const path = this.#safe(plugin, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    return path;
  }

  remove(plugin, file) {
    const path = this.#safe(plugin, file ?? '');
    if (!existsSync(path)) throw new Error(`no such ${file ? 'file' : 'plugin'}: ${plugin}${file ? '/' + file : ''}`);
    rmSync(path, { recursive: true });
  }
}
