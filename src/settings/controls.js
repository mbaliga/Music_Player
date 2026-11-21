// controls.js — the Settings look, shared: DOM helper `h`, segmented choice `seg`, switch `sw`, slider `range`. Used by the Settings page and by the
// Device mode sheet so both read as one family (violet switches, segmented choices; no native checkboxes or <select>s). Styles: settings.css (.st-*).
export const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v; else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v); else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(String(k)));
  return e;
};

export function seg(label, options, get, set) {
  const wrap = h('div', { class: 'st-seg' + (options.length > 4 ? ' dense' : ''), role: 'radiogroup', 'aria-label': label });
  const btns = options.map((o) => h('button', { type: 'button', role: 'radio', 'data-v': String(o.value), onclick: () => { set(o.value); paint(); } }, o.label, o.sub ? h('small', {}, o.sub) : null));
  const paint = () => { const cur = String(get()); btns.forEach((b) => { const on = b.dataset.v === cur; b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; }); };
  wrap.addEventListener('keydown', (e) => {
    const i = btns.indexOf(document.activeElement);
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step || i < 0) return;
    e.preventDefault(); const n = btns[(i + step + btns.length) % btns.length]; n.focus(); n.click();
  });
  wrap.append(...btns); paint();
  return { el: wrap, paint };
}

export function sw(label, hint, get, set) {
  const btn = h('button', { type: 'button', class: 'st-switch', role: 'switch', onclick: () => { set(!get()); paint(); } },
    h('span', { class: 'st-track' }), h('span', { class: 'st-grow' }, h('span', { class: 'st-label' }, label), hint ? h('span', { class: 'st-hint' }, hint) : null));
  const paint = () => btn.setAttribute('aria-checked', String(!!get()));
  paint();
  return { el: btn, paint };
}


/** A slider with a live value readout: range(label, hint, {min,max,step?}, get, set, fmt?) -> { el, paint }. Commits on release, shows the value while dragging. */
export function range(label, hint, { min, max, step = 1 }, get, set, fmt = (v) => String(v)) {
  const val = h('span', { class: 'st-val' });
  const input = h('input', { class: 'st-range', type: 'range', min: String(min), max: String(max), step: String(step), 'aria-label': label });
  const paint = () => { input.value = String(get()); val.textContent = fmt(Number(input.value)); };
  input.addEventListener('input', () => { val.textContent = fmt(Number(input.value)); });
  input.addEventListener('change', () => { set(Number(input.value)); paint(); });
  const el = h('div', { class: 'st-row' }, h('div', { class: 'st-rangehead' }, h('div', { class: 'st-label' }, label), val), hint ? h('div', { class: 'st-hint' }, hint) : null, input);
  paint();
  return { el, paint };
}
