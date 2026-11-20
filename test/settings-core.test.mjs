import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SETTINGS_KEY, FIELDS, PATHS, LEGACY, defaults, validate, checkField, migrate, parseBlob, createSettingsStore } from '../src/settings/settings.js';

const mem = (init = {}) => { const m = new Map(Object.entries(init)); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m }; };

test('defaults: every field has one, and the defaults validate to themselves', () => {
  const d = defaults();
  assert.equal(d.v, 1); assert.deepEqual(validate(d), d);
  for (const p of PATHS) assert.notEqual(checkField(p, p.split('.').reduce((a, k) => a[k], d)), undefined, p);
  assert.equal(d.appearance.theme, 'oled'); assert.equal(d.appearance.accent, 'violet'); assert.equal(d.turntable.layout, 'compact');
  assert.equal(d.privacy.rememberSearches, true); assert.equal(d.radio.aiStations, false);
});
test('validate: junk, wrong types, unknown keys, prototype pollution', () => {
  const v = validate({ v: 1, appearance: { theme: 'neon', accent: 'nope', textSize: 'huge', reduceMotion: 3 }, turntable: { layout: 'x' }, haptics: 'yes', playback: { defaultRpm: 50 }, __proto__: { polluted: 1 }, extra: 1 });
  assert.deepEqual(v, defaults());
  for (const bad of [null, undefined, 4, 'x', [], () => 1]) assert.deepEqual(validate(bad), defaults());
  assert.equal(({}).polluted, undefined);
  const ok = validate({ appearance: { theme: 'light', accent: '#fe5031', textSize: 'large', reduceMotion: 'reduce' }, turntable: { layout: 'cinematic' }, haptics: false, playback: { defaultRpm: '45', audiophile: true }, radio: { aiStations: true }, privacy: { rememberSearches: false } });
  assert.equal(ok.appearance.theme, 'light'); assert.equal(ok.appearance.accent, 'orange'); assert.equal(ok.playback.defaultRpm, 45);
  assert.equal(ok.haptics, false); assert.equal(ok.turntable.layout, 'cinematic'); assert.equal(ok.privacy.rememberSearches, false);
});
test('checkField: accent accepts presets and #rrggbb only; rpm accepts 33, 33.3, 45, 78', () => {
  assert.equal(checkField('appearance.accent', 'teal'), 'teal');
  assert.equal(checkField('appearance.accent', '#123ABC'), '#123abc');
  assert.equal(checkField('appearance.accent', '#FE5031'), 'orange');
  for (const bad of ['#12345', '#12345g', 'red', 'rgb(1,2,3)', '', null, 5, '#1234567', 'javascript:1', 'url(x)', '#fff; background:red']) assert.equal(checkField('appearance.accent', bad), undefined, String(bad));
  for (const ok of [33.333, 33.3, 33, '33.333', 45, 78]) assert.ok(checkField('playback.defaultRpm', ok) !== undefined, String(ok));
  for (const bad of [50, 'x', null, NaN, undefined, {}, 33.9, 0]) assert.equal(checkField('playback.defaultRpm', bad), undefined, String(bad));
  assert.equal(checkField('nope.nope', 1), undefined);
});

test('migrate: old keys become settings (an old dark theme was the OLED black palette)', () => {
  const st = mem({ 'runout.theme': 'dark', 'runout.layout.v2': 'cinematic', 'runout.cassette.haptics': '0', 'runout.flag.radio.ai': '1' });
  const { settings, changed } = migrate(null, (k) => st.getItem(k));
  assert.equal(settings.appearance.theme, 'oled'); assert.equal(settings.turntable.layout, 'cinematic');
  assert.equal(settings.haptics, false); assert.equal(settings.radio.aiStations, true);
  assert.deepEqual(changed.sort(), ['haptics', 'radio.aiStations', 'turntable.layout'].sort());   // theme: oled is also the default, so nothing "changed"
  const light = migrate(null, (k) => ({ 'runout.theme': 'light' }[k] ?? null));
  assert.equal(light.settings.appearance.theme, 'light');
});
test('migrate: garbage in the old keys is ignored', () => {
  const { settings } = migrate(null, () => 'garbage'.repeat(50));
  assert.deepEqual(settings, { ...defaults(), radio: { aiStations: false } });
  assert.deepEqual(migrate({ v: 1 }, () => { throw new Error('x'); }).settings, defaults());
});
test('read-through: the new "Dark" tone survives while the old key says dark; the old key flipping to light wins', () => {
  const blob = { v: 1, appearance: { theme: 'dark' } };
  assert.equal(migrate(blob, (k) => ({ 'runout.theme': 'dark' }[k] ?? null)).settings.appearance.theme, 'dark');
  assert.equal(migrate(blob, (k) => ({ 'runout.theme': 'light' }[k] ?? null)).settings.appearance.theme, 'light');
  assert.equal(migrate({ v: 1, appearance: { theme: 'light' } }, (k) => ({ 'runout.theme': 'dark' }[k] ?? null)).settings.appearance.theme, 'oled');
});
test('radio.ai flag: the old key is authoritative (the radio panel toggles it directly)', () => {
  const blob = { v: 1, radio: { aiStations: true } };
  assert.equal(migrate(blob, () => null).settings.radio.aiStations, false);
  assert.equal(migrate({ v: 1, radio: { aiStations: false } }, (k) => ({ 'runout.flag.radio.ai': '1' }[k] ?? null)).settings.radio.aiStations, true);
});
test('parseBlob: wrong version, garbage, oversized -> null', () => {
  for (const b of ['', '{', '[]', '{"v":2}', '{"v":"1"}', 'x'.repeat(30000), null, 5]) assert.equal(parseBlob(b), null);
  assert.deepEqual(parseBlob('{"v":1,"haptics":false}'), { v: 1, haptics: false });
});

test('store: first run imports old keys, writes the blob and mirrors them back (so old readers keep working)', () => {
  const st = mem({ 'runout.theme': 'light', 'runout.layout.v2': 'utilitarian' });
  const s = createSettingsStore({ storage: st });
  assert.equal(s.get('appearance.theme'), 'light'); assert.equal(s.get('turntable.layout'), 'utilitarian');
  const blob = JSON.parse(st.m.get(SETTINGS_KEY)); assert.equal(blob.v, 1); assert.equal(blob.appearance.theme, 'light');
  assert.equal(st.m.get('runout.theme'), 'light'); assert.equal(st.m.get('runout.layout.v2'), 'utilitarian');
  assert.equal(st.m.get('runout.cassette.haptics'), '1');          // default haptics = on, mirrored for MixtapeUI
  assert.equal(st.m.has('runout.flag.radio.ai'), false);           // flag off = key absent, as the flag module expects
});
test('store.set: validates, persists, mirrors, notifies once, ignores no-ops and bad values', () => {
  const st = mem(); const s = createSettingsStore({ storage: st });
  const seen = []; const off = s.subscribe((all, path) => seen.push([path, all.appearance.theme]));
  assert.equal(s.set('appearance.theme', 'oled'), true); assert.deepEqual(seen, []);        // already oled
  assert.equal(s.set('appearance.theme', 'dark'), true); assert.deepEqual(seen, [['appearance.theme', 'dark']]);
  assert.equal(st.m.get('runout.theme'), 'dark'); assert.equal(JSON.parse(st.m.get(SETTINGS_KEY)).appearance.theme, 'dark');
  assert.equal(s.set('appearance.theme', 'light'), true); assert.equal(st.m.get('runout.theme'), 'light');
  assert.equal(s.set('appearance.theme', 'pink'), false); assert.equal(s.get('appearance.theme'), 'light');
  assert.equal(s.set('radio.aiStations', true), true); assert.equal(st.m.get('runout.flag.radio.ai'), '1');
  assert.equal(s.set('radio.aiStations', false), true); assert.equal(st.m.has('runout.flag.radio.ai'), false);
  assert.equal(s.set('haptics', 'maybe'), false); assert.equal(s.set('haptics', false), true); assert.equal(st.m.get('runout.cassette.haptics'), '0');
  assert.equal(s.set('no.such', 1), false);
  off(); s.set('appearance.theme', 'dark'); assert.equal(seen.length, 5);
});
test('store.refresh picks up a change made by old code (radio panel flips the flag)', () => {
  const st = mem(); const s = createSettingsStore({ storage: st });
  const seen = []; s.subscribe((_, p) => seen.push(p));
  st.setItem('runout.flag.radio.ai', '1');
  assert.deepEqual(s.refresh(), ['radio.aiStations']); assert.equal(s.get('radio.aiStations'), true); assert.deepEqual(seen, ['radio.aiStations']);
  assert.deepEqual(s.refresh(), []);
});
test('store.reset restores defaults (one path or all) and mirrors them', () => {
  const st = mem(); const s = createSettingsStore({ storage: st });
  s.set('turntable.layout', 'cinematic'); s.set('appearance.accent', 'teal'); s.set('appearance.theme', 'light');
  s.reset('turntable.layout'); assert.equal(s.get('turntable.layout'), 'compact'); assert.equal(st.m.get('runout.layout.v2'), 'compact');
  s.reset(); assert.deepEqual(s.get(), defaults() && { ...defaults(), radio: { aiStations: false } }); assert.equal(st.m.get('runout.theme'), 'dark');
});
test('store never throws: missing, throwing and full storage; throwing subscribers; get returns copies', () => {
  const boom = { getItem() { throw new Error('a'); }, setItem() { throw new Error('b'); }, removeItem() { throw new Error('c'); } };
  for (const st of [null, undefined, boom]) {
    const s = createSettingsStore({ storage: st });
    assert.equal(s.get('appearance.theme'), 'oled'); assert.equal(s.set('appearance.theme', 'light'), true); assert.equal(s.get('appearance.theme'), 'light');
    s.subscribe(() => { throw new Error('sub'); }); assert.equal(s.set('haptics', false), true); s.reset(); s.refresh();
  }
  const s = createSettingsStore({ storage: mem() }); const a = s.get(); a.haptics = 'x'; assert.equal(s.get('haptics'), true);
  assert.equal(s.subscribe(5)(), undefined);
});
test('a corrupt or foreign-version blob falls back to defaults + old keys, then heals', () => {
  const st = mem({ [SETTINGS_KEY]: '{"v":9,"appearance":{"theme":"light"}}', 'runout.layout.v2': 'cinematic' });
  const s = createSettingsStore({ storage: st });
  assert.equal(s.get('appearance.theme'), 'oled'); assert.equal(s.get('turntable.layout'), 'cinematic');
  assert.equal(JSON.parse(st.m.get(SETTINGS_KEY)).v, 1);
});
test('every field has a legacy-free or declared legacy mapping, and the table is consistent', () => {
  for (const l of LEGACY) { assert.ok(FIELDS[l.path], l.path); assert.match(l.key, /^runout\./); }
  assert.equal(new Set(LEGACY.map((l) => l.key)).size, LEGACY.length);
});
