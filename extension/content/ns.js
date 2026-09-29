// Namespace, constants, channel names and tiny helpers shared by the isolated-world scripts.
(() => {
  'use strict';
  const MS = (globalThis.MediaScrubber = globalThis.MediaScrubber || {});

  MS.C = Object.freeze({
    PRESETS: Object.freeze([0.5, 0.75, 1]),
    LADDER: Object.freeze([0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60]),
    STREAK_MS: 600,
    HOLD_STEPS_PER_S: 4,
    IDLE_DIM_MS: 3000,
    TOAST_MS: 5000,
    FALLBACK_FPS: 30,
    COMMON_FPS: Object.freeze([23.976, 24, 25, 29.97, 30, 50, 59.94, 60]),
    AUDIO_END_EPS: 0.05,      // seek end clamp for audio (§6.5)
    END_WATCH_S: 0.035,       // stop-at-end margin x max(1, rate); video: at least 1 frame (§6.13)
    REMOVE_GRACE_MS: 1000,
    BUDGET_MAX: 5, BUDGET_WINDOW_MS: 2000, BUDGET_BACKOFF_MS: 5000,
  });

  const P = 'media-scrubber:';
  MS.EV = Object.freeze({
    lock: P + 'lock',
    gateArm: P + 'gate-arm',
    gateDisarm: P + 'gate-disarm',
    gateRelease: P + 'gate-release',
    gateHeld: P + 'gate-held',
    hold: P + 'hold',
    unhold: P + 'unhold',
    holdBlocked: P + 'hold-blocked',
    hello: P + 'hello',
    ready: P + 'ready',
    media: P + 'media',
    siteRate: P + 'site-rate',
  });

  // Media events we listen to. BASE is registered on `document` at document_start
  // (early-out while closed); EXTRA only while the bar is open.
  MS.MEDIA_EVENTS_BASE = Object.freeze(['loadedmetadata', 'play', 'playing', 'pause', 'ended', 'emptied', 'loadstart', 'ratechange']);
  MS.MEDIA_EVENTS_EXTRA = Object.freeze(['seeked', 'timeupdate', 'durationchange', 'progress', 'volumechange']);

  // Shared mutable state of the core (top frame).
  MS.state = {
    open: false,
    lock: null,
    view: null,
    atEndRef: null,
    prearmRef: null,      // gate armed for this element (pre-armed near the end, or at the end)
    gateHeld: false,
    passRef: null,        // one-shot: let this element play through its end (Space at a stopped end)
    passEnded: false,
    lastModel: null,
    heldRef: null,
    counters: { reapplies: 0, siteRateWrites: 0, seeksIssued: 0, contested: 0, holdBlocked: 0 },
  };

  MS.emit = (name, detail) => {
    window.dispatchEvent(new CustomEvent(name, { detail: detail === undefined ? null : detail }));
  };
  MS.emitNode = (name, node, detail) => {
    window.dispatchEvent(new MouseEvent(name, { relatedTarget: node || null, detail: detail || 0 }));
  };

  MS.alive = () => {
    try { return !!(globalThis.chrome && chrome.runtime && chrome.runtime.id); } catch (_) { return false; }
  };

  // Run a chrome.* call; on "Extension context invalidated" or a missing id, tear down (§6.10).
  MS.safeChrome = (fn, fallback) => {
    if (!MS.alive()) { MS.orphaned && MS.orphaned(); return fallback; }
    try {
      const r = fn();
      if (r && typeof r.catch === 'function') {
        return r.catch((err) => {
          if (/context invalidated/i.test(String(err && err.message))) MS.orphaned && MS.orphaned();
          return fallback;
        });
      }
      return r;
    } catch (err) {
      if (/context invalidated/i.test(String(err && err.message)) || !MS.alive()) MS.orphaned && MS.orphaned();
      return fallback;
    }
  };

  MS.shadowRootOf = (el) => {
    if (el.shadowRoot) return el.shadowRoot;
    try { return chrome.dom.openOrClosedShadowRoot(el) || null; } catch (_) { return null; }
  };

  MS.isMedia = (n) => n instanceof HTMLMediaElement;
  MS.finite = (x) => typeof x === 'number' && isFinite(x);
})();
