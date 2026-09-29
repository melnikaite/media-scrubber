# media-scrubber

Chrome extension (Manifest V3): a precise, always-available, full-width control
bar for the audio/video on any website. Read `DESIGN.md` before changing
anything; it names the source of truth and the invariants every change must keep.

## Hard rules

- **Universal only.** No hostname checks, no site-specific selectors or ids, no
  per-site branches. A site that misbehaves gets a *generic* mechanism (or a
  documented non-goal), never a special case.
- Plain JavaScript, no bundler, no npm, no build step. `extension/` loads as is.
  Static content scripts are classic scripts sharing one global scope per world,
  in manifest order — each file is an IIFE that attaches to a single namespace.
- DOM is built with `createElement` + `textContent` only. `innerHTML` throws on
  Trusted Types sites (verified on YouTube).
- Everything in English: code, comments, docs, UI strings.
- Tests: `PLAYWRIGHT_BROWSERS_PATH=$HOME/Library/Caches/ms-playwright uv run --with playwright==1.62.0 --with imageio-ffmpeg python test/run.py [filter]`
  (`--pages` checks the fixture pages without the extension; `--headed` shows the window). UI harness: `test/ui/check.py`.
  Test media is WebM (VP9 + Opus) — Playwright's Chromium has no H.264/AAC.
  Test server port 8437 (re-check with `lsof -iTCP:8437 -sTCP:LISTEN`).
  Playwright is pinned to 1.62.0 because it matches the cached Chromium build
  1234 (1.61 → 1228, 1.63 → 1243); unpinned it floats to a build not in the cache.
  The test server must support HTTP `Range` — without it Chrome cannot seek WebM.
- Git: personal repo on github.com/melnikaite over SSH; commits are signed via
  1Password — if signing fails with "agent returned an error", ask the user to
  unlock, never disable signing. `gh` is not installed. Never commit or push
  unless the user asks.

## Domain traps (verified, keep this list growing)

- **`load()` silently resets `playbackRate` to `defaultPlaybackRate`** — any src
  change, including YouTube's SPA navigation on the *same* element, and no
  `ratechange` fires for that reset. Always set both `playbackRate` and
  `defaultPlaybackRate`, and re-apply on `loadstart`/`loadedmetadata`/`emptied`.
- **Some players re-assert their own rate on every render.** playphrase.me
  (ClojureScript/React) writes `playbackRate = 1` ~10 ms after any external
  change and ~1.5 times per second while playing. A `ratechange` tug-of-war
  there never converges; only the MAIN-world setter lock (DESIGN.md §5) works.
- **Isolated and MAIN worlds have separate JS wrappers and prototypes.** A
  MAIN-world patch of `HTMLMediaElement.prototype` does not affect writes made
  from the content script, and expando/own properties set in one world are
  invisible in the other. DOM nodes are shared; JS objects are not.
- **Crossing worlds:** event `detail` only survives as a primitive. Node
  references cross via `MouseEvent.relatedTarget`, which is **retargeted to the
  outermost shadow host** when dispatched on `window` — resolve the rest with
  `chrome.dom.openOrClosedShadowRoot`. Detached nodes (`new Audio()`) cross as is.
- **Media events neither bubble nor compose.** A capture listener on `document`
  sees light-DOM media only; each shadow root needs its own listeners.
- **"Largest visible" is not `getBoundingClientRect`.** playphrase stacks three
  `<video>`s at the identical rect and hides the inactive ones with
  `opacity: 0` on an *ancestor*. Hidden `<audio>` (Wikipedia) has a 0×0 rect and
  `preload="none"` — no metadata until played.
- **Reels swap elements in one tick:** old `pause`(+`ended`) and new `play` fire
  in the same task; the site may also pause/advance *before* `ended` fires.
  New `<video>` nodes are created per clip, not recycled.
- **Handled keys must be swallowed on keydown, keypress and keyup** — sites bind
  any of the three. Match on `event.code` (layout-independent; the user types
  in Russian and German layouts).
- **Fullscreen blocks hit-testing outside the fullscreen element**: a top-layer
  popover re-shown after `fullscreenchange` is painted above it but receives no
  clicks. The host must move *inside* `document.fullscreenElement`; impossible
  when that element is a `<video>`/`<iframe>`/`<canvas>`.
- **`navigator.userActivation` is useless as "the user wanted this"**: our own
  swallowed `Space` still grants the page ~5 s of transient activation.
- Without the `tabs` permission the service worker cannot see `tab.url`, so
  `chrome.tabs.query({url})` finds nothing.
- **`el.ended` can be `true` before `currentTime` reaches `duration`** when one
  track (e.g. Opus audio with pre-skip) ends earlier — even with no `ended`
  event, after our own pause. `play()` on it restarts from 0.
- **A site's own end detection can act well before `ended`** (playphrase
  switches clips earlier than a 1.5-frame margin). No fixed stop margin fits
  every site: the end watch stops 0.1 s early by default and learns per
  document from pre-emptions (a held play, another element starting, a site
  pause of the still-playing active element). Never learn from anything after
  our own pause — a site that advances *because* we paused would ratchet the
  margin up forever.
- **Some players undo any pause they did not make.** playphrase.me ("pause
  recovery") calls `play()` again ~0.5 s after an external pause, with
  retries — our bar pause and our stop-at-end pause were both undone. Only a
  MAIN-world hold on `HTMLMediaElement.prototype.play` for the element we
  paused works (DESIGN §6.13 pause hold); the site's own buttons pass as a
  trusted click after the hold started.
- Content scripts are orphaned when the extension reloads/updates:
  `chrome.runtime.id` becomes undefined. Detect it, tear the bar down, release
  the MAIN-world lock.

## Delegation

The main session is the orchestrator: it plans, reviews, and answers questions.
Delegate implementation to the `worker` agent using these rules:

- **Confirm scope before implementing anything.** If it's ambiguous whether
  the user wants analysis/a plan or actual code changes — or they explicitly
  asked to "look into," "analyze," "think about," or "plan" something —
  default to analysis-only: present findings/a plan and stop. Never let "this
  looks easy" justify skipping that check; easy-looking tasks are exactly the
  ones that slip through unnoticed and burn tokens on unrequested work.
- **Do it yourself (no delegation) only if BOTH hold:** the edit touches 1–2
  files in a precisely known location, AND the current session is not
  pricier to run than the worker. "Pricier" is model tier *and* effort: the
  worker's are pinned in `.claude/agents/worker.md` (full model ID + an
  `effort:` field), the session's model is stated in the system prompt but
  its effort is not. Typical setup: session on Opus 5.5 at `high`, worker
  on Opus 5.5 at `low` — same model, but the session spends more thinking
  per turn over a much larger context, so it is the pricier side and
  anything beyond a precisely-located 1–2 file edit goes to the worker.
  When the comparison is uncertain (pricing and model lineups change),
  delegate rather than guess. The reverse also holds: if the user has
  deliberately switched the main session to a cheaper model than the
  worker's for cost control, don't hand bulk work to the pricier worker
  without saying so — that silently defeats their choice.
- **Send a follow-up task to a live worker (SendMessage):** the next task
  touches the same code the worker just worked on, and no more than a couple
  of minutes have passed.
- **Spawn a new worker:** the topic/subsystem changed, the previous agent
  already completed a large task (its context is bloated), or the tasks are
  independent — in that case spawn several new workers in parallel.
- **Dispatch independent workers in one message, not one at a time.** When a
  batch's Agent calls have no data dependency between them, send them
  together (multiple tool uses in a single message) even if you plan to
  review each one's diff before deciding the next step — reviewing
  sequentially doesn't require launching sequentially. Conflating "I'll
  check this before moving on" with "so I'll launch them one at a time"
  silently serializes work that could run concurrently.

After delegating, always review the resulting diff yourself.
