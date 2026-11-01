// SPIKE P1 -- THROWAWAY. FAKE adapters with configurable delays. Every number these produce is a
// CONFIGURED delay, never a measurement of any vendor. Report provenance marks them 'configured-fake'.
import { mulberry32, lognormalDelay } from './rng.mjs';
import { STAGES } from './budget.mjs';
import { createChunker } from './pipeline.mjs';

const p50Of = (id) => STAGES.find((s) => s.id === id).p50;

/** Default delay config = the doc budget p50s (so an unmodified run reproduces ~1.57 s by construction). */
export function defaultFakeConfig(overrides = {}) {
  return {
    seed: 42, sigma: 0.25,
    stt_final: p50Of('stt_final'), uplink: p50Of('uplink'), llm_ttft: p50Of('llm_ttft'),
    first_chunk: p50Of('first_chunk'), tts_ttfb: p50Of('tts_ttfb'), downlink: p50Of('downlink'),
    output: p50Of('output'), text: 'Hey, you are on the air. Thanks for calling in tonight.',
    ...overrides,
  };
}

export function makeFakeAdapters(mic, cfg = defaultFakeConfig()) {
  const rng = mulberry32(cfg.seed);
  const d = (key) => lognormalDelay(rng, cfg[key], cfg.sigma);
  const words = cfg.text.split(/(?<=\s)/); // tokens keep trailing space
  // How many tokens until the chunker emits its first clause (so the configured first_chunk delay
  // is spread across exactly those tokens).
  const ck = createChunker(); let nFirst = 1;
  for (const w of words) { if (ck.push(w)) break; nFirst++; }
  return {
    mic,
    stt: { kind: 'fake', async finalize(_, clock) { await clock.sleep(d('stt_final')); return { text: 'hello, can you play something slow' }; } },
    transport: { kind: 'fake', async send(_, clock) { await clock.sleep(d('uplink')); } },
    writer: {
      kind: 'fake',
      async *stream(_, clock) {
        await clock.sleep(d('llm_ttft'));
        const perChunk = d('first_chunk');
        let i = 0;
        for (const w of words) {
          // The configured first_chunk delay is spread across the tokens before the first clause ends.
          if (i > 0 && i < nFirst) await clock.sleep(perChunk / Math.max(1, nFirst - 1));
          i++;
          yield w;
        }
      },
    },
    tts: { kind: 'fake', async synthesize(text, clock) { await clock.sleep(d('tts_ttfb')); return { firstByteAt: clock.now(), audio: { text } }; } },
    playback: {
      kind: 'fake',
      async play(_, clock) {
        await clock.sleep(d('downlink'));
        const readyAt = clock.now();
        await clock.sleep(d('output'));
        return { readyAt, audibleAt: clock.now() };
      },
    },
  };
}
