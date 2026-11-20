// turntable-library-layout.test.mjs — the pure half of the turntable library: layout numbers, coverflow
// geometry, motion maths and the shelf-item adapter. (The expected layout numbers are the prototype's own
// layoutLib formulas worked by hand; see docs/TURNTABLE_LIBRARY.md.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  libraryLayout, coverPose, visibleRange, POOL_SIZE, dragFocus, flingTarget, easeStep, wheelStep, keyStep,
  formatDuration, totalDuration, clipText, albumsToCoverflow, builtinTestPressing, isBuiltinAlbum, TEST_PRESSING_ID, LIB_KNOBS,
} from '../src/turntable/library-layout.js';
import { groupTracks, shelfItems } from '../src/albums.js';
import { hashSeed } from '../src/turntable/covers.js';

const near = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) < e, `${a} != ${b}`);

// ── layout: numbers from the prototype's formulas ────────────────────────────
// cs = round(port ? w*.62 : h*.44); ct = round(cs*.64); fh = ct+cs+round(cs*.07);
// f1 = clamp(w/(port?26:70), 11, 16); rh = round(clamp(f1*3.1, 34, 48)); mh = round(f1*4.4); pad = round(w*.07)
const CASES = [
  // [w, h, portrait, cs, ct, fh, f1, f2, mh, pad, rhProto, rh]
  [1241, 561, false, 247, 158, 422, 16, 14.1, 70, 87, 48, 48],
  [561, 1241, true, 348, 223, 595, 16, 14.1, 70, 39, 48, 48],
  [582, 1162, true, 361, 231, 617, 16, 14.1, 70, 41, 48, 48],
  [360, 780, true, 223, 143, 382, 360 / 26, 12.2, 61, 25, 43, 44],
  [412, 915, true, 255, 163, 436, 412 / 26, 13.9, 70, 29, 48, 48],
  [320, 640, true, 198, 127, 339, 320 / 26, 10.8, 54, 22, 38, 44],
];
for (const [w, h, portrait, cs, ct, fh, f1, f2, mh, pad, rhProto, rh] of CASES) {
  test(`libraryLayout ${w}x${h}`, () => {
    const L = libraryLayout({ width: w, height: h, portrait });
    assert.equal(L.cs, cs); assert.equal(L.ct, ct); assert.equal(L.fh, fh);
    near(L.f1, f1); assert.equal(L.f2, f2); assert.equal(L.mh, mh); assert.equal(L.pad, pad);
    assert.equal(L.rhProto, rhProto); assert.equal(L.rh, rh);
    assert.ok(L.rh >= 44, 'touch target');
    assert.ok(L.tbH <= L.ct - 4, 'the toolbar fits above the cover');
  });
}

test('libraryLayout: portrait defaults from the aspect, survives junk', () => {
  assert.equal(libraryLayout({ width: 400, height: 800 }).portrait, true);
  assert.equal(libraryLayout({ width: 800, height: 400 }).portrait, false);
  assert.equal(libraryLayout({ width: 500, height: 500 }).portrait, false);     // the prototype's `pw < ph`
  const z = libraryLayout({}); assert.ok(z.cs >= 0 && Number.isFinite(z.fh));
  assert.equal(libraryLayout({ width: 360, height: 780, portrait: true }).tbRows, 2);
  assert.equal(libraryLayout({ width: 1241, height: 561, portrait: false }).tbRows, 1);
});

test('libraryLayout: font and row clamps', () => {
  assert.equal(libraryLayout({ width: 200, height: 400, portrait: true }).f1, 11);
  assert.equal(libraryLayout({ width: 4000, height: 2000, portrait: false }).f1, 16);
});

// ── coverflow geometry ───────────────────────────────────────────────────────
test('coverPose: centre, neighbours, far covers (the prototype updateFlow)', () => {
  const o = {}, cs = 200;
  coverPose(0, cs, o);
  assert.equal(o.x, 0); assert.equal(Math.abs(o.rot), 0); assert.equal(o.scale, 1); assert.equal(o.z, 100); assert.equal(o.shade, 0); assert.equal(o.opacity, 1);
  coverPose(1, cs, o);
  near(o.x, 124); near(o.rot, -56); near(o.scale, .8); assert.equal(o.z, 90); near(o.shade, .5);
  coverPose(-1, cs, o);
  near(o.x, -124); near(o.rot, 56);
  coverPose(3, cs, o);
  near(o.x, 124 + 2 * 60); assert.equal(o.opacity, 1);
  coverPose(3.3, cs, o); assert.equal(o.opacity, 0);
  coverPose(.5, cs, o); near(o.x, 62); near(o.rot, -28); near(o.scale, .9);
});

test('coverPose is continuous across |o| = 1', () => {
  const a = {}, b = {}; coverPose(.9999, 200, a); coverPose(1.0001, 200, b);
  assert.ok(Math.abs(a.x - b.x) < .1);
});

test('visibleRange: bounded window, never more nodes than the pool', () => {
  assert.deepEqual(visibleRange(0, 0), { lo: 0, hi: -1 });
  assert.deepEqual(visibleRange(0, 1), { lo: 0, hi: 0 });
  assert.deepEqual(visibleRange(0, 2000), { lo: 0, hi: 4 });
  for (let f = 0; f <= 1999; f += 0.137) {
    const r = visibleRange(f, 2000);
    assert.ok(r.hi - r.lo + 1 <= POOL_SIZE, `range at ${f}`);
    assert.ok(r.lo <= Math.round(f) && Math.round(f) <= r.hi);
    for (let k = r.lo; k <= r.hi; k++) assert.ok(Math.abs(k - f) <= LIB_KNOBS.fadeAt + 1.01);
  }
  // every index that is visible (opacity 1) is inside the range
  const o = {};
  for (let f = 5; f < 9; f += 0.05) {
    const r = visibleRange(f, 20);
    for (let k = 0; k < 20; k++) { coverPose(k - f, 200, o); if (o.opacity) assert.ok(k >= r.lo && k <= r.hi, `k=${k} f=${f}`); }
  }
  const slots = new Set(); const r = visibleRange(10.5, 100);
  for (let k = r.lo; k <= r.hi; k++) slots.add(k % POOL_SIZE);
  assert.equal(slots.size, r.hi - r.lo + 1);
});

// ── motion ───────────────────────────────────────────────────────────────────
test('dragFocus: finger right = previous album; clamped', () => {
  near(dragFocus(2, 0, 200, 5), 2);
  near(dragFocus(2, 124, 200, 5), 1);
  near(dragFocus(2, -124, 200, 5), 3);
  assert.equal(dragFocus(0, 999, 200, 5), 0);
  assert.equal(dragFocus(4, -999, 200, 5), 4);
  assert.equal(dragFocus(0, -50, 200, 0), 0);
});

test('flingTarget: rounds, adds momentum, is capped and clamped', () => {
  assert.equal(flingTarget(2.4, 0, 10), 2);
  assert.equal(flingTarget(2.6, 0, 10), 3);
  assert.equal(flingTarget(2.2, 5, 10), 3);          // 2.2 + .9 = 3.1
  assert.equal(flingTarget(2.2, -5, 10), 1);
  assert.equal(flingTarget(2, 500, 100), 7);          // capped at +5
  assert.equal(flingTarget(0.2, -50, 10), 0);
  assert.equal(flingTarget(8.7, 50, 10), 9);
  assert.equal(flingTarget(1, NaN, 10), 1);
  assert.equal(flingTarget(0, 3, 0), 0);
});

test('easeStep converges and snaps', () => {
  let f = 0, steps = 0;
  while (f !== 3 && steps++ < 600) f = easeStep(f, 3, 1 / 60);
  assert.equal(f, 3); assert.ok(steps < 120, `settled in ${steps} frames`);
  assert.equal(easeStep(2.9999, 3, 0.016), 3);
  assert.equal(easeStep(0, 5, 10), 5);                  // dt large: min(1, ..)
});

test('wheelStep / keyStep', () => {
  near(wheelStep(124, 200), 1);
  assert.equal(keyStep(2, 'ArrowRight', 5), 3);
  assert.equal(keyStep(2, 'ArrowLeft', 5), 1);
  assert.equal(keyStep(0, 'ArrowLeft', 5), 0);
  assert.equal(keyStep(4, 'ArrowRight', 5), 4);
  assert.equal(keyStep(2, 'Home', 5), 0);
  assert.equal(keyStep(2, 'End', 5), 4);
  assert.equal(keyStep(2, 'PageDown', 5), 4);
  assert.equal(keyStep(2, 'a', 5), null);
  assert.equal(keyStep(2.4, 'ArrowRight', 5), 3);
});

// ── display helpers ──────────────────────────────────────────────────────────
test('formatDuration: m:ss, h:mm:ss, an em dash when unknown', () => {
  assert.equal(formatDuration(0), '0:00');
  assert.equal(formatDuration(65), '1:05');
  assert.equal(formatDuration(59.6), '1:00');
  assert.equal(formatDuration(3725), '1:02:05');
  for (const v of [null, undefined, NaN, -1, Infinity]) assert.equal(formatDuration(v), '—');
});

test('totalDuration: null unless every track is known', () => {
  assert.equal(totalDuration([{ durationSec: 60 }, { durationSec: 30 }]), 90);
  assert.equal(totalDuration([{ durationSec: 60 }, { durationSec: null }]), null);
  assert.equal(totalDuration([]), null);
});

test('clipText bounds length and coerces', () => {
  assert.equal(clipText('x'.repeat(5000)).length, 200);
  assert.ok(clipText('x'.repeat(5000)).endsWith('…'));
  assert.equal(clipText(undefined), '');
  assert.equal(clipText(12), '12');
  assert.equal(clipText('<img src=x onerror=alert(1)>'), '<img src=x onerror=alert(1)>');   // text, never markup: the DOM uses textContent
});

// ── adapter ──────────────────────────────────────────────────────────────────
const T = (title, o = {}) => ({ title, artist: 'Ann', album: 'Blue', path: `Ann/Blue/${title}.mp3`, ...o });

test('albumsToCoverflow: vinyl + multi-disc CD from the real albums.js pipeline', () => {
  const items = shelfItems(groupTracks([
    T('b', { trackNo: 2, durationSec: 200 }), T('a', { trackNo: 1, durationSec: 100.4 }),
    { title: 'x1', artist: 'Bo', album: 'Wall CD1', path: 'Bo/Wall CD1/1.mp3', trackNo: 1 },
    { title: 'y1', artist: 'Bo', album: 'Wall CD2', path: 'Bo/Wall CD2/1.mp3', trackNo: 1, durationSec: 50 },
  ]));
  const out = albumsToCoverflow(items);
  assert.equal(out.length, 3);
  const blue = out.find((a) => a.title === 'Blue');
  assert.equal(blue.kind, 'vinyl'); assert.equal(blue.artist, 'Ann');
  assert.deepEqual(blue.tracks.map((t) => [t.title, t.durationSec]), [['a', 100.4], ['b', 200]]);   // albums.js order, not input order
  const cds = out.filter((a) => a.kind === 'cd');
  assert.deepEqual(cds.map((a) => a.title), ['Wall · CD 1', 'Wall · CD 2']);
  assert.equal(cds[0].coverSeed, cds[1].coverSeed, 'discs of one set share art');
  assert.notEqual(cds[0].id, cds[1].id);
  assert.equal(cds[0].tracks[0].durationSec, null);       // unknown -> null
  assert.equal(cds[1].tracks[0].durationSec, 50);
  for (const a of out) { assert.equal(typeof a.coverSeed, 'number'); assert.ok(Number.isInteger(a.coverSeed) && a.coverSeed >= 0); }
});

test('albumsToCoverflow: coverSeed is hash(artist + title) and deterministic', () => {
  const [a] = albumsToCoverflow(shelfItems(groupTracks([T('a')])));
  assert.equal(a.coverSeed, hashSeed('Ann\u0000Blue'));
  const [b] = albumsToCoverflow(shelfItems(groupTracks([T('a')])));
  assert.equal(a.coverSeed, b.coverSeed);
  const [c] = albumsToCoverflow(shelfItems(groupTracks([T('a', { artist: 'Zed' })])));
  assert.notEqual(a.coverSeed, c.coverSeed);
});

test('albumsToCoverflow: LibraryManager rows, cover urls, kind fallback', () => {
  const out = albumsToCoverflow([
    { id: 'r1', kind: 'cd', album: 'Set CD2', artist: 'Q', coverUrl: 'blob:abc', tracks: [{ title: 't', durationSec: 12 }] },
    { id: 'r2', album: 'Plain', artist: 'Q', tracks: [{ title: 'u', coverUrl: 'blob:from-track' }] },
    { id: 'r3', album: 'Other CD1', artist: 'Q', tracks: [] },
  ]);
  assert.equal(out[0].coverUrl, 'blob:abc'); assert.equal(out[0].kind, 'cd');
  assert.equal(out[1].coverUrl, 'blob:from-track'); assert.equal(out[1].kind, 'vinyl');
  assert.equal(out[2].kind, 'cd');                         // no kind given: the label rule decides
  assert.equal('coverUrl' in out[2], false);
});

test('albumsToCoverflow: empty / odd data never throws', () => {
  assert.deepEqual(albumsToCoverflow([]), []);
  assert.deepEqual(albumsToCoverflow(undefined), []);
  assert.deepEqual(albumsToCoverflow(null), []);
  assert.deepEqual(albumsToCoverflow([null, 3, 'x', undefined]), []);
  const out = albumsToCoverflow([
    { id: 'a', kind: 'vinyl', label: '', album: { title: '', artist: '' }, tracks: [] },
    { kind: 'vinyl', label: 'No id', album: { title: 'No id', artist: 'Z' }, tracks: [{}, { title: '  ' }, { path: '/m/x/07 song.flac' }, { title: 't', durationSec: -5 }, { title: 'u', durationSec: 'x' }] },
    { id: 'a', kind: 'vinyl', label: 'Dup id', album: { title: 'Dup id', artist: 'Z' }, tracks: null },
  ]);
  assert.equal(out.length, 3);
  assert.equal(out[0].title, 'Untitled'); assert.equal(out[0].artist, 'Unknown Artist'); assert.deepEqual(out[0].tracks, []);
  assert.deepEqual(out[1].tracks.map((t) => t.title), ['Track 1', 'Track 2', '07 song', 't', 'u']);
  assert.ok(out[1].tracks.every((t) => t.durationSec === null));
  assert.equal(new Set(out.map((a) => a.id)).size, 3, 'ids stay unique');
});

test('albumsToCoverflow: duplicate titles stay separate entries; non-Latin and 5000-char titles pass through', () => {
  const long = 'L'.repeat(5000);
  const items = shelfItems(groupTracks([
    T('a', { artist: 'P', album: 'Same' }), T('b', { artist: 'Q', album: 'Same' }),
    T('c', { artist: '山下達郎', album: 'ライド・オン・タイム' }), T('d', { artist: 'Ünïcode', album: 'Ωmega ☂' }),
    T('e', { artist: 'R', album: long }),
  ]));
  const out = albumsToCoverflow(items);
  assert.equal(out.length, 5);
  assert.equal(out.filter((a) => a.title === 'Same').length, 2);
  assert.notEqual(out.find((a) => a.artist === 'P').coverSeed, out.find((a) => a.artist === 'Q').coverSeed);
  assert.ok(out.some((a) => a.title === 'ライド・オン・タイム' && a.artist === '山下達郎'));
  assert.equal(out.find((a) => a.artist === 'R').title.length, 5000);      // the adapter keeps data intact; the component clips for display
});

test('albumsToCoverflow: 500 albums, unique ids, fast', () => {
  const tracks = [];
  for (let i = 0; i < 500; i++) for (let k = 1; k <= 4; k++) tracks.push({ title: `t${k}`, artist: `Artist ${i % 37}`, album: `Album ${i}`, path: `m/${i}/${k}.mp3`, trackNo: k, durationSec: 100 + k });
  const t0 = Date.now();
  const out = albumsToCoverflow(shelfItems(groupTracks(tracks)));
  assert.equal(out.length, 500);
  assert.equal(new Set(out.map((a) => a.id)).size, 500);
  assert.ok(out.every((a) => a.tracks.length === 4));
  assert.ok(Date.now() - t0 < 2000);
});

test('builtinTestPressing: one track by default; the app may supply its own', () => {
  const b = builtinTestPressing();
  assert.equal(b.id, TEST_PRESSING_ID); assert.equal(b.title, 'Test pressing'); assert.equal(b.kind, 'vinyl'); assert.equal(b.builtin, true);
  assert.deepEqual(b.tracks, [{ title: 'Test pressing', durationSec: null }]);
  assert.ok(isBuiltinAlbum(b)); assert.ok(!isBuiltinAlbum({ id: 'x' })); assert.ok(!isBuiltinAlbum(null));
  assert.equal(builtinTestPressing().coverSeed, b.coverSeed);
  const c = builtinTestPressing({ durationSec: 52.8 }); assert.equal(c.tracks[0].durationSec, 52.8);
  const d = builtinTestPressing({ tracks: [{ title: 'I', durationSec: 10 }, { title: 'II' }] });
  assert.deepEqual(d.tracks, [{ title: 'I', durationSec: 10 }, { title: 'II', durationSec: null }]);
});
