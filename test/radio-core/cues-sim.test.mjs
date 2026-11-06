import test from 'node:test';
import assert from 'node:assert/strict';
import { runSimulatedShow, extractedCuesFor } from '../../src/radio/core/sim.js';
import { makeLibrary } from '../../src/radio/core/fixtures.js';
import { findDeadAir } from '../../src/radio/core/scheduler.js';
import { validateSegment } from '../../src/radio/core/schemas.js';

const end = (r) => Math.max(...r.segments.map((s) => s.startSec + s.durationSec));

test('extracted cues on synthetic audio track the hand-set fixture cues; low-confidence tracks stay honest', () => {
  let n = 0, lowSeen = 0;
  for (const c of makeLibrary(40, 7)) {
    const x = extractedCuesFor(c);
    n++;
    if (c.cues.confidence === 'low') {
      lowSeen++;
      assert.ok(x.introEndSec === null || x.confidence !== 'high', `${c.trackId} ${JSON.stringify(x)}`);
    } else {
      assert.ok(Math.abs(x.introEndSec - c.cues.introEndSec) <= 1, `${c.trackId} introEnd ${x.introEndSec} vs ${c.cues.introEndSec}`);
      assert.ok(Math.abs(x.outroStartSec - c.cues.outroStartSec) <= 4, `${c.trackId} outroStart ${x.outroStartSec} vs ${c.cues.outroStartSec}`);
      assert.notEqual(x.confidence, 'low');
    }
    assert.ok(x.startTrimSec >= 0.3 && x.endTrimSec >= 0.5);
  }
  assert.ok(lowSeen > 0 && n === 40);
});

test('45-minute show with extracted cues: zero dead air, deterministic, talk over intro still happens', async () => {
  const a = await runSimulatedShow({ durationSec: 2700, cues: 'extracted' });
  const b = await runSimulatedShow({ durationSec: 2700, cues: 'extracted' });
  assert.deepEqual(a.deadAir, []);
  assert.deepEqual(findDeadAir(a.segments, { fromSec: 0, toSec: end(a) }), []);
  for (const s of a.segments) assert.equal(validateSegment(s).ok, true);
  assert.deepEqual(a.segments, b.segments);
  assert.ok(a.segments.some((s) => s.mode === 'over_intro'));
  const radio = await runSimulatedShow({ durationSec: 1500, cues: 'extracted', crossfade: 'radio' });
  assert.deepEqual(radio.deadAir, []);
});

test('hand-set path and per-track override still work', async () => {
  const h = await runSimulatedShow({ durationSec: 1500, cues: 'handset' });
  assert.deepEqual(h.deadAir, []);
  const x = extractedCuesFor(makeLibrary(5, 7)[0], { t001: { introEndSec: 3, confidence: 'high' } });
  assert.equal(x.introEndSec, 3);
  const o = await runSimulatedShow({ durationSec: 1500, cues: 'extracted', cueOverrides: Object.fromEntries(makeLibrary(20).map((t) => [t.trackId, { introEndSec: null, confidence: 'low' }])) });
  assert.deepEqual(o.deadAir, []);
  assert.ok(!o.segments.some((s) => s.mode === 'over_intro'), 'every cue overridden to null: no talk-over-intro');
});
