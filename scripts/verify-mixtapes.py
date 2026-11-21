#!/usr/bin/env python3
"""Verify the Mixtapes section (workstream D): the v4 editor (search / caps / sides / reorder / style / save), the shelf, the cassette
player's sides + AUTO + FLIP with REAL audio, persistence, and a 5,000-track picker.

Needs: ffmpeg, Playwright for Python, the dev server:  python3 serve.py 8321   (URL=http://localhost:8537/index.html)
Usage:  python3 scripts/verify-mixtapes.py [outdir]     Exits non-zero when an assertion fails; screenshots go to outdir/shots.
Set CHROME=/path/to/chrome when Playwright's own browser revision is not installed (e.g. /opt/pw-browsers/chromium-1243/chrome-linux64/chrome).

It generates a tagged FLAC library (flac carries durations, so the caps are exact): three albums of ~3-4 minute songs and a 'Short' album of
7 second songs (so the end of a side can really be reached), scans it through the folder-input fallback and drives the real UI at 360x780 and
412x915 with touch emulation.
NOT a substitute for the on-device checks (drag-reorder feel, flip animation frame rate, 5k-track scrolling, haptics, the Android WebView).
"""
import json, os, subprocess, sys, time
from playwright.sync_api import sync_playwright

OUT = sys.argv[1] if len(sys.argv) > 1 else '/tmp/mixtapes-verify'
SHOTS = os.path.join(OUT, 'shots'); os.makedirs(SHOTS, exist_ok=True)
LIB = os.path.join(OUT, 'lib')
URL = os.environ.get('URL', 'http://localhost:8537/index.html')

ALBUMS = [  # folder, album, artist, genre, year, [(title, seconds, hz)]
    ('Night Shift', 'Night Shift', 'Mara Quill', 'Jazz', 1994, [('Harbor Lights', 215, 220), ('Paper Moon', 232, 262), ('Slow Window', 198, 294), ('Copper Rain', 241, 330)]),
    ('Tidal', 'Tidal', 'Low Tide Orchestra', 'Jazz', 1995, [('Salt and Ember', 205, 392), ('Glass Hours', 223, 440), ('Low Water', 187, 196)]),
    ('Orchard Hum', 'Orchard Hum', 'Sigur Rós', 'Electronic', 2011, [('Hoppípolla', 268, 247), ('Static Orchard', 211, 277), ('Glósóli', 252, 311), ('Café del Mar', 190, 370), ('Maze Garden', 201, 233)]),
    ('Short', 'Short Cuts', 'Tiny Tapes', 'Rock', 1988, [('Blip One', 7, 300), ('Blip Two', 7, 340), ('Blip Three', 7, 380), ('Blip Four', 7, 420)]),
]

def make_fixtures():
    for (folder, album, artist, genre, year, tracks) in ALBUMS:
        d = os.path.join(LIB, folder); os.makedirs(d, exist_ok=True)
        for i, (title, sec, f) in enumerate(tracks, 1):
            out = os.path.join(d, f'{i:02d} - {title.replace(" ", "_")}.flac')
            if os.path.exists(out): continue
            subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', f'sine=frequency={f}:duration={sec}:sample_rate=44100', '-af', 'volume=0.4', '-ac', '2',
                            '-metadata', f'title={title}', '-metadata', f'artist={artist}', '-metadata', f'album={album}', '-metadata', f'genre={genre}', '-metadata', f'date={year}',
                            '-metadata', f'track={i}', '-compression_level', '5', out], check=True)

BUS_HOOK = """
(() => {
  const orig = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function(dest, ...r){
    try {
      if (!window.__bus && this instanceof GainNode && dest && dest.constructor && dest.constructor.name === 'AudioDestinationNode') {
        window.__bus = this;
        const ctx = this.context; const an = ctx.createAnalyser(); an.fftSize = 2048; orig.call(this, an); window.__an = an;
      }
    } catch(e) {}
    return orig.call(this, dest, ...r);
  };
  window.__rms = () => { const an = window.__an; if(!an) return -1; const b = new Float32Array(an.fftSize); an.getFloatTimeDomainData(b); let s=0; for (const x of b) s+=x*x; return Math.sqrt(s/b.length); };
})();
"""

fails = []
def check(ok, msg):
    if not ok: fails.append(msg)
    print(('ok   ' if ok else 'FAIL ') + msg, flush=True)

def launch(p):
    kw = {'executable_path': os.environ['CHROME']} if os.environ.get('CHROME') else {}
    if not kw and os.path.exists('/opt/pw-browsers/chromium-1243/chrome-linux64/chrome'): kw = {'executable_path': '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome'}
    return p.chromium.launch(**kw, args=['--autoplay-policy=no-user-gesture-required', '--no-sandbox'])

def boot(b, w, h, blob=None, reduced=False):
    ctx = b.new_context(viewport={'width': w, 'height': h}, device_scale_factor=2, has_touch=True, is_mobile=True, reduced_motion='reduce' if reduced else 'no-preference')
    init = 'window.showDirectoryPicker = undefined; try { localStorage.setItem("runout.wtDone", "1");'
    if blob: init += f' if (!localStorage.getItem("runout.mixtapes")) localStorage.setItem("runout.mixtapes", {json.dumps(json.dumps(blob))});'
    init += ' } catch (e) {}'
    ctx.add_init_script(init); ctx.add_init_script(BUS_HOOK)
    page = ctx.new_page(); errs = []
    page.on('pageerror', lambda e: errs.append(str(e)))
    page.on('console', lambda m: errs.append('console:' + m.text) if m.type == 'error' and 'stations/index.json' not in m.text and '404' not in m.text else None)
    page.goto(URL)
    page.wait_for_function('document.getElementById("latency") && !/boot error/.test(document.getElementById("latency").textContent)')
    page.wait_for_timeout(500)
    return ctx, page, errs

def to_section(page, sec):
    if page.evaluate('document.querySelector(".page:not([hidden])").dataset.section') == sec: return
    page.click('.page:not([hidden]) .hamburger')
    page.click(f'.drawer-item[data-section="{sec}"]')
    page.wait_for_function('s => { const p = document.querySelector(`.page[data-section="${s}"]`); return p && !p.hidden }', arg=sec)
    time.sleep(0.6)

def scan(page):
    """Scan the generated folder through Settings > Library (the folder-input fallback: no File System Access in this browser)."""
    to_section(page, 'settings'); page.wait_for_selector('.st-page')
    page.evaluate('document.querySelector(\'.st-group[data-group="library"]\').open = true')
    with page.expect_file_chooser() as fc:
        page.click('.st-group[data-group="library"] .st-btn.primary')
    fc.value.set_files(LIB)
    page.wait_for_timeout(5000)

def blob_v3_old():
    return {'version': 3, 'mixtapes': [{'id': 'old1', 'name': 'Old Road Trip', 'author': 'me', 'cfg': {'style': 'brass', 'pen': 'marker', 'wear': 0.2, 'gloss': 0.5, 'text': {'subtitle': 'v3 tape', 'note': '', 'side': 'A'}},
        'tracks': [{'title': 'Harbor Lights', 'artist': 'Mara Quill', 'album': 'Night Shift'}, {'title': 'Salt and Ember', 'artist': 'Low Tide Orchestra', 'album': 'Tidal'}]}]}

def stored(page):
    return json.loads(page.evaluate('localStorage.getItem("runout.mixtapes")') or 'null')

def toast_text(page):
    page.wait_for_selector('.ed-toast:not(.hidden)', timeout=3000)
    whole = page.inner_text('.ed-toast')
    if 'null' in whole or 'undefined' in whole: fails.append('a toast printed a stray null/undefined: ' + whole)
    return page.inner_text('.ed-toast span')

def search(page, text):
    page.fill('.pk-q', text); page.wait_for_timeout(350)

def add_search_result(page, title):
    search(page, title)
    page.locator('.pk-rowbtn', has_text=title).first.tap(); page.wait_for_timeout(250)

def gauges(page):
    return page.eval_on_selector_all('.ed-gauge', 'els => els.map(e => e.innerText.replace(/\\n+/g, " | "))')

def deck_playing(page):
    """The deck's PLAY key is latched down while the tape is really playing (the analyser keeps its last block when idle, so rms is only trusted while playing)."""
    return page.evaluate("document.querySelector('.sk-deck .key[data-key=play]').classList.contains('down')")

def side_state(page):
    """-> (side letter lit, auto engaged) from whichever skin is mounted."""
    return page.evaluate("""() => {
      const deck = document.querySelector('.sk-deck .side-panel');
      if (deck) { const lit = [...deck.querySelectorAll('text[data-side]')].find(t => t.getAttribute('fill') === '#ffb347');
        return [lit ? lit.getAttribute('data-side') : '', document.querySelector('.sk-deck .side-key[data-key=auto]').classList.contains('down')]; }
      const a = document.querySelector('.sk-player [aria-label^="Auto-reverse"]'), l = document.querySelector('.sk-player [id$="sideLetter"]');
      return [l ? l.textContent : '', !!a && a.classList.contains('down')]; }""")

def run_viewport(b, w, h):
    tag = f'{w}x{h}'
    print(f'--- {tag}', flush=True)
    shot = lambda page, name: page.screenshot(path=f'{SHOTS}/{tag}-{name}.png')
    ctx, page, errs = boot(b, w, h, blob_v3_old())
    scan(page)
    to_section(page, 'mixtapes'); page.wait_for_timeout(600)

    # ── migration: a v3 tape is shown, with its tape length and counts on the strip
    check(page.locator('.cs-card').count() == 1, f'{tag}: the v3 tape is on the shelf')
    meta = page.inner_text('.cs-meta')
    check(meta.startswith('C60') and 'A 2' in meta and 'B 0' in meta, f'{tag}: strip shows tape + side counts ({meta})')
    check(page.locator('.mt-sug').count() == 1, f'{tag}: the Suggested tapes row is on the page')
    names = page.eval_on_selector_all('.mt-sug-open b', 'els => els.map(e => e.textContent)')
    print('     suggestions:', names)
    check(len(names) >= 2, f'{tag}: at least two suggested tapes from the library ({names})')
    shot(page, 'shelf-with-suggestions')

    # ── a suggestion opens a DRAFT in the editor; nothing is saved until Save
    page.locator('.mt-sug-create').first.tap(); page.wait_for_selector('.ed'); page.wait_for_timeout(500)
    before = len(stored(page)['mixtapes'])
    check(page.locator('.tk-row').count() >= 5, f'{tag}: the suggestion is pre-filled ({page.locator(".tk-row").count()} songs on side A)')
    shot(page, 'editor-suggestion-draft')
    page.click('#ed-back'); page.wait_for_selector('.ed-warn'); page.click('.ed-warn .dc'); page.wait_for_timeout(300)
    check(len(stored(page)['mixtapes']) == before, f'{tag}: discarding a suggested draft saves nothing')
    page.locator('.mt-sug-x').first.tap(); page.wait_for_timeout(300)
    check(page.locator('.mt-sug-open').count() == len(names) - 1, f'{tag}: a suggestion can be dismissed')

    # ── create a tape end to end
    page.tap('#mtNew'); page.wait_for_selector('.ed'); page.wait_for_timeout(500)
    shot(page, 'editor-tape-tab')
    check('null' not in page.inner_text('.ed-panel') and 'undefined' not in page.inner_text('.ed-panel'), f'{tag}: no stray "null" text in the Tape tab')
    page.fill('.ed-tape-tab input[aria-label="Title"]', 'Café Road <b>Mix</b>')
    page.fill('.ed-tape-tab input[aria-label="Line on the label"]', 'for the long way home')
    page.fill('.ed-tape-tab input[aria-label="Made by"]', 'Madhav')
    page.locator('.ed-len', has_text='C30').tap(); page.wait_for_timeout(200)
    check('C30' in page.inner_text('.ed-caps') and '15:00' in page.inner_text('.ed-caps'), f'{tag}: C30 caps text states 15:00 per side')
    g = gauges(page); check('0:00 / 15:00' in g[0] and '0:00 / 15:00' in g[1], f'{tag}: gauges start empty ({g})')
    page.tap('#edtab-add'); page.wait_for_timeout(500)
    shot(page, 'editor-add-browse')
    check(page.locator('.pk-alb').count() >= 4, f'{tag}: browse by album lists the albums ({page.locator(".pk-alb").count()})')
    # search is diacritic-insensitive and grouped by album
    search(page, 'sigur ros')
    check(page.locator('.pk-alb').count() == 1 and page.locator('.pk-row').count() == 5, f'{tag}: "sigur ros" finds Sigur Rós across diacritics, grouped under its album')
    search(page, 'cafe')
    check(page.locator('.pk-rowbtn', has_text='Café del Mar').count() == 1, f'{tag}: "cafe" finds "Café del Mar"')
    shot(page, 'editor-add-search')
    # three different albums: Night Shift (4 songs = 14:46 fits C30 side A), then a fifth song is refused
    search(page, 'night shift')
    page.locator('.pk-addall').first.tap(); page.wait_for_timeout(300)
    t = toast_text(page); check('Added 4 songs to side A' in t, f'{tag}: add whole album -> {t}')
    g = gauges(page); check('14:46 / 15:00' in g[0], f'{tag}: gauge A after the album ({g[0]})')
    add_search_result(page, 'Glass Hours')
    t = toast_text(page); check(t == 'Side A has 0:14 left; this song is 3:43.', f'{tag}: refusal names the reason ({t})')
    shot(page, 'editor-refusal')
    check(page.locator('.pk-rowbtn', has_text='Glass Hours').count() == 1 and 'A' not in page.locator('.pk-rowbtn', has_text='Glass Hours').first.locator('.pk-act').inner_text(), f'{tag}: a refused song is not marked on tape')
    # switch to side B and add from the two other albums
    page.locator('.pk-sidebtn').nth(1).tap(); page.wait_for_timeout(200)
    add_search_result(page, 'Glass Hours')
    add_search_result(page, 'Low Water')
    search(page, 'ros')  # Hoppípolla / Glósóli (Sigur Rós) + 'Salt and Ember'? no: 'ros'
    page.locator('.pk-rowbtn', has_text='Hoppípolla').first.tap(); page.wait_for_timeout(250)
    g = gauges(page); check('B' in g[1] and '3 songs' in g[1], f'{tag}: side B has three songs from three albums ({g[1]})')
    # the row shows an "already on tape" marker, and tapping it again does not double-add
    page.locator('.pk-rowbtn', has_text='Hoppípolla').first.tap(); page.wait_for_timeout(200)
    t = toast_text(page); check('already on side B' in t, f'{tag}: already-on-tape is refused ({t})')
    # multi-select
    search(page, '')
    page.tap('.pk-sel-toggle'); page.locator('.pk-albmain', has_text='Orchard Hum').first.tap(); page.wait_for_timeout(250)
    page.locator('.pk-rowbtn').nth(0).tap(); page.locator('.pk-rowbtn').nth(1).tap(); page.wait_for_timeout(200)
    check(page.locator('.pk-bar:not(.hidden)').count() == 1 and '2 selected' in page.inner_text('.pk-bar'), f'{tag}: multi-select shows the bar ({page.inner_text(".pk-bar")[:30]!r})')
    shot(page, 'editor-add-select')
    page.tap('.pk-clear'); page.tap('.pk-sel-toggle')

    # ── tracklist of side B: reorder (keyboard + drag), move across, remove
    page.tap('#edtab-tracks'); page.wait_for_timeout(300)
    titles = lambda: page.eval_on_selector_all('.tk-row .tk-text b', 'els => els.map(e => e.textContent)')
    before = titles(); check(len(before) >= 3, f'{tag}: side B tracklist {before}')
    grip = page.locator('.tk-grip').first
    grip.focus(); page.keyboard.press('ArrowDown'); page.wait_for_timeout(200)
    after = titles(); check(after[0] == before[1] and after[1] == before[0], f'{tag}: keyboard reorder (ArrowDown on the grip) {before} -> {after}')
    # drag the last row to the top with real pointer movement on the grip
    last = page.locator('.tk-grip').last; bb = last.bounding_box(); top = page.locator('.tk-grip').first.bounding_box()
    page.mouse.move(bb['x'] + bb['width'] / 2, bb['y'] + bb['height'] / 2); page.mouse.down()
    steps = 8
    for i in range(1, steps + 1):
        page.mouse.move(bb['x'] + bb['width'] / 2, bb['y'] + bb['height'] / 2 + (top['y'] - bb['y'] - 6) * i / steps); page.wait_for_timeout(16)
    shot(page, 'editor-tracks-dragging')
    page.mouse.up(); page.wait_for_timeout(300)
    dragged = titles(); check(dragged[0] == after[-1], f'{tag}: drag-to-reorder moved the last song to the top {after} -> {dragged}')
    shot(page, 'editor-tracks-side-b')
    # menu: move to side A is refused when A is full, with the reason
    page.locator('.tk-dots').first.tap(); page.locator('.tk-menu button', has_text='Move to side A').tap(); page.wait_for_timeout(250)
    t = toast_text(page); check('Side A has' in t, f'{tag}: moving across into a full side is refused ({t})')
    # remove with undo
    n0 = page.locator('.tk-row').count()
    page.locator('.tk-dots').last.tap(); page.locator('.tk-menu .rm').tap(); page.wait_for_timeout(250)
    check(page.locator('.tk-row').count() == n0 - 1, f'{tag}: remove takes a song off')
    page.locator('.ed-toast button', has_text='Undo').tap(); page.wait_for_timeout(250)
    check(page.locator('.tk-row').count() == n0, f'{tag}: Undo puts it back')
    # flip the preview with a tap
    prev = page.inner_text('.ed-sidelabel'); page.tap('.ed-tape'); page.wait_for_timeout(500)
    check(page.inner_text('.ed-sidelabel') != prev, f'{tag}: tapping the cassette flips the preview ({prev} -> {page.inner_text(".ed-sidelabel")})')
    page.tap('.ed-tape'); page.wait_for_timeout(400)

    # ── style
    page.tap('#edtab-style'); page.wait_for_timeout(700)
    shot(page, 'editor-style')
    check(page.locator('.ed-sty').count() == 37, f'{tag}: 37 cassette types ({page.locator(".ed-sty").count()})')
    page.locator('.ed-sty').nth(5).tap(); page.locator('.ed-pens button').nth(1).tap(); page.locator('.ed-dots-row button').nth(3).tap()
    page.wait_for_timeout(300)

    # ── save, then see it in the stack with the strip info
    page.tap('.ed-bar .sv'); page.wait_for_selector('.ed', state='detached'); page.wait_for_timeout(700)
    st = stored(page)
    mt = [m for m in st['mixtapes'] if m['name'].startswith('Café')][0]
    check(st['version'] == 4 and mt['tape']['length'] == 'C30' and len(mt['sides']['A']) == 4 and len(mt['sides']['B']) == 3, f'{tag}: saved as v4 with sides A/B ({len(mt["sides"]["A"])}/{len(mt["sides"]["B"])})')
    check(all('dur' in r for r in mt['sides']['A']), f'{tag}: real durations were stored as hints')
    check(mt['name'] == 'Café Road <b>Mix</b>' and page.locator('.cs-card[aria-label*="<b>"]').count() >= 1, f'{tag}: a hostile title stays plain text')
    check(page.evaluate('!document.querySelector(".cs-card b, .ed b[data-x]")'), f'{tag}: no HTML was injected from the title')
    shot(page, 'shelf-stack')
    metas = page.eval_on_selector_all('.cs-meta', 'els => els.map(e => e.textContent)'); check(any('C30 · A 4 · B 3' in x for x in metas), f'{tag}: strips: {metas}')
    page.click('#mtBar .mt-view-btn:has-text("Spines")'); page.wait_for_timeout(500); shot(page, 'shelf-spines')
    # spines: the badge no longer sits on the tape name; every spine has a caption line and a visible 44px menu button
    check(page.locator('.cs-meta').count() == 0, f'{tag}: spines carry no overlapping badge')
    caps = page.eval_on_selector_all('.cs-rowmain .cs-cap', 'els => els.map(e => e.textContent)')
    check(any('Side A 4 songs' in c and 'Side B 3 songs' in c for c in caps), f'{tag}: spines say what is on each side in words ({caps})')
    page.click('#mtBar .mt-view-btn:has-text("Stack")'); page.wait_for_timeout(400)
    # reload: persisted
    page.reload(); page.wait_for_function('document.getElementById("latency") && !/boot error/.test(document.getElementById("latency").textContent)'); page.wait_for_timeout(1200)
    to_section(page, 'mixtapes')
    check(page.locator('.cs-card[aria-label*="Café Road"]').count() == 1, f'{tag}: the tape is still there after a reload')
    scan(page); to_section(page, 'mixtapes'); page.wait_for_timeout(400)      # a browser can't keep File handles: re-scan links the remembered songs again

    # ── player: build a short tape (7 s songs) so the end of a side can really be reached
    page.tap('#mtNew'); page.wait_for_selector('.ed'); page.wait_for_timeout(300)
    page.fill('.ed-tape-tab input[aria-label="Title"]', 'Blips'); page.locator('.ed-len', has_text='C30').tap()
    page.tap('#edtab-add'); page.wait_for_timeout(300)
    for ti in ['Blip One', 'Blip Two']: add_search_result(page, ti)
    page.locator('.pk-sidebtn').nth(1).tap()
    for ti in ['Blip Three', 'Blip Four']: add_search_result(page, ti)
    page.tap('.ed-bar .sv'); page.wait_for_selector('.ed', state='detached'); page.wait_for_timeout(500)
    blips = [m for m in stored(page)['mixtapes'] if m['name'] == 'Blips'][0]
    check(blips['autoReverse'] is True, f'{tag}: auto-reverse defaults on for a new tape')
    check([len(blips['sides']['A']), len(blips['sides']['B'])] == [2, 2], f'{tag}: the short tape has two songs a side ({[r["title"] for r in blips["sides"]["A"]]} | {[r["title"] for r in blips["sides"]["B"]]})')

    def open_player(name):
        card = page.locator(f'.cs-card[aria-label^="Mixtape: {name}"]').first
        card.tap(); page.wait_for_timeout(700)
        if page.locator('.tp:not(.hidden)').count() == 0: card.tap()      # the first tap only brought it to the top of the stack
        page.wait_for_selector('.tp:not(.hidden)'); page.wait_for_timeout(1500)
    open_player('Blips')
    check(page.evaluate('window.__rms()') > 0.01, f'{tag}: the tape plays real audio (rms {page.evaluate("window.__rms()"):.3f})')
    check(side_state(page) == ['A', True], f'{tag}: deck shows SIDE A with AUTO engaged {side_state(page)}')
    shot(page, 'player-deck-auto-on-side-a')
    # AUTO on: the end of side A flips by itself and side B plays
    page.wait_for_function('() => { const d = document.querySelector(".sk-deck .side-panel"); if (!d) return false; const l = [...d.querySelectorAll("text[data-side]")].find(t => t.getAttribute("fill") === "#ffb347"); return l && l.getAttribute("data-side") === "B"; }', timeout=25000)
    page.wait_for_timeout(300); shot(page, 'player-deck-auto-flipped-to-b')
    check(side_state(page)[0] == 'B', f'{tag}: AUTO on -> side B is in the deck after side A ran out')
    page.wait_for_timeout(2500)
    check(page.evaluate('window.__rms()') > 0.01, f'{tag}: playback carried on into side B (rms {page.evaluate("window.__rms()"):.3f})')
    # side B ends: stops and offers rewind
    page.wait_for_function("() => !document.querySelector('.sk-deck .key[data-key=play]').classList.contains('down')", timeout=25000)
    check(not deck_playing(page), f'{tag}: the end of side B stops (the deck stops playing)')
    shot(page, 'player-deck-end-of-b')
    # skins: the Player skin with AUTO
    page.locator('.tp-look').tap(); page.wait_for_timeout(1700)
    shot(page, 'player-skin-player')
    check(side_state(page) == ['A', True] or side_state(page)[1] is True, f'{tag}: the Player skin has the AUTO key engaged {side_state(page)}')
    shot(page, 'player-skin-player-auto-on')
    page.locator('.sk-player [aria-label^="Auto-reverse"]').click(); page.wait_for_timeout(300)
    check(side_state(page)[1] is False, f'{tag}: the Player skin AUTO key releases')
    shot(page, 'player-skin-player-auto-off')
    page.locator('.sk-player [aria-label^="Auto-reverse"]').click(); page.wait_for_timeout(300)
    check(side_state(page)[1] is True, f'{tag}: ...and latches again')
    s0 = side_state(page)[0]
    page.locator('.sk-player [aria-label^="Flip the tape"]').click(); page.wait_for_timeout(900)
    check(side_state(page)[0] != s0 and side_state(page)[0] in ('A', 'B'), f'{tag}: the Player skin FLIP key turns the tape (LCD side {s0} -> {side_state(page)[0]})')
    shot(page, 'player-skin-player-flipped')
    page.locator('.sk-player [aria-label^="Flip the tape"]').click(); page.wait_for_timeout(900)
    check(side_state(page)[0] == s0, f'{tag}: ...and back ({side_state(page)[0]})')
    page.locator('.tp-look').tap(); page.wait_for_timeout(1700)
    # AUTO off via the key: persisted on the mixtape and as the default
    page.locator('.sk-deck .side-key[data-key=auto]').click(); page.wait_for_timeout(400)
    check(side_state(page)[1] is False, f'{tag}: pressing AUTO releases the latch')
    check([m for m in stored(page)['mixtapes'] if m['name'] == 'Blips'][0]['autoReverse'] is False, f'{tag}: AUTO off is persisted on the mixtape')
    check(page.evaluate('localStorage.getItem("runout.cassette.auto")') == '0', f'{tag}: ...and as the default for new tapes')
    shot(page, 'player-deck-auto-off')
    # FLIP back to A (manual), play: starts side A from its beginning (it ran out earlier)
    page.locator('.sk-deck .side-key[data-key=flip]').click(); page.wait_for_timeout(120); shot(page, 'player-deck-flip-midway'); page.wait_for_timeout(700)
    check(side_state(page)[0] == 'A', f'{tag}: FLIP turns the tape to side A')
    page.locator('.sk-deck .key[data-key=play]').click(); page.wait_for_timeout(2200)
    check(page.evaluate('window.__rms()') > 0.01, f'{tag}: Play after FLIP plays side A (rms {page.evaluate("window.__rms()"):.3f})')
    # AUTO off: the end of side A stops with "Flip tape"
    page.wait_for_function('() => { const t = [...document.querySelectorAll(".sk-deck .side-panel text")].find(x => x.textContent === "FLIP TAPE" && x.getAttribute("font-size") === "50"); return !!t; }', timeout=20000)
    page.wait_for_timeout(300)
    check(not deck_playing(page), f'{tag}: AUTO off -> the end of side A stops')
    shot(page, 'player-deck-flip-tape')
    check(side_state(page)[0] == 'A', f'{tag}: still on side A, waiting for FLIP')
    page.locator('.sk-deck .key[data-key=play]').click(); page.wait_for_timeout(600)
    check(not deck_playing(page) and side_state(page)[0] == 'A', f'{tag}: Play does nothing until the tape is flipped')
    page.locator('.sk-deck .side-key[data-key=flip]').click(); page.wait_for_timeout(900)
    check(side_state(page)[0] == 'B', f'{tag}: FLIP -> side B')
    page.locator('.sk-deck .key[data-key=play]').click(); page.wait_for_timeout(2200)
    check(page.evaluate('window.__rms()') > 0.01, f'{tag}: Play starts side B from its beginning (rms {page.evaluate("window.__rms()"):.3f})')
    # the revealed tracklist shows the CURRENT side's songs with the other side one tap away
    page.locator('.cp-win').click(position={'x': 40, 'y': 40}); page.wait_for_timeout(400)
    lst = page.eval_on_selector_all('.tp-songs li', 'els => els.map(e => e.textContent)')
    check(len(lst) == 2 and 'Blip Three' in lst[0], f'{tag}: tapping the cassette lists the current side ({lst})')
    shot(page, 'player-tracklist-side-b')
    page.locator('.tp-side', has_text='Side A').tap(); page.wait_for_timeout(250)
    lst = page.eval_on_selector_all('.tp-songs li', 'els => els.map(e => e.textContent)'); check('Blip One' in lst[0], f'{tag}: the other side is one tap away ({lst})')
    page.locator('.btn-close').tap(); page.wait_for_timeout(500)

    # ── reload: sides / auto persist, the second boot of the player works
    page.reload(); page.wait_for_function('document.getElementById("latency") && !/boot error/.test(document.getElementById("latency").textContent)'); page.wait_for_timeout(1000)
    st = stored(page); b2 = [m for m in st['mixtapes'] if m['name'] == 'Blips'][0]
    check(b2['autoReverse'] is False and len(b2['sides']['B']) == 2, f'{tag}: sides and AUTO survive a reload')
    check(errs == [], f'{tag}: no page errors {errs[:3]}')
    ctx.close()


def run_layout(b, w, h):
    """Every mixtape task (the editor's four tabs, import) is a FULL-SCREEN page on a phone: the editor box equals the viewport (the test
    browser has no safe-area insets; the CSS pads by env(safe-area-inset-*)), the tab bar is sticky and visible, the body scrolls,
    tap targets are >= 44 px, the cassette preview is large, and leaving with unsaved changes asks first."""
    tag = f'layout {w}x{h}'
    print(f'--- {tag}', flush=True)
    land = w > h
    shot = lambda page, name: page.screenshot(path=f'{SHOTS}/layout-{w}x{h}-{name}.png')
    ctx, page, errs = boot(b, w, h, blob_v3_old())
    scan(page)
    to_section(page, 'mixtapes'); page.wait_for_timeout(500)
    rect = lambda sel: page.evaluate('(s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; }', sel)
    near = lambda a, b2: all(abs(x - y) <= 1 for x, y in zip(a, b2))
    page.tap('#mtNew'); page.wait_for_selector('.ed'); page.wait_for_timeout(500)
    check(near(rect('.ed'), [0, 0, w, h]), f'{tag}: the editor box is the whole viewport ({rect(".ed")})')
    check(near(rect('.ed-ov'), [0, 0, w, h]), f'{tag}: the editor overlay is the whole viewport')
    check(page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), f'{tag}: no horizontal page scroll')
    for tab in ['tape', 'add', 'tracks', 'style']:
        page.tap('#edtab-' + tab); page.wait_for_timeout(350)
        bar, tabs, panel, ed = rect('.ed-bar'), rect('.ed-tabs'), rect('.ed-panel'), rect('.ed')
        check(bar is not None and bar[1] == 0 and bar[3] >= 44, f'{tag}/{tab}: header bar at the top ({bar})')
        check(tabs[3] >= 44 and 0 <= tabs[1] and tabs[1] + tabs[3] <= h, f'{tag}/{tab}: the tab bar is on screen, >= 44 px tall ({tabs})')
        check(panel[3] >= (150 if land else 220), f'{tag}/{tab}: the scrolling body has room ({panel[3]:.0f}px)')
        check(abs(panel[1] + panel[3] - h) <= 1, f'{tag}/{tab}: the body runs to the bottom edge ({panel[1] + panel[3]:.0f} vs {h})')
        if land: check(rect('.ed-top')[0] + rect('.ed-top')[2] <= tabs[0] + 1, f'{tag}/{tab}: landscape puts the preview beside the tabs, not above them')
        small = page.evaluate("""() => [...document.querySelectorAll('.ed-bar button, .ed-tabs button, .ed-panel:not(.hidden) button, .ed-panel input:not([type=range]), .ed-gauge')]
          .filter((e) => e.offsetParent !== null && !e.closest('.hidden')).map((e) => { const r = e.getBoundingClientRect(); return [e.className || e.tagName, Math.round(r.width), Math.round(r.height)]; })
          .filter((x) => x[1] > 0 && (x[2] < 44 || x[1] < 44))""")
        small = [x for x in small if not str(x[0]).startswith('pk-row') and 'tk-' not in str(x[0])]
        check(not small, f'{tag}/{tab}: every visible button / field in the header, tabs and body is >= 44 px both ways ({small[:4]})')
        pv = rect('.ed-tape')
        if tab in ('tape', 'style') or land: check(pv[2] >= min(300, w * 0.45) and (not land or pv[2] >= 340), f'{tag}/{tab}: the live preview is large ({pv[2]:.0f}px wide)')
        shot(page, tab)
    page.tap('#edtab-add'); page.wait_for_timeout(300)
    q = rect('.pk-q'); sc = rect('.pk-scroll')
    tb = rect('.ed-tabs'); check(q[2] >= tb[2] * 0.7 and sc[2] >= tb[2] - 40, f'{tag}: search field and results use the width ({q[2]:.0f} / {sc[2]:.0f} of {w})')
    page.fill('.pk-q', 'zzzz-nothing'); page.wait_for_timeout(400)
    check('No songs match' in page.inner_text('.pk-scroll'), f'{tag}: an empty search says so')
    shot(page, 'add-empty')
    page.fill('.pk-q', '')
    # unsaved changes: Back asks; Keep editing stays; Discard leaves
    page.tap('#edtab-tape'); page.fill('.ed-tape-tab input[aria-label="Title"]', 'Draft'); page.tap('#ed-back'); page.wait_for_selector('.ed-warn')
    wr = rect('.ed-warn-card')
    check(wr is not None and wr[2] <= 400 and wr[3] < h * 0.8, f'{tag}: the discard confirmation is a small dialog ({wr})')
    check(all(x[2] >= 44 for x in page.evaluate("() => [...document.querySelectorAll('.ed-warn button')].map((e) => { const r = e.getBoundingClientRect(); return [0, 0, r.height]; })")), f'{tag}: confirmation buttons are >= 44 px')
    shot(page, 'discard-confirm')
    page.tap('.ed-warn .kp'); page.wait_for_timeout(200)
    check(page.locator('.ed-warn').count() == 0 and page.locator('.ed').count() == 1, f'{tag}: Keep editing stays in the editor')
    page.tap('#ed-back'); page.wait_for_selector('.ed-warn'); page.tap('.ed-warn .dc'); page.wait_for_timeout(300)
    check(page.locator('.ed').count() == 0, f'{tag}: Discard closes the editor')
    # import: a full-screen page with Back
    page.tap('#mtImport'); page.wait_for_selector('.mt-dialog .theme-card'); page.wait_for_timeout(300)
    check(near(rect('.mt-dialog .theme-card'), [0, 0, w, h]), f'{tag}: the import page is the whole viewport ({rect(".mt-dialog .theme-card")})')
    check(rect('.mt-dialog .mt-textarea')[2] >= w - 40, f'{tag}: the paste box uses the width')
    shot(page, 'import')
    page.tap('.mt-dialog .theme-x'); page.wait_for_timeout(200)
    check(page.locator('.mt-dialog').count() == 0, f'{tag}: Back closes the import page')
    # search + deck details + device-mode sheet are pages too
    page.locator('.page:not([hidden]) .page-search').first.tap(); page.wait_for_selector('.so-card'); page.wait_for_timeout(300)
    check(near(rect('.so-card'), [0, 0, w, h]), f'{tag}: Search fills the viewport ({rect(".so-card")})')
    shot(page, 'search')
    page.keyboard.press('Escape'); page.wait_for_timeout(300)
    to_section(page, 'albums'); page.wait_for_timeout(400)
    page.tap('#btnDeck'); page.wait_for_timeout(300)
    dk = rect('#deckSheet')
    check(dk[2] >= w - 2 and dk[3] >= h - 4, f'{tag}: Turntable settings is a full page ({dk})')
    shot(page, 'deck')
    page.tap('.tt-sheet-close'); page.wait_for_timeout(200)
    page.evaluate("import('/src/devicemode/sheet.js').then((m) => m.openSheet({ settings: { get: () => ({}), set() {} } }))"); page.wait_for_selector('.dm-sheet-card'); page.wait_for_timeout(200)
    dm = rect('.dm-sheet-card')
    check(near(dm, [0, 0, w, h]), f'{tag}: the Device mode sheet is a full page ({dm})')
    page.tap('.dm-done'); page.wait_for_timeout(200)
    check(page.locator('.dm-sheet').count() == 0, f'{tag}: Done closes the Device mode page')
    check(errs == [], f'{tag}: no page errors {errs[:3]}')
    ctx.close()


def blob_ux():
    r = lambda t, a, al, d: {'title': t, 'artist': a, 'album': al, 'dur': d}
    cfg = lambda st: {'style': st, 'pen': 'marker', 'wear': 0.2, 'gloss': 0.5, 'text': {'subtitle': '', 'note': '', 'side': 'A'}}
    return {'version': 4, 'mixtapes': [
        {'id': 'u1', 'name': 'Road Songs', 'author': 'me', 'cfg': cfg('brass'), 'tape': {'length': 'C60'}, 'autoReverse': True,
         'sides': {'A': [r('Harbor Lights', 'Mara Quill', 'Night Shift', 215), r('Paper Moon', 'Mara Quill', 'Night Shift', 232), r('Slow Window', 'Mara Quill', 'Night Shift', 198)],
                   'B': [r('Salt and Ember', 'Low Tide Orchestra', 'Tidal', 205)]}},
        {'id': 'u2', 'name': 'Late Night', 'author': 'me', 'cfg': cfg('clear'), 'tape': {'length': 'C90'}, 'autoReverse': True,
         'sides': {'A': [r('Glass Hours', 'Low Tide Orchestra', 'Tidal', 223)], 'B': []}}]}

def run_ux(b, w, h):
    """The UX review's defects in the Mixtapes shelf and the cassette player, asserted as geometry and text (not just pictures)."""
    tag = f'ux {w}x{h}'
    print(f'--- {tag}', flush=True)
    land = w > h
    shot = lambda page, name: page.screenshot(path=f'{SHOTS}/ux-{w}x{h}-{name}.png')
    ctx, page, errs = boot(b, w, h, blob_ux())
    scan(page); to_section(page, 'mixtapes'); page.wait_for_timeout(800)
    small = lambda sel: page.evaluate("""(s) => [...document.querySelectorAll(s)].filter((e) => e.offsetParent !== null).map((e) => { const r = e.getBoundingClientRect(); return [(e.id || e.className || e.tagName).toString().slice(0, 28), Math.round(r.width), Math.round(r.height)]; }).filter((x) => x[1] < 44 || x[2] < 44)""", sel)
    # ── shelf bar: labelled, no jargon, every target >= 44 px
    check(page.locator('#mtBar .sort-chip:has-text("Edit")').count() == 0 and page.locator('.pk-sel-toggle').count() == 0, f'{tag}: no stray Edit chip in the shelf bar')
    check([t.strip() for t in page.eval_on_selector_all('.mt-view-btn', 'els => els.map(e => e.textContent)')] == ['Stack', 'Spines'], f'{tag}: the view toggle is Stack | Spines')
    check(not small('#mtBar button, .mt-view-btn, .mt-sug button, .cs-more'), f'{tag}: shelf targets (+New, Import, view toggle, suggestions, tape menu) are >= 44 px ({small("#mtBar button, .mt-view-btn, .mt-sug button, .cs-more")[:4]})')
    # ── suggestions: a real cassette preview and a clear Create
    chips = page.locator('.mt-sug-chip').count()
    check(chips >= 2 and page.evaluate("[...document.querySelectorAll('.mt-sug-chip')].every((c) => c.querySelector('.mt-sug-prev svg'))"), f'{tag}: every suggestion shows a cassette preview ({chips})')
    check(all(t.strip() == 'Create' for t in page.eval_on_selector_all('.mt-sug-create', 'els => els.map(e => e.textContent)')), f'{tag}: every suggestion has a Create button')
    shot(page, 'shelf')
    # ── the per-tape menu: the visible ⋯ button and a long press both open it; Edit lives there
    page.locator('.cs-more').first.tap(); page.wait_for_selector('.mt-menu')
    items = page.eval_on_selector_all('.mt-menu-item b', 'els => els.map(e => e.textContent)')
    check(items[:1] == ['Play'] and 'Edit tape' in items and 'Export' in items, f'{tag}: the tape menu offers Play / Edit / Export ({items})')
    check(not small('.mt-menu button'), f'{tag}: menu rows are >= 44 px')
    shot(page, 'menu')
    page.keyboard.press('Escape'); page.wait_for_timeout(200)
    check(page.locator('.mt-menu').count() == 0, f'{tag}: Esc closes the tape menu')
    page.evaluate("""() => { const c = document.querySelector('.cs-card'); const r = c.getBoundingClientRect(); const o = { bubbles: true, pointerId: 1, clientX: r.x + 40, clientY: r.y + 20, pointerType: 'touch' }; c.dispatchEvent(new PointerEvent('pointerdown', o)); }""")
    page.wait_for_timeout(750)
    check(page.locator('.mt-menu').count() == 1, f'{tag}: a long press on a tape opens the same menu')
    page.locator('.mt-menu-item', has_text='Edit tape').tap(); page.wait_for_selector('.ed'); page.wait_for_timeout(400)
    # ── editor Tracks: the duration once, the side total labelled
    page.tap('#edtab-tracks'); page.wait_for_timeout(350)
    check(page.locator('.tk-time small').count() == 0, f'{tag}: a song shows its length once (no second running figure)')
    foot = page.inner_text('.tk-foot') if page.locator('.tk-foot').count() else ''
    check('Side A total' in foot, f'{tag}: the running figure is a labelled "Side A total" footer ({foot!r})')
    page.tap('#edtab-add'); page.wait_for_timeout(350)
    sides = page.eval_on_selector_all('.pk-sidebtn small', 'els => els.filter((e) => e.offsetParent !== null).map(e => e.textContent)')
    check(len(sides) == 2 and all(' of 20 songs' in x and '/20' not in x for x in sides), f'{tag}: side headers read "N of 20 songs" ({sides})')
    sel = page.inner_text('.pk-sel-toggle')
    page.tap('.pk-sel-toggle'); page.wait_for_timeout(200)
    check(sel == 'Pick several' and 'pick several' in page.inner_text('.pk-status').lower(), f'{tag}: "Select" is "Pick several" and says how it works ({sel!r})')
    shot(page, 'editor-add')
    page.tap('#ed-back'); page.wait_for_timeout(400)
    if page.locator('.ed-warn').count(): page.tap('.ed-warn .dc'); page.wait_for_timeout(300)
    # ── the player
    card = page.locator('.cs-card[aria-label^="Mixtape: Road Songs"]').first
    card.tap(position={'x': 120, 'y': 8}); page.wait_for_timeout(700)
    if page.locator('.tp:not(.hidden)').count() == 0: card.tap(position={'x': 120, 'y': 8})
    page.wait_for_selector('.tp:not(.hidden)'); page.wait_for_timeout(1800)
    shot(page, 'player')
    np_ = page.inner_text('.tp-np')
    check('road songs' in np_.lower() and 'side a' in np_.lower(), f'{tag}: the tape name and side are printed upright ({np_[:40]!r})')
    song = page.inner_text('.tp-np-song'); art = page.inner_text('.tp-np-artist'); tm = page.inner_text('.tp-np-time'); nx = page.inner_text('.tp-np-next')
    check(song == 'Harbor Lights' and art == 'Mara Quill', f'{tag}: now playing shows the song and artist ({song!r}, {art!r})')
    check('/' in tm and 'Side A' in tm, f'{tag}: elapsed / side length and the side ({tm!r})')
    check(nx.startswith('Next: Paper Moon'), f'{tag}: next up ({nx!r})')
    check(page.evaluate("[...document.querySelectorAll('.tp-np, .tp-np *')].every((e) => getComputedStyle(e).writingMode === 'horizontal-tb' && (getComputedStyle(e).transform === 'none'))"), f'{tag}: the now-playing text is not rotated')
    page.wait_for_timeout(1200)
    tm2 = page.inner_text('.tp-np-time'); check(tm2 != tm, f'{tag}: the elapsed time advances ({tm!r} -> {tm2!r})')
    labels = [t.strip() for t in page.eval_on_selector_all('.tp-chip, .tp-back, .tp-songs-btn', 'els => els.map(e => e.textContent)')]
    for want in ['Back', 'Songs', 'Auto-flip: On', 'Click sounds: Off', 'Vibration:']:
        check(any(want in l for l in labels), f'{tag}: a control is labelled "{want}" ({labels})')
    check(not any(l in ('Deck', 'Player', 'Haptics', 'Click') for l in labels), f'{tag}: the old jargon chips are gone')
    check(not small('.tp-chip, .tp-back, .tp-songs-btn'), f'{tag}: every player control is >= 44 px ({small(".tp-chip, .tp-back, .tp-songs-btn")})')
    rect = lambda sel: page.evaluate('(s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return [r.x, r.y, r.right, r.bottom]; }', sel)
    lock = rect('.dm-key-float')
    hit = lambda a, b2: a and b2 and not (a[2] <= b2[0] or b2[2] <= a[0] or a[3] <= b2[1] or b2[3] <= a[1])
    if lock:
        for sel in ['.tp-np-next', '.tp-np-time', '.tp-np-song', '.tp-np-artist', '.tp-songs-btn', '.tp-back', '.tp-ctl', '.tp-look']:
            # text blocks are measured by their text, not their (full-width) box
            r_ = page.evaluate("""(s) => { const e = document.querySelector(s); const g = document.createRange(); g.selectNodeContents(e); const r = (s.startsWith('.tp-np-') ? g : e).getBoundingClientRect(); return [r.x, r.y, r.right, r.bottom]; }""", sel)
            check(not hit(r_, lock), f'{tag}: the lock key does not cover {sel}')
    check(page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), f'{tag}: no horizontal scroll in the player')
    hostr, npr = rect('.tp-host'), rect('.tp-np')
    check(npr[3] <= h + 1 and hostr[3] <= h + 1, f'{tag}: deck and now-playing block fit the screen (np bottom {npr[3]:.0f} of {h})')
    if land: check(hostr[2] <= npr[0] + 1, f'{tag}: landscape puts the info beside the deck')
    # Songs button reveals the list, and closes it again
    page.tap('.tp-songs-btn'); page.wait_for_timeout(300)
    check(not page.evaluate("document.querySelector('.tp-list').classList.contains('hidden')") and page.get_attribute('.tp-songs-btn', 'aria-expanded') == 'true', f'{tag}: the Songs button opens the song list')
    check(page.locator('.tp-songs li').count() == 3, f'{tag}: ... with the three songs of side A')
    shot(page, 'player-songs')
    page.tap('.tp-songs-btn'); page.wait_for_timeout(250)
    check(page.evaluate("document.querySelector('.tp-list').classList.contains('hidden')"), f'{tag}: ... and the same button closes it')
    # side flip + auto-flip toggles reflect state
    page.tap('.tp-auto'); page.wait_for_timeout(250)
    check('Off' in page.inner_text('.tp-auto') and page.get_attribute('.tp-auto', 'aria-pressed') == 'false', f'{tag}: Auto-flip toggles off ({page.inner_text(".tp-auto")!r})')
    page.tap('.tp-auto'); page.wait_for_timeout(200)
    page.tap('.tp-flip'); page.wait_for_timeout(1500)
    check('Side B' in page.inner_text('.tp-np-time') and page.inner_text('.tp-np-song') == 'Salt and Ember', f'{tag}: Flip side shows side B and its song ({page.inner_text(".tp-np-time")!r})')
    shot(page, 'player-side-b')
    page.tap('.tp-back'); page.wait_for_timeout(500)
    check(page.locator('.tp:not(.hidden)').count() == 0, f'{tag}: Back closes the player')
    # ── wide: the shelf uses the width
    if w >= 700:
        xs = page.evaluate("[...document.querySelectorAll('.cs-cell')].map((e) => Math.round(e.getBoundingClientRect().x))")
        check(len(set(xs)) >= 2, f'{tag}: wide screens lay the tapes out in columns ({xs})')
        page.locator('.mt-view-btn', has_text='Spines').tap(); page.wait_for_timeout(400)
        xs = page.evaluate("[...document.querySelectorAll('.cs-row')].map((e) => Math.round(e.getBoundingClientRect().x))")
        check(len(set(xs)) >= 2, f'{tag}: ... and the spines too ({xs})')
        shot(page, 'spines-wide')
    check(errs == [], f'{tag}: no page errors {errs[:3]}')
    ctx.close()

def run_reduced(b):
    print('--- reduced motion', flush=True)
    blob = {'version': 4, 'mixtapes': [{'id': 'b1', 'name': 'Blips', 'author': '', 'cfg': {'style': 'clear', 'pen': 'marker', 'wear': 0.1, 'gloss': 0.5, 'text': {'subtitle': '', 'note': '', 'side': 'A'}}, 'tape': {'length': 'C30'}, 'autoReverse': True,
        'sides': {'A': [{'title': 'Blip One', 'artist': 'Tiny Tapes', 'album': 'Short Cuts'}, {'title': 'Blip Two', 'artist': 'Tiny Tapes', 'album': 'Short Cuts'}], 'B': [{'title': 'Blip Three', 'artist': 'Tiny Tapes', 'album': 'Short Cuts'}, {'title': 'Blip Four', 'artist': 'Tiny Tapes', 'album': 'Short Cuts'}]}}]}
    ctx, page, errs = boot(b, 360, 780, blob, reduced=True)
    scan(page); to_section(page, 'mixtapes'); page.wait_for_timeout(500)
    card = page.locator('.cs-card').first; card.tap(); page.wait_for_timeout(700)
    if page.locator('.tp:not(.hidden)').count() == 0: card.tap()
    page.wait_for_selector('.tp:not(.hidden)'); page.wait_for_timeout(1500)
    page.locator('.sk-deck .side-key[data-key=flip]').click(); page.wait_for_timeout(120)
    check(side_state(page)[0] == 'B', 'reduced motion: FLIP swaps the side at once (no animation to wait for)')
    check(page.evaluate('document.querySelector(".cp-flip").getAnimations().length') == 0, 'reduced motion: no flip animation runs')
    ctx.close()

def run_5k(b):
    print('--- 5,000 tracks', flush=True)
    ctx, page, errs = boot(b, 360, 780)
    n = 5000
    page.evaluate("""async (n) => {
      const tracks = [];
      for (let i = 0; i < n; i++) tracks.push({ id: 'k5-' + i, title: 'Song ' + i + (i % 7 ? ' Night' : ' Dáy'), artist: 'Artist ' + (i % 25), albumArtist: '', album: 'Album ' + (i % 400), path: 'x/Album ' + (i % 400) + '/' + i + '.mp3', genre: 'Rock', size: 1000 + i, hue: 10, color: '#222233', durationSec: 90 + (i % 20), trackNo: (i % 12) + 1 });
      await new Promise((res) => { const r = indexedDB.open('runout-library', 1); r.onupgradeneeded = () => { r.result.createObjectStore('kv'); r.result.createObjectStore('handles', { autoIncrement: true }); };
        r.onsuccess = () => { const t = r.result.transaction('kv', 'readwrite'); t.objectStore('kv').put({ version: 1, savedAt: 0, tracks }, 'index'); t.oncomplete = () => { r.result.close(); res(); }; }; });
    }""", n)
    page.reload(); page.wait_for_function('document.getElementById("latency") && !/boot error/.test(document.getElementById("latency").textContent)'); page.wait_for_timeout(1500)
    to_section(page, 'mixtapes'); page.tap('#mtNew'); page.wait_for_selector('.ed'); page.wait_for_timeout(400)
    page.tap('#edtab-add'); page.wait_for_timeout(1200)
    st = page.eval_on_selector('.pk-status', 'e => e.textContent'); check('5000 songs' in st, f'5k: library of 5000 restored ({st})')
    rows = page.locator('.pk-alb, .pk-row').count(); check(rows < 60, f'5k: the list is virtualised ({rows} DOM rows for 400 albums / 5000 songs)')
    t0 = time.time(); page.fill('.pk-q', 'night artist 4'); page.wait_for_function('document.querySelector(".pk-status").textContent.includes("song")'); dt = time.time() - t0
    check(dt < 1.5, f'5k: a search over 5,000 tracks answers in {dt*1000:.0f} ms (incl. debounce)')
    check(page.locator('.pk-alb, .pk-row').count() < 60, '5k: results are virtualised too')
    page.fill('.pk-q', ''); page.wait_for_timeout(400)
    page.evaluate('document.querySelector(".pk-scroll").scrollTop = 20000'); page.wait_for_timeout(300)
    check(page.locator('.pk-alb, .pk-row').count() < 60 and page.locator('.pk-alb').first.inner_text() != '', '5k: scrolling deep re-windows the rows')
    page.screenshot(path=f'{SHOTS}/5k-picker.png')
    # the hard cap: 20 songs a side (a C90 side has the minutes for far more), then the refusal says so
    page.tap('#edtab-tape'); page.locator('.ed-len', has_text='C90').tap()
    page.tap('#edtab-add'); page.wait_for_timeout(400)
    page.locator('.pk-addall').nth(0).tap(); page.wait_for_timeout(250)
    page.locator('.pk-addall').nth(1).tap(); page.wait_for_timeout(300)
    t = toast_text(page); check('20 songs' in t or 'did not fit' in t, f'5k: the second album only partly fits ({t})')
    g = gauges(page); check('20 songs' in g[0] or '0 left' in g[0], f'5k: side A holds at most 20 songs ({g[0]})')
    page.locator('.pk-addall').nth(2).tap(); page.wait_for_timeout(250)
    t = toast_text(page); check('20 songs' in t, f'5k: the 21st song is refused for count, not time ({t})')
    page.screenshot(path=f'{SHOTS}/5k-cap.png')
    errs2 = [e for e in errs]
    ctx.close()
    check(errs2 == [], f'5k: no page errors {errs2[:3]}')

def main():
    make_fixtures()
    with sync_playwright() as p:
        b = launch(p)
        only = os.environ.get('ONLY', '')      # ONLY=ux runs just the shelf / player UX checks, ONLY=layout just the full-screen geometry (both much faster than the real-audio run)
        if only in ('', 'layout'):
            if not only:
                for (w, h) in [(360, 780), (412, 915)]:
                    run_viewport(b, w, h)
            for (w, h) in [(360, 780), (412, 915), (915, 412)]:
                run_layout(b, w, h)
        if only in ('', 'ux'):
            for (w, h) in [(360, 780), (412, 915), (915, 412)]:
                run_ux(b, w, h)
        if not only:
            run_reduced(b)
            run_5k(b)
        b.close()
    print('\nFAILED:' if fails else '\nall checks passed', *fails, sep='\n  ' if fails else '')
    sys.exit(1 if fails else 0)

if __name__ == '__main__':
    main()
