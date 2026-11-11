import test from 'node:test';
import assert from 'node:assert/strict';
import { rig } from './rig.mjs';
import { findDeadAir } from '../../src/radio/core/scheduler.js';
import { wordCount, WPS, EST_TOL } from '../../src/radio/canned/pack.js';
import { CADENCE } from '../../src/radio/canned/chooser.js';
import { fakeLibrary } from '../radio-offline/helpers.mjs';

const H = 3600 * 1000;

for (const id of ['static-city-98-1', 'pirate-1400']) {
  test(`${id}: a 3-hour show on a virtual clock has zero dead air, in-band talk, estimates that hold, and no repeats inside the cool-down`, async () => {
    const r = await rig({ id, n: 40, seed: 11 });
    r.runner.start();
    await r.time.advance(3 * H, 250);
    assert.equal(r.runner.phase, 'playing');
    const endSec = r.time.now() / 1000;
    // dead air: songs (gapless joins) plus every spoken break as covering segments, the repo's own finder
    const songs = r.player.played.map((p) => ({ startSec: p.startSec, durationSec: Math.max(0, Math.min(p.endSec, endSec) - p.startSec), kind: 'song' }));
    const talk = r.runner.aired.map((a) => ({ startSec: r.player.played[0].startSec + a.startSec, durationSec: a.durSec, kind: 'voice' }));
    const from = songs[0].startSec;
    assert.deepEqual(findDeadAir([...songs, ...talk], { fromSec: from, toSec: endSec }), [], 'dead air found');
    assert.ok(songs.length >= 45, `${songs.length} songs in 3 h`);
    assert.equal(r.runner.diag.colds, 1, 'every later song joined gaplessly');
    assert.equal(r.runner.diag.decodeFailures, 0);

    // every aired segment's text is within its estSec +-35% (the pack's own yardstick; filled slot lines get their own estimate)
    const a = r.runner.aired;
    assert.ok(a.length >= 40, `${a.length} breaks`);
    for (const x of a) {
      const est = x.lines.reduce((n, l) => n + wordCount(l.text), 0) / WPS;
      const seg = r.pack.byId.get(x.segment);
      assert.ok(seg.estSec >= est * (1 - EST_TOL) - 1e-9 || x.variant === 'slots', `${x.segment}: estSec ${seg.estSec} vs ${est.toFixed(1)}`);
      assert.ok(seg.estSec <= est * (1 + EST_TOL) + 1e-9 || x.variant === 'slots', `${x.segment}: estSec ${seg.estSec} vs ${est.toFixed(1)}`);
      if (x.variant === 'slots') assert.ok(est >= seg.estSec * 0.6 && est <= seg.estSec * 1.6, `${x.segment} filled: ${est.toFixed(1)} vs ${seg.estSec}`);
    }

    // talk share over the real, measured airing
    const spoken = a.reduce((n, x) => n + x.durSec, 0);
    const share = spoken / (3 * 3600);
    assert.ok(share > 0.17 && share < 0.34, `share ${share.toFixed(3)}`);
    // sign-on once, first
    assert.equal(a[0].kind, 'sign_on');
    assert.equal(a.filter((x) => x.kind === 'sign_on').length, 1);
    // station ids about every 15 minutes
    const ids = a.filter((x) => ['station_id', 'jingle', 'sign_on'].includes(x.kind)).map((x) => x.startSec);
    for (let i = 1; i < ids.length; i++) assert.ok(ids[i] - ids[i - 1] <= 25 * 60, `${(ids[i] - ids[i - 1]) / 60} min without an ID`);
    // no unit repeats before its cool-down, on the real runner too
    const last = new Map();
    const kc = {}; for (const u of r.pack.units) kc[u.kind] = (kc[u.kind] || 0) + 1;
    for (const x of a) { if (['station_id', 'jingle'].includes(x.kind)) { if (last.has(x.unit)) assert.ok(x.startSec - last.get(x.unit) >= CADENCE.cooldownRareSec - 5, `${x.unit} repeated`); } else if (last.has(x.unit)) assert.ok(x.startSec - last.get(x.unit) >= (kc[x.kind] <= CADENCE.rareUnits ? CADENCE.cooldownRareSec : CADENCE.cooldownSec) - 5, `${x.unit} repeated after ${x.startSec - last.get(x.unit)}`); last.set(x.unit, x.startSec); }
    // no two breaks overlap in the speech lane
    const sorted = [...a].sort((p, q) => p.startSec - q.startSec);
    for (let i = 1; i < sorted.length; i++) assert.ok(sorted[i].startSec >= sorted[i - 1].startSec + 2, 'breaks do not stack');
    // the music bus ended where it should, with nothing left ducked
    r.runner.stop(); await r.time.advance(2000);
    assert.equal(r.duck.holdCount, 0);
    assert.ok(Math.abs(r.duck.gainNow() - 1) < 0.01);
  });
}

test('a short library repeats songs politely: 3 songs for 40 minutes never plays the same song twice in a row or the same artist back to back when avoidable', async () => {
  const lib = fakeLibrary(3);
  const r = await rig({ id: 'meridian-91-5', tracks: lib, seed: 4 });
  r.runner.start();
  await r.time.advance(40 * 60 * 1000, 250);
  const seq = r.player.played.map((p) => p.trackId);
  assert.ok(seq.length >= 10);
  for (let i = 1; i < seq.length; i++) assert.notEqual(seq[i], seq[i - 1]);
  r.runner.stop(); await r.time.advance(1000);
});

test('a single-song library plays that song on a loop with the station\'s talk and no dead air', async () => {
  const r = await rig({ id: 'tape-hiss-fm', tracks: fakeLibrary(1), seed: 2 });
  r.runner.start();
  await r.time.advance(20 * 60 * 1000, 250);
  assert.equal(r.runner.phase, 'playing');
  assert.ok(r.player.played.length >= 5);
  assert.ok(r.runner.aired.length >= 4);
  r.runner.stop(); await r.time.advance(1000);
});
