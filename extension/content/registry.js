// Discovery, the Registry and selectActive (DESIGN §6.2, §6.3).
// Entries hide element access behind methods so remote (child-frame) entries can be added later.
(() => {
  'use strict';
  const MS = (globalThis.MediaScrubber = globalThis.MediaScrubber || {});
  const C = MS.C;

  const FRAME_ID = 0;
  const ids = new WeakMap();          // element → numeric id, stable for the document lifetime
  let nextId = 1;
  let playClock = 0;                  // strictly increasing lastPlayAt values

  const entries = new Map();          // ref → Entry
  const byEl = new WeakMap();         // element → Entry
  const listenedRoots = new Set();    // shadow roots / detached elements with our listener set
  let mo = null;
  let checkQueued = false;
  let graceTimer = 0;
  let lastEvent = null;               // dedupe (element + root listeners can both see one event)

  class Entry {
    constructor(el, via) {
      if (!ids.has(el)) ids.set(el, nextId++);
      this.id = ids.get(el);
      this.ref = `${FRAME_ID}:${this.id}`;
      this.kind = el instanceof HTMLVideoElement ? 'video' : 'audio';
      this.via = via;
      this._strong = via === 'detached' ? null : el;
      this._weak = via === 'detached' ? new WeakRef(el) : null;
      this.lastPlayAt = 0;
      this.commanded = false;
      this.goneSince = 0;
      this.local = true;
    }
    el() { return this._strong || (this._weak && this._weak.deref()) || null; }
    connected() { const el = this.el(); return !!el && (this.via === 'detached' || el.isConnected); }
    ambient() {
      const el = this.el();
      if (!el || this.kind !== 'video' || this.commanded) return false;
      return (el.muted || el.volume === 0) && !el.controls;
    }
    playing() { const el = this.el(); return !!el && !el.paused && !el.ended; }
    alive() { return !!this.el(); }
    ready() { const el = this.el(); return !!el && el.readyState >= 1; }
    area() { const el = this.el(); return el ? visibleArea(el) : 0; }
    // Short description for the candidate list (the model, and child → top reports).
    desc() {
      const el = this.el();
      const r = el && el.isConnected ? el.getBoundingClientRect() : null;
      return {
        kind: this.kind,
        width: r ? Math.round(r.width) : 0, height: r ? Math.round(r.height) : 0,
        duration: el ? el.duration : NaN, paused: el ? el.paused : true,
      };
    }
  }

  function viaOf(el) {
    if (!el.isConnected) return 'detached';
    return el.getRootNode() instanceof Document ? 'light' : 'shadow';
  }

  function register(el) {
    let e = byEl.get(el);
    if (e && entries.get(e.ref) === e) {
      e.goneSince = 0;
      return e;
    }
    e = new Entry(el, viaOf(el));
    entries.set(e.ref, e);
    byEl.set(el, e);
    if (e.via === 'detached') listenOn(el);
    if (e.via === 'shadow') { const r = el.getRootNode(); if (r instanceof ShadowRoot) listenOn(r); }
    ensureObserver();
    MS.registry.onChange && MS.registry.onChange('add', e);
    return e;
  }

  function remove(e) {
    entries.delete(e.ref);
    MS.registry.onChange && MS.registry.onChange('remove', e);
    if (!entries.size) disconnectObserver();
  }

  // ---- listeners ----
  function onMediaEvent(ev) {
    if (!MS.state.open) return;
    if (ev === lastEvent) return;
    lastEvent = ev;
    const el = ev.target;
    if (!MS.isMedia(el)) return;
    const e = register(el);
    if (ev.type === 'play') e.lastPlayAt = playClock = Math.max(Date.now(), playClock + 0.001);
    MS.registry.onMedia && MS.registry.onMedia(ev.type, e, ev);
  }

  function listenOn(target) {
    if (listenedRoots.has(target)) return;
    listenedRoots.add(target);
    for (const t of MS.MEDIA_EVENTS_BASE) target.addEventListener(t, onMediaEvent, true);
    for (const t of MS.MEDIA_EVENTS_EXTRA) target.addEventListener(t, onMediaEvent, true);
    if (target instanceof ShadowRoot && mo) mo.observe(target, { childList: true, subtree: true });
  }

  function walk(root) {
    const all = root.querySelectorAll('*');
    for (let i = 0; i < all.length; i++) {
      const n = all[i];
      if (MS.isMedia(n)) register(n);
      const sr = MS.shadowRootOf(n);
      if (sr) { listenOn(sr); walk(sr); }
    }
  }

  function onChannelMedia(ev) {
    if (!MS.state.open) return;
    const n = ev.relatedTarget;
    if (!n) return;
    if (MS.isMedia(n)) { register(n); MS.registry.onChange && MS.registry.onChange('touch', null); return; }
    if (n instanceof Element) {
      const sr = MS.shadowRootOf(n);
      if (sr) { listenOn(sr); walk(sr); MS.registry.onChange && MS.registry.onChange('touch', null); }
    }
  }

  // ---- removal ----
  function ensureObserver() {
    if (mo || !MS.state.open) return;
    mo = new MutationObserver(queueCheck);
    mo.observe(document, { childList: true, subtree: true });
    for (const r of listenedRoots) if (r instanceof ShadowRoot) mo.observe(r, { childList: true, subtree: true });
  }
  function disconnectObserver() {
    if (mo) { mo.disconnect(); mo = null; }
  }
  function queueCheck() {
    if (checkQueued) return;
    checkQueued = true;
    requestAnimationFrame(checkConnected);
  }
  function checkConnected() {
    checkQueued = false;
    if (!MS.state.open) return;
    const now = Date.now();
    let waiting = false;
    for (const e of [...entries.values()]) {
      if (!e.local) continue;
      if (!e.el()) { remove(e); continue; }
      if (e.connected()) { e.goneSince = 0; continue; }
      if (!e.goneSince) e.goneSince = now;
      if (now - e.goneSince >= C.REMOVE_GRACE_MS) remove(e);
      else waiting = true;
    }
    if (waiting && !graceTimer) {
      graceTimer = setTimeout(() => { graceTimer = 0; checkConnected(); }, C.REMOVE_GRACE_MS + 20);
    }
  }

  // ---- geometry ----
  function visibleArea(el) {
    const r = el.getBoundingClientRect();
    const w = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
    const h = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
    let area = w * h;
    if (!area) return 0;
    let n = el, k = 0;
    while (n && k <= 10) {
      const cs = getComputedStyle(n);
      if (cs.visibility === 'hidden' || cs.display === 'none') return 0;
      area *= parseFloat(cs.opacity) || 0;
      if (!area) return 0;
      const p = n.parentElement;
      n = p || (n.getRootNode() instanceof ShadowRoot ? n.getRootNode().host : null);
      k++;
    }
    return area;
  }

  function pickFrom(list) {
    const playing = list.filter((e) => e.playing());
    if (playing.length) return maxBy(playing, (e) => e.lastPlayAt);
    const played = list.filter((e) => e.lastPlayAt > 0);
    if (played.length) return maxBy(played, (e) => e.lastPlayAt);
    const ready = list.filter((e) => e.ready());
    if (ready.length) return maxBy(ready, (e) => e.area());
    return null;
  }
  function maxBy(arr, f) {
    let best = null, bv = -Infinity;
    for (const x of arr) { const v = f(x); if (v > bv) { bv = v; best = x; } }
    return best;
  }

  function selectActive(pin) {
    if (pin && entries.has(pin)) return entries.get(pin);
    const all = [...entries.values()].filter((e) => e.alive());
    const normal = all.filter((e) => !e.ambient());
    return pickFrom(normal) || pickFrom(all.filter((e) => e.ambient())) || null;
  }

  MS.registry = {
    onMedia: null,   // (type, entry, event) set by boot
    onChange: null,  // (kind, entry) set by boot
    Entry,
    installDocumentListeners() {
      for (const t of MS.MEDIA_EVENTS_BASE) document.addEventListener(t, onMediaEvent, true);
      window.addEventListener(MS.EV.media, onChannelMedia, true);
    },
    removeDocumentListeners() {
      for (const t of MS.MEDIA_EVENTS_BASE) document.removeEventListener(t, onMediaEvent, true);
      window.removeEventListener(MS.EV.media, onChannelMedia, true);
    },
    // Called on open: extra listeners, full scan including closed shadow roots.
    start() {
      for (const t of MS.MEDIA_EVENTS_EXTRA) document.addEventListener(t, onMediaEvent, true);
      MS.registry.scan();
      if (entries.size) ensureObserver();
    },
    scan() {
      if (!MS.state.open) return;
      const root = document.documentElement ? document : null;
      if (root) walk(document);
    },
    stop() {
      for (const t of MS.MEDIA_EVENTS_EXTRA) document.removeEventListener(t, onMediaEvent, true);
      for (const r of listenedRoots) {
        for (const t of MS.MEDIA_EVENTS_BASE) r.removeEventListener(t, onMediaEvent, true);
        for (const t of MS.MEDIA_EVENTS_EXTRA) r.removeEventListener(t, onMediaEvent, true);
      }
      listenedRoots.clear();
      disconnectObserver();
      if (graceTimer) { clearTimeout(graceTimer); graceTimer = 0; }
      checkQueued = false;
      entries.clear();
      lastEvent = null;
    },
    register,
    // Remote (child-frame) entries, keyed "<frameId>:<id>" (content/frames.js).
    putRemote(e) {
      if (!MS.state.open || e.local) return;
      const had = entries.get(e.ref);
      entries.set(e.ref, e);
      if (had !== e) MS.registry.onChange && MS.registry.onChange('add', e);
    },
    removeRemote(ref) {
      const e = entries.get(ref);
      if (e && !e.local) remove(e);
    },
    entryFor: (el) => { const e = byEl.get(el); return e && entries.get(e.ref) === e ? e : null; },
    get: (ref) => entries.get(ref) || null,
    all: () => [...entries.values()],
    size: () => entries.size,
    selectActive,
    visibleArea,
    observing: () => !!mo,
  };
})();
