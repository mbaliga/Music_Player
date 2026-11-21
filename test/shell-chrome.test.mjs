import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pickNowPlaying } from '../src/shell/nowplaying.js';
import { STEPS } from '../src/walkthrough.js';
import { DEFAULT_FACES } from '../src/devicemode/default-faces.js';

test('mini bar: sources carry playing / canNext (default: playing, no next)', () => {
  const a = pickNowPlaying({ album: { title: 'A' } });
  assert.equal(a.playing, true); assert.equal(a.canNext, false);
  const m = pickNowPlaying({ mixtape: { title: 'M', playing: false, canNext: true } });
  assert.equal(m.playing, false); assert.equal(m.canNext, true);
});

test('the tour is short, plain and has no developer wording', () => {
  assert.ok(STEPS.length >= 4 && STEPS.length <= 5, 'four or five steps');
  const text = STEPS.map((s) => s.title + ' ' + s.body).join(' ');
  for (const bad of [/feel test/i, /\bJ\b.*\bk\b.*\bc\b/, /latency/i, /estimate/i, /this version/i, /knob/i, /\bJSON\b/, /\.md\b/, /backend/i, /\bAPI\b/])
    assert.ok(!bad.test(text), 'developer wording: ' + bad);
  for (const s of STEPS) assert.ok(s.body.length < 260, s.title + ' is short');
});

test('lock hints are short', () => {
  for (const [id, f] of Object.entries(DEFAULT_FACES)) assert.ok(f.notes.length <= 60, id + ' hint is short: ' + f.notes);
});

test('user-facing settings copy has no file names or docs-style phrases', () => {
  const src = readFileSync(new URL('../src/settings/page.js', import.meta.url), 'utf8') + readFileSync(new URL('../src/devicemode/sheet.js', import.meta.url), 'utf8');
  for (const bad of [/\.md\b/, /SHELL|SEARCH\.md|FX\.md/, /backend is ever/i, /folder picker scan/i, /stay in Deck details/i, /JSON;/]) assert.ok(!bad.test(src), 'docs wording: ' + bad);
  assert.ok(/Player surfaces stay dark/.test(src), 'Settings explains that player surfaces stay dark');
});
