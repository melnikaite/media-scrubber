// `ms:debug` snapshot for tests (docs/contracts.md §5).
(() => {
  'use strict';
  const MS = (globalThis.MediaScrubber = globalThis.MediaScrubber || {});

  const tail = (s) => (s || '').slice(-24);

  MS.debug = {
    snapshot() {
      const st = MS.state;
      const intent = MS.intent.get();
      const active = st.open ? MS.core.activeEntry() : null;
      const el = active && active.el();
      let view = null;
      try { view = st.view && st.view.getDebug ? st.view.getDebug() : null; } catch (e) { view = { error: String(e) }; }
      return {
        open: st.open,
        intent: intent ? MS.intent.snapshot() : null,
        lock: st.lock,
        active: active && !active.local ? MS.frames.remoteDebug(active) : el ? {
          ref: active.ref, kind: active.kind, src: tail(el.currentSrc),
          currentTime: el.currentTime, paused: el.paused, ended: el.ended,
          playbackRate: el.playbackRate, defaultPlaybackRate: el.defaultPlaybackRate,
          preservesPitch: el.preservesPitch,
        } : null,
        candidates: st.open ? MS.registry.all().map((e) => {
          const x = e.el();
          const src = e.local ? tail(x && x.currentSrc) : ((e.c && e.c.src) || '');
          return { ref: e.ref, kind: e.kind, src, ambient: e.ambient(), lastPlayAt: e.lastPlayAt, via: e.via };
        }) : [],
        atEnd: !!(active && (active.local ? (st.atEndRef === active.ref || (st.gateHeld && el && el.paused)) : (active.snap && active.snap.atEnd))),
        gateHeld: active && !active.local ? !!(active.snap && active.snap.gateHeld) : st.gateHeld,
        frames: MS.frames.debug(),
        counters: { ...st.counters },
        model: st.open ? st.lastModel : null,
        ui: view,
      };
    },
  };
})();
