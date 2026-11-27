#!/usr/bin/env python3
"""Run every Playwright verify script in sequence against ONE dev server on a free port; print a pass/fail table; exit non-zero on any failure.

Builds nothing. Needs ffmpeg, numpy, Playwright for Python.   CHROME=/path/to/chrome (default /opt/pw-browsers/chromium-1243/chrome-linux64/chrome)
Usage: python3 scripts/verify-all.py [outdir] [only-substring ...]       e.g.  python3 scripts/verify-all.py /tmp/va shell mixtapes
Each script gets URL=http://localhost:<port>/index.html and its own output dir <outdir>/<name>; per-script log in <outdir>/<name>.log.
A script that exits 0 is PASS (every one of them exits non-zero when an assertion fails); a timeout counts as FAIL.
"""
import os, socket, subprocess, sys, time
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPTS = [  # (name, file, timeout seconds)
    ('shell', 'verify-shell.py', 600), ('turntable', 'verify-turntable.py', 600), ('turntable-library', 'verify-turntable-library.py', 600),
    ('fx', 'verify-fx.py', 900), ('mixtapes', 'verify-mixtapes.py', 900), ('search-settings', 'verify-search-settings.py', 600),
    ('devicemode', 'verify-devicemode.py', 900), ('device-library', 'verify-device-library.py', 600), ('radio-layout', 'verify-radio-layout.py', 300), ('csp', 'verify-csp.py', 120),
    ('you-radio', 'verify-you-radio.py', 600), ('canned-radio', 'verify-canned-radio.py', 600), ('tour', 'verify-tour.py', 1200), ('real-playback', 'verify-real-playback.py', 900),
    ('basics', 'verify-basics.py', 1500), ('station-handoff', 'verify-station-handoff.py', 900), ('hardening-review', 'verify-hardening-review.py', 900), ('playback-review', 'verify-playback-review.py', 900), ('seams', 'verify-seams.py', 900),
]
NO_OUTDIR = {'seams', 'basics', 'station-handoff', 'hardening-review', 'playback-review'}   # their argv selects phases / scenarios, so they must not be handed an output directory
args = sys.argv[1:]
OUT = next((a for a in args if "/" in a), "/tmp/verify-all")
only = [a for a in args if a != OUT]
os.makedirs(OUT, exist_ok=True)
s = socket.socket(); s.bind(('127.0.0.1', 0)); PORT = s.getsockname()[1]; s.close()
srv = subprocess.Popen([sys.executable, os.path.join(ROOT, 'serve.py'), str(PORT)], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
env = dict(os.environ, URL=f'http://localhost:{PORT}/index.html', PORT=str(PORT), CHROME=os.environ.get('CHROME', '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome'))
time.sleep(1.0)
rows = []
try:
    for name, f, tmo in SCRIPTS:
        if only and not any(o in name for o in only): continue
        path = os.path.join(ROOT, 'scripts', f)
        if not os.path.exists(path): rows.append((name, 'SKIP', 0, 'missing')); continue
        od = os.path.join(OUT, name); os.makedirs(od, exist_ok=True)
        t0 = time.time(); log = os.path.join(OUT, name + '.log')
        try:
            with open(log, 'w') as lf: r = subprocess.run([sys.executable, path] + ([] if name in NO_OUTDIR else [od]), cwd=ROOT, env=env, stdout=lf, stderr=subprocess.STDOUT, timeout=tmo)
            code = r.returncode
        except subprocess.TimeoutExpired: code = 'timeout'
        txt = open(log, errors='replace').read()
        fails = [l for l in txt.splitlines() if l.startswith('FAIL ') or l.startswith('FAIL:')]
        oks = sum(1 for l in txt.splitlines() if l.startswith('ok ') or l.startswith('PASS '))
        rows.append((name, 'PASS' if code == 0 else 'FAIL', time.time() - t0, f'{oks} ok, {len(fails)} FAIL lines, exit {code}' + (('  first: ' + fails[0][:90]) if fails else '')))
        print(f'{rows[-1][0]:18s} {rows[-1][1]}  {rows[-1][2]:6.1f}s  {rows[-1][3]}', flush=True)
finally:
    srv.terminate()
print('\n' + '=' * 78); print(f'{"script":18s} {"result":6s} {"time":>7s}  detail')
for n, r, t, d in rows: print(f'{n:18s} {r:6s} {t:6.1f}s  {d}')
bad = [r for r in rows if r[1] == 'FAIL']
print(f'\n{len(rows) - len(bad)}/{len(rows)} passed' + (' ; FAILED: ' + ', '.join(r[0] for r in bad) if bad else ''))
sys.exit(1 if bad else 0)
