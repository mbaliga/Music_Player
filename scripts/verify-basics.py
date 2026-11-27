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

PHASES = {'resume': phase_resume}

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
