"""media-scrubber smoke suite (DESIGN.md §10).

Run:
  PLAYWRIGHT_BROWSERS_PATH=$HOME/Library/Caches/ms-playwright \
    uv run --with playwright==1.62.0 --with imageio-ffmpeg python test/run.py [filter...] [--pages] [--headed]

  filter   run only tests whose name contains any of the given substrings
  --pages  page self-check: run every test page in plain Chromium WITHOUT the
           extension and assert the pages' own behaviour (the fixtures are right)
  --headed show the browser window (default: --headless=new, which supports
           extensions and fullscreen in Chromium 1234)

Playwright 1.62.0 is pinned because its browsers.json expects chromium-1234,
which is in the local cache (1.63 wants 1243).

Tests observe the extension only through the ms:debug snapshot (docs/contracts.md
§5) and act only through real page.mouse / page.keyboard input at its rects.
"""
import asyncio, http.server, os, pathlib, re, socket, socketserver, subprocess, sys, tempfile, threading, time, traceback

from playwright.async_api import async_playwright

# Flip to False once cross-origin iframe support (worker "frames") lands.
IFRAME_XFAIL = False
# <video>-element fullscreen: Chrome does not hit-test anything outside a fullscreen <video>,
# so the bar cannot receive clicks there (user decision pending). Keys must still work.

ROOT = pathlib.Path(__file__).resolve().parent.parent
TEST = ROOT / "test"
EXT = pathlib.Path(os.environ.get("MS_EXT", ROOT / "extension")).resolve()  # MS_EXT: override for harness checks
PORT = 8437
A = f"http://127.0.0.1:{PORT}"   # primary origin
B = f"http://localhost:{PORT}"   # second origin (cross-origin iframe child)
VW, VH = 1280, 800
BAR_H = 52
TEST_TIMEOUT = 75                # seconds per test, hard
HOST_TAG = "media-scrubber-ui"
FRAME = 0.04                     # 25 fps test media

EXTRA_HEADERS = {
    "/pages/hostile.html": {
        "Content-Security-Policy": "default-src 'self'; style-src 'self'; script-src 'self'; require-trusted-types-for 'script'",
    },
}


# ---------------------------------------------------------------- server

class Handler(http.server.SimpleHTTPRequestHandler):
    """Static files from test/, with Range support (media seeking), no-store and per-path headers."""
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".webm": "video/webm", ".js": "text/javascript"}

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(TEST), **kw)

    def log_message(self, *a):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        if self.command in ("GET", "HEAD") and not self.headers.get("Range"):
            self.send_header("Accept-Ranges", "bytes")
        for k, v in EXTRA_HEADERS.get(self.path.split("?")[0], {}).items():
            self.send_header(k, v)
        super().end_headers()

    def send_head(self):
        rng = self.headers.get("Range")
        path = self.translate_path(self.path)
        if not rng or not os.path.isfile(path):
            return super().send_head()
        m = re.match(r"bytes=(\d*)-(\d*)", rng)
        size = os.path.getsize(path)
        start = int(m.group(1)) if m and m.group(1) else 0
        end = int(m.group(2)) if m and m.group(2) else size - 1
        end = min(end, size - 1)
        if start > end:
            self.send_error(416)
            return None
        f = open(path, "rb")
        f.seek(start)
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(end - start + 1))
        self.end_headers()
        self._remaining = end - start + 1
        return f

    def copyfile(self, src, dst):
        n = getattr(self, "_remaining", None)
        if n is None:
            return super().copyfile(src, dst)
        while n > 0:
            chunk = src.read(min(65536, n))
            if not chunk:
                break
            dst.write(chunk)
            n -= len(chunk)


class V4(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


class V6(V4):
    address_family = socket.AF_INET6


def start_server():
    busy = subprocess.run(["lsof", f"-iTCP:{PORT}", "-sTCP:LISTEN", "-P", "-n"], capture_output=True, text=True).stdout.strip()
    if busy:
        sys.exit(f"ERROR: port {PORT} is already taken:\n{busy}")
    servers = [V4(("127.0.0.1", PORT), Handler)]
    try:
        servers.append(V6(("::1", PORT), Handler))   # localhost may resolve to ::1 first
    except OSError as e:
        print(f"note: no IPv6 loopback listener ({e}); localhost must resolve to 127.0.0.1")
    for s in servers:
        threading.Thread(target=s.serve_forever, daemon=True).start()
    return servers


def ensure_media():
    need = ["clip-5s.webm", "clip-3s.webm", "clip-2s.webm", "audio-8s.webm"]
    if not all((TEST / "media" / n).exists() for n in need):
        subprocess.run([sys.executable, str(TEST / "gen_media.py")], check=True)


# ---------------------------------------------------------------- helpers

class Fail(Exception):
    pass


class XFail(Exception):
    pass


class Info(Exception):
    """Informational test: prints INFO with numbers, never counted as pass/fail."""


def check(cond, msg):
    if not cond:
        raise Fail(msg)


async def wait_until(fn, timeout=5.0, interval=0.05, msg="condition"):
    """Poll fn() (sync or async) until truthy; return its value or raise Fail with the last value."""
    end = time.monotonic() + timeout
    last = None
    while True:
        try:
            last = fn()
            if asyncio.iscoroutine(last):
                last = await last
        except Fail:
            raise
        except Exception as e:  # page navigating, snapshot not ready, ...
            last = f"<{type(e).__name__}: {str(e).splitlines()[0][:160]}>"
            if time.monotonic() > end:
                raise Fail(f"timeout {timeout}s waiting for {msg}; last: {last}")
            await asyncio.sleep(interval)
            continue
        if last and not (isinstance(last, str) and last.startswith("<")):
            return last
        if time.monotonic() > end:
            raise Fail(f"timeout {timeout}s waiting for {msg}; last: {last!r}")
        await asyncio.sleep(interval)


def near(a, b, tol):
    return a is not None and b is not None and abs(a - b) <= tol


class Env:
    def __init__(self, ctx):
        self.ctx = ctx
        self.notes = []

    def note(self, *a):
        self.notes.append(" ".join(str(x) for x in a))

    async def sw(self):
        # Pages may register their own service workers; ours is the chrome-extension:// one.
        ours = lambda w: w.url.startswith("chrome-extension://")
        for w in self.ctx.service_workers:
            if ours(w):
                return w
        return await self.ctx.wait_for_event("serviceworker", predicate=ours, timeout=10000)

    async def tab_id(self, page):
        """Tab id of `page`. chrome.tabs.query({url}) needs the `tabs` permission, which the
        extension does not request (tab.url is undefined), so fall back to: bring the page to the
        front, take the active tab of the last focused window. Cached per page (survives reloads)."""
        tid = getattr(page, "_ms_tab_id", None)
        if tid is not None:
            return tid
        sw = await self.sw()
        tid = await asyncio.wait_for(sw.evaluate("""async (url) => {
            const tabs = await chrome.tabs.query({});
            const hit = tabs.filter(t => t.url === url);
            return hit.length === 1 ? hit[0].id : null; }""", page.url), 5)
        if tid is None:
            await page.bring_to_front()
            tid = await asyncio.wait_for(sw.evaluate("""async () => {
                const [t] = await chrome.tabs.query({active: true, lastFocusedWindow: true});
                return t ? t.id : null; }"""), 5)
        check(tid is not None, f"cannot find the tab id of {page.url}")
        page._ms_tab_id = tid
        return tid

    async def _sw_tab(self, page, body, arg=None):
        tid = await self.tab_id(page)
        sw = await self.sw()
        js = """async ([tabId, arg]) => { const tab = {id: tabId}; %s }""" % body
        return await asyncio.wait_for(sw.evaluate(js, [tid, arg]), 5)

    async def toggle(self, page):
        """Same code path as the toolbar icon (contracts §4)."""
        return await self._sw_tab(page, """
            if (typeof self.msToggle !== 'function') throw new Error('self.msToggle is not defined in the service worker');
            return await self.msToggle(tab.id);""")

    async def debug(self, page):
        return await self._sw_tab(page, "return await chrome.tabs.sendMessage(tab.id, {type: 'ms:debug'}, {frameId: 0});")

    async def open(self, page):
        r = await self.toggle(page)
        check(r and r.get("open") is True, f"msToggle did not open: {r}")
        return await wait_until(lambda: self._ui_bar(page), 3, msg="ui.rects.bar after open")

    async def _ui_bar(self, page):
        d = await self.debug(page)
        return d if d.get("open") and d.get("ui") and (d["ui"].get("rects") or {}).get("bar") else None

    async def active(self, page, pred=lambda a: True, timeout=5, msg="active media"):
        async def f():
            d = await self.debug(page)
            a = d.get("active")
            return d if a and pred(a) else None
        return await wait_until(f, timeout, msg=msg)

    async def rect(self, page, *path):
        d = await self.debug(page)
        r = d["ui"]["rects"]
        for p in path:
            r = r[p] if r else None
        check(r, f"no rect ui.rects.{'.'.join(path)} in snapshot")
        return r


async def click_rect(page, rect, fx=0.5, fy=0.5):
    x = rect["x"] + rect["width"] * fx
    y = rect["y"] + rect["height"] * fy
    await page.mouse.click(x, y)
    return x, y


async def js(page, expr, arg=None):
    return await page.evaluate(expr, arg) if arg is not None else await page.evaluate(expr)


async def goto(env, path, origin=A, ready="() => !!window.__t"):
    page = await env.ctx.new_page()
    page.on("pageerror", lambda e: env.note("pageerror:", str(e)[:120]))
    await page.goto(origin + path, wait_until="load", timeout=10000)
    await page.wait_for_function(ready, timeout=5000)
    return page


async def media_ready(page, name="main"):
    await page.wait_for_function(f"() => __t.media[{name!r}] && __t.media[{name!r}].readyState >= 2", timeout=8000)


async def ctime(page, name="main"):
    return await js(page, f"() => __t.media[{name!r}].currentTime")


async def frame_time(page, name="main"):
    """mediaTime of the last presented frame (rVFC, recorded by the page) — the frame-step base."""
    # wait until the presented frame matches the element's position (rVFC fires after seeked)
    try:
        await page.wait_for_function(
            f"() => Math.abs(__t.frames[{name!r}] - __t.media[{name!r}].currentTime) < 0.041", timeout=600)
    except Exception:
        pass
    return await js(page, f"() => __t.frames[{name!r}]")


async def wait_seeked(page, name="main"):
    await page.wait_for_function(f"() => !__t.media[{name!r}].seeking", timeout=3000)
    await page.wait_for_timeout(60)


def check_bar_rect(bar):
    check(near(bar["x"], 0, 1) and near(bar["width"], VW, 1), f"bar not full width: {bar}")
    check(near(bar["height"], BAR_H, 1), f"bar height {bar['height']} != {BAR_H}")
    check(near(bar["y"] + bar["height"], VH, 1), f"bar not at the bottom: {bar}")


# ---------------------------------------------------------------- tests (with the extension)

async def t_all_pages(env):
    """Nothing happens until opened; close releases the lock; reload forgets."""
    for path in ["/pages/single.html", "/pages/recycle.html?noautoplay", "/pages/shadow.html", "/pages/audio.html", "/pages/nomedia.html"]:
        page = await goto(env, path)
        await page.wait_for_timeout(300)
        d = await env.debug(page)
        check(d.get("open") is False and d.get("ui") is None, f"{path}: before open: open={d.get('open')} ui={d.get('ui')}")
        check(await js(page, f"() => !document.querySelector('{HOST_TAG}')"), f"{path}: {HOST_TAG} exists before open")
        check(d.get("lock") is None, f"{path}: lock {d.get('lock')} before open")
        name = await js(page, "() => Object.keys(__t.media)[0] || null")
        if name:
            await js(page, f"() => __t.setRate({name!r}, 1.25)")
            await page.wait_for_timeout(250)
            r = await js(page, f"() => __t.media[{name!r}].playbackRate")
            check(r == 1.25, f"{path}: page rate write did not stick before open ({r})")
        await page.close()
    env.note("5 pages untouched before open")
    # close releases, reload forgets
    page = await goto(env, "/pages/single.html")
    await media_ready(page)
    await env.open(page)
    await env.toggle(page)
    d = await wait_until(lambda: _closed(env, page), 3, msg="closed snapshot")
    check(d["lock"] is None, f"lock after close: {d['lock']}")
    await js(page, "() => __t.setRate('main', 1.5)")
    await page.wait_for_timeout(250)
    check(await js(page, "() => __t.media.main.playbackRate") == 1.5, "page rate write does not stick after close")
    await env.open(page)
    await page.reload()
    await page.wait_for_function("() => !!window.__t", timeout=5000)
    d = await wait_until(lambda: env.debug(page), 3, msg="snapshot after reload")
    check(d["open"] is False, f"reload did not forget: open={d['open']}")
    await page.close()


async def _closed(env, page):
    d = await env.debug(page)
    return d if d.get("open") is False else None


async def t_single(env):
    page = await goto(env, "/pages/single.html")
    await media_ready(page)
    d = await env.open(page)
    check_bar_rect(d["ui"]["rects"]["bar"])
    env.note("bar", d["ui"]["rects"]["bar"])
    await env.active(page, lambda a: a["src"].endswith("clip-5s.webm"), msg="clip-5s active")
    dur = await js(page, "() => __t.media.main.duration")
    rail = await env.rect(page, "rail")
    # click-seek accuracy
    for f in (0.3, 0.7, 0.1):
        await click_rect(page, rail, f)
        await wait_seeked(page)
        ct = await ctime(page)
        tol = FRAME + dur / rail["width"]
        check(near(ct, f * dur, tol), f"click at {f}: currentTime {ct:.3f} vs {f * dur:.3f} (tol {tol:.3f})")
        env.note(f"click {f}: {ct:.3f}/{f * dur:.3f}")
    # Space toggles; page listeners never see Space/arrows but see other keys
    await js(page, "() => { __t.pageKeys.length = 0; __t.docCaptureKeys.length = 0; }")
    await page.keyboard.press("Space")
    await wait_until(lambda: js(page, "() => !__t.media.main.paused"), 2, msg="Space plays")
    await page.keyboard.press("Space")
    await wait_until(lambda: js(page, "() => __t.media.main.paused"), 2, msg="Space pauses")
    await page.keyboard.press("ArrowRight"); await page.keyboard.press("ArrowLeft")
    await page.keyboard.press("KeyJ")
    await page.wait_for_timeout(100)
    for lst in ("pageKeys", "docCaptureKeys"):
        codes = await js(page, f"() => __t.{lst}.map(k => k.type + ':' + k.code)")
        leaked = [c for c in codes if c.split(":")[1] in ("Space", "ArrowLeft", "ArrowRight")]
        check(not leaked, f"{lst} saw our keys: {leaked}")
        check("keydown:KeyJ" in codes and "keyup:KeyJ" in codes, f"{lst} did not see KeyJ: {codes}")
    # drag keeps play state (playing)
    await page.keyboard.press("Space")
    await wait_until(lambda: js(page, "() => !__t.media.main.paused"), 2, msg="playing before drag")
    y = rail["y"] + rail["height"] / 2
    await page.mouse.move(rail["x"] + rail["width"] * 0.2, y)
    await page.mouse.down()
    for i in range(1, 11):
        await page.mouse.move(rail["x"] + rail["width"] * (0.2 + 0.04 * i), y)
        await page.wait_for_timeout(30)
        check(not await js(page, "() => __t.media.main.paused"), "playing video paused during drag")
    await page.mouse.up()
    await page.wait_for_timeout(150)
    ct = await ctime(page)
    check(not await js(page, "() => __t.media.main.paused"), "not playing after drag")
    check(0.6 * dur - 0.1 <= ct <= 0.6 * dur + 0.5, f"after playing drag to 0.6: {ct:.3f}")
    # paused drag stays paused
    await page.keyboard.press("Space")
    await wait_until(lambda: js(page, "() => __t.media.main.paused"), 2, msg="paused")
    await page.mouse.move(rail["x"] + rail["width"] * 0.6, y)
    await page.mouse.down()
    await page.mouse.move(rail["x"] + rail["width"] * 0.4, y, steps=8)
    check(await js(page, "() => __t.media.main.paused"), "paused video played during drag")
    await page.mouse.up()
    await wait_seeked(page)
    ct = await ctime(page)
    check(near(ct, 0.4 * dur, FRAME + dur / rail["width"]), f"paused drag to 0.4: {ct:.3f}")
    check(await js(page, "() => __t.media.main.paused"), "paused video plays after drag")
    # ladder on a paused video
    await page.wait_for_timeout(700)
    deltas = []
    for i in range(4):
        t0 = await (frame_time(page) if i == 0 else ctime(page))
        await page.keyboard.press("ArrowLeft")
        await wait_seeked(page)
        deltas.append(round(t0 - await (frame_time(page) if i == 0 else ctime(page)), 3))
        await page.wait_for_timeout(120)
    env.note("ladder deltas", deltas)
    for got, want in zip(deltas, [FRAME, 0.1, 0.2, 0.5]):
        check(near(got, want, 0.005), f"ladder steps {deltas}, want [0.04, 0.1, 0.2, 0.5]")
    await page.wait_for_timeout(700)
    lbl = (await env.debug(page))["ui"].get("stepLabels")
    check(lbl and lbl.get("back") == "1f", f"stepLabels after streak expiry: {lbl}")
    t0 = await frame_time(page)
    await page.keyboard.press("ArrowLeft")
    await wait_seeked(page)
    dt = t0 - await frame_time(page)
    check(near(dt, FRAME, 0.005), f"after >600 ms gap the step is {dt:.3f}, want 1 frame")
    # typing in an input is untouched
    t0 = await ctime(page)
    await page.click("#txt")
    await page.keyboard.type("a b")
    await page.keyboard.press("ArrowLeft"); await page.keyboard.press("ArrowRight"); await page.keyboard.press("Space")
    await page.wait_for_timeout(200)
    val = await js(page, "() => document.getElementById('txt').value")
    check(val == "a b ", f"input value {val!r}")
    check(await js(page, "() => __t.media.main.paused") and near(await ctime(page), t0, 0.001), "media changed while typing")
    await js(page, "() => document.activeElement.blur()")
    # presets + preservesPitch
    await click_rect(page, await env.rect(page, "speed", "0.5"))
    d = await env.active(page, lambda a: a["playbackRate"] == 0.5, 2, msg="rate 0.5 after chip")
    check(d["active"]["preservesPitch"] is True, f"preservesPitch {d['active']['preservesPitch']}")
    check(d["lock"] == 0.5, f"lock {d['lock']}")
    # dragging to/past the end does not fire ended
    ended0 = await js(page, "() => __t.ended")
    await page.mouse.move(rail["x"] + rail["width"] * 0.8, y)
    await page.mouse.down()
    await page.mouse.move(VW + 50, y, steps=6)
    await page.mouse.up()
    await page.wait_for_timeout(500)
    ct = await ctime(page)
    check(await js(page, "() => __t.ended") == ended0, "dragging past the end fired ended")
    check(ct < dur, f"currentTime {ct} at/after duration {dur}")
    env.note(f"drag past end: {ct:.3f}/{dur:.3f}")
    await page.close()


async def t_ladder_cap(env):
    page = await goto(env, "/pages/single.html?clip=clip-3s.webm")
    await media_ready(page)
    await env.open(page)
    await env.active(page, lambda a: a["src"].endswith("clip-3s.webm"), msg="clip-3s active")
    await click_rect(page, await env.rect(page, "rail"), 0.03)
    await wait_seeked(page)
    await page.wait_for_timeout(700)
    deltas = []
    for i in range(6):
        t0 = await (frame_time(page) if i == 0 else ctime(page))
        await page.keyboard.press("ArrowRight")
        await wait_seeked(page)
        deltas.append(round(await (frame_time(page) if i == 0 else ctime(page)) - t0, 3))
        await page.wait_for_timeout(120)
    dur = await js(page, "() => __t.media.main.duration")
    cap = max(0.1, dur / 4)   # DESIGN §6.5; UI-DESIGN §2.3 says "never more than 0.5 s" (rung below the cap)
    env.note("deltas", deltas, f"cap {cap:.3f}")
    check(max(deltas) <= cap + 0.005, f"{dur:.2f} s clip stepped more than {cap:.3f} s: {deltas}")
    check(deltas[-1] >= 0.5 - 0.005, f"ladder did not climb to the cap region: {deltas}")
    await page.close()


async def _reels_open(env, rate_chip=None, path="/pages/reels.html"):
    page = await goto(env, path)
    await page.wait_for_function("() => __t.clipsStarted.length >= 1", timeout=8000)
    await env.open(page)
    await env.active(page, lambda a: not a["paused"], msg="playing reel active")
    if rate_chip:
        await click_rect(page, await env.rect(page, "speed", rate_chip))
    return page


async def _reels_wait_end_and_continue(env, page, n_clips, per_clip, rate=1.0):
    """Stop at end (DESIGN §6.13, UI-DESIGN §2.4; Space = CONTINUE).

    Every clip, on both advance paths (`ended`: 5 s, 2 s; the page's own early pause at
    duration - 0.05: 3 s), stops paused at its end: no `ended`, no advance for >= 700 ms.
    Space → the site advances to the next clip by its own logic; it plays at the locked rate
    and stops at its end again. The 2 s clip comes right after a Space (old activation hole).
    """
    out = []
    for k in range(n_clips):
        idx = await js(page, "() => __t.index()")
        clip = await js(page, "() => __t.current().dataset.clip")
        ended0 = await js(page, "() => __t.ended")
        adv0 = await js(page, "() => __t.advances.length")
        dur = await js(page, "() => { window.__endEl = __t.current(); return __endEl.duration; }")
        d = await wait_until(lambda: _at_end(env, page), per_clip(dur), msg=f"atEnd on {clip}")
        await page.wait_for_timeout(750)
        d = await env.debug(page)
        st = await js(page, f"""() => {{ const v = window.__endEl;
            return {{i: __t.index(), ended: __t.ended, adv: __t.advances.slice({adv0}).map(a => a.via),
                     paused: v.paused, t: v.currentTime, d: v.duration, connected: v.isConnected}}; }}""")
        rec = {"clip": clip, "left": round(st["d"] - st["t"], 3), "gateHeld": d.get("gateHeld"), "adv": st["adv"]}
        out.append(rec)
        check(st["ended"] == ended0, f"{clip}: `ended` fired ({rec})")
        check(st["adv"] == [] and st["i"] == idx and st["connected"], f"{clip}: page advanced within 750 ms of the stop ({rec})")
        check(st["paused"], f"{clip}: not paused at end ({rec})")
        check(rec["left"] < 0.2, f"{clip}: stopped {rec['left']} s before the end ({rec})")
        await page.keyboard.press("Space")
        await wait_until(lambda: js(page, f"() => __t.index() === {idx + 1} && !__t.current().paused"), 3,
                         msg=f"Space → the site advances after {clip}")
        await page.wait_for_timeout(300)
        r = await js(page, "() => __t.current().playbackRate")
        check(r == rate, f"next clip after {clip} plays at {r}, want {rate}")
    return out


async def _reels_next_button(env, page, rate):
    """A real click on the site's own "next" during playback moves on at once."""
    await wait_until(lambda: js(page, "() => !__t.current().paused && __t.current().currentTime > 0.2"), 3, msg="playing before #next")
    idx = await js(page, "() => __t.index()")
    t0 = time.monotonic()
    await page.click("#next")
    await wait_until(lambda: js(page, f"() => __t.index() === {idx + 1} && !__t.current().paused"), 1.0, 0.02,
                     msg="#next click moves on immediately")
    dt = time.monotonic() - t0
    await page.wait_for_timeout(300)
    r = await js(page, "() => __t.current().playbackRate")
    check(r == rate, f"after #next the clip plays at {r}, want {rate}")
    return round(dt, 2)


async def _at_end(env, page):
    d = await env.debug(page)
    return d if d.get("atEnd") else None


async def t_reels(env):
    page = await _reels_open(env, "0.5")
    await env.active(page, lambda a: a["playbackRate"] == 0.5, 2, msg="0.5 on the first reel")
    samples = []

    async def sample():
        while True:
            d = await env.debug(page)
            a = d["active"]
            if a and not a["paused"]:
                samples.append(a["playbackRate"])
            await asyncio.sleep(0.25)
    task = asyncio.create_task(sample())
    try:
        res = await _reels_wait_end_and_continue(env, page, 3, lambda dur: dur * 2 + 4, rate=0.5)
        res.append({"next_button_s": await _reels_next_button(env, page, 0.5)})
    finally:
        task.cancel()
    await page.wait_for_timeout(500)
    d = await env.debug(page)
    seen = await js(page, "() => __t.rateSeen")
    env.note("clips", res, "| samples", len(samples), "distinct", sorted(set(samples)), "| counters", d["counters"])
    check(samples and all(r == 0.5 for r in samples), f"active.playbackRate not held at 0.5: {sorted(set(samples))}")
    check(all(s["max"] <= 0.5 for s in seen[1:]), f"page saw rates above 0.5: {seen}")
    check(d["counters"]["siteRateWrites"] > 0, f"counters.siteRateWrites {d['counters']['siteRateWrites']}")
    check(d["counters"]["reapplies"] < 10, f"counters.reapplies {d['counters']['reapplies']}")
    check(await js(page, "() => __t.siteRateWrites") > 0, "page never re-asserted (fixture broken?)")
    await page.close()


async def t_reels_stop_at_end(env):
    page = await _reels_open(env)
    res = await _reels_wait_end_and_continue(env, page, 3, lambda dur: dur + 4, rate=1.0)
    res.append({"next_button_s": await _reels_next_button(env, page, 1.0)})
    env.note(res)
    paths = [c["clip"] for c in res if "clip" in c]
    check("clip-3s.webm" in paths, f"early-advance clip not covered: {paths}")
    await page.close()


async def t_recycle(env):
    page = await goto(env, "/pages/recycle.html")
    await media_ready(page)
    await env.open(page)
    await env.active(page, msg="recycle active")
    await click_rect(page, await env.rect(page, "speed", "0.5"))
    await env.active(page, lambda a: a["playbackRate"] == 0.5, 2, msg="0.5")
    w0 = await js(page, "() => __t.emptiedWrites")
    await js(page, "() => __t.next()")    # the site swaps src on the same element
    d = await env.active(page, lambda a: a["src"].endswith("clip-3s.webm") and not a["paused"], 5, msg="clip-3s on the same element")
    await page.wait_for_timeout(500)
    d = await env.debug(page)
    r = await js(page, "() => __t.media.main.playbackRate")
    check(await js(page, "() => __t.emptiedWrites") > w0, "page did not write on emptied (fixture)")
    check(r == 0.5 and d["active"]["playbackRate"] == 0.5, f"rate after src swap {r}")
    env.note("rate after swap", r, "counters", d["counters"])
    await page.close()


async def _control_named(env, page, name, clip):
    await js(page, f"() => {{ for (const [k, m] of Object.entries(__t.media)) if (k !== {name!r}) m.pause(); return __t.media[{name!r}].play(); }}")
    await env.active(page, lambda a: a["src"].endswith(clip) and not a["paused"], 5, msg=f"{name} ({clip}) active")
    await js(page, f"() => __t.media[{name!r}].pause()")
    await env.active(page, lambda a: a["paused"], 2, msg="paused")
    dur = await js(page, f"() => __t.media[{name!r}].duration")
    await click_rect(page, await env.rect(page, "rail"), 0.5)
    await wait_seeked(page, name)
    ct = await ctime(page, name)
    check(near(ct, dur / 2, FRAME + dur / VW), f"{name}: rail click → {ct:.3f}, want {dur / 2:.3f}")
    return ct


async def t_shadow(env):
    page = await goto(env, "/pages/shadow.html")
    check(await js(page, "() => !!document.getElementById('open-host').shadowRoot && document.getElementById('closed-host').shadowRoot === null"), "fixture roots")
    await media_ready(page, "nested")
    await env.open(page)
    for name, clip in (("open", "clip-5s.webm"), ("closed", "clip-3s.webm"), ("nested", "clip-2s.webm")):
        ct = await _control_named(env, page, name, clip)
        env.note(f"{name}: {ct:.3f}")
    await page.close()


async def t_audio(env):
    page = await goto(env, "/pages/audio.html")
    await env.open(page)
    await page.click("#aplay")
    await env.active(page, lambda a: a["kind"] == "audio" and not a["paused"], 5, msg="hidden audio active")
    await page.click("#apause")
    await click_rect(page, await env.rect(page, "rail"), 0.25)
    await wait_seeked(page, "hidden")
    ct = await ctime(page, "hidden")
    check(near(ct, 2.0, 0.06), f"hidden audio rail 0.25 → {ct:.3f}")
    ref0 = (await env.debug(page))["active"]["ref"]
    await page.click("#detached")
    await env.active(page, lambda a: a["ref"] != ref0 and not a["paused"], 5, msg="detached Audio() active")
    await click_rect(page, await env.rect(page, "rail"), 0.75)
    await page.wait_for_timeout(300)
    ct = await ctime(page, "detached")
    check(5.9 <= ct <= 6.6, f"detached audio rail 0.75 → {ct:.3f}")
    env.note(f"hidden {ref0}; detached at {ct:.3f}")
    await page.close()


async def t_spa(env):
    page = await goto(env, "/pages/spa.html")
    await media_ready(page)
    await env.open(page)
    await env.active(page, msg="spa active")
    await click_rect(page, await env.rect(page, "speed", "0.75"))
    await env.active(page, lambda a: a["playbackRate"] == 0.75, 2, msg="0.75")
    await page.click("#nav")
    await env.active(page, lambda a: a["src"].endswith("clip-3s.webm") and not a["paused"], 5, msg="rebind to new element")
    await page.wait_for_timeout(400)
    r = await js(page, "() => [__t.media.main.dataset.gen, __t.media.main.playbackRate]")
    check(r == ["2", 0.75], f"after pushState: gen/rate {r}")
    check((await env.debug(page))["open"], "bar closed by SPA navigation")
    await page.close()


async def _fs_enter(env, page, btn):
    await page.click(btn)
    await wait_until(lambda: js(page, "() => !!document.fullscreenElement"), 3, msg=f"{btn} fullscreen")
    await page.wait_for_timeout(300)


async def _fs_exit_check(env, page):
    await js(page, "() => document.exitFullscreen()")
    await wait_until(lambda: js(page, "() => !document.fullscreenElement"), 3, msg="exit fullscreen")
    await page.wait_for_timeout(200)
    d = await env.debug(page)
    check(d["ui"] and d["ui"]["hostPresent"], "bar gone after fullscreen exit")
    check_bar_rect(d["ui"]["rects"]["bar"])


async def _bar_hit(env, page):
    bar = await env.rect(page, "bar")
    tag = await js(page, "([x, y]) => { const e = document.elementFromPoint(x, y); return e && e.tagName.toLowerCase(); }",
                   [bar["x"] + bar["width"] / 2, bar["y"] + bar["height"] / 2])
    return bar, tag


async def t_fullscreen_container(env):
    page = await goto(env, "/pages/fullscreen.html")
    await media_ready(page)
    await env.open(page)
    await _fs_enter(env, page, "#fs-container")
    bar, tag = await _bar_hit(env, page)
    env.note("bar", bar)
    check(tag == HOST_TAG, f"elementFromPoint at the bar = {tag}")
    await click_rect(page, await env.rect(page, "speed", "0.5"))
    await env.active(page, lambda a: a["playbackRate"] == 0.5, 2, msg="speed chip clickable in container fullscreen")
    await _fs_exit_check(env, page)
    await page.close()


async def t_fullscreen_video(env):
    page = await goto(env, "/pages/fullscreen.html")
    await media_ready(page)
    await env.open(page)
    await _fs_enter(env, page, "#fs-video")
    # our keys must work while the <video> itself is fullscreen (not XFAIL-able)
    p0 = await js(page, "() => __t.media.main.paused")
    await page.keyboard.press("Space")
    await wait_until(lambda: js(page, f"() => __t.media.main.paused === {'false' if p0 else 'true'}"), 2, msg="Space toggles in <video> fullscreen")
    check("Space" not in await js(page, "() => __t.pageKeys.map(k => k.code)"), "page saw Space in <video> fullscreen")
    env.note("Space ok in <video> fullscreen")
    # Decided (DESIGN §6.8): with the <video> itself fullscreen the bar is keys-only —
    # Chrome paints it but does not hit-test outside the fullscreen <video>.
    t0 = await js(page, "() => __t.media.main.currentTime")
    await page.keyboard.press("ArrowLeft")
    await wait_until(lambda: js(page, f"() => __t.media.main.currentTime < {t0} - 0.01 || __t.media.main.currentTime === 0"), 2,
                     msg="ArrowLeft steps in <video> fullscreen")
    bar, tag = await _bar_hit(env, page)
    env.note("bar", bar, "hit", tag, "(keys-only by design)")
    ui = (await env.debug(page))["ui"]
    check(ui and ui["hostPresent"] and ui["popoverOpen"], "bar not painted in <video> fullscreen")
    await _fs_exit_check(env, page)
    await page.close()


async def t_reels_pauseadvance(env):
    """INFO: a site that advances on ANY pause near the end, including our stop-at-end pause."""
    page = await goto(env, "/pages/reels.html?pauseadvance")
    await page.wait_for_function("() => __t.clipsStarted.length >= 1", timeout=8000)
    await env.open(page)
    await env.active(page, lambda a: not a["paused"], msg="playing reel active")
    rate = (await env.debug(page))["active"]["playbackRate"]
    info = []
    for _ in range(3):
        idx = await js(page, "() => __t.index()")
        clip = await js(page, "() => { window.__endEl = __t.current(); return __endEl.dataset.clip; }")
        adv0 = await js(page, "() => __t.advances.length")
        dur = await js(page, "() => __endEl.duration")

        async def stopped_or_moved():
            d = await env.debug(page)
            moved = await js(page, f"() => __t.advances.length > {adv0}")
            return d if d.get("atEnd") or moved else None
        try:
            await wait_until(stopped_or_moved, dur / rate + 4, msg=f"stop on {clip}")
        except Fail as e:
            info.append({"clip": clip, "error": str(e)[:120]})
            break
        await page.wait_for_timeout(750)
        d = await env.debug(page)
        st = await js(page, f"""() => ({{ i: __t.index(), adv: __t.advances.slice({adv0}).map(a => a.via),
            oldPaused: __endEl.paused, left: +(__endEl.duration - __endEl.currentTime).toFixed(3),
            nextPlaying: __t.index() !== {idx} && !__t.current().paused,
            visibleSlotChanged: __t.index() !== {idx} }})""")
        rec = {"clip": clip, "gateHeld": d.get("gateHeld"), "atEnd": d.get("atEnd"), **st}
        await page.keyboard.press("Space")
        try:
            await wait_until(lambda: js(page, f"() => __t.index() === {idx + 1} && !__t.current().paused"), 3, msg="Space → next plays")
            await page.wait_for_timeout(300)
            rec["afterSpace"] = {"nextPlays": True, "rate": await js(page, "() => __t.current().playbackRate"), "lockedRate": rate}
        except Fail:
            rec["afterSpace"] = {"nextPlays": False, "index": await js(page, "() => __t.index()"),
                                 "curPaused": await js(page, "() => __t.current().paused")}
            info.append(rec)
            break
        info.append(rec)
    for r in info:
        env.note(r)
    await page.close()
    raise Info(f"{len(info)} clip(s) observed")


async def _reels_adaptive(env, rate):
    """Adaptive end margin (DESIGN §6.13): the page ends every clip itself 0.25 s before its end.

    The first clip may be pre-empted (recorded); the extension learns how early the site acts,
    and every following clip stops paused at its end before the page acts.
    """
    page = await _reels_open(env, None if rate == 1.0 else str(rate), path="/pages/reels.html?earlyms=250")
    if rate != 1.0:
        await env.active(page, lambda a: a["playbackRate"] == rate, 2, msg=f"{rate} on the first reel")
    out = []
    # First clip: stop or pre-emption.
    idx = await js(page, "() => __t.index()")
    adv0 = await js(page, "() => __t.advances.length")
    dur = await js(page, "() => { window.__endEl = __t.current(); return __endEl.duration; }")

    async def stopped_or_moved():
        d = await env.debug(page)
        moved = await js(page, f"() => __t.advances.length > {adv0}")
        return d if d.get("atEnd") or moved else None
    await wait_until(stopped_or_moved, dur / rate + 4, msg="first clip: stop or site advance")
    await page.wait_for_timeout(400)
    d = await env.debug(page)
    st = await js(page, f"""() => ({{ adv: __t.advances.slice({adv0}).map(a => a.via), i: __t.index(),
        left: +(__endEl.duration - __endEl.currentTime).toFixed(3), nextPlaying: __t.index() !== {idx} && !__t.current().paused }})""")
    first = {"first": True, "gateHeld": d.get("gateHeld"), "endMargin": d.get("endMargin"), **st}
    out.append(first)
    if not st["nextPlaying"]:
        await page.keyboard.press("Space")
    await wait_until(lambda: js(page, f"() => __t.index() === {idx + 1} && !__t.current().paused"), 3,
                     msg="after the first clip the next one plays")
    await page.wait_for_timeout(300)
    r = await js(page, "() => __t.current().playbackRate")
    check(r == rate, f"clip after the first plays at {r}, want {rate}")
    # Following clips: must stop before the page acts.
    for k in range(3):
        idx = await js(page, "() => __t.index()")
        clip = await js(page, "() => __t.current().dataset.clip")
        adv0 = await js(page, "() => __t.advances.length")
        dur = await js(page, "() => { window.__endEl = __t.current(); return __endEl.duration; }")
        await wait_until(stopped_or_moved, dur / rate + 4, msg=f"atEnd on {clip}")
        await page.wait_for_timeout(750)
        d = await env.debug(page)
        st = await js(page, f"""() => {{ const v = window.__endEl;
            return {{i: __t.index(), adv: __t.advances.slice({adv0}).map(a => a.via), paused: v.paused,
                     left: +(v.duration - v.currentTime).toFixed(3), connected: v.isConnected}}; }}""")
        em = d.get("endMargin") or {}
        rec = {"clip": clip, "gateHeld": d.get("gateHeld"), "learned": round(em.get("learned") or 0, 3),
               "effective": round(em.get("effective") or 0, 3), **st}
        out.append(rec)
        check(st["adv"] == [] and st["i"] == idx and st["connected"], f"{clip}: page acted before our stop ({rec})")
        check(st["paused"] and d.get("atEnd"), f"{clip}: not stopped at end ({rec})")
        check(0.25 < st["left"] < 0.5, f"{clip}: stop point {st['left']} s before the end ({rec})")
        check(0.25 <= rec["learned"] <= 0.35, f"learned margin {rec['learned']} not in 0.25..0.35 ({rec})")
        await page.keyboard.press("Space")
        await wait_until(lambda: js(page, f"() => __t.index() === {idx + 1} && !__t.current().paused"), 3,
                         msg=f"Space → the site advances after {clip}")
        await page.wait_for_timeout(300)
        r = await js(page, "() => __t.current().playbackRate")
        check(r == rate, f"next clip after {clip} plays at {r}, want {rate}")
    for x in out:
        env.note(x)
    await page.close()


async def t_reels_adaptive(env):
    await _reels_adaptive(env, 1.0)


async def t_reels_adaptive_slow(env):
    await _reels_adaptive(env, 0.5)


async def t_live(env):
    page = await goto(env, "/pages/live.html")
    await page.wait_for_function("() => __t.live.stage === 'ready' && __t.media.main.readyState >= 2", timeout=8000)
    await env.open(page)
    d = await env.active(page, msg="MSE active")
    ro = d["ui"]["readout"]
    m = ((d.get("model") or {}).get("media")) or None
    env.note("readout", repr(ro), "model.media", {k: m.get(k) for k in ("range", "live", "duration")} if m else "absent",
             "info", await js(page, "() => __t.info()"))
    check(re.search(r"LIVE|\d+:\d\d\.\d", ro or ""), f"readout {ro!r}")
    if m is not None:
        rng, live = m.get("range"), m.get("live")
        if rng is None:
            check(live is True or "LIVE" in (ro or ""), f"rail disabled but not marked live: {m}")
        else:
            check(rng["start"] >= -0.05 and rng["end"] <= 5.1 and rng["end"] - rng["start"] >= 1, f"range not the seekable window: {rng}")
    await click_rect(page, await env.rect(page, "rail"), 0.5)
    await page.wait_for_timeout(400)
    info = await js(page, "() => __t.info()")
    sk = info["seekable"]
    check(not sk or sk[0][0] - 0.05 <= info["currentTime"] <= sk[-1][1] + 0.05, f"currentTime outside seekable: {info}")
    await page.close()


async def t_hostile(env):
    page = await goto(env, "/pages/hostile.html")
    await media_ready(page)
    d = await env.open(page)
    check_bar_rect(d["ui"]["rects"]["bar"])
    await env.active(page, msg="hostile active")
    await click_rect(page, await env.rect(page, "speed", "0.5"))
    await env.active(page, lambda a: a["playbackRate"] == 0.5, 2, msg="0.5 via chip on hostile page")
    await js(page, "() => __t.media.main.pause()")
    await click_rect(page, await env.rect(page, "rail"), 0.5)
    await wait_seeked(page)
    ct = await ctime(page)
    check(near(ct, 2.5, FRAME + 5 / VW), f"rail click → {ct:.3f}")
    bar = await env.rect(page, "bar")
    tag = await js(page, "([x, y]) => document.elementFromPoint(x, y).tagName.toLowerCase()", [bar["x"] + bar["width"] / 2, bar["y"] + 10])
    check(tag == HOST_TAG, f"elementFromPoint over the max-z overlay = {tag}")
    await page.close()


async def t_ambient(env):
    page = await goto(env, "/pages/ambient.html")
    await page.wait_for_function("() => !__t.media.ambient.paused", timeout=8000)
    await media_ready(page)
    await env.open(page)
    await js(page, "() => __t.media.main.play()")
    d = await env.active(page, lambda a: a["src"].endswith("clip-5s.webm"), 5, msg="normal player active")
    await page.wait_for_timeout(2500)   # the ambient loop restarts meanwhile
    d = await env.debug(page)
    check(d["active"]["src"].endswith("clip-5s.webm"), f"active switched to {d['active']['src']}")
    amb = [c for c in d["candidates"] if c["src"].endswith("clip-2s.webm")]
    check(amb and amb[0]["ambient"], f"ambient candidate not flagged: {d['candidates']}")
    await page.close()


async def t_iframe(env):
    page = await goto(env, "/pages/iframe.html")
    await page.wait_for_timeout(1000)
    cross = next((f for f in page.frames if f.url.startswith(B)), None)
    check(cross, f"cross frame missing: {[f.url for f in page.frames]}")
    await cross.wait_for_function("() => __t.media.main.readyState >= 2", timeout=8000)
    await env.open(page)
    await cross.evaluate("() => __t.media.main.play()")
    try:
        await env.active(page, lambda a: not a["paused"], 5, msg="cross-origin child active")
        await cross.evaluate("() => __t.media.main.pause()")
        await click_rect(page, await env.rect(page, "rail"), 0.5)
        await page.wait_for_timeout(400)
        ct = await cross.evaluate("() => __t.media.main.currentTime")
        check(near(ct, 2.5, 0.05), f"cross child rail click → {ct:.3f}")
        box = await page.locator("#cross").bounding_box()
        await page.mouse.click(box["x"] + 50, box["y"] + 50)   # focus inside the child
        await cross.evaluate("() => { __t.pageKeys.length = 0; }")
        await page.keyboard.press("Space")
        await page.wait_for_timeout(300)
        check(not await cross.evaluate("() => __t.media.main.paused"), "Space with focus in child did not play")
        codes = await cross.evaluate("() => __t.pageKeys.map(k => k.code)")
        check("Space" not in codes, f"child page saw Space: {codes}")
    except Fail as e:
        if IFRAME_XFAIL:
            raise XFail(str(e))
        raise
    if IFRAME_XFAIL:
        env.note("XPASS: flip IFRAME_XFAIL")
    await page.close()


async def _stop_sw(env, page):
    """Terminate the extension service worker (as Chrome does when it goes idle)."""
    cdp = await env.ctx.new_cdp_session(page)
    targets = (await cdp.send("Target.getTargets"))["targetInfos"]
    sws = [t for t in targets if t["type"] == "service_worker" and t["url"].startswith("chrome-extension://")]
    check(sws, f"no extension service worker target: {[t['type'] for t in targets]}")
    for t in sws:
        await cdp.send("Target.closeTarget", {"targetId": t["targetId"]})
    await cdp.detach()


async def t_iframe_extra(env):
    """Frames (DESIGN §6.12): rate lock, readout extrapolation, frame step, stop at end inside a
    cross-origin child, keys forwarded from the child, reconnect after a service worker restart."""
    page = await goto(env, "/pages/iframe.html")
    await page.wait_for_timeout(1000)
    cross = next((f for f in page.frames if f.url.startswith(B)), None)
    check(cross, "cross frame missing")
    await cross.wait_for_function("() => __t.media.main.readyState >= 2", timeout=8000)
    # opening must not change what plays: the embed runs at 1.25 before open
    await cross.evaluate("() => { __t.setRate('main', 1.25); return __t.media.main.play(); }")
    await page.wait_for_timeout(200)
    await env.open(page)
    await env.active(page, lambda a: not a["paused"], 5, msg="cross child active")
    await page.wait_for_timeout(400)
    cr = await cross.evaluate("() => __t.media.main.playbackRate")
    d = await env.debug(page)
    env.note(f"after open: child rate {cr}, intent {d['intent']['rate']}, model {d['model']['rate']}, lock {d['lock']}")
    check(cr == 1.25 and d["intent"]["rate"] == 1.25 and d["model"]["rate"] == 1.25, "open changed the embed's rate")
    # rate lock inside the child: our rate is applied and a page write cannot change it
    await click_rect(page, await env.rect(page, "speed", "0.75"))
    await page.wait_for_timeout(300)
    r = await cross.evaluate("() => [__t.media.main.playbackRate, __t.media.main.defaultPlaybackRate, __t.setRate('main', 1)]")
    check(r == [0.75, 0.75, 0.75], f"child rate/defaultRate/after page write: {r}")
    # readout extrapolation vs the child's real currentTime
    worst = 0
    for _ in range(8):
        await page.wait_for_timeout(130)
        c1 = await cross.evaluate("() => __t.media.main.currentTime")
        d = await env.debug(page)
        c2 = await cross.evaluate("() => __t.media.main.currentTime")
        m = d["model"]["media"]["time"]
        err = 0 if c1 <= m <= c2 else min(abs(m - c1), abs(m - c2))
        worst = max(worst, err)
    env.note(f"readout vs child currentTime: worst {worst:.3f}s outside the sampling window")
    check(worst <= 0.1, f"remote readout off by {worst:.3f}s")
    # frame step on the paused child (→ from the top frame, focus in the top document)
    await cross.evaluate("() => __t.media.main.pause()")
    await page.wait_for_timeout(300)
    await page.mouse.click(20, 20)
    # compare presented frames (rVFC mediaTime): a paused currentTime sits mid-frame, so its
    # delta after a one-frame step is anywhere in (0, 0.04]
    t0 = await frame_time(cross)
    c0 = await cross.evaluate("() => __t.media.main.currentTime")
    await page.keyboard.press("ArrowRight")
    await wait_seeked(cross)
    t1 = await frame_time(cross)
    c1 = await cross.evaluate("() => __t.media.main.currentTime")
    env.note(f"frame step in child (presented frame): {t0:.3f} → {t1:.3f} (currentTime {c0:.3f} → {c1:.3f})")
    check(near(t1 - t0, 0.04, 0.005), f"frame step moved {t1 - t0:.3f}s")
    # stop at end inside the child: seek near the end, play, it must stop before `ended`
    await click_rect(page, await env.rect(page, "rail"), 4.3 / 5.028)
    await page.wait_for_timeout(300)
    await cross.evaluate("() => { __t.ended = 0; }")
    await page.keyboard.press("Space")
    async def stopped():
        d = await env.debug(page)
        return d if d.get("atEnd") else None
    d = await wait_until(stopped, 4, msg="child stopped at end")
    ct, paused, ended = await cross.evaluate("() => [__t.media.main.currentTime, __t.media.main.paused, __t.ended]")
    env.note(f"child stop at end: t={ct:.3f} paused={paused} ended events={ended}")
    check(paused and ended == 0 and ct > 4.9, f"child did not stop at its end: t={ct} paused={paused} ended={ended}")
    # service worker restart: ports drop, frames reconnect, commands work again
    await click_rect(page, await env.rect(page, "rail"), 0.2)
    await page.wait_for_timeout(300)
    await (await env.sw()).evaluate("() => { self.__msMarker = 1; }")
    await _stop_sw(env, page)
    await page.wait_for_timeout(2500)
    fresh = await (await env.sw()).evaluate("() => self.__msMarker === undefined")
    check(fresh, "service worker was not restarted")
    async def reconnected():
        d = await env.debug(page)
        f = d.get("frames") or {}
        return d if f.get("connected") and len(f.get("frames") or []) >= 2 else None
    d = await wait_until(reconnected, 6, msg="frames reconnected after SW restart")
    env.note(f"after SW restart: frames {d['frames']}")
    # key with focus INSIDE the child after the restart
    box = await page.locator("#cross").bounding_box()
    await page.mouse.click(box["x"] + 50, box["y"] + 50)
    await cross.evaluate("() => { __t.pageKeys.length = 0; }")
    await page.keyboard.press("Space")
    await page.wait_for_timeout(400)
    check(not await cross.evaluate("() => __t.media.main.paused"), "Space in child after SW restart did not play")
    await page.keyboard.press("ArrowLeft")
    await page.wait_for_timeout(200)
    codes = await cross.evaluate("() => __t.pageKeys.map(k => k.code)")
    check(not codes, f"child page saw our keys: {codes}")
    # close: the child drops its lock (site writes stick again) and its port
    await env.toggle(page)
    await page.wait_for_timeout(400)
    r = await cross.evaluate("() => __t.setRate('main', 1)")
    check(r == 1, f"child lock not released on close: {r}")
    await page.close()


async def t_nomedia(env):
    page = await goto(env, "/pages/nomedia.html")
    await env.open(page)
    await wait_until(lambda: _readout(env, page, "Waiting for media…"), 3, msg="readout 'Waiting for media…'")
    await page.click("#add")
    await env.active(page, lambda a: not a["paused"], 5, msg="late video binds")
    await env.toggle(page)
    d = await wait_until(lambda: _closed(env, page), 3, msg="closed")
    check(d["lock"] is None, f"lock after close {d['lock']}")
    await js(page, "() => __t.setRate('main', 1.25)")
    await page.wait_for_timeout(250)
    check(await js(page, "() => __t.media.main.playbackRate") == 1.25, "page write does not stick after close")
    await page.reload()
    await page.wait_for_function("() => !!window.__t", timeout=5000)
    d = await wait_until(lambda: env.debug(page), 3, msg="snapshot after reload")
    check(d["open"] is False, "reload did not forget")
    await page.close()


async def _readout(env, page, want):
    d = await env.debug(page)
    return d if d.get("ui") and d["ui"].get("readout") == want else None


TESTS = [
    ("all_pages", t_all_pages), ("single", t_single), ("ladder_cap", t_ladder_cap), ("reels", t_reels),
    ("reels_stop_at_end", t_reels_stop_at_end), ("reels_pauseadvance", t_reels_pauseadvance), ("reels_adaptive", t_reels_adaptive), ("reels_adaptive_slow", t_reels_adaptive_slow), ("recycle", t_recycle), ("shadow", t_shadow), ("audio", t_audio),
    ("spa", t_spa), ("fullscreen_container", t_fullscreen_container), ("fullscreen_video", t_fullscreen_video), ("live", t_live), ("hostile", t_hostile), ("ambient", t_ambient),
    ("iframe", t_iframe), ("iframe_extra", t_iframe_extra), ("nomedia", t_nomedia),
]


# ---------------------------------------------------------------- page self-check (no extension)

async def p_reels(env):
    page = await goto(env, "/pages/reels.html")
    await page.wait_for_function("() => __t.clipsStarted.length >= 1", timeout=8000)
    await page.wait_for_timeout(500)
    w0 = await js(page, "() => __t.siteRateWrites")
    await js(page, "() => { __t.current().playbackRate = 0.5; }")
    await wait_until(lambda: js(page, "() => __t.current().playbackRate === 1"), 0.4, 0.01, msg="page re-asserts 1 within one timeupdate")
    await page.wait_for_function("() => __t.advances.length >= 3", timeout=16000)
    adv = await js(page, "() => __t.advances.map(a => a.from + ':' + a.via)")
    check(any(a.endswith("ended") for a in adv) and "clip-3s.webm:early" in adv, f"advance paths {adv}")
    n_video = await js(page, "() => document.querySelectorAll('video').length")
    check(n_video == 3 and await js(page, "() => __t.created") >= 6, f"videos {n_video}, created {await js(page, '() => __t.created')}")
    rects = await js(page, "() => [...document.querySelectorAll('video')].map(v => JSON.stringify(v.getBoundingClientRect()))")
    check(len(set(rects)) == 1, "videos not at identical rect")
    env.note("advances", adv, "siteRateWrites", await js(page, "() => __t.siteRateWrites") - w0)
    await page.close()


async def p_recycle(env):
    page = await goto(env, "/pages/recycle.html")
    await media_ready(page)
    await js(page, "() => { __t.media.main.playbackRate = 0.5; __t.media.main.defaultPlaybackRate = 0.5; }")
    await page.wait_for_function("() => __t.srcSwaps >= 1 && !__t.media.main.paused", timeout=15000)
    r = await js(page, "() => [__t.media.main.currentSrc.split('/').pop(), __t.media.main.playbackRate, __t.emptiedWrites]")
    check(r[0] == "clip-3s.webm" and r[1] == 1 and r[2] >= 1, f"recycle src/rate/emptiedWrites {r}")
    env.note(r)
    await page.close()


async def p_shadow(env):
    page = await goto(env, "/pages/shadow.html")
    r = await js(page, """() => ({
        open: !!document.getElementById('open-host').shadowRoot?.querySelector('video'),
        closedHidden: document.getElementById('closed-host').shadowRoot === null,
        nestedOpen: !!document.getElementById('nested-host').shadowRoot,
        innerClosed: document.getElementById('nested-host').shadowRoot.getElementById('nested-inner').shadowRoot === null,
        lightVideos: document.querySelectorAll('video').length,
        refs: Object.keys(__t.media).sort().join(','),
        connected: Object.values(__t.media).every(v => v.isConnected) })""")
    check(r == {"open": True, "closedHidden": True, "nestedOpen": True, "innerClosed": True, "lightVideos": 0, "refs": "closed,nested,open", "connected": True}, f"{r}")
    await page.close()


async def p_audio(env):
    page = await goto(env, "/pages/audio.html")
    rect = await js(page, "() => { const r = document.getElementById('a').getBoundingClientRect(); return [r.width, r.height, __t.media.hidden.readyState]; }")
    check(rect == [0, 0, 0], f"hidden audio rect/readyState {rect}")
    await page.click("#aplay")
    await page.wait_for_function("() => __t.media.hidden.currentTime > 0.2", timeout=5000)
    await page.click("#detached")
    await page.wait_for_function("() => __t.media.detached && __t.media.detached.currentTime > 0.2 && !__t.media.detached.isConnected", timeout=5000)
    await page.close()


async def p_spa(env):
    page = await goto(env, "/pages/spa.html")
    await media_ready(page)
    await js(page, "() => { window.__old = __t.media.main; }")
    await page.click("#nav")
    r = await js(page, "() => [location.search, __old.isConnected, __t.media.main !== __old, __t.media.main.dataset.gen, document.querySelectorAll('video').length]")
    check(r == ["?p=2", False, True, "2", 1], f"spa {r}")
    await page.close()


async def p_fullscreen(env):
    page = await goto(env, "/pages/fullscreen.html")
    await media_ready(page)
    for btn, want in (("#fs-container", "box"), ("#fs-video", "VIDEO")):
        await page.click(btn)
        await wait_until(lambda: js(page, f"() => document.fullscreenElement && (document.fullscreenElement.id || document.fullscreenElement.tagName) === {want!r}"), 3, msg=f"{btn} → {want}")
        size = await js(page, "() => [innerWidth, innerHeight]")
        env.note(f"{btn}: fullscreen ok, viewport {size}")
        await js(page, "() => document.exitFullscreen()")
        await wait_until(lambda: js(page, "() => !document.fullscreenElement"), 3, msg="exit")
    await page.close()


async def p_live(env):
    page = await goto(env, "/pages/live.html")
    await page.wait_for_timeout(1500)
    env.note("log", await js(page, "() => [__t.live.stage, __t.live.error, __t.live.log]"))
    await page.wait_for_function("() => __t.media.main.currentTime > 0.3 || __t.live.error", timeout=5000)
    info = await js(page, "() => ({...__t.info(), error: __t.live.error, log: __t.live.log})")
    env.note(info)
    check(info["duration"] == float("inf") and not info["error"], f"live {info}")
    check(info["seekable"] and info["seekable"][0][1] >= 4.9, f"seekable {info['seekable']}")
    await js(page, "() => { __t.media.main.currentTime = 1.0; }")
    await wait_seeked(page)
    ct = await ctime(page)
    check(near(ct, 1.0, 0.1), f"seek in live → {ct}")
    await page.close()


async def p_hostile(env):
    page = await env.ctx.new_page()
    console = []
    page.on("console", lambda m: console.append(m.text))
    resp = await page.goto(A + "/pages/hostile.html")
    await page.wait_for_function("() => !!window.__t", timeout=5000)
    csp = resp.headers.get("content-security-policy", "")
    r = await js(page, "() => [__t.inlineRan, __t.ttEnforced, getComputedStyle(document.documentElement).transform]")
    env.note("csp:", csp, "| inline/tt/transform", r, "| console:", [c[:70] for c in console if "Content Security Policy" in c][:1])
    check("require-trusted-types-for" in csp, "CSP header missing")
    check(r[0] is False and r[1] is True and r[2] != "none", f"inlineRan/ttEnforced/transform {r}")
    check(any("Content Security Policy" in c for c in console), "no CSP console message")
    await page.close()


async def p_ambient(env):
    page = await goto(env, "/pages/ambient.html")
    await page.wait_for_function("() => !__t.media.ambient.paused && __t.media.ambient.muted && __t.media.ambient.loop", timeout=8000)
    check(await js(page, "() => __t.media.main.paused"), "normal player autoplays")
    await page.close()


async def p_iframe(env):
    page = await goto(env, "/pages/iframe.html")
    await page.wait_for_timeout(800)
    fr = {f.name or f.url: f for f in page.frames}
    same = next(f for f in page.frames if "?same" in f.url)
    cross = next(f for f in page.frames if "?cross" in f.url)
    await cross.wait_for_function("() => !!window.__t", timeout=5000)
    o = [await page.evaluate("location.origin"), await same.evaluate("__t.origin"), await cross.evaluate("__t.origin")]
    check(o[0] == o[1] and o[2] != o[0], f"origins {o}")
    blocked = await page.evaluate("() => { try { return !document.getElementById('cross').contentWindow.document; } catch (e) { return true; } }")
    check(blocked, "cross child DOM accessible from parent")
    box = await page.locator("#cross").bounding_box()
    await page.mouse.click(box["x"] + 50, box["y"] + 50)
    await page.keyboard.press("KeyK")
    await page.wait_for_timeout(100)
    check("KeyK" in await cross.evaluate("() => __t.pageKeys.map(k => k.code)"), "child key logger")
    env.note("origins", o)
    await page.close()


async def p_nomedia(env):
    page = await goto(env, "/pages/nomedia.html")
    check(await js(page, "() => document.querySelectorAll('video,audio').length === 0"), "has media")
    await page.click("#add")
    await page.wait_for_function("() => __t.media.main && __t.media.main.currentTime > 0.2", timeout=5000)
    await page.close()


async def p_single(env):
    page = await goto(env, "/pages/single.html")
    await media_ready(page)
    await page.keyboard.press("KeyJ")
    await page.keyboard.press("Space")
    k = await js(page, "() => [__t.keyCodes(__t.pageKeys), __t.keyCodes(__t.docCaptureKeys)]")
    check(k == [["KeyJ", "Space"], ["KeyJ", "Space"]], f"key loggers {k}")
    sk = await js(page, "() => { const s = __t.media.main.seekable; return s.length ? [s.start(0), s.end(0)] : null; }")
    check(sk and sk[0] == 0 and sk[1] > 4.9, f"seekable {sk} (server Range support?)")
    await js(page, "() => { __t.media.main.currentTime = 3.52; }")
    await wait_seeked(page)
    check(near(await ctime(page), 3.52, 0.001), "seek did not land (keyframe snapping / no Range?)")
    await js(page, "() => { __t.media.main.currentTime = 1.0; }")
    await wait_seeked(page)
    await page.wait_for_timeout(100)
    f = await js(page, "() => __t.frames.main")
    check(near(f, 1.0, FRAME), f"rVFC mediaTime after seek {f}")
    env.note("rVFC mediaTime", f)
    await page.close()


PAGE_TESTS = [("single", p_single), ("reels", p_reels), ("recycle", p_recycle), ("shadow", p_shadow), ("audio", p_audio),
              ("spa", p_spa), ("fullscreen", p_fullscreen), ("live", p_live), ("hostile", p_hostile),
              ("ambient", p_ambient), ("iframe", p_iframe), ("nomedia", p_nomedia)]


# ---------------------------------------------------------------- main

async def main():
    argv = sys.argv[1:]
    pages_mode = "--pages" in argv
    headed = "--headed" in argv
    filters = [a for a in argv if not a.startswith("--")]
    ensure_media()
    start_server()
    tests = PAGE_TESTS if pages_mode else TESTS
    tests = [t for t in tests if not filters or any(f in t[0] for f in filters)]
    results = []
    t_start = time.monotonic()

    if not pages_mode and not (EXT / "manifest.json").exists():
        for name, _ in tests:
            print(f"FAIL {name}: {EXT}/manifest.json not found — nothing to test")
        print(f"\n0/{len(tests)} passed")
        sys.exit(1)

    args = ["--autoplay-policy=no-user-gesture-required"]
    if not pages_mode:
        args += [f"--disable-extensions-except={EXT}", f"--load-extension={EXT}"]
    if not headed:
        args.append("--headless=new")
    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context(
            user_data_dir=tempfile.mkdtemp(prefix="ms-profile-"), headless=False, args=args,
            viewport={"width": VW, "height": VH})
        env = Env(ctx)
        if not pages_mode:
            try:
                sw = await env.sw()
                print("extension id:", sw.url.split("/")[2])
            except Exception as e:
                for name, _ in tests:
                    print(f"FAIL {name}: extension service worker did not start ({type(e).__name__})")
                await ctx.close()
                print(f"\n0/{len(tests)} passed")
                sys.exit(1)
        for name, fn in tests:
            env.notes = []
            t0 = time.monotonic()
            status, reason = "PASS", ""
            try:
                await asyncio.wait_for(fn(env), TEST_TIMEOUT)
            except XFail as e:
                status, reason = "XFAIL", str(e)
            except Info as e:
                status, reason = "INFO", str(e)
            except Fail as e:
                status, reason = "FAIL", str(e)
            except asyncio.TimeoutError:
                status, reason = "FAIL", f"test exceeded {TEST_TIMEOUT}s"
            except Exception as e:
                status, reason = "FAIL", f"{type(e).__name__}: {str(e).splitlines()[0][:300]}"
                if os.environ.get("MS_TRACE"):
                    traceback.print_exc()
            for pg in list(ctx.pages)[1:]:
                await pg.close()
            dt = time.monotonic() - t0
            print(f"{status} {name} ({dt:.1f}s){': ' + reason if reason else ''}")
            for n in env.notes:
                print("     ", n)
            results.append((name, status))
        await ctx.close()
    n_pass = sum(1 for _, s in results if s == "PASS")
    n_x = sum(1 for _, s in results if s == "XFAIL")
    n_info = sum(1 for _, s in results if s == "INFO")
    results = [r for r in results if r[1] != "INFO"]
    failed = [n for n, s in results if s == "FAIL"]
    print(f"\n{n_pass}/{len(results)} passed, {n_x} xfail, {n_info} info, {len(failed)} failed{': ' + ', '.join(failed) if failed else ''}"
          f" ({time.monotonic() - t_start:.0f}s)")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    asyncio.run(main())
