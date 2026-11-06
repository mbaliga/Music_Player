// reels-art.js — reel / tape drawing as SVG markup strings (the core calls these
// while it renders). Pure; geometry + physics in reels-physics.js.
import { famFor, packR, tapeD, markerX, fx, toDeg, TAPE_FILL } from './reels-physics.js';

const deg = (a) => ((toDeg(a)) % 360).toFixed(2);

function hubDefs(u) {
  return '<defs><radialGradient id="' + u + '-rhub" cx=".4" cy=".35" r=".8"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#d6d6d2"/></radialGradient>' +
    '<radialGradient id="' + u + '-rhole" cx=".35" cy=".3" r=".9"><stop offset="0" stop-color="#6f6d68"/><stop offset="1" stop-color="#aaa8a2"/></radialGradient></defs>';
}

function hubArt(u) {
  let teeth = '';
  for (let i = 0; i < 6; i++) teeth += '<rect x="-5" y="-58" width="10" height="13" rx="2.5" transform="rotate(' + (10 + i * 60) + ')"/>';
  return '<circle r="95" fill="#000" opacity=".28"/>' +
    '<circle r="88" fill="url(#' + u + '-rhub)" stroke="#8e8e8a"/>' +
    '<circle r="80" fill="none" stroke="#8e8e8a" stroke-width="1.4"/>' +
    '<circle r="73" fill="none" stroke="#a9a9a4" stroke-width="3" stroke-dasharray="1.6 6.2"/>' +
    '<circle r="66" fill="#efefec" stroke="#8e8e8a" stroke-width="1.2"/>' +
    '<circle r="58" fill="url(#' + u + '-rhole)" stroke="#7e7e7a" stroke-width="1.4"/>' +
    '<g fill="#f6f6f3" stroke="#8e8e8a">' + teeth + '</g>' +
    '<path d="M-20 -78A80 80 0 0 1 22 -77" fill="none" stroke="#c8102e" stroke-width="9" stroke-linecap="round" opacity=".92"/>' +
    '<path d="M14 77A80 80 0 0 1 -6 79" fill="none" stroke="#c8102e" stroke-width="4" stroke-linecap="round" opacity=".45"/>';
}

function art(f, side, p, u, ang) {
  const r = packR(f, side, p);
  return (side === 'left' ? hubDefs(u) : '') +
    '<circle data-pack r="' + fx(r) + '" fill="' + TAPE_FILL + '"/>' +
    '<circle data-edge r="' + fx(r - 2.5) + '" fill="none" stroke="#fff" stroke-opacity=".07" stroke-width="1.4"/>' +
    '<g transform="scale(' + f.S.toFixed(4) + ')"><g data-spin transform="rotate(' + deg(ang) + ')">' + hubArt(u) + '</g></g>';
}

/** Reel art for a mount group: tape pack sized from c.progress, spinning hub. */
export function standIn(c, side) { return art(famFor(c.st), side, c.progress, c.u, side === 'right' ? 2.39 : 0); }

/** Tape path from the reels round the corner rollers (clear + glass shells only). */
export function tapeLayer(c) {
  const f = famFor(c.st);
  if (!f.tape) return '';
  const p = c.progress;
  return '<g data-layer="tape" pointer-events="none"><path data-tape d="' + tapeD(f, packR(f, 'left', p), packR(f, 'right', p)) +
    '" fill="none" stroke="' + TAPE_FILL + '" stroke-width="5" stroke-linejoin="round"/></g>';
}

/** Marks on a roller so its spin can be seen. */
export function rollerMarks(x, y, side, r) {
  const a = r * 0.866, b = r * 0.5;
  return '<g transform="translate(' + x + ' ' + y + ')"><g data-roller="' + side + '" transform="rotate(0)" fill="#47402F"><circle cy="' + (-r) + '" r="2.3"/><circle cx="' + fx(a) + '" cy="' + fx(b) +
    '" r="2.3"/><circle cx="' + fx(-a) + '" cy="' + fx(b) + '" r="2.3"/></g></g>';
}

/** Amber position marker for the centre window. */
export function marker(c) {
  const f = famFor(c.st), m = f.mark, x = markerX(f, c.progress);
  return '<rect data-marker x="' + fx(x - 1.3) + '" y="' + m.y0 + '" width="2.6" height="' + (m.y1 - m.y0) + '" rx="1.3" fill="#ffb21c" stroke="none" pointer-events="none"/>';
}
