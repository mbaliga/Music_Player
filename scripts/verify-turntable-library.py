#!/usr/bin/env python3
"""Verify the turntable library component (src/turntable/library.js, docs/TURNTABLE_LIBRARY.md) in Chromium.

Needs: Playwright for Python and (for the side-by-side) Pillow. It starts its own dev server (serve.py) and drives the harness page
test/support/turntable-library.html, which mounts the real module on fake albums.
Usage:  python3 scripts/verify-turntable-library.py [outdir]        (default docs/screenshots/turntable-library)
Set CHROME=/path/to/chrome (default /opt/pw-browsers/chromium-1243/chrome-linux64/chrome).
Set PROTO=/path/to/original-prototype.html to also compare the library state with the owner's prototype (window.__rt.setZ(1)).

Checks: screenshots at 1241x561, 561x1241, 360x780, 412x915 with 5 and 40 albums (a CD, long, hostile, non-Latin and cover-less titles);
swipe (slow and flick) changes focus and fires 'focus' exactly once per settle; a tap on a row fires selectTrack with the right ids;
a tap on the centre cover fires tapCover; getSlotRect stays at the slot centre mid-swipe and follows the page scroll; setOpacity(.49) / hide()
make it inert; keyboard (arrows, Enter, row navigation); no console errors; hostile titles never become markup; 2000 albums keep the DOM
and canvas count bounded; reduced motion; real touch events (CDP) swipe.
Not a substitute for the on-device checks listed in docs/TURNTABLE_LIBRARY.md.
"""
import json, os, subprocess, sys, time, socket
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'docs/screenshots/turntable-library')
os.makedirs(OUT, exist_ok=True)
CH = os.environ.get('CHROME', '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome')
PROTO = os.environ.get('PROTO', '')
fails = []
def check(ok, msg):
    if not ok: fails.append(msg)
    print(('ok   ' if ok else 'FAIL ') + msg, flush=True)

def free_port():
    s = socket.socket(); s.bind(('127.0.0.1', 0)); p = s.getsockname()[1]; s.close(); return p
PORT = free_port()
srv = subprocess.Popen([sys.executable, os.path.join(ROOT, 'serve.py'), str(PORT)], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.0)
BASE = f'http://localhost:{PORT}/test/support/turntable-library.html'

def open_page(b, w, h, qs, touch=False, reduced=False, scale=2):
    ctx = b.new_context(bypass_csp=True, viewport={'width': w, 'height': h}, device_scale_factor=scale, has_touch=touch, is_mobile=touch,
                        reduced_motion='reduce' if reduced else 'no-preference')
    pg = ctx.new_page()
    pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(f'{BASE}?{qs}')
    pg.wait_for_function('window.__ready===true')
    pg.wait_for_timeout(500)
    return ctx, pg
errs = []

def J(pg, js): return pg.evaluate(js)
def centre_cover(pg): return J(pg, '(()=>{const r=document.querySelector(\'.tl-cv[aria-selected="true"]\').getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}})()')
def slot(pg): return J(pg, '(()=>{const r=__lib.getSlotRect();return {x:r.x,y:r.y,w:r.width,h:r.height}})()')
def log_since(pg): l = J(pg, '__log.splice(0)'); return l
def wait_settle(pg, ms=1100): pg.wait_for_timeout(ms)

def drag(pg, x0, y0, dx, steps=10, dt=16, release=True):
    pg.mouse.move(x0, y0); pg.mouse.down()
    for i in range(1, steps + 1):
        pg.mouse.move(x0 + dx * i / steps, y0); pg.wait_for_timeout(dt)
    if release: pg.mouse.up()

try:
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=CH)
        # ── screenshots ────────────────────────────────────────────────────────────────────────────────────────────
        for (w, h) in [(1241, 561), (561, 1241), (360, 780), (412, 915)]:
            for sset in ['5', '40']:
                ctx, pg = open_page(b, w, h, f'set={sset}', scale=1 if w > 1000 else 2)
                if sset == '40': pg.evaluate('__lib.focus(5,{animate:false})')   # a CD with a cover
                pg.wait_for_timeout(300)
                pg.screenshot(path=os.path.join(OUT, f'lib-{sset}-{w}x{h}.png'))
                ctx.close()
        ctx, pg = open_page(b, 360, 780, 'set=empty'); pg.screenshot(path=os.path.join(OUT, 'lib-empty-360x780.png')); 
        check(J(pg, '__lib.el.classList.contains("tl-empty")') and J(pg, 'getComputedStyle(document.querySelector(".tl-hint")).display') == 'block', 'empty library: only the test pressing, with the scan hint')
        pg.click('.tl-hint'); check(log_since(pg) == [['scan']], 'the hint emits scan')
        check(J(pg, 'document.querySelector(".tl-title").textContent') == 'Demo record' and 'play your own music' in J(pg, 'document.querySelector(".tl-hint").textContent'),
              'empty state: "Demo record" and "...play your own music" (no "test pressing" wording)')
        ctx.close()

        # ── narrow phone (tight toolbar): every chip is a 44 px target; Rescan label + last-scan caption; the first-run nudge ──────────────────
        ctx, pg = open_page(b, 360, 780, 'set=40')
        bad = J(pg, '[...document.querySelectorAll(".tl-chip")].filter(e => e.getBoundingClientRect().width > 0).map(e => { const r = e.getBoundingClientRect(); return [e.className, Math.round(r.width), Math.round(r.height)]; }).filter(r => r[1] < 44 || r[2] < 44)')
        check(not bad, f'360 px: every visible library chip (ALL / VINYL / CD, sort, scan) is >= 44 x 44 ({bad})')
        J(pg, '__lib.setScanLabel({long: "Rescan phone", short: "Rescan"}); __lib.setScanInfo("50 songs · last scan 3 min ago")')
        check(J(pg, 'document.querySelector(".tl-scan .tl-short").textContent') == 'Rescan' and J(pg, 'document.querySelector(".tl-scan").title') == '50 songs · last scan 3 min ago', 'the scan chip relabels to Rescan and carries the last-scan info')
        J(pg, 'document.querySelector(".tl-scroll").scrollTop = 99999'); pg.wait_for_timeout(150)
        foot = J(pg, '(() => { const e = document.querySelector(".tl-foot"); const r = e.getBoundingClientRect(); return { hidden: e.hidden, text: e.textContent, ok: r.width > 0 && r.height > 0 }; })()')
        check(not foot['hidden'] and foot['ok'] and foot['text'].startswith('50 songs'), f'the track list ends with the library caption ({foot})')
        J(pg, 'document.querySelector(".tl-scroll").scrollTop = 0')
        J(pg, '__lib.setPickHint("Pick an album")'); pg.wait_for_timeout(100)
        ph = J(pg, '(() => { const e = document.querySelector(".tl-pick"); const r = e.getBoundingClientRect(); return { hidden: e.hidden, text: e.textContent, w: r.width, h: r.height, bottom: r.bottom, vh: innerHeight, pe: getComputedStyle(e).pointerEvents }; })()')
        check(not ph['hidden'] and ph['text'] == 'Pick an album' and ph['w'] > 80 and ph['bottom'] <= ph['vh'] and ph['pe'] == 'none', f'the "Pick an album" nudge is pinned in view and never eats a swipe ({ph})')
        dock = J(pg, '(() => { const s = document.querySelector(".tl-scroll").getBoundingClientRect(), p = document.querySelector(".tl-pick").getBoundingClientRect(); return { sb: s.bottom, pt: p.top }; })()')
        check(dock['sb'] <= dock['pt'] + 1, f'the "Pick an album" pill is docked below the scroll area, over no row or footer ({dock})')
        J(pg, '__lib.setPickHint(null)'); check(J(pg, 'document.querySelector(".tl-pick").hidden'), 'and it can be cleared')
        ctx.close()

        # ── landscape: the tracks sit beside the cover fan, with room for several rows ───────────────────────────────────────────────
        ctx, pg = open_page(b, 915, 412, 'set=40')
        J(pg, '__lib.setPickHint("Pick an album")'); pg.wait_for_timeout(150)
        ls = J(pg, '(() => { const f = document.querySelector(".tl-flow").getBoundingClientRect(), t = document.querySelector(".tl-tracks").getBoundingClientRect(), vh = innerHeight; const rows = [...document.querySelectorAll(".tl-trk")].filter((e) => { const r = e.getBoundingClientRect(); return r.top >= t.top - 1 && r.bottom <= t.bottom + 1 && r.height > 0; }).length; const m = document.querySelector(".tl-meta").getBoundingClientRect(), pk = document.querySelector(".tl-pick").getBoundingClientRect(); return { fr: f.right, tl: t.left, rows, pickOnMeta: !(pk.right < m.left || pk.left > m.right || pk.bottom < m.top || pk.top > m.bottom) }; })()')
        check(ls['tl'] >= ls['fr'] - 2 and ls['rows'] >= 3 and not ls['pickOnMeta'], f'915x412: tracks beside the cover (>= 3 rows visible) and the pick pill is clear of the title ({ls})')
        pg.screenshot(path=os.path.join(OUT, 'lib-landscape-two-column.png'))
        ctx.close()

        # ── behaviour at 360x780, 40 albums (mouse) ────────────────────────────────────────────────────────────────
        errs.clear()
        ctx, pg = open_page(b, 360, 780, 'set=40')
        ids = J(pg, '__albums.map(a=>a.id)'); N = len(ids)
        cc = centre_cover(pg); cx, cy = cc['x'] + cc['w'] / 2, cc['y'] + cc['h'] / 2
        check(J(pg, '__lib.getFocus()') == 0, 'starts on the first album')
        log_since(pg)
        # slow swipe left, release between albums -> snaps to the nearest, ONE focus event
        drag(pg, cx, cy, -170, steps=14, dt=30); wait_settle(pg)
        l = log_since(pg); check([e[0] for e in l] == ['focus'] and l[0][1] == J(pg, '__lib.getFocus()') == 1, f'slow swipe left -> album 1, one focus event ({l})')
        check(l and l[0][2] == ids[1], 'the focus event carries the album id too')
        # swipe right goes back
        drag(pg, cx, cy, 170, steps=14, dt=30); wait_settle(pg)
        l = log_since(pg); check([e[0] for e in l] == ['focus'] and J(pg, '__lib.getFocus()') == 0, f'swipe right -> back to 0, one focus event ({l})')
        # a drag that returns to the same album: no event
        drag(pg, cx, cy, -40, steps=6, dt=30); wait_settle(pg)
        check(log_since(pg) == [] and J(pg, '__lib.getFocus()') == 0, 'a short drag that settles on the same album fires nothing')
        # flick: a few fast moves
        drag(pg, cx + 100, cy, -200, steps=4, dt=8); wait_settle(pg, 1500)
        l = log_since(pg); f = J(pg, '__lib.getFocus()')
        check(len(l) == 1 and f >= 2 and l[0][1] == f, f'a flick carries momentum past one album (focus {f}), still one focus event')
        # slot tracking mid-swipe: stays at the slot centre; the real centre cover moves
        J(pg, '__lib.focus(10,{animate:false})'); wait_settle(pg, 200); log_since(pg)
        s0 = slot(pg); cc = centre_cover(pg)
        check(abs(s0['x'] + s0['w'] / 2 - 180) < 1 and abs(s0['w'] - cc['w']) < 1, f'slot is centred and cover-sized at rest ({s0})')
        pg.mouse.move(cx, cy); pg.mouse.down()
        for i in range(1, 8): pg.mouse.move(cx - 18 * i, cy); pg.wait_for_timeout(30)
        s1 = slot(pg); mid = J(pg, '(()=>{const q=[...document.querySelectorAll(".tl-cv")].filter(e=>e.style.visibility==="visible").map(e=>e.getBoundingClientRect().x);return q})()')
        check(abs(s1['x'] - s0['x']) < 0.5 and abs(s1['y'] - s0['y']) < 0.5, 'mid-swipe the slot stays at the slot centre (as the prototype does)')
        pg.mouse.up(); wait_settle(pg); log_since(pg)
        # the page scrolls: slot follows by exactly the scroll distance
        J(pg, 'document.querySelector(".tl-scroll").scrollTop=120'); pg.wait_for_timeout(100)
        sc = J(pg, 'document.querySelector(".tl-scroll").scrollTop')
        s2 = slot(pg); check(sc > 50 and abs((s0['y'] - s2['y']) - sc) < 1.5, f'getSlotRect follows the scroll ({s0["y"] - s2["y"]:.1f} px for {sc} px)')
        J(pg, 'document.querySelector(".tl-scroll").scrollTop=0')
        # tap a row
        rows = J(pg, 'document.querySelectorAll(".tl-trk").length')
        cur = J(pg, '__lib.getFocus()'); nt = J(pg, '__albums[__lib.getFocus()].tracks.length'); check(rows == nt, f'row count == track count ({rows})')
        pg.locator('.tl-trk').nth(1).scroll_into_view_if_needed(); pg.locator('.tl-trk').nth(1).click(); l = log_since(pg)
        check(l == [['selectTrack', ids[cur], 1]], f'tap row 2 -> selectTrack(albumId, 1) ({l})')
        J(pg, 'document.querySelector(".tl-scroll").scrollTop=0'); pg.wait_for_timeout(100)
        # tap centre cover
        cc = centre_cover(pg); pg.mouse.click(cc['x'] + cc['w'] / 2, cc['y'] + cc['h'] / 2); l = log_since(pg)
        check(l == [['tapCover', ids[cur]]], f'tap the centre cover -> tapCover(albumId) ({l})')
        # tap a neighbour: becomes the focus (one focus event), no tapCover
        nb = J(pg, '(()=>{const r=[...document.querySelectorAll(".tl-cv")].find(e=>e.getAttribute("aria-posinset")==String(__lib.getFocus()+2)).getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]})()')
        pg.mouse.click(nb[0], nb[1]); wait_settle(pg); l = log_since(pg)
        check([e[0] for e in l] == ['focus'] and l[0][1] == cur + 1, f'tap a neighbour cover brings it to the centre ({l})')
        # now-playing dot
        J(pg, f'__lib.setNowPlaying({{albumId:{json.dumps(ids[cur + 1])},trackIndex:2}})')
        check(J(pg, '[...document.querySelectorAll(".tl-trk")].map(e=>e.classList.contains("on")).join()').startswith('false,false,true'), 'setNowPlaying marks the playing row (glowing dot)')
        J(pg, '__lib.setNowPlaying(null)'); check('true' not in J(pg, '[...document.querySelectorAll(".tl-trk")].map(e=>e.classList.contains("on")).join()'), 'setNowPlaying(null) clears it')
        # toolbar events
        pg.click('.tl-scan'); pg.click('.tl-f >> nth=1'); pg.click('.tl-s >> nth=2'); l = log_since(pg)
        check(l == [['scan'], ['filter', 'vinyl'], ['sort', 'genre']], f'toolbar emits scan / filter / sort ({l})')
        check(J(pg, 'document.querySelectorAll(".tl-chip[aria-pressed=true]").length') == 2, 'one filter and one sort chip pressed')
        # opacity / inertness
        J(pg, '__lib.setOpacity(0.49)'); cc = centre_cover(pg)
        check(J(pg, '__lib.el.hasAttribute("inert")') and J(pg, 'getComputedStyle(__lib.el).pointerEvents') == 'none', 'opacity .49 -> inert and pointer-events none')
        pg.mouse.click(cc['x'] + cc['w'] / 2, cc['y'] + cc['h'] / 2); drag(pg, cx, cy, -170, steps=8)
        wait_settle(pg, 300); check(log_since(pg) == [], 'no tap / swipe is delivered while inert')
        check(J(pg, 'document.elementFromPoint(%f,%f).closest(".tl-lib")' % (cx, cy)) is None, 'elementFromPoint does not hit the library when inert')
        s3 = slot(pg); check(s3['w'] > 0, 'getSlotRect still works while faded out (the disc needs it)')
        J(pg, '__lib.setOpacity(0.5)'); check(not J(pg, '__lib.el.hasAttribute("inert")'), 'opacity .5 -> live')
        J(pg, '__lib.setOpacity(0)'); check(J(pg, '__lib.el.hasAttribute("inert")') and J(pg, 'getComputedStyle(__lib.el).visibility') == 'hidden', 'opacity 0 -> inert and not painted')
        J(pg, '__lib.setOpacity(1); __lib.hide()')
        check(J(pg, 'getComputedStyle(__lib.el).visibility') == 'hidden' and J(pg, '__lib.el.getAttribute("aria-hidden")') == 'true', 'hide() removes it from the accessibility tree')
        pg.keyboard.press('Tab'); pg.keyboard.press('Tab')
        check(J(pg, '!document.activeElement || !document.activeElement.closest(".tl-lib")'), 'hidden: nothing inside is focusable')
        J(pg, '__lib.show()'); check(J(pg, 'getComputedStyle(__lib.el).visibility') == 'visible' and not J(pg, '__lib.el.hasAttribute("inert")'), 'show() brings it back')
        # keyboard
        J(pg, '__lib.focus(3,{animate:false})'); log_since(pg)
        J(pg, 'document.querySelector(".tl-flow").focus()')
        pg.keyboard.press('ArrowRight'); wait_settle(pg, 700); l = log_since(pg)
        check([e[0] for e in l] == ['focus'] and l[0][1] == 4, f'ArrowRight -> next album ({l})')
        pg.keyboard.press('ArrowLeft'); pg.keyboard.press('ArrowLeft'); wait_settle(pg, 700); l = log_since(pg)
        check(J(pg, '__lib.getFocus()') == 2, 'ArrowLeft x2 -> two albums back (one settle)')
        log_since(pg); pg.keyboard.press('Enter'); l = log_since(pg); check(l == [['tapCover', ids[2]]], f'Enter on the flow -> tapCover ({l})')
        check(J(pg, 'document.querySelector(".tl-flow").getAttribute("role")') == 'listbox' and J(pg, 'document.querySelectorAll(".tl-cv[role=option]").length') >= 5, 'listbox / option roles')
        pg.keyboard.press('Tab'); check(J(pg, 'document.activeElement.classList.contains("tl-playalb")'), 'Tab from the flow reaches the Play album button')
        l = log_since(pg); pg.keyboard.press('Enter'); l = log_since(pg); check(l == [['tapCover', ids[2]]], f'Enter on Play album -> tapCover, the album plays ({l})')
        pg.keyboard.press('Tab'); check(J(pg, 'document.activeElement.classList.contains("tl-trk")'), 'Tab again reaches the track list')
        pg.keyboard.press('ArrowDown'); pg.keyboard.press('Enter'); l = log_since(pg)
        check(l == [['selectTrack', ids[2], 1]], f'ArrowDown + Enter on a row -> selectTrack ({l})')
        # row targets
        mins = J(pg, 'Math.min(...[...document.querySelectorAll(".tl-trk")].map(e=>e.getBoundingClientRect().height))')
        chipsH = J(pg, 'Math.min(...[...document.querySelectorAll(".tl-chip")].map(e=>e.getBoundingClientRect().height))')
        check(mins >= 44 and chipsH >= 44, f'44 px targets (rows {mins}, chips {chipsH})')
        check(not errs, f'no console errors ({errs[:2]})')
        ctx.close()

        # ── hostile titles ─────────────────────────────────────────────────────────────────────────────────────────
        errs.clear()
        ctx, pg = open_page(b, 412, 915, 'set=40')
        idx = J(pg, '__albums.findIndex(a=>a.title.startsWith("<img"))'); pg.evaluate(f'__lib.focus({idx},{{animate:false}})'); pg.wait_for_timeout(200)
        check(J(pg, 'document.querySelector(".tl-title").textContent.startsWith("<img src=x onerror")'), 'a title of <img onerror=...> is shown as text')
        idx2 = J(pg, '__albums.findIndex(a=>a.title.startsWith("\\"><script"))'); pg.evaluate(f'__lib.focus({idx2},{{animate:false}})'); pg.wait_for_timeout(200)
        pg.screenshot(path=os.path.join(OUT, 'lib-hostile-412x915.png'))
        idx3 = J(pg, '__albums.findIndex(a=>a.tracks.some(t=>t.title.includes("<b>")))'); pg.evaluate(f'__lib.focus({idx3},{{animate:false}})'); pg.wait_for_timeout(100)
        rowtxt = J(pg, '[...document.querySelectorAll(".tl-trk .t")].map(e=>e.textContent).join("|")')
        check('<b>bold</b>' in rowtxt, 'a hostile track title is text too')
        check(J(pg, '__lib.el.querySelectorAll("img,script,b,iframe,svg").length') == 0 and J(pg, 'window.__pwned === undefined'), 'no element or script injected by hostile titles')
        j = J(pg, '__albums.findIndex(a=>a.title.length>4000)'); pg.evaluate(f'__lib.focus({j},{{animate:false}})'); pg.wait_for_timeout(200)
        check(J(pg, 'document.querySelector(".tl-title").textContent.length') <= 200 and J(pg, 'document.querySelector(".tl-title").getBoundingClientRect().height') < 40, 'a 5000-char title is clipped (200 chars, one line)')
        check(not errs, f'no console errors ({errs[:2]})')
        ctx.close()

        # ── 2000 albums: bounded DOM / canvases ────────────────────────────────────────────────────────────────────
        errs.clear()
        ctx, pg = open_page(b, 412, 915, 'set=2000')
        nodes = J(pg, '__lib.el.querySelectorAll("*").length'); base_nodes = nodes
        cvs = J(pg, '__lib.el.querySelectorAll("canvas").length')
        for k in [10, 400, 1000, 1999]:
            J(pg, f'__lib.focus({k},{{animate:false}})')
        for i in range(30):
            pg.mouse.move(200, 400); pg.mouse.down(); pg.mouse.move(80, 400, steps=4); pg.mouse.up(); pg.wait_for_timeout(30)
        pg.wait_for_timeout(800)
        nodes2 = J(pg, '__lib.el.querySelectorAll("*").length'); cvs2 = J(pg, '__lib.el.querySelectorAll("canvas").length')
        n_albums = J(pg, '__albums.length')
        check(n_albums >= 2000 and nodes2 < 260 and cvs2 <= 9, f'{n_albums} albums: {nodes2} DOM nodes below the root, {cvs2} canvases in the DOM (start {base_nodes}/{cvs})')
        t = J(pg, '(()=>{const t0=performance.now();const l=mountTurntableLibrary;return 0})()') if False else 0
        check(not errs, f'no console errors ({errs[:2]})')
        ctx.close()

        # ── reduced motion ─────────────────────────────────────────────────────────────────────────────────────────
        ctx, pg = open_page(b, 360, 780, 'set=40', reduced=True)
        drag(pg, 180, 250, -170, steps=10, dt=20); pg.wait_for_timeout(120)
        l = log_since(pg); check(len(l) == 1 and l[0][0] == 'focus', f'prefers-reduced-motion: the focus settles at once, no easing ({l})')
        ctx.close()

        # ── real touch events (CDP) ────────────────────────────────────────────────────────────────────────────────
        ctx, pg = open_page(b, 360, 780, 'set=40', touch=True)
        cdp = ctx.new_cdp_session(pg)
        def tsend(kind, pts): cdp.send('Input.dispatchTouchEvent', {'type': kind, 'touchPoints': [{'x': x, 'y': y} for x, y in pts]})
        cc = centre_cover(pg); x, y = cc['x'] + cc['w'] / 2, cc['y'] + cc['h'] / 2
        tsend('touchStart', [(x, 600)])
        for i in range(1, 9): tsend('touchMove', [(x, 600 - 30 * i)]); time.sleep(0.016)
        tsend('touchEnd', []); pg.wait_for_timeout(500)
        st = J(pg, 'document.querySelector(".tl-scroll").scrollTop'); l = log_since(pg)
        check(st > 20 and l == [], f'a vertical touch pan scrolls the list and does not change album (scrollTop {st}, events {l})')
        J(pg, 'document.querySelector(".tl-scroll").scrollTop = 0'); pg.wait_for_timeout(200); cc = centre_cover(pg); x, y = cc['x'] + cc['w'] / 2, cc['y'] + cc['h'] / 2   # the pan scrolled the list (it is longer now: Play album); the cover is back where it was
        tsend('touchStart', [(x, y)])
        for i in range(1, 13): tsend('touchMove', [(x - 14 * i, y)]); time.sleep(0.016)
        tsend('touchEnd', []); wait_settle(pg, 1400)
        l = log_since(pg); check(len(l) == 1 and l[0][0] == 'focus' and l[0][1] >= 1, f'touch swipe changes album, one focus event ({l})')
        ctx.close()

        # ── fidelity against the owner's prototype ─────────────────────────────────────────────────────────────────
        if PROTO and os.path.exists(PROTO):
            from PIL import Image
            report = []
            for (w, h) in [(1241, 561), (561, 1241), (582, 1162)]:
                c1 = b.new_context(bypass_csp=True, viewport={'width': w, 'height': h}); po = c1.new_page(); po.goto('file://' + PROTO); po.wait_for_timeout(700)
                po.evaluate('window.__rt.setZ(1); window.__rt.focus(2)'); po.wait_for_timeout(500)
                po.screenshot(path=os.path.join(OUT, f'proto-{w}x{h}.png'))
                geo_o = po.evaluate('''(()=>{const R=e=>{const r=e.getBoundingClientRect();return [r.x,r.y,r.width,r.height]};
                  const cv=[...document.querySelectorAll(".cv")].map(R);const lis=[...document.querySelectorAll("#tracks li")].map(R);
                  const cs=getComputedStyle(document.getElementById("lib"));
                  return {cv,title:R(document.getElementById("mTitle")),sub:R(document.getElementById("mSub")),rows:lis,slot:R(document.getElementById("slot")),
                  vars:["--cs","--ct","--fh","--mh","--f1","--f2","--pad","--rh"].map(k=>cs.getPropertyValue(k).trim()),
                  tf:[...document.querySelectorAll(".cv")].map(e=>e.style.transform)}})()''')
                c2 = b.new_context(bypass_csp=True, viewport={'width': w, 'height': h}); pm = c2.new_page(); pm.goto(f'{BASE}?set=5'); pm.wait_for_function('window.__ready===true'); pm.wait_for_timeout(600)
                pm.screenshot(path=os.path.join(OUT, f'mine-{w}x{h}.png'))
                geo_m = pm.evaluate('''(()=>{const R=e=>{const r=e.getBoundingClientRect();return [r.x,r.y,r.width,r.height]};
                  const cv=[...document.querySelectorAll(".tl-cv")].filter(e=>e.style.visibility==="visible").sort((a,b)=>a.getAttribute("aria-posinset")-b.getAttribute("aria-posinset")).map(R);
                  const lis=[...document.querySelectorAll(".tl-trk")].map(R);const cs=getComputedStyle(__lib.el);
                  return {cv,title:R(document.querySelector(".tl-title")),sub:R(document.querySelector(".tl-sub")),rows:lis,slot:R(document.querySelector(".tl-slot")),
                  vars:["--cs","--ct","--fh","--mh","--f1","--f2","--pad","--rh"].map(k=>cs.getPropertyValue(k).trim())}})()''')
                mx = lambda A, B: max(abs(a - b) for a, b in zip(A, B))
                d_cv = max(mx(a, b) for a, b in zip(geo_o['cv'], geo_m['cv'])); d_rows = max(mx(a, b) for a, b in zip(geo_o['rows'], geo_m['rows']))
                report.append({'viewport': f'{w}x{h}', 'vars_proto': geo_o['vars'], 'vars_mine': geo_m['vars'], 'max_cover_rect_diff_px': round(d_cv, 2),
                               'title_diff_px': round(mx(geo_o['title'], geo_m['title']), 2), 'sub_diff_px': round(mx(geo_o['sub'], geo_m['sub']), 2),
                               'slot_diff_px': round(mx(geo_o['slot'], geo_m['slot']), 2), 'max_row_rect_diff_px': round(d_rows, 2)})
                A = Image.open(os.path.join(OUT, f'proto-{w}x{h}.png')).convert('RGB'); B = Image.open(os.path.join(OUT, f'mine-{w}x{h}.png')).convert('RGB')
                sb = Image.new('RGB', (A.width + B.width + 12, A.height), (60, 60, 70)); sb.paste(A, (0, 0)); sb.paste(B, (A.width + 12, 0))
                sb.save(os.path.join(OUT, f'compare-{w}x{h}.png'))
                c1.close(); c2.close()
            print(json.dumps(report, indent=1))
            json.dump(report, open(os.path.join(OUT, 'fidelity.json'), 'w'), indent=1)
        b.close()
finally:
    srv.terminate()
print('\nFAILED: %d' % len(fails) if fails else '\nall checks passed')
for f in fails: print(' -', f)
sys.exit(1 if fails else 0)
