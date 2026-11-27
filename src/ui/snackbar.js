// snackbar.js — one transient bar with an action ("Deleted “Night Drive”.  Undo"). One at a time: a new one replaces the old (the old action is no longer offered).
//   const s = showSnackbar('Deleted “Tape”.', { action: 'Undo', onAction: () => {...}, ms: 8000, onExpire: () => {...} });  s.dismiss();
// Text goes in through textContent. role=status so a screen reader hears it; the button is a real 48 px target. Styles: src/shell/chrome.css (.rt-snack).
let cur = null;

export function showSnackbar(text, { action = '', onAction = null, onExpire = null, ms = 8000, doc = typeof document !== 'undefined' ? document : null } = {}) {
  if (!doc || !doc.body) return { dismiss() {} };
  if (cur) cur.end(false);
  const el = doc.createElement('div'); el.className = 'rt-snack'; el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite');
  const msg = doc.createElement('span'); msg.className = 'rt-snack-msg'; msg.textContent = String(text);
  el.append(msg);
  let timer = 0, done = false;
  const me = {
    end(acted) {
      if (done) return; done = true; clearTimeout(timer); el.remove(); if (cur === me) cur = null;
      if (!acted && onExpire) { try { onExpire(); } catch { /* */ } }
    },
    dismiss() { me.end(false); },
  };
  if (action) {
    const b = doc.createElement('button'); b.type = 'button'; b.className = 'rt-snack-btn'; b.textContent = action;
    b.addEventListener('click', () => { if (done) return; me.end(true); if (onAction) { try { onAction(); } catch { /* */ } } });
    el.append(b);
  }
  doc.body.append(el);
  cur = me;
  timer = setTimeout(() => me.end(false), ms);
  return me;
}
