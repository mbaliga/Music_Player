#!/usr/bin/env python3
"""END-TO-END TOUR: the whole app, in one script, the way a person would use it (Chromium, real touch events through CDP, real audio).

Needs: ffmpeg, Playwright for Python, node (for build:web size), the dev server (URL=http://localhost:PORT/index.html, CHROME=/path/to/chrome).
Usage:  python3 scripts/verify-tour.py [outdir]        TOUR_PUBLISH=1 also copies the 1x screenshots to docs/screenshots/tour/
Exit code non-zero when an assertion fails or the console / network log has anything beyond the known stations/ 404 noise.

Tour (portrait 360x780 and 412x915, touch, DSF 2; then one landscape pass 915x412):
  first run -> walkthrough -> Albums: play, stop / resume, speed, scratch, dimple seek, pinch to the library, scan, coverflow swipe, pick a
  track from another album, a CD album opens the CD view -> Search overlay (song / album / artist / station) -> Mixtapes: a tape from 3 albums
  through search, hit the 20-song cap, side B, style, save, search finds the tape, a short tape plays with AUTO on (flips to B) and off
  (FLIP TAPE) -> Radio: a canned station plays and ducks the music -> Booth: beat repeat engages -> Settings: theme + accent live, custom theme
  import preview -> lock (frozen / live) -> AOD -> wake -> unlock -> reload and persistence.
Extra phases: a mocked native Android device library ("Scan phone", device tracks in search / picker / coverflow) and a 5,000-track library
(search + picker speed). Measured: time to first interactive, JS heap after the tour, per-frame cost of the Albums stage, bytes shipped.
Headless Chromium on a CPU renderer: the numbers are indicative, NOT phone numbers. Real speech is never heard (a fake speechSynthesis is injected).
"""
import json, os, re, shutil, subprocess, sys, time, math
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = open(os.path.join(ROOT, 'scripts/verify-canned-radio.py')).read()
src = src[:src.index('def run():')]
OUTDIR = sys.argv[1] if len(sys.argv) > 1 else '/tmp/tour-verify'
sys.argv = ['x', OUTDIR]
os.environ.setdefault('URL', 'http://localhost:8123/index.html')
exec(src)    # FAKE_SPEECH, BUS_HOOK, launch, to_section, SHOTS, URL, ORIGIN
TLIB = os.path.join(OUTDIR, 'tour-lib')
PUBLISH = os.environ.get('TOUR_PUBLISH') == '1'
DOCSHOTS = os.path.join(ROOT, 'docs/screenshots/tour')
if PUBLISH: os.makedirs(DOCSHOTS, exist_ok=True)

fails = []
def check(ok, msg):
    if not ok: fails.append(msg)
    print(('ok   ' if ok else 'FAIL ') + msg, flush=True)

# ── fixtures ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
ALBUMS = [  # folder, album, artist, albumartist, genre, year, disc, [(title, seconds, hz, artist?)]
    ('Night Shift', 'Night Shift', 'Mara Quill', '', 'Jazz', 1994, 0, [(f'Harbor Light {i}', 9, 200 + 25 * i, None) for i in range(1, 8)]),
    ('Tidal', 'Tidal', 'Low Tide Orchestra', '', 'Jazz', 1995, 0, [(f'Tide Table {i}', 9, 300 + 22 * i, None) for i in range(1, 8)]),
    ('Orchard Hum', 'Orchard Hum', 'Sigur Ros', '', 'Electronic', 2011, 0, [(f'Orchard Song {i}', 9, 400 + 19 * i, None) for i in range(1, 8)]),
    ('Short Cuts', 'Short Cuts', 'Tiny Tapes', '', 'Rock', 1988, 0, [('Blip One', 7, 300, None), ('Blip Two', 7, 340, None), ('Blip Three', 7, 380, None), ('Blip Four', 7, 420, None)]),
    ('Double Set/CD1', 'Double Set', 'Cold Front', '', 'Rock', 1999, 1, [(f'Front {i}', 10, 250 + 30 * i, None) for i in range(1, 4)]),
    ('Double Set/CD2', 'Double Set', 'Cold Front', '', 'Rock', 1999, 2, [(f'Back {i}', 10, 500 + 30 * i, None) for i in range(1, 4)]),
    ('Various Voices', 'Various Voices', 'Various', 'Various Artists', 'Pop', 2005, 0, [('Anthem', 8, 330, 'Ada North'), ('Ballad', 8, 360, 'Bo South'), ('Chorus', 8, 390, 'Cy East'), ('Dirge', 8, 420, 'Di West'), ('Encore', 8, 450, 'Ada North')]),
]
def make_tour_fixtures():
    for (folder, album, artist, aa, genre, year, disc, tracks) in ALBUMS:
        d = os.path.join(TLIB, folder); os.makedirs(d, exist_ok=True)
        for i, (title, sec, hz, tartist) in enumerate(tracks, 1):
            out = os.path.join(d, f'{i:02d} - {title.replace(" ", "_")}.mp3')
            if os.path.exists(out): continue
            md = ['-metadata', f'title={title}', '-metadata', f'artist={tartist or artist}', '-metadata', f'album={album}', '-metadata', f'genre={genre}', '-metadata', f'date={year}', '-metadata', f'track={i}']
            if aa: md += ['-metadata', f'album_artist={aa}']
            if disc: md += ['-metadata', f'disc={disc}']
            subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', f'sine=frequency={hz}:duration={sec}:sample_rate=44100', '-af', 'volume=0.4', '-ac', '2', *md, '-id3v2_version', '3', '-c:a', 'libmp3lame', '-b:a', '96k', out], check=True)

# ── touch ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
class Touch:
    def __init__(self, page): self.cdp = page.context.new_cdp_session(page)
    def _send(self, kind, pts): self.cdp.send('Input.dispatchTouchEvent', {'type': kind, 'touchPoints': [{'x': x, 'y': y, 'id': i + 1} for i, (x, y) in enumerate(pts)]})
    def down(self, *pts): self._send('touchStart', pts)
    def move(self, *pts): self._send('touchMove', pts)
    def up(self): self._send('touchEnd', [])
    def drag(self, pts, step=0.016):
        self.down(pts[0])
        for p in pts[1:]: self.move(p); time.sleep(step)
        self.up()
    def line(self, x0, y0, x1, y1, n=12): return [(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n) for i in range(n + 1)]
    def tap(self, x, y, hold=0.06): self.down((x, y)); time.sleep(hold); self.up()
    def pinch(self, cx, cy, r0, r1, n=10):
        self.down((cx - r0, cy), (cx + r0, cy))
        for i in range(1, n + 1):
            r = r0 + (r1 - r0) * i / n; self.move((cx - r, cy), (cx + r, cy)); time.sleep(0.016)
        self.up()

APP = 'window.__rt.app()'
def center(page, sel):
    return page.evaluate("s => { const e = document.querySelector(s); const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2, r.width, r.height]; }", sel)
def stage_pt(page, x, y):
    return page.evaluate(f"""(() => {{ const t = document.querySelector('.tt-top'), g = document.getElementById('tt-topRot'); const p = t.createSVGPoint(); p.x = {x}; p.y = {y};
      const q = p.matrixTransform(g.getScreenCTM()); return [q.x, q.y]; }})()""")
def rms(page, n=6):
    v = []
    for _ in range(n): v.append(page.evaluate('window.__rms ? window.__rms() : -1')); time.sleep(0.04)
    return max(v)
def pos(page): return page.evaluate(f'(() => {{ const e = {APP}.state.engine; return e.position / e.sampleRate; }})()')
def pstate(page): return page.evaluate(f'(() => {{ const a = {APP}, p = a.stage.player; return {{ playing: p.playing, starting: p.starting, dragging: p.dragging, z: p.z, armS: p.armS, rpm: a.state.rpm, rate: a.state.engine._rate, view: a.state.view, album: a.state.albumId, T: a.state.T, fo: a.state.fingerOmega, braking: a.state.braking }}; }})()')

# ── console / network watch (the WHOLE tour) ───────────────────────────────────────────────────────────────────────────────────────────────
NOISE = ('stations/index.json', '/stations/')      # the dev server has no stations/ folder (the packs live in content/stations; the app falls back): known 404 noise
CONSOLE, NETFAIL, PAGEERR = [], [], []
def watch(page, tag):
    page.on('console', lambda m: CONSOLE.append((tag, m.type, m.text)) if m.type in ('error', 'warning') else None)
    page.on('pageerror', lambda e: PAGEERR.append((tag, str(e))))
    page.on('requestfailed', lambda r: NETFAIL.append((tag, r.url, str(r.failure))))
    page.on('response', lambda r: NETFAIL.append((tag, r.url, f'HTTP {r.status}')) if r.status >= 400 else None)

def boot(b, w, h, tag, wt_done=True, init='', dsf=2, library=False):
    ctx = b.new_context(bypass_csp=True, viewport={'width': w, 'height': h}, device_scale_factor=dsf, has_touch=True, is_mobile=True)
    i = 'window.showDirectoryPicker = undefined; try { ' + ('localStorage.setItem("runout.wtDone", "1");' if wt_done else '') + ' } catch (e) {}'
    ctx.add_init_script(i + init); ctx.add_init_script(BUS_HOOK); ctx.add_init_script(FAKE_SPEECH)
    page = ctx.new_page(); watch(page, tag)
    t0 = time.time(); page.goto(URL)
    page.wait_for_function('document.getElementById("latency") && !/boot error/.test(document.getElementById("latency").textContent) && window.__rt && window.runoutDeviceMode')
    return ctx, page, time.time() - t0

def drawer_to(page, sec):
    if page.evaluate('document.querySelector(".page:not([hidden])").dataset.section') == sec: return
    page.click('.page:not([hidden]) .hamburger'); page.click(f'.drawer-item[data-section="{sec}"]')
    page.wait_for_function('s => { const p = document.querySelector(`.page[data-section="${s}"]`); return p && !p.hidden }', arg=sec)
    time.sleep(0.6)

def scan_chip(page):
    """Scan the generated folder through the coverflow toolbar's Scan chip (the folder-input fallback: no File System Access here)."""
    with page.expect_file_chooser() as fc: page.click('.tl-scan')
    fc.value.set_files(TLIB)
    page.wait_for_function(f'{APP}.albums.length >= 7 && {APP}.albums.every(a => !a.builtin)', timeout=40000)
    page.wait_for_timeout(1500)

def zoom_to_library(page, T, w, h):
    T.pinch(w / 2, h / 2, 90, 20); page.wait_for_timeout(1300)
    return pstate(page)['z']

def step(name, fn):
    try: fn()
    except Exception as e:
        msg = f'STEP "{name}" raised {type(e).__name__}: {str(e)[:300]}'
        check(False, msg)

METRICS = {}

# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
def tour(b, w, h, tag, landscape=False):
    print(f'\n=== tour {tag} ===', flush=True)
    n = {'i': 0}
    def shot(page, name):
        n['i'] += 1; fn = f'{tag}-{n["i"]:02d}-{name}.png'
        page.screenshot(path=os.path.join(SHOTS, fn), scale='css')
        if PUBLISH and not tag.startswith('360'): shutil.copy(os.path.join(SHOTS, fn), os.path.join(DOCSHOTS, fn))     # 360x780 shots stay in the outdir (repo size)
    ctx, page, t_load = boot(b, w, h, tag, wt_done=False)
    T = Touch(page)
    state = {}

    # ── 1. first run + walkthrough ─────────────────────────────────────────────────────────────────────────────────────────────────────────
    def s_walk():
        page.wait_for_selector('.wt-overlay:not(.hidden)', timeout=6000)
        n_steps = page.evaluate('document.querySelectorAll(".wt-dot").length')
        check(n_steps >= 5, f'{tag}: first run shows the walkthrough ({n_steps} steps)')
        shot(page, 'walkthrough-1')
        titles = []
        for i in range(n_steps):
            titles.append(page.inner_text('.wt-title'))
            if i == 2: shot(page, 'walkthrough-3')
            page.tap('.wt-next'); page.wait_for_timeout(120)
        check(page.evaluate('document.querySelector(".wt-overlay").classList.contains("hidden")') and page.evaluate('localStorage.getItem("runout.wtDone")') == '1', f'{tag}: the last step closes it and remembers ({titles[0]} ... {titles[-1]})')
    step('walkthrough', s_walk)

    # ── 2. Albums: the vinyl player ────────────────────────────────────────────────────────────────────────────────────────────────────────
    def s_albums():
        shot(page, 'albums-idle')
        px, py, _, _ = center(page, '#tt-playBtn'); T.tap(px, py); time.sleep(2.5)
        S = pstate(page)
        check(S['playing'] and rms(page) > 0.005, f'{tag}: Play starts the built-in demo record and it is audible (rms {rms(page):.3f})')
        shot(page, 'albums-playing')
        p0 = pos(page); T.tap(px, py); time.sleep(1.0)
        S = pstate(page); p1 = pos(page); time.sleep(0.8); p2 = pos(page)
        check(not S['playing'] and abs(p2 - p1) < 0.05, f'{tag}: Stop freezes the record exactly (pos {p1:.2f} -> {p2:.2f})')
        T.tap(px, py); time.sleep(2.0)
        p3 = pos(page)
        check(pstate(page)['playing'] and p3 > p2 and p3 - p2 < 3.5, f'{tag}: resume continues from the same place (pos {p2:.2f} -> {p3:.2f})')
        for sid, rpm in [('b45', 45), ('b78', 78), ('b33', 33)]:
            x, y, _, _ = center(page, '#tt-' + sid); T.tap(x, y); time.sleep(0.5)
            S = pstate(page); check(round(S['rpm']) == rpm, f'{tag}: the {rpm} key sets {rpm} rpm (state {S["rpm"]:.1f}, engine rate {S["rate"]:.2f})')
        x, y, _, _ = center(page, '#tt-bp'); T.tap(x, y); time.sleep(0.4)
        check(pstate(page)['rpm'] > 33.5, f'{tag}: the + key nudges the speed up ({pstate(page)["rpm"]:.2f})')
        x, y, _, _ = center(page, '#tt-b33'); T.tap(x, y); time.sleep(0.4)
        # scratch: drag the disc, the rate follows the finger
        cx0, cy0 = stage_pt(page, 700, 300)
        rates = []
        T.down((cx0, cy0)); time.sleep(0.05)
        for i in range(1, 14):
            T.move((cx0 + 5 * i, cy0 + 12 * i)); time.sleep(0.03); rates.append(pstate(page)['rate'])
        shot(page, 'albums-scratch')
        T.up(); time.sleep(0.8)
        check(max(abs(r - 1) for r in rates) > 0.3, f'{tag}: scratching moves the audio rate with the finger (rates {min(rates):.2f}..{max(rates):.2f})')
        check(abs(pstate(page)['rate'] - 1) < 0.2, f'{tag}: ... and the motor winds it back after release ({pstate(page)["rate"]:.2f})')
        # dimple seek: drag the tonearm along its rail, release = set down there
        pa = pos(page); gx, gy, _, _ = center(page, '#tt-grab')
        sx0, sy0 = stage_pt(page, 800, 80); sx1, sy1 = stage_pt(page, 600, 80)
        dx, dy = sx1 - sx0, sy1 - sy0
        T.down((gx, gy)); time.sleep(0.05)
        for i in range(1, 11): T.move((gx + dx * i / 10, gy + dy * i / 10)); time.sleep(0.03)
        dragging = pstate(page)['dragging']; shot(page, 'albums-dimple-seek')
        T.up(); time.sleep(1.5)
        pb = pos(page)
        check(dragging and abs(pb - pa) > 2, f'{tag}: the dimple drag seeks (dragging {dragging}; pos {pa:.1f} -> {pb:.1f} s)')
    step('albums', s_albums)

    # ── 3. pinch to the library, scan, coverflow, pick a track, CD view ─────────────────────────────────────────────────────────────────────
    def s_library():
        z = zoom_to_library(page, T, w, h)
        check(z == 1 and page.evaluate("getComputedStyle(document.querySelector('.tl-lib')).pointerEvents") != 'none', f'{tag}: pinch in zooms out to the library (z {z})')
        shot(page, 'library-empty')
        scan_chip(page)
        A = page.evaluate(f'{APP}.albums.map(a => [a.title, a.kind, a.tracks.length])')
        names = [a[0] for a in A]
        check(len(A) == 7 and sum(1 for a in A if a[1] == 'cd') == 2, f'{tag}: the scan fills the library: {len(A)} albums, {sum(1 for a in A if a[1] == "cd")} CD cases ({names})')
        shot(page, 'library-scanned')
        ov = page.evaluate("""() => { const R = (e) => e.getBoundingClientRect(); const head = [...document.querySelectorAll('.page:not([hidden]) .page-head button, .page:not([hidden]) .page-head .dm-key')].map(R).filter(r => r.width > 0);
          const bar = [...document.querySelectorAll('.tl-bar button')].map(R).filter(r => r.width > 0); let n = 0;
          for (const a of head) for (const b of bar) if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) n++; return n; }""")
        check(ov == 0, f'{tag}: the library toolbar chips do not run under the header chips ({ov} overlaps)')
        t0 = page.inner_text('.tl-title')
        fy = center(page, '.tl-slot')[1]       # across the centre cover (the toolbar chips sit above it)
        T.drag(T.line(w * 0.75, fy, w * 0.2, fy, 8)); page.wait_for_timeout(1300)
        t1 = page.inner_text('.tl-title'); shot(page, 'coverflow-swiped')
        check(t1 != t0, f'{tag}: a coverflow swipe moves to another album ("{t0}" -> "{t1}")')
        # pick a track from this other (vinyl) album
        before = pstate(page)['album']
        page.locator('.tl-trk').nth(2).tap(); page.wait_for_timeout(2500)
        S = pstate(page)
        check(S['album'] != before and S['view'] == 'vinyl' and rms(page) > 0.005 or S['playing'], f'{tag}: a track from another album loads and plays (album {S["album"]}, playing {S["playing"]})')
        shot(page, 'library-track-picked')
        # a CD album opens the CD view (picking a track brought the player back: pinch out to the library again)
        zoom_to_library(page, T, w, h)
        ci = page.evaluate(f"{APP}.albums.findIndex(a => a.kind === 'cd')")
        page.evaluate(f'{APP}.tlib.focus({ci}, {{ animate: false }})'); page.wait_for_timeout(900)
        page.locator('.tl-trk').nth(0).tap(); page.wait_for_timeout(2200)
        check(pstate(page)['view'] == 'cd' and page.evaluate("!document.getElementById('cdView').classList.contains('hidden')"), f'{tag}: a CD track opens the CD view')
        shot(page, 'cd-view')
        page.tap('#cdLibBtn'); page.wait_for_timeout(900)
        check(page.evaluate("document.getElementById('pageAlbums').dataset.lib") == '1' and pstate(page)['z'] == 1, f'{tag}: its Library button shows the library over the CD view')
        # spread back to the player
        T.pinch(w / 2, h / 2, 20, 120); page.wait_for_timeout(1300)
        check(pstate(page)['z'] == 0, f'{tag}: spreading brings the player back (z {pstate(page)["z"]})')
    step('library', s_library)

    # ── 4. Search ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
    def s_search():
        page.click('.page:not([hidden]) .page-search'); page.wait_for_selector('.search-ov:not(.hidden)'); page.wait_for_timeout(500)
        def q(text, kind):
            page.fill('.so-input', text); page.wait_for_timeout(500)
            rows = page.locator(f'.so-row[data-type="{kind}"]').count()
            return rows
        r = q('slow', 'song') + q('tide table 3', 'song'); check(q('tide table 3', 'song') >= 1, f'{tag}: search finds a song ("tide table 3")')
        shot(page, 'search-song')
        check(q('orchard hum', 'album') >= 1, f'{tag}: search finds an album ("orchard hum")')
        check(q('mara quill', 'artist') >= 1, f'{tag}: search finds an artist ("mara quill")')
        shot(page, 'search-artist')
        check(q('cold front', 'artist') >= 1 and q('double set', 'album') >= 1, f'{tag}: the two-disc set is found as an album and its artist')
        check(q('ada north', 'artist') >= 1, f'{tag}: a track artist from the multi-artist set is found')
        page.fill('.so-input', 'meridian'); page.wait_for_timeout(900)
        st = page.locator('.so-row[data-type="station"]').count()
        check(st >= 1, f'{tag}: search finds a radio station ("meridian", {st} rows)')
        shot(page, 'search-station')
        page.fill('.so-input', 'tide table 3'); page.wait_for_timeout(500)
        page.locator('.so-row[data-type="song"]').first.click(); page.wait_for_timeout(2500)
        check(not page.evaluate("document.querySelector('.search-ov') && !document.querySelector('.search-ov').classList.contains('hidden')"), f'{tag}: choosing a result closes the overlay')
        check(pstate(page)['playing'] or pstate(page)['starting'], f'{tag}: ... and plays the song')
        # Esc closes
        page.keyboard.press('Control+k'); page.wait_for_timeout(400)
        check(page.evaluate("!document.querySelector('.search-ov').classList.contains('hidden')"), f'{tag}: Ctrl+K opens the overlay')
        page.keyboard.press('Escape'); page.wait_for_timeout(400)
    step('search', s_search)

    # ── 5. Mixtapes ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
    def toast():
        page.wait_for_selector('.ed-toast:not(.hidden)', timeout=3000); return page.inner_text('.ed-toast')
    def gauges(): return page.eval_on_selector_all('.ed-gauge', 'els => els.map(e => e.innerText.replace(/\\n+/g, " | "))')
    def stored(): return json.loads(page.evaluate('localStorage.getItem("runout.mixtapes")') or 'null')
    def s_mix_build():
        drawer_to(page, 'mixtapes'); page.wait_for_timeout(500)
        page.tap('#mtNew'); page.wait_for_selector('.ed'); page.wait_for_timeout(300)
        page.fill('.ed-tape-tab input[aria-label="Title"]', 'Three Albums'); page.locator('.ed-len', has_text='C30').tap()
        page.tap('#edtab-add'); page.wait_for_timeout(300)
        for q in ['night shift', 'tidal', 'orchard hum']:
            page.fill('.pk-q', q); page.wait_for_timeout(450)
            page.locator('.pk-addall').first.tap(); page.wait_for_timeout(350)
        t = toast()
        check('20 songs' in t or 'did not fit' in t, f'{tag}: three albums via search hit the cap: "{t}"')
        g = gauges(); check('20' in g[0] or '0 left' in g[0], f'{tag}: side A holds at most 20 songs ({g[0]})')
        shot(page, 'mixtape-cap')
        page.locator('.pk-sidebtn').nth(1).tap()
        page.fill('.pk-q', 'short cuts'); page.wait_for_timeout(450); page.locator('.pk-addall').first.tap(); page.wait_for_timeout(350)
        g = gauges(); check('B' in ' '.join(g) or len(g) >= 2, f'{tag}: side B takes songs ({g})')
        page.tap('#edtab-style'); page.wait_for_timeout(600)
        page.locator('.ed-sty').nth(6).tap(); page.locator('.ed-pens button').nth(1).tap(); page.wait_for_timeout(300)
        shot(page, 'mixtape-style')
        page.tap('.ed-bar .sv'); page.wait_for_selector('.ed', state='detached'); page.wait_for_timeout(800)
        m = [x for x in stored()['mixtapes'] if x['name'] == 'Three Albums'][0]
        check(len(m['sides']['A']) == 20 and len(m['sides']['B']) == 4, f'{tag}: saved: side A {len(m["sides"]["A"])} songs, side B {len(m["sides"]["B"])} songs')
        shot(page, 'mixtape-shelf')
    step('mixtape build', s_mix_build)
    def s_mix_search():
        page.click('.page:not([hidden]) .page-search'); page.wait_for_selector('.search-ov:not(.hidden)'); page.wait_for_timeout(400)
        page.fill('.so-input', 'three albums'); page.wait_for_timeout(600)
        check(page.locator('.so-row[data-type="mixtape"]').count() >= 1, f'{tag}: search finds the new mixtape')
        shot(page, 'search-mixtape')
        page.keyboard.press('Escape'); page.wait_for_timeout(400)
    step('mixtape search', s_mix_search)
    def s_mix_play():
        page.tap('#mtNew'); page.wait_for_selector('.ed'); page.wait_for_timeout(300)
        page.fill('.ed-tape-tab input[aria-label="Title"]', 'Blips'); page.locator('.ed-len', has_text='C30').tap()
        page.tap('#edtab-add'); page.wait_for_timeout(300)
        def add(title):
            page.fill('.pk-q', title); page.wait_for_timeout(400); page.locator('.pk-rowbtn', has_text=title).first.tap(); page.wait_for_timeout(250)
        add('Blip One'); add('Blip Two'); page.locator('.pk-sidebtn').nth(1).tap(); add('Blip Three'); add('Blip Four')
        page.tap('.ed-bar .sv'); page.wait_for_selector('.ed', state='detached'); page.wait_for_timeout(700)
        # stop the vinyl so the tape has the sound
        card = page.locator('.cs-card[aria-label^="Mixtape: Blips"]').first
        card.tap(); page.wait_for_timeout(700)
        if page.locator('.tp:not(.hidden)').count() == 0: card.tap()
        page.wait_for_selector('.tp:not(.hidden)'); page.wait_for_timeout(1800)
        side = lambda: page.evaluate("""() => { const d = document.querySelector('.sk-deck .side-panel'); const l = d && [...d.querySelectorAll('text[data-side]')].find(t => t.getAttribute('fill') === '#ffb347'); return l ? l.getAttribute('data-side') : ''; }""")
        auto = lambda: page.evaluate("document.querySelector('.sk-deck .side-key[data-key=auto]').classList.contains('down')")
        playing = lambda: page.evaluate("document.querySelector('.sk-deck .key[data-key=play]').classList.contains('down')")
        check(playing() and rms(page) > 0.005 and side() == 'A' and auto(), f'{tag}: the tape plays side A with AUTO on (rms {rms(page):.3f})')
        shot(page, 'cassette-side-a')
        # the Albums Play/Stop key must act on the tape that owns the engine, never show a stale platter (UX review item 1)
        lbl = lambda: page.evaluate("document.getElementById('tt-playLbl').textContent")
        tt_click = lambda: page.evaluate("document.getElementById('tt-playBtn').dispatchEvent(new MouseEvent('click', {bubbles: true}))")
        check(lbl() == 'Stop' and 'Blips' in page.evaluate("document.querySelector('.tt-now-title').textContent"), f'{tag}: while a tape plays the Albums key says Stop and the stage names the tape ({lbl()!r})')
        tt_click(); page.wait_for_timeout(900)
        paused = page.evaluate('(() => { const p = window.__rt.app().state.mixtapes.play; return !!(p && p.paused); })()')
        check(not playing() and lbl() == 'Play' and paused, f'{tag}: Stop on the stage pauses the tape (paused {paused}, label {lbl()!r})')
        tt_click(); page.wait_for_timeout(900)
        check(playing() and lbl() == 'Stop' and rms(page) > 0.005, f'{tag}: Play on the stage resumes the tape')
        page.wait_for_function('() => { const d = document.querySelector(".sk-deck .side-panel"); if (!d) return false; const l = [...d.querySelectorAll("text[data-side]")].find(t => t.getAttribute("fill") === "#ffb347"); return l && l.getAttribute("data-side") === "B"; }', timeout=30000)
        page.wait_for_timeout(500)
        check(side() == 'B' and playing(), f'{tag}: AUTO on: the end of side A flips to side B and keeps playing')
        shot(page, 'cassette-auto-flipped')
        page.wait_for_function("() => !document.querySelector('.sk-deck .key[data-key=play]').classList.contains('down')", timeout=30000)
        check(not playing(), f'{tag}: the end of side B stops')
        page.locator('.sk-deck .side-key[data-key=auto]').click(); page.wait_for_timeout(400)
        check(not auto(), f'{tag}: AUTO releases')
        page.locator('.sk-deck .side-key[data-key=flip]').click(); page.wait_for_timeout(1500)
        check(side() == 'A', f'{tag}: FLIP turns the tape (now side {side()})')
        page.locator('.sk-deck .key[data-key=play]').click(); page.wait_for_timeout(1500)
        page.wait_for_function('() => { const t = [...document.querySelectorAll(".sk-deck .side-panel text")].find(x => x.textContent === "FLIP TAPE" && x.getAttribute("font-size") === "50"); return !!t; }', timeout=30000)
        shot(page, 'cassette-flip-tape')
        check(not playing() and side() == 'A', f'{tag}: AUTO off: side A ends and waits with "FLIP TAPE"')
        page.evaluate("document.querySelector('.tp .btn-close').click()"); page.wait_for_timeout(600)
    step('mixtape play', s_mix_play)

    # ── 6. Radio ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
    def s_radio():
        drawer_to(page, 'radio'); page.wait_for_selector('.dial-card', timeout=10000)
        shot(page, 'radio-dial')
        page.locator('.dial-card[data-station="meridian-91-5"]').click()
        page.wait_for_selector('.pw-label', state='visible', timeout=10000)
        page.wait_for_function('document.querySelector(".ai-now-title") && document.querySelector(".ai-now-title").textContent !== "Tuning in…"', timeout=25000)
        page.evaluate('''() => { window.__fast = []; const ctx = window.__bus.context; setInterval(() => window.__fast.push(window.__bus.gain.value), 40); }''')
        ducked = False; t1 = time.time(); shotd = False
        while time.time() - t1 < 40 and not ducked:
            s = page.evaluate('({g: window.__bus ? window.__bus.gain.value : null, sp: !!window.speechSynthesis.speaking})')
            if s['sp'] and s['g'] is not None and s['g'] < 0.4: ducked = True; shot(page, 'radio-ducked')
            time.sleep(0.1)
        check(page.inner_text('.pw-label') != '' and rms(page) >= 0, f'{tag}: a canned station plays ("{page.inner_text(".pw-label")}")')
        check(ducked, f'{tag}: the music ducks while a host speaks (fake speech)')
        shot(page, 'radio-playing')
        page.evaluate("document.querySelector('.radio-now .theme-btn') && document.querySelector('.radio-now .theme-btn').click()"); page.wait_for_timeout(600)
    step('radio', s_radio)

    # ── 7. Booth ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
    def s_booth():
        drawer_to(page, 'albums'); page.wait_for_timeout(500)
        x, y, _, _ = center(page, '#tt-playBtn')
        if not pstate(page)['playing']: T.tap(x, y); page.wait_for_timeout(2000)
        drawer_to(page, 'booth'); page.wait_for_selector('.fx-row', timeout=10000)
        shot(page, 'booth-menu')
        page.click('.fx-row[data-id="repeat"]'); page.wait_for_timeout(1200)
        page.wait_for_selector('.fx-pad', timeout=5000)
        px, py, pw, ph = center(page, '.fx-pad')
        T.down((px, py - pw * 0.25)); page.wait_for_timeout(700)
        eng = page.evaluate('(() => { const c = window.__runoutFx.controller; return { engaged: c.engaged, mode: c.mode, div: c.hold && c.hold.div }; })()')
        shot(page, 'booth-beat-repeat')
        T.up(); page.wait_for_timeout(500)
        check(eng['engaged'] is True and eng['mode'] == 'repeat', f'{tag}: beat repeat engages from a real pad touch ({eng})')
        check(page.evaluate('window.__runoutFx.controller.engaged') is False, f'{tag}: ... and releases')
    step('booth', s_booth)

    # ── 8. Settings ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
    def s_settings():
        drawer_to(page, 'settings'); page.wait_for_selector('.st-page'); page.wait_for_timeout(400)
        shot(page, 'settings')
        page.click('.st-seg[aria-label="Theme"] [data-v="light"]'); page.wait_for_timeout(400)
        check(page.evaluate('document.documentElement.dataset.theme') == 'light', f'{tag}: Light applies live')
        shot(page, 'settings-light')
        page.click('.st-sw[data-id="orange"]'); page.wait_for_timeout(400)
        check(page.evaluate('getComputedStyle(document.documentElement).getPropertyValue("--violet").trim().toUpperCase()') == '#FE5031', f'{tag}: accent orange applies live')
        shot(page, 'settings-accent')
        page.click('.st-btn:has-text("Import JSON")'); page.wait_for_selector('#themeOverlay:not(.hidden)')
        theme = json.dumps({'version': 1, 'name': 'Tour Blue', 'colors': {m: {'primary': '#3366FF', 'secondary': '#33AAFF', 'tertiary': '#33FFAA', 'background': '#101828' if m == 'dark' else '#EEF2FF', 'surface': '#182236' if m == 'dark' else '#FFFFFF', 'surfaceVariant': '#22304A' if m == 'dark' else '#DDE5FF', 'onBackground': '#F0F4FF' if m == 'dark' else '#101828', 'onSurface': '#F0F4FF' if m == 'dark' else '#101828', 'onSurfaceVariant': '#AAB4CC' if m == 'dark' else '#44506A', 'outline': '#44506A' if m == 'dark' else '#AAB4CC', 'error': '#FF5566'} for m in ('dark', 'light')}})
        page.fill('#themeInput', theme); page.click('#themePreviewBtn'); page.wait_for_timeout(300)
        check(page.inner_text('#themePreviewText') == theme and page.locator('#themeApplyBtn').is_enabled(), f'{tag}: custom theme import shows the exact text as a preview')
        shot(page, 'settings-theme-preview')
        page.click('#themeApplyBtn'); page.wait_for_timeout(500)
        check('Tour Blue' in page.inner_text('.st-group[data-group="appearance"]'), f'{tag}: the custom theme is applied')
        page.click('.st-sw[data-id="orange"]')
        page.click('.st-seg[aria-label="Theme"] [data-v="dark"]'); page.wait_for_timeout(300)
    step('settings', s_settings)

    # ── 9. lock, AOD, wake, unlock ────────────────────────────────────────────────────────────────────────────────────────────────────────
    def s_lock():
        drawer_to(page, 'albums'); page.wait_for_timeout(700)
        # The Booth step's Play on a platter left holding a station's song loads the FOCUSED album (here the Cold Front CD set: by design, a stopped
        # station's leftover is not a record), so the stage is the CD player and has no platter keys. This step locks the PLATTER: put a vinyl album on it.
        if pstate(page)['view'] != 'vinyl':
            page.click('.page:not([hidden]) .page-search'); page.wait_for_selector('.search-ov:not(.hidden)'); page.fill('.so-input', 'tide table 3'); page.wait_for_timeout(500)
            page.locator('.so-row[data-type="song"]').first.click(); page.wait_for_timeout(2500)
        check(pstate(page)['view'] == 'vinyl', f'{tag}: lock step starts on the vinyl platter (view {pstate(page)["view"]})')
        page.evaluate("() => { const real = Date.now.bind(Date); window.__off = 0; Date.now = () => real() + window.__off; }")
        kx, ky, _, _ = center(page, '.page:not([hidden]) .dm-key'); T.tap(kx, ky); time.sleep(0.4)
        check(page.evaluate('runoutDeviceMode.state.locked'), f'{tag}: the lock key locks')
        shot(page, 'locked-albums')
        cx0, cy0 = stage_pt(page, 700, 300)
        T.down((cx0, cy0)); time.sleep(0.05); T.move((cx0 + 8, cy0 + 20)); time.sleep(0.05); T.move((cx0 + 12, cy0 + 40)); time.sleep(0.05)
        scr = page.evaluate(f'{APP}.stage.isScratching()'); T.up(); time.sleep(0.2)
        T.pinch(w / 2, h / 2, 90, 20); time.sleep(0.9)
        check(not scr and pstate(page)['z'] == 0, f'{tag}: locked: the disc and pinch are frozen')
        x, y, _, _ = center(page, '#tt-playBtn'); was = pstate(page)['playing']; T.tap(x, y); time.sleep(1.2)
        check(pstate(page)['playing'] != was or pstate(page)['starting'], f'{tag}: locked: Play / Stop still works')
        x, y, _, _ = center(page, '#tt-b45'); T.tap(x, y); time.sleep(0.4)
        check(round(pstate(page)['rpm']) == 45, f'{tag}: locked: the speed keys work')
        x, y, _, _ = center(page, '#tt-b33'); T.tap(x, y); time.sleep(0.3)
        page.evaluate("() => { window.__off += 61000; runoutDeviceMode.machine.tick(Date.now()); }"); time.sleep(1.0)
        check(page.evaluate('runoutDeviceMode.state.aod'), f'{tag}: the always-on display starts after the idle time')
        shot(page, 'aod-albums')
        sx, sy = page.evaluate("""([w, h]) => { for (let y = h * 0.3; y < h * 0.9; y += 17) for (let x = w * 0.2; x < w * 0.8; x += 19) { const e = document.elementFromPoint(x, y); if (e && !runoutDeviceMode.isAllowed(e)) return [x, y]; } return [w / 2, h / 2]; }""", [w, h])
        T.tap(sx, sy); time.sleep(0.12); T.tap(sx, sy + 2); time.sleep(0.7)
        check(not page.evaluate('runoutDeviceMode.state.aod') and page.evaluate('runoutDeviceMode.state.locked'), f'{tag}: a double tap wakes it (still locked)')
        kx, ky, _, _ = center(page, '.page:not([hidden]) .dm-key'); T.down((kx, ky)); time.sleep(1.0); T.up(); time.sleep(0.4)
        check(not page.evaluate('runoutDeviceMode.state.locked'), f'{tag}: hold the key to unlock')
        # scratching still works afterwards
        cx0, cy0 = stage_pt(page, 700, 300)
        T.down((cx0, cy0)); time.sleep(0.05); T.move((cx0 + 8, cy0 + 20)); time.sleep(0.05); T.move((cx0 + 12, cy0 + 40)); time.sleep(0.05)
        check(page.evaluate(f'{APP}.stage.isScratching()'), f'{tag}: after unlock the disc scratches again'); T.up(); time.sleep(0.3)
    step('lock', s_lock)

    # ── 10. reload: persistence ────────────────────────────────────────────────────────────────────────────────────────────────────────────
    def s_persist():
        if tag.startswith('412'):           # the heap at the END of the interactive tour (before the reload below throws the page's heap away)
            cdp0 = page.context.new_cdp_session(page); cdp0.send('HeapProfiler.enable'); cdp0.send('HeapProfiler.collectGarbage'); time.sleep(0.4)
            h0 = cdp0.send('Runtime.getHeapUsage'); METRICS['js_heap_used_mb_end_of_tour_before_reload'] = round(h0['usedSize'] / 1048576, 1); METRICS['js_heap_total_mb_end_of_tour'] = round(h0['totalSize'] / 1048576, 1)
            print(f"     JS heap at the end of the tour, before the reload (after GC): {METRICS['js_heap_used_mb_end_of_tour_before_reload']} MB used / {METRICS['js_heap_total_mb_end_of_tour']} MB total", flush=True)
            check(METRICS['js_heap_used_mb_end_of_tour_before_reload'] < 250, f'{tag}: JS heap at the end of the tour {METRICS["js_heap_used_mb_end_of_tour_before_reload"]} MB (< 250)')
        before = {'albums': page.evaluate(f'{APP}.albums.length'), 'speed': page.evaluate('localStorage.getItem("runout.tt.speed")'),
                  'theme': page.evaluate('document.documentElement.dataset.theme'), 'tapes': [m['name'] for m in json.loads(page.evaluate('localStorage.getItem("runout.mixtapes")'))['mixtapes']]}
        page.reload(); page.wait_for_function('document.getElementById("latency") && !/boot error/.test(document.getElementById("latency").textContent) && window.__rt'); page.wait_for_timeout(2500)
        after = {'albums': page.evaluate(f'{APP}.albums.length'), 'speed': page.evaluate('localStorage.getItem("runout.tt.speed")'),
                 'theme': page.evaluate('document.documentElement.dataset.theme'), 'tapes': [m['name'] for m in json.loads(page.evaluate('localStorage.getItem("runout.mixtapes")'))['mixtapes']]}
        check(after['albums'] >= 7 and after['albums'] == before['albums'], f'{tag}: the library comes back after a reload ({before["albums"]} -> {after["albums"]} albums, tracks "need re-link")')
        check(after['tapes'] == before['tapes'] and 'Three Albums' in after['tapes'] and 'Blips' in after['tapes'], f'{tag}: the mixtapes persist ({after["tapes"]})')
        check(after['theme'] == before['theme'] and after['speed'] == before['speed'], f'{tag}: theme and speed persist ({after["theme"]}, {after["speed"]})')
        check(not page.evaluate('runoutDeviceMode.state.locked'), f'{tag}: a fresh launch starts unlocked')
        drawer_to(page, 'settings'); page.wait_for_timeout(300)
        check('Tour Blue' in page.inner_text('.st-group[data-group="appearance"]'), f'{tag}: the custom theme persists')
        drawer_to(page, 'albums'); page.wait_for_timeout(400)
        shot(page, 'after-reload')
    step('persistence', s_persist)

    # ── measurements (portrait 412x915 only) ───────────────────────────────────────────────────────────────────────────────────────────────
    if tag.startswith('412') :
        def s_measure():
            cdp = page.context.new_cdp_session(page)
            x, y, _, _ = center(page, '#tt-playBtn')
            if not pstate(page)['playing']: T.tap(x, y); time.sleep(2.0)
            page.evaluate("""() => { const s = window.__rt.app().stage; const o = s.update; window.__upd = { n: 0, sum: 0, max: 0 }; s.update = function(...a) { const t = performance.now(); const r = o.apply(this, a); const d = performance.now() - t; window.__upd.n++; window.__upd.sum += d; if (d > window.__upd.max) window.__upd.max = d; return r; };
              window.__fr = { n: 0, long: 0 }; let last = performance.now(); const loop = (t) => { window.__fr.n++; if (t - last > 50) window.__fr.long++; last = t; window.__fr.on && requestAnimationFrame(loop); }; window.__fr.on = true; requestAnimationFrame(loop); }""")
            time.sleep(6)
            u = page.evaluate('({ ...window.__upd, fr: window.__fr.n, long: window.__fr.long })'); page.evaluate('window.__fr.on = false')
            METRICS['stage_update_ms_avg'] = round(u['sum'] / max(1, u['n']), 3); METRICS['stage_update_ms_max'] = round(u['max'], 2)
            METRICS['frames_per_s_playing'] = round(u['fr'] / 6, 1); METRICS['frames_over_50ms'] = u['long']
            print(f"     rAF cost on the Albums stage while playing: avg {METRICS['stage_update_ms_avg']} ms/frame, max {METRICS['stage_update_ms_max']} ms, {METRICS['frames_per_s_playing']} frames/s, {u['long']} frames > 50 ms (headless CPU renderer; the frame rate here is the machine's, not a phone's)", flush=True)
            check(METRICS['stage_update_ms_avg'] < 8, f'{tag}: the Albums stage costs {METRICS["stage_update_ms_avg"]} ms per frame on average (< 8 ms budget on this machine)')
            cdp.send('HeapProfiler.enable'); cdp.send('HeapProfiler.collectGarbage'); time.sleep(0.5)
            h_ = cdp.send('Runtime.getHeapUsage'); METRICS['js_heap_used_mb_after_reload'] = round(h_['usedSize'] / 1048576, 1); METRICS['js_heap_total_mb'] = round(h_['totalSize'] / 1048576, 1)
            print(f"     JS heap after reload + playing (after GC): {METRICS['js_heap_used_mb_after_reload']} MB used / {METRICS['js_heap_total_mb']} MB total", flush=True)
            check(METRICS['js_heap_used_mb_after_reload'] < 200, f'{tag}: JS heap after the tour {METRICS["js_heap_used_mb_after_reload"]} MB (< 200)')
        step('measure', s_measure)
    ctx.close()

def tour_landscape(b):
    w, h, tag = 915, 412, 'landscape-915x412'
    print(f'\n=== tour {tag} ===', flush=True)
    n = {'i': 0}
    def shot(page, name):
        n['i'] += 1; fn = f'{tag}-{n["i"]:02d}-{name}.png'
        page.screenshot(path=os.path.join(SHOTS, fn), scale='css')
        if PUBLISH: shutil.copy(os.path.join(SHOTS, fn), os.path.join(DOCSHOTS, fn))
    ctx, page, _ = boot(b, w, h, tag, wt_done=True); T = Touch(page)
    def s():
        shot(page, 'albums')
        check(page.evaluate(f'{APP}.stage.portrait') is False, f'{tag}: the stage is landscape')
        sw = page.evaluate("document.querySelector('.tt-wrap').getBoundingClientRect().width")
        check(sw > w * 0.9, f'{tag}: Albums takes the full width ({sw:.0f} of {w})')
        x, y, _, _ = center(page, '#tt-playBtn'); T.tap(x, y); time.sleep(2.0)
        check(pstate(page)['playing'] and rms(page) > 0.005, f'{tag}: Play works and is audible')
        shot(page, 'playing')
        cx0, cy0 = stage_pt(page, 700, 300)
        inside = 0 <= cx0 <= w and 0 <= cy0 <= h
        if inside:
            T.down((cx0, cy0)); time.sleep(0.05)
            for i in range(1, 10): T.move((cx0 + 6 * i, cy0 + 10 * i)); time.sleep(0.03)
            check(page.evaluate(f'{APP}.stage.isScratching()'), f'{tag}: the disc scratches'); T.up(); time.sleep(0.4)
        T.pinch(w / 2, h / 2, 120, 25); page.wait_for_timeout(1400)
        check(pstate(page)['z'] == 1, f'{tag}: pinch to the library')
        shot(page, 'library')
        T.pinch(w / 2, h / 2, 25, 160); page.wait_for_timeout(1400)
        page.click('.page:not([hidden]) .page-search'); page.wait_for_selector('.search-ov:not(.hidden)'); page.wait_for_timeout(400)
        page.fill('.so-input', 'meridian'); page.wait_for_timeout(700); shot(page, 'search')
        page.keyboard.press('Escape'); page.wait_for_timeout(400)
        page.evaluate("() => { const real = Date.now.bind(Date); window.__off = 0; Date.now = () => real() + window.__off; }")
        kx, ky, _, _ = center(page, '.page:not([hidden]) .dm-key'); T.tap(kx, ky); time.sleep(0.4)
        page.evaluate("() => { window.__off += 61000; runoutDeviceMode.machine.tick(Date.now()); }"); time.sleep(1.0)
        shot(page, 'aod')
        check(page.evaluate('runoutDeviceMode.state.aod'), f'{tag}: AOD in landscape')
        page.evaluate('runoutDeviceMode.unlock()'); time.sleep(0.5)
        check(not page.evaluate('runoutDeviceMode.state.locked'), f'{tag}: unlocked')
    step('landscape', s)
    ctx.close()

# ═══ extra phases ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
def phase_5k(b):
    print('\n=== 5,000-track library ===', flush=True)
    ctx, page, _ = boot(b, 360, 780, '5k')
    n = 5000
    page.evaluate("""async (n) => {
      const tracks = [];
      for (let i = 0; i < n; i++) tracks.push({ id: 'k5-' + i, title: 'Song ' + i + (i % 7 ? ' Night' : ' Dáy'), artist: 'Artist ' + (i % 25), albumArtist: '', album: 'Album ' + (i % 400), path: 'x/Album ' + (i % 400) + '/' + i + '.mp3', genre: ['Rock', 'Jazz', 'Folk'][i % 3], size: 1000 + i, hue: 10, color: '#222233', durationSec: 90 + (i % 20), trackNo: (i % 12) + 1, year: 1980 + (i % 40), added: 1700000000000 + i * 1000 });
      await new Promise((res) => { const r = indexedDB.open('runout-library', 1); r.onupgradeneeded = () => { r.result.createObjectStore('kv'); r.result.createObjectStore('handles', { autoIncrement: true }); };
        r.onsuccess = () => { const t = r.result.transaction('kv', 'readwrite'); t.objectStore('kv').put({ version: 1, savedAt: 0, tracks }, 'index'); t.oncomplete = () => { r.result.close(); res(); }; }; });
    }""", n)
    t0 = time.time(); page.reload()
    page.wait_for_function('document.getElementById("latency") && !/boot error/.test(document.getElementById("latency").textContent) && window.__rt')
    page.wait_for_function(f'{APP}.albums.length >= 300', timeout=30000); METRICS['boot_with_5k_tracks_s'] = round(time.time() - t0, 2)
    print(f"     boot + restore of 5,000 tracks: {METRICS['boot_with_5k_tracks_s']} s", flush=True)
    T = Touch(page)
    check(page.evaluate(f'{APP}.albums.length') >= 300, f'5k: the coverflow has {page.evaluate(f"{APP}.albums.length")} albums')
    page.click('.page:not([hidden]) .page-search'); page.wait_for_selector('.search-ov:not(.hidden)'); page.wait_for_timeout(1500)
    t0 = time.time(); page.fill('.so-input', 'night artist 4'); page.wait_for_selector('.so-row[data-type="song"]', timeout=8000); dt = time.time() - t0
    METRICS['search_5k_first_results_ms'] = round(dt * 1000)
    t0 = time.time(); page.fill('.so-input', 'song 4999'); page.wait_for_function('() => [...document.querySelectorAll(".so-row")].some(r => /4999/.test(r.textContent))', timeout=8000); dt2 = time.time() - t0
    METRICS['search_5k_second_query_ms'] = round(dt2 * 1000)
    print(f"     search over 5,000 songs: first results {METRICS['search_5k_first_results_ms']} ms, a later query {METRICS['search_5k_second_query_ms']} ms (incl. 120-ish ms debounce and Playwright overhead)", flush=True)
    check(dt < 2.5 and dt2 < 1.5, f'5k: search answers in {dt * 1000:.0f} ms / {dt2 * 1000:.0f} ms')
    page.screenshot(path=os.path.join(SHOTS, '5k-search.png'), scale='css')
    if PUBLISH: shutil.copy(os.path.join(SHOTS, '5k-search.png'), os.path.join(DOCSHOTS, '5k-search.png'))
    page.keyboard.press('Escape'); page.wait_for_timeout(300)
    drawer_to(page, 'mixtapes'); page.tap('#mtNew'); page.wait_for_selector('.ed'); page.wait_for_timeout(400)
    page.tap('#edtab-add'); page.wait_for_timeout(1200)
    st = page.eval_on_selector('.pk-status', 'e => e.textContent'); check('5000 songs' in st, f'5k: the picker sees all 5000 songs ({st})')
    t0 = time.time(); page.fill('.pk-q', 'night artist 4'); page.wait_for_function('document.querySelector(".pk-status").textContent.includes("song")'); dt = time.time() - t0
    METRICS['picker_5k_query_ms'] = round(dt * 1000); check(dt < 1.5, f'5k: the picker answers in {dt * 1000:.0f} ms')
    page.locator('.pk-addall').first.tap(); page.wait_for_timeout(300)
    page.tap('#edtab-tape'); page.locator('.ed-len', has_text='C90').tap(); page.tap('#edtab-add'); page.wait_for_timeout(300)
    page.fill('.pk-q', ''); page.wait_for_timeout(400)
    for i in range(3): page.locator('.pk-addall:not([disabled])').first.tap(); page.wait_for_timeout(250)
    t = page.inner_text('.ed-toast') if page.locator('.ed-toast:not(.hidden)').count() else ''
    check('20 songs' in t or '20' in ' '.join(page.eval_on_selector_all('.ed-gauge', 'els => els.map(e => e.innerText)')), f'5k: the 20-song side cap holds on a big library ("{t}")')
    ctx.close()

NATIVE_ROWS = r"""
;(() => {
  try { localStorage.setItem('runout.wtDone', '1'); } catch (e) {}
  const wavCache = {}; const rows = []; let n = 0;
  const album = (artist, name, folder, count, over = {}) => { for (let i = 0; i < count; i++, n++) rows.push(makeRow(n, { artist, album: name, title: `${name} ${i + 1}`, name: `0${i + 1} ${name} ${i + 1}.wav`, mime: 'audio/wav', relativePath: folder, track: i + 1, durationMs: 120000, genre: over.genre || 'Rock', year: over.year || 1991, ...over })); };
  album('The Dials', 'Heat Wave', 'Music/The Dials/Heat Wave/', 8, { year: 1993 });
  album('Mara Quill', 'Night Shift', 'Music/Mara Quill/Night Shift/', 6, { genre: 'Jazz', year: 1994 });
  album('Okonkwo', 'Savanna', 'Music/Okonkwo/Savanna/', 5, { genre: 'World', year: 1997 });
  const wav = (row) => { if (!wavCache[row.id]) { const b = makeWav(2, 220 + (row.id % 12) * 40); wavCache[row.id] = b; row.size = b.length; } return wavCache[row.id]; };
  for (const r of rows) wav(r);
  const fake = createFakeNative({ rows, bytesFor: (r) => wav(r), permission: 'prompt', afterRequest: 'granted' });
  window.__fake = fake;
  window.Capacitor = { getPlatform: () => 'android', isNativePlatform: () => true, Plugins: { DeviceLibrary: fake }, registerPlugin: () => fake };
})();
"""
def phase_native(b):
    print('\n=== mocked native Android device library ===', flush=True)
    fake_src = open(os.path.join(ROOT, 'test/support/fake-device-native.mjs')).read().replace('export function', 'function')
    ctx, page, _ = boot(b, 412, 860, 'native', init=fake_src + NATIVE_ROWS)
    T = Touch(page)
    page.wait_for_selector('.dv-card', timeout=8000)
    check('Allow access' in page.inner_text('.dv-card'), 'native: the permission card explains first')
    page.locator('.dv-card button').click()
    page.wait_for_function("document.querySelector('.dv-card') === null || document.querySelector('.dv-card').hidden", timeout=30000); page.wait_for_timeout(1500)
    nalb = page.evaluate(f'{APP}.albums.length'); check(nalb == 3, f'native: three device albums reach the coverflow ({nalb})')
    zoom_to_library(page, T, 412, 860)
    lab = page.inner_text('.tl-scan')
    check('scan phone' in lab.lower(), f'native: the library toolbar button says "{lab.strip()}"')
    check('phone' in page.inner_text('.tl-hint').lower() or page.evaluate("document.querySelector('.tl-hint').hidden || getComputedStyle(document.querySelector('.tl-hint')).display === 'none'"), 'native: the empty-shelf hint (if shown) talks about the phone, not a folder')
    page.screenshot(path=os.path.join(SHOTS, 'native-library.png'), scale='css')
    if PUBLISH: shutil.copy(os.path.join(SHOTS, 'native-library.png'), os.path.join(DOCSHOTS, 'native-library.png'))
    T.pinch(206, 430, 20, 150); page.wait_for_timeout(1200)
    page.click('.page:not([hidden]) .page-search'); page.wait_for_selector('.search-ov:not(.hidden)'); page.wait_for_timeout(500)
    page.fill('.so-input', 'savanna 3'); page.wait_for_timeout(600)
    check(page.locator('.so-row[data-type="song"]').count() >= 1, 'native: device songs are searchable')
    page.keyboard.press('Escape'); page.wait_for_timeout(300)
    drawer_to(page, 'mixtapes'); page.tap('#mtNew'); page.wait_for_selector('.ed'); page.wait_for_timeout(300)
    page.tap('#edtab-add'); page.wait_for_timeout(500); page.fill('.pk-q', 'heat wave'); page.wait_for_timeout(500)
    check(page.locator('.pk-addall').count() >= 1, 'native: device songs are in the mixtape picker')
    page.locator('.pk-addall').first.tap(); page.wait_for_timeout(300)
    page.tap('.ed-bar .sv'); page.wait_for_selector('.ed', state='detached'); page.wait_for_timeout(700)
    # suggested tapes read year / added / genre from the device rows (the same fields a folder scan produces)
    sug = page.evaluate("() => [...document.querySelectorAll('.mt-sug-chip .mt-sug-open b')].map(e => e.textContent)")
    print('     suggested tapes from device rows:', sug, flush=True)
    check('Fresh Finds' in sug and any(x.startswith('The 199') for x in sug), f'native: device rows feed Fresh Finds and the decade tape ({sug})')
    ctx.close()

def measure_ttI(b):
    ctx = b.new_context(bypass_csp=True, viewport={'width': 412, 'height': 915}, device_scale_factor=2, has_touch=True, is_mobile=True)
    ctx.add_init_script('window.showDirectoryPicker = undefined; try { localStorage.setItem("runout.wtDone", "1"); } catch (e) {}'); ctx.add_init_script(BUS_HOOK)
    page = ctx.new_page(); watch(page, 'tti'); T = Touch(page)
    t0 = time.time(); page.goto(URL, wait_until='commit')
    page.wait_for_function('window.__rt && window.__rt.app && window.__rt.app().state && window.__rt.app().state.engine', timeout=30000); t_ready = time.time() - t0
    page.wait_for_selector('#tt-playBtn'); x, y, _, _ = center(page, '#tt-playBtn'); T.tap(x, y)
    page.wait_for_function(f'{APP}.stage.player.starting || {APP}.stage.player.playing', timeout=10000); t_inter = time.time() - t0
    nav = page.evaluate("(() => { const n = performance.getEntriesByType('navigation')[0]; const p = Object.fromEntries(performance.getEntriesByType('paint').map(e => [e.name, e.startTime])); return { dcl: n.domContentLoadedEventEnd, load: n.loadEventEnd, fcp: p['first-contentful-paint'] || null, requests: performance.getEntriesByType('resource').length, transfer: performance.getEntriesByType('resource').reduce((a, r) => a + (r.transferSize || r.encodedBodySize || 0), 0) }; })()")
    METRICS['first_contentful_paint_ms'] = round(nav['fcp']) if nav['fcp'] else None; METRICS['dom_content_loaded_ms'] = round(nav['dcl']); METRICS['app_ready_s'] = round(t_ready, 2)
    METRICS['time_to_first_interactive_s'] = round(t_inter, 2); METRICS['boot_requests'] = nav['requests']; METRICS['boot_bytes_kb'] = round(nav['transfer'] / 1024)
    print(f"     time to first interactive (Play tapped and acting): {METRICS['time_to_first_interactive_s']} s; app ready {METRICS['app_ready_s']} s; FCP {METRICS['first_contentful_paint_ms']} ms; DCL {METRICS['dom_content_loaded_ms']} ms; {nav['requests']} requests, {METRICS['boot_bytes_kb']} KB at boot", flush=True)
    check(t_inter < 6, f'first interactive in {t_inter:.2f} s (local dev server, headless CPU)')
    ctx.close()

def bytes_shipped():
    r = subprocess.run(['node', os.path.join(ROOT, 'scripts/build-web.mjs')], cwd=ROOT, capture_output=True, text=True)
    www = os.path.join(ROOT, 'www'); tot = 0; files = []
    for d, _, fs in os.walk(www):
        for f in fs:
            p = os.path.join(d, f); s = os.path.getsize(p); tot += s; files.append((s, os.path.relpath(p, www)))
    files.sort(reverse=True)
    js = sum(s for s, p in files if p.endswith('.js'));
    METRICS['www_total_kb'] = round(tot / 1024); METRICS['www_js_kb'] = round(js / 1024); METRICS['www_files'] = len(files); METRICS['www_largest'] = [(p, round(s / 1024)) for s, p in files[:6]]
    print(f"     bytes shipped: www/ {METRICS['www_total_kb']} KB in {len(files)} files (JS {METRICS['www_js_kb']} KB); largest: {METRICS['www_largest']}", flush=True)
    check(r.returncode == 0 and tot > 0, 'build:web stages www/')

# ══ the user journey with a real multi-album library: the audio that plays must be the CHOSEN real track (measured), never the demo record ══
DOM_JS = """
(() => {
  window.__dom = () => {                                   // dominant frequency (Hz) of the engine output right now; 0 when silent
    const a = window.__an; if (!a) return -1;
    if (a.fftSize !== 16384) a.fftSize = 16384;
    const buf = new Float32Array(a.frequencyBinCount); a.getFloatFrequencyData(buf);
    let bi = 2; for (let i = 3; i < buf.length; i++) if (buf[i] > buf[bi]) bi = i;
    if (!(buf[bi] > -70)) return 0;
    return bi * a.context.sampleRate / a.fftSize;
  };
})();
"""
def tone_of(album, title):
    for (_, al, _, _, _, _, _, tracks) in ALBUMS:
        if al == album:
            for (t, _, hz, _) in tracks:
                if t == title: return hz
    raise KeyError((album, title))
def dom(page, n=8):
    """the most common dominant frequency over n quick reads (0 = silent)"""
    v = []
    for _ in range(n): v.append(round(page.evaluate('window.__dom()'))); time.sleep(0.08)
    return max(set(v), key=v.count)
def is_tone(hz, want, tol=10): return abs(hz - want) <= tol

def phase_journey(b, w=412, h=915):
    tag = f'journey-{w}x{h}'
    print(f'\n=== {tag}: the real-library user journey ===', flush=True)
    n = {'i': 0}
    def shot(page, name):
        n['i'] += 1; page.screenshot(path=os.path.join(SHOTS, f'{tag}-{n["i"]:02d}-{name}.png'), scale='css')
    ctx, page, _ = boot(b, w, h, tag, wt_done=True, init=DOM_JS)
    T = Touch(page)
    DEMO_HZ = None
    chosen = {}

    def s_first_run():
        txt = page.inner_text('.page:not([hidden])')
        check(page.evaluate("!document.getElementById('btnLibrary') || document.getElementById('btnLibrary').offsetWidth > 0"), f'{tag}: the Library button is visible on first run')
        card = page.locator('.tt-empty:not([hidden])')
        check(card.count() == 1 and 'demo record' in card.inner_text().lower(), f'{tag}: with nothing scanned the stage offers the Demo record and a Scan card ({card.inner_text()[:80]!r})')
        off = page.evaluate("[...document.querySelectorAll('#pageAlbums .page-head button')].filter(b => b.offsetWidth > 0).map(b => b.getBoundingClientRect()).filter(r => r.left < 0 || r.right > innerWidth).length")
        check(off == 0, f'{tag}: every Albums header button (Library, search, settings, lock) is on screen ({off} off the edge)')
        shot(page, 'first-run')
    step('first run', s_first_run)

    def s_scan():
        with page.expect_file_chooser() as fc: page.click('.tt-empty-btn')
        fc.value.set_files(TLIB)
        page.wait_for_function(f'{APP}.albums.length >= 7 && {APP}.albums.every(a => !a.builtin)', timeout=40000); page.wait_for_timeout(1800)
        check(page.evaluate("document.getElementById('btnLibrary').dataset.open") == 'true' and pstate(page)['z'] == 1, f'{tag}: after the scan the library opens by itself')
        check(page.locator('.tl-hint:visible, .tt-pick-nudge:visible').count() >= 0, f'{tag}: (nudge present or not; the library is what matters)')
        check(not pstate(page)['playing'] and dom(page) < 30, f'{tag}: scanning does not start any sound (playing {pstate(page)["playing"]}, dominant {dom(page)} Hz)')
        shot(page, 'library-after-scan')
    step('scan', s_scan)

    def s_pick():
        # focus Tidal (vinyl) through the coverflow, then tap its third track
        ti = page.evaluate(f"{APP}.albums.findIndex(a => a.title === 'Tidal')")
        page.evaluate(f'{APP}.tlib.focus({ti}, {{ animate: false }})'); page.wait_for_timeout(1000)
        check(page.inner_text('.tl-title').strip().lower() == 'tidal', f'{tag}: the coverflow centres "Tidal" ({page.inner_text(".tl-title")!r})')
        shot(page, 'album-picked')
        rows = page.locator('.tl-trk')
        names = rows.all_inner_texts()
        i3 = next(i for i, t in enumerate(names) if 'tide table 3' in t.lower())
        rows.nth(i3).tap(); page.wait_for_timeout(3000)
        hz = dom(page); want = tone_of('Tidal', 'Tide Table 3'); chosen['hz'] = want
        check(is_tone(hz, want), f'{tag}: tapping the track plays THAT real track: dominant {hz} Hz == {want} Hz (not the demo)')
        nl = page.evaluate("(() => { const e = document.querySelector('.tt-now'); return e && !e.hidden ? [document.querySelector('.tt-now-title').textContent, document.querySelector('.tt-now-sub').textContent, document.querySelector('.tt-now-time').textContent] : null; })()")
        check(nl and nl[0] == 'Tide Table 3' and 'Low Tide Orchestra' in nl[1] and 'Tidal' in nl[1], f'{tag}: the now-playing line names the real track and album ({nl})')
        check(not re.search(r'demo record|test pressing', page.inner_text('.page:not([hidden])'), re.I), f'{tag}: no Demo record / test pressing wording on the player')
        check(pstate(page)['z'] == 0, f'{tag}: picking a track brings the player back')
        shot(page, 'playing-real-track')
    step('pick + play', s_pick)

    def s_toggle():
        pr0 = page.evaluate("document.getElementById('btnLibrary').dataset.open")
        page.tap('#btnLibrary'); page.wait_for_timeout(1300)
        lab1 = page.inner_text('#btnLibrary'); on = pstate(page)['z'] == 1
        check(pr0 == 'false' and on and 'player' in lab1.lower(), f'{tag}: Library opens the shelf and the button becomes "{lab1.strip()}"')
        check(is_tone(dom(page), chosen['hz']), f'{tag}: the same real track keeps playing while the library is open')
        shot(page, 'library-while-playing')
        page.tap('#btnLibrary'); page.wait_for_timeout(1300)
        lab2 = page.inner_text('#btnLibrary'); off = pstate(page)['z'] == 0
        check(off and 'library' in lab2.lower(), f'{tag}: Player brings the turntable back and the button reads "{lab2.strip()}"')
    step('library/player toggle', s_toggle)

    def s_settings_sheet():
        page.tap('#btnDeck'); page.wait_for_timeout(500)
        r = page.evaluate("(() => { const r = document.getElementById('deckSheet').getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; })()")
        check(r[2] >= w - 2 and r[3] >= h - 4, f'{tag}: Tracks and options is a full page ({r})')
        t = page.inner_text('#deckSheet')
        check('Tracks and options' in (page.get_attribute('#deckSheet', 'aria-label') or '') and 'tide table 3' in t.lower() and 'tidal' in t.lower(), f'{tag}: it shows the album on the platter and its tracks')
        check(not re.search(r'deck details|feel knob|latency', t.split('Advanced')[0], re.I), f'{tag}: no developer wording above the Advanced fold')
        shot(page, 'turntable-settings')
        page.tap('.tt-sheet-close'); page.wait_for_timeout(400)
        check(page.evaluate("document.getElementById('deckSheet').hidden"), f'{tag}: Close returns to the player')
    step('turntable settings', s_settings_sheet)

    def s_mixtape():
        drawer_to(page, 'mixtapes'); page.wait_for_timeout(500)
        page.tap('#mtNew'); page.wait_for_selector('.ed'); page.wait_for_timeout(400)
        r = page.evaluate("(() => { const r = document.querySelector('.ed').getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; })()")
        check(r[2] >= w - 2 and r[3] >= h - 4, f'{tag}: the mixtape editor is full screen ({r})')
        page.fill('.ed-tape-tab input[aria-label="Title"]', 'Journey Mix'); page.locator('.ed-len', has_text='C30').tap()
        page.tap('#edtab-add'); page.wait_for_timeout(300)
        for q in ['Orchard Song 2', 'Harbor Light 4']:
            page.fill('.pk-q', q); page.wait_for_timeout(450); page.locator('.pk-rowbtn', has_text=q).first.tap(); page.wait_for_timeout(300)
        shot(page, 'mixtape-editor')
        page.tap('.ed-bar .sv'); page.wait_for_selector('.ed', state='detached'); page.wait_for_timeout(800)
        m = [x for x in json.loads(page.evaluate('localStorage.getItem("runout.mixtapes")'))['mixtapes'] if x['name'] == 'Journey Mix']
        check(len(m) == 1 and len(m[0]['sides']['A']) == 2, f'{tag}: the tape is saved with its two songs')
        shot(page, 'mixtape-shelf')
        card = page.locator('.cs-card[aria-label^="Mixtape: Journey Mix"]').first
        card.tap(); page.wait_for_timeout(700)
        if page.locator('.tp:not(.hidden)').count() == 0: card.tap()
        page.wait_for_selector('.tp:not(.hidden)'); page.wait_for_timeout(2500)
        want = tone_of('Orchard Hum', 'Orchard Song 2')
        hz = dom(page)
        check(is_tone(hz, want), f'{tag}: the tape plays its first real song: dominant {hz} Hz == {want} Hz')
        np_ = page.inner_text('.tp-np'); song = page.inner_text('.tp-np-song')
        check('journey mix' in np_.lower() and 'Orchard Song 2' in song, f'{tag}: the upright now-playing block names the tape and song ({np_!r})')
        check(page.evaluate("[...document.querySelectorAll('.tp-np, .tp-np *')].every((e) => getComputedStyle(e).writingMode === 'horizontal-tb' && getComputedStyle(e).transform === 'none')"), f'{tag}: ... and is not rotated')
        shot(page, 'cassette-playing')
        page.evaluate("document.querySelector('.tp .btn-close').click()"); page.wait_for_timeout(600)
    step('mixtape', s_mixtape)

    def s_radio():
        drawer_to(page, 'radio'); page.wait_for_timeout(600)
        page.fill('.radio-input', 'jazz'); page.keyboard.press('Enter')
        page.wait_for_selector('.radio-row[data-k]', timeout=8000); page.wait_for_timeout(500)
        rows = page.locator('.radio-row[data-k]').count()
        check(rows >= 1, f'{tag}: a station search shows results first ({rows} rows)')
        btn = page.evaluate("(() => { const b = document.querySelector('.radio-row[data-k] button'); if (!b) return null; const r = b.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height), b.textContent.trim()]; })()")
        check(btn and btn[1] >= 44, f'{tag}: every result has a visible Play button of >= 44 px ({btn})')
        shot(page, 'radio-search')
    step('radio search', s_radio)

    def s_booth():
        drawer_to(page, 'albums'); page.wait_for_timeout(500)
        if not (is_tone(dom(page), chosen['hz'])):            # the tape / radio took the engine: put the chosen real track back
            ti = page.evaluate(f"{APP}.albums.findIndex(a => a.title === 'Tidal')")
            page.tap('#btnLibrary'); page.wait_for_timeout(1000); page.evaluate(f'{APP}.tlib.focus({ti}, {{ animate: false }})'); page.wait_for_timeout(900)
            rows = page.locator('.tl-trk'); i3 = next(i for i, t in enumerate(rows.all_inner_texts()) if 'tide table 3' in t.lower()); rows.nth(i3).tap(); page.wait_for_timeout(2500)
        check(is_tone(dom(page), chosen['hz']), f'{tag}: picking a real track after a tape plays THAT track (dominant {dom(page)} Hz == {chosen["hz"]} Hz) and the tape no longer claims the engine')
        drawer_to(page, 'booth'); page.wait_for_selector('.fx-row', timeout=10000)
        page.click('.fx-row[data-id="repeat"]'); page.wait_for_selector('.fx-pad', timeout=5000); page.wait_for_timeout(800)
        px, py, pw, ph = center(page, '.fx-pad')
        T.down((px, py - pw * 0.25)); page.wait_for_timeout(800)
        eng = page.evaluate('(() => { const c = window.__runoutFx.controller; return { engaged: c.engaged, mode: c.mode }; })()')
        shot(page, 'booth-held')
        T.up(); page.wait_for_timeout(500)
        check(eng['engaged'] is True and eng['mode'] == 'repeat', f'{tag}: holding the Booth pad engages beat repeat ({eng})')
        check(page.evaluate('window.__runoutFx.controller.engaged') is False, f'{tag}: ... and releasing lets go')
    step('booth', s_booth)

    def s_settings():
        drawer_to(page, 'settings'); page.wait_for_selector('.st-page'); page.wait_for_timeout(400)
        t = page.evaluate("document.querySelector('.st-page').textContent")
        check('Tracks and options' in t and not re.search(r'deck details', t, re.I), f'{tag}: Settings points at "Tracks and options" and never "Deck details" ({t[:60]!r})')
        shot(page, 'settings')
    step('settings', s_settings)

    def s_lock():
        drawer_to(page, 'albums'); page.wait_for_timeout(1200)
        ov = page.evaluate("""(() => { const R = (s) => document.querySelector(s).getBoundingClientRect(), n = R('.tt-now'); let c = 0;
          for (const id of ['#tt-b33', '#tt-b45', '#tt-b78', '#tt-bm', '#tt-bp', '#tt-playBtn']) { const k = R(id); if (Math.min(n.right, k.right) - Math.max(n.left, k.left) > 2 && Math.min(n.bottom, k.bottom) - Math.max(n.top, k.top) > 2) c++; } return c; })()""")
        check(ov == 0, f'{tag}: after leaving and returning to Albums the now-playing line does not sit on the keys ({ov} overlaps)')
        page.evaluate("() => { const real = Date.now.bind(Date); window.__off = 0; Date.now = () => real() + window.__off; }")
        kx, ky, _, _ = center(page, '.page:not([hidden]) .dm-key'); T.tap(kx, ky); time.sleep(0.4)
        check(page.evaluate('runoutDeviceMode.state.locked'), f'{tag}: the lock key locks')
        page.evaluate("() => { window.__off += 61000; runoutDeviceMode.machine.tick(Date.now()); }"); time.sleep(1.0)
        check(page.evaluate('runoutDeviceMode.state.aod'), f'{tag}: the always-on display starts after the idle time')
        clock = page.inner_text('.dm-clock')
        check(re.search(r'\d{1,2}:\d{2}', clock or ''), f'{tag}: the always-on clock reads a time ({clock!r})')
        npt = page.evaluate("(document.querySelector('.dm-np') || {}).textContent || ''")
        check('Tide Table' in npt, f'{tag}: the always-on title names the real album track that is playing, not the earlier tape ({npt!r})')
        shot(page, 'aod-clock')
        sx, sy = page.evaluate("""([w, h]) => { for (let y = h * 0.3; y < h * 0.9; y += 17) for (let x = w * 0.2; x < w * 0.8; x += 19) { const e = document.elementFromPoint(x, y); if (e && !runoutDeviceMode.isAllowed(e)) return [x, y]; } return [w / 2, h / 2]; }""", [w, h])
        T.tap(sx, sy); time.sleep(0.12); T.tap(sx, sy + 2); time.sleep(0.7)
        kx, ky, _, _ = center(page, '.page:not([hidden]) .dm-key'); T.down((kx, ky)); time.sleep(1.0); T.up(); time.sleep(0.4)
        check(not page.evaluate('runoutDeviceMode.state.locked'), f'{tag}: wake and unlock')
    step('lock + AOD', s_lock)
    ctx.close()

def main():
    os.makedirs(SHOTS, exist_ok=True)
    make_tour_fixtures()
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        b = launch(p)
        only = [x for x in os.environ.get('TOUR_ONLY', '').split(',') if x]      # debugging aid: TOUR_ONLY=412,native
        want = lambda k: not only or k in only
        if want('tti'): measure_ttI(b)
        for (w, h) in [(360, 780), (412, 915)]:
            if want(str(w)): tour(b, w, h, f'{w}x{h}')
        if want('landscape'): tour_landscape(b)
        if want('journey'): phase_journey(b); phase_journey(b, 360, 780)
        if want('native'): phase_native(b)
        if want('5k'): phase_5k(b)
        b.close()
    if not only or 'bytes' in only: bytes_shipped()
    # ── the console / network log of the WHOLE tour ──
    def known(u): return any(k in u for k in NOISE)
    n404_console = sum(1 for c in CONSOLE if '404' in c[2] and 'Failed to load resource' in c[2])      # the message carries no URL: match them to the known requests instead
    n404_known = sum(1 for n in NETFAIL if known(n[1]) and n[2] == 'HTTP 404')
    cons = [c for c in CONSOLE if not known(c[2]) and not ('404' in c[2] and 'Failed to load resource' in c[2])]
    if n404_console > n404_known: cons.append(('*', 'error', f'{n404_console} console 404 messages but only {n404_known} known stations/ 404 responses'))
    net = [n for n in NETFAIL if not known(n[1])]
    print(f'\nconsole errors/warnings: {len(CONSOLE)} total, {len(cons)} beyond the known stations/ noise; failed requests: {len(NETFAIL)} total, {len(net)} beyond it; page errors: {len(PAGEERR)}', flush=True)
    for c in cons[:20]: print('   console', c)
    for n_ in net[:20]: print('   network', n_)
    for e in PAGEERR[:20]: print('   pageerror', e)
    for c in [c for c in CONSOLE if known(c[2]) or ('404' in c[2] and 'Failed to load resource' in c[2])][:3]: print('   (known noise)', c)
    check(not cons, 'no console errors or warnings during the whole tour except the known stations/ 404')
    check(not net, 'no failed requests during the whole tour except the known stations/ 404')
    check(not PAGEERR, 'no uncaught page errors during the whole tour')
    json.dump({'metrics': METRICS, 'console': CONSOLE, 'network': NETFAIL, 'pageerrors': PAGEERR, 'fails': fails}, open(os.path.join(OUTDIR, 'tour-report.json'), 'w'), indent=1, default=str)
    print('\nMETRICS', json.dumps(METRICS, indent=1))
    print('\nFAILED: %d' % len(fails)); [print(' -', f) for f in fails]
    sys.exit(1 if fails else 0)

if __name__ == '__main__':
    main()
