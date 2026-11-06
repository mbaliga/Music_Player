// The long simulated OFFLINE show: the repo's own runSimulatedShow driven by the offline Director, Writer, Voice and Context,
// on a virtual clock, asserting zero dead air and a verified script for every break. Plus: it needs no network at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runSimulatedShow } from '../../src/radio/core/sim.js';
import { createVirtualClock } from '../../src/radio/core/fake-adapters.js';
import { findDeadAir, SCHED } from '../../src/radio/core/scheduler.js';
import { verifyScript } from '../../src/radio/core/grounding.js';
import { validateScript, validateSegment, validateRundown } from '../../src/radio/core/schemas.js';
import { createOfflineContext } from '../../src/radio/offline/context.js';
import { createOfflineDirector } from '../../src/radio/offline/director.js';
import { createTemplateWriter } from '../../src/radio/offline/writer.js';
import { createSystemVoice, webSpeechBackend } from '../../src/radio/offline/voice.js';
import { repairRundown, rundownProblems } from '../../src/radio/core/director-client.js';
import { fakeTime, FakeSynth, FakeUtterance, VOICES, fakeLibrary } from './helpers.mjs';
import { rig } from './rig.mjs';

const START = Date.parse('2026-11-04T18:05:00Z');

function offlineAdapters({ n = 60, seed = 1, location = null } = {}) {
  const clock = createVirtualClock(START);
  const lib = fakeLibrary(n).map((t) => ({ ...t, durationSec: 170 + ((Number(t.id.slice(1)) * 13) % 80) }));
  const time = fakeTime(START);
  const voice0 = createSystemVoice({ backends: [webSpeechBackend({ synth: new FakeSynth(time, { voices: VOICES }), Utterance: FakeUtterance, timers: time.timers })], timers: time.timers, now: time.now });
  const context = createOfflineContext({ getTracks: () => lib, getLocation: () => location, utcOffsetMin: 0, seed });
  const director = createOfflineDirector({ seed });
  const writer = createTemplateWriter({ seed });
  const wrap = (name, obj, methods) => { const w = { calls: [], name }; for (const m of methods) w[m] = (...a) => { w.calls.push(m); return obj[m](...a); }; return w; };
  return {
    clock, lib,
    context, director, writer,
    voice: { calls: [], capabilities: () => voice0.capabilities(), render(a) { this.calls.push('render'); return voice0.render(a); } },
    decoder: { calls: [], async decode(id) { this.calls.push(id); return { trackId: id }; } },
    stt: null, brain: null,
  };
}

test('a 45-minute offline show: zero dead air, every break verified, mostly music, library tracks only', async () => {
  const a = offlineAdapters({ seed: 3 });
  const r = await runSimulatedShow({ adapters: a, durationSec: 2700, seed: 3 });
  assert.ok(r.endSec >= 2700);
  assert.deepEqual(r.deadAir, [], 'dead air found');
  assert.deepEqual(findDeadAir(r.segments, { fromSec: 0, toSec: r.endSec, toleranceSec: SCHED.deadAirToleranceSec }), []);
  for (const s of r.segments) assert.deepEqual(validateSegment(s), { ok: true, errors: [] });
  assert.ok(r.aired.length >= 8, `only ${r.aired.length} breaks`);
  for (const x of r.aired) {
    assert.deepEqual(validateScript(x.script), { ok: true, errors: [] });
    const v = verifyScript(x.script, x.snapshot, { atMs: x.airAtMs });
    assert.equal(v.ok, true, `${x.slotId}: ${JSON.stringify(v.problems)}`);
  }
  assert.ok(r.musicFraction > 0.85 && r.musicFraction < 1, `music fraction ${r.musicFraction}`);
  const libIds = new Set(a.lib.map((t) => t.id));
  assert.ok(r.played.length >= 10 && r.played.every((id) => libIds.has(id)));
  assert.equal(new Set(r.played).size, r.played.length, 'no repeats');
  assert.equal(r.fallbacks.filter((f) => f.kind === 'local_filler').length, 0, 'never needed the filler ladder');
  assert.deepEqual(r.errors, []);
});

test('a 3-hour offline show with a small library: still zero dead air, no repeats within a round, no errors', async () => {
  const a = offlineAdapters({ n: 25, seed: 8, location: { lat: 47.6, lon: -122.3 } });
  const r = await runSimulatedShow({ adapters: a, durationSec: 3 * 3600, seed: 8 });
  assert.deepEqual(r.deadAir, []);
  assert.deepEqual(r.errors, []);
  assert.ok(r.aired.length >= 20, `only ${r.aired.length} breaks in 3 hours`);
  for (const x of r.aired) assert.equal(verifyScript(x.script, x.snapshot, { atMs: x.airAtMs }).ok, true, x.slotId);
  // sun/season lines appeared, backed by facts
  assert.ok(r.aired.some((x) => x.script.utterances.some((u) => (u.factRefs || []).some((f) => f.startsWith('sun.') || f === 'season.now'))));
});

test('the offline Director’s rundowns pass the repo’s own property checks, with or without repair', async () => {
  const a = offlineAdapters({ n: 30 });
  for (let k = 0; k < 20; k++) {
    const snap = await a.context.getSnapshot({ nowMs: START + k * 600000 });
    const raw = await a.director.plan({ snapshot: snap, wantSlots: 8, nowMs: START + k * 600000 });
    assert.deepEqual(validateRundown(raw), { ok: true, errors: [] }, `raw rundown ${k}`);
    const r = repairRundown(raw, { snapshot: snap, atMs: START, idPrefix: `p${k}:`, previousKind: k ? 'song' : null });
    assert.equal(r.ok, true);
    if (k === 0) assert.deepEqual(rundownProblems(r.rundown, snap), []);
    // weather / traffic / place are never planned
    assert.equal(raw.slots.some((s) => ['weather_hit', 'traffic_hit', 'place_hit'].includes(s.kind)), false);
    for (const s of raw.slots) for (const id of (s.talk && s.talk.factIds) || []) assert.ok(snap.facts.some((f) => f.id === id), `fact ${id} exists`);
  }
  const first = (await a.director.plan({ snapshot: await a.context.getSnapshot({ nowMs: START }), wantSlots: 8, nowMs: START }));
  assert.ok(first.slots.length > 0);
});

test('NO NETWORK: a full offline show (simulated and live-runner) with fetch, XHR, WebSocket, EventSource and beacons all booby-trapped', async () => {
  const hits = [];
  const trap = (name) => function trapped() { hits.push(name); throw new Error(`network used: ${name}`); };
  const saved = {};
  const names = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'RTCPeerConnection'];
  for (const n of names) { saved[n] = globalThis[n]; globalThis[n] = trap(n); }
  const hadNav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { sendBeacon: trap('sendBeacon'), onLine: false, connection: undefined }, configurable: true });
  try {
    const a = offlineAdapters({ seed: 5 });
    const sim = await runSimulatedShow({ adapters: a, durationSec: 1800, seed: 5 });
    assert.deepEqual(sim.deadAir, []);
    assert.ok(sim.aired.length > 3);
    const r = await rig({ seed: 5, location: { lat: 51.5, lon: -0.1 } });
    r.runner.start();
    await r.time.advance(15 * 60 * 1000);
    assert.equal(r.runner.phase, 'playing');
    assert.ok(r.runner.aired.length > 2);
    r.runner.skip(); await r.time.advance(2000);
    r.runner.stop(); await r.time.advance(1000);
  } finally {
    for (const n of names) { if (saved[n] === undefined) delete globalThis[n]; else globalThis[n] = saved[n]; }
    if (hadNav) Object.defineProperty(globalThis, 'navigator', hadNav); else delete globalThis.navigator;
  }
  assert.deepEqual(hits, [], 'something touched the network');
});
