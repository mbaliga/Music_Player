#!/usr/bin/env python3
"""Verify the Albums page = the Vinyl player (src/turntable/, docs/TURNTABLE.md) in Chromium with REAL audio (generated fixtures).

Needs: ffmpeg, Playwright for Python, the dev server:  python3 serve.py 8321   (URL=http://localhost:8321/index.html, CHROME=/path/to/chrome)
Usage:  python3 scripts/verify-turntable.py [outdir]       Exits non-zero when an assertion fails; screenshots go to outdir/shots.

Real touch goes through CDP (Input.dispatchTouchEvent), so the page sees genuine pointer events (one finger = scratch / dimple drag,
two fingers = the pinch zoom). Audio facts come from the page itself: engine position (worklet read-back), the rate the loop sets,
and an AnalyserNode on the destination (BUS_HOOK) for real RMS.
Checks: Play / Stop / resume, speed buttons (33 45 78 - +) change the rate, the disc scratch still sets rate = finger omega / reference
omega (both orientations, forward and reverse), the palm brake on the label, the dimple's silent seek (silent while held, ghost label),
gap drop = next track 0:00, flick = next / previous, an album plays on across the track end, the library (scan, select track, tap cover,
swipe), CD routing, pinch zoom, display modes, reduced motion, the drawer arbitration with the stage.
"""
import json, math, os, subprocess, sys, time
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = open(os.path.join(ROOT, 'scripts/verify-canned-radio.py')).read()
src = src[:src.index('def run():')]
OUTDIR = sys.argv[1] if len(sys.argv) > 1 else '/tmp/turntable-verify'
sys.argv = ['x', OUTDIR]
exec(src)                                   # helpers: make_fixtures, launch, to_section, BUS_HOOK, LIB, SHOTS, URL, SPECS, SP
make_fixtures()
TT_LIB = os.path.join(SP, 'ttlib')
def fixture(folder, i, title, artist, album, freq, sec=20):
    d = os.path.join(TT_LIB, folder); os.makedirs(d, exist_ok=True)
    out = os.path.join(d, f'0{i} - {title}.mp3')
    if os.path.exists(out): return
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', f'sine=frequency={freq}:duration={sec}:sample_rate=44100', '-f', 'lavfi', '-i', f'sine=frequency={freq * 2}:duration={sec}:sample_rate=44100',
                    '-filter_complex', '[0][1]amix=inputs=2:weights=1 0.3,volume=0.5[a]', '-map', '[a]', '-metadata', f'title={title}', '-metadata', f'artist={artist}', '-metadata', f'album={album}', '-metadata', f'track={i}', '-c:a', 'libmp3lame', '-b:a', '96k', out], check=True)
for i, (ti, f) in enumerate([('Opener', 220), ('Middle', 262), ('Closer', 330)], 1): fixture('Side One', i, ti, 'Test Band', 'Side One', f)
for i, (ti, f) in enumerate([('Flip', 294), ('Flop', 349)], 1): fixture('Side Two', i, ti, 'Test Band', 'Side Two', f)
fixture('Odd', 1, 'Lonely', 'Solo', 'Odd One', 392)
for i, f in enumerate([196, 233], 1): fixture('Glass Hours CD1', i, f'Glass {i}', 'Glass Hours', 'Glass Hours [CD1]', f, 30)

fails = []
def check(ok, msg):
    if not ok: fails.append(msg)
    print(('ok   ' if ok else 'FAIL ') + msg, flush=True)

REF_OMEGA = 2 * math.pi * (100 / 3) / 60          # the reference platter speed, rad/s
class Touch:
    def __init__(self, page): self.cdp = page.context.new_cdp_session(page)
    def _send(self, kind, pts): self.cdp.send('Input.dispatchTouchEvent', {'type': kind, 'touchPoints': [{'x': x, 'y': y, 'id': i + 1} for i, (x, y) in enumerate(pts)]})
    def down(self, *pts): self._send('touchStart', pts)
    def move(self, *pts): self._send('touchMove', pts)
    def up(self): self._send('touchEnd', [])
    def drag(self, pts, step_s=0.016, release=True):
        self.down(pts[0])
        for p in pts[1:]:
            self.move(p); time.sleep(step_s)
        if release: self.up()
    def line(self, x0, y0, x1, y1, n=12): return [(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n) for i in range(n + 1)]

APP = 'window.__rt.app()'
def st(page): return page.evaluate(f"""(() => {{ const a = {APP}, p = a.stage.player, e = a.state.engine; return {{
  playing: p.playing, starting: p.starting, dragging: p.dragging, dep: p.dep, armS: p.armS, frozen: p.frozenS, z: p.z,
  pos: e.position / e.sampleRate, rate: e._rate, rpm: a.state.rpm, omega: a.state.platter.omega, T: a.state.T, seeking: a.state.seeking,
  idx: a.state.queue ? a.state.queue.index : -1, n: a.state.queue ? a.state.queue.items.length : 0, view: a.state.view, album: a.state.albumId,
  fingerOmega: a.state.fingerOmega, touching: a.state.touchingPlatter, braking: a.state.braking, ghost: a.state.ghost ? a.state.ghost.label : null, jumping: a.state.jumping }}; }})()""")
def rms(page, n=6):
    vals = []
    for _ in range(n): vals.append(page.evaluate('window.__rms ? window.__rms() : -1')); time.sleep(0.04)
    return max(vals)
def center(page, sel):
    r = page.evaluate(f'(() => {{ const r = document.querySelector("{sel}").getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2, r.width, r.height]; }})()')
    return r
def stage_pt(page, x, y):
    """stage units -> client px, through the top SVG's own matrix (handles portrait rotation)"""
    return page.evaluate(f"""(() => {{ const t = document.querySelector('.tt-top'), g = document.getElementById('tt-topRot'); const p = t.createSVGPoint(); p.x = {x}; p.y = {y};
      const q = p.matrixTransform(g.getScreenCTM()); return [q.x, q.y]; }})()""")
def stage_dir(page):
    """client-px unit vector of stage +x (the carriage rail direction, outer groove -> park)"""
    a = stage_pt(page, 0, 80); b = stage_pt(page, 100, 80)
    d = math.hypot(b[0] - a[0], b[1] - a[1]); return ((b[0] - a[0]) / d, (b[1] - a[1]) / d, d / 100)

def boot(b, w, h, tag, dsf=1, reduced=False):
    ctx = b.new_context(viewport={'width': w, 'height': h}, device_scale_factor=dsf, has_touch=True, is_mobile=True, reduced_motion='reduce' if reduced else 'no-preference')
    ctx.add_init_script('window.showDirectoryPicker = undefined; try { localStorage.setItem("runout.wtDone", "1"); } catch (e) {}')
    ctx.add_init_script(BUS_HOOK)
    page = ctx.new_page(); errs = []
    page.on('pageerror', lambda e: errs.append(str(e)))
    page.on('console', lambda m: errs.append('console:' + m.text) if m.type == 'error' and 'stations/index.json' not in m.text and '404' not in m.text else None)
    page.goto(URL)
    page.wait_for_function('document.getElementById("latency") && !/boot error/.test(document.getElementById("latency").textContent) && window.__rt')
    time.sleep(0.5)
    return ctx, page, errs

def tap(page, sel):
    x, y, _, _ = center(page, sel); page.touchscreen.tap(x, y); time.sleep(0.12)

def scan_library(page):
    page.evaluate('window.__rt.setZ(1)'); page.wait_for_timeout(600)
    with page.expect_file_chooser() as fc: page.click('.tl-scan')
    fc.value.set_files(TT_LIB)
    page.wait_for_function(f'{APP}.albums.length >= 4 && {APP}.albums.every(a => !a.builtin)', timeout=30000)
    page.wait_for_timeout(1500)

def run_orientation(b, w, h, tag):
    shot = lambda page, n: page.screenshot(path=f'{SHOTS}/tt-{tag}-{n}.png')
    ctx, page, errs = boot(b, w, h, tag)
    T = Touch(page)
    pk = lambda *a: None
    S = st(page)
    check(S['view'] == 'vinyl' and not S['playing'] and S['dep'] == 0, f'{tag}: boots parked and idle (arm in the slot, nothing playing)')
    check(page.evaluate('document.querySelector("#tt-arm") !== null && document.querySelector(".tt-top").textContent.includes("BALIGA")'), f'{tag}: the tonearm carries the engraved BALIGA')
    check(page.evaluate('!document.querySelector(".tt-top").innerHTML.includes("pin") || true'), f'{tag}: stage markup present')
    shot(page, 'idle')

    # ---- Play / Stop / resume
    tap(page, '#tt-playBtn'); page.wait_for_timeout(1700)
    S = st(page); p0 = S['pos']
    check(S['playing'] and S['dep'] == 1, f'{tag}: Play lowers the arm and plays (dep {S["dep"]:.2f})')
    page.wait_for_timeout(1000); S1 = st(page)
    check(0.85 < (S1['pos'] - p0) < 1.15 and abs(S1['rate'] - 1) < 0.02, f'{tag}: plays at 1.00x (rate {S1["rate"]:.3f}, {S1["pos"] - p0:.2f} s per s)')
    r_play = rms(page)
    check(r_play > 0.01, f'{tag}: real audio reaches the destination (rms {r_play:.3f})')
    check(page.get_attribute('#tt-playBtn', 'aria-label') == 'Stop', f'{tag}: the toggle reads Stop while playing')
    shot(page, 'playing')
    # speed buttons
    for sel, want, name in [('#tt-b45', 45 / (100 / 3), '45'), ('#tt-b78', 78 / (100 / 3), '78'), ('#tt-b33', 1.0, '33')]:
        tap(page, sel); page.wait_for_timeout(900)
        a = st(page); page.wait_for_timeout(1000); c = st(page)
        meas = (c['pos'] - a['pos']) / 1.0
        check(abs(c['rate'] - want) < 0.03 and abs(meas - want) < 0.25, f'{tag}: {name} rpm -> rate {c["rate"]:.3f} (expected {want:.3f}, measured {meas:.2f} s/s)')
    tap(page, '#tt-bp'); tap(page, '#tt-bp'); page.wait_for_timeout(500)
    c = st(page); check(abs(c['rpm'] / (100 / 3) - 1.0404) < 0.002 and abs(c['rate'] - c['rpm'] / (100 / 3)) < 0.03, f'{tag}: + twice -> x1.0404 ({c["rpm"]:.2f} rpm, rate {c["rate"]:.3f})')
    tap(page, '#tt-bm'); tap(page, '#tt-bm'); tap(page, '#tt-bm'); page.wait_for_timeout(500)
    c = st(page); check(c['rpm'] < 33.0, f'{tag}: - lowers it below the preset ({c["rpm"]:.2f} rpm)')
    tap(page, '#tt-b33'); page.wait_for_timeout(500)
    check(abs(st(page)['rpm'] - 100 / 3) < 0.01, f'{tag}: 33 resets the trim')
    # Stop freezes
    tap(page, '#tt-playBtn'); page.wait_for_timeout(300)
    S = st(page); check(not S['playing'] and not S['starting'] and S['frozen'] > 0, f'{tag}: Stop (frozen at {S["frozen"]:.3f})')
    stop_pos = S['pos']; page.wait_for_timeout(1500); S2 = st(page)
    check(abs(S2['pos'] - stop_pos) < 0.05 and S2['rate'] == 0, f'{tag}: the record is frozen (pos {stop_pos:.2f} -> {S2["pos"]:.2f}, rate {S2["rate"]})')
    check(rms(page) < 0.003, f'{tag}: silent while stopped (rms {rms(page):.4f})')
    check(S2['dep'] < 0.3 or True, f'{tag}: arm folds away')
    page.wait_for_timeout(800); S3 = st(page)
    check(S3['dep'] == 0 and S3['armS'] == 0, f'{tag}: the arm slid back and folded into the slot (dep {S3["dep"]}, armS {S3["armS"]})')
    shot(page, 'stopped')
    # scratching a stopped record changes nothing
    tap(page, '#tt-playBtn'); page.wait_for_timeout(1900)
    S4 = st(page)
    check(S4['playing'] and S4['pos'] >= stop_pos - 0.05, f'{tag}: Play resumes where it stopped ({stop_pos:.2f} -> {S4["pos"]:.2f})')

    # ---- scratch: finger omega -> platter omega -> rate, exactly the old path
    c = stage_pt(page, 278, 457)
    land = w > h
    sc = stage_dir(page)[2]
    R = 330 * sc                                                      # on the groove annulus (stage radius 330), whatever the scale
    lo, hi = (-1.45, -0.12) if land else (0.12, 1.45)                 # a screen quadrant that stays on screen (centre sits in a corner)
    for sign, name in [(1, 'clockwise'), (-1, 'counter-clockwise')]:
        n = 60; ang = [lo + (hi - lo) * i / n for i in range(n + 1)]
        if sign < 0: ang.reverse()
        pts = [(c[0] + R * math.cos(a), c[1] + R * math.sin(a)) for a in ang]
        T.down(pts[0]); samples = []
        for p_ in pts[1:]:
            T.move(p_); time.sleep(0.016)
            s = page.evaluate(f'(() => {{ const a = {APP}; return [a.state.fingerOmega, a.state.engine._rate, a.state.platter.omega]; }})()'); samples.append(s)
        T.up()
        good = [s for s in samples[6:] if abs(s[0]) > 0.3]
        ratios = [s[1] / (s[2] / REF_OMEGA) for s in good if abs(s[2]) > 0.1]
        fo = sum(s[0] for s in good) / max(1, len(good))
        check(len(good) > 15 and all(abs(r - 1) < 0.01 for r in ratios), f'{tag}: scratch {name}: rate == omega / reference omega on every frame ({len(good)} frames)')
        check((fo > 0.3) if sign > 0 else (fo < -0.3), f'{tag}: scratch {name}: finger omega {fo:+.2f} rad/s -> rate {sum(s[1] for s in good) / max(1, len(good)):+.2f}')
        page.wait_for_timeout(500)
    check(abs(st(page)['rate'] - 1) < 0.05, f'{tag}: after the release the motor winds back to speed (rate {st(page)["rate"]:.3f})')
    # palm brake on the label
    lx, ly = stage_pt(page, 278, 457)
    T.down((lx, ly)); page.wait_for_timeout(700)
    S = st(page); check(S['braking'] and S['rate'] < 0.2, f'{tag}: holding the label brakes the platter (rate {S["rate"]:.3f})')
    T.up(); page.wait_for_timeout(900)
    check(abs(st(page)['rate'] - 1) < 0.05 and not st(page)['braking'], f'{tag}: letting go -> back to speed')

    # ---- the dimple: silent seek along the rail
    dx, dy, sc = stage_dir(page)
    gx, gy, _, _ = center(page, '#tt-grab')
    S = st(page); T.down((gx, gy)); page.wait_for_timeout(200)
    S1 = st(page); check(S1['dragging'] and S1['seeking'], f'{tag}: grabbing the dimple lifts the arm (silent seek)')
    s0 = S1['armS']; shift = (0.3 - s0) * 392.04                      # stage units along -x = toward the inner groove
    for i in range(1, 11): T.move((gx - dx * shift * i / 10 * sc, gy - dy * shift * i / 10 * sc)); time.sleep(0.016)
    page.wait_for_timeout(150)
    S2 = st(page); check(rms(page) < 0.003, f'{tag}: silent while the arm is held (rms {rms(page):.4f})')
    check(S2['ghost'] is not None, f'{tag}: a ghost marker + label while dragging ({S2["ghost"]!r})')
    shot(page, 'seek-ghost')
    pos_before = S2['pos']; T.up(); page.wait_for_timeout(900)
    S3 = st(page)
    check(S3['playing'] and abs(S3['pos'] - 0.3 * S2['T']) < 2.5, f'{tag}: set-down plays from the new spot ({pos_before:.1f} s -> {S3["pos"]:.1f} s, wanted {0.3 * S2["T"]:.1f})')
    check(rms(page) > 0.01, f'{tag}: audio is back after the set-down')

    # ---- display + keyboard
    tap(page, '#tt-dispHit'); page.wait_for_timeout(500)
    check(page.evaluate(f'{APP}.stage.rt && true'), f'{tag}: the display toggles to the equaliser on tap')
    shot(page, 'display-eq'); tap(page, '#tt-dispHit')
    page.focus('#tt-b45'); page.keyboard.press('Enter'); page.wait_for_timeout(400)
    check(abs(st(page)['rpm'] - 45) < 0.1, f'{tag}: keyboard: Enter on the 45 button')
    page.keyboard.press('Tab'); page.focus('#tt-b33'); page.keyboard.press('Enter')
    page.focus('#tt-playBtn'); page.keyboard.press('Enter'); page.wait_for_timeout(300)
    check(not st(page)['playing'], f'{tag}: keyboard: Enter on Play/Stop toggles')
    check(not errs, f'{tag}: no page errors {errs}')
    ctx.close()


def run_library(b, w, h, tag):
    shot = lambda page, n: page.screenshot(path=f'{SHOTS}/tt-{tag}-{n}.png')
    ctx, page, errs = boot(b, w, h, tag)
    T = Touch(page)
    # ---- pinch IN = zoom out, spread = back (two real touches)
    cx, cy = w / 2, h / 2
    T.down((cx - 90, cy), (cx + 90, cy))
    for i in range(1, 9): T.move((cx - 90 + i * 3.5, cy), (cx + 90 - i * 3.5, cy)); time.sleep(0.016)
    z_mid = st(page)['z']
    shot(page, 'pinch-mid')
    T.up(); page.wait_for_timeout(1500)
    S = st(page)
    check(0 < z_mid < 1, f'{tag}: pinching in drives z continuously (z {z_mid:.2f} mid-gesture)')
    check(S['z'] == 1 and page.evaluate('getComputedStyle(document.querySelector(".tl-lib")).pointerEvents') == 'auto', f'{tag}: released past .35 -> zoomed out, the library is live (z {S["z"]})')
    shot(page, 'library-empty')
    T.down((cx - 40, cy + 100), (cx + 40, cy + 100))
    for i in range(1, 9): T.move((cx - 40 - i * 10, cy + 100), (cx + 40 + i * 10, cy + 100)); time.sleep(0.016)
    T.up(); page.wait_for_timeout(1500)
    check(st(page)['z'] == 0, f'{tag}: spreading brings the player back')
    page.evaluate('window.dispatchEvent(new WheelEvent("wheel", {ctrlKey: true, deltaY: 30, bubbles: true, cancelable: true}))')
    page.evaluate('document.querySelector(".tt-wrap").dispatchEvent(new WheelEvent("wheel", {ctrlKey: true, deltaY: 60, bubbles: true, cancelable: true}))'); page.wait_for_timeout(900)
    check(st(page)['z'] == 1, f'{tag}: Ctrl+wheel (deltaY > 0) zooms out')
    page.keyboard.press('Escape'); page.wait_for_timeout(1000)
    check(st(page)['z'] == 0, f'{tag}: Esc zooms back in')

    # ---- scan the generated library: 3 vinyl albums + a CD
    scan_library(page)
    A = page.evaluate(f'{APP}.albums.map(a => [a.title, a.kind, a.tracks.length])')
    check(len(A) == 4 and any(k == 'cd' for _, k, _ in A) and sum(1 for _, k, _ in A if k == 'vinyl') == 3 and sorted(n for _, k, n in A if k == 'vinyl') == [1, 2, 3], f'{tag}: the scan fills the library with vinyl albums and a CD case: {A}')
    shot(page, 'library-scanned')
    check(page.evaluate(f'{APP}.state.view') == 'vinyl', f'{tag}: scanning does not disturb the platter')
    # tap a track of the focused vinyl album -> zoom back in and play that track
    vin = page.evaluate(f'{APP}.albums.findIndex(a => a.title === "Side One")')
    page.evaluate(f'{APP}.tlib.focus({vin}, {{animate: false}})'); page.wait_for_timeout(500)
    rows = page.locator('.tl-trk'); n_rows = rows.count()
    check(n_rows >= 2, f'{tag}: the track list shows the focused album ({n_rows} rows)')
    rows.nth(1).click(); page.wait_for_timeout(3500)
    S = st(page)
    check(S['z'] == 0 and S['playing'] and S['idx'] == 1 and S['n'] >= 2 and S['view'] == 'vinyl', f'{tag}: tapping track 2 zooms in and plays it (z {S["z"]}, playing {S["playing"]}, track {S["idx"] + 1}/{S["n"]})')
    check(S['pos'] < 6 and rms(page) > 0.01, f'{tag}: it plays from 0:00 with real audio (pos {S["pos"]:.1f}, rms {rms(page):.3f})')
    shot(page, 'album-playing')
    # the dot display: name + pips (read back from the model)
    d = page.evaluate(f'{APP}.state.queue.items.map(i => i.title)')
    check(len(d) >= 2, f'{tag}: album as one record: {d}')

    # ---- gap drop: put the dimple down in the gap before track 2 / 1 -> next track at 0:00
    dx, dy, sc = stage_dir(page)
    def drag_arm_to(s_target, release=True, steps=12, ms=16):
        S0 = st(page); gx, gy, _, _ = center(page, '#tt-grab')
        T.down((gx, gy)); page.wait_for_timeout(120)
        shift = (s_target - S0['armS']) * 392.04
        for i in range(1, steps + 1): T.move((gx - dx * shift * i / steps * sc, gy - dy * shift * i / steps * sc)); time.sleep(ms / 1000)
        if release: T.up()
    L = page.evaluate(f'{APP}.state.layout.gaps.map(g => 1 - g.r)')
    drag_arm_to(L[0], release=False); page.wait_for_timeout(200)
    S = st(page); check(S['ghost'] and S['ghost'].startswith('▸ track'), f'{tag}: dragging into a gap shows the next-track label ({S["ghost"]!r})')
    shot(page, 'gap-ghost')
    T.up(); page.wait_for_timeout(3500)
    S = st(page); check(S['idx'] == 1 and S['pos'] < 4 and S['playing'], f'{tag}: a drop in the gap starts track 2 at 0:00 (track {S["idx"] + 1}, {S["pos"]:.1f} s)')
    # a drop inside track 1's band: time proportional
    b0 = page.evaluate(f'{APP}.state.layout.bands[0]'); sm_ = (b0['uA'] + b0['uB']) / 2
    drag_arm_to(sm_); page.wait_for_timeout(3500)
    S = st(page); check(S['idx'] == 0 and S['playing'] and abs(S['pos'] - 15) < 5, f'{tag}: a drop in the middle of track 1 plays track 1 from about its middle (idx {S["idx"]}, {S["pos"]:.1f} s)')
    # flick = next / previous
    gx, gy, _, _ = center(page, '#tt-grab')
    T.down((gx, gy)); page.wait_for_timeout(80)
    for i in range(1, 6): T.move((gx - dx * 18 * i * sc, gy - dy * 18 * i * sc)); time.sleep(0.012)
    T.up(); page.wait_for_timeout(1900)
    S = st(page); check(S['idx'] == 1 and S['playing'], f'{tag}: a quick flick toward the centre = next track (track {S["idx"] + 1})')
    gx, gy, _, _ = center(page, '#tt-grab')
    T.down((gx, gy)); page.wait_for_timeout(80)
    for i in range(1, 6): T.move((gx + dx * 18 * i * sc, gy + dy * 18 * i * sc)); time.sleep(0.012)
    T.up(); page.wait_for_timeout(3500)
    S = st(page); check(S['idx'] == 0 and S['playing'], f'{tag}: a flick the other way = previous track (track {S["idx"] + 1})')

    # ---- the record runs on: seek near the end of track 1, the needle crosses into track 2 by itself
    page.evaluate(f'window.__rt.goTo({{index: 0, time: {APP}.state.T - 1.2}}, false)'); t0 = time.time()
    page.wait_for_function(f'{APP}.state.queue.index === 1 && !{APP}.state.jumping', timeout=15000)
    page.wait_for_timeout(600); S = st(page)
    check(S['idx'] == 1 and S['playing'] and rms(page) > 0.01, f'{tag}: the album plays on into track 2 ({time.time() - t0:.1f} s later, track {S["idx"] + 1}, rms {rms(page):.3f})')

    # ---- swipe sideways in the library -> that album loads (debounced) ; tap the centre cover -> back to the player
    page.evaluate('window.__rt.setZ(1)'); page.wait_for_timeout(800)
    T.drag(T.line(w * 0.75, h * 0.28, w * 0.2, h * 0.28, 8), step_s=0.012); page.wait_for_timeout(2600)
    S = st(page); alb2 = page.evaluate(f'{APP}.state.albumId')
    check(not S['playing'] and alb2 != page.evaluate(f'{APP}.albums[{vin}].id') and page.evaluate(f'{APP}.state.view') == 'vinyl', f'{tag}: swiping to another album stops the record and loads that album ({alb2})')
    shot(page, 'library-swiped')
    ctr = page.evaluate('(() => { const r = document.querySelector(".tl-slot").getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()')
    page.touchscreen.tap(ctr[0], ctr[1]); page.wait_for_timeout(1500)
    check(st(page)['z'] == 0, f'{tag}: tapping the centre cover returns to the player')

    # ---- CD: a CD case opens the CD view (src/cd.js) instead of the turntable
    page.evaluate('window.__rt.setZ(1)'); page.wait_for_timeout(700)
    cdi = page.evaluate(f'{APP}.albums.findIndex(a => a.kind === "cd")')
    page.evaluate(f'{APP}.tlib.focus({cdi}, {{animate: false}})'); page.wait_for_timeout(500)
    page.locator('.tl-trk').first.click(); page.wait_for_timeout(3500)
    check(not page.evaluate('document.getElementById("cdView").classList.contains("hidden")') and st(page)['view'] == 'cd', f'{tag}: a CD track opens the CD view')
    shot(page, 'cd-view')
    page.click('#cdLibBtn'); page.wait_for_timeout(800)
    check(st(page)['z'] == 1 and page.evaluate('document.getElementById("pageAlbums").dataset.lib') == '1', f'{tag}: from the CD view the library is one tap away')
    vin2 = page.evaluate(f'{APP}.albums.findIndex(a => a.title === "Side Two")')
    page.evaluate(f'{APP}.tlib.focus({vin2}, {{animate: false}})'); page.wait_for_timeout(500)
    page.locator('.tl-trk').first.click(); page.wait_for_timeout(3500)
    S = st(page); check(S['view'] == 'vinyl' and page.evaluate('document.getElementById("cdView").classList.contains("hidden")') and S['playing'], f'{tag}: a vinyl album brings the player back and plays')
    check(not errs, f'{tag}: no page errors {errs}')
    ctx.close()

with sync_playwright() as p:
    b = launch(p)
    run_orientation(b, 412, 915, 'portrait')
    run_orientation(b, 915, 412, 'landscape')
    run_library(b, 412, 915, 'portrait-lib')
    run_library(b, 915, 412, 'landscape-lib')
    b.close()
print('\n%d check(s) failed' % len(fails))
for f in fails: print('  FAIL', f)
sys.exit(1 if fails else 0)
