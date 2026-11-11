#!/usr/bin/env python3
"""Replay the desktop-Chromium verification of the station picker ("the dial") and the canned (pre-written) stations.

Needs: ffmpeg (libmp3lame, libopus), Playwright for Python, and the dev server:  python3 serve.py 8123
Usage:  python3 scripts/verify-canned-radio.py [outdir]
Set CHROME=/path/to/chrome when Playwright's own browser revision is not installed (e.g. /opt/pw-browsers/chromium-1243/chrome-linux64/chrome).

What it checks (it injects a FAKE window.speechSynthesis because headless Chromium has no voices; REAL SPEECH IS NEVER HEARD):
  A  Radio tab: the dial lists the six pre-written stations (names from the pack JSON), each labelled "Pre-written show"; with the
     radio.ai flag off there are no AI style cards and no You Radio row
  B  start a station: "Pre-written show" label, captions with the speaking person's name, the music bus ducks while speech runs and
     returns to unity, several distinct voices, skip, favourites persist across a reload, Resume
  C  offline (context.set_offline): the show keeps going and a station already loaded restarts with ZERO new requests
  D  Stop signs off, then stops
  E  flag on: five greyed AI style cards "Needs internet — coming soon", You Radio row, tapping a style shows info, the audition reads
     the ten lines in the host's pace/pitch, nothing starts
  F  audio pack (stub manifest + generated Opus served through request interception): recordings play through <audio>, the .m4a alt
     is offered when the Opus is refused, and a recording that fails to decode is spoken by TTS instead
It generates six tagged MP3s, scans them through the folder-input fallback and prints a JSON report; screenshots go to outdir.
NOT a substitute for the on-device checks (voices on the RedMagic, Opus decode in the Android WebView, ducking feel, audio focus, screen off).
"""
import json, os, subprocess, sys, tempfile, time
from playwright.sync_api import sync_playwright

SP = sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp(prefix='canned-radio-')
SHOTS = os.path.join(SP, 'shots'); os.makedirs(SHOTS, exist_ok=True)
URL = os.environ.get('URL', 'http://localhost:8123/index.html')
ORIGIN = URL.rsplit('/', 1)[0]
LIB = os.path.join(SP, 'lib')
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SPECS = [('Harbor Lights', 'Mara Quill', 'Night Shift', 220, 'Jazz'), ('Paper Moon', 'The Velvet Lanterns', 'Night Shift', 262, 'Jazz'),
         ('Slow Window', 'Low Tide Orchestra', 'Tidal', 294, 'Ambient'), ('Copper Rain', 'June Parlor', 'Tidal', 330, 'Folk'),
         ('Static Orchard', 'Static Orchard', 'Orchard Hum', 392, 'Electronic'), ('Salt and Ember', 'Hollis Reed', 'Orchard Hum', 440, 'Rock')]
SONG_SEC = 40

def make_fixtures():
    os.makedirs(LIB, exist_ok=True)
    for i, (t, a, al, f, g) in enumerate(SPECS, 1):
        out = os.path.join(LIB, f"0{i} - {t.replace(' ', '_')}.mp3")
        if os.path.exists(out): continue
        subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', f'sine=frequency={f}:duration={SONG_SEC}:sample_rate=44100', '-f', 'lavfi', '-i', f'sine=frequency={f*2}:duration={SONG_SEC}',
                        '-filter_complex', '[0][1]amix=inputs=2:weights=1 0.3,volume=0.5[a]', '-map', '[a]', '-metadata', f'title={t}', '-metadata', f'artist={a}', '-metadata', f'album={al}',
                        '-metadata', f'genre={g}', '-metadata', f'track={i}', '-c:a', 'libmp3lame', '-b:a', '96k', out], check=True)

def make_opus(path, sec=2):
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', f'sine=frequency=180:duration={sec}:sample_rate=48000', '-c:a', 'libopus', '-b:a', '24k', path], check=True)

FAKE_SPEECH = """
(() => {
  const log = { spoken: [], cancels: 0 };
  window.__speech = log;
  class U { constructor(t){ this.text=t; this.rate=1; this.pitch=1; this.volume=1; } }
  let cur = null, timers = [];
  const V = [['Fake Samantha','en-US'],['Fake Daniel','en-GB'],['Fake Karen','en-AU'],['Fake Moira','en-IE'],['Fake Alex','en-US']].map(([n,l],i)=>({name:n,lang:l,voiceURI:'fv'+i,localService:true,default:i===0}));
  const synth = {
    speaking:false, pending:false, paused:false, _v:V,
    getVoices(){ return this._v; }, addEventListener(){}, removeEventListener(){}, resume(){},
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
  AudioNode.prototype.connect = function(dest, ...r){
    try {
      if (!window.__bus && this instanceof GainNode && dest && dest.constructor && dest.constructor.name === 'AudioDestinationNode') {
        window.__bus = this;
        const ctx = this.context; const an = ctx.createAnalyser(); an.fftSize = 2048; orig.call(this, an); window.__an = an;
      }
    } catch(e) {}
    return orig.call(this, dest, ...r);
  };
  window.__rms = () => { const an = window.__an; if(!an) return -1; const b = new Float32Array(an.fftSize); an.getFloatTimeDomainData(b); let s=0; for (const x of b) s+=x*x; return Math.sqrt(s/b.length); };
})();
"""

def local(u): return u.startswith(ORIGIN) or u.startswith('data:') or u.startswith('blob:')

def open_radio(page):
    page.goto(URL)
    page.wait_for_function('document.getElementById("latency") && !/boot error/.test(document.getElementById("latency").textContent)')
    time.sleep(0.4)
    page.click('#btnLibrary')
    page.click('.lib-tab[data-tab="radio"]')
    page.wait_for_selector('.dial-card', timeout=10000)

def scan(page):
    page.click('.lib-tab[data-tab="albums"]')
    with page.expect_file_chooser() as fc:
        page.click('#libScan')
    fc.value.set_files(LIB)
    page.wait_for_function('document.querySelectorAll("#albumGrid > *").length >= 2', timeout=20000)
    time.sleep(0.8)
    page.click('.lib-tab[data-tab="radio"]')
    page.wait_for_selector('.dial-card')

def launch(p):
    kw = {'executable_path': os.environ['CHROME']} if os.environ.get('CHROME') else {}
    return p.chromium.launch(**kw, args=['--autoplay-policy=no-user-gesture-required', '--no-sandbox'])

def run():
    make_fixtures()
    out = {}
    pack_names = {}
    idx = json.load(open(os.path.join(ROOT, 'content/stations/index.json')))
    for s in idx['stations']: pack_names[s['id']] = (s['name'], s['dial'])
    with sync_playwright() as p:
        b = launch(p)
        ctx = b.new_context(viewport={'width': 412, 'height': 860}, device_scale_factor=2)
        ctx.add_init_script('window.showDirectoryPicker = undefined; try { localStorage.setItem("runout.wtDone", "1"); } catch(e) {}')
        ctx.add_init_script(BUS_HOOK); ctx.add_init_script(FAKE_SPEECH)
        page = ctx.new_page()
        reqs = []; errs = []; bad = []
        page.on('request', lambda r: reqs.append(r.url))
        page.on('response', lambda r: bad.append((r.status, r.url)) if r.status >= 400 else None)
        page.on('pageerror', lambda e: errs.append(str(e)))
        page.on('console', lambda m: errs.append('console:' + m.text) if m.type == 'error' else None)

        # ---- A: the dial, flag off
        open_radio(page)
        out['A_cards'] = page.locator('.dial-card[data-station]').count()
        out['A_card_names'] = page.eval_on_selector_all('.dial-card[data-station] .dial-name', 'els => els.map(e => e.textContent)')
        out['A_card_dials'] = page.eval_on_selector_all('.dial-card[data-station] .dial-num', 'els => els.map(e => e.textContent)')
        out['A_names_match_pack_json'] = sorted(out['A_card_names']) == sorted(v[0] for v in pack_names.values())
        out['A_labels'] = page.eval_on_selector_all('.dial-card[data-station] .dial-badge', 'els => [...new Set(els.map(e => e.textContent))]')
        out['A_first_card_text'] = page.inner_text('.dial-card[data-station]')
        out['A_style_cards_flag_off'] = page.locator('.dial-card[data-style]').count()
        out['A_you_radio_rows_flag_off'] = page.locator('.radio-ai-sec .radio-row').count()
        out['A_internet_radio_heading'] = page.inner_text('.radio-net-head')
        out['A_hour'] = page.evaluate('new Date().getHours()')
        out['A_order'] = [c.get_attribute('data-station') for c in page.locator('.dial-card[data-station]').all()]
        page.screenshot(path=SHOTS + '/01-dial-flag-off.png')
        scan(page)

        # ---- B: start a canned station
        card = page.locator('.dial-card[data-station="meridian-91-5"]')
        reqs_before = len(reqs)
        card.click()
        page.wait_for_selector('.pw-label', state='visible', timeout=10000)
        out['B_label'] = page.inner_text('.pw-label')
        out['B_station_line'] = page.inner_text('[data-pw-station]')
        page.wait_for_function('document.querySelector(".ai-now-title") && document.querySelector(".ai-now-title").textContent !== "Tuning in…"', timeout=20000)
        out['B_now_title'] = page.inner_text('.ai-now-title')
        out['B_radio_now'] = page.inner_text('.radio-now')
        out['B_requests_for_start'] = [u.replace(ORIGIN, '') for u in reqs[reqs_before:] if not u.startswith('data:') and not u.startswith('blob:')]
        samples = []; caps_seen = []; shot = False; t1 = time.time()
        page.evaluate('''() => { window.__fast = []; const ctx = window.__bus.context; setInterval(() => window.__fast.push([ctx.currentTime, window.__bus.gain.value]), 5); }''')
        while time.time() - t1 < 40:
            s = page.evaluate('({g: window.__bus ? window.__bus.gain.value : null, sp: !!window.speechSynthesis.speaking})')
            caps = page.locator('.ai-cap').all_inner_texts()
            if caps and caps[-1] not in caps_seen: caps_seen.append(caps[-1])
            samples.append((round(time.time() - t1, 2), s['g'], s['sp']))
            if s['sp'] and not shot and s['g'] is not None and s['g'] < 0.4:
                page.screenshot(path=SHOTS + '/03-canned-on-air-ducked.png'); shot = True
            time.sleep(0.1)
        out['B_captions_seen'] = caps_seen
        sp = [x for x in samples if x[2]]; idle = [x for x in samples if not x[2] and x[0] > 2]
        out['B_gain_while_speaking_min'] = min([x[1] for x in sp]) if sp else None
        out['B_gain_idle_median'] = sorted([x[1] for x in idle])[len(idle)//2] if idle else None
        out['B_duck_down_and_back'] = bool(sp) and min(x[1] for x in sp) < 0.3 and bool(idle) and sorted([x[1] for x in idle])[len(idle)//2] > 0.95
        fast = page.evaluate('window.__fast')
        slopes = []; j = 0
        for i in range(len(fast)):
            while j < len(fast) and fast[j][0] - fast[i][0] < 0.02: j += 1
            if j < len(fast): slopes.append(abs(fast[j][1] - fast[i][1]) / (fast[j][0] - fast[i][0]))
        out['B_max_gain_slope_per_s'] = round(max(slopes), 2) if slopes else None
        out['B_expected_slope_per_s'] = round((1 - 0.1995) / 0.22, 2)
        spoken = page.evaluate('window.__speech.spoken.map(s => ({voice: s.voice, rate: +s.rate.toFixed(2), pitch: +s.pitch.toFixed(2), text: s.text.slice(0, 50)}))')
        out['B_distinct_voice_rate_pitch'] = len({(s['voice'], s['rate'], s['pitch']) for s in spoken})
        out['B_voices_used'] = sorted({s['voice'] for s in spoken if s['voice']})
        out['B_spoken_sample'] = spoken[:8]
        out['B_speaker_names_in_captions'] = [c.split(':')[0] for c in caps_seen]
        page.screenshot(path=SHOTS + '/04-canned-playing.png')
        # open the voices section for a screenshot
        page.click('.ai-voices summary'); time.sleep(0.3)
        out['B_voice_rows'] = page.locator('.pw-voice-row').count()
        page.screenshot(path=SHOTS + '/05-canned-cast-and-voices.png')
        page.click('.ai-voices summary')
        # skip
        t_before = page.inner_text('.ai-now-title'); c0 = page.evaluate('window.__speech.cancels')
        page.click('.ai-controls [data-act="skip"]')
        page.wait_for_function('(t) => document.querySelector(".ai-now-title").textContent !== t', arg=t_before, timeout=10000)
        out['B_skip_title_before_after'] = [t_before, page.inner_text('.ai-now-title')]
        time.sleep(1.0)
        out['B_gain_after_skip'] = page.evaluate('window.__bus.gain.value')
        # favourite via the card star, recents, store
        page.click('.dial-card[data-station="meridian-91-5"] .dial-star')
        time.sleep(0.2)
        out['B_fav_pressed'] = page.get_attribute('.dial-card[data-station="meridian-91-5"] .dial-star', 'aria-pressed')
        out['B_store'] = json.loads(page.evaluate('localStorage.getItem("runout.radio.v1")'))
        out['B_store_keys'] = {'favs': [e['k'] for e in out['B_store']['favs']], 'recents': [e['k'] for e in out['B_store']['recents']], 'last': out['B_store']['last']['k']}
        out['B_saved_sections'] = page.eval_on_selector_all('.radio-saved .radio-sec-head span', 'els => els.map(e => e.textContent)')
        del out['B_store']

        # ---- C: offline mid-show, then restart while offline
        ctx.set_offline(True)
        out['C_navigator_online'] = page.evaluate('navigator.onLine')
        n = len(reqs); title_c = page.inner_text('.ai-now-title')
        try:
            page.wait_for_function('(t) => document.querySelector(".ai-now-title").textContent !== t', arg=title_c, timeout=100000)
            out['C_joined_next_song_offline'] = True
        except Exception:
            out['C_joined_next_song_offline'] = 'TIMEOUT'
        caps_before = len(page.evaluate('window.__speech.spoken'))
        time.sleep(30)
        out['C_spoke_more_while_offline'] = len(page.evaluate('window.__speech.spoken')) > caps_before
        out['C_new_requests_mid_show'] = [u for u in reqs[n:] if not u.startswith('data:') and not u.startswith('blob:')]
        page.screenshot(path=SHOTS + '/06-offline-still-playing.png')
        # stop at once (the pill) then start the same station again, still offline
        page.click('.radio-now .theme-btn')
        time.sleep(0.8)
        out['C_stopped_phase_hidden'] = page.evaluate('document.querySelector(".ai-panel").classList.contains("hidden")')
        n2 = len(reqs)
        page.click('.dial-card[data-station="meridian-91-5"]')
        page.wait_for_function('document.querySelector(".ai-now-title") && document.querySelector(".ai-now-title").textContent !== "Tuning in…"', timeout=20000)
        time.sleep(3)
        out['C_restart_offline_title'] = page.inner_text('.ai-now-title')
        out['C_restart_offline_new_requests'] = [u for u in reqs[n2:] if not u.startswith('data:') and not u.startswith('blob:')]
        ctx.set_offline(False)

        # ---- D: Stop signs off then stops
        page.click('.ai-controls [data-act="stop"]')
        time.sleep(0.6)
        out['D_stop_label_while_signing_off'] = page.inner_text('.ai-controls [data-act="stop"]')
        out['D_note'] = page.inner_text('.ai-card .ai-note')
        try:
            page.wait_for_function('document.querySelector(".ai-panel").classList.contains("hidden")', timeout=60000)
            out['D_stopped_after_sign_off'] = True
        except Exception:
            out['D_stopped_after_sign_off'] = 'TIMEOUT'
        out['D_gain_after'] = page.evaluate('window.__bus.gain.value')

        # ---- persistence across reload, rescan, Resume
        page.reload()
        page.wait_for_function('document.getElementById("latency") && !/boot error/.test(document.getElementById("latency").textContent)')
        time.sleep(0.4); page.click('#btnLibrary'); page.click('.lib-tab[data-tab="radio"]'); page.wait_for_selector('.dial-card')
        out['E0_fav_after_reload'] = page.get_attribute('.dial-card[data-station="meridian-91-5"] .dial-star', 'aria-pressed')
        out['E0_saved_sections'] = page.eval_on_selector_all('.radio-saved .radio-sec-head span', 'els => els.map(e => e.textContent)')
        out['E0_resume_text'] = page.inner_text('.radio-resume')
        page.click('.radio-resume')  # library not re-scanned yet: friendly empty message
        page.wait_for_function('document.querySelector(".ai-note") && document.querySelector(".ai-note").textContent.length > 0', timeout=10000)
        out['E0_empty_library_note'] = page.inner_text('.ai-card .ai-note')
        page.screenshot(path=SHOTS + '/07-empty-library.png')
        page.click('.radio-now .theme-btn')
        scan(page)
        page.click('.radio-resume')
        page.wait_for_function('document.querySelector(".ai-now-title") && document.querySelector(".ai-now-title").textContent !== "Tuning in…" && document.querySelector(".ai-now-title").textContent !== "Nothing to play yet"', timeout=20000)
        out['E0_resume_plays'] = page.inner_text('.ai-now-title')
        page.click('.radio-now .theme-btn'); time.sleep(0.5)

        # ---- E: flag on: AI style cards, You Radio row, audition
        page.check('#aiStationsToggle')
        page.wait_for_selector('.dial-card[data-style]')
        out['F_style_cards'] = page.eval_on_selector_all('.dial-card[data-style] .dial-name', 'els => els.map(e => e.textContent)')
        out['F_style_status'] = page.eval_on_selector_all('.dial-card[data-style] .dial-badge', 'els => [...new Set(els.map(e => e.textContent))]')
        out['F_style_data_startable'] = page.eval_on_selector_all('.dial-card[data-style]', 'els => [...new Set(els.map(e => e.getAttribute("data-startable")))]')
        out['F_style_cards_greyed'] = page.eval_on_selector_all('.dial-card[data-style]', 'els => els.every(e => e.classList.contains("grey"))')
        out['F_you_radio_row'] = page.locator('.radio-ai-sec .radio-row').count()
        out['F_canned_cards_still'] = page.locator('.dial-card[data-station]').count()
        page.locator('.dial-card[data-style="signal-pirate"]').scroll_into_view_if_needed()
        page.screenshot(path=SHOTS + '/02-dial-flag-on-ai-styles.png')
        page.click('.dial-card[data-style="signal-pirate"]')
        time.sleep(0.3)
        out['F_info_visible'] = page.locator('.dial-card[data-style="signal-pirate"] .dial-info').is_visible()
        out['F_info_text'] = page.inner_text('.dial-card[data-style="signal-pirate"] .dial-info')[:400]
        out['F_started_anything'] = page.evaluate('!document.querySelector(".radio-now").classList.contains("hidden")')
        page.screenshot(path=SHOTS + '/08-ai-style-info.png')
        before = len(page.evaluate('window.__speech.spoken'))
        page.click('.dial-card[data-style="signal-pirate"] [data-audition="odile"]')
        time.sleep(2.5)
        # let it read through (10 lines)
        page.wait_for_function('window.__speech.spoken.length >= %d' % (before + 10), timeout=90000)
        aud = page.evaluate('window.__speech.spoken.slice(%d).map(s => ({text: s.text, rate: +s.rate.toFixed(2), pitch: +s.pitch.toFixed(2)}))' % before)
        out['F_audition_lines'] = len(aud); out['F_audition_first'] = aud[0]; out['F_audition_last'] = aud[-1]
        out['F_audition_rate_pitch_set'] = sorted({(a['rate'], a['pitch']) for a in aud})

        ext = [u for u in reqs if not local(u)]
        out['external_requests'] = ext
        out['http_errors_main'] = [x for x in bad if '/audio/' not in x[1]]
        out['page_errors'] = errs[:10]
        ctx.close()

        # ---- F: audio pack (stub manifest + generated Opus through request interception)
        opus_path = os.path.join(SP, 'seg.opus'); make_opus(opus_path, 2)
        opus = open(opus_path, 'rb').read()
        pack = json.load(open(os.path.join(ROOT, 'content/stations/tape-hiss-fm.json')))
        plain = [s for s in pack['segments'] if not s['usesSlots']]
        bad_ids = {s['id'] for s in plain if s['kind'] in ('banter', 'callin')}          # served as garbage: decode error -> TTS
        segs = [{'id': s['id'], 'kind': s['kind'], 'file': s['id'] + '.opus', 'durationSec': 2.0 if s['id'] not in bad_ids else 4.0, 'sha256': 'x', 'bytes': len(opus), 'lufs': -19,
                 'alt': [{'file': s['id'] + '.m4a'}]} for s in plain]
        manifest = {'v': 1, 'station': 'tape-hiss-fm', 'codec': 'opus', 'bitrateKbps': 24, 'targetLufs': -19, 'segments': segs}
        idx2 = json.loads(json.dumps(idx))
        for s in idx2['stations']:
            if s['id'] == 'tape-hiss-fm': s['audio'] = True
        ctx2 = b.new_context(viewport={'width': 412, 'height': 860}, device_scale_factor=2)
        ctx2.add_init_script('window.showDirectoryPicker = undefined; try { localStorage.setItem("runout.wtDone", "1"); } catch(e) {}')
        ctx2.add_init_script(BUS_HOOK); ctx2.add_init_script(FAKE_SPEECH)
        audio_reqs = []
        def route(r):
            u = r.request.url
            if u.endswith('/content/stations/index.json'): return r.fulfill(status=200, content_type='application/json', body=json.dumps(idx2))
            if u.endswith('/content/audio/tape-hiss-fm/manifest.json'): return r.fulfill(status=200, content_type='application/json', body=json.dumps(manifest))
            if '/content/audio/tape-hiss-fm/' in u:
                f = u.rsplit('/', 1)[1]; audio_reqs.append(f)
                sid = f.rsplit('.', 1)[0]
                if f.endswith('.m4a'): return r.fulfill(status=200, content_type='audio/mp4', body=b'not really an m4a')
                if sid in bad_ids: return r.fulfill(status=200, content_type='audio/ogg', body=b'garbage that is not ogg opus at all' * 40)
                return r.fulfill(status=200, content_type='audio/ogg', body=opus)
            if '/audio/tape-hiss-fm/' in u or u.endswith('/stations/index.json') and '/content/' not in u: return r.fulfill(status=404, body='')
            r.continue_()
        ctx2.route('**/*', route)
        pg = ctx2.new_page()
        e2 = []
        pg.on('pageerror', lambda e: e2.append(str(e)))
        pg.on('console', lambda m: e2.append('console:' + m.text) if m.type == 'error' else None)
        open_radio(pg); scan(pg)
        pg.evaluate('''() => { window.__can = {}; const a = document.createElement('audio'); window.__can.opus = a.canPlayType('audio/ogg; codecs="opus"'); window.__can.m4a = a.canPlayType('audio/mp4; codecs="mp4a.40.2"'); }''')
        out['G_canPlayType'] = pg.evaluate('window.__can')
        pg.click('.dial-card[data-station="tape-hiss-fm"]')
        pg.wait_for_function('document.querySelector(".ai-now-title") && document.querySelector(".ai-now-title").textContent !== "Tuning in…"', timeout=20000)
        t0 = time.time(); caps2 = []
        while time.time() - t0 < 150:
            caps = pg.locator('.ai-cap').all_inner_texts()
            if caps and caps[-1] not in caps2: caps2.append(caps[-1])
            time.sleep(0.15)
        out['G_audio_files_requested'] = sorted(set(audio_reqs))[:12]
        out['G_opus_requests'] = len([f for f in audio_reqs if f.endswith('.opus')])
        out['G_m4a_requests'] = len([f for f in audio_reqs if f.endswith('.m4a')])
        out['G_tts_lines_spoken'] = pg.evaluate('window.__speech.spoken.length')
        out['G_tts_sample'] = pg.evaluate('window.__speech.spoken.slice(0, 4).map(s => s.text.slice(0, 50))')
        out['G_captions'] = caps2[:10]
        out['G_recordings_note'] = pg.evaluate('document.querySelector(".ai-card .ai-note").textContent')
        pg.click('.ai-voices summary'); time.sleep(0.2)
        out['G_voices_text'] = pg.inner_text('[data-voices] .ai-note')[:200]
        pg.screenshot(path=SHOTS + '/09-audio-pack-mode.png')
        out['G_page_errors'] = e2[:10]
        ctx2.close(); b.close()
    print(json.dumps(out, indent=1, default=str))

run()
