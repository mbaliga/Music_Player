// radio-store.test.mjs — favourites / recents / last-played model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STORE_KEY, MAX_RECENTS, emptyModel, stationKey, snapshotOf, stationFromEntry, parseModel, serializeModel,
  isFavourite, toggleFavourite, recordPlayed, clearRecents, loadModel, saveModel,
} from '../src/radio-store.js';
import { parseStations, streamCandidates, reconnectDelayMs, MAX_RECONNECTS } from '../src/radio.js';

const st = (n = 1, o = {}) => ({ type: 'radio-browser', id: `rb:u${n}`, name: `Station ${n}`, streamUrl: `https://s/${n}`, streamUrls: [`https://s/${n}`, `https://alt/${n}`],
  favicon: 'https://s/f.png', tags: ['jazz'], country: 'Germany', codec: 'MP3', bitrate: 128, votes: 99, ...o });

test('stationKey: type + id, null when unusable', () => {
  assert.equal(stationKey(st(1)), 'radio-browser|rb:u1');
  assert.equal(stationKey({ type: 'radio-browser' }), null);
  assert.equal(stationKey(null), null);
  assert.notEqual(stationKey({ type: 'ai-you', id: 'x' }), stationKey({ type: 'radio-browser', id: 'x' }));
});

test('favourites: toggle on/off, newest first, snapshot keeps playable fields only', () => {
  let m = emptyModel();
  m = toggleFavourite(m, st(1), 10); m = toggleFavourite(m, st(2), 20);
  assert.deepEqual(m.favs.map((e) => e.id), ['rb:u2', 'rb:u1']);
  assert.ok(isFavourite(m, st(1)));
  assert.equal(m.favs[0].snap.votes, undefined);
  m = toggleFavourite(m, st(1));
  assert.ok(!isFavourite(m, st(1)));
  assert.equal(toggleFavourite(m, { type: 'x' }), m); // unusable station is a no-op
  assert.equal(toggleFavourite(m, { type: 'x', id: 'y', name: '  ' }), m);
});

test('recents: deduped, most recent first, capped; last tracks the latest', () => {
  let m = emptyModel();
  for (let i = 1; i <= MAX_RECENTS + 5; i++) m = recordPlayed(m, st(i), i);
  assert.equal(m.recents.length, MAX_RECENTS);
  assert.equal(m.recents[0].id, `rb:u${MAX_RECENTS + 5}`);
  m = recordPlayed(m, st(MAX_RECENTS + 2), 999);
  assert.equal(m.recents.length, MAX_RECENTS);
  assert.equal(m.recents.filter((e) => e.id === `rb:u${MAX_RECENTS + 2}`).length, 1);
  assert.equal(m.recents[0].id, `rb:u${MAX_RECENTS + 2}`);
  assert.equal(m.last.id, `rb:u${MAX_RECENTS + 2}`);
  assert.equal(clearRecents(m).recents.length, 0);
  assert.ok(clearRecents(m).last); // resume survives clearing the list
});

test('recordPlayed refreshes a favourite snapshot (stream URL drift)', () => {
  let m = toggleFavourite(emptyModel(), st(1));
  m = recordPlayed(m, st(1, { streamUrl: 'https://new/1', streamUrls: ['https://new/1'] }), 5);
  assert.equal(m.favs[0].snap.streamUrl, 'https://new/1');
});

test('persistence round trip; entry becomes a playable station offline', () => {
  let m = recordPlayed(toggleFavourite(emptyModel(), st(1)), st(2), 7);
  const back = parseModel(serializeModel(m));
  assert.deepEqual(back, m);
  const s = stationFromEntry(back.favs[0]);
  assert.equal(s.type, 'radio-browser'); assert.equal(s.id, 'rb:u1');
  assert.deepEqual(streamCandidates(s), ['https://s/1', 'https://alt/1']);
  assert.equal(s.name, 'Station 1');
});

test('parseModel never throws and drops bad data', () => {
  for (const bad of [null, undefined, '', '{', 'null', '[]', '42', '{"v":2,"favs":[1]}', { v: 1, favs: 'x', recents: {}, last: 3 }, {}]) {
    assert.deepEqual(parseModel(bad), emptyModel());
  }
  const m = parseModel({ v: 1, favs: [null, 3, { type: 'a', id: 'b' }, { type: 'a', id: 'b', snap: { name: 'ok', streamUrl: 'javascript:alert(1)', tags: [1, 'x'] } },
    { type: 'a', id: 'b', snap: { name: 'dupe' } }], recents: [], last: { type: 'a' } });
  assert.equal(m.favs.length, 1);
  assert.equal(m.favs[0].snap.streamUrl, undefined); // non-http dropped
  assert.deepEqual(m.favs[0].snap.tags, ['x']);
  assert.equal(m.last, null);
});

test('storage wrapper: guards getItem/setItem throwing, uses versioned key', () => {
  const boom = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.deepEqual(loadModel(boom), emptyModel());
  assert.equal(saveModel(boom, emptyModel()), false);
  assert.deepEqual(loadModel(null), emptyModel());
  const mem = new Map(); const ok = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  assert.equal(saveModel(ok, toggleFavourite(emptyModel(), st(3))), true);
  assert.ok(mem.has(STORE_KEY));
  assert.equal(loadModel(ok).favs[0].id, 'rb:u3');
});

test('future AI stations share the dial with no migration', () => {
  const you = { type: 'ai-you', id: 'you', name: 'You', tags: [], country: '' };
  let m = recordPlayed(toggleFavourite(emptyModel(), you), st(1));
  m = parseModel(serializeModel(m));
  assert.ok(isFavourite(m, you));
  assert.equal(stationFromEntry(m.favs[0]).streamUrl, undefined);
});

test('parseStations exposes the directory alternate URL; candidates + backoff', () => {
  const r = { stationuuid: 'u', name: 'A', url: 'https://orig/x', url_resolved: 'https://res/x', lastcheckok: 1 };
  const [s] = parseStations([r]).stations;
  assert.deepEqual(s.streamUrls, ['https://res/x', 'https://orig/x']);
  assert.equal(s.streamUrl, s.streamUrls[0]);
  assert.deepEqual(parseStations([{ ...r, url: 'http://orig/x' }]).stations[0].streamUrls, ['https://res/x']); // http alt dropped
  assert.deepEqual(parseStations([{ ...r, url: 'https://res/x' }]).stations[0].streamUrls, ['https://res/x']);
  assert.deepEqual(streamCandidates(null), []);
  assert.deepEqual(streamCandidates({ streamUrl: 'ftp://x', streamUrls: ['https://a', 'https://a'] }), ['https://a']);
  assert.deepEqual([0, 1, 2, 3, 4, 9].map(reconnectDelayMs), [1000, 2000, 4000, 8000, 8000, 8000]);
  assert.equal(MAX_RECONNECTS, 4);
});

test('snapshotOf bounds oversized input', () => {
  const s = snapshotOf({ name: 'x'.repeat(999), tags: Array(20).fill('t'), streamUrls: Array(9).fill(0).map((_, i) => `https://h/${i}`) });
  assert.equal(s.name.length, 200); assert.equal(s.tags.length, 5); assert.equal(s.streamUrls.length, 4);
});
