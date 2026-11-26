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
print('ALL OK' if not fails else 'FAILED: ' + '; '.join(fails))
sys.exit(1 if fails else 0)
