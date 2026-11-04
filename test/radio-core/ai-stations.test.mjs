import test from 'node:test';
import assert from 'node:assert/strict';
import {
  registerStationType, registerAiStationTypes, getStationType, listStationTypes, createSessionFor, _resetStationTypes,
  aiYouStation, aiYouCityStation, AI_TYPE_YOU, AI_TYPE_YOU_CITY,
} from '../../src/stations.js';
import { isRadioAiEnabled, setRadioAiEnabled, RADIO_AI_STORAGE_KEY, RADIO_AI_FLAG } from '../../src/radio/flag.js';
import { emptyModel, toggleFavourite, recordPlayed, isFavourite, stationKey, stationFromEntry, parseModel, serializeModel } from '../../src/radio-store.js';

const store = (init = {}) => { const m = new Map(Object.entries(init)); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m }; };

test('flag: default off; only an explicit "1" turns it on; failures mean off', () => {
  assert.equal(RADIO_AI_FLAG, 'radio.ai');
  assert.equal(isRadioAiEnabled(store()), false);
  assert.equal(isRadioAiEnabled(null), false);
  assert.equal(isRadioAiEnabled(undefined), false);
  for (const v of ['0', 'true', 'yes', '', '2']) assert.equal(isRadioAiEnabled(store({ [RADIO_AI_STORAGE_KEY]: v })), false, v);
  assert.equal(isRadioAiEnabled(store({ [RADIO_AI_STORAGE_KEY]: '1' })), true);
  assert.equal(isRadioAiEnabled({ getItem() { throw new Error('blocked'); } }), false);
  const s = store();
  assert.equal(setRadioAiEnabled(s, true), true);
  assert.equal(isRadioAiEnabled(s), true);
  assert.equal(setRadioAiEnabled(s, false), true);
  assert.equal(isRadioAiEnabled(s), false);
  assert.equal(setRadioAiEnabled({ setItem() { throw new Error('x'); }, removeItem() { throw new Error('x'); } }, true), false);
});

test('registerAiStationTypes is inert when the flag is off and never calls loadCore', () => {
  _resetStationTypes();
  let loads = 0;
  const loadCore = () => { loads++; return Promise.resolve({}); };
  for (const isEnabled of [undefined, () => false, () => 0, () => 'yes', () => { throw new Error('x'); }]) {
    assert.equal(registerAiStationTypes({ isEnabled, loadCore }), false);
  }
  assert.equal(registerAiStationTypes(), false);
  assert.deepEqual(listStationTypes(), []);
  assert.equal(createSessionFor(aiYouStation(), {}), null);
  assert.equal(loads, 0);
  _resetStationTypes();
});

test('flag on: types register under the one-dial ids and sessions follow the Session contract', async () => {
  _resetStationTypes();
  registerStationType({ id: 'radio-browser', label: 'Radio stations', createSession: () => ({ start() {}, stop() {}, onChange() {} }) });
  let loads = 0;
  assert.equal(registerAiStationTypes({ isEnabled: () => true, loadCore: async () => { loads++; } }), true);
  assert.deepEqual(listStationTypes().map((t) => t.id), ['radio-browser', AI_TYPE_YOU, AI_TYPE_YOU_CITY]);
  assert.equal(getStationType(AI_TYPE_YOU).label, 'You Radio');
  const s = createSessionFor(aiYouStation(), {});
  assert.deepEqual(Object.keys(s).sort(), ['onChange', 'start', 'state', 'stop']);
  assert.equal(s.state.phase, 'idle');
  const seen = [];
  s.onChange((x) => seen.push(x.phase));
  await s.start();
  assert.equal(loads, 1);
  assert.deepEqual(seen, ['connecting', 'error']);
  // stop during connecting wins over the late error
  const t = createSessionFor(aiYouCityStation(), {});
  const seen2 = [];
  t.onChange((x) => seen2.push(x.phase));
  const p = t.start(); t.stop(); await p;
  assert.deepEqual(seen2, ['connecting', 'idle']);
  // a core that fails to load ends the same way
  _resetStationTypes();
  registerAiStationTypes({ isEnabled: () => true, loadCore: () => Promise.reject(new Error('404')) });
  const u = createSessionFor(aiYouStation(), {});
  await u.start();
  assert.equal(u.state.phase, 'error');
  _resetStationTypes();
});

test('one dial: AI stations share the favourites/recents keys with real stations, with no migration', () => {
  const you = aiYouStation(), city = aiYouCityStation('Seattle, WA');
  assert.equal(stationKey(you), 'ai-you|you');
  assert.equal(stationKey(city), 'ai-you-city|you-city:seattle-wa');
  assert.equal(aiYouCityStation().id, 'you-city:home');
  assert.equal(aiYouCityStation('!!!').id, 'you-city:home');
  let m = emptyModel();
  const real = { type: 'radio-browser', id: 'rb:abc', name: 'Jazz FM', streamUrl: 'https://x.example/s' };
  m = toggleFavourite(m, real, 1);
  m = toggleFavourite(m, you, 2);
  m = toggleFavourite(m, city, 3);
  assert.deepEqual(m.favs.map((e) => e.k), ['ai-you-city|you-city:seattle-wa', 'ai-you|you', 'radio-browser|rb:abc']);
  assert.ok(isFavourite(m, you) && isFavourite(m, city) && isFavourite(m, real));
  m = recordPlayed(m, you, 10);
  assert.equal(m.last.k, 'ai-you|you');
  // survives a save/load round trip and gives back a Station the registry could route
  const back = parseModel(serializeModel(m));
  assert.deepEqual(back.favs.map((e) => e.k), m.favs.map((e) => e.k));
  const st = stationFromEntry(back.favs.find((e) => e.k === 'ai-you|you'));
  assert.deepEqual([st.type, st.id, st.name], ['ai-you', 'you', 'You Radio']);
  assert.equal(st.streamUrl, undefined);
  // radio-session's real-stream type is untouched by any of this
  _resetStationTypes();
  assert.equal(createSessionFor(st, {}), null); // flag off / not registered: no player, no crash
});
