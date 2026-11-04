// ─────────────────────────────────────────────────────────────────────────────
// radio-session.js — the 'radio-browser' Session: one <audio> element on a live
// stream, with alternate-URL fallback and bounded reconnect-with-backoff.
//
// No top-level browser globals: the audio element (and timers) are injected via
// `env`, so test/radio-session.test.mjs drives it with a fake element.
//
//  • Before the first sound: a dead URL moves to the station's next candidate
//    (url_resolved / url from the directory) and only errors when all are dead.
//  • After sound: a drop (error / ended / stall > STALL_MS) triggers up to
//    MAX_RECONNECTS retries at 1/2/4/8 s, phase 'reconnecting' (attempt n).
//    Attempt 0 retries the same URL; later attempts rotate through alternates.
//    The budget refills only after STABLE_MS of uninterrupted playing, so a
//    flapping stream cannot loop forever.
// ─────────────────────────────────────────────────────────────────────────────

import { classifyPlaybackFailure, reduceSession, streamCandidates, reconnectDelayMs, MAX_RECONNECTS } from './radio.js';

export const CONNECT_TIMEOUT_MS = 12000;
export const STALL_MS = 15000;
export const STABLE_MS = 30000;

export function createStreamSession(station, env = {}) {
  const audio = env.audioElement || new Audio();
  const isOnline = env.isOnline || (() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false));
  const delayFor = env.reconnectDelayMs || reconnectDelayMs;
  const connectMs = env.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  const stallMs = env.stallMs ?? STALL_MS;
  const stableMs = env.stableMs ?? STABLE_MS;
  const urls = streamCandidates(station);

  let state = { phase: 'idle', error: null };
  let cb = () => {};
  let gen = 0;            // ignore events from a superseded start()/stop()
  let idx = 0;            // candidate currently loaded
  let attempt = 0;        // reconnects used since last stable playback
  let loadId = 0;         // one per load(); a stale play() rejection must not double-advance
  let heardSound = false; // a 'playing' event happened in this start()
  let connectTimer = null, stallTimer = null, stableTimer = null, retryTimer = null;

  const clearAll = () => { for (const t of [connectTimer, stallTimer, stableTimer, retryTimer]) clearTimeout(t); connectTimer = stallTimer = stableTimer = retryTimer = null; };
  const dispatch = (event) => { state = reduceSession(state, event); cb(state); };
  const fail = (info) => { clearAll(); dispatch({ type: 'error', failure: classifyPlaybackFailure({ online: isOnline(), ...info }) }); };
  const halt = () => { try { audio.pause(); } catch {} };

  async function load(my) {
    const lid = ++loadId;
    clearTimeout(connectTimer);
    connectTimer = setTimeout(() => { if (my === gen && state.phase !== 'playing') onDrop(my, { timedOut: true }); }, connectMs);
    audio.src = urls[idx];
    try { await audio.play(); }
    catch (e) {
      if (my !== gen || lid !== loadId || (e && e.name === 'AbortError')) return;
      if (e && e.name === 'NotAllowedError') return fail({}); // autoplay policy: needs a tap
      onDrop(my, { mediaErrorCode: audio.error ? audio.error.code : 4 });
    }
  }

  function onDrop(my, info) {
    if (my !== gen || state.phase === 'idle' || state.phase === 'error' || retryTimer) return;
    clearTimeout(connectTimer); clearTimeout(stallTimer); clearTimeout(stableTimer); stallTimer = null;
    halt();
    if (!heardSound && idx + 1 < urls.length) { idx++; return void load(my); } // dead URL: next alternate
    if (!heardSound || attempt >= MAX_RECONNECTS) return fail(info);
    if (!isOnline()) return fail({}); // no point hammering while offline; the UI offers Retry
    const n = attempt++;
    dispatch({ type: 'reconnecting', attempt: n + 1 });
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (my !== gen) return;
      if (n > 0 && urls.length > 1) idx = (idx + 1) % urls.length;
      load(my);
    }, delayFor(n));
  }

  const on = (name, fn) => audio.addEventListener(name, fn);
  on('playing', () => {
    if (state.phase === 'idle' || state.phase === 'error') return;
    clearTimeout(connectTimer); clearTimeout(stallTimer); stallTimer = null;
    heardSound = true;
    dispatch({ type: 'playing' });
    const my = gen;
    clearTimeout(stableTimer);
    stableTimer = setTimeout(() => { if (my === gen) attempt = 0; }, stableMs);
  });
  const buffering = () => {
    if (state.phase !== 'playing' && state.phase !== 'buffering') return;
    dispatch({ type: 'buffering' });
    const my = gen;
    if (!stallTimer) stallTimer = setTimeout(() => { stallTimer = null; onDrop(my, { mediaErrorCode: 2 }); }, stallMs);
  };
  on('waiting', buffering);
  on('stalled', buffering);
  on('error', () => onDrop(gen, { mediaErrorCode: audio.error ? audio.error.code : 0 }));
  on('ended', () => onDrop(gen, { mediaErrorCode: 2 })); // a live stream should never end

  return {
    onChange(fn) { cb = fn; },
    get state() { return state; },
    get urlIndex() { return idx; },
    async start() {
      const my = ++gen;
      clearAll(); idx = 0; attempt = 0; heardSound = false;
      dispatch({ type: 'play' });
      if (!urls.length) return fail({ mediaErrorCode: 4 });
      if (!isOnline()) return fail({});
      await load(my);
    },
    stop() {
      gen++; clearAll();
      try { audio.pause(); audio.removeAttribute('src'); audio.load(); } catch {}
      dispatch({ type: 'stop' });
    },
  };
}
