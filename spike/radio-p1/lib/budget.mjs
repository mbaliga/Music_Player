// SPIKE P1 -- THROWAWAY. Not part of the shipped app. See docs/RADIO_SPIKE_P1.md.
//
// Latency budget calculator + per-stage timing report. Pure (no DOM, no timers),
// so it is covered by node:test. The table below is copied from
// docs/RADIO_ARCHITECTURE.md section 8.3 -- those numbers are BUDGET TARGETS,
// not measurements.

/** @typedef {{id:string,label:string,p50:number,lo:number,hi:number}} Stage */

/** @type {Stage[]} order = pipeline order; ids are the keys used everywhere else */
export const STAGES = [
  { id: 'vad_endpoint', label: '1 VAD endpointing hangover',   p50: 300, lo: 200, hi: 500 },
  { id: 'stt_final',    label: '2 STT finalization',           p50: 150, lo: 80,  hi: 300 },
  { id: 'uplink',       label: '3 Uplink + proxy hop',         p50: 80,  lo: 40,  hi: 150 },
  { id: 'llm_ttft',     label: '4 LLM first token',            p50: 450, lo: 300, hi: 800 },
  { id: 'first_chunk',  label: '5 First speakable chunk',      p50: 200, lo: 100, hi: 350 },
  { id: 'tts_ttfb',     label: '6 TTS time-to-first-byte',     p50: 250, lo: 150, hi: 450 },
  { id: 'downlink',     label: '7 Downlink+decode+jitter',     p50: 100, lo: 60,  hi: 200 },
  { id: 'output',       label: '8 Output device latency',      p50: 40,  lo: 12,  hi: 80  },
];

/** Doc targets: p50 <= 1.6 s, p95 <= 2.5 s (section 8.3); spike exit S1: p50 <= 2.0, p95 <= 3.0 (section 11). */
export const TARGETS = { docP50: 1600, docP95: 2500, spikeP50: 2000, spikeP95: 3000 };

/** Doc masking rule: if stages 1-5 exceed this, play a backchannel clip (section 8.3). */
export const MASK_THRESHOLD_MS = 900;
export const MASK_STAGE_IDS = ['vad_endpoint', 'stt_final', 'uplink', 'llm_ttft', 'first_chunk'];

export function budgetTotals(stages = STAGES) {
  const sum = (k) => stages.reduce((a, s) => a + s[k], 0);
  return { p50: sum('p50'), lo: sum('lo'), hi: sum('hi') };
}

/** Linear-interpolated percentile (p in 0..100). NaN for empty input. */
export function percentile(values, p) {
  if (!values.length) return NaN;
  const a = [...values].sort((x, y) => x - y);
  if (a.length === 1) return a[0];
  const r = (p / 100) * (a.length - 1);
  const lo = Math.floor(r), hi = Math.ceil(r);
  return a[lo] + (a[hi] - a[lo]) * (r - lo);
}

export function summarize(values) {
  return {
    n: values.length,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    max: values.length ? Math.max(...values) : NaN,
    min: values.length ? Math.min(...values) : NaN,
  };
}

/**
 * @param {Array<Record<string,number>>} turns  per-turn stage durations in ms, keyed by stage id.
 *        A turn may omit a stage (e.g. not measured); the total is only computed for complete turns.
 * @param {{provenance?:Record<string,'measured'|'configured-fake'|'reported'|'real-stub'>, stages?:Stage[]}} [opts]
 *        provenance says where each stage's number came from -- the report prints it so a fake
 *        delay can never be mistaken for a measurement.
 */
export function buildReport(turns, opts = {}) {
  const stages = opts.stages || STAGES;
  const provenance = opts.provenance || {};
  const rows = stages.map((s) => {
    const vals = turns.map((t) => t[s.id]).filter((v) => Number.isFinite(v));
    const sm = summarize(vals);
    let status = 'no data';
    if (sm.n) status = sm.p50 > s.hi ? 'OVER range' : sm.p50 > s.p50 ? 'above p50 budget' : 'within p50 budget';
    return { id: s.id, label: s.label, budgetP50: s.p50, budgetLo: s.lo, budgetHi: s.hi,
      ...sm, deltaP50: sm.n ? sm.p50 - s.p50 : NaN, status, provenance: provenance[s.id] || 'unspecified' };
  });
  const complete = turns.filter((t) => stages.every((s) => Number.isFinite(t[s.id])));
  const totals = complete.map((t) => stages.reduce((a, s) => a + t[s.id], 0));
  const total = summarize(totals);
  const bt = budgetTotals(stages);
  const maskable = complete.map((t) => MASK_STAGE_IDS.reduce((a, id) => a + (t[id] || 0), 0));
  const maskTriggerRate = maskable.length ? maskable.filter((v) => v > MASK_THRESHOLD_MS).length / maskable.length : NaN;
  const nonMeasured = stages.filter((s) => (provenance[s.id] || 'unspecified') !== 'measured').map((s) => s.id);
  return {
    turns: turns.length, completeTurns: complete.length, rows, total,
    budget: bt,
    verdicts: {
      docP50: total.n ? total.p50 <= TARGETS.docP50 : null,
      docP95: total.n ? total.p95 <= TARGETS.docP95 : null,
      spikeP50: total.n ? total.p50 <= TARGETS.spikeP50 : null,
      spikeP95: total.n ? total.p95 <= TARGETS.spikeP95 : null,
    },
    maskTriggerRate,
    // True only if EVERY stage came from a real measurement; otherwise the verdicts above
    // describe the configuration, not the product.
    allStagesMeasured: nonMeasured.length === 0,
    nonMeasuredStages: nonMeasured,
  };
}

const f = (v) => (Number.isFinite(v) ? String(Math.round(v)) : '-');

export function formatReportMarkdown(r, title = 'Caller-loop latency report') {
  const L = [];
  L.push(`### ${title}`, '');
  L.push(`Turns: ${r.turns} (complete: ${r.completeTurns}). All values ms, end of listener speech to first audible RJ audio.`, '');
  L.push('| Stage | Budget p50 (range) | p50 | p95 | max | n | vs budget | Source |');
  L.push('|---|---|---|---|---|---|---|---|');
  for (const x of r.rows) {
    L.push(`| ${x.label} | ${x.budgetP50} (${x.budgetLo}-${x.budgetHi}) | ${f(x.p50)} | ${f(x.p95)} | ${f(x.max)} | ${x.n} | ${x.status} | ${x.provenance} |`);
  }
  L.push(`| **Total** | **${r.budget.p50}** (${r.budget.lo}-${r.budget.hi} by column sum) | **${f(r.total.p50)}** | **${f(r.total.p95)}** | ${f(r.total.max)} | ${r.total.n} | | |`, '');
  const yn = (v) => (v === null ? 'n/a' : v ? 'PASS' : 'FAIL');
  L.push(`- Doc target p50 <= ${TARGETS.docP50} ms: ${yn(r.verdicts.docP50)}; p95 <= ${TARGETS.docP95} ms: ${yn(r.verdicts.docP95)}`);
  L.push(`- Spike exit (S1) p50 <= ${TARGETS.spikeP50} ms: ${yn(r.verdicts.spikeP50)}; p95 <= ${TARGETS.spikeP95} ms: ${yn(r.verdicts.spikeP95)}`);
  L.push(`- Backchannel masking would trigger (stages 1-5 > ${MASK_THRESHOLD_MS} ms) on ${Number.isFinite(r.maskTriggerRate) ? (r.maskTriggerRate * 100).toFixed(0) + '%' : 'n/a'} of turns`);
  if (!r.allStagesMeasured) {
    L.push(`- WARNING: these stages are NOT real measurements (${r.nonMeasuredStages.join(', ')}); the PASS/FAIL lines above describe the adapter configuration, not the product.`);
  }
  return L.join('\n');
}
