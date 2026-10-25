// Captured Web Notifications (window.Notification is shimmed in every context; the
// shim reports here). In-memory, capped — notifications are transient signals, the
// durable record is whatever a plugin writes to its event store.
export class NotificationStore {
  constructor(cap = 1000) {
    this.cap = cap;
    this.rows = [];
    this.seq = 0;
    this.listeners = new Set();
  }

  push(profile, note) {
    const row = { seq: ++this.seq, ts: new Date().toISOString(), profile, dismissed: false, ...note };
    this.rows.push(row);
    if (this.rows.length > this.cap) this.rows.splice(0, this.rows.length - this.cap);
    for (const fn of this.listeners) {
      try { fn(row); } catch { /* listener must not break capture */ }
    }
    return row;
  }

  list({ profile, since = 0, include_dismissed = false, limit = 100 } = {}) {
    return this.rows
      .filter((r) => (!profile || r.profile === profile)
        && r.seq > since
        && (include_dismissed || !r.dismissed))
      .slice(-limit);
  }

  // seq dismisses one; no seq dismisses everything listed (optionally per profile)
  dismiss({ profile, seq } = {}) {
    let n = 0;
    for (const r of this.rows) {
      if (seq !== undefined && r.seq !== seq) continue;
      if (profile && r.profile !== profile) continue;
      if (!r.dismissed) { r.dismissed = true; n++; }
    }
    if (seq !== undefined && n === 0) throw new Error(`no notification seq ${seq}`);
    return n;
  }

  onPush(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

// Injected into every page before site scripts run. Site calls to the Notification
// API land in the binding; permission looks granted so sites enable the feature.
export const NOTIFICATION_SHIM = `(() => {
  class LbNotification {
    constructor(title, opts = {}) {
      this.title = title;
      window.__lbNotification({ title: String(title), body: String(opts.body ?? ''), tag: String(opts.tag ?? '') });
    }
    close() {}
    addEventListener() {}
    removeEventListener() {}
    static requestPermission(cb) { if (cb) cb('granted'); return Promise.resolve('granted'); }
    static get permission() { return 'granted'; }
    static get maxActions() { return 0; }
  }
  window.Notification = LbNotification;
})();`;
