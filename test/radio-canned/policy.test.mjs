import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseShowSource, CLOUD_AVAILABLE, SOURCES } from '../../src/radio/canned/policy.js';
import { createFallbackController } from '../../src/radio/canned/fallback.js';
import { createFakeNet, createNetAdapter } from '../../src/radio/canned/net.js';

const U = { canned: { type: 'canned', id: 'x' }, you: { type: 'ai-you', id: 'you' }, style: { type: 'ai-style', id: 'morning-drive' }, city: { type: 'ai-you-city', id: 'you-city:home' }, real: { type: 'radio-browser', id: 'rb:1' } };

test('the cloud is not available yet, and the constant says so', () => {
  assert.equal(CLOUD_AVAILABLE, false);
  assert.deepEqual([...SOURCES], ['cloud', 'offline-host', 'canned']);
});

test('policy table: cloud is NEVER chosen while cloudAvailable is false, whatever else is true', () => {
  const bools = [true, false];
  let n = 0;
  for (const online of bools) for (const flagOn of bools) for (const k of Object.keys(U)) for (const lastSource of [null, 'canned', 'offline-host']) {
    const r = chooseShowSource({ online, cloudAvailable: false, flagOn, userStation: U[k], lastSource });
    assert.notEqual(r.source, 'cloud', `${online}/${flagOn}/${k}/${lastSource}`);
    assert.equal(typeof r.reason, 'string'); assert.ok(r.reason.length > 3);
    n++;
  }
  for (const u of [null, 'auto', undefined, 'what', 5, {}]) assert.notEqual(chooseShowSource({ cloudAvailable: false, flagOn: true, userStation: u }).source, 'cloud');
  assert.equal(n, 2 * 2 * 5 * 3);
  assert.doesNotThrow(() => chooseShowSource(null));
  assert.doesNotThrow(() => chooseShowSource({ userStation: Symbol('x') }));
});

test('policy table rows', () => {
  const P = (o) => chooseShowSource({ online: true, cloudAvailable: false, flagOn: false, lastSource: null, ...o });
  // canned: always canned
  for (const online of [true, false]) for (const flagOn of [true, false]) assert.equal(P({ online, flagOn, userStation: U.canned }).source, 'canned');
  // You Radio: 'Auto' = the offline host now
  assert.equal(P({ flagOn: true, userStation: U.you }).source, 'offline-host');
  assert.equal(P({ flagOn: true, online: false, userStation: U.you }).source, 'offline-host');
  assert.match(P({ flagOn: true, userStation: U.you }).reason, /not available yet|this phone/);
  assert.equal(P({ flagOn: false, userStation: U.you }).source, 'canned');
  // cloud-only styles degrade to canned (flagged)
  assert.equal(P({ flagOn: true, userStation: U.style }).source, 'canned');
  assert.equal(P({ flagOn: true, userStation: U.style }).degraded, true);
  assert.match(P({ flagOn: true, userStation: U.city }).reason, /needs internet/);
  // auto
  assert.equal(P({ flagOn: true, userStation: null }).source, 'offline-host');
  assert.equal(P({ flagOn: false, userStation: null }).source, 'canned');
  assert.equal(P({ flagOn: false, online: false, userStation: 'auto' }).source, 'canned');
  // real streams: not a show online; the app still has radio offline
  assert.equal(P({ userStation: U.real }).source, null);
  assert.equal(P({ userStation: U.real, online: false }).source, 'canned');
  assert.match(P({ userStation: U.real, online: false }).reason, /offline/);
});

test('the future cloud rows (extension point): cloud when available and online and the flag is on; sticky and degrading otherwise', () => {
  const C = (o) => chooseShowSource({ online: true, cloudAvailable: true, flagOn: true, lastSource: null, ...o });
  assert.equal(C({ userStation: U.style }).source, 'cloud');
  assert.equal(C({ userStation: U.you }).source, 'cloud');
  assert.equal(C({ userStation: null }).source, 'cloud');
  assert.equal(C({ userStation: U.canned }).source, 'canned');
  assert.notEqual(C({ userStation: U.style, flagOn: false }).source, 'cloud');
  assert.notEqual(C({ userStation: U.style, online: false }).source, 'cloud');
  // going offline mid-show degrades to canned
  const d = C({ userStation: U.style, online: false, lastSource: 'cloud' });
  assert.equal(d.source, 'canned'); assert.equal(d.degraded, true); assert.match(d.reason, /offline/);
  assert.equal(C({ userStation: U.you, online: false, lastSource: 'cloud' }).source, 'canned');
  // a fallback show is not swapped back to the cloud mid-show
  const s = C({ userStation: U.style, lastSource: 'canned' });
  assert.equal(s.source, 'canned'); assert.equal(s.sticky, true);
  assert.equal(C({ userStation: U.you, lastSource: 'offline-host' }).source, 'offline-host');
});

// ── the switch hook, with a fake cloud session that fails ────────────────────
const fakeSession = (name, log, { failOnStart = false } = {}) => {
  let cb = () => {}, state = { phase: 'idle', error: null };
  const s = { name, onChange(f) { cb = f; }, get state() { return state; },
    async start() { log.push(`${name}:start`); state = { phase: 'connecting' }; cb(state); if (failOnStart) { state = { phase: 'error', error: { kind: 'unavailable' } }; cb(state); } else { state = { phase: 'playing' }; cb(state); } },
    stop() { log.push(`${name}:stop`); state = { phase: 'idle' }; },
    fail() { state = { phase: 'error', error: { kind: 'dropped' } }; cb(state); } };
  return s;
};

test('fallback hook: today a style station starts the canned session and the cloud factory is never called', async () => {
  const log = []; let cloudCalls = 0;
  const fc = createFallbackController({ station: U.style, flagOn: true, net: createFakeNet(true), factories: { cloud: () => { cloudCalls++; return fakeSession('cloud', log); }, canned: () => fakeSession('canned', log), 'offline-host': () => fakeSession('host', log) } });
  await fc.start();
  assert.equal(fc.source, 'canned'); assert.equal(cloudCalls, 0);
  assert.deepEqual(log, ['canned:start']);
  fc.stop();
  const y = createFallbackController({ station: U.you, flagOn: true, net: createFakeNet(true), factories: { canned: () => fakeSession('canned', log), 'offline-host': () => fakeSession('host', log) } });
  await y.start();
  assert.equal(y.source, 'offline-host');
});

test('fallback hook (P2 plugs in): a cloud session that goes offline mid-show hands over to canned; a cloud session that errors does too', async () => {
  for (const how of ['offline', 'error']) {
    const log = [], switches = [];
    const net = createFakeNet(true);
    let cloud;
    const fc = createFallbackController({ station: U.style, flagOn: true, cloudAvailable: true, net, factories: { cloud: () => (cloud = fakeSession('cloud', log)), canned: () => fakeSession('canned', log) } });
    fc.onSwitch((s) => switches.push(s));
    await fc.start();
    assert.equal(fc.source, 'cloud');
    assert.deepEqual(log, ['cloud:start']);
    if (how === 'offline') net.set(false); else cloud.fail();
    await new Promise((r) => setImmediate(r));
    assert.equal(fc.source, 'canned', how);
    assert.deepEqual(log, ['cloud:start', 'cloud:stop', 'canned:start'], how);
    assert.equal(switches.length, 1);
    assert.equal(switches[0].from, 'cloud'); assert.equal(switches[0].to, 'canned');
    assert.equal(switches[0].ladder.rung, how === 'offline' ? 5 : 1);
    if (how === 'offline') assert.equal(switches[0].ladder.badge, 'offline_music_only');
    // coming back online does NOT flip the running canned show back
    net.set(true); await new Promise((r) => setImmediate(r));
    assert.equal(fc.source, 'canned');
    fc.stop();
    assert.equal(log.at(-1), 'canned:stop');
  }
});

test('fallback hook: stop() ends the cloud session and later network events do nothing', async () => {
  const log = []; const net = createFakeNet(true);
  const fc = createFallbackController({ station: U.style, flagOn: true, cloudAvailable: true, net, factories: { cloud: () => fakeSession('cloud', log), canned: () => fakeSession('canned', log) } });
  await fc.start(); fc.stop(); net.set(false); await new Promise((r) => setImmediate(r));
  assert.deepEqual(log, ['cloud:start', 'cloud:stop']);
});

test('net adapter: navigator.onLine and online/offline events through injected objects; no browser needed', () => {
  const listeners = {};
  const win = { addEventListener: (n, f) => { (listeners[n] ||= new Set()).add(f); }, removeEventListener: (n, f) => listeners[n]?.delete(f) };
  const nav = { onLine: true };
  const net = createNetAdapter({ win, nav });
  assert.equal(net.isOnline(), true);
  const seen = []; const un = net.onChange((v) => seen.push(v));
  nav.onLine = false; assert.equal(net.isOnline(), false);
  for (const f of listeners.offline) f(); for (const f of listeners.online) f();
  assert.deepEqual(seen, [false, true]);
  un(); assert.equal(listeners.online.size, 0);
  assert.equal(createNetAdapter({ win: null, nav: null }).isOnline(), true);
  assert.equal(typeof createNetAdapter({ win: null, nav: null }).onChange(() => {}), 'function');
});
