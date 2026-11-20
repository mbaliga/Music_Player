// lockkey.js — the physical-style latching lock key (DOM). A recessed housing with a sliding thumb carrying a padlock glyph and a small LED
// that lights while locked. Tap = lock. Unlock = press-and-hold (a ring fills), or double-tap, or slide, per setting. 44 px target.
// A11y: a real <button>, aria-pressed, label 'Lock controls' / 'Hold to unlock'. Keyboard: Enter toggles; hold Space to unlock.
// Assistive-technology activation (a click with detail 0) toggles directly: TalkBack must always be able to reach the unlock control.
export const HOLD_MS = 800;
export const DOUBLE_MS = 350;
export const SLIDE_PX = 22;

const LOCK = '<svg class="dm-glyph" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"><rect x="3" y="7" width="10" height="7" rx="1.6" fill="currentColor"/><path d="M5.2 7V5.2a2.8 2.8 0 0 1 5.6 0V7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
const RING = '<svg class="dm-ring" viewBox="0 0 44 44" aria-hidden="true" focusable="false"><circle class="dm-ring-bg" cx="22" cy="22" r="20"/><circle class="dm-ring-fg" cx="22" cy="22" r="20" pathLength="100"/></svg>';

/** Pure: is the second tap a deliberate double tap? */
export const isDoubleTap = (prevMs, ms, gap = DOUBLE_MS) => Number.isFinite(prevMs) && ms - prevMs > 0 && ms - prevMs <= gap;
/** Pure: how far through a slide (0..1) */
export const slideProgress = (dx, span = SLIDE_PX) => Math.max(0, Math.min(1, dx / span));

/**
 * deps = { host, floating?, getLocked(), getMethod(), onLock(), onUnlock(), onHint(msg), onTick?(), reduced():bool, haptic?(ms) }
 * Returns { el, setLocked(b), destroy() }.
 */
export function createLockKey(deps) {
  const el = document.createElement('button');
  el.type = 'button'; el.className = 'dm-key' + (deps.floating ? ' dm-key-float' : '');
  el.innerHTML = `${RING}<span class="dm-housing"><span class="dm-thumb">${LOCK}</span></span><span class="dm-led" aria-hidden="true"></span>`;
  const thumb = el.querySelector('.dm-thumb'), fg = el.querySelector('.dm-ring-fg');
  let holdT = 0, lastTap = NaN, slide = null, space = false;

  const paint = () => {
    const l = deps.getLocked();
    el.setAttribute('aria-pressed', String(l));
    el.setAttribute('aria-label', l ? 'Hold to unlock' : 'Lock controls');
    el.title = l ? (deps.getMethod() === 'hold' ? 'Hold to unlock' : deps.getMethod() === 'double' ? 'Double-tap to unlock' : 'Slide to unlock') : 'Lock controls';
    el.dataset.locked = String(l);
    thumb.style.transform = '';
  };
  const ring = (on) => {
    el.classList.toggle('dm-holding', on);
    fg.style.transition = on ? `stroke-dashoffset ${HOLD_MS}ms linear` : 'none';
    fg.style.strokeDashoffset = on ? '0' : '100';
  };
  const stopHold = () => { if (holdT) { clearTimeout(holdT); holdT = 0; } ring(false); };
  const startHold = () => {
    stopHold(); ring(false); void el.getBoundingClientRect(); ring(true);
    holdT = setTimeout(() => { holdT = 0; ring(false); deps.onUnlock(); }, HOLD_MS);
  };

  el.addEventListener('pointerdown', (e) => {
    if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
    if (!deps.getLocked()) return;                    // locking happens on release (a tap)
    const m = deps.getMethod();
    if (m === 'hold') startHold();
    else if (m === 'slide') { slide = { x0: e.clientX, id: e.pointerId }; try { el.setPointerCapture(e.pointerId); } catch { /* synthetic */ } }
  });
  el.addEventListener('pointermove', (e) => {
    if (!slide || e.pointerId !== slide.id) return;
    const p = slideProgress(e.clientX - slide.x0); thumb.style.transform = `translateX(${-SLIDE_PX * p}px)`;
    if (p >= 1) { slide = null; deps.onUnlock(); }
  });
  const up = (e) => {
    if (e.type === 'pointercancel') { stopHold(); slide = null; paint(); return; }
    const wasHolding = !!holdT, hadSlide = !!slide;
    stopHold(); if (slide) { slide = null; paint(); }
    if (!e.isPrimary) return;
    if (!deps.getLocked()) { deps.onLock(); return; }
    const m = deps.getMethod();
    if (m === 'double') { const t = e.timeStamp; if (isDoubleTap(lastTap, t)) { lastTap = NaN; deps.onUnlock(); } else { lastTap = t; deps.onHint('Double-tap to unlock'); } }
    else if (m === 'hold' && wasHolding) deps.onHint('Hold to unlock');
    else if (m === 'slide' && hadSlide) deps.onHint('Slide to unlock');
    deps.onTick && deps.onTick();
  };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('pointerleave', () => { if (holdT) stopHold(); });
  el.addEventListener('contextmenu', (e) => e.preventDefault());

  // keyboard + assistive technology
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); if (!e.repeat) (deps.getLocked() ? deps.onUnlock() : deps.onLock()); }
    else if (e.key === ' ') { e.preventDefault(); e.stopPropagation(); if (!e.repeat && !space) { space = true; if (deps.getLocked()) startHold(); else deps.onLock(); } }
  });
  el.addEventListener('keyup', (e) => { if (e.key === ' ') { e.preventDefault(); space = false; stopHold(); } });
  el.addEventListener('blur', () => { space = false; stopHold(); });
  el.addEventListener('click', (e) => {
    if (e.detail !== 0) return;                    // a real pointer click was handled above; detail 0 = keyboard / TalkBack action
    if (e.pointerType) return;
    if (document.activeElement === el && space) return;
    deps.getLocked() ? deps.onUnlock() : deps.onLock();
  });

  paint();
  deps.host.append(el);
  return { el, setLocked: paint, repaint: paint, destroy() { stopHold(); el.remove(); } };
}
