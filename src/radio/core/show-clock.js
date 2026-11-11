// ─────────────────────────────────────────────────────────────────────────────
// show-clock.js — the rolling-horizon show state machine (architecture 5).
//
// A show is a rolling rundown, not a script. ShowClock owns the TIMELINE of slots
// (planned start/end on the show/audio clock, in seconds) and answers one question:
// "what must be started or finished by now?". It does not do the work (that is the
// adapters' job) and it never reads a wall clock: callers pass `nowSec`.
//
// Lead times (the §5 table):
//   song selection   when the slot is 3 slots ahead      (LEAD.selectSlots)
//   script (Writer)  2 slots ahead                        (LEAD.scriptSlots)
//   TTS render       1 slot ahead AND >= 90 s buffer      (LEAD.ttsSlots, ttsMinBufferSec)
//   song decode      45 s before air (30–60 s window)     (LEAD.decodeLeadSec)
//   rundown horizon  keep 6–8 slots (about 25–30 min)     (LEAD.horizonSlots)
// "N slots ahead" means: the task starts when slot (index - N) begins airing.
//
// Overlay slots (talk_over_intro) take no timeline time; their effective position is
// that of the song after them. Hard deadlines feed the dead-air ladder (scheduler.js).
// ─────────────────────────────────────────────────────────────────────────────

import { SCRIPTED_KINDS, OVERLAY_KINDS } from './director-client.js';

export const LEAD = Object.freeze({
  horizonSlots: Object.freeze({ min: 6, max: 8 }),
  selectSlots: 3,
  scriptSlots: 2,
  ttsSlots: 1,
  ttsMinBufferSec: 90,
  decodeLeadSec: 45,
  decodeLeadRangeSec: Object.freeze([30, 60]),
  /** talk audio must exist this long before its slot, else the slot is dropped (ladder rung 2) */
  talkCutoffSec: 8,
});

export const STAGES = Object.freeze(['select', 'script', 'tts', 'decode']);

const needs = (kind) => ({
  select: kind === 'song',
  script: SCRIPTED_KINDS.includes(kind),
  tts: SCRIPTED_KINDS.includes(kind),
  decode: kind === 'song',
});

export class ShowClock {
  constructor({ startSec = 0, lead = LEAD } = {}) {
    this.startSec = startSec;
    this.lead = lead;
    this.entries = []; // {slot, status:'pending'|'airing'|'done'|'dropped', start, end, actualStart?, stages:{}}
    this._cursor = startSec; // where the next appended slot starts
  }

  // ── building the timeline ──────────────────────────────────────────────────
  _layout() {
    let t = this.startSec;
    for (const e of this.entries) {
      if (e.status === 'dropped') continue;
      if (e.status === 'done' || e.status === 'airing') { t = e.end; if (e.overlay) t = e.start; continue; }
      e.start = t;
      e.end = e.overlay ? t : t + e.slot.targetSec;
      t = e.end;
    }
    this._cursor = t;
  }

  /** Append repaired rundown slots to the end of the timeline. */
  append(slots) {
    for (const slot of slots) {
      if (this.entries.some((e) => e.slot.slotId === slot.slotId)) continue;
      this.entries.push({ slot, status: 'pending', start: 0, end: 0, overlay: OVERLAY_KINDS.includes(slot.kind), stages: {} });
    }
    this._layout();
    return this;
  }

  get(slotId) { return this.entries.find((e) => e.slot.slotId === slotId) || null; }
  get endSec() { return this._cursor; }
  live() { return this.entries.filter((e) => e.status !== 'dropped'); }
  pending() { return this.entries.filter((e) => e.status === 'pending'); }

  // ── progress reports from the bus ──────────────────────────────────────────
  begin(slotId, atSec) {
    const e = this.get(slotId);
    if (!e || e.status === 'dropped') return false;
    e.status = 'airing'; e.actualStart = atSec; e.start = atSec; e.end = e.overlay ? atSec : atSec + e.slot.targetSec;
    this._layout();
    return true;
  }
  /** Real end time replaces the plan; later slots re-flow. */
  complete(slotId, atSec) {
    const e = this.get(slotId);
    if (!e || e.status === 'dropped') return false;
    e.status = 'done'; e.end = atSec;
    this._layout();
    return true;
  }
  /** Remove a pending slot (talk not ready, skipped); later slots move up. */
  drop(slotId) {
    const e = this.get(slotId);
    if (!e || e.status === 'airing' || e.status === 'done') return false;
    e.status = 'dropped';
    this._layout();
    return true;
  }
  markDone(slotId, stage) { const e = this.get(slotId); if (e) e.stages[stage] = true; }

  /** Early invalidation by a live event: drop every PENDING slot after `slotId` (or all pending). Returns the dropped slots. */
  invalidateAfter(slotId = null) {
    let from = slotId === null ? 0 : this.entries.findIndex((e) => e.slot.slotId === slotId) + 1;
    if (slotId !== null && from === 0) return [];
    const dropped = [];
    for (let i = from; i < this.entries.length; i++) if (this.entries[i].status === 'pending') { this.entries[i].status = 'dropped'; dropped.push(this.entries[i].slot); }
    this._layout();
    return dropped;
  }

  /** Insert a live slot (caller/alert) right after `afterSlotId` (a safe point). */
  insertAfter(afterSlotId, slot) {
    const i = this.entries.findIndex((e) => e.slot.slotId === afterSlotId);
    if (i < 0) return false;
    this.entries.splice(i + 1, 0, { slot, status: 'pending', start: 0, end: 0, overlay: OVERLAY_KINDS.includes(slot.kind), stages: {} });
    this._layout();
    return true;
  }

  // ── what is due ────────────────────────────────────────────────────────────
  /** start of the slot `n` positions before entry i, counting only slots that take time (overlays sit on their song) */
  _startMinus(i, n) {
    const list = this.live().filter((e) => !e.overlay);
    let pos = list.indexOf(this.entries[i]);
    if (pos < 0) pos = list.findIndex((e) => this.entries.indexOf(e) > i); // overlay: the song after it
    if (pos < 0) pos = list.length;
    const anchor = list[Math.max(0, pos - n)];
    return anchor ? Math.min(anchor.start, this.entries[i].start) : this.startSec;
  }

  _plan(e, i) {
    const L = this.lead;
    const a = e.start;
    const t = {
      select: this._startMinus(i, L.selectSlots),
      script: this._startMinus(i, L.scriptSlots),
      tts: Math.min(this._startMinus(i, L.ttsSlots), a - L.ttsMinBufferSec),
      decode: a - L.decodeLeadSec,
    };
    // a task can never start before its prerequisite could: clamp to show start
    for (const k of Object.keys(t)) t[k] = Math.max(this.startSec, t[k]);
    const deadline = {
      select: a - L.decodeLeadSec, script: a - L.talkCutoffSec - 1, tts: a - L.talkCutoffSec, decode: a,
    };
    return { startAt: t, deadline };
  }

  /**
   * Tasks that should be running at nowSec: [{slotId, stage, startAtSec, deadlineSec, blockedBy}].
   * Sorted by deadline. Does not include done stages or non-pending slots.
   */
  due(nowSec) {
    const out = [];
    this.entries.forEach((e, i) => {
      if (e.status !== 'pending') return;
      const n = needs(e.slot.kind);
      const p = this._plan(e, i);
      for (const stage of STAGES) {
        if (!n[stage] || e.stages[stage]) continue;
        if (p.startAt[stage] > nowSec + 1e-9) continue;
        out.push({
          slotId: e.slot.slotId, stage, startAtSec: p.startAt[stage], deadlineSec: p.deadline[stage],
          blockedBy: stage === 'tts' && !e.stages.script ? 'script' : null,
        });
      }
    });
    return out.sort((x, y) => x.deadlineSec - y.deadlineSec || STAGES.indexOf(x.stage) - STAGES.indexOf(y.stage));
  }

  /** Tasks past their hard deadline at nowSec (feed these to the dead-air ladder). */
  overdue(nowSec) { return this.due(nowSec).filter((t) => t.deadlineSec < nowSec); }

  /** Does the rundown need extending? How many slots to ask the Director for? */
  horizon() {
    const ahead = this.pending().filter((e) => !e.overlay).length;
    const need = ahead < this.lead.horizonSlots.min;
    return { ahead, needMore: need, want: need ? this.lead.horizonSlots.max - ahead : 0 };
  }

  /** Slot airing at nowSec, or null (gap / before start / after end). */
  at(nowSec) {
    return this.live().find((e) => !e.overlay && e.start <= nowSec + 1e-9 && nowSec < e.end - 1e-9) || null;
  }
}
