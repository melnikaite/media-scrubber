// Frame relay (DESIGN §6.12). Top frame: remote Registry entries + a port to the service worker.
// Child frames (agent mode): a port to the service worker while the tab's bar is open, candidate
// and active-snapshot reports to the top frame, execution of the top frame's commands.
//
// Port messages (JSON over chrome.runtime ports; the service worker only routes):
//   child → top (SW adds `from` = sender.frameId):
//     {t:'hello'}                               connected / reconnected
//     {t:'cands', list:[Cand], href, nested, ts} full candidate list of the frame
//     {t:'snap', ...Snap}                       state of the element the top named active
//     {t:'key', key:'Space'|'ArrowLeft'|'ArrowRight', phase:'down'|'up'}
//   top → child ({to: frameId | 'all', ...}; SW strips nothing, children ignore `to`):
//     {t:'state', open, rate}                   read-only copy of Intent {open, rate}
//     {t:'active', id: number|null, pinned}     which local element is the global active one
//     {t:'cmd', id, c:'toggle'|'restart'|'step'|'seek', dir?, size?, time?, final?}
//     {t:'rects'}                               re-send candidates (fresh rects) for the outline
//   service worker → top: {t:'frame-gone', from}; service worker → children: {t:'top-gone'}
//   Cand = {id, kind, via, width, height, rect:{x,y,width,height}|null, duration, paused, ended,
//           lastPlayAt (Date.now() epoch ms), ambient, ready, area, src}
//   Snap = {id, kind, ready, time, duration, range, live, buffered, paused, ended, atEnd,
//           gateHeld, rate, defaultRate, preservesPitch, contested, src, ts (Date.now())}
//   Non-finite numbers travel as 'Infinity' / null (JSON).
(() => {
  'use strict';
  const MS = (globalThis.MediaScrubber = globalThis.MediaScrubber || {});
  const st = MS.state;
  const CHILD = window !== window.top;
  const PORT_NAME = 'ms-frame';
  const SNAP_EVERY_MS = 250;

  const enc = (x) => (MS.finite(x) ? x : x === Infinity ? 'Infinity' : x === -Infinity ? '-Infinity' : null);
  const dec = (v) => (typeof v === 'number' ? v : v === 'Infinity' ? Infinity : v === '-Infinity' ? -Infinity : NaN);
  const tail = (s) => (s || '').slice(-24);

  function post(port, msg) {
    if (!port) return false;
    try { port.postMessage(msg); return true; } catch (_) { return false; }
  }
  function connect(onMsg, onGone) {
    if (!MS.alive()) { MS.orphaned && MS.orphaned(); return null; }
    let p;
    try { p = chrome.runtime.connect({ name: PORT_NAME }); } catch (_) { MS.orphaned && MS.orphaned(); return null; }
    p.onMessage.addListener(onMsg);
    p.onDisconnect.addListener(() => {
      try { void chrome.runtime.lastError; } catch (_) {}
      onGone(p);
    });
    return p;
  }

  // Nested frames: ask the service worker to wake the tab's frames whenever an <iframe> (re)loads
  // while we are open (new or navigated frames missed the first broadcast).
  let wakeTimer = 0;
  function onFrameLoad(e) {
    const t = e.target;
    if (!st.open || !t || (t.localName !== 'iframe' && t.localName !== 'frame')) return;
    if (wakeTimer) return;
    wakeTimer = setTimeout(() => {
      wakeTimer = 0;
      if (st.open) MS.safeChrome(() => chrome.runtime.sendMessage({ type: 'ms:wake' }));
    }, 100);
  }
  function watchLoads(on) {
    if (on) document.addEventListener('load', onFrameLoad, true);
    else {
      document.removeEventListener('load', onFrameLoad, true);
      if (wakeTimer) { clearTimeout(wakeTimer); wakeTimer = 0; }
    }
  }

  // =====================================================================================
  // Top frame
  // =====================================================================================

  class RemoteEntry {
    constructor(frameId, id) {
      this.frameId = frameId;
      this.id = id;
      this.ref = `${frameId}:${id}`;
      this.local = false;
      this.via = 'light';
      this.kind = 'video';
      this.c = null;        // last candidate report
      this.snap = null;     // last active snapshot
      this.lastPlayAt = 0;
      this.commanded = false;
      this.goneSince = 0;
    }
    setInfo(c) { this.c = c; this.kind = c.kind === 'audio' ? 'audio' : 'video'; this.via = c.via || 'light'; this.lastPlayAt = c.lastPlayAt || 0; }
    cur() { const s = this.snap, c = this.c; return s && (!c || s.ts >= c.ts) ? s : c; }
    el() { return null; }
    alive() { return true; }
    connected() { return true; }
    ambient() { return !!(this.c && this.c.ambient); }
    playing() { const x = this.cur(); return !!x && !x.paused && !x.ended; }
    ready() { return !!((this.c && this.c.ready) || (this.snap && this.snap.ready)); }
    area() { return (this.c && this.c.area) || 0; }
    desc() {
      const c = this.c || {}, x = this.cur() || {};
      return { kind: this.kind, width: c.width || 0, height: c.height || 0, duration: x.duration ?? NaN, paused: x.paused !== false };
    }
  }

  let tport = null, tWant = false, tBackoff = 200, tTimer = 0, sweepTimer = 0, helloTimer = 0;
  const known = new Map();       // frameId → { heard: Date.now(), href, nested }
  const sentActive = new Map();  // frameId → id last sent in {t:'active'}
  let lastActive = null, lastPinned = false;
  let rectsAskedAt = 0;

  function topPost(msg) { return post(tport, msg); }
  function stateMsg(to) { const i = MS.intent.get(); return { to, t: 'state', open: !!st.open, rate: i && i.rate > 0 ? i.rate : null }; }

  function topConnect() {
    tTimer = 0;
    if (!tWant || !st.open) return;
    tport = connect(onTopMsg, (p) => {
      if (tport !== p) return;
      tport = null;
      if (!tWant) return;
      if (!MS.alive()) { MS.orphaned && MS.orphaned(); return; }
      // Service worker suspended/restarted: reconnect, children do the same.
      tTimer = setTimeout(topConnect, tBackoff);
      tBackoff = Math.min(tBackoff * 2, 2000);
    });
    if (!tport) return;
    sentActive.clear();
    topPost(stateMsg('all'));
    // Frames that do not answer the re-broadcast are gone (the table was rebuilt without them).
    const since = Date.now();
    if (sweepTimer) clearTimeout(sweepTimer);
    sweepTimer = setTimeout(() => {
      sweepTimer = 0;
      for (const [f, k] of [...known]) if (k.heard < since) dropFrame(f);
    }, 3000);
  }

  function dropFrame(f) {
    known.delete(f);
    sentActive.delete(f);
    for (const e of MS.registry.all()) if (!e.local && e.frameId === f) MS.registry.removeRemote(e.ref);
  }

  function onTopMsg(m) {
    if (!m || typeof m !== 'object' || !st.open) return;
    tBackoff = 200;
    const f = m.from;
    if (m.t === 'frame-gone') { if (typeof f === 'number') dropFrame(f); return; }
    if (typeof f !== 'number' || f === 0) return;
    const k = known.get(f) || { heard: 0, href: '', nested: false };
    k.heard = Date.now();
    known.set(f, k);
    switch (m.t) {
      case 'hello':
        sentActive.delete(f);
        topPost(stateMsg(f));
        sendActive(f);
        break;
      case 'cands': mergeCands(f, k, m); break;
      case 'snap': {
        const e = MS.registry.get(`${f}:${m.id}`);
        if (!e || e.local) return;
        m.duration = dec(m.duration);
        e.snap = m;
        MS.core.adoptRate();
        MS.core.render();
        break;
      }
      case 'key': MS.core.remoteKey(m.key, m.phase); break;
    }
  }

  function mergeCands(f, k, m) {
    k.href = String(m.href || '');
    k.nested = !!m.nested;
    const R = MS.registry;
    const seen = new Set();
    for (const c of Array.isArray(m.list) ? m.list : []) {
      if (typeof c.id !== 'number') continue;
      c.duration = dec(c.duration);
      c.ts = m.ts || Date.now();
      const ref = `${f}:${c.id}`;
      seen.add(ref);
      let e = R.get(ref);
      if (e && e.local) continue;
      if (!e) { e = new RemoteEntry(f, c.id); e.setInfo(c); R.putRemote(e); }
      else e.setInfo(c);
    }
    for (const e of R.all()) if (!e.local && e.frameId === f && !seen.has(e.ref)) R.removeRemote(e.ref);
    MS.core.recompute();
  }

  function sendActive(f) {
    const id = lastActive && !lastActive.local && lastActive.frameId === f ? lastActive.id : null;
    if (sentActive.has(f) && sentActive.get(f) === id) return;
    if (topPost({ to: f, t: 'active', id, pinned: id !== null && lastPinned })) sentActive.set(f, id);
  }

  function extrapolate(s) {
    let t = s.time;
    if (!s.paused && !s.ended && !s.atEnd && MS.finite(s.rate)) {
      const dt = Math.min(Math.max(0, Date.now() - s.ts), 2000) / 1000;   // cap if the port stalls
      t += dt * s.rate;
    }
    const r = s.range;
    if (r) t = Math.min(Math.max(t, r.start), r.end);
    return t;
  }

  // ---- iframe element of a frame id (outline geometry) ----
  // 1. chrome.runtime.getFrameId(<iframe>) — exact, works cross-origin (Chrome 106+).
  // 2. Fallback (pragmatic rule): exactly one iframe whose resolved `src` equals the child's
  //    reported location.href, else exactly one visible iframe. Otherwise null → label alone.
  // Frames nested deeper than one level report `nested` and are never outlined.
  function iframeFor(f) {
    const k = known.get(f);
    if (!k || k.nested) return null;
    const list = [...document.querySelectorAll('iframe,frame')];
    try {
      if (chrome.runtime.getFrameId) {
        for (const x of list) { try { if (chrome.runtime.getFrameId(x) === f) return x; } catch (_) {} }
      }
    } catch (_) {}
    const bySrc = list.filter((x) => x.src && x.src === k.href);
    if (bySrc.length === 1) return bySrc[0];
    const vis = list.filter((x) => { const r = x.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
    return vis.length === 1 ? vis[0] : null;
  }

  // =====================================================================================
  // Child frame (agent mode)
  // =====================================================================================

  let cport = null, cWant = false, cBackoff = 200, cTimer = 0, watchdog = 0;
  let childActiveId = null;
  let lastCands = '', lastSnap = null, lastSnapAt = 0;

  function childPost(msg) { return post(cport, msg); }

  function childConnect() {
    cTimer = 0;
    if (!cWant) return;
    cport = connect(onChildMsg, (p) => {
      if (cport !== p) return;
      cport = null;
      if (!cWant) return;
      if (!MS.alive()) { MS.orphaned && MS.orphaned(); return; }
      cTimer = setTimeout(childConnect, cBackoff);
      cBackoff = Math.min(cBackoff * 2, 2000);
    });
    if (!cport) return;
    lastCands = ''; lastSnap = null;
    childPost({ t: 'hello' });
    // Nobody answers (the top frame is gone or closed meanwhile) → back to inert.
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(() => { watchdog = 0; childStop(); }, 5000);
  }

  function childStop() {
    cWant = false;
    if (cTimer) { clearTimeout(cTimer); cTimer = 0; }
    if (watchdog) { clearTimeout(watchdog); watchdog = 0; }
    const p = cport;
    cport = null;
    if (p) { try { p.disconnect(); } catch (_) {} }
    childActiveId = null;
    if (st.open) MS.core.close('frames');
  }

  function onChildMsg(m) {
    if (!m || typeof m !== 'object') return;
    cBackoff = 200;
    if (watchdog) { clearTimeout(watchdog); watchdog = 0; }
    switch (m.t) {
      case 'top-gone': childStop(); break;
      case 'state':
        if (!m.open) { childStop(); return; }
        // rate null: the top has not adopted one yet — report candidates, touch nothing.
        if (m.rate !== null && (!(m.rate > 0) || !isFinite(m.rate))) return;
        if (!st.open) MS.core.open({ rate: m.rate, pin: null });
        else if (m.rate !== null && MS.intent.get() && MS.intent.get().rate !== m.rate) MS.intent.update({ rate: m.rate });
        lastCands = ''; lastSnap = null;
        MS.core.render();
        break;
      case 'active':
        setChildActive(m.id);
        break;
      case 'cmd':
        if (!st.open) return;
        if (m.id !== childActiveId) setChildActive(m.id);
        MS.core.childCommand(m);
        break;
      case 'rects':
        lastCands = '';
        MS.core.render();
        break;
    }
  }
  function setChildActive(id) {
    childActiveId = typeof id === 'number' ? id : null;
    lastSnap = null;
    MS.core.recompute();
  }

  function candOf(e) {
    const el = e.el();
    const r = el && el.isConnected ? el.getBoundingClientRect() : null;
    const played = e.lastPlayAt > 0;
    const ready = el.readyState >= 1;
    return {
      id: e.id, kind: e.kind, via: e.via,
      width: r ? Math.round(r.width) : 0, height: r ? Math.round(r.height) : 0,
      rect: r ? { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) } : null,
      duration: enc(el.duration), paused: el.paused, ended: el.ended,
      lastPlayAt: e.lastPlayAt, ambient: e.ambient(), ready, rate: el.playbackRate,
      // class 4 of selectActive only: never-played ready elements
      area: !played && ready && el.paused ? Math.round(MS.registry.visibleArea(el)) : 0,
      src: tail(el.currentSrc),
    };
  }

  function snapOf(e) {
    const md = MS.core.localMedia(e);
    const el = e.el();
    if (!md || !el) return null;
    return {
      id: e.id, kind: md.kind, ready: md.ready, time: md.time, duration: enc(md.duration),
      range: md.range, live: md.live, buffered: md.buffered, paused: md.paused, ended: el.ended,
      atEnd: !!md.atEnd, gateHeld: !!st.gateHeld, rate: el.playbackRate,
      defaultRate: el.defaultPlaybackRate, preservesPitch: el.preservesPitch,
      contested: MS.reconcile.contested(e), src: tail(el.currentSrc),
    };
  }
  const SNAP_KEYS = ['id', 'kind', 'ready', 'duration', 'live', 'paused', 'ended', 'atEnd', 'gateHeld', 'rate', 'defaultRate', 'contested', 'src'];
  function snapChanged(a, b) {
    for (const k of SNAP_KEYS) if (a[k] !== b[k]) return true;
    return JSON.stringify(a.range) !== JSON.stringify(b.range) || JSON.stringify(a.buffered) !== JSON.stringify(b.buffered);
  }

  // Called from the child's render (every media/registry event) and clock (rAF while playing).
  function childPush(fromClock) {
    if (!cport || !st.open) return;
    const now = Date.now();
    if (!fromClock) {
      const list = MS.registry.all().filter((e) => e.local && e.el()).map(candOf);
      const key = JSON.stringify(list);
      if (key !== lastCands) {
        lastCands = key;
        childPost({ t: 'cands', list, href: location.href, nested: window.parent !== window.top, ts: now });
      }
    }
    const a = MS.core.activeEntry();
    if (!a) return;
    const s = snapOf(a);
    if (!s) return;
    let send = !lastSnap || snapChanged(s, lastSnap);
    if (!send) {
      const playing = !s.paused && !s.ended;
      if (playing) {
        const predicted = lastSnap.time + (now - lastSnapAt) / 1000 * lastSnap.rate;
        send = now - lastSnapAt >= SNAP_EVERY_MS || Math.abs(s.time - predicted) > 0.05;
      } else send = s.time !== lastSnap.time;
    }
    if (!send) return;
    s.ts = now;
    lastSnap = s; lastSnapAt = now;
    childPost(Object.assign({ t: 'snap' }, s));
  }

  // =====================================================================================

  MS.frames = {
    RemoteEntry,

    // ---- lifecycle hooks from boot.js ----
    opened() {
      watchLoads(true);
      if (CHILD) return;
      tWant = true; tBackoff = 200;
      topConnect();
      // Insurance against a hello that raced the top frame's own connect.
      helloTimer = setTimeout(() => { helloTimer = 0; if (st.open) topPost(stateMsg('all')); }, 300);
    },
    closed(reason) {
      watchLoads(false);
      if (CHILD) {
        if (reason !== 'frames') {    // closed locally (orphaning): drop the port too
          cWant = false;
          if (cTimer) { clearTimeout(cTimer); cTimer = 0; }
          if (watchdog) { clearTimeout(watchdog); watchdog = 0; }
          const p = cport; cport = null;
          if (p) { try { p.disconnect(); } catch (_) {} }
        }
        childActiveId = null;
        return;
      }
      tWant = false;
      topPost({ to: 'all', t: 'state', open: false, rate: 1 });
      const p = tport; tport = null;
      if (p) { try { p.disconnect(); } catch (_) {} }
      for (const t of [tTimer, sweepTimer, helloTimer]) if (t) clearTimeout(t);
      tTimer = sweepTimer = helloTimer = 0;
      known.clear(); sentActive.clear();
      lastActive = null;
    },
    teardown() {
      try { MS.frames.closed('orphan'); } catch (_) {}
    },

    // ---- top frame ----
    activeChanged(active, pinned) {
      lastActive = active; lastPinned = pinned;
      if (!tport) return;
      for (const f of known.keys()) sendActive(f);
    },
    broadcastRate(rate) { topPost({ to: 'all', t: 'state', open: true, rate }); },
    command(e, cmd) {
      if (!e || e.local) return;
      sendActive(e.frameId);
      topPost(Object.assign({ to: e.frameId, t: 'cmd', id: e.id }, cmd));
      if (cmd.c === 'seek' && e.snap && MS.finite(cmd.time)) {
        // Optimistic: show the target until the child's next snapshot lands.
        e.snap = Object.assign({}, e.snap, { time: cmd.time, ts: Date.now() });
      }
      MS.core.render();
    },
    remoteMedia(e) {
      const s = e.snap;
      if (!s) {
        const c = e.c || {};
        const d = dec(c.duration);
        return {
          kind: e.kind, ready: !!c.ready, time: 0, duration: d,
          range: MS.finite(d) && d > 0 ? { start: 0, end: d } : null, live: d === Infinity,
          buffered: [], paused: c.paused !== false, atEnd: false,
        };
      }
      return {
        kind: s.kind, ready: !!s.ready, time: extrapolate(s), duration: s.duration,
        range: s.range || null, live: !!s.live, buffered: s.buffered || [],
        paused: !!s.paused, atEnd: !!s.atEnd,
      };
    },
    remoteRate: (e) => { const x = e.cur(); return x ? x.rate : NaN; },
    remoteContested: (e) => !!(e.snap && e.snap.contested),
    rectFor(e) {
      const now = Date.now();
      if (now - rectsAskedAt > 150) { rectsAskedAt = now; topPost({ to: e.frameId, t: 'rects' }); }
      const r = e.c && e.c.rect;
      const fr = r && iframeFor(e.frameId);
      if (!fr) return null;
      const b = fr.getBoundingClientRect();
      const cs = getComputedStyle(fr);
      const x0 = b.x + fr.clientLeft + (parseFloat(cs.paddingLeft) || 0);
      const y0 = b.y + fr.clientTop + (parseFloat(cs.paddingTop) || 0);
      return { x: x0 + r.x, y: y0 + r.y, width: r.width, height: r.height };
    },
    remoteDebug(e) {
      const s = e.snap;
      if (!s) return null;
      return {
        ref: e.ref, kind: e.kind, src: s.src, currentTime: extrapolate(s), paused: s.paused, ended: s.ended,
        playbackRate: s.rate, defaultPlaybackRate: s.defaultRate, preservesPitch: s.preservesPitch,
      };
    },
    debug() {
      if (CHILD) return { child: true, connected: !!cport, activeId: childActiveId };
      return { connected: !!tport, frames: [...known.keys()] };
    },

    // ---- child frame ----
    childWake(open) {
      if (!open) { childStop(); return; }
      if (cWant) return;
      cWant = true; cBackoff = 200;
      childConnect();
    },
    childActive() {
      return childActiveId === null ? null : MS.registry.get(`0:${childActiveId}`);
    },
    childPush,
    forwardKey(key, phase) { childPost({ t: 'key', key, phase }); },
  };
})();
