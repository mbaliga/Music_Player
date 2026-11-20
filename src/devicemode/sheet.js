// sheet.js — a temporary 'Device mode' settings sheet (a small gear beside the lock key). Replaced by a group in Settings once Workstream
// B's page hosts it; the data model (settings.js) is the same. Built from SPEC so a new setting appears automatically.
import { SPEC } from './settings.js';

const LABELS = {
  persistLock: ['Stay locked after restart', 'Off: a fresh launch always starts unlocked.'],
  unlockMethod: ['Unlock with', null, { hold: 'Press and hold', double: 'Double-tap', slide: 'Slide' }],
  fxPadWhileLocked: ['Allow the FX pad while locked', null],
  dimFrozen: ['Dim frozen areas slightly', null],
  keepAwakeMin: ['Keep the screen on for', 'Time without touching before the screen may sleep.', { 0: 'Never', 5: '5 min', 15: '15 min', 30: '30 min', 60: '60 min' }],
  neverTimeoutPlaying: ['Never time out while music plays', null],
  aodEnabled: ['Always-on display', 'A dim, minimal face while locked.'],
  aodIdleSec: ['Dim to always-on after', null, { 0: 'Off', 30: '30 s', 60: '1 min', 300: '5 min' }],
  aodWake: ['Wake the always-on display with', 'The buttons always work directly.', { double: 'Double-tap anywhere', long: 'Long-press anywhere', lockkey: 'Tap the lock key' }],
  aodBrightnessPct: ['Always-on brightness (%)', 'Android only.'],
  aodLowRefresh: ['Request low refresh rate', 'Android only; the system may ignore it.'],
  pixelShift: ['Burn-in protection (slow pixel shift)', null],
  glowPct: ['Button glow strength (%)', null],
};

export function openSheet({ settings, doc = document }) {
  if (doc.querySelector('.dm-sheet')) return;
  const ov = doc.createElement('div'); ov.className = 'dm-sheet'; ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-label', 'Device mode settings'); ov.setAttribute('aria-modal', 'true');
  const card = doc.createElement('div'); card.className = 'dm-sheet-card';
  const h = doc.createElement('h2'); h.textContent = 'Device mode'; card.append(h);
  const cur = settings.get();
  for (const key of Object.keys(SPEC)) {
    const s = SPEC[key], [label, help, names] = LABELS[key] || [key, null];
    const row = doc.createElement('label'); row.className = 'dm-row';
    const t = doc.createElement('span'); t.className = 'dm-row-t'; t.textContent = label;
    if (help) { const d = doc.createElement('small'); d.textContent = help; t.append(doc.createElement('br'), d); }
    let input;
    if (s.type === 'bool') { input = doc.createElement('input'); input.type = 'checkbox'; input.checked = !!cur[key]; input.addEventListener('change', () => settings.set({ [key]: input.checked })); }
    else if (s.type === 'enum') {
      input = doc.createElement('select');
      for (const v of s.allowed) { const o = doc.createElement('option'); o.value = String(v); o.textContent = (names && names[v]) || String(v); if (v === cur[key]) o.selected = true; input.append(o); }
      input.addEventListener('change', () => settings.set({ [key]: typeof s.allowed[0] === 'number' ? Number(input.value) : input.value }));
    } else { input = doc.createElement('input'); input.type = 'range'; input.min = s.min; input.max = s.max; input.value = cur[key]; input.addEventListener('change', () => settings.set({ [key]: Number(input.value) })); }
    row.append(t, input); card.append(row);
  }
  const done = doc.createElement('button'); done.type = 'button'; done.className = 'dm-done'; done.textContent = 'Done';
  const close = () => { ov.remove(); doc.removeEventListener('keydown', esc, true); };
  const esc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  done.addEventListener('click', close); ov.addEventListener('click', (e) => { if (e.target === ov) close(); }); doc.addEventListener('keydown', esc, true);
  card.append(done); ov.append(card); doc.body.append(ov); done.focus();
}
