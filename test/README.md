# media-scrubber tests

## Run

```sh
# smoke suite against extension/ (DESIGN.md §10)
PLAYWRIGHT_BROWSERS_PATH=$HOME/Library/Caches/ms-playwright \
  uv run --with playwright==1.62.0 --with imageio-ffmpeg python test/run.py [name-filter ...]

# page self-check: every page in plain Chromium WITHOUT the extension (are the fixtures right?)
PLAYWRIGHT_BROWSERS_PATH=$HOME/Library/Caches/ms-playwright \
  uv run --with playwright==1.62.0 --with imageio-ffmpeg python test/run.py --pages [name-filter ...]
```

- `playwright==1.62.0` is pinned: its `browsers.json` wants `chromium-1234`, which is in the
  local cache (1.63 wants 1243; 1.61 → 1228).
- Default mode is `--headless=new` (passed as an arg with `headless=False`): it loads extensions
  and supports the Fullscreen API, and does not steal focus. `--headed` shows the window.
- Options: `--headed`; `MS_EXT=/path` loads another extension dir (harness checks);
  `MS_TRACE=1` prints tracebacks. `IFRAME_XFAIL` at the top of `run.py` (now `False`: frame
  support has landed) can mark the iframe test as expected-fail (printed `XFAIL`, not counted);
  `iframe_extra` covers rate adoption on open, rate lock, readout, frame step, stop at end and
  reconnect after a service worker restart inside a cross-origin child.
- Output: one `PASS|FAIL|XFAIL name (seconds): reason` line per test plus indented measured
  numbers, then `N/M passed, X xfail, F failed: names (total s)`. Exit code 1 on any FAIL.
  Every wait has a timeout; each test is hard-capped at 75 s.
- Server: threaded, serves `test/` on port 8437 as both `http://127.0.0.1:8437` and
  `http://localhost:8437` (IPv4 + `::1` listeners), HTTP Range (206) support — Chrome cannot seek
  media without it —, `Cache-Control: no-store`, strict CSP header on `pages/hostile.html`.
  Startup fails with a message if the port is taken (`lsof -iTCP:8437 -sTCP:LISTEN -P -n`).
- The extension is observed only through `ms:debug` (docs/contracts.md §5) sent via the
  service worker, opened via `self.msToggle(tabId)`, and driven with real `page.mouse` /
  `page.keyboard` input at the snapshot's rects. The manifest has no `tabs` permission, so the
  tab id is found by bringing the page to the front and taking the active tab.

## Media (`test/gen_media.py`, cached in `test/media/`, gitignored)

`uv run --with imageio-ffmpeg python test/gen_media.py [--force] [--probe]`

| File | Content |
|---|---|
| `clip-5s.webm`, `clip-3s.webm`, `clip-2s.webm` | `testsrc2` 320×180, 25 fps VP9, keyframe every 50 frames (2 s, so keyframe snapping would show), Opus sine 440/660/880 Hz. Frame n at exactly n × 0.04 s; `duration` ≈ N + 0.028 s (Opus pre-skip on the audio track). |
| `audio-8s.webm` | Opus only, 520 Hz, 8 s |

Video and audio are encoded separately and stream-copied together: a single-pass mux offsets the
first video block by the Opus pre-skip and Chromium's MSE rejects the append.

## Pages (`test/pages/`) and `window.__t`

All pages load `common.js` (no inline scripts, DOM via `createElement`). Common fields:

| Field | Meaning |
|---|---|
| `__t.pageKeys` | window `keydown`/`keypress`/`keyup`, bubble phase, `{type, code, key}` |
| `__t.docCaptureKeys` | same on `document`, capture phase (registered by page script) |
| `__t.keyCodes(list, type='keydown')` | codes of one event type |
| `__t.media[name]` | the page's own reference to each element (also closed-shadow and detached ones) |
| `__t.events` | media events `{name, type, t, at}` (play, playing, pause, ended, seeked, ratechange, loadstart, emptied, loadedmetadata) |
| `__t.ended` | count of `ended` events |
| `__t.frames[name]` | `mediaTime` of the last presented frame (`requestVideoFrameCallback`) |
| `__t.setRate(name, r)` | a plain page-world `playbackRate` write |

| Page | Reproduces | Extra `__t` fields |
|---|---|---|
| `single.html` | one 860×483 video (`?clip=clip-3s.webm` to swap) + `<input id=txt>` | `inputEvents` |
| `reels.html` | playphrase-like: 3 `<video>`s at the identical rect, visibility by ancestor opacity/z-index, a NEW element per preload slot on each advance (old removed, old pause + new play in one task); advance on `ended` (5 s, 2 s) and for `clip-3s` the page pauses itself at `currentTime >= duration − 0.05` (timeupdate + page rAF) before `ended`; with `?pauseadvance` it also treats any pause within 0.1 s of the end as "over"; re-asserts `playbackRate`/`defaultPlaybackRate = 1` on every `timeupdate`, on `loadstart` and 10 ms after any `ratechange`. Keys: Space = next clip, Enter = play/pause. `#next` = site "next" button. `?noautoplay` | `siteRateWrites`, `clipsStarted[{clip,i,at}]`, `advances[{from,i,via:'ended'\|'early'\|'early-pause'\|'button'\|'key'}]`, `rateSeen[{clip,i,min,max}]` (rate at timeupdate), `created`, `current()`, `index()`, `start()` |
| `recycle.html` | one element, src swapped per clip on `ended` (5→3→2 s), `playbackRate = 1` on `emptied` | `srcSwaps`, `emptiedWrites`, `clipsStarted`, `next()` |
| `shadow.html` | `open` video in an open root; `closed` in a closed root made in a custom element constructor; `nested` = closed root inside an open root. Clips 5/3/2 s | — |
| `audio.html` | hidden 0×0 `<audio preload=none>` (`hidden`) with custom buttons `#aplay`/`#apause`; `#detached` plays a detached `new Audio()` (`detached`) | — |
| `spa.html` | `#nav` → `pushState(?p=N)` replaces the whole player subtree with a new `<video>` (odd p: 5 s, even: 3 s) | `navigations`, `generation`, `navigate()`; `media.main.dataset.gen` |
| `fullscreen.html` | `#fs-container` fullscreens a div, `#fs-video` the `<video>`; `#fs-exit` | `fsChanges`, `fsErrors` |
| `live.html` | MSE, whole `clip-5s.webm` appended, `duration = Infinity`, no `endOfStream`. Chromium 1234: `duration === Infinity`, `seekable = [[0, 5]]` (= buffered), seeking works. `?clip=` | `live{stage,error,log}`, `info()` |
| `hostile.html` | CSP `default-src 'self'; style-src 'self'; script-src 'self'; require-trusted-types-for 'script'` (HTTP header), `html { transform: translateZ(0) }`, `* { all: unset !important }`, a fixed max-z-index overlay at the bottom; an inline script that must NOT run | `inlineRan` (false), `ttEnforced` (true), `cspViolations` |
| `ambient.html` | muted looping autoplay background video (`ambient`, 2 s, no controls) + a normal player (`main`, 5 s, controls, not autoplaying) | — |
| `iframe.html` | same-origin child `#same` and cross-origin child `#cross` (`localhost` ↔ `127.0.0.1`, same port) → `iframe-child.html` | child: `origin`, own key loggers, `media.main` |
| `nomedia.html` | text only; `#add` appends and plays a video later | — |

### Adaptive stop-at-end

`reels.html?earlyms=N` makes the page end each clip by itself N ms before its
end (checked on `timeupdate` and rAF), modelling sites whose own end detection
fires earlier than our default 0.1 s margin. `reels_adaptive` (1×) and
`reels_adaptive_slow` (0.5×) assert that after the first pre-empted clip the
learned margin (`ms:debug` → `endMargin`) makes every following clip stop first.

### Pause recovery (pause hold)

`?pauserecovery=MS` (common.js, used by `single.html` and `reels.html`) models playphrase's
"pause recovery": the page flags the pauses it makes itself (`__t.sitePause(el)`); any other
`pause` of a watched element is undone with `el.play()` after MS ms, retried up to 3 times at MS
intervals while still paused (`__t.recoveries[{name, n, at}]`). `single.html` also has page-level
`#pplay` / `#ppause` buttons. `pause_hold` checks that our Space / bar pause stays paused ≥ 2 s
(`counters.holdBlocked`), that the page's own play/pause buttons still work, and reports what
happens after closing the bar while paused. `reels_pauserecovery` (1×) and
`reels_pauserecovery_slow` (0.5×) check every clip stays stopped at its end ≥ 1.5 s.
