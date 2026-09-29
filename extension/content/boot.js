// Wiring: document_start listeners, open/close lifecycle, the clock, the model, the controller.
(() => {
  'use strict';
  const MS = (globalThis.MediaScrubber = globalThis.MediaScrubber || {});
  if (MS.booted) return;
  MS.booted = true;
  // Child frames run in agent mode (DESIGN §6.12): no UI and no Intent ownership; they
  // receive {open, rate} and commands from the top frame through content/frames.js.
  const CHILD = window !== window.top;

  const C = MS.C;
  const st = MS.state;
  const R = MS.registry;
  const S = MS.seeker;
  const RC = MS.reconcile;

  let active = null;          // Entry; only ever assigned from selectActive (I4)
  let rafId = 0;
  let renderQueued = false;
  let candidatesCache = [];
  let orphaned = false;
  let undoSnap = null;
  let undoTimer = 0;
  let unsubIntent = null;

  // ---- active element ----
  function recompute() {
    const intent = MS.intent.get();
    // In a child frame the top frame's selectActive decides (it names our local id).
    const next = !st.open ? null : CHILD ? MS.frames.childActive() : R.selectActive(intent && intent.pin);
    if (next === active) return;
    if (active && active.local && active.el()) S.unwatchFrames(active.el());
    active = next;
    if (active && active.local && active.el()) S.watchFrames(active.el());
    if (!CHILD) {
      adoptRate();
      MS.frames.activeChanged(active, !!(intent && intent.pin));
    }
    // The active element changed: a gate armed for another element no longer applies.
    if (st.prearmRef && (!active || active.ref !== st.prearmRef) && !st.gateHeld) disarm();
    st.passRef = null;
  }

  // Opened with no active element: adopt the first active element's current rate (top only).
  function adoptRate() {
    const intent = MS.intent.get();
    // Only a *playing* active element: frame reports arrive one by one, and a paused candidate
    // can win briefly (class 4) before a playing embed has reported. Until something plays,
    // nothing is locked and nothing audible can change.
    if (!st.open || !intent || intent.rate > 0 || !active || !active.playing()) return;
    const r = active.local ? (active.el() && active.el().playbackRate) : MS.frames.remoteRate(active);
    if (r > 0 && isFinite(r)) MS.intent.update({ rate: r });
  }

  // ---- model ----
  function clipBuffered(el, r) {
    const out = [];
    const b = el.buffered;
    for (let i = 0; i < b.length; i++) {
      let a = b.start(i), z = b.end(i);
      if (r) { a = Math.max(a, r.start); z = Math.min(z, r.end); }
      if (z > a) out.push([a, z]);
    }
    return out;
  }
  function buildCandidates() {
    const all = R.all().filter((e) => e.alive());
    const withAmb = all.map((e) => ({ e, amb: e.ambient(), f: e.local ? 0 : e.frameId }));
    withAmb.sort((a, b) => (a.amb - b.amb) || (a.f - b.f) || (a.e.id - b.e.id));
    return withAmb.map(({ e }) => {
      const d = e.desc();
      return {
        ref: e.ref, kind: d.kind, width: d.width, height: d.height,
        duration: d.duration, paused: d.paused, active: e === active,
      };
    });
  }
  // model.media of a local element (also the base of a child frame's snapshot).
  function localMedia(e) {
    const el = e && e.el();
    if (!el) return null;
    const r = S.range(el);
    return {
      kind: e.kind,
      ready: el.readyState >= 1,
      time: S.logical(el),
      duration: el.duration,
      range: r,
      live: !r && el.duration === Infinity,
      buffered: clipBuffered(el, r),
      paused: el.paused,
      atEnd: st.atEndRef === e.ref || (st.gateHeld && el.paused),
    };
  }
  function buildModel(fromClock) {
    const intent = MS.intent.get();
    if (!fromClock) candidatesCache = buildCandidates();
    const media = !active ? null : active.local ? localMedia(active) : MS.frames.remoteMedia(active);
    const lab = S.labels(active);
    return {
      collapsed: intent.collapsed,
      placement: { dock: intent.placement.dock, y: intent.placement.y },
      fullscreen: document.fullscreenElement != null,
      media,
      rate: intent.rate > 0 ? intent.rate : 1,      // display only, until a rate is adopted
      rateContested: !!(active && (active.local ? RC.contested(active) : MS.frames.remoteContested(active))),
      presets: C.PRESETS,
      moreSpeeds: C.MORE_SPEEDS,
      step: lab.step,
      stepHot: lab.hot,
      candidates: candidatesCache,
      pinned: !!intent.pin,
    };
  }

  // ---- render & clock (§6.6) ----
  function doRender(fromClock) {
    if (!st.open) return;
    if (!MS.alive()) { orphan(); return; }
    if (CHILD) { MS.frames.childPush(fromClock); ensureClock(); return; }
    const model = buildModel(fromClock);
    st.lastModel = model;
    if (st.view) { try { st.view.update(model); } catch (e) { console.error('Media Scrubber view', e); } }
    ensureClock();
  }
  function render() {
    if (renderQueued || !st.open) return;
    renderQueued = true;
    queueMicrotask(() => { renderQueued = false; doRender(false); });
  }
  function clockShouldRun() {
    return st.open && !!active && active.playing() && document.visibilityState === 'visible';
  }
  function ensureClock() {
    if (rafId || !clockShouldRun()) return;
    rafId = requestAnimationFrame(tick);
  }
  function tick() {
    rafId = 0;
    if (!clockShouldRun()) return;
    if (active.local) S.endCheck(active);
    doRender(true);
  }

  // ---- media events ----
  const RECOMPUTE = new Set(['play', 'playing', 'pause', 'ended', 'emptied']);
  R.onMedia = (type, e) => {
    switch (type) {
      case 'play':
        // Another element starts while the active one had not been stopped: pre-emption (§6.13).
        if (e !== active && !e.ambient() && active && active.local) S.preempted(active, active.el());
        if (e.local) S.onPlay(e);
        if (st.passRef === e.ref && st.passEnded) st.passRef = null;
        if (!e.ambient()) {
          if (st.atEndRef || st.gateHeld || st.prearmRef) disarm();
        }
        RC.reconcile(e, false);
        break;
      case 'loadstart':
      case 'emptied':
        S.onReset(e);
        RC.reconcile(e, false);
        break;
      case 'loadedmetadata':
        RC.reconcile(e, false);
        break;
      case 'ratechange':
        RC.reconcile(e, true);
        break;
      case 'seeked':
        S.onSeeked(e);
        break;
      case 'ended':
        if (st.passRef === e.ref) st.passEnded = true;
        // fall through
      case 'pause':
        if (e === active) S.onPausedOrEnded(e);
        break;
      case 'timeupdate':
        if (e === active) S.endCheck(e);
        break;
    }
    if (RECOMPUTE.has(type)) recompute();
    if (!CHILD) adoptRate();
    render();
  };
  R.onChange = (kind, e) => {
    if (kind === 'add') RC.reconcile(e, false);
    if (kind === 'remove') {
      const intent = MS.intent.get();
      if (intent && intent.pin === e.ref) MS.intent.update({ pin: null });
      if (st.atEndRef === e.ref) st.atEndRef = null;
      const el = e.local && e.el();
      if (el) MS.emitNode(MS.EV.unhold, el, 1);   // forget: pending page calls resolve unplayed
    }
    recompute();
    render();
  };

  function disarm() {
    st.atEndRef = null;
    st.prearmRef = null;
    st.gateHeld = false;
    st.heldRef = null;
    MS.emit(MS.EV.gateDisarm, null);
  }

  // ---- channel from MAIN ----
  function onGateHeld(ev) {
    if (!st.open) return;
    const n = ev.relatedTarget;
    let e = null;
    if (MS.isMedia(n)) e = R.register(n);
    // The site tried to start another element before our stop: pre-emption (§6.13).
    if (active && active.local && e !== active) S.preempted(active, active.el());
    st.gateHeld = true;
    st.heldRef = e ? e.ref : null;
    render();
  }
  function onHoldBlocked() { if (st.open) st.counters.holdBlocked++; }
  function onSiteRate() { if (st.open) st.counters.siteRateWrites++; }
  function onReady() { if (st.open && st.lock !== null) RC.sendLock(st.lock); }

  // ---- controller (docs/contracts.md §3.2) ----
  const controller = {
    togglePlay() {
      const a = active;
      if (a && !a.local) { a.commanded = true; MS.frames.command(a, { c: 'toggle' }); return; }
      const el = a && a.el();
      if (!el) return;
      a.commanded = true;
      if (st.gateHeld && (st.atEndRef === a.ref || el.paused)) {
        // A deferred site play() is waiting (the stopped element may already be gone).
        st.gateHeld = false; st.heldRef = null; st.atEndRef = null; st.prearmRef = null;
        MS.emit(MS.EV.gateRelease, null);
      } else if (st.atEndRef === a.ref) {
        if (st.gateHeld) {
          st.gateHeld = false; st.heldRef = null; st.atEndRef = null; st.prearmRef = null;
          MS.emit(MS.EV.gateRelease, null);   // the site's deferred play() runs now
        } else {
          // Continue: let the last few ms play out so the element reaches `ended` and the
          // site advances by its own logic. Replay is ← / scrub.
          disarm();
          // Chrome can report `ended` for an element we paused a hair before its real end
          // (e.g. an audio track shorter than `duration`) without having fired `ended`; play()
          // would then restart from 0. Step back two frames so playback genuinely reaches the
          // end and the native `ended` fires.
          if (el.ended) el.currentTime = Math.max(0, el.currentTime - 2 * S.frameDuration(el));
          st.passRef = a.ref;
          st.passEnded = false;
          S.ownPlay(el);
        }
      } else if (!el.paused && !el.ended) {
        S.ownPause(el);                        // pause exactly now
      } else {
        disarm();
        S.ownPlay(el);
      }
      render();
    },
    stepPress: (dir) => S.stepPress(dir),
    stepRelease: (dir) => S.stepRelease(dir),
    wheelStep: (dir) => S.wheelStep(dir),
    seekTo(t, final) {
      if (!active || !MS.finite(t)) return;
      active.commanded = true;
      if (!active.local) { MS.frames.command(active, { c: 'seek', time: t, final: !!final }); return; }
      S.seekTo(active, t, !!final);
      render();
    },
    setRate(r) {
      r = Number(r);
      if (!(r > 0) || !isFinite(r)) return;
      MS.intent.update({ rate: r });
    },
    pin(ref) { MS.intent.update({ pin: ref && R.get(ref) ? ref : null }); },
    setCollapsed(b) { MS.intent.update({ collapsed: !!b }); },
    setPlacement(p) {
      if (!p) return;
      const dock = p.dock === 'top' || p.dock === 'free' ? p.dock : 'bottom';
      const y = dock === 'free' && MS.finite(p.y) ? Math.min(1, Math.max(0, p.y)) : null;
      MS.intent.update({ placement: { dock, y } });
    },
    close() { if (st.open) { closeBar('ui'); sendState(false); } },
    candidateRect(ref) {
      const e = R.get(ref);
      if (e && !e.local) return MS.frames.rectFor(e);
      const el = e && e.local && e.el();
      if (!el || !el.isConnected) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    },
  };

  function onIntent(intent, prev) {
    if (intent.rate !== prev.rate && intent.rate > 0) {
      RC.sendLock(intent.rate); RC.reconcileAll();
      if (!CHILD) MS.frames.broadcastRate(intent.rate);
    }
    if (intent.pin !== prev.pin) recompute();
    render();
  }

  // ---- lifecycle (§6.10) ----
  function onFullscreen() { render(); }
  function onVisibility() { render(); }
  function onPageshow() { R.scan(); recompute(); render(); }

  function openBar(snap) {
    if (st.open || orphaned) return;
    clearUndo();
    st.open = true;
    R.start();
    const pin = snap && snap.pin && R.get(snap.pin) ? snap.pin : null;
    const first = R.selectActive(pin);
    // No active element yet (e.g. media only in iframes): Intent.rate stays null and no lock is
    // sent, so opening never changes what plays; the first active element's rate is adopted.
    let rate = snap && snap.rate > 0 ? snap.rate : (first && first.el() ? first.el().playbackRate : null);
    if (rate !== null && (!(rate > 0) || !isFinite(rate))) rate = 1;
    if (CHILD) rate = snap && snap.rate > 0 ? snap.rate : null;
    MS.intent.create({ rate, pin, placement: snap && snap.placement, collapsed: snap && snap.collapsed });
    unsubIntent = MS.intent.subscribe(onIntent);
    if (rate !== null) { RC.sendLock(rate); RC.reconcileAll(); }
    recompute();
    document.addEventListener('fullscreenchange', onFullscreen, true);
    document.addEventListener('visibilitychange', onVisibility, true);
    window.addEventListener('pageshow', onPageshow, true);
    st.view = null;
    MS.frames.opened();
    if (!CHILD && MS.ui && MS.ui.mount) {
      try { st.view = MS.ui.mount(controller); } catch (e) { console.error('Media Scrubber mount', e); }
    }
    render();
  }

  function closeBar(reason) {
    if (!st.open) return;
    const snap = MS.intent.snapshot();
    RC.sendLock(null);             // MAIN also disarms the gate and releases a held play()
    MS.frames.closed(reason);
    st.open = false;
    if (active && active.local && active.el()) S.unwatchFrames(active.el());
    active = null;
    S.reset();
    R.stop();
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    document.removeEventListener('fullscreenchange', onFullscreen, true);
    document.removeEventListener('visibilitychange', onVisibility, true);
    window.removeEventListener('pageshow', onPageshow, true);
    if (unsubIntent) { unsubIntent(); unsubIntent = null; }
    MS.intent.discard();
    st.atEndRef = null; st.prearmRef = null; st.gateHeld = false; st.heldRef = null;
    st.passRef = null; st.lastModel = null;
    candidatesCache = [];
    const v = st.view;
    st.view = null;
    if (!v) return;
    try {
      if (reason === 'orphan') v.destroy();
      else {
        undoSnap = snap;
        undoTimer = setTimeout(clearUndo, C.TOAST_MS);
        v.closeWithToast(C.TOAST_MS, () => {
          const s = undoSnap;
          clearUndo();
          if (s && !st.open) { openBar(s); sendState(true); }
        });
      }
    } catch (e) { console.error('Media Scrubber close', e); }
  }
  function clearUndo() {
    if (undoTimer) { clearTimeout(undoTimer); undoTimer = 0; }
    undoSnap = null;
  }
  function sendState(open) {
    MS.safeChrome(() => chrome.runtime.sendMessage({ type: 'ms:state', open }));
  }

  function orphan() {
    if (orphaned) return;
    orphaned = true;
    try { closeBar('orphan'); } catch (_) {}
    try { MS.frames.teardown(); } catch (_) {}
    clearUndo();
    MS.keys.uninstall();
    R.removeDocumentListeners();
    window.removeEventListener(MS.EV.gateHeld, onGateHeld, true);
    window.removeEventListener(MS.EV.siteRate, onSiteRate, true);
    window.removeEventListener(MS.EV.holdBlocked, onHoldBlocked, true);
    window.removeEventListener(MS.EV.ready, onReady, true);
  }
  MS.orphaned = orphan;

  // Top → child commands, executed with the local core exactly like local input.
  function childCommand(m) {
    if (!st.open) return;
    switch (m.c) {
      case 'toggle': controller.togglePlay(); break;
      case 'seek': controller.seekTo(Number(m.time), !!m.final); break;
      case 'step': if (active && active.local) { S.execStep(active, m.dir, m.size); render(); } break;
    }
  }
  // A key forwarded from a focused child frame: the same path as a local key.
  function remoteKey(key, phase) {
    if (!st.open) return;
    const dir = key === 'ArrowLeft' ? -1 : key === 'ArrowRight' ? 1 : 0;
    if (key === 'Space') { if (phase === 'down') controller.togglePlay(); }
    else if (dir && phase === 'down') controller.stepPress(dir);
    else if (dir && phase === 'up') controller.stepRelease(dir);
    else return;
    try { st.view && st.view.noteActivity && st.view.noteActivity(); } catch (_) {}
  }

  MS.core = {
    CHILD,
    activeEntry: () => (st.open ? active : null),
    recompute: () => { recompute(); render(); },
    localMedia,
    childCommand,
    remoteKey,
    adoptRate,
    render,
    disarm,
    controller,
    open: openBar,
    close: closeBar,
  };

  // ---- document_start registrations (cheap early-outs while closed) ----
  MS.keys.install({
    isOpen() {
      if (!st.open) return false;
      if (!MS.alive()) { orphan(); return false; }
      return true;
    },
    // In a child frame handled keys are swallowed here and forwarded to the top (§6.7).
    togglePlay: () => (CHILD ? MS.frames.forwardKey('Space', 'down') : controller.togglePlay()),
    stepPress: (d) => (CHILD ? MS.frames.forwardKey(d < 0 ? 'ArrowLeft' : 'ArrowRight', 'down') : controller.stepPress(d)),
    stepRelease: (d) => (CHILD ? MS.frames.forwardKey(d < 0 ? 'ArrowLeft' : 'ArrowRight', 'up') : controller.stepRelease(d)),
    escape: () => { try { return !!(st.view && st.view.handleEscape && st.view.handleEscape()); } catch (_) { return false; } },
    activity: () => { try { st.view && st.view.noteActivity && st.view.noteActivity(); } catch (_) {} },
  });
  R.installDocumentListeners();
  window.addEventListener(MS.EV.gateHeld, onGateHeld, true);
  window.addEventListener(MS.EV.siteRate, onSiteRate, true);
  window.addEventListener(MS.EV.holdBlocked, onHoldBlocked, true);
  window.addEventListener(MS.EV.ready, onReady, true);

  try {
    chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
      if (!msg || orphaned) return;
      if (CHILD) {
        if (msg.type === 'ms:frames-open') MS.frames.childWake(!!msg.open);
        return;
      }
      if (msg.type === 'ms:toggle') {
        if (st.open) closeBar('toggle'); else openBar(null);
        reply({ open: st.open });
      } else if (msg.type === 'ms:debug') {
        reply(MS.debug.snapshot());
      }
    });
  } catch (_) { orphan(); }
})();
