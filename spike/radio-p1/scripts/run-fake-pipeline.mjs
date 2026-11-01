// SPIKE P1 -- THROWAWAY. Runs the caller-loop pipeline with FAKE adapters on a virtual clock and prints
// the per-stage report. Stage 1 (VAD) runs on real (synthetic) samples; stages 2-8 are configured delays.
//   node spike/radio-p1/scripts/run-fake-pipeline.mjs [--turns 30] [--scenario budget|slow-llm|lte|tail] [--json]
import { utterance } from '../lib/synth.mjs';
import { VirtualClock, BufferMic, runTurn, provenanceFor } from '../lib/pipeline.mjs';
import { makeFakeAdapters, defaultFakeConfig } from '../lib/adapters-fake.mjs';
import { buildReport, formatReportMarkdown } from '../lib/budget.mjs';

export const SCENARIOS = {
  budget: {},                                              // doc p50s
  'slow-llm': { llm_ttft: 800, sigma: 0.3 },               // top of the doc's LLM range
  lte: { uplink: 150, downlink: 200, sigma: 0.35 },        // top of the network ranges
  tail: { sigma: 0.6 },                                    // same medians, heavy tails: shows p50 passing while p95 fails
};

export async function simulate({ turns = 30, scenario = 'budget', hangoverMs = 300 } = {}) {
  const sr = 16000, rows = [];
  let provenance;
  for (let i = 0; i < turns; i++) {
    const utt = utterance(sr, { seed: 10 + i, speechMs: 900 + (i % 5) * 150 });
    const mic = new BufferMic(utt.samples, sr, { kind: 'measured' });
    const cfg = defaultFakeConfig({ seed: 1000 + i, ...SCENARIOS[scenario] });
    const adapters = makeFakeAdapters(mic, cfg);
    provenance = provenanceFor(adapters, { vadMeasured: true });
    const r = await runTurn({ adapters, clock: new VirtualClock(), vadOptions: { hangoverMs }, sampleRate: sr, truthSpeechEndMs: utt.truth.speechEndMs });
    rows.push(r.stages);
  }
  return buildReport(rows, { provenance });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const a = process.argv.slice(2), get = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  const report = await simulate({ turns: +get('--turns', 30), scenario: get('--scenario', 'budget') });
  console.log(a.includes('--json') ? JSON.stringify(report, null, 2) : formatReportMarkdown(report, `Fake-adapter simulation, scenario "${get('--scenario', 'budget')}"`));
}
