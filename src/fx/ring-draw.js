// ring-draw.js — draws the light ring (canvas 2D). The colour / intensity come from ring.js (pure); this only paints.
// An original design: a soft double stroke (halo + core) split into 48 arcs whose hue can spread into a slowly turning
// spectrum at high hand speed, with a faint "ferrofluid" radial shimmer (off under prefers-reduced-motion) and a bright
// marker at the finger. Painting is skipped when nothing changed and nothing animates.
const TAU = Math.PI * 2;
export const RING_SEGMENTS = 48;

/** A cheap signature of everything that changes the picture, so a static ring is painted once. */
export const ringSignature = (st, cx, cy, r, fingerAngle, t) => st.on
  ? `${st.hue}|${st.alpha}|${st.width}|${st.rainbow ? (st.rotate ? Math.floor(t / 40) : 1) : 0}|${cx | 0}|${cy | 0}|${r | 0}|${fingerAngle == null ? '' : fingerAngle.toFixed(2)}`
  : 'off';

export function drawRing(g, w, h, cx, cy, r, st, { t = 0, fingerAngle = null, shimmer = true, clear = true } = {}) {
  if (clear) g.clearRect(0, 0, w, h);
  if (!st.on || r <= 4) return;
  const core = Math.max(1.5, r * st.width), halo = core * 3.2;
  const spin = st.rainbow ? (t / 1000) * st.rotate : 0;
  for (let pass = 0; pass < 2; pass++) {
    g.lineWidth = pass === 0 ? halo : core;
    g.lineCap = 'butt';
    for (let i = 0; i < RING_SEGMENTS; i++) {
      const a0 = (i / RING_SEGMENTS) * TAU - Math.PI / 2, a1 = ((i + 1) / RING_SEGMENTS) * TAU - Math.PI / 2 + 0.012;
      const hue = st.rainbow ? ((i / RING_SEGMENTS) * 360 + spin * 57.3) % 360 : st.hue;
      const sh = shimmer && st.alpha > 0.3 ? Math.sin(i * 1.7 + t / 260) * core * 0.35 * Math.min(1, (st.width - 0.012) * 40) : 0;
      g.strokeStyle = `hsla(${hue},${st.sat}%,${st.light}%,${pass === 0 ? st.alpha * 0.22 : st.alpha})`;
      g.beginPath(); g.arc(cx, cy, r + sh, a0, a1); g.stroke();
    }
  }
  if (fingerAngle != null) {
    const x = cx + Math.cos(fingerAngle) * r, y = cy + Math.sin(fingerAngle) * r;
    const gr = g.createRadialGradient(x, y, 0, x, y, core * 4);
    gr.addColorStop(0, `hsla(${st.hue},100%,92%,${Math.min(1, st.alpha + 0.2)})`); gr.addColorStop(1, `hsla(${st.hue},100%,70%,0)`);
    g.fillStyle = gr; g.beginPath(); g.arc(x, y, core * 4, 0, TAU); g.fill();
  }
}
