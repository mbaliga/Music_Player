// mixtape-suggest.test.mjs — suggested tapes: deterministic, cap-respecting, defensive.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggestTapes, draftToMixtape, SUGGEST_KEYS, MIN_SONGS, MAX_SUGGESTIONS, suggestionBlurb } from '../src/mixtape-suggest.js';
import { sideDuration, isOverCap, TAPES, MAX_SONGS_PER_SIDE, createMixtape } from '../src/mixtape.js';

function fixture() {
  const lib = [];
  const albums = [
    ['Rock Alpha', 'Band One', 'Rock', 1994, 12, 240], ['Rock Beta', 'Band Two', 'Rock', 1996, 10, 230],
    ['Jazz Gamma', 'Trio', 'Jazz', 2011, 8, 400], ['Folk Delta', 'Singer', 'Folk', 1999, 6, 180],
    ['Mega Long', 'Epic', 'Prog', 1975, 9, 900],
  ];
  let n = 0;
  albums.forEach(([album, artist, genre, year, count, dur], ai) => {
    for (let i = 1; i <= count; i++) lib.push({ id: `id${n++}`, title: `${album} ${i}`, artist, album, genre, year, trackNo: i, durationSec: dur, added: 1000 + ai * 100 + i });
  });
  return lib;
}
const history = (lib) => ({ v: 1, tracks: Object.fromEntries(lib.slice(0, 15).map((t, i) => [t.id, { n: 20 - i, last: 5000 + i }])) });

test('five generators produce drafts and every draft respects the tape caps', () => {
  const lib = fixture();
  const s = suggestTapes(lib, { history: history(lib) });
  assert.ok(s.length >= 4 && s.length <= MAX_SUGGESTIONS);
  assert.deepEqual([...new Set(s.map((x) => x.kind))].sort(), ['decade', 'genre', 'long', 'played', 'recent'].filter((k) => s.some((x) => x.kind === k)).sort());
  for (const d of s) {
    assert.ok(d.tracks.length >= MIN_SONGS, d.name);
    const m = draftToMixtape(d, { id: 'mt-test' });
    assert.equal(isOverCap(m), false, d.name + ' within caps');
    for (const side of ['A', 'B']) {
      assert.ok(sideDuration(m, side) <= TAPES[m.tape.length].sideSec);
      assert.ok(m.sides[side].length <= MAX_SONGS_PER_SIDE);
    }
    assert.equal(m.tracks.length, d.tracks.length, d.name + ': nothing lost when it fits');
    assert.ok(m.name.length > 0 && m.name.length <= 40);
  }
});

test('deterministic: same library -> identical drafts and styles; input order does not matter', () => {
  const lib = fixture();
  const a = suggestTapes(lib, { history: history(lib) }), b = suggestTapes(lib.slice().reverse(), { history: history(lib) });
  assert.deepEqual(a.map((x) => [x.id, x.name, x.tracks.map((t) => t.id)]), b.map((x) => [x.id, x.name, x.tracks.map((t) => t.id)]));
  assert.deepEqual(a.map((x) => draftToMixtape(x, { id: 'q' }).cfg.style), b.map((x) => draftToMixtape(x, { id: 'q' }).cfg.style));
});

test('specific generators pick what they say', () => {
  const lib = fixture();
  const s = suggestTapes(lib, { history: history(lib) });
  const by = (k) => s.filter((x) => x.kind === k);
  assert.equal(by('played')[0].tracks[0].id, 'id0');               // most plays first
  assert.equal(by('recent')[0].tracks[0].added >= by('recent')[0].tracks[1].added, true);
  assert.equal(by('genre')[0].name, 'Rock');                        // 22 rock songs, the top genre
  assert.ok(by('genre')[0].tracks.length <= 40);
  assert.equal(by('decade')[0].name, 'The 1990s');
  assert.equal(by('long')[0].name, 'Mega Long');                    // 9 x 15:00 = 2h15
  // 9 x 900s = 8100s > 2 x 45:00 = 5400s -> the draft is cut to what a C90 holds (6 songs), never over the caps
  const d = draftToMixtape(by('long')[0], { id: 'x' });
  assert.equal(d.tape.length, 'C90'); assert.equal(d.tracks.length, 6); assert.equal(isOverCap(d), false);
});

test('sides are split roughly in half by time', () => {
  const lib = fixture();
  const g = suggestTapes(lib).find((x) => x.name === 'Jazz' || x.kind === 'recent');
  const m = draftToMixtape(g, { id: 'x' });
  const a = sideDuration(m, 'A'), b = sideDuration(m, 'B');
  assert.ok(m.sides.B.length > 0); assert.ok(Math.abs(a - b) < Math.max(...m.tracks.map((t) => t.dur || 240)) + 1);
});

test('missing data is fine: no history, no year, no added, tiny library, junk entries', () => {
  assert.deepEqual(suggestTapes([]), []); assert.deepEqual(suggestTapes(null), []); assert.deepEqual(suggestTapes(undefined, { history: 5 }), []);
  const bare = Array.from({ length: 8 }, (_, i) => ({ id: 'b' + i, title: 'T' + i, artist: 'A', album: 'Only' }));
  const s = suggestTapes([...bare, null, 7, { title: '' }], { history: { tracks: 'x' } });
  assert.deepEqual(s.map((x) => x.kind), ['long']);                 // only the album generator has data
  assert.equal(suggestTapes(bare, { history: { tracks: { b0: { n: 'many', last: 'x' }, __proto__: { n: 3 } } } }).some((x) => x.kind === 'played'), false);
  assert.equal(suggestTapes(fixture().slice(0, 3)).length, 0);
});

test('dismissed ids are hidden; setting keys are documented constants', () => {
  const lib = fixture();
  const all = suggestTapes(lib, { history: history(lib) });
  const some = suggestTapes(lib, { history: history(lib), dismissed: [all[0].id] });
  assert.equal(some.some((x) => x.id === all[0].id), false);
  assert.equal(SUGGEST_KEYS.enabled, 'runout.mixtapes.suggest'); assert.match(SUGGEST_KEYS.dismissed, /dismissed/);
  assert.match(suggestionBlurb(all[0]), /songs · \d+:\d\d/);
});

test('hostile titles stay plain text in the draft and the mixtape', () => {
  const lib = Array.from({ length: 6 }, (_, i) => ({ id: 'h' + i, title: `<img src=x onerror=alert(${i})>`, artist: '<b>A</b>', album: '"><script>x</script>', genre: '<i>Evil</i>', durationSec: 100 }));
  const s = suggestTapes(lib);
  assert.ok(s.length > 0);
  const m = draftToMixtape(s.find((x) => x.kind === 'genre') || s[0], { id: 'z' });
  assert.equal(m.tracks[0].title, '<img src=x onerror=alert(0)>');   // untouched data; the UI uses textContent only
  assert.ok(createMixtape({ id: 'k', name: m.name }).name.length > 0);
});

test('draftToMixtape with more songs than a C90 holds fills A then B and drops only what cannot fit (never over caps)', () => {
  const tracks = Array.from({ length: 70 }, (_, i) => ({ id: 'x' + i, title: 'S' + i, artist: 'A', album: 'B', durationSec: 200 }));
  const m = draftToMixtape({ id: 'sg-big', name: 'Big', tagline: '', tracks }, { id: 'mt-big' });
  assert.equal(m.tape.length, 'C90');
  assert.equal(isOverCap(m), false);
  assert.equal(m.sides.A.length, 13); assert.equal(m.sides.B.length, 13);     // 13 x 3:20 = 43:20; a 14th would be 46:40
  assert.deepEqual(m.sides.A[0].title, 'S0');
});
