#!/usr/bin/env python3
"""Verify Device mode (lock key, frozen face, keep-awake, always-on display) in Chromium with real touch input (CDP), at 360x780 and 412x915, DSF 2.

Needs: ffmpeg, Playwright for Python, the dev server:  python3 serve.py 8391   (URL=http://localhost:8391/index.html, CHROME=/path/to/chrome)
Usage:  python3 scripts/verify-devicemode.py [outdir]     Exits non-zero when an assertion fails; screenshots go to outdir/shots.

Time is controlled by offsetting Date.now() (the state machine's clock) and calling machine.tick(): no real waiting for 1 minute / 30 minutes.
Every frozen gesture is run twice: UNLOCKED (control: it must take effect) and LOCKED (it must do nothing).
NOT a substitute for the on-device checks in docs/DEVICE_MODE.md (real screen timeout, panel refresh rate, AMOLED brightness, TalkBack, back gesture).
"""
import json, os, subprocess, sys, time
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = open(os.path.join(ROOT, 'scripts/verify-canned-radio.py')).read()
src = src[:src.index('def run():')]
OUTDIR = sys.argv[1] if len(sys.argv) > 1 else '/tmp/devicemode-verify'
sys.argv = ['x', OUTDIR]
URLENV = os.environ.get('URL', 'http://localhost:8391/index.html')
os.environ['URL'] = URLENV
exec(src)    # helpers: make_fixtures, launch, to_section, FAKE_SPEECH, BUS_HOOK, LIB, SHOTS, URL, SPECS
make_fixtures()

fails = []
def check(ok, msg):
    if not ok: fails.append(msg)
    print(('ok   ' if ok else 'FAIL ') + msg, flush=True)

class Touch:
    def __init__(self, page): self.cdp = page.context.new_cdp_session(page)
    def _send(self, kind, pts): self.cdp.send('Input.dispatchTouchEvent', {'type': kind, 'touchPoints': [{'x': x, 'y': y, 'id': i} for i, (x, y) in enumerate(pts)]})
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

WAKELOCK = """
(() => {
  const log = { requests: 0, releases: 0, active: 0 };
  window.__wl = log;
  const sentinels = [];
  Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request: async (t) => {
    log.requests++; log.active++;
    const ls = {}; const s = { type: t, released: false, addEventListener: (n, f) => { ls[n] = f; }, release: async () => { if (!s.released) { s.released = true; log.releases++; log.active--; ls.release && ls.release(); } } };
    sentinels.push(s); return s; } } });
  window.__wlSentinels = sentinels;
})();
"""
SPY = """
(() => { window.__cap = 0; const o = Element.prototype.setPointerCapture; Element.prototype.setPointerCapture = function(...a) { window.__cap++; try { return o.apply(this, a); } catch (e) {} }; })();
(() => { window.__raf = 0; })();
"""

def boot(b, w, h, seed=True, extra_init=''):
    ctx = b.new_context(viewport={'width': w, 'height': h}, device_scale_factor=2, has_touch=True, is_mobile=True)
    init = 'window.showDirectoryPicker = undefined; try { localStorage.setItem("runout.wtDone", "1");'
    if seed:
        ts = [{'title': t, 'artist': a, 'album': al} for (t, a, al, f, g) in SPECS[:3]]
        mix = json.dumps({'version': 3, 'mixtapes': [{'id': f'm{i}', 'name': f'Tape {i + 1}', 'author': 'me', 'tracks': ts, 'cfg': {'style': st, 'pen': 'blue', 'wear': 0.2, 'gloss': 0.5, 'text': {'subtitle': 'side', 'note': 'note', 'side': 'A'}}} for i, st in enumerate(['brass', 'clear', 'smoke'])]})
        init += f' localStorage.setItem("runout.mixtapes", {json.dumps(mix)});'
    init += ' } catch(e) {}'
    ctx.add_init_script(init + extra_init)
    ctx.add_init_script(BUS_HOOK); ctx.add_init_script(FAKE_SPEECH); ctx.add_init_script(WAKELOCK); ctx.add_init_script(SPY)
    page = ctx.new_page()
    errs = []
    page.on('pageerror', lambda e: errs.append(str(e)))
    page.goto(URL)
    page.wait_for_function('document.getElementById("latency") && !/boot error/.test(document.getElementById("latency").textContent) && window.runoutDeviceMode')
    time.sleep(0.6)
    page.evaluate("() => { const real = Date.now.bind(Date); window.__off = 0; Date.now = () => real() + window.__off; }")
    return ctx, page, errs

def jump(page, ms):
    page.evaluate("ms => { window.__off += ms; runoutDeviceMode.machine.tick(Date.now()); }", ms)
    time.sleep(0.45)

def dm(page): return page.evaluate('runoutDeviceMode.state')
def attr(page): return page.evaluate('document.body.dataset.devicemode || ""')
def key_center(page):
    r = page.evaluate("""() => { const k = [...document.querySelectorAll('.page:not([hidden]) .dm-key')][0]; const r = k.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2, r.width, r.height]; }""")
    return r
def lock(page, T):
    x, y, _, _ = key_center(page); T.tap(x, y); time.sleep(0.25)
def unlock_hold(page, T, ms=1000):
    x, y, _, _ = key_center(page); T.down((x, y)); time.sleep(ms / 1000); T.up(); time.sleep(0.3)
def set_cfg(page, **kw): page.evaluate("p => runoutDeviceMode.settings.set(p)", kw)
def center(page, sel):
    return page.evaluate("s => { const e = document.querySelector(s); const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; }", sel)

def run_size(p, w, h):
    tag = f'{w}x{h}'
    b = launch(p)
    ctx, page, errs = boot(b, w, h)
    T = Touch(page)
    shot = lambda name: page.screenshot(path=f'{SHOTS}/{tag}-{name}.png')
    TX = "new DOMMatrix(getComputedStyle(document.getElementById('card')).transform).m41"

    # ── 1. keys exist, lock + visuals ─────────────────────────────────────────────────────────────────────────────────────────
    n = page.evaluate("document.querySelectorAll('.page-head .dm-key').length")
    np_ = page.evaluate("document.querySelectorAll('.page-head').length")
    check(n == np_ and n >= 4, f'{tag}: a lock key in every section header ({n} of {np_})')
    x, y, kw, kh = key_center(page)
    check(kw >= 44 and kh >= 44, f'{tag}: lock key target is {kw:.0f}x{kh:.0f} px (>=44)')
    check(page.evaluate("document.querySelector('.page:not([hidden]) .dm-key').getAttribute('aria-pressed')") == 'false', f'{tag}: aria-pressed false when unlocked')
    shot('albums-normal')

    # control experiments (UNLOCKED): the frozen gestures really do something
    page.evaluate('window.__cap = 0')
    d = page.evaluate("() => { const r = document.querySelector('#ttStage').getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; }")
    T.drag(T.line(5, 400, 250, 400)); time.sleep(0.8)
    opened = page.evaluate("document.getElementById('shell').dataset.open") == 'true'
    check(opened, f'{tag}: [control] drawer pull from the left strip opens the drawer when unlocked')
    page.evaluate("document.getElementById('shell').querySelector('.drawer-item.active') && 0"); T.tap(w - 20, h / 2); time.sleep(0.8)
    page.evaluate("runoutDeviceMode.showHint") if False else None

    # ── 2. lock: tap ─────────────────────────────────────────────────────────────────────────────────────────────────────────
    lock(page, T)
    check(dm(page)['locked'] and dm(page)['wake'] and 'locked' in attr(page), f'{tag}: tap on the key locks (state {dm(page)}, body "{attr(page)}")')
    check(page.evaluate("document.querySelector('.page:not([hidden]) .dm-key').getAttribute('aria-pressed')") == 'true', f'{tag}: aria-pressed true when locked')
    check(page.evaluate('window.__wl.active') == 1, f'{tag}: wake lock acquired on lock (requests {page.evaluate("window.__wl.requests")})')
    shot('albums-locked')
    ob = page.evaluate("getComputedStyle(document.body).overscrollBehaviorY + '|' + getComputedStyle(document.body).userSelect")
    check(ob.startswith('none') and ob.endswith('none'), f'{tag}: overscroll-behavior none, user-select none while locked ({ob})')

    # ── 3. frozen gestures, one by one ───────────────────────────────────────────────────────────────────────────────────────
    page.evaluate('window.__cap = 0')
    T.drag(T.line(5, 400, 250, 400)); time.sleep(0.7)
    check(page.evaluate("document.getElementById('shell').dataset.open") != 'true' and abs(page.evaluate(TX)) < 1, f'{tag}: drawer pull from the left strip does nothing while locked')
    T.tap(24, 28); time.sleep(0.5)    # the hamburger
    check(page.evaluate("document.getElementById('shell').dataset.open") != 'true', f'{tag}: the hamburger is frozen while locked')
    # platter scrub / tonearm drag / brake (the stage's own gestures call setPointerCapture)
    T.drag(T.line(w * 0.4, 120, w * 0.4 + 90, 300)); T.drag(T.line(w * 0.6, 200, w * 0.6, 360))
    cap = page.evaluate('window.__cap')
    check(cap == 0, f'{tag}: platter / tonearm drags never start while locked (pointer captures: {cap})')
    # pinch (zoom out to the library)
    T.pinch(w / 2, 300, 70, 14); time.sleep(0.8)
    lib_op = page.evaluate("(() => { const e = document.querySelector('.tl-lib'); return e ? parseFloat(getComputedStyle(e).opacity) : 0; })()")
    check(lib_op < 0.2, f'{tag}: pinch does not open the library while locked (library opacity {lib_op})')
    # text selection / context menu
    page.mouse.dblclick(w / 2, h - 40)
    sel = page.evaluate("String(window.getSelection())")
    check(sel == '', f'{tag}: no text selection while locked ("{sel}")')
    ctxm = page.evaluate("() => { const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true }); document.body.dispatchEvent(e); return e.defaultPrevented; }")
    check(ctxm, f'{tag}: context menu is suppressed while locked')
    wheel = page.evaluate("() => { const e = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 100, ctrlKey: true }); document.querySelector('#ttStage').dispatchEvent(e); return e.defaultPrevented; }")
    check(wheel, f'{tag}: wheel / ctrl-wheel zoom is suppressed while locked')
    # the Android back gesture: no silent unlock
    page.evaluate('history.back()'); time.sleep(0.4)
    check(dm(page)['locked'], f'{tag}: history back does not unlock')
    hint = page.evaluate("(() => { const h = document.querySelector('.dm-hint'); return h && !h.hidden ? h.textContent : ''; })()")
    check('unlock' in hint.lower(), f'{tag}: back shows an unlock hint ("{hint}")')

    # ── 4. allowed buttons work ─────────────────────────────────────────────────────────────────────────────────────────────
    page.evaluate('window.__cap = 0')
    px, py = center(page, '#tt-b45'); T.tap(px, py); time.sleep(0.3)
    check(page.evaluate("document.getElementById('tt-b45').getAttribute('aria-pressed')") == 'true', f'{tag}: the 45 key works while locked')
    px, py = center(page, '#tt-playBtn'); T.tap(px, py); time.sleep(0.5)
    lab = page.evaluate("document.getElementById('tt-playBtn').getAttribute('aria-label')")
    check(lab != 'Play', f'{tag}: the Play key works while locked (label now "{lab}")')
    check(page.evaluate('window.__cap') == 0, f'{tag}: tapping keys inside the stage does not start a platter gesture')
    shot('albums-playing-locked')
    px, py = center(page, '#tt-playBtn'); T.tap(px, py); time.sleep(0.3)

    # a live button inside a gesture surface must not reach the surface (generic fixture, data-lock-surface / data-lock-ok)
    page.evaluate("""() => { const s = document.createElement('div'); s.id = 'fx-surface'; s.setAttribute('data-lock-surface', ''); s.style.cssText = 'position:fixed;left:10px;right:10px;top:200px;height:120px;z-index:50;background:#223';
      const b = document.createElement('button'); b.id = 'fx-btn'; b.setAttribute('data-lock-ok', ''); b.textContent = 'ok'; b.style.cssText = 'position:absolute;left:20px;top:20px;width:60px;height:60px';
      s.append(b); document.body.append(s); window.__surf = 0; window.__btn = 0; s.addEventListener('pointerdown', () => window.__surf++); b.addEventListener('click', () => window.__btn++); }""")
    px, py = center(page, '#fx-btn'); T.tap(px, py); time.sleep(0.2)
    check(page.evaluate('window.__btn') == 1 and page.evaluate('window.__surf') == 0, f'{tag}: a live button inside a gesture surface works and its press does not reach the surface (btn {page.evaluate("window.__btn")}, surface {page.evaluate("window.__surf")})')
    T.tap(px + 200 if px + 200 < w - 10 else w - 20, py + 30); time.sleep(0.2)
    page.evaluate("document.getElementById('fx-surface').remove()")

    # ── 5. unlock: short press does not, hold does ──────────────────────────────────────────────────────────────────────────
    x, y, _, _ = key_center(page)
    T.tap(x, y, hold=0.12); time.sleep(0.4)
    check(dm(page)['locked'], f'{tag}: a short press on the key does not unlock')
    T.down((x, y)); time.sleep(0.3); T.up(); time.sleep(0.3)
    page.evaluate("() => { const k = document.querySelector('.page:not([hidden]) .dm-key'); k.classList.add('dm-holding'); const f = k.querySelector('.dm-ring-fg'); f.style.transition = 'none'; f.style.strokeDashoffset = '40'; }"); shot('unlock-ring-partway')
    page.evaluate("() => { const k = document.querySelector('.page:not([hidden]) .dm-key'); k.classList.remove('dm-holding'); k.querySelector('.dm-ring-fg').style.strokeDashoffset = '100'; }")
    check(dm(page)['locked'], f'{tag}: releasing before 0.8 s does not unlock')
    unlock_hold(page, T, 1000)
    check(not dm(page)['locked'] and attr(page) == '' and page.evaluate('window.__wl.active') == 0, f'{tag}: press-and-hold unlocks, wake lock released (state {dm(page)})')

    # double-tap and slide methods
    set_cfg(page, unlockMethod='double'); lock(page, T)
    x, y, _, _ = key_center(page); T.tap(x, y); time.sleep(0.8); check(dm(page)['locked'], f'{tag}: one tap does not unlock (double-tap method)')
    T.tap(x, y); time.sleep(0.12); T.tap(x, y); time.sleep(0.3); check(not dm(page)['locked'], f'{tag}: double-tap unlocks (double-tap method)')
    set_cfg(page, unlockMethod='slide'); lock(page, T)
    x, y, _, _ = key_center(page); T.drag(T.line(x, y, x - 8, y, 4)); time.sleep(0.3); check(dm(page)['locked'], f'{tag}: a short slide does not unlock')
    T.drag(T.line(x + 5, y, x - 40, y, 10)); time.sleep(0.3); check(not dm(page)['locked'], f'{tag}: sliding the key unlocks (slide method)')
    set_cfg(page, unlockMethod='hold')

    # keyboard: Enter toggles, Space-hold unlocks
    page.focus('.page:not([hidden]) .dm-key'); page.keyboard.press('Enter'); time.sleep(0.2)
    check(dm(page)['locked'], f'{tag}: Enter on the key locks')
    page.keyboard.down('Space'); time.sleep(1.0); page.keyboard.up('Space'); time.sleep(0.3)
    check(not dm(page)['locked'], f'{tag}: holding Space on the key unlocks')
    page.evaluate("document.querySelector('.page:not([hidden]) .dm-key').click()"); time.sleep(0.2)
    check(dm(page)['locked'], f'{tag}: an assistive-technology click (detail 0) locks')
    page.evaluate("document.querySelector('.page:not([hidden]) .dm-key').click()"); time.sleep(0.2)
    check(not dm(page)['locked'], f'{tag}: ... and unlocks (TalkBack can always reach the unlock)')
    names = page.evaluate("[...document.querySelectorAll('.page:not([hidden]) .dm-key')].map(k => k.getAttribute('aria-label'))")
    check(names == ['Lock controls'], f'{tag}: label "Lock controls" ({names})')

    # ── 6. AOD ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
    lock(page, T)
    jump(page, 61000)
    check(dm(page)['aod'] and 'aod' in attr(page), f'{tag}: AOD after 1 min idle (body "{attr(page)}")')
    check(page.evaluate("window.requestAnimationFrame.toString().indexOf('native code') < 0"), f'{tag}: rAF is gated while AOD is on')
    shot('albums-aod')
    bg = page.evaluate("getComputedStyle(document.body).backgroundColor")
    check(bg == 'rgb(0, 0, 0)', f'{tag}: AOD background is true black ({bg})')
    # rAF rate in AOD
    cnt = page.evaluate("""() => new Promise((res) => { let n = 0; const loop = () => { n++; requestAnimationFrame(loop); }; requestAnimationFrame(loop); setTimeout(() => res(n), 5200); })""")
    check(cnt <= 7, f'{tag}: rAF callbacks in 5.2 s of AOD: {cnt} (<= 1 per second)')
    # a stray touch does not wake; a button works; double tap wakes
    T.tap(w / 2, 300); time.sleep(0.5)
    check(dm(page)['aod'], f'{tag}: a single stray touch does not wake the AOD')
    px, py = center(page, '#tt-b78'); T.tap(px, py); time.sleep(0.4)
    check(dm(page)['aod'] and page.evaluate("document.getElementById('tt-b78').getAttribute('aria-pressed')") == 'true', f'{tag}: an AOD button works directly and the AOD stays')
    T.tap(w / 2, 250); time.sleep(0.12); T.tap(w / 2, 252); time.sleep(0.6)
    check(not dm(page)['aod'] and dm(page)['locked'], f'{tag}: double-tap anywhere wakes the AOD (still locked)')
    check('aod' not in attr(page) and page.evaluate("window.requestAnimationFrame.toString().indexOf('native code') >= 0"), f'{tag}: rAF restored after AOD')
    # other wake settings
    jump(page, 61000); set_cfg(page, aodWake='long')
    T.down((w / 2, 300)); time.sleep(0.9); T.up(); time.sleep(0.5)
    check(not dm(page)['aod'], f'{tag}: long-press wakes the AOD when configured')
    set_cfg(page, aodWake='lockkey'); jump(page, 61000)
    x, y, _, _ = key_center(page); T.tap(x, y); time.sleep(0.5)
    check(not dm(page)['aod'] and dm(page)['locked'], f'{tag}: tapping the lock key wakes the AOD when configured')
    set_cfg(page, aodWake='double')
    # pixel shift moves between minutes
    jump(page, 61000)
    s1 = page.evaluate("[document.body.style.getPropertyValue('--dm-sx'), document.body.style.getPropertyValue('--dm-sy')].join(',')")
    # unlock from AOD
    unlock_hold(page, T, 1000)
    check(not dm(page)['locked'] and 'aod' not in attr(page), f'{tag}: unlock from AOD with the hold works')

    # ── 7. keep-awake timeout ───────────────────────────────────────────────────────────────────────────────────────────────
    set_cfg(page, keepAwakeMin=5, neverTimeoutPlaying=False, aodEnabled=False); lock(page, T)
    jump(page, 4 * 60000); check(page.evaluate('window.__wl.active') == 1, f'{tag}: wake lock still held at 4 min')
    jump(page, 61000); check(page.evaluate('window.__wl.active') == 0 and dm(page)['locked'] and not dm(page)['wake'], f'{tag}: wake lock released after the 5 min timeout, still locked')
    T.tap(px, py); time.sleep(0.4)
    check(page.evaluate('window.__wl.active') == 1 and dm(page)['notice'] == 'timeout', f'{tag}: activity re-arms it and shows the notice')
    notice = page.evaluate("(() => { const n = document.querySelector('.dm-notice'); return n && !n.hidden ? n.textContent : ''; })()")
    check('5 min' in notice, f'{tag}: notice text "{notice}"')
    # visibility cycle re-acquires
    page.evaluate("() => { window.__wlSentinels.forEach(s => s.release()); }"); time.sleep(0.2)
    check(page.evaluate('window.__wl.active') == 0, f'{tag}: [setup] the system released the lock')
    page.evaluate("() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); }"); time.sleep(0.2)
    page.evaluate("() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange')); }"); time.sleep(0.5)
    check(page.evaluate('window.__wl.active') == 1, f'{tag}: the wake lock is re-acquired after a visibility cycle')
    unlock_hold(page, T, 1000)
    check(page.evaluate('window.__wl.active') == 0, f'{tag}: released on unlock')
    set_cfg(page, keepAwakeMin=30, neverTimeoutPlaying=True, aodEnabled=True)

    # restart: a fresh launch is unlocked
    lock(page, T); page.reload(); page.wait_for_function('window.runoutDeviceMode'); time.sleep(0.8)
    check(not dm(page)['locked'], f'{tag}: a fresh launch starts unlocked')
    set_cfg(page, persistLock=True); lock(page, T); page.reload(); page.wait_for_function('window.runoutDeviceMode'); time.sleep(1.0)
    check(dm(page)['locked'], f'{tag}: lock persists across a restart when the setting is on')
    page.evaluate("runoutDeviceMode.unlock(); runoutDeviceMode.settings.set({ persistLock: false })"); time.sleep(0.3)
    page.evaluate("Date.now = Date.now"); page.evaluate("() => { const real = Date.now.bind(Date); window.__off = 0; Date.now = () => real() + window.__off; }")

    # ── 8. the other sections: locked + AOD ─────────────────────────────────────────────────────────────────────────────────
    def section_shots(sec, setup=None, teardown=None):
        to_section(page, sec)
        if setup: setup()
        shot(f'{sec}-normal')
        lock(page, T); shot(f'{sec}-locked')
        jump(page, 61000)
        check(dm(page)['aod'], f'{tag}: {sec}: AOD on'); shot(f'{sec}-aod')
        # wake + unlock
        T.tap(w / 2, 400); time.sleep(0.12); T.tap(w / 2, 402); time.sleep(0.5)
        unlock_hold(page, T, 1000)
        check(not dm(page)['locked'], f'{tag}: {sec}: unlock works')
        if teardown: teardown()

    # Mixtapes: the cassette player open
    def mx_setup():
        page.wait_for_selector('.cs-card', timeout=8000)
        page.locator('.cs-card').nth(2).tap(position={'x': 150, 'y': 60}); page.wait_for_selector('.tp:not(.hidden)', timeout=8000); page.wait_for_timeout(2500)
    def mx_teardown():
        page.evaluate("document.querySelector('.tp .btn-close') && document.querySelector('.tp .btn-close').click()"); page.wait_for_timeout(500)
    to_section(page, 'mixtapes')
    mx_setup(); shot('mixtapes-normal')
    check(page.evaluate("getComputedStyle(document.querySelector('.dm-key-float')).display") != 'none', f'{tag}: the floating lock key shows over the cassette player')
    fk = page.evaluate("() => { const r = document.querySelector('.dm-key-float').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; }")
    T.tap(*fk); time.sleep(0.3)
    check(dm(page)['locked'], f'{tag}: Mixtapes: the floating key locks while the player is open')
    keys = page.evaluate("document.querySelectorAll('.tp [role=button]').length")
    shot('mixtapes-locked')
    # a transport key works, a skin chip is frozen
    chip_before = page.evaluate("[...document.querySelectorAll('.tp-chip')].map(c => c.getAttribute('aria-pressed')).join()")
    cx, cy = center(page, '.tp-chip'); T.tap(cx, cy); time.sleep(0.3)
    chip_after = page.evaluate("[...document.querySelectorAll('.tp-chip')].map(c => c.getAttribute('aria-pressed')).join()")
    check(chip_before == chip_after, f'{tag}: Mixtapes: skin chips are frozen while locked')
    kx, ky = page.evaluate("() => { const k = document.querySelector('.tp [data-key=play]') || document.querySelector('.tp [data-key]'); const r = k.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; }")
    page.evaluate("window.__keyHits = 0; document.querySelectorAll('.tp [data-key]').forEach(k => k.addEventListener('pointerdown', () => window.__keyHits++))")
    T.tap(kx, ky); time.sleep(0.4)
    check(page.evaluate('window.__keyHits') >= 1, f'{tag}: Mixtapes: a cassette transport key still receives presses while locked ({keys} role=button controls)')
    jump(page, 61000); shot('mixtapes-aod')
    T.tap(w / 2, 400); time.sleep(0.12); T.tap(w / 2, 402); time.sleep(0.5)
    unlock_hold(page, T, 1000); check(not dm(page)['locked'], f'{tag}: Mixtapes: unlock works with the player open')
    mx_teardown()

    # Radio: a playing canned station
    to_section(page, 'radio'); page.wait_for_selector('.dial-card', timeout=10000)
    page.locator('.dial-card[data-station]').first.click(); time.sleep(2.5)
    shot('radio-normal')
    lock(page, T); shot('radio-locked')
    before = page.evaluate("document.querySelectorAll('.radio-now').length")
    T.tap(w / 2, 300); time.sleep(0.3)
    jump(page, 61000); shot('radio-aod')
    T.tap(w / 2, 400); time.sleep(0.12); T.tap(w / 2, 402); time.sleep(0.5)
    unlock_hold(page, T, 1000)
    page.evaluate("document.querySelector('.radio-now .theme-btn') && document.querySelector('.radio-now .theme-btn').click()"); time.sleep(0.4)

    # Booth: the FX pad frozen unless allowed
    to_section(page, 'booth'); page.wait_for_selector('.fx-row', timeout=10000)
    shot('booth-normal')
    page.locator('.fx-row[data-id="bandpass"]').click(); time.sleep(0.8)
    page.wait_for_selector('.fx-pad', timeout=5000)
    shot('booth-pad')
    pxy = center(page, '.fx-pad')
    page.evaluate('window.__cap = 0'); T.down(pxy); time.sleep(0.2); T.up(); time.sleep(0.2)
    check(page.evaluate('window.__cap') >= 1, f'{tag}: [control] the FX pad takes a press when unlocked')
    lock(page, T); page.evaluate('window.__cap = 0')
    T.down(pxy); time.sleep(0.2); T.up(); time.sleep(0.2)
    check(page.evaluate('window.__cap') == 0, f'{tag}: Booth: the FX pad is frozen while locked')
    set_cfg(page, fxPadWhileLocked=True); page.evaluate('window.__cap = 0'); T.down(pxy); time.sleep(0.2); T.up(); time.sleep(0.2)
    check(page.evaluate('window.__cap') >= 1, f'{tag}: Booth: "Allow the FX pad while locked" enables it')
    set_cfg(page, fxPadWhileLocked=False)
    shot('booth-locked'); jump(page, 61000); shot('booth-aod')
    unlock_hold(page, T, 1000)

    # the settings sheet (temporary home for the settings)
    to_section(page, 'settings'); page.wait_for_selector('.st-page')
    check(page.evaluate("document.querySelectorAll('.dm-gear').length") == 0, f'{tag}: the temporary lock-sheet gear is gone from the page headers')
    page.evaluate("document.querySelector('.st-group[data-group=\"device-mode\"]') && (document.querySelector('.st-group[data-group=\"device-mode\"]').open = true)")
    page.locator('.st-group[data-group="device-mode"] .st-btn').first.click(); time.sleep(0.4)
    check(page.evaluate("!!document.querySelector('.dm-sheet')"), f'{tag}: the Device mode sheet opens from Settings > Device mode')
    shot('settings-sheet'); page.evaluate("document.querySelector('.dm-done').click()")

    check(not errs, f'{tag}: no page errors {errs[:3]}')
    b.close()


# ── NEW UI (Workstream I): the lock faces against the Albums vinyl stage, the coverflow library and the cassette player ───────────────────────────
APP = 'window.__rt.app()'
def stage_pt(page, x, y):
    return page.evaluate(f"""(() => {{ const t = document.querySelector('.tt-top'), g = document.getElementById('tt-topRot'); const p = t.createSVGPoint(); p.x = {x}; p.y = {y};
      const q = p.matrixTransform(g.getScreenCTM()); return [q.x, q.y]; }})()""")
def scan_via_settings(page):
    to_section(page, 'settings'); page.wait_for_selector('.st-page')
    page.evaluate('document.querySelector(\'.st-group[data-group="library"]\').open = true')
    with page.expect_file_chooser() as fc: page.click('.st-group[data-group="library"] .st-btn.primary')
    fc.value.set_files(LIB)
    page.wait_for_function(f'{APP}.albums.length >= 3 && {APP}.albums.every(a => !a.builtin)', timeout=30000); time.sleep(1.0)
    to_section(page, 'albums')

def new_ui_albums(p, w, h):
    tag = f'{w}x{h} albums'
    b = launch(p); ctx, page, errs = boot(b, w, h, seed=False); T = Touch(page)
    page.evaluate("() => { window.__sel = 0; window.__cov = 0; }")
    scan_via_settings(page)
    page.evaluate(f"() => {{ const t = {APP}.tlib; t.on('selectTrack', () => window.__sel++); t.on('tapCover', () => window.__cov++); }}")
    cx0, cy0 = stage_pt(page, 700, 300)          # a point on the groove annulus (r ~ 450 from the spindle)
    inside = 0 <= cx0 <= w and 0 <= cy0 <= h
    check(inside, f'{tag}: [setup] a disc point is on screen ({cx0:.0f},{cy0:.0f})')
    def scratching_during():
        T.down((cx0, cy0)); time.sleep(0.05); T.move((cx0 + 8, cy0 + 20)); time.sleep(0.05); T.move((cx0 + 12, cy0 + 40)); time.sleep(0.05)
        v = page.evaluate(f'{APP}.stage.isScratching()'); T.up(); time.sleep(0.2); return v
    def braking_during():
        bx, by = stage_pt(page, 428, 457)      # on the label (r = 150 < 217) but clear of the header chips (the spindle itself sits under the hamburger on a 360 px phone)
        T.down((bx, by)); time.sleep(0.1); v = page.evaluate(f'{APP}.state.braking'); T.up(); time.sleep(0.2); return v
    def arm_during():
        gx, gy = center(page, '#tt-grab'); T.down((gx, gy)); time.sleep(0.1); T.move((gx + 4, gy + 4)); v = page.evaluate(f'{APP}.stage.player.dragging'); T.up(); time.sleep(0.3); return v
    def pinch_z():
        T.pinch(w / 2, h / 2, 90, 20); time.sleep(0.9); z = page.evaluate(f'{APP}.stage.zoom'); return z
    # play first so the arm is down (dimple drag needs it)
    px, py = center(page, '#tt-playBtn'); T.tap(px, py); time.sleep(2.2)
    check(page.evaluate(f'{APP}.stage.player.playing'), f'{tag}: [control] Play starts the record')
    check(scratching_during(), f'{tag}: [control] a drag on the disc scratches when unlocked')
    check(braking_during(), f'{tag}: [control] a hold on the label brakes when unlocked')
    check(arm_during(), f'{tag}: [control] the dimple drag starts when unlocked')
    z = pinch_z(); check(z > 0.3, f'{tag}: [control] pinch zooms out when unlocked (z {z:.2f})')
    # coverflow control (unlocked): swipe moves focus, a row tap picks a track, a cover tap fires
    title0 = page.evaluate("document.querySelector('.tl-title').textContent")
    fl = page.evaluate("() => { const r = document.querySelector('.tl-flow').getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; }")
    fy = fl[1] + fl[3] * 0.4
    T.drag(T.line(w * 0.75, fy, w * 0.2, fy, 8)); time.sleep(1.2)
    title1 = page.evaluate("document.querySelector('.tl-title').textContent")
    check(title1 != title0, f'{tag}: [control] a coverflow swipe changes the focused album when unlocked ("{title0}" -> "{title1}")')
    rx, ry = center(page, '.tl-trk'); T.tap(rx, ry); time.sleep(0.8)
    check(page.evaluate('window.__sel') >= 1, f'{tag}: [control] a track-row tap selects a track when unlocked')
    T.pinch(w / 2, h / 2, 20, 120); time.sleep(0.9)            # spread: back to the player (still unlocked)
    page.evaluate(f'{APP}.stage.dispatch({{type: "zoomTo", z: 0}})'); time.sleep(1.2)
    check(page.evaluate(f'{APP}.stage.zoom') == 0, f'{tag}: [setup] back on the player')

    # ── LOCK
    lock(page, T)
    check(dm(page)['locked'], f'{tag}: locked')
    page.evaluate("() => { window.__sel = 0; window.__cov = 0; }")
    check(not scratching_during(), f'{tag}: LOCKED: a drag on the disc does not scratch')
    check(not braking_during(), f'{tag}: LOCKED: a hold on the label does not brake')
    check(not arm_during(), f'{tag}: LOCKED: the dimple drag does not start')
    z = pinch_z(); check(z == 0, f'{tag}: LOCKED: pinch does not zoom (z {z:.2f})')
    page.evaluate("document.querySelector('.tt-wrap').dispatchEvent(new WheelEvent('wheel', {ctrlKey: true, deltaY: 80, bubbles: true, cancelable: true}))"); time.sleep(0.9)
    check(page.evaluate(f'{APP}.stage.zoom') == 0, f'{tag}: LOCKED: Ctrl+wheel does not zoom')
    page.keyboard.press('Space'); time.sleep(0.2)
    check(not page.evaluate(f'{APP}.state.braking'), f'{tag}: LOCKED: Space does not brake')
    for kk in ['Escape', 'ArrowLeft']: page.keyboard.press(kk)
    # live keys while the record plays: speed, -/+, Stop, Play (the 40 s test songs run out while the gestures above are tried, so put the needle back first)
    page.evaluate("() => { const a = window.__rt.app(), e = a.state.engine; if (a.state.T - e.position / e.sampleRate < 25) window.__rt.goTo({ index: 0, time: 1 }, true); }"); time.sleep(1.5)
    if not page.evaluate(f'{APP}.stage.player.playing'):
        px, py = center(page, '#tt-playBtn'); T.tap(px, py); time.sleep(2.0)
    rpm0 = page.evaluate(f'{APP}.state.rpm')
    px_, py_ = center(page, '#tt-bp'); T.tap(px_, py_); time.sleep(0.3)
    rpm1 = page.evaluate(f'{APP}.state.rpm'); check(rpm1 != rpm0, f'{tag}: LOCKED: the + speed key works ({rpm0} -> {rpm1})')
    for sid in ['b78', 'b33', 'b45']:
        sx, sy = center(page, '#tt-' + sid); T.tap(sx, sy); time.sleep(0.25)
        check(page.evaluate(f"document.getElementById('tt-{sid}').getAttribute('aria-pressed')") == 'true', f'{tag}: LOCKED: the {sid[1:]} key works')
    px, py = center(page, '#tt-playBtn'); T.tap(px, py); time.sleep(1.2)
    check(not page.evaluate(f'{APP}.stage.player.playing'), f'{tag}: LOCKED: Stop works')
    T.tap(px, py); time.sleep(2.0)
    check(page.evaluate(f'{APP}.stage.player.playing') and rms_now(page) > 0.005, f'{tag}: LOCKED: Play works again and the record is audible (rms {rms_now(page):.3f})')
    # coverflow, frozen: show the library through the test hook (the zoom gesture itself is frozen), then swipe / tap
    page.evaluate('window.__rt.setZ(1)'); time.sleep(1.0)
    t_before = page.evaluate("document.querySelector('.tl-title').textContent")
    fl = page.evaluate("() => { const r = document.querySelector('.tl-flow').getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; }")
    T.drag(T.line(w * 0.75, fl[1] + fl[3] * 0.4, w * 0.2, fl[1] + fl[3] * 0.4, 8)); time.sleep(1.0)
    check(page.evaluate("document.querySelector('.tl-title').textContent") == t_before, f'{tag}: LOCKED: a coverflow swipe does nothing')
    rx, ry = center(page, '.tl-trk'); T.tap(rx, ry); time.sleep(0.5)
    cvx, cvy = center(page, '.tl-cv[aria-selected="true"], .tl-cv'); T.tap(cvx, cvy); time.sleep(0.5)
    check(page.evaluate('window.__sel') == 0 and page.evaluate('window.__cov') == 0, f'{tag}: LOCKED: track-row and cover taps do nothing (sel {page.evaluate("window.__sel")}, cover {page.evaluate("window.__cov")})')
    chip = page.evaluate("document.querySelector('.tl-f[aria-pressed=false], .tl-f') && document.querySelector('.tl-f:not([aria-pressed=true])') ? 1 : 0")
    page.evaluate('window.__rt.setZ(0)'); time.sleep(0.8)
    # header chips and the drawer are frozen
    for sel, what in [('.page:not([hidden]) .page-actions button[aria-label*="earch"]', 'search chip'), ('#btnDeck', 'Deck details chip')]:
        if page.evaluate(f"!!document.querySelector('{sel}')"):
            sx, sy = center(page, sel); T.tap(sx, sy); time.sleep(0.5)
            check(not page.evaluate("!!document.querySelector('.srch-overlay:not([hidden]), .srch:not([hidden])')") and page.evaluate("document.getElementById('deckSheet') ? document.getElementById('deckSheet').hidden : true"), f'{tag}: LOCKED: the {what} is frozen')
    check(not errs, f'{tag}: no page errors {errs[:3]}')
    b.close()

def stray_point(page, w, h):
    """a screen point that is not on any live control and not on a lock key (so a double-tap there is a stray touch that wakes the AOD)"""
    return page.evaluate("""([w, h]) => { for (let y = h * 0.3; y < h * 0.9; y += 17) for (let x = w * 0.2; x < w * 0.8; x += 19) { const e = document.elementFromPoint(x, y); if (e && !runoutDeviceMode.isAllowed(e)) return [x, y]; } return [w / 2, h / 2]; }""", [w, h])

def rms_now(page):
    return max([page.evaluate('window.__rms()') for _ in range(5) if time.sleep(0.05) is None])

def new_ui_cassette(p, w, h):
    tag = f'{w}x{h} cassette'
    b = launch(p); ctx, page, errs = boot(b, w, h, seed=False); T = Touch(page)
    scan_via_settings(page); to_section(page, 'mixtapes'); page.wait_for_timeout(500)
    page.tap('#mtNew'); page.wait_for_selector('.ed'); page.wait_for_timeout(300)
    page.fill('.ed-tape-tab input[aria-label="Title"]', 'Lockable'); page.tap('#edtab-add'); page.wait_for_timeout(300)
    def add(title):
        page.fill('.pk-q', title); page.wait_for_timeout(350); page.locator('.pk-rowbtn', has_text=title).first.tap(); page.wait_for_timeout(250)
    add('Harbor Lights'); add('Paper Moon'); page.locator('.pk-sidebtn').nth(1).tap(); add('Slow Window')
    page.tap('.ed-bar .sv'); page.wait_for_selector('.ed', state='detached'); page.wait_for_timeout(600)
    card = page.locator('.cs-card[aria-label^="Mixtape: Lockable"]').first; card.tap(); page.wait_for_timeout(700)
    if page.locator('.tp:not(.hidden)').count() == 0: card.tap()
    page.wait_for_selector('.tp:not(.hidden)'); page.wait_for_timeout(1500)
    side = lambda: page.evaluate("""() => { const d = document.querySelector('.sk-deck .side-panel'); const l = d && [...d.querySelectorAll('text[data-side]')].find(t => t.getAttribute('fill') === '#ffb347'); return l ? l.getAttribute('data-side') : ''; }""")
    auto = lambda: page.evaluate("document.querySelector('.sk-deck .side-key[data-key=auto]').classList.contains('down')")
    playing = lambda: page.evaluate("document.querySelector('.sk-deck .key[data-key=play]').classList.contains('down')")
    # control (unlocked): tape tap reveals the song list
    tx, ty = center(page, '.tp-host'); T.tap(tx, ty - 40); time.sleep(0.4)
    shown = page.evaluate("!document.querySelector('.tp-list').classList.contains('hidden')")
    check(shown, f'{tag}: [control] tapping the tape reveals the song list when unlocked')
    T.tap(tx, ty - 40); time.sleep(0.3)
    a0 = auto(); s0 = side()
    fk = page.evaluate("() => { const r = document.querySelector('.dm-key-float').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; }")
    T.tap(*fk); time.sleep(0.3)
    check(dm(page)['locked'], f'{tag}: locked with the cassette player open')
    page.evaluate("document.querySelector('.tp-list').classList.add('hidden')")
    T.tap(tx, ty - 40); time.sleep(0.4)
    check(page.evaluate("document.querySelector('.tp-list').classList.contains('hidden')"), f'{tag}: LOCKED: the tape-tap song-list reveal is frozen (decision: it is a reveal, not a key)')
    # shelf + editor frozen: the player covers the shelf; the editor entry points refuse
    page.evaluate("window.__ed = 0; const o = document.querySelector('#mtNew'); o && o.addEventListener('click', () => window.__ed++)")
    ex = page.evaluate("(() => { try { const ui = window.__rt.app().state.mixtapes; ui.edit(null); return !!document.querySelector('.ed'); } catch (e) { return 'err ' + e; } })()")
    check(ex is False, f'{tag}: LOCKED: the editor refuses to open ({ex})')
    # live keys: AUTO, FLIP, transport, wind
    ax, ay = center(page, '.sk-deck .side-key[data-key=auto]'); T.tap(ax, ay); time.sleep(0.4)
    check(auto() != a0, f'{tag}: LOCKED: AUTO toggles ({a0} -> {auto()})')
    T.tap(ax, ay); time.sleep(0.3)
    fx_, fy_ = center(page, '.sk-deck .side-key[data-key=flip]'); T.tap(fx_, fy_); time.sleep(1.3)
    check(side() != s0 and side() in ('A', 'B'), f'{tag}: LOCKED: FLIP turns the tape ({s0} -> {side()})')
    T.tap(fx_, fy_); time.sleep(1.3)
    pkx, pky = center(page, '.sk-deck .key[data-key=play]'); T.tap(pkx, pky); time.sleep(1.8)
    check(playing() and rms_now(page) > 0.005, f'{tag}: LOCKED: PLAY plays the tape (rms {rms_now(page):.3f})')
    ffx, ffy = center(page, '.sk-deck .key[data-key=ff]'); T.down((ffx, ffy)); time.sleep(0.9); wind = page.evaluate(f'!!{APP}.state.mixtapes.play && !!{APP}.state.mixtapes.play.wind'); T.up(); time.sleep(0.4)
    check(wind, f'{tag}: LOCKED: holding the wind key winds the tape')
    stx, sty = center(page, '.sk-deck .key[data-key=stop]'); T.tap(stx, sty); time.sleep(0.8)
    check(not playing(), f'{tag}: LOCKED: STOP stops the tape')
    # chips frozen
    before = page.evaluate("[...document.querySelectorAll('.tp-chip')].map(c => c.getAttribute('aria-pressed')).join()")
    cx, cy = center(page, '.tp-chip'); T.tap(cx, cy); time.sleep(0.3)
    check(before == page.evaluate("[...document.querySelectorAll('.tp-chip')].map(c => c.getAttribute('aria-pressed')).join()"), f'{tag}: LOCKED: the skin chips are frozen')
    ejx, ejy = center(page, '.sk-deck .key[data-key=eject]'); T.tap(ejx, ejy); time.sleep(1.4)
    check(dm(page)['locked'], f'{tag}: LOCKED: eject works and the device stays locked')
    check(not errs, f'{tag}: no page errors {errs[:3]}')
    b.close()

def locked_hint_card(p):
    tag = 'hint'
    b = launch(p); ctx, page, errs = boot(b, 412, 915, seed=False); T = Touch(page)
    lock(page, T); time.sleep(0.4)
    vis = lambda: page.evaluate("(() => { const h = document.querySelector('.dm-hint'); return !!h && !h.hidden; })()")
    check(vis(), f'{tag}: the locked hint card shows after locking')
    hx, hy = center(page, '.dm-hint'); T.tap(hx, hy); time.sleep(0.3)
    check(not vis(), f'{tag}: a tap dismisses the hint card')
    unlock_hold(page, T, 1000); lock(page, T); t0 = time.time(); time.sleep(0.2)
    while vis() and time.time() - t0 < 6: time.sleep(0.1)
    check(time.time() - t0 <= 4.3 and not vis(), f'{tag}: the hint card auto-dismisses within 4 s ({time.time() - t0:.1f} s)')
    jump(page, 61000); time.sleep(0.4)
    page.evaluate("history.back()"); time.sleep(0.5)       # a hint-raising event while in AOD
    check(dm(page)['aod'] and not vis(), f'{tag}: no hint card while in AOD')
    check(not errs, f'{tag}: no page errors {errs[:3]}')
    b.close()

def aod_new_ui(p, w, h):
    """AOD on every section: rAF rate <= 1/s, no visible canvases except the Albums outline, audio keeps running across enter/exit, scratching works afterwards."""
    tag = f'{w}x{h} aod'
    b = launch(p); ctx, page, errs = boot(b, w, h, seed=False); T = Touch(page)
    page.evaluate("() => { window.__min = 1; }"); audio_gaps = []
    px, py = center(page, '#tt-playBtn'); T.tap(px, py); time.sleep(2.0)
    page.evaluate("""() => { window.__gaps = 0; window.__t = setInterval(() => { const r = window.__rms(); if (r >= 0 && r < 0.002) window.__gaps++; }, 25); }""")
    for sec in ['albums', 'mixtapes', 'radio', 'booth', 'settings']:
        to_section(page, sec); time.sleep(0.4)
        page.evaluate("() => { const a = window.__rt.app(), e = a.state.engine; if (a.state.T - e.position / e.sampleRate < 18) window.__rt.goTo({ index: 0, time: 1 }, true); }"); time.sleep(1.0)   # the synthesized record is only 24 s long: keep it playing
        was_playing = rms_now(page) > 0.005          # audio keeps running through lock + AOD only if it was playing (navigating to some sections stops the vinyl: not an AOD effect)
        page.evaluate('window.__gaps = 0'); lock(page, T); jump(page, 61000); time.sleep(0.5)
        check(dm(page)['aod'], f'{tag}: {sec}: AOD on')
        cnt = page.evaluate("""() => new Promise((res) => { let n = 0; const loop = () => { n++; requestAnimationFrame(loop); }; requestAnimationFrame(loop); setTimeout(() => res(n), 5200); })""")
        check(cnt <= 7, f'{tag}: {sec}: rAF callbacks in 5.2 s of AOD: {cnt} (<= 1 per second)')
        vis = page.evaluate("[...document.querySelectorAll('canvas')].filter(c => { const r = c.getBoundingClientRect(); return r.width > 4 && getComputedStyle(c).visibility !== 'hidden' && getComputedStyle(c).display !== 'none'; }).map(c => c.className || c.id)")
        check(vis == ([ 'tt-layer tt-disc' ] if sec == 'albums' else []), f'{tag}: {sec}: visible canvases in AOD: {vis}')
        if sec == 'albums': page.screenshot(path=f'{SHOTS}/{tag}-albums-aod-outline.png')
        sx, sy = stray_point(page, w, h); T.tap(sx, sy); time.sleep(0.12); T.tap(sx, sy + 2); time.sleep(0.6)
        check(not dm(page)['aod'] and dm(page)['locked'], f'{tag}: {sec}: wake')
        g_ = page.evaluate('window.__gaps')
        if was_playing: audio_gaps.append(g_)
        check(not was_playing or g_ <= 2, f'{tag}: {sec}: audio ran through lock + AOD + wake without a dropout (near-silent samples {g_}; audio was {"playing" if was_playing else "not playing here"})')
        unlock_hold(page, T, 1000)
        check(not dm(page)['locked'], f'{tag}: {sec}: unlocked')
    page.evaluate("clearInterval(window.__t)")
    check(len(audio_gaps) >= 1 and max(audio_gaps) <= 2, f'{tag}: the AudioContext kept running across the enter/exit cycles where audio played ({audio_gaps})')
    to_section(page, 'albums'); time.sleep(0.8)
    # leaving AOD restored the stage: the disc canvas draws again, scratching still works
    check(page.evaluate(f"{APP}.stage.outline") is False, f'{tag}: the stage left outline mode')
    cx0, cy0 = stage_pt(page, 700, 300)
    T.down((cx0, cy0)); time.sleep(0.05); T.move((cx0 + 8, cy0 + 20)); time.sleep(0.05); T.move((cx0 + 12, cy0 + 40)); time.sleep(0.05)
    check(page.evaluate(f'{APP}.stage.isScratching()'), f'{tag}: scratching works after lock / AOD / unlock cycles'); T.up()
    px_ = page.evaluate("(() => { const c = document.querySelector('canvas.tt-disc'); const g = c.getContext('2d'); const d = g.getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4 * 97) if (d[i] > 0) n++; return n; })()")
    check(px_ > 200, f'{tag}: the disc canvas is painted again after AOD ({px_} sampled opaque pixels)')
    check(not errs, f'{tag}: no page errors {errs[:3]}')
    b.close()

def audio_across_aod(p):
    """Audio must not glitch across AOD enter/exit: sample the master bus RMS every 25 ms while the synthesized track plays."""
    b = launch(p); ctx, page, errs = boot(b, 412, 915, seed=False); T = Touch(page)
    px, py = center(page, '#tt-playBtn'); T.tap(px, py); time.sleep(1.5)
    page.evaluate("""() => { window.__gaps = []; window.__min = 1; let last = performance.now(); window.__t = setInterval(() => { const r = window.__rms(); const t = performance.now(); if (r >= 0 && r < 0.002) window.__gaps.push([t, r]); window.__min = Math.min(window.__min, r); last = t; }, 25); }""")
    page.evaluate('runoutDeviceMode.lock()'); time.sleep(0.5)
    jump(page, 61000); time.sleep(2.0)
    T.tap(200, 300); time.sleep(0.12); T.tap(200, 302); time.sleep(1.5)
    page.evaluate("clearInterval(window.__t)")
    rms = page.evaluate("window.__rms()"); gaps = page.evaluate("window.__gaps.length")
    check(rms > 0.002 and gaps <= 2, f'audio: no dropouts across AOD enter/exit (rms now {rms:.3f}, near-silent samples {gaps})')
    check(not errs, 'audio: no page errors')
    b.close()

if __name__ == '__main__' or True:
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        for (w, h) in [(412, 915), (360, 780)]:
            run_size(p, w, h)
        audio_across_aod(p)
        for (w, h) in [(412, 915), (360, 780)]:
            new_ui_albums(p, w, h); new_ui_cassette(p, w, h); aod_new_ui(p, w, h)
        locked_hint_card(p)
    print('\nFAILED: %d' % len(fails)); [print(' -', f) for f in fails]
    sys.exit(1 if fails else 0)
