#!/usr/bin/env python3
"""Verify global Search and the Settings section in Chromium (touch emulation) at 360x780 and 412x915, device scale 2.

Needs: ffmpeg, Playwright for Python, the dev server:  python3 serve.py 8321   (URL=http://localhost:8321/index.html, CHROME=/path/to/chrome)
Usage:  python3 scripts/verify-search-settings.py [outdir]     Exits non-zero when an assertion fails; screenshots go to outdir/shots.

Search: empty state + recents, results in every group (songs, albums, artists, mixtapes, radio), type chips, highlights, hostile titles
(never become markup), no results, the internet-directory row (no request until tapped; offline note), artist and album drill-downs,
keyboard (Ctrl+K, '/', arrows, Enter, Esc), back-gesture (history) close. Settings: every group, light/dark/OLED, accent live, text size,
custom theme import with the plain-text preview step, export, persistence across a reload, old keys migrated.
"""
import json, os, subprocess, sys, tempfile, time
from playwright.sync_api import sync_playwright

OUT = sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp(prefix='search-settings-')
SHOTS = os.path.join(OUT, 'shots'); os.makedirs(SHOTS, exist_ok=True)
URL = os.environ.get('URL', 'http://localhost:8321/index.html')
LIB = os.path.join(OUT, 'lib'); os.makedirs(LIB, exist_ok=True)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

SPECS = [  # title, artist, album, freq
    ('Night Walk', 'Night Ranger', 'Night Shift', 220), ('Harbor Lights', 'Mara Quill', 'Night Shift', 262),
    ('Army of Me', 'Björk', 'Post', 294), ('Hyperballad', 'Björk', 'Post', 330),
    ('東京の夜', 'ヨルシカ', '夜行', 392), ('Slow Window', 'Low Tide Orchestra', 'Tidal', 440),
    ('<img src=x onerror=window.__pwned=1>', '"><script>window.__pwned=2</script>', '<b>Hostile</b> & "Album"', 196),
]
def make_fixtures():
    for i, (t, a, al, f) in enumerate(SPECS, 1):
        out = os.path.join(LIB, f'{i:02d}.mp3')
        if os.path.exists(out): continue
        subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', f'sine=frequency={f}:duration=40:sample_rate=44100', '-metadata', f'title={t}', '-metadata', f'artist={a}',
                        '-metadata', f'album={al}', '-metadata', f'track={i}', '-c:a', 'libmp3lame', '-b:a', '64k', out], check=True)

fails = []
def check(ok, msg):
    if not ok: fails.append(msg)
    print(('ok   ' if ok else 'FAIL ') + msg, flush=True)

MIX = json.dumps({'version': 3, 'mixtapes': [{'id': 'm1', 'name': 'Night Mix', 'author': 'me', 'cfg': {'style': 'clear', 'pen': 'blue', 'wear': 0.2, 'gloss': 0.5, 'text': {'subtitle': '', 'note': '', 'side': 'A'}},
    'tracks': [{'title': 'Night Walk', 'artist': 'Night Ranger', 'album': 'Night Shift'}, {'title': 'Hyperballad', 'artist': 'Björk', 'album': 'Post'}]}]})
def snap(name, typ, id_, extra=None): return {'k': f'{typ}|{id_}', 'type': typ, 'id': id_, 'at': 1700000000000, 'snap': {'name': name, 'streamUrl': 'https://example.invalid/s', 'streamUrls': ['https://example.invalid/s'], 'country': 'UK', 'tags': ['jazz'], 'codec': 'MP3', 'bitrate': 128, **(extra or {})}}
RADIO = json.dumps({'v': 1, 'favs': [snap('Night Owl FM', 'radio-browser', 'rb:night')], 'recents': [snap('Jazz FM', 'radio-browser', 'rb:jazz')], 'last': None})

def launch(p):
    kw = {'executable_path': os.environ['CHROME']} if os.environ.get('CHROME') else {}
    return p.chromium.launch(**kw, args=['--autoplay-policy=no-user-gesture-required', '--no-sandbox'])

def boot(b, w, h, seed=True, extra_init=''):
    ctx = b.new_context(bypass_csp=True, viewport={'width': w, 'height': h}, device_scale_factor=2, has_touch=True, is_mobile=True)
    init = 'window.showDirectoryPicker = undefined; if (!sessionStorage.getItem("seeded")) { sessionStorage.setItem("seeded", "1"); try { localStorage.setItem("runout.wtDone", "1");'
    if seed: init += f' localStorage.setItem("runout.mixtapes", {json.dumps(MIX)}); localStorage.setItem("runout.radio.v1", {json.dumps(RADIO)});'
    init += ' } catch (e) {} }' + extra_init
    ctx.add_init_script(init)
    page = ctx.new_page(); errs = []; reqs = []
    page.on('pageerror', lambda e: errs.append(str(e)))
    page.on('console', lambda m: errs.append('console:' + m.text) if m.type == 'error' and '404' not in m.text and 'ERR_' not in m.text and 'stations/index' not in m.text else None)
    page.on('request', lambda r: reqs.append(r.url))
    page.goto(URL)
    page.wait_for_function('document.getElementById("latency") && !/boot error/.test(document.getElementById("latency").textContent)')
    page.wait_for_timeout(700)
    return ctx, page, errs, reqs

def cur(page): return page.evaluate('document.querySelector(".page:not([hidden])").dataset.section')
def open_drawer(page): page.click('.page:not([hidden]) .hamburger'); page.wait_for_timeout(650)
def goto(page, sec):
    if cur(page) == sec: return
    open_drawer(page); page.click(f'.drawer-item[data-section="{sec}"]')
    page.wait_for_function('s => { const p = document.querySelector(`.page[data-section="${s}"]`); return p && !p.hidden }', arg=sec); page.wait_for_timeout(600)
def ov_open(page): return page.evaluate('!!document.querySelector(".search-ov:not(.hidden)")')
def rows(page): return page.evaluate('[...document.querySelectorAll(".search-ov .so-row")].map(r => ({type: r.dataset.type, title: r.querySelector(".so-t").textContent, sel: r.getAttribute("aria-selected")}))')
def type_q(page, q):
    page.fill('.so-input', q); page.wait_for_timeout(200)

def run_viewport(b, w, h):
    tag = f'{w}x{h}'
    print(f'--- {tag}')
    ctx, page, errs, reqs = boot(b, w, h)
    shot = lambda n: page.screenshot(path=f'{SHOTS}/{tag}-{n}.png')

    def sdet(name, open_=True): page.evaluate(f'document.querySelector(\'.st-group[data-group="{name}"]\').open = {str(open_).lower()}')
    # ── fill the library from the Settings page (the folder-picker scan)
    goto(page, 'settings')
    page.wait_for_selector('.st-page'); sdet('library')
    with page.expect_file_chooser() as fc:
        page.click('.st-group[data-group="library"] .st-btn.primary')
    fc.value.set_files(LIB)
    page.wait_for_function('document.querySelectorAll(".tl-row, .tl-track, [class*=tl-]").length > 0', timeout=15000)
    page.wait_for_timeout(2500)

    # ── the drawer: search button + Settings item
    goto(page, 'albums'); open_drawer(page)
    check(page.locator('#btnSearch').is_visible(), f'{tag}: drawer shows the search button')
    check(page.locator('.drawer-item[data-section="settings"] .drawer-glyph svg').count() == 1, f'{tag}: Settings item has a gear glyph')
    check(page.evaluate('[...document.querySelectorAll(".drawer-item")].map(b => b.dataset.section).join()') == 'albums,mixtapes,radio,booth,settings', f'{tag}: menu = Albums, Mixtapes, Radio, Booth, Settings')
    check(page.evaluate('document.getElementById("btnSettings") === null'), f'{tag}: the old gear popover button is gone')
    shot('drawer')
    bb = page.evaluate('(() => { const r = document.getElementById("btnSearch").getBoundingClientRect(); return [r.width, r.height, r.right, innerWidth]; })()')
    check(bb[0] >= 44 and bb[1] >= 44 and bb[2] <= bb[3], f'{tag}: search button >= 44 px and inside the screen ({bb[0]:.0f}x{bb[1]:.0f})')

    # ── open Search from the drawer
    page.click('#btnSearch'); page.wait_for_selector('.search-ov:not(.hidden)'); page.wait_for_timeout(500)
    check(page.evaluate('document.activeElement && document.activeElement.classList.contains("so-input")'), f'{tag}: the field has focus')
    check(page.evaluate('document.getElementById("shell").dataset.open') == 'false', f'{tag}: the drawer closed behind the overlay')
    check(page.get_attribute('.so-input', 'role') == 'combobox' and page.get_attribute('#so-list', 'role') == 'listbox', f'{tag}: combobox + listbox roles')
    shot('search-empty')
    check('Try an artist, album or song' in page.inner_text('.so-body') and 'type:' not in page.inner_text('.so-body'), f'{tag}: the empty-search tip is plain words, no query syntax')
    ph = page.evaluate('''() => { const i = document.querySelector(".so-input"); const c = document.createElement("canvas").getContext("2d"); const cs = getComputedStyle(i); c.font = cs.fontWeight + " " + cs.fontSize + " " + cs.fontFamily;
        return {text: i.placeholder, textW: c.measureText(i.placeholder).width, boxW: i.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)}; }''')
    check(ph['text'] == 'Search your music and radio' and ph['textW'] <= ph['boxW'], f'{tag}: the placeholder "{ph["text"]}" fits its field ({ph["textW"]:.0f} <= {ph["boxW"]:.0f} px)')
    ch = page.evaluate('''() => { const card = document.querySelector(".so-card").getBoundingClientRect(); const bs = [...document.querySelectorAll(".so-chips .so-chip")].map((b) => b.getBoundingClientRect());
        return {n: bs.length, inside: bs.every((r) => r.left >= card.left - 0.5 && r.right <= card.right + 0.5), minH: Math.min(...bs.map((r) => r.height))}; }''')
    check(ch['n'] >= 5 and ch['inside'] and ch['minH'] >= 43.5, f'{tag}: all {ch["n"]} filter chips are on screen (wrapped, none scrolled off) and >= 44 px tall')
    n_dir = len([u for u in reqs if 'radio-browser' in u])
    # ── typing: every group
    type_q(page, 'night')
    r = rows(page); types = {x['type'] for x in r}
    check(types >= {'song', 'album', 'artist', 'mixtape', 'station'}, f'{tag}: "night" finds every kind: {sorted(types)}')
    check(page.locator('.so-sec').count() >= 5 and page.locator('.so-sec-n').first.inner_text().isdigit(), f'{tag}: section headers with counts')
    check(page.locator('.search-ov mark').count() >= 3, f'{tag}: matches are highlighted ({page.locator(".search-ov mark").count()} marks)')
    heights = page.evaluate('[...document.querySelectorAll(".so-row")].map(r => r.getBoundingClientRect().height)')
    check(min(heights) >= 44, f'{tag}: rows are >= 44 px tall (min {min(heights):.0f})')
    check(len([u for u in reqs if 'radio-browser' in u]) == n_dir, f'{tag}: no directory request while typing')
    check(page.locator('.so-dirbtn').count() == 0, f'{tag}: a local-results query does not push the radio directory row (UX review)')
    type_q(page, 'night radio')
    check(page.locator('.so-dirbtn').count() == 1 and 'Search the internet radio directory for' in page.inner_text('.so-dirbtn'), f'{tag}: a radio-like query offers the explicit directory row at the bottom')
    type_q(page, 'night')
    shot('search-results-all-groups')
    # chips
    page.click('.so-chip[data-chip="songs"]'); page.wait_for_timeout(200)
    check({x['type'] for x in rows(page)} == {'song'}, f'{tag}: Songs chip shows only songs')
    shot('search-chip-songs')
    page.click('.so-chip[data-chip="stations"]'); page.wait_for_timeout(200)
    check({x['type'] for x in rows(page)} == {'station'}, f'{tag}: Radio chip shows only stations')
    page.click('.so-chip[data-chip="all"]'); page.wait_for_timeout(200)
    # diacritics + CJK
    type_q(page, 'bjork'); r = rows(page)
    check(any(x['type'] == 'artist' and x['title'] == 'Björk' for x in r) and any(x['title'] == 'Hyperballad' for x in r), f'{tag}: "bjork" finds Björk')
    type_q(page, '東京'); check(any(x['title'] == '東京の夜' for x in rows(page)), f'{tag}: CJK substring match')
    type_q(page, 'hyperbalad'); check(any(x['title'] == 'Hyperballad' for x in rows(page)), f'{tag}: one-letter typo still finds Hyperballad')
    # hostile titles
    type_q(page, 'onerror'); page.wait_for_timeout(200)
    check(any('<img' in x['title'] for x in rows(page)), f'{tag}: the hostile title is listed as plain text')
    check(page.evaluate('window.__pwned === undefined') and page.locator('.search-ov img').count() == 0 and page.locator('.search-ov script').count() == 0, f'{tag}: hostile titles never become markup')
    shot('search-hostile')
    type_q(page, 'hostile'); shot('search-hostile-album')
    # no results
    type_q(page, 'zzzqqq'); check('Nothing matches' in page.inner_text('.so-body') and page.locator('.so-dirbtn').count() == 1, f'{tag}: empty state + directory row still offered')
    shot('search-no-results')
    # directory: offline -> plain note and no request
    before = len([u for u in reqs if 'radio-browser' in u])
    ctx.set_offline(True); page.evaluate('Object.defineProperty(navigator, "onLine", { value: false, configurable: true })')
    page.click('.so-dirbtn'); page.wait_for_timeout(500)
    check('offline' in page.inner_text('.so-body').lower(), f'{tag}: offline note shown ("{page.inner_text(".so-note")[:60]}")')
    check(len([u for u in reqs if 'radio-browser' in u]) == before, f'{tag}: offline tap made no network request')
    shot('search-directory-offline')
    ctx.set_offline(False); page.evaluate('Object.defineProperty(navigator, "onLine", { value: true, configurable: true })')
    # drill: artist
    type_q(page, 'night ranger'); page.click('.so-row[data-type="artist"]'); page.wait_for_timeout(400)
    check(page.locator('.so-drill-title b').inner_text() == 'Night Ranger' and page.locator('.so-act.primary').inner_text() == 'Play all', f'{tag}: artist drill-down with Play all')
    check(page.locator('.so-row[data-type="album"]').count() >= 1 and page.locator('.so-row[data-type="song"]').count() >= 1, f'{tag}: artist drill lists albums and songs')
    shot('search-drill-artist')
    page.click('.so-back'); page.wait_for_timeout(300)
    check(ov_open(page) and page.locator('.so-drill-title:not([hidden])').count() == 0, f'{tag}: back returns to results')
    page.click('.so-row[data-type="album"]'); page.wait_for_timeout(400)
    check(page.locator('.so-act.primary').inner_text() == 'Play album' and page.locator('.so-row[data-type="song"]').count() >= 1, f'{tag}: album drill: Play album + songs')
    check(page.locator('.so-act:has-text("Add to mixtape")').count() == 1, f'{tag}: album drill offers Add to mixtape (bound by the mixtape creator)')
    shot('search-drill-album')
    # recents after an activation
    page.keyboard.press('Escape'); page.wait_for_timeout(200)     # back from the drill
    check(ov_open(page), f'{tag}: Esc inside a drill goes back first')
    # keyboard: arrows + Enter on the radio row? use Down/Up then Esc closes
    type_q(page, 'night'); page.keyboard.press('ArrowDown'); page.keyboard.press('ArrowDown')
    sel = [x for x in rows(page) if x['sel'] == 'true']
    check(len(sel) == 1 and page.evaluate('document.querySelector(".so-input").getAttribute("aria-activedescendant")') == page.evaluate('document.querySelector(".so-row[aria-selected=true]").id'), f'{tag}: arrows move the active row + aria-activedescendant')
    page.keyboard.press('Escape'); page.wait_for_timeout(300)
    check(not ov_open(page), f'{tag}: Esc closes')
    # shortcuts
    page.keyboard.press('Control+k'); page.wait_for_timeout(400); check(ov_open(page), f'{tag}: Ctrl+K opens')
    page.keyboard.press('Escape'); page.wait_for_timeout(300)
    page.keyboard.press('/'); page.wait_for_timeout(400); check(ov_open(page), f'{tag}: "/" opens')
    check(page.input_value('.so-input') == '', f'{tag}: "/" is not typed into the field')
    # recents are remembered (play a song via Enter)
    type_q(page, 'army of me'); page.keyboard.press('Enter'); page.wait_for_timeout(1800)
    check(not ov_open(page), f'{tag}: activating a song closes the overlay and plays it')
    check(cur(page) == 'albums', f'{tag}: playing a song goes to Albums')
    page.keyboard.press('Control+k'); page.wait_for_timeout(500)
    check('army of me' in page.inner_text('.so-body').lower() and 'recent searches' in page.inner_text('.so-body').lower(), f'{tag}: recent search remembered')
    shot('search-recents')
    # history/back closes
    page.go_back(); page.wait_for_timeout(500)
    check(not ov_open(page), f'{tag}: the browser/Android back closes the overlay')
    # header search button on another section
    goto(page, 'mixtapes'); page.click('.page:not([hidden]) .page-search'); page.wait_for_timeout(400)
    check(ov_open(page), f'{tag}: every page header has a search button')
    type_q(page, 'night mix'); page.click('.so-row[data-type="mixtape"]'); page.wait_for_timeout(1500)
    check(not ov_open(page), f'{tag}: opening a mixtape closes the overlay')
    shot('mixtape-opened-from-search')
    check(not errs, f'{tag}: no page errors {errs[:3]}')

    # ───────────────── Settings
    errs.clear()
    page.reload(); page.wait_for_function('document.getElementById("latency") && !/boot error/.test(document.getElementById("latency").textContent)'); page.wait_for_timeout(700)
    goto(page, 'settings')
    page.wait_for_selector('.st-page'); page.wait_for_timeout(400)
    check(page.locator('.st-group').count() == 7, f'{tag}: seven groups')
    groups = page.evaluate('[...document.querySelectorAll(".st-group > summary")].map(s => s.firstChild.textContent)')
    check(groups == ['Appearance', 'Library', 'Playback', 'Radio', 'Booth', 'Device mode', 'Privacy & about'], f'{tag}: groups {groups}')
    shot('settings-appearance')
    # theme
    page.click('.st-seg[aria-label="Theme"] [data-v="light"]'); page.wait_for_timeout(300)
    check(page.evaluate('document.documentElement.dataset.theme') == 'light', f'{tag}: Light applies')
    check(page.evaluate('localStorage.getItem("runout.theme")') == 'light', f'{tag}: old key mirrored (runout.theme=light)')
    shot('settings-light')
    page.click('.st-seg[aria-label="Theme"] [data-v="dark"]'); page.wait_for_timeout(300)
    check(page.evaluate('document.documentElement.dataset.tone') == 'soft' and page.evaluate('getComputedStyle(document.documentElement).getPropertyValue("--bg").trim()') in ('', '#14141a') or page.evaluate('getComputedStyle(document.body).backgroundColor') == 'rgb(20, 20, 26)', f'{tag}: Dark = soft tone')
    shot('settings-dark-soft')
    page.click('.st-seg[aria-label="Theme"] [data-v="oled"]'); page.wait_for_timeout(300)
    check(page.evaluate('getComputedStyle(document.body).backgroundColor') == 'rgb(0, 0, 0)', f'{tag}: OLED black = pure black')
    # accent live
    page.click('.st-sw[data-id="orange"]'); page.wait_for_timeout(300)
    check(page.evaluate('getComputedStyle(document.documentElement).getPropertyValue("--violet").trim().toUpperCase()') == '#FE5031', f'{tag}: accent orange applied live')
    check(page.evaluate('getComputedStyle(document.querySelector(".st-pv-chip")).backgroundColor') == 'rgb(254, 80, 49)', f'{tag}: preview card follows the accent')
    shot('settings-accent-orange')
    page.fill('.st-hex', '#12ab9c'); page.wait_for_timeout(200)
    check(page.evaluate('getComputedStyle(document.documentElement).getPropertyValue("--violet").trim().toLowerCase()') == '#12ab9c', f'{tag}: custom hex accent applies')
    page.fill('.st-hex', '#12ab'); page.wait_for_timeout(100)
    check(page.get_attribute('.st-hex', 'aria-invalid') == 'true', f'{tag}: invalid hex flagged, accent unchanged')
    page.click('.st-sw[data-id="violet"]')
    # text size
    page.click('.st-seg[aria-label="Text size"] [data-v="large"]'); page.wait_for_timeout(300)
    check(page.evaluate('document.documentElement.dataset.text') == 'large' and page.evaluate('getComputedStyle(document.querySelector(".st-page")).zoom') in ('1.14', '1.14000'), f'{tag}: large text size')
    shot('settings-text-large'); page.click('.st-seg[aria-label="Text size"] [data-v="default"]')
    page.click('.st-seg[aria-label="Motion"] [data-v="reduce"]'); check(page.evaluate('document.documentElement.dataset.motion') == 'reduce' and page.evaluate('matchMedia("(prefers-reduced-motion: reduce)").matches'), f'{tag}: reduce motion override')
    page.click('.st-seg[aria-label="Motion"] [data-v="system"]')
    # custom theme import with preview
    page.click('.st-btn:has-text("Import JSON")'); page.wait_for_selector('#themeOverlay:not(.hidden)')
    theme = json.dumps({'version': 1, 'name': 'Verify Blue', 'colors': {m: {'primary': '#3366FF', 'secondary': '#33AAFF', 'tertiary': '#33FFAA', 'background': '#101828' if m == 'dark' else '#EEF2FF', 'surface': '#182236' if m == 'dark' else '#FFFFFF', 'surfaceVariant': '#22304A' if m == 'dark' else '#DDE5FF', 'onBackground': '#F0F4FF' if m == 'dark' else '#101828', 'onSurface': '#F0F4FF' if m == 'dark' else '#101828'} for m in ('dark', 'light')}}, indent=2)
    page.fill('#themeInput', theme); page.click('#themePreviewBtn'); page.wait_for_timeout(200)
    check(page.inner_text('#themePreviewText') == theme and page.locator('#themeApplyBtn').is_enabled(), f'{tag}: preview shows the exact pasted text, Apply enabled')
    shot('settings-theme-preview')
    page.click('#themeBack'); page.fill('#themeInput', '{"version": 1, "name": "bad"}'); page.click('#themePreviewBtn')
    check(page.locator('#themeApplyBtn').is_disabled() and 'colors' in page.inner_text('#themeError'), f'{tag}: a malformed theme cannot be applied ({page.inner_text("#themeError")[:50]})')
    page.click('#themeBack'); page.fill('#themeInput', theme); page.click('#themePreviewBtn'); page.click('#themeApplyBtn'); page.wait_for_timeout(400)
    check(page.evaluate('getComputedStyle(document.documentElement).getPropertyValue("--bg").trim()') in ('#101828', 'rgb(16, 24, 40)') and 'Verify Blue' in page.inner_text('.st-group[data-group="appearance"]'), f'{tag}: custom theme applied, status shows its name')
    shot('settings-custom-theme')
    page.click('.st-btn:has-text("Export")'); check(json.loads(page.inner_text('.st-pre'))['name'] == 'Verify Blue', f'{tag}: Export shows the theme JSON')
    page.reload(); page.wait_for_function('document.getElementById("latency") && !/boot error/.test(document.getElementById("latency").textContent)'); page.wait_for_timeout(700)
    check(page.evaluate('getComputedStyle(document.documentElement).getPropertyValue("--bg").trim()') in ('#101828', 'rgb(16, 24, 40)'), f'{tag}: custom theme survives a reload')
    goto(page, 'settings'); page.click('.st-btn:has-text("Reset")'); page.wait_for_timeout(300)
    check(page.evaluate('document.documentElement.style.getPropertyValue("--bg")') == '', f'{tag}: reset returns to the built-in palette')
    # other groups
    for g in ('library', 'playback', 'radio', 'booth', 'device-mode', 'privacy-about'):
        sdet('appearance', False); sdet(g); page.wait_for_timeout(250)
        page.evaluate(f'document.querySelector(\'.st-group[data-group="{g}"]\').scrollIntoView()'); page.wait_for_timeout(150); shot('settings-' + g)
    # plain user-facing copy: no file names, no docs-style sentences; Theme explains that the player surfaces stay dark; native controls are gone
    for g in ('appearance', 'library', 'playback', 'radio', 'booth', 'device-mode', 'privacy-about'): sdet(g)
    alltxt = page.evaluate('document.querySelector(".st-page").innerText')
    bad = [w_ for w_ in ['.md', 'docs/', 'AI stations backend', 'folder picker scan', 'stay in Deck details', 'Advanced:', 'JSON;'] if w_.lower() in alltxt.lower()]
    check(not bad, f'{tag}: Settings copy has no file names or docs-style phrases ({bad})')
    check('Player surfaces stay dark' in alltxt, f'{tag}: Settings says that player surfaces stay dark')
    pa = page.evaluate('document.querySelector(".st-group[data-group=\\"privacy-about\\"]").innerText')
    check('Version' in pa and 'Stays on this phone' in pa and 'internet is used only when you ask' in pa, f'{tag}: Privacy & about says what stays on the phone, what the network is for, and the version')
    check(page.evaluate('document.querySelectorAll(".st-page input[type=checkbox], .st-page select").length') == 0, f'{tag}: no native checkboxes or selects on the Settings page')
    smallc = page.evaluate('[...document.querySelectorAll(".st-page summary, .st-page button, .st-page .st-sw")].filter(b => b.getBoundingClientRect().width > 0 && (b.getBoundingClientRect().height < 44 || b.getBoundingClientRect().width < 44)).map(b => b.className + ":" + Math.round(b.getBoundingClientRect().width) + "x" + Math.round(b.getBoundingClientRect().height))')
    check(not smallc, f'{tag}: every Settings control is at least 44x44 ({smallc})')
    for g in ('library', 'playback', 'radio', 'booth', 'device-mode', 'privacy-about'): sdet(g, False)
    sdet('radio'); page.click('.st-group[data-group="radio"] .st-switch'); page.wait_for_timeout(300)
    check(page.evaluate('localStorage.getItem("runout.flag.radio.ai")') == '1', f'{tag}: the You Radio toggle writes the existing radio.ai flag')
    page.click('.st-group[data-group="radio"] .st-switch')
    check(page.evaluate('localStorage.getItem("runout.flag.radio.ai")') is None, f'{tag}: ...and removes it again')
    sdet('privacy-about'); page.click('.st-group[data-group="privacy-about"] .st-switch'); page.wait_for_timeout(200)
    check(page.evaluate('JSON.parse(localStorage.getItem("runout.settings.v1")).privacy.rememberSearches') is False, f'{tag}: "remember searches" off persists')
    page.click('.st-group[data-group="privacy-about"] .st-switch')
    check(page.evaluate('localStorage.getItem("runout.settings.v1") !== null'), f'{tag}: settings blob stored')
    check(not errs, f'{tag}: no page errors in Settings {errs[:3]}')
    check(page.evaluate('document.documentElement.scrollWidth <= innerWidth'), f'{tag}: no horizontal scroll')
    ctx.close()

    # ── migration: old keys only
    ctx, page, errs, reqs = boot(b, w, h, seed=False, extra_init=' localStorage.setItem("runout.theme","light"); localStorage.setItem("runout.flag.radio.ai","1");')
    check(page.evaluate('document.documentElement.dataset.theme') == 'light', f'{tag}: old runout.theme=light is honoured on first run')
    check(page.evaluate('JSON.parse(localStorage.getItem("runout.settings.v1")).radio.aiStations') is True, f'{tag}: old radio.ai flag migrated into the settings blob')
    ctx.close()

make_fixtures()
with sync_playwright() as p:
    b = launch(p)
    for (w, h) in [(360, 780), (412, 915)]: run_viewport(b, w, h)
    b.close()
print('\nFAILURES: ' + str(len(fails))); [print(' -', f) for f in fails]
sys.exit(1 if fails else 0)
