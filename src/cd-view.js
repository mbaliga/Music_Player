// ─────────────────────────────────────────────────────────────────────────────
// cd-view.js — the CD player view (browser glue; geometry is pure in cd.js).
//
// A CD is not a platter: no scrub, no pitch bend. The disc just spins at a
// steady visual rate while playing, and you SKIP — prev/next, tap a track in
// the segment ring or the list, tap the progress ring to seek. The rainbow is
// drawn procedurally: a static two-lobe diffraction field (light does not
// rotate with the disc) under a thin rotating layer (data rings, dust, printed
// ring text) so the spin is visible without the colours swimming.
// ─────────────────────────────────────────────────────────────────────────────

import { CD_KNOBS, segmentArcs, hitTest, formatTime } from './cd.js';

const TAU = Math.PI * 2;
const SPIN_RAD_PER_SEC = 4.2;   // ~40 rpm look; purely visual (audio is always 1x)

function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360 / 360;
  const f = (n) => {
    const k = (n + h * 12) % 12;
    return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
  };
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

/** Static diffraction field: size x size RGBA, circular alpha mask (hub hole cut). */
export function bakeDiffraction(size) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d');
  const img = g.createImageData(size, size);
  const c = size / 2;
  const lobe0 = -0.6;                  // light direction (radians), fixed
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - c, dy = y + 0.5 - c;
      const r = Math.hypot(dx, dy) / c;
      const i = (y * size + x) * 4;
      if (r > 1 || r < 0.115) { img.data[i + 3] = 0; continue; }   // outside / spindle hole
      const a = Math.atan2(dy, dx);
      // Two opposing bright lobes (cos^2), sharpened; a dim silver floor elsewhere.
      const lobe = Math.pow(Math.cos(a - lobe0), 2);
      const k = Math.pow(lobe, 1.6);
      // Hue sweeps with radius and angle: the "oil slick" diffraction bands.
      const hue = 300 * (r * 1.35) + 80 * Math.sin(a * 2 - lobe0) + 20;
      const [R, G, B] = hslToRgb(hue, 0.8, 0.6);
      const silver = 150 + 60 * Math.cos(a - lobe0 + 0.4) ** 2;
      const m = 0.08 + 0.62 * k;                                   // rainbow strength
      img.data[i] = silver * (1 - m) + R * m;
      img.data[i + 1] = silver * (1 - m) + G * m;
      img.data[i + 2] = silver * (1 - m) + B * m;
      // soften the rim and the clamp-area edge
      const edge = Math.min(1, (1 - r) * c / 1.5, (r - 0.115) * c / 1.5);
      img.data[i + 3] = 255 * Math.max(0, edge);
    }
  }
  g.putImageData(img, 0, 0);
  return cv;
}

/** Rotating layer: fine data rings, a few specks, and printed text around the hub. */
export function bakeSpinLayer(size) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d');
  const c = size / 2, R = c;
  g.translate(c, c);
  g.lineWidth = 1;
  for (let r = R * 0.3; r < R * 0.985; r += 1.6) {
    g.strokeStyle = `rgba(0,0,0,${(0.035 + 0.025 * Math.sin(r * 0.9)).toFixed(3)})`;
    g.beginPath(); g.arc(0, 0, r, 0, TAU); g.stroke();
  }
  // mirror-band / clamp ring
  g.strokeStyle = 'rgba(255,255,255,0.35)';
  g.lineWidth = Math.max(1, R * 0.012);
  g.beginPath(); g.arc(0, 0, R * 0.27, 0, TAU); g.stroke();
  g.strokeStyle = 'rgba(0,0,0,0.25)';
  g.beginPath(); g.arc(0, 0, R * 0.235, 0, TAU); g.stroke();
  // printed ring text (rotates with the disc so you can see it turning)
  const txt = 'RUNOUT · DIGITAL AUDIO · ';
  g.fillStyle = 'rgba(30,30,40,0.55)';
  g.font = `600 ${Math.round(R * 0.05)}px system-ui, sans-serif`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  const rr = R * 0.205;
  const step = TAU / txt.length;
  for (let i = 0; i < txt.length; i++) {
    g.save(); g.rotate(i * step); g.translate(0, -rr); g.fillText(txt[i], 0, 0); g.restore();
  }
  // a notch + dust specks as rotation tells
  g.fillStyle = 'rgba(20,20,30,0.7)';
  g.beginPath(); g.arc(0, -R * 0.44, R * 0.012, 0, TAU); g.fill();
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 40; i++) {
    const a = rnd() * TAU, r = R * (0.35 + 0.6 * rnd());
    g.fillStyle = `rgba(255,255,255,${(0.08 + 0.12 * rnd()).toFixed(2)})`;
    g.fillRect(Math.cos(a) * r, Math.sin(a) * r, 1.2, 1.2);
  }
  return cv;
}

export class CdView {
  /**
   * els = { root, canvas, list, prev, next, play, num, time, title }
   * cb  = { onTrack(i), onSeekFrac(f), onPrev(), onNext(), onToggle() }
   */
  constructor(els, cb) {
    this.e = els;
    this.cb = cb;
    this.g = els.canvas.getContext('2d');
    this.titles = [];
    this.weights = [];
    this.arcs = [];
    this.index = 0;
    this.spin = 0;
    this.geo = null;
    this._sprites = null;
    this._lastKey = '';
    this._rect = null;

    els.prev.addEventListener('click', () => cb.onPrev());
    els.next.addEventListener('click', () => cb.onNext());
    els.play.addEventListener('click', () => cb.onToggle());
    els.canvas.addEventListener('pointerdown', (ev) => this._tap(ev));
    new ResizeObserver(() => this.resize()).observe(els.canvas);
  }

  show(on) { this.e.root.classList.toggle('hidden', !on); if (on) this.resize(); }

  /** titles: string[], weights: seconds (null for unknown) per track. */
  setTracks(titles, weights, index) {
    const key = titles.join('\u0001');
    this.weights = weights;
    this.arcs = segmentArcs(weights.map((w) => (w > 0 ? w : 0)));
    this.index = index;
    if (key !== this._lastKey) {
      this._lastKey = key;
      this.titles = titles;
      const ol = this.e.list;
      ol.textContent = '';
      titles.forEach((t, i) => {
        const li = document.createElement('li');
        li.textContent = t;
        li.dataset.i = String(i);
        li.addEventListener('click', () => this.cb.onTrack(i));
        ol.appendChild(li);
      });
    }
    [...this.e.list.children].forEach((li, i) => li.classList.toggle('cur', i === index));
  }

  resize() {
    const cv = this.e.canvas;
    const r = cv.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    cv.width = Math.round(r.width * dpr);
    cv.height = Math.round(r.height * dpr);
    this._rect = r;
    const W = r.width, H = r.height;
    const R = Math.min(W, H) * 0.47;
    this.geo = { W, H, cx: W / 2, cy: H / 2, R, dpr };
    const px = Math.round(R * 2 * dpr);
    this._sprites = { rainbow: bakeDiffraction(px), spin: bakeSpinLayer(px) };
  }

  _tap(ev) {
    if (!this.geo) return;
    const r = this.e.canvas.getBoundingClientRect();
    const x = ev.clientX - r.left, y = ev.clientY - r.top;
    const hit = hitTest(x, y, this.geo.cx, this.geo.cy, this.geo.R, this.arcs);
    if (!hit) return;
    if (hit.ring === 'segments') this.cb.onTrack(hit.index);
    else this.cb.onSeekFrac(hit.frac);
  }

  /** frame = { t, T, playing, dt, loading } */
  draw(frame) {
    const geo = this.geo;
    if (!geo || !this._sprites) return;
    const { g } = this;
    const { W, H, cx, cy, R, dpr } = geo;
    if (frame.playing && !frame.loading) this.spin = (this.spin + SPIN_RAD_PER_SEC * frame.dt) % TAU;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);

    // soft contact shadow
    const sh = g.createRadialGradient(cx, cy + R * 0.04, R * 0.9, cx, cy + R * 0.04, R * 1.12);
    sh.addColorStop(0, 'rgba(0,0,0,0.45)'); sh.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = sh; g.beginPath(); g.arc(cx, cy + R * 0.04, R * 1.12, 0, TAU); g.fill();

    g.drawImage(this._sprites.rainbow, cx - R, cy - R, R * 2, R * 2);
    g.save();
    g.translate(cx, cy); g.rotate(this.spin);
    g.drawImage(this._sprites.spin, -R, -R, R * 2, R * 2);
    g.restore();

    const K = CD_KNOBS;
    const frac = frame.T > 0 ? Math.max(0, Math.min(1, frame.t / frame.T)) : 0;

    // Segment ring: one arc per track; played dim, current bright, upcoming faint.
    g.lineCap = 'butt';
    const segMid = R * (K.segInner + K.ringOuter) / 2, segW = R * (K.ringOuter - K.segInner);
    for (const s of this.arcs) {
      const cur = s.index === this.index;
      g.lineWidth = segW * (cur ? 1 : 0.6);
      g.strokeStyle = cur ? 'rgba(24,18,60,0.88)' : s.index < this.index ? 'rgba(24,18,60,0.55)' : 'rgba(24,18,60,0.32)';
      g.beginPath(); g.arc(cx, cy, segMid, s.a0 - Math.PI / 2, s.a1 - Math.PI / 2); g.stroke();
      if (cur) {
        g.lineWidth = 2; g.strokeStyle = '#c9bfff';
        g.beginPath(); g.arc(cx, cy, R * K.ringOuter, s.a0 - Math.PI / 2, s.a1 - Math.PI / 2); g.stroke();
      }
    }

    // Progress ring (current track unrolled).
    const pMid = R * (K.progInner + K.progOuter) / 2, pW = R * (K.progOuter - K.progInner);
    g.lineWidth = pW; g.strokeStyle = 'rgba(14,12,30,0.55)';
    g.beginPath(); g.arc(cx, cy, pMid, 0, TAU); g.stroke();
    g.lineWidth = pW * 0.5; g.strokeStyle = '#a99cff'; g.lineCap = 'round';
    if (frac > 0.002) { g.beginPath(); g.arc(cx, cy, pMid, -Math.PI / 2, -Math.PI / 2 + frac * TAU); g.stroke(); }
    const ta = -Math.PI / 2 + frac * TAU;
    g.fillStyle = '#fff';
    g.beginPath(); g.arc(cx + Math.cos(ta) * pMid, cy + Math.sin(ta) * pMid, pW * 0.34, 0, TAU); g.fill();

    // Centre plate with the track number + time readout.
    const pr = R * K.progInner * 0.92;
    g.fillStyle = 'rgba(12,10,26,0.82)';
    g.beginPath(); g.arc(cx, cy, pr, 0, TAU); g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.14)'; g.lineWidth = 1; g.stroke();
    g.fillStyle = '#f2f0ff'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = `700 ${Math.round(R * 0.30)}px ui-monospace, Menlo, monospace`;
    g.fillText(String(this.index + 1).padStart(2, '0'), cx, cy - R * 0.10);
    g.fillStyle = 'rgba(230,226,255,0.78)';
    g.font = `500 ${Math.round(R * 0.095)}px ui-monospace, Menlo, monospace`;
    g.fillText(frame.loading ? 'reading…' : `${formatTime(frame.t)} / ${formatTime(frame.T)}`, cx, cy + R * 0.14);
    g.font = `500 ${Math.round(R * 0.065)}px system-ui, sans-serif`;
    g.fillStyle = 'rgba(230,226,255,0.5)';
    g.fillText(`of ${this.arcs.length}`, cx, cy + R * 0.27);

    // DOM readouts (for a11y / tests)
    this.e.num.textContent = `Track ${this.index + 1} of ${this.arcs.length}`;
    this.e.time.textContent = `${formatTime(frame.t)} / ${formatTime(frame.T)}`;
    this.e.title.textContent = this.titles[this.index] || '';
    this.e.play.textContent = frame.playing ? '❚❚' : '▶';
  }
}
