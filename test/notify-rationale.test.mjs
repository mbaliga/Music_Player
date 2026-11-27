import test from 'node:test';
import assert from 'node:assert/strict';
import { createRationale, RATIONALE_KEY, RATIONALE_TEXT } from '../src/notify-rationale.js';

const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v), m }; };

test('the text is the one-line question', () => { assert.equal(RATIONALE_TEXT, 'Show playback controls on your lock screen and in notifications?'); });

test('Allow -> true and remembered; asked only once ever', async () => {
  const st = mem(); let shown = 0;
  const ask = createRationale({ storage: st, show: async () => { shown++; return 'allow'; } });
  assert.equal(await ask(), true); assert.equal(st.m.get(RATIONALE_KEY), 'allow');
  assert.equal(await ask(), false); assert.equal(shown, 1);
});

test('Not now / dismissed -> false, remembered, never shown again', async () => {
  for (const answer of ['later', undefined, 'whatever']) {
    const st = mem(); let shown = 0;
    const ask = createRationale({ storage: st, show: async () => { shown++; return answer; } });
    assert.equal(await ask(), false); assert.equal(await ask(), false); assert.equal(shown, 1);
  }
});

test('concurrent asks share one card; a throwing UI counts as Not now; no storage still works', async () => {
  let shown = 0; let release; const gate = new Promise((r) => { release = r; });
  const ask = createRationale({ storage: null, show: async () => { shown++; await gate; return 'allow'; } });
  const a = ask(), b = ask(); release();
  assert.deepEqual(await Promise.all([a, b]), [true, true]); assert.equal(shown, 1);
  const bad = createRationale({ storage: mem(), show: async () => { throw new Error('x'); } });
  assert.equal(await bad(), false);
});
