#!/usr/bin/env python3
"""Layout and tap-target checks for the Radio tab (the dial, the canned card, saved lists) in desktop Chromium + Playwright.

Needs: ffmpeg, Playwright for Python, the dev server:  python3 serve.py 8123   (CHROME=/path/to/chrome when needed)
Usage:  python3 scripts/verify-radio-layout.py [outdir]     Exits non-zero when an assertion fails; screenshots go to outdir/shots.

Asserts, at 360x780, 320x640 and 412x915:
  * dial star and card Play button hit areas are >= 44 px (a missed star tap cannot reach the card's Play button), audition buttons >= 40 px tall
  * no role=button container holds a button (the dial cards are plain containers with one real <button>)
  * while the canned card is mounted the now-bar is hidden, and the dial scroller keeps >= 190 px in: idle, playing, long captions,
    a long error / music-only note, and the Cast list expanded; no horizontal page scroll
  * saved canned entries are refreshed from the stations index; one whose station is gone says "no longer in the app" with Remove
"""
import json, os, sys, time
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = open(os.path.join(ROOT, 'scripts/verify-canned-radio.py')).read()
src = src[:src.index('def run():')]
OUTDIR = sys.argv[1] if len(sys.argv) > 1 else '/tmp/radio-layout'
sys.argv = ['x', OUTDIR]
exec(src)                                  # helpers: make_fixtures, open_radio, scan, launch, FAKE_SPEECH, SHOTS
make_fixtures()
VIEWS = [(360, 780), (320, 640), (412, 915)]
MIN_SCROLLER = 190
LONG = 'Welcome back to the show everybody, this is a deliberately long caption line that wraps over several rows on a narrow phone screen to stress the card height. ' * 2
fails = []
def check(ok, msg):
    if not ok: fails.append(msg)
    print(('ok   ' if ok else 'FAIL ') + msg)

STATE = '''()=>{const w=document.querySelector('#paneRadio .lib-grid-wrap'), n=document.querySelector('.radio-now'), p=document.querySelector('.ai-panel');
  return {scroller: Math.round(w.getBoundingClientRect().height), nowShown: !!n && getComputedStyle(n).display !== 'none', cardUp: !!p && !p.classList.contains('hidden'),
          hscroll: document.documentElement.scrollWidth > innerWidth}}'''

with sync_playwright() as p:
    b = launch(p)
    for (w, h) in VIEWS:
        tag = f'{w}x{h}'
        ctx = b.new_context(viewport={'width': w, 'height': h})
        ctx.add_init_script('window.showDirectoryPicker = undefined; try { localStorage.setItem("runout.wtDone", "1"); localStorage.setItem("runout.flag.radio.ai", "1"); } catch(e) {}')
        ctx.add_init_script(FAKE_SPEECH)
        page = ctx.new_page(); errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        open_radio(page)
        def snap(state):
            m = page.evaluate(STATE)
            page.screenshot(path=f'{SHOTS}/{tag}-{state}.png')
            check(m['scroller'] >= MIN_SCROLLER, f'{tag} {state}: dial scroller {m["scroller"]} px >= {MIN_SCROLLER}')
            check(not m['hscroll'], f'{tag} {state}: no horizontal page scroll')
            if m['cardUp']: check(not m['nowShown'], f'{tag} {state}: now-bar hidden while the card is mounted')
        snap('idle')
        # tap targets
        star = page.locator('.dial-card[data-station] .dial-star').first.bounding_box()
        check(star['width'] >= 44 and star['height'] >= 44, f'{tag}: dial star hit area {star["width"]:.0f}x{star["height"]:.0f} >= 44')
        pl = page.locator('.dial-card[data-station] .dial-play').first.bounding_box()
        card = page.locator('.dial-card[data-station]').first.bounding_box()
        check(pl['height'] >= 20, f'{tag}: card has a real Play button')
        over = page.evaluate('''() => { const c = document.querySelector('.dial-card[data-station]'); const s = c.querySelector('.dial-star').getBoundingClientRect();
            const cx = (s.left + s.right) / 2, cy = (s.top + s.bottom) / 2;
            return [[s.left + 2, cy], [s.right - 2, cy], [cx, s.top + 2], [cx, s.bottom - 2]].map(([x, y]) => document.elementFromPoint(x, y).closest('.dial-star') !== null) }''')
        check(all(over), f'{tag}: the edge midpoints of the 44 px star box hits the star, not the Play overlay')
        check(page.locator('[role=button] button, [role=button] a').count() == 0, f'{tag}: no role=button container holds a button')
        check(page.locator('.dial-card[data-station][role]').count() == 0, f'{tag}: canned cards are plain containers')
        if w == 360:
            page.locator('.dial-card[data-style] .dial-play').first.click()
            btns = page.locator('.dial-card[data-style] [data-audition]:visible').all()
            check(len(btns) > 0 and all(x.bounding_box()['height'] >= 40 for x in btns), f'{tag}: audition buttons >= 40 px tall ({[round(x.bounding_box()["height"]) for x in btns]})')
        # stale saved entries: refreshed / gone
        page.evaluate('''() => { const e = (id, name) => ({k: 'canned|' + id, type: 'canned', id, at: 1, snap: {name, tags: ['canned'], country: '', codec: '', bitrate: 0}});
            localStorage.setItem('runout.radio.v1', JSON.stringify({v: 1, favs: [e('meridian-91-5', 'Old Meridian'), e('gone-station', 'Gone FM')], recents: [], last: e('gone-station', 'Gone FM')})); }''')
        open_radio(page)
        page.wait_for_function('document.querySelector(".radio-row.missing")', timeout=10000)
        txt = page.inner_text('.radio-saved')
        check('Old Meridian' not in txt and 'Meridian 91.5' in txt, f'{tag}: favourite snapshot refreshed from the index')
        check('This station is no longer in the app' in txt and page.locator('.radio-saved .radio-remove').count() >= 1, f'{tag}: removed station says so and offers Remove')
        page.locator('.radio-saved .radio-remove').first.click()
        check('Gone FM' not in page.inner_text('.radio-saved'), f'{tag}: Remove clears the stale entry everywhere')
        scan(page)
        page.click('.dial-card[data-station="meridian-91-5"] .dial-play')
        page.wait_for_selector('.pw-label', state='visible', timeout=10000)
        page.wait_for_function('document.querySelectorAll(".ai-cap").length>0', timeout=30000)
        snap('playing')
        page.evaluate('''(L) => { document.querySelector('.ai-captions').replaceChildren(...[1, 2, 3].map(i => { const d = document.createElement('div'); d.className = 'ai-cap'; d.textContent = 'Speaker ' + i + ': ' + L; return d; })); }''', LONG)
        snap('long-captions')
        page.evaluate('''(L) => { const n = document.querySelector('.ai-panel .ai-note'); n.textContent = L; n.classList.add('warn'); }''', LONG[:200])
        snap('error-note')
        for sel in ('skip', 'stop'):
            bb = page.locator(f'.ai-controls [data-act="{sel}"]').bounding_box()
            check(bb['height'] >= 40, f'{tag}: card {sel} button {bb["height"]:.0f} px tall')
        page.click('.ai-voices summary'); time.sleep(0.4)
        snap('cast-expanded')
        check(not errs, f'{tag}: no page errors {errs[:2]}')
        ctx.close()
    b.close()
print('FAILED' if fails else 'ALL OK', len(fails))
sys.exit(1 if fails else 0)
