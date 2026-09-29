// Intent: the single source of truth for what the user chose (DESIGN §5.2). In memory only.
(() => {
  'use strict';
  const MS = (globalThis.MediaScrubber = globalThis.MediaScrubber || {});

  let intent = null;
  const subs = new Set();

  MS.intent = {
    get: () => intent,
    create(init) {
      intent = {
        open: true,
        rate: init.rate,
        pin: init.pin || null,
        placement: init.placement ? { dock: init.placement.dock, y: init.placement.y ?? null } : { dock: 'bottom', y: null },
        collapsed: !!init.collapsed,
      };
      return intent;
    },
    // Only called from user input (I1) — plus pin clearing when the pinned element is removed (§6.3).
    update(patch) {
      if (!intent) return;
      const prev = intent;
      intent = Object.assign({}, intent, patch);
      if (patch.placement) intent.placement = { dock: patch.placement.dock, y: patch.placement.y ?? null };
      for (const fn of subs) { try { fn(intent, prev); } catch (e) { console.error(e); } }
    },
    snapshot() {
      return intent && { rate: intent.rate, pin: intent.pin, placement: { ...intent.placement }, collapsed: intent.collapsed };
    },
    discard() { intent = null; },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
  };
})();
