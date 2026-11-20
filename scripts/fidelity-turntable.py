#!/usr/bin/env python3
"""Fidelity check: the owner's prototype page vs the port, side by side, at the handoff's sizes and in the handoff's states.

  ORIG=/path/to/artifact.html  python3 scripts/fidelity-turntable.py [outdir]     (dev server on :8321 or URL=http://host:port)

Left = the prototype (its own __rt hooks: pose / show / setZ), middle = the port (turntable-harness.html: the stage + library
alone, same hook names), right = |difference| x4. Both draw the SAME peaks (the prototype's makeDemo audio is lifted out of the artifact and
fed to the port) and the same scroll offset (performance.now is frozen), so what remains is real difference. Prints a mean absolute
difference and the share of pixels differing by more than 24/255 for the whole frame and for a 4x4 grid; writes the images.
Reference: /root/.claude/projects/.../tool-results/artifact-6b3a7907-1795168708-ccaf.html (the full file with the mat).
"""
import os, re, sys, json
import numpy as np
from PIL import Image
from playwright.sync_api import sync_playwright
ORIG = os.environ['ORIG']
OUT = sys.argv[1] if len(sys.argv) > 1 else '/tmp/fidelity'
URL = os.environ.get('URL', 'http://localhost:8321').rstrip('/')
CHROME = os.environ.get('CHROME', '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome')
os.makedirs(OUT, exist_ok=True)
html = open(ORIG).read()
m = re.search(r'function makeDemo\(sr,A\)\{.*?\n\}\n', html, re.S)
MAKE = '(function(){' + m.group(0) + 'return makeDemo;})()'
FREEZE = 'const __T = 5000; performance.now = () => __T;'
SIZES = [(1241, 561), (561, 1241), (582, 1162), (360, 780), (412, 915)]
# the prototype's demo album has 5 tracks at bars [0,4,12,16,19,22]/22: the display shows the track under the playhead
TRK = ['INTRO', 'GROOVE', 'LIFT', 'DRIVE', 'OUTRO']
def track_at(s):
    bars = [0, 4, 12, 16, 19, 22]
    return max(i for i in range(5) if s * 22 >= bars[i] - 1e-6)
PORT_DISPLAY = {'park': 0, 'play35': .35, 'play80': .8, 'arm-folding': .5, 'z25': .35, 'z50': .35, 'z75': .35, 'z100': .35}
STATES = [('park', 'pose(0,0,1)'), ('play35', 'show(0.35,true)'), ('play80', 'show(0.8,true)'), ('arm-folding', 'pose(0.5,0.5,1)'),
          ('z25', 'show(0.35,true);setZ(0.25)'), ('z50', 'show(0.35,true);setZ(0.5)'), ('z75', 'show(0.35,true);setZ(0.75)'), ('z100', 'show(0.35,true);setZ(1)')]
only = os.environ.get('STATES'); only = only.split(',') if only else None
rows = []
with sync_playwright() as p:
    b = p.chromium.launch(executable_path=CHROME, args=['--no-sandbox'])
    for (w, h) in SIZES:
        for name, js in STATES:
            if only and name not in only: continue
            imgs = []
            for which in ('orig', 'port'):
                ctx = b.new_context(viewport={'width': w, 'height': h}, device_scale_factor=1)
                ctx.add_init_script(FREEZE)
                ctx.add_init_script(f'window.__makeDemo = {MAKE};')
                pg = ctx.new_page(); errs = []
                pg.on('pageerror', lambda e: errs.append(str(e)))
                if which == 'orig': pg.goto('file://' + ORIG)
                else:
                    pg.goto(f'{URL}/turntable-harness.html'); pg.wait_for_function('window.__ready === true')
                pg.wait_for_timeout(700)
                if which == 'port':
                    ti = track_at(PORT_DISPLAY[name]); pg.evaluate(f'window.__stage.setDisplay({{name: "{TRK[ti]}", trackCount: 5, trackIndex: {ti}}}); window.__rt.setScroll(5000)')
                pg.evaluate('(js) => { const r = window.__rt; with (r) { eval(js); } }', js) if False else pg.evaluate('(js) => { const r = window.__rt; js.split(";").forEach(c => { const m = /^(\\w+)\\((.*)\\)$/.exec(c.trim()); if (m) r[m[1]].apply(r, m[2] ? m[2].split(",").map(v => v === "true" ? true : v === "false" ? false : Number(v)) : []); }); }', js)
                pg.wait_for_timeout(900)
                path = f'{OUT}/{which}-{w}x{h}-{name}.png'
                pg.screenshot(path=path); imgs.append(np.asarray(Image.open(path).convert('RGB')).astype(np.int16))
                if errs: print('   errors', which, errs[:2])
                ctx.close()
            d = np.abs(imgs[0] - imgs[1]).max(axis=2)
            mean = d.mean(); share = (d > 24).mean() * 100
            H, W = d.shape; g = [[d[i*H//4:(i+1)*H//4, j*W//4:(j+1)*W//4].mean() for j in range(4)] for i in range(4)]
            sbs = np.concatenate([imgs[0].astype(np.uint8), imgs[1].astype(np.uint8), np.clip(np.repeat(d[:, :, None], 3, axis=2) * 4, 0, 255).astype(np.uint8)], axis=1)
            Image.fromarray(sbs).save(f'{OUT}/sbs-{w}x{h}-{name}.png')
            rows.append({'size': f'{w}x{h}', 'state': name, 'mean_abs_diff': round(float(mean), 2), 'pct_px_over_24': round(float(share), 2), 'worst_cell': round(float(max(max(r) for r in g)), 1)})
            print(f'{w}x{h:<5} {name:<12} mean {mean:6.2f}   >24: {share:5.2f}%   worst 4x4 cell {max(max(r) for r in g):6.1f}', flush=True)
    b.close()
json.dump(rows, open(f'{OUT}/fidelity.json', 'w'), indent=1)
