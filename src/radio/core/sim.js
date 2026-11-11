// ─────────────────────────────────────────────────────────────────────────────
// sim.js — deterministic "simulated show" (architecture 11 P2 exit, 13).
//
// Runs a whole show on a VIRTUAL clock through the real core (ShowClock, repairRundown,
// song-select, grounding verifier, scheduler) with adapters injected, so the P2 exit
// criteria ("unattended show, zero audible dead air, every script passes the verifier")
// can be asserted in CI with no network and no audio. In P2 the same orchestration moves
// into the show runner and the fakes are swapped for real adapters (README).
//
//   const a = makeFakeAdapters({ scenario: 'rainy-commute' });
//   a.writer.inject('hallucinate');                          // failure injection
//   const report = await runSimulatedShow({ adapters: a, durationSec: 2700 });
//
// Time model: a task that starts at show-time t runs against the virtual clock set to t and
// finishes at t + (sum of its adapters' delays); its product is only usable from then on.
// A slot whose talk audio is not ready 8 s before air is DROPPED (ladder rung 2), a song
// not decoded by its start is replaced by the last decoded track or a local filler
// (rungs 4/3); the show never goes silent.
// ─────────────────────────────────────────────────────────────────────────────

import { ShowClock, LEAD } from './show-clock.js';
import { repairRundown, musicOnlySlots, OVERLAY_KINDS } from './director-client.js';
import { planSongs } from './song-select.js';
import { verifyScript, nextStepAfterVerify, writerFacts, dropStaleUtterances } from './grounding.js';
import { validateScript } from './schemas.js';
import { scheduleShow, findDeadAir, deadAirLadder, SCHED } from './scheduler.js';
import { cannedScript, breakScript, LOCAL_STINGERS } from './canned.js';
import {
  FakeContext, FakeDirector, FakeWriter, FakeVoice, FakeDecoder, FakeStt, FakeBrain, createVirtualClock, AdapterError,
} from './fake-adapters.js';
import { FIXTURE_NOW_MS, snapshotFixture } from './fixtures.js';
import { extractCuesFromEnvelope, synthEnvelope, songPlan, toLibraryCues } from './cues.js';
import { hashSeed } from './util.js';

/** A full set of fakes on one virtual clock. delays are per-call milliseconds (CONFIGURED, not measured). */
export function makeFakeAdapters({ scenario = 'rainy-commute', seed = 1, startMs = FIXTURE_NOW_MS, delays = {} } = {}) {
  const clock = createVirtualClock(startMs);
  const d = { context: 200, director: 2500, writer: 1800, voice: 250, decoder: 3000, ...delays };
  return {
    clock,
    context: new FakeContext({ clock, scenario, seed, delayMs: d.context }),
    director: new FakeDirector({ clock, seed, delayMs: d.director }),
    writer: new FakeWriter({ clock, seed, delayMs: d.writer }),
    voice: new FakeVoice({ clock, seed, delayMs: d.voice }),
    decoder: new FakeDecoder({ clock, seed, delayMs: d.decoder }),
    stt: new FakeStt({ clock, seed }),
    brain: new FakeBrain({ clock, seed }),
  };
}

/**
 * Cues the way the P2 pipeline will produce them: synthesize an envelope whose structure follows the candidate's
 * hand-set cues (a 'low'-confidence candidate gets a gradual build with no clear step, so the extractor honestly
 * reports low/null), run extractCuesFromEnvelope, and use the result. `overrides[trackId]` (hand-set, partial)
 * wins key by key. Pure and deterministic; cached per candidate by the caller.
 */
export function extractedCuesFor(cand, overrides = null) {
  const h = cand.cues || {};
  const dur = cand.durationSec;
  const ov = overrides && overrides[cand.trackId];
  if (!Number.isFinite(dur) || dur < 20 || !Number.isFinite(h.introEndSec) || !Number.isFinite(h.outroStartSec)) return toLibraryCues(null, ov || h);
  const lead = 0.5 + (hashSeed(cand.trackId) % 3) * 0.5;
  const gradual = h.confidence === 'low';
  const plan = songPlan({
    durationSec: dur, leadSilenceSec: lead, introEndSec: h.introEndSec, outroStartSec: h.outroStartSec,
    fadeEndSec: dur - 1.5, riseSec: gradual ? Math.max(0.6, h.introEndSec - lead - 0.1) : 0.6,
  });
  const r = extractCuesFromEnvelope(synthEnvelope(plan, Math.round(dur * 5)), { durationSec: dur, absolute: true });
  return toLibraryCues(r, ov);
}

const COMMIT_LOOKAHEAD_SEC = LEAD.talkCutoffSec; // talk audio must exist by T-8; commit decisions are taken then

export async function runSimulatedShow({
  adapters = makeFakeAdapters(), durationSec = 2700, seed = 1, crossfade = 'album', tickSec = 1,
  scenario = 'rainy-commute', retryDirectorAfterSec = 30,
  cues = 'extracted', cueOverrides = null, // cues: 'extracted' (default) | 'handset' (fixture values as written)
} = {}) {
  const { clock, context, director, writer, voice, decoder } = adapters;
  const startMs = clock.now();
  const wall = (sec) => startMs + Math.round(sec * 1000);
  const rel = () => (clock.now() - startMs) / 1000;

  const show = new ShowClock();
  const work = new Map();
  const visibleAt = new Map();
  const songState = { playedIds: [], excludeIds: [], lastArtist: null, recentArtists: [] };
  const rep = {
    repairs: [], errors: [], fallbacks: [], dropped: [], canned: [], regenerations: 0, aired: [], decodeFailures: [],
    directorCalls: 0, badge: null, breakAired: false, played: [], replays: [],
  };
  const items = [];
  let snapshot = null;
  let baseSnapshot = null;
  let cursor = 0, t = 0, directorBusyUntil = 0, moCount = 0, lastKind = null, quota = false, lastAiredTrack = null, fillerN = 0, extension = 0;

  const getWork = (id) => { if (!work.has(id)) work.set(id, { ready: {} }); return work.get(id); };
  const degraded = () => ({ ...(baseSnapshot || snapshotFixture(scenario)), facts: [], serviceStatus: { weather: 'down', traffic: 'down', place: 'down' } });

  async function refreshContext(at) {
    clock.set(wall(at));
    try {
      snapshot = await context.getSnapshot({ nowMs: wall(at) });
      baseSnapshot = snapshot;
    } catch (e) {
      rep.errors.push({ at, stage: 'context', code: e.code || 'error' });
      snapshot = degraded();
      if (e.code === 'offline') rep.badge = 'offline_music_only';
    }
    return snapshot;
  }
  const cueCache = new Map();
  const withCues = (c) => {
    if (cues === 'handset') return cueOverrides && cueOverrides[c.trackId] ? { ...c, cues: toLibraryCues(null, { ...c.cues, ...cueOverrides[c.trackId] }) } : c;
    if (!cueCache.has(c.trackId)) cueCache.set(c.trackId, extractedCuesFor(c, cueOverrides));
    return { ...c, cues: cueCache.get(c.trackId) };
  };
  const candidates = () => (snapshot || baseSnapshot || snapshotFixture(scenario)).libraryDigest.candidates.map(withCues);

  // ── Director: keep 6–8 slots ahead ─────────────────────────────────────────
  async function extendRundown(at) {
    const h = show.horizon();
    if (!h.needMore || at < directorBusyUntil) return;
    rep.directorCalls++;
    await refreshContext(at);
    const prevKind = lastKind;
    let ok = false;
    try {
      const raw = await director.plan({ snapshot, wantSlots: h.want, nowMs: wall(at) });
      const r = repairRundown(raw, { snapshot, atMs: wall(at), idPrefix: `x${++extension}:`, previousKind: prevKind });
      if (!r.ok) throw new AdapterError('invalid_rundown', r.errors.join('; '));
      rep.repairs.push(...r.repairs.map((x) => ({ ...x, at })));
      show.append(r.rundown.slots);
      const doneAt = rel();
      for (const s of r.rundown.slots) visibleAt.set(s.slotId, doneAt);
      lastKind = [...r.rundown.slots].reverse().find((s) => !OVERLAY_KINDS.includes(s.kind)).kind;
      ok = true;
      quota = false;
    } catch (e) {
      rep.errors.push({ at, stage: 'director', code: e.code || 'error' });
      if (e.code === 'http_429') quota = true;
      if (e.code === 'offline') rep.badge = 'offline_music_only';
      const mo = musicOnlySlots(h.want, moCount); moCount += h.want;
      if (quota && !rep.breakAired) {
        // spend ceiling: one in-character "on a break" line, then music only (writer is not called)
        const id = `quota-break${moCount}`;
        mo.splice(1, 0, { slotId: id, kind: 'talk_break', targetSec: 15, talk: { budgetSec: 12, factIds: [], mode: 'between_songs' } });
        const w = getWork(id);
        w.script = breakScript(id); w.scriptSource = 'break'; w.snapshot = degraded(); w.ready.script = at;
        rep.breakAired = true;
      }
      show.append(mo);
      if (quota) for (const s of mo) if (s.slotId.startsWith('quota-break')) show.markDone(s.slotId, 'script');
      for (const s of mo) visibleAt.set(s.slotId, at);
      lastKind = 'song';
      rep.fallbacks.push({ at, kind: 'music_only_slots', count: mo.length });
    }
    directorBusyUntil = ok ? rel() : at + retryDirectorAfterSec;
  }

  // ── per-slot work, started at its lead time ───────────────────────────────
  async function runTask(task, now) {
    const e = show.get(task.slotId);
    const w = getWork(task.slotId);
    const slot = e.slot;
    const airAtMs = wall(e.start);
    if (task.stage === 'select') {
      const { picks, state } = planSongs([slot], candidates(), { state: songState, seed });
      Object.assign(songState, state);
      const id = picks.get(slot.slotId);
      const tr = candidates().find((x) => x.trackId === id);
      w.track = tr ? { trackId: tr.trackId, durationSec: tr.durationSec, cues: tr.cues } : null;
      w.ready.select = now;
      show.markDone(slot.slotId, 'select');
    } else if (task.stage === 'decode') {
      show.markDone(slot.slotId, 'decode');
      if (!w.track) return;
      clock.set(wall(now));
      try { await decoder.decode(w.track.trackId); w.ready.decode = rel(); }
      catch (err) { w.decodeFailed = true; rep.decodeFailures.push({ at: now, slotId: slot.slotId, code: err.code }); }
    } else if (task.stage === 'script') {
      show.markDone(slot.slotId, 'script');
      await refreshContext(now);
      const persona = snapshot.memory && snapshot.memory.persona;
      const facts = writerFacts(snapshot, (slot.talk && slot.talk.factIds) || [], airAtMs);
      let attempt = 0, script = null, source = null;
      while (script === null) {
        let raw = null;
        try { clock.set(clock.now()); raw = await writer.write({ slot, facts, persona: persona || {}, seed }); }
        catch (err) {
          rep.errors.push({ at: now, stage: 'writer', code: err.code || 'error', slotId: slot.slotId });
          if (err.code === 'http_429') { quota = true; break; }
          if (attempt < 1) { attempt++; rep.regenerations++; continue; }
          break;
        }
        if (typeof raw === 'string' || !validateScript(raw).ok) {
          rep.errors.push({ at: now, stage: 'writer', code: 'invalid_json', slotId: slot.slotId });
          if (attempt < 1) { attempt++; rep.regenerations++; continue; }
          break;
        }
        const v = verifyScript(raw, snapshot, { atMs: airAtMs });
        const step = nextStepAfterVerify(v, attempt);
        if (step.action === 'accept') { script = v.script; source = 'writer'; }
        else if (step.action === 'regenerate') { attempt++; rep.regenerations++; }
        else { script = cannedScript(slot.slotId, seed); source = 'canned'; rep.canned.push({ at: now, slotId: slot.slotId, why: 'verifier' }); }
      }
      if (script === null && quota && !rep.breakAired) { script = breakScript(slot.slotId); source = 'break'; rep.breakAired = true; }
      w.script = script; w.scriptSource = source; w.snapshot = snapshot; w.ready.script = rel();
      if (!script) w.dropReason = quota ? 'quota' : 'writer_failed';
    } else if (task.stage === 'tts') {
      show.markDone(slot.slotId, 'tts');
      if (!w.script) return;
      const startAt = Math.max(now, w.ready.script || 0);
      clock.set(wall(startAt));
      try { w.voice = await voice.render({ script: w.script }); w.ready.tts = rel(); }
      catch (err) { w.dropReason = err.code || 'tts_failed'; rep.errors.push({ at: startAt, stage: 'voice', code: err.code, slotId: slot.slotId }); }
    }
  }

  // ── commit one slot to the audible timeline ──────────────────────────────
  function sync(slotId, from, to) { if (show.begin(slotId, from)) show.complete(slotId, to); }

  /** returns false when nothing was committed and waiting is the right call */
  function commitNext(now) {
    const pending = show.pending().filter((e) => (visibleAt.get(e.slot.slotId) ?? Infinity) <= now);
    const e = pending[0];
    const before = cursor;
    if (!e) {
      // nothing to air: cold start gets the station ID stinger at once; later we only fall back to
      // local filler (rung 3) when the audible stream is about to run out (the Director may still land)
      const cold = items.length === 0;
      if (!cold && cursor - now > 1) return false;
      const st = cold ? LOCAL_STINGERS[0] : LOCAL_STINGERS[2];
      items.push({ slotId: `${cold ? 'cold' : 'fill'}${fillerN++}`, kind: cold ? 'station_id' : 'filler', stinger: st, filler: st });
      if (!cold) rep.fallbacks.push({ at: now, kind: 'local_filler' });
      cursor = scheduleShow(items, { crossfade }).endSec;
      return true;
    }
    const slot = e.slot;
    const w = getWork(slot.slotId);
    if (slot.kind === 'station_id') {
      items.push({ slotId: slot.slotId, kind: 'station_id', stinger: LOCAL_STINGERS[items.length % 2] });
    } else if (slot.kind === 'song') {
      if (!w.track && !w.ready.select) { /* select task not yet run: do it inline */ const { picks, state } = planSongs([slot], candidates(), { state: songState, seed }); Object.assign(songState, state); const tr = candidates().find((x) => x.trackId === picks.get(slot.slotId)); w.track = tr ? { trackId: tr.trackId, durationSec: tr.durationSec, cues: tr.cues } : null; }
      const ready = w.track && !w.decodeFailed && (w.ready.decode ?? Infinity) <= cursor;
      if (ready) { items.push({ slotId: slot.slotId, kind: 'song', track: w.track }); lastAiredTrack = w.track; rep.played.push(w.track.trackId); }
      else {
        const ladder = deadAirLadder({ nextSongReady: false, anyDecodedTrack: !!lastAiredTrack, online: rep.badge === null });
        if (ladder.action === 'any_decoded_track') { items.push({ slotId: slot.slotId, kind: 'song', track: lastAiredTrack }); rep.replays.push({ at: now, slotId: slot.slotId, trackId: lastAiredTrack.trackId }); rep.fallbacks.push({ at: now, kind: 'any_decoded_track', slotId: slot.slotId }); }
        else { items.push({ slotId: slot.slotId, kind: 'filler', filler: LOCAL_STINGERS[2] }); rep.fallbacks.push({ at: now, kind: 'local_filler', slotId: slot.slotId }); }
      }
    } else {
      // scripted talk
      const airSec = cursor;
      let voiceItem = null, why = null;
      if (w.script && w.voice && (w.ready.tts ?? Infinity) <= now) {
        const stale = dropStaleUtterances(w.script, wall(airSec));
        if (!stale.script.utterances.length) why = 'stale';
        else {
          const keep = new Set(stale.script.utterances.map((u) => u.id));
          voiceItem = { utterances: w.voice.utterances.filter((u) => keep.has(u.id)).map((u) => ({ id: u.id, durationSec: u.durationSec, droppable: u.droppable, pauseSec: u.pauseSec })) };
          rep.aired.push({ slotId: slot.slotId, script: stale.script, snapshot: w.snapshot, airAtMs: wall(airSec), source: w.scriptSource, rendered: w.voice.utterances.map((u) => u.rendered) });
        }
      } else why = w.dropReason || ((w.script && w.voice) ? 'tts_late' : 'not_ready');
      if (voiceItem) items.push({ slotId: slot.slotId, kind: slot.kind, voice: voiceItem });
      else { rep.dropped.push({ at: now, slotId: slot.slotId, kind: slot.kind, why }); show.drop(slot.slotId); return true; }
    }
    cursor = scheduleShow(items, { crossfade }).endSec;
    // the clock learns the ACTUAL times (an overlay takes none: it sits on the song after it)
    sync(slot.slotId, before, OVERLAY_KINDS.includes(slot.kind) ? before : cursor);
    return true;
  }

  // ── main loop ──────────────────────────────────────────────────────────────
  const maxTicks = Math.ceil((durationSec + 600) / tickSec);
  for (let i = 0; i < maxTicks && cursor < durationSec; i++) {
    t = i * tickSec;
    await extendRundown(t);
    for (const task of show.due(t)) {
      if (task.blockedBy) continue;
      if ((visibleAt.get(task.slotId) ?? Infinity) > t) continue;
      await runTask(task, t);
    }
    let guard = 0;
    while (cursor - t <= COMMIT_LOOKAHEAD_SEC && cursor < durationSec && guard++ < 20) if (!commitNext(t)) break;
  }

  const sched = scheduleShow(items, { crossfade });
  const deadAir = findDeadAir(sched.segments, { fromSec: 0, toSec: sched.endSec, toleranceSec: SCHED.deadAirToleranceSec });
  const songSec = sched.segments.filter((s) => s.kind === 'song').reduce((a, s) => a + s.durationSec, 0);
  return {
    segments: sched.segments, endSec: sched.endSec, notes: sched.notes, deadAir,
    musicFraction: songSec / sched.endSec,
    ...rep,
    adapterCalls: Object.fromEntries(['context', 'director', 'writer', 'voice', 'decoder'].map((k) => [k, adapters[k].calls.length])),
  };
}
