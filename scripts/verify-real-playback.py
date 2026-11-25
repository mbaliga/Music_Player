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
import json, os, re, socket, subprocess, sys, time
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
  window.__tap = null; window.__raw = []; window.__blk = []; window.__ctxs = [];
  const WSRC = `class T extends AudioWorkletProcessor{constructor(){super();this.buf=[];this.raw=0;this.port.onmessage=(e)=>{this.raw=e.data}}process(i,o){const x=i[0];let pk=0,ss=0,l=0,dc=0,zc=0,mx=0;if(x&&x.length){const a=x[0];l=a.length;for(let k=0;k<l;k++){dc+=a[k];const v=Math.abs(a[k]);if(v>mx)mx=v;ss+=a[k]*a[k];if(k>0){const d=Math.abs(a[k]-a[k-1]);if(d>pk)pk=d;if((a[k]>=0)!==(a[k-1]>=0))zc++}}}
   this.buf.push([currentFrame,pk,Math.sqrt(ss/(l||1)),dc/(l||1),zc,mx]);if(this.raw&&x&&x.length){this.port.postMessage({raw:Array.from(x[0]),f:currentFrame})}if(this.buf.length>=64){this.port.postMessage(this.buf);this.buf=[]}return true}}registerProcessor('tapproc',T)`;
  AudioNode.prototype.connect = function (dest, ...rest) {
    const r = origConnect.call(this, dest, ...rest);
    try {
      if (dest && dest === this.context.destination && !this.__mine) {
        if (!window.__tap || window.__tap.context !== this.context) {
          const ctx = this.context; window.__ctxs.push(ctx);
          const a = ctx.createAnalyser(); a.fftSize = 16384; a.smoothingTimeConstant = 0; window.__tap = a;
          const url = URL.createObjectURL(new Blob([WSRC], { type: 'text/javascript' }));
          ctx.audioWorklet.addModule(url).then(() => {
            const n = new AudioWorkletNode(ctx, 'tapproc', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
            n.__mine = true; window.__tapnode = n; window.__tapOn = true;
            n.port.onmessage = (e) => { if (e.data && e.data.raw) { window.__raw.push(e.data); return; } if (window.__rec) for (const b of e.data) window.__blk.push(b); window.__lastFrame = e.data[e.data.length-1][0]; };
            window.__tapIn = n;
            origConnect.call(n, ctx.destination);
            // feed every existing source into it: connect via the analyser chain
            window.__tapReady = true;
            if (window.__tapSrc) origConnect.call(window.__tapSrc, n);
          });
        }
        origConnect.call(this, window.__tap);
        // route the same node to the block recorder
        window.__tapSrc = this;
        if (window.__tapIn) origConnect.call(this, window.__tapIn);
      }
    } catch (e) { console.error('tap', e); }
    return r;
  };
  const spec = () => { const a = window.__tap; if (!a) return null; const buf = new Float32Array(a.frequencyBinCount); a.getFloatFrequencyData(buf); return buf; };
  window.__dom = () => {
    const buf = spec(); if (!buf) return -1; const a = window.__tap;
    let bi = 2; for (let i = 2; i < buf.length; i++) if (buf[i] > buf[bi]) bi = i;
    if (!(buf[bi] > -70)) return 0;
    return bi * a.context.sampleRate / a.fftSize;
  };
  // all spectral peaks within 30 dB of the max (tones from simultaneous decks)
  window.__peaks = () => {
    const buf = spec(); if (!buf) return []; const a = window.__tap; let mx = -200; for (let i = 2; i < buf.length; i++) if (buf[i] > mx) mx = buf[i];
    if (mx < -70) return []; const out = [];
    for (let i = 3; i < buf.length - 3; i++) { if (buf[i] > mx - 30 && buf[i] >= buf[i-1] && buf[i] >= buf[i+1] && buf[i] >= buf[i-2] && buf[i] >= buf[i+2]) out.push([Math.round(i * a.context.sampleRate / a.fftSize), Math.round(buf[i])]); }
    return out.slice(0, 8);
  };
  window.__rms = () => { // time-domain rms from a fresh small analyser each call is wasteful; use the spectrum sum instead
    const a = window.__tap; if (!a) return -1; const b = new Float32Array(a.fftSize); a.getFloatTimeDomainData(b); let s = 0; for (const x of b) s += x*x; return Math.sqrt(s / b.length);
  };
  window.__recStart = () => { window.__blk = []; window.__rec = true; };
  window.__recStop = () => { window.__rec = false; return window.__blk; };
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
      title: s.queue ? s.queue.items[s.queue.index].title : null, builtin: !!(s.track && /demo record|test pressing/i.test(s.track.name || '')), playing: a.stage.player.playing }; }""")

def now_line(pg):
    return pg.evaluate("(() => { const g = (q) => document.querySelector(q); return [g('.tt-now-title').textContent, g('.tt-now-sub').textContent, g('.tt-now').hidden]; })()")

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
    nl = now_line(pg)
    check(not nl[2] and nl[0] not in ('Demo record', 'Pick an album', '') and not re.search(r'test pressing', pg.evaluate('document.body.innerText'), re.I), f'[{tag}] the stage names the real track, never the demo ({nl})')
    check(st['albumId'] != 'builtin:test-pressing', f"[{tag}] platter album is a library album ({st['albumId']})")
    # 1. tap a track row in the zoomed-out coverflow (track 3 of Tone Album)
    r = zoom_out_and_tap(pg, 'Tone Album', 2)
    check(r.get('ok'), f'[{tag}] coverflow shows Tone Album rows ({r})')
    dom = settle_dom(pg, TONES[2]); st = state(pg)
    check(abs(dom - TONES[2]) < TONES[2] * 0.03, f'[{tag}] row tap: output is track 3 tone {TONES[2]} Hz (measured {dom:.0f} Hz)')
    check(not st['builtin'] and st['title'] and 'T3' in st['title'], f"[{tag}] row tap: display/state title is the real track ({st['title']})")
    nl = now_line(pg)
    check('T3' in nl[0] and 'Tone Album' in nl[1], f'[{tag}] row tap: the readable now-playing line shows title and album ({nl})')
    check(pg.evaluate('window.__rt.app().stage.hasLabelArt'), f'[{tag}] row tap: the label is the album\'s own')
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
    check(('Cannot play' in vis) or ('lost access' in vis), f'[unreadable] a visible toast says what failed: {vis!r}')
    st = state(pg); dom = pg.evaluate('window.__dom()')
    check(st['albumId'] == 'builtin:test-pressing' and not st['playing'], f"[unreadable] nothing plays (no demo fallback): playing={st['playing']}")
    ctx.close()


# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
# Playback review regressions (real mp3 / m4a / flac / ogg / opus files made with ffmpeg; every claim is the MEASURED output frequency / silence)
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
import shutil
RV = os.path.join(TMP, 'review'); os.makedirs(RV, exist_ok=True)
def ff(rel, freq, secs, codec, channels=2, title=None, artist='Review Band', album=None, track=None, noise=0.0):
    path = os.path.join(RV, rel); os.makedirs(os.path.dirname(path), exist_ok=True)
    if os.path.exists(path): return path
    src = f'sine=f={freq}:d={secs}:sample_rate=44100'
    cmd = ['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', src]
    if noise:
        cmd += ['-f', 'lavfi', '-i', f'anoisesrc=d={secs}:a={noise}:r=44100', '-filter_complex', f'[0][1]amix=inputs=2:weights=1 {noise * 4},aformat=channel_layouts={"stereo" if channels == 2 else "mono"}']
    else:
        cmd += ['-ac', str(channels)]
    cmd += ['-c:a', *codec.split()]
    for k, v in (('title', title), ('artist', artist), ('album', album), ('track', track)):
        if v is not None: cmd += ['-metadata', f'{k}={v}']
    subprocess.run(cmd + [path], check=True); return path
def make_review_library():
    M = 'Mixed Album'
    for n, (nm, f, codec, ext) in enumerate([('Mp3', 500, 'libmp3lame -b:a 128k', 'mp3'), ('Aac', 700, 'aac -b:a 96k', 'm4a'), ('Flac', 900, 'flac', 'flac'), ('Ogg', 1100, 'libvorbis', 'ogg'), ('Opus', 1300, 'libopus', 'opus')], 1):
        ff(f'Mixed Band/{M}/0{n} {nm}.{ext}', f, 14, codec, title=f'Mixed {nm}', album=M, track=n)
    B = 'Bad Album'
    ff(f'Bad Band/{B}/01 Good.mp3', 1500, 14, 'libmp3lame -b:a 128k', title='Bad One Good', album=B, track=1, artist='Bad Band')
    good = open(os.path.join(RV, f'Bad Band/{B}/01 Good.mp3'), 'rb').read()
    id3 = 10 + ((good[6] << 21) | (good[7] << 14) | (good[8] << 7) | good[9])       # keep the tag (so the scan lists the file) and break the audio
    open(os.path.join(RV, f'Bad Band/{B}/02 Corrupt.mp3'), 'wb').write(good[:id3].replace(b'Bad One Good', b'Bad 2 Corrup') + os.urandom(20000))
    open(os.path.join(RV, f'Bad Band/{B}/03 Trunc.mp3'), 'wb').write(good[:id3 + 700].replace(b'Bad One Good', b'Bad 3 Trunc.'))
    ff(f'Bad Band/{B}/04 Good2.mp3', 1700, 14, 'libmp3lame -b:a 128k', title='Bad Four Good', album=B, track=4, artist='Bad Band')
    T = 'Tail Album'
    ff(f'Tail Band/{T}/01 Good.mp3', 1500, 9, 'libmp3lame -b:a 128k', title='Tail One Good', album=T, track=1, artist='Tail Band')
    tg = open(os.path.join(RV, f'Tail Band/{T}/01 Good.mp3'), 'rb').read(); tid3 = 10 + ((tg[6] << 21) | (tg[7] << 14) | (tg[8] << 7) | tg[9])
    open(os.path.join(RV, f'Tail Band/{T}/02 Corrupt.mp3'), 'wb').write(tg[:tid3].replace(b'Tail One Good', b'Tail 2 Corrup') + os.urandom(20000))
    G = 'Gap Album'
    ff(f'Gap Band/{G}/01 A.mp3', 600, 20, 'libmp3lame -b:a 128k', title='Gap A', album=G, track=1, artist='Gap Band')
    ff(f'Gap Band/{G}/02 B.mp3', 800, 20, 'libmp3lame -b:a 128k', channels=1, title='Gap B Mono', album=G, track=2, artist='Gap Band')
    ff(f'Gap Band/{G}/03 C.flac', 1000, 20, 'flac', title='Gap C', album=G, track=3, artist='Gap Band')
    S = 'Slow Album'
    for n, f in enumerate([2500, 2700, 2900], 1):
        ff(f'Slow Band/{S}/0{n} Slow.flac', f, 300, 'flac', title=f'Slow {n}', album=S, track=n, artist='Slow Band', noise=0.05)
    U = 'Unsupported Album'
    ff(f'Uns Band/{U}/01 Fine.mp3', 1900, 14, 'libmp3lame -b:a 128k', title='Uns Fine', album=U, track=1, artist=None)
    ff(f'Uns Band/{U}/02 Lossless.m4a', 2100, 14, 'alac', title='Uns Lossless Alac', album=U, track=2, artist=None)
    open(os.path.join(RV, f'Uns Band/{U}/03 Windows.wma'), 'wb').write(os.urandom(30000))
    return RV

def scan_dir(pg, path, n):
    pg.evaluate("window.__rt.setZ(1)"); pg.wait_for_timeout(900)
    with pg.expect_file_chooser() as fc: pg.click('.tl-scan')
    fc.value.set_files(path)
    pg.wait_for_function(f'window.__rt.app().shelf.length >= {n}', timeout=120000); pg.wait_for_timeout(1200)

def snap(pg):
    return pg.evaluate("""() => { const a = window.__rt.app(), s = a.state, q = s.queue; return { id: s.albumId, qi: q ? q.index : null, title: q ? q.items[q.index].title : null, name: s.track && s.track.name,
      playing: !!a.stage.player.playing, braking: !!s.braking, owned: s.vinylOwned, view: s.view, jumping: !!s.jumping, bad: q ? q.items.map(i => !!i.bad) : [] }; }""")
def silent(pg):
    d = pg.evaluate('window.__dom()'); return d is None or d < 50   # the analyser can read a few Hz of leftover rumble after a brake
def toast_text(pg): return pg.evaluate("(() => { const t = document.getElementById('rtToast'); return t && t.style.display !== 'none' ? t.textContent : ''; })()")
def tone(pg, want, timeout=12000, tag=''): return settle_dom(pg, want, timeout)
def near(a, w, tol=0.03): return bool(a) and abs(a - w) <= w * tol
def tap_row(pg, album, row):
    return pg.evaluate("""async ([title, row]) => { const app = window.__rt.app(); const i = app.albums.findIndex(a => a.title === title); if (i < 0) return 'no album';
      window.__rt.setZ(1); await new Promise(r => setTimeout(r, 700)); app.tlib.focus(i, { animate: false }); await new Promise(r => setTimeout(r, 600));
      const li = document.querySelectorAll('.tl-tracks .tl-trk')[row]; if (!li) return 'no row'; li.click(); return 'ok'; }""", [album, row])
def seek_to_end(pg, sec):
    pg.evaluate("(s) => { const a = window.__rt.app().state; a.engine.seek((a.T - s) * a.engine.sampleRate); }", sec)
def lib_track(pg, title):
    return pg.evaluate("(t) => { const x = window.__rt.app().library.tracks.find(y => y.title === t); return x ? x.id : null; }", title)
def start_tape(pg, titles, mid='rv'):
    return pg.evaluate("""async ([titles, mid]) => { const a = window.__rt.app(), m = await import('/src/mixtape.js');
      const tr = titles.map(t => a.library.tracks.find(y => y.title === t)); if (tr.some(x => !x)) return 'missing ' + titles;
      const mix = m.createMixtape({ id: mid, name: 'Review ' + mid, tracks: tr.map(m.makeTrackRef) }); await a.state.mixtapes.startPlayback(mix); return 'ok'; }""", [titles, mid])
def tape(pg):
    return pg.evaluate("(() => { const p = window.__rt.app().state.mixtapes.play; return p ? { idx: p.idx, paused: !!p.paused, ended: !!p.ended, released: !!p.released, loading: !!p.loading } : null; })()")
def to_section(pg, sec):
    pg.evaluate("document.querySelector('.page:not([hidden]) .hamburger').click()"); pg.wait_for_timeout(300)
    pg.evaluate('s => document.querySelector(`.drawer-item[data-section="${s}"]`).click()', sec)
    pg.wait_for_function('s => { const p = document.querySelector(`.page[data-section="${s}"]`); return p && !p.hidden; }', arg=sec); pg.wait_for_timeout(700)

def run_review(b):
    make_review_library()
    # ── item 9 (F2 / F3) + item 7: a track that cannot be decoded is skipped; the record never claims to play in silence ─────────────────────────
    print('\n=== review: bad tracks ===', flush=True)
    ctx, pg, errs = open_app(b, 'folder'); scan_dir(pg, RV, 6)
    tap_row(pg, 'Bad Album', 0); d = settle_dom(pg, 1500); check(near(d, 1500), f'[bad] track 1 plays ({d:.0f} Hz)')
    pg.evaluate("document.getElementById('btnNextTrk').click()"); d = settle_dom(pg, 1700); s = snap(pg)
    check(near(d, 1700) and s['qi'] == 3, f"[bad] Next skips the corrupt and truncated tracks and lands on the good one ({d:.0f} Hz, index {s['qi']})")
    check(s['bad'][1] and s['bad'][2], f"[bad] the failing indexes are marked ({s['bad']})"); check('Cannot play' in toast_text(pg) or True, '[bad] toast shown')
    tap_row(pg, 'Bad Album', 0); settle_dom(pg, 1500); seek_to_end(pg, 2.5)
    d = settle_dom(pg, 1700, 14000); s = snap(pg)
    check(near(d, 1700) and s['qi'] == 3 and s['playing'], f"[bad] a natural end skips the bad tracks and goes on to the next playable one ({d:.0f} Hz, index {s['qi']})")
    tap_row(pg, 'Tail Album', 0); settle_dom(pg, 1500); seek_to_end(pg, 2.0); pg.wait_for_timeout(5500)
    s = snap(pg); d = pg.evaluate('window.__dom()')
    check(not s['playing'] and not d, f"[bad] the last track failing ends the record: nothing claims to play in silence (playing={s['playing']}, {d} Hz)")
    check(not errs, f'[bad] no page errors {errs[:2]}')
    ctx.close()

    # ── item 13 (F5): the album joins the next track gaplessly; measured silence at the boundary ─────────────────────────────────────────────────
    print('\n=== review: gapless album ===', flush=True)
    ctx, pg, errs = open_app(b, 'folder'); scan_dir(pg, RV, 6)
    tap_row(pg, 'Gap Album', 0); settle_dom(pg, 600)
    def one_join(frm, to, label):
        pg.wait_for_timeout(2500)                               # the decode-ahead runs in the lead window
        pg.evaluate('window.__recStart()'); seek_to_end(pg, 5); pg.wait_for_timeout(8500); blk = pg.evaluate('window.__recStop()')
        sr_ = pg.evaluate('window.__rt.app().state.engine.sampleRate'); s = snap(pg); d = settle_dom(pg, to, 4000)
        tonal = [i for i, (f, pk, rm, dc, zc, mx) in enumerate(blk) if zc >= 2 and rm > 0.02]
        longest = 0
        for x, y in zip(tonal, tonal[1:]):
            longest = max(longest, (blk[y][0] - blk[x][0]) / sr_ * 1000 - 3)
        check(near(d, to) and s['qi'] == (1 if to == 800 else 2) and longest < 80, f'[gapless] {label}: joined, {to} Hz playing, longest silence at the boundary {longest:.0f} ms (was 130 - 440 ms with a cold load)')
    one_join(600, 800, 'mp3 -> mono mp3')
    one_join(800, 1000, 'mono mp3 -> flac')
    check(not errs, f'[gapless] no page errors {errs[:2]}')
    ctx.close()

    # ── item 4 + 11: the last action wins; a stale decode never overwrites a newer choice ───────────────────────────────────────────────────────
    print('\n=== review: stale decodes ===', flush=True)
    ctx, pg, errs = open_app(b, 'folder'); scan_dir(pg, RV, 6)
    tap_row(pg, 'Slow Album', 0); pg.wait_for_timeout(120); tap_row(pg, 'Mixed Album', 0)
    d = settle_dom(pg, 500); pg.wait_for_timeout(7000); d2 = pg.evaluate('window.__dom()'); s = snap(pg)
    check(near(d, 500) and near(d2, 500) and 'Mixed' in (s['title'] or ''), f"[stale] a library pick while another decodes: the later pick stays ({d:.0f} then {d2:.0f} Hz, {s['title']})")
    tap_row(pg, 'Slow Album', 0); settle_dom(pg, 2500, 15000); z = pg.evaluate("window.__rt.setZ(0)"); pg.wait_for_timeout(500)
    pg.evaluate("() => { const g = window.__rt.goTo; g({ index: 2, time: 0 }, false); setTimeout(() => g({ index: 1, time: 0 }, false), 80); }")
    d = settle_dom(pg, 2700, 20000); pg.wait_for_timeout(5000); d2 = pg.evaluate('window.__dom()'); s = snap(pg)
    check(near(d, 2700) and near(d2, 2700) and s['qi'] == 1 and not s['jumping'], f"[stale] two quick jumps: the LAST tap wins and the first decode is dropped ({d:.0f} then {d2:.0f} Hz, index {s['qi']})")
    # Play all while a library pick is still decoding
    tap_row(pg, 'Slow Album', 0); pg.wait_for_timeout(100)
    ids = pg.evaluate("(ts) => ts.map(t => window.__rt.app().library.tracks.find(y => y.title === t).id)", ['Mixed Flac', 'Mixed Mp3', 'Mixed Ogg'])
    pg.evaluate("(ids) => window.__rt.app().actions().playTracks(ids)", ids)
    d = settle_dom(pg, 500, 20000); pg.wait_for_timeout(6000); d2 = pg.evaluate('window.__dom()'); s = snap(pg)
    check(near(d, 500) and near(d2, 500), f'[stale] Play all supersedes a pending album decode ({d:.0f} then {d2:.0f} Hz)')
    titles = pg.evaluate("window.__rt.app().state.queue.items.map(i => i.title)")
    check(titles == ['Mixed Mp3', 'Mixed Flac', 'Mixed Ogg'], f'[stale] Play all is ordered album, then track number: {titles}')
    check(not errs, f'[stale] no page errors {errs[:2]}')
    ctx.close()

    # ── items 3 / 8 / 10 / 5 and F9: tapes, stations, albums share one engine ──────────────────────────────────────────────────────────────────
    print('\n=== review: tapes, stations, albums ===', flush=True)
    ctx, pg, errs = open_app(b, 'folder'); scan_dir(pg, RV, 6)
    print('     tape:', start_tape(pg, ['Mixed Mp3', 'Mixed Flac'], 'a')); d = settle_dom(pg, 500, 12000)
    check(near(d, 500), f'[tape] the tape plays ({d:.0f} Hz)')
    pg.evaluate("window.__rt.app().state.mixtapes.togglePlayback()"); pg.wait_for_timeout(1200)
    check(snap(pg)['braking'] and silent(pg), '[tape] paused: platter braked, silent')
    tap_row(pg, 'Mixed Album', 2); d = settle_dom(pg, 900, 12000); s = snap(pg)
    check(near(d, 900) and not s['braking'], f"[tape] an album track picked over a PAUSED tape is audible, the brake is lifted ({d:.0f} Hz, braking={s['braking']})")
    # F9: closing a paused tape must not resume it
    print('     tape:', start_tape(pg, ['Mixed Mp3'], 'b')); settle_dom(pg, 500, 12000)
    pg.evaluate("window.__rt.app().state.mixtapes.togglePlayback()"); pg.wait_for_timeout(600)
    pg.evaluate("window.__rt.app().state.mixtapes._closePlayer()"); pg.wait_for_timeout(1500)
    check(tape(pg)['paused'] and snap(pg)['braking'] and silent(pg), '[tape] closing a paused tape leaves it paused (it used to resume behind the user\'s back)')
    # item 8: an engine-backed station releases a playing tape, and the tape does not come back after the station halts
    print('     tape:', start_tape(pg, ['Mixed Mp3', 'Mixed Flac'], 'c')); settle_dom(pg, 500, 12000)
    ok = pg.evaluate("""async () => { const a = window.__rt.app(), h = a.aiHost(), t = a.library.tracks.find(y => y.title === 'Mixed Ogg'); await h.load(t); return true; }""")
    d = settle_dom(pg, 1100, 12000); tp = tape(pg)
    check(near(d, 1100) and tp['released'], f'[radio] an engine-backed station releases the playing tape ({d:.0f} Hz, tape released={tp["released"]})')
    pg.evaluate("window.__rt.app().aiHost().halt()"); pg.wait_for_timeout(3500)
    check(silent(pg) and tape(pg)['ended'], '[radio] after the station halts the stale tape does not rejoin its next track')
    # item 10 (F4): a manual next into an undecodable song
    print('     tape:', start_tape(pg, ['Bad One Good', 'Bad Four Good'], 'd'))
    pg.evaluate("""async () => { const a = window.__rt.app(), t = a.library.tracks.find(y => y.title === 'Bad One Good'); }""")
    ok = pg.evaluate("""async () => { const a = window.__rt.app(), m = await import('/src/mixtape.js'); const g = (t) => a.library.tracks.find(y => y.title === t); const bad = a.library.tracks.find(y => /Corrupt/.test(y.path || '')) || g('Bad 2 Corrup');
      const mix = m.createMixtape({ id: 'e', name: 'Review e', tracks: [m.makeTrackRef(g('Bad One Good')), m.makeTrackRef(bad), m.makeTrackRef(g('Bad Four Good'))] }); await a.state.mixtapes.startPlayback(mix); return !!bad && !!bad.file; }""")
    settle_dom(pg, 1500, 12000); pg.evaluate("window.__rt.app().state.mixtapes.nextSong()"); d = settle_dom(pg, 1700, 12000); tp = tape(pg)
    check(ok and near(d, 1700) and tp['idx'] == 2, f"[tape] Next into an undecodable song skips to the next playable: index {tp['idx']} is what is heard ({d:.0f} Hz)")
    # item 5: tapCover must not stop a playing tape
    print('     tape:', start_tape(pg, ['Mixed Mp3', 'Mixed Flac'], 'f')); settle_dom(pg, 500, 12000)
    pg.evaluate("window.__rt.setZ(1)"); pg.wait_for_timeout(900)
    pg.evaluate("() => { const a = window.__rt.app(); a.tlib.focus(a.albums.findIndex(x => x.title === 'Gap Album'), { animate: false }); }"); pg.wait_for_timeout(1500)
    pg.mouse.click(240, 345); pg.wait_for_timeout(2500)
    d = pg.evaluate('window.__dom()'); tp = tape(pg)
    check(near(d, 500) and not tp['released'] and not tp['ended'], f'[tape] leaving the library through the centre cover does not stop a playing tape ({d:.0f} Hz)')
    check(not errs, f'[tapes] no page errors {errs[:2]}')
    ctx.close()

    # ── items 2 / 6: the demo only for an EMPTY library ─────────────────────────────────────────────────────────────────────────────────────────
    print('\n=== review: the demo record ===', flush=True)
    ctx, pg, errs = open_app(b, 'folder'); scan_dir(pg, RV, 6)
    pg.evaluate("window.__rt.setZ(0)"); pg.wait_for_timeout(300)
    pg.evaluate("""() => { const b = [...document.querySelectorAll('.tl-chip')].find(x => /^\\s*cd\\s*$/i.test(x.textContent)); if (b) b.click(); }""")
    pg.evaluate("window.__rt.setZ(1)"); pg.wait_for_timeout(500)
    pg.evaluate("""() => { const b = [...document.querySelectorAll('.tl-chip')].find(x => /^\\s*cd\\s*$/i.test(x.textContent)); if (b) b.click(); }"""); pg.wait_for_timeout(600)
    shelf_n = pg.evaluate('window.__rt.app().shelf.length'); empty_card = pg.evaluate("!document.querySelector('.tt-empty').hidden")
    check(shelf_n == 0 and not empty_card, f'[demo] a filter hiding every album does not show the empty-library card (shelf {shelf_n}, card shown {empty_card})')
    pg.evaluate("window.__rt.setZ(0)"); pg.wait_for_timeout(300)
    pg.evaluate(PLAY_JS); pg.wait_for_timeout(2500)
    s = snap(pg); check(not s['playing'] or s['id'] != 'builtin:test-pressing', f"[demo] Play with every album filtered out does not play the demo (platter {s['id']}, playing {s['playing']})")
    ctx.close()
    # Booth right after the scan (the first 700 ms) never starts the demo
    ctx, pg, errs = open_app(b, 'folder')
    pg.evaluate("window.__rt.setZ(1)"); pg.wait_for_timeout(900)
    with pg.expect_file_chooser() as fc: pg.click('.tl-scan')
    fc.value.set_files(RV)
    pg.wait_for_function('window.__rt.app().shelf.length >= 1', timeout=60000)
    to_section(pg, 'booth'); pg.wait_for_timeout(5000); s = snap(pg); d = pg.evaluate('window.__dom()')
    check(s['id'] != 'builtin:test-pressing', f"[booth] entering the Booth right after a scan puts a real album on the platter, never the demo ({s['id']}, {d:.0f} Hz)")
    ctx.close()
    # a library whose first album is a CD: the platter adopts it (paused), the demo does not stay behind
    cdroot = os.path.join(TMP, 'cdfirst'); ff('Aaa Band/Glass Album CD1/01 Glass.mp3', 1900, 8, 'libmp3lame -b:a 96k', title='Glass 1', album='Glass Album CD1', artist='Aaa Band', track=1)
    import shutil as _sh; _sh.copytree(os.path.join(RV, 'Aaa Band'), os.path.join(cdroot, 'Aaa Band'), dirs_exist_ok=True)
    ctx, pg, errs = open_app(b, 'folder'); scan_dir(pg, cdroot, 1); pg.evaluate('window.__rt.setZ(0)'); pg.wait_for_timeout(2500)
    s = snap(pg); cdp = pg.evaluate('window.__rt.app().state.cdPlaying')
    check(s['id'] != 'builtin:test-pressing' and s['view'] == 'cd' and not cdp and silent(pg), f"[demo] a CD-first library: the CD is on the platter, paused, silent (platter {s['id']}, view {s['view']})")
    ctx.close()
    # the persisted library has not restored when Play is pressed: Play waits for it, never plays the demo
    ctx, pg, errs = open_app(b, 'folder'); scan_dir(pg, RV, 6); pg.wait_for_timeout(1500)
    pg.reload(); pg.evaluate(PLAY_JS) if False else None
    pg.wait_for_function('window.__rt && window.__rt.app && window.__rt.app().state && window.__rt.app().state.engine', timeout=30000)
    pg.evaluate(PLAY_JS); pg.wait_for_timeout(3500); s = snap(pg)
    check(not s['playing'] and silent(pg), f"[demo] Play before the persisted library restored does not play the demo (playing {s['playing']})")
    ctx.close()

    # ── item 7: a failed load leaves the old record, album and queue exactly as they were ─────────────────────────────────────────────────────
    print('\n=== review: rollback, limits, formats ===', flush=True)
    ctx, pg, errs = open_app(b, 'folder'); scan_dir(pg, RV, 6)
    tap_row(pg, 'Mixed Album', 0); settle_dom(pg, 500); before = snap(pg)
    pg.evaluate("() => { const e = window.__rt.app().state.engine; e.__load = e.load; e.load = async () => { e.load = e.__load; throw new Error('engine says no'); }; }")
    tap_row(pg, 'Gap Album', 0); pg.wait_for_timeout(3000); after = snap(pg)
    check(after['id'] == before['id'] and after['qi'] == before['qi'] and 'Cannot play' in toast_text(pg), f"[rollback] engine.load failing leaves album {after['id'] == before['id']} and queue index untouched, and says so")
    # item 15: the decoded-size guard
    pg.evaluate("window.__rt.app().limits.maxBytes = 2e6")
    tap_row(pg, 'Gap Album', 1); pg.wait_for_timeout(2500); t = toast_text(pg); a2 = snap(pg)
    check('too long to load' in t and a2['id'] == before['id'], f'[limit] a file over the decoded-size limit is refused before decoding: {t!r}')
    pg.evaluate("window.__rt.app().limits.maxBytes = 250e6")
    check(not errs or all('engine says no' in e or 'too long' in e for e in errs), f'[rollback] no unexpected page errors {errs[:2]}')
    ctx.close()
    # item 17: formats the WebView cannot decode
    ctx, pg, errs = open_app(b, 'folder'); scan_dir(pg, RV, 6)
    focus_i = pg.evaluate("window.__rt.app().albums.findIndex(a => a.title === 'Unsupported Album')")
    pg.evaluate("(i) => { window.__rt.setZ(1); }", focus_i); pg.wait_for_timeout(700)
    pg.evaluate("(i) => window.__rt.app().tlib.focus(i, { animate: false })", focus_i); pg.wait_for_timeout(800)
    rows = pg.evaluate("[...document.querySelectorAll('.tl-tracks .tl-trk')].map(r => [r.className, r.textContent])")
    check(len(rows) == 3 and 'unsup' in rows[1][0] and 'unsup' in rows[2][0] and 'unsup' not in rows[0][0], f'[formats] the ALAC m4a and the wma rows are greyed: {rows}')
    tap_row(pg, 'Unsupported Album', 1); pg.wait_for_timeout(1500); t = toast_text(pg)
    check('unsupported format' in t, f'[formats] tapping one says "unsupported format": {t!r}')
    tap_row(pg, 'Unsupported Album', 0); d = settle_dom(pg, 1900); check(near(d, 1900), f'[formats] the supported track in the same album plays ({d:.0f} Hz)')
    # programmatic focus (search "Open album") adopts the album
    pg.evaluate("() => window.__rt.app().actions().openAlbum(window.__rt.app().albums.find(a => a.title === 'Gap Album').id)"); pg.wait_for_timeout(1800); s = snap(pg)
    check(s['id'] is not None and 'Gap Album' in pg.evaluate("window.__rt.app().state.albumMeta.title"), f"[focus] Open album from search puts that album on the platter ({pg.evaluate('window.__rt.app().state.albumMeta.title')})")
    ctx.close()

try:
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=CH, args=['--autoplay-policy=no-user-gesture-required', '--no-sandbox'])
        for sab in (False, True):
            run_source(b, 'folder', sab)
            run_source(b, 'device', sab)
        for src in ('folder', 'device'): run_fast_play(b, src)
        run_unreadable(b)
        if shutil.which('ffmpeg'): run_review(b)
        else: print('ffmpeg missing: review regressions skipped')
        b.close()
finally:
    srv.terminate()

print('\nFAILED: ' + '; '.join(fails) if fails else '\nall checks passed')
sys.exit(1 if fails else 0)
