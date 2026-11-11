// ─────────────────────────────────────────────────────────────────────────────
// runner.js — the live canned show: the user's OWN songs through the engine, with a station's pre-written talk between them.
//
// Same shape as the You Radio runner (offline/show-runner.js) and built from the same parts, minus everything that exists to
// WRITE talk (no director, writer or grounding verifier: the words are fixed in the pack and were never generated at run time):
//   reused   show-state.js   the pure session reducer (phases, skip, stop, bad file, 3 speech failures = music only)
//            queue.js        the gapless policy (never more than two decoded tracks; preload 40 s ahead; join)
//            ducking.js      music-bus gain around speech/audio, released on every exit path
//            voice.js        the system-speech adapter (extended with a per-line voice override, see voices.js)
//            pronounce.js    through slots.js
//   new      chooser.js      WHAT is said and WHEN (cadence, gags, bits, cool-downs, slot fallback)
//            audio.js        pre-rendered recordings when an audio pack is present; TTS otherwise or on any failure
//
// Talk is always spoken OVER the music bed (ducked), starting so that it ends about 2 s before the next song joins; a long
// segment may run on into the next song's intro. So the music never stops for the talk and there is no dead air by construction.
//
// Failure ladder, per segment:  recording fails to load/decode -> that segment is spoken by TTS (3 failures in a row switch
// the recordings off for the session, with a visible note) -> TTS fails -> the segment is skipped -> 3 in a row -> music only,
// with a visible note. A song that will not decode is skipped silently (5 in a row stops the show with a plain message).
// All time and I/O is injected, so test/radio-canned drives it on a fake clock.
// ─────────────────────────────────────────────────────────────────────────────

import { hashSeed, mulberry32 } from '../core/util.js';
import { createQueue, reduce as queueReduce } from '../../queue.js';
import { reduceShow, initialShow } from '../offline/show-state.js';
import { prepareUtterance } from '../offline/voice.js';
import { createChooser } from './chooser.js';
import { slotValues, resolveUnit } from './slots.js';
import { chooseVoiceSource, preferTwinForAudio, captionTimeline, audioUrl } from './audio-pack.js';
import { lineVoice } from './voices.js';

export const MAX_AUDIO_FAILS = 3;
const MAX_LINE_PAUSE_MS = 1500;
const OUTRO_MAX_WAIT_MS = 25000;
const nameOf = (t) => ({ title: t && t.title, artist: t && t.artist, album: t && t.album });
const isCallinLike = (u) => !!u && (u.kind === 'callin' || u.bit);

export function createCannedRunner(deps) {
  const {
    now, timers, pack, voice, audio = null, audioPack = null, player, duck = null, getTracks, emit = () => {}, seed = 1,
    tickMs = 250, getVoiceAssign = () => ({ byHost: {} }), isPlayable = (t) => !!(t && t.file && !t.relink && t.id),
    slotsInAudioMode = 'twin', speechReady = null, cadence = {},
  } = deps;

  let st = initialShow();
  let gen = 0;
  let startMs = 0, chooser = null, cur = null, nextWork = null, q = null, triggers = [];
  let timer = null, preloadBusy = false, advanceBusy = false, background = false, laneBusy = false, signingOff = false;
  let audioFails = 0, audioDisabled = false, tracksPlayed = 0, tickBusy = false;
  const failedIds = new Set();
  const lane = [];
  const aired = [];
  const log = [];
  const diag = { dropped: [], decodeFailures: 0, skips: 0, joins: 0, colds: 0, audioAired: 0, ttsAired: 0, audioFallbacks: 0, silences: [] };
  let songState = { playedIds: [], lastArtist: null, n: 0 };
  const showSec = () => (now() - startMs) / 1000;
  const note = (type, o = {}) => { log.push({ type, atMs: now(), ...o }); if (log.length > 300) log.shift(); };
  const alive = (g) => g === gen && (st.phase === 'starting' || st.phase === 'playing');
  const sleep = (ms) => new Promise((r) => timers.setTimeout(r, ms));
  const hasAudio = () => !!(audioPack && audioPack.entries && audioPack.entries.size > 0 && audio);
  const speechCapable = () => !!(voice && voice.available) || hasAudio();
  const nameFor = (id) => (pack.hosts[id] ? pack.hosts[id].name : id);

  const preferTwin = (unit) => hasAudio() && preferTwinForAudio({ entries: audioPack.entries, unit, slotsInAudioMode, audioDisabled });

  // ── reducer plumbing (same actions as the You runner) ──────────────────────
  function dispatch(ev) {
    const r = reduceShow(st, ev);
    const prev = st;
    st = r.state;
    if (st.phase !== prev.phase || st.error !== prev.error || st.speech !== prev.speech) emit({ type: 'state', phase: st.phase, error: st.error, speech: st.speech });
    for (const a of r.actions) {
      if (a.type === 'begin') begin().catch((e) => fail(e));
      else if (a.type === 'cancel-speech') cancelSpeech();
      else if (a.type === 'restore-music') { if (duck) duck.restoreNow(); }
      else if (a.type === 'drop-next') { nextWork = null; try { player.dropNext(); } catch { /* */ } }
      else if (a.type === 'halt') halt();
      else if (a.type === 'advance') advance(a).catch((e) => fail(e));
      else if (a.type === 'notice') emit({ type: 'notice', text: a.text });
    }
  }
  function fail(e) { if (st.phase === 'starting' || st.phase === 'playing') dispatch({ type: 'fail', message: e && e.message ? e.message : 'The station stopped unexpectedly.' }); }

  function halt() {
    gen++;
    if (timer) { timers.clearInterval(timer); timer = null; }
    lane.length = 0; triggers = [];
    try { voice && voice.cancel(); } catch { /* */ }
    try { audio && audio.cancel(); } catch { /* */ }
    if (duck) duck.restoreNow();
    Promise.resolve().then(() => player.halt()).catch(() => {});
  }
  function cancelSpeech() {
    lane.length = 0;
    try { voice && voice.cancel(); } catch { /* */ }
    try { audio && audio.cancel(); } catch { /* */ }
    if (duck) duck.releaseAll();
    emit({ type: 'caption-clear' });
  }

  // ── songs: pick, load, join (the same gapless policy as You Radio and the mixtapes) ──
  function playable() { try { return (getTracks() || []).filter((t) => { try { return isPlayable(t); } catch { return false; } }); } catch { return []; } }

  function pickTrack() {
    const all = playable();
    if (!all.length) return null;
    let pool = all.filter((t) => !songState.playedIds.includes(t.id));
    if (!pool.length) { // a new round; keep the last one out so it does not repeat back to back (unless it is the only song)
      songState = { ...songState, playedIds: all.length > 1 ? songState.playedIds.slice(-1) : [] };
      pool = all.filter((t) => !songState.playedIds.includes(t.id));
      if (!pool.length) pool = all;
    }
    const rng = mulberry32(hashSeed(`${seed}:song:${songState.n}`));
    const nonRepeat = pool.filter((t) => !songState.lastArtist || String(t.artist || '') !== songState.lastArtist);
    const from = nonRepeat.length ? nonRepeat : pool;
    const t = from[Math.floor(rng() * from.length)];
    songState = { playedIds: [...songState.playedIds, t.id], lastArtist: String(t.artist || ''), n: songState.n + 1 };
    return t;
  }

  /** the song after the current one (chosen once, so what the host says matches what plays) */
  function ensureNext() {
    if (nextWork) return nextWork;
    const t = pickTrack();
    nextWork = t ? { lib: t, handle: null } : null;
    return nextWork;
  }

  function buildQueue() {
    if (!cur) return null;
    const durations = [cur.dur, nextWork ? (nextWork.lib.durationSec || null) : null];
    let qq = createQueue({ playable: [true, !!nextWork], durations });
    qq = queueReduce(qq, { type: 'start', index: 0, bytes: Math.ceil(cur.dur * 44100 * 2 * 4) }).state;
    return qq;
  }

  async function startSong(lib, info, how) {
    const g = gen;
    const dur = (info && info.durationSec) || lib.durationSec || 200;
    cur = { lib, startedMs: now(), startedSec: showSec(), dur, handle: info };
    tracksPlayed++;
    emit({ type: 'now', track: nameOf(lib), how });
    dispatch({ type: 'song-started', slotId: `song-${tracksPlayed}`, trackId: lib.id });
    if (!alive(g)) return;
    q = null; triggers = [];
    // look ahead: the next song, then the break that rides the end of this one
    ensureNext();
    q = buildQueue();
    planBreak(g);
  }

  /** decide the break for the end of the current song and arm its trigger */
  function planBreak(g) {
    if (!cur || !chooser || signingOff) return;
    if (st.speech === 'off' || background) { diag.silences.push('speech off'); return; }
    const values = slotValues({ prev: cur.lib, next: nextWork && nextWork.lib });
    const plan = chooser.plan({ nowSec: showSec(), songStartSec: cur.startedSec, songDurSec: cur.dur, values });
    if (plan.type !== 'talk') { diag.silences.push(plan.why); if (diag.silences.length > 300) diag.silences.shift(); note('silence', { why: plan.why }); return; }
    const songRef = cur;
    triggers.push({ atT: plan.startAtSec, fired: false, fire: () => enqueue({ plan, songRef, maxWaitMs: OUTRO_MAX_WAIT_MS }) });
  }

  async function coldLoad(lib, how) {
    const g = gen;
    diag.colds++;
    let info;
    try { info = await player.load(lib); }
    catch {
      diag.decodeFailures++;
      note('decode_failed', { trackId: lib.id });
      if (alive(g)) dispatch({ type: 'decode-failed', trackId: lib.id });
      return false;
    }
    if (!alive(g)) return false;
    nextWork = null;
    await startSong(lib, info, how);
    return true;
  }

  async function loadNextCold(g) {
    for (let i = 0; i < 8 && alive(g); i++) {
      const nw = ensureNext();
      if (!nw || !alive(g)) return false;
      nextWork = null;
      if (await coldLoad(nw.lib, 'cold')) return true;
    }
    return false;
  }

  async function advance(a) {
    if (advanceBusy) return;
    advanceBusy = true;
    const g = gen;
    try {
      if (a.why === 'skip') diag.skips++;
      if (a.why === 'skip' && nextWork && nextWork.handle && q && q.phase === 'ready') { if (await doJoin(0.12)) return; }
      await loadNextCold(g);
    } finally { advanceBusy = false; }
  }

  async function doJoin(fadeSec) {
    const g = gen;
    const nw = nextWork;
    if (!nw || !nw.handle) return false;
    let ok = false;
    try { ok = player.joinNext(fadeSec); } catch { ok = false; }
    if (!ok) return false;
    diag.joins++;
    try { player.adopt(nw.handle); } catch { /* */ }
    nextWork = null;
    await startSong(nw.lib, nw.handle, 'join');
    return alive(g);
  }

  async function preloadNext(g) {
    if (preloadBusy || !nextWork) return;
    preloadBusy = true;
    const nw = nextWork;
    try {
      const handle = await player.decodeNext(nw.lib);
      if (!alive(g) || nextWork !== nw) { try { player.dropNext(); } catch { /* */ } return; }
      await player.prepareNext(handle);
      if (!alive(g) || nextWork !== nw) { try { player.dropNext(); } catch { /* */ } return; }
      nw.handle = handle;
      if (q) q = queueReduce(q, { type: 'preloaded', index: 1, bytes: handle.bytes || 0 }).state;
    } catch {
      diag.decodeFailures++;
      note('preload_failed', { trackId: nw.lib.id });
      if (!alive(g)) return;
      nextWork = null;
      dispatch({ type: 'preload-failed', trackId: nw.lib.id });
      const again = ensureNext();
      if (alive(g) && cur) { q = buildQueue(); if (!again) q = buildQueue(); }
    } finally { preloadBusy = false; }
  }

  async function tick() {
    const g = gen;
    if (!alive(g) || !cur || tickBusy) return;
    tickBusy = true;
    try { await tickOnce(g); } finally { tickBusy = false; }
  }
  async function tickOnce(g) {
    let pos = null;
    try { pos = player.position(); } catch { pos = null; }
    if (!pos) return;
    for (const tr of triggers) if (!tr.fired && pos.t >= tr.atT) { tr.fired = true; try { tr.fire(); } catch { /* */ } }
    if (!q) return;
    const r = queueReduce(q, { type: 'tick', t: pos.t, T: pos.T, rate: 1 });
    q = r.state;
    for (const a of r.actions) {
      if (a.type === 'preload') preloadNext(g);
      else if (a.type === 'join') { if (!(await doJoin(a.fadeSec))) await fallbackNext(g); }
      else if (a.type === 'cold' || a.type === 'end') await fallbackNext(g);
    }
  }
  async function fallbackNext(g) {
    if (advanceBusy) return;
    advanceBusy = true;
    try { await loadNextCold(g); } finally { advanceBusy = false; }
  }

  // ── the speech lane: one voice at a time, FIFO, stale jobs dropped ─────────
  function enqueue(job) {
    if (st.speech === 'off' || background) { drop(job.plan, 'speech_off'); return; }
    lane.push({ ...job, gen, queuedAt: now() });
    pump();
  }
  async function pump() {
    if (laneBusy) return;
    laneBusy = true;
    try {
      while (lane.length) {
        const j = lane.shift();
        if (j.gen !== gen) continue;
        if (now() - j.queuedAt > j.maxWaitMs) { drop(j.plan, 'late'); continue; }
        // the song this break was planned for is gone (skipped / ended): it no longer fits, unless it is a bookend
        if (j.songRef && j.songRef !== cur && j.plan.why !== 'sign_on' && j.plan.why !== 'sign_off') { drop(j.plan, 'song_changed'); continue; }
        try { await airPlan(j); } catch (e) { note('air_error', { why: e && e.message }); }
      }
    } finally { laneBusy = false; }
  }
  function drop(plan, why) {
    diag.dropped.push({ unit: plan && plan.unit && plan.unit.id, why });
    if (diag.dropped.length > 200) diag.dropped.shift();
  }

  /** Air one planned break NOW: resolve against the real neighbours, pick the voice source, caption, duck. */
  async function airPlan(job) {
    const { plan } = job;
    const g = job.gen;
    if (speechReady) { try { await speechReady(); } catch { /* */ } }
    if (!alive(g) || st.speech === 'off') return drop(plan, 'speech_off');
    const values = slotValues({ prev: cur && cur.lib, next: nextWork && nextWork.lib });
    const unit = plan.unit;
    const resolved = resolveUnit(unit, values, { preferTwin: preferTwin(unit) });
    if (!resolved) return drop(plan, 'unresolvable');
    const entry = hasAudio() ? audioPack.entries.get(resolved.seg.id) || null : null;
    let source = chooseVoiceSource({ entry, audioDisabled, failedIds, ttsAvailable: !!(voice && voice.available), segmentId: resolved.seg.id });
    if (source === 'none') return drop(plan, 'no_voice');

    const startedSec = showSec();
    const estSec = entry && source === 'audio' ? entry.durationSec : resolved.estSec;
    chooser.commit({ ...plan, unit }, { startedSec, durSec: estSec });
    const rec = { unit: unit.id, segment: resolved.seg.id, kind: unit.kind, variant: resolved.variant, source, startSec: startedSec, durSec: estSec, lines: resolved.lines.map((l) => ({ host: l.host, text: l.text })), why: plan.why };
    aired.push(rec); if (aired.length > 400) aired.shift();
    const hold = duck ? duck.hold(`s:${unit.id}`) : null;
    emit({ type: 'speech', state: 'speaking', unit: unit.id, kind: unit.kind });
    let ok = true;
    try {
      if (source === 'audio') {
        const r = await playRecording(resolved, entry, g, job, rec);
        if (r === 'fallback') {
          // the recording failed: this segment is spoken by TTS instead (if there is a voice)
          if (voice && voice.available && alive(g)) { rec.source = 'tts'; rec.fellBack = true; diag.audioFallbacks++; ok = await speakLines(resolved, g, job, rec); }
          else ok = false;
        } else ok = r === 'ok';
      } else ok = await speakLines(resolved, g, job, rec);
    } finally {
      if (duck && hold) duck.release(hold);
      rec.durSec = Math.max(0.5, showSec() - startedSec);
      try { chooser.amend(unit.id, rec.durSec); } catch { /* */ }
      emit({ type: 'speech', state: 'idle', unit: unit.id, kind: unit.kind });
      timers.setTimeout(() => { if (!laneBusy || !lane.length) emit({ type: 'caption-fade' }); }, 3500);
    }
    return ok;
  }

  const captionOf = (resolved, line, unit) => ({ type: 'caption', speaker: line.host, name: nameFor(line.host), text: line.text, unit: unit.id, kind: unit.kind, bit: isCallinLike(unit) });

  /** TTS: per-line speak so each speaker gets their own voice; pauseAfterMs between lines. */
  async function speakLines(resolved, g, job, rec) {
    const assign = (() => { try { return getVoiceAssign() || { byHost: {} }; } catch { return { byHost: {} }; } })();
    const unit = job.plan.unit;
    const lines = resolved.lines;
    let allOk = true;
    for (let i = 0; i < lines.length; i++) {
      if (!alive(g) || background) { allOk = false; break; }
      const l = lines[i];
      const lv = lineVoice(assign.byHost && assign.byHost[l.host], l.direction);
      const prepared = prepareUtterance({ id: `${resolved.seg.id}:${i}`, speaker: 'a', text: l.text, style: {} });
      if (!prepared.chunks.length) continue;
      prepared.override = { voiceId: lv.voiceId, rate: lv.rate, pitch: lv.pitch };
      const res = await voice.speak(prepared, {
        onStart: () => { emit(captionOf(resolved, l, unit)); if (job.firstSound) { job.firstSound = false; dispatch({ type: 'first-sound' }); } },
      });
      if (res.ok) { dispatch({ type: 'speech-ok' }); diag.ttsAired += i === 0 ? 1 : 0; }
      else if (res.reason !== 'cancelled') { dispatch({ type: 'speech-failed', reason: res.reason }); allOk = false; note('speech_failed', { reason: res.reason }); break; }
      else { allOk = false; break; }
      if (i < lines.length - 1) await sleep(Math.min(MAX_LINE_PAUSE_MS, Math.max(120, Number(l.pauseAfterMs) || 250)));
    }
    return allOk;
  }

  /** A recording: one file for the whole segment; captions follow its estimated line timeline. -> 'ok' | 'fallback' | 'cancelled' */
  async function playRecording(resolved, entry, g, job, rec) {
    const unit = job.plan.unit;
    const cands = entry.candidates.map((c) => ({ url: audioUrl(audioPack.base || 'audio', audioPack.stationId || pack.id, c.file), type: c.type }));
    const tl = captionTimeline(resolved.lines, entry.durationSec);
    const capTimers = [];
    const res = await audio.play({
      candidates: cands, durationSec: entry.durationSec,
      onStart: () => {
        if (job.firstSound) { job.firstSound = false; dispatch({ type: 'first-sound' }); }
        for (const c of tl) {
          const line = { host: c.host, text: c.text };
          if (c.atSec <= 0.05) emit(captionOf(resolved, line, unit));
          else capTimers.push(timers.setTimeout(() => emit(captionOf(resolved, line, unit)), c.atSec * 1000));
        }
      },
    });
    for (const t of capTimers) timers.clearTimeout(t);
    if (res.ok) { audioFails = 0; diag.audioAired++; dispatch({ type: 'speech-ok' }); return 'ok'; }
    if (res.reason === 'cancelled') return 'cancelled';
    // a recording that will not load or decode: remember it, and after MAX_AUDIO_FAILS in a row stop trying them this session
    failedIds.add(resolved.seg.id);
    audioFails++;
    note('audio_failed', { id: resolved.seg.id, reason: res.reason });
    if (audioFails >= MAX_AUDIO_FAILS && !audioDisabled) {
      audioDisabled = true;
      emit({ type: 'notice', text: 'The recorded voices could not be played on this device, so the phone’s own voice is reading the shows instead.' });
    }
    return 'fallback';
  }

  // ── begin / stop / sign-off ────────────────────────────────────────────────
  async function begin() {
    const g = gen;
    startMs = now();
    chooser = createChooser(pack, { seed, cadence, preferTwin, durations: audioPack && audioPack.entries ? new Map([...audioPack.entries].map(([id, e]) => [id, e.durationSec])) : null });
    const first = ensureNext();
    if (!first) { dispatch({ type: 'fail', message: 'No playable songs were found.' }); return; }
    // cold start: the sign-on is spoken at once (masking the first decode); the first song loads in parallel
    if (st.speech === 'ok') {
      const so = chooser.planSignOn({ values: slotValues({ next: first.lib }), songDurSec: first.lib.durationSec || 200 });
      if (so.type === 'talk') lane.push({ plan: { ...so, why: 'sign_on' }, songRef: null, firstSound: true, maxWaitMs: 60000, gen: g, queuedAt: now() });
      pump();
    }
    timer = timers.setInterval(() => { tick().catch((e) => note('tick_error', { why: e && e.message })); }, tickMs);
    advanceBusy = true;
    let ok = false;
    try { ok = await loadNextCold(g); } finally { advanceBusy = false; }
    if (alive(g) && !ok && st.phase === 'starting') dispatch({ type: 'fail', message: 'No playable songs were found.' });
    else if (ok && alive(g) && st.phase === 'starting') dispatch({ type: 'first-sound' });
  }

  async function doSignOff() {
    const g = gen;
    signingOff = true;
    triggers = [];
    cancelSpeech();
    let aired_ = false;
    if (st.speech === 'ok' && chooser && !background) {
      const off = chooser.planSignOff({ values: slotValues({ prev: cur && cur.lib }) });
      if (off.type === 'talk') {
        emit({ type: 'signing-off' });
        try { await airPlan({ plan: { ...off, why: 'sign_off' }, songRef: null, maxWaitMs: 1e9, gen: g }); aired_ = true; } catch { /* */ }
        if (aired_ && alive(g)) await sleep(900);
      }
    }
    if (alive(g)) dispatch({ type: 'stop' });
  }

  return {
    start() {
      gen++;
      const tracks = playable().length;
      dispatch({ type: 'start', tracks, speechAvailable: speechCapable() });
    },
    stop() { dispatch({ type: 'stop' }); },
    skip() { dispatch({ type: 'skip' }); },
    /** graceful stop: the station signs off (if it has a sign-off and a voice), then stops. A second call stops at once. */
    signOff() {
      if (st.phase !== 'playing' && st.phase !== 'starting') return dispatch({ type: 'stop' });
      if (signingOff) return dispatch({ type: 'stop' });
      doSignOff().catch(() => dispatch({ type: 'stop' }));
    },
    voiceChanged() { dispatch({ type: 'voice-changed' }); },
    setBackground(b) { background = !!b; if (background) cancelSpeech(); },
    tick,
    get state() { return st; },
    get phase() { return st.phase; },
    get current() { return cur ? { track: nameOf(cur.lib), dur: cur.dur } : null; },
    get chooser() { return chooser; },
    get audioDisabled() { return audioDisabled; },
    aired, log, diag,
    get playedIds() { return songState.playedIds; },
    get queue() { return q; },
    get hasNext() { return !!(nextWork && nextWork.handle); },
  };
}
