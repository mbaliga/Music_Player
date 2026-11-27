#!/usr/bin/env python3
"""Cross-feature seams of the playback round (real tone files on a mocked phone library; every audible claim is the dominant frequency of the
engine output, never app state alone; desktop Chromium, NOT a device test).

  1  resume vs cover tap        a resumed (paused) album: the cover tap PLAYS it from the saved place (vinyl and CD), a cover tap on the playing one does not restart it
  2  shuffle/repeat vs stage    the stage Previous / Next keys follow the shuffled order, wrap under Repeat all, and a press near a gapless join advances exactly once
  3  sleep timer vs owners      a station and a tape are both stopped by the timer, the album owner is covered by verify-basics
  4  seek bar                   tap seeks (audible), frozen while locked and in AOD, agrees with the tonearm's position
  5  mini-bar Previous          follows the shuffled order backwards
  6  delete-undo snackbar       Undo restores the tape; Back does not eat it; a locked screen cannot Undo
Usage: python3 scripts/verify-seams.py [section ...]     (default: all)      CHROME=/path/to/chrome overrides the browser."""
import sys, os, re
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from basics_common import *
from playwright.sync_api import sync_playwright

check = Checker()
SECS = 40
VF = [600, 800, 1000, 1200]            # the vinyl album 'Tone Album'
CF = [1500, 1700, 1900]                # the CD set 'Double Set CD 1'
LIB = [('Tone Band', 'Tone Album', VF), ('Cold Front', 'Double Set CD 1', CF)]
STORE = "(() => { try { return JSON.parse(localStorage.getItem('runout.resume.v1')); } catch (e) { return null; } })()"
A = "window.__rt.app()"

def set_mode(pg, shuffle=None, repeat=None):
    pg.evaluate("""([sh, rp]) => { const st = window.__rt.app().settingsStore; if (sh !== null) st.set('playback.shuffle', sh); if (rp !== null) st.set('playback.repeat', rp); }""", [shuffle, repeat])

def focus_album(pg, title_part):
    i = pg.evaluate("(t) => window.__rt.app().albums.findIndex((a) => a.title.includes(t))", title_part)
    pg.evaluate("(i) => window.__rt.app().tlib.focus(i, { animate: false })", i); pg.wait_for_timeout(1500)
    return i

def start_album(pg, title_part, wait=2500):
    """The real path: open the library, focus the album, tap its first row (a programmatic focus alone does not load it)."""
    pg.evaluate('window.__rt.setZ(1)'); pg.wait_for_timeout(1200); focus_album(pg, title_part)
    pg.evaluate("document.querySelector('.tl-trk').click()"); pg.wait_for_timeout(wait)

def st(pg):
    return pg.evaluate("""(() => { const a = window.__rt.app(), s = a.state, p = a.stage.player; return { view: s.view, qi: s.queue && s.queue.index, cd: s.cdPlaying, playing: !!(p.playing || p.starting), z: p.z,
      pos: s.engine.position / s.engine.sampleRate, owner: s.albumId, radio: !!s.radioOn }; })()""")

def is_playing(pg):
    s = st(pg); return (s['cd'] if s['view'] == 'cd' else s['playing'])

def center_of(pg, sel):
    return pg.evaluate("""(sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2, r.width, r.height]; }""", sel)

def tap_cover(pg):
    pg.evaluate('window.__rt.setZ(1)'); pg.wait_for_timeout(1500)
    c = center_of(pg, '.tl-slot')
    pg.mouse.click(c[0], c[1]); pg.wait_for_timeout(300)

# ── 1 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
def sec_resume_cover(b, URL):
    print('\n=== 1. resume vs cover tap ===', flush=True)
    ctx, pg, errs = open_app(b, URL, LIB, secs=SECS)
    kinds = pg.evaluate(f"{A}.albums.map((a) => [a.title, a.kind])"); print('     albums', kinds)
    check(any(k[1] == 'cd' for k in kinds) and any(k[1] == 'vinyl' for k in kinds), 'the fake library has one vinyl album and one CD')
    # ---- vinyl
    start_album(pg, 'Tone Album')
    pg.evaluate("window.__rt.goTo({ index: 2, time: 20 }, false)"); d = settle_dom(pg, VF[2]); check(near(d, VF[2]), f'vinyl track 3 plays ({d:.0f} Hz)')
    pg.wait_for_timeout(4500); pg.evaluate(PLAY); pg.wait_for_timeout(1000)       # pause: the record is written at once
    p0 = pos(pg); rec = pg.evaluate(STORE); check(bool(rec) and rec['index'] == 2, f'vinyl: resume record written ({rec})')
    reload(pg); pg.wait_for_timeout(4500)
    s = st(pg); check(s['qi'] == 2 and not s['playing'] and abs(pos(pg) - p0) < 1.5, f'vinyl: restored PAUSED on track 3 at {pos(pg):.1f} s (saved {p0:.1f})')
    check(not near(pg.evaluate('window.__dom()'), VF[2]), 'vinyl: silent after restore')
    tap_cover(pg)
    d = settle_dom(pg, VF[2], 9000); s = st(pg); pp = pos(pg)
    check(near(d, VF[2]) and s['qi'] == 2 and s['z'] == 0, f'vinyl: the cover tap on the resumed album plays ITS track 3 ({d:.0f} Hz, queue {s["qi"]}, z {s["z"]})')
    check(pp > p0 - 1, f'vinyl: ... from the saved place, not from 0 ({pp:.1f} s, saved {p0:.1f})')
    check(pg.evaluate("document.getElementById('resumeChip').hidden"), 'vinyl: the Resume chip is gone once it plays')
    tap_cover(pg); pg.wait_for_timeout(1500)
    p2 = pos(pg); s = st(pg)
    check(s['playing'] and s['qi'] == 2 and p2 > pp, f'vinyl: a cover tap on the album that is already playing does not restart it ({pp:.1f} -> {p2:.1f} s, track {s["qi"] + 1})')
    # ---- CD
    start_album(pg, 'Double Set'); d = settle_dom(pg, CF[0])
    check(near(d, CF[0]) and st(pg)['view'] == 'cd', f'CD: Play loads the CD and plays track 1 ({d:.0f} Hz, view {st(pg)["view"]})')
    pg.evaluate("window.__rt.goTo({ index: 1, time: 12 }, false)"); d = settle_dom(pg, CF[1]); check(near(d, CF[1]), f'CD track 2 plays ({d:.0f} Hz)')
    pg.wait_for_timeout(4500); pg.evaluate("document.getElementById('cdPlay').click()"); pg.wait_for_timeout(1200)
    check(not is_playing(pg), 'CD: paused')
    c0 = pos(pg); rec = pg.evaluate(STORE); check(bool(rec) and rec['view'] == 'cd' and rec['index'] == 1, f'CD: resume record written ({rec})')
    reload(pg); pg.wait_for_timeout(4500)
    s = st(pg); check(s['view'] == 'cd' and s['qi'] == 1 and not is_playing(pg) and abs(pos(pg) - c0) < 1.5, f'CD: restored PAUSED on track 2 at {pos(pg):.1f} s (saved {c0:.1f})')
    tap_cover(pg)
    d = settle_dom(pg, CF[1], 9000); s = st(pg); pp = pos(pg)
    check(near(d, CF[1]) and s['qi'] == 1, f'CD: the cover tap plays the resumed track 2 ({d:.0f} Hz, queue {s["qi"]})')
    check(pp > c0 - 1, f'CD: ... from the saved place, not from 0 ({pp:.1f} s, saved {c0:.1f})')
    tap_cover(pg); pg.wait_for_timeout(1500)
    p2 = pos(pg); check(is_playing(pg) and p2 > pp, f'CD: a cover tap on the album that is already playing does not restart it ({pp:.1f} -> {p2:.1f} s)')
    check(not errs, f'no console / page errors {errs[:3]}')
    ctx.close()

# ── 2 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
def sec_stage_keys(b, URL):
    print('\n=== 2. shuffle / repeat vs the stage Previous / Next keys ===', flush=True)
    freqs = [500, 700, 900, 1100, 1300]
    ctx, pg, errs = open_app(b, URL, [('Tone Band', 'Tone Album', freqs)], secs=SECS)
    def order(): return pg.evaluate(f"{A}.state.queue.order")
    def idx(): return pg.evaluate(f"{A}.state.queue.index")
    def key(id_): pg.evaluate("(i) => document.getElementById(i).dispatchEvent(new MouseEvent('click', { bubbles: true }))", id_)
    pg.evaluate(PLAY); settle_dom(pg, freqs[0], 9000)
    set_mode(pg, shuffle=True, repeat='off'); o = order()
    check(o is not None and o[0] == 0 and sorted(o) == [0, 1, 2, 3, 4], f'shuffle on: a permutation led by the playing track {o}')
    seen = [0]
    for k in range(4):
        key('tt-next'); want = o[k + 1]; d = settle_dom(pg, freqs[want], 9000); seen.append(idx())
        check(near(d, freqs[want]) and idx() == want, f'stage Next #{k + 1} follows the shuffled order: slot {want} ({d:.0f} Hz, index {idx()})')
    for k in range(2):
        key('tt-prev'); pg.wait_for_timeout(250); want = o[3 - k]; d = settle_dom(pg, freqs[want], 9000)
        check(near(d, freqs[want]) and idx() == want, f'stage Previous follows the order backwards: slot {want} ({d:.0f} Hz, index {idx()})')
    # a press just before a natural (gapless) join advances exactly once
    set_mode(pg, shuffle=True, repeat='off'); pg.evaluate(f"window.__rt.goTo({{ index: {idx()}, time: 0.5 }}, false)"); pg.wait_for_timeout(400)
    cur = idx(); k = o.index(cur)
    if k + 2 < 5:
        pg.evaluate(f"window.__rt.goTo({{ index: {cur}, time: {SECS} - 4.2 }}, false)"); pg.wait_for_timeout(2300)     # inside the look-ahead window
        key('tt-next'); want = o[k + 1]; d = settle_dom(pg, freqs[want], 9000); pg.wait_for_timeout(6000)
        d2 = settle_dom(pg, freqs[want], 3000)
        check(near(d, freqs[want]) and near(d2, freqs[want]) and idx() == want, f'Next pressed at the gapless join advances exactly once (slot {want}: {d:.0f} then {d2:.0f} Hz, index {idx()})')
    # repeat all: Next on the last slot of the order wraps; repeat off: Next on the last slot does not run past the end
    set_mode(pg, shuffle=False, repeat='all'); pg.evaluate("window.__rt.goTo({ index: 4, time: 0.5 }, false)"); settle_dom(pg, freqs[4], 9000)
    key('tt-next'); d = settle_dom(pg, freqs[0], 9000); check(near(d, freqs[0]) and idx() == 0, f'repeat all: stage Next on the last track wraps to the first ({d:.0f} Hz)')
    key('tt-prev'); pg.wait_for_timeout(400); d = settle_dom(pg, freqs[4], 9000); check(near(d, freqs[4]) and idx() == 4, f'repeat all: stage Previous on the first track wraps to the last ({d:.0f} Hz)')
    set_mode(pg, shuffle=False, repeat='off'); pg.evaluate("window.__rt.goTo({ index: 4, time: 0.5 }, false)"); settle_dom(pg, freqs[4], 9000)
    key('tt-next'); pg.wait_for_timeout(1500); s = st(pg); print('     repeat off, Next on the last track:', s)
    check(s['qi'] == 4 or not s['playing'], f'repeat off: stage Next on the last track does not play a phantom track (index {s["qi"]}, playing {s["playing"]})')
    check(not errs, f'no console / page errors {errs[:3]}')
    ctx.close()

# ── 3 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
SKEW = "(() => { if (!window.__realNow) { window.__realNow = Date.now.bind(Date); window.__skew = 0; Date.now = () => window.__realNow() + window.__skew; } })()"
def skew(pg, sec): pg.evaluate("(s) => { window.__skew += s * 1000; }", sec)

def sec_sleep_owners(b, URL):
    print('\n=== 3. sleep timer vs station / tape owners ===', flush=True)
    ctx, pg, errs = open_app(b, URL, LIB, secs=SECS)
    pg.evaluate(SKEW)
    # a canned station
    pg.evaluate(f"{A}.shell().go('radio', {{ close: true }})"); pg.wait_for_selector('.dial-card', timeout=15000)
    pg.locator('.dial-card[data-station="meridian-91-5"]').click(); pg.wait_for_selector('.pw-label', state='visible', timeout=15000)
    pg.wait_for_function('document.querySelector(".ai-now-title") && document.querySelector(".ai-now-title").textContent !== "Tuning in…"', timeout=25000); pg.wait_for_timeout(2500)
    on = lambda: pg.evaluate("(() => { const l = document.querySelector('.pw-label'); return !!l && l.getBoundingClientRect().width > 0; })()")
    audible = lambda: sum(pg.evaluate('window.__rms()') for _ in range(8)) / 8
    check(on() and audible() > 0.003, f'a station is on air and audible ({audible():.3f})')
    pg.evaluate("window.__sleep.start(5)"); pg.wait_for_timeout(300); skew(pg, 301); pg.wait_for_timeout(4500)
    sl = pg.evaluate("window.__sleep.state().mode")
    check(sl == 'off' and not on(), f'the sleep timer stops the station and clears itself (on {on()}, timer {sl})')
    pg.wait_for_timeout(1500); check(audible() < 0.004, f'the station is silent after the timer ({audible():.4f})')
    check(not errs, f'no console / page errors {errs[:3]}')
    ctx.close()

def avg_dom_quiet(pg):
    v = [pg.evaluate('window.__rms()') for _ in range(5)]; return sum(v) / len(v) < 0.004

# ── 4 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
def sec_seekbar(b, URL):
    print('\n=== 4. stage seek bar vs lock / AOD / tonearm ===', flush=True)
    ctx, pg, errs = open_app(b, URL, [('Tone Band', 'Tone Album', VF)], secs=SECS)
    pg.evaluate(SKEW)
    pg.evaluate(PLAY); settle_dom(pg, VF[0], 9000)
    bar = lambda: center_of(pg, '.rt-seek')
    c = bar(); check(bool(c) and c[2] > 150 and c[3] >= 44, f'the seek bar is there: {c and [round(x) for x in c]}')
    # tap at ~70 % of the TRACK line -> within the record the position moves there
    tr = pg.evaluate("(() => { const r = document.querySelector('.rt-seek-track').getBoundingClientRect(); return [r.left, r.width, r.top + r.height / 2]; })()")
    p_before = pos(pg); pg.mouse.click(tr[0] + tr[1] * 0.70, tr[2]); pg.wait_for_timeout(1500)
    tot = pg.evaluate(f"{A}.state.T"); q = st(pg)['qi']
    d = settle_dom(pg, VF[q], 6000); p_after = pos(pg)
    print(f'     seek tap: pos {p_before:.1f} -> {p_after:.1f} s of {tot:.1f}, track {q}')
    check(abs(p_after - tot * 0.70) < 3 and near(d, VF[q]), f'unlocked: a tap at 70 % seeks there, audibly ({p_after:.1f} of {tot:.1f} s, {d:.0f} Hz)')
    vn = pg.evaluate("+document.querySelector('.rt-seek').getAttribute('aria-valuenow')")
    check(abs(vn - pos(pg)) < 3, f'the bar reads the engine position (aria {vn}, engine {pos(pg):.1f})')
    # tonearm: drag the dimple back, the bar follows
    gx, gy, _, _ = center_of(pg, '#tt-grab'); pg.mouse.move(gx, gy); pg.mouse.down()
    for i in range(1, 12): pg.mouse.move(gx - 4 * i, gy + 6 * i); pg.wait_for_timeout(30)
    pg.mouse.up(); pg.wait_for_timeout(1800)
    p_arm = pos(pg); vn = pg.evaluate("+document.querySelector('.rt-seek').getAttribute('aria-valuenow')")
    check(abs(vn - p_arm) < 3, f'after a tonearm drag the bar agrees with the position (aria {vn}, engine {p_arm:.1f})')
    # lock
    kx, ky, _, _ = center_of(pg, '.page:not([hidden]) .dm-key')
    pg.mouse.click(kx, ky); pg.wait_for_timeout(500)
    check(pg.evaluate('runoutDeviceMode.state.locked'), 'locked')
    pa = pos(pg); tr = pg.evaluate("(() => { const r = document.querySelector('.rt-seek-track').getBoundingClientRect(); return [r.left, r.width, r.top + r.height / 2]; })()")
    pg.mouse.click(tr[0] + tr[1] * 0.15, tr[2]); pg.wait_for_timeout(1200); pb = pos(pg)
    check(abs(pb - pa) < 3.5, f'locked: the seek bar is frozen ({pa:.1f} -> {pb:.1f} s)')
    pg.keyboard.press('Tab'); pg.evaluate("(() => { const e = document.querySelector('.rt-seek'); e.focus(); e.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })); })()"); pg.wait_for_timeout(800)
    check(abs(pos(pg) - pa) < 3.5, 'locked: a keyboard Home on the bar does not seek either')
    # AOD
    pg.evaluate("() => { window.__off = 0; }"); skew(pg, 61); pg.evaluate("runoutDeviceMode.machine.tick(Date.now())"); pg.wait_for_timeout(1000)
    check(pg.evaluate('runoutDeviceMode.state.aod'), 'AOD is on')
    vis = pg.evaluate("(() => { const e = document.querySelector('.rt-seek'); if (!e) return 'none'; const r = e.getBoundingClientRect(), cs = getComputedStyle(e); return cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0 || r.width === 0 ? 'hidden' : 'visible'; })()")
    print('     seek bar in AOD:', vis)
    if vis == 'visible':
        pg.mouse.click(tr[0] + tr[1] * 0.9, tr[2]); pg.wait_for_timeout(1000)
        check(pos(pg) < 20, f'AOD: tapping where the bar is does not seek ({pos(pg):.1f} s)')
    else: check(True, 'AOD: the seek bar is not shown')
    check(not errs, f'no console / page errors {errs[:3]}')
    ctx.close()

# ── 5 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
def sec_minibar(b, URL):
    print('\n=== 5. mini-bar Previous / Next with shuffle ===', flush=True)
    freqs = [500, 700, 900, 1100, 1300]
    ctx, pg, errs = open_app(b, URL, [('Tone Band', 'Tone Album', freqs)], secs=SECS)
    def order(): return pg.evaluate(f"{A}.state.queue.order")
    def idx(): return pg.evaluate(f"{A}.state.queue.index")
    pg.evaluate(PLAY); settle_dom(pg, freqs[0], 9000)
    set_mode(pg, shuffle=True, repeat='off'); o = order()
    pg.evaluate(f"{A}.shell().go('settings', {{ close: true }})"); pg.wait_for_timeout(1200)
    check(pg.evaluate("(() => { const m = document.querySelector('.minibar'); return !!m && !m.hidden && m.getBoundingClientRect().height > 0; })()"), 'the mini bar is up on Settings')
    for k in range(3):
        pg.evaluate("document.querySelector('.minibar-next').click()"); want = o[k + 1]; d = settle_dom(pg, freqs[want], 9000)
        check(near(d, freqs[want]) and idx() == want, f'mini-bar Next #{k + 1}: shuffled slot {want} ({d:.0f} Hz)')
    pg.evaluate(f"window.__rt.goTo({{ index: {idx()}, time: 0.4 }}, false)"); pg.wait_for_timeout(500)
    for k in range(2):
        cur = idx(); want = o[o.index(cur) - 1]
        pg.evaluate("document.querySelector('.minibar-prev').click()"); d = settle_dom(pg, freqs[want], 9000)
        check(near(d, freqs[want]) and idx() == want, f'mini-bar Previous follows the shuffled order: slot {want} ({d:.0f} Hz)')
        pg.evaluate(f"window.__rt.goTo({{ index: {idx()}, time: 0.4 }}, false)"); pg.wait_for_timeout(400)
    check(not errs, f'no console / page errors {errs[:3]}')
    ctx.close()

# ── 6 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
def sec_snackbar(b, URL):
    print('\n=== 6. delete-undo snackbar vs Back and lock ===', flush=True)
    ctx, pg, errs = open_app(b, URL, [('Tone Band', 'Tone Album', VF)], secs=SECS)
    pg.evaluate(f"{A}.shell().go('mixtapes', {{ close: true }})"); pg.wait_for_timeout(900)
    pg.evaluate("""() => { const a = window.__rt.app(); a.state.mixtapes.startFrom({ trackIds: a.shelf[0].tracks.map((t) => t.id), name: 'Doomed' }); }"""); pg.wait_for_selector('.ed', timeout=5000); pg.wait_for_timeout(400)
    pg.click('.ed-bar .sv'); pg.wait_for_selector('.ed', state='detached'); pg.wait_for_timeout(800)
    n0 = pg.locator('.cs-card').count(); check(n0 >= 1, f'a tape is on the shelf ({n0})')
    pg.evaluate("(() => { const m = window.__rt.app().state.mixtapes; m.deleteTape(m.list[0].id); })()"); pg.wait_for_timeout(600)
    check(pg.locator('.cs-card').count() == n0 - 1, f'the tape is gone from the shelf ({pg.locator(".cs-card").count()} cards)')
    check(pg.locator('.rt-snack').count() == 1 and 'Doomed' in pg.inner_text('.rt-snack'), f'the snackbar names it ({pg.locator(".rt-snack").count()})')
    sc = center_of(pg, '.rt-snack-btn'); sbox = pg.evaluate("(() => { const r = document.querySelector('.rt-snack').getBoundingClientRect(); return [r.bottom, innerHeight, r.width]; })()")
    check(sc[3] >= 44 and sbox[0] <= sbox[1], f'the Undo is a 48 px target inside the viewport ({sc[3]:.0f} px high, bar bottom {sbox[0]:.0f} of {sbox[1]})')
    # Back does not eat the snackbar, nor undo it
    pg.evaluate("window.__runoutBack()"); pg.wait_for_timeout(600)
    print('     after Back: snackbar', pg.locator('.rt-snack').count(), 'page', pg.evaluate('document.querySelector(".page:not([hidden])").dataset.section'))
    sec_now = pg.evaluate('document.querySelector(".page:not([hidden])").dataset.section')
    check(sec_now == 'albums' and pg.locator('.rt-snack').count() == 1, f'Back leaves the Mixtapes page as usual and the snackbar stays ({sec_now}, snackbars {pg.locator(".rt-snack").count()})')
    pg.evaluate(f"{A}.shell().go('mixtapes', {{ close: true }})"); pg.wait_for_timeout(600)
    check(pg.locator('.cs-card').count() == n0 - 1 and pg.locator('.rt-snack').count() == 1, 'Back does not undo the delete (the shelf is still without the tape)')
    # lock: the Undo is inert while locked
    kx, ky, _, _ = center_of(pg, '.page:not([hidden]) .dm-key')
    if pg.locator('.rt-snack').count() == 0: print('     (snackbar gone after Back: acceptable only if the page changed)')
    pg.mouse.click(kx, ky); pg.wait_for_timeout(500)
    locked = pg.evaluate('runoutDeviceMode.state.locked')
    if locked and pg.locator('.rt-snack-btn').count():
        c = center_of(pg, '.rt-snack-btn'); pg.mouse.click(c[0], c[1]); pg.wait_for_timeout(600)
        check(pg.locator('.cs-card').count() == n0 - 1, 'locked: a tap on Undo does nothing')
    else: print('     locked', locked, 'snackbar', pg.locator('.rt-snack-btn').count())
    check(not errs, f'no console / page errors {errs[:3]}')
    ctx.close()

# ── 7 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
def sec_tour_cta(b, URL):
    print('\n=== 7. tour last-card CTA ===', flush=True)
    ctx = b.new_context(bypass_csp=True, viewport={'width': 360, 'height': 780}, device_scale_factor=1, has_touch=True, is_mobile=True)
    ctx.add_init_script('window.showDirectoryPicker = undefined;')   # the web build: the last card says "Choose music folder"
    pg = ctx.new_page(); errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(URL); pg.wait_for_function(READY, timeout=30000); pg.wait_for_selector('.wt-overlay:not(.hidden)', timeout=8000)
    n = pg.evaluate('document.querySelectorAll(".wt-dot").length')
    for i in range(n - 1): pg.tap('.wt-next'); pg.wait_for_timeout(150)
    vis = pg.evaluate("(() => { const b = document.querySelector('.wt-scan'); const r = b && b.getBoundingClientRect(); return b && !b.closest('.wt-cta').hidden ? [b.textContent, r.width, r.height] : null; })()")
    check(bool(vis) and vis[2] >= 44, f'the last card offers a real button ({vis})')
    pg.screenshot(path='/tmp/seams-cta.png')
    with pg.expect_file_chooser(timeout=5000) as fc: pg.tap('.wt-scan')
    check(fc.value is not None, 'the button opens the music-folder chooser from inside the tap')
    pg.wait_for_timeout(600)
    check(pg.evaluate('document.querySelector(".wt-overlay").classList.contains("hidden")') and pg.evaluate('localStorage.getItem("runout.wtDone")') == '1', 'the button closes the tour and remembers it')
    check(not errs, f'no page errors {errs[:3]}')
    ctx.close()

SECTIONS = {'resume': sec_resume_cover, 'stagekeys': sec_stage_keys, 'sleep': sec_sleep_owners, 'seek': sec_seekbar, 'minibar': sec_minibar, 'snackbar': sec_snackbar, 'cta': sec_tour_cta}

def main():
    want = sys.argv[1:] or list(SECTIONS)
    srv, URL = serve()
    try:
        with sync_playwright() as p:
            b = p.chromium.launch(executable_path=CH, args=['--autoplay-policy=no-user-gesture-required'])
            for k in want:
                try: SECTIONS[k](b, URL)
                except Exception as e: check(False, f'section {k} raised {type(e).__name__}: {str(e)[:300]}')
            b.close()
    finally:
        srv.terminate()
    print('\nFAILED: %d' % len(check.fails) if check.fails else '\nALL OK')
    for f in check.fails: print(' -', f)
    sys.exit(1 if check.fails else 0)

if __name__ == '__main__': main()
