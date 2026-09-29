// MAIN world policy agent (DESIGN §6.1, §6.4, §6.13). Pass-through while no lock is set.
// Only primitives cross in `detail`; node references cross via MouseEvent.relatedTarget.
(() => {
  'use strict';
  if (window.__mediaScrubberAgent) return;
  Object.defineProperty(window, '__mediaScrubberAgent', { value: true });

  const P = 'media-scrubber:';
  const proto = HTMLMediaElement.prototype;
  const rateDesc = Object.getOwnPropertyDescriptor(proto, 'playbackRate');
  const defRateDesc = Object.getOwnPropertyDescriptor(proto, 'defaultPlaybackRate');
  const nativePlay = proto.play;
  const nativeAttachShadow = Element.prototype.attachShadow;
  const nativeGetRootNode = Node.prototype.getRootNode;
  const nativeAdd = EventTarget.prototype.addEventListener;
  const nativeDispatch = EventTarget.prototype.dispatchEvent;
  const W = window;
  const NativeCustomEvent = CustomEvent;
  const NativeMouseEvent = MouseEvent;
  const NativeDocument = Document;
  const NativePromise = Promise;
  const HOST = 'MEDIA-SCRUBBER-UI';
  const INTENT_MS = 1000;

  let lockedRate = null;       // number | null
  let gateArmed = false;
  let gateStopped = null;      // element that stopped at its end
  let held = null;             // { el, resolve, reject }
  let lastSiteRateAt = 0;
  let lastIntentAt = -Infinity; // last trusted site-directed pointerdown/click/keydown

  // Recent site-directed user intent. Listeners sit on `document` (capture): the isolated world
  // swallows our own keys in the window capture phase, so they never get here; events inside our
  // UI are retargeted to the host element and are ignored.
  function noteIntent(e) {
    try {
      if (!e.isTrusted) return;
      const t = e.target;
      if (t && t.nodeName === HOST) return;
      lastIntentAt = performance.now();
    } catch (_) {}
  }
  for (const t of ['pointerdown', 'click', 'keydown']) nativeAdd.call(document, t, noteIntent, true);

  function emit(name, detail) {
    try { nativeDispatch.call(W, new NativeCustomEvent(P + name, { detail })); } catch (_) {}
  }
  function emitNode(name, node) {
    try { nativeDispatch.call(W, new NativeMouseEvent(P + name, { relatedTarget: node })); } catch (_) {}
  }

  function reportSiteRate(v) {
    const now = Date.now();
    if (now - lastSiteRateAt < 1000) return;
    lastSiteRateAt = now;
    emit('site-rate', typeof v === 'number' ? v : Number(v));
  }

  function patchRate(name, desc) {
    if (!desc || !desc.set || !desc.get) return;
    Object.defineProperty(proto, name, {
      configurable: true,
      enumerable: true,
      get: desc.get,
      set(v) {
        if (lockedRate !== null) {
          reportSiteRate(v);
          return desc.set.call(this, lockedRate);
        }
        return desc.set.call(this, v);
      },
    });
  }
  patchRate('playbackRate', rateDesc);
  patchRate('defaultPlaybackRate', defRateDesc);

  function isInDocument(el) {
    try { return nativeGetRootNode.call(el) instanceof NativeDocument; } catch (_) { return true; }
  }

  proto.play = function play() {
    try {
      if (lockedRate !== null && !isInDocument(this)) emitNode('media', this);
      if (gateArmed && this !== gateStopped && !(performance.now() - lastIntentAt < INTENT_MS)) {
        // Deferred. A previously held call is replaced; its promise stays pending forever
        // (acceptable: the site moved on to a newer clip).
        const el = this;
        return new NativePromise((resolve, reject) => {
          held = { el, resolve, reject };
          emitNode('gate-held', el);
        });
      }
    } catch (_) { /* never throw into the page */ }
    return nativePlay.apply(this, arguments);
  };

  function onShadowMedia(e) {
    if (lockedRate === null) return;
    const t = e.target;
    if (t instanceof HTMLMediaElement) emitNode('media', t);
  }

  if (nativeAttachShadow) {
    Element.prototype.attachShadow = function attachShadow() {
      const root = nativeAttachShadow.apply(this, arguments);
      try {
        if (lockedRate !== null) {
          nativeAdd.call(root, 'loadedmetadata', onShadowMedia, true);
          nativeAdd.call(root, 'play', onShadowMedia, true);
        }
      } catch (_) {}
      return root;
    };
  }

  function release() {
    const h = held;
    held = null;
    gateArmed = false;
    gateStopped = null;
    if (!h) return;
    try {
      nativePlay.call(h.el).then(h.resolve, h.reject);
    } catch (err) { h.reject(err); }
  }

  const handlers = {
    lock(e) {
      const v = e.detail;
      if (typeof v === 'number' && v > 0 && isFinite(v)) {
        lockedRate = v;
      } else {
        lockedRate = null;
        release();          // closing the bar lets the site continue its flow
      }
    },
    'gate-arm'(e) {
      if (lockedRate === null) return;
      gateArmed = true;
      gateStopped = e.relatedTarget || null;
    },
    // Disarm does not release: a held call is forgotten (its promise stays pending), so a
    // later release cannot start a stale element.
    'gate-disarm'() { gateArmed = false; gateStopped = null; held = null; },
    'gate-release'() { release(); },
    hello() { emit('ready', null); },
  };
  for (const name of Object.keys(handlers)) {
    nativeAdd.call(W, P + name, (e) => {
      try { handlers[name](e); } catch (_) {}
    }, true);
  }
  emit('ready', null);
})();
