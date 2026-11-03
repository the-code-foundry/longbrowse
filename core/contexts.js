// One persistent Chromium context per profile name. Separate profiles keep logins
// (mail, jira, ...) from ever sharing cookies or storage.
import { chromium } from 'rebrowser-playwright'; // playwright with the CDP Runtime.enable leak patched (bot-detection)
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { NOTIFICATION_SHIM } from './notifications.js';

export class Contexts {
  constructor({ profilesDir, headless, maxTabs = 3, stickyTab = true, notifications = null, proxies = null, egress = null, ensureDisplay = null, ephemeralProfiles = [] }) {
    this.ephemeral = new Set(ephemeralProfiles);
    this.profileOptions = new Map(); // profile -> extra context options (userAgent, locale, timezoneId, extraHTTPHeaders)
    this.profilesDir = profilesDir;
    this.headless = headless;
    this.notifications = notifications;
    this.proxies = proxies;
    this.egress = egress;
    this.ensureDisplay = ensureDisplay; // headful only: bring Xvnc back before a launch
    this.paused = false; // pause tool: no launches until unpause
    this.defaults = { maxTabs, stickyTab };
    this.limitsByProfile = new Map(); // profile -> {maxTabs, stickyTab, onOverflow}
    this.contexts = new Map(); // profile -> BrowserContext
    this.launching = new Map(); // profile -> Promise<BrowserContext> (in-flight launch)
  }

  // Per-profile overrides (plugin manifests); onOverflow(url) fires on auto-closed popups.
  setLimits(profile, limits) {
    this.limitsByProfile.set(profile, { ...this.defaults, ...limits });
  }

  limits(profile) {
    return this.limitsByProfile.get(profile) ?? this.defaults;
  }

  async context(profile = 'default') {
    if (!/^[a-z0-9_-]+$/i.test(profile)) throw new Error(`bad profile name: ${profile}`);
    if (this.paused) throw new Error('paused: browser is stopped, call unpause first');
    const ctx = this.contexts.get(profile);
    if (ctx) return ctx;
    // concurrent callers (plugin watchers at startup) share one launch — a second
    // launchPersistentContext on the same profile dir dies on Chromium's singleton
    let inflight = this.launching.get(profile);
    if (!inflight) {
      inflight = this.#launch(profile).finally(() => this.launching.delete(profile));
      this.launching.set(profile, inflight);
    }
    return inflight;
  }

  async #launch(profile) {
    if (!this.headless) await this.ensureDisplay?.(); // Xvnc may be down after a pause
    const dir = join(this.profilesDir, profile);
    mkdirSync(dir, { recursive: true });
    // stale locks survive container restarts (volume keeps them, hostname changes);
    // only this process launches browsers, so clearing them is safe
    for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      rmSync(join(dir, f), { force: true });
    }
    // The window fills the screen (maximised). No window manager on the Xvnc display,
    // so --start-maximized does nothing: position and size are passed explicitly and
    // the viewport follows the window. kiosk: also no browser chrome, for one always-on site.
    const kiosk = process.env.KIOSK === '1';
    const [w, h] = (process.env.SCREEN ?? '1280x720').split('x').map(Number);
    const args = ['--window-position=0,0', `--window-size=${w},${h}`];
    if (kiosk) args.unshift('--kiosk');
    args.push('--disable-blink-features=AutomationControlled'); // navigator.webdriver stays false
    // user-set proxy wins; otherwise egress (log/enforce) interposes its SOCKS5
    // listener, and hostnames resolve at the proxy so DNS cannot leak around it
    let proxy = this.proxies?.get(profile);
    if (!proxy && this.egress && this.egress.mode !== 'off') {
      proxy = { server: `socks5://127.0.0.1:${await this.egress.portFor(profile)}` };
      args.push('--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1');
    } else if (proxy && this.egress && this.egress.mode !== 'off') {
      console.error(`[contexts] ${profile}: user proxy set, egress ${this.egress.mode} skipped for this profile`);
    }
    const ctxOpts = {
      viewport: this.headless ? { width: w, height: h } : null,
      // fingerprint alignment: match the browser's clock and language to the egress
      // IP's region instead of the container's UTC/en-US defaults
      ...(process.env.TIMEZONE && { timezoneId: process.env.TIMEZONE }),
      ...(process.env.LOCALE && { locale: process.env.LOCALE }),
      ...this.profileOptions.get(profile),
    };
    let ctx;
    if (this.ephemeral.has(profile)) {
      // in memory only: a plain browser + context, nothing written to the profile dir
      const browser = await chromium.launch({ headless: this.headless, args, ...(proxy && { proxy }) });
      ctx = await browser.newContext(ctxOpts);
      ctx.on('close', () => browser.close().catch(() => {}));
    } else {
      ctx = await chromium.launchPersistentContext(dir, { headless: this.headless, args, ...(proxy && { proxy }), ...ctxOpts });
    }
    // a crashed renderer never recovers by itself: reload it
    const wireCrash = (p) => p.on('crash', () => {
      console.error(`[contexts] page crashed (${profile}), reloading`);
      p.reload().catch(() => {});
    });
    for (const p of ctx.pages()) wireCrash(p);
    ctx.on('page', wireCrash);
    // the shim overrides window.Notification with a non-native function - a
    // detection tell; profiles listed in STEALTH_PROFILES (csv, or '*') skip it
    const stealth = (process.env.STEALTH_PROFILES ?? '').split(',').map((s) => s.trim());
    if (this.notifications && !stealth.includes(profile) && !stealth.includes('*')) {
      // capture Web Notifications: permission looks granted, calls land in the store
      await ctx.grantPermissions(['notifications']);
      await ctx.exposeBinding('__lbNotification', ({ page }, note) => {
        this.notifications.push(profile, { ...note, url: page.url() });
      });
      await ctx.addInitScript(NOTIFICATION_SHIM);
    }
    ctx.on('close', () => this.contexts.delete(profile));
    // Popup auto-close: a page beyond maxTabs (opened by the site, not by us —
    // the tabs tool refuses before opening) is closed on arrival and reported.
    ctx.on('page', (p) => {
      const { maxTabs, onOverflow } = this.limits(profile);
      if (ctx.pages().length <= maxTabs) return;
      const url = p.url();
      p.close().catch(() => {});
      onOverflow?.(url);
    });
    this.contexts.set(profile, ctx);
    return ctx;
  }

  // The active page of a profile: last open page, or a fresh one.
  async page(profile = 'default') {
    const ctx = await this.context(profile);
    const pages = ctx.pages();
    return pages.length ? pages[pages.length - 1] : await ctx.newPage();
  }

  // Per-profile context options, applied at the profile's next launch (identity copied
  // from a user's browser: locale, timezone, Accept-Language, user agent). Returns
  // whether they changed; the caller closes the profile to apply them now.
  setOptions(profile, opts) {
    const clean = Object.fromEntries(Object.entries(opts ?? {}).filter(([, v]) => v != null && v !== ''));
    if (JSON.stringify(this.profileOptions.get(profile) ?? {}) === JSON.stringify(clean)) return false;
    this.profileOptions.set(profile, clean);
    return true;
  }

  // Close one profile's browser; the next use relaunches it (new proxy applies then).
  async close(profile) {
    const ctx = this.contexts.get(profile);
    if (ctx) await ctx.close().catch(() => {});
    this.contexts.delete(profile);
  }

  async closeAll() {
    for (const ctx of this.contexts.values()) await ctx.close().catch(() => {});
    this.contexts.clear();
  }
}
