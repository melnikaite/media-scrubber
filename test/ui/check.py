"""UI harness checks: PLAYWRIGHT_BROWSERS_PATH=$HOME/Library/Caches/ms-playwright uv run --with playwright python test/ui/check.py"""
import glob, os, subprocess, sys, time, socket, pathlib
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[2]
SHOTS = ROOT / 'test/ui/shots'
SHOTS.mkdir(exist_ok=True)
PORT = int(os.environ.get('UI_PORT', '8438'))
URL = f'http://127.0.0.1:{PORT}/test/ui/harness.html'
EXE = sorted(glob.glob(os.path.expanduser('~/Library/Caches/ms-playwright/chromium-1234/chrome-mac*/*.app/Contents/MacOS/*')))[-1]

results = []
def check(name, ok, info=''):
    results.append((name, bool(ok), info))
    print(('PASS ' if ok else 'FAIL ') + name + (f'  [{info}]' if info else ''), flush=True)

def free(port):
    with socket.socket() as s:
        return s.connect_ex(('127.0.0.1', port)) != 0

assert free(PORT), f'port {PORT} busy'
srv = subprocess.Popen([sys.executable, '-m', 'http.server', str(PORT), '--bind', '127.0.0.1'], cwd=ROOT,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(0.8)
try:
    with sync_playwright() as p:
        br = p.chromium.launch(executable_path=EXE, headless=True)
        page = br.new_page(viewport={'width': 1280, 'height': 720})
        console_errors = []
        page.on('console', lambda m: console_errors.append(m.text) if m.type == 'error' and 'favicon' not in (m.location or {}).get('url', '') else None)
        page.on('pageerror', lambda e: console_errors.append(str(e)))
        page.goto(URL)
        page.wait_for_timeout(300)
        dbg = lambda: page.evaluate('__view.getDebug()')
        calls = lambda: page.evaluate('__calls')
        clear = lambda: page.evaluate('__calls.length = 0')
        c = lambda r: (r['x'] + r['width'] / 2, r['y'] + r['height'] / 2)
        def host_at(x, y):
            return page.evaluate(f'(document.elementFromPoint({x},{y})||{{}}).tagName')
        def shot(n): page.screenshot(path=str(SHOTS / f'{n}.png'))

        d = dbg()
        R = d['rects']
        check('host present + popover open', d['hostPresent'] and d['popoverOpen'])
        check('bar full width 52px at bottom', abs(R['bar']['width'] - 1280) < 1 and abs(R['bar']['height'] - 52) < 0.5 and abs(R['bar']['y'] - 668) < 0.5, R['bar'])
        check('rail 20px full width', abs(R['rail']['height'] - 20) < 0.5 and abs(R['rail']['width'] - 1280) < 1, R['rail'])
        check('play 30px', abs(R['play']['width'] - 30) < 0.5 and abs(R['play']['height'] - 30) < 0.5, R['play'])
        check('step 62x28', abs(R['stepBack']['width'] - 62) < 0.5 and abs(R['stepBack']['height'] - 28) < 0.5, R['stepBack'])
        check('readout text', d['readout'] == '0:02.4 / 0:05.0', d['readout'])
        check('media chip visible (3 candidates)', R['media'] is not None)
        check('elementFromPoint at bar = host (beats z-index overlay)', host_at(640, 700) == 'MEDIA-SCRUBBER-UI', host_at(640, 700))
        check('elementFromPoint above bar = overlay', host_at(640, 600) == 'DIV')
        shot('01-default')

        # rail click at 50%
        clear()
        page.mouse.click(640, R['rail']['y'] + 10)
        cl = calls()
        seeks = [x['args'] for x in cl if x['name'] == 'seekTo']
        check('rail click 50% -> seekTo(~2.5, false) then (…, true)', len(seeks) == 2 and abs(seeks[0][0] - 2.5) < 0.01 and seeks[0][1] is False and seeks[1][1] is True, seeks)
        check('page did not see our events', not [s for s in page.evaluate('__pageSaw') if 'MEDIA-SCRUBBER' in s], page.evaluate('__pageSaw'))

        # drag
        clear()
        ry = R['rail']['y'] + 10
        page.mouse.move(256, ry); page.mouse.down()
        for x in range(260, 900, 40): page.mouse.move(x, ry)
        d2 = dbg()
        check('readout follows pointer during drag', d2['readout'].startswith('0:03.3'), d2['readout'])
        check('dimmed false while scrubbing', d2['scrubbing'] and not d2['dimmed'])
        shot('05-scrub')
        page.mouse.up()
        seeks = [x['args'] for x in calls() if x['name'] == 'seekTo']
        check('drag: many non-final then exactly one final', len(seeks) > 5 and all(not s[1] for s in seeks[:-1]) and seeks[-1][1] is True and abs(seeks[-1][0] - 860 / 1280 * 5) < 0.02, (len(seeks), seeks[-1]))

        # shift fine scrub
        clear()
        page.mouse.move(640, ry); page.mouse.down()
        page.keyboard.down('Shift')
        page.mouse.move(740, ry)
        page.keyboard.up('Shift')
        page.mouse.up()
        seeks = [x['args'] for x in calls() if x['name'] == 'seekTo']
        exp = 2.5 + 100 / 1280 * 5 / 10
        check('shift fine scrub = 1/10 movement', abs(seeks[-1][0] - exp) < 0.01, (seeks[-1][0], exp))

        # esc cancel
        clear()
        page.evaluate('__state.time = 1.0; __push()')
        page.mouse.move(640, ry); page.mouse.down(); page.mouse.move(900, ry)
        consumed = page.evaluate('__view.handleEscape()')
        page.mouse.up()
        seeks = [x['args'] for x in calls() if x['name'] == 'seekTo']
        check('Esc cancels scrub back to start', consumed and seeks[-1] == [1.0, True] and sum(1 for s in seeks if s[1]) == 1, seeks[-3:])

        # wheel
        clear()
        page.mouse.move(640, ry); page.mouse.wheel(0, 100); page.wait_for_timeout(50); page.mouse.wheel(0, -100)
        ws = [x['args'][0] for x in calls() if x['name'] == 'wheelStep']
        check('wheel over rail -> wheelStep(+1,-1)', ws == [1, -1], ws)
        check('page did not scroll', page.evaluate('scrollY') == 0)

        # play
        page.mouse.move(640, 300)
        clear()
        page.mouse.move(*c(R['play'])); page.mouse.down()
        check('play acts on pointerdown', [x['name'] for x in calls()] == ['togglePlay'])
        page.mouse.up()
        page.wait_for_timeout(100)
        shot('01b-playing')
        page.evaluate('__ctl.togglePlay(); __state.time = 2.43; __push()')

        # steps
        page.wait_for_timeout(700)
        clear()
        page.mouse.move(*c(R['stepBack'])); page.mouse.down(); page.mouse.up()
        page.mouse.down(); page.mouse.up(); page.mouse.down(); page.mouse.up()
        names = [(x['name'], x['args']) for x in calls()]
        check('step back press/release x3', names == [('stepPress', [-1]), ('stepRelease', [-1])] * 3, names)
        page.wait_for_timeout(30)
        d = dbg()
        check('step label climbs', d['stepLabels']['back'] == '0.5', (d['stepLabels'], page.evaluate('__state.paused')))
        shot('03-streak')
        page.mouse.move(*c(R['stepFwd'])); page.mouse.down(); page.mouse.up()
        check('step fwd press/release', [x['name'] for x in calls()][-2:] == ['stepPress', 'stepRelease'])
        page.wait_for_timeout(700)
        check('labels back to base (paused -> 1f)', dbg()['stepLabels'] == {'back': '1f', 'fwd': '1f'}, dbg()['stepLabels'])

        # speed chips
        clear()
        page.mouse.click(*c(R['speed']['1']))
        check('chip 1 -> setRate(1)', calls()[-1]['args'] == [1])
        check('no extra chip for a preset rate', dbg()['rects']['speed']['extra'] is None and 'more' not in dbg()['rects']['speed'])
        page.evaluate('__ctl.setRate(1.25)')
        page.wait_for_timeout(30)
        d = dbg()
        ex = d['rects']['speed']['extra']
        check('non-preset rate 1.25 -> extra chip after presets', ex is not None and ex['x'] > d['rects']['speed']['1']['x'], d['rects']['speed'])
        page.evaluate('__state.contested = true; __push()')
        shot('09-rate-extra-contested')
        page.evaluate('__state.contested = false; __push()')
        page.mouse.click(*c(d['rects']['speed']['0.75']))
        page.wait_for_timeout(30)
        check('preset picked -> extra chip gone', calls()[-1]['args'] == [0.75] and dbg()['rects']['speed']['extra'] is None)

        # restart
        R = dbg()['rects']
        rs, sb = R['restart'], R['stepBack']
        check('restart is first control, 28x28, left of step back', rs is not None and rs['x'] + rs['width'] <= sb['x'] + 0.5 and abs(rs['width'] - 28) < 0.6 and abs(rs['height'] - 28) < 0.6, (rs, sb))
        page.evaluate('__state.time = 3.2; __state.paused = true; __push()')
        clear()
        page.mouse.click(*c(rs))
        page.wait_for_timeout(30)
        check('restart click -> restart() only', [x['name'] for x in calls()] == ['restart'], calls())
        check('restart -> time ~0, playing', page.evaluate('__state.time') < 0.3 and not page.evaluate('__state.paused'))
        page.evaluate('__state.paused = true; __state.time = 2.43; __push()')
        clear()
        page.keyboard.press('KeyR')
        check('no keyboard shortcut for restart', not any(x['name'] == 'restart' for x in calls()), calls())

        # media chip
        R = dbg()['rects']
        page.mouse.move(*c(R['media']))
        page.wait_for_timeout(80)
        d = dbg()
        o = d['rects']['outline']
        check('chip hover outlines active element', o and abs(o['x'] - 58) < 1 and abs(o['width'] - 434) < 1 and d['outlineLabel'] == 'Controlling · video 860×483 · 0:05.0', (o, d['outlineLabel']))
        shot('08a-chip-hover')
        clear()
        page.mouse.click(*c(R['media']))
        d = dbg()
        check('media menu: automatic + 3 rows', d['menu'] == 'media' and len(d['menuItems']) == 4 and 'Automatic' in d['menuItems'][0]['text'], [m['text'] for m in d['menuItems']])
        page.mouse.move(*c(d['menuItems'][2]['rect']))
        page.wait_for_timeout(80)
        o = dbg()['rects']['outline']
        check('row hover outlines that candidate', o and abs(o['x'] - 558) < 1, o)
        shot('08-media-menu')
        page.mouse.click(*c(d['menuItems'][2]['rect']))
        page.wait_for_timeout(30)
        check('choose row -> pin(v2)', calls()[-1]['name'] == 'pin' and calls()[-1]['args'] == ['v2'])
        page.mouse.move(640, 300); page.wait_for_timeout(50)
        shot('08b-pinned')
        page.mouse.click(*c(dbg()['rects']['media']))
        page.mouse.click(*c(dbg()['menuItems'][0]['rect']))
        check('Automatic -> pin(null)', calls()[-1]['args'] == [None])
        page.mouse.move(640, 300); page.wait_for_timeout(50)
        check('outline gone after leaving', dbg()['rects']['outline'] is None)

        # drag to the middle
        R = dbg()['rects']
        hx = R['media']['x'] - 400  # empty spacer area
        clear()
        page.mouse.move(hx, 690); page.mouse.down()
        for y in range(680, 330, -20): page.mouse.move(hx, y)
        shot('13-dragging')
        page.mouse.move(hx, 330); page.mouse.up()
        pl = [x['args'][0] for x in calls() if x['name'] == 'setPlacement']
        check('drag to middle -> setPlacement free', pl and pl[-1]['dock'] == 'free' and abs(pl[-1]['y'] - (668 - 360) / 720) < 0.01, pl)
        page.wait_for_timeout(50)
        check('bar moved to free y', abs(dbg()['rects']['bar']['y'] - 308) < 1, dbg()['rects']['bar'])
        page.mouse.move(640, 100)
        shot('09-floating')
        # into top snap zone
        clear()
        page.mouse.move(hx, 330); page.mouse.down()
        for y in range(320, 20, -20): page.mouse.move(hx, y)
        page.mouse.move(hx, 40); page.mouse.up()
        pl = [x['args'][0] for x in calls() if x['name'] == 'setPlacement']
        page.wait_for_timeout(250)
        check('drag into top zone -> dock top', pl and pl[-1] == {'dock': 'top', 'y': None} and dbg()['rects']['bar']['y'] == 0, (pl, dbg()['rects']['bar']))
        shot('14-top')
        # double-click empty area -> bottom
        clear()
        page.mouse.dblclick(hx, 36)
        page.wait_for_timeout(250)
        check('dblclick -> dock bottom', calls() and calls()[-1]['args'] == [{'dock': 'bottom', 'y': None}] and abs(dbg()['rects']['bar']['y'] - 668) < 1, (calls(), dbg()['rects']['bar']))

        # collapse
        R = dbg()['rects']
        page.mouse.click(*c(R['collapse']))
        page.wait_for_timeout(200)
        d = dbg()
        check('collapse -> pill', d['collapsed'] and d['rects']['bar'] is None and d['rects']['pill'] and abs(d['rects']['pill']['height'] - 36) < 0.5, d['rects']['pill'])
        check('elementFromPoint at pill = host', host_at(*c(d['rects']['pill'])) == 'MEDIA-SCRUBBER-UI')
        shot('10-pill')
        clear()
        page.mouse.move(*c(d['rects']['pillPlay'])); page.mouse.down(); page.mouse.up()
        check('pill play -> togglePlay only', [x['name'] for x in calls()] == ['togglePlay'], calls())
        pr = d['rects']['pill']
        page.mouse.click(pr['x'] + pr['width'] - 14, pr['y'] + 18)
        page.wait_for_timeout(50)
        check('pill body -> expand', calls()[-1]['args'] == [False] and dbg()['rects']['bar'] is not None)
        page.evaluate('__ctl.togglePlay()')

        # rest dimming
        page.mouse.move(640, 200)
        page.wait_for_timeout(3300)
        d = dbg()
        check('dimmed after 3 s idle', d['dimmed'])
        page.wait_for_timeout(500)
        shot('07-rest')
        page.mouse.move(640, 640)
        page.wait_for_timeout(100)
        check('wake on pointer proximity', not dbg()['dimmed'])
        page.evaluate('__view.getDebug()')
        page.mouse.move(640, 200); page.wait_for_timeout(3300)
        page.evaluate('__view.noteActivity()')
        check('noteActivity wakes', not dbg()['dimmed'])

        # narrow
        page.set_viewport_size({'width': 560, 'height': 720})
        page.wait_for_timeout(100)
        d = dbg()
        check('narrow: preset chips stay visible', all(d['rects']['speed'][k] is not None and d['rects']['speed'][k]['width'] > 0 for k in ('0.5', '0.75', '1')) and abs(d['rects']['bar']['width'] - 560) < 1, d['rects']['speed'])
        shot('15-narrow')
        page.set_viewport_size({'width': 1280, 'height': 720})
        page.wait_for_timeout(100)

        # degraded states
        page.evaluate('__state.media = false; __push()')
        check('no media readout', dbg()['readout'] == 'Waiting for media…', dbg()['readout'])
        shot('16-waiting')
        page.evaluate('__state.media = true; __state.ready = false; __push()')
        check('loading readout', dbg()['readout'] == 'Loading…')
        clear(); page.mouse.click(640, 678)
        check('disabled rail does not seek', not [x for x in calls() if x['name'] == 'seekTo'])
        page.evaluate('__state.ready = true; __push()')

        # fullscreen: container
        page.mouse.click(*c(page.evaluate("document.getElementById('fsContainer').getBoundingClientRect().toJSON()")))
        page.wait_for_timeout(500)
        fs = page.evaluate('document.fullscreenElement && document.fullscreenElement.id')
        d = dbg()
        check('container fullscreen: popover open, host at bar', fs == 'stage' and d['popoverOpen'] and host_at(640, 700) == 'MEDIA-SCRUBBER-UI', (fs, host_at(640, 700)))
        clear(); page.mouse.click(*c(dbg()['rects']['speed']['1']))
        check('container fullscreen: real click reaches the bar', calls() and calls()[-1]['name'] == 'setRate', calls())
        shot('17-fs-container')
        page.evaluate('document.fullscreenElement && document.exitFullscreen()'); page.wait_for_timeout(400)
        check('after exit: host at bar', host_at(640, 700) == 'MEDIA-SCRUBBER-UI')
        page.mouse.click(*c(page.evaluate("document.getElementById('fsVideo').getBoundingClientRect().toJSON()")))
        page.wait_for_timeout(500)
        fs = page.evaluate('document.fullscreenElement && document.fullscreenElement.id')
        check('video fullscreen: popover open (rendered above)', fs == 'vid' and dbg()['popoverOpen'])
        # Keys-only by design (DESIGN §6.8): Chrome paints the bar but does not hit-test outside a fullscreen <video>.
        print('INFO video fullscreen hit-test:', host_at(640, 700), '(keys-only by design)')
        shot('18-fs-video')
        page.evaluate('document.fullscreenElement && document.exitFullscreen()'); page.wait_for_timeout(400)

        # self-healing
        page.evaluate("document.querySelector('media-scrubber-ui').remove()")
        page.wait_for_timeout(50)
        d = dbg()
        check('self-heal after removal', d['hostPresent'] and d['popoverOpen'] and host_at(640, 700) == 'MEDIA-SCRUBBER-UI')

        # close + undo
        R = dbg()['rects']
        page.mouse.click(*c(R['close']))
        page.wait_for_timeout(100)
        d = dbg()
        check('close -> toast, bar gone', d['rects']['bar'] is None and d['rects']['toast'] is not None and d['hostPresent'])
        shot('11-toast')
        page.mouse.click(*c(d['rects']['toastUndo']))
        page.wait_for_timeout(100)
        d = dbg()
        check('Undo -> onUndo, bar back, single host', [x['name'] for x in calls()][-1] == 'undo' and d['rects']['bar'] and page.evaluate("document.querySelectorAll('media-scrubber-ui').length") == 1)
        page.evaluate('__ctl.close()')
        page.wait_for_timeout(5200)
        check('toast expires -> host removed', page.evaluate("document.querySelectorAll('media-scrubber-ui').length") == 0)

        check('no console errors', not console_errors and not page.evaluate('__errors'), console_errors)

        # reduced-motion default-state screenshot on white page
        page2 = br.new_page(viewport={'width': 1280, 'height': 300}, reduced_motion='reduce')
        page2.goto(URL); page2.wait_for_timeout(200)
        page2.evaluate("document.getElementById('overlay').remove()")
        page2.screenshot(path=str(SHOTS / '02-reduced-motion.png'))
        br.close()
finally:
    srv.terminate()

src = ''.join((ROOT / 'extension/content/ui' / f).read_text() for f in os.listdir(ROOT / 'extension/content/ui'))
check('no innerHTML/outerHTML/insertAdjacentHTML/title attr', not any(k in src for k in ('innerHTML', 'outerHTML', 'insertAdjacentHTML', "'title'", '.title')))
fails = [r for r in results if not r[1]]
print(f'\n{len(results) - len(fails)}/{len(results)} passed')
sys.exit(1 if fails else 0)
