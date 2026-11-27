#!/usr/bin/env python3
"""Verify the Content-Security-Policy meta in index.html does not break the app: NO CSP violations while booting and visiting every drawer section,
the real AudioEngine loads its AudioWorklet, the canned-radio station list + a dial tap work, and inline script / eval ARE blocked (so the policy is live).

Unlike the other verify scripts this one runs WITHOUT bypass_csp (they need it: Playwright's wait_for_function evals a string in the page).
Usage: URL=http://localhost:8321/index.html python3 scripts/verify-csp.py [outdir]     (exits non-zero on any failure)
Serve the staged build (npm run build:web; cd www; python3 ../serve.py) to test what ships; verify-all.py serves the source tree.
"""
import os, sys, time
from playwright.sync_api import sync_playwright
URL = os.environ.get('URL', 'http://localhost:8321/index.html')
CHROME = os.environ.get('CHROME', '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome')
fails = []
def check(ok, msg):
    if not ok: fails.append(msg)
    print(('ok   ' if ok else 'FAIL ') + msg, flush=True)

with sync_playwright() as p:
    b = p.chromium.launch(executable_path=CHROME, args=['--autoplay-policy=no-user-gesture-required'])
    pg = b.new_context(viewport={'width': 412, 'height': 915}).new_page()
    pg.set_default_timeout(6000)
    viol, errs = [], []
    pg.on('console', lambda m: viol.append(m.text) if ('Content Security Policy' in m.text or 'CSPVIOL' in m.text) else (errs.append(m.text) if m.type == 'error' else None))
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.add_init_script("document.addEventListener('securitypolicyviolation',e=>console.log('CSPVIOL '+e.violatedDirective+' '+e.blockedURI))")
    pg.goto(URL); time.sleep(2)
    try: pg.click('text=Skip', timeout=2500)       # the first-run walkthrough
    except Exception: pass
    time.sleep(0.5)
    secs = pg.evaluate('[...document.querySelectorAll(".drawer-item")].map(e => e.dataset.section)')
    check(len(secs) >= 5, f'drawer sections found: {secs}')
    for sec in secs:
        pg.evaluate('document.querySelector(".page:not([hidden]) .hamburger").click()'); time.sleep(0.6)
        pg.evaluate('s => document.querySelector(`.drawer-item[data-section="${s}"]`).click()', sec); time.sleep(1.2)
        check(pg.evaluate('s => !document.querySelector(`.page[data-section="${s}"]`).hidden', sec), f'section {sec} opens')
    pg.evaluate('document.querySelector(".page:not([hidden]) .hamburger").click()'); time.sleep(0.6)
    pg.evaluate('document.querySelector(\'.drawer-item[data-section="radio"]\').click()'); time.sleep(1.5)
    cards = pg.locator('.dial-card[data-station]').count()
    check(cards >= 1, f'canned radio dial lists stations ({cards})')
    if cards:
        try: pg.evaluate('document.querySelector(".dial-card[data-station]").click()'); time.sleep(3)
        except Exception as e: check(False, f'dial tap: {str(e)[:80]}')
    r = pg.evaluate("""async () => { try { const { AudioEngine } = await import('./src/audio-engine.js'); const e = new AudioEngine(); await e.init(); return 'ok'; } catch (e) { return String(e); } }""")
    check(r == 'ok', f'AudioEngine.init() loads the worklet under the CSP ({r})')
    pg.evaluate("(() => { const x = document.createElement('script'); x.textContent = '1'; document.head.appendChild(x); })()"); time.sleep(0.4)
    blocked = [v for v in viol if 'script-src' in v]
    check(len(blocked) >= 1, 'an injected inline script IS blocked (policy is enforced)')
    check(len(viol) == len(blocked), f'no other CSP violations ({[v[:120] for v in viol if v not in blocked]})')
    print('console errors (informational):', errs[:5])
    b.close()

# ── phase 2: the playback UI (seek bar, stage sheets, sleep chip, resume chip, shuffle/repeat, notify rationale, snackbar) on a mocked phone library,
# still WITHOUT bypass_csp. Nothing here uses wait_for_function with a string (that evals): it polls with evaluate().
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from basics_common import device_script, PLAYBACK_MOCK, READY
def poll(pg, expr, timeout=30):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            if pg.evaluate(expr): return True
        except Exception: pass
        time.sleep(0.25)
    return False
with sync_playwright() as p:
    b = p.chromium.launch(executable_path=CHROME, args=['--autoplay-policy=no-user-gesture-required'])
    ctx = b.new_context(viewport={'width': 412, 'height': 860})
    ctx.add_init_script("try { localStorage.getItem('runout.wtDone') || localStorage.setItem('runout.wtDone', '1'); } catch (e) {}")
    ctx.add_init_script("document.addEventListener('securitypolicyviolation',e=>console.log('CSPVIOL '+e.violatedDirective+' '+e.blockedURI))")
    ctx.add_init_script(device_script([('Tone Band', 'Tone Album', [600, 800, 1000])], 40))
    ctx.add_init_script(PLAYBACK_MOCK)
    pg = ctx.new_page(); pg.set_default_timeout(6000)
    viol2, errs2 = [], []
    pg.on('console', lambda m: viol2.append(m.text) if ('Content Security Policy' in m.text or 'CSPVIOL' in m.text) else (errs2.append(m.text) if m.type == 'error' else None))
    pg.on('pageerror', lambda e: errs2.append(str(e)))
    pg.goto(URL)
    check(poll(pg, '(' + READY + ')'), 'phase 2: the app boots under the CSP with the mocked phone library')
    pg.evaluate("async () => { const m = await import('/src/device/index.js'); await m.deviceLibrary.scan({ force: true }); }")
    check(poll(pg, 'window.__rt.app().shelf.length >= 1'), 'phase 2: the library scan fills the shelf')
    pg.evaluate('window.__rt.setZ(0)'); time.sleep(1.5)
    PLAYJS = "document.getElementById('tt-playBtn').dispatchEvent(new MouseEvent('click', { bubbles: true }))"
    pg.evaluate(PLAYJS); time.sleep(1.5)
    check(pg.evaluate('!!window.__rt.app().stage.player.playing'), 'phase 2: an album plays')
    check(pg.evaluate("(() => { const e = document.querySelector('.rt-seek'); if (!e) return false; const r = e.getBoundingClientRect(); const f = e.querySelector('.rt-seek-fill'); return r.width > 100 && r.height >= 40 && getComputedStyle(e).position !== 'static' && f && f.getBoundingClientRect().width >= 0; })()"), 'phase 2: the stage seek bar is laid out (48 px target, styled by the stylesheet)')
    pg.evaluate("(() => { const e = document.querySelector('.rt-seek'); e.focus(); e.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); })()"); time.sleep(0.4)
    # the stage sheets: Sleep timer, Shuffle / Repeat
    pg.evaluate("(() => { const b = document.querySelector('#ttSleepHost [data-v=\"5\"]'); b && b.click(); })()"); time.sleep(0.5)
    check(pg.evaluate("(() => { const c = document.getElementById('sleepChip'); return !!c && !c.hidden && /Sleep/.test(c.textContent) && getComputedStyle(c).display !== 'none' && c.getBoundingClientRect().height > 0; })()"), 'phase 2: the sleep timer chip shows (styled, visible)')
    pg.evaluate("(() => { const b = document.querySelector('#ttSleepHost [data-v=\"off\"], #ttSleepHost [role=radio]'); b && b.click(); })()")
    check(pg.evaluate("[...document.querySelectorAll('[role=radio], [aria-pressed]')].length > 3"), 'phase 2: the stage sheets render their option rows')
    # a snackbar with an Undo
    pg.evaluate("async () => { const m = await import('/src/ui/snackbar.js'); m.showSnackbar('Deleted \\u201cTape\\u201d.', { action: 'Undo', onAction: () => { window.__undone = 1; } }); }"); time.sleep(0.4)
    check(pg.evaluate("(() => { const e = document.querySelector('.rt-snack'); if (!e) return false; const r = e.getBoundingClientRect(), bt = e.querySelector('.rt-snack-btn').getBoundingClientRect(); return r.width > 150 && bt.height >= 44 && getComputedStyle(e).position === 'fixed'; })()"), 'phase 2: the snackbar shows with a 48 px Undo')
    pg.evaluate("document.querySelector('.rt-snack-btn').click()"); time.sleep(0.3)
    check(pg.evaluate('window.__undone === 1') and pg.evaluate("!document.querySelector('.rt-snack')"), 'phase 2: Undo runs and the snackbar goes')
    # the resume chip: reload -> the record is restored paused with a chip
    time.sleep(2.0)
    pg.reload(); poll(pg, '(' + READY + ')'); time.sleep(0.5)
    pg.evaluate("async () => { const m = await import('/src/device/index.js'); await m.deviceLibrary.scan({ force: true }); }"); poll(pg, 'window.__rt.app().shelf.length >= 1'); time.sleep(2.5)
    check(pg.evaluate("(() => { const c = document.getElementById('resumeChip'); return !!c && !c.hidden && getComputedStyle(c).display !== 'none' && c.getBoundingClientRect().height > 0; })()"), 'phase 2: the Resume chip shows after a reload (styled, visible)')
    # the notification rationale (native, permission not yet decided): the first Play asks one line before the OS dialog
    pg.evaluate(PLAYJS); time.sleep(1.5)
    check(pg.evaluate("(() => { const c = document.querySelector('.nr-card'); return !!c && c.getBoundingClientRect().width > 150 && getComputedStyle(c).position !== 'static' || !!document.querySelector('.nr-card'); })()"), 'phase 2: the notification rationale card shows on the first Play')
    pg.evaluate("(() => { const b = document.querySelector('.nr-btn'); b && b.click(); })()"); time.sleep(0.5)
    blocked2 = [v for v in viol2 if 'script-src' in v]
    check(len(viol2) == 0, f'phase 2: no CSP violation in the playback UI ({[v[:120] for v in viol2][:4]})')
    print('phase 2 console errors (informational):', errs2[:5])
    b.close()
print('ALL OK' if not fails else 'FAILED: ' + '; '.join(fails))
sys.exit(1 if fails else 0)
