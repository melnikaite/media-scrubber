# media-scrubber — architecture

Status: **approved with changes** (2026-09-29, see §0). No extension code exists yet.
The UI/UX pass is a separate document: [UI-DESIGN.md](UI-DESIGN.md).

---

## 0. Decisions from the review (2026-09-29)

These override the original brief; the sections below are already updated.

- **Manual activation.** The bar appears only when the user opens it for the tab
  (toolbar icon or `Alt+Shift+M`) and disappears only when the user closes it
  (× on the bar, or the same toggle). Nothing is auto-summoned.
- **No persistence.** All state lives in memory for the lifetime of the
  document: SPA navigation keeps it; a reload or a new document forgets
  everything (open/closed, position, collapsed, speed, pin). No `chrome.storage`
  and no `storage` permission. This replaces the original "position remembered
  per site". (`window.sessionStorage` would not do this — it survives reloads.)
- **Speed is always controlled while the bar is open.** There is no "site speed"
  release; opening the bar locks the active element's current rate, closing the
  bar releases the lock.
- **Scrubbing preserves the play state**: playing keeps playing during a drag,
  paused stays paused.
- **Loop and A-B loop are out.**
- **Everything else ships in v1**, including media in iframes and extra speeds.
  Per-site default speed and settings sync are dropped (nothing is persisted).
- Accepted as proposed: plain keys, vertical-only drag at full width, ambient
  media ranked last, toolbar icon toggles the bar.
- **Minimal controls (UI revision 3):** step back · play/pause · step forward ·
  readout · speed · media chip (only with ≥ 2 candidates) · collapse · close.
  No captions, no tooltips, no temporary hints.
- **Seeking steps are a logarithmic ladder** instead of fixed ±0.1/±1/±5 and
  frame buttons: repeated presses in one direction climb
  1 frame (paused video only) → 0.1 → 0.2 → 0.5 → 1 → 2 → 5 → 10 → 30 → 60 s (§6.5).
- **Stop at end is always on** while the bar is open (§6.13); no toggle.
- **Keys: `Space`, `←`, `→` only** (plus `Esc` while scrubbing or in a menu).
  One command: open/close (`Alt+Shift+M`).

---

## 1. Probe findings (measured 2026-09-29, Chrome, macOS)

Measured with injected instrumentation (event logs on every media element, a
MutationObserver, a stack-capturing `playbackRate` setter), not from reading
docs. These numbers drive §5–§7.

### playphrase.me/reels/de/ru/ernst/ (the reference site)

| Question | Finding |
|---|---|
| Media elements | 3 `<video>` (no `<audio>`), light DOM, no shadow roots, no iframes. `preload="auto"`, `controls=false`, MP4 on S3. |
| Layout | All three at the **identical rect**; the visible one is chosen by `opacity` on an **ancestor** (`opacity:1; z-index:2` vs `opacity:0; z-index:0`), cross-faded in over ~100 ms. `getBoundingClientRect` cannot tell them apart. |
| Clip switch | The **element is replaced, not recycled**: the old one is removed and a new `<video>` node is created for the next preload slot on every advance. Old `pause`(+`ended`) and new `play` fire in the **same task** (same ms). |
| Clip durations | 7.92, 5.08, 2.50, 4.50, 2.13 s. |
| `ended` | Auto-advances. Once the site paused the clip at its duration **without** an `ended` event (it advances on its own end detection), so "hook `ended`" is not sufficient for pause-at-end/loop. |
| Rate reset | **Aggressive.** Any external `playbackRate` write is reverted to 1 ~10 ms later from React `componentDidUpdate` (code: `a.playbackRate===b \|\| (a.playbackRate=b)` for both `playbackRate` and `defaultPlaybackRate`). While playing, the site re-writes `1` ~1.5×/s (33 writes in 20 s). A `ratechange`-driven re-apply would flip-flop audibly forever. |
| Rate lock test | A MAIN-world accessor on `HTMLMediaElement.prototype.playbackRate` that substitutes the desired value for page writes held 0.5× for a full 7.92 s clip (played for 15.8 s), all 33 site writes absorbed, site kept working. |
| Pitch | `preservesPitch === true` by default. |
| Fullscreen | Site's button fullscreens a **container** div (not the `<video>`). |
| Keys | Site binds (capture + bubble keydown on the window/document): ArrowUp/ArrowDown and J/K = previous/next slide, **Space = next clip**, ArrowLeft/ArrowRight = previous/next video, **Enter = play/pause**. So Space is *not* play/pause here. |
| Other | The site has its own speed and repeat buttons; a free-tier dialog appears after 5 clips (irrelevant to us, but it pauses media). |

### youtube.com/watch

| Question | Finding |
|---|---|
| Media | 1 `<video>` (MSE `blob:` src), light DOM, 0 shadow roots, 2 unrelated iframes. `seekable` = [0, duration]. |
| SPA navigation | The **same element is reused**; `emptied` → `play` → `loadstart` → `loadedmetadata`. |
| Rate reset | Once per load: at `emptied` YouTube writes its own stored rate (1) — with `ratechange`. It does **not** fight afterwards (0.75 held for the rest of the video; YouTube's internal rate stayed 1). `defaultPlaybackRate` we set survived the navigation, `playbackRate` did not. |
| Trusted Types | `element.innerHTML = '…'` **throws**. `createElement`/`textContent` required. |
| Popover API | A `popover="manual"` element shown with `showPopover()` rendered on top of the page (top layer). |
| Fullscreen | Could not be entered from the automated browser (requests were refused even with user activation); **to be verified in Playwright** with local test pages instead. |

### Spec behaviour confirmed along the way

- The media `load()` algorithm resets `playbackRate` to `defaultPlaybackRate`
  silently (no `ratechange` for that reset). Every src change calls it.

### en.wikipedia.org File page with an `.ogg` (plain audio)

| Question | Finding |
|---|---|
| Media | 4 `<audio>` elements, `preload="none"`, `readyState 0`, `duration NaN`, **0×0 rect**, custom UI (MediaWiki player). |
| Implication | "Show the bar once an element has metadata" never fires until the user presses the site's play; "largest visible" ranks all of them at 0. Discovery must also trigger on `play`. |

### Consequences for the design

1. The active-element rule must be **event-recency based** (last to start
   playing), with geometry only as a tie-breaker for never-played elements, and
   geometry must account for ancestor opacity.
2. Rate enforcement needs a **MAIN-world setter lock**; `ratechange` re-apply is
   only a budgeted fallback.
3. Re-apply rate on *load of the same element* (YouTube), not only on element
   switch (playphrase). Setting `defaultPlaybackRate` makes the silent reset a no-op.
4. Our key handler must run before the site's and must own Space and arrows,
   which playphrase uses for navigation (decided: plain keys, §0).
5. Nothing site-specific: every finding above is answered with a mechanism
   that works on any page.

---

## 2. Goals

- One bar that behaves identically on every site with an `HTMLMediaElement`.
- Full-viewport-width seek rail: 1 px ≈ duration / viewport width (a 5 s clip on
  a 2056 px viewport is ~2.4 ms/px).
- Tenth-of-a-second readout, exact seeks, a logarithmic step ladder from one
  frame to 60 s.
- Instant play/pause, including a hotkey that pauses *now*.
- A speed the user chose survives anything the site does to the element or to
  which element is active.
- Zero cost on pages without media; negligible cost on pages with media.

## 3. Non-goals (unless a probe proves otherwise)

- DRM players that break when `currentTime` is written directly (Netflix and
  similar): we do not special-case them; if they break, they are unsupported.
- Canvas / WebCodecs / WebAudio-graph players with no media element.
- Replacing the site's own UI, subtitles, or thumbnails; no hover previews.
- Controlling media in other tabs; mobile Chrome.
- Site-specific adapters of any kind (see CLAUDE.md "Universal only").

---

## 4. Candidate architectures and why the winner wins

**A. Isolated-world controller that fights back on `ratechange`** (the classic
speed-controller approach). Simple, no page-world code. **Loses on the
reference site:** playphrase re-writes the rate on every render, so the fight
never ends; the only "fix" is giving up (back-off), i.e. the speed resets —
exactly the bug this project exists to fix.

**B. Everything in the MAIN world** (controller and UI in the page's JS realm).
Direct access to closed shadow roots and detached `new Audio()`, trivial lock.
**Loses on robustness:** no `chrome.*` APIs (a bridge is needed anyway), the
page can tamper with every prototype we rely on after we start, our state is
visible to and patchable by the page, and the page's realm quirks (polyfilled
`Array`, patched `addEventListener`, Trusted Types default policies) become our
bugs.

**C. Split: isolated-world controller + UI (owns the source of truth), thin
MAIN-world "policy agent"** (~150 lines: rate lock, play/attachShadow hooks),
connected by a page-global event channel carrying only primitives and node
references. **Winner.** The lock lives where the page's writes happen; all
logic, state and UI live where the page cannot reach them; the MAIN agent is
stateless except for one number (the lock) and is a pass-through when no lock
is set, so a bug there degrades to "speed not enforced", never to "site broken".

For the fullscreen problem: **top-layer popover** (winner: survives any
fullscreen element, escapes `transform`/`filter` on ancestors that break
`position: fixed`, no reparenting into site DOM) vs. **moving the host into
`document.fullscreenElement`** (breaks when the fullscreen element is the
`<video>` itself — a replaced element has no children — and exposes the bar to
the site's layout/transforms) vs. **nothing** (bar vanishes in fullscreen,
unacceptable).

---

## 5. Core sentence and data model

### 5.1 The proposed sentence, evaluated

> *The user's intent is the source of truth. The media element's state is
> observed, never stored. Whenever a different element becomes the active one,
> the intent is re-applied to it.*

Right in spirit, wrong in three places the probe exposed:

1. **"Whenever a different element becomes active" is too narrow.** YouTube keeps
   the *same* element and silently resets its rate on `load()`; playphrase
   re-asserts its rate on the *same* element 1.5×/s; preloaded siblings should
   already have the rate *before* they become active (otherwise the first frames
   of each clip play at 1×). Re-application must happen on every trigger, to
   every eligible element.
2. **Play/pause and position are not intent.** Storing "playing" as intent would
   fight the site's own auto-advance, its own buttons and its paywall dialog.
   They are **commands**: one-shot operations on the observed element.
3. **Intent has a lifetime.** Before the bar is opened and after it is closed we
   must not touch anything (the site's own speed menu works as usual). While
   the bar is open the rate is always ours (§0).

**Adopted sentence:**

> **`Intent` is the single source of truth for everything the user has chosen;
> media state is observed, never stored. One idempotent `reconcile(intent,
> element)` is run on every eligible element whenever either side changes — an
> element appears, (re)loads, is written to by the site, or the intent changes.
> Play, pause and seek are commands, not intent. Intent exists only while the
> bar is open; before that and after closing, we leave the site alone.**

### 5.2 `Intent` — the one named source of truth

Lives in memory in the isolated world of the **top frame**, created when the
bar is opened, discarded when it is closed or the document goes away. One
`update(patch)` entry point notifies subscribers.

```
Intent
├─ open:       boolean               the bar is open in this document
├─ rate:       number | null         null until an active element is *playing*; then adopted
│                                    once from its playbackRate and locked (or set by the user)
├─ pin:        MediaRef | null       user override of the active element
├─ placement:  { dock: 'bottom' | 'top' | 'free', y?: number }   y = fraction of viewport height
└─ collapsed:  boolean

Constants (content/ns.js; not user-editable in v1)
  PRESETS     = [0.5, 0.75, 1]                  shown as chips
  LADDER      = [0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60] s, preceded by one frame on a paused video
  STREAK_MS   = 600, HOLD_STEPS_PER_S = 4
  MORE_SPEEDS = [0.25, 0.6, 0.9, 1.25, 1.5, 2]  in the ▾ menu
  IDLE_DIM_MS = 3000
```

Rules: nothing in `Intent` is ever written from a media event, a timer, or a
site action — only from user input (bar, keys, commands, toolbar). **Nothing is
persisted.** Child frames receive a read-only copy of `{open, rate}` (§6.12).

### 5.3 Observed state (derived, never stored as truth)

```
Registry           Map<MediaRef, Entry>        what exists (discovery, §6.2)
  MediaRef         "<frameId>:<id>"           string; frameId from the service worker (§6.12)
  Entry            { el (strong if connected, WeakRef if detached), kind: 'video'|'audio',
                     lastPlayAt: number, ambient: boolean (recomputed), via: 'light'|'shadow'|'detached' }
active             = selectActive(Registry, Intent.pin)     pure function, §6.3
snapshot(active)   read from the element on every render: currentTime, duration,
                   seekable, buffered, paused, ended, playbackRate, readyState
Memo (per element) fpsEstimate, seek pipeline state — caches of observations, safe to drop
View transient     drag target, hover, idle, open menu — UI-only, never persisted
```

### 5.4 Commands (one-shot, operate on `active`)

`togglePlay` (synchronous `el.pause()` when playing — "pause exactly now";
at a stopped end: release the deferred next clip or replay, §6.13), `seekTo(t)`,
`step(direction)` (the ladder, §6.5). Commands never touch
`Intent`; intent ops (`setRate`, `pin`, `collapse`, `dock`, `hide`) never touch
the element directly — they update `Intent`, and `reconcile`/render follow.

---

## 6. Subsystems

### 6.1 Worlds, files, channel

```
extension/
  manifest.json
  background.js              service worker: commands, toolbar click, ON badge, per-tab frame relay
  main/agent.js              MAIN world, document_start: rate lock, play/attachShadow hooks
  content/ns.js              ISOLATED, document_start: namespace, constants, channel names
  content/intent.js          Intent store (in memory: subscribe/update)
  content/registry.js        discovery, Registry, selectActive
  content/reconcile.js       reconcile(), lock channel, fallback budget
  content/seeker.js          seek pipeline, stepping, frame step, fps estimator
  content/keys.js            window-capture keyboard handling
  content/frames.js          frame relay: child-frame agent mode, port to the service worker,
                             remote Registry entries in the top frame
  content/ui/styles.js       CSS as a string → constructable stylesheet
  content/ui/host.js         host element, closed shadow root, top-layer management
  content/ui/bar.js          bar DOM + render(snapshot, intent, view)
  content/boot.js            wiring; registers the cheap listeners; lazy-builds everything else
```

Classic scripts, loaded in manifest order into one isolated-world global scope.
Each file is an IIFE attaching to `globalThis.MediaScrubber` (a namespace
object, not a module system). Nothing runs at load time except `boot.js`.

Manifest essentials: `"permissions": []` — none; page access comes from the
content-script `matches`. Two `content_scripts` entries on `<all_urls>` at
`document_start` (one with `"world": "MAIN"`), both `all_frames: true`,
`match_about_blank: true`, `match_origin_as_fallback: true`; `commands`;
`action`; `minimum_chrome_version: "120"` (MAIN-world static scripts 111,
Popover 114).

Why static injection on every page when activation is manual: the keyboard
listener must be registered before any page script to run first in the window
capture phase, and the rate lock must own the prototype accessors before the
page can save the native ones. Before activation both are inert early-outs.

**MAIN ↔ ISOLATED channel** (page-global events on `window`, names prefixed
`media-scrubber:`):

| Event | Direction | Payload |
|---|---|---|
| `…:lock` | isolated → main | `CustomEvent.detail` = rate number, or `null` when the bar is closed (MAIN also stops emitting `…:media` and releases any held `play()`) |
| `…:gate-arm` | isolated → main | `relatedTarget` = the active element about to stop / stopped at its end |
| `…:gate-disarm` | isolated → main | disarm and **forget** a held `play()` (its promise stays pending) so a stale element can never start later |
| `…:gate-held` / `…:gate-release` | main → isolated / isolated → main | a page `play()` was deferred / run the held `play()` now (§6.13) |
| `…:hello` / `…:ready` | both | handshake; whichever side loads second re-sends state |
| `…:media` | main → isolated | `MouseEvent`, `relatedTarget` = media element or (retargeted) outermost shadow host |
| `…:site-rate` | main → isolated | `detail` = rate the site tried to set (throttled to 1/s) |

Only primitives and node references cross (JS objects do not). The page can
observe and forge these events; the worst a forger can do is lock its own
page's speed or point us at its own elements — acceptable.

### 6.2 Discovery

Cheapest mechanism first; each covers what the previous one misses.

1. **Light DOM:** capture listeners on `document` for `loadedmetadata`, `play`,
   `playing`, `pause`, `ended`, `emptied`, `loadstart`, `ratechange`. Registered
   at `document_start`, before any page script, so nothing is missed.
2. **Shadow DOM:** MAIN agent wraps `Element.prototype.attachShadow`; on each new
   root it adds capture listeners for `loadedmetadata` and `play` and emits
   `…:media` with `relatedTarget` = the media element. Dispatching on `window`
   retargets that to the outermost host; the isolated side walks the host's
   shadow tree with `chrome.dom.openOrClosedShadowRoot` (works for closed roots),
   registers the media found and attaches its own listener set (1.) to that root.
3. **Detached media** (`new Audio()`): MAIN agent wraps
   `HTMLMediaElement.prototype.play`; if `el.getRootNode()` is not a `Document`,
   it emits `…:media` (a detached node crosses unretargeted). Our listeners are
   attached to the element itself.
4. **Safety net:** one `querySelectorAll('video,audio')` at `DOMContentLoaded`
   and on `pageshow` (bfcache restore).

Known gap: declarative shadow DOM (`<template shadowrootmode>`) bypasses
`attachShadow`; such media is found only via (4.) plus a shadow walk. Rare;
accepted for v1.

**Removal:** a `MutationObserver` on `document` (childList, subtree) exists only
while the Registry is non-empty. Its callback does no tree work: it sets a dirty
flag and, once per animation frame at most, checks `isConnected` of the k
registered elements. Disconnected entries get a 1 s grace period (frameworks
move nodes) before removal. Detached-origin entries are held by `WeakRef`.

**Activation (manual):** before the bar is opened, the listeners in (1.) and the
MAIN hooks exist but record nothing (early-outs; MAIN emits nothing while no
lock is set). Opening the bar does a one-time scan: `querySelectorAll('video,
audio')`, plus a walk over all elements calling
`chrome.dom.openOrClosedShadowRoot` to register shadow media and attach
listeners to their roots (a few ms even on large pages; once per activation).
Media played before activation counts as `lastPlayAt = 0` except that a
currently playing element still wins class 2 of §6.3. Detached `new Audio()`
created before activation is found at its next `play()`.

`ambient` = a video that is muted (or volume 0), has no `controls`, and was
never the target of our commands — background/hero loops, hover previews. It
only affects ranking (§6.3); it never hides the bar.

### 6.3 Active element selection

`selectActive(registry, pin)` — pure, deterministic, recomputed on every
registry event (`play`, `playing`, `pause`, `ended`, `emptied`, add, remove) and
on pin change; never assigned ad hoc. First non-empty class wins:

1. `pin`, if still registered.
2. Playing (`!paused && !ended`) non-ambient elements → greatest `lastPlayAt`.
3. Paused non-ambient elements that have played → greatest `lastPlayAt`
   (the clip that just ended stays active until the next one starts).
4. Never-played non-ambient elements with `readyState ≥ 1` → largest *effective
   visible area* = viewport-clipped rect area × product of ancestor opacities
   (walk ≤ 10 ancestors; computed only when this class is reached).
5. Ambient elements, same order as 2–4.
6. `null` → the bar shows "Waiting for media…" (it never hides by itself) and
   binds as soon as something appears.

On playphrase this yields: new clip's `play` (same task as old `pause`) → class
2 switches immediately. On YouTube: one element, trivially. On Wikipedia: the
audio the user pressed. Pin is cleared when the pinned element is removed.

### 6.4 Reconcile and the rate lock

```
reconcile(el):                                 idempotent; safe to call any time
  if !Intent.open: return                       never touch the site while closed (I3)
  rate = Intent.rate
  if el.defaultPlaybackRate != rate: el.defaultPlaybackRate = rate
  if el.playbackRate != rate:        el.playbackRate = rate
  if el.preservesPitch !== true:     el.preservesPitch = true
```

Called for **every** registered non-ambient element on: registration,
`loadstart`, `loadedmetadata`, `emptied`, `play`, `ratechange` (budgeted), and
on any change of `Intent.rate`. Preloaded next clips therefore already
carry the rate before they start.

**Lock:** whenever `Intent.rate` changes, the isolated side sends
`…:lock(rate|null)`. The MAIN agent replaces the prototype accessors of
`playbackRate` and `defaultPlaybackRate` once at `document_start`; while a lock
is set, a page write of any value calls the native setter with the locked rate
instead (so page-created elements get the right rate too), and reports the
site's wish via `…:site-rate`. With no lock, the accessors are pure
pass-through. Our own writes come from the isolated world's pristine prototype
and never pass through the patch. Getters are untouched.

**Fallback budget:** if a `ratechange` shows `playbackRate != rate` despite the
lock (a page using a saved native setter or another realm's prototype), re-apply
at most 5 times per 2 s per element; beyond that stop for 5 s and set the
observed flag `contested`, which the UI shows. No infinite tug-of-war is
possible by construction.

**The lock is on for as long as the bar is open** (§0): the site's own speed
menu has no audible effect meanwhile (its label may say 1×). Closing the bar
sends `…:lock(null)` and the site regains control; we do not restore any
previous rate.

### 6.5 Seeking

- **Range:** finite `duration` → [0, duration]. `Infinity`/`NaN` → last
  `seekable` range if it spans ≥ 1 s, else the rail is disabled ("LIVE" or
  "--:--.-"). Recomputed on `durationchange`/`progress`, not polled.
- **Pipeline (per element), at most one seek in flight:** `seekTo(t)` clamps,
  then if no seek is in flight writes `currentTime = t`, else stores `pending = t`.
  On `seeked`: if `pending` differs from what landed, issue it. `currentTime`
  only; never `fastSeek` (keyframe snapping defeats the purpose).
- **Logical playhead** = `pending ?? inFlightTarget ?? currentTime`. Steps and key
  auto-repeat accumulate from it, so a fast streak lands exactly on the sum of its steps
  even when seeks are slower than repeats.
- **End clamp:** never seek to ≥ `duration − ε` (ε = one frame, or 0.05 s for
  audio). Landing exactly on the end fires `ended`, which makes reels sites
  auto-advance — scrubbing to "the end" must not skip the clip.
- **Drag:** pointer capture on the rail; readout and playhead render from the
  drag target immediately, independent of seek completion; pipeline seeks while
  moving; exact `seekTo` on release; `Esc` cancels back to the start position.
  The play state is preserved (§0): a playing element keeps playing while the
  pipeline chases the pointer; a paused one stays paused and shows the frame
  under the pointer.
- **Step ladder** (`step(±1)`; buttons, `←`/`→`, wheel over the rail): state
  `{dir, rung, lastAt}` in the seeker memo (view-level, not intent). A step in
  the same direction within `STREAK_MS` of the previous one climbs one rung,
  otherwise the streak restarts at rung 0. Rung 0 is one frame when the active
  element is a paused video, else `LADDER[0]`. Steps from a held key/button are
  applied at `HOLD_STEPS_PER_S` (extra auto-repeat events are dropped) and each
  applied step climbs a rung. The ladder stops climbing at the largest rung
  ≤ `duration / 4` (never below `LADDER[0]`), so short clips keep fine control
  (3 s clip → at most 0.5 s). Frame rungs go through the
  frame-step path below; time rungs through `seekTo(logical + dir × step)`.
  The UI shows the size the *next* press would make (§ UI-DESIGN 2.3), derived
  from the memo and the clock — it falls back to rung 0 when the streak expires.
- **Frame step:** video only (the ladder's rung 0 on a paused video). Base = the last presented
  frame's `mediaTime` from `requestVideoFrameCallback` (falls back to
  `currentTime`). Frame duration from an estimator that samples ~20 frames of
  `mediaTime` deltas via rVFC while the active video plays, takes the median and
  snaps to a common rate (23.976/24/25/29.97/30/50/59.94/60) within 2 %;
  fallback 1/30 s. Target = base ± frameDuration, through the
  pipeline.

### 6.6 Readout clock

While the active element plays, the bar is visible and `document.visibilityState`
is `visible`, one `requestAnimationFrame` loop reads `currentTime` and moves the
playhead (transform only) and the tenths readout. It stops on pause, `ended`,
hidden tab, or the bar closed. No other timers; idle dimming uses one `setTimeout`
re-armed on activity.

### 6.7 Keyboard

- `keydown`, `keypress`, `keyup` listeners on `window`, **capture**, registered at
  `document_start` → they run before every page listener. Cheap early-out when
  the bar is closed. Collapsed counts as open.
- **Child frames** run the same listener. When focus is inside a child frame
  (e.g. the user clicked into a video embed) and the bar is open in the tab,
  handled keys are swallowed there and forwarded to the top frame as commands
  (§6.12).
- Ignore when: `isComposing`; Ctrl or Meta held; the deep focused element (walk
  `activeElement` through open and closed shadow roots) is editable —
  `input` (any type except button-like ones; `range` counts as editable),
  `textarea`, `select`, `contenteditable`, `designMode`, roles
  `textbox|searchbox|combobox|spinbutton`.
- Match on `event.code` (layout-independent). When a key is ours:
  `preventDefault()` + `stopImmediatePropagation()` on keydown, remember the
  code, and swallow the matching `keypress`/`keyup` too. Keys that are not ours
  are never touched.
- Keys: `Space` → `togglePlay` (repeat ignored), `←`/`→` → `step(∓1)` (repeat
  feeds the hold rate), `Esc` only while scrubbing or with a menu open.
- Global toggles through `chrome.commands` (work even while typing in inputs,
  since the browser handles them): see UI-DESIGN §6 for the map. The service
  worker forwards `{cmd}` to the tab's top frame. There is one command, open/close
  (`Alt+Shift+M`), identical to the toolbar icon. The service worker keeps an
  `ON` badge per tab in sync.

### 6.8 Host, isolation, top layer, fullscreen

- One custom-named host element (`<media-scrubber-ui>`), appended to
  `document.documentElement` (not `body`: frameworks replace body content), with
  a **closed** shadow root. All our DOM lives inside it; built with
  `createElement`/`textContent`.
- Styles: constructable `CSSStyleSheet` via `adoptedStyleSheets` (not subject to
  the page's `style-src` CSP the way an inline `<style>` can be); `:host { all:
  initial }` blocks inherited page styles. The host's own box is locked with
  inline `!important` declarations (`all: initial` + position/size), which beat
  any page stylesheet rule, including `!important` ones.
- The host is `popover="manual"` and shown with `showPopover()` → top layer:
  renders above page content and above z-index wars, and `position: fixed` is
  relative to the viewport even if the page transforms `html`/`body`.
- **Fullscreen (measured 2026-09-29, Chrome for Testing build 1234):** a popover
  re-shown after `fullscreenchange` is *painted* above the fullscreen element,
  but Chrome does not hit-test anything outside the fullscreen element's subtree
  — the bar is visible yet unclickable. Therefore: while an element is
  fullscreen, the host is **moved inside `document.fullscreenElement`** (into its
  shadow root via `chrome.dom.openOrClosedShadowRoot` if it has one) and moved
  back to `documentElement` on exit; the popover is re-shown after each move.
  Verified for container fullscreen. **When the fullscreen element cannot hold
  children** (`<video>` itself, `<iframe>`, `<canvas>`), the bar is painted but
  clicks do not reach it; keys still work. **Decided: keys-only** in that case
  (2026-09-29) — we do not redirect the site's fullscreen request, so the site's
  own fullscreen behaves exactly as designed by the site.
- **Event hygiene:** pointer, mouse, click, wheel and touch events from our bar
  are stopped at the host (bubble phase) so page-level "click to pause" and
  drag handlers do not see them; `mousedown` default is prevented on buttons so
  we never steal focus from the page (keeps the site's own focus logic intact).
  Page *capture* listeners on window/document still see our events — accepted.
- **Self-healing:** if the host is removed (a `MutationObserver` on
  `documentElement` childList only), re-append and re-show it.
- A page modal `<dialog>` opened later sits above us and may make us inert until
  closed — accepted, verified in tests so it is at least known.

### 6.9 Persistence

None (§0). `Intent` is a plain in-memory object in the top frame. A reload or
navigation to a new document starts from a closed bar. `chrome.storage` is not
used and the `storage` permission is not requested.

### 6.10 Lifecycle

- **Close:** remove the host, disconnect observers and frame ports, send
  `…:lock(null)` to every frame, drop `Intent` and the Registry. The document_start
  listeners stay (as early-outs) so reopening works.
- **Orphaning:** after an extension reload/update, `chrome.runtime.id` becomes
  undefined in old content scripts. Any `chrome.*` failure or a missing id →
  the same teardown plus removing all listeners.
- **bfcache:** state survives; on `pageshow` re-run the safety-net scan.
- SPA navigation: same document → `Intent` survives by design. Reload → gone;
  the service worker clears the badge when the tab starts loading.

### 6.11 Performance budget

- Any page before activation: ~11 capture listeners that early-out and 4
  pass-through prototype accessors/wrappers. No observers, timers, DOM, ports or
  messages.
- Page with media: one debounced `MutationObserver`, rAF only while playing and
  visible, `IntersectionObserver` not used (geometry computed on demand in class 4).
- No polling loops anywhere. Target: < 0.5 ms script time per page load before
  activation (verified in tests via `performance.measure` around boot).

### 6.12 Frames (v1)

- Every frame runs the MAIN agent and the content scripts. Only the **top frame**
  owns `Intent` and the UI; child frames run in *agent mode*: Registry,
  `reconcile`, seeker, keys — no UI.
- On open, the service worker broadcasts `ms:frames-open` to all frames of the
  tab; each child connects a `chrome.runtime` Port (`name: 'ms-frame'`) only
  then, and disconnects on close (I7). Frames added or navigated later are
  picked up via `ms:wake`, sent on iframe `load`. The service worker is a pure
  router (`tabId → frameId → port`, plus `frame-gone`/`top-gone` notices) and
  holds no other state: when it is suspended and ports drop, frames reconnect
  (backoff 200 ms → 2 s), the top re-broadcasts state and drops frames silent
  for 3 s, and a child with no answer within 5 s goes inert.
- Child frames report their candidates (kind, size, duration, paused,
  `lastPlayAt` as `Date.now()` epoch ms so values compare across processes) on
  every Registry event. The top frame merges them into one Registry keyed by
  `MediaRef {frameId, id}` and runs `selectActive` over all of them.
- For the active remote element, the child sends a snapshot on every media event
  and every 250 ms while playing; the top frame extrapolates
  `t = t0 + (now − ts) × rate` for a smooth tenths readout without flooding the port.
- Commands go top → service worker → owning frame. `{open, rate}` is broadcast to
  all frames; each frame keeps its own MAIN lock. The step ladder (rungs, hold
  repeat, labels) lives in the top frame; a child only executes
  `step(dir, size)` with `size` in seconds or one frame. Snapshots are sent on a
  state change, a time jump > 0.05 s, and every 250 ms while playing. The exact
  message shapes are in docs/contracts.md §4.1.
- `Intent.rate` is adopted from the first active element (local or remote)
  that is **playing** — frames report one by one, and a paused preload could
  otherwise win selection briefly. Until then no lock is sent, so opening never
  changes what is already playing; a speed the user picks sets it directly.
- Geometry of an element inside a frame is converted to top-frame coordinates
  only for the "Controlling…" outline: the child reports its rect; the top finds
  the `<iframe>` with `chrome.runtime.getFrameId(iframe) === frameId` (exact,
  works cross-origin), falling back to a unique `src` match or the only visible
  iframe; frames nested deeper than one level get the label only.
- Fullscreen of an embed makes the `<iframe>` the top document's
  `fullscreenElement`; the top-layer re-show (§6.8) covers it.


### 6.13 Stop at end

Always on while the bar is open (§0): the active clip ends paused on its last
frame, and the site does not move on by itself.

- **End watch:** while the active element plays, the readout rAF loop (§6.6)
  already reads `currentTime`; when `currentTime ≥ duration − ε_end`, call
  `pause()`. ε_end = max(default, learned) × `max(1, rate)` media seconds —
  never shrunk at slow rates, or a site's own early end check wins — and never
  more than 15 % of the clip's duration. default = max(0.1 s, 1.5 frames) for
  video, max(0.1 s, 0.08 s) for audio. This fires before the site's own end
  detection (playphrase pauses and advances *before* `ended`, §1) and before
  `ended`, so neither path runs. The rAF loop does not run in background tabs,
  so a `timeupdate` check is the backstop there (coarser; accepted).
- **Learned margin (per document, in memory only, per frame):** a site whose
  own end detection acts earlier than our margin *pre-empts* the stop. It is
  detected on the active element while it still plays and we have not paused it
  (neither our stop nor the user's pause through us; nothing after our stop
  counts, so a site reacting to our pause — `?pauseadvance` — never ratchets):
  the MAIN gate reports `gate-held` for another element, another non-ambient
  element fires `play`, or the site pauses it. With R = `duration − currentTime`
  at that moment, if ε_end < R ≤ cap (cap = min(1 s, 0.15 × duration); a larger
  R is a mid-clip pause from the site's UI, not an end check), then
  learned = min(max(learned, R + 2 frames (audio 0.05 s)), cap). The first clip
  on such a site may be lost this way; the following ones stop in time. The
  values are in `ms:debug` `endMargin` (docs/contracts.md §5).
- **Play gate (MAIN agent):** **pre-armed** while the active element plays with
  less than max(1 s, ε_end / rate + 0.3 s) of wall-clock time left
  (`(duration − t) / rate`), so the
  site's own early end detection cannot slip a `play()` out before our end
  watch fires; a site pause of the active element inside that window counts as
  the stop. Stays armed at the end until the user plays again; seeking back out
  of the window or an active-element change disarms. While armed, a page call to
  `HTMLMediaElement.prototype.play` on an element *other than* the stopped one
  is **deferred** — unless the user showed site-directed intent within the last
  1000 ms: a trusted `pointerdown`/`click`/`keydown` seen by a MAIN capture
  listener on `document` whose target is not our host (our own keys are
  swallowed in the window capture phase and never reach it). So the site's own
  "next" button always goes through. (`navigator.userActivation` was rejected:
  our own `Space` grants the page ~5 s of activation, which let short clips
  auto-advance.) A deferred call: returns a promise that stays pending, and the element is recorded as "next". The
  isolated side shows it as "Next clip ready". On `Space`/play the isolated side
  tells MAIN to release the deferred call (native `play()` runs and the promise
  settles with its result) — the site's own flow continues exactly as if it had
  never waited. With nothing deferred (our end watch won, so the site never
  tried to move on), play means **continue**: disarm, mark the element
  "pass through the end" once, and `play()` — the last milliseconds play out,
  the element reaches `ended` (if Chrome already reports `ended` on the paused
  element, step back two frames first — `play()` on an ended element restarts
  from 0), and the site advances by its own logic (or the
  clip simply ends). Replay is ← / scrubbing; there is no separate replay path.
- Our own `play()` calls come from the isolated world and never pass the gate.
- **Ads are stopped too** (decided 2026-09-29; measured on YouTube, where a 20 s
  pre-roll was held at 19.96 s): an ad and content cannot be told apart
  generically, so the ad→content transition waits for `Space` like any other
  clip, and the locked speed applies to ads as well.
- **Known limit (measured, `reels.html?pauseadvance`):** a site that advances on
  *any* pause near the end — including our own stop — has its next `play()`
  held correctly, but its own UI state (visible slide, index) still moves to
  the next clip, shown paused. We cannot stop a site's internal state machine
  generically; `Space` then plays that next clip at the locked rate.
- Closing the bar releases any deferred call immediately.
- For media in a child frame, the end watch and the gate run in the owning
  frame (its own agent and MAIN script).
- Channel: the gate is enabled whenever the lock is set (bar open); `…:gate-release` isolated → main; `…:gate-held` main →
  isolated (`relatedTarget` = held element, retargeted as in §6.2).

---

## 7. Invariants

- **I1** Nothing writes `Intent` except user input — with one exception: the
  one-time adoption of `rate` from the first playing active element after opening.
  Media events and site writes otherwise trigger `reconcile`/render only.
- **I2** While the bar is open and `rate` is adopted, every registered non-ambient element (in every frame) has
  `playbackRate = defaultPlaybackRate = rate` and `preservesPitch = true` after each
  reconcile trigger, and the MAIN lock equals `rate`.
- **I3** While the bar is closed, we never write `playbackRate` or anything else on media, and no lock is set.
- **I4** `active` is always `selectActive(Registry, pin)`; there is no other assignment.
- **I5** At most one seek in flight per element; the latest target always lands;
  release lands exactly; no seek reaches `duration − ε` or beyond.
- **I6** We stop propagation only of events we handled; a handled key is
  swallowed on keydown, keypress and keyup alike; editable focus is never
  intercepted.
- **I7** Before activation we create no DOM, observers, timers, ports or messages.
- **I8** The bar opens, closes, collapses and expands only by explicit user
  action. Timers may only dim it.
- **I9** Nothing is persisted; a reload forgets everything.
- **I10** All our DOM lives in one closed shadow root under one host; no `innerHTML`.
- **I11** No hostname, selector or id of any particular site appears in the code.

---

## 8. Feature → model mapping

| Feature | Expressed as | Notes |
|---|---|---|
| Open / close the bar | `Intent.open` (toolbar, `Alt+Shift+M`, ×) | creating/discarding `Intent` is the whole lifecycle |
| Seek click/drag, live readout | command `seekTo` + view transient `drag.target` | pipeline I5; play state untouched |
| Step ladder (frame → 60 s) | command `step(±1)` + streak memo + fps memo | §6.5 |
| Play/pause, pause-now | command `togglePlay` | never intent |
| Speed presets + extra speeds, pitch | `Intent.rate` → reconcile + lock | constants for the lists |
| Speed survives new clip / src change / recycled element | reconcile triggers + `defaultPlaybackRate` + lock | the playphrase + YouTube cases |
| Keys (incl. from a focused iframe) | key map → commands / intent ops | §6.7, §6.12 |
| Dock, drag | `Intent.placement` | until reload |
| Collapse | `Intent.collapsed` | until reload |
| Active element override | `Intent.pin` | I4 |
| Media in iframes | `MediaRef.frameId ≠ 0`, router in the service worker | §6.12 |
| Stop at end instead of auto-advance | always on while `Intent.open`: end watch + MAIN *play gate* | §6.13; needed because playphrase advances before `ended` (§1) |
| Out: loop / A-B loop | would be `Intent.loop` + the same end watch + play gate | decided out (§0); nothing in the model blocks it later |
| Dropped: per-site default speed, settings sync | would need a persisted scope feeding `Intent.rate` on open | nothing is persisted (§0) |
| Future: free drag with resizable width | `placement` gains `{x, width}`; rail width = bar width | |

Every row is an operation on `Intent`, a command, or a derivation — no feature
needs to infer the user's wish from media state.

---

## 9. Edge cases per feature (to be covered by tests or accepted explicitly)

- **Seek:** `duration` NaN before metadata (rail disabled until `loadedmetadata`);
  `Infinity` with seekable window (DVR); seek while `readyState 0`
  (`preload=none`: the write is stored as the start position); seeking an ended
  element; 2–5 s clips (sub-frame precision matters); dragging past rail ends.
- **Rate:** site resets on `loadstart` (YouTube), on every render (playphrase),
  from a saved native setter (fallback budget), new element per clip, same
  element new src; user picks "site default" → lock released.
- **Active:** two elements start in the same task (the later `play` wins); the
  active element removed while playing; pinned element removed; audio + video on
  one page; ambient hero video plus a real player; ads in the same element.
- **Keys:** focus in input/textarea/contenteditable/closed-shadow input; IME
  composition; site listens on keyup only; Ctrl/Cmd combos; auto-repeat.
- **UI:** page transforms `html`; page CSS `* { … !important }`; strict CSP +
  Trusted Types; container fullscreen; `<video>` fullscreen; modal dialog;
  host removed by the page; viewport resize while floating (clamp `y`).
- **Activation:** open with no media ("Waiting…", binds later); open while a clip
  is already playing at 1.25× (locks 1.25, shown in the ▾ button); close releases
  the lock; reopen after close; reload forgets.
- **Frames:** cross-origin iframe media; focus inside the iframe (keys
  forwarded); service worker suspended mid-session (ports reconnect); iframe
  removed while its media is active; two frames playing at once (latest wins).

---

## 10. Test plan (Playwright smoke test, run through uv)

Modelled on `~/projects/screenshare-blur/test/run.py`: a persistent context with
`--load-extension`, headed Chromium, a local `http.server` on port **8437**
(verified free 2026-09-29), reachable as both `127.0.0.1` and `localhost` —
two origins, so the iframe page gets a genuinely cross-origin child. The
service worker exposes its toggle handler as a global so the test can open the
bar the same way the toolbar icon does. Observations of the closed shadow root go through a
`debug:snapshot` message answered by the content script (bar state, active
`MediaRef`, readout text, element rects); interactions use real
`page.mouse`/`page.keyboard` input at coordinates from that snapshot, so user
activation and event order are real.

**Media:** `test/gen_media.py` generates via `imageio-ffmpeg` (a uv-managed
static ffmpeg with `libvpx-vp9` and `libopus`, checked 2026-09-29) into
`test/media/` (gitignored, cached): `testsrc2` clips at 25 fps, 320×180 — 5 s,
3 s, 2 s — each with a distinct sine tone, plus an 8 s Opus-only `.webm`. The
frame counter is burned into `testsrc2`, and `requestVideoFrameCallback`
`mediaTime` gives exact frame positions for assertions.

| Page | Covers |
|---|---|
| `single.html` | click-seek accuracy (±1 frame); drag readout, play state preserved during drag; ladder: first `←` on a paused video = 1 frame (`mediaTime` delta 0.04), quick repeats climb 0.1/0.2/0.5…, a pause > 600 ms resets, the cap on short clips; play/pause; keys ignored in `<input>`; the page's own window keydown listener never sees Space/←/→ but sees other keys; presets + `preservesPitch`; dragging to the end does not fire `ended` |
| `reels.html` | 3 stacked videos hidden by ancestor opacity, new element per clip, auto-advance on `ended`; site re-asserts rate 1 on `loadstart` **and** on every `timeupdate`; asserts 0.5× held on every clip and `ratechange` count stays small |
| `recycle.html` | one element, src swapped per clip, rate reset on `emptied` (YouTube-like) |
| `shadow.html` | video in an open root, in a closed root (custom element constructor), and nested |
| `audio.html` | hidden 0×0 `<audio preload=none>`; detached `new Audio()` started by a button |
| `spa.html` | player subtree replaced on `pushState`; rebinds; rate survives |
| `fullscreen.html` | container fullscreen: `elementFromPoint` at the bar is our host and clicks work; `<video>` fullscreen: keys work, bar painted (keys-only by design); bar survives exit |
| `live.html` | MSE with `duration = Infinity`: rail uses `seekable` or is disabled |
| `hostile.html` | served with strict CSP + `require-trusted-types-for 'script'`, `html { transform }`, `* { … !important }`: bar renders, sized, clickable |
| `ambient.html` | muted looping background video + a real video → the real one is active |
| `iframe.html` | video in a same-origin and in a cross-origin iframe: active across frames, seek/rate/frame step work, keys work with focus inside the iframe, readout extrapolation within ±0.1 s |
| `nomedia.html` | before activation: no host, no observers, boot time budget; open → "Waiting for media…"; add a video → binds |
| (all pages) | nothing happens until the bar is opened; close releases the lock (site's rate write sticks again); reload forgets |
| `reels.html` + stop at end | with the bar open, each clip pauses on its last frame (never `ended`), the site's early-advance path (it pauses/advances before `ended`, like playphrase) and its `ended` path are both held; `Space` then releases the deferred `play()` of the next clip |
