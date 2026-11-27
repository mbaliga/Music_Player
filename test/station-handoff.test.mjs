// Regressions for the station / tape / album hand-offs (adversarial review at 9d78a0f). Behaviour in a browser: scripts/verify-station-handoff.py.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerCannedStationType, createSessionFor, CANNED_TYPE, _resetStationTypes } from '../src/stations.js';

const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const radioUi = readFileSync(new URL('../src/radio-player.js', import.meta.url), 'utf8');

function fakeInner() {
  const calls = [];
  let cb = () => {};
  return { calls, onChange: (f) => { cb = f; }, async start() { calls.push('start'); cb({ phase: 'playing' }); }, stop() { calls.push('stop'); }, abandon() { calls.push('abandon'); }, skip() {}, signOff() {} };
}

test('the canned proxy session has abandon(): the user\'s own tape / record must not be halted by the show', async () => {
  _resetStationTypes();
  const inner = fakeInner();
  registerCannedStationType({ loadCanned: async () => ({ createCannedSession: () => inner, mountCannedPanel: () => () => {} }) });
  const s = createSessionFor({ type: CANNED_TYPE, id: 'x', name: 'X' }, { aiHost: {} });
  assert.equal(typeof s.abandon, 'function');
  await s.start();
  assert.equal(s.state.phase, 'playing');
  s.abandon();
  assert.deepEqual(inner.calls, ['start', 'abandon'], 'abandon, never stop (stop would halt the deck the tape now owns)');
  assert.equal(s.state.phase, 'idle');
});

test('abandon() while the show module is still loading cancels the start', async () => {
  _resetStationTypes();
  const inner = fakeInner();
  let release; const gate = new Promise((r) => { release = r; });
  registerCannedStationType({ loadCanned: async () => { await gate; return { createCannedSession: () => inner }; } });
  const s = createSessionFor({ type: CANNED_TYPE, id: 'x', name: 'X' }, { aiHost: {} });
  const started = s.start();
  s.abandon();
  release(); await started;
  assert.deepEqual(inner.calls, [], 'a start superseded before the module arrived never touches the engine');
  assert.equal(s.state.phase, 'idle');
});

test('host.halt() only parks the deck while a station still holds it', () => {
  const h = main.slice(main.indexOf('async halt()'), main.indexOf('async halt()') + 500);
  assert.match(h, /if \(!state\.stationLeftover\) return;/);
  assert.match(main, /state\.stationLeftover = !!fromRadio;/);
});

test('a stopped station\'s parked song is not a user record: Play adopts the focused album', () => {
  assert.match(main, /const platterIsDemo = \(\) => \(state\.albumId === TEST_PRESSING_ID \|\| !!state\.stationLeftover\) && libHasAlbums\(\)/);
});

test('a station tap is the intent; the show\'s own first load must not supersede a tape opened after the tap', () => {
  assert.match(radioUi, /this\.d\.onPlay\?\.\(station\)/);
  assert.match(main, /onPlay: \(\) => \{ newIntent\(\); \}/);
  const load = main.slice(main.indexOf('async load(libTrack)'), main.indexOf('async decodeNext'));
  assert.ok(!/newIntent\(\)/.test(load), 'host.load no longer bumps the intent');
});

test('a streamed station that takes the engine from a tape parks the tape\'s track (no ghost audio on Stop)', () => {
  const f = main.slice(main.indexOf('function parkTapeUnderStation()'), main.indexOf('function boothShown()'));
  assert.match(f, /releaseEngine\(\)/);
  assert.match(f, /setRate\(0\)/);
  assert.match(f, /seek\(Math\.max\(0, state\.frames - 2\)\)/);
  assert.match(main, /if \(on\) \{ newIntent\(\); parkTapeUnderStation\(\); \}/);
});
