# media-scrubber — UI/UX design

Status: **revision 3** (2026-09-29) after two review rounds; decisions in
DESIGN §0. Companion to [DESIGN.md](DESIGN.md). Mockup:
[design/bar-mockup.html](design/bar-mockup.html).

## 1. Principles

1. **The rail is the product.** Edge to edge, no padding, no end caps. Every
   pixel of viewport width is seek resolution.
2. **Few controls, each obvious.** Anything that needs a caption or a tooltip
   to be understood is a control too many. No captions, no tooltips, no
   temporary hints.
3. **Calm.** A translucent grey strip that sits on the page, not a slab over
   it. Accent colour only where the information is: the played part of the rail.
4. **Nothing moves while playing.** Tabular numerals, fixed-width readout and
   buttons; the layout never reflows as digits change.
5. **Always there.** It dims when idle, never hides by itself. Opening and
   closing are explicit acts.
6. **The same everywhere; never steal from the site** — no focus stealing, no
   clicks leaking to the page, no keys taken beyond the three we use.

## 2. Anatomy (expanded, docked at the bottom)

```
 viewport left edge                                                             viewport right edge
┌───────────────────────────────────────────────────────────────────────────────────────────────────┐
│▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔█░░░░░░░░░░░░░░░· · · · · · · · · · · · · · · · · · · · · · · · · · ·│ RAIL 20 px hit
│  ↺  ◀ 0.1   ▶   0.1 ▶    0:02.4 / 0:05.0                                  0.5  0.75  1   ▣2/3  ⌄  × │ ROW 32 px
└───────────────────────────────────────────────────────────────────────────────────────────────────┘
restart step play step     readout              (empty area = drag handle)    speed     media  collapse close
```

Total height 52 px. The rail is always the top edge of the bar.

### 2.1 Rail

- **Hit area 20 px** across the full width; visible track 3 px, 6 px on hover
  and while scrubbing (120 ms).
- Layers: track (white 22 %), buffered (white 35 %), played (accent), ticks,
  playhead (2 px accent line over the full hit height; 12 px knob on
  hover/drag).
- **Adaptive ticks:** smallest step of 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60 s,
  2, 5, 10, 15, 30 min … keeping ticks ≥ 40 px apart; 4 px tall, white 25 %.
  No labels.
- **Hover:** ghost playhead + a small time label `0:03.7` above the pointer —
  the one piece of floating text in the product, because it *is* the reading
  (the time under the pointer), not a hint.
- **Click** seeks to the point. **Drag:** playhead and readout follow the pointer
  instantly (readout in accent while dragging); pointer capture, so the pointer
  may wander. The play state is preserved (playing keeps playing, paused stays
  paused).
- **Fine scrub:** `Shift` held during a drag scales movement to 1/10.
- **Wheel over the rail:** one ladder step per notch (§2.3).
- `Esc` during a drag cancels back to the start.
- **Disabled** (no metadata, unseekable live): track only at 50 %; the readout
  says why (`Loading…`, `LIVE`).

### 2.2 Controls row

| Control | Behaviour |
|---|---|
| **Restart `↺`** | First control of the row, 28×28 icon button. Seeks to the start of the range and plays (also from a stopped end, and past a pause hold). No keyboard shortcut; not in the pill. |
| **Step back `◀ 0.1`** / **step forward `0.1 ▶`** | Seek by the current ladder step (§2.3). The number on the button is always the step the *next* press will make, so it grows during a streak (`◀ 0.5`, `◀ 2`) and returns to its base when the streak ends. When paused on a video the base is one frame and the button reads `◀ 1f`. Press-and-hold repeats and climbs the ladder. |
| **Play/pause** | 30 px round button, white glyph on a white 14 % disc (accent only on hover). Reacts on `pointerdown`. At the end of a clip (stopped there, §2.4) it shows `▶` and continues. |
| **Readout** | `0:02.4 / 0:05.0` — current 15 px semibold, duration secondary. Tenths always, truncated. `m:ss.t` under an hour, `h:mm:ss.t` beyond. Live: `LIVE` / `−0:12.3`. |
| **Empty row area** | Drag handle (cursor `grab` over it). Double-click: dock to bottom. |
| **Speed `0.5 0.75 1`** | Plain text chips; the chosen one gets a white 18 % pill and full-white text, the others secondary text. If the rate is not a preset (adopted from the site on open, e.g. 1.25), one extra chip `1.25` follows the presets, selected; it disappears once a preset is picked. No menu. Always ours while the bar is open. |
| **Speed contested** | The chosen chip gets a small amber dot while the site keeps resetting the speed (DESIGN §6.4 fallback). |
| **Media `▣2/3`** | Only with ≥ 2 candidates or a pin (§5). |
| **Collapse `⌄`** | To the pill (§3.3). |
| **Close `×`** | Closes the bar, releases speed control, 5 s Undo toast (§3.6). |

### 2.3 The step ladder (logarithmic seeking)

One pair of buttons and one pair of keys replace the ±0.1/±1/±5 and frame
buttons. Repetition means "further":

```
rung:   0        1     2     3     4    5    6     7     8     9
step:  [1 frame] 0.1   0.2   0.5   1    2    5     10    30    60 s
        └ only when paused on a video; otherwise the ladder starts at 0.1 s
```

- A press (button or `←`/`→`) in the **same direction within 600 ms** of the
  previous one climbs one rung; a pause longer than that, or a press in the
  other direction, starts again at rung 0.
- **Holding** a key or button applies steps at 4 per second and climbs one rung
  per step (OS key auto-repeat is ignored beyond that rate).
- The ladder is capped at a quarter of the clip: on a 3 s clip it never steps
  more than 0.5 s, so fine control is not lost on short clips.
- Steps accumulate from the *logical* playhead (DESIGN §6.5), so fast presses
  never get lost behind a slow seek.
- The 1-2-5 progression is logarithmic: each rung is ~2–2.5× the previous, so
  five quick presses cover the range from "one frame" to "a couple of seconds",
  nine cover a minute.

### 2.4 Stopping at the end

While the bar is open, every clip stops paused on its last frame instead of
letting the site auto-advance (DESIGN §6.13) — the whole clip plays, the stop
lands within about a frame of the end. There is no toggle. `Space` or the
play button then **continues**: the clip plays out its last milliseconds and the
site moves on as it normally would (on reels sites: the next clip, which again
stops at its end). To hear the clip again, press `↺` (restart), step back (`←`) or click the rail.
The site's own "next" button still works immediately.

### 2.5 Narrow viewports

- **< 600 px:** nothing collapses — the three speed chips stay (the readout and
  spacer shrink first).
- The rail is never shortened.

## 3. States

### 3.0 Opening
Nothing appears until the user clicks the toolbar icon or presses
`Alt+Shift+M`; the icon shows an `ON` badge on that tab. The bar rises from the
bottom (150 ms). With no media yet: `Waiting for media…`, binds as soon as
something loads or plays. Everything is forgotten on reload.

### 3.1 Expanded, docked (default)
Bottom dock flush with the viewport edge, hairline top border. Top dock is the
same layout at the top edge.

### 3.2 Floating
Anywhere vertically, always full width. Soft shadow `0 6px 20px rgba(0,0,0,.25)`.

### 3.3 Collapsed pill
36 px capsule at the right end of the bar's line: `(▶) 0:02.4 · 0.75  ⌃`, a
2 px progress line along its bottom edge. Play button toggles, the rest expands.
Keys keep working.

### 3.4 Rest (idle dim)
After 3 s with no pointer within the bar + 64 px and no keys: surface
0.55 → 0.4, controls 0.6. The rail and readout stay at full strength. In
fullscreen: surface 0.3, controls 0.45. Wake on proximity or our keys (120 ms).
No dimming while scrubbing or with the speed/media menu open. Clicks at rest
act immediately.

### 3.5 Scrubbing
Track 6 px, knob visible, time label above the playhead, readout in accent;
play state untouched.

### 3.6 Closed
`×`, the toolbar icon or `Alt+Shift+M` closes at once. Toast for 5 s:
`Media Scrubber closed — reopen with the toolbar icon or Alt+Shift+M   [Undo]`.
Undo reopens with the same position, speed and pin.

### 3.7 Degraded states
| State | Look |
|---|---|
| Loading (`readyState 0`) | rail disabled, readout `--:--.-`, play enabled |
| Live / unseekable | readout `LIVE`, rail disabled; DVR window → rail spans it |
| Audio | `♪` in the media chip; ladder starts at 0.1 s |
| No media | readout `Waiting for media…`, controls disabled |
| Pinned | media chip shows a pin glyph |

## 4. Drag, dock, collapse

- Drag by any empty part of the controls row (not the rail, not a control).
- Snap zones 48 px at the top and bottom edges show a 2 px accent line; release
  inside docks (150 ms settle). Double-click empty row area: dock to bottom.
- Position `{dock, y}` in memory, `y` as a fraction of viewport height, clamped
  on resize; reload → bottom dock.
- Collapse/expand is instant; the pill fades in.

## 5. Active element: indication and switching

- Automatic by default (follows what plays, DESIGN §6.3). One element → no chip.
- ≥ 2 candidates → media chip `▣ 2/3` (`♪` for audio).
- **Hover the chip:** a 2 px accent outline around the active element on the
  page, labelled `Controlling · video 860×483 · 0:05.0` (label alone for 0×0
  elements).
- **Click the chip:** a menu — `Automatic — follow what plays`, then one row per
  candidate (`▣ Video 860×483 · 0:02.5 · playing`). Hovering a row outlines it;
  choosing pins it. A removed pinned element falls back to automatic.
- No highlight on automatic switches (reels switch every few seconds).

## 6. Keyboard

Three keys, active while the bar is open (expanded or collapsed), focus not in
an editable field, no Ctrl/Cmd held — including with focus inside an embedded
player's iframe. Matched by `event.code`.

| Key | Action |
|---|---|
| `Space` | Play / pause (at the end: continue — the site moves on) |
| `←` / `→` | Step back / forward on the ladder (§2.3) |
| `Esc` | Only while scrubbing or with a menu open: cancel / close |

Everything else stays with the site (on playphrase `↑`/`↓`/`J`/`K`/`Enter`
keep working; `Space` and `←`/`→` become ours).

`chrome.commands`: one — **Open / close the bar in this tab**, `Alt+Shift+M`.

## 7. Visual language

| Token | Value |
|---|---|
| Surface | `rgba(28,30,34,.55)` + `backdrop-filter: blur(14px) saturate(1.1)`; rest `.4`; fullscreen rest `.3` |
| Hairline | `rgba(255,255,255,.10)` |
| Text | primary `#F4F5F7`, secondary `rgba(244,245,247,.62)`, disabled `.35` |
| Accent | `#5AA8FF` — played rail, playhead, readout while scrubbing, snap lines, outline |
| Warning | `#F5B83D` (contested dot) |
| Selected chip | white 18 % pill, primary text |
| Type | `system-ui`, 13 px / 500; readout 15 px / 600; `tabular-nums` |
| Radius | buttons 6 px, chips 6 px, pill 18 px, menus 10 px |
| Targets | ≥ 28×28 px in the row, 20 px-tall rail |
| Icons | inline SVG via `createElementNS`, 16 px, 1.75 px stroke |
| Motion | hover 120 ms; rest 400 ms; dock 150 ms; `prefers-reduced-motion`: none |

Text on the 0.55 surface stays ≥ 4.5:1 over a white page thanks to the blur +
saturation backdrop and the white-on-grey text; verified in the mockup.

## 8. Accessibility

`role="region"` `aria-label="Media controls"`; rail `role="slider"` with
`aria-valuetext`; every button has an `aria-label` (action + key, e.g. "Step
back 0.1 seconds, Left arrow") — for assistive tech only, never shown. Controls
are `tabindex="-1"` (out of the site's tab order).

## 9. Microcopy

"Waiting for media…", "Automatic — follow what plays", "Media Scrubber closed —
reopen with the toolbar icon or Alt+Shift+M", "Undo". No exclamation marks, no
emojis.
