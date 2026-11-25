// focus-trap.js — one small helper for every modal surface (sheets, dialogs, the tour, the search overlay).
//   const release = trapFocus(rootEl, { initial, onEscape, restore = true });
// On call: remembers the opener (document.activeElement) and moves focus into `rootEl` (to `initial`, else the first focusable, else the root
// itself). While active: Tab / Shift+Tab cycle inside `rootEl` (also pulled back in if focus escaped), Escape calls `onEscape` (when given;
// default behaviour of the page is stopped). Traps stack: only the topmost one reacts. `release()` removes the trap and puts focus back on the
// opener when it is still in the document. Safe to call release twice. Never throws.

const FOCUSABLE = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [tabindex], [role="slider"], [role="option"][tabindex]';
const stack = [];

function visible(el) {
  if (el.disabled || el.hidden || el.closest('[hidden], [inert]')) return false;
  const t = el.getAttribute('tabindex'); if (t !== null && Number(t) < 0) return false;
  try { return el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'; } catch { return true; }
}
export function focusables(root) { return [...root.querySelectorAll(FOCUSABLE)].filter(visible); }

let bound = false;
function onKey(e) {
  const top = stack[stack.length - 1]; if (!top) return;
  try {
    if (e.key === 'Escape' && top.onEscape && !e.defaultPrevented) { e.preventDefault(); e.stopPropagation(); top.onEscape(e); return; }
    if (e.key !== 'Tab') return;
    const f = focusables(top.root), a = document.activeElement;
    if (!f.length) { e.preventDefault(); top.root.focus && top.root.focus({ preventScroll: true }); return; }
    const i = f.indexOf(a), inside = top.root.contains(a);
    if (e.shiftKey && (i <= 0 || !inside)) { e.preventDefault(); f[f.length - 1].focus(); }
    else if (!e.shiftKey && (i === f.length - 1 || !inside)) { e.preventDefault(); f[0].focus(); }
  } catch { /* never throws */ }
}

export function trapFocus(root, o = {}) {
  if (!root) return () => {};
  const opener = document.activeElement;
  const me = { root, onEscape: o.onEscape || null };
  stack.push(me);
  if (!bound) { document.addEventListener('keydown', onKey, true); bound = true; }
  try {
    if (!root.hasAttribute('tabindex')) root.setAttribute('tabindex', '-1');
    const first = o.initial || focusables(root)[0] || root;
    first.focus({ preventScroll: true });
  } catch { /* */ }
  let done = false;
  return function release() {
    if (done) return; done = true;
    const i = stack.indexOf(me); if (i >= 0) stack.splice(i, 1);
    if (!stack.length && bound) { document.removeEventListener('keydown', onKey, true); bound = false; }
    if (o.restore !== false) { try { if (opener && opener.isConnected && opener.focus && opener !== document.body) opener.focus({ preventScroll: true }); } catch { /* */ } }
  };
}
