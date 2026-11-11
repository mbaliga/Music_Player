// ─────────────────────────────────────────────────────────────────────────────
// fake-adapters.js — deterministic stand-ins for every service the show depends on.
//
// Same method signatures the real adapters will have in P2, so the core is exercised
// end to end with no network, no vendor and no wall clock:
//
//   FakeContext   getSnapshot({nowMs})                       ContextProvider
//   FakeDirector  plan({snapshot, wantSlots, nowMs})         backend LLM gateway: /rundown
//   FakeWriter    write({slot, facts, persona})              backend LLM gateway: /script
//   FakeBrain     respond({transcript, library})             Caller Brain
//   FakeVoice     capabilities(), render({script})           TtsAdapter
//   FakeStt       finalize()                                 SttAdapter
//   FakeDecoder   decode(trackId)                            deck decode-ahead
//
// Every adapter has a configurable per-call delay (`delayMs`: number, fn(callIndex) or
// {base, jitter, seed}) that advances an injected VIRTUAL clock, and failure injection:
//   adapter.inject(kind, times = 1)   the next `times` calls misbehave as `kind`
//   adapter.injectAlways(kind)        every call does
// Kinds that throw: 'offline' 'timeout' 'http_429' 'refusal' 'tts_stall'; the rest return bad data
// (writer: 'invalid_json' 'hallucinate' 'unreferenced_claim' 'pii'; director: 'bad_hints'
// 'adjacent_talk' 'bad_first' 'wrong_horizon' 'garbage'; voice: 'tts_stall' (throws) 'fail'; ...).
// The injected clock is the only notion of time; nothing here touches Date or timers.
// ─────────────────────────────────────────────────────────────────────────────

import { mulberry32, hashSeed } from './util.js';
import { snapshotFixture, FIXTURE_NOW_MS } from './fixtures.js';
import { degradeUtterance, templateResolver, stripMarkup, CAPS_SSML } from './markup.js';

export class AdapterError extends Error {
  constructor(code, message) { super(message || code); this.name = 'AdapterError'; this.code = code; }
}

/** Virtual clock: delay() advances time instantly and resolves. */
export function createVirtualClock(startMs = 0) {
  let t = startMs;
  return {
    now: () => t,
    set: (ms) => { t = ms; },
    advance: (ms) => { t += ms; },
    delay: (ms) => { t += Math.max(0, ms); return Promise.resolve(); },
  };
}

const THROWING = new Set(['offline', 'timeout', 'http_429', 'refusal', 'tts_stall']);

class FakeBase {
  constructor({ name, clock = createVirtualClock(), delayMs = 0, seed = 1 } = {}) {
    this.name = name;
    this.clock = clock;
    this.delay = delayMs;
    this.rng = mulberry32(hashSeed(`${name}|${seed}`));
    this.calls = [];          // [{method, startedAt, endedAt, ms, fault}]
    this._faults = [];        // [{kind, left}]
    this._always = null;
  }
  inject(kind, times = 1) { this._faults.push({ kind, left: times }); return this; }
  injectAlways(kind) { this._always = kind; return this; }
  clearFaults() { this._faults = []; this._always = null; return this; }
  _nextFault() {
    if (this._always) return this._always;
    while (this._faults.length && this._faults[0].left <= 0) this._faults.shift();
    if (!this._faults.length) return null;
    this._faults[0].left--;
    return this._faults[0].kind;
  }
  _delayFor(i) {
    const d = this.delay;
    if (typeof d === 'function') return d(i);
    if (d && typeof d === 'object') return Math.max(0, d.base + (this.rng() * 2 - 1) * (d.jitter || 0));
    return d || 0;
  }
  /** wait the configured delay, record the call, throw for throwing faults, else hand the fault to fn */
  async _call(method, fn, faultDelaysMs = {}) {
    const i = this.calls.length;
    const fault = this._nextFault();
    const startedAt = this.clock.now();
    await this.clock.delay(this._delayFor(i) + (faultDelaysMs[fault] || 0));
    this.calls.push({ method, startedAt, endedAt: this.clock.now(), ms: this.clock.now() - startedAt, fault });
    if (fault && THROWING.has(fault)) throw new AdapterError(fault, `${this.name}.${method}: ${fault}`);
    return fn(fault);
  }
}

// ── Context ──────────────────────────────────────────────────────────────────

const shiftIso = (iso, ms) => new Date(Date.parse(iso) + ms).toISOString();

export class FakeContext extends FakeBase {
  constructor(o = {}) { super({ name: 'context', ...o }); this.scenario = o.scenario || 'rainy-commute'; this.ttlSec = o.ttlSec ?? null; }
  /** Fixture scenario re-dated to `nowMs` (fresh asOf for every fact that was fresh in the fixture). */
  async getSnapshot({ nowMs = FIXTURE_NOW_MS, scenario } = {}) {
    return this._call('getSnapshot', (fault) => {
      const s = snapshotFixture(scenario || this.scenario);
      const delta = nowMs - FIXTURE_NOW_MS;
      s.snapshotId = `${s.snapshotId}@${nowMs}`;
      s.takenAt = shiftIso(s.takenAt, delta);
      s.facts = s.facts.map((f) => ({ ...f, asOf: shiftIso(f.asOf, delta), ...(this.ttlSec ? { ttlSec: Math.min(f.ttlSec, this.ttlSec) } : {}) }));
      if (fault === 'weather_down') {
        s.serviceStatus = { ...s.serviceStatus, weather: 'down' };
        s.facts = s.facts.filter((f) => f.kind !== 'weather' && f.kind !== 'forecast');
      }
      return s;
    });
  }
}

// ── Director ─────────────────────────────────────────────────────────────────

const UNITS = [
  ['song'], ['talk_over_intro', 'song'], ['song', 'talk_break'], ['song'], ['talk_over_intro', 'song'], ['song', 'weather_hit'],
  ['song', 'talk_break'], ['song', 'caller_invite'], ['song'], ['talk_over_intro', 'song'], ['song', 'talk_break'], ['station_id'],
];
const KIND_SEC = { song: 200, talk_over_intro: 12, talk_break: 45, weather_hit: 40, caller_invite: 20, station_id: 6, sign_on: 20, sign_off: 20 };

export class FakeDirector extends FakeBase {
  constructor(o = {}) { super({ name: 'director', ...o }); this.seq = 0; this.unit = 0; }
  /** Raw rundown JSON as an LLM might emit it (arithmetic and ids NOT trustworthy when faults are injected). */
  async plan({ snapshot, wantSlots = 8, nowMs = 0 } = {}) {
    return this._call('plan', (fault) => {
      if (fault === 'garbage') return { oops: 'not a rundown' };
      const cands = (snapshot.libraryDigest && snapshot.libraryDigest.candidates) || [];
      const hasWx = snapshot.facts.some((f) => f.id === 'wx.now');
      const slots = [];
      const rng = mulberry32(hashSeed(`dir|${this.unit}|${snapshot.snapshotId}`));
      const first = this.seq === 0;
      if (first) slots.push({ slotId: `d${this.seq++}`, kind: 'station_id', targetSec: 6 });
      while (slots.filter((s) => s.kind !== 'talk_over_intro').length < wantSlots) {
        const unit = UNITS[this.unit++ % UNITS.length];
        for (let kind of unit) {
          const slot = { slotId: `d${this.seq++}`, kind, targetSec: KIND_SEC[kind] };
          if (kind === 'song') slot.song = { constraints: { energy: Math.round(rng() * 10) / 10, genres: [] }, trackIdHint: cands.length && rng() < 0.4 ? cands[Math.floor(rng() * cands.length)].trackId : null };
          else if (kind === 'weather_hit') slot.talk = { budgetSec: 36, purpose: 'weather', factIds: hasWx ? ['wx.now', 'wx.next6h'].filter((id) => snapshot.facts.some((f) => f.id === id)) : [], mood: 'wry' };
          else if (kind === 'talk_break') slot.talk = { budgetSec: 40, purpose: 'chat', factIds: hasWx && rng() < 0.5 ? ['wx.now'] : [], mood: 'warm' };
          else if (kind === 'talk_over_intro') slot.talk = { budgetSec: 10, purpose: 'intro', factIds: [], mode: 'over_intro', mood: 'warm' };
          else if (kind === 'caller_invite') { slot.talk = { budgetSec: 16, purpose: 'invite a call', factIds: [] }; slot.skippable = true; }
          slots.push(slot);
        }
      }
      if (fault === 'bad_hints') for (const s of slots) if (s.kind === 'song') s.song.trackIdHint = `invented-${s.slotId}`;
      if (fault === 'adjacent_talk') slots.splice(2, 0, { slotId: 'adj1', kind: 'talk_break', targetSec: 20, talk: { budgetSec: 15, factIds: [] } }, { slotId: 'adj2', kind: 'talk_break', targetSec: 20, talk: { budgetSec: 15, factIds: [] } });
      if (fault === 'bad_first') slots.unshift({ slotId: 'bf0', kind: 'talk_break', targetSec: 20, talk: { budgetSec: 15, factIds: [] } });
      const real = slots.filter((s) => s.kind !== 'talk_over_intro').reduce((a, s) => a + s.targetSec, 0);
      return {
        schemaVersion: 1, rundownId: `fx-rd-${this.calls.length}`, snapshotId: snapshot.snapshotId,
        horizonSec: fault === 'wrong_horizon' ? real * 3 : real,
        showSeed: { theme: 'fixture show', moodArc: ['warm', 'wry'], runningGag: null, callbackFromMemory: null },
        slots: slots.slice(0, 12),
      };
    });
  }
}

// ── Writer ───────────────────────────────────────────────────────────────────

const FILLERS = [
  'Settle in, we have got plenty more coming.', 'Keep it close and turn it up a little.', 'That one has a lovely long fade.',
  'Take your time, nobody is rushing you here.', 'Here is something with a little room in it.', 'Let that one ring out for a moment.',
  'Easy does it as the evening unfolds.', 'No hurry at all, the crate is deep tonight.',
];

export class FakeWriter extends FakeBase {
  constructor(o = {}) { super({ name: 'writer', ...o }); }
  /**
   * Returns a Script (object). Copies fact `say` strings verbatim into utterances, with factRefs.
   * A regeneration is just another call: it is clean unless another fault is injected.
   */
  async write({ slot, facts = [], persona = {}, seed = 0 } = {}) {
    return this._call('write', (fault) => {
      if (fault === 'invalid_json') return '{"slotId": "oops", utterances: [';
      const r = mulberry32(hashSeed(`${slot.slotId}|${seed}`));
      const budget = (slot.talk && slot.talk.budgetSec) || 12;
      const nUtt = budget >= 20 ? 3 : budget >= 10 ? 2 : 1;
      const u = (i, text, factRefs, o = {}) => ({ id: `${slot.slotId}.${i}`, text, style: { emotion: o.emotion || 'warm', energy: 0.5, pace: 1 }, factRefs, droppable: !!o.droppable });
      const utts = [];
      const used = [...facts];
      const station = persona.stationName ? `You are with ${persona.rjName || 'me'} on ${persona.stationName}.` : '';
      // ~2.5 words/s at ~8 words per sentence, aiming at 75% of the budget so the break fits its slot
      const perUtt = Math.max(1, Math.round((budget * 2.5 * 0.75) / nUtt / 8));
      for (let i = 0; i < nUtt; i++) {
        const f = used.shift();
        const sentences = [];
        if (f) sentences.push(`Right now it is ${f.say}.`);
        while (sentences.length < perUtt) sentences.push(FILLERS[Math.floor(r() * FILLERS.length)]);
        if (!f && i === nUtt - 1 && station && slot.kind !== 'talk_over_intro') sentences.push(station);
        utts.push(u(i + 1, sentences.join(' '), f ? [f.id] : [], { droppable: i > 0 }));
      }
      if (fault === 'hallucinate') utts[0].text += ' Expect 99 inches of snow by dawn.';
      if (fault === 'unreferenced_claim') utts[0].text = 'Traffic is a nightmare out there tonight.';
      if (fault === 'pii') utts[0].text += ' Call 555 010 9999 to chat.';
      return { schemaVersion: 1, slotId: slot.slotId, utterances: utts };
    });
  }
}

// ── Caller Brain ─────────────────────────────────────────────────────────────

export class FakeBrain extends FakeBase {
  constructor(o = {}) { super({ name: 'brain', ...o }); this.scripted = o.scripted || null; }
  /** -> {script, actions[], safety}. `scripted` can force actions (e.g. hostile ones) to test the filter. */
  async respond({ transcript = '', slotId = 'call' } = {}) {
    return this._call('respond', () => {
      const s = this.scripted || {};
      const text = /slow/i.test(transcript) ? 'Slow it is. Let me find something gentle.' : 'Good to hear from you. Let me see what I can do.';
      return {
        script: { schemaVersion: 1, slotId, utterances: [{ id: `${slotId}.1`, text, style: { emotion: 'warm', energy: 0.5, pace: 1 }, factRefs: [] }] },
        actions: s.actions ?? [{ type: 'request_song', query: transcript.slice(0, 60) || 'something nice', dedication: null }],
        safety: s.safety ?? 'ok',
      };
    });
  }
}

// ── Voice (TTS) ──────────────────────────────────────────────────────────────

export const TTS_STALL_MS = 2500;
const wordsOf = (t) => (stripMarkup(t).match(/\S+/g) || []).length;

export class FakeVoice extends FakeBase {
  constructor(o = {}) { super({ name: 'voice', delayMs: 250, ...o }); this.caps = o.caps || CAPS_SSML; this.wordsPerSec = o.wordsPerSec || 2.5; this.firstByteMs = o.firstByteMs ?? 250; }
  capabilities() { return this.caps; }
  /**
   * Render a Script: per-utterance duration (words / (wps * pace) + pauseAfterMs) and the
   * capability-degraded body each utterance would be sent as. A first byte later than 2.5 s is a stall.
   */
  async render({ script, nowParts } = {}) {
    return this._call('render', (fault) => {
      if (fault === 'fail') throw new AdapterError('tts_failed', 'voice.render: failed');
      const resolve = templateResolver(nowParts || {});
      const utterances = script.utterances.map((u) => {
        const w = wordsOf(u.text);
        const pauseSec = (u.pauseAfterMs || 0) / 1000;
        return { id: u.id, durationSec: Math.round((w / (this.wordsPerSec * (u.style.pace || 1)) + pauseSec) * 100) / 100, droppable: !!u.droppable, pauseSec: 0.15, rendered: degradeUtterance(u, this.caps, { resolve }) };
      });
      return { audioId: `audio:${script.slotId}`, utterances, durationSec: utterances.reduce((a, u) => a + u.durationSec, 0), firstByteMs: this.firstByteMs };
    }, { tts_stall: TTS_STALL_MS }); // 'tts_stall': no first byte within 2.5 s -> the adapter's own timeout throws
  }
}

// ── STT ──────────────────────────────────────────────────────────────────────

export class FakeStt extends FakeBase {
  constructor(o = {}) { super({ name: 'stt', delayMs: 150, ...o }); this.queue = [...(o.scripted || [])]; }
  say(text, confidence = 0.92) { this.queue.push({ text, confidence }); return this; }
  async finalize() {
    return this._call('finalize', (fault) => {
      if (fault === 'garbage') return { text: '', confidence: 0.1 };
      if (fault === 'mic_denied') throw new AdapterError('mic_denied', 'stt: microphone permission denied');
      return this.queue.shift() || { text: '', confidence: 0 };
    });
  }
}

// ── Decoder ──────────────────────────────────────────────────────────────────

export class FakeDecoder extends FakeBase {
  constructor(o = {}) { super({ name: 'decoder', delayMs: 3000, ...o }); }
  /** -> {trackId}; 'oom' / 'fail' model decode failure under memory pressure. */
  async decode(trackId) {
    return this._call('decode', (fault) => {
      if (fault === 'oom' || fault === 'fail') throw new AdapterError('decode_failed', `decoder: ${fault}`);
      return { trackId };
    });
  }
}
