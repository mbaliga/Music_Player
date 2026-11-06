/* More styles on the same base: the flat, printed-sleeve look (solid colour, bold shapes, no reel drawings so your reels stay the only reels).
   Each is a skin on the shared Figma geometry. Colour slots stay editable. Only generic wording is printed. */
import { Cassette } from './core.js';
(function () {
  'use strict';
  var C = Cassette, h = C.helpers;
  var P = 'M90 34H725L756 64.5V367H53V64.5L90 34Z';
  function poly(pts, fill, op) { return '<path d="M' + pts.join('L') + 'Z" fill="' + fill + '"' + (op != null ? ' fill-opacity="' + op + '"' : '') + '/>'; }
  function R(x, y, w, hh, f, o) { return h.rect(x, y, w, hh, f, o); }
  function def(o) { C.registerStyle(Object.assign({ kind: 'Flat', gloss: 0.35, badge: 'letter' }, o)); }

  def({ id: 'sea', name: 'Sea', note: 'Blue shell, white sleeve', badge: 'dot',
    slots: { body: '#2F6BF0', panel: '#F4F4F2', accent: '#2F6BF0', paper: '#2F6BF0', ink: '#FFFFFF', rule: '#CFE0FF', window: '#17327E', glass: '#FFFFFF', tape: '#EDEDED' }, screw: 'dark', editable: ['body', 'panel', 'paper', 'ink'] });

  def({ id: 'crimson', name: 'Crimson', note: 'Red shell, black sleeve', badge: 'ring',
    slots: { body: '#A7161C', panel: '#090909', accent: '#E8E2D6', paper: '#EDE7DA', ink: '#1B1B1B', rule: '#6F6A60', window: '#2A0A0C', glass: '#E8E2D6' }, editable: ['body', 'panel', 'accent', 'paper'],
    deco: function (c) { var r = c.rand, d = ''; for (var i = 0; i < 7; i++) d += '<path d="M' + (120 + r() * 520) + ' ' + (60 + r() * 260) + 'C' + (80 + r() * 620) + ' ' + (40 + r() * 300) + ' ' + (80 + r() * 620) + ' ' + (60 + r() * 300) + ' ' + (120 + r() * 520) + ' ' + (80 + r() * 260) + '" fill="none" stroke="#fff" stroke-opacity="' + (0.16 + r() * 0.18).toFixed(2) + '" stroke-width="1"/>'; return d; } });

  def({ id: 'noir', name: 'Noir', note: 'Dark with cyan script', badge: 'none',
    slots: { body: '#3B3835', panel: '#080808', accent: '#5BC0D8', paper: '#0E0E0E', ink: '#5BC0D8', rule: '#2B4A52', window: '#2B2B2B', glass: '#E8E8E8' }, editable: ['body', 'panel', 'accent', 'ink'],
    print: function (c) { return h.text(110, 330, 'after dark · side ' + (c.T.side || 'A'), { size: 18, fill: c.S.accent, ls: 2, op: 0.8 }); } });

  def({ id: 'lilac', name: 'Lilac', note: 'Pastel with yellow', badge: 'dot',
    slots: { body: '#B9C6EE', panel: '#D6CBF5', accent: '#FFF08A', paper: '#FFF08A', ink: '#7A6AC8', rule: '#D9C94A', window: '#8C7FD0', glass: '#FFF8C4', tape: '#FFF08A' }, screw: 'silver', editable: ['body', 'panel', 'accent', 'ink'],
    deco: function (c) { return '<defs><linearGradient id="' + c.id('lg') + '" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#B9C6EE"/><stop offset="1" stop-color="#D9CCF8"/></linearGradient></defs><rect x="53" y="34" width="703" height="333" fill="url(#' + c.id('lg') + ')"/><rect x="72" y="52" width="665" height="296" fill="none" stroke="#fff" stroke-width="4" stroke-opacity=".9"/>'; } });

  def({ id: 'marquee', name: 'Marquee', note: 'Black, yellow trim', badge: 'letter',
    slots: { body: '#0C0C0C', panel: '#0C0C0C', accent: '#FFD400', paper: '#FFD400', ink: '#0C0C0C', rule: '#7A6600', window: '#1A1A1A', glass: '#F4F2EA' }, screw: 'dark', editable: ['body', 'accent', 'paper'],
    deco: function (c) { return '<path d="M96 52H713L736 76V352H72V76Z" fill="none" stroke="#fff" stroke-width="4"/><circle cx="76" cy="52" r="9" fill="' + c.S.accent + '"/><circle cx="733" cy="52" r="9" fill="' + c.S.accent + '"/>'; } });

  def({ id: 'gouache', name: 'Gouache', note: 'Painted patches', badge: 'none',
    slots: { body: '#EDE8DD', panel: '#FFFFFF', accent: '#8B6F5E', paper: '#FFFFFF', ink: '#1B1B1B', rule: '#9C9484', window: '#3B3B3B', glass: '#FFFFFF' }, editable: ['body', 'ink'],
    deco: function (c) { var cols = ['#F2D43D', '#5BA84A', '#3548A8', '#E8762C', '#B84C8C', '#8CC4E8', '#C7C03A'], r = c.rand, d = ''; for (var i = 0; i < 46; i++) d += '<rect x="' + (50 + r() * 700).toFixed(0) + '" y="' + (30 + r() * 330).toFixed(0) + '" width="' + (28 + r() * 70).toFixed(0) + '" height="' + (22 + r() * 50).toFixed(0) + '" fill="' + cols[i % cols.length] + '" fill-opacity="' + (0.55 + r() * 0.4).toFixed(2) + '" transform="rotate(' + ((r() - 0.5) * 50).toFixed(0) + ' 400 200)"/>'; return d; } });

  def({ id: 'meadow', name: 'Meadow', note: 'Sky blue, green panel', badge: 'dot',
    slots: { body: '#BFDCF7', panel: '#C9E0A6', accent: '#9A7B68', paper: '#F6F6EF', ink: '#2C3A2A', rule: '#8AA67A', window: '#4E6B45', glass: '#F2F7E4' }, screw: 'silver', editable: ['body', 'panel', 'accent', 'ink'],
    deco: function (c) { var r = c.rand, d = ''; for (var i = 0; i < 90; i++) d += '<circle cx="' + (70 + r() * 660).toFixed(0) + '" cy="' + (250 + r() * 110).toFixed(0) + '" r="' + (1 + r() * 2).toFixed(1) + '" fill="#fff" fill-opacity="' + (0.4 + r() * 0.4).toFixed(2) + '"/>'; return d; } });

  def({ id: 'checker', name: 'Checker', note: 'Black and white squares', badge: 'ring',
    slots: { body: '#F0F0F0', panel: '#F0F0F0', accent: '#A32C2C', paper: '#F0F0F0', ink: '#111111', rule: '#999', window: '#2A2A2A', glass: '#F7F7F7' }, screw: 'dark', editable: ['body', 'accent', 'ink'],
    deco: function (c) { var d = '', s = 37; for (var y = 0; y < 10; y++) for (var x = 0; x < 20; x++) if ((x + y) % 2 === 0) d += '<rect x="' + (35 + x * s) + '" y="' + (25 + y * s) + '" width="' + s + '" height="' + s + '" fill="#0E0E0E"/>'; return d; } });

  def({ id: 'crystal', name: 'Crystal', note: 'Silver, blue shards', badge: 'none',
    slots: { body: '#D2D6DC', panel: '#2540B8', accent: '#2540B8', paper: '#EEF1F6', ink: '#1B2A66', rule: '#8C97C4', window: '#16226B', glass: '#EAF0FA' }, screw: 'silver', editable: ['body', 'panel', 'ink'],
    deco: function (c) { var r = c.rand, d = '', cols = ['#2A44C0', '#5C7AE0', '#A9BCF2', '#FFFFFF', '#1B2F96']; for (var i = 0; i < 38; i++) { var x = 50 + r() * 700, y = 30 + r() * 330; d += poly([x.toFixed(0) + ' ' + y.toFixed(0), (x + 40 + r() * 70).toFixed(0) + ' ' + (y + r() * 50 - 20).toFixed(0), (x + r() * 60 - 10).toFixed(0) + ' ' + (y + 40 + r() * 60).toFixed(0)], cols[i % cols.length], 0.9); } return d; } });

  def({ id: 'bubblegum', name: 'Bubblegum', note: 'Pink with sky window', badge: 'dot',
    slots: { body: '#F7B6CB', panel: '#B8DDF0', accent: '#FFFFFF', paper: '#F7F3F4', ink: '#8A3050', rule: '#C58A9C', window: '#C77A98', glass: '#FFFFFF' }, screw: 'silver', editable: ['body', 'panel', 'ink'],
    deco: function (c) { return '<rect x="53" y="250" width="703" height="117" fill="#9ED3E9" fill-opacity=".6"/>'; } });

  def({ id: 'vellum', name: 'Vellum', note: 'Parchment label, black shell', badge: 'letter',
    slots: { body: '#26221E', panel: '#CBB98F', accent: '#CBB98F', paper: '#EFE6CF', ink: '#2B2418', rule: '#6C5E3E', window: '#26221E', glass: '#C9BA94' }, screw: 'silver', editable: ['body', 'panel', 'paper', 'ink'],
    deco: function (c) { var r = c.rand, d = ''; for (var i = 0; i < 16; i++) d += h.circle((70 + r() * 660).toFixed(0), (40 + r() * 320).toFixed(0), (14 + r() * 40).toFixed(0), '#8A744A', { op: 0.07 + r() * 0.07 }); return d; } });

  def({ id: 'wrap', name: 'Tape Wrap', note: 'Printed tape ribbons', badge: 'none',
    slots: { body: '#7F9FDC', panel: '#AFC7F2', accent: '#F4A6C8', paper: '#F7F8FC', ink: '#2B3A66', rule: '#8AA0D6', window: '#4F6FB8', glass: '#F7F8FC' }, screw: 'silver', editable: ['body', 'panel', 'accent', 'ink'],
    after: function (c) {
      var d = '<g clip-path="url(#' + c.id('bodyClip') + ')">', A = c.S.accent, txt = 'MIXTAPE · SIDE ' + (c.T.side || 'A') + ' · ';
      [[20, 330, -14], [560, 20, 18], [30, 440, 6], [520, 470, -8], [680, 150, 70], [60, 80, -60]].forEach(function (b) { d += '<g transform="translate(' + b[0] + ' ' + b[1] + ') rotate(' + b[2] + ')"><rect x="0" y="-13" width="360" height="26" fill="' + A + '"/><text x="8" y="6" font-family="system-ui,-apple-system,Roboto,sans-serif" font-weight="700" font-size="14" letter-spacing="3" fill="#fff">' + txt + txt + txt + '</text></g>'; });
      return d + '</g>';
    } });

  def({ id: 'harvest', name: 'Harvest', note: 'Olive shell, orange sleeve', badge: 'ring',
    slots: { body: '#BDB78E', panel: '#F2A33C', accent: '#FFFFFF', paper: '#FFFFFF', ink: '#3B3A2A', rule: '#B5AE86', window: '#F2A33C', glass: '#FFFFFF' }, screw: 'silver', editable: ['body', 'panel', 'ink'] });

  def({ id: 'cocoa', name: 'Cocoa', note: 'Brown, amber ribbons', badge: 'none',
    slots: { body: '#5A2E1F', panel: '#F0A80C', accent: '#FFD27A', paper: '#F4A81A', ink: '#3A1D10', rule: '#B87A08', window: '#6A3A12', glass: '#F4EBD8' }, screw: 'silver', editable: ['body', 'panel', 'ink'],
    deco: function (c) { var d = ''; for (var i = 0; i < 9; i++) d += '<path d="M' + (40 + i * 90) + ' 20L' + (100 + i * 90) + ' 20L' + (190 + i * 90) + ' 380L' + (130 + i * 90) + ' 380Z" fill="#B8620C" fill-opacity=".35"/>'; return d; } });

  def({ id: 'hit', name: 'Hit', note: 'Pale blue, navy bars', badge: 'none',
    slots: { body: '#C7E3FB', panel: '#C7E3FB', accent: '#C2184F', paper: '#C7E3FB', ink: '#1B2557', rule: '#8FB4D8', window: '#1B2557', glass: '#F2F8FF' }, screw: 'silver', editable: ['body', 'accent', 'ink'],
    deco: function (c) { return poly(['260 34', '330 34', '290 160', '230 160'], c.S.accent) + poly(['330 34', '725 34', '756 64', '756 150', '300 150'], c.S.ink) + poly(['53 300', '330 300', '330 330', '53 330'], c.S.accent) + poly(['53 330', '756 330', '756 367', '53 367'], c.S.ink); },
    print: function (c) { return h.text(72, 150, 'HIT', { size: 78, weight: 700, italic: 1, fill: c.S.ink }); } });

  def({ id: 'zinc', name: 'Zinc', note: 'Black shell, cream sleeve', badge: 'letter',
    slots: { body: '#242424', panel: '#DDD7C8', accent: '#8C8C8C', paper: '#EDE8DA', ink: '#2A2A2A', rule: '#8A857A', window: '#242424', glass: '#DDD7C8' }, screw: 'silver', editable: ['body', 'panel', 'ink'],
    deco: function (c) { var d = ''; for (var i = 0; i < 4; i++) d += '<rect x="' + (64) + '" y="' + (330 + i * 8) + '" width="60" height="3" fill="#333"/><rect x="' + (686) + '" y="' + (330 + i * 8) + '" width="60" height="3" fill="#333"/>'; return d; } });
})();
