// Regression tests for the chooser review fixes: cool-down tiers, the talk-share ceiling when an ID cannot air, gag levels from
// airable units only (per-gag seq), and finished gags. Each fails on the pre-fix chooser/pack code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createChooser, CADENCE } from '../../src/radio/canned/chooser.js';
import { buildPack, gagLevels, parsePack, validatePackDoc } from '../../src/radio/canned/pack.js';
import { slotValues } from '../../src/radio/canned/slots.js';
import { simulate, talkShare, STATION_IDS, loadPackFile, LIB } from '../support/canned-sim.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const docOf = (id) => JSON.parse(readFileSync(resolve(root, 'content/stations', `${id}.json`), 'utf8'));
const ID_KINDS = new Set(['station_id', 'jingle']);
const SEEDS = Array.from({ length: 40 }, (_, i) => i + 1);

test('cool-down tiers: 25 min only for ID/jingle units, the 45-minute floor for small pools, 90 min for pools of 5+; relaxing never goes below the floor for talk', () => {
  let draws = 0, small = 0;
  for (const id of STATION_IDS) {
    const pack = loadPackFile(id);
    const kindCount = {}; for (const u of pack.units) kindCount[u.kind] = (kindCount[u.kind] || 0) + 1;
    for (const seed of SEEDS) {
      const sim = simulate(pack, { hours: 6, seed });
      const last = new Map();
      for (const b of sim.breaks) {
        if (b.kind === 'sign_on' || b.kind === 'sign_off') continue;
        if (last.has(b.unit)) {
          draws++;
          const gap = b.startSec - last.get(b.unit);
          if (ID_KINDS.has(b.kind)) assert.ok(gap >= CADENCE.cooldownRareSec - 1, `${id}/${seed} ${b.unit} ${gap}`);
          else if (kindCount[b.kind] <= CADENCE.rareUnits) { small++; assert.ok(gap >= CADENCE.hardFloorSec - 1, `${id}/${seed} ${b.unit} (${b.kind}) repeated after ${(gap / 60).toFixed(0)} min`); }
          else assert.ok(gap >= (b.plan.why === 'relaxed cool-down' ? CADENCE.hardFloorSec : CADENCE.cooldownSec) - 1, `${id}/${seed} ${b.unit} ${gap}`);
        }
        last.set(b.unit, b.startSec);
      }
    }
  }
  assert.ok(draws > 3000 && small > 200, `${draws} repeats, ${small} small-pool repeats`);
});

test('everything cooling down gives silence (music only), never an early repeat', () => {
  const doc = docOf('meridian-91-5');
  doc.segments = doc.segments.filter((s) => s.kind === 'sign_on' || s.kind === 'sign_off' || s.kind === 'news');
  doc.segments = doc.segments.filter((s) => !s.fallbackOf && !(s.usesSlots || []).length);
  const pack = buildPack(doc);
  const ch = createChooser(pack, { seed: 3 });
  const aired = new Map();
  let t = 0, silences = 0;
  for (let i = 0; i < 100; i++, t += 200) {
    const p = ch.plan({ nowSec: t, songStartSec: t, songDurSec: 200, values: slotValues({}) });
    if (p.type === 'talk') { const s = t + p.startAtSec; if (aired.has(p.unit.id)) assert.ok(s - aired.get(p.unit.id) >= CADENCE.hardFloorSec - 1, `${p.unit.id} after ${s - aired.get(p.unit.id)}`); aired.set(p.unit.id, s); ch.commit(p, { startedSec: s, durSec: p.estSec }); } else silences++;
  }
  assert.ok(aired.size >= 1 && silences > 50, `${aired.size} units, ${silences} silences`);
});

test('talk-share ceiling still applies when a station ID is due but the pack has no ID units to air', () => {
  const doc = docOf('static-city-98-1');
  doc.segments = doc.segments.filter((s) => !ID_KINDS.has(s.kind));
  const pack = buildPack(doc);
  // direct: push the rolling share well over the ceiling, then ask after the 15-minute ID mark
  const ch = createChooser(pack, { seed: 5 });
  ch.commit({ type: 'talk', unit: pack.units.find((u) => u.kind === 'news'), estSec: 40 }, { startedSec: 3000, durSec: 1500 });
  const p = ch.plan({ nowSec: 4700, songStartSec: 4700, songDurSec: 200, values: slotValues({}) });
  assert.equal(p.type, 'silence', `share ${ch.shareAt(4700).toFixed(2)} over ${CADENCE.shareHi} but got ${p.type}`);
  // whole shows
  let worst = 0;
  for (const seed of SEEDS) {
    const sim = simulate(pack, { hours: 3, seed });
    for (let t = 3600; t <= sim.totalSec; t += 300) worst = Math.max(worst, talkShare(sim, t - 3600, t));
  }
  assert.ok(worst < 0.34, `worst rolling-hour share without IDs ${worst.toFixed(3)}`);
});

test('gag levels come from airable units only: a level held by a bookend / silent / over-long unit does not block the gag', () => {
  const doc = docOf('meridian-91-5');
  const lampBefore = gagLevels(buildPack(doc)).get('gag:lamp');
  const bookend = doc.segments.find((s) => s.kind === 'sign_on');
  bookend.tags = [...bookend.tags, 'gag:lamp', 'seq:0'];
  const silent = { id: 'md-silent-gag', kind: 'liner', hosts: [], lines: [], estSec: 0, tags: ['gag:lamp', 'seq:9'], usesSlots: [], fallbackOf: null, weight: 5 };
  doc.segments.push(silent);
  const pack = buildPack(doc);
  assert.deepEqual(gagLevels(pack).get('gag:lamp'), lampBefore);
  // the validator names the problem on the real parse path
  const v = validatePackDoc(doc).errors.map((e) => e.msg).join('|');
  assert.match(v, /gag:lamp seq 0 is held only by units that can never air/);
  assert.match(v, /gag:lamp seq 9 is held only by units that can never air/);
  assert.equal(parsePack(doc).ok, false);
  // and a show still airs lamp beats
  let lamp = 0;
  for (const seed of [1, 2, 3, 4, 5]) lamp += simulate(pack, { hours: 4, seed }).breaks.filter((b) => b.plan.unit.gags.includes('gag:lamp')).length;
  assert.ok(lamp > 3, `${lamp} lamp breaks`);
});

test('the six real packs validate under the new gag rule; seq/payoff tags belong to the gag tag they follow', () => {
  let multi = 0;
  for (const id of STATION_IDS) {
    assert.deepEqual(validatePackDoc(docOf(id)).errors, [], id);
    for (const u of loadPackFile(id).units) {
      if (u.gags.length < 2) continue;
      multi++;
      const beats = [...u.gagBeats.entries()].filter(([, b]) => b.seq != null || b.payoff);
      assert.ok(beats.length <= 1, `${u.id} gives seq/payoff to ${beats.length} gags`);
    }
  }
  assert.ok(multi >= 8, `${multi} multi-gag units in the real packs`);
  const hum = loadPackFile('static-city-98-1').units.find((u) => u.id === 'sc-callin-linefour-3');
  assert.equal(hum.gagBeats.get('gag:linefour').seq, 3);
  assert.equal(hum.gagBeats.get('gag:hum').seq, null);
  const doc = docOf('meridian-91-5');
  doc.segments[2].tags = [...doc.segments[2].tags, 'gag:lamp', 'seq:1', 'seq:2'];
  assert.match(validatePackDoc(doc).errors.map((e) => e.msg).join('|'), /two seq tags for gag:lamp/);
});

test('a finished gag never replays: in 6-hour shows each gag payoff airs at most once and nothing of the gag follows it', () => {
  let finished = 0;
  for (const id of STATION_IDS) {
    const pack = loadPackFile(id);
    const levels = gagLevels(pack);
    for (const seed of SEEDS) {
      const sim = simulate(pack, { hours: 6, seed });
      const done = new Set(), payoffs = new Map();
      for (const b of sim.breaks) {
        const u = pack.unitOfSeg.get(b.resolved.seg.id);
        if (b.kind === 'sign_on' || b.kind === 'sign_off') continue; // bookends carry flavour tags only and air outside the chooser's gag gate
        for (const g of u.gags) {
          assert.ok(!done.has(g), `${id}/${seed}: ${u.id} aired after ${g} finished`);
          const beat = u.gagBeats.get(g), lv = levels.get(g);
          if (beat.payoff) { const k = `${g}|${u.id}`; payoffs.set(k, (payoffs.get(k) || 0) + 1); assert.ok(payoffs.get(k) <= 1, `${id}/${seed}: payoff ${u.id} aired twice`); }
          if (beat.payoff || (beat.seq != null && lv.length && beat.seq >= lv[lv.length - 1])) { done.add(g); finished++; }
        }
      }
    }
  }
  assert.ok(finished > 200, `${finished} gags finished`);
});
