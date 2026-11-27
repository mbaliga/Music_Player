// notify-rationale.js — the one-line in-app explanation shown BEFORE Android's notification permission dialog (API 33+), once.
// The first Play already raises the audio-library permission dialog; a second, unexplained OS dialog right behind it felt like an attack.
// So: ask in our own words first ("Allow" goes on to the OS dialog, "Not now" never asks again and playback is unaffected).
export const RATIONALE_KEY = 'runout.notifRationale.v1';
export const RATIONALE_TEXT = 'Show playback controls on your lock screen and in notifications?';

const read = (st) => { try { return st ? st.getItem(RATIONALE_KEY) : null; } catch { return null; } };
const write = (st, v) => { try { if (st) st.setItem(RATIONALE_KEY, v); } catch { /* */ } };

/**
 * show() -> Promise<'allow' | 'later'>  (the UI; dismissing it any other way counts as 'later')
 * Returns ask() -> Promise<boolean>: true = go on to the OS permission dialog. Resolves false at once when it was shown before.
 */
export function createRationale({ storage = null, show } = {}) {
  let inFlight = null;
  return function ask() {
    if (read(storage)) return Promise.resolve(false);              // once: whatever the answer was, we do not nag
    if (inFlight) return inFlight;
    inFlight = (async () => {
      let a = 'later';
      try { a = (await show()) === 'allow' ? 'allow' : 'later'; } catch { a = 'later'; }
      write(storage, a);
      return a === 'allow';
    })().finally(() => { inFlight = null; });
    return inFlight;
  };
}

/** The card. Browser only. Resolves 'allow' | 'later'. */
export function showRationaleCard({ doc = typeof document !== 'undefined' ? document : null, host = null } = {}) {
  return new Promise((resolve) => {
    if (!doc) { resolve('later'); return; }
    const card = doc.createElement('div'); card.className = 'nr-card'; card.setAttribute('role', 'dialog'); card.setAttribute('aria-label', 'Playback notification');
    const p = doc.createElement('p'); p.className = 'nr-text'; p.textContent = RATIONALE_TEXT;
    const row = doc.createElement('div'); row.className = 'nr-row';
    const later = doc.createElement('button'); later.type = 'button'; later.className = 'nr-btn'; later.textContent = 'Not now';
    const allow = doc.createElement('button'); allow.type = 'button'; allow.className = 'nr-btn nr-allow'; allow.textContent = 'Allow';
    row.append(later, allow); card.append(p, row);
    const done = (v) => { try { card.remove(); } catch { /* */ } resolve(v); };
    allow.addEventListener('click', () => done('allow'));
    later.addEventListener('click', () => done('later'));
    card.addEventListener('keydown', (e) => { if (e.key === 'Escape') done('later'); });
    (host || doc.body).appendChild(card);
    try { allow.focus(); } catch { /* */ }
  });
}
