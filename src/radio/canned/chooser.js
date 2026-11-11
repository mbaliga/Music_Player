// ─────────────────────────────────────────────────────────────────────────────
// chooser.js — what a canned station says, and when. PURE, seeded, never throws.
//
//   const ch = createChooser(pack, { seed });
//   const plan = ch.plan({ nowSec, songStartSec, songDurSec, values, ... });   // decide the break for the end of this song
//   ch.commit(plan, { startedSec, durSec });                                    // record that it actually aired
//   ch.planSignOn(...) / ch.planSignOff(...)                                    // the two bookends
//
// A plan is { type:'talk', unit, resolved, startAtSec, estSec, why } (startAtSec is relative to the CURRENT song's start)
// or { type:'silence', why }. Silence is a first-class outcome (it is how the station keeps its talk share and its gaps),
// and so is the zero-line segment ("silent" unit) a pack may supply.
//
// Rules (see CADENCE):
//   • sign_on first, sign_off on stop; station_id / jingle about every 15 min (never otherwise, unless nothing else fits).
//   • talk share by time targets 25-30 % over a rolling hour: below the band the chooser prefers longer segments, above it it
//     stays silent. Talk is spoken over the music bed, and counts as talk at its measured (or estimated) length.
//   • at least MIN_GAP_SEC of pure music between breaks; two talk segments are never adjacent unless one is a skit/callin.
//   • no unit airs twice inside its cool-down: 90 min for a kind with 5+ units, 45 min (the hard floor) for a kind with 4 or
//     fewer (news, promo, liner ...), 25 min only for the few station_id / jingle units. When the pool is exhausted the
//     cool-down relaxes to the 45-minute floor for non-ID kinds (never below it; 25 min stays for IDs), else the chooser stays
//     silent (music only). A slot segment and its twin are ONE unit.
//   • running gags (`gag:<name>` / `serial:<name>` + `seq:<n>` + `payoff`): beats air in seq order, never skipping to a later
//     beat, the payoff only after its earlier beats, beats of a gag at least GAG_GAP_SEC apart. Equal seq numbers are
//     alternatives of one beat. `seq`/`payoff` tags belong to the gag tag they follow. Only airable units hold a level. A gag is
//     FINISHED when its top beat / payoff airs: none of its units airs again (a payoff never replays without its set-up).
//   • `bit` units: at most 2 per rolling hour.
//   • time of day is NOT a rule here (owner: playable any time); the picker orders by daypart, the review flags time words.
// ─────────────────────────────────────────────────────────────────────────────

import { hashSeed, mulberry32 } from '../core/util.js';
import { resolveUnit } from './slots.js';
import { gagLevels } from './pack.js';

export const CADENCE = Object.freeze({
  shareLo: 0.25, shareHi: 0.30, shareWindowSec: 3600, shareMinDenomSec: 600,
  minGapSec: 75, quickFollowGapSec: 8,       // pure music between breaks; a skit/callin may follow talk more closely
  idEverySec: 900, idJitterSec: 120,
  cooldownSec: 5400, cooldownRareSec: 1500, rareUnits: 4, hardFloorSec: 2700,
  gagGapSec: 480, bitsPerHour: 2,
  minTriggerSec: 12, marginSec: 2,          // a break starts no earlier than 12 s into a song and ends ~2 s before the join
  spillSec: 25,                             // how far a break may run into the next song's intro
  maxEstSec: 140,
});

const ID_KINDS = new Set(['station_id', 'jingle']);
const BOOKENDS = new Set(['sign_on', 'sign_off']);
const BIG_KINDS = new Set(['monologue', 'skit', 'callin', 'news', 'ad', 'banter', 'dedication']);
const MULTI = new Set(['skit', 'callin']);

/** two talk segments may be adjacent only when one of them is a skit or a call-in */
export const canFollow = (prevKind, nextKind) => MULTI.has(prevKind) || MULTI.has(nextKind);

export function createChooser(pack, { seed = 1, cadence = {}, preferTwin = false, durations = null } = {}) {
  // preferTwin: boolean, or (unit) => boolean (audio-pack mode decides per unit whether its recording exists)
  const twinFor = (u) => (typeof preferTwin === 'function' ? !!preferTwin(u) : !!preferTwin);
  const C = { ...CADENCE, ...cadence };
  const units = pack.units;
  const levels = gagLevels(pack, { maxEstSec: C.maxEstSec });
  const kindCount = {};
  for (const u of units) if (!BOOKENDS.has(u.kind)) kindCount[u.kind] = (kindCount[u.kind] || 0) + 1;

  const st = {
    n: 0,
    used: new Map(),          // unit id -> { lastSec, count }
    talk: [],                 // [{ startSec, endSec, kind, unit }]
    lastTalkEndSec: -Infinity, lastTalkKind: null, lastKind: null, lastIdSec: -Infinity, lastIdKind: null,
    gagDone: new Map(),       // gag -> Set(levels done)
    gagFinished: new Set(),   // gags whose top beat / payoff has aired: nothing of them airs again
    gagCount: new Map(),      // gag -> number of airings
    gagLastSec: new Map(),    // gag -> last airing (ordered beats)
    bits: [],                 // [sec]
    signedOn: false,
  };
  const rngFor = (salt) => mulberry32(hashSeed(`${seed}:${pack.id}:${salt}:${st.n}`));
  const dur = (u, resolved) => {
    const m = durations && (durations.get ? durations.get(resolved.seg.id) : durations[resolved.seg.id]);
    return Number.isFinite(m) && m > 0 ? m : resolved.estSec;
  };

  // 25 min only for ID kinds; a small pool (<= rareUnits) of anything else cools for the hard floor, a large one for the full 90 min
  const cooldownOf = (u) => (ID_KINDS.has(u.kind) ? C.cooldownRareSec : kindCount[u.kind] <= C.rareUnits ? C.hardFloorSec : C.cooldownSec);

  function gagOk(u, atSec) {
    for (const g of u.gags) {
      if (st.gagFinished.has(g)) return false;                                  // the payoff has aired: no replays without the set-up
      const lv = levels.get(g) || [];
      const done = st.gagDone.get(g) || new Set();
      const b = (u.gagBeats && u.gagBeats.get(g)) || { seq: null, payoff: false };
      if (b.seq != null) {
        for (const l of lv) if (l < b.seq && !done.has(l)) return false;       // never skip to a later beat (this also covers the payoff)
        const maxDone = done.size ? Math.max(...done) : -1;
        if (b.seq < maxDone) return false;                                      // no stepping back once a later beat aired
        const last = st.gagLastSec.get(g);
        if (last != null && atSec - last < C.gagGapSec) return false;           // let a beat breathe
      } else if (b.payoff) {
        if ((st.gagCount.get(g) || 0) < 1) return false;                        // a payoff with no seq still waits for the set-up
      }
    }
    return true;
  }

  const bitsInHour = (atSec) => st.bits.filter((t) => atSec - t < 3600).length;

  function shareAt(nowSec) {
    const from = nowSec - C.shareWindowSec;
    let talk = 0;
    for (const t of st.talk) { const a = Math.max(t.startSec, from), b = Math.min(t.endSec, nowSec); if (b > a) talk += b - a; }
    const denom = Math.max(C.shareMinDenomSec, Math.min(C.shareWindowSec, nowSec));
    return talk / denom;
  }

  function cooled(u, atSec, relax) {
    const r = st.used.get(u.id);
    if (!r) return true;
    const need = relax && ID_KINDS.has(u.kind) ? cooldownOf(u) : relax ? Math.min(C.hardFloorSec, cooldownOf(u)) : cooldownOf(u);
    return atSec - r.lastSec >= need;
  }

  function weightOf(u, resolved, ctx) {
    let w = Math.max(0.05, u.weight || 1);
    const e = resolved.estSec;
    if (ctx.wantBig) w *= e >= 30 ? 2.2 : e >= 15 ? 1.2 : 0.4;
    else if (ctx.wantSmall) w *= e <= 20 ? 1.8 : e <= 40 ? 1 : 0.35;
    if (u.kind === st.lastKind) w *= 0.25;
    if (!st.used.has(u.id)) w *= 2.5; // fresh material first
    // the next beat of a gag that is already running is worth hearing soon
    if (u.gags.some((g) => { const b = u.gagBeats.get(g); return b && b.seq != null && (st.gagCount.get(g) || 0) > 0; })) w *= 1.7;
    if (u.gags.some((g) => u.gagBeats.get(g) && u.gagBeats.get(g).payoff)) w *= 1.4;
    return w;
  }

  function pick(cands, rng) {
    const total = cands.reduce((a, c) => a + c.w, 0);
    if (!(total > 0)) return null;
    let r = rng() * total;
    for (const c of cands) { r -= c.w; if (r <= 0) return c; }
    return cands[cands.length - 1];
  }

  function silence(why, extra = {}) { return { type: 'silence', why, ...extra }; }

  function startFor(estSec, songDurSec) {
    const room = Math.max(0, songDurSec - C.minTriggerSec - C.marginSec);
    return Math.max(C.minTriggerSec, songDurSec - Math.min(estSec, room + C.spillSec) - C.marginSec);
  }

  return {
    get state() { return st; },
    config: C,
    shareAt,

    /** The first break: a sign_on, spoken as the first song starts (or before it, while it decodes). */
    planSignOn({ values = {}, songDurSec = 200 } = {}) {
      try {
        const cands = units.filter((u) => u.kind === 'sign_on').map((u) => ({ u, resolved: resolveUnit(u, values, { preferTwin: twinFor(u) }) })).filter((c) => c.resolved);
        if (!cands.length) return silence('no sign_on in pack');
        st.n++;
        const c = pick(cands.map((x) => ({ ...x, w: Math.max(0.05, x.u.weight || 1) })), rngFor('on'));
        return { type: 'talk', unit: c.u, resolved: c.resolved, startAtSec: 0.4, estSec: dur(c.u, c.resolved), why: 'sign_on' };
      } catch { return silence('error'); }
    },

    /** The last break: a sign_off, aired now (the show ends when it does). */
    planSignOff({ values = {} } = {}) {
      try {
        const cands = units.filter((u) => u.kind === 'sign_off').map((u) => ({ u, resolved: resolveUnit(u, values, { preferTwin: twinFor(u) }) })).filter((c) => c.resolved);
        if (!cands.length) return silence('no sign_off in pack');
        st.n++;
        const c = pick(cands.map((x) => ({ ...x, w: Math.max(0.05, x.u.weight || 1) })), rngFor('off'));
        return { type: 'talk', unit: c.u, resolved: c.resolved, startAtSec: 0, estSec: dur(c.u, c.resolved), why: 'sign_off' };
      } catch { return silence('error'); }
    },

    /**
     * Decide the break that rides the END of the current song.
     * ctx = { nowSec, songStartSec, songDurSec, values, [allowIds=true] }
     */
    plan(ctx) {
      try {
        st.n++;
        const { nowSec, songStartSec, songDurSec, values = {} } = ctx;
        if (!(songDurSec > 0)) return silence('unknown song length');
        const rng = rngFor('plan');
        const share = shareAt(nowSec);
        const idTime = nowSec + (songDurSec - 30) - st.lastIdSec >= C.idEverySec - Math.floor(rng() * C.idJitterSec);
        const musicOnly = ctx.musicOnly === true;
        if (musicOnly) return silence('music only');

        const wantBig = share < C.shareLo;
        const wantSmall = share > (C.shareLo + C.shareHi) / 2;
        const build = (relax, allowIds, onlyIds) => {
          const out = [];
          for (const u of units) {
            if (BOOKENDS.has(u.kind)) continue;
            if (ID_KINDS.has(u.kind) ? !allowIds : onlyIds) continue;
            if (u.silent) continue;
            if (!cooled(u, nowSec, relax)) continue;
            const resolved = resolveUnit(u, values, { preferTwin: twinFor(u) });
            if (!resolved) continue;
            const est = dur(u, resolved);
            if (est > C.maxEstSec) continue;
            if (est > Math.max(15, songDurSec - C.minTriggerSec - C.marginSec + C.spillSec)) continue;
            const startAt = startFor(est, songDurSec);
            const absStart = songStartSec + startAt;
            const gap = absStart - st.lastTalkEndSec;
            if (gap < C.minGapSec && !(gap >= C.quickFollowGapSec && st.lastTalkKind && canFollow(st.lastTalkKind, u.kind))) continue;
            if (!gagOk(u, absStart)) continue;
            if (u.bit && bitsInHour(absStart) >= C.bitsPerHour) continue;
            out.push({ u, resolved, est, startAt, absStart, w: weightOf(u, resolved, { wantBig, wantSmall }) });
          }
          return out;
        };

        let cands = [];
        let why = 'normal';
        // an ID is only "due" when one can actually air now; otherwise (no ID units, all cooling, no room) the share gate applies
        let idDue = false;
        if (idTime) {
          cands = build(false, true, true);
          if (!cands.length) cands = build(true, true, true);
          if (cands.length) {
            idDue = true;
            // alternate between ID and jingle when both exist
            const other = cands.filter((c) => c.u.kind !== st.lastIdKind);
            if (other.length) cands = other;
            why = 'station-id due';
          }
        }
        // a silent unit is how a pack supplies silence; if the share is high we simply stay silent anyway
        if (!idDue && share >= C.shareHi) return silence(`share ${share.toFixed(2)} >= ${C.shareHi}`, { share });
        if (!cands.length) cands = build(false, false, false);
        if (!cands.length) { cands = build(true, false, false); if (cands.length) why = 'relaxed cool-down'; }
        if (!cands.length) return silence('nothing eligible', { share });
        const c = pick(cands, rng);
        if (!c) return silence('nothing eligible', { share });
        return { type: 'talk', unit: c.u, resolved: c.resolved, startAtSec: c.startAt, estSec: c.est, why, share };
      } catch (e) { return silence(`error: ${e && e.message}`); }
    },

    /** Record that a planned break aired (call at air time, with the measured length when known). */
    commit(plan, info) {
      try {
        const { startedSec, durSec } = info || {};
        if (!plan || plan.type !== 'talk') return;
        const u = plan.unit;
        const d = Number.isFinite(durSec) && durSec > 0 ? durSec : plan.estSec;
        const s = Number.isFinite(startedSec) ? startedSec : 0;
        st.used.set(u.id, { lastSec: s, count: ((st.used.get(u.id) || {}).count || 0) + 1 });
        st.talk.push({ startSec: s, endSec: s + d, kind: u.kind, unit: u.id });
        if (st.talk.length > 400) st.talk.shift();
        st.lastTalkEndSec = s + d; st.lastTalkKind = u.kind; st.lastKind = u.kind;
        if (ID_KINDS.has(u.kind) || u.kind === 'sign_on') { st.lastIdSec = s; st.lastIdKind = u.kind; }
        for (const g of u.gags) {
          st.gagCount.set(g, (st.gagCount.get(g) || 0) + 1);
          const b = u.gagBeats.get(g);
          if (b && b.seq != null) { st.gagLastSec.set(g, s); if (!st.gagDone.has(g)) st.gagDone.set(g, new Set()); st.gagDone.get(g).add(b.seq); }
          const lv = levels.get(g) || [];
          if (b && (b.payoff || (b.seq != null && lv.length && b.seq >= lv[lv.length - 1]))) st.gagFinished.add(g);
        }
        if (u.bit) st.bits.push(s);
        if (u.kind === 'sign_on') st.signedOn = true;
      } catch { /* bookkeeping must not break the show */ }
    },

    /** Correct the length of the most recent airing of `unitId` once it is measured (talk share and gaps use real time). */
    amend(unitId, durSec) {
      try {
        if (!(durSec > 0)) return;
        for (let i = st.talk.length - 1; i >= 0; i--) if (st.talk[i].unit === unitId) {
          st.talk[i].endSec = st.talk[i].startSec + durSec;
          if (i === st.talk.length - 1) st.lastTalkEndSec = st.talk[i].endSec;
          return;
        }
      } catch { /* */ }
    },
  };
}
