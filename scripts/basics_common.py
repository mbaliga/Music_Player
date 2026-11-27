"""Shared harness for scripts/verify-basics.py: the dev server, the audio tap (measures what the engine really outputs) and a mocked phone library of
real tone files, so every claim is the dominant frequency of the output, never app state."""
import json, os, re, socket, subprocess, sys, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CH = os.environ.get('CHROME', '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome')

_src = open(os.path.join(ROOT, 'scripts/verify-real-playback.py')).read()
TAP = re.search(r'TAP = r"""(.*?)"""', _src, re.S).group(1)     # the audio tap lives in one place: verify-real-playback.py
_fake = open(os.path.join(ROOT, 'test/support/fake-device-native.mjs')).read().replace('export function', 'function')

def device_script(albums, secs=60):
    """albums = [(artist, album, [freq, ...])]: a fake phone library, one WAV tone file per track."""
    return _fake + r"""
;(() => {
  const cache = {}; const rows = [];
  const album = (artist, name, folder, freqs) => freqs.forEach((f, i) => rows.push(makeRow(rows.length, { artist, album: name, title: `${name} T${i + 1}`, name: `0${i + 1} ${name} T${i + 1}.wav`, mime: 'audio/wav', relativePath: folder, track: i + 1, durationMs: SECS * 1000, genre: 'Rock', freq: f })));
  for (const [artist, name, freqs] of ALBUMS) album(artist, name, `Music/${artist}/${name}/`, freqs);
  const wav = (r) => { if (!cache[r.id]) { cache[r.id] = makeWav(SECS, r.freq); r.size = cache[r.id].length; } return cache[r.id]; };
  for (const r of rows) wav(r);
  const fake = createFakeNative({ rows, bytesFor: wav, permission: 'granted' });
  window.__fake = fake;
  window.Capacitor = { getPlatform: () => 'android', isNativePlatform: () => true, Plugins: { DeviceLibrary: fake }, registerPlugin: () => fake };
})();
""".replace('SECS', str(secs)).replace('ALBUMS', json.dumps(albums))

def serve():
    s = socket.socket(); s.bind(('127.0.0.1', 0)); port = s.getsockname()[1]; s.close()
    p = subprocess.Popen([sys.executable, os.path.join(ROOT, 'serve.py'), str(port)], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1.0)
    return p, f'http://localhost:{port}/index.html'

class Checker:
    def __init__(self): self.fails = []
    def __call__(self, ok, msg):
        if not ok: self.fails.append(msg)
        print(('ok   ' if ok else 'FAIL ') + msg, flush=True)

READY = 'window.__rt && window.__rt.app && window.__rt.app().state && window.__rt.app().state.engine'
PLAY = "document.getElementById('tt-playBtn').dispatchEvent(new MouseEvent('click', { bubbles: true }))"

def open_app(b, URL, albums, secs=60, viewport=None, scan=True, ctx=None):
    ctx = ctx or b.new_context(bypass_csp=True, viewport=viewport or {'width': 412, 'height': 860}, device_scale_factor=1)
    ctx.add_init_script(TAP)
    ctx.add_init_script("try { localStorage.getItem('runout.wtDone') || localStorage.setItem('runout.wtDone', '1'); } catch (e) {}")
    ctx.add_init_script(device_script(albums, secs))
    pg = ctx.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.on('console', lambda m: errs.append('console:' + m.text) if m.type == 'error' and 'stations/' not in m.text and '404' not in m.text else None)
    pg.goto(URL); pg.wait_for_function(READY, timeout=30000); pg.wait_for_timeout(800)
    if scan:
        pg.evaluate("async () => { const m = await import('/src/device/index.js'); await m.deviceLibrary.scan({ force: true }); }")
        pg.wait_for_function('window.__rt.app().shelf.length >= 1', timeout=30000)
        pg.evaluate('window.__rt.setZ(0)'); pg.wait_for_timeout(2200)
    return ctx, pg, errs

def reload(pg):
    pg.reload(); pg.wait_for_function(READY, timeout=30000)

def settle_dom(pg, want, timeout=9000):
    t0 = time.time(); last = -1
    while time.time() - t0 < timeout / 1000:
        last = pg.evaluate('window.__dom()')
        if want and last and abs(last - want) / want < 0.03: return last
        pg.wait_for_timeout(250)
    return last

def near(a, b, tol=0.03): return bool(a) and bool(b) and abs(a - b) / b < tol

def pos(pg): return pg.evaluate("window.__rt.app().state.engine.position / window.__rt.app().state.engine.sampleRate")
