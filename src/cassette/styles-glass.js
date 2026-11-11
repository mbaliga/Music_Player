/* Cassette "Glass" family: built from Madhav's Figma file "Transparent casette" (702 x 466 frame, 675 x 439 shell).
   Same API as the rest: registerStyle, mounts at the two hub openings. Reel mounts for this family:
   left (174.5, 184.5), right (501.5, 184.5), opening radius 45.5. Read them with Cassette.mounts(styleId). */
import { Cassette } from './core.js';
import * as Reels from './reels-art.js';

(function (C) {
  'use strict';
  var h = C.helpers, esc = h.esc, mix = h.mix, shade = h.shade;
  var MOUNTS = { left: { x: 174.5, y: 184.5 }, right: { x: 501.5, y: 184.5 }, radius: 45.5 };

  /* the Figma outline: notches on top, hub openings cut out (even-odd) */
  var SHELL = 'M57 0C59.2091 0 61 1.79086 61 4V28C61 28.5523 61.4477 29 62 29H97C97.5523 29 98 28.5523 98 28V4C98 1.79086 99.7909 0 102 0H572C574.209 0 576 1.79086 576 4V28C576 28.5523 576.448 29 577 29H612C612.552 29 613 28.5523 613 28V4C613 1.79086 614.791 0 617 0H651C664.255 0 675 10.7452 675 24V415C675 428.255 664.255 439 651 439H24C10.7452 439 0 428.255 0 415V24C0 10.7452 10.7452 0 24 0H57Z' +
    'M174.5 139C149.371 139 129 159.371 129 184.5C129 209.629 149.371 230 174.5 230C199.629 230 220 209.629 220 184.5C220 159.371 199.629 139 174.5 139Z' +
    'M501.5 139C476.371 139 456 159.371 456 184.5C456 209.629 476.371 230 501.5 230C526.629 230 547 209.629 547 184.5C547 159.371 526.629 139 501.5 139Z';
  var STAR = 'M24.5626 16.5243C24.8853 15.6551 26.1147 15.6551 26.4374 16.5243L27.5847 19.6136C27.752 20.0639 28.2158 20.3317 28.6894 20.2514L31.9385 19.7003C32.8526 19.5452 33.4672 20.6099 32.8759 21.324L30.7741 23.8622C30.4677 24.2322 30.4677 24.7678 30.7741 25.1378L32.8759 27.676C33.4672 28.3901 32.8525 29.4548 31.9385 29.2997L28.6894 28.7486C28.2158 28.6683 27.752 28.9361 27.5847 29.3864L26.4374 32.4757C26.1147 33.3449 24.8853 33.3449 24.5626 32.4757L23.4153 29.3864C23.248 28.9361 22.7842 28.6683 22.3106 28.7486L19.0615 29.2997C18.1474 29.4548 17.5328 28.3901 18.1241 27.676L20.2259 25.1378C20.5323 24.7678 20.5323 24.2322 20.2259 23.8622L18.1241 21.324C17.5328 20.6099 18.1475 19.5452 19.0615 19.7003L22.3106 20.2514C22.7842 20.3317 23.248 20.0639 23.4153 19.6136L24.5626 16.5243Z';
  var TAPE = 'M336.967 353.127L479.278 379.5H550.5V385.5H478.725L478.453 385.45L336.75 359.19L195.047 385.45L194.775 385.5H123V379.5H194.222L336.532 353.127L336.547 353.05L336.75 353.087L336.953 353.05L336.967 353.127Z';

  function build(c, cfg) {
    var S = c.S, T = c.T, pen = c.pen, wear = c.wear, gloss = c.gloss, id = c.id, url = c.url, F = c.st;
    var tint = S.body, edge = S.edge, tintA = F.tintA != null ? F.tintA : 0.1;
    var side = String(T.side || 'A').slice(0, 2).toUpperCase();
    var d = '';
    d += h.fx(id('fxShell'), { drop: { dx: 20, dy: 20, b: 3.5, c: [0, 0, 0], a: 0.25 } });
    d += h.fx(id('fxStar'), { inner: { dx: 0, dy: 4, b: 2, c: [0, 0, 0], a: 1 } });
    d += h.fx(id('fxTrap'), { drop: { dx: 8, dy: 0, b: 2, c: [0, 0, 0], a: 0.25 }, inner: { dx: 3, dy: 3, b: 2, c: [1, 1, 1], a: 0.25 } });
    d += h.fx(id('fxHub'), { inner: { dx: 2, dy: 2, b: 1, c: [0, 0, 0], a: 0.25 } });
    d += h.fx(id('fxHub2'), { drop: { dx: 2, dy: 2, b: 1, c: [0, 0, 0], a: 0.15 } });
    d += h.fx(id('fxHole'), { drop: { dx: 1, dy: 1, b: 0.5, c: [1, 1, 1], a: 0.25 } });
    d += h.fx(id('fxPaper'), { drop: { dx: 0, dy: 2, b: 2.2, c: [0, 0, 0], a: 0.24 } });
    d += '<linearGradient id="' + id('rim') + '" gradientUnits="userSpaceOnUse" x1="12" y1="16" x2="675" y2="433"><stop stop-color="' + edge + '"/><stop offset="1" stop-color="#fff" stop-opacity=".25"/></linearGradient>';
    d += '<linearGradient id="' + id('rimN') + '" gradientUnits="userSpaceOnUse" x1="61.6" y1="6.8" x2="97" y2="30"><stop stop-color="' + edge + '"/><stop offset="1" stop-color="#fff" stop-opacity=".25"/></linearGradient>';
    d += '<linearGradient id="' + id('pip') + '" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#CCC3B8"/><stop offset="1" stop-color="#867970"/></linearGradient>';
    d += '<radialGradient id="' + id('starG') + '" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(25.5 24.5) rotate(90) scale(10.5)"><stop stop-color="' + S.star + '"/><stop offset="1" stop-color="' + shade(S.star, -0.65) + '"/></radialGradient>';
    d += '<linearGradient id="' + id('paperLight') + '" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#fff" stop-opacity=".3"/><stop offset=".6" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".08"/></linearGradient>';
    d += '<radialGradient id="' + id('sheen') + '" gradientUnits="userSpaceOnUse" cx="190" cy="80" r="470" fx="190" fy="80"><stop stop-color="#fff" stop-opacity="' + (0.34 * gloss).toFixed(3) + '"/><stop offset=".5" stop-color="#fff" stop-opacity="' + (0.06 * gloss).toFixed(3) + '"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>';
    d += '<linearGradient id="' + id('streak') + '" gradientUnits="userSpaceOnUse" x1="90" y1="0" x2="330" y2="0"><stop stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity="' + (0.15 * gloss).toFixed(3) + '"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>';
    d += '<filter id="' + id('grain') + '" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="4"/><feColorMatrix type="matrix" values="0 0 0 0 .12 0 0 0 0 .10 0 0 0 0 .08 0 0 0 1.1 -.42"/></filter>';
    d += '<clipPath id="' + id('shapeClip') + '"><path d="' + SHELL + '" clip-rule="evenodd"/></clipPath>';
    d += '<clipPath id="' + id('shellOuter') + '"><rect x="0" y="0" width="675" height="439" rx="24"/></clipPath>';
    d += '<clipPath id="' + id('cav') + '"><rect x="39.5" y="39.5" width="597" height="278" rx="13.5"/></clipPath>';
    d += '<clipPath id="' + id('paperClip') + '"><rect x="58" y="50" width="560" height="76" rx="6"/></clipPath>';
    d += '<path id="' + id('star') + '" d="' + STAR + '"/>';

    /* screws: dark head, bronze star */
    var screws = '';
    [[0, 0], [0, 390], [624, 0], [624, 390]].forEach(function (p, k) {
      var rot = (c.rand() * 2 - 1) * 40 * c.wear;
      screws += '<g transform="translate(' + p[0] + ' ' + p[1] + ')"><circle cx="25.5" cy="24.5" r="14.5" fill="' + S.screw + '"/>' +
        '<path d="M' + (k > 1 ? 638 - 624 : 14) + ' 25C' + (k > 1 ? 638 - 624 : 14) + ' 18.37 ' + (k > 1 ? 643.37 - 624 : 19.37) + ' 13 ' + (k > 1 ? 650 - 624 : 26) + ' 13" stroke="url(#' + id('pip') + ')" stroke-width="2" stroke-linecap="round" fill="none"/>' +
        '<g filter="' + url('fxStar') + '"><use href="#' + id('star') + '" fill="' + url('starG') + '" transform="rotate(' + rot.toFixed(1) + ' 25.5 24.5)"/></g></g>';
    });

    /* reels sit behind the film so packs show through the plastic and the two openings */
    var on = !!cfg.reelStandIns;
    var reels = '<g data-layer="reels" clip-path="' + url('cav') + '">' +
      '<g data-reel="left" transform="translate(' + MOUNTS.left.x + ' ' + MOUNTS.left.y + ')">' + (on ? c.standIn('left') : '') + '</g>' +
      '<g data-reel="right" transform="translate(' + MOUNTS.right.x + ' ' + MOUNTS.right.y + ')">' + (on ? c.standIn('right') : '') + '</g></g>';

    /* body film + rim (inner half of a 10px stroke, as in the Figma) */
    var shell = '<g data-layer="shell" filter="' + url('fxShell') + '"><path d="' + SHELL + '" fill-rule="evenodd" fill="' + tint + '" fill-opacity="' + tintA + '"/>' +
      '<g clip-path="' + url('shapeClip') + '"><path d="' + SHELL + '" fill="none" stroke="' + url('rim') + '" stroke-width="10"/></g></g>';

    var trap = '<path data-layer="bottom" d="M126.131 334H539.869L566 439H100L126.131 334Z" fill="' + tint + '" fill-opacity="' + (tintA) + '" filter="' + url('fxTrap') + '"/>';
    var RL = !!cfg.reelStandIns;
    var tape = RL ? Reels.tapeLayer(c) : '<path d="' + TAPE + '" fill="' + S.tape + '"/>';

    /* bottom hubs (the guide rollers in the Figma) */
    var hubs = '';
    [71, 604].forEach(function (x) {
      hubs += '<circle cx="' + x + '" cy="373" r="31" fill="' + S.hub + '"/>' +
        '<g filter="' + url('fxHub') + '"><circle cx="' + x + '" cy="373" r="25" fill="' + S.hub + '"/></g>' +
        '<g filter="' + url('fxHub2') + '"><circle cx="' + x + '" cy="373" r="14" fill="' + S.hub + '"/></g>' +
        '<circle cx="' + x + '" cy="373" r="5" fill="' + shade(S.hub, -0.7) + '"/>' + (RL ? Reels.rollerMarks(x, 373, x < 300 ? 'L' : 'R', 19) : '');
    });
    var holes = '<g filter="' + url('fxHole') + '"><ellipse cx="337" cy="355.5" rx="15" ry="14.5" fill="#46413D"/></g>' +
      '<g opacity=".3"><rect x="213" y="396" width="28" height="28" rx="6" fill="#E1E1E1"/><rect x="432" y="396" width="28" height="28" rx="6" fill="#E1E1E1"/>' +
      '<ellipse cx="160" cy="417.5" rx="15" ry="14.5" fill="#E1E1E1"/><ellipse cx="505" cy="417.5" rx="15" ry="14.5" fill="#E1E1E1"/></g>';

    /* cavity outline, centre window, tape counter ticks */
    var line = '<g data-layer="cavity" fill="none" stroke="#fff"><rect x="39.5" y="39.5" width="597" height="278" rx="13.5"/>';
    if (RL) line += '<rect x="232.5" y="138.5" width="211" height="93" rx="7" fill="#fff" fill-opacity=".06" stroke-opacity=".7"/>';
    for (var i = 0, nT = RL ? 12 : 8, tx0 = RL ? 249.5 : 282.5; i < nT; i++) line += '<path d="M' + (tx0 + 16 * i) + ' 177.5V196.5" stroke-linecap="round"/>';
    if (RL) line += Reels.marker(c);
    line += '</g>';

    /* handwritten label strip across the top of the cavity */
    var ink = S.ink, rule = shade(S.paper, -0.45), x0 = 130, maxW = 600 - x0;
    function ln(y, str, size, op) {
      if (!str) return '';
      var s = pen.upper ? String(str).toUpperCase() : String(str);
      return '<text x="' + x0 + '" y="' + y + '" font-family="' + pen.family + '" font-size="' + size.toFixed(1) + '" fill="' + ink + '" fill-opacity="' + op + '" letter-spacing="' + pen.ls + '" data-fit="' + maxW + '" data-size="' + size.toFixed(1) + '" transform="rotate(' + pen.tilt + ' ' + x0 + ' ' + y + ')">' + esc(s) + '</text>';
    }
    var paper = '<g data-layer="paper"><rect x="58" y="50" width="560" height="76" rx="6" fill="' + mix(S.paper, '#C9B27A', wear * 0.22) + '" filter="' + url('fxPaper') + '"/>' +
      '<rect x="58" y="50" width="560" height="76" rx="6" fill="' + url('paperLight') + '"/><g clip-path="' + url('paperClip') + '">' +
      (wear > 0.01 ? '<rect x="58" y="50" width="560" height="76" fill="#6b5a35" filter="' + url('grain') + '" opacity="' + (wear * 0.45).toFixed(2) + '"/>' : '') +
      '<path d="M58 77.5H618M58 108.5H618" stroke="' + rule + '" stroke-opacity=".7" fill="none"/>' +
      '<circle cx="92" cy="88" r="22" fill="' + S.accent + '"/><text x="92" y="97" text-anchor="middle" font-family="' + pen.family + '" font-size="26" fill="' + S.paper + '">' + esc(side) + '</text>' +
      ln(70, T.subtitle, 15 * Math.min(pen.k, 1.2), 0.75) + ln(105, T.title, 32 * pen.k, 0.92) + ln(122, T.note, 12, 0.7) + '</g></g>';

    var wearG = '';
    if (wear > 0.01) {
      wearG = '<g data-layer="wear" clip-path="' + url('shellOuter') + '"><rect width="675" height="439" fill="#000" filter="' + url('grain') + '" opacity="' + (wear * 0.55).toFixed(2) + '"/>';
      for (var s = 0, n = Math.round(wear * 16); s < n; s++) {
        var x1 = 20 + c.rand() * 630, y1 = 10 + c.rand() * 420, a = c.rand() * Math.PI, l = 8 + c.rand() * 40;
        wearG += '<path d="M' + x1.toFixed(1) + ' ' + y1.toFixed(1) + 'l' + (Math.cos(a) * l).toFixed(1) + ' ' + (Math.sin(a) * l).toFixed(1) + '" stroke="#fff" stroke-opacity="' + (0.12 + c.rand() * 0.2).toFixed(2) + '" stroke-width="' + (0.5 + c.rand() * 0.6).toFixed(2) + '" fill="none"/>';
      }
      wearG += '</g>';
    }
    var sheen = cfg.static ? '' : '<g data-layer="sheen" clip-path="' + url('shellOuter') + '" pointer-events="none"><rect width="675" height="439" fill="' + url('sheen') + '"/><polygon points="30,439 260,0 320,0 90,439" fill="' + url('streak') + '"/></g>';
    var guides = cfg.guides ? '<g data-layer="guides" fill="none" stroke="#E5322D" stroke-width="1.2" pointer-events="none"><circle cx="174.5" cy="184.5" r="45.5"/><circle cx="501.5" cy="184.5" r="45.5"/><path d="M174.5 164v40M154.5 184.5h40M501.5 164v40M481.5 184.5h40"/><rect x="39.5" y="39.5" width="597" height="278" rx="13.5" stroke-dasharray="4 4"/></g>' : '';

    return '<defs>' + d + '</defs>' + (RL ? reels + shell + trap + hubs + tape : reels + shell + trap + tape + hubs) + holes + line + paper + screws + wearG + sheen + guides;
  }

  var base = { kind: 'Glass', bodyW: 675, vb: [702, 466], build: build, mounts: MOUNTS, gloss: 0.8, badge: 'dot', clear: true,
    editable: ['body', 'edge', 'hub', 'star', 'paper', 'ink', 'accent'] };
  function reg(o) { C.registerStyle(Object.assign({}, base, o, { slots: Object.assign({ body: '#FFFFFF', edge: '#838488', hub: '#D4CDC5', star: '#8D5E3A', screw: '#161510', tape: '#434343', paper: '#EDEBE3', ink: '#2B2A28', accent: '#E9463C' }, o.slots) })); }

  reg({ id: 'glass', name: 'Glass', note: 'From your transparent Figma', slots: {} });
  reg({ id: 'glass-smoke', name: 'Glass Smoke', note: 'Dark tinted plastic', tintA: 0.34, slots: { body: '#3A3A45', edge: '#9A9AA8', hub: '#C8C6C2', star: '#B8B2A8', screw: '#0E0E10', paper: '#E8E6DF', accent: '#7A6CF0' } });
  reg({ id: 'glass-ice', name: 'Glass Ice', note: 'Cool blue tint', tintA: 0.24, slots: { body: '#7FC6E8', edge: '#5C8CA6', hub: '#E8EEF2', star: '#5A7A92', screw: '#10202A', paper: '#F2F5F6', accent: '#F26B5B' } });
  reg({ id: 'glass-amber', name: 'Glass Amber', note: 'Warm honey tint', tintA: 0.26, slots: { body: '#E8A83C', edge: '#8F6A2A', hub: '#EFE4CC', star: '#7A4A22', screw: '#1C1208', paper: '#F5EDD8', accent: '#B8321E' } });
})(Cassette);
