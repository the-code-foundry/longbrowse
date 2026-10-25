// Per-plugin runtime settings: plugin-settings.json next to the plugin's code,
// accessed per key (read-modify-write each call; the file is small). The loader's
// watcher ignores this file, so settings writes do not trigger a plugin reload.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export const SETTINGS_FILE = 'plugin-settings.json';

// settings.<name>.json — named stores, per plugin or shared at the plugins root
export function settingsFileName(name) {
  if (!/^[a-z0-9_-]+$/i.test(name)) throw new Error(`bad settings name: ${name}`);
  return `settings.${name}.json`;
}

export const SETTINGS_FILE_RX = /^(plugin-settings|settings\.[a-z0-9_-]+)\.json$/i;

export class Settings {
  constructor(file) {
    this.file = file;
  }

  #load() {
    return existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : {};
  }

  get(key, fallback = undefined) {
    const v = this.#load()[key];
    return v === undefined ? fallback : v;
  }

  set(key, value) {
    const all = this.#load();
    all[key] = value;
    writeFileSync(this.file, JSON.stringify(all, null, 2));
    return value;
  }

  delete(key) {
    const all = this.#load();
    const had = key in all;
    delete all[key];
    writeFileSync(this.file, JSON.stringify(all, null, 2));
    return had;
  }

  all() {
    return this.#load();
  }
}
