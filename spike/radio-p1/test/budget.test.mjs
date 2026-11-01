// SPIKE P1 tests (throwaway module, but the pure logic is worth locking down).
import test from 'node:test';
import assert from 'node:assert/strict';
import { STAGES, budgetTotals, percentile, summarize, buildReport, formatReportMarkdown, MASK_THRESHOLD_MS, MASK_STAGE_IDS } from '../lib/budget.mjs';

test('budget table: p50 column sums to the doc total of 1570 ms', () => {
  assert.equal(STAGES.length, 8);
  assert.equal(budgetTotals().p50, 1570);
});

test('budget table: column sums of ranges (documents a doc inconsistency: 942-2830, doc says ~1100-2900)', () => {
  const t = budgetTotals();
  assert.equal(t.lo, 942);
  assert.equal(t.hi, 2830);
});

test('doc inconsistency: stages 1-5 at p50 already exceed the 900 ms masking threshold', () => {
  const s = STAGES.filter((x) => MASK_STAGE_IDS.includes(x.id)).reduce((a, x) => a + x.p50, 0);
  assert.equal(s, 1180);
  assert.ok(s > MASK_THRESHOLD_MS);
});

test('percentile: interpolates, handles edges', () => {
  assert.equal(percentile([1, 2, 3, 4], 50), 2.5);
  assert.equal(percentile([5], 95), 5);
  assert.equal(percentile([1, 2, 3, 4, 5], 0), 1);
  assert.equal(percentile([1, 2, 3, 4, 5], 100), 5);
  assert.ok(Number.isNaN(percentile([], 50)));
  assert.equal(percentile([3, 1, 2], 50), 2, 'unsorted input');
});

test('summarize', () => {
  const s = summarize([10, 20, 30]);
  assert.deepEqual([s.n, s.p50, s.max, s.min], [3, 20, 30, 10]);
});

const budgetTurn = () => Object.fromEntries(STAGES.map((s) => [s.id, s.p50]));

test('report: a turn exactly at budget totals 1570 and passes doc p50 target', () => {
  const r = buildReport([budgetTurn(), budgetTurn()], { provenance: Object.fromEntries(STAGES.map((s) => [s.id, 'measured'])) });
  assert.equal(r.total.p50, 1570);
  assert.equal(r.verdicts.docP50, true);
  assert.equal(r.verdicts.docP95, true);
  assert.equal(r.allStagesMeasured, true);
  assert.ok(r.rows.every((x) => x.status === 'within p50 budget'));
});

test('report: stage over its hi range is flagged, total fails p95 target', () => {
  const t = budgetTurn(); t.llm_ttft = 1500;
  const r = buildReport([t]);
  assert.equal(r.rows.find((x) => x.id === 'llm_ttft').status, 'OVER range');
  assert.equal(r.verdicts.docP95, false);
  assert.equal(r.verdicts.spikeP95, true);
});

test('report: incomplete turns are excluded from totals but kept in per-stage stats', () => {
  const full = budgetTurn(), partial = { vad_endpoint: 300 };
  const r = buildReport([full, partial]);
  assert.equal(r.turns, 2); assert.equal(r.completeTurns, 1);
  assert.equal(r.rows[0].n, 2);
  assert.equal(r.total.n, 1);
});

test('report: NaN/missing never counted; no data gives null verdicts', () => {
  const r = buildReport([{ vad_endpoint: NaN }]);
  assert.equal(r.verdicts.docP50, null);
  assert.equal(r.rows[0].status, 'no data');
});

test('report: provenance other than measured sets the warning and markdown carries it', () => {
  const r = buildReport([budgetTurn()], { provenance: { vad_endpoint: 'measured', stt_final: 'configured-fake' } });
  assert.equal(r.allStagesMeasured, false);
  assert.ok(r.nonMeasuredStages.includes('stt_final'));
  const md = formatReportMarkdown(r);
  assert.match(md, /NOT real measurements/);
  assert.match(md, /configured-fake/);
});

test('masking trigger rate counts turns whose stages 1-5 exceed the threshold', () => {
  const quick = budgetTurn(); for (const id of MASK_STAGE_IDS) quick[id] = 100; // 500 total
  const slow = budgetTurn();                                                      // 1180
  const r = buildReport([quick, slow]);
  assert.equal(r.maskTriggerRate, 0.5);
});
