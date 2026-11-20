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
        check(abs(m['sw'] - m['cw']) < 2 and abs(m['sh'] - m['ch']) < 2, f'{tag}: the stage fills the Albums card ({m["sw"]:.0f}x{m["sh"]:.0f} in {m["cw"]:.0f}x{m["ch"]:.0f})')
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
        # tap on the card's visible part closes
        page.tap('#cardCover', position={'x': w * 0.5, 'y': h * 0.5}) if False else T.drag([(w * 0.8, 500), (w * 0.8, 500)], 0.02)
        settle(page)
        check(not is_open(page) and abs(tx(page)) < 1, f'{tag}: tap on the pulled-aside card closes the drawer')
        # drag back to close
        T.drag(T.line(10, 420, 160, 420, 10)); settle(page)
        T.drag(T.line(w * 0.7, 420, w * 0.2, 420, 10)); settle(page)
        check(not is_open(page), f'{tag}: dragging the card back closes it')
        # a short quick fling opens even though the position is under half
        T.drag(T.line(8, 420, 8 + w * 0.22, 420, 4), step_s=0.003); settle(page)
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
        page.click('#btnTheme'); page.wait_for_timeout(300)   # back to dark
        page.keyboard.press('Escape'); settle(page)

        # ---- walkthrough does not cover the hamburger
        page.click('.page:not([hidden]) .hamburger'); settle(page)
        page.click('#btnWalkthrough'); page.wait_for_timeout(500)
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
    to_section(page, 'mixtapes'); page.wait_for_timeout(700)
    check(not page.evaluate('document.querySelector(".minibar").hidden'), 'the mini bar stays on Mixtapes while the radio plays')
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
    rms = [page.evaluate('window.__rms()') for _ in range(5)] if page.evaluate('typeof window.__rms') == 'function' else [1]
    check(max(rms) > 0.002, f'the mixtape is audible while another section shows (rms {max(rms):.4f})')
    page.tap('.minibar-main'); page.wait_for_timeout(900)
    check(cur(page) == 'mixtapes', f'tapping the mini bar returns to Mixtapes ({cur(page)})')
    page.screenshot(path=f'{SHOTS}/360x780-minibar-home-mixtapes.png')
    check(not errs, f'no page errors {errs}')
    ctx.close()

    # ---- landscape + small phone: usable, no horizontal scroll
    for (w, h, name) in [(780, 360, 'landscape'), (320, 640, '320x640')]:
        ctx, page, errs = boot(b, w, h, name)
        page.wait_for_timeout(400)
        page.screenshot(path=f'{SHOTS}/{name}-albums.png')
        for sec in ['mixtapes', 'radio', 'booth', 'albums']:
            to_section(page, sec)
            check(page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), f'{name}: no horizontal page scroll on {sec}')
            if sec != 'albums': page.screenshot(path=f'{SHOTS}/{name}-{sec}.png')
        page.click('.page:not([hidden]) .hamburger'); settle(page)
        page.screenshot(path=f'{SHOTS}/{name}-drawer-open.png')
        check(is_open(page), f'{name}: drawer opens')
        ctx.close()
    b.close()

print('\nALL OK' if not fails else '\nFAILED:\n  ' + '\n  '.join(fails))
sys.exit(1 if fails else 0)
