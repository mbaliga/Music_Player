#!/usr/bin/env python3
"""Replay the desktop-Chromium verification of You Radio (docs/RADIO_ARCHITECTURE.md section 16, HANDOFF.md).

Needs: ffmpeg (with libmp3lame), Playwright for Python, and the dev server running:  python3 serve.py 8123
Usage:  python3 scripts/verify-you-radio.py [fake|real] [outdir]

  fake (default)  injects a fake window.speechSynthesis whose events fire like a real engine, because headless Chromium
                  reports no voices and fails every speak(). Captions, ducking, skip, stop and offline are then checked.
  real            leaves the browser's own speechSynthesis alone (expect 0 voices and 'synthesis-failed' in headless).

It generates six tagged 32 s MP3s, scans them through the app's folder-input fallback, turns the flag on from the Radio tab,
starts You Radio and prints a JSON report; screenshots go to outdir. NOT a substitute for the on-device checks.
Set CHROME=/path/to/chrome if Playwright's own browser revision is not installed.
"""
import os, subprocess, tempfile
import json, sys, time, glob
from playwright.sync_api import sync_playwright

MODE = sys.argv[1] if len(sys.argv) > 1 else 'fake'
SP = sys.argv[2] if len(sys.argv) > 2 else tempfile.mkdtemp(prefix='you-radio-')
SHOTS = os.path.join(SP, 'shots'); os.makedirs(SHOTS, exist_ok=True)
URL = os.environ.get('URL', 'http://localhost:8123/index.html')
LIB = os.path.join(SP, 'lib')
SPECS = [('Harbor Lights', 'Mara Quill', 'Night Shift', 220, 'Jazz'), ('Paper Moon', 'The Velvet Lanterns', 'Night Shift', 262, 'Jazz'),
         ('Slow Window', 'Low Tide Orchestra', 'Tidal', 294, 'Ambient'), ('Copper Rain', 'June Parlor', 'Tidal', 330, 'Folk'),
         ('Static Orchard', 'Static Orchard', 'Orchard Hum', 392, 'Electronic'), ('Salt and Ember', 'Hollis Reed', 'Orchard Hum', 440, 'Rock')]

def make_fixtures():
    os.makedirs(LIB, exist_ok=True)
    for i, (t, a, al, f, g) in enumerate(SPECS, 1):
        out = os.path.join(LIB, f"0{i} - {t.replace(' ', '_')}.mp3")
        if os.path.exists(out): continue
        subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', f'sine=frequency={f}:duration=32:sample_rate=44100', '-f', 'lavfi', '-i', f'sine=frequency={f*2}:duration=32',
                        '-filter_complex', '[0][1]amix=inputs=2:weights=1 0.3,volume=0.5[a]', '-map', '[a]', '-metadata', f'title={t}', '-metadata', f'artist={a}', '-metadata', f'album={al}',
                        '-metadata', f'genre={g}', '-metadata', f'track={i}', '-c:a', 'libmp3lame', '-b:a', '96k', out], check=True)

FAKE_SPEECH = """
(() => {
  const log = { spoken: [], cancels: 0, voicesAsked: 0 };
  window.__speech = log;
  class U { constructor(t){ this.text=t; this.rate=1; this.pitch=1; this.volume=1; } }
  let cur = null, timers = [];
  const synth = {
    speaking:false, pending:false, paused:false,
    _v:[{name:'Fake Alex',lang:'en-US',voiceURI:'fa',localService:true,default:true},{name:'Fake Fiona',lang:'en-GB',voiceURI:'ff',localService:true,default:false}],
    getVoices(){ log.voicesAsked++; return this._v; }, addEventListener(){}, removeEventListener(){}, resume(){},
    speak(u){
      log.spoken.push({text:u.text, rate:u.rate, pitch:u.pitch, voice:u.voice&&u.voice.name, t:performance.now()});
      cur=u; this.speaking=true;
      const words=(u.text.match(/\\S+/g)||[]).length, dur=Math.max(400, words/(2.6*(u.rate||1))*1000);
      const at=(f,ms)=>timers.push(setTimeout(()=>{ if(cur===u) f(); }, ms));
      at(()=>u.onstart&&u.onstart({}),60);
      for(let i=1;i<=words;i++) at(()=>u.onboundary&&u.onboundary({}), 60+dur*i/(words+1));
      at(()=>{ this.speaking=false; cur=null; u.onend&&u.onend({}); }, dur);
    },
    cancel(){ log.cancels++; const u=cur; cur=null; this.speaking=false; timers.forEach(clearTimeout); timers=[]; if(u&&u.onerror) u.onerror({error:'interrupted'}); },
  };
  Object.defineProperty(window,'speechSynthesis',{value:synth,configurable:true});
  window.SpeechSynthesisUtterance = U;
})();
"""

BUS_HOOK = """
(() => {
  const orig = AudioNode.prototype.connect;
  window.__busCandidates = 0;
  AudioNode.prototype.connect = function(dest, ...r){
    try {
      if (!window.__bus && this instanceof GainNode && dest && dest.constructor && dest.constructor.name === 'AudioDestinationNode') {
        window.__bus = this; window.__busCandidates++;
        const ctx = this.context; const an = ctx.createAnalyser(); an.fftSize = 2048; orig.call(this, an); window.__an = an;
      }
    } catch(e) {}
    return orig.call(this, dest, ...r);
  };
  window.__rms = () => { const an = window.__an; if(!an) return -1; const b = new Float32Array(an.fftSize); an.getFloatTimeDomainData(b); let s=0; for (const x of b) s+=x*x; return Math.sqrt(s/b.length); };
})();
"""

def run():
    make_fixtures()
    out = {}
    with sync_playwright() as p:
        b = p.chromium.launch(**({'executable_path': os.environ['CHROME']} if os.environ.get('CHROME') else {}), args=['--autoplay-policy=no-user-gesture-required', '--no-sandbox'])
        ctx = b.new_context(viewport={'width': 412, 'height': 860}, device_scale_factor=2)
        ctx.add_init_script('window.showDirectoryPicker = undefined; try { localStorage.setItem("runout.wtDone", "1"); } catch(e) {}')
        ctx.add_init_script(BUS_HOOK)
        if MODE == 'fake':
            ctx.add_init_script(FAKE_SPEECH)
        page = ctx.new_page()
        reqs = []
        page.on('request', lambda r: reqs.append(r.url))
        bad = []
        page.on('response', lambda r: bad.append((r.status, r.url)) if r.status >= 400 else None)
        errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        page.on('console', lambda m: errs.append('console:' + m.text) if m.type == 'error' else None)
        page.goto(URL)
        page.wait_for_function('document.getElementById("latency") && !/boot error/.test(document.getElementById("latency").textContent)')
        time.sleep(0.5)

        # --- Phase A: flag off
        page.click('#btnLibrary')
        page.click('.lib-tab[data-tab="radio"]')
        page.wait_for_selector('#aiStationsToggle')
        out['A_toggle_label'] = page.inner_text('.radio-setting b')
        out['A_toggle_checked'] = page.is_checked('#aiStationsToggle')
        out['A_ai_row_present'] = page.locator('.radio-ai-sec .radio-row').count()
        out['A_flag_in_storage'] = page.evaluate('localStorage.getItem("runout.flag.radio.ai")')
        page.screenshot(path=SHOTS + '/01-radio-tab-flag-off.png')

        # --- Phase B: scan the generated library via the file-input fallback
        page.click('.lib-tab[data-tab="albums"]')
        with page.expect_file_chooser() as fc:
            page.click('#libScan')
        fc.value.set_files(LIB)
        page.wait_for_function('document.querySelectorAll("#albumGrid > *").length >= 2', timeout=20000)
        time.sleep(1.0)
        out['B_albums'] = page.locator('#albumGrid > *').count()
        page.screenshot(path=SHOTS + '/02-library-scanned.png')

        # --- Phase C: enable the toggle, start You Radio
        page.click('.lib-tab[data-tab="radio"]')
        page.check('#aiStationsToggle')
        page.wait_for_selector('.radio-ai-sec .radio-row')
        out['C_flag_in_storage'] = page.evaluate('localStorage.getItem("runout.flag.radio.ai")')
        out['C_ai_row_text'] = page.inner_text('.radio-ai-sec .radio-row')
        page.screenshot(path=SHOTS + '/03-toggle-on-you-radio-row.png')
        page.evaluate('''() => {
          window.__fast = []; window.__chunks = [];
          const ctx = window.__bus.context;
          const sp = ctx.createScriptProcessor(1024, 2, 1);
          let prev = 0;
          sp.onaudioprocess = (e) => { const d = e.inputBuffer.getChannelData(0); let m = 0, pk = 0; for (let i = 0; i < d.length; i++) { const dx = Math.abs(d[i] - prev); if (dx > m) m = dx; if (Math.abs(d[i]) > pk) pk = Math.abs(d[i]); prev = d[i]; } window.__chunks.push([ctx.currentTime, m, pk, window.__bus.gain.value]); };
          window.__bus.connect(sp); sp.connect(ctx.destination);
          setInterval(() => window.__fast.push([ctx.currentTime, window.__bus.gain.value]), 5);
        }''')
        out['C_requests_before_station_click'] = len(reqs)
        t0 = time.time()
        page.click('.radio-ai-sec .radio-row')
        page.wait_for_selector('.ai-card .ai-label', state='visible')
        out['C_label'] = page.inner_text('.ai-label')
        page.wait_for_function('document.querySelector(".ai-now-title") && document.querySelector(".ai-now-title").textContent !== "Tuning in…"', timeout=15000)
        out['C_first_title_after_s'] = round(time.time() - t0, 2)
        out['C_external_requests_after_station_click'] = [u for u in reqs[out['C_requests_before_station_click']:] if not u.startswith('http://localhost:8123')]
        out['C_now_title'] = page.inner_text('.ai-now-title')
        out['C_now_sub'] = page.inner_text('.ai-now-sub')

        # sample gain / rms / captions for ~25 s
        samples = []
        caps_seen = []
        t1 = time.time()
        shot_taken = False
        while time.time() - t1 < 28:
            s = page.evaluate('({g: window.__bus ? window.__bus.gain.value : null, rms: window.__rms(), speaking: window.__speech ? window.__speech.spoken.length : null, sp: window.__speech ? !!window.speechSynthesis.speaking : null})')
            caps = page.locator('.ai-cap').all_inner_texts()
            if caps and caps[-1] not in caps_seen: caps_seen.append(caps[-1])
            samples.append((round(time.time() - t1, 2), s['g'], s['rms'], s['sp']))
            if s['sp'] and not shot_taken and s['g'] is not None and s['g'] < 0.4:
                page.screenshot(path=SHOTS + '/04-you-radio-speaking-ducked.png'); shot_taken = True
            time.sleep(0.1)
        out['C_captions_seen'] = caps_seen
        sp = [x for x in samples if x[3]]
        ns = [x for x in samples if not x[3] and x[0] > 3]
        out['C_gain_while_speaking_min'] = min([x[1] for x in sp]) if sp else None
        out['C_gain_while_speaking_median'] = sorted([x[1] for x in sp])[len(sp)//2] if sp else None
        out['C_gain_idle_median'] = sorted([x[1] for x in ns])[len(ns)//2] if ns else None
        out['C_rms_speaking_median'] = sorted([x[2] for x in sp])[len(sp)//2] if sp else None
        out['C_rms_idle_median'] = sorted([x[2] for x in ns])[len(ns)//2] if ns else None
        gs = [x[1] for x in samples if x[1] is not None]
        # click check: largest change of gain between consecutive 100 ms samples
        out['C_max_gain_step_per_100ms'] = round(max(abs(a - b) for a, b in zip(gs, gs[1:])), 3) if len(gs) > 1 else None
        fast = page.evaluate('window.__fast')
        # gain slope measured in AUDIO time over >= 20 ms windows (timer jitter makes tiny windows meaningless)
        slopes = []
        j = 0
        for i in range(len(fast)):
            while j < len(fast) and fast[j][0] - fast[i][0] < 0.02: j += 1
            if j < len(fast): slopes.append(abs(fast[j][1] - fast[i][1]) / (fast[j][0] - fast[i][0]))
        out['C_fast_samples'] = len(fast)
        out['C_max_gain_slope_per_s_20ms_windows'] = round(max(slopes), 2) if slopes else None
        out['C_expected_attack_slope_per_s'] = round((1-0.1995)/0.22, 2)
        chunks = [c for c in page.evaluate('window.__chunks') if c[0] > 4.0]  # skip the song-onset transient at the very start
        out['C_audio_chunks'] = len(chunks)
        steady = [c for c in chunks if c[2] > 0.02 and abs(c[3]-1) < 1e-6]   # full-level music, no ducking
        ducked = [c for c in chunks if c[2] > 0.003 and abs(c[3]-0.1995) < 1e-3]
        ramp = [c for c in chunks if 0.2 < c[3] < 0.999]
        out['C_chunks_steady_full_gain'] = len(steady); out['C_chunks_ducked'] = len(ducked); out['C_chunks_ramping'] = len(ramp)
        out['C_max_sample_step_steady'] = round(max(c[1] for c in steady), 4) if steady else None
        out['C_max_sample_step_ducked'] = round(max(c[1] for c in ducked), 4) if ducked else None
        out['C_max_sample_step_ramping'] = round(max(c[1] for c in ramp), 4) if ramp else None
        # gain transitions: contiguous runs where the gain is changing, with their duration and span
        runs = []; cur = None
        for fa, fb in zip(fast, fast[1:]):
            ch = abs(fb[1]-fa[1]) > 1e-4
            if ch and cur is None: cur = [fa[0], fa[1], fb[0], fb[1]]
            elif ch and cur is not None: cur[2], cur[3] = fb[0], fb[1]
            elif not ch and cur is not None: runs.append(cur); cur = None
        out['C_gain_transitions'] = [{'t0': round(r[0],3), 'dur_ms': round((r[2]-r[0])*1000), 'from': round(r[1],3), 'to': round(r[3],3)} for r in runs]
        norm = lambda cs: round(max(c[1]/c[2] for c in cs if c[2] > 0.003), 4) if cs else None
        out['C_norm_step_steady'] = norm(steady); out['C_norm_step_ducked'] = norm(ducked); out['C_norm_step_ramping'] = norm(ramp)
        out['C_top5_sample_steps_overall'] = sorted([(round(c[1],3), round(c[0],2), round(c[3],3)) for c in chunks], reverse=True)[:5]
        out['C_spoken'] = page.evaluate('window.__speech ? window.__speech.spoken.map(s => ({text: s.text, voice: s.voice, rate: +s.rate.toFixed(2), pitch: +s.pitch.toFixed(2)})) : null')
        page.screenshot(path=SHOTS + '/05-you-radio-on-air.png')

        # --- Phase D: skip
        title_before = page.inner_text('.ai-now-title')
        cancels_before = page.evaluate('window.__speech ? window.__speech.cancels : 0')
        page.click('.ai-controls [data-act="skip"]')
        page.wait_for_function('(t) => document.querySelector(".ai-now-title").textContent !== t', arg=title_before, timeout=8000)
        out['D_title_before'] = title_before
        out['D_title_after_skip'] = page.inner_text('.ai-now-title')
        time.sleep(0.5)
        out['D_gain_after_skip'] = page.evaluate('window.__bus.gain.value')

        # --- Phase E: offline
        ctx.set_offline(True)
        out['E_navigator_online'] = page.evaluate('navigator.onLine')
        n_reqs = len(reqs)
        title_e = page.inner_text('.ai-now-title')
        # wait for the next song to join on its own (32 s songs)
        try:
            page.wait_for_function('(t) => document.querySelector(".ai-now-title").textContent !== t', arg=title_e, timeout=45000)
            out['E_joined_next_song_offline'] = page.inner_text('.ai-now-title')
        except Exception as e:
            out['E_joined_next_song_offline'] = 'TIMEOUT'
        out['E_new_requests_while_offline'] = reqs[n_reqs:]
        out['E_state'] = page.evaluate('document.querySelector(".radio-now") ? document.querySelector(".radio-now").className : null')
        page.screenshot(path=SHOTS + '/06-offline-still-playing.png')
        ctx.set_offline(False)

        # --- Phase F: stop mid-speech if possible
        for _ in range(300):
            if page.evaluate('window.__speech ? window.speechSynthesis.speaking : true'): break
            time.sleep(0.1)
        out['F_speaking_at_stop'] = page.evaluate('window.__speech ? window.speechSynthesis.speaking : null')
        c_before = page.evaluate('window.__speech ? window.__speech.cancels : 0')
        page.click('.ai-controls [data-act="stop"]')
        time.sleep(0.6)
        out['F_cancels_added'] = (page.evaluate('window.__speech ? window.__speech.cancels : 0') - c_before) if MODE == 'fake' else None
        out['F_speaking_after_stop'] = page.evaluate('window.__speech ? window.speechSynthesis.speaking : null')
        out['F_gain_after_stop'] = page.evaluate('window.__bus.gain.value')
        time.sleep(1.5)
        out['F_rms_after_stop'] = [round(page.evaluate('window.__rms()'), 5) for _ in range(5)]
        out['F_panel_hidden'] = page.evaluate('document.querySelector(".ai-panel").classList.contains("hidden")')
        spoken_n = page.evaluate('window.__speech ? window.__speech.spoken.length : 0')
        time.sleep(8)
        out['F_spoken_after_stop'] = (page.evaluate('window.__speech ? window.__speech.spoken.length : 0') - spoken_n) if MODE == 'fake' else None
        page.screenshot(path=SHOTS + '/07-stopped.png')

        # --- Phase G: reload: flag persisted; toggle off removes the row
        page.reload()
        page.wait_for_function('document.getElementById("latency") && !/boot error/.test(document.getElementById("latency").textContent)')
        page.click('#btnLibrary'); page.click('.lib-tab[data-tab="radio"]')
        page.wait_for_selector('#aiStationsToggle')
        out['G_checked_after_reload'] = page.is_checked('#aiStationsToggle')
        out['G_row_after_reload'] = page.locator('.radio-ai-sec .radio-row').count()

        # --- Phase H: empty library (library is not restored: tracks need re-link)
        page.click('.radio-ai-sec .radio-row')
        page.wait_for_function('document.querySelector(".ai-note") && document.querySelector(".ai-note").textContent.length > 0', timeout=8000)
        out['H_empty_note'] = page.inner_text('.ai-card .ai-note')
        out['H_radio_now'] = page.inner_text('.radio-now')
        page.screenshot(path=SHOTS + '/08-empty-library.png')
        page.click('.ai-controls [data-act="stop"]')
        page.check('#aiStationsToggle') if not page.is_checked('#aiStationsToggle') else page.uncheck('#aiStationsToggle')
        time.sleep(0.3)
        out['H_row_after_toggle_off'] = page.locator('.radio-ai-sec .radio-row').count()
        out['H_flag_after_off'] = page.evaluate('localStorage.getItem("runout.flag.radio.ai")')

        ext = [u for u in reqs if not u.startswith('http://localhost:8123') and not u.startswith('data:') and not u.startswith('blob:')]
        out['external_requests'] = ext
        out['page_errors'] = errs[:10]
        out['http_errors'] = bad
        b.close()
    print(json.dumps(out, indent=1, default=str))

run()
