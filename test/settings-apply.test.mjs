import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planAppearance, applyPlan, installMotionOverride, THEME_COLOR, modeOfTheme } from '../src/settings/apply.js';
import { defaults } from '../src/settings/settings.js';
import { builtinThemeTemplate, parseTheme, THEME_CSS_VARS } from '../src/theme.js';

const S = (o = {}) => { const d = defaults(); Object.assign(d.appearance, o); return d; };
const custom = parseTheme(JSON.stringify({ ...builtinThemeTemplate('mine'), colors: { ...builtinThemeTemplate().colors, dark: { ...builtinThemeTemplate().colors.dark, background: '#102030' } } })).theme;

test('plan: OLED black is today\'s dark look (no tone), Dark is the soft tone, Light is light', () => {
  const o = planAppearance(S({ theme: 'oled' })), d = planAppearance(S({ theme: 'dark' })), l = planAppearance(S({ theme: 'light' }));
  assert.deepEqual([o.attrs['data-theme'], o.attrs['data-tone']], ['dark', null]);
  assert.deepEqual([d.attrs['data-theme'], d.attrs['data-tone']], ['dark', 'soft']);
  assert.deepEqual([l.attrs['data-theme'], l.attrs['data-tone']], ['light', null]);
  assert.deepEqual([o.metaColor, d.metaColor, l.metaColor], [THEME_COLOR.oled, THEME_COLOR.dark, THEME_COLOR.light]);
  assert.equal(modeOfTheme('x'), 'dark');
});
test('plan: accent sets vars only for a non-default accent and only without a custom theme', () => {
  assert.equal(planAppearance(S({ accent: 'violet' })).accent, null);
  const p = planAppearance(S({ accent: 'orange', theme: 'light' }));
  assert.equal(p.accent.vars['--violet'], '#FE5031'); assert.match(p.accent.vars['--violet-glow'], /0\.18\)$/);
  const c = planAppearance(S({ accent: 'orange' }), { customTheme: custom });
  assert.equal(c.accent, null); assert.equal(c.customMode, 'dark'); assert.equal(c.attrs['data-tone'], null); assert.equal(c.metaColor, '#102030');
  assert.equal(planAppearance(S({ accent: 'orange' })).customMode, null);
});
test('plan: text size and motion attributes; junk settings fall back safely', () => {
  assert.equal(planAppearance(S({ textSize: 'large' })).attrs['data-text'], 'large'); assert.equal(planAppearance(S({ textSize: 'default' })).attrs['data-text'], null);
  assert.equal(planAppearance(S({ reduceMotion: 'reduce' })).attrs['data-motion'], 'reduce'); assert.equal(planAppearance(S()).attrs['data-motion'], null);
  for (const bad of [null, undefined, {}, { appearance: { theme: 'x', accent: 'nope' } }, 5]) { const p = planAppearance(bad); assert.equal(p.attrs['data-theme'], 'dark'); }
});

// a tiny fake root
function fakeRoot() {
  const attrs = new Map(), props = new Map();
  return { attrs, props, setAttribute: (k, v) => attrs.set(k, v), removeAttribute: (k) => attrs.delete(k), style: { setProperty: (k, v) => props.set(k, v), removeProperty: (k) => props.delete(k) } };
}
test('applyPlan writes attributes, theme vars XOR accent vars, and the meta colour', () => {
  const root = fakeRoot(); const meta = { v: '', setAttribute(k, v) { this.v = v; } };
  let cleared = 0; const set = [];
  const io = { root, meta, setThemeVars: (t, m) => set.push([t.name, m]), clearThemeVars: () => { cleared++; root.props.delete('--bg'); } };
  applyPlan(planAppearance(S({ theme: 'dark', accent: 'teal', textSize: 'small' })), io);
  assert.equal(root.attrs.get('data-theme'), 'dark'); assert.equal(root.attrs.get('data-tone'), 'soft'); assert.equal(root.attrs.get('data-text'), 'small');
  assert.equal(root.props.get('--violet'), '#2EC4B6'); assert.equal(cleared, 1); assert.equal(meta.v, THEME_COLOR.dark);
  applyPlan(planAppearance(S({ theme: 'oled' }), { customTheme: custom }), { ...io, customTheme: custom });
  assert.deepEqual(set, [['mine', 'dark']]); assert.equal(root.attrs.has('data-tone'), false);
  assert.equal(root.props.has('--on-accent'), false);
  applyPlan(planAppearance(S({ accent: 'violet' })), io);                              // back to default: every accent var removed again
  assert.equal(root.props.has('--violet'), false); assert.equal(root.props.has('--violet-glow'), false);
  assert.ok(THEME_CSS_VARS.includes('--violet'));
});
test('motion override: only the reduce query is answered, only when forced; installs once; never throws', () => {
  let forced = false;
  const win = { matchMedia: (q) => ({ matches: q.includes('reduce') ? false : true, media: q, addEventListener() {} }), document: {} };
  assert.equal(installMotionOverride(win, () => forced), true); assert.equal(installMotionOverride(win, () => forced), false);
  assert.equal(win.matchMedia('(prefers-reduced-motion: reduce)').matches, false);
  forced = true;
  assert.equal(win.matchMedia('(prefers-reduced-motion: reduce)').matches, true);
  assert.equal(typeof win.matchMedia('(prefers-reduced-motion: reduce)').addEventListener, 'function');
  assert.equal(win.matchMedia('(prefers-color-scheme: dark)').matches, true);
  assert.equal(installMotionOverride({}), false); assert.equal(installMotionOverride(null), false);
});
