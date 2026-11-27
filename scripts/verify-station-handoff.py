#!/usr/bin/env python3
"""Regression checks for the station / tape / album hand-offs (real ffmpeg audio, desktop Chromium; NOT a device test).

Needs: ffmpeg (libmp3lame), Playwright for Python, the dev server:  python3 serve.py 8765   (URL=... to override)
Set CHROME=/path/to/chrome when Playwright's own browser revision is missing (e.g. /opt/pw-browsers/chromium-1243/chrome-linux64/chrome).
Usage:  python3 scripts/verify-station-handoff.py        Exits non-zero when an assertion fails.

What "plays" is the dominant frequency of the real output (scripts/fixtures/audio-tap.js), never app state alone.
  1  opening a tape while a pre-written (Dial) show plays: the tape plays its FIRST song from 0:00, at several delays after the station tap
     (including the race window while the show's first song is still decoding) and with a long (7 min) first show song
  2  after a Dial show is stopped, Play on Albums loads the focused album and plays it (no silent "playing" record)
  3  a streamed station started over a playing tape, then stopped: no ghost audio from the abandoned tape song
"""
import http.server, os, socketserver, subprocess, sys, tempfile, threading, time, json, base64
from playwright.sync_api import sync_playwright

URL = os.environ.get('URL', 'http://localhost:8765/index.html')
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TAP = open(os.path.join(ROOT, 'scripts/fixtures/audio-tap.js')).read()
TMP = tempfile.mkdtemp(prefix='handoff-')
TONES = [300, 500, 700, 900, 1100, 1300]
fails = []

def check(ok, msg):
    print(('PASS ' if ok else 'FAIL ') + msg)
    if not ok: fails.append(msg)

def mk(path, freq, sec, **tags):
    meta = sum((['-metadata', f'{k}={v}'] for k, v in tags.items()), [])
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', f'sine=frequency={freq}:duration={sec}:sample_rate=44100', *meta, '-c:a', 'libmp3lame', '-b:a', '64k', path], check=True)

def lib_files(first_sec=40):
    out = []
    for i, f in enumerate(TONES):
        p = os.path.join(TMP, f'0{i + 1}-t{f}.mp3')
        mk(p, f, first_sec if i == 0 else 40, title=f'T{f}', artist='Tone Band', album='Tones', track=i + 1)
        out.append(p)
    return out

STREAM = os.path.join(TMP, 'stream.mp3'); mk(STREAM, 1500, 60)
class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=TMP, **k)
    def log_message(self, *a): pass
socketserver.TCPServer.allow_reuse_address = True
SRV = socketserver.ThreadingTCPServer(('127.0.0.1', 0), H); threading.Thread(target=SRV.serve_forever, daemon=True).start()
STREAM_URL = f'http://127.0.0.1:{SRV.server_address[1]}/stream.mp3'
STORE = {'v': 1, 'favs': [{'k': 'radio-browser|rb:1', 'type': 'radio-browser', 'id': 'rb:1', 'at': 1, 'snap': {'name': 'Local Stream FM', 'streamUrl': STREAM_URL, 'streamUrls': [STREAM_URL], 'tags': ['test'], 'country': '', 'codec': 'MP3', 'bitrate': 128}}], 'recents': [], 'last': None}

ADD = """async (args) => { const [names, datas] = args; const fs = names.map((n,i)=>{ const bin = Uint8Array.from(atob(datas[i]), c=>c.charCodeAt(0)); return new File([bin], n, {type:'audio/mpeg'}); }); await window.__rt.app().library.addFiles(fs); }"""
INIT = ("window.showDirectoryPicker = undefined; try { localStorage.setItem('runout.wtDone', '1'); if (!localStorage.getItem('seedr')) { localStorage.setItem('seedr', '1'); localStorage.setItem('runout.radio.v1', %s); } } catch(e) {}"
        % json.dumps(json.dumps(STORE)))

def launch(p):
    kw = {'executable_path': os.environ['CHROME']} if os.environ.get('CHROME') else {}
    return p.chromium.launch(**kw, args=['--no-sandbox', '--autoplay-policy=no-user-gesture-required'])

def fresh(p, files):
    b = launch(p); ctx = b.new_context(bypass_csp=True, viewport={'width': 412, 'height': 860}, device_scale_factor=1)
    ctx.add_init_script(TAP); ctx.add_init_script(INIT)
    pg = ctx.new_page(); pg.errs = []
    pg.on('pageerror', lambda e: pg.errs.append(str(e)))
    pg.goto(URL); pg.wait_for_function('window.__rt && window.__rt.app && window.__rt.app().state && window.__rt.app().state.engine', timeout=30000)
    time.sleep(1.2)
    names = [os.path.basename(f) for f in files]
    pg.evaluate(ADD, [names, [base64.b64encode(open(f, 'rb').read()).decode() for f in files]])
    pg.evaluate("window.__rt.setZ(1)"); pg.wait_for_timeout(300)
    for c in ('Album', 'Artist'):   # a sort-chip toggle rebuilds the shelf (the web scan path does the same through its progress callback)
        pg.evaluate("c => [...document.querySelectorAll('.tl-chip')].find(e => e.textContent.trim() === c).click()", c); pg.wait_for_timeout(300)
    pg.wait_for_function('window.__rt.app().shelf.length >= 1', timeout=30000); pg.wait_for_timeout(1000)
    pg.evaluate("window.__rt.setZ(0)"); pg.wait_for_timeout(300)
    return b, pg

def goto(pg, sec):
    if pg.evaluate('document.querySelector(".page:not([hidden])").dataset.section') == sec: return
    pg.click('.page:not([hidden]) .hamburger'); pg.wait_for_timeout(400)
    pg.click(f'.drawer-item[data-section="{sec}"]'); pg.wait_for_timeout(900)

def back(pg): pg.evaluate('window.__runoutBack && window.__runoutBack()'); pg.wait_for_timeout(450)
def dom(pg): return pg.evaluate('window.__dom()')
def near(f, want): return f and abs(f - want) < want * 0.04

def make_tape(pg):
    ids = pg.evaluate("window.__rt.app().library.tracks.map(t=>t.id)")
    pg.evaluate("ids=>window.__rt.app().actions().addToMixtape(ids)", ids); pg.wait_for_timeout(1200)
    pg.click('.ed-ov button:has-text("Save")'); pg.wait_for_timeout(800)
    mid = pg.evaluate("JSON.parse(localStorage.getItem('runout.mixtapes')).mixtapes[0].id")
    back(pg)
    return mid

def open_tape(pg, mid): pg.evaluate("id=>window.__rt.app().actions().openMixtape(id)", mid)
def tape_song(pg): return pg.evaluate("(document.querySelector('.tp-np-song')||{}).textContent || ''")
def canned(pg):
    goto(pg, 'radio')
    pg.evaluate("document.querySelectorAll('.dial-play')[1].click()")

def watch(pg, secs, step=120):
    seen = []; t0 = time.time()
    while time.time() - t0 < secs:
        d = dom(pg) or 0
        seen.append(round(d / 20) * 20); pg.wait_for_timeout(step)
    return seen

def scenario1(p, first_sec, delays, tag):
    b, pg = fresh(p, lib_files(first_sec))
    mid = make_tape(pg)
    tape_first = None
    for d in delays:
        canned(pg); pg.wait_for_timeout(d)
        open_tape(pg, mid)
        seen = watch(pg, 4.0)
        song = tape_song(pg)
        # the tape's first song is whichever the tape lists first
        first_tone = None
        for t in TONES:
            if str(t) in song: first_tone = t
        tape_first = tape_first or first_tone
        loud = [s for s in seen[8:] if s]   # the show's song may sound until the tape's own first decode lands (~1 s at worst); after that only the tape may be heard
        pos = pg.evaluate("(document.querySelector('.tp-np-time')||{}).textContent || ''")
        ok = len(loud) > 12 and all(near(s, tape_first or TONES[0]) for s in loud) and 'song 1 of' in pos and pos.startswith('0:0')
        check(ok, f'[{tag}] tape opened {d} ms after a Dial tap plays its first song ({tape_first} Hz) from the start; heard {sorted(set(loud))[:6]} loud-samples={len(loud)} ({song!r}, {pos!r})')
        back(pg)
        pg.evaluate("window.__rt.app().state.mixtapes.releaseEngine && window.__rt.app().state.mixtapes.releaseEngine()")
        pg.wait_for_timeout(500)
    b.close()

def scenario2(p):
    b, pg = fresh(p, lib_files())
    canned(pg); pg.wait_for_timeout(5000)
    check(dom(pg) > 0, f'[2] the show plays ({dom(pg):.0f} Hz)')
    pg.evaluate('window.__rt.app().radio().stop()'); pg.wait_for_timeout(1500)
    goto(pg, 'albums'); pg.evaluate("window.__rt.setZ(0)"); pg.wait_for_timeout(500)
    check(pg.evaluate("window.__rt.app().state.stationLeftover") is True, '[2] the stopped show leaves a station song on the platter (not a user record)')
    sel = '#tt-playBtn'
    pg.evaluate("document.getElementById('tt-playBtn').dispatchEvent(new MouseEvent('click', { bubbles: true }))")
    pg.wait_for_timeout(3500)
    d = dom(pg)
    check(d and any(near(d, t) for t in TONES), f'[2] Play after a stopped show plays an album track (measured {d:.0f} Hz, play via {sel})')
    check(pg.evaluate("window.__rt.app().state.stationLeftover") is False, '[2] platter now holds the user record')
    b.close()

def scenario3(p):
    b, pg = fresh(p, lib_files())
    mid = make_tape(pg)
    open_tape(pg, mid); pg.wait_for_timeout(2500)
    check(dom(pg) and any(near(dom(pg), t) for t in TONES), f'[3] tape plays ({dom(pg):.0f} Hz)')
    back(pg); goto(pg, 'radio'); pg.wait_for_timeout(1500)
    pg.wait_for_selector('.rr-play', timeout=15000); pg.click('.rr-play >> nth=0'); pg.wait_for_timeout(4000)
    check(pg.evaluate("window.__rt.app().radio().session.state.phase") == 'playing', '[3] the streamed station is playing')
    pg.click('.radio-now button:has-text("Stop")')
    seen = watch(pg, 12, 250)
    ghost = [s for s in seen if s and any(near(s, t) for t in TONES)]
    check(not ghost, f'[3] no ghost tape audio after the station stops (heard {sorted(set(s for s in seen if s))})')
    check(pg.evaluate("window.__rt.app().stage.player.playing") is False, '[3] the platter is not playing')
    b.close()

ONLY = set(sys.argv[1:])   # e.g. `2 3` runs just those scenarios
with sync_playwright() as p:
    if not ONLY or '1' in ONLY:
        scenario1(p, 40, [0, 40, 100, 150, 400, 2500], 'fast')
        scenario1(p, 420, [0, 80, 150], 'long-song')
    if not ONLY or '2' in ONLY: scenario2(p)
    if not ONLY or '3' in ONLY: scenario3(p)
SRV.shutdown()
print('FAILED: %d' % len(fails) if fails else 'ALL PASSED')
sys.exit(1 if fails else 0)
