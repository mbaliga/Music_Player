// Deterministic driver for the AudioWorklet processor in plain node (no AudioWorkletGlobalScope).
// Used by the FX tests: the same scenario is replayed against the processor and hashed.
import { createHash } from 'node:crypto';

export async function loadProcessor(sr = 44100) {
  globalThis.sampleRate = sr;
  let cls = null;
  globalThis.registerProcessor = (_n, c) => { cls = c; };
  globalThis.AudioWorkletProcessor = class { constructor() { this.port = { onmessage: null, postMessage() {} }; } };
  await import('../../src/worklet.js?drive=' + Math.random());
  return cls;
}

/** tiny deterministic PRNG (mulberry32) */
export function prng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function makeStereo(frames, seed = 7) {
  const r = prng(seed);
  const pcm = new Float32Array(frames * 2);
  for (let i = 0; i < frames; i++) {
    pcm[i] = 0.4 * Math.sin(i * 0.031) + 0.2 * (r() * 2 - 1);
    pcm[frames + i] = 0.3 * Math.sin(i * 0.047 + 1) + 0.2 * (r() * 2 - 1);
  }
  return pcm;
}

/** Run `blocks` quanta; `script(b, proc)` may poke the processor before block b. Returns {out:[Float32Array L,R], proc}. */
export function run(Proc, { pcm, frames, control = null, blocks, script = () => {} }) {
  const proc = new Proc({ processorOptions: { channels: 2, frames, pcm: pcm.buffer, control: control ? control.buffer : null } });
  const L = new Float32Array(blocks * 128), R = new Float32Array(blocks * 128);
  const o0 = new Float32Array(128), o1 = new Float32Array(128);
  for (let b = 0; b < blocks; b++) {
    script(b, proc);
    proc.process([], [[o0, o1]], {});
    L.set(o0, b * 128); R.set(o1, b * 128);
  }
  return { out: [L, R], proc };
}

export const sha = (...arrs) => { const h = createHash('sha256'); for (const a of arrs) h.update(Buffer.from(a.buffer, a.byteOffset, a.byteLength)); return h.digest('hex'); };

/** the legacy (pre-FX) scenario: rate sweeps incl. reverse + zero, a seek, a pause. */
export function legacyScenario(Proc, { sab }) {
  const frames = 30000;
  const pcm = makeStereo(frames);
  const control = sab ? new Float64Array(16) : null;
  const rates = [0, 1, 1, 2.5, -1.5, 0, 0.3, 1, 8, -3, 1];
  const res = run(Proc, {
    pcm, frames, control, blocks: 400,
    script(b, p) {
      const rate = rates[Math.floor(b / 36) % rates.length];
      if (control) {
        control[0] = rate; control[5] = b >= 300 && b < 320 ? 0 : 1;
        if (b === 150) { control[2] = 9000; control[3] += 1; }
      } else {
        p.onMessage({ type: 'rate', value: rate });
        p.onMessage({ type: 'playing', value: !(b >= 300 && b < 320) });
        if (b === 150) p.onMessage({ type: 'seek', value: 9000 });
      }
    },
  });
  return { hash: sha(res.out[0], res.out[1], new Float64Array([res.proc.readPosition])), res };
}
