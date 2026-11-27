// sleep-ui.js — the sleep timer's controls (Settings > Playback and the stage sheet) and the small countdown chip. DOM only; the model is sleep.js.
import { h, seg } from './settings/controls.js';
import { SLEEP_MINUTES, formatLeft } from './sleep.js';

const OPTIONS = [{ value: 'off', label: 'Off' }, ...SLEEP_MINUTES.map((m) => ({ value: m, label: `${m} min` })), { value: 'end', label: 'End of track' }];

/** One line saying what the timer is doing. */
export function describe(st) {
  if (!st || st.mode === 'off') return 'Off. Music keeps playing until you stop it.';
  if (st.mode === 'end') return st.remainingSec == null ? 'Stops when the current track ends (radio has no track end: pick minutes instead).' : `Stops at the end of this track, in ${formatLeft(st.remainingSec)}.`;
  return `Stops in ${formatLeft(st.remainingSec)}${st.fading ? ' (fading out)' : ''}.`;
}

/** Mount the control into `host`. Returns { paint, destroy }. */
export function mountSleep(host, sleep) {
  const get = () => { const s = sleep.state(); return s.mode === 'off' ? 'off' : s.spec; };
  const set = (v) => { if (v === 'off') sleep.cancel(); else sleep.start(v === 'end' ? 'end' : Number(v)); };
  const control = seg('Sleep timer', OPTIONS, get, set);
  control.el.classList.add('sl-seg');
  const line = h('div', { class: 'st-hint sl-line', role: 'status', 'aria-live': 'off' });
  host.append(control.el, line);
  const paint = () => { control.paint(); line.textContent = describe(sleep.state()); };
  paint();
  const off = sleep.subscribe(paint);
  return { paint, destroy() { try { off(); } catch { /* */ } } };
}

/** The countdown chip on the Albums page: shown while a timer runs; a tap opens the controls. */
export function mountSleepChip(host, sleep, { onTap } = {}) {
  const b = h('button', { type: 'button', class: 'sl-chip', id: 'sleepChip', hidden: true });
  b.addEventListener('click', () => { try { onTap && onTap(); } catch { /* */ } });
  host.appendChild(b);
  const paint = () => {
    const st = sleep.state();
    if (st.mode === 'off') { b.hidden = true; return; }
    const left = st.remainingSec == null ? 'end of track' : formatLeft(st.remainingSec);
    b.textContent = `Sleep ${left}`; b.setAttribute('aria-label', `Sleep timer: ${describe(st)} Tap to change.`); b.hidden = false;
  };
  paint();
  const off = sleep.subscribe(paint);
  return { el: b, paint, destroy() { try { off(); } catch { /* */ } } };
}
