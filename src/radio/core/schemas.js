// ─────────────────────────────────────────────────────────────────────────────
// schemas.js — the data contracts (architecture 3.3) as versioned, hand-written
// validators. They are the trust boundary between the LLM/proxy and the device,
// so they run on the device too.
//
// Every validator: (value) => { ok: boolean, errors: string[] }. They NEVER throw
// (hostile input, cyclic objects, wrong types all become errors). Errors read
// "path: message" with paths like "slots[2].kind".
//
// Contracts (all carry schemaVersion = 1):
//   runout/context-snapshot/1   validateContextSnapshot   the only source of facts
//   runout/rundown/1            validateRundown           Director output
//   runout/segment/1            validateSegment           one scheduled timeline element
//   runout/script/1             validateScript            Writer output + expressive markup
//   runout/caller-turn/1        validateCallerTurn        one exchange in a live call
//   runout/station-memory/1     validateStationMemory     on-device memory (inside the snapshot)
//
// "Segment" is not in the architecture doc's 3.3 (the doc has StationMemory as its fifth
// contract); it is the scheduler's output unit and is added here because the P0 brief
// lists it. Both are validated.
// ─────────────────────────────────────────────────────────────────────────────

import { checker, guarded, isObj } from './util.js';
import { validateMarkup, TEMPLATE_NAMES } from './markup.js';

export const SCHEMA_VERSION = 1;
export const SCHEMA_IDS = Object.freeze({
  contextSnapshot: 'runout/context-snapshot/1',
  rundown: 'runout/rundown/1',
  segment: 'runout/segment/1',
  script: 'runout/script/1',
  callerTurn: 'runout/caller-turn/1',
  stationMemory: 'runout/station-memory/1',
});

export const DAYPARTS = ['early_morning', 'morning', 'midday', 'afternoon', 'evening', 'late_night'];
export const FACT_KINDS = ['weather', 'forecast', 'sun', 'traffic', 'place', 'holiday', 'listening', 'library', 'custom'];
export const SERVICE_STATES = ['ok', 'stale', 'down', 'denied'];
export const SESSION_CONTEXTS = ['unknown', 'commute', 'focus', 'workout', 'home'];
export const SLOT_KINDS = ['sign_on', 'station_id', 'song', 'talk_break', 'talk_over_intro', 'back_sell', 'weather_hit',
  'place_hit', 'traffic_hit', 'caller_open', 'caller_invite', 'sign_off'];
export const TALK_MODES = ['over_intro', 'between_songs', 'cold'];
export const EMOTIONS = ['warm', 'wry', 'hype', 'hushed', 'wistful', 'deadpan', 'playful', 'serious'];
export const SEGMENT_KINDS = ['song', 'voice', 'stinger', 'filler'];
export const SEGMENT_MODES = ['over_intro', 'pre_roll', 'between_songs', 'cold'];
export const SEGMENT_SOURCES = ['rundown', 'caller', 'alert', 'fallback'];
export const CALL_DIRECTIONS = ['listener_calls_station', 'station_calls_listener'];
export const ACTION_TYPES = ['request_song', 'note_for_show', 'end_call'];
export const SAFETY_LABELS = ['ok', 'distress', 'abuse', 'off_topic'];
export const CONFIDENCES = ['low', 'med', 'high'];

export const LIMITS = Object.freeze({
  maxSlots: 12, maxCandidates: 60, maxUtterances: 12, maxUtteranceChars: 400, maxFactSayChars: 160,
  maxTitleChars: 120, maxPurposeChars: 200, maxNoteChars: 200, maxListenerNoteChars: 160,
  maxRecentShows: 7, maxListenerNotes: 20, maxTranscriptChars: 2000, maxActions: 3,
});

const uniqueIds = (c, items, key, path) => {
  const seen = new Set();
  items.forEach((it, i) => {
    if (isObj(it) && typeof it[key] === 'string') {
      if (seen.has(it[key])) c.err(`${path}[${i}].${key}`, `duplicate ${key} "${it[key].slice(0, 40)}"`);
      seen.add(it[key]);
    }
  });
};

// ── StationMemory ────────────────────────────────────────────────────────────

export const validateStationMemory = guarded((m) => {
  const c = checker();
  if (!c.obj(m, '$')) return c.result();
  c.version(m.schemaVersion, '$');
  if (c.obj(m.persona, 'persona', { optional: true }) && m.persona) {
    for (const k of ['stationName', 'rjName', 'voiceId']) c.str(m.persona[k], `persona.${k}`, { optional: true, max: 80 });
    c.obj(m.persona.tone, 'persona.tone', { optional: true });
    c.strArr(m.persona.banned, 'persona.banned', { optional: true, max: 50 });
  }
  if (c.arr(m.recentShows, 'recentShows', { optional: true, max: LIMITS.maxRecentShows }) && m.recentShows) {
    m.recentShows.forEach((s, i) => {
      if (!c.obj(s, `recentShows[${i}]`)) return;
      c.str(s.date, `recentShows[${i}].date`, { max: 40 });
      c.strArr(s.themes, `recentShows[${i}].themes`, { optional: true, max: 10 });
      c.strArr(s.lines, `recentShows[${i}].lines`, { optional: true, max: 40 });
      c.strArr(s.trackIds, `recentShows[${i}].trackIds`, { optional: true, max: 200 });
    });
  }
  if (c.arr(m.listenerNotes, 'listenerNotes', { optional: true, max: LIMITS.maxListenerNotes }) && m.listenerNotes) {
    m.listenerNotes.forEach((n, i) => {
      const p = `listenerNotes[${i}]`;
      if (!c.obj(n, p)) return;
      c.str(n.id, `${p}.id`, { optional: true, max: 60 });
      c.str(n.text, `${p}.text`, { min: 1, max: LIMITS.maxListenerNoteChars });
      c.oneOf(n.source, `${p}.source`, ['caller', 'user_set']);
      c.str(n.at, `${p}.at`, { max: 40 });
      c.str(n.expiresAt, `${p}.expiresAt`, { max: 40, optional: true });
    });
  }
  return c.result();
});

// ── ContextSnapshot ──────────────────────────────────────────────────────────

function checkCues(c, cues, p) {
  if (!c.obj(cues, p, { optional: true }) || !cues) return;
  c.num(cues.introEndSec, `${p}.introEndSec`, { nullable: true, min: 0 });
  c.num(cues.outroStartSec, `${p}.outroStartSec`, { nullable: true, min: 0 });
  c.num(cues.loudnessGainDb, `${p}.loudnessGainDb`, { optional: true, min: -40, max: 40 });
  c.oneOf(cues.confidence, `${p}.confidence`, CONFIDENCES, { optional: true });
}

export const validateContextSnapshot = guarded((s) => {
  const c = checker();
  if (!c.obj(s, '$')) return c.result();
  c.version(s.schemaVersion, '$');
  c.str(s.snapshotId, 'snapshotId', { min: 1, max: 80 });
  c.iso(s.takenAt, 'takenAt');
  if (c.obj(s.time, 'time')) {
    c.str(s.time.tz, 'time.tz', { min: 1, max: 80 });
    c.str(s.time.localISO, 'time.localISO', { min: 1, max: 40 });
    c.oneOf(s.time.daypart, 'time.daypart', DAYPARTS);
    c.str(s.time.weekday, 'time.weekday', { min: 1, max: 20 });
    c.str(s.time.holiday, 'time.holiday', { nullable: true, max: 80 });
  }
  if (c.obj(s.place, 'place', { nullable: true }) && s.place) {
    for (const k of ['label', 'region', 'country']) c.str(s.place[k], `place.${k}`, { optional: true, max: 80 });
    c.str(s.place.geohash, 'place.geohash', { optional: true, max: 5 });
  }
  if (c.arr(s.facts, 'facts') && Array.isArray(s.facts)) {
    s.facts.forEach((f, i) => {
      const p = `facts[${i}]`;
      if (!c.obj(f, p)) return;
      c.str(f.id, `${p}.id`, { min: 1, max: 60 });
      c.oneOf(f.kind, `${p}.kind`, FACT_KINDS);
      if (!('value' in f)) c.err(`${p}.value`, 'required');
      c.str(f.say, `${p}.say`, { min: 1, max: LIMITS.maxFactSayChars });
      c.iso(f.asOf, `${p}.asOf`);
      c.num(f.ttlSec, `${p}.ttlSec`, { int: true, min: 0 });
      c.str(f.source, `${p}.source`, { min: 1, max: 80 });
      c.bool(f.mentionable, `${p}.mentionable`);
    });
    uniqueIds(c, s.facts, 'id', 'facts');
  }
  if (c.obj(s.serviceStatus, 'serviceStatus', { optional: true }) && s.serviceStatus) {
    for (const [k, v] of Object.entries(s.serviceStatus)) c.oneOf(v, `serviceStatus.${k}`, SERVICE_STATES);
  }
  if (c.obj(s.listener, 'listener')) {
    c.str(s.listener.displayName, 'listener.displayName', { nullable: true, max: 60 });
    if (c.arr(s.listener.namedPlaces, 'listener.namedPlaces', { optional: true, max: 10 }) && s.listener.namedPlaces) {
      s.listener.namedPlaces.forEach((n, i) => {
        if (!c.obj(n, `listener.namedPlaces[${i}]`)) return;
        c.oneOf(n.label, `listener.namedPlaces[${i}].label`, ['home', 'work', 'custom']);
        c.str(n.name, `listener.namedPlaces[${i}].name`, { min: 1, max: 80 });
      });
    }
    c.oneOf(s.listener.sessionContext, 'listener.sessionContext', SESSION_CONTEXTS, { optional: true });
  }
  if (c.obj(s.libraryDigest, 'libraryDigest')) {
    const cands = s.libraryDigest.candidates;
    if (c.arr(cands, 'libraryDigest.candidates', { max: LIMITS.maxCandidates }) && Array.isArray(cands)) {
      cands.forEach((t, i) => {
        const p = `libraryDigest.candidates[${i}]`;
        if (!c.obj(t, p)) return;
        c.str(t.trackId, `${p}.trackId`, { min: 1, max: 80 });
        c.str(t.title, `${p}.title`, { min: 1, max: LIMITS.maxTitleChars });
        c.str(t.artist, `${p}.artist`, { min: 1, max: LIMITS.maxTitleChars });
        c.str(t.album, `${p}.album`, { optional: true, max: LIMITS.maxTitleChars });
        c.str(t.genre, `${p}.genre`, { optional: true, max: 60 });
        c.num(t.durationSec, `${p}.durationSec`, { optional: true, min: 0 });
        c.num(t.energy, `${p}.energy`, { optional: true, min: 0, max: 1 });
        checkCues(c, t.cues, `${p}.cues`);
        c.num(t.lastPlayedAgoSec, `${p}.lastPlayedAgoSec`, { nullable: true, min: 0 });
        c.num(t.playCount, `${p}.playCount`, { optional: true, int: true, min: 0 });
      });
      uniqueIds(c, cands, 'trackId', 'libraryDigest.candidates');
    }
    c.strArr(s.libraryDigest.excludeTrackIds, 'libraryDigest.excludeTrackIds', { optional: true });
  }
  c.nest('memory', c.obj(s.memory, 'memory') ? validateStationMemory(s.memory) : { ok: true, errors: [] });
  return c.result();
});

// ── Rundown ──────────────────────────────────────────────────────────────────

export const validateRundown = guarded((r) => {
  const c = checker();
  if (!c.obj(r, '$')) return c.result();
  c.version(r.schemaVersion, '$');
  c.str(r.rundownId, 'rundownId', { min: 1, max: 80 });
  c.str(r.snapshotId, 'snapshotId', { min: 1, max: 80 });
  c.num(r.horizonSec, 'horizonSec', { min: 0 });
  if (c.obj(r.showSeed, 'showSeed', { optional: true }) && r.showSeed) {
    c.str(r.showSeed.theme, 'showSeed.theme', { optional: true, max: 80 });
    c.strArr(r.showSeed.moodArc, 'showSeed.moodArc', { optional: true, max: 12 });
    c.str(r.showSeed.runningGag, 'showSeed.runningGag', { nullable: true, max: 200 });
    c.str(r.showSeed.callbackFromMemory, 'showSeed.callbackFromMemory', { nullable: true, max: 200 });
  }
  if (c.arr(r.slots, 'slots', { min: 1, max: LIMITS.maxSlots }) && Array.isArray(r.slots)) {
    r.slots.forEach((sl, i) => {
      const p = `slots[${i}]`;
      if (!c.obj(sl, p)) return;
      c.str(sl.slotId, `${p}.slotId`, { min: 1, max: 60 });
      c.oneOf(sl.kind, `${p}.kind`, SLOT_KINDS);
      c.num(sl.targetSec, `${p}.targetSec`, { min: 0 });
      if (c.obj(sl.song, `${p}.song`, { optional: true }) && sl.song) {
        if (c.obj(sl.song.constraints, `${p}.song.constraints`, { optional: true }) && sl.song.constraints) {
          const k = sl.song.constraints;
          c.str(k.mood, `${p}.song.constraints.mood`, { optional: true, max: 60 });
          c.num(k.energy, `${p}.song.constraints.energy`, { optional: true, min: 0, max: 1 });
          c.strArr(k.genres, `${p}.song.constraints.genres`, { optional: true, max: 10 });
          c.strArr(k.artistsAnyOf, `${p}.song.constraints.artistsAnyOf`, { optional: true, max: 10 });
        }
        c.str(sl.song.trackIdHint, `${p}.song.trackIdHint`, { nullable: true, max: 80 });
      }
      if (c.obj(sl.talk, `${p}.talk`, { optional: true }) && sl.talk) {
        c.num(sl.talk.budgetSec, `${p}.talk.budgetSec`, { optional: true, min: 0 });
        c.str(sl.talk.purpose, `${p}.talk.purpose`, { optional: true, max: LIMITS.maxPurposeChars });
        c.strArr(sl.talk.factIds, `${p}.talk.factIds`, { optional: true, max: 20 });
        c.oneOf(sl.talk.mode, `${p}.talk.mode`, TALK_MODES, { optional: true });
        c.str(sl.talk.mood, `${p}.talk.mood`, { optional: true, max: 60 });
      }
      c.iso(sl.mustAirBy, `${p}.mustAirBy`, { nullable: true });
      c.bool(sl.skippable, `${p}.skippable`, { optional: true });
    });
    uniqueIds(c, r.slots, 'slotId', 'slots');
  }
  return c.result();
});

// ── Segment (scheduler output) ───────────────────────────────────────────────

export const validateSegment = guarded((g) => {
  const c = checker();
  if (!c.obj(g, '$')) return c.result();
  c.version(g.schemaVersion, '$');
  c.str(g.segmentId, 'segmentId', { min: 1, max: 80 });
  c.str(g.slotId, 'slotId', { min: 1, max: 60 });
  c.oneOf(g.kind, 'kind', SEGMENT_KINDS);
  c.num(g.startSec, 'startSec', { min: 0 });
  c.num(g.durationSec, 'durationSec', { min: 0.001 });
  c.oneOf(g.source, 'source', SEGMENT_SOURCES, { optional: true });
  c.oneOf(g.mode, 'mode', SEGMENT_MODES, { optional: true });
  if (g.kind === 'song') c.str(g.trackId, 'trackId', { min: 1, max: 80 });
  else c.str(g.trackId, 'trackId', { optional: true, max: 80 });
  if (g.kind === 'voice' && c.arr(g.utterances, 'utterances', { min: 1, max: LIMITS.maxUtterances }) && Array.isArray(g.utterances)) {
    g.utterances.forEach((u, i) => {
      if (!c.obj(u, `utterances[${i}]`)) return;
      c.str(u.id, `utterances[${i}].id`, { min: 1, max: 60 });
      c.num(u.startSec, `utterances[${i}].startSec`, { min: 0 });
      c.num(u.durationSec, `utterances[${i}].durationSec`, { min: 0 });
      c.bool(u.droppable, `utterances[${i}].droppable`, { optional: true });
    });
  }
  if (c.obj(g.duck, 'duck', { optional: true }) && g.duck) {
    c.num(g.duck.depthDb, 'duck.depthDb', { min: -40, max: 0 });
    c.num(g.duck.leadMs, 'duck.leadMs', { min: 0, max: 2000 });
    c.num(g.duck.releaseMs, 'duck.releaseMs', { min: 0, max: 5000 });
  }
  c.str(g.attachedTo, 'attachedTo', { optional: true, max: 80 });
  c.num(g.fadeInSec, 'fadeInSec', { optional: true, min: 0, max: 30 });
  c.num(g.fadeOutSec, 'fadeOutSec', { optional: true, min: 0, max: 30 });
  return c.result();
});

// ── Script (Writer output) ───────────────────────────────────────────────────

export const validateScript = guarded((s) => {
  const c = checker();
  if (!c.obj(s, '$')) return c.result();
  c.version(s.schemaVersion, '$');
  c.str(s.slotId, 'slotId', { min: 1, max: 60 });
  if (c.arr(s.utterances, 'utterances', { min: 1, max: LIMITS.maxUtterances }) && Array.isArray(s.utterances)) {
    s.utterances.forEach((u, i) => {
      const p = `utterances[${i}]`;
      if (!c.obj(u, p)) return;
      c.str(u.id, `${p}.id`, { min: 1, max: 60 });
      if (c.str(u.text, `${p}.text`, { min: 1, max: LIMITS.maxUtteranceChars })) {
        for (const e of validateMarkup(u.text).errors) c.err(`${p}.text`, `markup: ${e}`);
      }
      if (c.obj(u.style, `${p}.style`)) {
        c.oneOf(u.style.emotion, `${p}.style.emotion`, EMOTIONS);
        c.num(u.style.energy, `${p}.style.energy`, { min: 0, max: 1 });
        c.num(u.style.pace, `${p}.style.pace`, { min: 0.8, max: 1.25 });
        c.num(u.style.pitchSemitones, `${p}.style.pitchSemitones`, { optional: true, min: -2, max: 2 });
        c.str(u.style.direction, `${p}.style.direction`, { optional: true, max: 80 });
      }
      c.num(u.pauseAfterMs, `${p}.pauseAfterMs`, { optional: true, int: true, min: 0, max: 2000 });
      c.strArr(u.factRefs, `${p}.factRefs`, { optional: true, max: 20 });
      c.bool(u.droppable, `${p}.droppable`, { optional: true });
      c.iso(u.expiresAt, `${p}.expiresAt`, { nullable: true });
      if (c.arr(u.templates, `${p}.templates`, { optional: true, max: 6 }) && u.templates) {
        u.templates.forEach((t, j) => c.oneOf(t, `${p}.templates[${j}]`, TEMPLATE_NAMES));
      }
    });
    uniqueIds(c, s.utterances, 'id', 'utterances');
  }
  c.strArr(s.claimedTrackIds, 'claimedTrackIds', { optional: true, max: 12 });
  return c.result();
});

// ── CallerTurn ───────────────────────────────────────────────────────────────

export const validateCallerTurn = guarded((t) => {
  const c = checker();
  if (!c.obj(t, '$')) return c.result();
  c.version(t.schemaVersion, '$');
  c.str(t.callId, 'callId', { min: 1, max: 80 });
  c.num(t.turn, 'turn', { int: true, min: 0 });
  c.oneOf(t.direction, 'direction', CALL_DIRECTIONS);
  c.iso(t.startedAt, 'startedAt');
  if (c.obj(t.listener, 'listener', { optional: true }) && t.listener) {
    c.str(t.listener.transcript, 'listener.transcript', { optional: true, max: LIMITS.maxTranscriptChars });
    c.num(t.listener.sttConfidence, 'listener.sttConfidence', { optional: true, min: 0, max: 1 });
    c.bool(t.listener.bargedIn, 'listener.bargedIn', { optional: true });
    c.num(t.listener.durationMs, 'listener.durationMs', { optional: true, int: true, min: 0 });
    c.bool(t.listener.audioRetained, 'listener.audioRetained', { optional: true });
  }
  if (c.obj(t.host, 'host', { optional: true }) && t.host) {
    if (t.host.script !== undefined) c.nest('host.script', validateScript(t.host.script));
    c.bool(t.host.interrupted, 'host.interrupted', { optional: true });
    c.num(t.host.spokenCharsBeforeInterrupt, 'host.spokenCharsBeforeInterrupt', { optional: true, int: true, min: 0 });
  }
  if (c.arr(t.actions, 'actions', { optional: true, max: LIMITS.maxActions }) && t.actions) {
    t.actions.forEach((a, i) => {
      const p = `actions[${i}]`;
      if (!c.obj(a, p)) return;
      if (!c.oneOf(a.type, `${p}.type`, ACTION_TYPES)) return;
      if (a.type === 'request_song') {
        c.str(a.query, `${p}.query`, { min: 1, max: 120 });
        c.str(a.dedication, `${p}.dedication`, { nullable: true, max: LIMITS.maxNoteChars });
      } else if (a.type === 'note_for_show') c.str(a.text, `${p}.text`, { min: 1, max: LIMITS.maxNoteChars });
    });
  }
  c.oneOf(t.safety, 'safety', SAFETY_LABELS, { optional: true });
  return c.result();
});

/** schema id -> validator, for generic code and table-driven tests. */
export const VALIDATORS = Object.freeze({
  [SCHEMA_IDS.contextSnapshot]: validateContextSnapshot,
  [SCHEMA_IDS.rundown]: validateRundown,
  [SCHEMA_IDS.segment]: validateSegment,
  [SCHEMA_IDS.script]: validateScript,
  [SCHEMA_IDS.callerTurn]: validateCallerTurn,
  [SCHEMA_IDS.stationMemory]: validateStationMemory,
});

export function validate(schemaId, value) {
  const v = VALIDATORS[schemaId];
  return v ? v(value) : { ok: false, errors: [`unknown schema ${String(schemaId).slice(0, 60)}`] };
}
