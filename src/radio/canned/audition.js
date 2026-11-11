// audition.js — read the audition script (voice-direction.md section 5) through the phone's own voice with a style host's
// persona rate/pitch, so the owner can judge a voice before the cloud phase exists. Works offline (system speech, T0: text +
// rate + pitch + pauses only). Browser glue over the shared system-voice adapter.

import { createSystemVoice, webSpeechBackend, capacitorBackend, resolveCapacitorTts, prepareUtterance, loadVoicePrefs } from '../offline/voice.js';
import { AUDITION_SCRIPT, hostProsody } from './ai-styles.js';

export function createAuditioner({ win = (typeof window !== 'undefined' ? window : {}), storage = null, timers = { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (t) => clearTimeout(t) } } = {}) {
  let voice = null, running = 0;
  const get = () => {
    if (voice) return voice;
    voice = createSystemVoice({
      backends: [webSpeechBackend({ synth: win.speechSynthesis, Utterance: win.SpeechSynthesisUtterance, timers }), capacitorBackend({ plugin: resolveCapacitorTts(win.Capacitor) })],
      timers, prefs: storage ? loadVoicePrefs(storage) : { a: null, b: null },
    });
    return voice;
  };
  /** -> Promise<{ok, spoken, reason?}>. hooks.onLine(text, i) fires as each line starts. */
  async function audition(styleHost, { onLine, onDone } = {}) {
    const my = ++running;
    const v = get();
    try { await v.init(); } catch { /* engine default voice still works */ }
    if (!v.available) { onDone && onDone({ ok: false, spoken: 0, reason: 'no speech engine' }); return { ok: false, spoken: 0, reason: 'no speech engine' }; }
    const pr = hostProsody(styleHost);
    const pause = (() => { const m = String(styleHost.pauseHabit || '').match(/(\d+)\D+(\d+)|(\d+)/); const n = m ? Number(m[2] || m[3] || m[1]) : 400; return Math.min(1200, Math.max(150, n)); })();
    const a = v.hosts().a;
    let spoken = 0;
    for (let i = 0; i < AUDITION_SCRIPT.length && my === running; i++) {
      const p = prepareUtterance({ id: `aud:${i}`, speaker: 'a', text: AUDITION_SCRIPT[i], style: {} });
      p.override = { voiceId: a, rate: pr.rate, pitch: pr.pitch };
      onLine && onLine(AUDITION_SCRIPT[i], i);
      const r = await v.speak(p, {});
      if (!r.ok) { onDone && onDone({ ok: false, spoken, reason: r.reason }); return { ok: false, spoken, reason: r.reason }; }
      spoken++;
      await new Promise((res) => timers.setTimeout(res, pause));
    }
    onDone && onDone({ ok: my === running, spoken });
    return { ok: my === running, spoken };
  }
  return { audition, stop() { running++; try { voice && voice.cancel(); } catch { /* */ } }, get available() { try { return !!get().available; } catch { return false; } } };
}
