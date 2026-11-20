import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCENT_PRESETS, DEFAULT_ACCENT, resolveAccent, accentVars, relativeLuminance, contrastRatio, onAccent, builtinThemeTemplate, exportThemeText, parseTheme, ACCENT_CSS_VARS,
} from '../src/theme.js';

test('presets: violet is the default, the logo orange is #FE5031, ids and hexes are unique and valid', () => {
  assert.equal(DEFAULT_ACCENT, 'violet'); assert.equal(ACCENT_PRESETS[0].hex, '#8E7BFF');
  assert.equal(ACCENT_PRESETS.find((a) => a.id === 'orange').hex, '#FE5031');
  assert.equal(new Set(ACCENT_PRESETS.map((a) => a.id)).size, ACCENT_PRESETS.length); assert.equal(new Set(ACCENT_PRESETS.map((a) => a.hex)).size, ACCENT_PRESETS.length);
  for (const a of ACCENT_PRESETS) assert.match(a.hex, /^#[0-9A-F]{6}$/);
  assert.ok(ACCENT_PRESETS.length >= 6); assert.ok(Object.isFrozen(ACCENT_PRESETS));
});
test('resolveAccent: id, hex (any case), canonical preset for a preset hex, null for junk', () => {
  assert.deepEqual(resolveAccent('orange'), { id: 'orange', hex: '#FE5031' });
  assert.deepEqual(resolveAccent('#fe5031'), { id: 'orange', hex: '#FE5031' });
  assert.deepEqual(resolveAccent('#0a1b2c'), { id: '#0a1b2c', hex: '#0A1B2C' });
  for (const b of [null, undefined, 3, '', '#fff', '#GGGGGG', 'rgb(0,0,0)', '#12345678', '<script>', 'expression(1)']) assert.equal(resolveAccent(b), null);
});
test('contrast math: black/white extremes and known WCAG values', () => {
  assert.ok(Math.abs(contrastRatio('#000000', '#FFFFFF') - 21) < 0.01); assert.ok(Math.abs(contrastRatio('#777777', '#777777') - 1) < 1e-9);
  assert.ok(relativeLuminance('#FFFFFF') > 0.99 && relativeLuminance('#000000') < 0.001);
  assert.ok(Math.abs(contrastRatio('#FF0000', '#FFFFFF') - 3.998) < 0.01);
  assert.equal(onAccent('#FFB020'), '#111111'); assert.equal(onAccent('#2EC4B6'), '#111111'); assert.equal(onAccent('#8E7BFF'), '#111111' === onAccent('#8E7BFF') ? '#111111' : '#FFFFFF');
  assert.equal(onAccent('#000000'), '#FFFFFF'); assert.equal(onAccent('#FFFFFF'), '#111111');
  for (const a of ACCENT_PRESETS) assert.ok(contrastRatio(a.hex, onAccent(a.hex)) >= 3, a.id + ' label contrast');
});
test('accentVars: --violet, a mode-dependent glow, and the ink on accent; nothing for an invalid accent', () => {
  const d = accentVars('orange', 'dark'), l = accentVars('orange', 'light');
  assert.deepEqual(Object.keys(d), ACCENT_CSS_VARS);
  assert.equal(d['--violet'], '#FE5031'); assert.equal(d['--violet-glow'], 'rgba(254, 80, 49, 0.28)'); assert.equal(l['--violet-glow'], 'rgba(254, 80, 49, 0.18)');
  assert.equal(accentVars('orange', 'weird')['--violet-glow'], d['--violet-glow']);
  assert.equal(accentVars('nope'), null);
});
test('builtinThemeTemplate round-trips through parseTheme and Export text parses back to the same theme', () => {
  const t = builtinThemeTemplate();
  const r = parseTheme(JSON.stringify(t)); assert.equal(r.ok, true);
  const text = exportThemeText(r.theme);
  assert.equal(text, JSON.stringify(r.theme, null, 2)); assert.deepEqual(parseTheme(text).theme, r.theme);
  assert.equal(parseTheme(JSON.stringify({ ...t, name: '' })).theme.name, 'Custom theme');
});
