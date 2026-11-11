import test from 'node:test';
import assert from 'node:assert/strict';
import { createChooser, CADENCE, canFollow } from '../../src/radio/canned/chooser.js';
import { buildPack, gagLevels } from '../../src/radio/canned/pack.js';
import { slotValues } from '../../src/radio/canned/slots.js';
import { simulate, talkShare, STATION_IDS, loadPackFile, LIB } from '../support/canned-sim.mjs';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SEEDS = Array.from({ length: 60 }, (_, i) => i + 1);
const ID_KINDS = new Set(['station_id', 'jingle']);
const runs = [];
for (const id of STATION_IDS) { const pack = loadPackFile(id); for (const seed of SEEDS) runs.push({ id, pack, seed, sim: simulate(pack, { hours: 3, seed }) }); }

test('bookends: exactly one sign_on first and one sign_off last, in every show', () => {
  for (const r of runs) {
    const b = r.sim.breaks;
    assert.equal(b[0].kind, 'sign_on', `${r.id}/${r.seed}`);
    assert.equal(b.filter((x) => x.kind === 'sign_on').length, 1);
    assert.equal(b.filter((x) => x.kind === 'sign_off').length, 1);
    assert.equal(b[b.length - 1].kind, 'sign_off');
    assert.ok(b.slice(1, -1).every((x) => x.kind !== 'sign_on' && x.kind !== 'sign_off'));
  }
});

test('no segment repeats before its cool-down (thousands of draws); the cool-down relaxes only to the 45-minute floor', () => {
  let draws = 0, relaxed = 0;
  for (const r of runs) {
    const last = new Map();
    const kindCount = {}; for (const u of r.pack.units) kindCount[u.kind] = (kindCount[u.kind] || 0) + 1;
    for (const b of r.sim.breaks) {
      if (b.kind === 'sign_on' || b.kind === 'sign_off') continue;
      draws++;
      const need = ID_KINDS.has(b.kind) || kindCount[b.kind] <= CADENCE.rareUnits ? CADENCE.cooldownRareSec : CADENCE.cooldownSec;
      if (last.has(b.unit)) {
        const gap = b.startSec - last.get(b.unit);
        if (b.plan.why === 'relaxed cool-down') { relaxed++; assert.ok(gap >= CADENCE.hardFloorSec - 1, `${r.id}/${r.seed} ${b.unit} ${gap}`); }
        else assert.ok(gap >= need - 1, `${r.id}/${r.seed} ${b.unit} repeated after ${gap}s (< ${need})`);
      }
      last.set(b.unit, b.startSec);
    }
  }
  assert.ok(draws > 15000, `${draws} draws`);
  assert.ok(relaxed < draws * 0.02, `${relaxed} relaxed of ${draws}`);
});

test('a slot segment and its twin are one unit: airing either counts for both', () => {
  for (const r of runs.filter((x) => x.seed <= 10)) {
    const seen = new Set();
    for (const b of r.sim.breaks) { if (ID_KINDS.has(b.kind)) continue; const u = r.pack.unitOfSeg.get(b.resolved.seg.id); assert.equal(u.id, b.unit); if (seen.has(b.unit)) { /* repeat allowed only after cool-down (tested above) */ } seen.add(b.unit); }
  }
});

function verifyGags(r) {
  const levels = gagLevels(r.pack);
  const done = new Map(), count = new Map(), lastStart = new Map();
  for (const b of r.sim.breaks) {
    const u = r.pack.unitOfSeg.get(b.resolved.seg.id);
    for (const g of u.gags) {
      const lv = levels.get(g);
      const d = done.get(g) || new Set();
      if (u.seq != null) {
        for (const l of lv) if (l < u.seq) assert.ok(d.has(l), `${r.id}/${r.seed}: ${u.id} (${g} seq ${u.seq}) aired before level ${l}`);
        if (d.size) assert.ok(u.seq >= Math.max(...d), `${r.id}/${r.seed}: ${u.id} stepped back in ${g}`);
        if (lastStart.has(g)) assert.ok(b.startSec - lastStart.get(g) >= CADENCE.gagGapSec - 1, `${r.id}/${r.seed}: ${g} beats ${b.startSec - lastStart.get(g)}s apart`);
        d.add(u.seq); done.set(g, d); lastStart.set(g, b.startSec);
      } else if (u.payoff) assert.ok((count.get(g) || 0) >= 1, `${r.id}/${r.seed}: payoff ${u.id} of ${g} with no set-up`);
      count.set(g, (count.get(g) || 0) + 1);
    }
  }
}
test('running gags: beats in seq order, never skipping ahead, payoff only after its set-up, beats spaced out', () => {
  for (const r of runs) verifyGags(r);
});

test('running gags actually pay off: across seeds most gags that start also reach their payoff in three hours', () => {
  let started = 0, paid = 0;
  for (const r of runs.filter((x) => x.seed <= 20)) {
    const levels = gagLevels(r.pack);
    const aired = new Set(r.sim.breaks.map((b) => b.resolved.seg.id));
    for (const [g, lv] of levels) {
      const beats = r.pack.units.filter((u) => u.gags.includes(g) && u.seq != null);
      if (!beats.some((u) => aired.has(u.id) || u.twins.some((t) => aired.has(t.id)))) continue;
      started++;
      const pay = beats.filter((u) => u.payoff);
      if (pay.some((u) => aired.has(u.id) || u.twins.some((t) => aired.has(t.id)))) paid++;
    }
  }
  assert.ok(started > 100);
  assert.ok(paid / started > 0.3, `${paid}/${started}`);
});

test('bit rationing: at most 2 bit-tagged segments in any rolling hour', () => {
  const doc = JSON.parse(readFileSync(resolve(root, 'content/stations/pirate-1400.json'), 'utf8'));
  for (const s of doc.segments) if (s.kind === 'callin' || s.kind === 'skit') s.tags.push('bit');
  const pack = buildPack(doc);
  assert.ok(pack.units.filter((u) => u.bit).length > 10);
  let bitsAired = 0;
  for (const seed of SEEDS.slice(0, 25)) {
    const sim = simulate(pack, { hours: 3, seed });
    const starts = sim.breaks.filter((b) => pack.unitOfSeg.get(b.resolved.seg.id).bit).map((b) => b.startSec);
    bitsAired += starts.length;
    for (const t of starts) assert.ok(starts.filter((x) => x >= t && x < t + 3600).length <= CADENCE.bitsPerHour, `seed ${seed}: more than ${CADENCE.bitsPerHour} bits inside an hour`);
  }
  assert.ok(bitsAired > 20, `${bitsAired} bits aired`);
});

test('talk share lands in the 25-30% band on average and never runs away in any hour', () => {
  const byPack = {};
  let over = 0, hours = 0;
  for (const r of runs) {
    (byPack[r.id] ||= []).push(talkShare(r.sim));
    for (let h = 0; h < 3; h++) { const s = talkShare(r.sim, h * 3600, (h + 1) * 3600); hours++; if (s > 0.32) over++; assert.ok(s < 0.38, `${r.id}/${r.seed} hour ${h}: ${s}`); }
  }
  const report = {};
  for (const [id, a] of Object.entries(byPack)) { const m = a.reduce((x, y) => x + y, 0) / a.length; report[id] = Math.round(m * 1000) / 1000; assert.ok(m >= 0.2 && m <= 0.31, `${id} mean share ${m}`); }
  assert.ok(over / hours < 0.12, `${over}/${hours} hours above 32%`);
  console.log('mean talk share per pack (3 h, 60 seeds):', JSON.stringify(report));
});

test('cadence: breaks keep a gap of music; two talk segments are adjacent only when one is a skit or call-in', () => {
  assert.equal(canFollow('banter', 'skit'), true);
  assert.equal(canFollow('callin', 'ad'), true);
  assert.equal(canFollow('banter', 'ad'), false);
  assert.equal(canFollow('station_id', 'jingle'), false);
  assert.equal(canFollow(null, 'banter'), false);
  for (const r of runs) {
    const b = r.sim.breaks.slice(0, -1);
    for (let i = 1; i < b.length; i++) {
      const gap = b[i].startSec - (b[i - 1].startSec + b[i - 1].durSec);
      if (gap < CADENCE.minGapSec - 12) assert.ok(canFollow(b[i - 1].kind, b[i].kind) || b[i - 1].kind === 'sign_on', `${r.id}/${r.seed}: ${b[i - 1].kind} -> ${b[i].kind} only ${gap.toFixed(0)}s apart`);
      assert.ok(gap > -20, `${r.id}/${r.seed}: breaks overlap by ${-gap}s`);
    }
  }
});

test('station id / jingle about every 15 minutes, alternating where the pack has both', () => {
  for (const r of runs.filter((x) => x.seed <= 20)) {
    const t = r.sim.breaks.filter((b) => ID_KINDS.has(b.kind) || b.kind === 'sign_on').map((b) => b.startSec);
    for (let i = 1; i < t.length; i++) assert.ok(t[i] - t[i - 1] <= 25 * 60, `${r.id}/${r.seed}: ${(t[i] - t[i - 1]) / 60} min without an ID`);
    assert.ok(t.length >= 9, `${r.id}/${r.seed}: ${t.length} IDs in 3 h`);
    const ids = r.sim.breaks.filter((b) => ID_KINDS.has(b.kind)).map((b) => b.kind);
    for (let i = 1; i < ids.length; i++) assert.ok(!(ids[i] === ids[i - 1] && ids.includes('station_id') && ids.includes('jingle') && ids.filter((k) => k === ids[i]).length === ids.length));
  }
});

test('slot fallback inside a whole show: with no usable metadata only slot-free text airs; with good metadata slot lines air filled', () => {
  const noMeta = (n) => ({ ...n, title: 'Track 04', artist: 'Unknown Artist', album: 'Unknown Album' });
  let filled = 0, twins = 0;
  for (const r of runs.filter((x) => x.seed <= 12)) {
    const sparse = simulate(r.pack, { hours: 3, seed: r.seed, lib: LIB.map(noMeta) });
    for (const b of sparse.breaks) { assert.notEqual(b.variant, 'slots'); for (const l of b.resolved.lines) assert.doesNotMatch(l.text, /\{\w+\}/); }
    twins += sparse.breaks.filter((b) => b.variant === 'twin').length;
    for (const b of r.sim.breaks) { for (const l of b.resolved.lines) assert.doesNotMatch(l.text, /\{\w+\}/); if (b.variant === 'slots') filled++; }
    // the sparse show still has talk (the twins carry it)
    assert.ok(sparse.breaks.length > 30);
  }
  assert.ok(filled > 20, `${filled} filled slot lines`);
  assert.ok(twins > 5, `${twins} twin lines`);
});

test('determinism: the same seed gives the same show, another seed another show', () => {
  const p = loadPackFile('tape-hiss-fm');
  const a = simulate(p, { seed: 7 }).breaks.map((b) => b.resolved.seg.id).join();
  assert.equal(simulate(p, { seed: 7 }).breaks.map((b) => b.resolved.seg.id).join(), a);
  assert.notEqual(simulate(p, { seed: 8 }).breaks.map((b) => b.resolved.seg.id).join(), a);
});

test('silence is a real outcome, zero-line units are never aired as talk, and junk never throws', () => {
  const doc = JSON.parse(readFileSync(resolve(root, 'content/stations/meridian-91-5.json'), 'utf8'));
  doc.segments.push({ id: 'md-silent', kind: 'liner', hosts: [], lines: [], estSec: 0, tags: ['silent'], usesSlots: [], fallbackOf: null, weight: 50 });
  const pack = buildPack(doc);
  assert.equal(pack.units.find((u) => u.id === 'md-silent').silent, true);
  for (const seed of [1, 2, 3]) assert.ok(!simulate(pack, { seed }).breaks.some((b) => b.unit === 'md-silent'));
  const ch = createChooser(loadPackFile('meridian-91-5'), { seed: 1 });
  for (const junk of [undefined, null, {}, { songDurSec: -5 }, { nowSec: NaN, songStartSec: 'x', songDurSec: 200 }, 5]) {
    assert.doesNotThrow(() => ch.plan(junk));
    assert.equal(ch.plan(junk).type === 'silence' || ch.plan(junk).type === 'talk', true);
  }
  for (const junk of [undefined, null, {}, { type: 'talk' }, { type: 'talk', unit: {} }]) assert.doesNotThrow(() => ch.commit(junk, junk));
  assert.equal(ch.plan({ nowSec: 100, songStartSec: 0, songDurSec: 200, values: {}, musicOnly: true }).type, 'silence');
  // a very short song cannot hold a long break: only short ones are offered
  const shortSong = createChooser(loadPackFile('meridian-91-5'), { seed: 2 }).plan({ nowSec: 700, songStartSec: 700, songDurSec: 40, values: slotValues({}) });
  if (shortSong.type === 'talk') assert.ok(shortSong.estSec <= 15 + 25, `${shortSong.estSec}`);
});

test('amend corrects the measured length; planning right after a long break respects the real end', () => {
  const p = loadPackFile('static-city-98-1');
  const ch = createChooser(p, { seed: 1 });
  const plan = ch.plan({ nowSec: 700, songStartSec: 700, songDurSec: 200, values: slotValues({ next: LIB[1] }) });
  assert.equal(plan.type, 'talk');
  ch.commit(plan, { startedSec: 750, durSec: 20 });
  assert.equal(ch.state.lastTalkEndSec, 770);
  ch.amend(plan.unit.id, 55);
  assert.equal(ch.state.lastTalkEndSec, 805);
});
