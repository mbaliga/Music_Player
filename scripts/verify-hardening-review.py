#!/usr/bin/env python3
"""Regression checks for the adversarial review at 9d78a0f, findings 4-9 (real ffmpeg audio, desktop Chromium; NOT a device test).

Needs: ffmpeg (libmp3lame), Playwright for Python, the dev server:  python3 serve.py 8765   (URL=... to override)
Set CHROME=/path/to/chrome when Playwright's own browser revision is missing (e.g. /opt/pw-browsers/chromium-1243/chrome-linux64/chrome).
Usage:  python3 scripts/verify-hardening-review.py [A B C D E F]       Exits non-zero when an assertion fails.

  A  (4) Booth "Open Radio" does not navigate while the device is locked; it does once unlocked
  B  (5) three rapid taps on Mixtapes "Import" open ONE dialog
  C  (6) a full / blocked localStorage: saving a tape and changing a setting say so (toast) instead of looking saved
  D  (7) web folder re-pick: deleted files leave, a modified file is not duplicated, the same song in two folders gets two ids
  E  (8) an album whose next track cannot be decoded: a toast names it, playback goes on to the next playable track
  F  (9) no "Resume <show>" banner while that show is on air; it is back after Stop
"""
import base64, os, shutil, subprocess, sys, tempfile, time
from playwright.sync_api import sync_playwright

URL = os.environ.get('URL', 'http://localhost:8765/index.html')
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TAP = open(os.path.join(ROOT, 'scripts/fixtures/audio-tap.js')).read()
TMP = tempfile.mkdtemp(prefix='hardening-')
fails = []

def check(ok, msg):
    print(('PASS ' if ok else 'FAIL ') + msg)
    if not ok: fails.append(msg)

def mk(path, freq, sec, **tags):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    meta = sum((['-metadata', f'{k}={v}'] for k, v in tags.items()), [])
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', f'sine=frequency={freq}:duration={sec}:sample_rate=44100', *meta, '-c:a', 'libmp3lame', '-b:a', '64k', path], check=True)

ADD = """async (args) => { const [names, datas] = args; const fs = names.map((n,i)=>{ const bin = Uint8Array.from(atob(datas[i]), c=>c.charCodeAt(0)); return new File([bin], n, {type:'audio/mpeg'}); }); await window.__rt.app().library.addFiles(fs); }"""
INIT = "window.__noPicker = 1; try { delete window.showDirectoryPicker; } catch (e) {} try { localStorage.setItem('runout.wtDone', '1'); } catch(e) {}"

def launch(p):
    kw = {'executable_path': os.environ['CHROME']} if os.environ.get('CHROME') else {}
    return p.chromium.launch(**kw, args=['--no-sandbox', '--autoplay-policy=no-user-gesture-required'])

def page(p, files=None, extra_init=''):
    b = launch(p); ctx = b.new_context(bypass_csp=True, viewport={'width': 412, 'height': 860}, device_scale_factor=1)
    ctx.add_init_script(TAP); ctx.add_init_script(INIT)
    if extra_init: ctx.add_init_script(extra_init)
    pg = ctx.new_page(); pg.errs = []
    pg.on('pageerror', lambda e: pg.errs.append(str(e)))
    pg.goto(URL); pg.wait_for_function('window.__rt && window.__rt.app && window.__rt.app().state && window.__rt.app().state.engine', timeout=30000)
    time.sleep(1.2)
    if files: add_files(pg, files)
    return b, pg

def rebuild(pg):
    pg.evaluate("window.__rt.setZ(1)"); pg.wait_for_timeout(300)
    for c in ('Album', 'Artist'):
        pg.evaluate("c => [...document.querySelectorAll('.tl-chip')].find(e => e.textContent.trim() === c).click()", c); pg.wait_for_timeout(300)

def add_files(pg, files):
    pg.evaluate(ADD, [[os.path.basename(f) for f in files], [base64.b64encode(open(f, 'rb').read()).decode() for f in files]])
    rebuild(pg); pg.wait_for_function('window.__rt.app().shelf.length >= 1', timeout=30000); pg.wait_for_timeout(800)
    pg.evaluate("window.__rt.setZ(0)"); pg.wait_for_timeout(300)

def section(pg): return pg.evaluate('document.querySelector(".page:not([hidden])").dataset.section')
def goto(pg, sec):
    if section(pg) == sec: return
    pg.click('.page:not([hidden]) .hamburger'); pg.wait_for_timeout(400)
    pg.click(f'.drawer-item[data-section="{sec}"]'); pg.wait_for_timeout(900)
def toast(pg): return pg.evaluate("(document.getElementById('rtToast')||{}).textContent || ''")
def dom(pg): return pg.evaluate('window.__dom()') or 0
def near(f, want): return f and abs(f - want) < want * 0.04

def lib(n=3, sec=30):
    out = []
    for i in range(n):
        f = os.path.join(TMP, 'lib', f'0{i + 1}-t{300 + 200 * i}.mp3'); mk(f, 300 + 200 * i, sec, title=f'T{300 + 200 * i}', artist='Tone Band', album='Tones', track=i + 1); out.append(f)
    return out

def test_A(p):
    import json
    url = 'http://127.0.0.1:1/x.mp3'   # never reached: only the state "a station is on" matters
    store = {'v': 1, 'favs': [{'k': 'radio-browser|rb:1', 'type': 'radio-browser', 'id': 'rb:1', 'at': 1, 'snap': {'name': 'Local FM', 'streamUrl': url, 'streamUrls': [url], 'tags': [], 'country': '', 'codec': 'MP3', 'bitrate': 128}}], 'recents': [], 'last': None}
    b, pg = page(p, lib(), extra_init="if(!localStorage.getItem('seedr')){localStorage.setItem('seedr','1');localStorage.setItem('runout.radio.v1',%s)}" % json.dumps(json.dumps(store)))
    goto(pg, 'radio'); pg.wait_for_selector('.rr-play', timeout=15000); pg.click('.rr-play >> nth=0'); pg.wait_for_timeout(800)
    goto(pg, 'booth'); pg.wait_for_selector('.fx-idle .fx-go', state='attached', timeout=15000); pg.wait_for_timeout(600)
    visible = pg.evaluate("(() => { const b = document.querySelector('.fx-idle .fx-go'); return !!(b && b.getBoundingClientRect().width && !b.hidden); })()")
    check(visible, '[A] the Booth shows its "Open Radio" button while a station is on')
    pg.evaluate("import('/src/devicemode/guard.js').then(m => m._setGuard({ locked: true }))"); pg.wait_for_timeout(200)
    pg.evaluate("document.querySelector('.fx-idle .fx-go').click()"); pg.wait_for_timeout(900)
    check(section(pg) == 'booth', f'[A] locked: the button does not navigate (section = {section(pg)})')
    pg.evaluate("import('/src/devicemode/guard.js').then(m => m._setGuard({ locked: false }))"); pg.wait_for_timeout(200)
    pg.evaluate("document.querySelector('.fx-idle .fx-go').click()"); pg.wait_for_timeout(1200)
    check(section(pg) == 'radio', f'[A] unlocked: it opens the Radio (section = {section(pg)})')
    b.close()

def test_B(p):
    b, pg = page(p, lib())
    goto(pg, 'mixtapes')
    pg.evaluate("()=>{const n=document.getElementById('mtImport');n.click();n.click();n.click()}"); pg.wait_for_timeout(900)
    n = pg.evaluate("document.querySelectorAll('.mt-dialog').length")
    check(n == 1, f'[B] three rapid taps on Import open one dialog (found {n})')
    pg.evaluate("document.querySelector('.mt-dialog .theme-x').click()"); pg.wait_for_timeout(400)
    pg.evaluate("document.getElementById('mtImport').click()"); pg.wait_for_timeout(500)
    check(pg.evaluate("document.querySelectorAll('.mt-dialog').length") == 1, '[B] after closing it, Import opens again')
    b.close()

def test_C(p):
    b, pg = page(p, lib())
    goto(pg, 'mixtapes')
    pg.evaluate("""() => { const o = Storage.prototype.setItem; window.__full = true; Storage.prototype.setItem = function (k, v) { if (window.__full && (k === 'runout.mixtapes' || k === 'runout.settings.v1')) throw new DOMException('quota', 'QuotaExceededError'); return o.call(this, k, v); }; }""")
    ids = pg.evaluate("window.__rt.app().library.tracks.map(t=>t.id)")
    pg.evaluate("ids=>window.__rt.app().actions().addToMixtape(ids)", ids); pg.wait_for_timeout(1200)
    pg.click('.ed-ov button:has-text("Save")'); pg.wait_for_timeout(900)
    t = toast(pg)
    check('could not save' in t.lower() and 'storage' in t.lower(), f'[C] saving a tape with full storage says so ({t!r})')
    pg.evaluate("document.getElementById('rtToast').textContent = ''")
    pg.evaluate("window.__rt.app().settingsStore.set('playback.shuffle', true)"); pg.wait_for_timeout(400)
    t = toast(pg)
    check('could not save' in t.lower() and 'setting' in t.lower(), f'[C] changing a setting with full storage says so ({t!r})')
    b.close()

def test_D(p):
    d = os.path.join(TMP, 'folder', 'Music'); shutil.rmtree(os.path.join(TMP, 'folder'), ignore_errors=True)
    mk(os.path.join(d, 'a.mp3'), 300, 5, title='Alpha', artist='Band', album='Rec', track=1)
    mk(os.path.join(d, 'b.mp3'), 500, 5, title='Beta', artist='Band', album='Rec', track=2)
    mk(os.path.join(d, 's1', 'dup.mp3'), 700, 5, title='Twin', artist='Band', album='Twins', track=1)
    shutil.copy(os.path.join(d, 's1', 'dup.mp3'), os.path.join(d, 's2_dup.mp3')) if False else None
    os.makedirs(os.path.join(d, 's2'), exist_ok=True); shutil.copy(os.path.join(d, 's1', 'dup.mp3'), os.path.join(d, 's2', 'dup.mp3'))
    b, pg = page(p)
    def scan():
        pg.evaluate("window.__rt.setZ(1)"); pg.wait_for_timeout(600)
        with pg.expect_file_chooser() as fc: pg.click('.tl-scan')
        fc.value.set_files(os.path.join(TMP, 'folder', 'Music')); pg.wait_for_timeout(4000)
    def rows(): return pg.evaluate("window.__rt.app().library.tracks.map(t => [t.title, t.path, t.id])")
    scan(); r1 = rows()
    check(len(r1) == 4, f'[D] first pick: 4 rows ({[x[0] for x in r1]})')
    twins = [x for x in r1 if x[0] == 'Twin']
    check(len(twins) == 2 and twins[0][2] != twins[1][2], f'[D] the same song in two folders gets two ids ({[x[2] for x in twins]})')
    os.remove(os.path.join(d, 'b.mp3'))
    mk(os.path.join(d, 'a.mp3'), 300, 8, title='Alpha', artist='Band', album='Rec', track=1)   # modified: new size and mtime
    scan(); r2 = rows()
    titles = sorted(x[0] for x in r2)
    check('Beta' not in titles, f'[D] a file deleted from the folder leaves the library on re-pick ({titles})')
    check(titles.count('Alpha') == 1, f'[D] a modified file is one row, not two ({titles})')
    twins = [x for x in r2 if x[0] == 'Twin']
    check(len(r2) == 3 and len(twins) == 2 and twins[0][2] != twins[1][2], f'[D] the twins keep their own rows and ids after the re-pick ({len(r2)} rows)')
    b.close()

def test_E(p):
    d = os.path.join(TMP, 'skip'); os.makedirs(d, exist_ok=True)
    f1, f3 = os.path.join(d, '01.mp3'), os.path.join(d, '03.mp3')
    mk(f1, 300, 6, title='Good One', artist='Skip Band', album='Skips', track=1)
    mk(f3, 900, 12, title='Good Three', artist='Skip Band', album='Skips', track=3)
    bad = os.path.join(d, '02.mp3')
    mk(bad, 500, 6, title='Broken Two', artist='Skip Band', album='Skips', track=2)
    data = bytearray(open(bad, 'rb').read()); i = data.find(b'\xff\xfb')
    for k in range(max(i, 0) + 400, len(data)): data[k] = 0x41   # keep the tags, destroy the audio frames
    open(bad, 'wb').write(bytes(data))
    b, pg = page(p, [f1, bad, f3])
    pg.evaluate("window.__rt.setZ(1)"); pg.wait_for_timeout(400)
    pg.evaluate("""async () => { const app = window.__rt.app(); app.tlib.focus(0, {animate:false}); await new Promise(r => setTimeout(r, 400)); document.querySelectorAll('.tl-tracks .tl-trk')[0].click(); }""")
    t0 = time.time(); seen = []; msgs = set()
    while time.time() - t0 < 16:
        seen.append(round(dom(pg) / 20) * 20); tt = toast(pg)
        if tt: msgs.add(tt)
        pg.wait_for_timeout(200)
    check(any('Broken Two' in m and 'skipped' in m.lower() for m in msgs), f'[E] a toast names the skipped track ({sorted(msgs)})')
    check(any(near(s, 900) for s in seen), f'[E] playback continues with the next playable track (900 Hz heard: {sorted(set(seen))})')
    b.close()

def test_F(p):
    b, pg = page(p, lib(6, 40))
    goto(pg, 'radio'); pg.wait_for_selector('.dial-play', timeout=15000)
    pg.evaluate("document.querySelectorAll('.dial-play')[1].click()"); pg.wait_for_timeout(3500)
    n = pg.evaluate("document.querySelectorAll('.radio-resume').length")
    check(n == 0, f'[F] no Resume banner while that show is on air ({n})')
    pg.evaluate('window.__rt.app().radio().stop()'); pg.wait_for_timeout(800)
    n = pg.evaluate("document.querySelectorAll('.radio-resume').length")
    check(n == 1, f'[F] the Resume banner is back after Stop ({n})')
    check(pg.evaluate("document.querySelector('.radio-resume') && document.querySelector('.radio-resume').textContent").startswith('▶Resume'), '[F] and it names the show')
    b.close()

ONLY = set(sys.argv[1:])
with sync_playwright() as p:
    for k, fn in (('A', test_A), ('B', test_B), ('C', test_C), ('D', test_D), ('E', test_E), ('F', test_F)):
        if not ONLY or k in ONLY: fn(p)
print('FAILED: %d' % len(fails) if fails else 'ALL PASSED')
sys.exit(1 if fails else 0)
