import test from 'node:test';
import assert from 'node:assert/strict';
import { createKeepAwake } from '../src/devicemode/keepawake.js';
import { getDisplayPlugin, createDisplayControl } from '../src/devicemode/native.js';

function fakeWeb({ deny = false, vis = 'visible' } = {}) {
  const listeners = {}; const doc = { visibilityState: vis, addEventListener: (t, f) => { (listeners[t] ||= []).push(f); } };
  const log = { requests: 0, releases: 0 }; const sentinels = [];
  const nav = { wakeLock: { request: async () => {
    if (deny) { const e = new Error('no'); e.name = 'NotAllowedError'; throw e; }
    log.requests++; const ls = {}; const s = { addEventListener: (t, f) => { ls[t] = f; }, release: async () => { log.releases++; ls.release && ls.release(); }, fire: () => ls.release && ls.release() };
    sentinels.push(s); return s; } } };
  return { doc, nav, log, sentinels, setVis(v) { doc.visibilityState = v; (listeners.visibilitychange || []).forEach((f) => f()); } };
}
const settle = () => new Promise((r) => setTimeout(r, 5));

test('wake lock: acquire on set(true), release on set(false)', async () => {
  const w = fakeWeb(); const k = createKeepAwake({ nav: w.nav, doc: w.doc });
  let st = await k.set(true); assert.equal(st.mode, 'wakelock'); assert.equal(st.held, true); assert.equal(w.log.requests, 1);
  await k.set(true); assert.equal(w.log.requests, 1);                       // no double acquire
  st = await k.set(false); assert.equal(st.held, false); assert.equal(w.log.releases, 1);
});
test('wake lock: re-acquired after a visibility cycle and after the system releases it', async () => {
  const w = fakeWeb(); const k = createKeepAwake({ nav: w.nav, doc: w.doc }); await k.set(true);
  w.sentinels[0].fire();                                                      // the OS released it (page hidden): sentinel gone
  assert.equal(k.status.held, false);
  w.setVis('hidden'); await settle(); assert.equal(w.log.requests, 1);        // hidden: do not ask
  w.setVis('visible'); await settle(); assert.equal(w.log.requests, 2); assert.equal(k.status.held, true);
});
test('wake lock: not re-acquired after unlock; denial is reported not thrown; unsupported -> none', async () => {
  const w = fakeWeb(); const k = createKeepAwake({ nav: w.nav, doc: w.doc }); await k.set(true); await k.set(false);
  w.setVis('hidden'); w.setVis('visible'); await settle(); assert.equal(w.log.requests, 1);
  const d = fakeWeb({ deny: true }); const k2 = createKeepAwake({ nav: d.nav, doc: d.doc });
  const st = await k2.set(true); assert.equal(st.held, false); assert.equal(st.error, 'NotAllowedError');
  const k3 = createKeepAwake({ nav: {}, doc: { visibilityState: 'visible', addEventListener() {} } }); const s3 = await k3.set(true);
  assert.equal(s3.mode, 'none'); assert.equal(s3.held, false);
});
test('unlock while the request is still in flight does not leak a lock', async () => {
  const w = fakeWeb(); const k = createKeepAwake({ nav: w.nav, doc: w.doc }); const a = k.set(true); const b = k.set(false); await Promise.all([a, b]);
  assert.equal(k.status.held, false); assert.equal(w.log.requests - w.log.releases, 0);
});
test('native plugin is preferred when available; falls back to the wake lock if it fails', async () => {
  const calls = []; const native = { keepAwake: async (a) => { calls.push(a.on); } };
  const w = fakeWeb(); const k = createKeepAwake({ native, nav: w.nav, doc: w.doc });
  let st = await k.set(true); assert.equal(st.mode, 'native'); assert.equal(st.held, true); assert.deepEqual(calls, [true]); assert.equal(w.log.requests, 0);
  st = await k.set(false); assert.equal(st.held, false); assert.deepEqual(calls, [true, false]);
  const bad = createKeepAwake({ native: { keepAwake: async () => { throw new Error('boom'); } }, nav: w.nav, doc: w.doc });
  st = await bad.set(true); assert.equal(st.mode, 'wakelock'); assert.equal(st.held, true);
});
test('no environment at all: never throws', async () => {
  const k = createKeepAwake({ nav: null, doc: null }); const st = await k.set(true); assert.equal(st.held, false);
});
test('display plugin discovery and control degrade to no-ops', async () => {
  assert.equal(getDisplayPlugin({}), null); assert.equal(getDisplayPlugin({ Capacitor: { isNativePlatform: () => false } }), null);
  assert.equal(getDisplayPlugin({ Capacitor: { isNativePlatform: () => true, isPluginAvailable: () => false } }), null);
  const p = {}; assert.equal(getDisplayPlugin({ Capacitor: { isNativePlatform: () => true, isPluginAvailable: () => true, registerPlugin: () => p } }), p);
  const none = createDisplayControl(null); assert.equal(none.available, false); assert.equal(await none.setBrightness(0.1), false); assert.equal(await none.info(), null);
  const seen = []; const d = createDisplayControl({ setBrightness: async (a) => seen.push(a), setPreferredRefreshRate: async () => { throw new Error('x'); } });
  assert.equal(await d.setBrightness(0.08), true); assert.equal(await d.setBrightness(null), true); assert.equal(await d.setBrightness(5), true);
  assert.deepEqual(seen, [{ fraction: 0.08 }, { fraction: null }, { fraction: 1 }]); assert.equal(await d.setRefreshRate(1), false);
});
