// Per-profile proxy settings, persisted in <dataDir>/proxies.json. Chromium only
// reads proxy config at launch, so a change takes effect by closing the profile's
// context — the next tool call relaunches it with the new proxy.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export class ProxyStore {
  constructor(file) {
    this.file = file;
    this.map = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  }

  // {server: "http://host:port" | "socks5://host:port", bypass?, username?, password?}
  get(profile) {
    return this.map[profile] ?? null;
  }

  set(profile, proxy) {
    if (!proxy?.server) throw new Error('proxy needs {server: "scheme://host:port"}');
    this.map[profile] = proxy;
    this.#save();
  }

  clear(profile) {
    delete this.map[profile];
    this.#save();
  }

  all() {
    return this.map;
  }

  #save() {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.map, null, 2));
  }
}
