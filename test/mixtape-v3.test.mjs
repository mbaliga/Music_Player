// mixtape-v3.test.mjs — the v3 model (cassette cfg + author), v1/v2 migration,
// one-way import of the standalone deck data, tape locate (inverse of progress).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MIXTAPE_VERSION, LEGACY_STYLE_MAP, LEGACY_FONT_MAP, PEN_IDS, cassetteStyles, hasStyle, hasPen,
  createMixtape, withText, withInk, withWear, withGloss, withPen, withStyle, withAuthor, inkHex,
  cassetteCfg, autoNote, serializeMixtape, parseMixtape, serializeCollection, parseCollection,
  parseImport, fromDeckItem, collectionVersion, isFutureCollection, tapeProgress, locateTape,
  estimateTapeSeconds, STORAGE_KEY,
} from '../src/mixtape.js';

const tr = (title, artist = 'A', album = 'X') => ({ title, artist, album });

test('version is 3 and the storage key is unchanged', () => {
  assert.equal(MIXTAPE_VERSION, 3);
  assert.equal(STORAGE_KEY, 'runout.mixtapes');
});

test('createMixtape (v3): defaults, clamps, validation', () => {
  const m = createMixtape({ id: 'a', name: 'Road', tracks: [tr('1')] });
  assert.deepEqual(m.cfg, { style: 'clear', pen: 'marker', wear: 0.15, gloss: 0.6, text: { subtitle: '', note: '', side: 'A' } });
  assert.equal(m.author, '');
  const x = createMixtape({ id: 'b', author: '  Madhav  ', cfg: { style: 'glass-ice', pen: 'script', wear: 9, gloss: -3, slots: { ink: '#123456' }, text: { subtitle: 's', note: 'n', side: 'b' } } });
  assert.equal(x.author, 'Madhav');
  assert.equal(x.cfg.style, 'glass-ice'); assert.equal(x.cfg.pen, 'script');
  assert.equal(x.cfg.wear, 1); assert.equal(x.cfg.gloss, 0);
  assert.equal(x.cfg.slots.ink, '#123456'); assert.equal(x.cfg.text.side, 'B');
  const bad = createMixtape({ id: 'c', cfg: { style: 'nope', pen: 'nope', slots: { ink: 'red' } } });
  assert.equal(bad.cfg.style, 'clear'); assert.equal(bad.cfg.pen, 'marker'); assert.equal(bad.cfg.slots, undefined);
});

test('pure edits do not mutate and reject bad input', () => {
  const m = createMixtape({ id: 'a', name: 'T' });
  const m2 = withStyle(withPen(withInk(m, '#ffffff'), 'bold'), 'noir');
  assert.equal(m.cfg.style, 'clear'); assert.equal(m2.cfg.style, 'noir'); assert.equal(m2.cfg.pen, 'bold'); assert.equal(inkHex(m2), '#ffffff');
  assert.equal(inkHex(withInk(m2, null)), null);
  assert.equal(withInk(m, 'zzz'), m); assert.equal(withPen(m, 'zzz'), m); assert.equal(withStyle(m, 'zzz'), m);
  assert.equal(withWear(m, 5).cfg.wear, 1); assert.equal(withGloss(m, NaN).cfg.gloss, m.cfg.gloss);
  assert.equal(withText(m, { side: 'abc' }).cfg.text.side, 'AB');
  assert.equal(withText(m, { subtitle: 'x'.repeat(200) }).cfg.text.subtitle.length, 48);
  assert.equal(withAuthor(m, 'y'.repeat(99)).author.length, 28);
});

test('cassetteCfg: title = name, blank note = "Side A · N songs", renders in the engine', () => {
  const m = createMixtape({ id: 'abc', name: 'Night', tracks: [tr('1'), tr('2')] });
  const c = cassetteCfg(m);
  assert.equal(c.text.title, 'Night'); assert.equal(c.text.note, 'Side A · 2 songs'); assert.equal(c.seed, 'abc');
  assert.equal(autoNote(createMixtape({ id: 'z', tracks: [tr('1')] })), 'Side A · 1 song');
  assert.equal(cassetteCfg(withText(m, { note: 'mine' })).text.note, 'mine');
  assert.equal(cassetteCfg(m, { reelStandIns: true }).reelStandIns, true);
  assert.equal(cassetteCfg(withInk(m, '#abcdef')).slots.ink, '#abcdef');
  assert.equal(cassetteCfg(m).slots, undefined);
});

test('v3 serialize -> parse round-trips with stable text', () => {
  const m = createMixtape({ id: 'a', name: 'Road Trip', author: 'M', tracks: [tr('One'), { ...tr('Two'), id: 't1-abc' }],
    cfg: { style: 'glass', pen: 'type', wear: 0.3, gloss: 0.9, slots: { ink: '#1F4FD8' }, text: { subtitle: 'tag', note: 'n', side: 'B' } } });
  const text = serializeMixtape(m);
  assert.equal(JSON.parse(text).version, 3);
  const p = parseMixtape(text, { id: 'a' });
  assert.ok(p.ok, p.error);
  assert.deepEqual(p.mixtape, m);
  assert.equal(serializeMixtape(p.mixtape), text);
});

test('v1/v2 style + font + colour ids migrate to the nearest new style/pen; none map to a missing style', () => {
  for (const [old, now] of Object.entries(LEGACY_STYLE_MAP)) assert.ok(hasStyle(now), `${old} -> ${now}`);
  for (const [old, now] of Object.entries(LEGACY_FONT_MAP)) assert.ok(hasPen(now), `${old} -> ${now}`);
  assert.equal(Object.keys(LEGACY_STYLE_MAP).length, 8);
  assert.equal(Object.keys(LEGACY_FONT_MAP).length, 6);
  for (const v of [1, 2]) {
    const doc = JSON.stringify({ version: v, name: 'Old', style: 'sunburst', font: 'serif', fontColor: '#1f4fd8', tracks: [{ title: 'a', artist: 'b', album: 'c' }] });
    const p = parseMixtape(doc, { id: 'x' });
    assert.ok(p.ok, p.error);
    assert.equal(p.mixtape.cfg.style, 'tangerine'); assert.equal(p.mixtape.cfg.pen, 'script'); assert.equal(inkHex(p.mixtape), '#1f4fd8');
  }
  // the old default font colour means "no override"
  const d = parseMixtape(JSON.stringify({ version: 2, name: 'N', style: 'noir', font: 'mono', fontColor: '#1a1a1f', tracks: [] }));
  assert.equal(inkHex(d.mixtape), null);
  // unknown legacy ids are still named errors (never silently substituted)
  assert.match(parseMixtape(JSON.stringify({ version: 2, name: 'N', style: 'glass', font: 'mono', fontColor: '#111111', tracks: [] })).error, /Unknown "style"/);
  assert.match(parseMixtape(JSON.stringify({ version: 1, name: 'N', style: 'noir', font: 'zzz', fontColor: '#111111', tracks: [] })).error, /Unknown "font"/);
});

test('v2 collection blobs migrate in place, keep ref ids, and re-save as v3', () => {
  const v2 = JSON.stringify({ version: 2, mixtapes: [
    { id: 'm1', name: 'Neon', style: 'neon-grid', font: 'typewriter', fontColor: '#2de2e6', tracks: [{ title: 't', artist: 'a', album: 'b', id: 'tid' }] },
    { id: 'm2', name: 'Plain', style: 'checker', font: 'marker', fontColor: '#1a1a1f', tracks: [] },
    null, { id: 5 },
  ] });
  assert.equal(collectionVersion(v2), 2);
  const list = parseCollection(v2);
  assert.equal(list.length, 2);
  assert.equal(list[0].cfg.style, 'lilac'); assert.equal(list[0].cfg.pen, 'type'); assert.equal(inkHex(list[0]), '#2de2e6');
  assert.equal(list[0].tracks[0].id, 'tid');
  assert.equal(list[1].cfg.style, 'checker');
  const out = JSON.parse(serializeCollection(list));
  assert.equal(out.version, 3);
  assert.deepEqual(parseCollection(JSON.stringify(out)), list);
});

test('collections: corrupt -> [], future (v4) detectable and never parsed, v3 round-trip', () => {
  const list = [createMixtape({ id: 'a', name: 'A', cfg: { style: 'noir' } }), createMixtape({ id: 'b', name: 'B', tracks: [tr('x')] })];
  assert.deepEqual(parseCollection(serializeCollection(list)), list);
  const fut = JSON.stringify({ version: 4, mixtapes: [{ id: 'x', tracks: [] }] });
  assert.deepEqual(parseCollection(fut), []); assert.equal(isFutureCollection(fut), true);
  assert.equal(isFutureCollection(serializeCollection(list)), false);
  for (const junk of ['', 'null', '[]', '"s"', '{"version":"3"}', '{"version":3}', '{nope', undefined, null]) assert.deepEqual(parseCollection(junk), []);
  assert.equal(collectionVersion('{nope'), null);
});

test('parseImport: runout doc, collection, handoff deck blob and single deck item; never throws', () => {
  const ids = () => { let n = 0; return () => 'new-' + n++; };
  const one = parseImport(serializeMixtape(createMixtape({ id: 'a', name: 'Solo' })), { newId: ids() });
  assert.ok(one.ok); assert.equal(one.source, 'mixtape'); assert.equal(one.mixtapes[0].id, 'new-0');
  const col = parseImport(serializeCollection([createMixtape({ id: 'a', name: 'A' }), createMixtape({ id: 'b', name: 'B' })]), { newId: ids() });
  assert.ok(col.ok); assert.equal(col.mixtapes.length, 2); assert.deepEqual(col.mixtapes.map((m) => m.id), ['new-0', 'new-1']);
  const deckItem = { id: 'm3', cfg: { style: 'glass-ice', pen: 'type', wear: 0.18, gloss: 0.6, text: { title: 'Rainy Sunday', subtitle: 'kettle on', note: 'Side A · 9 tracks', side: 'A' } }, tracks: [{ title: 'S1', artist: 'A', album: 'X' }, 'S2 as string', { artist: 'no title' }], author: 'Madhav' };
  const deck = parseImport(JSON.stringify({ items: [deckItem, null, { id: 'bad' }], n: 3, player: 'deck' }), { newId: ids() });
  assert.ok(deck.ok); assert.equal(deck.source, 'deck'); assert.equal(deck.mixtapes.length, 1);
  const m = deck.mixtapes[0];
  assert.equal(m.name, 'Rainy Sunday'); assert.equal(m.author, 'Madhav'); assert.equal(m.cfg.style, 'glass-ice'); assert.equal(m.cfg.pen, 'type');
  assert.equal(m.cfg.text.subtitle, 'kettle on'); assert.equal(m.tracks.length, 2); assert.equal(m.tracks[1].title, 'S2 as string');
  const single = parseImport(JSON.stringify(deckItem), { newId: ids() });
  assert.ok(single.ok); assert.equal(single.source, 'deck');
  assert.equal(fromDeckItem(null), null); assert.equal(fromDeckItem({ id: 'x' }), null);
  for (const junk of ['{nope', '[]', '3', '{"items":[]}', '{"mixtapes":[]}', '{"version":9,"name":"x"}', 'null']) {
    const r = parseImport(junk); assert.equal(r.ok, false); assert.equal(typeof r.error, 'string');
  }
});

test('every one of the 37 styles and every pen is accepted by the model', () => {
  assert.equal(cassetteStyles().length, 37);
  for (const s of cassetteStyles()) assert.equal(createMixtape({ id: 'a', cfg: { style: s.id } }).cfg.style, s.id);
  for (const p of PEN_IDS) assert.equal(createMixtape({ id: 'a', cfg: { pen: p } }).cfg.pen, p);
});

test('locateTape is the inverse of tapeProgress (equal and time-weighted)', () => {
  for (const durs of [undefined, [10, 30, 20, 40]]) {
    for (let i = 0; i < 4; i++) for (const f of [0, 0.25, 0.5, 0.999]) {
      const p = tapeProgress(i, 4, f, durs);
      const loc = locateTape(p, 4, durs);
      const back = tapeProgress(loc.index, 4, loc.frac, durs);
      assert.ok(Math.abs(back - p) < 1e-9, `${i} ${f}`);
    }
  }
  assert.deepEqual(locateTape(1, 3), { index: 2, frac: 1 });
  assert.deepEqual(locateTape(0, 3), { index: 0, frac: 0 });
  assert.deepEqual(locateTape(NaN, 3), { index: 0, frac: 0 });
  assert.deepEqual(locateTape(0.5, 0), { index: 0, frac: 0 });
  assert.equal(locateTape(0.5, 2, [10, 30]).index, 1);   // 20 s of 40 s -> inside track 2
});

test('estimateTapeSeconds fills unknown durations with the mean of the known (else 4 min)', () => {
  assert.equal(estimateTapeSeconds([100, 200], 2), 300);
  assert.equal(estimateTapeSeconds([100, null, 200], 3), 450);
  assert.equal(estimateTapeSeconds([], 3), 720);
  assert.equal(estimateTapeSeconds(undefined, 2), 480);
});
