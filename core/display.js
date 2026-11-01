// Xvnc + websockify lifecycle, owned by node (not the entrypoint) so pause can
// stop them and unpause can bring them back without recreating the container.
// The entrypoint still writes /tmp/vncpass (DES needs --openssl-legacy-provider,
// which the server process does not run with).
import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';

const SOCKET = '/tmp/.X11-unix/X99';

export class Display {
  constructor({ screen = '1280x720', vncPassword = '' } = {}) {
    this.screen = screen;
    this.vncPassword = vncPassword;
    this.procs = [];
    this.starting = null; // in-flight start(), shared by concurrent callers
  }

  get running() {
    return this.procs.length > 0;
  }

  start() {
    if (this.running) return Promise.resolve();
    this.starting ??= this.#start().finally(() => { this.starting = null; });
    return this.starting;
  }

  async #start() {
    rmSync('/tmp/.X99-lock', { force: true });
    rmSync(SOCKET, { force: true });
    const sec = this.vncPassword
      ? ['-SecurityTypes', 'VncAuth', '-PasswordFile', '/tmp/vncpass']
      : ['-SecurityTypes', 'None'];
    this.#spawn('Xvnc', [':99', '-geometry', this.screen, '-depth', '24', ...sec, '-localhost']);
    for (let i = 0; i < 50 && !existsSync(SOCKET); i++) await new Promise((r) => setTimeout(r, 100));
    if (!existsSync(SOCKET)) { this.stop(); throw new Error('Xvnc did not come up'); }
    this.#spawn('websockify', ['--web', '/usr/share/novnc', '6080', 'localhost:5999']);
    process.env.DISPLAY = ':99';
  }

  #spawn(cmd, args) {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'inherit'] });
    p.on('exit', () => { this.procs = this.procs.filter((x) => x !== p); });
    this.procs.push(p);
  }

  stop() {
    for (const p of this.procs) p.kill('SIGTERM');
    this.procs = [];
  }
}
