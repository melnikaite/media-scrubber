// Generic playphrase-like reels player (DESIGN §1):
// - 3 stacked <video>s at the identical rect, visibility via ANCESTOR opacity + z-index
// - a NEW <video> element per preload slot on every advance (old one removed)
// - advance on `ended`, and for clip-3s the page pauses itself at
//   currentTime >= duration - 0.05 (checked on timeupdate and on a page rAF) BEFORE `ended`
// - React-like re-assert: if (v.playbackRate !== 1) v.playbackRate = 1 on every
//   timeupdate and loadstart (also defaultPlaybackRate), plus ~10 ms after any ratechange
(() => {
  const t = window.__t;
  const CLIPS = ['clip-5s.webm', 'clip-3s.webm', 'clip-2s.webm'];
  const EARLY = 'clip-3s.webm';
  const PAUSE_ADVANCE = new URLSearchParams(location.search).has('pauseadvance');
  // Opt-in (?earlyms=N): EVERY clip ends by the page's own detection once less than N ms of media
  // remain (checked on timeupdate and on the page rAF): pause + advance('early-ms'). Models a
  // site that acts earlier than the extension's default stop margin (DESIGN §6.13, learning).
  const EARLY_MS = Number(new URLSearchParams(location.search).get('earlyms')) || 0;
  const stage = document.getElementById('stage');
  stage.style.cssText = 'position:relative;width:640px;height:360px;';
  t.siteRateWrites = 0;
  t.clipsStarted = [];      // {clip, at}
  t.advances = [];          // {from, via: 'ended'|'early'|'early-pause'|'button'|'key', at}
  t.rateSeen = [];          // per started clip: {clip, min, max} of playbackRate seen at timeupdate
  t.created = 0;
  let index = 0;            // playlist position of the current clip
  const slots = [];         // 3 wrappers; slot (index % 3) is current

  const clipOf = (i) => CLIPS[i % CLIPS.length];
  const assert1 = (v) => {
    if (v.playbackRate !== 1) { v.playbackRate = 1; t.siteRateWrites++; }
    if (v.defaultPlaybackRate !== 1) { v.defaultPlaybackRate = 1; t.siteRateWrites++; }
  };

  function makeClip(i) {
    const clip = clipOf(i);
    const v = t.makeVideo(t.MEDIA + clip, { width: 640, height: 360 });
    v.style.cssText = 'position:absolute;left:0;top:0;width:640px;height:360px;';
    v.dataset.clip = clip;
    v.dataset.i = String(i);
    t.created++;
    t.track(v, 'reel' + i);
    v.addEventListener('loadstart', () => assert1(v));
    v.addEventListener('ratechange', () => setTimeout(() => assert1(v), 10));
    v.addEventListener('timeupdate', () => {
      if (Number(v.dataset.i) !== index) return;
      const seen = t.rateSeen[t.rateSeen.length - 1];
      if (seen && seen.i === i) { seen.min = Math.min(seen.min, v.playbackRate); seen.max = Math.max(seen.max, v.playbackRate); }
      assert1(v);
      earlyCheck(v);
    });
    v.addEventListener('play', () => {
      if (Number(v.dataset.i) !== index) return;
      t.clipsStarted.push({ clip, i, at: performance.now() });
      t.rateSeen.push({ clip, i, min: v.playbackRate, max: v.playbackRate });
    });
    v.addEventListener('ended', () => { if (Number(v.dataset.i) === index) advance('ended'); });
    // Opt-in (?pauseadvance): the early-path clip also treats a pause close to its end as "clip over" (a site with its
    // own end detection): this is what makes the page call play() on the next clip while a
    // stop-at-end pause is in effect, exercising the play gate (DESIGN §6.13).
    v.addEventListener('pause', () => {
      if (!PAUSE_ADVANCE) return;
      if (Number(v.dataset.i) !== index || v.dataset.clip !== EARLY || !isFinite(v.duration)) return;
      if (v.currentTime >= v.duration - 0.1) advance('early-pause');
    });
    return v;
  }

  function earlyCheck(v) {
    if (EARLY_MS > 0 && Number(v.dataset.i) === index && !v.paused && isFinite(v.duration) &&
        v.duration - v.currentTime < EARLY_MS / 1000) { v.pause(); advance('early-ms'); return; }
    if (v.dataset.clip !== EARLY || v.paused || !isFinite(v.duration)) return;
    if (v.currentTime >= v.duration - 0.05) { v.pause(); advance('early'); }   // the queued pause event sees index already moved on
  }

  function show() {
    slots.forEach((w, k) => {
      const cur = k === index % 3;
      w.style.opacity = cur ? '1' : '0';
      w.style.zIndex = cur ? '2' : '0';
    });
    document.getElementById('status').textContent = 'clip ' + index + ' ' + clipOf(index);
  }

  function advance(via) {
    const oldSlot = slots[index % 3];
    const old = oldSlot.firstChild;
    t.advances.push({ from: old.dataset.clip, i: index, via, at: performance.now() });
    old.pause();
    index++;
    const next = slots[index % 3].firstChild;
    show();
    next.play().catch(() => {});                  // same task as the old pause
    old.remove();                                  // old element removed ...
    oldSlot.appendChild(makeClip(index + 2));      // ... NEW element for the preload slot
  }

  for (let k = 0; k < 3; k++) {
    const w = document.createElement('div');
    w.className = 'slot';
    w.style.cssText = 'position:absolute;left:0;top:0;width:640px;height:360px;transition:opacity 100ms;';
    w.appendChild(makeClip(k));
    stage.appendChild(w);
    slots.push(w);
  }
  show();
  const loop = () => { const v = slots[index % 3].firstChild; if (v) earlyCheck(v); requestAnimationFrame(loop); };
  requestAnimationFrame(loop);

  t.current = () => slots[index % 3].firstChild;
  t.index = () => index;
  t.start = () => t.current().play();
  document.getElementById('next').addEventListener('click', () => advance('button'));
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') { e.preventDefault(); advance('key'); }
    if (e.code === 'Enter') { const v = t.current(); v.paused ? v.play() : v.pause(); }
  });
  if (!new URLSearchParams(location.search).has('noautoplay')) t.start().catch(() => {});
})();
