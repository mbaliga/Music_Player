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
  * (second pass, 360x780 / 412x915 / 915x412, a MOCKED station directory) search: results come first and replace the other sections, a spinner
    while loading, "No stations found for X", an error state with Try again, a Back control, genre chips with a selected state that keep the
    typed text; every card / row has a visible Play / Stop button >= 44 px and the whole card plays it; chips, Search and the clear button >= 44 px;
    plain wording (no "Pre-written show" / "Night (any time)"); the AI switch is a role=switch; two-column cards in landscape; the playing
    card stays in view above the now-playing card
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
        time.sleep(1.0)
        pb = page.evaluate('''() => { const w = document.querySelector('#paneRadio .lib-grid-wrap').getBoundingClientRect(), bs = [...document.querySelectorAll('.radio-row.on .rr-play, .dial-card.on .dial-play[data-play]')].map((b) => b.getBoundingClientRect());
            return {inView: bs.some((r) => r.top >= w.top - 1 && r.bottom <= w.bottom + 1)} }''')
        check(pb['inView'], f'{tag}: a Stop button for the playing station stays in view above the now-playing card')
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

# ── second pass: search + cards + landscape, against a mocked station directory ──────────────────────────────────────────────────────────
STN = [{'stationuuid': f'u{i}', 'name': n, 'url_resolved': f'https://example.invalid/s{i}', 'country': c, 'codec': 'MP3', 'bitrate': 128, 'tags': t, 'votes': 100 - i, 'lastcheckok': 1}
       for i, (n, c, t) in enumerate([('Jazz FM London Smooth Classics and Evening Standards', 'United Kingdom of Great Britain', 'jazz,smooth jazz,lounge'), ('KJAZZ 88.1', 'USA', 'jazz,bebop'), ('Radio Swiss Jazz', 'Switzerland', 'jazz')])]
CORS = {'access-control-allow-origin': '*'}
def bb(page, sel): return page.locator(sel).first.bounding_box()
def tall(page, sel, what, tag, min_h=43.5):
    els = page.locator(sel).all(); hs = [e.bounding_box()['height'] for e in els if e.is_visible()]
    check(bool(hs) and min(hs) >= min_h, f'{tag}: {what} >= 44 px tall (min {min(hs) if hs else None})')
with sync_playwright() as p:
    b = launch(p)
    for (w, h) in [(360, 780), (412, 915), (915, 412)]:
        tag = f'{w}x{h} search'
        ctx = b.new_context(viewport={'width': w, 'height': h}, has_touch=True, is_mobile=True)
        ctx.add_init_script('window.showDirectoryPicker = undefined; try { localStorage.setItem("runout.wtDone", "1"); localStorage.setItem("runout.flag.radio.ai", "1"); } catch(e) {}')
        ctx.add_init_script(FAKE_SPEECH)
        mode = {'v': 'ok'}; held = []; streams = []
        def route(r):
            u = r.request.url
            if 'all.api.radio-browser' in u: return r.fulfill(status=200, content_type='application/json', body='[{"name":"de1.api.radio-browser.info"}]', headers=CORS)
            if 'stations/search' in u:
                if mode['v'] == 'hold': held.append(r); return
                if mode['v'] == 'fail': return r.abort()
                return r.fulfill(status=200, content_type='application/json', body='[]' if mode['v'] == 'none' else json.dumps(STN), headers=CORS)
            if 'example.invalid' in u: streams.append(r); return   # a stream that never answers: the station stays on "connecting"
            r.continue_()
        ctx.route('**/*', route)
        page = ctx.new_page(); errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        open_radio(page)
        page.wait_for_function('document.querySelectorAll(".lib-grid-wrap > .radio-list .radio-row").length > 0', timeout=10000)
        page.screenshot(path=f'{SHOTS}/{tag}-0-top.png')
        # plain wording, switch, tap targets
        txt = page.inner_text('#paneRadio')
        check('Pre-written show' not in txt and '(any time)' not in txt and 'Night (' not in txt, f'{tag}: no "Pre-written show" / "Night (any time)" jargon on the tab')
        sw = page.locator('#aiStationsToggle')
        check(sw.get_attribute('role') == 'switch' and 'st-switch' in sw.get_attribute('class'), f'{tag}: AI stations is the same role=switch control as Settings')
        check(sw.get_attribute('aria-checked') == 'true' and 'Off by default' in page.inner_text('#aiStationsHelp'), f'{tag}: AI switch has its plain help line ("Off by default...")')
        tall(page, '.radio-chips .sort-chip', 'genre chips', tag); tall(page, '.radio-go', 'Search button', tag); tall(page, '.dial-card[data-station] .dial-play[data-play]', 'canned card Play button', tag)
        tall(page, '.lib-grid-wrap > .radio-list .radio-row .rr-play', 'internet row Play button', tag); tall(page, '.radio-ai-sec .rr-play', 'You Radio Play button', tag); tall(page, '.radio-star', 'stars', tag)
        check('Works offline' in page.inner_text('.dial-card[data-station]'), f'{tag}: canned cards say "Works offline"')
        for sel in ('.dial-card[data-station]', '.radio-row'):
            check('Play' in page.locator(sel + ' [data-play], ' + sel + ' .rr-play').first.inner_text(), f'{tag}: {sel} has a labelled Play button')
        # two-column grid in landscape / wide
        cards = page.locator('.dial-card[data-station]').all()[:2]
        a, c2 = cards[0].bounding_box(), cards[1].bounding_box()
        if w > h: check(abs(a['y'] - c2['y']) < 4 and c2['x'] > a['x'] + a['width'] - 2, f'{tag}: landscape shows two columns of cards ({a["x"]:.0f}, {c2["x"]:.0f})')
        else: check(c2['y'] > a['y'], f'{tag}: portrait stays one column')
        # rows wrap to two lines instead of one truncated line
        r0 = page.locator('.lib-grid-wrap > .radio-list .radio-row .rr-meta').first
        check(r0.evaluate('e => getComputedStyle(e).whiteSpace') != 'nowrap' and r0.evaluate('e => e.scrollWidth <= e.clientWidth + 1'), f'{tag}: internet row metadata wraps (no one-line ellipsis)')
        ai = page.locator('.radio-ai-sec .rr-meta').first
        check(ai.evaluate('e => e.scrollHeight <= e.clientHeight + 1'), f'{tag}: You Radio text is not cut off')
        # whole card plays: tap the tagline, not the button
        page.locator('.dial-card[data-station] .dial-tag').first.scroll_into_view_if_needed(); bx = page.locator('.dial-card[data-station] .dial-tag').first.bounding_box(); page.mouse.click(bx['x'] + bx['width'] / 2, bx['y'] + bx['height'] / 2)
        page.wait_for_function('document.querySelector(".dial-card.on")', timeout=5000)
        lab = page.locator('.dial-card.on .dial-play[data-play]').inner_text()
        check('Stop' in lab and page.locator('.dial-card.on .rr-now').inner_text() != '', f'{tag}: tapping the card plays it; button reads "{lab}" with a now-playing line')
        page.locator('.radio-now .theme-btn, .ai-panel [data-act="stop"]').first.click(); time.sleep(0.6)   # (no library here, so the card shows its "scan first" note and a Retry button)
        check(page.locator('.dial-card.on').count() == 0, f'{tag}: Stop stops it')
        # internet row: whole row plays, row button stops
        page.locator('.lib-grid-wrap > .radio-list .radio-row .rr-name').first.click(); time.sleep(0.3)
        check('Stop' in page.locator('.radio-row.on .rr-play').first.inner_text(), f'{tag}: tapping an internet row plays it (button reads Stop)')
        page.locator('.radio-row.on .rr-play').first.click(); time.sleep(0.3)
        check(page.locator('.radio-row.on').count() == 0, f'{tag}: ...and its button stops it ' + ('' if page.locator('.radio-row.on').count() == 0 else page.evaluate('[...document.querySelectorAll(".radio-row.on")].map(r => r.dataset.k + "|" + r.querySelector(".rr-play").textContent + "|" + (document.querySelector(".radio-now") || {}).className).join()')))
        # search: spinner, results first, replaces the other sections
        page.fill('.radio-input', 'jazz'); mode['v'] = 'hold'
        check(page.locator('.radio-clear:visible').count() == 1, f'{tag}: a clear button appears with text')
        page.click('.radio-go'); page.wait_for_function('document.querySelector(".radio-spin")', timeout=5000)
        st = page.evaluate('() => ({mode: document.getElementById("paneRadio").dataset.mode, dial: getComputedStyle(document.querySelector(".radio-dial")).display, saved: getComputedStyle(document.querySelector(".radio-saved")).display, head: getComputedStyle(document.querySelector(".radio-res-head")).display, txt: document.querySelector(".radio-status").textContent})')
        check(st['mode'] == 'results' and st['dial'] == 'none' and st['head'] != 'none' and 'jazz' in st['txt'], f'{tag}: loading: results view up, other sections hidden, spinner + "{st["txt"]}"')
        page.screenshot(path=f'{SHOTS}/{tag}-1-loading.png')
        for _ in range(100):
            if held: break
            page.wait_for_timeout(50)
        mode['v'] = 'ok'
        for r in held: r.fulfill(status=200, content_type='application/json', body=json.dumps(STN), headers=CORS)
        page.wait_for_function('document.querySelectorAll(".lib-grid-wrap > .radio-list .radio-row").length === 3', timeout=8000)
        top = page.evaluate('() => document.querySelector(".lib-grid-wrap > .radio-list .radio-row").getBoundingClientRect().top')
        check(top < h * 0.6, f'{tag}: the first result is high on screen (y={top:.0f} of {h})')
        check('jazz' in page.inner_text('.radio-res-title') and page.locator('.radio-spin').count() == 0, f'{tag}: results titled "{page.inner_text(".radio-res-title")}"')
        page.screenshot(path=f'{SHOTS}/{tag}-2-results.png')
        # chips keep the typed text, show a selected state, and deselect
        page.locator('.radio-chips .sort-chip', has_text='rock').click(); time.sleep(0.4)
        check(page.input_value('.radio-input') == 'jazz', f'{tag}: a genre chip keeps the typed text')
        check(page.locator('.radio-chips .sort-chip.active').inner_text().strip().endswith('rock') and page.locator('.radio-chips .sort-chip[aria-pressed=true]').count() == 1, f'{tag}: the selected genre is marked')
        check('jazz' in page.inner_text('.radio-res-title') and 'rock' in page.inner_text('.radio-res-title'), f'{tag}: title says "{page.inner_text(".radio-res-title")}"')
        page.locator('.radio-chips .sort-chip', has_text='rock').click(); time.sleep(0.4)
        check(page.locator('.radio-chips .sort-chip.active').count() == 0 and page.input_value('.radio-input') == 'jazz', f'{tag}: tapping it again deselects (text kept)')
        # nothing found
        mode['v'] = 'none'; page.fill('.radio-input', 'zzzqq'); page.click('.radio-go')
        page.wait_for_function('document.querySelector(".radio-status.empty")', timeout=8000)
        check('No stations found for “zzzqq”' in page.inner_text('.radio-status'), f'{tag}: empty state names the query')
        page.screenshot(path=f'{SHOTS}/{tag}-3-none.png')
        # error
        mode['v'] = 'fail'; page.click('.radio-go')
        page.wait_for_function('document.querySelector(".radio-status.err")', timeout=15000)
        check('Try again' in page.inner_text('.radio-status') and 'Could not reach' in page.inner_text('.radio-status'), f'{tag}: error state with Try again')
        tall(page, '.radio-status .sort-chip', 'error actions', tag)
        page.screenshot(path=f'{SHOTS}/{tag}-4-error.png')
        mode['v'] = 'ok'; page.locator('.radio-status .sort-chip', has_text='Try again').click()
        page.wait_for_function('document.querySelectorAll(".lib-grid-wrap > .radio-list .radio-row").length === 3', timeout=8000)
        check(True, f'{tag}: Try again recovers')
        # back
        tall(page, '.radio-back', 'Back control', tag)
        page.click('.radio-back'); time.sleep(0.5)
        check(page.evaluate('document.getElementById("paneRadio").dataset.mode') == 'browse' and page.input_value('.radio-input') == '' and page.locator('.dial-card[data-station]').first.is_visible(), f'{tag}: Back returns to the full tab and clears the search')
        check(not errs, f'{tag}: no page errors {errs[:2]}')
        ctx.close()
    b.close()
print('FAILED' if fails else 'ALL OK', len(fails))
sys.exit(1 if fails else 0)
