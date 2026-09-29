// reconcile(), the MAIN lock channel and the ratechange fallback budget (DESIGN §6.4).
(() => {
  'use strict';
  const MS = (globalThis.MediaScrubber = globalThis.MediaScrubber || {});
  const C = MS.C;

  const budgets = new WeakMap();   // element → { times: number[], backoffUntil, contested }

  function write(el, rate) {
    let wrote = false;
    if (el.defaultPlaybackRate !== rate) el.defaultPlaybackRate = rate;
    if (el.playbackRate !== rate) { el.playbackRate = rate; wrote = true; }
    if (el.preservesPitch !== true) el.preservesPitch = true;
    return wrote;
  }

  // Idempotent; safe to call any time. `fromRatechange` applies the fallback budget.
  function reconcile(entry, fromRatechange) {
    const intent = MS.intent.get();
    if (!MS.state.open || !intent) return;           // I3
    if (!entry.local || entry.ambient()) return;
    const el = entry.el();
    if (!el) return;
    const rate = intent.rate;
    if (!(rate > 0)) return;                          // not adopted yet: leave the media alone
    if (fromRatechange && el.playbackRate !== rate) {
      const now = Date.now();
      let b = budgets.get(el);
      if (!b) budgets.set(el, (b = { times: [], backoffUntil: 0, contested: false }));
      if (now < b.backoffUntil) return;
      if (b.contested) b.contested = false;           // back-off over: try again
      b.times = b.times.filter((t) => now - t < C.BUDGET_WINDOW_MS);
      if (b.times.length >= C.BUDGET_MAX) {
        b.backoffUntil = now + C.BUDGET_BACKOFF_MS;
        b.contested = true;
        b.times = [];
        MS.state.counters.contested++;
        return;
      }
      b.times.push(now);
    }
    if (write(el, rate)) MS.state.counters.reapplies++;
  }

  function reconcileAll() {
    for (const e of MS.registry.all()) reconcile(e, false);
  }

  function sendLock(rate) {
    MS.state.lock = rate;
    MS.emit(MS.EV.lock, rate);
  }

  function contested(entry) {
    const el = entry && entry.el();
    const b = el && budgets.get(el);
    return !!(b && b.contested && Date.now() < b.backoffUntil);
  }

  MS.reconcile = { reconcile, reconcileAll, sendLock, contested };
})();
