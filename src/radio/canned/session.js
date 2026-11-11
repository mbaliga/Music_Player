// ─────────────────────────────────────────────────────────────────────────────
// session.js — the Session behind a canned station (stations.js type 'canned'): wires the runner to the app.
//
// Same contract and extras as the You Radio session (offline/station-session.js): { start, stop, onChange, state } plus
// skip() signOff() setBackground() onEvent() voice getView() usesEngine=true. It plays through the app's own engine (env.aiHost,
// the same host port You Radio uses), so radio-player.js treats it as an engine-backed station.
//
// NO NETWORK FOR PLAYBACK. The only I/O is loading the station's own files from the app's origin (pack JSON, and the audio
// pack manifest + recordings when they exist): `fetch` is injectable, requests are same-origin only, and a pack is cached after
// its first load so a station already loaded plays again with the network off. In the packaged app these are local assets.
// Voice source per segment: a recording when the audio pack has one (and it keeps working), else the phone's own speech
// (speechSynthesis, then the Capacitor TTS plugin), else the station plays music only and says so.
// ─────────────────────────────────────────────────────────────────────────────

import { parsePack } from './pack.js';
import { parseStationsIndex } from './catalog.js';
import { parseAudioManifest, AUDIO_BASES } from './audio-pack.js';
import { createAudioBackend } from './audio.js';
import { assignHostVoices, loadCannedVoicePrefs, saveCannedVoicePrefs } from './voices.js';
import { createCannedRunner } from './runner.js';
import { chooseShowSource, CLOUD_AVAILABLE } from './policy.js';
import { createNetAdapter } from './net.js';
import { createSystemVoice, webSpeechBackend, capacitorBackend, resolveCapacitorTts } from '../offline/voice.js';
import { createDuckController } from '../offline/ducking.js';

export const PACK_BASES = Object.freeze(['stations', 'content/stations']);

export const INDEX_BASES = Object.freeze(['stations', 'content/stations']);
let indexCache = null;  // parsed stations index entries
const packCache = new Map();   // station id -> parsed pack
const audioCache = new Map();  // station id -> audio pack | null
export const _clearCaches = () => { packCache.clear(); audioCache.clear(); indexCache = null; };

const sameOrigin = (url, base) => { try { const u = new URL(url, base); return u.origin === new URL(base).origin; } catch { return false; } };

async function getJson(fetchFn, base, path, baseUrl) {
  const url = new URL(path, baseUrl).href;
  if (!sameOrigin(url, baseUrl)) throw new Error('refused: not the app origin');
  const r = await fetchFn(url, { credentials: 'same-origin' });
  if (!r || !r.ok) throw new Error(`HTTP ${r && r.status}`);
  return r.json();
}

/** Load (and cache) the stations index: the small list the dial renders. -> entries[] ([] when it cannot be loaded) */
export async function loadStationsIndex({ fetchFn, baseUrl } = {}) {
  if (indexCache) return indexCache;
  for (const b of INDEX_BASES) {
    try {
      const entries = parseStationsIndex(await getJson(fetchFn, b, `${b}/index.json`, baseUrl));
      if (entries.length) { indexCache = entries; return entries; }
    } catch { /* try the next base */ }
  }
  return [];
}

/** Load (and cache) a station pack. -> { ok, pack, errors } */
export async function loadStationPack(id, { fetchFn, baseUrl, file = null } = {}) {
  if (packCache.has(id)) return { ok: true, pack: packCache.get(id), errors: [] };
  const name = file || `${id}.json`;
  let lastErr = 'no source';
  for (const b of PACK_BASES) {
    try {
      const doc = await getJson(fetchFn, b, `${b}/${name}`, baseUrl);
      const r = parsePack(doc);
      if (!r.ok) return { ok: false, pack: null, errors: r.errors };
      packCache.set(id, r.pack);
      return { ok: true, pack: r.pack, errors: [] };
    } catch (e) { lastErr = e && e.message; }
  }
  return { ok: false, pack: null, errors: [lastErr] };
}

/** The optional pre-rendered voice pack for a station (absent in this build). -> { entries, base, stationId } | null */
export async function loadAudioPack(id, { fetchFn, baseUrl } = {}) {
  if (audioCache.has(id)) return audioCache.get(id);
  for (const b of AUDIO_BASES) {
    try {
      const j = await getJson(fetchFn, b, `${b}/${id}/manifest.json`, baseUrl);
      const m = parseAudioManifest(j, id);
      if (m.ok) { const ap = { entries: m.entries, base: b, stationId: id }; audioCache.set(id, ap); return ap; }
    } catch { /* not present at this base */ }
  }
  audioCache.set(id, null);
  return null;
}

const PHASE = { idle: 'idle', starting: 'connecting', playing: 'playing', error: 'error', empty: 'error' };

export function createCannedSession(station, env = {}) {
  const host = env.aiHost;
  if (!host) throw new Error('canned station needs env.aiHost');
  const g = (typeof window !== 'undefined' ? window : {});
  const storage = env.storage || (() => { try { return g.localStorage; } catch { return null; } })() || { getItem: () => null, setItem() {}, removeItem() {} };
  const timers = env.timers || { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (t) => clearTimeout(t), setInterval: (f, ms) => setInterval(f, ms), clearInterval: (t) => clearInterval(t) };
  const now = env.now || (() => Date.now());
  const fetchFn = env.fetch || (typeof fetch === 'function' ? (u, o) => fetch(u, o) : null);
  const baseUrl = env.baseUrl || (typeof document !== 'undefined' ? document.baseURI : 'http://localhost/');
  const net = env.net || createNetAdapter();
  const synth = env.speechSynthesis !== undefined ? env.speechSynthesis : g.speechSynthesis;
  const Utter = env.Utterance || g.SpeechSynthesisUtterance;
  const cap = env.capPlugin !== undefined ? env.capPlugin : resolveCapacitorTts(g.Capacitor);
  const voice = env.voice || createSystemVoice({
    backends: [webSpeechBackend({ synth, Utterance: Utter, timers }), capacitorBackend({ plugin: cap })],
    timers, now,
  });
  const audio = env.audio !== undefined ? env.audio : (typeof Audio === 'function' || env.createAudio ? createAudioBackend({ createAudio: env.createAudio, timers }) : null);
  const duck = (() => { try { const p = host.busParam && host.busParam(); return p ? createDuckController({ param: p, now: () => host.audioNow() }) : null; } catch { return null; } })();

  let state = { phase: 'idle', error: null };
  let cb = () => {};
  const evCbs = new Set();
  let pack = null, audioPack = null, assign = { byHost: {}, distinct: 0 }, prefs = {}, runner = null, voiceInit = null, gen = 0;
  const setState = (s) => { state = s; try { cb(state); } catch { /* */ } };
  const emit = (e) => {
    if (e.type === 'state') {
      const phase = PHASE[e.phase] || 'idle';
      if (phase !== state.phase || e.error !== state.error) setState({ phase, error: e.error || null, speech: e.speech });
    }
    for (const f of evCbs) { try { f(e); } catch { /* UI errors never reach the show */ } }
  };
  const speechReady = () => Promise.race([voiceInit || Promise.resolve(), new Promise((r) => timers.setTimeout(r, 700))]);
  const recompute = () => { assign = assignHostVoices(pack ? pack.hostList : [], voice.allVoices ? voice.allVoices() : [], prefs); return assign; };

  const api = {
    usesEngine: true,
    isCanned: true,
    onChange(fn) { cb = fn; },
    onEvent(fn) { evCbs.add(fn); return () => evCbs.delete(fn); },
    get state() { return state; },
    get voice() { return voice; },
    get runner() { return runner; },
    get pack() { return pack; },
    get audioPack() { return audioPack; },
    get decision() { return chooseShowSource({ online: net.isOnline(), cloudAvailable: CLOUD_AVAILABLE, flagOn: false, userStation: station, lastSource: null }); },
    voiceAssignment: () => assign,
    voicePrefs: () => ({ ...prefs }),
    getView: () => ({ phase: runner ? runner.phase : 'idle', current: runner ? runner.current : null, speech: runner ? runner.state.speech : 'off', speechAvailable: voice.available, engine: voice.backendName, recordings: !!(audioPack && audioPack.entries && audioPack.entries.size) }),
    async start() {
      const my = ++gen;
      setState({ phase: 'connecting', error: null });
      const fail = (message, kind = 'unavailable') => { if (my === gen) setState({ phase: 'error', error: { kind, message } }); };
      if (!fetchFn && !packCache.has(station.id)) return fail('This station’s script could not be loaded.');
      const r = await loadStationPack(station.id, { fetchFn, baseUrl });
      if (my !== gen) return;
      if (!r.ok) return fail('This station’s script could not be loaded. It is part of the app, so reinstalling should fix it.');
      pack = r.pack;
      // the recordings are optional and absent in this build: only look for them when the index says they were shipped
      try {
        const idx = fetchFn || indexCache ? await loadStationsIndex({ fetchFn, baseUrl }) : [];
        const e = idx.find((x) => x.id === station.id);
        audioPack = e && e.audio ? await loadAudioPack(station.id, { fetchFn, baseUrl }) : null;
      } catch { audioPack = null; }
      if (my !== gen) return;
      prefs = (loadCannedVoicePrefs(storage) || {})[station.id] || {};
      voiceInit = voice.init().then(() => { recompute(); }).catch(() => null);
      recompute();
      runner = createCannedRunner({
        now, timers, pack, voice, audio: audioPack ? audio : null, audioPack, player: host, duck, seed: env.seed ?? 1,
        getTracks: () => host.getTracks(), getVoiceAssign: () => assign, emit, speechReady, slotsInAudioMode: env.slotsInAudioMode || 'twin',
      });
      emit({ type: 'pack', pack: { id: pack.id, name: pack.name, dial: pack.dial, hosts: pack.hostList } });
      runner.start();
    },
    stop() { gen++; if (runner) runner.stop(); else setState({ phase: 'idle', error: null }); },
    /** graceful: the station signs off, then stops. A second call stops at once. */
    signOff() { if (runner) runner.signOff(); },
    skip() { if (runner) runner.skip(); },
    setBackground(b) { if (runner) runner.setBackground(b); },
    /** the owner picks a voice for one cast member; saved per station */
    setHostVoice(hostId, voiceId) {
      if (voiceId) prefs = { ...prefs, [hostId]: voiceId }; else { prefs = { ...prefs }; delete prefs[hostId]; }
      saveCannedVoicePrefs(storage, station.id, prefs);
      recompute();
      if (runner) runner.voiceChanged();
    },
    resetVoices() { prefs = {}; saveCannedVoicePrefs(storage, station.id, prefs); recompute(); if (runner) runner.voiceChanged(); },
  };
  return api;
}
