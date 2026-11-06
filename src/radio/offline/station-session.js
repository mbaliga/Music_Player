// ─────────────────────────────────────────────────────────────────────────────
// station-session.js — the real Session behind aiYouStation(): wires the offline adapters to the app.
//
// Session contract (stations.js): { start(), stop(), onChange(cb), state } with phase
// 'idle'|'connecting'|'playing'|'error', plus additive extras the You panel uses:
//   skip()  setBackground(bool)  voice  getView()  onEvent(cb)  usesEngine=true
// It plays through the app's existing AudioEngine (via env.aiHost, supplied by main.js), so it must NOT mute the vinyl
// bus the way a streamed station does; radio-player.js checks `usesEngine`.
//
// NO NETWORK: nothing in src/radio/offline touches fetch/XMLHttpRequest/WebSocket (test/radio-offline asserts it).
// All persistence is local: play history (play-history.js), station memory (core memory.js), voice choice (voice.js).
// ─────────────────────────────────────────────────────────────────────────────

import { loadMemory, saveMemory } from '../core/memory.js';
import { createOfflineContext, DEFAULT_PERSONA } from './context.js';
import { createOfflineDirector } from './director.js';
import { createTemplateWriter } from './writer.js';
import { recentLines } from '../core/memory.js';
import { createSystemVoice, webSpeechBackend, capacitorBackend, loadVoicePrefs, saveVoicePrefs } from './voice.js';
import { createDuckController } from './ducking.js';
import { createShowRunner } from './show-runner.js';
import { loadHistory, saveHistory } from './play-history.js';

export const LOCATION_KEY = 'runout.radio.offline.location.v1';

/** Optional, user-entered, city-level location: {lat, lon, label?} stored locally. Never requested automatically. */
export function loadLocation(storage) {
  try {
    const j = JSON.parse(storage.getItem(LOCATION_KEY));
    if (j && Number.isFinite(j.lat) && Number.isFinite(j.lon) && Math.abs(j.lat) <= 90 && Math.abs(j.lon) <= 180) {
      // city level: round to 0.1 degree (~11 km) so a precise fix is never kept
      return { lat: Math.round(j.lat * 10) / 10, lon: Math.round(j.lon * 10) / 10, label: typeof j.label === 'string' ? j.label.slice(0, 60) : '' };
    }
  } catch { /* none */ }
  return null;
}
export function saveLocation(storage, loc) {
  try {
    if (!loc) { storage.removeItem(LOCATION_KEY); return true; }
    storage.setItem(LOCATION_KEY, JSON.stringify({ lat: loc.lat, lon: loc.lon, label: loc.label || '' }));
    return true;
  } catch { return false; }
}

const PHASE = { idle: 'idle', starting: 'connecting', playing: 'playing', error: 'error', empty: 'error' };

export function createOfflineSession(station, env = {}) {
  const host = env.aiHost;
  if (!host) throw new Error('offline You station needs env.aiHost');
  const g = (typeof window !== 'undefined' ? window : {});
  const storage = env.storage || (() => { try { return g.localStorage; } catch { return null; } })() || { getItem: () => null, setItem() {}, removeItem() {} };
  const timers = env.timers || { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (t) => clearTimeout(t), setInterval: (f, ms) => setInterval(f, ms), clearInterval: (t) => clearInterval(t) };
  const now = env.now || (() => Date.now());

  let history = loadHistory(storage);
  let memory = loadMemory(storage, DEFAULT_PERSONA);
  const synth = env.speechSynthesis !== undefined ? env.speechSynthesis : g.speechSynthesis;
  const Utter = env.Utterance || g.SpeechSynthesisUtterance;
  const cap = env.capPlugin !== undefined ? env.capPlugin : (g.Capacitor && g.Capacitor.Plugins && g.Capacitor.Plugins.TextToSpeech) || null;
  const voice = env.voice || createSystemVoice({
    backends: [webSpeechBackend({ synth, Utterance: Utter, timers }), capacitorBackend({ plugin: cap })],
    timers, now, prefs: loadVoicePrefs(storage),
  });
  const context = createOfflineContext({
    getTracks: () => host.getTracks(), getHistory: () => history, getMemory: () => memory, getLocation: () => loadLocation(storage),
    utcOffsetMin: env.utcOffsetMin ?? null,
  });
  const director = createOfflineDirector({ seed: env.seed ?? 1 });
  const writer = createTemplateWriter({ seed: env.seed ?? 1, recentIds: () => recentLines(memory) });
  const duck = (() => { try { const p = host.busParam && host.busParam(); return p ? createDuckController({ param: p, now: () => host.audioNow() }) : null; } catch { return null; } })();

  let state = { phase: 'idle', error: null };
  let cb = () => {};
  const evCbs = new Set();
  const setState = (s) => { state = s; try { cb(state); } catch { /* */ } };
  const emit = (e) => {
    if (e.type === 'state') {
      const phase = PHASE[e.phase] || 'idle';
      if (phase !== state.phase || e.error !== state.error) setState({ phase, error: e.error || null, speech: e.speech });
    }
    for (const f of evCbs) { try { f(e); } catch { /* UI errors never reach the show */ } }
  };
  let voiceInit = null;
  const speechReady = () => Promise.race([voiceInit || Promise.resolve(), new Promise((r) => timers.setTimeout(r, 700))]);

  const runner = createShowRunner({
    now, timers, context, director, writer, voice, player: host, duck, seed: env.seed ?? 1,
    getTrack: (id) => host.getTracks().find((t) => t.id === id) || null,
    getHistory: () => history, setHistory: (h) => { history = h; saveHistory(storage, h); },
    getMemory: () => memory, setMemory: (m) => { memory = m; saveMemory(storage, m); },
    utcOffsetMin: env.utcOffsetMin ?? null, emit, speechReady,
  });

  return {
    usesEngine: true,
    onChange(fn) { cb = fn; },
    onEvent(fn) { evCbs.add(fn); return () => evCbs.delete(fn); },
    get state() { return state; },
    get voice() { return voice; },
    get runner() { return runner; },
    getView: () => ({ phase: runner.phase, current: runner.current, speech: runner.state.speech, speechAvailable: voice.available, engine: voice.backendName }),
    async start() {
      setState({ phase: 'connecting', error: null });
      voiceInit = voice.init().then((r) => { try { return r; } catch { return null; } }).catch(() => null);
      runner.start();
    },
    stop() { runner.stop(); },
    skip() { runner.skip(); },
    setBackground(b) { runner.setBackground(b); },
    saveVoices() { saveVoicePrefs(storage, voice.hosts()); runner.voiceChanged(); },
    setLocation(loc) { return saveLocation(storage, loc); },
    getLocation: () => loadLocation(storage),
  };
}
