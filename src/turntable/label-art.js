// label-art.js — the record label drawn from the album: its own cover (embedded / folder art) when there is one, otherwise a generated
// label (the album's procedural hue pair, rings, title and artist). Browser canvas only; the stage rotates the result with the disc.
// All text reaches a canvas through fillText, never the DOM. Units: the label is a circle of radius 217 stage units (see disc-draw.js).
import { specForAlbum } from './covers.js';

export const LABEL_R = 217;

function fit(g, text, maxW, px, weight = 700) {
  let size = px;
  g.font = `${weight} ${size}px system-ui, "Helvetica Neue", Arial, sans-serif`;
  while (size > 14 && g.measureText(text).width > maxW) { size -= 2; g.font = `${weight} ${size}px system-ui, "Helvetica Neue", Arial, sans-serif`; }
  let t = text;
  while (t.length > 1 && g.measureText(t).width > maxW) t = t.slice(0, -2) + '…';
  return t;
}

/**
 * Paint the label into `canvas` (square, any size; one stage unit = size / 434 px).
 *   opts = { album: {title, artist, coverSeed, coverSpec?}, image?: HTMLImageElement | ImageBitmap | canvas (cropped to a centred square) }
 * Returns the canvas.
 */
export function paintLabel(canvas, { album, image = null } = {}) {
  const S = canvas.width, u = S / 434, g = canvas.getContext('2d');
  if (!g) return canvas;
  g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, S, S);
  g.save(); g.translate(S / 2, S / 2); g.scale(u, u);
  g.beginPath(); g.arc(0, 0, LABEL_R, 0, Math.PI * 2); g.clip();
  const spec = specForAlbum(album || {});
  const w = image && (image.naturalWidth || image.width), h = image && (image.naturalHeight || image.height);
  if (image && w && h) {
    const side = Math.min(w, h);
    g.drawImage(image, (w - side) / 2, (h - side) / 2, side, side, -LABEL_R, -LABEL_R, LABEL_R * 2, LABEL_R * 2);
  } else {
    const [h0, h1] = spec.hue;
    const grad = g.createLinearGradient(-LABEL_R, -LABEL_R, LABEL_R, LABEL_R);
    grad.addColorStop(0, `hsl(${h0} 62% 52%)`); grad.addColorStop(1, `hsl(${h1} 66% 30%)`);
    g.fillStyle = grad; g.fillRect(-LABEL_R, -LABEL_R, LABEL_R * 2, LABEL_R * 2);
    g.lineWidth = 3; g.strokeStyle = 'rgba(255,255,255,.16)';
    for (const r of [96, 150, 196]) { g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2); g.stroke(); }
    g.fillStyle = 'rgba(255,255,255,.94)'; g.textAlign = 'center'; g.textBaseline = 'middle';
    const title = String(album && album.title || '').toUpperCase();
    const artist = String(album && album.artist || '');
    if (title) { g.fillText(fit(g, title, 330, 46), 0, -112); }
    g.fillStyle = 'rgba(255,255,255,.78)';
    if (artist) { g.fillText(fit(g, artist, 300, 30, 600), 0, 118); }
  }
  // the spindle area stays readable on any artwork: a soft dark well around the hole, a hairline rim
  const well = g.createRadialGradient(0, 0, 14, 0, 0, 74);
  well.addColorStop(0, 'rgba(0,0,0,.62)'); well.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = well; g.fillRect(-LABEL_R, -LABEL_R, LABEL_R * 2, LABEL_R * 2);
  g.restore();
  return canvas;
}
