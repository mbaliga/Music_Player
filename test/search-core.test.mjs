import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fold, foldMap, tokenize, within1 } from '../src/search/fold.js';
import {
  buildIndex, createIndexBuilder, query, parseQuery, highlight, replaceType, indexSize, groupsOf, TYPES, MAX_QUERY, MAX_DOCS,
} from '../src/search/index.js';

const T = (id, title, artist, album, extra = {}) => ({ id, title, artist, album, ...extra });
const ix1 = () => buildIndex({
  tracks: [
    T('1', 'Army of Me', 'Björk', 'Post'), T('2', 'Hyperballad', 'Björk', 'Post'), T('3', 'Queen of Hearts', 'Nobody', 'Cards'),
    T('4', 'Bohemian Rhapsody', 'Queen', 'A Night at the Opera'), T('5', 'Queenie', 'Pat', 'Misc'), T('6', 'Under Pressure', 'Queen', 'Hot Space'),
    T('7', '東京ブギウギ', '笠置シヅ子', 'Best'), T('8', 'Café del Mar', 'Energy 52', 'Balearic'), T('9', 'Radio Ga Ga', 'Queen', 'The Works'),
  ],
  albums: [{ id: 'a1', name: 'Post', artist: 'Björk', kind: 'vinyl', trackCount: 11 }, { id: 'a2', name: 'Hot Space', artist: 'Queen', kind: 'cd', trackCount: 10 }],
  artists: [{ name: 'Björk', albums: 1, tracks: 2 }, { name: 'Queen', albums: 2, tracks: 3 }],
  mixtapes: [{ id: 'm1', name: 'Road Trip', author: 'Sam', tracks: [{ title: 'Hyperballad', artist: 'Björk' }, 'Highway Star'] }],
  stations: [
    { id: 'kilo', type: 'canned', name: 'Kilo-Hertz Rock 102.7', dial: '102.7', tagline: 'Loud enough to count as a hobby.', hosts: [{ name: 'Big Danny Sparks' }], source: 'canned' },
    { id: 'jazz', type: 'radio-browser', name: 'Jazz FM', tags: ['jazz', 'lounge'], country: 'UK', source: 'saved' },
    { id: 'you', type: 'ai-you', name: 'You Radio', source: 'you' },
  ],
});
const titles = (r, k) => r[k].map((x) => x.title);

test('fold: case, diacritics, compatibility forms, specials', () => {
  assert.equal(fold('Björk'), 'bjork');
  assert.equal(fold('ÉCOLE Ñandú'), 'ecole nandu');
  assert.equal(fold('ﬁne Ｒｕｎｏｕｔ'), 'fine runout');
  assert.equal(fold('Straße Øresund'), 'strasse oresund');
  assert.equal(fold('東京'), '東京');
  assert.equal(fold(null), ''); assert.equal(fold(42), '');
});
test('foldMap maps folded units back to original ranges', () => {
  const m = foldMap('Björk');
  assert.equal(m.s, 'bjork'); assert.equal(m.from.length, 5);
  const m2 = foldMap('Straße');           // one original char -> two folded units
  assert.equal(m2.s, 'strasse'); assert.deepEqual([m2.from[4], m2.to[4], m2.from[5], m2.to[5]], [4, 5, 4, 5]);
});
test('tokenize splits on non-letters, keeps digits, caps token count/length', () => {
  assert.deepEqual(tokenize('kilo-hertz rock 102.7').map((x) => x.t), ['kilo', 'hertz', 'rock', '102', '7']);
  assert.equal(tokenize('a '.repeat(100)).length, 32);
  assert.equal(tokenize('x'.repeat(500))[0].t.length, 64);
});
test('within1: substitution, insertion, deletion, transposition; not 2 edits', () => {
  for (const [a, b] of [['bjork', 'bjork'], ['bjork', 'bjrk'], ['bjork', 'bjorkk'], ['bjork', 'bjerk'], ['bjork', 'bjrok'], ['queen', 'queeen']]) assert.ok(within1(a, b), a + b);
  for (const [a, b] of [['bjork', 'bjrko'], ['queen', 'qeen x'], ['abcd', 'badc'], ['abcd', 'abxxd']]) assert.ok(!within1(a, b), a + b);
});

test('diacritics: Bjork finds Björk and Björk finds Bjork', () => {
  const ix = ix1();
  for (const q of ['bjork', 'Bjork', 'BJÖRK', 'björk']) {
    const r = query(ix, q);
    assert.equal(r.counts.artists, 1, q);
    assert.ok(titles(r, 'songs').includes('Army of Me'), q);
  }
  assert.equal(query(ix, 'cafe').songs[0].title, 'Café del Mar');
});
test('ranges point into the ORIGINAL text (accents preserved)', () => {
  const r = query(ix1(), 'bjork');
  const a = r.artists[0];
  assert.deepEqual(a.ranges.title, [[0, 5]]);
  const s = r.songs.find((x) => x.title === 'Army of Me');
  const sub = s.subtitle; const [[b, e]] = s.ranges.subtitle;
  assert.equal(sub.slice(b, e), 'Björk');
});
test('CJK matches by plain substring, with highlights', () => {
  const ix = ix1();
  for (const q of ['東京', '京ブ', 'ブギ']) { const r = query(ix, q); assert.deepEqual(titles(r, 'songs'), ['東京ブギウギ'], q); }
  const r = query(ix, '笠置'); assert.equal(r.songs.length, 1);
  assert.deepEqual(r.songs[0].ranges.subtitle, [[0, 2]]);
});
test('ranking: exact > prefix > substring (title beats artist beats album inside a class)', () => {
  const ix = buildIndex({ tracks: [
    T('a', 'Superqueen', 'X', 'Y'),            // substring in title
    T('b', 'Queenie', 'X', 'Y'),               // prefix in title
    T('c', 'Anything', 'Queen', 'Y'),          // exact word in artist
    T('d', 'Queen', 'X', 'Y'),                 // exact title (whole)
    T('e', 'Other', 'X', 'Queen Anthology'),   // exact word in album
    T('f', 'Queen of Hearts', 'X', 'Y'),       // exact word in title + phrase prefix
  ] });
  const order = titles(query(ix, 'queen', { limit: 20 }), 'songs');
  assert.deepEqual(order, ['Queen', 'Queen of Hearts', 'Anything', 'Other', 'Queenie', 'Superqueen']);
});
test('title beats artist beats album within the same match class', () => {
  const ix = buildIndex({ tracks: [T('1', 'Zed', 'Moon', 'Q'), T('2', 'Moon', 'Q', 'Q'), T('3', 'Zed', 'Q', 'Moon')] });
  assert.deepEqual(query(ix, 'moon').songs.map((x) => x.id), ['2', '1', '3']);
});
test('AND across tokens, in any order, across fields', () => {
  const ix = ix1();
  assert.deepEqual(titles(query(ix, 'queen under'), 'songs'), ['Under Pressure']);
  assert.deepEqual(titles(query(ix, 'under queen'), 'songs'), ['Under Pressure']);
  assert.deepEqual(titles(query(ix, 'hyperballad bjork post'), 'songs'), ['Hyperballad']);
  assert.equal(query(ix, 'queen zzzzz').counts.total, 0);
});
test('prefix match on tokens while typing', () => {
  const ix = ix1();
  assert.equal(query(ix, 'hyperb').songs[0].title, 'Hyperballad');
  assert.equal(query(ix, 'bohem rhap').songs[0].title, 'Bohemian Rhapsody');
});
test('typos: edit distance 1 on tokens of 4+ letters only, strict hits suppress the typo pass', () => {
  const ix = ix1();
  const r = query(ix, 'hyperbalad');            // deletion
  assert.equal(r.fuzzy, true); assert.equal(r.songs[0].title, 'Hyperballad');
  assert.equal(query(ix, 'bjrok').artists[0].title, 'Björk');          // transposition
  assert.equal(query(ix, 'rhapsodi').songs[0].title, 'Bohemian Rhapsody'); // substitution
  assert.equal(query(ix, 'jaz').counts.stations, 1);                     // short token: prefix works
  assert.equal(query(ix, 'jzz').counts.total, 0);                        // 3 letters: no typo tolerance
  const strict = query(ix, 'queen', { limit: 20 }); assert.equal(strict.fuzzy, false);
  assert.equal(query(ix, 'hyperxxxx').counts.total, 0);                  // 2+ edits
});
test('highlights: fuzzy word highlighted as a whole; multi-token; merged', () => {
  assert.deepEqual(highlight('Hyperballad', ['hyperbalad'], { fuzzy: true }), [[0, 11]]);
  assert.deepEqual(highlight('Under Pressure', ['under', 'press']), [[0, 5], [6, 11]]);
  assert.deepEqual(highlight('queen queen', ['queen']), [[0, 5], [6, 11]]);
  assert.deepEqual(highlight('abc', []), []); assert.deepEqual(highlight(null, ['a']), []);
  assert.deepEqual(highlight('Radio', ['x']), []);
});
test('type: operator and type filter option', () => {
  const ix = ix1();
  assert.deepEqual(parseQuery('type:artist bjork'), { tokens: ['bjork'], types: ['artists'] });
  assert.deepEqual(parseQuery('TYPE:Radio  jazz fm').types, ['stations']);
  assert.deepEqual(parseQuery('in:tapes in:albums x').types, ['mixtapes', 'albums']);
  assert.deepEqual(parseQuery('type:nonsense x'), { tokens: ['type', 'nonsense', 'x'], types: [] });
  const r = query(ix, 'type:artist queen');
  assert.deepEqual(r.types, ['artists']); assert.equal(r.songs.length, 0); assert.equal(r.artists.length, 1);
  const r2 = query(ix, 'queen', { types: ['albums', 'songs'] });
  assert.deepEqual(r2.types, ['songs', 'albums']); assert.equal(r2.artists.length, 0);
  assert.deepEqual(query(ix, 'queen', { types: ['bogus'] }).types, [...TYPES]);
});
test('grouping and caps: default 5 per group, 50 when solo, explicit limits, counts are totals', () => {
  const tracks = Array.from({ length: 80 }, (_, i) => T('t' + i, 'Song ' + i, 'Artist', 'Album'));
  const ix = buildIndex({ tracks });
  const all = query(ix, 'song');
  assert.equal(all.songs.length, 5); assert.equal(all.counts.songs, 80);
  assert.equal(query(ix, 'song', { types: ['songs'] }).songs.length, 50);
  assert.equal(query(ix, 'song', { limit: 12 }).songs.length, 12);
  assert.equal(query(ix, 'song', { limit: { songs: 3 } }).songs.length, 3);
  assert.equal(query(ix, 'song', { limit: 9999 }).songs.length, 80);
  assert.equal(query(ix, 'song', { limit: -4 }).songs.length, 1);
  assert.deepEqual(groupsOf(all).map((g) => g.type), ['songs']);
  assert.equal(groupsOf(all)[0].count, 80);
});
test('stable ordering: ties keep title order then input order; repeat queries are identical', () => {
  const tracks = [T('1', 'Same', 'A', 'x'), T('2', 'Same', 'A', 'x'), T('3', 'Alpha Same', 'A', 'x'), T('4', 'Same', 'A', 'x')];
  const ix = buildIndex({ tracks });
  const a = query(ix, 'same', { now: 1 }), b = query(ix, 'same', { now: 1 });
  assert.deepEqual(a, b);
  assert.deepEqual(a.songs.map((x) => x.id), ['1', '2', '4', '3']);
});
test('play count / recency boost: breaks ties, never beats a better match class', () => {
  const now = Date.UTC(2026, 5, 1);
  const ix = buildIndex({ tracks: [
    T('cold', 'Moonlight', 'A', 'x'), T('hot', 'Moonlight', 'A', 'x', { plays: 40, lastPlayed: now - 86400000 }),
    T('exact', 'Moon', 'A', 'x'), T('old', 'Moonlight', 'A', 'x', { plays: 40, lastPlayed: now - 400 * 86400000 }),
  ] });
  const ids = query(ix, 'moon', { now, limit: 10 }).songs.map((x) => x.id);
  assert.deepEqual(ids, ['exact', 'hot', 'old', 'cold']);
  const r = query(ix, 'moonlight', { now }); assert.equal(r.songs[0].id, 'hot');
});
test('empty query shows what was played or saved lately, ranked by boost', () => {
  const now = Date.UTC(2026, 5, 1);
  const ix = buildIndex({ tracks: [T('1', 'A', 'x', 'y'), T('2', 'B', 'x', 'y', { plays: 3, lastPlayed: now - 3600e3 }), T('3', 'C', 'x', 'y', { lastPlayed: now - 10 * 86400e3 })], stations: [{ id: 's', type: 'canned', name: 'S', lastPlayed: now - 1000 }] });
  const r = query(ix, '   ', { now });
  assert.equal(r.empty, true);
  assert.deepEqual(r.songs.map((x) => x.id), ['2', '3']); assert.equal(r.stations.length, 1);
  assert.deepEqual(r.songs[0].ranges, { title: [], subtitle: [] });
});
test('mixtapes match by name, author and the songs on them (and say which song)', () => {
  const ix = ix1();
  assert.equal(query(ix, 'road').mixtapes[0].title, 'Road Trip');
  assert.equal(query(ix, 'sam').mixtapes[0].title, 'Road Trip');
  const r = query(ix, 'highway');
  assert.equal(r.mixtapes[0].title, 'Road Trip'); assert.match(r.mixtapes[0].detail, /Highway Star/);
  assert.ok(r.mixtapes[0].ranges.detail.length);
});
test('stations match by name, dial, tags, hosts, tagline; flags carried through', () => {
  const ix = buildIndex({ stations: [
    { id: 'kilo', type: 'canned', name: 'Kilo-Hertz Rock 102.7', dial: '102.7', hosts: [{ name: 'Big Danny Sparks' }], tagline: 'Loud enough to count as a hobby.' },
    { id: 'st', type: 'ai-style', name: 'Late Night Style', disabled: true, note: 'coming soon', source: 'style' },
  ] });
  for (const q of ['kilo', '102.7', 'danny', 'hobby', 'hertz rock']) assert.equal(query(ix, q).stations[0].id, 'kilo', q);
  const st = query(ix, 'late').stations[0];
  assert.equal(st.disabled, true); assert.equal(st.note, 'coming soon'); assert.equal(st.stationType, 'ai-style');
});
test('hostile input: regex metacharacters, huge strings, control chars, non-strings never throw', () => {
  const ix = ix1();
  for (const q of ['.*', '(((', '[a-', '\\', '(a+)+$', '?*+^$|', 'a'.repeat(100000), '\u0000\u0001', '\uD800', ' '.repeat(5000), 'a '.repeat(10000), null, undefined, 42, {}, [], 'type:', 'type:artist']) {
    const r = query(ix, q);
    assert.ok(r && typeof r.counts.total === 'number', String(q).slice(0, 10));
    assert.ok(r.tokens.length <= 8);
  }
  const t0 = performance.now(); query(ix, '(a+)+'.repeat(40) + '!'); assert.ok(performance.now() - t0 < 200);
  assert.equal(query(ix, 'a'.repeat(100000)).text.length, MAX_QUERY);
  assert.equal(query(null, 'x').counts.total, 0); assert.equal(query({}, 'x').counts.total, 0);
});
test('hostile data: huge titles are cut, junk records skipped, results are plain data', () => {
  const ix = buildIndex({ tracks: [T('1', '<img src=x onerror=alert(1)>'.repeat(200), 'a'.repeat(1e6), 'b'), null, 7, 'str', { title: {} }, T('2', '<b>Bold</b> & "quotes"', "x'y", 'z')], mixtapes: [{ id: 'm', tracks: 'nope' }, null], stations: 5, albums: 'x' });
  assert.ok(indexSize(ix) >= 3);
  const r = query(ix, 'bold');
  assert.equal(r.songs[0].title, '<b>Bold</b> & "quotes"');
  assert.ok(r.songs[0].title.length <= 240);
  assert.equal(query(ix, 'img').songs[0].title.length, 240);
  assert.equal(JSON.parse(JSON.stringify(r)).songs.length, 1);
});
test('MAX_DOCS bounds memory', () => { assert.ok(MAX_DOCS >= 20000 && MAX_DOCS <= 200000); });
test('replaceType swaps one type in place', () => {
  const ix = ix1();
  replaceType(ix, 'mixtapes', [{ id: 'n', name: 'New Tape', tracks: [] }]);
  assert.equal(query(ix, 'road').counts.mixtapes, 0); assert.equal(query(ix, 'new tape').mixtapes[0].id, 'n');
  replaceType(ix, 'nope', []); replaceType(null, 'songs', []);
});

test('chunked builder: queryable mid-build, progress, injected scheduler, cancel', async () => {
  const tracks = Array.from({ length: 2500 }, (_, i) => T('t' + i, 'Track ' + i, 'Artist ' + (i % 50), 'Album ' + (i % 100)));
  const queue = []; const seen = [];
  const b = createIndexBuilder({ tracks }, { schedule: (fn) => queue.push(fn), chunk: 1000, onProgress: (d, t) => seen.push([d, t]) });
  assert.equal(queue.length, 1); assert.equal(b.progress(), 0);
  queue.shift()();                                           // first chunk
  assert.equal(b.progress(), 0.4);
  assert.equal(query(b.index, 'track 7', { types: ['songs'] }).songs[0].title, 'Track 7');
  assert.equal(indexSize(b.index), 1000);   // the rest is not indexed yet
  while (queue.length) queue.shift()();
  const ix = await b.done;
  assert.equal(ix, b.index); assert.equal(b.progress(), 1);
  assert.deepEqual(seen.map((x) => x[0]), [1000, 2000, 2500]);
  assert.equal(query(ix, 'track 1999').songs[0].id, 't1999');
  const q2 = []; const c = createIndexBuilder({ tracks }, { schedule: (fn) => q2.push(fn), chunk: 10 });
  q2.shift()(); c.cancel(); q2.shift()();
  assert.equal(indexSize(await c.done), 10);
  assert.equal(indexSize(await createIndexBuilder({}).done), 0);
});
test('chunked builder never lets a throwing observer or bad item stop the build', async () => {
  const q = [];
  const b = createIndexBuilder({ tracks: [null, T('1', 'ok', 'a', 'b')] }, { schedule: (f) => q.push(f), onProgress: () => { throw new Error('x'); } });
  while (q.length) q.shift()();
  assert.equal(indexSize(await b.done), 1);
});

// ── 20k-track timing (generous budget; the measured numbers are printed and reported in docs/SEARCH.md) ───────────────────
function lcg(seed) { let x = seed >>> 0; return () => (x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 4294967296; }
const WORDS = 'love night river fire moon silver golden heart dream road city blue red shadow light dance home lost wild paper glass echo storm summer winter rain stone ocean ghost velvet neon'.split(' ');
function bigLib(n) {
  const r = lcg(7), pick = () => WORDS[Math.floor(r() * WORDS.length)];
  return Array.from({ length: n }, (_, i) => T('id' + i, `${pick()} ${pick()} ${i % 7 === 0 ? pick() : ''}`.trim() + ' ' + (i % 13), `Artist ${pick()} ${i % 400}`, `Album ${pick()} ${i % 1500}`, { plays: i % 17 === 0 ? i % 9 : 0 }));
}
test('20k tracks: chunked build and query latency', async () => {
  const tracks = bigLib(20000);
  const albums = Array.from({ length: 1500 }, (_, i) => ({ id: 'al' + i, name: `Album ${WORDS[i % WORDS.length]} ${i}`, artist: `Artist ${i % 400}`, trackCount: 13 }));
  const artists = Array.from({ length: 400 }, (_, i) => ({ name: `Artist ${WORDS[i % WORDS.length]} ${i}`, albums: 3, tracks: 50 }));
  let chunks = 0, maxChunkMs = 0, last = performance.now();
  const b = createIndexBuilder({ tracks, albums, artists }, { chunk: 1000, schedule: (fn) => setImmediate(() => { const t = performance.now(); fn(); const d = performance.now() - t; chunks++; if (d > maxChunkMs) maxChunkMs = d; }) });
  const t0 = performance.now();
  const ix = await b.done;
  const buildMs = performance.now() - t0;
  const qs = ['love', 'silver moon', 'artist 12', 'gld', 'velvet ghost 4', 'nepn', 'a', 'type:artist artist', 'zzzzzzzz'];
  const times = {};
  for (const q of qs) {
    query(ix, q);                                        // warm
    const ts = []; for (let i = 0; i < 5; i++) { const s = performance.now(); query(ix, q); ts.push(performance.now() - s); }
    times[q] = Math.round(Math.min(...ts) * 10) / 10;
  }
  const worst = Math.max(...Object.values(times));
  console.log(`# search 20k: build ${Math.round(buildMs)} ms in ${chunks} chunks (worst chunk ${maxChunkMs.toFixed(1)} ms); query ms ${JSON.stringify(times)}`);
  assert.equal(indexSize(ix), 21900);
  assert.ok(worst < 150, 'query budget (generous: CI machines vary) worst=' + worst);
  assert.ok(maxChunkMs < 250, 'chunk budget ' + maxChunkMs);
  assert.ok(query(ix, 'love').songs.length > 0);
  assert.ok(buildMs < 8000);
});
