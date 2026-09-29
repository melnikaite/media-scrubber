// Window-capture keyboard handling (DESIGN §6.7). Space, ←, → (+ Esc via the view).
(() => {
  'use strict';
  const MS = (globalThis.MediaScrubber = globalThis.MediaScrubber || {});

  const swallowing = new Set();       // codes whose keypress/keyup we still owe a swallow
  const BUTTONISH = new Set(['button', 'submit', 'reset', 'checkbox', 'radio', 'image', 'file', 'color', 'hidden']);
  const ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']);
  let handlers = null;                // { isOpen, togglePlay, stepPress, stepRelease, escape, activity }

  function deepActive() {
    let a = document.activeElement;
    for (let i = 0; a && i < 32; i++) {
      const sr = MS.shadowRootOf(a);
      if (!sr || !sr.activeElement) break;
      a = sr.activeElement;
    }
    return a;
  }
  function editable(el) {
    if (document.designMode === 'on') return true;
    if (!el || el === document.body || el === document.documentElement) return false;
    const tag = el.localName;
    if (tag === 'input') return !BUTTONISH.has((el.type || 'text').toLowerCase());
    if (tag === 'textarea' || tag === 'select') return true;
    if (el.isContentEditable) return true;
    const role = el.getAttribute && el.getAttribute('role');
    return !!role && ROLES.has(role.toLowerCase());
  }

  function swallow(e) { e.preventDefault(); e.stopImmediatePropagation(); }

  function onKeydown(e) {
    if (!handlers || !handlers.isOpen()) return;
    const code = e.code;
    if (code !== 'Space' && code !== 'ArrowLeft' && code !== 'ArrowRight' && code !== 'Escape') return;
    if (e.isComposing || e.ctrlKey || e.metaKey) return;
    if (editable(deepActive())) return;
    if (code === 'Escape') {
      if (!handlers.escape()) return;
    } else if (code === 'Space') {
      if (!e.repeat) handlers.togglePlay();
    } else if (!e.repeat) {
      handlers.stepPress(code === 'ArrowLeft' ? -1 : 1);
    }
    swallow(e);
    swallowing.add(code);
    handlers.activity();
  }
  function onKeypress(e) {
    if (!handlers || !swallowing.size) return;
    // keypress for Space carries code 'Space'; arrows produce none.
    if (swallowing.has(e.code)) swallow(e);
  }
  function onKeyup(e) {
    if (!handlers || !swallowing.has(e.code)) return;
    swallowing.delete(e.code);
    swallow(e);
    if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') handlers.stepRelease(e.code === 'ArrowLeft' ? -1 : 1);
  }
  function onBlur(e) {
    if (e.target !== window) return;
    // Focus left the window mid-hold: no keyup will come.
    if (swallowing.has('ArrowLeft') && handlers) handlers.stepRelease(-1);
    if (swallowing.has('ArrowRight') && handlers) handlers.stepRelease(1);
    swallowing.clear();
  }

  MS.keys = {
    install(h) {
      handlers = h;
      window.addEventListener('keydown', onKeydown, true);
      window.addEventListener('keypress', onKeypress, true);
      window.addEventListener('keyup', onKeyup, true);
      window.addEventListener('blur', onBlur, true);
    },
    uninstall() {
      window.removeEventListener('keydown', onKeydown, true);
      window.removeEventListener('keypress', onKeypress, true);
      window.removeEventListener('keyup', onKeyup, true);
      window.removeEventListener('blur', onBlur, true);
      handlers = null;
      swallowing.clear();
    },
    editable, deepActive,
  };
})();
