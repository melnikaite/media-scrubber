// The bar: MS.ui.mount(controller) → view (docs/contracts.md §3).
// Renders the model it is given, calls the controller; never reads media elements.
(() => {
  'use strict';
  const MS = (globalThis.MediaScrubber = globalThis.MediaScrubber || {});
  MS.ui = MS.ui || {};

  const SVGNS = 'http://www.w3.org/2000/svg';
  const BAR_H = 52;
  const PILL_H = 36;
  const SNAP = 48;
  const IDLE_MS = 3000;
  const NEAR_PX = 64;
  const TICK_MIN_PX = 40;
  const TICK_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 18000, 36000];

  const ICON = {
    play: ['0 0 16 16', 'M5.5 3.5v9l7-4.5z', true],
    pause: ['0 0 16 16', 'M4.5 3h2.5v10H4.5zM9 3h2.5v10H9z', true],
    back: ['0 0 10 10', 'M8 1v8L1.5 5z', true],
    fwd: ['0 0 10 10', 'M2 1v8l6.5-4z', true],
    collapse: ['0 0 16 16', 'm4 6 4 4 4-4', false],
    expand: ['0 0 16 16', 'm4 10 4-4 4 4', false],
    close: ['0 0 16 16', 'm4.5 4.5 7 7M11.5 4.5l-7 7', false],
    restart: ['0 0 16 16', 'M3.5 8a4.5 4.5 0 1 0 1.4-3.3M3.5 2.5v2.7h2.7', false],
    pin: ['0 0 16 16', 'M8 10.5V15M5 1.5h6M6 1.5v4L3.5 9h9L10 5.5v-4', false],
  };

  // ---- pure helpers -------------------------------------------------------

  const pad2 = (n) => (n < 10 ? '0' : '') + n;

  // Tenths always, truncated (with a tiny epsilon so 2.3 stays 2.3 despite
  // binary floating point), m:ss.t under an hour, h:mm:ss.t beyond.
  function formatTime(t) {
    if (typeof t !== 'number' || !Number.isFinite(t)) return '--:--.-';
    if (t < 0) t = 0;
    const tt = Math.floor(t * 10 + 1e-6);
    const tenths = tt % 10;
    const s = Math.floor(tt / 10);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h ? `${h}:${pad2(m)}:${pad2(sec)}.${tenths}` : `${m}:${pad2(sec)}.${tenths}`;
  }
  function rateLabel(r) {
    return String(Math.round(r * 1000) / 1000);
  }
  function sameRate(a, b) { return Math.abs(a - b) < 1e-6; }
  function tickStep(pxPerS) {
    for (const s of TICK_STEPS) if (s * pxPerS >= TICK_MIN_PX) return s;
    return 0;
  }
  function stepAria(dir, label) {
    const what = label === '1f' ? 'one frame' : `${label} ${label === '1' ? 'second' : 'seconds'}`;
    return dir < 0 ? `Step back ${what}, Left arrow` : `Step forward ${what}, Right arrow`;
  }
  function kindGlyph(kind) { return kind === 'audio' ? '♪' : '▣'; }
  function candDesc(c, cap) {
    const k = c.kind === 'audio' ? 'audio' : 'video';
    const name = cap ? k[0].toUpperCase() + k.slice(1) : k;
    const size = c.kind !== 'audio' && c.width && c.height ? ` ${c.width}×${c.height}` : '';
    return `${name}${size} · ${formatTime(c.duration)}`;
  }

  MS.ui.formatTime = formatTime;
  MS.ui.tickStep = tickStep;

  // ---- DOM helpers (createElement / textContent only) --------------------

  function el(tag, cls, parent) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (parent) parent.appendChild(e);
    return e;
  }
  function icon(name, extraCls) {
    const [vb, d, fill] = ICON[name];
    const s = document.createElementNS(SVGNS, 'svg');
    s.setAttribute('viewBox', vb);
    s.setAttribute('aria-hidden', 'true');
    let c = fill ? 'fill' : '';
    if (extraCls) c += (c ? ' ' : '') + extraCls;
    if (c) s.setAttribute('class', c);
    const p = document.createElementNS(SVGNS, 'path');
    p.setAttribute('d', d);
    s.appendChild(p);
    return s;
  }
  function button(cls, label, parent) {
    const b = el('button', cls, parent);
    b.type = 'button';
    b.tabIndex = -1;
    b.setAttribute('aria-label', label);
    return b;
  }
  function setText(node, s) {
    if (node._t !== s) { node._t = s; node.textContent = s; }
  }
  function setAttr(node, k, v) {
    const key = '_a_' + k;
    if (node[key] !== v) { node[key] = v; node.setAttribute(k, v); }
  }
  function setCls(node, cls, on) {
    const key = '_c_' + cls;
    if (node[key] !== on) { node[key] = on; node.classList.toggle(cls, on); }
  }
  function setStyle(node, k, v) {
    const key = '_s_' + k;
    if (node[key] !== v) { node[key] = v; node.style.setProperty(k, v); }
  }
  function rectOf(node) {
    if (!node || !node.isConnected) return null;
    const r = node.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return null;
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }

  // ---- mount --------------------------------------------------------------

  MS.ui.mount = function mount(controller) {
    const H = MS.ui.createHost();
    const root = H.root;
    const ctl = controller;
    const call = (name, ...args) => {
      try { return ctl && typeof ctl[name] === 'function' ? ctl[name](...args) : undefined; } catch (e) { console.error(e); }
      return undefined;
    };

    let model = null;
    let destroyed = false;
    let closing = false;
    let vw = window.innerWidth;
    let vh = window.innerHeight;
    let barTop = vh - BAR_H;       // current top edge of the bar line, px
    let railW = vw;
    let scrub = null;              // {id, spp, left, startTime, baseX, baseT, shift, t, range}
    let drag = null;               // {id, startY, startTop, top, moved, zone}
    let localPlacement = null;     // placement applied locally until the model catches up
    let menu = null;               // null | 'media'
    let chipHover = false;
    let outlineRef = null;         // candidate ref being outlined (row hover), else active
    let outlineRaf = 0;
    let dimmed = false;
    let restTimer = 0;
    let nearRaf = 0;
    let nearY = 0;
    let settleTimer = 0;
    let toastTimer = 0;
    let hover = null;              // {x} while the pointer is over the rail (not scrubbing)
    const memo = Object.create(null);
    const changed = (k, v) => (memo[k] === v ? false : ((memo[k] = v), true));

    // ---- build ----
    const bar = el('div', 'bar dock-bottom', root);
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', 'Media controls');

    const rail = el('div', 'rail', bar);
    rail.setAttribute('role', 'slider');
    rail.setAttribute('aria-label', 'Seek');
    rail.setAttribute('aria-valuemin', '0');
    rail.setAttribute('aria-valuemax', '0');
    rail.setAttribute('aria-valuenow', '0');
    rail.tabIndex = -1;
    const track = el('div', 'track', rail);
    const bufs = el('div', 'bufs', rail);
    const played = el('div', 'played', rail);
    const ticks = el('div', 'ticks', rail);
    const gw = el('div', 'hw gw', rail);
    el('div', 'ghost', gw);
    const hw = el('div', 'hw', rail);
    el('div', 'head', hw);
    el('div', 'knob', hw);
    void track;

    const row = el('div', 'row', bar);
    const restartBtn = button('restart', 'Restart from the beginning', row);
    restartBtn.appendChild(icon('restart'));
    const stepBack = button('step back', stepAria(-1, '0.1'), row);
    stepBack.appendChild(icon('back', 'tri'));
    const backN = el('span', 'n', stepBack);
    const playBtn = button('play', 'Play, Space', row);
    let playIcon = icon('play');
    playBtn.appendChild(playIcon);
    const stepFwd = button('step fwd', stepAria(1, '0.1'), row);
    const fwdN = el('span', 'n', stepFwd);
    stepFwd.appendChild(icon('fwd', 'tri'));
    const readout = el('div', 'readout', row);
    const rCur = el('span', 'cur', readout);
    const rDur = el('span', 'dur', readout);
    const spacer = el('div', 'spacer', row);
    const speed = el('div', 'speed', row);
    const chips = new Map(); // label -> button
    // Extra chip for an adopted non-preset rate (e.g. 1.25), after the presets.
    const extra = button('chip extra hidden', 'Speed', speed);
    const extraTxt = el('span', '', extra);
    el('span', 'dot', extra);
    const mediaBtn = button('media dim hidden', 'Choose media', row);
    const mediaPin = icon('pin', 'pin');
    const mediaTxt = el('span', '', mediaBtn);
    const collapseBtn = button('collapse dim', 'Collapse', row);
    collapseBtn.appendChild(icon('collapse'));
    const closeBtn = button('close dim', 'Close Media Scrubber, Alt+Shift+M', row);
    closeBtn.appendChild(icon('close'));

    const tip = el('div', 'tip', root);
    const snapTop = el('div', 'snap top', root);
    const snapBottom = el('div', 'snap bottom', root);
    const menuEl = el('div', 'menu', root);
    menuEl.setAttribute('role', 'menu');
    const outline = el('div', 'outline', root);
    const olabel = el('div', 'olabel', root);

    const pill = el('div', 'pill', root);
    pill.setAttribute('role', 'region');
    pill.setAttribute('aria-label', 'Media controls, collapsed');
    const pPlay = button('play', 'Play, Space', pill);
    let pPlayIcon = icon('play');
    pPlay.appendChild(pPlayIcon);
    const pCur = el('span', 'pcur', pill);
    const pRate = el('span', 'prate', pill);
    const pExpand = button('expand dim', 'Expand', pill);
    pExpand.appendChild(icon('expand'));
    const pProg = el('div', 'prog', pill);

    // ---- geometry ----
    function effPlacement() {
      if (localPlacement) return localPlacement;
      return (model && model.placement) || { dock: 'bottom', y: null };
    }
    function placementTop(p) {
      if (p.dock === 'top') return 0;
      if (p.dock === 'free' && typeof p.y === 'number') {
        return Math.max(0, Math.min(vh - BAR_H, Math.round(p.y * vh)));
      }
      return vh - BAR_H;
    }

    function renderLayout() {
      const collapsed = !!(model && model.collapsed);
      const fs = !!(model && model.fullscreen);
      let dock; let top;
      if (drag && drag.moved) {
        dock = 'free'; top = drag.top;
      } else {
        const p = effPlacement();
        dock = p.dock === 'top' || p.dock === 'free' ? p.dock : 'bottom';
        top = placementTop(p);
        if (dock === 'free' && top >= vh - BAR_H) dock = 'bottom';
      }
      barTop = top;
      const key = `${collapsed}|${dock}|${top}|${vh}|${fs}`;
      if (!changed('layout', key)) return;
      setCls(bar, 'dock-bottom', dock === 'bottom');
      setCls(bar, 'dock-top', dock === 'top');
      setCls(bar, 'dock-free', dock === 'free');
      setCls(bar, 'fs', fs);
      setCls(pill, 'fs', fs);
      if (dock === 'free') { setStyle(bar, 'top', top + 'px'); setStyle(bar, 'bottom', 'auto'); } else if (dock === 'top') { setStyle(bar, 'top', '0px'); setStyle(bar, 'bottom', 'auto'); } else { setStyle(bar, 'top', (vh - BAR_H) + 'px'); setStyle(bar, 'bottom', 'auto'); }
      setCls(bar, 'hidden', collapsed);
      setCls(pill, 'show', collapsed);
      const pTop = dock === 'top' ? 8 : dock === 'bottom' ? vh - PILL_H - 8 : top + (BAR_H - PILL_H) / 2;
      setStyle(pill, 'top', pTop + 'px');
      if (collapsed) closeMenu();
    }

    // ---- media/rail/readout ----
    function railRange() {
      const m = model && model.media;
      if (!m || !m.ready || !m.range) return null;
      const r = m.range;
      if (!(Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start)) return null;
      return r;
    }

    function renderMediaState() {
      const m = model && model.media;
      const range = railRange();
      const enabled = !!range;
      setCls(rail, 'disabled', !enabled);
      setAttr(rail, 'aria-disabled', enabled ? 'false' : 'true');
      const noMedia = !m;
      restartBtn.disabled = noMedia || !enabled;
      stepBack.disabled = noMedia || !enabled;
      stepFwd.disabled = noMedia || !enabled;
      playBtn.disabled = noMedia;
      pPlay.disabled = noMedia;
      if (range && changed('range', `${range.start}|${range.end}|${railW}`)) {
        setAttr(rail, 'aria-valuemin', String(Math.floor(range.start * 10) / 10));
        setAttr(rail, 'aria-valuemax', String(Math.floor(range.end * 10) / 10));
        renderTicks(range);
      }
      if (!range) changed('range', '');
      // fixed readout width from the duration's format
      const durStr = m ? formatTime(m.duration) : '';
      if (changed('curW', durStr)) {
        const w = m && m.ready && !m.live ? Math.max(5, durStr.length - 1.2) + 'ch' : 'auto';
        setStyle(rCur, 'min-width', w);
        setStyle(pCur, 'min-width', w);
      }
    }

    function renderTicks(range) {
      const len = range.end - range.start;
      const pxPerS = railW / len;
      const step = tickStep(pxPerS);
      if (!step) { setStyle(ticks, 'background-image', 'none'); return; }
      const spacing = step * pxPerS;
      const first = Math.ceil(range.start / step - 1e-9) * step;
      const off = (first - range.start) * pxPerS;
      setStyle(ticks, 'background-image', 'linear-gradient(to right, rgba(255,255,255,.25) 0 1px, transparent 1px)');
      setStyle(ticks, 'background-size', `${spacing}px 4px`);
      setStyle(ticks, 'background-position', `${off}px 0`);
    }

    function renderBuffered() {
      const m = model && model.media;
      const range = railRange();
      const b = (m && range && m.buffered) || [];
      const key = range ? b.map((x) => x[0].toFixed(2) + '-' + x[1].toFixed(2)).join(',') + '|' + range.start + '|' + range.end : '';
      if (!changed('buf', key)) return;
      bufs.replaceChildren();
      if (!range) return;
      const len = range.end - range.start;
      for (const [s, e] of b) {
        const a = Math.max(0, (s - range.start) / len); const z = Math.min(1, (e - range.start) / len);
        if (z <= a) continue;
        const d = el('div', '', bufs);
        d.style.setProperty('left', (a * 100) + '%');
        d.style.setProperty('width', ((z - a) * 100) + '%');
      }
    }

    function renderTime() {
      const m = model && model.media;
      const range = railRange();
      let curS; let durS;
      if (!m) { curS = 'Waiting for media…'; durS = ''; } else if (!m.ready) { curS = 'Loading…'; durS = ''; } else if (m.live && !range) { curS = 'LIVE'; durS = ''; } else {
        const t = scrub ? scrub.t : m.time;
        if (m.live && range) { curS = '−' + formatTime(range.end - t); durS = ' / LIVE'; } else {
          curS = formatTime(t); durS = ' / ' + formatTime(m.duration);
        }
      }
      setText(rCur, curS);
      setText(rDur, durS);
      setCls(readout, 'accent', !!scrub);
      const pc = m && m.ready && !(m.live && !range) ? curS : curS;
      setText(pCur, pc);
      let p = 0;
      if (range) {
        const t = scrub ? scrub.t : m.time;
        p = Math.max(0, Math.min(1, (t - range.start) / (range.end - range.start)));
        if (changed('now', formatTime(t))) {
          setAttr(rail, 'aria-valuenow', String(Math.floor(t * 10 + 1e-6) / 10));
          setAttr(rail, 'aria-valuetext', m.live ? curS : `${formatTime(t)} of ${formatTime(m.duration)}`);
        }
      }
      if (changed('p', p)) {
        played.style.transform = `scaleX(${p})`;
        hw.style.transform = `translateX(${p * 100}%)`;
        pProg.style.transform = `scaleX(${p})`;
      }
      if (scrub) placeTip(scrub.left + p * railW, curS, false);
    }

    function renderPlay() {
      const m = model && model.media;
      const playing = !!(m && !m.paused && !m.atEnd);
      if (!changed('playing', playing)) return;
      const ni = icon(playing ? 'pause' : 'play');
      playBtn.replaceChild(ni, playIcon); playIcon = ni;
      const np = icon(playing ? 'pause' : 'play');
      pPlay.replaceChild(np, pPlayIcon); pPlayIcon = np;
      const lab = playing ? 'Pause, Space' : 'Play, Space';
      setAttr(playBtn, 'aria-label', lab);
      setAttr(pPlay, 'aria-label', lab);
    }

    function renderSteps() {
      const st = (model && model.step) || { back: '0.1', fwd: '0.1' };
      const hot = (model && model.stepHot) || {};
      setText(backN, String(st.back));
      setText(fwdN, String(st.fwd));
      setCls(stepBack, 'hot', !!hot.back);
      setCls(stepFwd, 'hot', !!hot.fwd);
      setAttr(stepBack, 'aria-label', stepAria(-1, String(st.back)));
      setAttr(stepFwd, 'aria-label', stepAria(1, String(st.fwd)));
    }

    function renderSpeed() {
      const presets = (model && model.presets) || [0.5, 0.75, 1];
      const rate = model ? model.rate : 1;
      const contested = !!(model && model.rateContested);
      const pk = presets.join(',');
      if (changed('presets', pk)) {
        for (const b of chips.values()) b.remove();
        chips.clear();
        for (const r of presets) {
          const lab = rateLabel(r);
          const b = button('chip preset', `Speed ${lab}`, null);
          el('span', '', b).textContent = lab;
          el('span', 'dot', b);
          b.addEventListener('click', () => { closeMenu(); call('setRate', r); });
          speed.insertBefore(b, extra);
          chips.set(lab, b);
        }
      }
      if (!changed('speed', `${pk}|${rate}|${contested}`)) return;
      let isPreset = false;
      for (const r of presets) {
        const on = sameRate(r, rate);
        if (on) isPreset = true;
        const b = chips.get(rateLabel(r));
        setCls(b, 'on', on);
        setCls(b, 'contested', on && contested);
        setAttr(b, 'aria-pressed', on ? 'true' : 'false');
      }
      setCls(extra, 'hidden', isPreset);
      setCls(extra, 'on', !isPreset);
      setCls(extra, 'contested', !isPreset && contested);
      setAttr(extra, 'aria-pressed', isPreset ? 'false' : 'true');
      if (!isPreset) {
        setText(extraTxt, rateLabel(rate));
        setAttr(extra, 'aria-label', `Speed ${rateLabel(rate)}`);
      }
      pRate.textContent = `· ${rateLabel(rate)}`;
    }

    function renderMediaChip() {
      const cands = (model && model.candidates) || [];
      const pinned = !!(model && model.pinned);
      const show = cands.length >= 2 || pinned;
      const idx = cands.findIndex((c) => c.active);
      const act = cands[idx];
      const key = `${show}|${pinned}|${idx}|${cands.length}|${act ? act.kind : ''}`;
      if (changed('mchip', key)) {
        setCls(mediaBtn, 'hidden', !show);
        if (!show && (chipHover || menu === 'media')) { chipHover = false; closeMenu(); }
        setText(mediaTxt, `${act ? kindGlyph(act.kind) : '▣'} ${idx >= 0 ? idx + 1 : '–'}/${cands.length}`);
        if (pinned && !mediaPin.isConnected) mediaBtn.insertBefore(mediaPin, mediaTxt);
        if (!pinned && mediaPin.isConnected) mediaPin.remove();
        setAttr(mediaBtn, 'aria-label', `Choose media, ${idx >= 0 ? idx + 1 : 0} of ${cands.length}${pinned ? ', pinned' : ', automatic'}`);
      }
      if (menu === 'media') {
        const mk = cands.map((c) => `${c.ref}|${c.active}|${c.paused}|${c.width}|${c.height}|${c.duration}`).join(',') + pinned;
        if (changed('mmenu', mk)) buildMediaMenu();
      }
    }

    // ---- update ----
    function update(m) {
      if (destroyed || closing || !m) return;
      if (localPlacement && m.placement && m.placement.dock === localPlacement.dock &&
          (m.placement.dock !== 'free' || Math.abs((m.placement.y || 0) - (localPlacement.y || 0)) < 1e-4)) {
        localPlacement = null;
      }
      model = m;
      renderLayout();
      renderMediaState();
      renderBuffered();
      renderTime();
      renderPlay();
      renderSteps();
      renderSpeed();
      renderMediaChip();
    }

    // ---- scrubbing ----
    function clampT(t, r) { return Math.max(r.start, Math.min(r.end, t)); }

    rail.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const range = railRange();
      if (!range || scrub) return;
      closeMenu();
      const r = rail.getBoundingClientRect();
      railW = r.width || railW;
      const spp = (range.end - range.start) / railW;
      const t0 = clampT(range.start + (e.clientX - r.left) * spp, range);
      scrub = { id: e.pointerId, left: r.left, spp, startTime: model.media.time, baseX: e.clientX, baseT: t0,
        shift: !!e.shiftKey, t: t0, range, lastX: e.clientX };
      try { rail.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      setCls(bar, 'scrub', true);
      hideTipHover();
      wake();
      call('seekTo', t0, false);
      renderTime();
    });
    rail.addEventListener('pointermove', (e) => {
      if (scrub && e.pointerId === scrub.id) {
        if (!!e.shiftKey !== scrub.shift) { scrub.baseT = scrub.t; scrub.baseX = scrub.lastX; scrub.shift = !!e.shiftKey; }
        const f = scrub.shift ? 0.1 : 1;
        const t = clampT(scrub.baseT + (e.clientX - scrub.baseX) * scrub.spp * f, scrub.range);
        scrub.lastX = e.clientX;
        if (t !== scrub.t) { scrub.t = t; call('seekTo', t, false); renderTime(); }
        return;
      }
      const range = railRange();
      if (!range) { hideTipHover(); return; }
      if (!hover) { const r = rail.getBoundingClientRect(); railW = r.width || railW; hover = { left: r.left }; }
      const x = e.clientX - hover.left;
      const t = range.start + (x / railW) * (range.end - range.start);
      gw.style.transform = `translateX(${x}px)`;
      placeTip(e.clientX, formatTime(clampT(t, range)), true);
    });
    rail.addEventListener('pointerleave', () => { hover = null; if (!scrub) hideTipHover(); });
    function endScrub(e, final) {
      if (!scrub || (e && e.pointerId !== scrub.id)) return;
      const s = scrub;
      scrub = null;
      setCls(bar, 'scrub', false);
      tip.style.display = 'none';
      if (final) call('seekTo', s.t, true);
      try { rail.releasePointerCapture(s.id); } catch (_) { /* ignore */ }
      renderTime();
      arm();
    }
    rail.addEventListener('pointerup', (e) => endScrub(e, true));
    rail.addEventListener('pointercancel', (e) => endScrub(e, true));
    rail.addEventListener('lostpointercapture', (e) => endScrub(e, true));

    let wheelAcc = 0; let wheelT = 0;
    rail.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (!railRange()) return;
      const d = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      if (!d) return;
      const now = performance.now();
      if (now - wheelT > 250) wheelAcc = 0;
      wheelT = now;
      const px = e.deltaMode === 0 ? d : d * 40;
      wheelAcc += px;
      if (Math.abs(wheelAcc) >= 40 || e.deltaMode !== 0) {
        wheelAcc = 0;
        wake();
        call('wheelStep', d > 0 ? 1 : -1);
      }
    }, { passive: false });

    function placeTip(x, text, isHover) {
      setText(tip, text);
      setCls(tip, 'hover', isHover);
      const below = barTop < 30;
      tip.style.left = Math.max(24, Math.min(vw - 24, x)) + 'px';
      tip.style.top = (below ? barTop + BAR_H + 6 : barTop - 26) + 'px';
      tip.style.display = 'block';
    }
    function hideTipHover() { if (!scrub) tip.style.display = 'none'; }

    // ---- buttons ----
    function holdButton(btn, dir) {
      let held = null;
      btn.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || btn.disabled) return;
        closeMenu();
        held = e.pointerId;
        try { btn.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
        wake();
        call('stepPress', dir);
      });
      const rel = (e) => {
        if (held === null || e.pointerId !== held) return;
        held = null;
        call('stepRelease', dir);
      };
      btn.addEventListener('pointerup', rel);
      btn.addEventListener('pointercancel', rel);
      btn.addEventListener('lostpointercapture', rel);
    }
    holdButton(stepBack, -1);
    holdButton(stepFwd, 1);

    const onPlay = (e) => {
      if (e.button !== 0 || !(model && model.media)) return;
      closeMenu();
      wake();
      call('togglePlay');
    };
    playBtn.addEventListener('pointerdown', onPlay);
    pPlay.addEventListener('pointerdown', onPlay);

    restartBtn.addEventListener('click', () => {
      if (!(model && model.media)) return;
      closeMenu();
      wake();
      call('restart');
    });
    mediaBtn.addEventListener('click', () => { if (menu === 'media') closeMenu(); else openMediaMenu(); });
    mediaBtn.addEventListener('pointerenter', () => { chipHover = true; outlineRef = null; startOutline(); });
    mediaBtn.addEventListener('pointerleave', () => { chipHover = false; });
    collapseBtn.addEventListener('click', () => { closeMenu(); call('setCollapsed', true); });
    closeBtn.addEventListener('click', () => { closeMenu(); call('close'); });
    pill.addEventListener('click', (e) => {
      if (e.target === pPlay || pPlay.contains(e.target)) return;
      call('setCollapsed', false);
    });

    // ---- menus ----
    function positionMenu(anchor) {
      const a = anchor.getBoundingClientRect();
      menuEl.style.visibility = 'hidden';
      setCls(menuEl, 'open', true);
      const mr = menuEl.getBoundingClientRect();
      let left = Math.min(vw - mr.width - 8, a.right - mr.width);
      left = Math.max(8, left);
      const above = barTop - mr.height - 6;
      const top = above >= 4 ? above : barTop + BAR_H + 6;
      menuEl.style.left = left + 'px';
      menuEl.style.top = top + 'px';
      menuEl.style.visibility = '';
    }
    function menuItem(parts, on, onChoose, onHover) {
      const it = el('div', 'mi' + (on ? ' on' : ''), menuEl);
      it.setAttribute('role', 'menuitemradio');
      it.setAttribute('aria-checked', on ? 'true' : 'false');
      el('span', 'mark', it).textContent = on ? '●' : '';
      const txt = el('span', '', it);
      el('span', '', txt).textContent = parts[0];
      if (parts[1]) el('span', 'muted', txt).textContent = parts[1];
      it.addEventListener('click', onChoose);
      if (onHover) {
        it.addEventListener('pointerenter', () => onHover(true));
        it.addEventListener('pointerleave', () => onHover(false));
      }
      return it;
    }
    function buildMediaMenu() {
      menuEl.replaceChildren();
      const cands = (model && model.candidates) || [];
      const pinned = !!(model && model.pinned);
      menuItem(['Automatic — follow what plays'], !pinned, () => { closeMenu(); call('pin', null); });
      el('div', 'msep', menuEl);
      for (const c of cands) {
        menuItem([`${kindGlyph(c.kind)} ${candDesc(c, true)}`, ` · ${c.paused ? 'paused' : 'playing'}`],
          pinned && c.active,
          () => { closeMenu(); call('pin', c.ref); },
          (on) => { outlineRef = on ? c.ref : null; });
      }
    }
    function openMediaMenu() {
      closeMenu();
      menu = 'media';
      memo.mmenu = undefined;
      renderMediaChip();
      menuEl.setAttribute('aria-label', 'Media');
      positionMenu(mediaBtn);
      setAttr(mediaBtn, 'aria-expanded', 'true');
      startOutline();
      wake();
    }
    function closeMenu() {
      if (!menu) return false;
      menu = null;
      outlineRef = null;
      setCls(menuEl, 'open', false);
      menuEl.replaceChildren();
      setAttr(mediaBtn, 'aria-expanded', 'false');
      arm();
      return true;
    }
    // Pointer down anywhere outside the open menu (and outside its toggle) closes it.
    root.addEventListener('pointerdown', (e) => {
      if (!menu) return;
      const t = e.target;
      if (menuEl.contains(t) || (menu === 'media' && mediaBtn.contains(t))) return;
      closeMenu();
    }, true);
    const onWinDown = (e) => { if (menu && e.target !== H.host) closeMenu(); };
    window.addEventListener('pointerdown', onWinDown, true);

    // ---- outline of the controlled element ----
    function startOutline() {
      if (outlineRaf) return;
      const tick = () => {
        outlineRaf = 0;
        if (destroyed || closing || !(chipHover || menu === 'media')) { outline.style.display = 'none'; olabel.style.display = 'none'; return; }
        const cands = (model && model.candidates) || [];
        const act = cands.find((c) => c.active);
        const ref = outlineRef || (act && act.ref);
        const c = cands.find((x) => x.ref === ref);
        if (!c) { outline.style.display = 'none'; olabel.style.display = 'none'; } else {
          const r = call('candidateRect', ref);
          const label = (c.active ? 'Controlling · ' : '') + candDesc(c, false);
          setText(olabel, label);
          olabel.style.display = 'block';
          if (r && r.width > 0 && r.height > 0) {
            outline.style.display = 'block';
            outline.style.left = (r.x - 2) + 'px';
            outline.style.top = (r.y - 2) + 'px';
            outline.style.width = (r.width + 4) + 'px';
            outline.style.height = (r.height + 4) + 'px';
            const ly = r.y - 26 >= 0 ? r.y - 26 : r.y + 4;
            olabel.style.left = Math.max(0, r.x - 2) + 'px';
            olabel.style.top = ly + 'px';
          } else {
            outline.style.display = 'none';
            const b = mediaBtn.getBoundingClientRect();
            olabel.style.left = Math.max(4, Math.min(vw - 300, b.left - 60)) + 'px';
            olabel.style.top = (barTop > 40 ? barTop - 28 : barTop + BAR_H + 6) + 'px';
          }
        }
        outlineRaf = requestAnimationFrame(tick);
      };
      outlineRaf = requestAnimationFrame(tick);
    }

    // ---- drag / dock ----
    const isHandle = (t) => t === row || t === spacer || t === readout || readout.contains(t);
    row.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !isHandle(e.target)) return;
      closeMenu();
      drag = { id: e.pointerId, startY: e.clientY, startTop: barTop, top: barTop, moved: false, zone: null };
      try { row.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      setCls(bar, 'drag', true);
      wake();
    });
    row.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dy = e.clientY - drag.startY;
      if (!drag.moved && Math.abs(dy) < 3) return;
      drag.moved = true;
      drag.top = Math.max(0, Math.min(vh - BAR_H, drag.startTop + dy));
      drag.zone = drag.top <= SNAP ? 'top' : drag.top + BAR_H >= vh - SNAP ? 'bottom' : null;
      setCls(snapTop, 'show', true); setCls(snapBottom, 'show', true);
      setCls(snapTop, 'hot', drag.zone === 'top'); setCls(snapBottom, 'hot', drag.zone === 'bottom');
      setCls(bar, 'settle', false);
      renderLayout();
    });
    function endDrag(e) {
      if (!drag || (e && e.pointerId !== drag.id)) return;
      const d = drag;
      drag = null;
      setCls(bar, 'drag', false);
      setCls(snapTop, 'show', false); setCls(snapBottom, 'show', false);
      if (d.moved) {
        const p = d.zone ? { dock: d.zone, y: null } : { dock: 'free', y: d.top / vh };
        localPlacement = p;
        if (d.zone) {
          setCls(bar, 'settle', true);
          clearTimeout(settleTimer);
          settleTimer = setTimeout(() => setCls(bar, 'settle', false), 200);
        }
        memo.layout = undefined;
        renderLayout();
        call('setPlacement', p);
      }
      arm();
    }
    row.addEventListener('pointerup', endDrag);
    row.addEventListener('pointercancel', endDrag);
    row.addEventListener('lostpointercapture', endDrag);
    row.addEventListener('dblclick', (e) => {
      if (!isHandle(e.target)) return;
      localPlacement = { dock: 'bottom', y: null };
      memo.layout = undefined;
      renderLayout();
      call('setPlacement', { dock: 'bottom', y: null });
    });

    // ---- resize ----
    const onResize = () => {
      vw = window.innerWidth; vh = window.innerHeight;
      memo.layout = undefined;
      renderLayout();
      renderSpeed();
      if (menu) closeMenu();
    };
    window.addEventListener('resize', onResize);
    const ro = new ResizeObserver((entries) => {
      for (const en of entries) {
        const w = en.contentRect.width;
        if (w && w !== railW) { railW = w; memo.range = undefined; if (model) { renderMediaState(); } }
      }
    });
    ro.observe(rail);

    // ---- rest dimming ----
    function applyDim() {
      setCls(bar, 'rest', dimmed);
      setCls(pill, 'rest', dimmed);
    }
    function arm() {
      if (destroyed || closing) return;
      clearTimeout(restTimer);
      restTimer = setTimeout(onIdle, IDLE_MS);
    }
    function onIdle() {
      restTimer = 0;
      if (destroyed || closing) return;
      if (scrub || drag || menu) { arm(); return; }
      dimmed = true;
      applyDim();
    }
    function wake() {
      if (dimmed) { dimmed = false; applyDim(); }
      arm();
    }
    const onWinMove = (e) => {
      nearY = e.clientY;
      if (nearRaf) return;
      nearRaf = requestAnimationFrame(() => {
        nearRaf = 0;
        const collapsed = !!(model && model.collapsed);
        const top = collapsed ? parseFloat(pill.style.top) || barTop : barTop;
        const h = collapsed ? PILL_H : BAR_H;
        if (nearY >= top - NEAR_PX && nearY <= top + h + NEAR_PX) wake();
      });
    };
    window.addEventListener('pointermove', onWinMove, { capture: true, passive: true });
    arm();

    // ---- lifecycle ----
    function teardownListeners() {
      clearTimeout(restTimer); clearTimeout(settleTimer); clearTimeout(toastTimer);
      if (nearRaf) cancelAnimationFrame(nearRaf);
      if (outlineRaf) cancelAnimationFrame(outlineRaf);
      nearRaf = outlineRaf = 0;
      window.removeEventListener('pointermove', onWinMove, true);
      window.removeEventListener('pointerdown', onWinDown, true);
      window.removeEventListener('resize', onResize);
      ro.disconnect();
    }
    function destroy() {
      if (destroyed) return;
      destroyed = true;
      teardownListeners();
      H.destroy();
    }

    let toastEl = null;
    function closeWithToast(ms, onUndo) {
      if (destroyed || closing) return;
      closing = true;
      scrub = null; drag = null; menu = null;
      teardownListeners();
      for (const n of [bar, pill, tip, snapTop, snapBottom, menuEl, outline, olabel]) n.remove();
      toastEl = el('div', 'toast', root);
      toastEl.setAttribute('role', 'status');
      el('span', '', toastEl).textContent = 'Media Scrubber closed — reopen with the toolbar icon or Alt+Shift+M';
      const undo = button('undo', 'Undo, reopen Media Scrubber', toastEl);
      undo.textContent = 'Undo';
      undo.addEventListener('click', () => {
        clearTimeout(toastTimer);
        destroy();
        if (typeof onUndo === 'function') onUndo();
      });
      toastTimer = setTimeout(destroy, typeof ms === 'number' ? ms : 5000);
    }

    function handleEscape() {
      if (destroyed || closing) return false;
      if (scrub) {
        const s = scrub;
        scrub = null;
        setCls(bar, 'scrub', false);
        tip.style.display = 'none';
        call('seekTo', s.startTime, true);
        try { rail.releasePointerCapture(s.id); } catch (_) { /* ignore */ }
        renderTime();
        arm();
        return true;
      }
      if (menu) { closeMenu(); return true; }
      return false;
    }

    function getDebug() {
      const alive = !destroyed;
      const speedRects = {};
      for (const [k, b] of chips) speedRects[k] = alive ? rectOf(b) : null;
      speedRects.extra = alive && !extra.classList.contains('hidden') ? rectOf(extra) : null;
      return {
        hostPresent: alive && H.host.isConnected,
        popoverOpen: alive && H.isOpen(),
        collapsed: !!(model && model.collapsed),
        dimmed: alive && !closing && dimmed,
        scrubbing: !!scrub,
        menu,
        readout: closing || destroyed ? '' : (rCur.textContent + rDur.textContent),
        stepLabels: { back: backN.textContent, fwd: fwdN.textContent },
        rects: {
          bar: alive && !closing ? rectOf(bar) : null,
          rail: alive && !closing ? rectOf(rail) : null,
          play: alive && !closing ? rectOf(playBtn) : null,
          restart: alive && !closing ? rectOf(restartBtn) : null,
          stepBack: alive && !closing ? rectOf(stepBack) : null,
          stepFwd: alive && !closing ? rectOf(stepFwd) : null,
          speed: speedRects,
          media: alive && !closing ? rectOf(mediaBtn) : null,
          collapse: alive && !closing ? rectOf(collapseBtn) : null,
          close: alive && !closing ? rectOf(closeBtn) : null,
          pill: alive && !closing ? rectOf(pill) : null,
          pillPlay: alive && !closing ? rectOf(pPlay) : null,
          menu: alive && menu ? rectOf(menuEl) : null,
          outline: alive && !closing ? rectOf(outline) : null,
          toast: alive && toastEl ? rectOf(toastEl) : null,
          toastUndo: alive && toastEl ? rectOf(toastEl.querySelector('button')) : null,
        },
        menuItems: alive && menu ? Array.from(menuEl.querySelectorAll('.mi')).map((n) => ({ text: n.textContent, rect: rectOf(n) })) : [],
        outlineLabel: alive && olabel.isConnected && olabel.style.display === 'block' ? olabel.textContent : null,
      };
    }

    return {
      update,
      noteActivity: wake,
      handleEscape,
      closeWithToast,
      destroy,
      getDebug,
    };
  };
})();
