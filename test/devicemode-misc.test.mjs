import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, SPEC, validate, coerce, createSettings, load, save, KEY } from '../src/devicemode/settings.js';
import { pixelShift, minuteOf, SHIFT_POSITIONS } from '../src/devicemode/pixelshift.js';
import { createFrameGate, frameDue, frameWait } from '../src/devicemode/framegate.js';

const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m }; };

test('settings defaults match the owner brief', () => {
  assert.equal(DEFAULTS.persistLock, false); assert.equal(DEFAULTS.unlockMethod, 'hold'); assert.equal(DEFAULTS.keepAwakeMin, 30);
  assert.equal(DEFAULTS.neverTimeoutPlaying, true); assert.equal(DEFAULTS.aodIdleSec, 60); assert.equal(DEFAULTS.aodWake, 'double');
  assert.equal(DEFAULTS.aodBrightnessPct, 8); assert.equal(DEFAULTS.aodLowRefresh, true); assert.equal(DEFAULTS.fxPadWhileLocked, false);
  assert.equal(DEFAULTS.aodEnabled, true); assert.equal(DEFAULTS.pixelShift, true);
});
test('validators clamp, reject and drop unknown keys', () => {
  const v = validate({ keepAwakeMin: 7, aodBrightnessPct: 99, aodIdleSec: '30', unlockMethod: 'nope', pixelShift: 'yes', glowPct: -4, junk: 1 });
  assert.equal(v.keepAwakeMin, 30); assert.equal(v.aodBrightnessPct, 40); assert.equal(v.aodIdleSec, 60); assert.equal(v.unlockMethod, 'hold');
  assert.equal(v.pixelShift, true); assert.equal(v.glowPct, 10); assert.ok(!('junk' in v));
  assert.deepEqual(validate(null), DEFAULTS); assert.deepEqual(validate('x'), DEFAULTS);
  assert.equal(coerce('aodBrightnessPct', 'abc'), 8); assert.equal(coerce('nonexistent', 1), undefined);
  for (const k of Object.keys(SPEC)) assert.equal(coerce(k, DEFAULTS[k]), DEFAULTS[k]);
});
test('settings store: persist, reload, subscribe, corrupt storage', () => {
  const st = mem(); const s = createSettings(st); const seen = [];
  const off = s.subscribe((x) => seen.push(x.keepAwakeMin)); s.set({ keepAwakeMin: 60 }); off(); s.set({ keepAwakeMin: 5 });
  assert.deepEqual(seen, [60]); assert.equal(load(st).keepAwakeMin, 5); assert.ok(JSON.parse(st.m.get(KEY)).v === 1);
  st.setItem(KEY, '{nope'); assert.deepEqual(load(st), DEFAULTS); assert.equal(save(null, DEFAULTS), false);
  s.reset(); assert.deepEqual(s.get(), DEFAULTS);
});

test('pixel shift: bounded, deterministic, never the same twice in a row, covers the grid', () => {
  const seen = new Set(); let prev = null;
  for (let m = -50; m < 5000; m++) {
    const a = pixelShift(m), b = pixelShift(m);
    assert.deepEqual(a, b); assert.ok(Math.abs(a.x) <= 3 && Math.abs(a.y) <= 3);
    if (prev) assert.ok(a.x !== prev.x || a.y !== prev.y, 'repeat at ' + m);
    prev = a; seen.add(a.x + ',' + a.y);
  }
  assert.ok(seen.size >= SHIFT_POSITIONS - 2);
  assert.deepEqual(pixelShift(NaN), pixelShift(0)); assert.deepEqual(pixelShift(7, 0), { x: 0, y: 0 });
  assert.equal(minuteOf(120000), 2);
});

test('frameGate math: 1 fps cap in AOD, none in normal', () => {
  assert.equal(frameDue('normal', 0, 1), true); assert.equal(frameDue('aod', 0, 999), false); assert.equal(frameDue('aod', 0, 1000), true);
  assert.equal(frameWait('aod', 0, 250), 750); assert.equal(frameWait('normal', 0, 1), 0); assert.equal(frameWait('aod', NaN, 5), 0);
});

function fakeWin() {
  const timers = []; let t = 0; const rafq = [];
  const win = { performance: { now: () => t }, requestAnimationFrame: (cb) => { rafq.push(cb); return rafq.length; }, cancelAnimationFrame: () => {} };
  const env = { win, now: () => t, setTimeout: (f, ms) => { timers.push({ f, at: t + ms }); return timers.length; }, clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].f = null; } };
  return { win, env, rafq, advance(ms) { const end = t + ms; for (;;) { const nxt = timers.filter((x) => x.f && x.at <= end).sort((a, b) => a.at - b.at)[0]; if (!nxt) break; t = nxt.at; const f = nxt.f; nxt.f = null; f(); } t = end; },
    runRaf() { const q = rafq.splice(0); for (const f of q) f(t); } };
}
test('frameGate in AOD: a rAF loop runs at most once a second; restoring hands parked loops back to the real rAF', () => {
  const w = fakeWin(); const g = createFrameGate(w.env); const realRaf = w.win.requestAnimationFrame;
  let n = 0; const loop = () => { n++; w.win.requestAnimationFrame(loop); };
  g.setMode('aod'); assert.notEqual(w.win.requestAnimationFrame, realRaf);
  w.win.requestAnimationFrame(loop); w.advance(10_000); assert.equal(n, 10);
  g.setMode('normal'); assert.equal(w.win.requestAnimationFrame, realRaf);
  assert.equal(w.rafq.length, 1);        // the parked loop is back on the display clock
  w.runRaf(); assert.equal(n, 11);
});
test('frameGate: cancel works and a throwing callback does not stop the others', () => {
  const w = fakeWin(); const g = createFrameGate(w.env); g.setMode('aod'); let a = 0, b = 0;
  const id = g.request(() => a++); g.cancel(id); g.request(() => { throw new Error('x'); }); g.request(() => b++);
  w.advance(1000); assert.equal(a, 0); assert.equal(b, 1);
});
