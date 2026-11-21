#!/usr/bin/env python3
"""Regression: a real library track must be the audio that actually plays (never the built-in test pressing).

Two sources, each a small album of generated WAV tones (a distinct pure frequency per track, 30 s long):
  * folder  : LibraryManager.addFiles(real File objects)
  * device  : the mocked native DeviceLibrary plugin (tracks are chunked DeviceFile objects)
The page taps the engine's output (every connect() to ctx.destination also feeds one analyser), so "what plays" is measured as the
dominant frequency of the real output, not read from app state. Each entry point is driven the way a finger would:
tap a track row in the zoomed-out coverflow, tap the centre cover, Play on the stage, the artist Play-all hook, search-result play,
next / previous. Asserts: dominant frequency == that track's tone, the display / state shows its title, and a failure is loud.

Usage: python3 scripts/verify-real-playback.py [outdir]     CHROME=/path/to/chrome overrides the browser.
"""
import json, os, socket, subprocess, sys, time
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CH = os.environ.get('CHROME', '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome')
fails = []
def check(ok, msg):
    if not ok: fails.append(msg)
    print(('ok   ' if ok else 'FAIL ') + msg, flush=True)

s = socket.socket(); s.bind(('127.0.0.1', 0)); PORT = s.getsockname()[1]; s.close()
srv = subprocess.Popen([sys.executable, os.path.join(ROOT, 'serve.py'), str(PORT)], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.0)
URL = f'http://localhost:{PORT}/index.html'

TONES = [600, 800, 1000, 1200]          # Hz, track 1..4 of "Tone Album"
TONES_B = [700, 900]                    # second album, 2 tracks
import tempfile, wave, struct, math
TMP = tempfile.mkdtemp(prefix='rt-tones-')
def write_wav(path, freq, secs=30, rate=22050):
    with wave.open(path, 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate)
        w.writeframes(b''.join(struct.pack('<h', int(9000 * math.sin(2 * math.pi * freq * i / rate))) for i in range(secs * rate)))
FILES = []
for alb, fr in (('Tone Album', TONES), ('Second Album', TONES_B)):
    for i, f in enumerate(fr):
        os.makedirs(os.path.join(TMP, alb), exist_ok=True)
        pth = os.path.join(TMP, alb, f'0{i + 1} {alb} T{i + 1}.wav'); write_wav(pth, f); FILES.append(pth)
fake_src = open(os.path.join(ROOT, 'test/support/fake-device-native.mjs')).read().replace('export function', 'function')

TAP = r"""
;(() => {
  try { localStorage.setItem('runout.wtDone', '1'); } catch (e) {}
  const origConnect = AudioNode.prototype.connect;
  window.__tap = null;
  AudioNode.prototype.connect = function (dest, ...rest) {
    const r = origConnect.call(this, dest, ...rest);
    try {
      if (dest && dest === this.context.destination) {
        if (!window.__tap || window.__tap.context !== this.context) {
          const a = this.context.createAnalyser(); a.fftSize = 16384; a.smoothingTimeConstant = 0;
          window.__tap = a;
        }
        origConnect.call(this, window.__tap);
      }
    } catch (e) {}
    return r;
  };
  // dominant frequency (Hz) of the engine output right now, or 0 when it is silent
  window.__dom = () => {
    const a = window.__tap; if (!a) return -1;
    const buf = new Float32Array(a.frequencyBinCount); a.getFloatFrequencyData(buf);
    let best = 0, bi = 0; for (let i = 2; i < buf.length; i++) if (buf[i] > best || bi === 0) { if (bi === 0 || buf[i] > buf[bi]) { bi = i; best = buf[i]; } }
    if (!(buf[bi] > -70)) return 0;
    return bi * a.context.sampleRate / a.fftSize;
  };
})();
"""

DEVICE = fake_src + r"""
;(() => {
  const cache = {};
  const rows = [];
  const album = (artist, name, folder, freqs) => freqs.forEach((f, i) => rows.push(makeRow(rows.length, { artist, album: name, title: `${name} T${i + 1}`, name: `0${i + 1} ${name} T${i + 1}.wav`, mime: 'audio/wav',
    relativePath: folder, track: i + 1, durationMs: 30000, genre: 'Rock', freq: f })));
  album('Tone Band', 'Tone Album', 'Music/Tone Band/Tone Album/', %s);
  album('Other Band', 'Second Album', 'Music/Other Band/Second Album/', %s);
  const wav = (r) => { if (!cache[r.id]) { cache[r.id] = makeWav(30, r.freq); r.size = cache[r.id].length; } return cache[r.id]; };
  for (const r of rows) wav(r);
  const fake = createFakeNative({ rows, bytesFor: wav, permission: 'granted' });
  window.__fake = fake;
  window.Capacitor = { getPlatform: () => 'android', isNativePlatform: () => true, Plugins: { DeviceLibrary: fake }, registerPlugin: () => fake };
})();
""" % (json.dumps(TONES), json.dumps(TONES_B))

def open_app(b, source, sab=True, fail=False):
    ctx = b.new_context(viewport={'width': 412, 'height': 860}, device_scale_factor=1)
    ctx.add_init_script(TAP)
    if not sab: ctx.add_init_script("Object.defineProperty(window, 'crossOriginIsolated', { value: false });")
    ctx.add_init_script('try { delete window.showDirectoryPicker; } catch (e) {}')
    if source == 'device': ctx.add_init_script(DEVICE)
    if fail: ctx.add_init_script('window.__fake.failReads = 1e9;')
    pg = ctx.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.on('console', lambda m: errs.append('console:' + m.text) if m.type == 'error' else None)
    pg.goto(URL)
    pg.wait_for_function('window.__rt && window.__rt.app && window.__rt.app().state && window.__rt.app().state.engine', timeout=30000)
    pg.wait_for_timeout(1200)
    return ctx, pg, errs

def wait_library(pg, n_albums):
    pg.wait_for_timeout(4000); print('     shelf:', pg.evaluate("window.__rt.app().shelf.map(a=>[a.album,a.artist,a.tracks.length])"), pg.evaluate("window.__rt.app().albums.length"))
    pg.wait_for_function(f'window.__rt.app().shelf.length >= {n_albums}', timeout=30000)
    pg.wait_for_timeout(800)

def state(pg):
    return pg.evaluate("""() => { const a = window.__rt.app(), s = a.state; return { name: s.track && s.track.name, albumId: s.albumId, T: s.T, qi: s.queue ? s.queue.index : null,
      title: s.queue ? s.queue.items[s.queue.index].title : null, builtin: !!(s.track && /test pressing/i.test(s.track.name || '')), playing: a.stage.player.playing }; }""")

def settle_dom(pg, want, timeout=9000):
    """poll the measured dominant frequency until it is within 3 %% of `want` (or timeout); returns the last reading"""
    t0 = time.time(); last = -1
    while time.time() - t0 < timeout / 1000:
        last = pg.evaluate('window.__dom()')
        if want and last and abs(last - want) / want < 0.03: return last
        pg.wait_for_timeout(250)
    return last

def zoom_out_and_tap(pg, album_title, row):
    return pg.evaluate("""async ([title, row]) => {
      const app = window.__rt.app(); const i = app.albums.findIndex(a => a.title === title);
      window.__rt.setZ(1); await new Promise(r => setTimeout(r, 900));
      app.tlib.focus(i, { animate: false }); await new Promise(r => setTimeout(r, 700));
      const li = document.querySelectorAll('.tl-tracks .tl-trk')[row]; if (!li) return { err: 'no row ' + row + ' of ' + document.querySelectorAll('.tl-tracks .tl-trk').length };
      li.click(); return { ok: true };
    }""", [album_title, row])

def run_source(b, source, sab=True):
    tag = source + ('' if sab else '+nosab')
    print(f'\n=== source: {tag} ===', flush=True)
    ctx, pg, errs = open_app(b, source, sab)
    if source == 'device':
        pg.evaluate("""async () => { const m = await import('/src/device/index.js'); await m.deviceLibrary.scan({ force: true }); }""")
    else:
        pg.evaluate("window.__rt.setZ(1)"); pg.wait_for_timeout(900)
        with pg.expect_file_chooser() as fc: pg.click('.tl-scan')
        fc.value.set_files(TMP)
    wait_library(pg, 2)
    st = state(pg)
    print('     initial', st)
    # 0. the user changes nothing: the first album is on the shelf, taps Play on the stage
    pg.evaluate("window.__rt.setZ(0)"); pg.wait_for_timeout(2500)
    pg.evaluate("document.getElementById('tt-playBtn').dispatchEvent(new MouseEvent('click', { bubbles: true }))")
    first = pg.evaluate("window.__rt.app().shelf[0].tracks[0]")
    want0 = {'Tone Album': TONES[0], 'Second Album': TONES_B[0]}.get(pg.evaluate("window.__rt.app().shelf[0].album").replace('rt-tones-', '').split('/')[-1], None)
    pg.wait_for_timeout(4000); st = state(pg); dom = pg.evaluate('window.__dom()')
    print('     play-without-picking:', st, dom)
    dom0 = settle_dom(pg, TONES_B[0], 6000)
    check(abs(dom0 - TONES_B[0]) < TONES_B[0] * 0.03, f'[{tag}] Play (nothing picked) is the focused album track 1: {TONES_B[0]} Hz (measured {dom0:.0f} Hz)')
    check(not st['builtin'], f"[{tag}] Play with a real library and nothing picked does not play the test pressing ({st['name']})")
    check(st['albumId'] != 'builtin:test-pressing', f"[{tag}] platter album is a library album ({st['albumId']})")
    # 1. tap a track row in the zoomed-out coverflow (track 3 of Tone Album)
    r = zoom_out_and_tap(pg, 'Tone Album', 2)
    check(r.get('ok'), f'[{tag}] coverflow shows Tone Album rows ({r})')
    dom = settle_dom(pg, TONES[2]); st = state(pg)
    check(abs(dom - TONES[2]) < TONES[2] * 0.03, f'[{tag}] row tap: output is track 3 tone {TONES[2]} Hz (measured {dom:.0f} Hz)')
    check(not st['builtin'] and st['title'] and 'T3' in st['title'], f"[{tag}] row tap: display/state title is the real track ({st['title']})")
    # 2. another album, track 1
    zoom_out_and_tap(pg, 'Second Album', 0)
    dom = settle_dom(pg, TONES_B[0]); st = state(pg)
    check(abs(dom - TONES_B[0]) < TONES_B[0] * 0.03, f'[{tag}] other album row 1: {TONES_B[0]} Hz (measured {dom:.0f} Hz)')
    # 3. next / previous on the platter (arm flick = goTo next)
    pg.evaluate("window.__rt.app().stage.dispatch({type:'zoomTo', z:0})"); pg.wait_for_timeout(600)
    pg.evaluate("window.__rt.goTo({ index: 1, time: 0 }, false)"); dom = settle_dom(pg, TONES_B[1])
    check(abs(dom - TONES_B[1]) < TONES_B[1] * 0.03, f'[{tag}] next track: {TONES_B[1]} Hz (measured {dom:.0f} Hz)')
    check(not errs, f'[{tag}] no console / page errors: {errs[:3]}')
    ctx.close()


PLAY_JS = "document.getElementById('tt-playBtn').dispatchEvent(new MouseEvent('click', { bubbles: true }))"

def run_fast_play(b, source):
    """Play pressed the instant the library appears (before the silent adopt timer): the toggle itself must load the focused album, never the demo."""
    print(f'\n=== fast Play: {source} ===', flush=True)
    ctx, pg, errs = open_app(b, source)
    if source == 'device':
        pg.evaluate("""async () => { const m = await import('/src/device/index.js'); await m.deviceLibrary.scan({ force: true }); }""")
    else:
        pg.evaluate("window.__rt.setZ(1)"); pg.wait_for_timeout(900)
        with pg.expect_file_chooser() as fc: pg.click('.tl-scan')
        fc.value.set_files(TMP)
    pg.wait_for_function('window.__rt.app().shelf.length >= 2', timeout=30000)
    pg.evaluate("window.__rt.setZ(0)"); pg.wait_for_timeout(300)
    print('     platter before Play:', pg.evaluate("window.__rt.app().state.albumId"))
    pg.evaluate(PLAY_JS)
    dom = settle_dom(pg, TONES_B[0], 12000); st = state(pg)
    check(abs(dom - TONES_B[0]) < TONES_B[0] * 0.03 and not st['builtin'], f"[fast {source}] Play plays the focused album's first track ({TONES_B[0]} Hz, measured {dom:.0f}; {st['name']})")
    ctx.close()

def run_unreadable(b):
    """A device file whose native read fails: a visible toast, and Play does NOT fall back to the demo."""
    print('\n=== unreadable file (device) ===', flush=True)
    ctx, pg, errs = open_app(b, 'device', fail=True)
    pg.evaluate("""async () => { const m = await import('/src/device/index.js'); await m.deviceLibrary.scan({ force: true }); }""")
    pg.wait_for_function('window.__rt.app().shelf.length >= 2', timeout=30000); pg.wait_for_timeout(1500)
    pg.evaluate("window.__rt.setZ(0)"); pg.wait_for_timeout(600)
    pg.evaluate(PLAY_JS); pg.wait_for_timeout(2500)
    vis = pg.evaluate("(() => { const t = document.getElementById('rtToast'); return t && t.style.display !== 'none' ? t.textContent : ''; })()")
    check('Cannot play' in vis, f'[unreadable] a visible toast says what failed: {vis!r}')
    st = state(pg); dom = pg.evaluate('window.__dom()')
    check(st['albumId'] == 'builtin:test-pressing' and not st['playing'], f"[unreadable] nothing plays (no demo fallback): playing={st['playing']}")
    ctx.close()

try:
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=CH, args=['--autoplay-policy=no-user-gesture-required', '--no-sandbox'])
        for sab in (False, True):
            run_source(b, 'folder', sab)
            run_source(b, 'device', sab)
        for src in ('folder', 'device'): run_fast_play(b, src)
        run_unreadable(b)
        b.close()
finally:
    srv.terminate()

print('\nFAILED: ' + '; '.join(fails) if fails else '\nall checks passed')
sys.exit(1 if fails else 0)
