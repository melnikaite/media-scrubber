// The host element: <media-scrubber-ui> on documentElement, closed shadow root,
// top layer via popover="manual", re-shown on fullscreen changes, self-healing
// when the page removes it, and event hygiene at the shadow boundary (DESIGN §6.8).
(() => {
  'use strict';
  const MS = (globalThis.MediaScrubber = globalThis.MediaScrubber || {});
  MS.ui = MS.ui || {};

  const TAG = 'media-scrubber-ui';

  // Inline !important declarations beat every page rule. `all` must come first.
  const HOST_STYLE = [
    ['all', 'initial'],
    ['position', 'fixed'], ['inset', '0'], ['top', '0'], ['left', '0'], ['right', 'auto'], ['bottom', 'auto'],
    ['width', '100vw'], ['height', '100vh'], ['min-width', '0'], ['min-height', '0'],
    ['max-width', 'none'], ['max-height', 'none'],
    ['margin', '0'], ['padding', '0'], ['border', '0'], ['outline', '0'],
    ['background', 'transparent'], ['color', '#F4F5F7'], ['overflow', 'visible'],
    ['z-index', '2147483647'], ['display', 'block'], ['visibility', 'visible'], ['opacity', '1'],
    ['transform', 'none'], ['filter', 'none'], ['clip-path', 'none'], ['contain', 'none'],
    ['pointer-events', 'none'],
  ];

  // Events originating in our UI never reach page bubble listeners.
  const STOP = [
    'pointerdown', 'pointerup', 'pointermove', 'pointerover', 'pointerout', 'pointerenter', 'pointerleave', 'pointercancel',
    'mousedown', 'mouseup', 'mousemove', 'mouseover', 'mouseout', 'mouseenter', 'mouseleave',
    'click', 'auxclick', 'dblclick', 'contextmenu', 'wheel',
    'touchstart', 'touchmove', 'touchend', 'touchcancel', 'dragstart', 'selectstart',
  ];

  let sheet = null;
  function getSheet() {
    if (!sheet) {
      sheet = new CSSStyleSheet();
      sheet.replaceSync(MS.ui.css || '');
    }
    return sheet;
  }

  MS.ui.createHost = function createHost() {
    const doc = document;
    const host = doc.createElement(TAG);
    for (const [k, v] of HOST_STYLE) host.style.setProperty(k, v, 'important');
    host.setAttribute('popover', 'manual');
    const root = host.attachShadow({ mode: 'closed' });
    root.adoptedStyleSheets = [getSheet()];

    let alive = true;
    const mo = new MutationObserver(() => {
      if (alive && (!host.isConnected || host.parentNode !== targetParent())) attach();
    });

    const stop = (e) => {
      e.stopPropagation();
      if (e.type === 'wheel') e.preventDefault();
      if (e.type === 'mousedown' || e.type === 'pointerdown' || e.type === 'dragstart' || e.type === 'selectstart') {
        e.preventDefault(); // never steal focus from the page, no text selection
      }
    };
    for (const t of STOP) host.addEventListener(t, stop, { passive: false });

    function show() {
      if (!alive || !host.isConnected) return;
      try { if (!host.matches(':popover-open')) host.showPopover(); } catch (_) { /* not supported / invalid state */ }
    }
    function reshow() {
      if (!alive || !host.isConnected) return;
      try { if (host.matches(':popover-open')) host.hidePopover(); } catch (_) { /* ignore */ }
      show();
    }
    // Chrome makes everything outside the fullscreen element inert (it renders,
    // but hit-testing skips it), even in the top layer. So while an element is
    // fullscreen the host lives inside it; replaced elements (<video>, <iframe>,
    // …) cannot hold children, there the host stays on documentElement.
    const NO_CHILDREN = new Set(['VIDEO', 'AUDIO', 'IFRAME', 'IMG', 'CANVAS', 'OBJECT', 'EMBED', 'INPUT', 'TEXTAREA', 'SELECT']);
    function shadowOf(e) {
      try {
        if (globalThis.chrome && chrome.dom && chrome.dom.openOrClosedShadowRoot) return chrome.dom.openOrClosedShadowRoot(e);
      } catch (_) { /* ignore */ }
      return e.shadowRoot || null;
    }
    function targetParent() {
      const fe = doc.fullscreenElement || doc.webkitFullscreenElement || null;
      if (fe && fe !== doc.documentElement && fe.isConnected && !NO_CHILDREN.has(fe.tagName)) {
        return shadowOf(fe) || fe;
      }
      return doc.documentElement;
    }
    let observed = null;
    function observe(parent) {
      if (observed === parent) return;
      mo.disconnect();
      if (doc.documentElement) mo.observe(doc.documentElement, { childList: true });
      if (parent && parent !== doc.documentElement) mo.observe(parent, { childList: true });
      observed = parent;
    }
    function attach() {
      const parent = targetParent();
      if (!parent) return;
      if (host.parentNode !== parent) parent.appendChild(host);
      observe(parent);
      show();
    }

    const onFs = () => { if (!alive) return; const p = targetParent(); if (host.parentNode !== p) attach(); else reshow(); };
    doc.addEventListener('fullscreenchange', onFs, true);
    doc.addEventListener('webkitfullscreenchange', onFs, true);

    attach();

    return {
      host, root, show, reshow,
      isOpen() { try { return host.matches(':popover-open'); } catch (_) { return false; } },
      destroy() {
        if (!alive) return;
        alive = false;
        mo.disconnect();
        doc.removeEventListener('fullscreenchange', onFs, true);
        doc.removeEventListener('webkitfullscreenchange', onFs, true);
        try { if (host.matches(':popover-open')) host.hidePopover(); } catch (_) { /* ignore */ }
        host.remove();
      },
    };
  };
})();
