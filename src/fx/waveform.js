// waveform.js — turn the existing RMS envelope into drawable columns (pure).
/** `cols` peak columns (max over each envelope span), each in 0..1. */
export function waveColumns(envelope, cols) {
  const out = new Float32Array(Math.max(0, cols | 0));
  if (!envelope || !envelope.length || out.length === 0) return out;
  const n = envelope.length;
  for (let c = 0; c < out.length; c++) {
    const a = Math.floor((c / out.length) * n), b = Math.max(a + 1, Math.floor(((c + 1) / out.length) * n));
    let m = 0;
    for (let i = a; i < b && i < n; i++) if (envelope[i] > m) m = envelope[i];
    out[c] = m;
  }
  return out;
}
export const playheadFrac = (t, T) => (T > 0 ? Math.max(0, Math.min(1, t / T)) : 0);
/** The captured slice as [from, to] fractions of the track, ending at `tCapture` (repeat) or starting there (stutter). */
export function sliceSpan(tCapture, sliceSec, T, mode) {
  if (!(T > 0) || !(sliceSec > 0) || !Number.isFinite(tCapture)) return null;
  const a = mode === 'stutter' ? tCapture : tCapture - sliceSec;
  const f0 = Math.max(0, Math.min(1, a / T)), f1 = Math.max(0, Math.min(1, (a + sliceSec) / T));
  return f1 > f0 ? [f0, f1] : null;
}
