# Internal contracts

The seams between subsystems, fixed before parallel implementation. DESIGN.md
says *what and why*; this file says *exactly how the pieces talk*. Change a
contract here first, then in code.

## 1. File ownership

| Area | Files | Owner (initial build) |
|---|---|---|
| Core | `extension/manifest.json`, `extension/background.js`, `extension/icons/*`, `extension/main/agent.js`, `extension/content/{ns,intent,registry,reconcile,seeker,keys,debug,boot}.js` | worker "core" |
| UI | `extension/content/ui/{styles,host,bar}.js` (more `ui/*.js` files allowed if listed in §2 by the core owner on request), `test/ui/*` | worker "ui" |
| Tests | `test/run.py`, `test/gen_media.py`, `test/pages/*`, `test/README.md` | worker "tests" |
| Frames | `extension/content/frames.js` + changes in core files | worker "frames" (after core lands) |

Nobody edits another area's files. Nobody commits.

## 2. Script loading

Classic scripts, one isolated-world global scope per frame, manifest order:

```
content/ns.js, content/intent.js, content/registry.js, content/reconcile.js,
content/seeker.js, content/keys.js, content/ui/styles.js, content/ui/host.js,
content/ui/bar.js, content/frames.js, content/debug.js, content/boot.js
```
Every frame runs all of them; `window.top !== window` → agent mode (no UI mount, no Intent
ownership, §4.1).
MAIN world: `main/agent.js` alone, separate `content_scripts` entry.
Both entries: `matches: ["<all_urls>"]`, `run_at: "document_start"`,
`all_frames: true`, `match_about_blank: true`, `match_origin_as_fallback: true`.

Every file starts with the same namespace line and wraps itself in an IIFE:

```js
(() => {
  'use strict';
  const MS = (globalThis.MediaScrubber = globalThis.MediaScrubber || {});
  // ...
  MS.something = { ... };
})();
```

No file does work at load time except `boot.js`. `boot.js` must tolerate
`MS.ui` being absent (runs "headless": everything but rendering), which is also
how child frames run.

## 3. Core → UI: the view

`MS.ui.mount(controller) → view`. Called by core when the bar opens (top frame
only). `view` methods:

| Method | Meaning |
|---|---|
| `update(model)` | Render. Called on every model change and on every animation frame while the active media plays. Must be cheap: diff against the previous model, touch only what changed, move the playhead with `transform`. |
| `noteActivity()` | Our key was used — wake from rest dimming. |
| `handleEscape() → boolean` | `Esc` pressed; return `true` if the UI consumed it (cancelled a scrub or closed a menu). |
| `closeWithToast(ms, onUndo)` | Bar is closing: remove the bar at once, show the closed toast for `ms`, then remove the host entirely. `onUndo()` if the user clicks Undo (core then re-mounts). |
| `destroy()` | Remove everything immediately (orphaning, page teardown). |
| `getDebug() → object` | See §5. |

### 3.1 `model`

```js
{
  collapsed: false,
  placement: { dock: 'bottom' | 'top' | 'free', y: null | 0..1 },   // y: top edge as fraction of viewport height (free only)
  fullscreen: false,                  // document.fullscreenElement != null
  media: null | {                     // null → "Waiting for media…"
    kind: 'video' | 'audio',
    ready: true,                      // readyState >= 1
    time: 2.43,                       // logical playhead (seconds)
    duration: 5.0,                    // may be NaN or Infinity
    range: null | { start: 0, end: 5.0 },   // what the rail maps; null → rail disabled
    live: false,                      // unseekable or Infinity without a usable range
    buffered: [[0, 3.9]],             // clipped to range
    paused: false,
    atEnd: false,                     // stopped at the end (DESIGN §6.13)
  },
  rate: 0.75,                         // not a preset (e.g. 1.25 adopted on open) → one extra selected chip after the presets
  rateContested: false,
  presets: [0.5, 0.75, 1],
  step: { back: '0.1', fwd: '0.1' },  // label of the next step: '1f' | '0.1' | '0.2' | '0.5' | '1' | '2' | '5' | '10' | '30' | '60'
  stepHot: { back: false, fwd: false },   // true while a streak in that direction is live (label shows a climbed rung)
  candidates: [                       // non-ambient first; the chip shows only if length >= 2 or pinned
    { ref: '0:3', kind: 'video', width: 860, height: 483, duration: 5.08, paused: true, active: true }
  ],
  pinned: false
}
```

Numbers are raw; formatting (tenths, `m:ss.t`) is the UI's job. The UI never
reads media elements itself.

### 3.2 `controller` (UI → core)

| Call | Meaning |
|---|---|
| `togglePlay()` | Play/pause (at a stopped end: release the deferred next clip or replay) |
| `restart()` | ↺: unhold + disarm + exact seek to the range start + our own play (releases the pause hold). Remote active element: child command `restart` |
| `stepPress(dir)` / `stepRelease(dir)` | `dir` = −1 or +1. Press applies one step immediately; holding (no release yet) repeats at `HOLD_STEPS_PER_S` inside core. Buttons call press on `pointerdown`, release on `pointerup`/`pointercancel`/`lostpointercapture`. |
| `wheelStep(dir)` | One ladder step (press+release) |
| `seekTo(t, final)` | Scrub: `final=false` while dragging (pipelined), `true` on release (exact) |
| `setRate(r)` | Any positive number (the preset chips) |
| `pin(ref \| null)` | Pin a candidate, or back to automatic |
| `setCollapsed(bool)` | |
| `setPlacement({dock, y})` | On drag end only |
| `close()` | `×` |
| `candidateRect(ref) → {x, y, width, height} \| null` | Viewport rect of a candidate, for the outline; `null` if not measurable |

## 4. Messages

`chrome.runtime` messages, `{type, ...}`:

| Type | From → to | Payload / reply |
|---|---|---|
| `ms:toggle` | service worker → top frame (frameId 0) | reply `{open: boolean}`; SW sets the `ON` badge |
| `ms:state` | top frame → service worker | `{open}` whenever it changes by other means (×, Undo) |
| `ms:debug` | test (via service worker) → top frame | reply: §5 |

| `ms:frames-open` | service worker → every frame of the tab (no `frameId`) | `{open}`; sent after `ms:toggle`/`ms:state`/`ms:wake`. Child frames connect (`open`) or disconnect and go inert (`!open`); the top frame ignores it |
| `ms:wake` | any open frame → service worker | an `<iframe>` (re)loaded while open; the SW re-sends `ms:frames-open {open: true}` |

The service worker exposes `self.msToggle(tabId) → Promise<{open}>` — the same
code path as the toolbar click — for tests. Without the `tabs` permission,
`tab.url` is not visible to the service worker, so tests find the tab id via
the active tab of the last focused window after `page.bring_to_front()`.

MAIN ↔ isolated channel: DESIGN §6.1 table (event names `media-scrubber:*`).

### 4.1 Frame ports (DESIGN §6.12, `content/frames.js`)

`chrome.runtime.connect({name: 'ms-frame'})`, only while the tab's bar is open (I7). The service
worker is a pure router — `tabId → frameId → Port` from `sender.tab.id`/`sender.frameId`, no
other state. Top-frame messages carry `to: frameId | 'all'`; child messages are forwarded to the
top frame with `from: frameId` added. Non-finite numbers travel as `'Infinity'` / `null`.

| Message | Direction | Payload |
|---|---|---|
| `{t:'hello'}` | child → top | on every (re)connect; top replies `state` + `active` |
| `{t:'cands', list, href, nested, ts}` | child → top | full list on every Registry event (deduped). Item: `{id, kind, via, width, height, rect: {x,y,width,height} \| null (child viewport), duration, paused, ended, lastPlayAt (Date.now() ms), ambient, ready, area, src}` |
| `{t:'snap', id, kind, ready, time, duration, range, live, buffered, paused, ended, atEnd, gateHeld, rate, defaultRate, preservesPitch, contested, src, ts}` | child → top | the element the top named active; on state changes, time jumps > 0.05 s, and every 250 ms while playing. `ts` = `Date.now()`; the top extrapolates `time + (now − ts) × rate` (clamped to `range`) |
| `{t:'key', key: 'Space'\|'ArrowLeft'\|'ArrowRight', phase: 'down'\|'up'}` | child → top | a handled key with focus in the child (swallowed there); the top runs the local key path |
| `{t:'state', open, rate}` | top → child / all | read-only copy of Intent; on connect, hello, rate change, close (`open: false`) |
| `{t:'active', id \| null, pinned}` | top → child | which of the child's local ids is the global active element |
| `{t:'cmd', id, c: 'toggle'}` / `{…, c: 'restart'}` / `{…, c: 'seek', time, final}` / `{…, c: 'step', dir, size}` | top → child | executed by the child's own core (pipeline, stop at end, gate). The ladder (rung choice, hold repeat, labels) runs in the top frame; `size` is seconds or `'f'` (one frame) |
| `{t:'rects'}` | top → child | re-send `cands` (fresh rects) for the outline; at most every 150 ms |
| `{t:'frame-gone', from}` | SW → top | a child port disconnected; its entries are removed |
| `{t:'top-gone'}` | SW → children | the top port disconnected; children close |

Reconnect: on `onDisconnect` both sides reconnect with backoff 200 ms → 2 s while open; after a
top reconnect it re-broadcasts `state`, frames not heard from within 3 s are dropped; a child
that hears nothing within 5 s of connecting goes inert. Remote entries are keyed
`"<frameId>:<id>"` and implement the Entry methods (`alive, ready, playing, ambient, area, desc`)
from the reports; `el()` is `null`.

`candidateRect` of a remote entry = the child's rect + the content box of its `<iframe>` found
with `chrome.runtime.getFrameId(iframe) === frameId` (works cross-origin); fallback: the one iframe
whose `src` equals the child's `href`, else the only visible iframe; frames nested deeper than
one level → `null` (label alone).

## 5. Debug snapshot (`ms:debug` reply)

```js
{
  open: true,
  intent: { rate, pin, placement, collapsed },
  lock: 0.75 | null,                  // what was last sent to the MAIN agent
  active: null | { ref, kind, src, currentTime, paused, ended, playbackRate, defaultPlaybackRate, preservesPitch },
  candidates: [ { ref, kind, src, ambient, lastPlayAt, via } ],   // via: 'light' | 'shadow' | 'detached'
  atEnd: false, gateHeld: false,      // for a remote active element: from its snapshot
  endMargin: { effective: 0.035 },    // stop-at-end margin, media s (DESIGN §6.13): max(1 frame, 0.035 × max(1, rate)),
                                      // audio 0.035 × max(1, rate); null without a local active element
  frames: { connected: true, frames: [3, 4] },   // top: port up + child frame ids heard from
  model: { ... },                     // the last model passed to view.update (§3.1)
  counters: { reapplies: 0, siteRateWrites: 0, seeksIssued: 0, contested: 0, holdBlocked: 0 },  // holdBlocked: pause holds that deferred a page play() (DESIGN §6.13)
  ui: null | {                        // view.getDebug(); null when headless
    hostPresent: true, popoverOpen: true, collapsed: false, dimmed: false,
    scrubbing: false, menu: null | 'media', menuItems: [ { text, rect } ], outlineLabel: null | string,
    readout: '0:02.4 / 0:05.0',
    stepLabels: { back: '0.1', fwd: '0.1' },
    rects: { bar, rail, play, restart, stepBack, stepFwd, speed: { '0.5': r, '0.75': r, '1': r, extra: r | null },
             media, collapse, close, pill, pillPlay, menu, outline, toast, toastUndo }
             // viewport CSS px {x, y, width, height} or null; speed keys are the rate labels;
             // `extra` = the non-preset rate chip, null while hidden
  }
}
```
`src` is the last 24 characters of `currentSrc`. For a remote active element `active` is built
from its snapshot (`currentTime` extrapolated) and is `null` until the first snapshot. Tests act with real
`page.mouse` / `page.keyboard` input at the reported rects.

## 6. Test infrastructure notes

- The test HTTP server must support `Range` requests (206 + `Content-Range`,
  `Accept-Ranges: bytes`); without them Chrome cannot seek WebM at all.
- The cached Chromium is Chrome for Testing build 1234; the newest Playwright
  expects a newer build (see test/README.md for the pin / `executable_path`).
