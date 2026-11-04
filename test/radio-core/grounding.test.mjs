import test from 'node:test';
import assert from 'node:assert/strict';
import {
  verifyScript, nextStepAfterVerify, degradeSlotForServices, writerFacts, forbiddenTopics, piiScan,
  deriveExpiry, utteranceStaleAt, whyUnusable, factIndex,
} from '../../src/radio/core/grounding.js';
import { cannedScript, CANNED_TEXTS } from '../../src/radio/core/canned.js';
import { validateScript } from '../../src/radio/core/schemas.js';
import { snapshotFixture, goldenScripts, FIXTURE_NOW_MS } from '../../src/radio/core/fixtures.js';

const U = (text, factRefs, id = 'u1') => ({ id, text, style: { emotion: 'warm', energy: 0.5, pace: 1 }, factRefs });
const S = (...utts) => ({ schemaVersion: 1, slotId: 's', utterances: utts });
const verify = (script, name = 'rainy-commute', o = {}) => verifyScript(script, snapshotFixture(name), { atMs: FIXTURE_NOW_MS, ...o });
const codes = (r) => r.problems.map((p) => p.code);

test('golden scripts pass; expiry is derived from fact TTLs, not the writer', () => {
  const snap = snapshotFixture();
  for (const s of Object.values(goldenScripts())) {
    const r = verifyScript(s, snap, { atMs: FIXTURE_NOW_MS, trackMeta: { t004: { title: 'Midnight Copper II', artist: 'x' } } });
    assert.deepEqual(r.problems, []);
    assert.equal(r.ok, true);
  }
  const g5 = verify(goldenScripts().g5).script;
  // wx.now ttl 1800 s from the fixture instant is the soonest-expiring ref of u1
  assert.equal(g5.utterances[0].expiresAt, new Date(FIXTURE_NOW_MS + 1800 * 1000).toISOString());
  assert.equal(g5.utterances[2].expiresAt, null);
  const liar = { ...goldenScripts().g5 }; liar.utterances = liar.utterances.map((u) => ({ ...u, expiresAt: '2099-01-01T00:00:00.000Z' }));
  assert.notEqual(deriveExpiry(liar, snap).utterances[0].expiresAt, '2099-01-01T00:00:00.000Z');
  assert.equal(utteranceStaleAt(g5.utterances[0], FIXTURE_NOW_MS + 1801 * 1000), true);
  assert.equal(utteranceStaleAt(g5.utterances[0], FIXTURE_NOW_MS), false);
});

test('numbers: spelled and digit forms are equivalent; rounding the way a host would is fine', () => {
  assert.equal(verify(S(U('It is twelve degrees and raining.', ['wx.now']))).ok, true);
  assert.equal(verify(S(U('Around 12 degrees, raining.', ['wx.now']))).ok, true);
  assert.equal(verify(S(U('Four fifty-two was sunset.', ['sun.set']))).ok, true);
});

test('mutation: perturbing any number in a good script makes the verifier fail', () => {
  const good = goldenScripts().g5;
  assert.equal(verify(good).ok, true);
  let mutated = 0;
  for (const [from, to] of [['12', '21'], ['9', '7'], ['4:52', '5:52'], ['12', 'fourteen'], ['9', 'nineteen'], ['4:52', '4:25']]) {
    const bad = JSON.parse(JSON.stringify(good));
    bad.utterances.forEach((u) => { u.text = u.text.replace(from, to); });
    if (JSON.stringify(bad) === JSON.stringify(good)) continue;
    mutated++;
    const r = verify(bad);
    assert.equal(r.ok, false, `${from} -> ${to}`);
    assert.ok(codes(r).includes('ungrounded_number'), `${from} -> ${to}`);
  }
  assert.ok(mutated >= 5);
});

test('known-hallucination corpus is rejected with the right code', () => {
  const cases = [
    ['Expect 5 inches of snow tonight.', ['wx.now'], 'ungrounded_number'],
    ['It is sunny and clear out there.', [], 'unreferenced_claim'],
    ['Traffic is a nightmare on the bridge.', ['wx.now'], 'unreferenced_claim'],
    ['Sunset is early these days.', ['wx.now'], 'unreferenced_claim'],
    ['This song won a Grammy in 1974.', [], 'ungrounded_number'],
    ['Greetings from Portland, folks.', ['wx.now'], 'ungrounded_name'],
    ['It is raining hard.', ['nope.id'], 'unknown_fact'],
  ];
  for (const [text, refs, code] of cases) {
    const r = verify(S(U(text, refs)));
    assert.equal(r.ok, false, text);
    assert.ok(codes(r).includes(code), `${text} -> ${codes(r)}`);
  }
});

test('every utterance must carry factRefs (an empty list is fine, absent is not)', () => {
  assert.deepEqual(codes(verify(S(U('Back in a moment.', undefined)))), ['missing_factrefs']);
  assert.equal(verify(S(U('Back in a moment.', []))).ok, true);
});

test('names: sentence-initial words and persona/place/track names are fine; invented ones are not', () => {
  assert.equal(verify(S(U('Casey here on Runout FM, in Seattle.', []))).ok, true);
  assert.equal(verify(S(U('Next up, Mara Quill.', []), U('Coming from Seattle.', [], 'u2')), 'rainy-commute', { trackMeta: { t1: { title: 'x', artist: 'Mara Quill' } } }).ok, false);
  const ok = verify({ ...S(U('Next up, Mara Quill.', [])), claimedTrackIds: ['t1'] }, 'rainy-commute', { trackMeta: { t1: { title: 'Slow', artist: 'Mara Quill' } } });
  assert.equal(ok.ok, true);
  assert.ok(codes(verify(S(U('Say hi to Dave for me.', [])))).includes('ungrounded_name'));
  assert.ok(codes(verify(S(U('Happy Tuesday.', [])))).includes('ungrounded_name')); // snapshot weekday is Wednesday
  assert.equal(verify(S(U('Happy Wednesday.', []))).ok, true);
});

test('stale, unmentionable and service-down facts cannot be referenced', () => {
  const stale = verifyScript(S(U('The commute is 35 minutes slow.', ['traffic.commute'])), snapshotFixture('stale-traffic'), { atMs: FIXTURE_NOW_MS });
  assert.ok(codes(stale).includes('service_unavailable') || codes(stale).includes('stale_fact'));
  const snap = snapshotFixture();
  snap.facts.push({ id: 'secret', kind: 'custom', value: 'x', say: 'you left home early again', asOf: snap.takenAt, ttlSec: 999, source: 'fx', mentionable: false });
  assert.ok(codes(verifyScript(S(U('Still raining.', ['secret', 'wx.now'])), snap, { atMs: FIXTURE_NOW_MS })).includes('unmentionable_ref'));
  assert.ok(codes(verifyScript(S(U('Funny, you left home early again.', [])), snap, { atMs: FIXTURE_NOW_MS })).includes('unmentionable_text'));
  // air time later than ttl
  const late = verify(S(U('About 12 degrees and raining.', ['wx.now'])), 'rainy-commute', { atMs: FIXTURE_NOW_MS + 2000 * 1000 });
  assert.ok(codes(late).includes('stale_fact'));
});

test('weather down: facts cannot be used and a weather_hit degrades to chat', () => {
  const snap = snapshotFixture('weather-down');
  assert.deepEqual(forbiddenTopics(snap), ['weather']);
  assert.deepEqual(codes(verifyScript(S(U('Lovely and sunny.', [])), snap, { atMs: FIXTURE_NOW_MS })), ['unreferenced_claim']);
  const hit = { slotId: 'h', kind: 'weather_hit', targetSec: 20, talk: { factIds: ['wx.now', 'wx.next6h'], budgetSec: 20 } };
  const d = degradeSlotForServices(hit, snap, FIXTURE_NOW_MS);
  assert.equal(d.converted, true);
  assert.equal(d.slot.kind, 'talk_break');
  assert.deepEqual(d.slot.talk.factIds, []);
  assert.deepEqual(d.dropped.sort(), ['wx.next6h', 'wx.now']);
  const fine = degradeSlotForServices(hit, snapshotFixture(), FIXTURE_NOW_MS);
  assert.equal(fine.converted, false);
  assert.equal(fine.slot, hit);
  const noLoc = snapshotFixture('no-location');
  assert.equal(degradeSlotForServices({ slotId: 'p', kind: 'place_hit', targetSec: 15, talk: { factIds: [] } }, noLoc).converted, true);
});

test('writerFacts shows the writer only usable {id, say, value}', () => {
  const snap = snapshotFixture('stale-traffic');
  const f = writerFacts(snap, ['wx.now', 'traffic.commute', 'nope'], FIXTURE_NOW_MS);
  assert.deepEqual(f.map((x) => x.id), ['wx.now']);
  assert.deepEqual(Object.keys(f[0]).sort(), ['id', 'say', 'value']);
  assert.equal(whyUnusable(snap, factIndex(snap).get('traffic.commute'), FIXTURE_NOW_MS), 'service_unavailable');
});

test('PII and policy scan', () => {
  for (const t of ['I am at 47.6097, -122.3331 today', 'Visit 1200 Pine Street soon', 'ring 555 010 9999', 'mail me at a@b.co', 'see https://x.io', 'www.example.com']) {
    assert.ok(piiScan(t).length > 0, t);
  }
  assert.deepEqual(piiScan('About 12.5 degrees at 6:45.'), []);
  assert.ok(codes(verify(S(U('Call 555 010 9999 now.', [])))).includes('pii'));
});

test('failure policy: regenerate once with diagnostics, then canned', () => {
  const bad = verify(S(U('Snow 9 inches.', [])));
  const first = nextStepAfterVerify(bad, 0);
  assert.equal(first.action, 'regenerate');
  assert.ok(first.diagnostics.length > 0);
  assert.equal(nextStepAfterVerify(bad, 1).action, 'canned');
  assert.equal(nextStepAfterVerify(verify(S(U('Hi.', []))), 0).action, 'accept');
});

test('every canned line is schema-valid and passes the verifier in every scenario', () => {
  for (let seed = 0; seed < CANNED_TEXTS.length * 2; seed++) {
    const s = cannedScript('slot', seed);
    assert.equal(validateScript(s).ok, true);
    for (const n of ['rainy-commute', 'weather-down', 'no-location', 'midnight']) {
      assert.deepEqual(verifyScript(s, snapshotFixture(n), { atMs: FIXTURE_NOW_MS }).problems, [], `${seed} ${n}`);
    }
  }
  assert.notEqual(cannedScript('a', 1).utterances[0].text, cannedScript('a', 2).utterances[0].text);
});

test('verifier never throws on garbage', () => {
  for (const s of [null, {}, { utterances: 5 }, { utterances: [null] }, { utterances: [{ text: 5 }] }]) {
    const r = verifyScript(s, snapshotFixture(), {});
    assert.equal(typeof r.ok, 'boolean');
  }
  assert.equal(verifyScript(S(U('x', [])), null, {}).ok !== undefined, true);
});
