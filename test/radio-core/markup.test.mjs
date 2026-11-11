import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMarkup, validateMarkup, stripMarkup, hasLeakedMarkers, degradeUtterance, templateResolver,
  CAPS_NONE, CAPS_SSML, CAPS_RICH,
} from '../../src/radio/core/markup.js';
import { extractNumbers, numberToWords, numberMatches } from '../../src/radio/core/numbers.js';

const utt = (text, style = {}) => ({ id: 'u', text, style: { emotion: 'wry', energy: 0.5, pace: 1.1, pitchSemitones: 1, direction: 'dry', ...style } });
const RICH = 'Well {pause:400} it is {em}raining{/em} {laugh} out {breath} there {sfx:rain} {{time.spoken}}.';

test('parse: every marker type tokenises', () => {
  const r = parseMarkup(RICH);
  assert.equal(r.ok, true);
  assert.deepEqual(r.tokens.filter((t) => t.type !== 'text').map((t) => t.type), ['pause', 'em', 'em', 'laugh', 'breath', 'sfx', 'template']);
  assert.equal(r.tokens.find((t) => t.type === 'pause').ms, 400);
});

test('validate: unknown/malformed markers are errors and never become tokens', () => {
  for (const bad of ['{bogus}', '{pause:99999}', '{pause:x}', '{sfx:Bad Name}', '{em}x', '{/em}', '{em}{em}x{/em}{/em}', '{{date.fancy}}', 'stray } brace', 'open { brace']) {
    assert.equal(validateMarkup(bad).ok, false, bad);
  }
  assert.equal(validateMarkup(RICH).ok, true);
  assert.equal(parseMarkup(42).ok, false);
});

test('strip: plain speech has no markers; em keeps its words; templates resolve or drop', () => {
  assert.equal(stripMarkup(RICH), 'Well it is raining out there.');
  assert.equal(stripMarkup(RICH, { templates: () => 'six oh five' }), 'Well it is raining out there six oh five.');
  assert.equal(hasLeakedMarkers(stripMarkup('x {bogus} y {pause:9999999}')), false);
  assert.equal(stripMarkup(null), '');
});

test('golden: no-capability engine gets punctuation rhythm only, nothing leaks', () => {
  const o = degradeUtterance(utt(RICH), CAPS_NONE, { resolve: templateResolver({ hour: 18, minute: 5 }) });
  assert.equal(o.form, 'text');
  assert.equal(o.body, 'Well, it is raining out, there six oh five.');
  assert.deepEqual(o.params, {});
  assert.deepEqual(o.sfx, [{ name: 'rain', atChar: 32 }]);
  for (const d of ['laugh', 'emphasis', 'pace', 'pitch', 'direction']) assert.ok(o.dropped.includes(d), d);
  assert.equal(hasLeakedMarkers(o.body), false);
});

test('golden: SSML engine gets break/emphasis/prosody and valid escaping', () => {
  const o = degradeUtterance(utt('A & B {pause:400} {em}go{/em} <now>'), CAPS_SSML);
  assert.equal(o.form, 'ssml');
  assert.equal(o.body, '<speak><prosody rate="110%" pitch="+1st">A &amp; B <break time="400ms"/> <emphasis level="moderate">go</emphasis> &lt;now&gt;</prosody></speak>');
  assert.deepEqual(o.params, { rate: 1.1, pitchSemitones: 1 });
  assert.ok(o.dropped.includes('direction'));
  assert.equal(hasLeakedMarkers(o.body), false);
});

test('golden: rich engine maps style, direction, audio tags; ellipsis for long pauses', () => {
  const o = degradeUtterance(utt('Hmm {pause:800} sure {laugh} {breath}', { emotion: 'hype' }), CAPS_RICH);
  assert.equal(o.form, 'text');
  assert.equal(o.body, 'Hmm... sure [laughs] [sighs]');
  assert.deepEqual(o.params, { rate: 1.1, engineStyle: 'excited', direction: 'dry' });
  assert.ok(!o.dropped.includes('laugh'));
});

test('degrade: any utterance/caps combination is marker-free and never throws', () => {
  const texts = [RICH, '{{time.daypart}} {pause:50}', '{bogus} {em}', 'plain', '', '{sfx:a}{sfx:b}'];
  for (const caps of [CAPS_NONE, CAPS_SSML, CAPS_RICH, undefined, {}]) {
    for (const t of texts) {
      const o = degradeUtterance(utt(t), caps);
      assert.equal(hasLeakedMarkers(o.body.replace(/<[^>]+>/g, '')), false, t);
    }
  }
  assert.equal(degradeUtterance(null, CAPS_SSML).body, '<speak></speak>');
});

test('templates: spoken time, daypart and date', () => {
  const r = templateResolver({ hour: 18, minute: 0, daypart: 'evening', weekday: 'Wednesday', month: 11, day: 4 });
  assert.equal(r('time.spoken'), "six o'clock");
  assert.equal(r('time.daypart'), 'this evening');
  assert.equal(r('date.spoken'), 'Wednesday, November four');
  assert.equal(templateResolver({})('time.spoken'), '');
});

test('numbers: digits, spelled numbers and compounds; bare "one" is not a claim', () => {
  const v = (t) => extractNumbers(t).map((n) => n.value);
  assert.deepEqual(v('about 18 degrees'), [18]);
  assert.deepEqual(v('eighteen degrees, twenty-five or twenty five'), [18, 25, 25]);
  assert.deepEqual(v('one of those days'), []);
  assert.deepEqual(v('twenty-one and one hundred ten'), [21, 110]);
  assert.deepEqual(v('1,200 at 6:45'), [1200, 6, 45]);
  assert.deepEqual(v('two thousand twenty six'), [2026]);
  assert.deepEqual(v('five five'), [5, 5]);
  assert.equal(numberToWords(45), 'forty-five');
  assert.equal(numberToWords(1907), 'nineteen hundred seven'.replace('nineteen hundred seven', 'one thousand nine hundred seven'));
  assert.equal(numberMatches(18, 17.6), true);
  assert.equal(numberMatches(19, 17.6), false);
});
