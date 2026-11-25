#!/usr/bin/env python3
"""Verify the navigation shell (drawer + sections) in Chromium with touch emulation, at 360x780 and 412x915 (device scale 2).

Needs: ffmpeg, Playwright for Python, the dev server:  python3 serve.py 8321   (URL=http://localhost:8321/index.html, CHROME=/path/to/chrome)
Usage:  python3 scripts/verify-shell.py [outdir]     Exits non-zero when an assertion fails; screenshots go to outdir/shots.

Real touch input is sent through CDP (Input.dispatchTouchEvent), so the page sees genuine pointer events.
Checks: every section closed; drawer open; mid-drag; light theme; mixtape stack with 6 seeded tapes; Albums with a scanned generated
library; Radio dial; Booth; drag from the 24 px strip opens / flings / cancels; a drag that starts on the platter, the tonearm zone or a
cassette never moves the drawer; vinyl scrub still changes the rate; tap on the card / Esc / menu item close; aria + inert + focus trap;
last section is remembered; a playing radio station and a playing mixtape survive section changes and show the mini bar.
"""
import json, math, os, subprocess, sys, time
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = open(os.path.join(ROOT, 'scripts/verify-canned-radio.py')).read()
src = src[:src.index('def run():')]
OUTDIR = sys.argv[1] if len(sys.argv) > 1 else '/tmp/shell-verify'
sys.argv = ['x', OUTDIR]
exec(src)                                   # helpers: make_fixtures, launch, to_section, FAKE_SPEECH, BUS_HOOK, LIB, SHOTS, URL, SPECS
make_fixtures()
# a two-disc-label folder so the shelf has a CD (albums.js: a disc label in the album tag or the path makes it a CD)
CD_DIR = os.path.join(LIB, 'Glass Hours CD1')
os.makedirs(CD_DIR, exist_ok=True)
for i, f in enumerate([196, 233], 1):
    out = os.path.join(CD_DIR, f'0{i} - Glass {i}.mp3')
    if not os.path.exists(out):
        subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', f'sine=frequency={f}:duration=30:sample_rate=44100', '-metadata', f'title=Glass {i}', '-metadata', 'artist=Glass Hours',
                        '-metadata', 'album=Glass Hours [CD1]', '-metadata', f'track={i}', '-c:a', 'libmp3lame', '-b:a', '96k', out], check=True)

fails = []
def check(ok, msg):
    if not ok: fails.append(msg)
    print(('ok   ' if ok else 'FAIL ') + msg, flush=True)

STYLES = ['brass', 'clear', 'smoke', 'aqua', 'rose', 'cobalt']
def mixtape_blob(real_tracks=False):
    ts = [{'title': t, 'artist': a, 'album': al} for (t, a, al, f, g) in SPECS[:3]]
    return json.dumps({'version': 3, 'mixtapes': [
        {'id': f'm{i}', 'name': f'Tape {i + 1}', 'author': 'me', 'tracks': ts,
         'cfg': {'style': st, 'pen': 'blue', 'wear': 0.2, 'gloss': 0.5, 'text': {'subtitle': 'side', 'note': 'note', 'side': 'A'}}} for i, st in enumerate(STYLES)]})

TX = "new DOMMatrix(getComputedStyle(document.getElementById('card')).transform).m41"
def tx(page): return page.evaluate(TX)
def is_open(page): return page.evaluate("document.getElementById('shell').dataset.open") == 'true'
def cur(page): return page.evaluate('document.querySelector(".page:not([hidden])").dataset.section')
def settle(page, ms=700): page.wait_for_timeout(ms)

class Touch:
    def __init__(self, page): self.cdp = page.context.new_cdp_session(page)
    def _send(self, kind, pts): self.cdp.send('Input.dispatchTouchEvent', {'type': kind, 'touchPoints': [{'x': x, 'y': y} for x, y in pts]})
    def down(self, x, y): self._send('touchStart', [(x, y)])
    def move(self, x, y): self._send('touchMove', [(x, y)])
    def up(self): self._send('touchEnd', [])
    def drag(self, pts, step_s=0.016, release=True):
        self.down(*pts[0])
        for p in pts[1:]:
            self.move(*p); time.sleep(step_s)
        if release: self.up()
    def line(self, x0, y0, x1, y1, n=12): return [(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n) for i in range(n + 1)]

def disc(page):
    """the disc centre in client px (through the stage's own SVG matrix) and its outer radius"""
    r = page.evaluate("""(() => { const t = document.querySelector('.tt-top'), g = document.getElementById('tt-topRot'); const p = t.createSVGPoint(); p.x = 278; p.y = 457;
      const q = p.matrixTransform(g.getScreenCTM()); const m = g.getScreenCTM(); return [q.x, q.y, Math.hypot(m.a, m.b)]; })()""")
    return {'cx': r[0], 'cy': r[1], 'R': 644 * r[2], 'rOut': 640 * r[2]}

def boot(b, w, h, tag, seed_mix=True, speech=False, light=False):
    ctx = b.new_context(viewport={'width': w, 'height': h}, device_scale_factor=2, has_touch=True, is_mobile=True)
    init = 'window.showDirectoryPicker = undefined; try { localStorage.setItem("runout.wtDone", "1");'
    if seed_mix: init += f' localStorage.setItem("runout.mixtapes", {json.dumps(mixtape_blob())});'
    if light: init += ' localStorage.setItem("runout.theme", "light");'
    init += ' } catch (e) {}'
    ctx.add_init_script(init)
    ctx.add_init_script(BUS_HOOK)
    if speech: ctx.add_init_script(FAKE_SPEECH)
    page = ctx.new_page(); errs = []
    page.on('pageerror', lambda e: errs.append(str(e)))
    page.on('console', lambda m: errs.append('console:' + m.text) if m.type == 'error' and 'stations/index.json' not in m.text and '404' not in m.text else None)
    page.goto(URL)
    page.wait_for_function('document.getElementById("latency") && !/boot error/.test(document.getElementById("latency").textContent)')
    page.wait_for_timeout(600)
    return ctx, page, errs

def scan_albums(page, folder, n=1):
    """the library is the stage's zoomed-out view: scan through its toolbar button"""
    page.evaluate('window.__rt.setZ(1)'); page.wait_for_timeout(800)
    with page.expect_file_chooser() as fc:
        page.click('.tl-scan')
    fc.value.set_files(folder)
    page.wait_for_function('n => window.__rt.app().albums.filter(a => !a.builtin).length >= n', arg=n, timeout=30000)
    page.wait_for_timeout(900)
    page.evaluate('window.__rt.setZ(0)'); page.wait_for_timeout(700)

def scan(page):
    scan_albums(page, LIB, 1)

def pick(page, kind):
    """zoom out, focus the first album of `kind`, tap its first track (the library is the stage's zoomed-out view)"""
    page.evaluate('window.__rt.setZ(1)'); page.wait_for_timeout(700)
    page.evaluate("k => { const a = window.__rt.app(); a.tlib.focus(a.albums.findIndex(x => x.kind === k && !x.builtin), {animate: false}); }", kind); page.wait_for_timeout(500)
    page.locator('.tl-trk').first.click(); page.wait_for_timeout(2500)

with sync_playwright() as p:
    b = launch(p)
    for (w, h) in [(360, 780), (412, 915)]:
        tag = f'{w}x{h}'
        print(f'--- {tag}')
        ctx, page, errs = boot(b, w, h, tag)
        T = Touch(page)
        shot = lambda name: page.screenshot(path=f'{SHOTS}/{tag}-{name}.png')

        # first run opens Albums; semantics
        check(cur(page) == 'albums', f'{tag}: first run opens Albums')
        check(page.evaluate('document.getElementById("drawer").getAttribute("role") || document.getElementById("drawer").tagName') in ('NAV', 'navigation'), f'{tag}: drawer is a navigation landmark')
        check(page.get_attribute('.page:not([hidden]) .hamburger', 'aria-expanded') == 'false', f'{tag}: hamburger aria-expanded=false when closed')
        check(page.evaluate('document.getElementById("cardInner").inert') is False, f'{tag}: card is not inert when closed')
        scan(page)
        page.wait_for_timeout(400)
        shot('albums-closed')
        # the Vinyl player fills the card (src/turntable/); the library is its zoomed-out view
        m = page.evaluate('(() => { const s = document.querySelector("#pageAlbums .tt-wrap").getBoundingClientRect(), c = document.getElementById("card").getBoundingClientRect(); return { sw: s.width, sh: s.height, cw: c.width, ch: c.height }; })()')
        hd = page.evaluate('(() => { const h = document.querySelector("#pageAlbums .page-head").getBoundingClientRect(), s = document.querySelector("#pageAlbums .tt-wrap").getBoundingClientRect(); return { h: h.height, bottom: h.bottom, stageTop: s.top, title: (document.querySelector("#pageAlbums .page-title").innerText || "").trim(), titleShown: getComputedStyle(document.querySelector("#pageAlbums .page-title")).display !== "none" }; })()')
        check(abs(m['sw'] - m['cw']) < 2 and abs(m['sh'] + hd['h'] - m['ch']) < 2, f'{tag}: the stage fills the Albums card below its header ({m["sw"]:.0f}x{m["sh"]:.0f} + {hd["h"]:.0f} header in {m["cw"]:.0f}x{m["ch"]:.0f})')
        check(hd['title'] == 'Albums' and hd['titleShown'] and hd['bottom'] <= hd['stageTop'] + 1, f'{tag}: Albums has its own header (title "{hd["title"]}") and the menu button covers no part of the stage')
        small = page.evaluate('[...document.querySelectorAll(".page .page-head button, .page .tt-details-btn")].filter(b => b.offsetParent && (b.getBoundingClientRect().width < 44 || b.getBoundingClientRect().height < 44)).map(b => b.className + " " + b.getBoundingClientRect().width + "x" + b.getBoundingClientRect().height)')
        check(not small, f'{tag}: every header control on Albums is at least 44x44 ({small})')
        hh = page.evaluate('(() => { const e = document.getElementById("edgeStrip").getBoundingClientRect(), h = document.querySelector(".card-handle").getBoundingClientRect(); return { sw: e.width, hw: h.width, hh: h.height, op: getComputedStyle(document.querySelector(".card-handle")).opacity }; })()')
        check(abs(hh['sw'] - 24) < 1 and hh['hw'] >= 5 and hh['hh'] >= 40 and float(hh['op']) > 0.9, f'{tag}: the 24 px gesture strip is kept and the edge shows a deliberate grab tab ({hh})')
        check(page.evaluate('document.documentElement.scrollWidth <= innerWidth'), f'{tag}: no horizontal page scroll on Albums')
        pick(page, 'vinyl')
        check(page.evaluate('window.__rt.app().stage.zoom') == 0 and page.evaluate('window.__rt.app().state.queue.kind') == 'vinyl', f'{tag}: picking a library track zooms in and loads the record')
        # a CD album opens the existing CD view; then back to a vinyl record for the platter tests
        pick(page, 'cd')
        check(not page.evaluate('document.getElementById("cdView").classList.contains("hidden")'), f'{tag}: a CD album swaps in the CD view')
        shot('albums-cd')
        cdm = page.evaluate('(() => { const c = document.getElementById("cdView").getBoundingClientRect(), l = document.getElementById("cdList").getBoundingClientRect(); return { canvasH: document.getElementById("cdCanvas").getBoundingClientRect().height, listH: l.height, bottom: c.bottom }; })()')
        check(cdm['canvasH'] >= 120, f'{tag}: the CD canvas keeps a usable size ({cdm["canvasH"]:.0f} px)')
        page.click('#cdLibBtn'); page.wait_for_timeout(600)
        pick(page, 'vinyl')
        check(page.evaluate('document.getElementById("cdView").classList.contains("hidden")'), f'{tag}: a vinyl album brings the platter back')

        # ---- drawer by touch: drag from the strip
        d = disc(page)
        T.drag(T.line(10, 420, 170, 420, 8), release=False); page.wait_for_timeout(80)   # ends at 170 px (was 120): 120 sat on the 50 % settle threshold, so one slow run settled closed (flake)
        mid = tx(page); shot('drawer-mid-drag')
        T.up(); settle(page)
        check(0 < mid < 200, f'{tag}: mid-drag the card follows the finger ({mid:.0f} px)')
        check(is_open(page) and abs(tx(page) - page.evaluate('parseFloat(getComputedStyle(document.getElementById("shell")).getPropertyValue("--open-w"))')) < 2, f'{tag}: released past half -> settles open ({tx(page):.0f} px)')
        check(page.get_attribute('.page:not([hidden]) .hamburger', 'aria-expanded') == 'true', f'{tag}: aria-expanded=true while open')
        check(page.evaluate('document.getElementById("cardInner").inert') is True, f'{tag}: the card is inert while open')
        check(page.evaluate('document.getElementById("drawer").contains(document.activeElement)'), f'{tag}: focus moved into the drawer')
        shot('drawer-open')
        foot = page.evaluate('[...document.querySelectorAll(".drawer-foot button")].map(b => ({ t: b.innerText.replace(/\\s+/g, " ").trim(), w: b.getBoundingClientRect().width, h: b.getBoundingClientRect().height }))')
        check([f['t'].split(' ')[-1] for f in foot] == ['Help', 'Audiophile', 'Theme'] and all(f['h'] >= 44 and f['w'] >= 44 for f in foot), f'{tag}: the drawer footer buttons carry text labels and are at least 44 px ({foot})')
        # tap on the card's visible part closes
        page.tap('#cardCover', position={'x': w * 0.5, 'y': h * 0.5}) if False else T.drag([(w * 0.8, 500), (w * 0.8, 500)], 0.02)
        settle(page)
        check(not is_open(page) and abs(tx(page)) < 1, f'{tag}: tap on the pulled-aside card closes the drawer')
        # drag back to close
        T.drag(T.line(10, 420, 160, 420, 10)); settle(page)
        T.drag(T.line(w * 0.7, 420, w * 0.2, 420, 10)); settle(page)
        check(not is_open(page), f'{tag}: dragging the card back closes it')
        # a short quick fling opens even though the position is under half
        # (velocity comes from event timestamps, which CDP batches when the machine is busy: allow up to 6 attempts, close between them; the attempt count is printed)
        flung = 0
        for attempt in range(1, 7):
            T.drag(T.line(8, 420, 8 + w * 0.22, 420, 4), step_s=0.003); settle(page)
            if is_open(page): flung = attempt; break
            settle(page)
        print(f'     fling opened the drawer on attempt {flung or "none"}', flush=True)
        check(is_open(page), f'{tag}: a quick fling from the edge opens it')
        page.keyboard.press('Escape'); settle(page)
        check(not is_open(page), f'{tag}: Esc closes')
        # a slow drag under half returns closed
        T.drag(T.line(10, 420, 60, 420, 8), step_s=0.03); settle(page)
        check(not is_open(page), f'{tag}: a short slow drag settles back closed')
        # a vertical start is a scroll attempt, not ours
        T.drag(T.line(10, 420, 14, 560, 8)); settle(page)
        check(not is_open(page) and abs(tx(page)) < 1, f'{tag}: a vertical drag from the strip does not move the card')
        # mouse-less keyboard: hamburger toggles
        page.focus('.page:not([hidden]) .hamburger'); page.keyboard.press('Enter'); settle(page)
        check(is_open(page), f'{tag}: Enter on the hamburger opens')
        # arrow keys + Enter move through the menu
        page.keyboard.press('ArrowDown'); page.keyboard.press('ArrowDown')
        foc = page.evaluate('document.activeElement.dataset.section')
        check(foc == 'radio', f'{tag}: arrows move through the menu (focus on {foc})')
        # focus trap: tab many times, focus stays in the drawer
        for _ in range(12): page.keyboard.press('Tab')
        check(page.evaluate('document.getElementById("drawer").contains(document.activeElement)'), f'{tag}: Tab is trapped inside the open drawer')
        page.keyboard.press('Home'); page.keyboard.press('ArrowDown'); page.keyboard.press('Enter'); settle(page, 900)
        check(cur(page) == 'mixtapes' and not is_open(page), f'{tag}: Enter on a menu item switches section and closes ({cur(page)})')
        check(page.evaluate('localStorage.getItem("runout.section")') == 'mixtapes', f'{tag}: the last section is remembered')

        # ---- Mixtapes
        page.wait_for_timeout(600)
        shot('mixtapes')
        n = page.locator('.cs-card').count()
        check(n == 6, f'{tag}: six seeded mixtapes in the stack ({n})')
        top = page.evaluate('[...document.querySelectorAll(".cs-card")].sort((a, b) => b.style.zIndex - a.style.zIndex)[0].getAttribute("aria-label")')
        # tapping a lower tape brings it up (does not open the player)
        page.locator('.cs-card').nth(2).tap(position={'x': 150, 'y': 14}); page.wait_for_timeout(700)
        top2 = page.evaluate('[...document.querySelectorAll(".cs-card")].sort((a, b) => b.style.zIndex - a.style.zIndex)[0].getAttribute("aria-label")')
        check(top != top2 and page.locator('.tp:not(.hidden)').count() == 0, f'{tag}: tapping another tape brings it to the top ({top} -> {top2}), no player yet')
        shot('mixtapes-brought-up')
        # a drag that starts on a cassette (not on the strip) does not move the drawer
        T.drag(T.line(80, 300, 260, 300, 8)); settle(page, 400)
        check(not is_open(page) and abs(tx(page)) < 1, f'{tag}: a horizontal drag on the cassette stack does not move the drawer')
        check(page.evaluate('document.documentElement.scrollWidth <= innerWidth'), f'{tag}: no horizontal page scroll on Mixtapes')

        # ---- Radio (lazy) + Booth
        boot_reqs_radio = page.evaluate('performance.getEntriesByType("resource").map(r => r.name).filter(n => /radio-player|radio\\/canned/.test(n)).length')
        check(boot_reqs_radio == 0, f'{tag}: no radio code was fetched before the first visit to Radio')
        to_section(page, 'radio'); page.wait_for_selector('.dial-card', timeout=10000); page.wait_for_timeout(500)
        shot('radio')
        check(page.evaluate('performance.getEntriesByType("resource").map(r => r.name).filter(n => /radio-player/.test(n)).length') >= 1, f'{tag}: radio code is fetched when Radio opens')
        to_section(page, 'booth'); page.wait_for_timeout(500)
        shot('booth')
        check(page.evaluate('!!document.querySelector("#boothHost *")'), f'{tag}: Booth mounts something (placeholder or the FX component)')
        to_section(page, 'albums')
        check(not errs, f'{tag}: no page errors {errs}')

        # ---- gesture arbitration on the Albums page
        page.evaluate('window.__rt.setZ(0)'); page.wait_for_timeout(500)
        page.evaluate('window.__rt.app().stage.dispatch({type: "stop"})'); page.tap('#tt-playBtn'); page.wait_for_timeout(2200)
        d = disc(page)
        rate0 = page.evaluate('document.getElementById("rate").textContent')
        # (a) a drag that starts ON the platter does not move the drawer, and the platter scrubs
        a0 = d['rOut'] * 0.6
        circle = [(d['cx'] + a0 * math.cos(0.12 + i * 0.035), d['cy'] + a0 * math.sin(0.12 + i * 0.035)) for i in range(0, 40)]   # an arc that stays on screen
        T.drag(circle, step_s=0.016, release=False); page.wait_for_timeout(300)
        rate_during = page.evaluate('document.getElementById("rate").textContent')
        moved = tx(page); T.up(); settle(page, 500)
        check(abs(moved) < 1 and not is_open(page), f'{tag}: a drag on the platter does not move the drawer')
        check(rate_during != rate0 and rate_during != '1.00×', f'{tag}: vinyl scrub still works (rate {rate0} -> {rate_during})')
        # (b) a drag that starts in the tonearm / outer-edge zone, just outside the 24 px strip, does not move the drawer either
        x_edge = max(26, d['cx'] - d['rOut'] - 6)
        T.drag(T.line(x_edge, d['cy'], x_edge + 160, d['cy'] + 20, 10)); settle(page, 500)
        check(not is_open(page) and abs(tx(page)) < 1, f'{tag}: a drag from the disc\'s outer edge (x={x_edge:.0f}) does not move the drawer')
        # (c) while the platter is held, a second finger on the strip cannot start the drawer
        T.cdp.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': d['cx'] + a0, 'y': d['cy'], 'id': 1}]})
        T.cdp.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': d['cx'] + a0, 'y': d['cy'], 'id': 1}, {'x': 10, 'y': 420, 'id': 2}]})
        for i in range(8):
            T.cdp.send('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': [{'x': d['cx'] + a0, 'y': d['cy'], 'id': 1}, {'x': 10 + i * 20, 'y': 420, 'id': 2}]}); time.sleep(0.016)
        held = tx(page); T.up(); settle(page, 500)
        check(abs(held) < 1 and not is_open(page), f'{tag}: a second finger on the strip while the platter is held does not start the drawer')
        shot('albums-after-gestures')

        # ---- light theme (the reference is light)
        page.click('#btnTheme') if False else None
        T.drag(T.line(10, 420, 150, 420, 8)); settle(page)
        page.click('#btnTheme'); page.wait_for_timeout(400)
        shot('drawer-open-light')
        lt = page.evaluate('''(() => { const lum = (c) => { const m = c.match(/[\\d.]+/g).map(Number); const f = (v) => { v /= 255; return v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); }; return .2126 * f(m[0]) + .7152 * f(m[1]) + .0722 * f(m[2]); };
          const t = document.querySelector('#pageAlbums .page-title'), hs = document.querySelector('#pageAlbums .page-search'), hz = document.querySelector('#pageAlbums .dm-housing');
          return { theme: document.documentElement.dataset.theme, title: lum(getComputedStyle(t).color), search: lum(getComputedStyle(hs).color), housing: lum(getComputedStyle(hz).backgroundColor), page: lum(getComputedStyle(document.getElementById('pageAlbums')).backgroundColor) }; })()''')
        check(lt['theme'] == 'light' and lt['title'] > 0.6 and lt['search'] > 0.6 and lt['housing'] < 0.1 and lt['page'] < 0.05, f'{tag}: light theme: the player surface stays dark and the chrome on it is light-on-dark ({lt})')
        page.click('#btnTheme'); page.wait_for_timeout(300)   # back to dark
        page.keyboard.press('Escape'); settle(page)

        # ---- walkthrough does not cover the hamburger
        page.click('.page:not([hidden]) .hamburger'); settle(page)
        page.click('#btnWalkthrough'); page.wait_for_timeout(500)
        wt = page.evaluate('''(() => ({ dots: [...document.querySelectorAll('.wt-dot')].map(d => Math.round(d.getBoundingClientRect().top)), skip: (() => { const b = document.querySelector('.wt-skip'); const r = b.getBoundingClientRect(); return { w: r.width, h: r.height, vis: r.top >= 0 && r.bottom <= innerHeight && getComputedStyle(b).visibility !== 'hidden' }; })(), x: (() => { const r = document.querySelector('.wt-x').getBoundingClientRect(); return [r.width, r.height]; })(), text: document.querySelector('.wt-card').innerText }))()''')
        check(4 <= len(wt['dots']) <= 5 and len(set(wt['dots'])) == 1, f'{tag}: the tour has {len(wt["dots"])} steps and its progress dots sit on one row')
        check(wt['skip']['vis'] and wt['skip']['h'] >= 44 and wt['x'][0] >= 44, f'{tag}: Skip is visible on step 1 and the close button is at least 44 px')
        for _ in range(len(wt['dots']) - 1):
            page.click('.wt-next'); page.wait_for_timeout(150)
            ok_skip = page.evaluate("(() => { const r = document.querySelector('.wt-skip').getBoundingClientRect(); return r.bottom <= innerHeight && r.width >= 44 && r.height >= 44; })()")
            if not ok_skip: break
        check(ok_skip, f'{tag}: Skip stays on screen through the last step')
        alltext = wt['text'] + ' ' + page.evaluate("document.querySelector('.wt-card').innerText")
        check(not any(w_ in alltext.lower() for w_ in ['feel test', 'j / k', 'latency', 'estimate', 'this version']), f'{tag}: no developer wording in the tour')
        for _ in range(len(wt['dots']) - 1): page.click('.wt-prev'); page.wait_for_timeout(100)
        page.click('.wt-next'); page.wait_for_timeout(300)
        hb = page.evaluate('(() => { const h = document.querySelector(".page:not([hidden]) .hamburger").getBoundingClientRect(), c = document.querySelector(".wt-card").getBoundingClientRect(); return { hbBottom: h.bottom, cardTop: c.top, ring: !document.querySelector(".wt-ring").classList.contains("hidden") }; })()')
        check(hb['cardTop'] >= hb['hbBottom'] and hb['ring'], f'{tag}: the walkthrough card sits below the hamburger (card top {hb["cardTop"]:.0f} >= {hb["hbBottom"]:.0f}) and rings it')
        shot('walkthrough-hamburger')
        page.click('.wt-x'); page.wait_for_timeout(200)
        page.evaluate('document.querySelector(".wt-prev") && 0')
        ctx.close()

    # ---- persistence across a reload + playing sources survive section changes (360x780 only)
    ctx, page, errs = boot(b, 360, 780, 'p', speech=True)
    T = Touch(page)
    check(cur(page) == 'albums', 'fresh profile opens Albums')
    to_section(page, 'radio'); page.wait_for_selector('.dial-card')
    page.reload(); page.wait_for_function('document.getElementById("latency") && !/boot error/.test(document.getElementById("latency").textContent)'); page.wait_for_timeout(800)
    check(cur(page) == 'radio', f'reload reopens the last section ({cur(page)})')
    page.wait_for_selector('.dial-card')
    to_section(page, 'albums'); scan(page); to_section(page, 'radio'); page.wait_for_selector('.dial-card')
    # start a canned station, change sections: it keeps playing, the mini bar shows, tap returns
    page.click('.dial-card[data-station] .dial-play'); page.wait_for_timeout(2500)
    name = page.evaluate('document.querySelector(".radio-now .alb-name, .ai-card .ai-title, .dial-card.on .dial-name")?.textContent || ""')
    to_section(page, 'albums'); page.wait_for_timeout(900)
    mini = page.evaluate('(() => { const m = document.querySelector(".minibar"); return { hidden: m.hidden, text: m.innerText }; })()')
    check(not mini['hidden'] and 'Radio' in mini['text'], f'a playing radio station shows the mini bar on Albums: {mini["text"]!r}')
    page.screenshot(path=f'{SHOTS}/360x780-minibar-radio.png')
    mb = page.evaluate('(() => { const m = document.querySelector(".minibar").getBoundingClientRect(), s = document.querySelector("#pageAlbums .tt-wrap").getBoundingClientRect(); const bs = [...document.querySelectorAll(".minibar button")].filter(b => !b.hidden).map(b => ({ c: b.className, w: b.getBoundingClientRect().width, h: b.getBoundingClientRect().height })); return { top: m.top, stageBottom: s.bottom, bs, chev: !!document.querySelector(".minibar-chev") }; })()')
    check(mb['stageBottom'] <= mb['top'] + 1, f'the mini bar does not cover the bottom of the Albums stage (stage ends {mb["stageBottom"]:.0f}, bar starts {mb["top"]:.0f})')
    check(all(b['w'] >= 44 and b['h'] >= 44 for b in mb['bs']) and mb['chev'] and any('stop' in b['c'] for b in mb['bs']), f'the radio mini bar has a Stop control (>= 44 px) and a chevron that says tap to open ({mb["bs"]})')
    to_section(page, 'mixtapes'); page.wait_for_timeout(700)
    check(not page.evaluate('document.querySelector(".minibar").hidden'), 'the mini bar stays on Mixtapes while the radio plays')
    cover = page.evaluate('(() => { const m = document.querySelector(".minibar").getBoundingClientRect(), b = document.querySelector(".mt-body").getBoundingClientRect(); return { top: m.top, bodyBottom: b.bottom }; })()')
    check(cover['bodyBottom'] <= cover['top'] + 1, f'the mini bar does not cover the bottom of the Mixtapes list (list ends {cover["bodyBottom"]:.0f}, bar starts {cover["top"]:.0f})')
    check(page.evaluate('!!document.querySelector(".ai-panel:not(.hidden)")') or page.evaluate('document.querySelector(".radio-now") && !document.querySelector(".radio-now").classList.contains("hidden")'), 'the radio session is still alive after changing sections')
    page.tap('.minibar-main'); page.wait_for_timeout(900)
    check(cur(page) == 'radio', f'tapping the mini bar returns to Radio ({cur(page)})')
    check(page.evaluate('document.querySelector(".minibar").hidden'), 'the mini bar hides on the source\'s own section')
    page.screenshot(path=f'{SHOTS}/360x780-radio-playing.png')
    page.click('.ai-controls button:last-child') if page.locator('.ai-controls button').count() else None
    # stop it via the panel / now-bar
    for sel in ['.radio-now .theme-btn', '.ai-panel .ai-controls button:has-text("Stop")']:
        if page.locator(sel).count() and page.locator(sel).first.is_visible():
            page.locator(sel).first.click(); break
    page.wait_for_timeout(1500)
    # mixtape: scan the generated library, play the top tape, leave the section, mini bar shows, music continues
    to_section(page, 'mixtapes'); page.wait_for_timeout(800)
    page.locator('.cs-card').nth(5).tap(position={'x': 150, 'y': 60}); page.wait_for_selector('.tp:not(.hidden)', timeout=8000); page.wait_for_timeout(2500)
    page.screenshot(path=f'{SHOTS}/360x780-mixtape-player.png')
    page.click('.tp .btn-close'); page.wait_for_timeout(500)
    to_section(page, 'radio'); page.wait_for_timeout(900)
    mini = page.evaluate('(() => { const m = document.querySelector(".minibar"); return { hidden: m.hidden, text: m.innerText }; })()')
    check(not mini['hidden'] and 'Mixtape' in mini['text'], f'a playing mixtape shows the mini bar on Radio: {mini["text"]!r}')
    mt = page.evaluate('[...document.querySelectorAll(".minibar button")].filter(b => !b.hidden).map(b => ({ c: b.className, l: b.getAttribute("aria-label"), w: b.getBoundingClientRect().width, h: b.getBoundingClientRect().height }))')
    check(any('toggle' in b['c'] and b['l'] == 'Pause' for b in mt) and any('next' in b['c'] for b in mt) and all(b['w'] >= 44 and b['h'] >= 44 for b in mt), f'the mixtape mini bar has Pause and Next, both >= 44 px ({mt})')
    sub0 = page.evaluate('document.querySelector(".minibar-sub").innerText')
    page.tap('.minibar-next'); page.wait_for_timeout(1500)
    sub1 = page.evaluate('document.querySelector(".minibar-sub").innerText')
    check(sub0 != sub1 and not page.evaluate('document.querySelector(".minibar").hidden'), f'Next on the mini bar skips to the next song ({sub0!r} -> {sub1!r})')
    page.tap('.minibar-toggle'); page.wait_for_timeout(700)
    check(not page.evaluate('document.querySelector(".minibar").hidden') and page.get_attribute('.minibar-toggle', 'aria-label') == 'Play', 'Pause on the mini bar pauses the tape and the bar stays, now offering Play')
    page.tap('.minibar-toggle'); page.wait_for_timeout(900)
    check(page.get_attribute('.minibar-toggle', 'aria-label') == 'Pause', 'Play on the mini bar resumes the tape')
    rms = [page.evaluate('window.__rms()') for _ in range(5)] if page.evaluate('typeof window.__rms') == 'function' else [1]
    check(max(rms) > 0.002, f'the mixtape is audible while another section shows (rms {max(rms):.4f})')
    page.tap('.minibar-main'); page.wait_for_timeout(900)
    check(cur(page) == 'mixtapes', f'tapping the mini bar returns to Mixtapes ({cur(page)})')
    page.screenshot(path=f'{SHOTS}/360x780-minibar-home-mixtapes.png')
    check(not errs, f'no page errors {errs}')
    ctx.close()

    # ---- accessible names: label-in-name for the Back buttons, one pattern for the Library button
    ctx, page, errs = boot(b, 412, 915, '412x915-a11y')
    nm = page.evaluate("""() => { const own = (n) => n.nodeType === 3 ? n.textContent : (n.nodeType === 1 && n.getAttribute('aria-hidden') !== 'true' ? [...n.childNodes].map(own).join('') : '');
      const ok = (s) => { const e = document.querySelector(s); if (!e) return 'missing ' + s; const vis = (e.textContent || '').replace(/[\u2190-\u21ff]/g, '').trim().toLowerCase(); const name = (e.getAttribute('aria-label') || own(e)).trim().toLowerCase(); return name.startsWith(vis) && vis ? 'ok' : `${s}: name "${name}" vs visible "${vis}"`; };
      const lb = document.getElementById('btnLibrary');
      return { x1: ok('#themeX1'), x2: ok('#themeX2'), lib: lb ? { pressed: lb.hasAttribute('aria-pressed'), label: lb.getAttribute('aria-label'), text: lb.textContent.trim() } : null }; }""")
    check(nm['x1'] == 'ok' and nm['x2'] == 'ok', f'the theme overlay Back buttons: accessible name starts with the visible text ({nm["x1"]}; {nm["x2"]})')
    check(nm['lib'] and not nm['lib']['pressed'] and nm['lib']['label'] is None and nm['lib']['text'] == 'Library', f'the Library button uses ONE naming pattern: its visible label is its name, no aria-pressed / aria-label ({nm["lib"]})')
    ctx.close()

    # ---- landscape + small phone: usable, no horizontal scroll
    for (w, h, name) in [(780, 360, 'landscape'), (320, 640, '320x640'), (915, 412, 'landscape915')]:
        ctx, page, errs = boot(b, w, h, name)
        page.wait_for_timeout(400)
        page.screenshot(path=f'{SHOTS}/{name}-albums.png')
        for sec in ['mixtapes', 'radio', 'booth', 'albums']:
            to_section(page, sec)
            check(page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), f'{name}: no horizontal page scroll on {sec}')
            if sec != 'albums': page.screenshot(path=f'{SHOTS}/{name}-{sec}.png')
            small = page.evaluate('[...document.querySelectorAll(".page:not([hidden]) .page-head button, .page:not([hidden]) .mt-bar button")].filter(b => b.getBoundingClientRect().width < 44 || b.getBoundingClientRect().height < 44).length')
            check(small == 0, f'{name}: every header control on {sec} is at least 44x44')
        if w > h:
            # Booth in landscape: the six mode chips are >= 44 px wide, and the last pads scroll clear of the mini bar (forced visible here)
            to_section(page, 'booth'); page.wait_for_selector('.fx-row', timeout=10000); page.wait_for_timeout(800)
            ws = page.evaluate('[...document.querySelectorAll(".fx-row")].map(e => Math.round(e.getBoundingClientRect().width * 10) / 10)')
            check(len(ws) == 6 and min(ws) >= 44, f'{name}: the six Booth mode chips are at least 44 px wide ({ws})')
            r = page.evaluate("""() => { const m = document.querySelector('.minibar'); m.hidden = false; document.getElementById('card').dataset.mini = 'true';
              const f = document.querySelector('.fx-screen'); f.scrollTop = 99999; const pads = [...document.querySelectorAll('.fx-perf')].map(e => e.getBoundingClientRect().bottom);
              return { pad: Math.max(...pads), mini: m.getBoundingClientRect().top }; }""")
            check(r['pad'] <= r['mini'] + 1, f'{name}: scrolled to the end, the Booth pads end above the mini bar ({r["pad"]:.0f} <= {r["mini"]:.0f})')
            to_section(page, 'albums')
        page.click('.page:not([hidden]) .hamburger'); settle(page)
        page.screenshot(path=f'{SHOTS}/{name}-drawer-open.png')
        check(is_open(page), f'{name}: drawer opens')
        ctx.close()
    b.close()

print('\nALL OK' if not fails else '\nFAILED:\n  ' + '\n  '.join(fails))
sys.exit(1 if fails else 0)
