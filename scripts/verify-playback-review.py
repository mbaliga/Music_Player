#!/usr/bin/env python3
"""Regression checks for the independent playback review at 6f15b2c (real ffmpeg audio, desktop Chromium; NOT a device test).

Needs: ffmpeg (libmp3lame), Playwright for Python, the dev server:  python3 serve.py 8765   (URL=... to override)
Set CHROME=/path/to/chrome when Playwright's own browser revision is missing (e.g. /opt/pw-browsers/chromium-1243/chrome-linux64/chrome).
Usage:  python3 scripts/verify-playback-review.py        Exits non-zero when an assertion fails.

  1  a rescan inserts a track into the album already on the platter: tapping a row plays THAT row, not queue[row]
  2  a row tap inside the swipe-settle debounce window (slow decode) is not overridden by the silent adopt of track 0
  4  a CD that reaches the end of its last track pauses (mini bar / media session stop claiming it plays) and Play restarts it
  5  tapping an album track while a streamed station is on ends the station (the record is not silent under it)
  6  RadioUI.play() of a missing canned station stops the previous one;  empty library: offline show says "scan your music" with a button, no Retry
  7  Save and play on an empty new mixtape saves nothing and says "Add songs first"
"""
import base64, os, subprocess, sys, tempfile, time
from playwright.sync_api import sync_playwright

URL = os.environ.get('URL', 'http://localhost:8765/index.html')
ORIGIN = URL.rsplit('/', 1)[0]
TMP = tempfile.mkdtemp(prefix='pbreview-')
fails = []

def check(ok, msg):
    print(('PASS ' if ok else 'FAIL ') + msg); 
    if not ok: fails.append(msg)

def mk(name, freq, title, artist, album, track, sec=20):
    out = os.path.join(TMP, name + '.mp3')
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', f'sine=frequency={freq}:duration={sec}', '-metadata', f'title={title}', '-metadata', f'artist={artist}',
                    '-metadata', f'album={album}', '-metadata', f'track={track}', '-c:a', 'libmp3lame', '-b:a', '64k', out], check=True)
    return out

def b64(path): return base64.b64encode(open(path, 'rb').read()).decode()

ADD = """async (args) => { const [names, datas] = args; const fs = names.map((n,i)=>{ const bin = Uint8Array.from(atob(datas[i]), c=>c.charCodeAt(0)); return new File([bin], n+'.mp3', {type:'audio/mpeg'}); }); await window.__rt.app().library.addFiles(fs); }"""
INIT = """window.showDirectoryPicker = undefined; try { localStorage.setItem("runout.wtDone", "1"); } catch(e) {}
window.__slow = 0; const o = BaseAudioContext.prototype.decodeAudioData;
BaseAudioContext.prototype.decodeAudioData = function(...a) { const d = window.__slow; if (!d) return o.apply(this, a); return new Promise(r => setTimeout(r, d)).then(() => o.apply(this, a)); };"""
CUR = "(()=>{const a=window.__rt.app(); const q=a.state.queue; return q? q.items[q.index].title : null})()"
ZOOM = "window.__rt.app().stage.dispatch({type:'zoomTo', z:1})"
ROW = "(n)=>document.querySelector('.tl-tracks li:nth-child('+n+')').click()"

def launch(p):
    kw = {'executable_path': os.environ['CHROME']} if os.environ.get('CHROME') else {}
    return p.chromium.launch(**kw, args=['--no-sandbox', '--autoplay-policy=no-user-gesture-required'])

def fresh(p, files):
    b = launch(p); ctx = b.new_context(viewport={'width': 412, 'height': 860}); ctx.add_init_script(INIT)
    page = ctx.new_page(); page.on('pageerror', lambda e: print('PAGEERR', e))
    page.goto(URL); time.sleep(1.5)
    if files: add(page, files)
    return b, page

def rebuild(page):   # a sort-chip toggle rebuilds the shelf (the web scan path does the same through its progress callback)
    page.evaluate("[...document.querySelectorAll('.tl-chip')].find(e=>/^Album$/i.test(e.textContent)).click()"); time.sleep(0.2)
    page.evaluate("[...document.querySelectorAll('.tl-chip')].find(e=>/^Artist$/i.test(e.textContent)).click()"); time.sleep(0.6)

def add(page, files):
    page.evaluate(ADD, [[os.path.basename(f)[:-4] for f in files], [b64(f) for f in files]]); rebuild(page)

def to_section(page, sec):
    page.click('.page:not([hidden]) .hamburger'); page.click(f'.drawer-item[data-section="{sec}"]')
    page.wait_for_function('s => { const p = document.querySelector(`.page[data-section="${s}"]`); return p && !p.hidden }', arg=sec); time.sleep(0.8)

def main():
    # tracks 1,3,5 first; a rescan then adds track 2 in the middle (rows shift)
    a1, a2, a3, a0 = mk('s1', 300, 'Song1', 'Art', 'Alb', 1), mk('s2', 400, 'Song2', 'Art', 'Alb', 3), mk('s3', 500, 'Song3', 'Art', 'Alb', 5), mk('s0', 200, 'Song0', 'Art', 'Alb', 2)
    b1, b2, b3 = (mk(f'b{i}', 600 + i * 50, f'Beta{i}', 'Zed', 'Beta', i) for i in (1, 2, 3))
    c1, c2 = mk('c1', 300, 'Cd1', 'Art', 'Disc (CD1)', 1, 3), mk('c2', 600, 'Cd2', 'Art', 'Disc (CD1)', 2, 3)
    with sync_playwright() as p:
        # 1
        b, page = fresh(p, [a1, a2, a3])
        page.evaluate(ZOOM); time.sleep(1); page.evaluate(ROW, 2); time.sleep(2.5)
        check(page.evaluate(CUR) == 'Song2', '1: first tap plays row 2')
        page.evaluate(ZOOM); time.sleep(0.8); add(page, [a0])
        page.evaluate(ZOOM); time.sleep(0.8); page.evaluate(ROW, 3); time.sleep(2.5)
        check(page.evaluate(CUR) == 'Song2', '1: after the rescan shifted the rows, tapping row 3 plays Song2 (got %s)' % page.evaluate(CUR))
        b.close()
        # 2
        b, page = fresh(p, [a1, a2, a3, b1, b2, b3])
        page.evaluate(ZOOM); time.sleep(1); page.evaluate(ROW, 1); time.sleep(2.5); page.evaluate(ZOOM); time.sleep(1)
        page.evaluate('window.__slow=1200')
        page.mouse.move(300, 360); page.mouse.down(); page.mouse.move(250, 360, steps=4); page.mouse.move(120, 360, steps=8); page.mouse.up()
        time.sleep(0.3); page.evaluate(ROW, 2); time.sleep(4)
        check(page.evaluate(CUR) == 'Beta2' and page.evaluate('window.__rt.app().stage.player.playing'), '2: a row tap inside the swipe-settle window wins over the silent adopt (got %s)' % page.evaluate(CUR))
        b.close()
        # 4
        b, page = fresh(p, [c1, c2])
        page.evaluate(ZOOM); time.sleep(1); page.evaluate(ROW, 2); time.sleep(1.5)
        ST = "(()=>{const a=window.__rt.app(); return {view:a.state.view, cdPlaying:a.state.cdPlaying, idx:a.state.queue&&a.state.queue.index}})()"
        time.sleep(6); end = page.evaluate(ST)
        check(end['view'] == 'cd' and end['cdPlaying'] is False, '4: the CD paused at the end of its last track (%s)' % end)
        page.click('#cdPlay'); time.sleep(0.8); again = page.evaluate(ST)
        check(again['cdPlaying'] is True and again['idx'] == 0, '4: Play restarts the disc from track 1 (%s)' % again)
        b.close()
        # 5
        b, page = fresh(p, [a1, a2, a3])
        page.route('**/fake-stream.mp3', lambda r: r.fulfill(status=200, body=open(a1, 'rb').read(), content_type='audio/mpeg'))
        to_section(page, 'radio')
        page.evaluate("window.__rt.app().radio().play({type:'radio-browser', id:'x1', name:'Fake FM', streamUrl:'%s/fake-stream.mp3', tags:[]})" % ORIGIN); time.sleep(2)
        check(page.evaluate('window.__rt.app().state.radioOn') is True, '5: a streamed station is on')
        to_section(page, 'albums'); page.evaluate(ZOOM); time.sleep(1); page.evaluate(ROW, 2); time.sleep(2.5)
        r = page.evaluate("({on: window.__rt.app().state.radioOn, st: !!window.__rt.app().radio().station})")
        check(r['on'] is False and r['st'] is False, '5: picking an album track ended the station (%s)' % r)
        b.close()
        # 6 + empty-library radio, 7
        b, page = fresh(p, [])
        to_section(page, 'radio')
        page.evaluate("document.querySelector('.dial-play[data-play]').click()"); time.sleep(1)
        txt = page.evaluate('document.querySelector(".radio-now").innerText')
        check('Scan your music' in txt and 'Open Albums' in txt and 'Retry' not in txt, '6: empty library: the card says scan first, has Open Albums, no Retry (%r)' % txt)
        check(page.evaluate('window.__rt.app().radio().session') is None, '6: no session was started')
        check(page.evaluate('!!document.querySelector(".ai-panel:not(.hidden)")') is False, '6: no big "Nothing to play yet" panel')
        to_section(page, 'mixtapes'); page.click('#mtNew'); time.sleep(0.8)
        page.click('.ed-bar .pl', force=True); time.sleep(0.8)
        check(page.evaluate('document.querySelector(".ed-toast")?.innerText') == 'Add songs first' and page.evaluate('!!document.querySelector(".ed-ov")'), '7: Save and play on an empty tape stays in the editor and says "Add songs first"')
        check(page.evaluate('localStorage.getItem("runout.mixtapes")') is None, '7: nothing was saved')
        b.close()
    print('FAILED: %d' % len(fails) if fails else 'ALL OK'); sys.exit(1 if fails else 0)

if __name__ == '__main__': main()
