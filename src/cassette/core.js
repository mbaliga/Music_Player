/* ============================================================================
   cassette-core.js
   The shared cassette base. Every style is a skin on this one geometry.

   Geometry is taken 1:1 from the Figma export "Casette alt 1.svg" (808 x 495).
   Layer order, filters (drop + inner shadows) and corner values are the same as
   the Figma file; only colours, printing and decoration change per style.

   PUBLIC API
     Cassette.registerStyle(def)           add a style (see cassette-styles.js)
     Cassette.styles()                     ordered list of style definitions
     Cassette.render(cfg)    -> string     pure SVG markup, no DOM needed
     Cassette.mount(el, cfg, opts) -> handle   render into el, fit text, return controls
         handle.update(patch)              merge a partial cfg and redraw
         handle.setLight(x, y)             move the specular sheen (SVG coords)
         handle.reels.left / .right        <g> mount points for the reels (see below)
         opts.onRender(handle)             called after every redraw: re-mount reels here
     Cassette.GEO, Cassette.MOUNTS, Cassette.PENS, Cassette.SLOT_LABELS

   cfg = {
     style: 'brass',                       style id
     slots: { body, panel, accent, paper, ink, window, glass, ... },  colour overrides
     text:  { title, subtitle, note, side },
     pen:   'marker' | 'script' | 'type' | 'bold',
     wear:  0..1,   gloss: 0..1,
     guides: bool,                         draw reel mounts and zones (for developers)
     reelStandIns: bool, progress: 0..1,   placeholder reels, off by default
     static: bool                          thumbnails: no sheen
   }

   REEL MOUNT POINTS (the same on every style)
     <g data-reel="left"  transform="translate(246 225)">   hub centre, y = 225
     <g data-reel="right" transform="translate(562 225)">
   Draw each reel centred on 0,0 inside its group. The layer is clipped to the window
   (pill, r = 68 end caps) on opaque styles and to the whole cavity on clear styles.
   Draw order: shell > reels (clear) | panel > paper > window > reels (opaque) > centre
   window > bottom > screws.
   ========================================================================== */
import { standIn as reelStandIn, tapeLayer, rollerMarks, marker } from './reels-art.js';

const global = typeof window !== 'undefined' ? window : globalThis;

  var W = 808, H = 495;

  /* ---- Geometry, straight from the Figma file ---------------------------- */
  var GEO = {
    W: W, H: H,
    body: { x: 8, y: 0, w: 792, h: 491, r: 30 },
    ledgeL: 'M0 343L8 339V454L0 450V343Z',
    ledgeR: 'M808 343L800 339V454L808 450V343Z',
    panel: 'M90 34H725L756 64.5V367H53V64.5L90 34Z',
    paper: { x: 107, y: 45, w: 595, h: 94, r: 10, lines: [74.5, 109.5] },
    pill: { x: 178, y: 157, w: 452, h: 136, r: 68 },
    tapeWin: { x: 313, y: 179, w: 181, h: 91, r: 8 },
    bottom: 'M167 374H642L672 491H137L167 374Z',
    screws: [[40, 31], [40, 463], [772, 31], [772, 463]],
    sqHoles: [[280, 440], [499, 440]],            /* top-left of 28 x 28, rx 6 */
    roundHoles: [[227, 461.5], [572, 461.5]],     /* rx 15, ry 14.5 */
    centerHole: [404, 399.5]
  };
  var MOUNTS = { left: { x: 246, y: 225 }, right: { x: 562, y: 225 }, radius: 68 };

  var PENS = {
    marker: { label: 'Marker',     family: "'Patrick Hand','Segoe Print','Bradley Hand',cursive",  upper: true,  ls: 0.6, k: 1.0,  tilt: -0.5 },
    script: { label: 'Script',     family: "'Caveat','Segoe Script','Brush Script MT',cursive",     upper: false, ls: 0,   k: 1.3,  tilt: -1.2 },
    type:   { label: 'Typewriter', family: "'Special Elite','Courier New',monospace",              upper: false, ls: 0,   k: 0.78, tilt: 0 },
    bold:   { label: 'Felt tip',   family: "'Permanent Marker','Marker Felt',cursive",              upper: true,  ls: 0,   k: 0.82, tilt: -0.8 }
  };
  var SLOT_LABELS = { body: 'Shell', panel: 'Label', accent: 'Accent', paper: 'Paper', ink: 'Ink', window: 'Window', edge: 'Rim', hub: 'Hubs', star: 'Screws' };

  var DEFAULTS = {
    body: '#353537', panel: '#CDA760', accent: '#CDA760', paper: '#DAD6CF', ink: '#2B2A28',
    rule: null, window: '#312E27', glass: '#D9D9D9', glassTick: null, bottom: null,
    hole: null, hole2: null, print: '#FFFFFF', tape: '#2C2724'
  };
  var SCREWS = {
    dark:   { bezel: '#8C8C8E', well: '#010103', cross: '#5A5A5A' },
    silver: { bezel: '#D3D4D6', well: '#9A9B9F', cross: '#6A6B70' }
  };
  var PRINT = "'Barlow Condensed','Arial Narrow','Helvetica Neue',Arial,sans-serif";

  /* ---- Small utilities ---------------------------------------------------- */
  function esc(s) { return String(s).replace(/[&<>"]/g, function (m) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]; }); }
  function hex2rgb(h) { h = String(h).replace('#', ''); if (h.length === 3) h = h.replace(/./g, '$&$&'); var n = parseInt(h, 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }
  function rgb2hex(a) { return '#' + a.map(function (v) { return Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'); }).join(''); }
  function mix(a, b, t) { var A = hex2rgb(a), B = hex2rgb(b); return rgb2hex(A.map(function (v, i) { return v + (B[i] - v) * t; })); }
  function shade(c, t) { return t < 0 ? mix(c, '#000000', -t) : mix(c, '#ffffff', t); }
  function lum(c) { var a = hex2rgb(c); return (0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2]) / 255; }
  function rng(seed) { var a = seed >>> 0; return function () { a |= 0; a = a + 0x6D2B79F5 | 0; var t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function hash(s) { var h = 2166136261; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

  /* ---- Drawing helpers handed to styles ------------------------------------ */
  function txt(x, y, s, o) {
    o = o || {};
    return '<text x="' + x + '" y="' + y + '" font-family="' + (o.family || PRINT) + '" font-size="' + (o.size || 16) +
      '" font-weight="' + (o.weight || 600) + '"' + (o.italic ? ' font-style="italic"' : '') +
      ' letter-spacing="' + (o.ls || 0) + '" text-anchor="' + (o.anchor || 'start') + '" fill="' + (o.fill || '#000') + '"' +
      (o.op != null ? ' fill-opacity="' + o.op + '"' : '') +
      (o.rot ? ' transform="rotate(' + o.rot + ' ' + x + ' ' + y + ')"' : '') + '>' + esc(s) + '</text>';
  }
  function strokeAttrs(o) { return o.stroke ? ' stroke="' + o.stroke + '" stroke-width="' + (o.sw || 1) + '"' + (o.sop != null ? ' stroke-opacity="' + o.sop + '"' : '') : ''; }
  var h = {
    PRINT: PRINT, esc: esc, mix: mix, shade: shade, lum: lum, text: txt,
    rect: function (x, y, w, hh, fill, o) { o = o || {}; return '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + hh + '" rx="' + (o.rx || 0) + '" fill="' + fill + '"' + (o.op != null ? ' fill-opacity="' + o.op + '"' : '') + strokeAttrs(o) + (o.rot ? ' transform="rotate(' + o.rot + ' ' + (x + w / 2) + ' ' + (y + hh / 2) + ')"' : '') + '/>'; },
    circle: function (x, y, r, fill, o) { o = o || {}; return '<circle cx="' + x + '" cy="' + y + '" r="' + r + '" fill="' + fill + '"' + (o.op != null ? ' fill-opacity="' + o.op + '"' : '') + strokeAttrs(o) + '/>'; },
    ellipse: function (x, y, rx, ry, fill, o) { o = o || {}; return '<ellipse cx="' + x + '" cy="' + y + '" rx="' + rx + '" ry="' + ry + '" fill="' + fill + '"' + (o.op != null ? ' fill-opacity="' + o.op + '"' : '') + strokeAttrs(o) + (o.rot ? ' transform="rotate(' + o.rot + ' ' + x + ' ' + y + ')"' : '') + '/>'; },
    path: function (d, fill, o) { o = o || {}; return '<path d="' + d + '" fill="' + fill + '"' + (o.op != null ? ' fill-opacity="' + o.op + '"' : '') + strokeAttrs(o) + (o.tf ? ' transform="' + o.tf + '"' : '') + '/>'; },
    /* diagonal stripes inside a clipping viewport */
    diag: function (x, y, w, hh, o) {
      var p = o.sw + o.gap, n = Math.ceil((w + hh) / p) + 2, s = '', cx = w / 2;
      for (var i = -n; i <= n; i++) s += '<rect x="' + (cx + i * p + (o.off || 0)) + '" y="' + (-(w + hh)) + '" width="' + o.sw + '" height="' + ((w + hh) * 3) + '"/>';
      return '<svg x="' + x + '" y="' + y + '" width="' + w + '" height="' + hh + '" viewBox="0 0 ' + w + ' ' + hh + '"><g transform="rotate(' + o.angle + ' ' + cx + ' ' + (hh / 2) + ')" fill="' + o.fill + '">' + s + '</g></svg>';
    },
    fx: function (i, o) { return fx(i, o); },
    heart: function (x, y, s, fill, op) { return '<path d="M0 7C-16-6-7-18 0-9C7-18 16-6 0 7Z" transform="translate(' + x + ' ' + y + ') scale(' + s + ')" fill="' + fill + '"' + (op != null ? ' fill-opacity="' + op + '"' : '') + '/>'; }
  };

  /* ---- Filters: same drop / inner-shadow recipe Figma exports -------------- */
  function fx(id, o) {
    var alpha = function (r) { return '<feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="' + r + '"/>'; };
    var cm = function (c, a) { return '<feColorMatrix type="matrix" values="0 0 0 0 ' + c[0] + ' 0 0 0 0 ' + c[1] + ' 0 0 0 0 ' + c[2] + ' 0 0 0 ' + a + ' 0"/>'; };
    var s = '<feFlood flood-opacity="0" result="bg"/>';
    if (o.drop) {
      s += alpha('ha') + '<feOffset dx="' + (o.drop.dx || 0) + '" dy="' + (o.drop.dy || 0) + '"/><feGaussianBlur stdDeviation="' + o.drop.b + '"/>' +
        '<feComposite in2="ha" operator="out"/>' + cm(o.drop.c, o.drop.a) +
        '<feBlend mode="normal" in2="bg" result="drop"/><feBlend mode="normal" in="SourceGraphic" in2="drop" result="shape"/>';
    } else {
      s += '<feBlend mode="normal" in="SourceGraphic" in2="bg" result="shape"/>';
    }
    if (o.inner) {
      s += alpha('hb') + '<feOffset dx="' + (o.inner.dx || 0) + '" dy="' + (o.inner.dy || 0) + '"/><feGaussianBlur stdDeviation="' + o.inner.b + '"/>' +
        '<feComposite in2="hb" operator="arithmetic" k2="-1" k3="1"/>' + cm(o.inner.c, o.inner.a) +
        '<feBlend mode="normal" in2="shape" result="inner"/>';
    }
    return '<filter id="' + id + '" x="-20%" y="-20%" width="145%" height="150%" color-interpolation-filters="sRGB">' + s + '</filter>';
  }

  /* ---- Registry ------------------------------------------------------------ */
  var REG = {}, ORDER = [], UID = 0;
  function registerStyle(def) { if (!REG[def.id]) ORDER.push(def.id); REG[def.id] = def; return def; }
  function styles() { return ORDER.map(function (k) { return REG[k]; }); }

  /* ---- Placeholder reels (off by default) ----------------------------------- */
  function standIn(c, side) { return reelStandIn(c, side); }

  /* ---- Render ---------------------------------------------------------------- */
  function render(cfg) {
    cfg = cfg || {};
    var st = (typeof cfg.style === 'string' ? REG[cfg.style] : cfg.style) || REG[ORDER[0]];
    var S = Object.assign({}, DEFAULTS, st.slots || {}, cfg.slots || {});
    var T = Object.assign({ title: '', subtitle: '', note: '', side: 'A' }, cfg.text || {});
    var pen = PENS[cfg.pen] || PENS.marker;
    var wear = cfg.wear == null ? 0.15 : cfg.wear;
    var gloss = cfg.gloss == null ? (st.gloss == null ? 0.5 : st.gloss) : cfg.gloss;
    var clear = !!st.clear;
    var F = {
      clear: clear,
      bodyA: st.bodyA != null ? st.bodyA : (clear ? 0.55 : 1),
      panelA: st.panelA != null ? st.panelA : (clear ? 0.3 : 1),
      reelsIn: st.reelsIn || (clear ? 'cavity' : 'pill'),
      pill: st.pill || (clear ? 'rim' : 'hole'),
      rollers: st.rollers != null ? st.rollers : clear,
      notches: st.notches != null ? st.notches : clear,
      liner: st.liner != null ? st.liner : clear,
      badge: st.badge || 'letter',
      strips: st.strips != null ? st.strips : true,
      screw: SCREWS[st.screw || 'dark']
    };
    var u = 'k' + (++UID).toString(36);
    var id = function (n) { return u + '-' + n; };
    var url = function (n) { return 'url(#' + id(n) + ')'; };
    var rand = rng(hash(st.id + (cfg.seed || '')));
    var c = { u: u, S: S, st: st, F: F, T: T, pen: pen, wear: wear, gloss: gloss, h: h, G: GEO, id: id, url: url, progress: cfg.progress == null ? 0.35 : cfg.progress };

    c.rand = rand; c.standIn = function (side) { return standIn(c, side); };
    c.cfg = cfg;
    if (typeof st.build === 'function') {
      var vb = st.vb || [808, 495];
      return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + vb[0] + ' ' + vb[1] + '" width="' + vb[0] + '" height="' + vb[1] + '" data-cassette="' + u + '" role="img" aria-label="' + esc('Cassette, ' + st.name + (T.title ? ': ' + T.title : '')) + '">' + st.build(c, cfg) + '</svg>';
    }

    var edgeC = clear ? shade(S.body, -0.45) : shade(S.body, -0.5);
    var holeSq = S.hole || mix(S.body, '#000000', 0.85);
    var holeRd = S.hole2 || mix(S.body, '#000000', 0.6);

    /* defs */
    var d = '';
    d += fx(id('fxBottom'), { drop: { dx: 8, dy: 0, b: 2, c: [0, 0, 0], a: clear ? 0.16 : 0.25 }, inner: { dx: 3, dy: 3, b: 2, c: [1, 1, 1], a: 0.25 } });
    d += fx(id('fxBezel'), { drop: { dx: 1, dy: 1, b: 0.5, c: [1, 1, 1], a: 0.1 }, inner: { dx: 3, dy: 3, b: 2, c: [0, 0, 0], a: 0.75 } });
    d += fx(id('fxWell'), { inner: { dx: 4, dy: 4, b: 2, c: [1, 1, 1], a: 0.25 } });
    d += fx(id('fxCross'), { inner: { dx: 0, dy: 4, b: 2, c: [0, 0, 0], a: 1 } });
    d += fx(id('fxHole'), { drop: { dx: 1, dy: 1, b: 0.5, c: [1, 1, 1], a: 0.25 } });
    d += fx(id('fxPaper'), { drop: { dx: 0, dy: 2, b: 2.2, c: [0, 0, 0], a: 0.22 } });
    d += '<filter id="' + id('grain') + '" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="4"/><feColorMatrix type="matrix" values="0 0 0 0 .12 0 0 0 0 .10 0 0 0 0 .08 0 0 0 1.1 -.42"/></filter>';
    d += '<clipPath id="' + id('bodyClip') + '"><rect x="8" y="0" width="792" height="491" rx="30"/></clipPath>';
    d += '<clipPath id="' + id('panelClip') + '"><path d="' + GEO.panel + '"/></clipPath>';
    d += '<clipPath id="' + id('pillClip') + '"><rect x="178" y="157" width="452" height="136" rx="68"/></clipPath>';
    d += '<clipPath id="' + id('cavClip') + '"><path d="' + GEO.panel + '"/></clipPath>';
    d += '<clipPath id="' + id('paperClip') + '"><rect x="107" y="45" width="595" height="94" rx="10"/></clipPath>';
    d += '<linearGradient id="' + id('bodyLight') + '" gradientUnits="userSpaceOnUse" x1="60" y1="0" x2="760" y2="491"><stop offset="0" stop-color="#fff" stop-opacity=".14"/><stop offset=".45" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".16"/></linearGradient>';
    d += '<linearGradient id="' + id('edge') + '" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".45"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".35"/></linearGradient>';
    d += '<linearGradient id="' + id('pillShade') + '" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity=".5"/><stop offset=".2" stop-color="#000" stop-opacity="0"/><stop offset=".82" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#fff" stop-opacity=".1"/></linearGradient>';
    d += '<linearGradient id="' + id('paperLight') + '" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".28"/><stop offset=".6" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".08"/></linearGradient>';
    d += '<linearGradient id="' + id('streak') + '" gradientUnits="userSpaceOnUse" x1="120" y1="0" x2="520" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity="' + (0.16 * gloss).toFixed(3) + '"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>';
    d += '<radialGradient id="' + id('sheen') + '" gradientUnits="userSpaceOnUse" cx="300" cy="120" r="520" fx="300" fy="120"><stop offset="0" stop-color="#fff" stop-opacity="' + (0.4 * gloss).toFixed(3) + '"/><stop offset=".5" stop-color="#fff" stop-opacity="' + (0.07 * gloss).toFixed(3) + '"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>';
    d += '<radialGradient id="' + id('roller') + '" cx=".4" cy=".35" r=".85"><stop offset="0" stop-color="#F8F6EE"/><stop offset="1" stop-color="#D5D1C3"/></radialGradient>';

    /* shell */
    var ledge = mix(S.body, '#000000', 0.28);
    var shell = '<g data-layer="shell">' +
      '<path d="' + GEO.ledgeL + '" fill="' + ledge + '" fill-opacity="' + F.bodyA + '"/><path d="' + GEO.ledgeR + '" fill="' + ledge + '" fill-opacity="' + F.bodyA + '"/>' +
      '<rect x="8" y="0" width="792" height="491" rx="30" fill="' + S.body + '" fill-opacity="' + F.bodyA + '"' + (clear ? ' stroke="' + edgeC + '" stroke-opacity=".55" stroke-width="1.5"' : (lum(S.body) > 0.72 ? ' stroke="' + shade(S.body, -0.3) + '" stroke-opacity=".7" stroke-width="1.5"' : '')) + '/>' +
      '<rect x="8" y="0" width="792" height="491" rx="30" fill="' + url('bodyLight') + '"/>' +
      '<rect x="9" y="1" width="790" height="489" rx="29" fill="none" stroke="' + url('edge') + '" stroke-width="1.5"/>' +
      (F.notches ? '<g fill="#fff" fill-opacity=".25" stroke="' + edgeC + '" stroke-opacity=".55" stroke-width="1.5"><path d="M83 0V29H133V0"/><path d="M675 0V29H725V0"/></g>' : '') +
      (F.liner ? '<g fill="none" stroke="' + edgeC + '" stroke-opacity=".4" stroke-width="1.4"><path d="M66 100C30 200 30 300 66 352"/><path d="M742 100C778 200 778 300 742 352"/></g>' : '') +
      '</g>';

    /* reels */
    var standOn = !!cfg.reelStandIns;
    var reels = '<g data-layer="reels" clip-path="' + url(F.reelsIn === 'pill' ? 'pillClip' : 'cavClip') + '">' +
      '<g data-reel="left" transform="translate(' + MOUNTS.left.x + ' ' + MOUNTS.left.y + ')">' + (standOn ? standIn(c, 'left') : '') + '</g>' +
      '<g data-reel="right" transform="translate(' + MOUNTS.right.x + ' ' + MOUNTS.right.y + ')">' + (standOn ? standIn(c, 'right') : '') + '</g></g>';

    /* panel: tint first, printed artwork second (clear shells put the reels between them) */
    var panelFill = '<g data-layer="panel"><path d="' + GEO.panel + '" fill="' + S.panel + '" fill-opacity="' + F.panelA + '" stroke="' + shade(S.panel, -0.35) + '" stroke-opacity=".5" stroke-width="1"/></g>';
    var panelArt = '<g data-layer="panel-art"><g clip-path="' + url('panelClip') + '">' + (st.deco ? st.deco(c) : '') + '</g>' + (st.print ? st.print(c) : '') + '</g>';
    var film = F.clear ? '<path data-layer="glass-film" d="' + GEO.panel + '" fill="' + S.body + '" fill-opacity=".16"/>' : '';

    /* paper + handwriting */
    var paper = paperLayer(c, wear);

    /* window */
    var P = GEO.pill, win;
    if (F.pill === 'hole') {
      win = '<g data-layer="window"><rect x="' + P.x + '" y="' + P.y + '" width="' + P.w + '" height="' + P.h + '" rx="' + P.r + '" fill="' + S.window + '"/>' + reels +
        '<rect x="' + P.x + '" y="' + P.y + '" width="' + P.w + '" height="' + P.h + '" rx="' + P.r + '" fill="' + url('pillShade') + '"/>' +
        '<rect x="' + (P.x + .5) + '" y="' + (P.y + .5) + '" width="' + (P.w - 1) + '" height="' + (P.h - 1) + '" rx="' + (P.r - .5) + '" fill="none" stroke="#000" stroke-opacity=".35"/></g>';
    } else {
      win = '<g data-layer="window"><rect x="' + P.x + '" y="' + P.y + '" width="' + P.w + '" height="' + P.h + '" rx="' + P.r + '" fill="' + S.window + '" fill-opacity=".07" stroke="#fff" stroke-opacity=".65" stroke-width="2"/>' +
        '<rect x="' + (P.x + 2) + '" y="' + (P.y + 2) + '" width="' + (P.w - 4) + '" height="' + (P.h - 4) + '" rx="' + (P.r - 2) + '" fill="none" stroke="' + edgeC + '" stroke-opacity=".28"/></g>';
    }

    /* centre tape window */
    var Wn = GEO.tapeWin, tw = '<g data-layer="tape-window">';
    for (var i = 0; i < 7; i++) {
      var tx = 341.6 + i * 20.5, mid = i === 3;
      tw += '<line x1="' + tx.toFixed(1) + '" y1="' + (mid ? 212 : 217) + '" x2="' + tx.toFixed(1) + '" y2="' + (mid ? 238 : 233) + '" stroke="#fff" stroke-width="' + (mid ? 2.4 : 1.8) + '" stroke-linecap="round"/>';
    }
    if (cfg.reelStandIns) tw += marker(c);
    tw += '</g>';

    /* bottom pocket */
    var bf = F.clear ? shade(S.body, 0.5) : (S.bottom || S.body), bfa = F.clear ? 0.35 : 1;
    var bottom = '<g data-layer="bottom"><path d="' + GEO.bottom + '" fill="' + bf + '" fill-opacity="' + bfa + '" filter="' + url('fxBottom') + '"/>';
    var hf = F.clear ? '#1A1F27' : null, hop = F.clear ? ' fill-opacity=".38" stroke="#fff" stroke-opacity=".55"' : '';
    GEO.sqHoles.forEach(function (p) { bottom += '<rect x="' + p[0] + '" y="' + p[1] + '" width="28" height="28" rx="6" fill="' + (hf || holeSq) + '"' + hop + ' filter="' + url('fxHole') + '"/>'; });
    GEO.roundHoles.concat([GEO.centerHole]).forEach(function (p) { bottom += '<ellipse cx="' + p[0] + '" cy="' + p[1] + '" rx="15" ry="14.5" fill="' + (hf || holeRd) + '"' + hop + ' filter="' + url('fxHole') + '"/>'; });
    bottom += '</g>';

    /* rollers (clear shells only) */
    var rollers = '';
    if (F.rollers) [[96, 452], [712, 452]].forEach(function (p) {
      rollers += '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="26" fill="' + url('roller') + '" stroke="#BEBAAC" stroke-width="2"/><circle cx="' + p[0] + '" cy="' + p[1] + '" r="15" fill="none" stroke="#C9C5B7"/><circle cx="' + p[0] + '" cy="' + p[1] + '" r="5" fill="#6C6A64"/>' + (cfg.reelStandIns ? rollerMarks(p[0], p[1], p[0] < 400 ? 'L' : 'R', 20) : '');
    });

    var tapeL = cfg.reelStandIns ? tapeLayer(c) : '';

    /* screws */
    var sc = F.screw, tw8 = [0, 1, 2, 3].map(function () { return (rand() * 2 - 1) * 30 * wear; }), screws = '<g data-layer="screws">';
    GEO.screws.forEach(function (p, k) {
      var x = p[0], y = p[1];
      screws += '<circle cx="' + x + '" cy="' + y + '" r="16" fill="' + sc.bezel + '" filter="' + url('fxBezel') + '"/>' +
        '<circle cx="' + x + '" cy="' + y + '" r="12" fill="' + sc.well + '" filter="' + url('fxWell') + '"/>' +
        '<path d="M' + (x + 3) + ' ' + (y - 3) + 'H' + (x + 9) + 'V' + (y + 3) + 'H' + (x + 3) + 'V' + (y + 9) + 'H' + (x - 3) + 'V' + (y + 3) + 'H' + (x - 9) + 'V' + (y - 3) + 'H' + (x - 3) + 'V' + (y - 9) + 'H' + (x + 3) + 'V' + (y - 3) + 'Z" fill="' + sc.cross + '" transform="rotate(' + tw8[k].toFixed(1) + ' ' + x + ' ' + y + ')" filter="' + url('fxCross') + '"/>';
    });
    screws += '</g>';

    /* wear, sheen, guides */
    var wearG = '';
    if (wear > 0.01) {
      wearG = '<g data-layer="wear" clip-path="' + url('bodyClip') + '"><rect x="0" y="0" width="808" height="495" fill="#000" filter="' + url('grain') + '" opacity="' + (wear * 0.7).toFixed(2) + '"/>';
      var n = Math.round(wear * 16);
      for (var s = 0; s < n; s++) {
        var x0 = 30 + rand() * 740, y0 = 10 + rand() * 470, a = rand() * Math.PI, l = 8 + rand() * 40;
        wearG += '<path d="M' + x0.toFixed(1) + ' ' + y0.toFixed(1) + 'l' + (Math.cos(a) * l).toFixed(1) + ' ' + (Math.sin(a) * l).toFixed(1) + '" stroke="#fff" stroke-opacity="' + (0.1 + rand() * 0.16).toFixed(2) + '" stroke-width="' + (0.5 + rand() * 0.6).toFixed(2) + '" fill="none"/>';
      }
      wearG += '</g>';
    }
    var sheen = cfg.static ? '' : '<g data-layer="sheen" clip-path="' + url('bodyClip') + '" pointer-events="none"><rect x="0" y="0" width="808" height="495" fill="' + url('sheen') + '"/><polygon points="40,495 330,0 400,0 110,495" fill="' + url('streak') + '"/></g>';
    var guides = cfg.guides ? guidesLayer(c) : '';

    /* assemble, in Figma z-order */
    var body = F.clear
      ? shell + panelFill + reels + film + panelArt + paper + win + tw + bottom + rollers + tapeL + screws
      : shell + panelFill + panelArt + paper + win + tw + bottom + screws;
    var after = st.after ? st.after(c) : '';

    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 808 495" width="808" height="495" data-cassette="' + u + '" role="img" aria-label="' + esc('Cassette, ' + st.name + (T.title ? ': ' + T.title : '')) + '">' +
      '<defs>' + d + '</defs>' + body + after + wearG + sheen + guides + '</svg>';
  }

  /* paper strip, ruled lines, side marker, handwriting */
  function paperLayer(c, wear) {
    var S = c.S, T = c.T, pen = c.pen, F = c.F, url = c.url, G = GEO.paper;
    var tone = mix(S.paper, '#C9B27A', wear * 0.22), rule = S.rule || S.ink;
    var out = '<g data-layer="paper"><rect x="107" y="45" width="595" height="94" rx="10" fill="' + tone + '" filter="' + url('fxPaper') + '"/>' +
      '<rect x="107" y="45" width="595" height="94" rx="10" fill="' + url('paperLight') + '"/>' +
      '<g clip-path="' + url('paperClip') + '">' +
      (wear > 0.01 ? '<rect x="107" y="45" width="595" height="94" fill="#6b5a35" filter="' + url('grain') + '" opacity="' + (wear * 0.45).toFixed(2) + '"/>' : '') +
      '<path d="M107 74.5H702M107 109.5H702" stroke="' + rule + '" stroke-opacity=".75" fill="none"/>';
    var x0 = 128, ink = S.ink, side = String(T.side || 'A').slice(0, 2).toUpperCase();
    if (F.badge === 'letter') {
      out += '<text x="141" y="107" text-anchor="middle" font-family="' + pen.family + '" font-size="' + (50 * Math.min(pen.k, 1.1)).toFixed(0) + '" fill="' + ink + '" fill-opacity=".9">' + esc(side) + '</text><path d="M170 54V130" stroke="' + rule + '" stroke-opacity=".35"/>';
      x0 = 184;
    } else if (F.badge === 'dot') {
      out += '<circle cx="146" cy="92" r="24" fill="' + S.accent + '"/><text x="146" y="101" text-anchor="middle" font-family="' + pen.family + '" font-size="26" fill="' + S.paper + '">' + esc(side) + '</text>';
      x0 = 188;
    } else if (F.badge === 'ring') {
      out += '<circle cx="146" cy="92" r="24" fill="none" stroke="' + ink + '" stroke-opacity=".7" stroke-width="2.2"/><text x="146" y="101" text-anchor="middle" font-family="' + pen.family + '" font-size="26" fill="' + ink + '">' + esc(side) + '</text>';
      x0 = 188;
    }
    var maxW = 690 - x0;
    function line(y, str, size, op, bold) {
      if (!str) return '';
      var s = pen.upper ? String(str).toUpperCase() : String(str);
      return '<text x="' + x0 + '" y="' + y + '" font-family="' + pen.family + '" font-size="' + size.toFixed(1) + '" fill="' + ink + '" fill-opacity="' + op + '" letter-spacing="' + pen.ls + '" data-fit="' + maxW + '" data-size="' + size.toFixed(1) + '" transform="rotate(' + pen.tilt + ' ' + x0 + ' ' + y + ')">' + esc(s) + '</text>';
    }
    out += line(105, T.title, 36 * pen.k, 0.95) + line(67, T.subtitle, 19 * pen.k, 0.8) + line(131, T.note, 14.5 * pen.k, 0.72);
    return out + '</g></g>';
  }

  /* developer overlay: reel mounts, clip regions, writing rows */
  function guidesLayer(c) {
    var mk = '#FF2BD6', cy = '#00B7FF', s = '<g data-layer="guides" pointer-events="none" font-family="ui-monospace,Menlo,monospace" font-size="11">';
    var P = GEO.pill;
    if (c.F.reelsIn === 'pill') s += '<rect x="' + P.x + '" y="' + P.y + '" width="' + P.w + '" height="' + P.h + '" rx="' + P.r + '" fill="none" stroke="' + mk + '" stroke-dasharray="5 4"/>';
    else s += '<path d="' + GEO.panel + '" fill="none" stroke="' + mk + '" stroke-dasharray="5 4"/>';
    ['left', 'right'].forEach(function (k) {
      var m = MOUNTS[k];
      s += '<circle cx="' + m.x + '" cy="' + m.y + '" r="' + MOUNTS.radius + '" fill="' + mk + '" fill-opacity=".08" stroke="' + mk + '"/>' +
        '<path d="M' + (m.x - 14) + ' ' + m.y + 'H' + (m.x + 14) + 'M' + m.x + ' ' + (m.y - 14) + 'V' + (m.y + 14) + '" stroke="' + mk + '" stroke-width="1.5"/>' +
        '<text x="' + m.x + '" y="' + (m.y + MOUNTS.radius + 15) + '" text-anchor="middle" fill="' + mk + '">reel-' + k + ' (' + m.x + ',' + m.y + ')</text>';
    });
    [[45, 74.5, 'subtitle'], [74.5, 109.5, 'title'], [109.5, 139, 'note']].forEach(function (r) {
      s += '<rect x="107" y="' + r[0] + '" width="595" height="' + (r[1] - r[0]) + '" fill="none" stroke="' + cy + '" stroke-dasharray="3 3"/><text x="112" y="' + (r[0] + 11) + '" fill="' + cy + '">' + r[2] + '</text>';
    });
    s += '<rect x="313" y="179" width="181" height="91" rx="8" fill="none" stroke="' + cy + '" stroke-dasharray="3 3"/>';
    return s + '</g>';
  }

  /* ---- DOM: mount, fit text, light ---------------------------------------------- */
  function fit(svg) {
    var els = svg.querySelectorAll('text[data-fit]');
    for (var i = 0; i < els.length; i++) {
      var t = els[i], max = +t.getAttribute('data-fit'), size = +t.getAttribute('data-size'), w = 0;
      t.setAttribute('font-size', size); t.removeAttribute('textLength'); t.removeAttribute('lengthAdjust');
      try { w = t.getComputedTextLength(); } catch (e) { w = 0; }
      if (w > max) {
        t.setAttribute('font-size', Math.max(size * 0.62, size * max / w).toFixed(2));
        try { w = t.getComputedTextLength(); } catch (e) { w = 0; }
        if (w > max + 0.5) { t.setAttribute('textLength', max); t.setAttribute('lengthAdjust', 'spacingAndGlyphs'); }
      }
    }
  }
  function refitAll() { var all = document.querySelectorAll('svg[data-cassette]'); for (var i = 0; i < all.length; i++) fit(all[i]); }
  if (global.document && document.fonts) {
    document.fonts.addEventListener && document.fonts.addEventListener('loadingdone', refitAll);
    document.fonts.ready && document.fonts.ready.then(refitAll);
  }

  function mount(el, cfg, opts) {
    opts = opts || {};
    var handle = { el: el, cfg: Object.assign({}, cfg), svg: null, reels: {}, light: null };
    function draw() {
      el.innerHTML = render(handle.cfg);
      var svg = handle.svg = el.firstChild;
      fit(svg);
      handle.reels = { left: svg.querySelector('[data-reel="left"]'), right: svg.querySelector('[data-reel="right"]') };
      if (handle.light) handle.setLight(handle.light.x, handle.light.y);
      if (opts.onRender) opts.onRender(handle);
    }
    handle.update = function (patch) { Object.assign(handle.cfg, patch); draw(); return handle; };
    handle.setLight = function (x, y) {
      handle.light = { x: x, y: y };
      if (!handle.svg) return;
      var g = handle.svg.querySelector('radialGradient[id$="-sheen"]');
      if (g) { g.setAttribute('cx', x); g.setAttribute('cy', y); g.setAttribute('fx', x); g.setAttribute('fy', y); }
    };
    draw();
    return handle;
  }

export const Cassette = {
    version: '1.0', GEO: GEO, MOUNTS: MOUNTS, PENS: PENS, SLOT_LABELS: SLOT_LABELS, helpers: h,
    registerStyle: registerStyle, styles: styles, mounts: function (k) { var st = REG[k]; return (st && st.mounts) || MOUNTS; }, style: function (k) { return REG[k]; },
    render: render, mount: mount, refit: refitAll
  };


export const { registerStyle, styles, style, render, mount, mounts, refit, GEO, MOUNTS, PENS, SLOT_LABELS, helpers } = Cassette;
export default Cassette;
