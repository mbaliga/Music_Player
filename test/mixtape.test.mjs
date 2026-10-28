// mixtape.test.mjs — pure mixtape model: edits, reels, progress, JSON, storage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CASSETTE_STYLES, FONTS, FONT_COLOURS, createMixtape, cleanName, makeTrackRef, trackKey,
  resolveTracks, addTrack, removeTrack, moveTrack, withName, withStyle, withFont, withFontColor,
  reelRadii, tapeProgress, serializeMixtape, parseMixtape, serializeCollection, parseCollection,
  newMixtapeId, MAX_NAME,
} from '../src/mixtape.js';
import { validateHexColor } from '../src/theme.js';

const tr = (title, artist = 'A', album = 'X') => ({ title, artist, album });

test('catalogue: at least 6 styles with unique ids; fonts and colours are valid', () => {
  assert.ok(CASSETTE_STYLES.length >= 6);
  assert.equal(new Set(CASSETTE_STYLES.map((s) => s.id)).size, CASSETTE_STYLES.length);
  assert.ok(FONTS.length >= 4 && FONT_COLOURS.length >= 6);
  for (const c of FONT_COLOURS) assert.equal(validateHexColor(c.hex, c.id), null);
  for (const s of CASSETTE_STYLES) for (const k of ['shell', 'shell2', 'label', 'stripe', 'accent'])
    assert.equal(validateHexColor(s[k], `${s.id}.${k}`), null);
});

test('createMixtape normalises name, style, font, colour', () => {
  const m = createMixtape({ id: 'a', name: '  Road   Trip  ', styleId: 'nope', fontId: 'nope', fontColor: 'red' });
  assert.equal(m.name, 'Road Trip');
  assert.equal(m.styleId, CASSETTE_STYLES[0].id);
  assert.equal(m.fontId, FONTS[0].id);
  assert.equal(m.fontColor, FONT_COLOURS[0].hex); // bad colour -> default
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
  assert.equal(withStyle(m, 'noir').styleId, 'noir');
  assert.equal(withFont(m, 'mono').fontId, 'mono');
  assert.equal(withFontColor(m, '#112233').fontColor, '#112233');
  assert.equal(withFontColor(m, 'nope'), m);
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
  styleId: 'noir', fontId: 'mono', fontColor: '#1F4FD8',
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
  bad((o) => { o.version = 2; }, /Unsupported "version"/);
  bad((o) => { o.name = ' '; }, /Missing "name"/);
  bad((o) => { o.style = 'zzz'; }, /Unknown "style"/);
  bad((o) => { o.font = 'zzz'; }, /Unknown "font"/);
  bad((o) => { o.fontColor = 'red'; }, /fontColor.*missing leading/);
  bad((o) => { o.fontColor = '#12'; }, /fontColor/);
  bad((o) => { o.tracks = 'x'; }, /Missing "tracks"/);
  bad((o) => { o.tracks[1] = { artist: 'q' }; }, /tracks\[1\]/);
  assert.ok(parseMixtape(JSON.stringify({ ...good, fontColor: '#80112233' })).ok); // 8-digit hex accepted
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
