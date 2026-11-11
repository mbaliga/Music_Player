import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCatalog, parseStationsIndex, daypartOfHour, daypartFits, daypartBadge, cannedCard, PRE_WRITTEN_LABEL, NEEDS_INTERNET, CANNED_TYPE } from '../../src/radio/canned/catalog.js';
import { AI_STYLES, MOOD_PROSODY, AUDITION_SCRIPT, hostProsody, styleById } from '../../src/radio/canned/ai-styles.js';
import { stationKey, snapshotOf, parseModel, serializeModel, recordPlayed, toggleFavourite, emptyModel, stationFromEntry, isFavourite } from '../../src/radio-store.js';
import { STATION_IDS } from '../support/canned-sim.mjs';
import { buildStationsIndex } from '../../scripts/stations-index.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const index = JSON.parse(readFileSync(resolve(root, 'content/stations/index.json'), 'utf8'));

test('the index is read from the pack JSON: every field is the pack\'s, nothing is named in code', () => {
  const entries = parseStationsIndex(index);
  assert.equal(entries.length, 6);
  assert.deepEqual(entries.map((e) => e.id).sort(), [...STATION_IDS].sort());
  for (const e of entries) {
    const doc = JSON.parse(readFileSync(resolve(root, 'content/stations', e.file), 'utf8')).station;
    assert.equal(e.name, doc.name); assert.equal(e.dial, doc.dial); assert.equal(e.tagline, doc.tagline); assert.equal(e.vibe, doc.vibe);
    assert.deepEqual(e.hosts.map((h) => h.id), doc.hosts.map((h) => h.id));
    assert.ok(e.minutes >= 30 && e.minutes <= 90, `${e.id} ${e.minutes} min`);
  }
  assert.deepEqual(buildStationsIndex().stations.map((s) => s.name), entries.map((e) => e.name));
  // a rename is a data-only change: no source file under src/ or the UI mentions any station name, dial brand or host by name
  const names = entries.map((e) => e.name).concat(['Pirate 1400', 'Sunbelt Soul', 'Kilo-Hertz', 'Tape Hiss', 'Static City', 'Meridian']);
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((x) => (x.isDirectory() ? walk(resolve(d, x.name)) : [resolve(d, x.name)]));
  for (const f of walk(resolve(root, 'src')).filter((p) => p.endsWith('.js') && !p.includes('/fonts/'))) {
    const t = readFileSync(f, 'utf8');
    for (const n of names) assert.ok(!t.includes(n), `${f} names a station: ${n}`);
  }
});

test('junk index never throws and yields nothing usable', () => {
  for (const j of [null, undefined, 5, '{', '{"v":2}', { v: 1 }, { v: 1, stations: [null, 3, { id: '../x', name: 'x' }, { id: 'a b', name: 'x' }, { id: 'ok', name: '' }] }]) {
    assert.doesNotThrow(() => parseStationsIndex(j));
    assert.deepEqual(parseStationsIndex(j), []);
  }
  assert.equal(parseStationsIndex({ v: 1, stations: [{ id: 'ok-1', name: 'Fine', hosts: 'no' }] })[0].hosts.length, 0);
});

test('dayparts: hour mapping, fits, badges', () => {
  assert.deepEqual([6, 12, 18, 23, 2].map(daypartOfHour), ['morning', 'day', 'evening', 'night', 'night']);
  assert.equal(daypartFits(['morning'], 7), true); assert.equal(daypartFits(['morning'], 22), false);
  assert.equal(daypartFits(['night', 'any'], 12), true); assert.equal(daypartFits([], 3), true);
  assert.equal(daypartBadge(['any']), 'Any time'); assert.equal(daypartBadge(['evening', 'night']), 'Evening / Night');
  assert.equal(daypartBadge(['night', 'any']), 'Night (any time)');
});

test('catalog: six canned cards with every field the picker shows; in-daypart stations first at any hour; all playable at any time', () => {
  for (const hour of [7, 13, 19, 23, 3]) {
    const cat = buildCatalog({ index, flagOn: false, hour });
    assert.equal(cat.canned.length, 6);
    assert.deepEqual(cat.styles, []);
    assert.equal(cat.youRadio, false);
    const fits = cat.canned.map((c) => c.fit);
    assert.deepEqual(fits, [...fits].sort((a, b) => b - a), `hour ${hour}: best daypart fit first`);
    for (const c of cat.canned) {
      assert.equal(c.startable, true); assert.equal(c.label, PRE_WRITTEN_LABEL);
      for (const k of ['name', 'dial', 'tagline', 'vibe', 'daypartBadge']) assert.ok(c[k], k);
      assert.ok(c.hostChips.length >= 2 && c.hostChips.every((h) => h.name)); assert.ok(c.minutes > 0);
      assert.equal(c.station.type, CANNED_TYPE); assert.equal(c.station.id, c.id); assert.equal(c.key, `canned|${c.id}`);
    }
  }
  const morning = buildCatalog({ index, hour: 8 }).canned.map((c) => c.id);
  assert.equal(morning[0], 'kilo-hertz-rock-102-7', 'the morning station leads in the morning');
});

test('catalog: the five AI style cards appear only with the flag, greyed, "Needs internet — coming soon", never startable', () => {
  const on = buildCatalog({ index, flagOn: true, hour: 22 });
  assert.equal(on.styles.length, 5); assert.equal(on.youRadio, true);
  for (const c of on.styles) {
    assert.equal(c.startable, false); assert.equal(c.status, NEEDS_INTERNET);
    assert.ok(c.name && c.mode && c.hostChips.length === 2 && c.talkShare > 0.1 && c.musicShare > 0.6);
    assert.equal(Math.round((c.talkShare + c.musicShare) * 100), 100);
  }
  assert.deepEqual(on.styles.map((c) => c.name), ['Daybreak', 'The Quiet Signal', 'KDC', 'Town Line', 'Signal Pirate']);
  assert.equal(on.styles.find((c) => c.id === 'morning-drive').inDaypart, false, 'Daybreak at 22:00 is out of its window');
  assert.equal(on.styles.find((c) => c.id === 'after-hours').inDaypart, true);
  assert.equal(buildCatalog({ index, flagOn: true, hour: 22, cloudAvailable: true }).styles.every((c) => c.startable), true, 'the extension point for the cloud phase');
});

test('AI style data matches the bibles and voice-direction tables (ten hosts, rate/pitch/mood, audition script)', () => {
  assert.equal(AI_STYLES.length, 5);
  const hosts = AI_STYLES.flatMap((s) => s.hosts);
  assert.equal(hosts.length, 10);
  const want = { nia: [1.08, 1.0, 'bright'], theo: [0.95, 0.9, 'warm'], ines: [0.9, 0.95, 'soft'], rafe: [0.88, 0.85, 'warm'], devika: [1.1, 1.05, 'bright'], marcus: [0.95, 0.92, 'amused'], hal: [0.95, 0.95, 'warm'], june: [1.05, 1.02, 'bright'], odile: [1.2, 1.05, 'dramatic'], benny: [1.0, 0.98, 'flat'] };
  for (const h of hosts) { const w = want[h.id]; assert.ok(w, h.id); assert.deepEqual([h.rate, h.pitch, h.mood], w, h.id); assert.ok(h.flatDevice && h.auditionFor && h.pauseHabit); }
  assert.equal(AI_STYLES.filter((s) => s.hosts.filter((h) => h.default).length === 1).length, 5);
  assert.deepEqual(Object.keys(MOOD_PROSODY).sort(), ['amused', 'bright', 'dramatic', 'flat', 'neutral', 'serious', 'soft', 'warm']);
  assert.equal(AUDITION_SCRIPT.length, 10);
  assert.equal(AUDITION_SCRIPT[9], 'Here’s one.');
  const p = hostProsody(styleById('signal-pirate').hosts[0]);
  assert.ok(p.rate >= 0.8 && p.rate <= 1.3 && p.pitch >= 0.8 && p.pitch <= 1.3, JSON.stringify(p));
  for (const h of hosts) { const q = hostProsody(h); assert.ok(q.rate >= 0.8 && q.rate <= 1.3 && q.pitch >= 0.8 && q.pitch <= 1.3); }
});

test('favourites / recents / resume work for canned stations through the existing type|id store', () => {
  const e = parseStationsIndex(index)[0];
  const c = cannedCard(e, 12);
  const st = c.station;
  assert.equal(stationKey(st), `canned|${e.id}`);
  let m = emptyModel();
  m = toggleFavourite(m, st, 1000);
  assert.equal(isFavourite(m, st), true);
  m = recordPlayed(m, st, 2000);
  assert.equal(m.last.k, `canned|${e.id}`); assert.equal(m.recents[0].k, `canned|${e.id}`);
  // survives a serialise / parse round trip (a restart) and still yields a playable station object
  const back = parseModel(serializeModel(m));
  assert.equal(back.favs.length, 1); assert.equal(back.last.type, 'canned');
  const again = stationFromEntry(back.last);
  assert.equal(again.type, 'canned'); assert.equal(again.id, e.id); assert.equal(again.name, e.name);
  assert.ok(again.tags.includes('canned'));
  assert.ok(Object.keys(snapshotOf(st)).every((k) => ['name', 'dial', 'tagline', 'country', 'tags', 'codec', 'bitrate'].includes(k)));
});
