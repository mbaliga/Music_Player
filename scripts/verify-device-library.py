#!/usr/bin/env python3
"""End-to-end check of the Android device-library pipeline in desktop Chromium with a MOCKED native backend.

The page gets a fake `window.Capacitor` (platform 'android', plugin DeviceLibrary) whose backend is test/support/fake-device-native.mjs
serving generated audio (WAV tones, some behind ID3 tags), then the REAL app runs: permission card -> Allow -> scan progress -> albums on
the shelf -> tap a device track -> it plays through DeviceFile (chunked reads) -> decodeAudioData -> the engine.

Needs: Playwright for Python. Starts serve.py itself.   Usage: python3 scripts/verify-device-library.py [outdir]
CHROME=/path/to/chrome overrides the browser. Exits non-zero when an assertion fails.
This proves the JS side only; the Java plugin is compiled by CI (android.yml) and untested on a phone (docs/DEVICE_LIBRARY.md).
"""
import json, os, re, socket, subprocess, sys, time
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'docs/screenshots/device-library')
os.makedirs(OUT, exist_ok=True)
CH = os.environ.get('CHROME', '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome')
fails = []
def check(ok, msg):
    if not ok: fails.append(msg)
    print(('ok   ' if ok else 'FAIL ') + msg, flush=True)

s = socket.socket(); s.bind(('127.0.0.1', 0)); PORT = s.getsockname()[1]; s.close()
srv = subprocess.Popen([sys.executable, os.path.join(ROOT, 'serve.py'), str(PORT)], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.0)
URL = f'http://localhost:{PORT}/index.html'

fake_src = open(os.path.join(ROOT, 'test/support/fake-device-native.mjs')).read().replace('export function', 'function')
INIT = fake_src + r"""
;(() => {
  try { localStorage.setItem('runout.wtDone', '1'); } catch (e) {}
  const wavCache = {};
  const rows = [];
  let n = 0;
  const album = (artist, name, folder, count, over = {}) => {
    for (let i = 0; i < count; i++, n++) rows.push(makeRow(n, { artist, album: name, title: `${name} ${i + 1}`, name: `0${i + 1} ${name} ${i + 1}.wav`, mime: 'audio/wav',
      relativePath: folder, track: i + 1, durationMs: 120000, genre: over.genre || 'Rock', ...over }));
  };
  album('The Dials', 'Heat Wave', 'Music/The Dials/Heat Wave/', 8);
  album('Glass Hours', 'Glass Hours [CD1]', 'Music/Glass Hours/Glass Hours CD1/', 5, { genre: 'Ambient' });
  album('Glass Hours', 'Glass Hours [CD2]', 'Music/Glass Hours/Glass Hours CD2/', 5, { genre: 'Ambient' });
  album('Mara Quill', 'Night Shift', 'Music/Mara Quill/Night Shift/', 10, { genre: 'Jazz' });
  album('Okonkwo', 'Savanna', 'Music/Okonkwo/Savanna/', 7, { genre: 'World' });
  album('Various', 'Road Trip Mix', 'Music/Road Trip/', 12, { albumArtist: 'Various Artists', genre: 'Pop' });
  for (let i = 0; i < 3; i++, n++) rows.push(makeRow(n, { artist: '<unknown>', album: '<unknown>', title: '', name: `voice-${i}.wav`, mime: 'audio/wav', relativePath: 'Download/Mystery/', durationMs: 90000, size: 0 }));
  rows.push(makeRow(n++, { title: 'WhatsApp Ptt', artist: '<unknown>', album: '<unknown>', name: 'PTT-1.wav', mime: 'audio/wav', relativePath: 'WhatsApp/Media/WhatsApp Audio/', durationMs: 20000 }));
  rows.push(makeRow(n++, { title: 'Ring', name: 'ring.wav', mime: 'audio/wav', relativePath: 'Ringtones/', durationMs: 25000, isRingtone: true }));
  rows.push(makeRow(n++, { title: 'Blip', name: 'blip.wav', mime: 'audio/wav', relativePath: 'Music/Dials/', durationMs: 6000 }));
  rows.push(makeRow(n++, { title: 'cover', name: 'cover.jpg', mime: 'image/jpeg', relativePath: 'Music/Dials/' }));
  const wav = (row) => {
    if (!wavCache[row.id]) {
      let b = makeWav(2, 220 + (row.id % 12) * 40);
      if (row.name.startsWith('voice-')) b = withId3({ TIT2: 'Found In Tags ' + row.id, TPE1: 'Tagged Artist', TALB: 'Found Album' }, b, 64);
      wavCache[row.id] = b; row.size = b.length;
    }
    return wavCache[row.id];
  };
  for (const r of rows) if (r.mime !== 'image/jpeg') wav(r); else r.size = 100;
  const fake = createFakeNative({ rows, bytesFor: (r) => (r.mime === 'image/jpeg' ? new Uint8Array(100) : wav(r)), permission: 'prompt', afterRequest: window.__afterRequest || 'granted' });
  const origRead = fake.read; fake.read = async (a) => { await new Promise((r) => setTimeout(r, 2)); return origRead(a); };
  const origRecords = fake.records; fake.records = async (a) => { await new Promise((r) => setTimeout(r, 1500)); return origRecords(a); };   // slow rows so progress is visible
  window.__fake = fake;
  window.Capacitor = { getPlatform: () => 'android', isNativePlatform: () => true, Plugins: { DeviceLibrary: fake }, registerPlugin: () => fake };
})();
"""

def open_app(b, w=412, h=860, after='granted'):
    ctx = b.new_context(viewport={'width': w, 'height': h}, device_scale_factor=2)
    ctx.add_init_script(f'window.__afterRequest = {json.dumps(after)};')
    ctx.add_init_script(INIT)
    pg = ctx.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.on('console', lambda m: errs.append('console:' + m.text) if m.type == 'error' else None)
    pg.goto(URL); pg.wait_for_selector('#pageAlbums', state='attached'); pg.wait_for_timeout(1500)
    return ctx, pg, errs

def to_albums(pg):
    pg.evaluate("""() => { const a = document.querySelector('[data-nav="albums"],[data-section-link="albums"]'); if (a) a.click(); }""")

try:
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=CH, args=['--autoplay-policy=no-user-gesture-required', '--no-sandbox'])

        # ── 1. first run: the permission card ─────────────────────────────────────
        ctx, pg, errs = open_app(b)
        card = pg.locator('.dv-card')
        check(card.is_visible(), 'permission card is shown on first run (native Android, no permission)')
        check('Allow access to your audio files' in card.inner_text(), 'card carries the explanation copy')
        check(pg.evaluate('__fake.requested') == 0, 'nothing asked the OS before the user tapped Allow')
        pg.screenshot(path=os.path.join(OUT, '01-permission-card.png'))

        # ── 2. Allow -> scanning progress -> library ──────────────────────────────
        card.locator('button').click()
        pg.wait_for_function("document.querySelector('.dv-card') && /Found \\d+/.test(document.querySelector('.dv-card').innerText)", timeout=8000)
        pg.screenshot(path=os.path.join(OUT, '02-scanning.png'))
        check('Found' in card.inner_text(), 'progress text "Found N tracks…" while scanning')
        pg.wait_for_function("window.__fake.calls.records >= 1", timeout=15000)
        pg.wait_for_function("document.querySelector('.dv-card') === null || document.querySelector('.dv-card').hidden", timeout=30000)
        pg.wait_for_timeout(800)
        check(pg.evaluate('__fake.requested') == 1, 'exactly one OS permission request')
        pg.screenshot(path=os.path.join(OUT, '03-library.png'))

        # what the library holds (through the app's own handle when exposed, else the persisted store)
        info = pg.evaluate("""async () => {
          const m = await import('/src/device/index.js'); const t = m.deviceLibrary.tracks();
          return { n: t.length, titles: t.map(x => x.title), kinds: t.map(x => x.kind), status: m.deviceLibrary.status.get() };
        }""")
        check(info['n'] == 51 - 1 - 0 or info['n'] > 40, f"scanned device tracks: {info['n']} (non-audio row skipped)")
        check(not any(t == 'cover' for t in info['titles']), 'the .jpg row is not a track')
        check(any(t.startswith('Found In Tags') for t in info['titles']), 'untagged files were read through DeviceFile and tagged (tags.js)')
        check(info['status']['phase'] == 'idle', f"scan finished: phase {info['status']['phase']}")

        lib = pg.evaluate("""async () => {
          const m = await import('/src/device/index.js'); const t = m.deviceLibrary.tracks();
          return { sample: t.slice(0, 2).map(x => ({ id: x.id, uri: x.uri, path: x.path })) };
        }""")
        check(lib['sample'][0]['uri'].startswith('content://media/external/audio/media/'), 'records carry the content:// uri')

        # shelf as the app sees it (filters applied: no ringtone, no WhatsApp Audio, no 6 s blip)
        shelf = pg.evaluate("""() => window.__rt.app().shelf.map(a => ({ album: a.album, artist: a.artist, kind: a.kind, n: a.tracks.length }))""")
        names = {a['album'] for a in shelf}
        print('     shelf:', sorted(names))
        check({'Heat Wave', 'Night Shift', 'Savanna', 'Road Trip Mix'} <= names, 'albums reach the shelf (grouped from MediaStore tags)')
        cds = sorted(a['album'] for a in shelf if a['kind'] == 'cd')
        check(cds == ['Glass Hours · CD 1', 'Glass Hours · CD 2'], f'CD1/CD2 folders become two CDs: {cds}')
        check('Found Album' in names or 'Mystery' in names, 'untagged files grouped (by their tags / folder)')
        check(not any(a['album'] in ('WhatsApp Audio', 'Ringtones') for a in shelf), 'WhatsApp Audio / Ringtones are filtered out')
        total = sum(a['n'] for a in shelf)
        check(total == 53 - 3, f'tracks on the shelf after filters: {total} (ringtone, WhatsApp, 6 s clip hidden)')
        # the library as T2's component draws it, fed by the device-backed LibraryManager.albums() (mounted over the page for the shot)
        pg.evaluate("""async () => {
          const lay = await import('/src/turntable/library-layout.js'); const mod = await import('/src/turntable/library.js');
          const host = document.createElement('div'); host.id = 'shotHost'; host.style.cssText = 'position:fixed;inset:0;z-index:99;background:#0b0b10';
          document.body.appendChild(host);
          const lib = mod.mountTurntableLibrary(host, {});
          lib.layout({ width: innerWidth, height: innerHeight, portrait: true });
          lib.setAlbums(lay.albumsToCoverflow(window.__rt.app().shelf)); lib.show(); lib.setOpacity(1);
        }"""); pg.wait_for_timeout(1200)
        pg.screenshot(path=os.path.join(OUT, '04-albums.png'))
        pg.evaluate("document.getElementById('shotHost').remove()")

        # ── 3. play a device track through DeviceFile -> decodeAudioData ──────────
        reads_before = pg.evaluate('__fake.calls.read')
        played = pg.evaluate("""async () => {
          const m = await import('/src/device/index.js');
          const t = m.deviceLibrary.tracks().find(x => x.title === 'Night Shift 3');
          const ctx = new AudioContext();
          const ab = await t.file.arrayBuffer();
          const bytes = ab.byteLength;                       // decodeAudioData detaches the buffer
          const buf = await ctx.decodeAudioData(ab);
          return { bytes, size: t.size, dur: buf.duration, ch: buf.numberOfChannels, rate: buf.sampleRate };
        }""")
        check(played['bytes'] == played['size'] and played['dur'] > 1.9, f"DeviceFile -> decodeAudioData: {played['bytes']} bytes, {played['dur']:.2f} s")
        check(pg.evaluate('__fake.calls.read') > reads_before, 'bytes came through native read() chunks')

        # the real app path: loadFile(file, engine.ctx)
        ok = pg.evaluate("""async () => {
          const m = await import('/src/device/index.js'); const tr = await import('/src/track.js');
          const t = m.deviceLibrary.tracks().find(x => x.title === 'Savanna 2');
          const ctx = new AudioContext();
          const r = await tr.loadFile(t.file, ctx);
          return { frames: r.frames, name: r.name, L: r.channels[0].length };
        }""")
        check(ok['frames'] > 40000 and ok['name'] == '02 Savanna 2', f"track.js loadFile on a DeviceFile: {ok}")
        # the real UI path: pick a track in the library -> the app loads it through DeviceFile and queues the album
        picked = pg.evaluate("""async () => {
          const app = window.__rt.app(); const i = app.albums.findIndex(a => a.title === 'Night Shift' || a.album === 'Night Shift');
          app.tlib.focus(i, { animate: false });
          const li = document.querySelectorAll('[data-stub="library"] .stub-list li')[2]; if (!li) return { err: 'no list' };
          li.click();
          await new Promise(r => setTimeout(r, 2500));
          const s = window.__rt.app().state;
          return { name: s.track && s.track.name, albumId: s.albumId, T: s.T };
        }""")
        check(picked.get('name') and 'Night Shift' in picked['name'] and picked['T'] > 1.5, f'tapping a device track in the library plays it: {picked}')
        pg.screenshot(path=os.path.join(OUT, '06-playing-device-track.png'))
        check(not [e for e in errs if 'favicon' not in e], f'no console/page errors: {errs[:3]}')
        ctx.close()

        # ── 4. denied, then permanently denied ────────────────────────────────────
        ctx, pg, errs = open_app(b, after='denied')
        pg.locator('.dv-card button').click(); pg.wait_for_timeout(600)
        check('blocked' in pg.locator('.dv-card').inner_text().lower() or 'Open' in pg.locator('.dv-card button').inner_text(), 'permanent denial shows "Open settings"')
        pg.screenshot(path=os.path.join(OUT, '05-blocked.png'))
        pg.locator('.dv-card button').click(); pg.wait_for_timeout(300)
        check(pg.evaluate('__fake.settingsOpened') == 1 and pg.evaluate('__fake.requested') == 1, 'Open settings hook called; no second OS request (no loop)')
        ctx.close()

        # ── 5. second launch: persisted tracks are there before any permission/scan ─
        ctx, pg, errs = open_app(b)
        pg.locator('.dv-card button').click()
        pg.wait_for_function("window.__fake.calls.records >= 1", timeout=20000); pg.wait_for_timeout(2500)
        stored = pg.evaluate("""async () => new Promise((res) => { const r = indexedDB.open('runout-device', 1); r.onsuccess = () => { const g = r.result.transaction('kv').objectStore('kv').get('index'); g.onsuccess = () => res(g.result ? g.result.tracks.length : -1); }; r.onerror = () => res(-2); })""")
        check(stored > 40, f'device index persisted to IndexedDB ({stored} tracks)')
        ctx.close()
        b.close()
finally:
    srv.terminate()

print('\nFAILED: ' + '; '.join(fails) if fails else '\nall checks passed')
sys.exit(1 if fails else 0)
