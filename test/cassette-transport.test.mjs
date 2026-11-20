// cassette-transport.test.mjs — every transition of the cassette player's pure state machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTransport, reduce, runMode, deckMessage } from '../src/cassette/transport.js';

const run = (st, ...evs) => { let acts = []; for (const e of evs) { const r = reduce(st, e); st = r.state; acts = acts.concat(r.actions); } return { st, acts }; };
const types = (acts) => acts.map((a) => a.type);
const mk = (o = {}) => createTransport({ nA: 3, nB: 2, ...o });

test('defaults: side A, AUTO on, stopped, each side at its own start', () => {
  const t = mk();
  assert.equal(t.side, 'A'); assert.equal(t.auto, true); assert.equal(t.phase, 'stopped');
  assert.deepEqual(t.pos, { A: { index: 0, frac: 0 }, B: { index: 0, frac: 0 } });
  assert.equal(createTransport({ auto: false }).auto, false);
});

test('play starts the side at its own position; pause/resume; toggle', () => {
  let { st, acts } = run(mk(), { type: 'play' });
  assert.equal(st.phase, 'playing'); assert.deepEqual(acts, [{ type: 'start', side: 'A', index: 0, frac: 0 }]);
  ({ st, acts } = run(st, { type: 'pause' })); assert.equal(st.phase, 'paused'); assert.deepEqual(types(acts), ['pause']);
  ({ st, acts } = run(st, { type: 'toggle' })); assert.equal(st.phase, 'playing'); assert.deepEqual(types(acts), ['resume']);
  ({ st, acts } = run(st, { type: 'toggle' })); assert.equal(st.phase, 'paused');
  assert.deepEqual(run(st, { type: 'play' }).acts, [{ type: 'resume' }]);
  assert.deepEqual(run(run(mk(), { type: 'play' }).st, { type: 'play' }).acts, []);       // already playing
  assert.deepEqual(run(run(mk(), { type: 'pause' }).st).acts, []);                        // pause while stopped: nothing
});

test('progress is remembered per side and resumed from there', () => {
  let { st } = run(mk(), { type: 'play' }, { type: 'progress', index: 2, frac: 0.5 }, { type: 'pause' }, { type: 'stop' });
  // stop while paused -> wind to the top
  assert.deepEqual(st.pos.A, { index: 0, frac: 0 }); assert.equal(st.phase, 'stopped');
  ({ st } = run(mk(), { type: 'play' }, { type: 'progress', index: 1, frac: 0.25 }));
  assert.deepEqual(st.pos.A, { index: 1, frac: 0.25 });
  const r = run(st, { type: 'stop' });                 // first stop = brake
  assert.equal(r.st.phase, 'paused'); assert.deepEqual(r.st.pos.A, { index: 1, frac: 0.25 });
  assert.deepEqual(run(r.st, { type: 'play' }).acts, [{ type: 'resume' }]);
  const stopped = run(mk(), { type: 'play' }, { type: 'progress', index: 1, frac: 0.25 }, { type: 'flip' }).st;   // flip stops
  assert.equal(stopped.side, 'B'); assert.deepEqual(stopped.pos.A, { index: 1, frac: 0.25 }); assert.deepEqual(stopped.pos.B, { index: 0, frac: 0 });
  const back = run(stopped, { type: 'flip' });
  assert.equal(back.st.side, 'A');
  assert.deepEqual(run(back.st, { type: 'play' }).acts, [{ type: 'start', side: 'A', index: 1, frac: 0.25 }]);   // each side keeps its own tape position
});

test('AUTO on: the run crosses A -> B by itself: side flips, flip animation (auto), play continues', () => {
  let { st, acts } = run(mk(), { type: 'play' }, { type: 'progress', index: 2, frac: 0.99 });
  assert.equal(runMode(st), 'both');
  ({ st, acts } = run(st, { type: 'changed', side: 'B', index: 0 }));
  assert.equal(st.side, 'B'); assert.equal(st.phase, 'playing');
  assert.deepEqual(acts[0], { type: 'flipAnim', to: 'B', reason: 'auto' });
  assert.equal(runMode(st), 'B');
  assert.deepEqual(st.pos.B, { index: 0, frac: 0 });
  // within the side nothing flips
  assert.deepEqual(run(st, { type: 'changed', side: 'B', index: 1 }).acts, []);
  // end of side B always stops and offers rewind
  const end = run(st, { type: 'sideEnd' });
  assert.equal(end.st.phase, 'end'); assert.deepEqual(types(end.acts), ['stopPlayback', 'notice']); assert.equal(deckMessage(end.st), 'END');
  assert.deepEqual(run(end.st, { type: 'play' }).acts, [{ type: 'notice', text: 'REWIND' }]);
  const rw = run(end.st, { type: 'rewind' });
  assert.equal(rw.st.phase, 'stopped'); assert.deepEqual(rw.st.pos.B, { index: 0, frac: 0 });
  assert.equal(run(rw.st, { type: 'play' }).st.phase, 'playing');
});

test('AUTO on, the queue fell short (sideEnd on A): the machine itself starts B', () => {
  const r = run(mk(), { type: 'play' }, { type: 'sideEnd' });
  assert.equal(r.st.side, 'B'); assert.equal(r.st.phase, 'playing');
  assert.deepEqual(r.acts.slice(1, 3), [{ type: 'flipAnim', to: 'B', reason: 'auto' }, { type: 'start', side: 'B', index: 0, frac: 0 }]);
});

test('AUTO off: end of side A stops with "Flip tape"; Play is refused until FLIP; then Play starts B from its beginning', () => {
  let { st, acts } = run(mk({ auto: false }), { type: 'play' });
  assert.equal(runMode(st), 'A');                      // the run covers side A only
  ({ st, acts } = run(st, { type: 'sideEnd' }));
  assert.equal(st.phase, 'flip'); assert.equal(st.side, 'A'); assert.equal(deckMessage(st), 'FLIP TAPE');
  assert.deepEqual(types(acts), ['stopPlayback', 'notice']);
  assert.deepEqual(run(st, { type: 'play' }).acts, [{ type: 'notice', text: 'FLIP TAPE' }]);
  assert.equal(run(st, { type: 'play' }).st.phase, 'flip');
  ({ st, acts } = run(st, { type: 'flip' }));
  assert.equal(st.side, 'B'); assert.equal(st.phase, 'stopped');
  assert.deepEqual(acts.filter((a) => a.type === 'flipAnim'), [{ type: 'flipAnim', to: 'B', reason: 'manual' }]);
  ({ st, acts } = run(st, { type: 'play' }));
  assert.deepEqual(acts, [{ type: 'start', side: 'B', index: 0, frac: 0 }]); assert.equal(st.phase, 'playing');
  ({ st } = run(st, { type: 'sideEnd' }));
  assert.equal(st.phase, 'end');
});

test('empty side B: end of A with AUTO on does not flip into nothing; play on an empty side is refused', () => {
  const t = createTransport({ nA: 2, nB: 0 });
  assert.equal(runMode(t), 'A');
  const r = run(t, { type: 'play' }, { type: 'sideEnd' });
  assert.equal(r.st.phase, 'end');
  const f = run(createTransport({ nA: 2, nB: 0 }), { type: 'flip' });
  assert.deepEqual(run(f.st, { type: 'play' }).acts, [{ type: 'notice', text: 'EMPTY SIDE' }]);
});

test('AUTO toggle: persisted, re-plans the run, no-op when unchanged, never auto-flips a parked tape', () => {
  let { st, acts } = run(mk(), { type: 'setAuto', on: false });
  assert.equal(st.auto, false); assert.deepEqual(acts, [{ type: 'persistAuto', on: false }, { type: 'queueMode', playable: 'A' }]);
  assert.deepEqual(run(st, { type: 'setAuto', on: false }).acts, []);
  ({ st, acts } = run(st, { type: 'setAuto', on: true })); assert.deepEqual(acts[1], { type: 'queueMode', playable: 'both' });
  const parked = run(mk({ auto: false }), { type: 'play' }, { type: 'sideEnd' }, { type: 'setAuto', on: true });
  assert.equal(parked.st.phase, 'flip');
  // toggling mid side B: the run stays on B
  const b = run(mk(), { type: 'flip' }, { type: 'setAuto', on: false }, { type: 'setAuto', on: true });
  assert.equal(runMode(b.st), 'B');
});

test('FLIP while playing stops, flips and keeps both positions; FLIP while stopped/at END works too', () => {
  let { st, acts } = run(mk(), { type: 'play' }, { type: 'progress', index: 1, frac: 0.4 }, { type: 'flip' });
  assert.deepEqual(types(acts).filter((t) => t !== 'start'), ['stopPlayback', 'flipAnim', 'queueMode']);
  assert.equal(st.side, 'B'); assert.equal(st.phase, 'stopped');
  const atEnd = run(mk(), { type: 'flip' }, { type: 'play' }, { type: 'sideEnd' }, { type: 'flip' });
  assert.equal(atEnd.st.side, 'A'); assert.equal(atEnd.st.phase, 'stopped');
});

test('wind: rewinding past the start of side A stops; same on B (never crosses sides); ff off the end = side end', () => {
  const a = run(mk(), { type: 'play' }, { type: 'progress', index: 1, frac: 0.5 }, { type: 'windEdge', edge: 'start' });
  assert.equal(a.st.side, 'A'); assert.equal(a.st.phase, 'stopped'); assert.deepEqual(a.st.pos.A, { index: 0, frac: 0 }); assert.deepEqual(types(a.acts).slice(-1), ['stopPlayback']);
  const b = run(mk(), { type: 'flip' }, { type: 'play' }, { type: 'windEdge', edge: 'start' });
  assert.equal(b.st.side, 'B'); assert.equal(b.st.phase, 'stopped');
  const ff = run(mk({ auto: false }), { type: 'play' }, { type: 'windEdge', edge: 'end' });
  assert.equal(ff.st.phase, 'flip');
  const ffAuto = run(mk(), { type: 'play' }, { type: 'windEdge', edge: 'end' });
  assert.equal(ffAuto.st.side, 'B'); assert.equal(ffAuto.st.phase, 'playing');
  // seek after a wind updates the side's own position; seeking from END leaves it stopped
  const sk = run(mk(), { type: 'play' }, { type: 'seek', index: 2, frac: 0.1 });
  assert.deepEqual(sk.st.pos.A, { index: 2, frac: 0.1 });
  const fromEnd = run(mk(), { type: 'flip' }, { type: 'play' }, { type: 'sideEnd' }, { type: 'seek', index: 0, frac: 0 });
  assert.equal(fromEnd.st.phase, 'stopped');
});

test('counts changes re-plan the run; stop semantics; unknown events and junk never throw', () => {
  const r = run(mk(), { type: 'setCounts', A: 3, B: 0 });
  assert.deepEqual(r.acts, [{ type: 'queueMode', playable: 'A' }]); assert.deepEqual(r.st.n, { A: 3, B: 0 });
  assert.equal(run(mk(), { type: 'stop' }).st.phase, 'stopped');                      // stopped + stop = rewind, stays stopped
  assert.equal(run(run(mk(), { type: 'play' }).st, { type: 'stop' }).st.phase, 'paused');
  for (const ev of [{ type: 'nope' }, { type: 'changed' }, { type: 'progress' }, { type: 'seek' }, {}]) assert.doesNotThrow(() => reduce(mk(), ev));
  assert.equal(createTransport({ side: 'Z', nA: -1 }).side, 'A');
  assert.equal(deckMessage(mk()), '');
});

test('a full session: A -> auto B -> end -> rewind -> flip back manually, positions independent', () => {
  let st = mk();
  const feed = (...e) => { st = run(st, ...e).st; };
  feed({ type: 'play' }, { type: 'progress', index: 1, frac: 0.3 }, { type: 'changed', side: 'B', index: 0 }, { type: 'progress', index: 1, frac: 0.9 });
  assert.equal(st.side, 'B'); assert.deepEqual(st.pos.B, { index: 1, frac: 0.9 });
  feed({ type: 'sideEnd' }, { type: 'rewind' }, { type: 'flip' });
  assert.equal(st.side, 'A'); assert.equal(st.phase, 'stopped');
  assert.deepEqual(st.pos.A, { index: 2, frac: 1 });     // A was left at its end by the auto-reverse ...
  assert.deepEqual(run(st, { type: 'play' }).acts, [{ type: 'start', side: 'A', index: 0, frac: 0 }]);   // ... and starts over from the top
});
