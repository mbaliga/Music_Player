// dom.js — tiny DOM helpers for the cassette UI. Everything user-supplied goes through
// textContent / setAttribute (never innerHTML), so hostile titles can only ever be text.

/** h('div', { class: 'x', onclick }, child, 'text', [more]) */
export function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') e.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(2)) if (c != null && c !== false) e.append(c);
  return e;
}

const NS = 'http://www.w3.org/2000/svg';
/** Inline SVG icon from a path (static markup written here, never user data). */
export function icon(d, { size = 18, stroke = 2, fill = 'none' } = {}) {
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', size); s.setAttribute('height', size);
  s.setAttribute('fill', fill); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', stroke);
  s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); s.append(p);
  return s;
}
export const ICONS = {
  back: 'M15 5l-7 7 7 7',
  play: 'M7 4l13 8-13 8z',
  dots: 'M12 5v.01M12 12v.01M12 19v.01',
  grip: 'M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01',
  plus: 'M12 5v14M5 12h14',
  check: 'M5 12l5 5 9-10',
  chev: 'M9 6l6 6-6 6',
  flip: 'M4 9a8 8 0 0 1 14-3M20 15a8 8 0 0 1-14 3M17 3v4h-4M7 21v-4h4',
  up: 'M6 15l6-6 6 6',
  down: 'M6 9l6 6 6-6',
  x: 'M6 6l12 12M18 6L6 18',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
};

export const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
