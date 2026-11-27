// seekbar.js — a thin visible seek bar: tap or drag the track, arrow keys step. Used by the vinyl stage (src/turntable/stage.js) and the CD view.
//   const bar = createSeekBar({ label, onSeek(frac 0..1), onScrub?(frac), doc });  parent.append(bar.el);
//   bar.set(t, T)        paint the playhead (seconds); ignored while the finger is on the bar
//   bar.setEnabled(on)   false = a dim, inert bar (nothing loaded / a tape or station owns the engine)
// The 4 px line is the drawing; the element itself is a 48 px tall touch target (styles: src/shell/chrome.css .rt-seek). A drag moves only the thumb;
// the seek is committed once, on release (a seek is a decode-free but audible jump: not one per pointermove).
export function createSeekBar({ label = 'Seek', onSeek = () => {}, onScrub = null, doc = typeof document !== 'undefined' ? document : null } = {}) {
  const el = doc.createElement('div');
  el.className = 'rt-seek'; el.setAttribute('role', 'slider'); el.setAttribute('tabindex', '0'); el.setAttribute('aria-label', label);
  el.setAttribute('aria-valuemin', '0'); el.setAttribute('aria-valuemax', '0'); el.setAttribute('aria-valuenow', '0');
  const track = doc.createElement('div'); track.className = 'rt-seek-track';
  const fill = doc.createElement('div'); fill.className = 'rt-seek-fill';
  const thumb = doc.createElement('div'); thumb.className = 'rt-seek-thumb';
  track.append(fill); el.append(track, thumb);
  let T = 0, frac = 0, drag = null, enabled = true;
  const fmt = (s) => { s = Math.max(0, Math.round(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const paint = (f) => { frac = Math.max(0, Math.min(1, f)); const p = (frac * 100).toFixed(2) + '%'; fill.style.width = p; thumb.style.left = p; };
  const fracAt = (e) => { const r = track.getBoundingClientRect(); return r.width > 0 ? Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) : 0; };
  function aria() { el.setAttribute('aria-valuemax', String(Math.round(T))); el.setAttribute('aria-valuenow', String(Math.round(frac * T))); el.setAttribute('aria-valuetext', T > 0 ? `${fmt(frac * T)} of ${fmt(T)}` : 'nothing playing'); }
  el.addEventListener('pointerdown', (e) => {
    if (!enabled || !(T > 0) || (e.pointerType === 'mouse' && e.button > 0)) return;
    e.preventDefault(); e.stopPropagation();
    drag = { id: e.pointerId };
    try { el.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
    el.classList.add('drag'); paint(fracAt(e)); aria(); if (onScrub) onScrub(frac);
  });
  el.addEventListener('pointermove', (e) => { if (!drag || e.pointerId !== drag.id) return; paint(fracAt(e)); aria(); if (onScrub) onScrub(frac); });
  const end = (commit) => (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null; el.classList.remove('drag');
    try { el.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    if (commit) { paint(fracAt(e)); aria(); onSeek(frac); }
  };
  el.addEventListener('pointerup', end(true)); el.addEventListener('pointercancel', end(false));
  el.addEventListener('keydown', (e) => {
    if (!enabled || !(T > 0)) return;
    const step = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 5 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -5 : e.key === 'PageUp' ? 30 : e.key === 'PageDown' ? -30 : 0;
    let f = null;
    if (step) f = (frac * T + step) / T; else if (e.key === 'Home') f = 0; else if (e.key === 'End') f = 0.98;
    if (f == null) return;
    e.preventDefault(); e.stopPropagation(); paint(f); aria(); onSeek(frac);
  });
  paint(0); aria();
  return {
    el,
    get dragging() { return !!drag; },
    set(t, total) { T = total > 0 ? total : 0; if (!drag) { paint(T > 0 ? t / T : 0); aria(); } },
    setEnabled(on) { enabled = !!on; el.classList.toggle('off', !enabled); el.setAttribute('aria-disabled', String(!enabled)); el.tabIndex = enabled ? 0 : -1; if (!enabled) { T = 0; paint(0); aria(); } },
  };
}
