// SPIKE P1 -- THROWAWAY. Sweeps the energy VAD over synthetic utterances: endpoint latency vs ground truth.
// Measures THIS toy VAD on SYNTHETIC speech-like signals only. Says nothing about real voices/rooms.
import { utterance } from '../lib/synth.mjs';
import { EnergyVad } from '../lib/vad.mjs';
import { summarize } from '../lib/budget.mjs';
const sr = 16000;
console.log('| hangover ms | noise dBFS | n | endpoint latency p50 | p95 | false/missed |');
console.log('|---|---|---|---|---|---|');
for (const hang of [200, 300, 500]) for (const noiseDb of [-60, -40, -30]) {
  const lat = []; let bad = 0;
  for (let i = 0; i < 30; i++) {
    const u = utterance(sr, { seed: 100 + i, speechMs: 800 + (i % 6) * 200, noiseDb, level: 0.3 });
    const vad = new EnergyVad({ sampleRate: sr, hangoverMs: hang });
    const ev = []; for (let k = 0; k + 320 <= u.samples.length; k += 320) ev.push(...vad.push(u.samples.subarray(k, k + 320)));
    const e = ev.filter((x) => x.type === 'speech_end');
    if (e.length !== 1) { bad++; continue; }
    lat.push(e[0].atMs - u.truth.speechEndMs);
  }
  const s = summarize(lat);
  console.log(`| ${hang} | ${noiseDb} | ${s.n} | ${s.p50.toFixed(0)} | ${s.p95.toFixed(0)} | ${bad} |`);
}
