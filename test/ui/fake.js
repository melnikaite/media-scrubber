// Fake core for the UI harness: a 5.0 s clip on a fake clock.
(() => {
  'use strict';
  const MS = globalThis.MediaScrubber;
  const calls = (window.__calls = []);
  const errors = (window.__errors = []);
  window.addEventListener('error', (e) => errors.push(String(e.message)));
  const RUNGS = ['1f', '0.1', '0.2', '0.5', '1', '2', '5', '10', '30', '60'];
  const SEC = { '1f': 1 / 30, '0.1': 0.1, '0.2': 0.2, '0.5': 0.5, '1': 1, '2': 2, '5': 5, '10': 10, '30': 30, '60': 60 };
  const els = { v1: document.getElementById('vid'), v2: document.getElementById('box2') };
  const S = (window.__state = {
    time: 2.43, paused: true, atEnd: false, rate: 0.75, contested: false, pinned: null,
    placement: { dock: 'bottom', y: null }, collapsed: false, fullscreen: false,
    streak: { dir: 0, rung: 0, at: 0 }, stepHot: { back: false, fwd: false }, ready: true, media: true,
    candidates: [
      { ref: 'v1', kind: 'video', width: 860, height: 483, duration: 5.08 },
      { ref: 'v2', kind: 'video', width: 640, height: 360, duration: 12.5 },
      { ref: 'a1', kind: 'audio', width: 0, height: 0, duration: 8.0 },
    ],
    active: 'v1',
  });
  const D = 5.0;
  const base = () => (S.paused ? 0 : 1);
  function label(dir) {
    const live = S.streak.dir === dir && performance.now() - S.streak.at < 600;
    const r = live ? Math.min(S.streak.rung + 1, RUNGS.length - 1) : base();
    return RUNGS[r];
  }
  function model() {
    return {
      collapsed: S.collapsed, placement: S.placement, fullscreen: !!document.fullscreenElement,
      media: S.media ? { kind: 'video', ready: S.ready, time: S.time, duration: D, range: S.ready ? { start: 0, end: D } : null,
        live: false, buffered: [[0, 3.9]], paused: S.paused, atEnd: S.atEnd } : null,
      rate: S.rate, rateContested: S.contested, presets: [0.5, 0.75, 1],
      step: { back: label(-1), fwd: label(1) }, stepHot: S.stepHot,
      candidates: S.candidates.map((c) => ({ ...c, paused: c.ref === S.active ? S.paused : true, active: c.ref === S.active })),
      pinned: !!S.pinned,
    };
  }
  const log = (name, args) => calls.push({ name, args, t: performance.now() });
  function step(dir) {
    const now = performance.now();
    if (S.streak.dir === dir && now - S.streak.at < 600) S.streak.rung = Math.min(S.streak.rung + 1, RUNGS.length - 1);
    else S.streak.rung = base();
    S.streak.dir = dir; S.streak.at = now;
    S.time = Math.max(0, Math.min(D, S.time + dir * SEC[RUNGS[S.streak.rung]]));
    S.stepHot = { back: dir < 0, fwd: dir > 0 };
    clearTimeout(S.hotTimer);
    S.hotTimer = setTimeout(() => { S.stepHot = { back: false, fwd: false }; push(); }, 620);
  }
  const ctl = {
    togglePlay() { log('togglePlay', []); if (S.atEnd) { S.atEnd = false; S.time = 0; } S.paused = !S.paused; push(); },
    restart() { log('restart', []); S.atEnd = false; S.time = 0; S.paused = false; push(); },
    stepPress(dir) { log('stepPress', [dir]); step(dir); push(); },
    stepRelease(dir) { log('stepRelease', [dir]); push(); },
    wheelStep(dir) { log('wheelStep', [dir]); step(dir); push(); },
    seekTo(t, final) { log('seekTo', [t, final]); S.time = t; push(); },
    setRate(r) { log('setRate', [r]); S.rate = r; push(); },
    pin(ref) { log('pin', [ref]); S.pinned = ref; if (ref) S.active = ref; push(); },
    setCollapsed(b) { log('setCollapsed', [b]); S.collapsed = b; push(); },
    setPlacement(p) { log('setPlacement', [p]); S.placement = p; push(); },
    close() { log('close', []); view.closeWithToast(5000, () => { log('undo', []); view = MS.ui.mount(ctl); window.__view = view; push(); }); },
    candidateRect(ref) {
      const e = els[ref]; if (!e) return null;
      const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };
    },
  };
  let view = MS.ui.mount(ctl);
  window.__view = view; window.__ctl = ctl; window.__model = model;
  function push() { window.__view.update(model()); }
  window.__push = push;
  let last = performance.now();
  function frame(now) {
    const dt = (now - last) / 1000; last = now;
    if (!S.paused && !window.__freeze) {
      S.time += dt * S.rate;
      if (S.time >= D) { S.time = D - 0.001; S.paused = true; S.atEnd = true; }
    }
    push();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  document.addEventListener('fullscreenchange', () => push());
  document.getElementById('fsContainer').addEventListener('click', () => document.getElementById('stage').requestFullscreen());
  document.getElementById('fsVideo').addEventListener('click', () => document.getElementById('vid').requestFullscreen());
  // page-level listeners that must never see our events
  window.__pageSaw = [];
  for (const t of ['click', 'pointerdown', 'mousedown', 'wheel']) document.addEventListener(t, (e) => window.__pageSaw.push(t + ':' + (e.target && e.target.tagName)));
})();
