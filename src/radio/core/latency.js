// ─────────────────────────────────────────────────────────────────────────────
// latency.js — the caller-loop latency budget (architecture 8.3, corrected by the
// P1 spike: docs/RADIO_SPIKE_P1.md 5.4). Pure constants + stats; no timers.
//
// Target = end of listener speech to first audible RJ audio. These are BUDGET
// TARGETS to be confirmed or killed on a device, not measurements.
//   • the range row is the sum of the range columns (942–2,830 ms), not 1,100–2,900
//   • gate on p95 (<= 2.5 s); p50 (<= 1.6 s) is reported but a sum of medians is not
//     the median of the sum, so p50 has no slack
//   • the S1 exit equals the product targets (1.6 / 2.5); only the KILL line is looser
//   • backchannel masking triggers at 1,400 ms after end of speech, not 900 (the p50
//     sum of stages 1–5 is 1,180 ms, so 900 would fire on essentially every turn)
// ─────────────────────────────────────────────────────────────────────────────

export const LATENCY_STAGES = Object.freeze([
  { id: 'vad_endpoint', label: 'VAD endpointing hangover', p50: 300, lo: 200, hi: 500 },
  { id: 'stt_final', label: 'STT finalization', p50: 150, lo: 80, hi: 300 },
  { id: 'uplink', label: 'Uplink + proxy hop', p50: 80, lo: 40, hi: 150 },
  { id: 'llm_ttft', label: 'LLM first token', p50: 450, lo: 300, hi: 800 },
  { id: 'first_chunk', label: 'First speakable chunk', p50: 200, lo: 100, hi: 350 },
  { id: 'tts_ttfb', label: 'TTS time-to-first-byte', p50: 250, lo: 150, hi: 450 },
  { id: 'downlink', label: 'Downlink + decode + jitter buffer', p50: 100, lo: 60, hi: 200 },
  { id: 'output', label: 'Output device latency', p50: 40, lo: 12, hi: 80 },
].map((s) => Object.freeze(s)));

export const TARGETS = Object.freeze({ p50Ms: 1600, p95Ms: 2500, killP95Ms: 3000 });
export const BACKCHANNEL = Object.freeze({ afterMs: 1400, cooldownTurns: 3 });
/** stages that must be done before the first speakable chunk exists (what masking waits on) */
export const MASK_STAGE_IDS = Object.freeze(['vad_endpoint', 'stt_final', 'uplink', 'llm_ttft', 'first_chunk']);

export function budgetTotals(stages = LATENCY_STAGES) {
  const sum = (k) => stages.reduce((a, s) => a + s[k], 0);
  return { p50: sum('p50'), lo: sum('lo'), hi: sum('hi') };
}

/** Linear-interpolated percentile (p in 0..100); NaN for empty input. */
export function percentile(values, p) {
  if (!values.length) return NaN;
  const a = [...values].sort((x, y) => x - y);
  if (a.length === 1) return a[0];
  const r = (p / 100) * (a.length - 1);
  const lo = Math.floor(r), hi = Math.ceil(r);
  return a[lo] + (a[hi] - a[lo]) * (r - lo);
}

/**
 * Gate on a sample of end-to-end turn latencies (ms): PASS iff p95 <= 2.5 s.
 * p50 is reported (and flagged) but is not the gate. `kill` = p95 > 3.0 s.
 */
export function evaluateGate(totalsMs) {
  const v = (totalsMs || []).filter(Number.isFinite);
  const p50 = percentile(v, 50), p95 = percentile(v, 95);
  return {
    n: v.length, p50, p95, max: v.length ? Math.max(...v) : NaN,
    pass: v.length > 0 && p95 <= TARGETS.p95Ms,
    p50Within: v.length > 0 && p50 <= TARGETS.p50Ms,
    kill: v.length > 0 && p95 > TARGETS.killP95Ms,
  };
}
