// Human pacing: per profile, a slowly drifting target rate (sine wave with a
// random phase and period) with log-normal jitter per action, plus backpressure
// when the last minute ran over the cap. Plugins ask `api.human.ms()` for the
// next delay (or `await api.human.delay()`); the module tracks actions itself.
export class Human {
  constructor(opts = {}) {
    // now/rand injectable for tests
    this.opts = { baseApm: 8, amp: 0.5, capApm: 20, now: Date.now, rand: Math.random, ...opts };
    this.profiles = new Map(); // name -> {phase, periodMs, actions: [ts]}
  }

  #state(profile) {
    let s = this.profiles.get(profile);
    if (!s) {
      const r = this.opts.rand;
      s = { phase: r() * 2 * Math.PI, periodMs: (15 + r() * 15) * 60e3, actions: [] };
      this.profiles.set(profile, s);
    }
    return s;
  }

  // current target actions-per-minute (the wave), always > 0
  rate(profile = 'default') {
    const { baseApm, amp, now } = this.opts;
    const s = this.#state(profile);
    return baseApm * (1 + amp * Math.sin((2 * Math.PI * now()) / s.periodMs + s.phase));
  }

  // suggested delay before the next action, ms; records the action
  ms(profile = 'default') {
    const { capApm, now, rand } = this.opts;
    const s = this.#state(profile);
    const t = now();
    s.actions = s.actions.filter((a) => t - a < 60e3);
    s.actions.push(t);
    const mean = 60e3 / this.rate(profile);
    const jitter = Math.exp(0.5 * gauss(rand)); // log-normal, median 1
    let d = mean * jitter;
    if (s.actions.length > capApm) d += (s.actions.length - capApm) * 2000; // backpressure
    return Math.round(d);
  }

  delay(profile = 'default') {
    return new Promise((r) => setTimeout(r, this.ms(profile)));
  }
}

function gauss(rand) { // Box-Muller
  let u = 0, v = 0;
  while (!u) u = rand();
  while (!v) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
