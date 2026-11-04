// ─────────────────────────────────────────────────────────────────────────────
// scheduler.js — slots -> timeline of Segments (architecture 4.3, 4.6).
//
// Pure math on the audio clock (seconds). The Web Audio bus (P2) turns the output
// into scheduled gain ramps and source starts; nothing here touches an AudioContext.
//
//   planTalkOverIntro   voice start so the host lands before the vocals (cue-based),
//                       trimming droppable utterances, else pre-roll, else between songs
//   duckEnvelope        music-bus gain breakpoints around voice windows (+ gainAt)
//   crossfadePlan       equal-power overlap, 'album' (0 s) or 'radio' (2–4 s)
//   scheduleShow        ordered items -> Segment[] (validated shape)
//   findDeadAir         gaps in audible coverage longer than a tolerance
//   findSafePoint /
//   insertAtSafePoint   where a caller/alert may enter (end of utterance, song boundary)
//   deadAirLadder       what to do when something is not ready (4.6 rungs 1–4)
// ─────────────────────────────────────────────────────────────────────────────

import { clamp } from './util.js';

export const SCHED = Object.freeze({
  hitMarginSec: 0.4,       // voice ends this long before the vocals (introEnd)
  minIntroSec: 3,          // intros shorter than this are not worth talking over
  maxPreRollSec: 6,        // how far into the previous outro the voice may start
  duck: Object.freeze({ depthDb: -14, leadMs: 250, releaseMs: 400 }), // tuning values, by ear
  callDuckDb: -22,         // music bed under a live call (8.2: -20 to -25)
  voiceGapSec: 0.15,       // silence around standalone voice (must stay under deadAirToleranceSec)
  utterancePauseSec: 0.15, // default pause after an utterance
  radioOverlapSec: Object.freeze([2, 4]),
  deadAirToleranceSec: 0.25,
});

const EPS = 1e-9;

// ── talk-over-intro ──────────────────────────────────────────────────────────

/**
 * utterances = [{id, durationSec, droppable?}] (durations are the MEASURED TTS lengths).
 * -> {mode:'over_intro'|'pre_roll'|'between_songs', voiceStartSec, durationSec, keptIds[], droppedIds[]}
 * Voice start = songStart + max(0, introEnd - D - hitMargin) so it ends hitMargin before the vocals.
 */
export function planTalkOverIntro({ songStartSec, cues, utterances, prevOutroSec = 0, hitMarginSec = SCHED.hitMarginSec, maxPreRollSec = SCHED.maxPreRollSec, minIntroSec = SCHED.minIntroSec }) {
  const all = (utterances || []).map((u) => ({ id: u.id, d: Math.max(0, u.durationSec || 0), droppable: !!u.droppable }));
  const total = (xs) => xs.reduce((a, u) => a + u.d, 0);
  const between = () => ({ mode: 'between_songs', voiceStartSec: null, durationSec: total(all), keptIds: all.map((u) => u.id), droppedIds: [] });
  const confident = cues && cues.confidence !== 'low' && Number.isFinite(cues.introEndSec) && cues.introEndSec >= minIntroSec;
  if (!confident) return between();
  const window = cues.introEndSec - hitMarginSec;
  let kept = [...all];
  const dropped = [];
  for (let i = kept.length - 1; i >= 0 && total(kept) > window + EPS; i--) {
    if (kept[i].droppable) { dropped.push(kept[i].id); kept.splice(i, 1); }
  }
  const D = total(kept);
  if (!kept.length) return between();
  if (D <= window + EPS) {
    return { mode: 'over_intro', voiceStartSec: songStartSec + Math.max(0, window - D), durationSec: D, keptIds: kept.map((u) => u.id), droppedIds: dropped };
  }
  const need = D - window;
  if (need <= Math.min(prevOutroSec, maxPreRollSec) + EPS) {
    return { mode: 'pre_roll', voiceStartSec: songStartSec - need, durationSec: D, keptIds: kept.map((u) => u.id), droppedIds: dropped };
  }
  return between();
}

// ── ducking ──────────────────────────────────────────────────────────────────

const dbToGain = (db) => 10 ** (db / 20);

/**
 * windows = [{startSec, endSec, depthDb?}] -> breakpoints [{t, gain, db}] for linearRampToValueAtTime.
 * Duck begins leadMs before voice and releases releaseMs after; windows whose ramps overlap merge.
 */
export function duckEnvelope(windows, { depthDb = SCHED.duck.depthDb, leadMs = SCHED.duck.leadMs, releaseMs = SCHED.duck.releaseMs } = {}) {
  const ws = (windows || []).filter((w) => w && w.endSec > w.startSec).map((w) => ({ ...w })).sort((a, b) => a.startSec - b.startSec);
  const merged = [];
  for (const w of ws) {
    const last = merged[merged.length - 1];
    const d = w.depthDb ?? depthDb;
    if (last && w.startSec - leadMs / 1000 <= last.endSec + releaseMs / 1000) {
      last.endSec = Math.max(last.endSec, w.endSec); last.depthDb = Math.min(last.depthDb, d);
    } else merged.push({ startSec: w.startSec, endSec: w.endSec, depthDb: d });
  }
  const pts = [];
  for (const m of merged) {
    const g = dbToGain(m.depthDb);
    pts.push({ t: Math.max(0, m.startSec - leadMs / 1000), gain: 1, db: 0 }, { t: m.startSec, gain: g, db: m.depthDb },
      { t: m.endSec, gain: g, db: m.depthDb }, { t: m.endSec + releaseMs / 1000, gain: 1, db: 0 });
  }
  return pts;
}

/** Linear-ramp interpolation of the envelope (what the bus will do); 1 outside. */
export function gainAt(env, t) {
  if (!env.length || t <= env[0].t) return 1;
  for (let i = 1; i < env.length; i++) {
    if (t <= env[i].t) {
      const a = env[i - 1], b = env[i];
      return b.t === a.t ? b.gain : a.gain + (b.gain - a.gain) * ((t - a.t) / (b.t - a.t));
    }
  }
  return 1;
}

// ── crossfade ────────────────────────────────────────────────────────────────

/** Equal-power gains at progress p in [0,1]: out^2 + in^2 = 1. */
export const equalPower = (p) => ({ out: Math.cos(clamp(p, 0, 1) * Math.PI / 2), in: Math.sin(clamp(p, 0, 1) * Math.PI / 2) });

/**
 * outgoing = {startSec, durationSec, cues}. style 'album' (no overlap, album-faithful) or 'radio'
 * (2–4 s starting at outroStartSec). -> {overlapSec, incomingStartSec}
 */
export function crossfadePlan(outgoing, style = 'album', { overlapSec = 3 } = {}) {
  const end = outgoing.startSec + outgoing.durationSec;
  if (style !== 'radio') return { overlapSec: 0, incomingStartSec: end };
  const [lo, hi] = SCHED.radioOverlapSec;
  let ov = clamp(overlapSec, lo, hi);
  const o = outgoing.cues && Number.isFinite(outgoing.cues.outroStartSec) ? outgoing.cues.outroStartSec : null;
  if (o !== null) ov = Math.min(ov, Math.max(0, outgoing.durationSec - o)); // can't start before the outro
  ov = Math.min(ov, outgoing.durationSec / 2);
  return { overlapSec: ov, incomingStartSec: end - ov };
}

// ── show assembly ────────────────────────────────────────────────────────────

const mkId = (slotId, tag) => `${slotId}:${tag}`;

function layoutUtterances(utts, startSec) {
  let t = startSec;
  return utts.map((u) => {
    const seg = { id: u.id, startSec: t, durationSec: u.durationSec, droppable: !!u.droppable };
    t += u.durationSec + (u.pauseSec ?? SCHED.utterancePauseSec);
    return seg;
  });
}
const voiceDur = (utts) => utts.reduce((a, u) => a + u.durationSec + (u.pauseSec ?? SCHED.utterancePauseSec), 0);
const hasVoice = (item) => !!(item.voice && item.voice.utterances && item.voice.utterances.length);

/**
 * items (rundown order), each:
 *   {slotId, kind:'station_id', stinger:{id,durationSec}}
 *   {slotId, kind:'song', track:{trackId,durationSec,cues}}
 *   {slotId, kind:<talk kind>, voice:{utterances:[{id,durationSec,droppable?,pauseSec?}]}}   voice absent => slot dropped
 *   {slotId, kind:'filler', filler:{id,durationSec}}                                          ladder rung 3/4
 * opts: {startSec, crossfade:'album'|'radio', overlapSec}
 * -> {segments:[Segment], endSec, notes:[{slotId, note}]}
 * A talk_over_intro item must directly precede its song; its voice is planned against that
 * song's cues (planTalkOverIntro) and tagged attachedTo that song's segment.
 */
export function scheduleShow(items, { startSec = 0, crossfade = 'album', overlapSec = 3 } = {}) {
  const segments = [], notes = [];
  let t = startSec;            // end of the audible stream so far
  let prev = null;             // the last song, while the stream currently ends in a song
  let pendingOverlay = null;   // talk_over_intro waiting for its song
  const push = (seg) => { segments.push({ schemaVersion: 1, source: 'rundown', ...seg }); return segments[segments.length - 1]; };

  const standalone = (item, utts) => {
    const start = t + (prev ? SCHED.voiceGapSec : 0);
    const d = voiceDur(utts);
    push({ segmentId: mkId(item.slotId, 'voice'), slotId: item.slotId, kind: 'voice', mode: 'between_songs', startSec: start, durationSec: Math.max(d, 0.001), utterances: layoutUtterances(utts, start) });
    t = start + d + SCHED.voiceGapSec;
    prev = null;
  };

  for (const item of items) {
    if (item.kind === 'talk_over_intro') {
      if (hasVoice(item)) pendingOverlay = item; else notes.push({ slotId: item.slotId, note: 'dropped: no voice ready' });
      continue;
    }
    if (item.kind === 'station_id' || item.kind === 'filler') {
      const x = item.stinger || item.filler;
      push({ segmentId: mkId(item.slotId, 'stinger'), slotId: item.slotId, kind: item.kind === 'filler' ? 'filler' : 'stinger', trackId: x.id, startSec: t, durationSec: x.durationSec });
      t += x.durationSec; prev = null;
      continue;
    }
    if (item.kind === 'song') {
      const tr = item.track;
      let start = t, fadeIn = 0;
      if (prev) {
        const cf = crossfadePlan({ startSec: prev.startSec, durationSec: prev.durationSec, cues: prev.cues }, crossfade, { overlapSec });
        start = cf.incomingStartSec; fadeIn = cf.overlapSec;
        if (fadeIn > 0) prev.seg.fadeOutSec = fadeIn;
      }
      const prevSeg = prev && prev.seg;
      let voiceSeg = null;
      if (pendingOverlay) {
        const utts = pendingOverlay.voice.utterances.map((u) => ({ ...u }));
        const outroLen = prev ? prev.durationSec - ((prev.cues && Number.isFinite(prev.cues.outroStartSec)) ? prev.cues.outroStartSec : prev.durationSec) : 0;
        const plan = planTalkOverIntro({ songStartSec: start, cues: tr.cues, utterances: utts.map((u) => ({ ...u, durationSec: u.durationSec + (u.pauseSec ?? SCHED.utterancePauseSec) })), prevOutroSec: outroLen });
        if (plan.droppedIds.length) notes.push({ slotId: pendingOverlay.slotId, note: `trimmed ${plan.droppedIds.join(',')}` });
        if (plan.mode === 'between_songs') {
          standalone(pendingOverlay, utts);
          notes.push({ slotId: pendingOverlay.slotId, note: 'between_songs: intro unusable or too short' });
          start = t; fadeIn = 0; // no crossfade out of a break
          if (prevSeg) delete prevSeg.fadeOutSec;
        } else {
          const keep = utts.filter((u) => plan.keptIds.includes(u.id));
          voiceSeg = { segmentId: mkId(pendingOverlay.slotId, 'voice'), slotId: pendingOverlay.slotId, kind: 'voice', mode: plan.mode, startSec: plan.voiceStartSec, durationSec: Math.max(voiceDur(keep), 0.001), utterances: layoutUtterances(keep, plan.voiceStartSec), duck: { ...SCHED.duck } };
          notes.push({ slotId: pendingOverlay.slotId, note: plan.mode });
        }
        pendingOverlay = null;
      }
      const seg = push({ segmentId: mkId(item.slotId, 'song'), slotId: item.slotId, kind: 'song', trackId: tr.trackId, startSec: start, durationSec: tr.durationSec, ...(fadeIn > 0 ? { fadeInSec: fadeIn } : {}) });
      if (voiceSeg) push({ ...voiceSeg, attachedTo: seg.segmentId });
      prev = { startSec: start, durationSec: tr.durationSec, cues: tr.cues, seg };
      t = start + tr.durationSec;
      continue;
    }
    // talk kinds: standalone voice between songs
    if (hasVoice(item)) standalone(item, item.voice.utterances); else notes.push({ slotId: item.slotId, note: 'dropped: no voice ready' });
  }
  if (pendingOverlay) notes.push({ slotId: pendingOverlay.slotId, note: 'dropped: no song after overlay' });
  return { segments, endSec: t, notes };
}

// ── dead air ─────────────────────────────────────────────────────────────────

/** Gaps > toleranceSec in the union of segment coverage over [fromSec, toSec]. */
export function findDeadAir(segments, { fromSec, toSec, toleranceSec = SCHED.deadAirToleranceSec } = {}) {
  const iv = (segments || []).filter((s) => s.durationSec > 0).map((s) => [s.startSec, s.startSec + s.durationSec]).sort((a, b) => a[0] - b[0]);
  if (!iv.length) return [{ startSec: fromSec ?? 0, endSec: toSec ?? 0, lengthSec: (toSec ?? 0) - (fromSec ?? 0) }].filter((g) => g.lengthSec > toleranceSec);
  const from = fromSec ?? iv[0][0], to = toSec ?? Math.max(...iv.map((x) => x[1]));
  const gaps = [];
  let cover = from;
  for (const [a, b] of iv) {
    if (a > cover + toleranceSec + EPS && a > from) gaps.push({ startSec: cover, endSec: a, lengthSec: a - cover });
    cover = Math.max(cover, b);
  }
  if (to > cover + toleranceSec + EPS) gaps.push({ startSec: cover, endSec: to, lengthSec: to - cover });
  return gaps.filter((g) => g.startSec < to);
}

// ── safe points: caller / alert insertion ────────────────────────────────────

const segEnd = (s) => s.startSec + s.durationSec;

/**
 * Earliest point >= nowSec + minLeadSec where a live item may enter:
 *   - the end of the current utterance inside a standalone voice segment, or
 *   - the end of the stream underneath (song / stinger / filler); overlay voice rides along.
 * -> {atSec, afterSegmentId, reason:'utterance_end'|'song_boundary'|'segment_end'|'idle', afterUtteranceId?}
 */
export function findSafePoint(segments, nowSec, { minLeadSec = 0.5 } = {}) {
  const t0 = nowSec + minLeadSec;
  const segs = segments || [];
  const cur = segs.filter((s) => s.startSec <= nowSec + EPS && nowSec < segEnd(s) - EPS);
  if (!cur.length) return { atSec: nowSec, afterSegmentId: null, reason: 'idle' };
  const voice = cur.find((s) => s.kind === 'voice' && s.mode === 'between_songs' && s.utterances);
  if (voice) {
    for (const u of voice.utterances) {
      const e = u.startSec + u.durationSec;
      if (e >= t0) return { atSec: e, afterSegmentId: voice.segmentId, reason: 'utterance_end', afterUtteranceId: u.id };
    }
  }
  const stream = cur.filter((s) => s.kind !== 'voice').sort((a, b) => segEnd(b) - segEnd(a))[0] || voice;
  if (segEnd(stream) >= t0) return { atSec: segEnd(stream), afterSegmentId: stream.segmentId, reason: stream.kind === 'song' ? 'song_boundary' : 'segment_end' };
  const next = segs.filter((s) => s.kind !== 'voice' && segEnd(s) >= t0).sort((a, b) => segEnd(a) - segEnd(b))[0];
  return next ? { atSec: segEnd(next), afterSegmentId: next.segmentId, reason: next.kind === 'song' ? 'song_boundary' : 'segment_end' } : { atSec: segEnd(stream), afterSegmentId: stream.segmentId, reason: 'segment_end' };
}

const shiftSeg = (s, d) => ({ ...s, startSec: s.startSec + d, ...(s.utterances ? { utterances: s.utterances.map((u) => ({ ...u, startSec: u.startSec + d })) } : {}) });

/**
 * Insert a live call/alert (a voice segment of durationSec) at the safe point after nowSec.
 * Everything not yet started re-flows after it (an incoming crossfade is pushed past the
 * call's end, never overlapping it); a standalone voice segment is split at the utterance
 * boundary and resumes after the call. The music bed ducks to SCHED.callDuckDb under it.
 * -> {segments (sorted), call, safePoint}
 */
export function insertAtSafePoint(segments, nowSec, call, opts = {}) {
  const sp = findSafePoint(segments, nowSec, opts);
  const D = call.durationSec;
  const at = sp.atSec;
  const callSeg = {
    schemaVersion: 1, source: call.source || 'caller', segmentId: call.segmentId || 'call', slotId: call.slotId || 'call',
    kind: 'voice', mode: 'cold', startSec: at, durationSec: D, utterances: [{ id: call.segmentId || 'call', startSec: at, durationSec: D }], duck: { depthDb: SCHED.callDuckDb, leadMs: SCHED.duck.leadMs, releaseMs: SCHED.duck.releaseMs },
  };
  const out = [];
  if (sp.reason === 'utterance_end') {
    const v = segments.find((s) => s.segmentId === sp.afterSegmentId);
    const idx = v.utterances.findIndex((u) => u.id === sp.afterUtteranceId);
    const head = v.utterances.slice(0, idx + 1), tail = v.utterances.slice(idx + 1);
    for (const s of segments) {
      if (s !== v) { out.push(s.startSec > nowSec + EPS && segEnd(s) > at - EPS ? shiftSeg(s, D) : s); continue; }
      out.push({ ...v, utterances: head, durationSec: segEnd(head[head.length - 1]) - v.startSec }, callSeg);
      if (tail.length) {
        const ts = tail[0].startSec + D;
        out.push({ ...v, segmentId: `${v.segmentId}:resume`, startSec: ts, utterances: tail.map((u) => ({ ...u, startSec: u.startSec + D })), durationSec: segEnd(v) - tail[0].startSec });
      }
    }
  } else {
    // movers: not started yet and either at/after the boundary or still overlapping it (a crossfade
    // incoming); overlay voice moves with the song it is attached to.
    const movers = new Set(segments.filter((s) => s.kind !== 'voice' && s.startSec > nowSec + EPS && (s.startSec >= at - EPS || segEnd(s) > at + EPS)).map((s) => s.segmentId));
    for (const s of segments) if (s.attachedTo && movers.has(s.attachedTo) && s.startSec > nowSec + EPS) movers.add(s.segmentId);
    for (const s of segments) if (s.kind === 'voice' && !s.attachedTo && s.startSec > nowSec + EPS && s.startSec >= at - EPS) movers.add(s.segmentId);
    const starts = segments.filter((s) => movers.has(s.segmentId)).map((s) => s.startSec);
    const delta = D + (starts.length ? Math.max(0, at - Math.min(...starts)) : 0);
    for (const s of segments) out.push(movers.has(s.segmentId) ? shiftSeg(s, delta) : s);
    out.push(callSeg);
  }
  return { segments: out.sort((a, b) => a.startSec - b.startSec), call: callSeg, safePoint: sp };
}

// ── dead-air ladder (4.6) ────────────────────────────────────────────────────

/**
 * state = {talkReady, nextSongReady, anyDecodedTrack, online, secondsToSlot}
 * -> {rung:1..5, action:'normal'|'drop_talk'|'local_filler'|'any_decoded_track', badge?:'offline_music_only'}
 * Rung 5 (offline) is a badge on top of whichever of 2–4 applies, never speech.
 */
export function deadAirLadder({ talkReady = true, talkExpected = true, nextSongReady = true, anyDecodedTrack = true, online = true, secondsToSlot = Infinity } = {}) {
  const badge = online ? {} : { badge: 'offline_music_only' };
  if (!nextSongReady) {
    return anyDecodedTrack ? { rung: 4, action: 'any_decoded_track', ...badge } : { rung: 3, action: 'local_filler', ...badge };
  }
  if (talkExpected && !talkReady && secondsToSlot <= 8) return { rung: 2, action: 'drop_talk', ...badge };
  return { rung: online ? 1 : 5, action: 'normal', ...badge };
}
