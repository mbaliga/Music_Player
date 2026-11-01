// SPIKE P1 -- THROWAWAY. See lib/gaps.mjs. Usage: node find-gaps.mjs recording.wav [minGapMs=250]
import { readFileSync } from 'node:fs';
import { parseWavPcm16, findGaps } from '../lib/gaps.mjs';
const [file, min = '250'] = process.argv.slice(2);
if (!file) { console.error('usage: find-gaps.mjs recording.wav [minGapMs]'); process.exit(2); }
const { samples, sampleRate } = parseWavPcm16(new Uint8Array(readFileSync(file)));
const { gaps, medianDb } = findGaps(samples, sampleRate, { minGapMs: +min });
console.log(`duration ${(samples.length / sampleRate).toFixed(1)} s, median envelope ${medianDb.toFixed(1)} dB, gaps >= ${min} ms: ${gaps.length}`);
for (const g of gaps) console.log(`  gap at ${(g.startMs / 1000).toFixed(2)} s for ${g.durMs} ms`);
console.log(gaps.length === 0 ? 'S2 exit (no gap > 250 ms): PASS for this recording' : 'S2 exit (no gap > 250 ms): FAIL for this recording');
