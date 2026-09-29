// Shared page instrumentation. Every page exposes its observations on window.__t.
// No inline scripts anywhere (hostile.html is CSP-strict); DOM via createElement only.
(() => {
  'use strict';
  const t = (window.__t = window.__t || {});
  t.pageKeys = [];        // window keydown/keypress/keyup, bubble phase: {type, code, key}
  t.docCaptureKeys = [];  // document keydown/keypress/keyup, capture phase
  t.events = [];          // media events: {name, type, t: currentTime, at: performance.now()}
  t.ended = 0;            // count of `ended` across all tracked media
  t.frames = {};          // name -> last presented rVFC mediaTime
  t.media = {};           // name -> element (the page holds refs, also to closed-shadow media)

  for (const type of ['keydown', 'keypress', 'keyup']) {
    window.addEventListener(type, (e) => t.pageKeys.push({ type, code: e.code, key: e.key }), false);
    document.addEventListener(type, (e) => t.docCaptureKeys.push({ type, code: e.code, key: e.key }), true);
  }
  t.keyCodes = (list, type = 'keydown') => list.filter((k) => k.type === type).map((k) => k.code);

  const EV = ['play', 'playing', 'pause', 'ended', 'seeked', 'ratechange', 'loadstart', 'emptied', 'loadedmetadata'];
  t.track = (el, name) => {
    t.media[name] = el;
    for (const type of EV) {
      el.addEventListener(type, () => {
        t.events.push({ name, type, t: el.currentTime, at: performance.now() });
        if (type === 'ended') t.ended++;
      });
    }
    if (el.requestVideoFrameCallback) {
      const cb = (_now, meta) => { t.frames[name] = meta.mediaTime; el.requestVideoFrameCallback(cb); };
      el.requestVideoFrameCallback(cb);
    }
    return el;
  };

  t.makeVideo = (src, opts = {}) => {
    const v = document.createElement('video');
    v.src = src;
    v.preload = opts.preload || 'auto';
    v.playsInline = true;
    if (opts.muted) v.muted = true;
    if (opts.loop) v.loop = true;
    if (opts.autoplay) v.autoplay = true;
    if (opts.controls) v.controls = true;
    v.width = opts.width || 640;
    v.height = opts.height || 360;
    return v;
  };

  // A plain page-world rate write, used by tests for "the site's write sticks".
  t.setRate = (name, r) => { const el = t.media[name]; el.playbackRate = r; return el.playbackRate; };
  t.MEDIA = new URL('../media/', location.href).href;
})();
