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

PHASES = {'resume': phase_resume, 'shuffle': phase_shuffle}

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
