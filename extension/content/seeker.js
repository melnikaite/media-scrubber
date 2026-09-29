// Seek pipeline, step ladder, frame step, fps estimator, stop at end (DESIGN §6.5, §6.13).
(() => {
  'use strict';
  const MS = (globalThis.MediaScrubber = globalThis.MediaScrubber || {});
  const C = MS.C;

  const memos = new WeakMap();   // element → { inFlight, inFlightAt, pending, fps, samples, lastMT, lastPF, rvfc }
  function memo(el) {
    let m = memos.get(el);
    if (!m) memos.set(el, (m = { inFlight: null, inFlightAt: 0, pending: null, fps: 0, samples: [], lastMT: null, lastPF: -1, rvfcOn: false }));
    return m;
  }

  // ---- fps estimator (rVFC) ----
  function frameDuration(el) {
    const m = memo(el);
    return 1 / (m.fps || m.fpsHint || C.FALLBACK_FPS);
  }
  const entryOf = (el) => MS.registry.entryFor(el);
  function watchFrames(el) {
    if (!(el instanceof HTMLVideoElement) || !el.requestVideoFrameCallback) return;
    const m = memo(el);
    if (m.rvfcOn) return;
    m.rvfcOn = true;
    const cb = (now, meta) => {
      if (!MS.state.open || !m.rvfcOn) { m.rvfcOn = false; return; }
      if (m.lastPF >= 0 && meta.presentedFrames === m.lastPF + 1 && !el.paused && !el.seeking && m.samples.length < 20 && m.lastMT !== null) {
        const d = meta.mediaTime - m.lastMT;
        if (d > 0.004 && d < 0.2) m.samples.push(d);
        if (m.samples.length >= 20 && !m.fps) m.fps = snapFps(m.samples);
      }
      m.lastMT = meta.mediaTime;
      m.lastPF = meta.presentedFrames;
      if (m.fstep && m.fstep.seekedAt && !el.seeking) checkFrameStep(entryOf(el), el, m, meta.mediaTime);
      el.requestVideoFrameCallback(cb);
    };
    el.requestVideoFrameCallback(cb);
  }
  function unwatchFrames(el) { const m = memos.get(el); if (m) m.rvfcOn = false; }
  function snapFps(samples) {
    const s = [...samples].sort((a, b) => a - b);
    const med = s[s.length >> 1];
    const fps = 1 / med;
    for (const f of C.COMMON_FPS) if (Math.abs(fps - f) / f <= 0.02) return f;
    return fps > 5 && fps < 240 ? fps : C.FALLBACK_FPS;
  }

  // ---- range & clamps ----
  function range(el) {
    const d = el.duration;
    if (MS.finite(d) && d > 0) return { start: 0, end: d };
    const s = el.seekable;
    if (s && s.length) {
      const a = s.start(s.length - 1), b = s.end(s.length - 1);
      if (b - a >= 1) return { start: a, end: b };
    }
    return null;
  }
  function endEps(entry, el) {
    return entry.kind === 'video' ? frameDuration(el) : C.AUDIO_END_EPS;
  }
  function clamp(entry, el, t) {
    const r = range(el);
    if (!r) return Math.max(0, t);
    const hi = r.end - endEps(entry, el);
    return Math.min(Math.max(t, r.start), Math.max(r.start, hi));
  }

  // ---- pipeline ----
  function logical(el) {
    const m = memos.get(el);
    if (m) {
      if (m.pending !== null) return m.pending;
      if (m.inFlight !== null) return m.inFlight;
    }
    return el.currentTime;
  }
  function issue(el, m, t) {
    el.currentTime = t;
    MS.state.counters.seeksIssued++;
    if (el.readyState === 0) { m.inFlight = null; return; } // stored as start position; no `seeked`
    m.inFlight = t;
    m.inFlightAt = performance.now();
  }
  function seekTo(entry, t) {
    const el = entry.el();
    if (!el) return;
    t = clamp(entry, el, t);
    const m = memo(el);
    // A seek that never reported back (element reset) must not block the pipeline.
    if (m.inFlight !== null && performance.now() - m.inFlightAt > 1500) m.inFlight = null;
    if (m.inFlight === null) { m.pending = null; issue(el, m, t); }
    else m.pending = t;
    MS.state.atEndRef = null;
    MS.state.passRef = null;
  }
  function onSeeked(entry) {
    const el = entry.el();
    const m = el && memos.get(el);
    if (!m) return;
    const landed = m.inFlight;
    m.inFlight = null;
    if (m.pending !== null) {
      const p = m.pending;
      m.pending = null;
      if (p !== landed) { issue(el, m, p); return; }
    }
    if (m.fstep) {
      // Wait for the presented frame (rVFC); if none comes, the frame did not change.
      m.fstep.seekedAt = performance.now();
      clearTimeout(m.fstep.timer);
      m.fstep.timer = setTimeout(() => { if (m.fstep) checkFrameStep(entry, el, m, m.lastMT); }, 150);
    }
  }

  // Frame-step verification: with an unknown (fallback) frame rate the step may be shorter than
  // the real frame and land on the same frame. Nudge by half a step until the frame changes
  // (≤ 4 tries); an adjacent-frame delta larger than the fallback frame is a reliable fps hint.
  function checkFrameStep(entry, el, m, mt) {
    const fs = m.fstep;
    if (!fs || !entry) { m.fstep = null; return; }
    clearTimeout(fs.timer);
    fs.seekedAt = 0;
    if (mt === null) { m.fstep = null; return; }
    // Frame of the start position unknown (no frame presented since we started watching):
    // forward is decidable from currentTime, backward is accepted as moved.
    const moved = fs.fromMT !== null ? mt !== fs.fromMT : (fs.dir > 0 ? mt > fs.fromCT + 1e-6 : true);
    if (moved) {
      const d = Math.abs(mt - fs.fromMT);
      if (fs.fromMT !== null && !m.fps && d > 1 / C.FALLBACK_FPS + 1e-4 && d < 0.2) m.fpsHint = snapFps([d]);
      m.fstep = null;
      return;
    }
    if (++fs.tries > 4 || !MS.state.open) { m.fstep = null; return; }
    const fd = frameDuration(el);
    m.fstep = fs;
    seekTo(entry, logical(el) + fs.dir * fd / 2);
  }
  function onReset(entry) {        // emptied / loadstart: the element starts over
    const el = entry.el();
    const m = el && memos.get(el);
    if (m) { m.inFlight = null; m.pending = null; m.lastMT = null; m.lastPF = -1; m.fps = 0; m.fpsHint = 0; m.samples = []; if (m.fstep) clearTimeout(m.fstep.timer); m.fstep = null; }
  }

  // ---- ladder ----
  const FRAME = 'f';
  const ladderState = { dir: 0, rung: 0, lastAt: 0 };
  let hold = null;          // { dir, timer }
  let fallbackTimer = 0;

  // paused/range of an entry: read from the element, or from a remote entry's snapshot.
  function stateOf(entry) {
    if (!entry) return null;
    if (entry.local) { const el = entry.el(); return el ? { paused: el.paused, range: range(el) } : null; }
    const s = entry.snap;
    return { paused: s ? s.paused : true, range: s ? s.range : null };
  }
  function rungsFor(entry) {
    const s = stateOf(entry);
    const frame = !!s && entry.kind === 'video' && s.paused;
    let list = frame ? [FRAME, ...C.LADDER] : [...C.LADDER];
    const r = s && s.range;
    if (r) {
      const cap = Math.max(C.LADDER[0], (r.end - r.start) / 4);
      // Stop climbing at the largest rung ≤ cap (labels stay on the ladder).
      list = list.filter((v) => v === FRAME || v <= cap + 1e-9);
    }
    return list;
  }
  function streakLive(dir, now) {
    return ladderState.dir === dir && now - ladderState.lastAt <= C.STREAK_MS;
  }
  function nextRung(dir, now, list) {
    if (!streakLive(dir, now)) return 0;
    return Math.min(ladderState.rung + 1, list.length - 1);
  }
  function applyStep(dir) {
    const entry = MS.core.activeEntry();
    if (!entry || (entry.local && !entry.el())) return;
    entry.commanded = true;
    const now = performance.now();
    const list = rungsFor(entry);
    const rung = nextRung(dir, now, list);
    ladderState.dir = dir; ladderState.rung = rung; ladderState.lastAt = now;
    const size = list[rung];
    if (entry.local) execStep(entry, dir, size);
    else MS.frames.command(entry, { c: 'step', dir, size });   // the owning frame executes it
    scheduleFallback();
    MS.core.render();
  }
  // One step of `size` (seconds, or FRAME) on a local element. Also used by child frames for
  // steps whose rung the top frame chose.
  function execStep(entry, dir, size) {
    const el = entry && entry.el();
    if (!el) return;
    entry.commanded = true;
    dir = dir < 0 ? -1 : 1;
    if (size === FRAME) frameStep(entry, el, dir);
    else {
      size = Number(size);
      if (!(size > 0)) return;
      const m = memos.get(el); if (m && m.fstep) { clearTimeout(m.fstep.timer); m.fstep = null; }
      seekTo(entry, logical(el) + dir * size);
    }
  }
  function frameStep(entry, el, dir) {
    const m = memo(el);
    const fd = frameDuration(el);
    let base;
    if (m.pending !== null || m.inFlight !== null) base = logical(el);
    else if (m.lastMT !== null && Math.abs(m.lastMT - el.currentTime) < fd) base = m.lastMT + 0.001;
    else base = el.currentTime;
    // The last rVFC callback can lag one frame behind a pause (frame presented, callback not yet
    // run): with a known frame rate, never start below the frame that contains currentTime.
    if (m.fps && m.pending === null && m.inFlight === null) {
      const gridFrame = Math.floor(el.currentTime / fd + 1e-3) * fd + 0.001;
      if (gridFrame > base && gridFrame - base < 1.5 * fd) base = gridFrame;
    }
    const fromMT = m.lastMT !== null && base - 0.001 > m.lastMT + fd / 2 ? base - 0.001 : m.lastMT;
    if (m.fstep) clearTimeout(m.fstep.timer);
    m.fstep = { dir, fromMT, fromCT: el.currentTime, tries: 0, seekedAt: 0, timer: 0 };
    seekTo(entry, base + dir * fd);
  }
  function scheduleFallback() {
    if (fallbackTimer) clearTimeout(fallbackTimer);
    fallbackTimer = setTimeout(() => { fallbackTimer = 0; if (MS.state.open) MS.core.render(); }, C.STREAK_MS + 20);
  }
  function stepPress(dir) {
    dir = dir < 0 ? -1 : 1;
    stepRelease();
    applyStep(dir);
    const h = { dir, timer: 0 };
    const tick = () => { if (hold !== h || !MS.state.open) return; applyStep(dir); h.timer = setTimeout(tick, 1000 / C.HOLD_STEPS_PER_S); };
    h.timer = setTimeout(tick, 1000 / C.HOLD_STEPS_PER_S);
    hold = h;
  }
  function stepRelease(dir) {
    if (!hold || (dir && hold.dir !== (dir < 0 ? -1 : 1))) return;
    clearTimeout(hold.timer);
    hold = null;
  }
  function wheelStep(dir) { stepRelease(); applyStep(dir < 0 ? -1 : 1); }

  function fmt(v) { return v === FRAME ? '1f' : String(v); }
  function labels(entry) {
    const now = performance.now();
    const list = rungsFor(entry);
    const out = { step: {}, hot: {} };
    for (const [k, d] of [['back', -1], ['fwd', 1]]) {
      const r = nextRung(d, now, list);
      out.step[k] = fmt(list[r]);
      out.hot[k] = streakLive(d, now) && r > 0;
    }
    return out;
  }

  // ---- stop at end ----
  // End margin (§6.13): max(default, learned) media seconds × max(1, rate), capped at 15 % of the
  // clip. `learned` is per document, in memory only: raised when the site pre-empts our stop.
  let learned = 0;
  function clipCap(el) {
    const d = el.duration;
    return MS.finite(d) && d > 0 ? Math.min(C.END_LEARN_CAP_S, C.END_CAP_FRAC * d) : C.END_LEARN_CAP_S;
  }
  function defaultMargin(entry, el) {
    const base = entry.kind === 'video' ? 1.5 * frameDuration(el) : C.AUDIO_END_WATCH;
    return Math.max(C.END_MARGIN_S, base);
  }
  function watchEps(entry, el) {
    // Never below the 1x margin: slow rates must still beat a site's own early end check.
    const m = Math.max(defaultMargin(entry, el), learned) * Math.max(1, el.playbackRate || 1);
    const d = el.duration;
    return MS.finite(d) && d > 0 ? Math.min(m, C.END_CAP_FRAC * d) : m;
  }
  function nearEnd(entry, el, slack) {
    const d = el.duration;
    if (!MS.finite(d) || d <= 0) return false;
    return el.ended || el.currentTime >= d - watchEps(entry, el) - (slack || 0);
  }
  // `quiet`: we paused this element ourselves (stop at end, or the user's pause) or it is already
  // stopped at its end; nothing that happens to it counts as a pre-emption until it plays again.
  function onPlay(entry) { const el = entry.el(); if (el) memo(el).quiet = false; }
  // Every pause we make leaves a MAIN-world hold (§6.13 pause hold): a page play() on this
  // element is deferred until we play it or the user acts on the page's own UI.
  function ownPause(el) { memo(el).quiet = true; el.pause(); MS.emitNode(MS.EV.hold, el); }
  // Our own play: drop the hold first (MAIN settles deferred page calls with a native play()).
  function ownPlay(el) { MS.emitNode(MS.EV.unhold, el); el.play().catch(() => {}); }
  // The site acted on the still-playing active element before our stop: learn how early.
  function preempted(entry, el) {
    if (!el || !MS.state.open || el.ended || MS.state.passRef === entry.ref) return;
    const m = memo(el);
    if (m.quiet || MS.state.atEndRef === entry.ref) return;
    const d = el.duration;
    if (!MS.finite(d) || d <= 0) return;
    const r = d - el.currentTime;
    const cap = clipCap(el);
    // Only a stop we could have beaten: later than our margin, within the cap (a mid-clip pause
    // from the site's own UI is not an end detection).
    if (!(r > watchEps(entry, el)) || r > cap) return;
    m.quiet = true;
    const extra = entry.kind === 'video' ? 2 * frameDuration(el) : C.END_LEARN_EXTRA_S;
    learned = Math.min(Math.max(learned, r + extra), cap);
  }
  function arm(entry, el) {
    const wasArmed = MS.state.prearmRef === entry.ref;
    memo(el).quiet = true;
    MS.state.atEndRef = entry.ref;
    MS.state.prearmRef = entry.ref;
    if (wasArmed) return;
    MS.emitNode(MS.EV.gateArm, el);
  }
  // Pre-arm: the gate is armed once < prearmWindow of wall-clock time remains, so a site's own
  // early end detection cannot start the next clip before our end watch fires.
  const PREARM_S = 1.0;
  function remainingWall(el) {
    const d = el.duration;
    if (!MS.finite(d) || d <= 0) return Infinity;
    return (d - el.currentTime) / (el.playbackRate || 1);
  }
  function prearmWindow(entry, el) {
    return Math.max(PREARM_S, watchEps(entry, el) / (el.playbackRate || 1) + 0.3);
  }
  function prearm(entry, el) {
    if (MS.state.prearmRef === entry.ref) return;
    MS.state.prearmRef = entry.ref;
    MS.emitNode(MS.EV.gateArm, el);
  }
  // Called every clock frame and on timeupdate for the active element.
  function endCheck(entry) {
    const el = entry && entry.el();
    if (!el || el.paused || el.ended || !MS.state.open) return;
    if (MS.state.passRef === entry.ref) return;          // one-shot pass-through (continue at end)
    if (nearEnd(entry, el)) { ownPause(el); arm(entry, el); MS.core.render(); return; }
    if (remainingWall(el) < prearmWindow(entry, el)) prearm(entry, el);
    else if (MS.state.prearmRef === entry.ref) MS.core.disarm();   // sought back
  }
  // Active element paused/ended on its own near its end, or inside the pre-armed window.
  function onPausedOrEnded(entry) {
    const el = entry.el();
    if (!el || MS.state.passRef === entry.ref) return;
    preempted(entry, el);          // a pause we did not cause, earlier than our margin
    if (MS.state.prearmRef === entry.ref || nearEnd(entry, el, 0.05)) arm(entry, el);
  }
  function endMarginDebug(entry) {
    const el = entry && entry.local && entry.el();
    return {
      default: el ? defaultMargin(entry, el) : C.END_MARGIN_S,
      learned,
      effective: el ? watchEps(entry, el) : null,
    };
  }

  function reset() {
    stepRelease();
    if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = 0; }
    ladderState.dir = 0; ladderState.rung = 0; ladderState.lastAt = 0;
  }

  MS.seeker = {
    range, clamp, logical, seekTo, onSeeked, onReset, frameDuration,
    watchFrames, unwatchFrames,
    stepPress, stepRelease, wheelStep, labels, execStep,
    endCheck, onPausedOrEnded, onPlay, ownPause, ownPlay, preempted, endMarginDebug, reset,
  };
})();
