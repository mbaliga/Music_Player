// ─────────────────────────────────────────────────────────────────────────────
// theme.test.mjs — correctness gate for the JSON custom-theme parser/validator.
//
// Mirrors the shared schema tested in the same way across the Fylz/Fyl-Manager
// and Fotoz/Foto-Xplorr apps: every malformed shape must be refused with a
// specific, named reason (never a generic "invalid JSON"), and a valid theme
// (6- or 8-digit hex) must round-trip untouched.
//
// Dependency-free: node:test + node:assert only, same as model.test.mjs.
// ─────────────────────────────────────────────────────────────────────────────

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PALETTE_KEYS, parseTheme, validateHexColor,
  hexToRgb, hexToCssColor, withAlpha, CSS_VAR_MAP,
} from '../src/theme.js';

function validColors(overrides = {}) {
  return {
    primary: '#8E7BFF', secondary: '#5AA9E6', tertiary: '#E67BAE',
    background: '#000000', surface: '#0D0D12', surfaceVariant: '#16161E',
    onBackground: '#E8E8F0', onSurface: '#E8E8F0',
    ...overrides,
  };
}

function validThemeObj() {
  return {
    version: 1,
    name: 'My Theme',
    colors: {
      light: validColors({ background: '#EBEBF2', surface: '#FFFFFF', surfaceVariant: '#E0E0EA', onBackground: '#0E0E1A', onSurface: '#0E0E1A' }),
      dark: validColors(),
    },
  };
}

// ── Valid round-trip ──────────────────────────────────────────────────────────

test('parseTheme accepts a well-formed theme and returns it normalized', () => {
  const result = parseTheme(JSON.stringify(validThemeObj()));
  assert.equal(result.ok, true);
  assert.equal(result.theme.version, 1);
  assert.equal(result.theme.name, 'My Theme');
  assert.deepEqual(Object.keys(result.theme.colors).sort(), ['dark', 'light']);
  for (const mode of ['light', 'dark']) {
    for (const key of PALETTE_KEYS) {
      assert.equal(typeof result.theme.colors[mode][key], 'string');
    }
  }
});

test('parseTheme accepts 8-digit #AARRGGBB hex as a superset', () => {
  const obj = validThemeObj();
  obj.colors.dark.primary = '#80FF0000'; // 50% alpha red
  const result = parseTheme(JSON.stringify(obj));
  assert.equal(result.ok, true);
  assert.equal(result.theme.colors.dark.primary, '#80FF0000');
});

test('parseTheme defaults a missing/blank "name" rather than refusing the theme', () => {
  const obj = validThemeObj();
  delete obj.name;
  const result = parseTheme(JSON.stringify(obj));
  assert.equal(result.ok, true);
  assert.equal(result.theme.name, 'Custom theme');
});

// ── Malformed cases: each must be refused with a specific, named reason ──────

test('rejects text that is not parseable as JSON at all', () => {
  const result = parseTheme('{not json');
  assert.equal(result.ok, false);
  assert.match(result.error, /^Not valid JSON:/);
});

test('rejects a JSON value that is not an object', () => {
  const result = parseTheme('[1,2,3]');
  assert.equal(result.ok, false);
  assert.match(result.error, /must be a JSON object/);
});

test('rejects a missing "version" field', () => {
  const obj = validThemeObj();
  delete obj.version;
  const result = parseTheme(JSON.stringify(obj));
  assert.equal(result.ok, false);
  assert.match(result.error, /Missing "version"/);
});

test('rejects a wrong "version" value', () => {
  const obj = validThemeObj();
  obj.version = 2;
  const result = parseTheme(JSON.stringify(obj));
  assert.equal(result.ok, false);
  assert.match(result.error, /Unsupported "version": 2/);
});

test('rejects a missing "colors" object', () => {
  const obj = validThemeObj();
  delete obj.colors;
  const result = parseTheme(JSON.stringify(obj));
  assert.equal(result.ok, false);
  assert.match(result.error, /Missing "colors" object/);
});

test('rejects a missing "colors.light" object', () => {
  const obj = validThemeObj();
  delete obj.colors.light;
  const result = parseTheme(JSON.stringify(obj));
  assert.equal(result.ok, false);
  assert.match(result.error, /Missing "colors\.light" object/);
});

test('rejects a missing "colors.dark" object', () => {
  const obj = validThemeObj();
  delete obj.colors.dark;
  const result = parseTheme(JSON.stringify(obj));
  assert.equal(result.ok, false);
  assert.match(result.error, /Missing "colors\.dark" object/);
});

test('rejects a missing key, naming the exact field (e.g. colors.dark.primary)', () => {
  const obj = validThemeObj();
  delete obj.colors.dark.primary;
  const result = parseTheme(JSON.stringify(obj));
  assert.equal(result.ok, false);
  assert.match(result.error, /Missing "colors\.dark\.primary"/);
});

test('every one of the 8 keys is checked, per mode, by name', () => {
  for (const mode of ['light', 'dark']) {
    for (const key of PALETTE_KEYS) {
      const obj = validThemeObj();
      delete obj.colors[mode][key];
      const result = parseTheme(JSON.stringify(obj));
      assert.equal(result.ok, false, `${mode}.${key} should have failed`);
      assert.match(result.error, new RegExp(`Missing "colors\\.${mode}\\.${key}"`));
    }
  }
});

test('rejects a hex value missing the leading "#"', () => {
  const obj = validThemeObj();
  obj.colors.light.secondary = '8E7BFF';
  const result = parseTheme(JSON.stringify(obj));
  assert.equal(result.ok, false);
  assert.match(result.error, /colors\.light\.secondary/);
  assert.match(result.error, /missing leading "#"/);
});

test('rejects a hex value of the wrong length', () => {
  const obj = validThemeObj();
  obj.colors.dark.tertiary = '#12345';
  const result = parseTheme(JSON.stringify(obj));
  assert.equal(result.ok, false);
  assert.match(result.error, /colors\.dark\.tertiary/);
  assert.match(result.error, /"#12345"/);
  assert.match(result.error, /expected 6 or 8 hex digits/);
});

test('rejects a hex value with a non-hex digit', () => {
  const obj = validThemeObj();
  obj.colors.light.onSurface = '#GGGGGG';
  const result = parseTheme(JSON.stringify(obj));
  assert.equal(result.ok, false);
  assert.match(result.error, /colors\.light\.onSurface/);
  assert.match(result.error, /non-hex digit/);
});

test('rejects a non-string hex value', () => {
  const obj = validThemeObj();
  obj.colors.dark.background = 123456;
  const result = parseTheme(JSON.stringify(obj));
  assert.equal(result.ok, false);
  assert.match(result.error, /colors\.dark\.background/);
});

test('never throws — every malformed input returns a result object', () => {
  const inputs = ['', 'null', 'true', '42', '"just a string"', '{"version":1}', '{{{{'];
  for (const input of inputs) {
    assert.doesNotThrow(() => parseTheme(input));
    const result = parseTheme(input);
    assert.equal(result.ok, false);
    assert.equal(typeof result.error, 'string');
    assert.ok(result.error.length > 0);
  }
});

// ── validateHexColor (standalone) ────────────────────────────────────────────

test('validateHexColor accepts both 6- and 8-digit hex, rejects everything else', () => {
  assert.equal(validateHexColor('#8E7BFF', 'x'), null);
  assert.equal(validateHexColor('#80FF0000', 'x'), null);
  assert.notEqual(validateHexColor('8E7BFF', 'x'), null);
  assert.notEqual(validateHexColor('#8E7BF', 'x'), null);
  assert.notEqual(validateHexColor('#8E7BFFZZ', 'x'), null);
  assert.notEqual(validateHexColor(null, 'x'), null);
});

// ── Color math helpers ────────────────────────────────────────────────────────

test('hexToRgb parses 6-digit hex as fully opaque', () => {
  assert.deepEqual(hexToRgb('#8E7BFF'), { r: 0x8E, g: 0x7B, b: 0xFF, a: 1 });
});

test('hexToRgb parses 8-digit hex as AARRGGBB (alpha first, Android order)', () => {
  const { r, g, b, a } = hexToRgb('#80FF0000');
  assert.equal(r, 0xFF);
  assert.equal(g, 0x00);
  assert.equal(b, 0x00);
  assert.ok(Math.abs(a - 128 / 255) < 1e-9);
});

test('hexToCssColor passes 6-digit hex straight through', () => {
  assert.equal(hexToCssColor('#8E7BFF'), '#8E7BFF');
});

test('hexToCssColor converts 8-digit hex into an rgba() with the right alpha', () => {
  const css = hexToCssColor('#80FF0000');
  assert.match(css, /^rgba\(255, 0, 0, 0\.\d+\)$/);
});

test('withAlpha recombines a hex color\'s RGB with a caller-supplied alpha', () => {
  assert.equal(withAlpha('#8E7BFF', 0.5), 'rgba(142, 123, 255, 0.5)');
  // Ignores the source's own alpha, if it had one.
  assert.equal(withAlpha('#8000FF00', 0.5), 'rgba(0, 255, 0, 0.5)');
});

// ── CSS var mapping ───────────────────────────────────────────────────────────

test('CSS_VAR_MAP covers every schema key except the derived/left-alone ones', () => {
  // secondary/tertiary/onBackground/onSurface/primary/background/surface/
  // surfaceVariant are direct 1:1 mappings; --violet-glow and --ink2 are
  // derived (tested via setThemeVars in the browser check, not here — they
  // need `document`), and --border is intentionally left untouched.
  const mapped = new Set(Object.keys(CSS_VAR_MAP));
  for (const key of PALETTE_KEYS) assert.ok(mapped.has(key), `${key} should be mapped`);
  assert.equal(CSS_VAR_MAP.primary, '--violet');
  assert.equal(CSS_VAR_MAP.secondary, '--secondary');
  assert.equal(CSS_VAR_MAP.tertiary, '--tertiary');
  assert.equal(CSS_VAR_MAP.onBackground, '--ink-bg');
  assert.equal(CSS_VAR_MAP.onSurface, '--ink');
});
