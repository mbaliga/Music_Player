import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDirectorySearch, clean, OFFLINE_NOTE } from '../src/search/directory.js';

const API = [{ stationuuid: 'u1', name: 'Jazz FM', url_resolved: 'https://s.example/jazz', votes: 5, lastcheckok: 1, country: 'UK', tags: 'jazz,lounge', codec: 'mp3', bitrate: 128 },
  { stationuuid: 'u2', name: 'Plain http', url_resolved: 'http://s.example/x', votes: 1, lastcheckok: 1 }];
const mkFetch = (log, { fail = false, late = null } = {}) => async (url) => {
  log.push(String(url));
  if (fail) throw new Error('down');
  if (late) await late;
  return { ok: true, json: async () => (String(url).includes('/servers') ? [{ name: 'de1.api.radio-browser.info' }] : API) };
};

test('creating it and building a UI around it makes no request', () => {
  const log = []; createDirectorySearch({ fetchImpl: mkFetch(log) });
  assert.deepEqual(log, []);
});
test('search: discovers servers once, queries by name, returns https stations only', async () => {
  const log = []; const d = createDirectorySearch({ fetchImpl: mkFetch(log), isOnline: () => true });
  const r = await d.search('  jazz ');
  assert.equal(r.ok, true); assert.deepEqual(r.stations.map((s) => s.name), ['Jazz FM']);
  assert.equal(r.stations[0].type, 'radio-browser'); assert.ok(r.stations[0].streamUrl.startsWith('https://'));
  assert.ok(log.some((u) => u.includes('/json/stations/search') && u.includes('name=jazz') && u.includes('limit=20')));
  const n = log.filter((u) => u.includes('/servers')).length; await d.search('rock');
  assert.equal(log.filter((u) => u.includes('/servers')).length, n);
});
test('offline: no request is made at all, and the note is plain', async () => {
  const log = []; const d = createDirectorySearch({ fetchImpl: mkFetch(log), isOnline: () => false });
  const r = await d.search('jazz');
  assert.deepEqual(log, []); assert.equal(r.ok, false); assert.equal(r.kind, 'offline'); assert.equal(r.error, OFFLINE_NOTE);
});
test('unreachable directory degrades to a plain message; empty and hostile queries are handled', async () => {
  const d = createDirectorySearch({ fetchImpl: mkFetch([], { fail: true }), isOnline: () => true });
  const r = await d.search('jazz'); assert.equal(r.ok, false); assert.equal(r.kind, 'unreachable'); assert.match(r.error, /not reachable/);
  assert.equal((await d.search('   ')).kind, 'empty-query'); assert.equal((await d.search(null)).kind, 'empty-query');
  assert.equal(clean('a\u0000b\n c'), 'a b c'); assert.equal(clean('x'.repeat(500)).length, 100);
});
test('latest call wins: a slow earlier response is superseded', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const d = createDirectorySearch({ fetchImpl: mkFetch([], { late: gate }), isOnline: () => true });
  const first = d.search('jazz'); const second = d.search('rock'); release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.kind, 'superseded'); assert.equal(b.ok, true);
  const c = createDirectorySearch({ fetchImpl: mkFetch([]), isOnline: () => true }); const p = c.search('x'); c.cancel(); assert.equal((await p).kind, 'superseded');
});
