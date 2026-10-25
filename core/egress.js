// Egress control: one in-process SOCKS5 listener per profile on loopback; the
// browser is launched with proxy socks5://127.0.0.1:<port> plus
// --host-resolver-rules so hostnames reach the proxy instead of local DNS.
// Modes: off (no proxy), log (allow all, log hosts missing from the allowlist),
// enforce (refuse those connections). Denials/logs append to the 'egress' event
// stream. Allowlists persist per profile (exact host, ip, or *.suffix).
import { createServer, connect } from 'node:net';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export function hostAllowed(host, list) {
  const h = host.toLowerCase();
  return list.some((pat) => {
    const p = pat.toLowerCase();
    if (p.startsWith('*.')) return h === p.slice(2) || h.endsWith(p.slice(1));
    return h === p;
  });
}

export class Egress {
  constructor({ mode = 'off', file, events = null, log = console.error }) {
    Object.assign(this, { mode, file, events, log });
    this.rules = file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}; // profile -> [host]
    this.servers = new Map(); // profile -> {server, port}
  }

  allow(profile, hosts) {
    this.rules[profile] = [...new Set([...(this.rules[profile] ?? []), ...hosts])];
    this.#save();
  }

  remove(profile, host) {
    this.rules[profile] = (this.rules[profile] ?? []).filter((h) => h !== host);
    this.#save();
  }

  list() { return this.rules; }

  #save() { if (this.file) writeFileSync(this.file, JSON.stringify(this.rules, null, 1)); }

  // loopback SOCKS5 port for a profile's browser (listener created on first use)
  async portFor(profile) {
    let s = this.servers.get(profile);
    if (!s) {
      const server = createServer((c) => this.#socks(profile, c));
      await new Promise((res) => server.listen(0, '127.0.0.1', res));
      server.unref();
      s = { server, port: server.address().port };
      this.servers.set(profile, s);
    }
    return s.port;
  }

  // shortcut: greeting and request read as one chunk each (Chromium sends them
  // that way); a client that fragments mid-message gets dropped
  #socks(profile, sock) {
    sock.on('error', () => {});
    sock.once('data', (greet) => {
      if (greet[0] !== 5) return sock.destroy();
      sock.write(Buffer.from([5, 0])); // no auth
      sock.once('data', (req) => {
        try {
          if (req[0] !== 5 || req[1] !== 1) return this.#refuse(sock, 7); // CONNECT only
          let host, off;
          if (req[3] === 1) { host = [...req.subarray(4, 8)].join('.'); off = 8; }
          else if (req[3] === 3) { const n = req[4]; host = req.subarray(5, 5 + n).toString(); off = 5 + n; }
          else if (req[3] === 4) {
            host = Array.from({ length: 8 }, (_, i) => req.readUInt16BE(4 + 2 * i).toString(16)).join(':');
            off = 20;
          } else return this.#refuse(sock, 8);
          const port = req.readUInt16BE(off);
          if (!hostAllowed(host, this.rules[profile] ?? [])) {
            this.events?.append('egress', { type: 'denied', mode: this.mode, profile, host, port });
            this.log(`egress: ${this.mode === 'enforce' ? 'DENIED' : 'not in allowlist (log mode)'} ${profile} -> ${host}:${port}`);
            if (this.mode === 'enforce') return this.#refuse(sock, 2);
          }
          const up = connect(port, host, () => {
            sock.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
            sock.pipe(up).pipe(sock);
          });
          up.on('error', () => this.#refuse(sock, 1));
          sock.on('close', () => up.destroy());
        } catch { sock.destroy(); }
      });
    });
  }

  #refuse(sock, code) {
    sock.end(Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]));
  }

  close() {
    for (const { server } of this.servers.values()) server.close();
    this.servers.clear();
  }
}
