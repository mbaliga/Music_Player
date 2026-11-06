// ─────────────────────────────────────────────────────────────────────────────
// show-runner.js — the live show for the offline You station.
//
// This is the P2 "show runner" the core README describes, in its offline form: the same pipeline
//   Context -> Director -> repairRundown -> ShowClock -> song-select -> Writer -> verifyScript -> Voice
// with adapters injected, but driven by the REAL clock and by what the audio engine reports, because system
// speech is live (see voice.js): there is no pre-rendered timeline to schedule, only moments to trigger from.
//
//   songs     decoded one at a time and handed to the engine with the gapless prepareNext/joinNext path; queue.js
//             (the same pure policy the mixtapes use) decides when to preload (40 s before the end), whether memory
//             allows it (never more than two decoded tracks), and when to join. A bad file is skipped silently.
//   talk      every break is written when its song starts, VERIFIED, and verified AGAIN at air time (stale facts,
//             regenerate once, else a canned fact-free link). Placement:
//               talk-over-intro / sign-on  at the start of the song (cue-planned by core planTalkOverIntro when the
//                                          intro cue is confident, else straight away, ducked)
//               every other break          over the previous song's outro, timed to end ~2 s before the join
//             Speech failing for any reason skips that break silently; 3 in a row switches the hosts off (music only).
//   ducking   the music bus is ducked from the moment speak() is called until the voice ends/fails/is cancelled
//             (ducking.js), so the music is back on every exit path.
//   never dead air: music is always playing; a song that will not decode is replaced by the next pick; after 5 in a
//             row the show stops with a plain message instead of idling silently.
// All time and I/O is injected (now, timers, player, voice, context...), so test/radio-offline drives it on a fake clock.
// ─────────────────────────────────────────────────────────────────────────────

import { ShowClock } from '../core/show-clock.js';
import { repairRundown, musicOnlySlots, OVERLAY_KINDS } from '../core/director-client.js';
import { planSongs } from '../core/song-select.js';
import { verifyScript, nextStepAfterVerify, writerFacts, dropStaleUtterances } from '../core/grounding.js';
import { validateScript } from '../core/schemas.js';
import { cannedScript } from '../core/canned.js';
import { planTalkOverIntro } from '../core/scheduler.js';
import { extractCuesFromEnvelope, toLibraryCues } from '../core/cues.js';
import { stripMarkup, templateResolver } from '../core/markup.js';
import { recordShow } from '../core/memory.js';
import { createQueue, reduce as queueReduce } from '../../queue.js';
import { reduceShow, initialShow } from './show-state.js';
import { makeTrackFact, localParts, daypartFor, energyFromGenre, DEFAULT_PERSONA } from './context.js';
import { recordPlay, recordSession } from './play-history.js';

const SNAPSHOT_MAX_AGE_MS = 20 * 60 * 1000;
const OUTRO_MARGIN_SEC = 2;
const MIN_TRIGGER_SEC = 12;
const INTRO_MAX_WAIT_MS = 9000;
const OUTRO_MAX_WAIT_MS = 20000;
const nameOf = (t) => ({ title: t && t.title, artist: t && t.artist, album: t && t.album });

export function createShowRunner(deps) {
  const {
    now, timers, context, director, writer, voice, player, duck = null, getTrack, emit = () => {}, seed = 1,
    getHistory = () => null, setHistory = () => {}, getMemory = () => null, setMemory = () => {}, utcOffsetMin = null, tickMs = 250,
    persona = DEFAULT_PERSONA, maxAired = 300, speechReady = null,
  } = deps;

  let st = initialShow();
  let gen = 0;
  let startMs = 0, show = null, snap = null, snapAt = 0, lastKind = null, ext = 0, moCount = 0;
  let songState = { playedIds: [], excludeIds: [], lastArtist: null, recentArtists: [] };
  let cur = null;         // { entry, cand, lib, startedMs, dur, cues, handle }
  let nextWork = null;    // { entry, cand, lib, handle|null }
  let q = null;           // mini gapless queue for cur -> next
  let triggers = [];
  let timer = null, windowBusy = false, preloadBusy = false, advanceBusy = false, background = false;
  let laneBusy = false;
  const lane = [];
  const work = new Map(); // slotId -> { cand, lib }
  const aired = [];
  const log = [];
  const diag = { dropped: [], canned: 0, regenerations: 0, decodeFailures: 0, skips: 0, joins: 0, colds: 0 };
  const offset = (ms) => (Number.isFinite(utcOffsetMin) ? utcOffsetMin : -new Date(ms).getTimezoneOffset());
  const nowParts = () => { const p = localParts(now(), offset(now())); return { hour: p.hour, minute: p.minute, daypart: daypartFor(p.hour), weekday: p.weekday, month: p.month, day: p.day }; };
  const showSec = () => (now() - startMs) / 1000;
  const note = (type, o = {}) => { log.push({ type, atMs: now(), ...o }); if (log.length > 300) log.shift(); };
  const alive = (g) => g === gen && (st.phase === 'starting' || st.phase === 'playing');

  // ── reducer plumbing ───────────────────────────────────────────────────────
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
    try { voice.cancel(); } catch { /* */ }
    if (duck) duck.restoreNow();
    Promise.resolve().then(() => player.halt()).catch(() => {});
    finishShowMemory();
  }
  function cancelSpeech() { lane.length = 0; try { voice.cancel(); } catch { /* */ } if (duck) duck.releaseAll(); emit({ type: 'caption-clear' }); }

  function finishShowMemory() {
    try {
      const mem = getMemory();
      if (mem && writer.usedIds) setMemory(recordShow(mem, { date: new Date(startMs || now()).toISOString().slice(0, 16), themes: ['offline'], lines: writer.usedIds().slice(-40), trackIds: songState.playedIds.slice(-200) }));
    } catch { /* memory is a convenience */ }
  }

  // ── snapshot / rundown / selection ────────────────────────────────────────
  async function refreshSnapshot(force = false) {
    if (!force && snap && now() - snapAt < SNAPSHOT_MAX_AGE_MS) return snap;
    snap = await context.getSnapshot({ nowMs: now(), excludeTrackIds: songState.playedIds, seed });
    snapAt = now();
    return snap;
  }
  const candidates = () => ((snap && snap.libraryDigest && snap.libraryDigest.candidates) || []);

  async function newRound() {
    // a new round after every song was played once; keep the last one out so it is not repeated back to back
    // (unless it is the only song there is)
    let many = true;
    try { many = !context.playableCount || context.playableCount() > 1; } catch { /* assume many */ }
    const keep = many ? songState.playedIds.slice(-1) : [];
    songState = { ...songState, playedIds: keep };
    await refreshSnapshot(true);
    note('new_round');
  }

  async function extendRundown(g) {
    const h = show.horizon();
    if (!h.needMore) return;
    await refreshSnapshot();
    if (!candidates().length) await newRound();
    if (!alive(g)) return;
    let slots;
    try {
      const raw = await director.plan({ snapshot: snap, wantSlots: h.want, nowMs: now() });
      const r = repairRundown(raw, { snapshot: snap, atMs: now(), idPrefix: `x${++ext}:`, previousKind: lastKind });
      if (!r.ok) throw new Error(r.errors.join('; '));
      slots = r.rundown.slots;
    } catch (e) {
      slots = musicOnlySlots(h.want, moCount); moCount += h.want;
      note('director_fallback', { why: e && e.message });
    }
    if (!alive(g)) return;
    show.append(slots);
    const lastReal = [...slots].reverse().find((s) => !OVERLAY_KINDS.includes(s.kind));
    if (lastReal) lastKind = lastReal.kind;
  }

  /** select a track for a pending song slot (idempotent) */
  async function selectFor(entry) {
    const id = entry.slot.slotId;
    if (work.has(id) && work.get(id).cand) return work.get(id);
    for (let attempt = 0; attempt < 2; attempt++) {
      const { picks, state } = planSongs([entry.slot], candidates(), { state: songState, seed });
      const pick = picks.get(id);
      const cand = pick && candidates().find((c) => c.trackId === pick);
      const lib = cand && getTrack(cand.trackId);
      if (cand && lib) { songState = { ...songState, ...state }; const w = { cand, lib }; work.set(id, w); return w; }
      if (cand && !lib) { songState = { ...songState, playedIds: [...songState.playedIds, cand.trackId] }; continue; }
      await newRound();
    }
    return null;
  }

  /** ensure the next song slot (and what follows) is selected; returns it */
  async function ensureNextSong(g) {
    for (let i = 0; i < 6; i++) {
      await extendRundown(g);
      if (!alive(g)) return null;
      const e = show.pending().find((x) => x.slot.kind === 'song');
      if (e) { const w = await selectFor(e); if (w) return { entry: e, ...w }; show.drop(e.slot.slotId); continue; }
      // no pending song: force the horizon open
      show.append(musicOnlySlots(2, moCount)); moCount += 2;
    }
    return null;
  }

  // ── scripts: write, verify, (re)generate, canned ───────────────────────────
  function breakFacts(entry, prevLib, nextLib) {
    const asOf = new Date(now()).toISOString();
    const extra = [];
    if (prevLib) extra.push(makeTrackFact('prev', prevLib, asOf));
    if (nextLib) extra.push(makeTrackFact('next', nextLib, asOf, { energy: energyFromGenre(nextLib.genre) }));
    const s = { ...snap, takenAt: asOf, facts: [...snap.facts.map((f) => ({ ...f })), ...extra] };
    const ids = [...new Set([...(entry.slot.talk && entry.slot.talk.factIds || []), ...extra.map((f) => f.id)])];
    return { s, ids };
  }
  const trackMetaOf = (s) => Object.fromEntries(s.facts.filter((f) => f.id.startsWith('trk.') && f.value && f.value.trackId).map((f) => [f.value.trackId, { title: f.value.title, artist: f.value.artist, album: f.value.album }]));

  /** -> { script, snapshot, source } or null. Verified now against `atMs`. */
  async function makeScript(entry, prevLib, nextLib, atMs) {
    if (!snap || now() - snapAt > SNAPSHOT_MAX_AGE_MS) await refreshSnapshot(true);
    const { s, ids } = breakFacts(entry, prevLib, nextLib);
    const facts = writerFacts(s, ids, atMs);
    const slot = entry.slot;
    const brief = { daypart: s.time.daypart, nextEnergy: nextLib ? (energyFromGenre(nextLib.genre) ?? undefined) : undefined };
    let attempt = 0;
    for (;;) {
      let script = null;
      try { script = await writer.write({ slot, facts, persona: (s.memory && s.memory.persona) || persona, seed, brief }); } catch { script = null; }
      if (script && validateScript(script).ok) {
        const v = verifyScript(script, s, { atMs, trackMeta: trackMetaOf(s) });
        const step = nextStepAfterVerify(v, attempt);
        if (step.action === 'accept') return { script: v.script, snapshot: s, source: 'writer' };
        if (step.action === 'regenerate') { attempt++; diag.regenerations++; continue; }
      } else if (attempt < 1) { attempt++; diag.regenerations++; continue; }
      diag.canned++;
      return { script: verifyScript(cannedScript(slot.slotId, seed), s, { atMs }).script, snapshot: s, source: 'canned' };
    }
  }

  // ── speech lane: one voice at a time, FIFO, stale jobs dropped ────────────
  function enqueueSpeech(job) {
    if (st.speech === 'off' || background) { dropBreak(job.entry, job.entry && job.entry.slot.kind === 'station_id' ? 'speech_off' : 'speech_off'); return; }
    lane.push({ ...job, gen, queuedAt: now() });
    pumpLane();
  }
  async function pumpLane() {
    if (laneBusy) return;
    laneBusy = true;
    try {
      while (lane.length) {
        const j = lane.shift();
        if (j.gen !== gen) continue;
        if (now() - j.queuedAt > j.maxWaitMs) { dropBreak(j.entry, 'late'); continue; }
        try { await j.run(); } catch { /* a bad break never stops the lane */ }
      }
    } finally { laneBusy = false; }
  }
  function dropBreak(entry, why) {
    if (!entry) return;
    diag.dropped.push({ slotId: entry.slot.slotId, why }); if (diag.dropped.length > 200) diag.dropped.shift();
    show.drop(entry.slot.slotId);
  }

  /** Air one break NOW: verify at air time, render, duck, speak, captions. */
  async function airBreak(entry, prevLib, nextLib, g, { firstSound = false } = {}) {
    if (speechReady) { try { await speechReady(); } catch { /* */ } }
    if (!alive(g) || st.speech === 'off') return dropBreak(entry, 'speech_off');
    const atMs = now();
    let made;
    try { made = await makeScript(entry, prevLib, nextLib, atMs); } catch { made = null; }
    if (!made || !alive(g)) return dropBreak(entry, 'no_script');
    // expiry at air time: facts may have gone stale while the break waited
    const fresh = dropStaleUtterances(made.script, now());
    if (!fresh.script.utterances.length) return dropBreak(entry, 'stale');
    // the final gate: the exact script that will be spoken passes the verifier at THIS moment
    const v = verifyScript(fresh.script, made.snapshot, { atMs: now(), trackMeta: trackMetaOf(made.snapshot) });
    const script = v.ok ? v.script : verifyScript(cannedScript(entry.slot.slotId, seed), made.snapshot, { atMs: now() }).script;
    const parts = nowParts();
    const resolve = templateResolver(parts);
    let rendered;
    try { rendered = await voice.render({ script, nowParts: parts }); } catch { rendered = null; }
    if (!rendered || !rendered.utterances.length || !alive(g)) return dropBreak(entry, 'render_failed');
    aired.push({ slotId: entry.slot.slotId, kind: entry.slot.kind, script, snapshot: made.snapshot, airAtMs: now(), source: v.ok ? made.source : 'canned', trackMeta: trackMetaOf(made.snapshot) });
    if (aired.length > maxAired) aired.shift();
    show.begin(entry.slot.slotId, showSec());
    const hold = duck ? duck.hold(`s:${entry.slot.slotId}`) : null;
    emit({ type: 'speech', state: 'speaking', slotId: entry.slot.slotId });
    let ok = true;
    try {
      for (let i = 0; i < rendered.utterances.length && ok; i++) {
        if (!alive(g)) break;
        const p = rendered.utterances[i];
        const su = script.utterances.find((u) => u.id === p.id) || script.utterances[i];
        const text = stripMarkup(su.text, { templates: resolve });
        const res = await voice.speak(p, {
          onStart: () => { emit({ type: 'caption', speaker: p.speaker, name: nameFor(p.speaker), text, slotId: entry.slot.slotId }); if (firstSound) dispatch({ type: 'first-sound' }); },
        });
        if (res.ok) dispatch({ type: 'speech-ok' });
        else if (res.reason !== 'cancelled') { dispatch({ type: 'speech-failed', reason: res.reason }); ok = false; note('speech_failed', { reason: res.reason }); }
        else ok = false;
        if (ok && i < rendered.utterances.length - 1) await sleep(Math.min(900, p.pauseSec * 1000));
      }
    } finally {
      if (duck && hold) duck.release(hold);
      emit({ type: 'speech', state: 'idle', slotId: entry.slot.slotId });
      timers.setTimeout(() => { if (!laneBusy || !lane.length) emit({ type: 'caption-fade' }); }, 3500);
      if (show.get(entry.slot.slotId) && show.get(entry.slot.slotId).status === 'airing') show.complete(entry.slot.slotId, showSec());
    }
  }
  const nameFor = (who) => (who === 'b' ? 'Jo' : 'Casey');
  const sleep = (ms) => new Promise((r) => timers.setTimeout(r, ms));

  // ── songs ──────────────────────────────────────────────────────────────────
  const durOf = (w, info) => (info && info.durationSec) || w.cand.durationSec || 200;

  function cuesFrom(info, cand) {
    try {
      if (info && info.envelope && info.envelope.length) return toLibraryCues(extractCuesFromEnvelope(info.envelope, { durationSec: info.durationSec }), null);
    } catch { /* fall through */ }
    return cand.cues || null;
  }

  async function startSong(entry, w, info, how) {
    const g = gen;
    if (cur) { show.complete(cur.entry.slot.slotId, showSec()); }
    const dur = durOf(w, info);
    cur = { entry, cand: w.cand, lib: w.lib, startedMs: now(), dur, cues: cuesFrom(info, w.cand), handle: info };
    show.begin(entry.slot.slotId, showSec());
    try { let h = getHistory(); if (h) { h = recordPlay(h, w.lib.id, now()); setHistory(h); } } catch { /* history is a convenience */ }
    emit({ type: 'now', track: nameOf(w.lib), slotId: entry.slot.slotId, how });
    dispatch({ type: 'song-started', slotId: entry.slot.slotId, trackId: w.cand.trackId });
    if (!alive(g)) return;
    q = null; nextWork = null; triggers = [];
    // attachments that sit BEFORE this song (sign-on, talk-over-intro) are spoken over its start
    const idx = show.entries.indexOf(entry);
    const intro = show.entries.filter((e, i) => i < idx && e.status === 'pending');
    for (const e of intro) {
      if (e.slot.kind === 'sign_on' || e.slot.kind === 'talk_over_intro') armIntro(e, w, g);
      else if (e.slot.kind !== 'song') dropBreak(e, 'skipped_over');
      else show.drop(e.slot.slotId);
    }
    // look ahead: next song + the breaks between
    const nx = await ensureNextSong(g);
    if (!alive(g) || !cur || cur.entry !== entry) return;
    if (nx) { nextWork = { ...nx, handle: null }; }
    q = buildQueue();
    armOutros(entry, nx, g);
  }

  function buildQueue() {
    if (!cur) return null;
    const durations = [cur.dur, nextWork ? (nextWork.cand.durationSec || null) : null];
    let qq = createQueue({ playable: [true, !!nextWork], durations });
    qq = queueReduce(qq, { type: 'start', index: 0, bytes: Math.ceil(cur.dur * 44100 * 2 * 4) }).state;
    return qq;
  }

  function armIntro(e, w, g) {
    const entry = e;
    const run = async () => airBreak(entry, null, w.lib, g, { firstSound: false });
    // cue-planned offset when the intro cue is confident; otherwise at once (talk-up, ducked)
    let atT = 0.4;
    const cues = cur && cur.cues;
    if (cues && cues.confidence !== 'low' && Number.isFinite(cues.introEndSec) && cues.introEndSec >= 3.5) {
      const est = Math.min(cues.introEndSec - 0.4, 8);
      const plan = planTalkOverIntro({ songStartSec: 0, cues, utterances: [{ id: 'x', durationSec: est, droppable: false }] });
      if (plan.mode === 'over_intro' && Number.isFinite(plan.voiceStartSec)) atT = Math.max(0.4, Math.min(plan.voiceStartSec, 6));
    }
    triggers.push({ atT, kind: 'intro', fired: false, fire: () => enqueueSpeech({ entry, maxWaitMs: INTRO_MAX_WAIT_MS, run }) });
  }

  function armOutros(songEntry, nx, g) {
    const idx = show.entries.indexOf(songEntry);
    const after = [];
    for (let i = idx + 1; i < show.entries.length; i++) {
      const e = show.entries[i];
      if (e.status !== 'pending') continue;
      if (e.slot.kind === 'song') break;
      if (OVERLAY_KINDS.includes(e.slot.kind) || e.slot.kind === 'sign_on') continue;
      after.push(e);
    }
    for (const e of after) {
      const entry = e;
      const run = async () => airBreak(entry, cur && cur.lib, nx && nx.lib, g);
      const est = Math.min(30, (entry.slot.talk && entry.slot.talk.budgetSec) || 20) * 0.8;
      const atT = Math.max(MIN_TRIGGER_SEC, cur.dur - est - OUTRO_MARGIN_SEC);
      triggers.push({ atT, kind: 'outro', fired: false, fire: () => enqueueSpeech({ entry, maxWaitMs: OUTRO_MAX_WAIT_MS, run }) });
    }
  }

  async function coldLoad(entry, w, how) {
    const g = gen;
    diag.colds++;
    let info;
    try { info = await player.load(w.lib); }
    catch (e) {
      diag.decodeFailures++;
      songState = { ...songState, playedIds: songState.playedIds.includes(w.cand.trackId) ? songState.playedIds : [...songState.playedIds, w.cand.trackId] };
      show.drop(entry.slot.slotId);
      note('decode_failed', { trackId: w.cand.trackId });
      if (alive(g)) dispatch({ type: 'decode-failed', trackId: w.cand.trackId });
      return false;
    }
    if (!alive(g)) return false;
    await startSong(entry, w, info, how);
    return true;
  }

  /** cold-load the next pick; a bad file is skipped silently and the next one tried (the reducer stops after five in a row) */
  async function loadNextCold(g) {
    for (let i = 0; i < 8 && alive(g); i++) {
      const nx = await ensureNextSong(g);
      if (!nx || !alive(g)) return false;
      if (await coldLoad(nx.entry, nx, 'cold')) return true;
    }
    return false;
  }

  async function advance(a) {
    if (advanceBusy) return;
    advanceBusy = true;
    const g = gen;
    try {
      if (a.why === 'skip') diag.skips++;
      // a prepared next deck: skip by joining it (short fade) so there is no gap
      if (a.why === 'skip' && nextWork && nextWork.handle && q && q.phase === 'ready') {
        if (await doJoin(0.12)) return;
      }
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
    await startSong(nw.entry, { cand: nw.cand, lib: nw.lib }, nw.handle, 'join');
    return alive(g);
  }

  async function preloadNext(g) {
    if (preloadBusy || !nextWork) return;
    preloadBusy = true;
    const nw = nextWork;
    try {
      const handle = await player.decodeNext(nw.lib);
      if (!alive(g) || nextWork !== nw) { try { player.dropNext(); } catch { /* */ } return; }
      handle.cues = cuesFrom(handle, nw.cand);
      await player.prepareNext(handle);
      if (!alive(g) || nextWork !== nw) { try { player.dropNext(); } catch { /* */ } return; }
      nw.handle = handle;
      if (q) q = queueReduce(q, { type: 'preloaded', index: 1, bytes: handle.bytes || 0 }).state;
    } catch (e) {
      diag.decodeFailures++;
      note('preload_failed', { trackId: nw.cand.trackId });
      if (!alive(g)) return;
      songState = { ...songState, playedIds: songState.playedIds.includes(nw.cand.trackId) ? songState.playedIds : [...songState.playedIds, nw.cand.trackId] };
      show.drop(nw.entry.slot.slotId);
      work.delete(nw.entry.slot.slotId);
      dispatch({ type: 'preload-failed', trackId: nw.cand.trackId });
      // choose another next track and rebuild the mini queue; the next tick preloads it
      const nx = await ensureNextSong(g);
      if (alive(g) && cur) { nextWork = nx ? { ...nx, handle: null } : null; q = buildQueue(); }
    } finally { preloadBusy = false; }
  }

  // ── tick ───────────────────────────────────────────────────────────────────
  let tickBusy = false;
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
      else if (a.type === 'cold') await fallbackNext(g);
      else if (a.type === 'end') await fallbackNext(g);
    }
  }
  async function fallbackNext(g) {
    if (advanceBusy) return;
    advanceBusy = true;
    try { await loadNextCold(g); } finally { advanceBusy = false; }
  }

  // ── begin ──────────────────────────────────────────────────────────────────
  async function begin() {
    const g = gen;
    startMs = now();
    show = new ShowClock({ startSec: 0 });
    try { const h = getHistory(); if (h) setHistory(recordSession(h)); } catch { /* */ }
    await refreshSnapshot(true);
    if (!candidates().length) { dispatch({ type: 'fail', message: 'No playable songs were found.' }); return; }
    await extendRundown(g);
    if (!alive(g)) return;
    // cold start: the station ID is spoken at once (masking the first decode); the first song loads in parallel
    const first = show.pending()[0];
    if (first && first.slot.kind === 'station_id') {
      if (st.speech === 'ok') {
        const run = async () => { await airBreak(first, null, null, g, { firstSound: true }); };
        lane.push({ entry: first, maxWaitMs: 60000, run, gen: g, queuedAt: now() });
        pumpLane();
      } else { show.begin(first.slot.slotId, 0); show.complete(first.slot.slotId, 0.1); }
    }
    timer = timers.setInterval(() => { tick().catch((e) => note('tick_error', { why: e && e.message })); }, tickMs);
    advanceBusy = true;
    let ok = false;
    try { ok = await loadNextCold(g); } finally { advanceBusy = false; }
    if (alive(g) && !ok && st.phase === 'starting') dispatch({ type: 'fail', message: 'No playable songs were found.' });
    else if (ok && alive(g) && st.phase === 'starting') dispatch({ type: 'first-sound' });
  }

  return {
    start() {
      gen++;
      const tracks = (() => { try { return context.playableCount ? context.playableCount() : 1; } catch { return 0; } })();
      dispatch({ type: 'start', tracks, speechAvailable: !!(voice && voice.available) });
    },
    stop() { dispatch({ type: 'stop' }); },
    skip() { dispatch({ type: 'skip' }); },
    voiceChanged() { dispatch({ type: 'voice-changed' }); },
    /** app went to the background: speech cannot be trusted there; cancel it and keep the music */
    setBackground(b) { background = !!b; if (background) cancelSpeech(); },
    tick,
    get state() { return st; },
    get phase() { return st.phase; },
    get current() { return cur ? { track: nameOf(cur.lib), slotId: cur.entry.slot.slotId, dur: cur.dur } : null; },
    aired, log, diag,
    get playedIds() { return songState.playedIds; },
    get clock() { return show; },
    get queue() { return q; },
    get hasNext() { return !!(nextWork && nextWork.handle); },
  };
}
