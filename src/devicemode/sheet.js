// sheet.js — the Device mode options sheet, opened from Settings > Device mode. Full-screen on phones. Built from SPEC so a new setting appears
// automatically; the controls are the Settings page's own (switches, segmented choices, sliders: src/settings/controls.js), never native
// checkboxes or <select>s.
import { SPEC } from './settings.js';
import { trapFocus } from '../ui/focus-trap.js';
import { h, seg, sw, range } from '../settings/controls.js';

// key: [label, short helper text | null, { value: label } for choices]
const LABELS = {
  persistLock: ['Stay locked after restart', 'Off: the app always opens unlocked.'],
  unlockMethod: ['Unlock with', 'How you open the lock key.', { hold: 'Hold', double: 'Double-tap', slide: 'Slide' }],
  fxPadWhileLocked: ['Booth pad works while locked', null],
  dimFrozen: ['Dim what is locked', 'Locked parts look a little fainter.'],
  keepAwakeMin: ['Keep the screen on for', 'Without a touch, then the phone may sleep.', { 0: 'Always', 5: '5 min', 15: '15 min', 30: '30 min', 60: '1 hour' }],
  neverTimeoutPlaying: ['Stay on while music plays', null],
  aodEnabled: ['Always-on display', 'A dim clock and the song title while locked.'],
  aodIdleSec: ['Go dim after', null, { 0: 'Never', 30: '30 sec', 60: '1 min', 300: '5 min' }],
  aodWake: ['Wake it with', 'The buttons always work without waking it.', { double: 'Double-tap', long: 'Long press', lockkey: 'Lock key' }],
  aodBrightnessPct: ['Dim brightness', 'Android only.'],
  aodLowRefresh: ['Save battery when dim', 'Asks the screen to refresh less often. Android only.'],
  pixelShift: ['Protect the screen', 'Moves the picture a little each minute to avoid burn-in.'],
  glowPct: ['Button glow', null],
};
const GROUPS = [
  ['Locking', ['persistLock', 'unlockMethod', 'fxPadWhileLocked', 'dimFrozen']],
  ['Screen', ['keepAwakeMin', 'neverTimeoutPlaying']],
  ['Always-on display', ['aodEnabled', 'aodIdleSec', 'aodWake', 'aodBrightnessPct', 'aodLowRefresh', 'pixelShift', 'glowPct']],
];

export function openSheet({ settings, doc = document }) {
  if (doc.querySelector('.dm-sheet')) return;
  const painters = [];
  const control = (key) => {
    const s = SPEC[key], [label, help, names] = LABELS[key] || [key, null];
    const get = () => settings.get()[key], set = (v) => settings.set({ [key]: v });
    let c;
    if (s.type === 'bool') c = sw(label, help, get, set);
    else if (s.type === 'enum') {
      const num = typeof s.allowed[0] === 'number';
      const sg = seg(label, s.allowed.map((v) => ({ value: v, label: (names && names[v]) || String(v) })), get, (v) => set(num ? Number(v) : v));
      c = { el: h('div', { class: 'st-row' }, h('div', { class: 'st-label' }, label), help ? h('div', { class: 'st-hint' }, help) : null, sg.el), paint: sg.paint };
    } else c = range(label, help, { min: s.min, max: s.max }, get, set, (v) => v + '%');
    painters.push(c.paint);
    return c.el;
  };
  const used = new Set(GROUPS.flatMap((g) => g[1]));
  const groups = [...GROUPS, ['More', Object.keys(SPEC).filter((k) => !used.has(k))]].filter((g) => g[1].some((k) => SPEC[k]));

  const done = h('button', { type: 'button', class: 'dm-done' }, 'Done');
  const card = h('div', { class: 'dm-sheet-card' },
    h('div', { class: 'dm-sheet-head' }, h('h2', {}, 'Device mode'), done),
    h('p', { class: 'st-text dm-sheet-lead' }, 'Lock the screen so a stray touch does nothing while music plays. The lock key is in the top bar of every page.'),
    ...groups.map(([title, keys]) => h('section', { class: 'dm-group' }, h('h3', {}, title), ...keys.filter((k) => SPEC[k]).map(control))));
  const ov = h('div', { class: 'dm-sheet', role: 'dialog', 'aria-label': 'Device mode', 'aria-modal': 'true' }, card);
  const unsub = settings.subscribe ? settings.subscribe(() => { for (const p of painters) { try { p(); } catch { /* */ } } }) : null;
  let release = () => {};
  const close = () => { ov.remove(); release(); if (unsub) unsub(); };
  done.addEventListener('click', close); ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
  doc.body.append(ov); release = trapFocus(card, { initial: done, onEscape: close });
}
