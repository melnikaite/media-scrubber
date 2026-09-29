// The bar's stylesheet as a string. host.js turns it into a constructable
// CSSStyleSheet (adoptedStyleSheets) inside the closed shadow root.
(() => {
  'use strict';
  const MS = (globalThis.MediaScrubber = globalThis.MediaScrubber || {});
  MS.ui = MS.ui || {};

  MS.ui.css = `
:host {
  all: initial;
  position: fixed; inset: 0; margin: 0; padding: 0; border: 0;
  width: 100vw; height: 100vh; background: transparent; overflow: visible;
  color: #F4F5F7; pointer-events: none; display: block;
}
* { box-sizing: border-box; }
.bar, .pill, .menu, .toast, .tip, .olabel {
  --surface: rgba(28,30,34,.55); --hair: rgba(255,255,255,.10);
  --text: #F4F5F7; --text2: rgba(244,245,247,.62); --text3: rgba(244,245,247,.35);
  --accent: #5AA8FF; --warn: #F5B83D;
  font: 500 13px/1.2 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-variant-numeric: tabular-nums; color: var(--text);
  -webkit-user-select: none; user-select: none; -webkit-font-smoothing: antialiased;
  text-align: left; letter-spacing: normal; text-transform: none; white-space: nowrap;
}
svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.75;
      stroke-linecap: round; stroke-linejoin: round; display: block; flex: none; }
svg.fill { fill: currentColor; stroke: none; }
svg.tri { width: 10px; height: 10px; }
button {
  all: unset; box-sizing: border-box; height: 28px; min-width: 28px; display: inline-flex;
  align-items: center; justify-content: center; gap: 4px; border-radius: 6px; color: var(--text);
  font: inherit; font-size: 12.5px; font-weight: 500; padding: 0 7px; cursor: pointer;
  pointer-events: auto; flex: none; position: relative; transition: background-color 120ms, color 120ms, opacity 120ms;
}
button:hover { background: rgba(255,255,255,.08); }
button:disabled, button.disabled { color: var(--text3); cursor: default; background: transparent; }
button.dim { color: var(--text2); }
button.dim:hover { color: var(--text); }

/* ---- bar ---- */
.bar {
  position: fixed; left: 0; right: 0; height: 52px; pointer-events: auto;
  background: var(--surface);
  -webkit-backdrop-filter: blur(14px) saturate(1.1); backdrop-filter: blur(14px) saturate(1.1);
  transition: background-color 120ms, box-shadow 120ms;
}
.bar::before { content: ""; position: absolute; left: 0; right: 0; height: 1px; background: var(--hair); pointer-events: none; }
.bar.dock-bottom { bottom: 0; }
.bar.dock-bottom::before { top: 0; }
.bar.dock-top { top: 0; }
.bar.dock-top::before { bottom: 0; }
.bar.dock-free { box-shadow: 0 6px 20px rgba(0,0,0,.25); }
.bar.dock-free::before { top: 0; }
.bar.settle { transition: top 150ms ease-out, bottom 150ms ease-out, background-color 120ms; }

/* ---- rail ---- */
.rail { position: relative; height: 20px; cursor: pointer; overflow: hidden; touch-action: none; }
.rail > .track, .rail > .bufs, .rail > .played { position: absolute; left: 0; right: 0; top: 9px; height: 3px;
  transition: top 120ms, height 120ms; }
.rail:hover > .track, .rail:hover > .bufs, .rail:hover > .played,
.bar.scrub .rail > .track, .bar.scrub .rail > .bufs, .bar.scrub .rail > .played { top: 7px; height: 6px; }
.track { background: rgba(255,255,255,.22); }
.bufs > div { position: absolute; top: 0; bottom: 0; background: rgba(255,255,255,.35); }
.played { background: var(--accent); transform-origin: 0 0; transform: scaleX(0); }
.ticks { position: absolute; left: 0; right: 0; top: 0; height: 4px; pointer-events: none; background-repeat: repeat-x; }
.hw { position: absolute; left: 0; top: 0; width: 100%; height: 20px; pointer-events: none; transform: translateX(0); }
.head { position: absolute; left: -1px; top: 0; width: 2px; height: 20px; background: var(--accent); }
.knob { position: absolute; left: -6px; top: 4px; width: 12px; height: 12px; border-radius: 50%; background: #fff;
  box-shadow: 0 0 0 3px rgba(90,168,255,.4); opacity: 0; transition: opacity 120ms; }
.rail:hover .knob, .bar.scrub .knob { opacity: 1; }
.ghost { position: absolute; left: 0; top: 0; width: 1px; height: 20px; background: rgba(255,255,255,.55); }
.gw { display: none; }
.rail:hover .gw { display: block; }
.bar.scrub .gw { display: none; }
.rail.disabled { cursor: not-allowed; }
.rail.disabled > .track { opacity: .5; top: 9px; height: 3px; }
.rail.disabled > .bufs, .rail.disabled > .played, .rail.disabled > .ticks, .rail.disabled > .hw, .rail.disabled .gw { display: none; }

/* ---- controls row ---- */
.row { height: 32px; display: flex; align-items: center; gap: 4px; padding: 0 10px; cursor: grab; }
.bar.drag .row { cursor: grabbing; }
.row > *:not(.readout):not(.spacer) { transition: opacity 120ms; }
.step { width: 62px; }
.step .n { color: var(--text2); min-width: 18px; text-align: center; }
.step.hot .n { color: var(--text); }
.step:disabled .n { color: var(--text3); }
.play { width: 30px; height: 30px; min-width: 30px; border-radius: 50%; padding: 0; background: rgba(255,255,255,.14); }
.play:hover { background: rgba(255,255,255,.2); color: var(--accent); }
.readout { margin-left: 12px; font-size: 15px; font-weight: 600; white-space: nowrap; flex: none; pointer-events: none; }
.readout .cur { display: inline-block; text-align: left; }
.readout .dur { color: var(--text2); font-weight: 500; }
.readout.accent .cur { color: var(--accent); }
.spacer { flex: 1 1 auto; align-self: stretch; min-width: 8px; }
.speed { display: flex; align-items: center; gap: 4px; flex: none; }
.chip { height: 24px; min-width: 34px; padding: 0 6px; font-weight: 600; color: var(--text2); }
.chip:hover { color: var(--text); }
.chip.on { background: rgba(255,255,255,.18); color: var(--text); }
.chip .dot { position: absolute; top: 2px; right: 2px; width: 6px; height: 6px; border-radius: 50%; background: var(--warn); display: none; }
.chip.on.contested .dot { display: block; }
.bar.narrow .chip.preset { display: none; }
.media { gap: 5px; }
.media .pin { width: 13px; height: 13px; }
.hidden { display: none !important; }

/* ---- rest dimming ---- */
.bar.rest { background: rgba(28,30,34,.4); transition: background-color 400ms; }
.bar.rest .row > *:not(.readout):not(.spacer) { opacity: .6; transition: opacity 400ms; }
.bar.rest.fs { background: rgba(28,30,34,.3); }
.bar.rest.fs .row > *:not(.readout):not(.spacer) { opacity: .45; }
.pill.rest { background: rgba(28,30,34,.4); transition: background-color 400ms; }
.pill.rest > button { opacity: .6; transition: opacity 400ms; }
.pill.rest.fs { background: rgba(28,30,34,.3); }
.pill.rest.fs > button { opacity: .45; }

/* ---- floating time label ---- */
.tip { position: fixed; left: 0; top: 0; transform: translateX(-50%); background: rgba(20,21,24,.9); color: var(--accent);
  padding: 3px 7px; border-radius: 5px; font-weight: 600; font-size: 12px; pointer-events: none; display: none; }
.tip.hover { color: var(--text); }

/* ---- snap lines ---- */
.snap { position: fixed; left: 0; right: 0; height: 2px; background: #5AA8FF; pointer-events: none; display: none; opacity: .55; }
.snap.top { top: 0; } .snap.bottom { bottom: 0; }
.snap.show { display: block; } .snap.hot { opacity: 1; }

/* ---- menus ---- */
.menu { position: fixed; min-width: 120px; max-width: 360px; background: rgba(24,25,29,.96); border-radius: 10px; padding: 6px;
  box-shadow: 0 12px 32px rgba(0,0,0,.35); border: 1px solid var(--hair); pointer-events: auto; display: none; }
.menu.open { display: block; }
.mi { display: flex; align-items: center; gap: 8px; padding: 7px 10px; border-radius: 6px; cursor: pointer; }
.mi:hover { background: rgba(90,168,255,.16); }
.mi .mark { width: 10px; flex: none; color: var(--text); font-size: 10px; }
.mi .muted { color: var(--text2); }
.mi.on { font-weight: 600; }
.msep { height: 1px; background: var(--hair); margin: 4px 0; }

/* ---- outline of the controlled element ---- */
.outline { position: fixed; left: 0; top: 0; border: 2px solid #5AA8FF; border-radius: 3px; pointer-events: none; display: none; }
.olabel { position: fixed; left: 0; top: 0; background: var(--accent); color: #07121f; font-weight: 600; font-size: 11px;
  padding: 3px 7px; border-radius: 4px; pointer-events: none; display: none; }

/* ---- collapsed pill ---- */
.pill { position: fixed; right: 12px; height: 36px; border-radius: 18px; display: none; align-items: center; gap: 8px;
  padding: 0 4px 0 3px; background: var(--surface); pointer-events: auto; overflow: hidden; font-weight: 600; cursor: pointer;
  -webkit-backdrop-filter: blur(14px) saturate(1.1); backdrop-filter: blur(14px) saturate(1.1);
  box-shadow: 0 2px 10px rgba(0,0,0,.18); transition: background-color 120ms; }
.pill.show { display: flex; animation: ms-fade 150ms ease-out; }
.pill .pcur { display: inline-block; text-align: left; }
.pill .prate { color: var(--text2); font-weight: 500; }
.pill .expand { min-width: 24px; padding: 0 2px; }
.pill .prog { position: absolute; left: 0; right: 0; bottom: 0; height: 2px; background: var(--accent); transform-origin: 0 0; transform: scaleX(0); pointer-events: none; }
@keyframes ms-fade { from { opacity: 0; } to { opacity: 1; } }

/* ---- closed toast ---- */
.toast { position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%); background: rgba(24,25,29,.94);
  padding: 9px 14px; border-radius: 10px; display: flex; align-items: center; gap: 14px; pointer-events: auto;
  box-shadow: 0 8px 24px rgba(0,0,0,.3); animation: ms-fade 150ms ease-out; }
.toast button { height: auto; min-width: 0; padding: 0; color: var(--accent); font-weight: 600; font-size: 13px; }
.toast button:hover { background: transparent; text-decoration: underline; }

@media (prefers-reduced-motion: reduce) {
  *, *::before { transition: none !important; animation: none !important; }
}
`;
})();
