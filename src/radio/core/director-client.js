// ─────────────────────────────────────────────────────────────────────────────
// director-client.js — rundown repair (architecture 5, 10.2).
//
// The Director (LLM) proposes a rolling rundown; the device NEVER trusts it. repairRundown:
//   • drops unknown / repeated / excluded trackIdHints (selector picks instead)
//   • clamps durations and talk budgets; a song with a known hint takes the track's
//     real duration, and horizonSec is recomputed — model arithmetic is ignored
//   • no two standalone talk breaks adjacent unless a caller slot is involved
//     (the later one is dropped if skippable, else a song is inserted between)
//   • first slot is music or a pre-rendered station ID (an ID is prepended otherwise)
//   • talk_over_intro is an OVERLAY on the song right after it (it takes no time of
//     its own); one that is not followed by a song becomes a normal talk_break
//   • facts the slot may use are filtered to usable ones; a weather/traffic/place hit
//     whose service is down becomes a fact-free chat break (grounding.js)
// Input is never mutated. Output is validated; repairs[] says what changed.
// ─────────────────────────────────────────────────────────────────────────────

import { validateRundown, SLOT_KINDS, LIMITS } from './schemas.js';
import { degradeSlotForServices } from './grounding.js';
import { isObj, isNum, isIso } from './util.js';

export const STANDALONE_TALK = Object.freeze(['talk_break', 'back_sell', 'weather_hit', 'place_hit', 'traffic_hit']);
export const CALLER_KINDS = Object.freeze(['caller_open', 'caller_invite']);
/** kinds that need a Writer script (station_id is pre-rendered, song is music) */
export const SCRIPTED_KINDS = Object.freeze([...STANDALONE_TALK, 'talk_over_intro', 'sign_on', 'sign_off', ...CALLER_KINDS]);
/** kinds that occupy no timeline time of their own */
export const OVERLAY_KINDS = Object.freeze(['talk_over_intro']);

export const DEFAULT_SONG_SEC = 200;
export const ID_SEC = 6;
export const DURATION_LIMITS = Object.freeze({
  song: [60, 600], station_id: [2, 15], sign_on: [5, 45], sign_off: [5, 45], talk_break: [8, 60], back_sell: [5, 40],
  weather_hit: [8, 45], place_hit: [8, 45], traffic_hit: [8, 45], caller_open: [10, 120], caller_invite: [8, 40], talk_over_intro: [4, 20],
});
export const TALK_BUDGET_MAX = Object.freeze({ talk_over_intro: 20, back_sell: 25, caller_invite: 25 /* others: targetSec */ });

const clone = (o) => JSON.parse(JSON.stringify(o));
const clampDur = (kind, sec) => {
  const [lo, hi] = DURATION_LIMITS[kind] || [1, 120];
  return Math.min(hi, Math.max(lo, isNum(sec) ? sec : (kind === 'song' ? DEFAULT_SONG_SEC : lo)));
};
const isTalky = (k) => STANDALONE_TALK.includes(k);
const trim = (s, n) => (typeof s === 'string' ? s.slice(0, n) : s);

/** Sum of non-overlay target durations: the only horizon the device believes. */
export const horizonOf = (slots) => slots.filter((s) => !OVERLAY_KINDS.includes(s.kind)).reduce((a, s) => a + s.targetSec, 0);

/**
 * repairRundown(raw, {snapshot, atMs, maxSlots}) ->
 *   {ok, rundown|null, repairs:[{code, slotId, detail}], errors[]}
 * A rolling EXTENSION passes previousKind (kind of the last slot already on the clock): the first-slot rule is
 * then skipped and adjacency is checked against it. idPrefix namespaces generated slot ids across calls.
 * ok=false only for unrepairable input (not an object, wrong schemaVersion, no usable slots).
 */
export function repairRundown(raw, { snapshot = null, atMs, maxSlots = LIMITS.maxSlots, idPrefix = '', previousKind = null } = {}) {
  const repairs = [];
  const fix = (code, slotId, detail) => repairs.push({ code, slotId: slotId ?? null, detail: detail ?? null });
  let r;
  try { r = clone(raw); } catch { return { ok: false, rundown: null, repairs, errors: ['rundown is not JSON-cloneable'] }; }
  if (!isObj(r)) return { ok: false, rundown: null, repairs, errors: ['rundown must be an object'] };
  if (r.schemaVersion !== 1) return { ok: false, rundown: null, repairs, errors: [`unsupported schemaVersion ${JSON.stringify(r.schemaVersion)}`] };
  if (!Array.isArray(r.slots)) return { ok: false, rundown: null, repairs, errors: ['slots must be an array'] };

  const cands = (snapshot && snapshot.libraryDigest && snapshot.libraryDigest.candidates) || [];
  const byId = new Map(cands.map((t) => [t.trackId, t]));
  const excluded = new Set((snapshot && snapshot.libraryDigest && snapshot.libraryDigest.excludeTrackIds) || []);
  const when = Number.isFinite(atMs) ? atMs : (snapshot ? Date.parse(snapshot.takenAt) : NaN);

  // 1. per-slot sanitation
  const seenIds = new Set(), usedHints = new Set();
  let n = 0, slots = [];
  for (const s0 of r.slots) {
    if (!isObj(s0) || !SLOT_KINDS.includes(s0.kind)) { fix('drop_unknown_kind', isObj(s0) ? s0.slotId : null, isObj(s0) ? s0.kind : typeof s0); continue; }
    let s = { ...s0 };
    if (typeof s.slotId !== 'string' || !s.slotId || seenIds.has(s.slotId)) { const old = s.slotId; s.slotId = `${idPrefix}r${++n}-${s.kind}`; fix('rename_slot', s.slotId, `was ${JSON.stringify(old)}`); }
    seenIds.add(s.slotId);
    const target = clampDur(s.kind, s.targetSec);
    if (target !== s.targetSec) fix('clamp_duration', s.slotId, `${s.targetSec} -> ${target}`);
    s.targetSec = target;
    if (s.mustAirBy !== undefined && s.mustAirBy !== null && !isIso(s.mustAirBy)) { s.mustAirBy = null; fix('drop_bad_mustAirBy', s.slotId); }
    if (s.skippable !== undefined && typeof s.skippable !== 'boolean') delete s.skippable;
    if (s.kind === 'song') {
      s.song = isObj(s.song) ? { ...s.song } : {};
      const h = s.song.trackIdHint;
      if (h !== undefined && h !== null) {
        if (typeof h !== 'string' || !byId.has(h)) { s.song.trackIdHint = null; fix('drop_unknown_hint', s.slotId, String(h).slice(0, 40)); }
        else if (excluded.has(h) || usedHints.has(h)) { s.song.trackIdHint = null; fix('drop_repeat_hint', s.slotId, h); }
        else { usedHints.add(h); const real = byId.get(h).durationSec; if (isNum(real) && real > 0 && real !== s.targetSec) { s.targetSec = clampDur('song', real); fix('song_duration_from_track', s.slotId, `${target} -> ${s.targetSec}`); } }
      }
    } else if (s.song !== undefined) delete s.song;
    if (SCRIPTED_KINDS.includes(s.kind)) {
      s.talk = isObj(s.talk) ? { ...s.talk } : {};
      const cap = Math.min(TALK_BUDGET_MAX[s.kind] ?? s.targetSec, s.targetSec);
      if (!isNum(s.talk.budgetSec) || s.talk.budgetSec > cap || s.talk.budgetSec < 0) { if (s.talk.budgetSec !== undefined) fix('clamp_talk_budget', s.slotId, `${s.talk.budgetSec} -> ${cap}`); s.talk.budgetSec = cap; }
      s.talk.purpose = trim(s.talk.purpose, LIMITS.maxPurposeChars);
      if (!Array.isArray(s.talk.factIds)) s.talk.factIds = [];
      s.talk.factIds = s.talk.factIds.filter((x) => typeof x === 'string');
      if (snapshot) {
        const d = degradeSlotForServices(s, snapshot, when);
        if (d.dropped.length) fix('drop_unusable_fact', s.slotId, d.dropped.join(','));
        if (d.converted) fix('service_down_to_chat', s.slotId, `${s.kind} -> talk_break`);
        s = d.slot;
      }
      s.talk.mode = s.kind === 'talk_over_intro' ? 'over_intro' : (s.talk.mode === 'cold' ? 'cold' : 'between_songs');
      if (s.kind === 'talk_break' && s.targetSec < s.talk.budgetSec) s.talk.budgetSec = s.targetSec;
    } else if (s.talk !== undefined) delete s.talk;
    slots.push(s);
  }

  // 2. overlays must precede a song
  slots = slots.map((s, i) => {
    if (OVERLAY_KINDS.includes(s.kind) && !(slots[i + 1] && slots[i + 1].kind === 'song')) {
      fix('overlay_without_song', s.slotId, 'talk_over_intro -> talk_break');
      return { ...s, kind: 'talk_break', targetSec: clampDur('talk_break', Math.max(s.targetSec, 8)), talk: { ...s.talk, mode: 'between_songs', budgetSec: Math.min(s.talk.budgetSec, 30) } };
    }
    return s;
  });

  // 3. no adjacent standalone talk (caller slots exempt); overlays are transparent
  let k = 0;
  const out = [];
  for (const s of slots) {
    const prev = [...out].reverse().find((x) => !OVERLAY_KINDS.includes(x.kind)) || (previousKind ? { kind: previousKind } : null);
    if (prev && isTalky(prev.kind) && isTalky(s.kind)) {
      if (s.skippable) { fix('drop_adjacent_talk', s.slotId, 'skippable'); continue; }
      const filler = { slotId: `${idPrefix}rep-song-${++k}`, kind: 'song', targetSec: DEFAULT_SONG_SEC, song: { constraints: {}, trackIdHint: null } };
      out.push(filler); fix('insert_song_between_talk', filler.slotId, `before ${s.slotId}`);
    }
    out.push(s);
  }

  // 4. first slot: music or a pre-rendered ID
  if (!previousKind && out.length && !(out[0].kind === 'song' || out[0].kind === 'station_id')) {
    const id = { slotId: `${idPrefix}rep-id-0`, kind: 'station_id', targetSec: ID_SEC };
    out.unshift(id); fix('prepend_station_id', id.slotId, `first slot was ${out[1].kind}`);
    // cold start: an ID straight into talk is not a start; put a song between
    if (out[1].kind !== 'song' && !OVERLAY_KINDS.includes(out[1].kind)) {
      const song = { slotId: `${idPrefix}rep-song-0`, kind: 'song', targetSec: DEFAULT_SONG_SEC, song: { constraints: {}, trackIdHint: null } };
      out.splice(1, 0, song); fix('insert_song_after_cold_start_id', song.slotId);
    }
  }

  // 5. cap length (drop from the end; never leaves an overlay dangling)
  while (out.length > maxSlots) { const d = out.pop(); fix('truncate', d.slotId, `max ${maxSlots}`); }
  while (out.length && OVERLAY_KINDS.includes(out[out.length - 1].kind)) { const d = out.pop(); fix('truncate', d.slotId, 'dangling overlay'); }
  if (!out.length) return { ok: false, rundown: null, repairs, errors: ['no usable slots'] };

  // 6. never trust arithmetic or ids
  const horizonSec = horizonOf(out);
  if (!isNum(r.horizonSec) || Math.abs(r.horizonSec - horizonSec) > 0.5) fix('fix_horizon', null, `${r.horizonSec} -> ${horizonSec}`);
  const snapId = snapshot ? snapshot.snapshotId : r.snapshotId;
  if (snapshot && r.snapshotId !== snapId) fix('fix_snapshot_id', null, `${r.snapshotId} -> ${snapId}`);
  const rundown = {
    schemaVersion: 1,
    rundownId: typeof r.rundownId === 'string' && r.rundownId ? r.rundownId : 'rundown-repaired',
    snapshotId: typeof snapId === 'string' && snapId ? snapId : 'unknown',
    horizonSec,
    showSeed: isObj(r.showSeed) ? {
      theme: trim(r.showSeed.theme, 80), moodArc: Array.isArray(r.showSeed.moodArc) ? r.showSeed.moodArc.filter((x) => typeof x === 'string').slice(0, 12) : [],
      runningGag: typeof r.showSeed.runningGag === 'string' ? trim(r.showSeed.runningGag, 200) : null,
      callbackFromMemory: typeof r.showSeed.callbackFromMemory === 'string' ? trim(r.showSeed.callbackFromMemory, 200) : null,
    } : undefined,
    slots: out,
  };
  if (rundown.showSeed === undefined) delete rundown.showSeed;
  const v = validateRundown(rundown);
  return { ok: v.ok, rundown: v.ok ? rundown : null, repairs, errors: v.errors };
}

/**
 * Property checks for golden rundowns (architecture 13): returns violations[] (empty = good).
 * Independent of repairRundown so it can audit its output and the fake Director's.
 */
export function rundownProblems(rundown, snapshot) {
  const bad = [];
  const slots = (rundown && rundown.slots) || [];
  const cands = new Map((((snapshot || {}).libraryDigest || {}).candidates || []).map((t) => [t.trackId, t]));
  if (!slots.length) return ['no slots'];
  const first = slots[0];
  if (!(first.kind === 'song' || first.kind === 'station_id')) bad.push(`first slot is ${first.kind}`);
  if (Math.abs(horizonOf(slots) - rundown.horizonSec) > 0.5) bad.push('horizonSec does not equal the slot sum');
  const hints = new Set();
  let prev = null;
  slots.forEach((s, i) => {
    if (s.kind === 'song' && s.song && s.song.trackIdHint) {
      if (snapshot && !cands.has(s.song.trackIdHint)) bad.push(`unknown hint ${s.song.trackIdHint}`);
      if (hints.has(s.song.trackIdHint)) bad.push(`repeated hint ${s.song.trackIdHint}`);
      hints.add(s.song.trackIdHint);
    }
    if (OVERLAY_KINDS.includes(s.kind) && !(slots[i + 1] && slots[i + 1].kind === 'song')) bad.push(`overlay ${s.slotId} not before a song`);
    if (!OVERLAY_KINDS.includes(s.kind)) {
      if (prev && isTalky(prev.kind) && isTalky(s.kind)) bad.push(`adjacent talk ${prev.slotId}+${s.slotId}`);
      prev = s;
    }
    if (s.talk && s.talk.budgetSec > s.targetSec + 1e-9 && !OVERLAY_KINDS.includes(s.kind)) bad.push(`budget exceeds slot ${s.slotId}`);
    if (snapshot) {
      const ids = new Map((snapshot.facts || []).map((f) => [f.id, f]));
      for (const id of (s.talk && s.talk.factIds) || []) {
        const f = ids.get(id);
        if (!f) bad.push(`unknown fact ${id}`); else if (!f.mentionable) bad.push(`unmentionable fact ${id} planned`);
      }
    }
  });
  return bad;
}

/**
 * Music-only slots made on the device when the Director is unreachable (offline, quota, refusal).
 * Songs are chosen by song-select.js as usual; no talk, so nothing needs the network.
 */
export function musicOnlySlots(count, startIndex = 0) {
  return Array.from({ length: count }, (_, i) => ({
    slotId: `mo${startIndex + i}`, kind: 'song', targetSec: DEFAULT_SONG_SEC, song: { constraints: {}, trackIdHint: null }, skippable: false,
  }));
}
