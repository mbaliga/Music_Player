// mixtape.test.mjs — pure mixtape model: edits, reels, progress, JSON, storage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cassetteStyles, PEN_IDS, FONT_COLOURS, createMixtape, cleanName, makeTrackRef, trackKey,
  resolveTracks, addTrack, removeTrack, moveTrack, withName, withStyle, withPen, withInk,
  reelRadii, tapeProgress, serializeMixtape, parseMixtape, serializeCollection, parseCollection,
  newMixtapeId, MAX_NAME,
} from '../src/mixtape.js';
import { validateHexColor } from '../src/theme.js';

import { isFutureCollection, MIXTAPE_VERSION } from '../src/mixtape.js';
const tr = (title, artist = 'A', album = 'X') => ({ title, artist, album });

test('catalogue: 37 styles with unique ids; pens and ink colours are valid', () => {
  const styles = cassetteStyles();
  assert.equal(styles.length, 37);
  assert.equal(new Set(styles.map((s) => s.id)).size, styles.length);
  assert.ok(PEN_IDS.length >= 4 && FONT_COLOURS.length >= 6);
  for (const c of FONT_COLOURS) assert.equal(validateHexColor(c.hex, c.id), null);
});

test('createMixtape normalises name, style, pen, ink (legacy v1/v2 inputs migrate)', () => {
  const m = createMixtape({ id: 'a', name: '  Road   Trip  ', styleId: 'nope', fontId: 'nope', fontColor: 'red' });
  assert.equal(m.name, 'Road Trip');
  assert.equal(m.cfg.style, 'clear');   // unknown -> default
  assert.equal(m.cfg.pen, 'marker');
  assert.equal(m.cfg.slots, undefined); // bad colour -> no ink override
  assert.equal(cleanName(''), 'Untitled Mixtape');
  assert.equal(cleanName('x'.repeat(100)).length, MAX_NAME);
});

test('edits are pure (inputs untouched) and validated', () => {
  const m = createMixtape({ id: 'a', name: 'T', tracks: [tr('1'), tr('2'), tr('3')] });
  const m2 = addTrack(m, tr('4'));
  assert.equal(m.tracks.length, 3); assert.equal(m2.tracks.length, 4);
  assert.deepEqual(removeTrack(m, 1).tracks.map((t) => t.title), ['1', '3']);
  assert.equal(removeTrack(m, 9), m);
  assert.deepEqual(moveTrack(m, 0, 2).tracks.map((t) => t.title), ['2', '3', '1']);
  assert.deepEqual(moveTrack(m, 2, -5).tracks.map((t) => t.title), ['3', '1', '2']);
  assert.equal(moveTrack(m, 5, 0), m);
  assert.equal(withName(m, '  ').name, 'Untitled Mixtape');
  assert.equal(withStyle(m, 'noir').cfg.style, 'noir');
  assert.equal(withStyle(m, 'nope'), m);
  assert.equal(withPen(m, 'type').cfg.pen, 'type');
  assert.equal(withInk(m, '#112233').cfg.slots.ink, '#112233');
  assert.equal(withInk(m, 'nope'), m);
});

test('resolveTracks: exact, loose fallback, missing -> null', () => {
  const lib = [tr('One', 'A', 'X'), tr('Two', 'A', 'Retagged')];
  const m = createMixtape({ id: 'a', tracks: [tr('one'), tr('Two', 'A', 'X'), tr('Gone')] });
  const r = resolveTracks(m, lib);
  assert.equal(r[0], lib[0]);
  assert.equal(r[1], lib[1]);
  assert.equal(r[2], null);
  assert.equal(trackKey(makeTrackRef({ title: ' A  b ' })), trackKey({ title: 'a b' }));
});

test('reelRadii: endpoints swap, tape area conserved, monotonic, clamped', () => {
  const rMin = 10, rMax = 30;
  const a = reelRadii(0, rMin, rMax), z = reelRadii(1, rMin, rMax);
  assert.ok(Math.abs(a.supply - rMax) < 1e-9 && Math.abs(a.take - rMin) < 1e-9);
  assert.ok(Math.abs(z.supply - rMin) < 1e-9 && Math.abs(z.take - rMax) < 1e-9);
  let prev = reelRadii(0, rMin, rMax);
  for (let i = 1; i <= 50; i++) {
    const r = reelRadii(i / 50, rMin, rMax);
    assert.ok(Math.abs(r.supply ** 2 + r.take ** 2 - (rMax ** 2 + rMin ** 2)) < 1e-6);
    assert.ok(r.supply <= prev.supply && r.take >= prev.take);
    prev = r;
  }
  // visibly different at 25% vs 75% (the point of the feature)
  assert.ok(reelRadii(0.25, rMin, rMax).supply - reelRadii(0.75, rMin, rMax).supply > 5);
  assert.deepEqual(reelRadii(-3, rMin, rMax), a);
  assert.deepEqual(reelRadii(7, rMin, rMax), z);
  assert.deepEqual(reelRadii(NaN, rMin, rMax), a);
});

test('tapeProgress: equal-weighted by default, time-weighted when durations known', () => {
  assert.equal(tapeProgress(0, 4, 0), 0);
  assert.equal(tapeProgress(1, 4, 0.5), 0.375);
  assert.equal(tapeProgress(3, 4, 1), 1);
  assert.equal(tapeProgress(0, 0, 0.5), 0);
  assert.equal(tapeProgress(9, 2, 0.5), 0.75); // index clamped
  assert.equal(tapeProgress(1, 2, 0.5, [10, 30]), (10 + 15) / 40);
  assert.equal(tapeProgress(1, 2, 0.5, [10, 0]), 0.75); // unknown duration -> equal weights
});

const sample = () => createMixtape({
  id: 'a', name: 'Road Trip', tracks: [tr('One'), tr('Two', 'B', 'Y')],
  cfg: { style: 'noir', pen: 'type', slots: { ink: '#1F4FD8' } },
});

test('serialize -> parse round-trips', () => {
  const m = sample();
  const p = parseMixtape(serializeMixtape(m), { id: 'a' });
  assert.ok(p.ok, p.error);
  assert.deepEqual(p.mixtape, m);
  assert.equal(serializeMixtape(m), serializeMixtape(p.mixtape)); // stable text
});

test('parseMixtape names every malformed case and never throws', () => {
  const good = JSON.parse(serializeMixtape(sample()));
  const bad = (mut, re) => {
    const o = JSON.parse(JSON.stringify(good)); mut(o);
    const r = parseMixtape(JSON.stringify(o));
    assert.equal(r.ok, false); assert.match(r.error, re);
  };
  assert.match(parseMixtape('{nope').error, /Not valid JSON/);
  assert.match(parseMixtape('[]').error, /an array/);
  assert.match(parseMixtape('3').error, /number/);
  bad((o) => delete o.version, /Missing "version"/);
  bad((o) => { o.version = 4; }, /Unsupported "version"/);
  bad((o) => { o.version = 0; }, /Unsupported "version"/);
  bad((o) => { o.name = ' '; }, /Missing "name"/);
  bad((o) => { o.cfg.style = 'zzz'; }, /Unknown "cfg.style"/);
  bad((o) => { o.cfg.pen = 'zzz'; }, /Unknown "cfg.pen"/);
  bad((o) => { delete o.cfg; }, /Missing "cfg"/);
  bad((o) => { o.cfg.slots.ink = 'red'; }, /ink.*missing leading/);
  bad((o) => { o.cfg.slots.ink = '#12'; }, /ink/);
  bad((o) => { o.tracks = 'x'; }, /Missing "tracks"/);
  bad((o) => { o.tracks[1] = { artist: 'q' }; }, /tracks\[1\]/);
  assert.ok(parseMixtape(JSON.stringify({ ...good, cfg: { ...good.cfg, slots: { ink: '#80112233' } } })).ok); // 8-digit hex accepted
});

test('collection storage: round-trip, corrupt -> [], bad entries dropped', () => {
  const list = [sample(), createMixtape({ id: 'b', name: 'Two' })];
  assert.deepEqual(parseCollection(serializeCollection(list)), list);
  assert.deepEqual(parseCollection(''), []);
  assert.deepEqual(parseCollection(null), []);
  assert.deepEqual(parseCollection('{{'), []);
  assert.deepEqual(parseCollection('{"version":9,"mixtapes":[]}'), []);
  const mixed = JSON.stringify({ version: 1, mixtapes: [null, { id: 5 }, { id: 'ok', name: 'Fine', tracks: [{ title: 't' }, 7] }] });
  const r = parseCollection(mixed);
  assert.equal(r.length, 1); assert.equal(r[0].id, 'ok'); assert.equal(r[0].tracks.length, 1);
});

test('newMixtapeId avoids collisions', () => {
  const a = newMixtapeId(1000, 0.5, []);
  const b = newMixtapeId(1000, 0.5, [{ id: a }]);
  assert.notEqual(a, b);
});

// ── v2: stable track ids + v1 migration ──────────────────────────────────────
test('refs carry an optional stable id; resolve prefers id over tags', () => {
  const lib = [{ id: 't-aaa', title: 'Retitled', artist: 'A', album: 'X' }, { title: 'One', artist: 'A', album: 'X' }];
  assert.equal(makeTrackRef({ title: 'x', id: 't-aaa' }).id, 't-aaa');
  assert.equal('id' in makeTrackRef({ title: 'x' }), false);
  const m = createMixtape({ id: 'a', tracks: [{ title: 'Old name', artist: 'A', album: 'X', id: 't-aaa' }, tr('One')] });
  const r = resolveTracks(m, lib);
  assert.equal(r[0], lib[0]); // id match despite a changed title
  assert.equal(r[1], lib[1]);
});

test('resolve: a linked track beats a needs-re-link one with the same key', () => {
  const relink = { title: 'One', artist: 'A', album: 'X', relink: true, id: 'p' };
  const live = { title: 'One', artist: 'A', album: 'X', file: {}, id: 'q' };
  const m = createMixtape({ id: 'a', tracks: [tr('One')] });
  assert.equal(resolveTracks(m, [relink, live])[0], live);
  assert.equal(resolveTracks(m, [live, relink])[0], live);
  assert.equal(resolveTracks(m, [relink])[0], relink);
});

test('v1 documents migrate: single parse and collection, ids round-trip in v2', () => {
  const v1 = JSON.stringify({ version: 1, name: 'Old', style: 'noir', font: 'mono', fontColor: '#112233', tracks: [{ title: 'a', artist: 'b', album: 'c' }] });
  const p = parseMixtape(v1);
  assert.ok(p.ok); assert.equal(p.mixtape.tracks[0].id, undefined);
  assert.equal(p.mixtape.cfg.style, 'noir'); assert.equal(p.mixtape.cfg.pen, 'type'); assert.equal(p.mixtape.cfg.slots.ink, '#112233');
  const out = JSON.parse(serializeMixtape({ ...p.mixtape, tracks: [{ title: 'a', artist: 'b', album: 'c', id: 'tid' }] }));
  assert.equal(out.version, MIXTAPE_VERSION);
  assert.equal(parseMixtape(JSON.stringify(out)).mixtape.tracks[0].id, 'tid');
  const col = parseCollection(JSON.stringify({ version: 1, mixtapes: [{ id: 'm', name: 'N', tracks: [{ title: 't' }] }] }));
  assert.equal(col.length, 1);
  const back = parseCollection(serializeCollection([createMixtape({ id: 'm', tracks: [{ title: 't', id: 'zz' }] })]));
  assert.equal(back[0].tracks[0].id, 'zz');
});

test('future / corrupt collections never throw; future is detectable', () => {
  const fut = JSON.stringify({ version: 99, mixtapes: [{ id: 'x', tracks: [] }] });
  assert.deepEqual(parseCollection(fut), []);
  assert.equal(isFutureCollection(fut), true);
  assert.equal(isFutureCollection('{nope'), false);
  assert.equal(isFutureCollection(null), false);
  for (const junk of ['', 'null', '[]', '"s"', '{"version":"2"}', '{"version":2}', undefined]) assert.deepEqual(parseCollection(junk), []);
});
