import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePackDoc, parsePack, buildPack, gagLevels, estimateLinesSec, KINDS } from '../../src/radio/canned/pack.js';
import { STATION_IDS, loadPackFile } from '../support/canned-sim.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const raw = (id) => JSON.parse(readFileSync(resolve(root, 'content/stations', `${id}.json`), 'utf8'));

test('all six shipped packs validate with the shared validator', () => {
  for (const id of STATION_IDS) {
    const { errors, stats } = validatePackDoc(raw(id));
    assert.deepEqual(errors, [], id);
    assert.equal(stats.id, id);
    assert.ok(stats.segments >= 70, id);
  }
});

test('the validator never throws on junk and always says what is wrong', () => {
  const junk = [undefined, null, 0, 'x', [], {}, { v: 1 }, { v: 1, station: 5, segments: 'no' }, { v: 1, station: { hosts: [null, 3, {}] }, segments: [null, 1, { lines: 'no' }, { hosts: 7, lines: [null, 4] }] }];
  for (const j of junk) {
    let r;
    assert.doesNotThrow(() => { r = validatePackDoc(j); });
    assert.ok(r.errors.length > 0, JSON.stringify(j));
    assert.doesNotThrow(() => parsePack(j));
    assert.equal(parsePack(j).ok, false);
  }
  assert.equal(parsePack('{not json').ok, false);
  assert.equal(parsePack(undefined).pack, null);
});

test('the validator catches each rule the check script enforces', () => {
  const base = () => raw('tape-hiss-fm');
  const cases = [
    ['kind', (d) => { d.segments[0].kind = 'sing'; }, /bad kind/],
    ['unknown host', (d) => { d.segments[0].lines[0].host = 'nobody'; }, /unknown host/],
    ['bad slot', (d) => { d.segments[0].lines[0].text += ' {nope}'; }, /unknown slot|bad slot/],
    ['url', (d) => { d.segments[0].lines[0].text += ' www.example.com'; }, /url/],
    ['emoji', (d) => { d.segments[0].lines[0].text += ' 😀'; }, /emoji/],
    ['estSec', (d) => { d.segments[0].estSec = 999; }, /estSec/],
    ['weight', (d) => { d.segments[0].weight = 0; }, /weight/],
    ['dup id', (d) => { d.segments[1].id = d.segments[0].id; }, /duplicate segment id/],
    ['no fallback', (d) => { const s = d.segments.find((x) => x.usesSlots.length); const t = d.segments.find((x) => x.fallbackOf === s.id); d.segments = d.segments.filter((x) => x !== t); }, /no fallback variant/],
    ['voice hint', (d) => { d.station.hosts[0].voice.rate = 2; }, /out of 0.8-1.3/],
    ['daypart', (d) => { d.station.daypart = ['lunch']; }, /daypart/],
  ];
  for (const [name, mut, re] of cases) {
    const d = base(); mut(d);
    const { errors } = validatePackDoc(d);
    assert.ok(errors.some((e) => re.test(e.msg)), `${name}: ${JSON.stringify(errors.slice(0, 3))}`);
    assert.equal(parsePack(d).ok, false, name);
  }
});

test('check-content.mjs keeps its contract: 0 on the real packs, 1 with the same message shape on a broken one', () => {
  const ok = spawnSync(process.execPath, ['scripts/check-content.mjs'], { cwd: root, encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /OK\s*$/);
  assert.match(ok.stdout, /pirate-1400: \d+ segments, [\d.]+ min, \d+ slot \/ \d+ slot-free/);
  const dir = mkdtempSync(resolve(tmpdir(), 'cc-'));
  try {
    const d = raw('pirate-1400'); d.segments[2].kind = 'sing'; d.segments[3].estSec = 500;
    const f = resolve(dir, 'bad.json'); writeFileSync(f, JSON.stringify(d));
    const bad = spawnSync(process.execPath, ['scripts/check-content.mjs', f], { cwd: root, encoding: 'utf8' });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, new RegExp(`${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\[${d.segments[2].id}\\]: bad kind sing`));
    assert.match(bad.stderr, /\d+ error\(s\)/);
    const f2 = resolve(dir, 'junk.json'); writeFileSync(f2, '{nope');
    assert.equal(spawnSync(process.execPath, ['scripts/check-content.mjs', f2], { cwd: root, encoding: 'utf8' }).status, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the unit model groups a slot segment with its twin and reads gag/payoff/bit tags from the root', () => {
  for (const id of STATION_IDS) {
    const pack = loadPackFile(id);
    const doc = raw(id);
    const twins = doc.segments.filter((s) => s.fallbackOf);
    assert.equal(pack.units.length, doc.segments.length - twins.length, id);
    for (const t of twins) {
      const u = pack.unitOfSeg.get(t.id);
      assert.equal(u.id, t.fallbackOf);
      assert.ok(u.twins.some((x) => x.id === t.id));
      assert.deepEqual(u.slots.length > 0, true, `${id}: twin ${t.id} belongs to a slot unit`);
    }
    for (const u of pack.units) { assert.ok(KINDS.includes(u.kind)); assert.ok(u.estSec > 0); }
    assert.ok(pack.uniqueSec > 1800, id);
    assert.ok(pack.hostList.length >= 4);
  }
  const p = loadPackFile('pirate-1400');
  const lv = gagLevels(p);
  assert.deepEqual(lv.get('serial:salt-duchess'), [1, 2, 3, 4, 5, 6]);
  assert.ok(p.units.find((u) => u.id === 'p14-duchess-6').payoff);
  assert.equal(estimateLinesSec([{ text: 'one two three four five' }]), 5 / 2.6);
});
