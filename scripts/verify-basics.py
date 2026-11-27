#!/usr/bin/env python3
"""Player basics, end to end in desktop Chromium (a mocked phone library of real tone files; audio is MEASURED at the engine output):
  1 resume last position   2 shuffle / repeat   3 sleep timer   4 notification rationale   5 MediaSession seek + artwork
Usage: python3 scripts/verify-basics.py [phase ...]    (default: all)      CHROME=/path/to/chrome overrides the browser."""
import sys, os, re
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from basics_common import *
from playwright.sync_api import sync_playwright

check = Checker()
TONES = [600, 800, 1000, 1200]
ALB = [('Tone Band', 'Tone Album', TONES)]
STORE = "(() => { try { return JSON.parse(localStorage.getItem('runout.resume.v1')); } catch (e) { return null; } })()"

def phase_resume(b, URL):
    print('\n=== 1. resume last position ===', flush=True)
    ctx, pg, errs = open_app(b, URL, ALB)
    pg.evaluate(PLAY); pg.wait_for_timeout(2500)
    pg.evaluate("window.__rt.goTo({ index: 2, time: 20 }, false)")
    d = settle_dom(pg, TONES[2]); check(near(d, TONES[2]), f'track 3 plays its tone ({d:.0f} Hz)')
    pg.wait_for_timeout(4500)
    rec = pg.evaluate(STORE)
    check(bool(rec) and rec['trackId'].startswith('d2-') and rec['index'] == 2 and rec['t'] > 20, f'the record is written while playing, with the stable d2- track id: {rec}')
    pg.evaluate(PLAY); pg.wait_for_timeout(900)           # pause: written at once
    rec = pg.evaluate(STORE); p0 = pos(pg)
    check(abs(rec['t'] - p0) < 1.5, f"pausing writes the position at once ({rec['t']:.1f} s vs engine {p0:.1f} s)")
    reload(pg); pg.wait_for_timeout(4500)
    st = pg.evaluate("(() => { const a = window.__rt.app(), s = a.state; const c = document.getElementById('resumeChip'); return { qi: s.queue && s.queue.index, title: s.queue && s.queue.items[s.queue.index].title, playing: a.stage.player.playing || a.stage.player.starting, chip: c && !c.hidden ? c.textContent : null, albumId: s.albumId }; })()")
    check(st['qi'] == 2 and 'T3' in (st['title'] or ''), f'relaunch: track 3 is back on the platter ({st})')
    check(not st['playing'] and not near(pos(pg), 0.0001) and abs(pos(pg) - p0) < 1.5, f'relaunch: restored PAUSED at the saved position ({pos(pg):.1f} s, saved {p0:.1f} s)')
    check(st['chip'] and 'Resume' in st['chip'], f"relaunch: the Resume chip is there ({st['chip']})")
    pg.wait_for_timeout(1200)
    check(not near(pg.evaluate('window.__dom()'), TONES[2]) , 'relaunch: nothing is audible (never auto-plays)')
    pg.click('#resumeChip'); d = settle_dom(pg, TONES[2], 9000)
    check(near(d, TONES[2]), f'tapping Resume plays the saved track ({d:.0f} Hz)')
    check(pos(pg) > p0 - 1, f'... from the saved position, not from 0 ({pos(pg):.1f} s)')
    check(pg.evaluate("document.getElementById('resumeChip').hidden"), 'the chip goes away once it plays')
    check(not errs, f'no console / page errors {errs[:3]}')
    # the file is gone: quietly the normal state (a new context has the record but the phone library no longer has that track)
    st2 = ctx.storage_state()
    ctx.close()
    ctx2 = b.new_context(bypass_csp=True, viewport={'width': 412, 'height': 860}, storage_state=st2)
    ctx2.add_init_script("try { localStorage.setItem('runout.resume.v1', JSON.stringify({ v: 1, albumId: 'tone band\\u0000tone album', trackId: 'd2-zzzz', index: 2, t: 33, view: 'vinyl', at: 1 })); } catch (e) {}")
    ctx2, pg2, errs2 = open_app(b, URL, ALB, ctx=ctx2)
    pg2.wait_for_timeout(3500)
    st = pg2.evaluate("(() => { const a = window.__rt.app(), s = a.state; const c = document.getElementById('resumeChip'); return { qi: s.queue && s.queue.index, chip: c && !c.hidden, playing: a.stage.player.playing, toast: (document.getElementById('rtToast')||{}).textContent || '' }; })()")
    check(st['qi'] in (0, None) and not st['chip'] and not st['playing'], f'track gone: normal first-run state, no chip, no sound ({st})')
    check(not re.search(r'cannot|re-link|lost|fail|resume', st['toast'], re.I), f"track gone: no error message ({st['toast']!r})")
    pg2.evaluate(PLAY); d = settle_dom(pg2, TONES[0]); check(near(d, TONES[0]), f'track gone: Play starts the focused album as ever ({d:.0f} Hz)')
    rec = pg2.evaluate(STORE); check(rec and rec['index'] == 0, f'track gone: the stale record is replaced by what the user really played ({rec and rec["index"]})')
    ctx2.close()
    # demo record: with an EMPTY library the demo record is never written as a resume point
    ctx3, pg3, errs3 = open_app(b, URL, [], scan=False)
    pg3.evaluate(PLAY); pg3.wait_for_timeout(3500)
    check(pg3.evaluate(STORE) is None, 'demo record (empty library) never writes a resume record')
    ctx3.close()

SET = "window.__rt.app().settings"
def set_mode(pg, shuffle=None, repeat=None):
    pg.evaluate("""async ([sh, rp]) => { const m = await import('/src/settings/wire.js'); const st = window.__rt.app().settingsStore; if (sh !== null) st.set('playback.shuffle', sh); if (rp !== null) st.set('playback.repeat', rp); }""", [shuffle, repeat])

def phase_shuffle(b, URL):
    print('\n=== 2. shuffle and repeat ===', flush=True)
    freqs = [500, 700, 900, 1100, 1300]
    ctx, pg, errs = open_app(b, URL, [('Tone Band', 'Tone Album', freqs)], secs=35)
    pg.evaluate(PLAY); d = settle_dom(pg, freqs[0], 9000); check(near(d, freqs[0]), f'plain order: track 1 plays {d:.0f} Hz')
    def order(): return pg.evaluate("window.__rt.app().state.queue.order")
    def idx(): return pg.evaluate("window.__rt.app().state.queue.index")
    def seek_near_end(i): pg.evaluate("([i]) => window.__rt.goTo({ index: i, time: 35 - 3.5 }, false)", [i]); pg.wait_for_timeout(500)
    # shuffle ON while track 1 plays: it keeps leading, the order is a permutation, and the sheet switch reflects it
    set_mode(pg, shuffle=True)
    o = order(); check(o is not None and o[0] == 0 and sorted(o) == [0, 1, 2, 3, 4], f'shuffle on: a permutation led by the playing track {o}')
    check(near(settle_dom(pg, freqs[0], 3000), freqs[0]), 'shuffle on does not interrupt the playing track')
    # walk the whole record by natural ends (gapless join): each audible tone must be the tone of the slot the order names
    seen = [idx()]
    for k in range(4):
        seek_near_end(seen[-1]); want = o[k + 1]
        d = settle_dom(pg, freqs[want], 9000)
        check(near(d, freqs[want]) and idx() == want, f'shuffle step {k + 1}: slot {want} -> {freqs[want]} Hz plays (measured {d:.0f}, queue index {idx()})')
        seen.append(idx())
    check(sorted(seen) == [0, 1, 2, 3, 4], f'every track exactly once in a shuffled pass: {seen}')
    # titles / ids still belong to their audio: the title of the playing slot says its number
    title = pg.evaluate("(() => { const q = window.__rt.app().state.queue; return q.items[q.index].title; })()")
    check(title.endswith('T%d' % (seen[-1] + 1)), f'track title still matches the audio after shuffling ({title})')
    # repeat OFF: end of the order stops
    seek_near_end(idx()); pg.wait_for_timeout(6500)
    st = pg.evaluate("(() => { const a = window.__rt.app(); return { playing: a.stage.player.playing || a.stage.player.starting, frozen: a.stage.player.frozenS }; })()")
    check(not st['playing'], f'repeat off: the record stops at the end of the shuffled order ({st})')
    # repeat ALL wraps
    set_mode(pg, repeat='all')
    pg.evaluate(PLAY); pg.wait_for_timeout(1500)
    last = idx(); o = order(); pos_ = o.index(last); wrap = o[(pos_ + 1) % 5]
    seek_near_end(last); d = settle_dom(pg, freqs[wrap], 9000)
    check(near(d, freqs[wrap]) and idx() == wrap, f'repeat all: after the last of the order slot {wrap} plays again ({d:.0f} Hz)')
    # repeat ONE replays the same track, a pressed Next still advances
    set_mode(pg, repeat='one'); cur = idx()
    seek_near_end(cur); pg.wait_for_timeout(5500)
    d = settle_dom(pg, freqs[cur], 6000); check(near(d, freqs[cur]) and idx() == cur and pos(pg) < 20, f'repeat one: track {cur + 1} replays from the start ({d:.0f} Hz, {pos(pg):.1f} s)')
    pg.evaluate("document.getElementById('btnNextTrk').click()"); pg.wait_for_timeout(300)
    nxt = order()[(order().index(cur) + 1) % 5]
    d = settle_dom(pg, freqs[nxt], 9000); check(near(d, freqs[nxt]) and idx() == nxt, f'repeat one: pressing Next still moves on, in shuffle order ({d:.0f} Hz)')
    # Prev follows the shuffled order backwards
    pg.evaluate("window.__rt.goTo({ index: %d, time: 0 }, false)" % nxt); pg.wait_for_timeout(600)
    pg.evaluate("document.getElementById('btnPrevTrk').click()"); pg.wait_for_timeout(300)
    d = settle_dom(pg, freqs[cur], 9000); check(near(d, freqs[cur]) and idx() == cur, f'Prev goes back to the previous track of the shuffle order ({d:.0f} Hz)')
    # a bad file inside the shuffled order is skipped
    set_mode(pg, repeat='off', shuffle=True); o = order(); cur = idx(); p = o.index(cur)
    if p + 2 < 5:
        bad = o[p + 1]; good = o[p + 2]
        pg.evaluate("([i]) => { window.__rt.app().state.queue.items[i].bad = true; }", [bad])
        pg.evaluate("document.getElementById('btnNextTrk').click()"); d = settle_dom(pg, freqs[good], 9000)
        check(near(d, freqs[good]) and idx() == good, f'bad file skipped inside the shuffled order (slot {bad} skipped, slot {good} plays: {d:.0f} Hz)')
    # shuffle OFF restores slot order and persists
    set_mode(pg, shuffle=False, repeat='off'); check(order() is None, 'shuffle off: slot order again')
    set_mode(pg, shuffle=True, repeat='all')
    reload(pg); pg.wait_for_timeout(1500)
    saved = pg.evaluate("(() => { const s = JSON.parse(localStorage.getItem('runout.settings.v1')); return [s.playback.shuffle, s.playback.repeat]; })()")
    check(saved == [True, 'all'], f'shuffle / repeat persist in settings ({saved})')
    # sheet + settings page + mini bar show it
    pg.evaluate(PLAY); pg.wait_for_timeout(2500)
    sw_on = pg.evaluate("(() => { const b = document.querySelector('#ttPlayModeHost .st-switch'); return b && b.getAttribute('aria-checked'); })()")
    rp = pg.evaluate("(() => { const b = document.querySelector('#ttPlayModeHost [role=radio][aria-checked=true]'); return b && b.textContent; })()")
    check(sw_on == 'true' and rp == 'All', f'the stage sheet shows shuffle on / repeat all ({sw_on}, {rp})')
    pg.evaluate("window.__rt.app().shell().go('settings', { close: true })"); pg.wait_for_timeout(1200)
    mini = pg.evaluate("(() => { const m = document.querySelector('.minibar'); return m && !m.hidden ? m.querySelector('.minibar-sub').textContent : null; })()")
    check(bool(mini) and 'shuffle' in mini and 'repeat all' in mini, f'the mini bar says shuffle / repeat ({mini!r})')
    pg.evaluate("document.querySelector('.st-group[data-group=playback]').open = true")
    stg = pg.evaluate("(() => { const g = document.querySelector('.st-group[data-group=playback]'); const r = g.querySelector('[role=radiogroup][aria-label=Repeat] [aria-checked=true]'); const s = [...g.querySelectorAll('.st-switch')].find((x) => /Shuffle/.test(x.textContent)); return [r && r.textContent, s && s.getAttribute('aria-checked')]; })()")
    check(stg == ['All', 'true'], f'Settings > Playback shows the same two controls ({stg})')
    pg.evaluate("window.__rt.app().shell().go('albums', { close: true })"); pg.wait_for_timeout(800)
    # the artist "Play all" queue shuffles the same way
    set_mode(pg, shuffle=True, repeat='off')
    ok = pg.evaluate("async () => { const a = window.__rt.app(); return await a.actions().playTracks(a.shelf[0].tracks.map((t) => t.id)); }")
    pg.wait_for_timeout(1500)
    o = order(); cur = idx(); check(ok and o is not None and sorted(o) == [0, 1, 2, 3, 4], f'Play all: the queue is shuffled too ({o})')
    pg.evaluate("document.getElementById('btnNextTrk').click()"); nx = o[(o.index(cur) + 1) % 5]
    d = settle_dom(pg, freqs[nx], 9000); check(near(d, freqs[nx]) and idx() == nx, f'Play all: Next follows the shuffled order, each id its own audio ({d:.0f} Hz = slot {nx})')
    pg.evaluate("document.querySelector('#ttPlayModeHost [data-v=one]').click()"); pg.wait_for_timeout(300)
    check(pg.evaluate("JSON.parse(localStorage.getItem('runout.settings.v1')).playback.repeat") == 'one', 'tapping Repeat: One in the sheet changes the setting')
    check(not errs, f'no console / page errors {errs[:3]}')
    ctx.close()

SKEW = "(() => { if (!window.__realNow) { window.__realNow = Date.now.bind(Date); window.__skew = 0; Date.now = () => window.__realNow() + window.__skew; } })()"
def skew(pg, sec): pg.evaluate("(s) => { window.__skew += s * 1000; }", sec)
def rms(pg): return pg.evaluate('window.__rms()')
def avg_rms(pg, n=6):
    v = []
    for _ in range(n): v.append(rms(pg)); pg.wait_for_timeout(60)
    return sum(v) / len(v)
def sleep_state(pg): return pg.evaluate("window.__sleep.state()")

def phase_sleep(b, URL):
    print('\n=== 3. sleep timer ===', flush=True)
    freqs = [500, 700, 900]
    ctx, pg, errs = open_app(b, URL, [('Tone Band', 'Tone Album', freqs)], secs=40)
    pg.evaluate(SKEW)
    pg.evaluate(PLAY); d = settle_dom(pg, freqs[0], 9000); check(near(d, freqs[0]), f'album plays ({d:.0f} Hz)')
    full = avg_rms(pg); check(full > 0.01, f'full-volume rms {full:.3f}')
    # the controls: stage sheet and Settings both offer 5/10/15/30/45/60 and End of track
    opts = pg.evaluate("[...document.querySelectorAll('#ttSleepHost [role=radio]')].map((b) => b.textContent)")
    check(opts == ['Off', '5 min', '10 min', '15 min', '30 min', '45 min', '60 min', 'End of track'], f'the stage sheet offers every option ({opts})')
    pg.evaluate("document.querySelector('#ttSleepHost [data-v=\"5\"]').click()"); pg.wait_for_timeout(300)
    st = sleep_state(pg); check(st['mode'] == 'timer' and st['spec'] == 5 and 290 < st['remainingSec'] <= 300, f'5 min armed: {st}')
    line = pg.evaluate("document.querySelector('#ttSleepHost .sl-line').textContent"); check('Stops in 4:5' in line or 'Stops in 5:0' in line, f'remaining time is shown in the sheet ({line!r})')
    chip = pg.evaluate("(() => { const c = document.getElementById('sleepChip'); return c && !c.hidden ? c.textContent : null; })()")
    check(bool(chip) and chip.startswith('Sleep ') and ('4:' in chip or '5:00' in chip), f'a countdown chip is on the Albums page ({chip!r})')
    pg.evaluate("window.__rt.app().shell().go('settings', { close: true })"); pg.wait_for_timeout(900)
    pg.evaluate("document.querySelector('.st-group[data-group=playback]').open = true")
    sg = pg.evaluate("(() => { const g = document.querySelector('.st-group[data-group=playback]'); const on = g.querySelector('.sl-seg [aria-checked=true]'); return [on && on.textContent, (g.querySelector('.sl-line')||{}).textContent]; })()")
    check(sg[0] == '5 min' and 'Stops in' in sg[1], f'Settings > Playback shows the running timer ({sg})')
    # the page is hidden (screen off): no animation frames at all. The timer must still fade and stop.
    pg.evaluate("""() => { window.__rafCalls = 0; window.__realRaf = window.requestAnimationFrame; window.requestAnimationFrame = () => 0;
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange')); }""")
    pg.wait_for_timeout(600)
    def left(sec): skew(pg, sleep_state(pg)['remainingSec'] - sec)
    left(11); pg.wait_for_timeout(700)                      # 11 s left
    r11 = avg_rms(pg); check(r11 > full * 0.8, f'11 s left: still full volume ({r11:.3f} vs {full:.3f})')
    check(pg.evaluate("window.__rt.app().stage.player.playing"), 'still playing before the timer ends')
    left(6); pg.wait_for_timeout(900)                       # the first fade tick inserts the fader; the harness tap would still hear the bus directly, so unhook it
    pg.evaluate("window.__rt.app().state.engine.musicBus.disconnect(window.__tap)"); pg.wait_for_timeout(300)
    r6 = avg_rms(pg); check(0.05 * full < r6 < 0.75 * full, f'~5 s left: the music is fading ({r6:.3f} of {full:.3f})')
    left(2); pg.wait_for_timeout(500)
    r2 = avg_rms(pg); check(r2 < r6 * 0.6, f'~2 s left: quieter still ({r2:.3f})')
    left(0.2); pg.wait_for_timeout(2500)                    # expired
    a = pg.evaluate("(() => { const a = window.__rt.app(); return { playing: a.stage.player.playing || a.stage.player.starting, state: window.__sleep.state() }; })()")
    check(not a['playing'] and a['state']['mode'] == 'off', f'timer ended with the page hidden and no rAF: playback stopped, timer cleared ({a})')
    pg.wait_for_timeout(600); check(avg_rms(pg) < 0.002, 'silent after the stop')
    pg.evaluate("""() => { delete document.hidden; delete document.visibilityState; window.requestAnimationFrame = window.__realRaf; document.dispatchEvent(new Event('visibilitychange')); }""")
    pg.wait_for_timeout(700)
    check(pg.evaluate("document.getElementById('sleepChip').hidden"), 'the countdown chip is gone')
    check('Sleep timer' in (pg.evaluate("(document.getElementById('rtToast')||{}).textContent") or ''), 'a short message says what happened')
    pg.evaluate("window.__rt.app().shell().go('albums', { close: true })"); pg.wait_for_timeout(700)
    pg.evaluate(PLAY); pg.wait_for_timeout(2500)
    back = avg_rms(pg); check(back > full * 0.8, f'next time Play is at full volume again ({back:.3f} vs {full:.3f})')
    # end of track: fade over the last seconds, then pause, and the NEXT track must not start
    pg.evaluate("window.__rt.goTo({ index: 0, time: 40 - 14 }, false)"); pg.wait_for_timeout(700)
    pg.evaluate("document.querySelector('#ttSleepHost [data-v=end]').click()"); pg.wait_for_timeout(400)
    st = sleep_state(pg); check(st['mode'] == 'end' and 11 < st['remainingSec'] < 14, f'end of track armed with the remaining time of this track: {st}')
    pg.wait_for_timeout(5000)
    rm = avg_rms(pg); check(rm < full * 0.85, f'end of track: fading before the end ({rm:.3f})')
    pg.wait_for_timeout(9500)
    a = pg.evaluate("(() => { const a = window.__rt.app(); return { playing: a.stage.player.playing || a.stage.player.starting, idx: a.state.queue.index, st: window.__sleep.state().mode }; })()")
    check(not a['playing'] and a['idx'] == 0 and a['st'] == 'off', f'end of track: stopped on the same track, the next one never started ({a})')
    # a manual stop clears the timer
    pg.evaluate(PLAY); pg.wait_for_timeout(1500)
    pg.evaluate("window.__sleep.start(30)"); pg.wait_for_timeout(500)
    pg.evaluate(PLAY); pg.wait_for_timeout(5000)
    check(sleep_state(pg)['mode'] == 'off', 'stopping by hand clears the timer')
    # a tape: the owner-aware stop pauses it
    pg.evaluate("window.__rt.app().shell().go('mixtapes', { close: true })"); pg.wait_for_timeout(800)
    pg.evaluate("""() => { const a = window.__rt.app(); a.state.mixtapes.startFrom({ trackIds: a.shelf[0].tracks.map((t) => t.id), name: 'Sleepy' }); }"""); pg.wait_for_selector('.ed', timeout=5000); pg.wait_for_timeout(500)
    pg.click('.ed-bar .sv'); pg.wait_for_selector('.ed', state='detached'); pg.wait_for_timeout(800)
    pg.locator('.cs-card').first.click(); pg.wait_for_timeout(1500)
    pg.evaluate("window.__rt.app().state.engine.resume()")
    pg.evaluate("(() => { const k = document.querySelector('.sk-deck .key[data-key=play]'); k && k.dispatchEvent(new MouseEvent('click', { bubbles: true })); })()"); pg.wait_for_timeout(2500)
    tape = pg.evaluate("(() => { const p = window.__rt.app().state.mixtapes.play; return p ? { paused: p.paused, ended: p.ended } : null; })()")
    print('     tape state:', tape)
    if tape and not tape['ended']:
        check(near(settle_dom(pg, freqs[0], 6000), freqs[0]) and not tape['paused'], 'the tape is playing real audio')
        pg.evaluate("window.__rt.app().state.mixtapes.paused")
        pg.evaluate("window.__sleep.start(5)"); pg.wait_for_timeout(300); skew(pg, 301); pg.wait_for_timeout(2500)
        tape = pg.evaluate("(() => { const p = window.__rt.app().state.mixtapes.play; return p ? { paused: p.paused, ended: p.ended } : null; })()")
        check(bool(tape) and (tape['paused'] or tape['ended']) , f'a playing mixtape is paused by the sleep timer ({tape})')
        pg.wait_for_timeout(800); dd = pg.evaluate('window.__dom()'); check(dd < 50, f'tape: the music is gone after the stop (dominant {dd:.0f} Hz; the paused output of a tape is low-frequency only, as it is for a manual pause)')
    else:
        check(False, 'could not start a tape for the sleep check')
    check(not errs, f'no console / page errors {errs[:3]}')
    ctx.close()


def phase_notify(b, URL):
    print('\n=== 4. notification permission rationale ===', flush=True)
    ctx, pg, errs = open_app_pb(b, URL, ALB, secs=40)
    pg.evaluate(PLAY); pg.wait_for_timeout(3500)
    names = [c[0] for c in pb_calls(pg)]
    check('start' in names, f'the playback service starts on the first Play ({names})')
    card = pg.evaluate("(() => { const c = document.querySelector('.nr-card'); return c ? c.textContent : null; })()")
    check(card is not None and 'Show playback controls on your lock screen and in notifications?' in card and 'Allow' in card and 'Not now' in card, f'a one-line rationale with Allow / Not now is shown first ({card!r})')
    check('perm' not in names, 'the OS permission dialog has NOT been raised yet (no back-to-back dialogs)')
    sizes = pg.evaluate("[...document.querySelectorAll('.nr-btn')].map((b) => { const r = b.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })")
    check(all(w >= 44 and h >= 44 for w, h in sizes), f'both buttons are touch-sized ({sizes})')
    pg.screenshot(path='/tmp/claude-0/scratch/rationale.png')
    pg.click('.nr-allow'); pg.wait_for_timeout(900)
    check('perm' in [c[0] for c in pb_calls(pg)], 'Allow raises the OS dialog')
    check(pg.evaluate("document.querySelector('.nr-card') === null"), 'the card is gone')
    metas = len(pb_calls(pg, 'setMetadata')); check(metas >= 2, f'after a grant the notification picture is sent again ({metas} setMetadata)')
    reload(pg); pg.evaluate("window.__pb.perm = 'prompt'")       # the OS would say granted; pretend it still asks, to prove OUR once-only rule
    pg.evaluate("async () => { const m = await import('/src/device/index.js'); await m.deviceLibrary.scan({ force: true }); }"); pg.wait_for_timeout(1500)
    pg.evaluate('window.__rt.setZ(0)'); pg.wait_for_timeout(1500)
    pg.evaluate(PLAY); pg.wait_for_timeout(3000)
    check(pg.evaluate("document.querySelector('.nr-card') === null") and 'perm' not in [c[0] for c in pb_calls(pg)], 'shown only once: the next launch does not ask again')
    ctx.close()
    # Not now: no OS dialog, playback and the service are unaffected
    ctx, pg, errs = open_app_pb(b, URL, ALB, secs=40)
    pg.evaluate(PLAY); pg.wait_for_timeout(3500)
    pg.click('.nr-btn:not(.nr-allow)'); pg.wait_for_timeout(800)
    names = [c[0] for c in pb_calls(pg)]
    check('perm' not in names and 'start' in names, f'Not now: no OS dialog, the service still runs ({names})')
    check(near(settle_dom(pg, TONES[0], 5000), TONES[0]), 'Not now: the music is unaffected')
    pg.evaluate(PLAY); pg.wait_for_timeout(500); pg.evaluate(PLAY); pg.wait_for_timeout(2500)
    check(pg.evaluate("document.querySelector('.nr-card') === null"), 'Not now: never nags again in this session')
    ctx.close()
    # already granted at the OS: no rationale at all
    ctx = b.new_context(bypass_csp=True, viewport={'width': 412, 'height': 860})
    ctx.add_init_script("window.__preGranted = true;")
    ctx2, pg, errs = open_app_pb(b, URL, ALB, secs=40, ctx=ctx)
    pg.evaluate("window.__pb.perm = 'granted'"); pg.evaluate(PLAY); pg.wait_for_timeout(3500)
    check(pg.evaluate("document.querySelector('.nr-card') === null") and 'perm' not in [c[0] for c in pb_calls(pg)], 'permission already granted: no rationale, no dialog')
    check(not errs, f'no console / page errors {errs[:3]}')
    ctx.close()

PHASES = {'resume': phase_resume, 'shuffle': phase_shuffle, 'sleep': phase_sleep, 'notify': phase_notify}

def main():
    want = sys.argv[1:] or list(PHASES)
    srv, URL = serve()
    try:
        with sync_playwright() as p:
            b = p.chromium.launch(executable_path=CH, args=['--autoplay-policy=no-user-gesture-required', '--no-sandbox'])
            for k in want: PHASES[k](b, URL)
            b.close()
    finally:
        srv.kill()
    print('\nFAILED: %d' % len(check.fails) if check.fails else '\nall checks passed')
    for f in check.fails: print('  - ' + f)
    sys.exit(1 if check.fails else 0)
main()
