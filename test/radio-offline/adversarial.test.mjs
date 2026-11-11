// Same adversarial orders as test/radio-canned/adversarial.test.mjs, against the You Radio runner (shared code pattern).
import test from 'node:test';
import assert from 'node:assert/strict';
import { rig } from './rig.mjs';
import { createEngineGate } from '../../src/engine-gate.js';

test('You Radio: skip during the pause between a break\'s utterances does not speak the rest over the next song', async () => {
  for (let seed = 1; seed <= 8; seed++) {
    const r = await rig({ seed });
    r.runner.start();
    let paused = false;
    for (let i = 0; i < 24000 && !paused; i++) {
      await r.time.advance(50, 50);
      const a = r.runner.aired, last = a.at(-1);
      const before = a.slice(0, -1).reduce((x, b) => x + b.script.utterances.length, 0);
      paused = !!last && last.script.utterances.length > 1 && r.events.filter((e) => e.type === 'caption').length === before + 1 && !r.synth.speaking && !r.voice.speaking && r.duck.holdCount > 0;
    }
    if (!paused) continue;
    const slotId = r.runner.aired.at(-1).slotId;
    const capsOf = () => r.events.filter((e) => e.type === 'caption' && e.slotId === slotId).length;
    const caps = capsOf();
    r.runner.skip();
    await r.time.advance(2500, 50);
    assert.equal(capsOf(), caps, 'no further line of the cancelled break was spoken');
    r.runner.stop(); await r.time.advance(1000, 50);
    assert.equal(r.duck.holdCount, 0);
    return;
  }
  assert.fail('never saw a pause between utterances');
});

test('You Radio: Stop during a slow cold load does not install the song; a user-started track makes the show stand down', async () => {
  const gate = createEngineGate();
  const r = await rig({});
  const base = r.player;
  const wait = (ms) => new Promise((res) => r.time.setTimeout(res, ms));
  const load = base.load.bind(base);
  r.player.owner = () => gate.token();
  r.player.cancelPending = () => { gate.bump(); };
  r.player.load = async (lib) => { const t = gate.token(); await wait(3000); gate.check(t); return load(lib); };
  r.runner.start();
  await r.time.advance(500, 50);
  r.runner.stop();
  await r.time.advance(8000, 100);
  assert.equal(base.deck, null);

  const g2 = createEngineGate();
  const q = await rig({});
  q.player.owner = () => g2.token();
  q.runner.start();
  await q.time.advance(10000, 100);
  assert.equal(q.runner.phase, 'playing');
  g2.bump();
  const n = q.player.ev.length;
  await q.time.advance(1500, 100);
  assert.equal(q.runner.phase, 'idle');
  assert.ok(!q.player.ev.slice(n).some((e) => ['halt', 'dropNext', 'join', 'load'].includes(e[0])));
});
