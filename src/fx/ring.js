// ─────────────────────────────────────────────────────────────────────────────
// ring.js — the light ring: colour and intensity from the mode and the hand speed (pure; the canvas drawing is in ui.js).
// Runout's own palette: each mode has a base hue; speed pushes the hue along a violet -> cyan -> lime path, and past RAINBOW_AT
// the ring breaks into a slowly rotating spectrum. prefers-reduced-motion: no rotation, no pulsing, no spectrum (colour only).
// ─────────────────────────────────────────────────────────────────────────────

export const RING_KNOBS = Object.freeze({
  speedFull: 6,          // |spin| (relative to nominal) that counts as "full speed"
  rainbowAt: 0.85,       // speed (0..1) beyond which the ring turns into a spectrum
  idleAlpha: 0.38, heldAlpha: 0.55, maxAlpha: 0.95,
  idleWidth: 0.012, maxWidth: 0.04,   // as fractions of the ring radius
});

export const MODE_HUE = Object.freeze({ scratch: 262, blend: 318, repeat: 14, stutter: 44, bandpass: 192, echo: 160 });

export const ringSpeed = (spin, K = RING_KNOBS) => Math.max(0, Math.min(1, Math.abs(Number.isFinite(spin) ? spin : 0) / K.speedFull));

/**
 * -> { on, hue, sat, light, alpha, width, rainbow, rotate }   (hue/sat/light in CSS hsl units, alpha 0..1, width as radius fraction)
 * rainbow: spectrum spread over the ring; rotate: radians per second of the spectrum (0 when reduced motion).
 */
export function ringStyle({ mode = 'scratch', speed = 0, engaged = false, enabled = true, reduced = false, blocked = false } = {}, K = RING_KNOBS) {
  if (!enabled) return { on: false, hue: 0, sat: 0, light: 0, alpha: 0, width: 0, rainbow: false, rotate: 0 };
  const s = Math.max(0, Math.min(1, speed));
  const base = MODE_HUE[mode] ?? MODE_HUE.scratch;
  // speed drifts the hue toward cyan (190) then lime (110) via the short way round
  const toward = s < 0.5 ? 190 : 110;
  const k = s < 0.5 ? s * 2 : (s - 0.5) * 2;
  const from = s < 0.5 ? base : 190;
  const hue = ((from + (toward - from) * k) % 360 + 360) % 360;
  const rainbow = !reduced && engaged && s >= K.rainbowAt;
  const alphaTarget = blocked ? K.idleAlpha * 0.4 : engaged ? K.heldAlpha + (K.maxAlpha - K.heldAlpha) * s : K.idleAlpha + 0.25 * s;
  return {
    on: true, hue: Math.round(hue * 10) / 10, sat: 88, light: 62 + 8 * s,
    alpha: Math.round(alphaTarget * 1000) / 1000,
    width: K.idleWidth + (K.maxWidth - K.idleWidth) * (engaged ? 0.4 + 0.6 * s : s * 0.5),
    rainbow, rotate: rainbow ? 1.4 : 0,
  };
}
