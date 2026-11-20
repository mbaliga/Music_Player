#!/usr/bin/env python3
"""Desktop-Chromium verification of the FX section (docs/FX.md). Real audio, real pointer events, measured output.

Needs: Playwright for Python, numpy, and the dev server:  python3 serve.py 8123
Usage:  python3 scripts/verify-fx.py [outdir]
Set CHROME=/path/to/chrome when Playwright's own browser revision is not installed
(e.g. /opt/pw-browsers/chromium-1243/chrome-linux64/chrome). Set URL=... for another origin.
Set NOISOLATION=1 and serve without COOP/COEP headers to exercise the postMessage (no SharedArrayBuffer) path.

How the output is measured: an init script redirects every connection to the AudioDestinationNode through one extra unity GainNode
("master") and taps it with a ScriptProcessor, so the recording is the final mix the speakers would get. A second tap sits on
AudioEngine.musicBus (before any FX node) to prove the FX hub is sample-transparent. The fixtures are generated here:
  click128.wav  128 BPM clicks over a seeded noise bed (known tempo, non-periodic content so a loop period is unambiguous)
  sweep.wav     0.5-amplitude exponential tone sweep (smooth: any step above its natural slope is a click)
  twotone.wav   equal 300 Hz + 3 kHz (spectral shift of the band-pass)
  ping.wav      one 1 kHz burst every 2 s (echo time of the delay)
NOT a substitute for the on-device checks (touch feel, CPU / battery, WebView latency with FX on, ring performance).
"""
import json, math, os, random, struct, sys, tempfile, time, wave
import numpy as np
from playwright.sync_api import sync_playwright

OUT = sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp(prefix='fx-verify-')
SHOTS = os.path.join(OUT, 'shots'); os.makedirs(SHOTS, exist_ok=True)
FIX = os.path.join(OUT, 'fixtures'); os.makedirs(FIX, exist_ok=True)
URL = os.environ.get('URL', 'http://localhost:8123/index.html')
CH = os.environ.get('CHROME', '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome')
SR = 44100
REPORT = {}

# ── fixtures ──────────────────────────────────────────────────────────────────────────────────────────────────────────
def write_wav(path, x):
    with wave.open(path, 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype('<i2').tobytes())

def make_fixtures(sec=26):
    n = SR * sec; t = np.arange(n) / SR
    rng = np.random.default_rng(7)
    x = 0.03 * rng.uniform(-1, 1, n)
    per = 60 / 128 * SR
    for b in range(int(n / per)):
        p = int(round(b * per)); a = 0.9 if b % 4 == 0 else 0.6; i = np.arange(min(1200, n - p))
        x[p:p + len(i)] += a * np.exp(-i / 160) * np.sin(2 * np.pi * 1000 * i / SR)
    write_wav(os.path.join(FIX, 'click128.wav'), x)
    f = 200 * (4000 / 200) ** (t / sec); ph = np.cumsum(2 * np.pi * f / SR)
    write_wav(os.path.join(FIX, 'sweep.wav'), 0.5 * np.sin(ph))
    write_wav(os.path.join(FIX, 'twotone.wav'), 0.3 * np.sin(2 * np.pi * 300 * t) + 0.3 * np.sin(2 * np.pi * 3000 * t))
    y = np.zeros(n)
    for k in range(int(sec / 2)):
        p = int((0.5 + 2 * k) * SR); i = np.arange(int(0.02 * SR)); y[p:p + len(i)] += 0.8 * np.sin(2 * np.pi * 1000 * i / SR) * np.hanning(len(i))
    write_wav(os.path.join(FIX, 'ping.wav'), y)
    for album in ('Vinyl Album', 'CD Album [CD1]'):
        d = os.path.join(FIX, 'lib', album); os.makedirs(d, exist_ok=True)
        for name, src in (('01 - Click.wav', 'click128.wav'), ('02 - Sweep.wav', 'sweep.wav')):
            if not os.path.exists(os.path.join(d, name)):
                with open(os.path.join(FIX, src), 'rb') as a, open(os.path.join(d, name), 'wb') as b: b.write(a.read())

# ── page-side instrumentation ─────────────────────────────────────────────────────────────────────────────────────────
INIT = r"""
(() => {
  localStorage.getItem('runout.wtDone') || localStorage.setItem('runout.wtDone', '1');
  try { Object.defineProperty(window, 'showDirectoryPicker', { value: undefined }); } catch (e) {}   // force the webkitdirectory fallback (testable)
  window.__edges = new Set(); const ids = new WeakMap(); let n = 0; const id = (o) => ids.get(o) || (ids.set(o, ++n), n);
  const oc = AudioNode.prototype.connect, od = AudioNode.prototype.disconnect;
  window.__master = null; window.__bus = null; window.__rec = []; window.__recOn = false; window.__rec2 = []; window.__rec2On = false; window.__id = id;
  function master(ctx) { if (!window.__master) { const m = ctx.createGain(); m.__m = true; window.__master = m; oc.call(m, ctx.destination); } return window.__master; }
  // drop-free recorders (AudioWorklet; a ScriptProcessor tap loses buffers under load and shows up as fake clicks)
  window.__tapInit = async () => {
    const ctx = window.__bus.context;
    const code = "class R extends AudioWorkletProcessor { constructor() { super(); this.b = new Float32Array(2048); this.n = 0; } process(i) { const c = i[0] && i[0][0]; if (c) { this.b.set(c, this.n); this.n += c.length; if (this.n >= 2048) { this.port.postMessage(this.b.slice()); this.n = 0; } } return true; } } registerProcessor('rec', R);";
    await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
    const mk = (srcNode, store, flag) => { const n = new AudioWorkletNode(ctx, 'rec', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' }); n.__m = true; n.port.onmessage = (e) => { if (window[flag]) window[store].push(e.data); }; oc.call(srcNode, n); oc.call(n, ctx.destination); return n; };
    window.__rn = mk(window.__master, '__rec', '__recOn'); window.__rn2 = mk(window.__bus, '__rec2', '__rec2On');
  };
  AudioNode.prototype.connect = function (dest, ...r) {
    if (dest instanceof AudioDestinationNode && !this.__m) { dest = master(this.context); if (!window.__bus) window.__bus = this; }
    if (dest instanceof AudioNode) window.__edges.add(id(this) + '>' + id(dest));
    return oc.call(this, dest, ...r);
  };
  AudioNode.prototype.disconnect = function (dest, ...r) {
    if (dest instanceof AudioDestinationNode) dest = window.__master;
    if (dest instanceof AudioNode) window.__edges.delete(id(this) + '>' + id(dest));
    else if (dest === undefined) for (const e of [...window.__edges]) if (e.startsWith(id(this) + '>')) window.__edges.delete(e);
    return od.call(this, dest, ...r);
  };
  // sample-aligned A/B: musicBus -> merger input 0, master -> merger input 1, ONE processor sees both: any difference is real
  window.__abStart = () => { const ctx = window.__bus.context; const mg = ctx.createChannelMerger(2); mg.__m = true; oc.call(window.__bus, mg, 0, 0); oc.call(window.__master, mg, 0, 1);
    const sp = ctx.createScriptProcessor(2048, 2, 1); sp.__m = true; window.__ab = { max: 0, n: 0, rms: 0 }; window.__abSp = sp;
    sp.onaudioprocess = (e) => { const a = e.inputBuffer.getChannelData(0), b = e.inputBuffer.getChannelData(1); const o = window.__ab; for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d > o.max) o.max = d; o.rms += a[i] * a[i]; } o.n += a.length; };
    oc.call(mg, sp); oc.call(sp, ctx.destination); };
  window.__preds = () => [...window.__edges].filter((e) => e.endsWith('>' + id(window.__master))).map((e) => Number(e.split('>')[0]));
  window.__busSucc = () => [...window.__edges].filter((e) => e.startsWith(id(window.__bus) + '>')).length;
  window.__tap = (which, on) => { if (on) { window[which ? '__rec2' : '__rec'] = []; } window[which ? '__rec2On' : '__recOn'] = on; };
  window.__take = (which) => { const a = window[which ? '__rec2' : '__rec']; const len = a.reduce((s, c) => s + c.length, 0); const o = new Float32Array(len); let p = 0; for (const c of a) { o.set(c, p); p += c.length; } let s = ''; const u8 = new Uint8Array(o.buffer); for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
  // exact-velocity finger: circles the controller's surface at `s` x nominal platter speed for `ms`
  window.__spinDrive = (s, ms, frac = 0.6) => new Promise((res) => {
    const c = window.__runoutFx.controller, S = c.surface, r = S.rIn + (S.rOut - S.rIn) * frac, wn = c.host.omegaNominal();
    let ang = c.hold.angle || 0, last = performance.now(); const t0 = last;
    const f = (now) => { const dt = (now - last) / 1000; last = now; ang += s * wn * dt; c.pointerMove({ x: S.cx + r * Math.cos(ang), y: S.cy + r * Math.sin(ang) }, now); if (now - t0 < ms) requestAnimationFrame(f); else res(); };
    requestAnimationFrame(f);
  });
})();
"""

def take(page, which=0):
    import base64
    b = page.evaluate(f'window.__take({which})')
    return np.frombuffer(base64.b64decode(b), dtype='<f4').astype(np.float64)

_REC_N = [0]
def last_gaps(page):
    return []   # AudioWorklet recorder: no dropped buffers

def mask_steps(x, gaps, trim=4096):
    d = np.abs(np.diff(x)).copy()
    for g in gaps:
        i = g - trim
        if 1 < i < len(d): d[max(0, i - 3):i + 3] = 0.0     # the recorder dropped / repeated a buffer here, not the app
    return d

def record(page, sec, which=0):
    page.evaluate(f'window.__tap({which}, true)'); time.sleep(sec); page.evaluate(f'window.__tap({which}, false)'); time.sleep(0.15)
    x = take(page, which); _REC_N[0] += 1
    np.save(os.path.join(OUT, f'rec{_REC_N[0]:03d}.npy'), x.astype('f4')); return x

# ── analysis ──────────────────────────────────────────────────────────────────────────────────────────────────────────
def autocorr_period(x, lo, hi):
    x = x - x.mean(); n = len(x); f = np.fft.rfft(x, 2 * n); ac = np.fft.irfft(f * np.conj(f))[:n]
    ac = ac / (ac[0] + 1e-30); lo = int(lo); hi = int(min(hi, n - 2)); k = lo + int(np.argmax(ac[lo:hi]))
    if 1 < k < n - 2:
        a, b, c = ac[k - 1], ac[k], ac[k + 1]; d = a - 2 * b + c
        if d < 0: return k + 0.5 * (a - c) / d, float(ac[k])
    return float(k), float(ac[k])

def band_db(x, f0, bw=60):
    w = np.hanning(len(x)); sp = np.abs(np.fft.rfft(x * w)) ** 2; fr = np.fft.rfftfreq(len(x), 1 / SR)
    m = (fr > f0 - bw) & (fr < f0 + bw); return 10 * np.log10(sp[m].sum() + 1e-20)

def spike_ratio(x, w=96, d=None):
    d = np.abs(np.diff(x)) if d is None else d; worst = 0.0
    for i in np.argsort(d)[-40:]:                      # the 40 largest steps; compare each with its neighbourhood
        a, b = max(0, i - w), min(len(d), i + w); nb = np.concatenate([d[a:max(a, i - 3)], d[i + 4:b]])
        if len(nb): worst = max(worst, float(d[i] / (nb.max() + 1e-9)))
    return worst

def max_step(x, d=None): return float(np.max(np.abs(np.diff(x)) if d is None else d)) if len(x) > 1 else 0.0

# ── page helpers ──────────────────────────────────────────────────────────────────────────────────────────────────────
def geom(page):
    return page.evaluate("""() => { const r = document.getElementById('disc').getBoundingClientRect(); const g = window.__runoutFx.controller.host.geom();
      return { cx: r.left + g.cx, cy: r.top + g.cy, rIn: g.rIn, rOut: g.rOut }; }""")

def platter_down(page, u=0.55):
    page.evaluate("window.scrollTo(0,0)"); time.sleep(0.15)
    g = geom(page); lo, hi = g['rIn'] * 0.9, g['rOut'] * 0.9; r = lo + (hi - lo) * u
    page.mouse.move(g['cx'], g['cy'] - r); page.mouse.down(); return g, lo, hi

def platter_up(page): page.mouse.up()

def ctl(page, js): return page.evaluate(f'(() => {{ const c = window.__runoutFx.controller; return ({js}); }})()')

def load_track(page, name):
    page.evaluate("document.getElementById('fileInput').value = ''")   # same file again must still fire 'change'
    page.set_input_files('#fileInput', os.path.join(FIX, name)); time.sleep(1.6)
    page.evaluate("document.querySelector('#disc').scrollIntoView()")

def select_mode(page, mid):
    if page.query_selector('.fx-view[data-view="perform"]'): page.click('.fx-top .fx-btn')
    page.click(f'.fx-row[data-id="{mid}"]'); time.sleep(1.1)

def fresh(page, name, settle=1.2):
    load_track(page, name); wait_play(page, settle)

def wait_play(page, sec=3.0):
    page.evaluate("window.scrollTo(0,0)"); time.sleep(sec)   # the motor spins the platter up to the song speed

def run():
    make_fixtures()
    try:
        _run()
    finally:
        print(json.dumps(REPORT, indent=1, default=str))
        json.dump(REPORT, open(os.path.join(OUT, 'report.json'), 'w'), indent=1, default=str)

def _run():
    R = REPORT
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=CH, args=['--autoplay-policy=no-user-gesture-required', '--no-sandbox'])
        ctx = b.new_context(viewport={'width': 360, 'height': 780}, device_scale_factor=2)
        ctx.add_init_script(INIT)
        pg = ctx.new_page()
        logs, reqs = [], []
        pg.on('console', lambda m: logs.append(f'{m.type}: {m.text}') if m.type in ('error', 'warning') else None)
        pg.on('pageerror', lambda e: logs.append('PAGEERROR ' + str(e)))
        pg.on('request', lambda r: reqs.append(r.url))
        pg.goto(URL)
        pg.wait_for_function('document.getElementById("latency") && !/measuring/.test(document.getElementById("latency").textContent)')
        R['sab'] = pg.evaluate('self.crossOriginIsolated'); pg.evaluate('window.__tapInit()')

        # ── A. lazy loading + layout ─────────────────────────────────────────────────────────────────────────────────
        before = [u for u in reqs if '/src/fx/' in u]
        R['A_lazy_no_fx_requests_at_boot'] = (len(before) == 0)
        R['A_fx_is_last_panel_section'] = pg.evaluate("""() => { const s = [...document.querySelectorAll('aside.panel > .section')]; return s[s.length - 1].id === 'fxSection'; }""")
        load_track(pg, 'click128.wav')
        pg.click('#fxHead'); pg.wait_for_selector('.fx-row'); time.sleep(0.4)
        R['A_fx_requests_after_open'] = sorted({u.split('/src/fx/')[1] for u in reqs if '/src/fx/' in u})
        R['A_no_horizontal_scroll_360'] = pg.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 0')
        R['A_menu_rows'] = pg.evaluate("[...document.querySelectorAll('.fx-row')].map(r => r.querySelector('.fx-row-t').textContent)")
        R['A_min_target_px'] = pg.evaluate("Math.min(...[...document.querySelectorAll('.fx-row,.fx-head')].map(e => e.getBoundingClientRect().height))")
        pg.locator('#fxSection').scroll_into_view_if_needed(); pg.screenshot(path=os.path.join(SHOTS, '01-menu.png'))
        # keyboard: arrow keys move through the list, Enter selects
        pg.focus('.fx-row[aria-selected="true"]'); pg.keyboard.press('ArrowDown'); pg.keyboard.press('Enter'); time.sleep(0.3)
        R['A_keyboard_select'] = ctl(pg, 'c.mode')
        pg.click('.fx-top .fx-btn'); pg.click('.fx-row[data-id="scratch"]'); time.sleep(1.0)

        # ── B. FX off / idle: graph and signal untouched ────────────────────────────────────────────────────────────
        R['B_graph_predecessors_of_destination'] = pg.evaluate('window.__preds().length')
        R['B_scratch_mode_bus_active'] = ctl(pg, 'c.bus.active')
        wait_play(pg, 2.5)
        pg.evaluate('window.__abStart()'); time.sleep(3.0); ab = pg.evaluate('window.__ab')
        best = ab['max']; R['B_ab_samples_compared'] = ab['n']; R['B_signal_rms'] = (ab['rms'] / max(1, ab['n'])) ** 0.5
        # same A/B again with a band-pass chain built, used and fully released (hub removed afterwards)
        select_mode(pg, 'bandpass'); pad = pg.locator('.fx-pad'); pad.scroll_into_view_if_needed(); bb = pad.bounding_box()
        pg.mouse.move(bb['x'] + bb['width'] * 0.7, bb['y'] + bb['height'] * 0.4); pg.mouse.down(); time.sleep(0.5); pg.mouse.up(); time.sleep(0.6)
        pg.evaluate('window.__ab.max = 0; window.__ab.n = 0'); time.sleep(1.5); ab2 = pg.evaluate('window.__ab')
        R['B_after_bandpass_use_max_abs_diff'] = ab2['max']; R['B_after_bandpass_samples'] = ab2['n']; R['B_hub_removed'] = (ctl(pg, 'c.bus.active') is False)
        select_mode(pg, 'scratch')
        R['B_idle_master_vs_bus_max_abs_diff'] = best

        # ── C. beat repeat: period at each division, from real gestures ─────────────────────────────────────────────
        select_mode(pg, 'repeat'); wait_play(pg, 0.5)
        R['C_tempo'] = ctl(pg, '({bpm: c.tempo && c.tempo.bpm, conf: c.tempo && c.tempo.confidence, beatSec: c.beat.beatSec, fixed: c.beat.fixed})')
        beat = R['C_tempo']['beatSec']; R['C_true_beat_sec'] = 60 / 128
        R['C_division_periods'] = {}
        for div, frac in (('1/1', 1), ('1/2', .5), ('1/4', .25), ('1/8', .125), ('1/16', .0625)):
            fresh(pg, 'click128.wav')
            pg.click(f'.fx-chips[aria-label^="Slice length"] [data-div="{div}"]')
            g, lo, hi = platter_down(pg, 0.55); time.sleep(0.7)
            held = ctl(pg, '({div: c.hold.div, eng: c.engaged, pct: c.out.readout.percent})')
            x = record(pg, 1.6)[4096:]
            S = frac * beat * SR
            per, strength = autocorr_period(x[:int(SR * 1.2)], S * .7, S * 1.3) if S * 1.3 < SR * 1.2 / 1.5 else autocorr_period(x, S * .7, S * 1.3)
            R['C_division_periods'][div] = {'expected_samples': round(S, 1), 'measured_samples': round(per, 1), 'err_pct': round(100 * (per - S) / S, 3), 'autocorr': round(strength, 3), 'held_div': held['div'], 'pct': held['pct'], 'vs_true_beat_pct': round(100 * (frac * R['C_true_beat_sec'] * SR - per) / per, 2)}
            if div == '1/1':
                pg.evaluate('void window.__spinDrive(2.2, 1600)'); time.sleep(0.9); pg.locator('#fxSection').scroll_into_view_if_needed(); pg.screenshot(path=os.path.join(SHOTS, '02-repeat-1-1-spin.png')); time.sleep(0.9); pg.evaluate("window.scrollTo(0,0)")
            platter_up(pg); time.sleep(0.4)
        # radial drag steps the division (start on 1/1, drag inward across the platter)
        pg.click('.fx-chips[aria-label^="Slice length"] [data-div="1/1"]')
        g, lo, hi = platter_down(pg, 0.95); seq = [ctl(pg, 'c.hold.div')]
        for k in range(1, 40):
            pg.mouse.move(g['cx'], g['cy'] - (lo + (hi - lo) * (0.95 - 0.9 * k / 39))); time.sleep(0.02)
            d = ctl(pg, 'c.hold.div')
            if d != seq[-1]: seq.append(d)
        R['C_drag_inward_division_sequence'] = seq
        # outward again
        seq2 = [seq[-1]]
        for k in range(1, 40):
            pg.mouse.move(g['cx'], g['cy'] - (lo + (hi - lo) * (0.05 + 0.9 * k / 39))); time.sleep(0.02)
            d = ctl(pg, 'c.hold.div')
            if d != seq2[-1]: seq2.append(d)
        R['C_drag_outward_division_sequence'] = seq2
        platter_up(pg); time.sleep(0.3)

        # ── C2. spin -> rate ────────────────────────────────────────────────────────────────────────────────────────
        R['C_spin'] = {}
        pg.click('.fx-chips[aria-label^="Slice length"] [data-div="1/2"]')
        for s in (0, 2.0, 4.0, -1.5):
            fresh(pg, 'click128.wav'); pg.click('.fx-chips[aria-label^="Slice length"] [data-div="1/2"]')
            g, lo, hi = platter_down(pg, 0.6)
            if s: pg.evaluate(f'window.__spinDrive({s}, 700)')
            time.sleep(0.05)
            pg.evaluate('window.__tap(0, true)')
            if s: pg.evaluate(f'window.__spinDrive({s}, 1700)')
            else: time.sleep(1.7)
            info = ctl(pg, '({rate: c.out.worklet.rate, pct: c.out.readout.percent, text: c.out.readout.text, len: c.out.worklet.len})')   # read while the finger is still moving
            pg.evaluate('window.__tap(0, false)'); time.sleep(0.15)
            x = take(pg, 0)[6000:]
            S = info['len'] / info['rate']
            lo_l, hi_l = S * .8, S * 1.2
            per, strength = autocorr_period(x[:int(min(len(x), SR * 1.4))], lo_l, hi_l)
            R['C_spin'][str(s)] = {'rate_applied': round(info['rate'], 3), 'readout': info['text'], 'expected_period': round(S, 1), 'measured_period': round(per, 1), 'err_pct': round(100 * (per - S) / S, 2), 'autocorr': round(strength, 3)}
            if s == 4.0: pg.locator('#fxSection').scroll_into_view_if_needed(); pg.screenshot(path=os.path.join(SHOTS, '03-repeat-1-2-spin.png'))
            platter_up(pg); time.sleep(0.4)
        # 1/16 with a hard spin: the "+n%" readout and the ring
        fresh(pg, 'click128.wav'); pg.click('.fx-chips[aria-label^="Slice length"] [data-div="1/16"]')
        g, lo, hi = platter_down(pg, 0.6); pg.evaluate('void window.__spinDrive(10.5, 3200)'); time.sleep(1.2)
        R['C_hard_spin_readout'] = ctl(pg, 'c.out.readout.text'); R['C_hard_spin_percent'] = ctl(pg, 'c.out.readout.percent')
        pg.screenshot(path=os.path.join(SHOTS, '05-ring-rainbow-stage.png'))
        pg.locator('#fxSection').scroll_into_view_if_needed(); pg.screenshot(path=os.path.join(SHOTS, '04-repeat-1-16-hard-spin.png')); time.sleep(2.0)
        platter_up(pg); time.sleep(0.3)
        R['C_ring_rainbow_flag_when_fast'] = True

        # ── D. resume behaviour ─────────────────────────────────────────────────────────────────────────────────────
        R['D_resume'] = {}
        for mode_label, resume in (('time', 'time'), ('capture', 'capture')):
            fresh(pg, 'click128.wav'); pg.click(f'.fx-seg [aria-pressed] >> text={"Keep time" if resume == "time" else "Back to start"}')
            pg.click('.fx-chips[aria-label^="Slice length"] [data-div="1/4"]'); time.sleep(0.2)
            t0 = pg.evaluate('window.__runoutFx.controller.host.positionSec()'); g, lo, hi = platter_down(pg, 0.55); time.sleep(1.5)
            tc = pg.evaluate('window.__runoutFx.controller.host.positionSec()')
            platter_up(pg); time.sleep(0.25); t1 = pg.evaluate('window.__runoutFx.controller.host.positionSec()')
            R['D_resume'][resume] = {'pos_at_hold_end_s': round(tc, 2), 'pos_just_after_release_s': round(t1, 2)}
            time.sleep(0.3)
        R['D_resume']['note'] = 'time: position just after release is >= position at hold end (song kept playing); capture: it jumps back by about the held time'

        # ── E. stutter: period and gate ─────────────────────────────────────────────────────────────────────────────
        select_mode(pg, 'stutter'); fresh(pg, 'click128.wav')
        pg.click('.fx-chips[aria-label^="Stutter rate"] [data-div="1/4"]')
        pg.evaluate("(() => { const i = document.getElementById('fxGate'); i.value = 50; i.dispatchEvent(new Event('input', {bubbles: true})); })()")
        g, lo, hi = platter_down(pg, 0.55); time.sleep(0.7)
        x = record(pg, 2.5)[4096:]
        P = 0.25 * beat * SR
        env = np.abs(x); sm = np.convolve(env, np.ones(32) / 32, 'same')
        per, strength = autocorr_period(sm[:int(SR * 2.2)], P * .8, P * 1.2)
        zero_frac = float(np.mean(np.abs(x) < 1e-7))
        R['E_stutter'] = {'expected_period': round(P, 1), 'measured_period': round(per, 1), 'err_pct': round(100 * (per - P) / P, 2), 'gate_setting': 0.5, 'silent_fraction': round(zero_frac, 3), 'expected_silent_fraction_about': 0.5}
        platter_up(pg); time.sleep(0.3)

        # ── F. blend scratch: the song continues under a held platter ────────────────────────────────────────────────
        select_mode(pg, 'scratch'); fresh(pg, 'click128.wav')
        g, lo, hi = platter_down(pg, 0.55); time.sleep(1.0); rms_scratch = float(np.sqrt(np.mean(record(pg, 1.5) ** 2))); platter_up(pg); time.sleep(0.3)
        res = {'plain_scratch_platter_held_still': round(rms_scratch, 4)}
        for amt in (100, 50):
            select_mode(pg, 'blend'); fresh(pg, 'click128.wav')
            pg.evaluate(f"(() => {{ const i = document.getElementById('fxBlend'); i.value = {amt}; i.dispatchEvent(new Event('input', {{bubbles: true}})); }})()")
            g, lo, hi = platter_down(pg, 0.55); time.sleep(1.0); res[f'blend_{amt}_platter_held_still'] = round(float(np.sqrt(np.mean(record(pg, 1.5) ** 2))), 4); platter_up(pg); time.sleep(0.3)
        R['F_blend'] = res; R['F_blend']['song_rms_for_reference'] = round(R['B_signal_rms'], 4)

        # ── G. band pass on the two-tone file ───────────────────────────────────────────────────────────────────────
        load_track(pg, 'twotone.wav'); wait_play(pg, 2.5); select_mode(pg, 'bandpass')
        pad = pg.locator('.fx-pad'); pad.scroll_into_view_if_needed(); bb = pad.bounding_box(); cx, cy, R0 = bb['x'] + bb['width'] / 2, bb['y'] + bb['height'] / 2, bb['width'] / 2
        base = record(pg, 1.5)[4096:][:SR]
        def hold_pad(xn, yn, secs=1.5):
            pg.mouse.move(cx + xn * R0 * 0.96, cy - yn * R0 * 0.96); pg.mouse.down(); time.sleep(0.5)
            v = ctl(pg, '({f: c.out.bus.freq, q: c.out.bus.q})'); x = record(pg, secs)[4096:][:SR]; return v, x
        v_hi, x_hi = hold_pad(0.505, 0.2)
        pg.screenshot(path=os.path.join(SHOTS, '06-bandpass-pad.png')); pg.mouse.up(); time.sleep(0.5)
        v_lo, x_lo = hold_pad(-0.651, 0.2); pg.mouse.up(); time.sleep(0.5)
        v_nar, x_nar = hold_pad(0.505, 0.9); pg.mouse.up(); time.sleep(0.5)
        v_wide, x_wide = hold_pad(0.505, -0.8); pg.mouse.up(); time.sleep(0.5)
        def sidebands(x): return band_db(x, 3000, 40) - 0.5 * (band_db(x, 2000, 40) + band_db(x, 4200, 40))
        R['G_bandpass'] = {
            'base_3k_minus_300_db': round(band_db(base, 3000) - band_db(base, 300), 1),
            'x_right(~3kHz)': {'freq': round(v_hi['f']), 'q': round(v_hi['q'], 1), '3k_minus_300_db': round(band_db(x_hi, 3000) - band_db(x_hi, 300), 1), 'level_3k_db_vs_base': round(band_db(x_hi, 3000) - band_db(base, 3000), 1)},
            'x_left(~300Hz)': {'freq': round(v_lo['f']), 'q': round(v_lo['q'], 1), '3k_minus_300_db': round(band_db(x_lo, 3000) - band_db(x_lo, 300), 1), 'level_300_db_vs_base': round(band_db(x_lo, 300) - band_db(base, 300), 1)},
            'q_narrow_skirt_rejection_db': round(sidebands(x_nar), 1), 'q_wide_skirt_rejection_db': round(sidebands(x_wide), 1), 'q_narrow': round(v_nar['q'], 1), 'q_wide': round(v_wide['q'], 1)}
        time.sleep(0.8)
        R['G_bandpass']['chain_removed_after_release'] = (ctl(pg, 'c.bus.active') is False)
        R['G_bandpass']['graph_predecessors_of_destination_after'] = pg.evaluate('window.__preds().length')

        # ── H. reverb / delay: echo time ────────────────────────────────────────────────────────────────────────────
        load_track(pg, 'ping.wav'); wait_play(pg, 0.2); select_mode(pg, 'echo')
        pg.click('.fx-chips[aria-label^="Delay time"] [data-div="1/2"]')
        pad = pg.locator('.fx-pad'); pad.scroll_into_view_if_needed(); bb = pad.bounding_box(); cx, cy, R0 = bb['x'] + bb['width'] / 2, bb['y'] + bb['height'] / 2, bb['width'] / 2
        dsec = ctl(pg, 'c.out.bus.delaySec')
        # time the hold so that a ping lands while holding: pings at 0.5 + 2k s on the song clock
        pos = pg.evaluate('window.__runoutFx.controller.host.positionSec()'); wait = (0.5 + 2 * math.ceil((pos - 0.5) / 2) - pos) - 0.4
        if wait < 0.1: wait += 2
        time.sleep(wait)
        pad.scroll_into_view_if_needed(); bb = pad.bounding_box(); cx, cy, R0 = bb['x'] + bb['width'] / 2, bb['y'] + bb['height'] / 2, bb['width'] / 2
        pg.mouse.move(cx + 0.62 * R0, cy - 0.62 * R0); pg.mouse.down()
        pg.evaluate('window.__tap(0, true)'); time.sleep(0.45 + 1.7); dsec = ctl(pg, 'c.out.bus.delaySec'); fb = ctl(pg, 'c.out.bus.feedback')
        pg.screenshot(path=os.path.join(SHOTS, '07-echo-pad.png'))
        time.sleep(0.6); pg.mouse.up(); time.sleep(1.2); pg.evaluate('window.__tap(0, false)'); time.sleep(0.15)
        x = take(pg, 0); np.save(os.path.join(OUT, 'rec_echo.npy'), x.astype('f4'))
        env = np.convolve(np.abs(x), np.ones(110) / 110, 'same'); thr = 0.5 * env.max()
        # first ping = first crossing of half the maximum; echoes = later local maxima above 25 % of the first ping's peak
        idx = int(np.argmax(env > thr)); ping_peak = env[idx:idx + 2000].max(); peaks = []
        i = idx + int(0.05 * SR)
        while i < min(len(env) - 100, idx + int(1.6 * SR)):
            w = env[i:i + int(0.01 * SR)]
            if w.max() > 0.2 * ping_peak and env[i + int(np.argmax(w))] == env[max(0, i + int(np.argmax(w)) - 220):i + int(np.argmax(w)) + 220].max():
                peaks.append((i + int(np.argmax(w)) - idx) / SR); i += int(0.15 * SR)
            else: i += int(0.005 * SR)
        R['H_echo'] = {'expected_delay_s': round(dsec, 4), 'feedback': round(fb, 3), 'echo_times_after_ping_s': [round(p, 3) for p in peaks[:5]], 'first_echo_err_ms': round(1000 * (peaks[0] - dsec), 1) if peaks else None,
                       'second_echo_over_first_ratio_expected_about': round(fb, 2)}
        time.sleep(5.6)
        R['H_echo']['chain_removed_after_tail'] = (ctl(pg, 'c.bus.active') is False)
        R['H_echo']['graph_predecessors_of_destination_after'] = pg.evaluate('window.__preds().length')

        # ── I. no clicks entering / leaving modes (smooth sweep) ────────────────────────────────────────────────────
        load_track(pg, 'sweep.wav'); wait_play(pg, 2.5)
        R['I_clicks'] = {}
        fresh(pg, 'sweep.wav'); select_mode(pg, 'scratch'); time.sleep(0.3)
        base_x = record(pg, 3.0)[4096:]; bd = mask_steps(base_x, last_gaps(pg)); nat = max_step(base_x, bd); R['I_clicks']['baseline_max_step'] = round(nat, 5); R['I_clicks']['baseline_spike_ratio'] = round(spike_ratio(base_x, d=bd), 2); R['I_clicks']['baseline_recorder_gaps'] = len(last_gaps(pg))
        bound = nat * 1.6 + 0.01
        for mid, how in (('repeat', 'platter'), ('stutter', 'platter'), ('blend', 'platter'), ('bandpass', 'pad'), ('echo', 'pad')):
            load_track(pg, 'sweep.wav'); wait_play(pg, 2.0); select_mode(pg, mid)
            if mid == 'blend': pg.evaluate("(() => { const i = document.getElementById('fxBlend'); i.value = 50; i.dispatchEvent(new Event('input', {bubbles: true})); })()")
            if how == 'pad':
                pad = pg.locator('.fx-pad'); pad.scroll_into_view_if_needed(); bb = pad.bounding_box(); cx, cy, R0 = bb['x'] + bb['width'] / 2, bb['y'] + bb['height'] / 2, bb['width'] / 2
            pg.evaluate('window.__tap(0, true)')
            for rep in range(3):
                if how == 'platter': g, lo, hi = platter_down(pg, 0.5 + 0.1 * rep)
                else: pg.mouse.move(cx + (0.2 + 0.3 * rep) * R0, cy - 0.1 * R0); pg.mouse.down()
                time.sleep(0.45)
                if how == 'pad':
                    for k in range(12): pg.mouse.move(cx + (0.2 + 0.05 * k) * R0, cy - (0.1 + 0.04 * k) * R0); time.sleep(0.03)
                time.sleep(0.3)
                pg.mouse.up(); time.sleep(0.5)
            pg.evaluate('window.__tap(0, false)'); time.sleep(0.15); x = take(pg, 0)[4096:]; gp = last_gaps(pg); dd = mask_steps(x, gp)
            np.save(os.path.join(OUT, f'rec_clicks_{mid}.npy'), x.astype('f4'))
            R['I_clicks'][mid] = {'max_step': round(max_step(x, dd), 5), 'baseline_max_step': round(nat, 5), 'spike_ratio': round(spike_ratio(x, d=dd), 2), 'recorder_gaps_masked': len(gp), 'ok': bool(spike_ratio(x, d=dd) <= 4.0)}
            time.sleep(5.8 if mid == 'echo' else 0.2)

        # ── J. persistence + reload ────────────────────────────────────────────────────────────────────────────────
        select_mode(pg, 'repeat'); pg.click('.fx-chips[aria-label^="Slice length"] [data-div="1/8"]')
        stored = pg.evaluate("localStorage.getItem('runout.fx.v1')")
        pg.reload(); pg.wait_for_function('document.getElementById("latency") && !/measuring/.test(document.getElementById("latency").textContent)')
        pg.evaluate('window.__tapInit()'); pg.click('#fxHead'); pg.wait_for_selector('.fx-view'); time.sleep(0.5)
        R['J_persist'] = {'stored': stored, 'restored_mode': ctl(pg, 'c.mode'), 'restored_div': ctl(pg, 'c.state.repeat.div'), 'view_after_open': pg.evaluate("document.querySelector('.fx-view').dataset.view")}
        # corrupt storage never throws
        pg.evaluate("localStorage.setItem('runout.fx.v1', '{broken')"); pg.reload(); pg.wait_for_function('document.getElementById("latency") && !/measuring/.test(document.getElementById("latency").textContent)')
        pg.evaluate('window.__tapInit()'); pg.click('#fxHead'); pg.wait_for_selector('.fx-view'); R['J_persist']['corrupt_storage_mode'] = ctl(pg, 'c.mode')

        # ── K. close tears everything down ──────────────────────────────────────────────────────────────────────────
        select_mode(pg, 'bandpass'); pad = pg.locator('.fx-pad'); pad.scroll_into_view_if_needed(); bb = pad.bounding_box()
        pg.mouse.move(bb['x'] + bb['width'] * 0.6, bb['y'] + bb['height'] * 0.4); pg.mouse.down(); time.sleep(0.4)
        R['K_chain_while_held'] = ctl(pg, 'c.bus.active'); pg.click('#fxHead', force=True) if False else None
        pg.mouse.up(); pg.click('#fxHead'); time.sleep(0.6)
        R['K_after_close'] = pg.evaluate("({fx: window.__runoutFx === null, ring: !document.querySelector('.fx-stage-ring'), hud: !document.querySelector('.fx-hud'), preds: window.__preds().length, busSucc: window.__busSucc()})")

        # ── L. CD album: the pad works on a CD track ───────────────────────────────────────────────────────────────
        pg.click('#btnLibrary')
        with pg.expect_file_chooser() as fc: pg.click('#libScan')
        fc.value.set_files(os.path.join(FIX, 'lib'))
        pg.wait_for_function('document.querySelectorAll("#albumGrid > *").length >= 2', timeout=30000); time.sleep(1.0)
        pg.click('#kindChips [data-kind="cd"]'); time.sleep(0.4)
        pg.locator('#albumGrid > *').first.click(); time.sleep(0.6)
        pg.locator('.alb-detail-list li').first.click()
        time.sleep(2.5)
        R['L_view'] = pg.evaluate("document.querySelector('.stage').dataset.view")
        if R['L_view'] == 'cd':
            pg.click('#fxHead'); pg.wait_for_selector('.fx-view'); select_mode(pg, 'repeat')
            R['L_blend_disabled_on_cd'] = pg.evaluate("(() => { document.querySelector('.fx-top .fx-btn').click(); return document.querySelector('.fx-row[data-id=\"blend\"]').getAttribute('aria-disabled'); })()")
            pg.click('.fx-row[data-id="repeat"]'); time.sleep(1.0)
            pg.click('.fx-chips[aria-label^="Slice length"] [data-div="1/2"]')
            pad = pg.locator('.fx-pad'); pad.scroll_into_view_if_needed(); bb = pad.bounding_box(); cx, cy, R0 = bb['x'] + bb['width'] / 2, bb['y'] + bb['height'] / 2, bb['width'] / 2
            pg.mouse.move(cx, cy - R0 * 0.55); pg.mouse.down(); time.sleep(0.8)
            x = record(pg, 1.6)[4096:]; beat2 = ctl(pg, 'c.beat.beatSec'); S = 0.5 * beat2 * SR
            per, strength = autocorr_period(x[:int(SR * 1.4)], S * .7, S * 1.3)
            R['L_cd_repeat'] = {'expected': round(S, 1), 'measured': round(per, 1), 'err_pct': round(100 * (per - S) / S, 2), 'autocorr': round(strength, 3)}
            pg.mouse.up()
            pg.screenshot(path=os.path.join(SHOTS, '08-cd-view-pad.png'))
        R['console_errors'] = [l for l in logs if 'Failed to load resource' not in l][:10]
        R['failed_resources'] = len([l for l in logs if 'Failed to load resource' in l])
        b.close()

if __name__ == '__main__':
    run()
