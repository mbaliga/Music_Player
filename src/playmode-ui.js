// playmode-ui.js — shuffle + repeat controls, built from the Settings controls so they look and behave like the rest. Used by the stage's
// "Turntable settings" sheet; the Settings page builds the same two rows itself. The store (settings.js) is the single source of truth.
import { h, seg, sw } from './settings/controls.js';

export function mountPlayMode(host, store) {
  const shuffle = sw('Shuffle', 'Play the tracks of this album (or Play all) in a random order.', () => store.get('playback.shuffle'), (v) => store.set('playback.shuffle', v));
  const repeat = seg('Repeat', [{ value: 'off', label: 'Off' }, { value: 'all', label: 'All' }, { value: 'one', label: 'One' }], () => store.get('playback.repeat'), (v) => store.set('playback.repeat', v));
  const row = h('div', { class: 'st-row' }, h('div', { class: 'st-label' }, 'Repeat'), repeat.el);
  host.append(shuffle.el, row);
  const paint = () => { shuffle.paint(); repeat.paint(); };
  const off = store.subscribe(paint);
  return { paint, destroy() { try { off && off(); } catch { /* */ } } };
}
