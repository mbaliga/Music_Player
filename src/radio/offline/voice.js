// ─────────────────────────────────────────────────────────────────────────────
// voice.js — the Voice adapter backed by the platform's built-in TTS ("system speech").
//
// Same seam as the core's FakeVoice / the cloud TtsAdapter:  capabilities()  and  render({script, nowParts}).
// The difference is physical: system TTS cannot be rendered to an audio buffer or routed into Web Audio. So:
//   • capabilities() is honest: no SSML, no named styles, no direction, no audio tags; only `rate` and `pitch`;
//     `preRender:false, liveOnly:true`. The core's markup degrade path (degradeUtterance with this record) drops
//     everything the engine cannot do; pauses become timed gaps between spoken chunks, pitch comes from style.
//   • render() therefore does not make audio: it PREPARES each utterance (templates resolved, text made speakable,
//     pause-split into chunks, rate/pitch chosen, duration ESTIMATED from word count) and the host calls speak() at
//     air time. Estimates are used for placement (talk-over-intro) only; real timing comes from the engine's events.
//   • speak() is a small state machine over onstart / onboundary / onend / onerror with watchdogs, because engines
//     drop events (Android WebView and some desktop voices never fire onend or onstart):
//        starting --onstart--> speaking --onend--> done
//        starting --(no start within startTimeoutMs)--> failed 'no_start'      (cancelled; counts toward backend fallback)
//        speaking --(no end by estimate*1.6+2s / no boundary for 4s)--> done, assumed:true (cancelled to clear the queue)
//        any --cancel()--> failed 'cancelled'
//     speak() ALWAYS settles; it never rejects and never hangs.
//   • Backends: window.speechSynthesis (preferred) and the optional Capacitor plugin
//     @capacitor-community/text-to-speech (window.Capacitor.Plugins.TextToSpeech) as the Android fallback.
// Two "hosts" are two voice settings (voice + pitch/rate offsets), user-selectable, persisted.
// ─────────────────────────────────────────────────────────────────────────────

import { CAPS_NONE, parseMarkup, templateResolver } from '../core/markup.js';
import { speakable } from './pronounce.js';
import { WORDS_PER_SEC } from './writer.js';

export const VOICE_PREFS_KEY = 'runout.radio.offline.voices.v1';
export const TIMEOUTS = Object.freeze({ startMs: 2200, stallNoBoundaryMs: 4000, endSlackMs: 2000, endFactor: 1.6, voicesWaitMs: 1500 });

export const SYSTEM_CAPS = Object.freeze({
  ...CAPS_NONE, rate: true, pitch: true, preRender: false, liveOnly: true,
  events: Object.freeze({ start: true, end: true, boundary: true }),
});

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ── prepare one utterance (pure) ─────────────────────────────────────────────

const EMOTION_TWEAK = {
  hype: { rate: 0.06, pitch: 0.08 }, playful: { rate: 0.03, pitch: 0.05 }, hushed: { rate: -0.08, pitch: -0.05 },
  wistful: { rate: -0.06, pitch: -0.02 }, deadpan: { rate: -0.03, pitch: -0.04 }, wry: { rate: -0.02, pitch: 0.0 },
  serious: { rate: -0.03, pitch: -0.05 }, warm: { rate: 0, pitch: 0 },
};

/** Split spoken text so no chunk is long enough to trip engines that cut off long utterances. */
function sentencesOf(text, max = 180) {
  const parts = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  const out = [];
  for (const p of parts) {
    if (p.length <= max) { out.push(p); continue; }
    let cur = '';
    for (const w of p.split(/(?<=,)\s+|\s+/)) { if ((cur + ' ' + w).trim().length > max && cur) { out.push(cur.trim()); cur = w; } else cur = `${cur} ${w}`; }
    if (cur.trim()) out.push(cur.trim());
  }
  return out;
}

/**
 * Prepare an utterance for live speech.
 * -> { id, speaker, chunks:[{text, pauseAfterMs}], params:{rate, pitchMul}, durationSec, display, dropped[] }
 * `resolve` renders late-bound {{time.spoken}} etc. (call this at air time so the clock is current).
 */
export function prepareUtterance(utt, { resolve, wps = WORDS_PER_SEC } = {}) {
  const dropped = new Set();
  const { tokens } = parseMarkup(utt && utt.text);
  const chunks = [];
  let buf = '';
  const flush = (pauseAfterMs = 0) => {
    const t = speakable(buf);
    buf = '';
    if (!t && !pauseAfterMs) return;
    if (!t) { if (chunks.length) chunks[chunks.length - 1].pauseAfterMs += pauseAfterMs; return; }
    const parts = sentencesOf(t);
    parts.forEach((p, i) => chunks.push({ text: p, pauseAfterMs: i === parts.length - 1 ? pauseAfterMs : 120 }));
  };
  for (const t of tokens) {
    if (t.type === 'text') buf += t.text;
    else if (t.type === 'template') buf += resolve ? String(resolve(t.name) ?? '') : '';
    else if (t.type === 'pause') { if (t.ms >= 300) flush(t.ms); else { buf += t.ms >= 150 ? ', ' : ' '; dropped.add('pause-ms'); } }
    else if (t.type === 'breath') { flush(220); dropped.add('breath'); }
    else if (t.type === 'laugh') dropped.add('laugh');
    else if (t.type === 'em') dropped.add('emphasis');
    // sfx: played by a bus we do not have for system speech
    else if (t.type === 'sfx') dropped.add('sfx');
  }
  flush(0);
  const style = (utt && utt.style) || {};
  const tw = EMOTION_TWEAK[style.emotion] || EMOTION_TWEAK.warm;
  const pace = Number.isFinite(style.pace) ? style.pace : 1;
  const st = Number.isFinite(style.pitchSemitones) ? style.pitchSemitones : 0;
  const rate = clamp(pace + tw.rate, 0.6, 1.6);
  const pitchMul = clamp((1 + tw.pitch) * 2 ** (st / 12), 0.5, 1.6);
  if (style.direction) dropped.add('direction');
  const words = chunks.reduce((a, c) => a + (c.text.match(/\S+/g) || []).length, 0);
  const pauses = chunks.reduce((a, c) => a + c.pauseAfterMs, 0) / 1000;
  return {
    id: utt.id, speaker: utt.speaker || 'a', chunks, params: { rate, pitchMul }, droppable: !!utt.droppable,
    durationSec: Math.round((words / (wps * rate) + pauses + (utt.pauseAfterMs || 0) / 1000) * 100) / 100,
    pauseSec: Math.max(0.15, (utt.pauseAfterMs || 0) / 1000),
    display: chunks.map((c) => c.text).join(' '), dropped: [...dropped],
  };
}

// ── backends ─────────────────────────────────────────────────────────────────

/** window.speechSynthesis. `synth` and `Utterance` are injected so tests use a fake. */
export function webSpeechBackend({ synth, Utterance, timers = { setTimeout, clearTimeout } } = {}) {
  const ok = !!(synth && typeof Utterance === 'function' && typeof synth.speak === 'function');
  let cur = null;
  return {
    name: 'web-speech',
    startEvent: true,
    available: () => ok,
    async getVoices({ waitMs = 0 } = {}) {
      if (!ok) return [];
      const read = () => { try { return Array.from(synth.getVoices() || []); } catch { return []; } };
      let v = read();
      if (!v.length && waitMs > 0 && typeof synth.addEventListener === 'function') {
        await new Promise((res) => {
          let done = false;
          const fin = () => { if (!done) { done = true; try { synth.removeEventListener('voiceschanged', fin); } catch { /* */ } res(); } };
          try { synth.addEventListener('voiceschanged', fin); } catch { /* */ }
          timers.setTimeout(fin, waitMs);
        });
        v = read();
      }
      return v.map((x) => ({ id: x.voiceURI || x.name, name: x.name, lang: x.lang || '', local: x.localService !== false, default: !!x.default, _v: x }));
    },
    speak({ text, lang, voice, rate, pitch, volume = 1, on }) {
      let u;
      try {
        try { if (synth.paused) synth.resume(); } catch { /* */ }
        try { if (synth.speaking || synth.pending) synth.cancel(); } catch { /* */ }
        u = new Utterance(text);
        u.lang = lang || (voice && voice.lang) || 'en-US';
        if (voice && voice._v) u.voice = voice._v;
        u.rate = rate; u.pitch = pitch; u.volume = volume;
        u.onstart = () => on.start(); u.onend = () => on.end();
        u.onerror = (e) => on.error(e && e.error ? String(e.error) : 'error');
        u.onboundary = () => on.boundary();
        cur = u;
        synth.speak(u);
      } catch (e) { on.error(e && e.message ? e.message : 'throw'); }
      return { cancel: () => { try { synth.cancel(); } catch { /* */ } } };
    },
    cancel() { try { synth.cancel(); } catch { /* */ } cur = null; },
  };
}

/**
 * The Capacitor TextToSpeech plugin from the injected `Capacitor` global, or null. The app does not bundle plugin JS
 * (plain static files), so the proxy is made with Capacitor.registerPlugin('TextToSpeech'); that only works when the
 * native side has the plugin (isPluginAvailable), which is why the web build never calls it.
 */
export function resolveCapacitorTts(Cap) {
  try {
    if (!Cap) return null;
    if (Cap.Plugins && Cap.Plugins.TextToSpeech) return Cap.Plugins.TextToSpeech;
    if (typeof Cap.isPluginAvailable === 'function' && Cap.isPluginAvailable('TextToSpeech') && typeof Cap.registerPlugin === 'function') return Cap.registerPlugin('TextToSpeech');
  } catch { /* not available */ }
  return null;
}

/** Capacitor TextToSpeech plugin (Android/iOS). speak() resolves when the utterance finishes; no start/boundary events. */
export function capacitorBackend({ plugin } = {}) {
  const ok = !!(plugin && typeof plugin.speak === 'function');
  return {
    name: 'capacitor-tts',
    startEvent: false,
    available: () => ok,
    async getVoices() {
      if (!ok || typeof plugin.getSupportedVoices !== 'function') return [];
      try {
        const r = await plugin.getSupportedVoices();
        return (r && r.voices ? r.voices : []).map((x, i) => ({ id: `cap:${i}`, name: x.name, lang: x.lang || '', local: x.localService !== false, default: !!x.default, _index: i }));
      } catch { return []; }
    },
    speak({ text, lang, voice, rate, pitch, volume = 1, on }) {
      let live = true;
      Promise.resolve().then(() => {
        on.start(); // no real start event: the call itself is the start
        const opts = { text, lang: lang || (voice && voice.lang) || 'en-US', rate, pitch, volume, queueStrategy: 0 };
        if (voice && Number.isInteger(voice._index)) opts.voice = voice._index;
        return plugin.speak(opts);
      }).then(() => { if (live) on.end(); }, (e) => { if (live) on.error(e && e.message ? e.message : 'error'); });
      return { cancel: () => { live = false; try { plugin.stop(); } catch { /* */ } } };
    },
    cancel() { try { plugin.stop(); } catch { /* */ } },
  };
}

// ── voices / hosts ───────────────────────────────────────────────────────────

const REGION_RANK = { 'en-us': 0, 'en-gb': 1, 'en-au': 2, 'en-ca': 3, 'en-in': 4 };
/** English voices, local (offline-capable) first, then known regions, then name. */
export function englishVoices(voices) {
  return (voices || []).filter((v) => /^en([-_]|$)/i.test(v.lang || '')).sort((a, b) =>
    (b.local - a.local) || ((REGION_RANK[(a.lang || '').toLowerCase().replace('_', '-')] ?? 9) - (REGION_RANK[(b.lang || '').toLowerCase().replace('_', '-')] ?? 9))
    || (b.default - a.default) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Pick two distinct voices where possible; with one voice both hosts share it and differ by pitch/rate. */
export function defaultHostVoices(voices) {
  const en = englishVoices(voices);
  if (!en.length) return { a: null, b: null };
  const a = en[0];
  const b = en.find((v) => v.name !== a.name && v.id !== a.id) || en[0];
  return { a: a.id, b: b.id };
}

/** Per-host offsets so two hosts on ONE voice still sound like two people. */
export const HOST_OFFSET = Object.freeze({ a: { rate: 0, pitch: 1.0 }, b: { rate: -0.04, pitch: 0.86 } });

export function loadVoicePrefs(storage) {
  try {
    const j = JSON.parse(storage.getItem(VOICE_PREFS_KEY));
    if (j && j.v === 1) return { a: typeof j.a === 'string' ? j.a : null, b: typeof j.b === 'string' ? j.b : null };
  } catch { /* none */ }
  return { a: null, b: null };
}
export function saveVoicePrefs(storage, p) { try { storage.setItem(VOICE_PREFS_KEY, JSON.stringify({ v: 1, a: p.a || null, b: p.b || null })); return true; } catch { return false; } }

// ── the adapter ──────────────────────────────────────────────────────────────

/**
 * backends: ordered list, first available with voices wins; after `fallbackAfter` consecutive 'no_start' failures
 * the next backend is tried. timers/now are injected for tests.
 */
export function createSystemVoice({ backends = [], timers = { setTimeout, clearTimeout }, now = () => Date.now(), prefs = { a: null, b: null }, fallbackAfter = 2, wps = WORDS_PER_SEC, timeouts = TIMEOUTS } = {}) {
  const avail = backends.filter((b) => b && b.available());
  let active = avail[0] || null;
  let voices = [];
  let hosts = { a: prefs.a || null, b: prefs.b || null };
  let noStart = 0;
  let job = null; // the speak in flight: {cancel(reason)}
  let epoch = 0;
  const diag = { backend: active ? active.name : 'none', failures: 0, assumedEnds: 0, lastReason: null };

  const byId = (id) => voices.find((v) => v.id === id) || null;

  const api = {
    name: 'system-speech',
    capabilities: () => ({ ...SYSTEM_CAPS, available: !!active, engine: active ? active.name : 'none', startEvent: active ? active.startEvent : false }),
    get available() { return !!active; },
    get backendName() { return active ? active.name : 'none'; },
    diag,

    /** Discover voices (waits briefly for async voice lists) and choose default hosts. */
    async init() {
      for (const b of avail) {
        const v = await b.getVoices({ waitMs: timeouts.voicesWaitMs });
        if (v.length) { active = b; voices = v; break; }
      }
      if (!voices.length && active) voices = await active.getVoices({ waitMs: 0 }); // may legitimately be empty; engine default voice still works
      const d = defaultHostVoices(voices);
      for (const k of ['a', 'b']) if (!hosts[k] || !byId(hosts[k])) hosts[k] = d[k];
      diag.backend = active ? active.name : 'none';
      return { voices: englishVoices(voices), hosts: { ...hosts } };
    },
    voices: () => englishVoices(voices),
    allVoices: () => voices.slice(),
    hosts: () => ({ ...hosts }),
    setHost(which, voiceId) { if (which === 'a' || which === 'b') hosts[which] = voiceId || null; },

    /** Core Voice contract: prepare, don't synthesize. */
    async render({ script, nowParts } = {}) {
      const resolve = templateResolver(nowParts || {});
      const utterances = script.utterances.map((u) => prepareUtterance(u, { resolve, wps }));
      return { audioId: null, live: true, utterances, durationSec: utterances.reduce((a, u) => a + u.durationSec + u.pauseSec, 0), firstByteMs: 0 };
    },

    cancel() { if (job) job.cancel('cancelled'); if (active) active.cancel(); },
    get speaking() { return !!job; },

    /**
     * Speak one prepared utterance. -> Promise<{ok, reason, assumed?, startedMs, endedMs, chunks}>; never rejects.
     * hooks: { onStart(), onBoundary(), onEnd(result), onChunk(text, i) }
     */
    speak(prepared, hooks = {}) {
      if (!active) return Promise.resolve({ ok: false, reason: 'unavailable', chunks: 0 });
      if (job) job.cancel('cancelled'); // one voice at a time
      const my = ++epoch;
      const hostSet = HOST_OFFSET[prepared.speaker] || HOST_OFFSET.a;
      // `override` ({ voiceId, rate, pitch }, absolute values) lets a caller with more than two speakers (canned stations: a
      // cast of hosts, callers and characters) pick the voice per line; the two-host path above is unchanged without it.
      const ov = prepared.override && typeof prepared.override === 'object' ? prepared.override : null;
      const voice = ov ? (ov.voiceId ? byId(ov.voiceId) : null) : byId(hosts[prepared.speaker === 'b' ? 'b' : 'a']);
      const sameVoice = hosts.a === hosts.b;
      const rate = ov && Number.isFinite(ov.rate) ? clamp(ov.rate, 0.6, 1.6) : clamp(prepared.params.rate + (sameVoice ? hostSet.rate : 0), 0.6, 1.6);
      const pitch = ov && Number.isFinite(ov.pitch) ? clamp(ov.pitch, 0.5, 1.6) : clamp(prepared.params.pitchMul * (sameVoice ? hostSet.pitch : 1), 0.5, 1.6);
      const startedMs = now();
      let spokenChunks = 0, settled = false, current = null, pauseTimer = null, resolveAll;
      const done = new Promise((r) => { resolveAll = r; });

      const finish = (res) => {
        if (settled) return;
        settled = true;
        if (pauseTimer) timers.clearTimeout(pauseTimer);
        if (job && job.epoch === my) job = null;
        const out = { ...res, chunks: spokenChunks, startedMs, endedMs: now() };
        if (!res.ok && res.reason !== 'cancelled') { diag.failures++; diag.lastReason = res.reason; }
        if (res.assumed) diag.assumedEnds++;
        try { hooks.onEnd && hooks.onEnd(out); } catch { /* host callback must not break us */ }
        resolveAll(out);
      };
      job = { epoch: my, cancel: (reason = 'cancelled') => { try { current && current.cancel(); } catch { /* */ } finish({ ok: false, reason }); } };

      const speakChunk = (i) => {
        if (settled) return;
        if (i >= prepared.chunks.length) { noStart = 0; return finish({ ok: true, reason: 'done' }); }
        const ch = prepared.chunks[i];
        const est = ch.text.split(/\s+/).filter(Boolean).length / (wps * rate);
        let started = false, ended = false, sawBoundary = false, startTimer = null, stallTimer = null;
        const clear = () => { if (startTimer) timers.clearTimeout(startTimer); if (stallTimer) timers.clearTimeout(stallTimer); startTimer = stallTimer = null; };
        const next = (extraPause = 0) => { clear(); spokenChunks++; if (ch.pauseAfterMs + extraPause > 0 && i < prepared.chunks.length - 1) pauseTimer = timers.setTimeout(() => { pauseTimer = null; speakChunk(i + 1); }, ch.pauseAfterMs); else speakChunk(i + 1); };
        const armStall = () => {
          if (stallTimer) timers.clearTimeout(stallTimer);
          const ms = sawBoundary ? timeouts.stallNoBoundaryMs : est * 1000 * timeouts.endFactor + timeouts.endSlackMs;
          stallTimer = timers.setTimeout(() => {
            if (settled || ended) return;
            ended = true; diag.assumedEnds++;
            try { current && current.cancel(); } catch { /* */ }
            // started, then silence: the speech almost certainly finished (events dropped) or hung; either way clear it and go on
            next();
          }, ms);
        };
        startTimer = timers.setTimeout(() => {
          if (settled || started || ended) return;
          ended = true; clear();
          try { current && current.cancel(); } catch { /* */ }
          noStart++;
          // a dead front-end (Android WebView): try the next backend for later utterances
          if (noStart >= fallbackAfter) { const alt = avail.find((b) => b !== active); if (alt) { active = alt; diag.backend = alt.name; noStart = 0; voices = []; alt.getVoices().then((v) => { voices = v; const d = defaultHostVoices(v); for (const k of ['a', 'b']) if (!byId(hosts[k])) hosts[k] = d[k]; }); } }
          finish({ ok: false, reason: 'no_start' });
        }, timeouts.startMs);
        try { hooks.onChunk && hooks.onChunk(ch.text, i); } catch { /* */ }
        current = active.speak({
          text: ch.text, voice, lang: voice && voice.lang, rate, pitch,
          on: {
            start: () => { if (settled || started) return; started = true; if (startTimer) timers.clearTimeout(startTimer); startTimer = null; noStart = 0; if (spokenChunks === 0 && i === 0) { try { hooks.onStart && hooks.onStart(); } catch { /* */ } } armStall(); },
            boundary: () => { if (settled || ended) return; sawBoundary = true; try { hooks.onBoundary && hooks.onBoundary(); } catch { /* */ } armStall(); },
            end: () => { if (settled || ended) return; ended = true; if (!started && i === 0 && spokenChunks === 0) { try { hooks.onStart && hooks.onStart(); } catch { /* */ } } next(); },
            error: (code) => {
              if (settled || ended) return; ended = true; clear();
              const cancelled = /interrupted|cancel/i.test(String(code));
              finish({ ok: false, reason: cancelled ? 'cancelled' : `error:${code}` });
            },
          },
        });
      };
      speakChunk(0);
      return done;
    },
  };
  return api;
}
