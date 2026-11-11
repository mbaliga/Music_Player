/* ============================================================================
   cassette-styles.js
   Every style below is a skin on the same Figma base (cassette-core.js).
   A style only supplies colours (slots), flags, and optional drawing hooks:

     slots   colour defaults: body, panel, accent, paper, ink, rule, window, glass, print, tape
     clear   true = translucent shell (body/panel alpha, reels visible across the cavity)
     badge   'letter' | 'dot' | 'ring' | 'none'   side marker on the paper strip
     deco(c) markup clipped to the label panel, drawn under the paper and window
     print(c) printed words on the label panel
     after(c) anything drawn above the whole cassette
     editable  which slots the personalisation panel exposes

   Label panel zones (px, 808 x 495 space):
     left column  x 53-178    right column  x 630-756
     bottom band  y 300-367   window (pill) y 157-293
   Only generic wording is printed (no brand names or logos).
   ========================================================================== */
import { Cassette } from './core.js';
(function () {
  'use strict';
  var C = Cassette, h = C.helpers, t = h.text, R = h.rect;

  /* 1. The original: your Figma file, colour for colour ------------------- */
  C.registerStyle({
    id: 'brass', name: 'Brass', kind: 'Original', note: 'Your Figma base', gloss: 0.45, strips: false, badge: 'letter',
    slots: { body: '#353537', panel: '#CDA760', accent: '#CDA760', paper: '#DAD6CF', ink: '#2B2A28', rule: '#3F3B34', window: '#312E27', glass: '#D9D9D9', hole: '#000000', hole2: '#242425' },
    editable: ['body', 'panel', 'paper', 'ink']
  });

  /* 2-4. Clear and tinted-clear shells ------------------------------------ */
  C.registerStyle({
    id: 'clear', name: 'Clear', kind: 'Clear', note: 'The classic mixtape', clear: true, gloss: 0.85, badge: 'dot',
    slots: { body: '#C7D0D8', panel: '#FFFFFF', accent: '#E9463C', paper: '#EFEEE7', ink: '#1B1B1B', rule: '#85857F', window: '#FFFFFF', glass: '#E6E9EA' },
    editable: ['body', 'accent', 'paper', 'ink']
  });

  C.registerStyle({
    id: 'smoke', name: 'Smoke', kind: 'Clear', note: 'Lilac tint', clear: true, gloss: 0.85, badge: 'dot', bodyA: 0.68, panelA: 0.26,
    slots: { body: '#8F87B8', panel: '#CFC8EA', accent: '#6A5FA0', paper: '#EEEBE6', ink: '#1F1D2B', rule: '#7A7690', window: '#FFFFFF', glass: '#DDDCE6', print: '#FFFFFF' },
    editable: ['body', 'panel', 'accent', 'paper', 'ink'],
    print: function (c) {
      return t(404, 312, 'TYPE I · NORMAL POSITION', { size: 14, ls: 3, fill: c.S.print, anchor: 'middle', op: 0.9 }) +
        t(404, 357, 'C 60', { size: 50, anchor: 'middle', fill: c.S.print, op: 0.95, ls: 2 });
    }
  });

  C.registerStyle({
    id: 'aqua', name: 'Aqua', kind: 'Clear', note: 'Cyan with coral print', clear: true, gloss: 0.85, badge: 'dot', bodyA: 0.62, panelA: 0.3,
    slots: { body: '#4DC2F0', panel: '#BDEEFF', accent: '#E5536A', paper: '#EFF3F2', ink: '#12303C', rule: '#6C8C98', window: '#FFFFFF', glass: '#DCEFF6' },
    editable: ['body', 'panel', 'accent', 'paper', 'ink'],
    print: function (c) {
      var A = c.S.accent;
      return t(112, 260, '74', { size: 66, weight: 700, italic: 1, anchor: 'middle', fill: A }) +
        h.ellipse(693, 222, 40, 17, A, { rot: -12 }) + h.ellipse(693, 222, 18, 7, '#FFFFFF', { op: 0.92, rot: -12 }) + h.circle(693, 222, 5, A) +
        t(404, 336, 'LOW NOISE · HIGH OUTPUT', { size: 16, ls: 5, anchor: 'middle', fill: '#12303C', op: 0.7 });
    }
  });

  /* 5-6. Pop: confetti and cocktail shapes ---------------------------------- */
  function glass(x, y, r, col) {
    return '<g transform="translate(' + x + ' ' + y + ') rotate(' + r + ')"><path d="M-25-28H25L0 6Z" fill="' + col + '"/><path d="M0 6V30M-15 31H15" stroke="' + col + '" stroke-width="5" stroke-linecap="round" fill="none"/><circle cx="9" cy="-17" r="5" fill="#fff" fill-opacity=".6"/></g>';
  }
  function pop(c) {
    var A = c.S.accent, B = c.S.pop2 || '#E8506A', o = '';
    o += glass(100, 252, -14, A) + glass(712, 248, 14, A) + glass(640, 340, -22, B) + glass(206, 340, 20, B);
    o += h.circle(72, 172, 10, 'none', { stroke: A, sw: 5 }) + h.circle(152, 166, 7, B) + h.circle(736, 174, 11, 'none', { stroke: A, sw: 5 }) + h.circle(668, 306, 6, B);
    o += h.circle(330, 338, 9, 'none', { stroke: A, sw: 5 }) + h.circle(488, 342, 7, B) + h.circle(406, 328, 5, A) + h.circle(110, 336, 8, 'none', { stroke: B, sw: 4 }) + h.circle(736, 336, 9, 'none', { stroke: B, sw: 4 });
    o += h.path('M120 360L142 318L164 360Z', B, { op: 0.9, tf: 'translate(430 -6)' });
    return o;
  }
  C.registerStyle({
    id: 'rose', name: 'Rose Pop', kind: 'Tinted', note: 'Confetti and cocktails', clear: true, gloss: 0.85, badge: 'dot', bodyA: 0.62, panelA: 0.28, deco: pop,
    slots: { body: '#F4A3B5', panel: '#FFD9E2', accent: '#2FB3AD', pop2: '#E8506A', paper: '#FCF1F3', ink: '#6B1F36', rule: '#B07A88', window: '#FFFFFF', glass: '#F6DCE2' },
    editable: ['body', 'panel', 'accent', 'paper', 'ink']
  });
  C.registerStyle({
    id: 'lime', name: 'Lime Pop', kind: 'Tinted', note: 'Same party, greener', clear: true, gloss: 0.85, badge: 'dot', bodyA: 0.66, panelA: 0.26, deco: pop,
    slots: { body: '#74DB43', panel: '#C9F5B0', accent: '#2F6FD8', pop2: '#F1397E', paper: '#F5F9EE', ink: '#1D4A12', rule: '#71906A', window: '#FFFFFF', glass: '#E1F2D8' },
    editable: ['body', 'panel', 'accent', 'paper', 'ink']
  });

  /* 7. Cobalt: deep blue translucent ----------------------------------------- */
  C.registerStyle({
    id: 'cobalt', name: 'Cobalt', kind: 'Tinted', note: 'High-bias blue', clear: true, gloss: 0.9, badge: 'ring', bodyA: 0.92, panelA: 0.42,
    slots: { body: '#1E49C8', panel: '#3E73EE', accent: '#9AD7FF', paper: '#EEF1F6', ink: '#0F2150', rule: '#5C6C9C', window: '#0E1B4A', glass: '#C9D6F5', print: '#DFF1FF', tape: '#14214F' },
    editable: ['body', 'panel', 'accent', 'paper', 'ink'],
    print: function (c) {
      return t(404, 318, 'HIGH BIAS · TYPE II', { size: 15, ls: 4, anchor: 'middle', fill: c.S.print, op: 0.85 }) +
        t(738, 268, '74', { size: 84, weight: 700, anchor: 'end', fill: c.S.accent, op: 0.95 }) +
        t(86, 225, 'CHROME', { size: 20, ls: 7, anchor: 'middle', rot: -90, fill: c.S.print, op: 0.85 });
    }
  });

  /* 8. Memphis: yellow header, flat shapes ------------------------------------ */
  C.registerStyle({
    id: 'memphis', name: 'Memphis', kind: 'Clear', note: 'Loud, flat, 1990', clear: true, gloss: 0.8, badge: 'letter', bodyA: 0.55, panelA: 0.18,
    slots: { body: '#D6E2EA', panel: '#FFFFFF', accent: '#E8338C', paper: '#F6D84C', ink: '#1B2146', rule: '#1B2146', window: '#FFFFFF', glass: '#E9EEF1' },
    editable: ['body', 'accent', 'paper', 'ink'],
    deco: function (c) {
      var A = c.S.accent;
      return h.path('M70 354L136 258L200 354Z', '#2F3E9E') + R(560, 302, 160, 56, A) + h.circle(716, 246, 18, '#27B3A4') +
        h.circle(98, 196, 12, 'none', { stroke: '#1B2146', sw: 4 }) + R(268, 322, 120, 8, '#1B2146', { op: 0.85 }) + R(268, 338, 84, 8, '#27B3A4');
    },
    print: function (c) { return t(708, 348, '90', { size: 48, weight: 700, anchor: 'end', fill: '#FFFFFF' }); }
  });

  /* 9-17. Opaque label shells --------------------------------------------------- */
  C.registerStyle({
    id: 'candy', name: 'Candy Stripe', kind: 'Opaque', note: 'Diagonal red and white', badge: 'letter',
    slots: { body: '#DB4B2F', panel: '#F6F2EB', accent: '#D8402B', paper: '#FBF7F0', ink: '#8A2412', rule: '#C9523A', window: '#6F2517', glass: '#E9D7C9' },
    editable: ['body', 'panel', 'accent', 'paper', 'ink'],
    deco: function (c) { return h.diag(53, 143, 703, 224, { angle: -52, sw: 44, gap: 44, fill: c.S.accent }); }
  });

  C.registerStyle({
    id: 'rainbow', name: 'Rainbow', kind: 'Opaque', note: 'Six bands and a navy base', badge: 'letter',
    slots: { body: '#D8CCB1', panel: '#EFE7D3', accent: '#2F3A4C', paper: '#F8F3E3', ink: '#2E3A4C', rule: '#7C8190', window: '#3A332B', glass: '#E4DDCC', print: '#B9C6D6' },
    editable: ['body', 'panel', 'accent', 'paper', 'ink'],
    deco: function (c) {
      var cols = ['#E2453C', '#F08A3A', '#F5C443', '#6DB56B', '#3F9AD6', '#6F5BB3'], o = '';
      cols.forEach(function (k, i) { o += R(53, 150 + i * 23.6, 703, 23.8, k); });
      return o + R(53, 296, 703, 71, c.S.accent);
    },
    print: function (c) { return t(404, 346, 'HI-FI SOUND', { size: 36, italic: 1, weight: 700, anchor: 'middle', fill: c.S.print, ls: 3 }); }
  });

  C.registerStyle({
    id: 'tangerine', name: 'Tangerine', kind: 'Opaque', note: 'Cream over orange, teal base', badge: 'letter',
    slots: { body: '#E7A05B', panel: '#F6E8C9', accent: '#25A3A8', paper: '#FBF3DF', ink: '#2A3A3C', rule: '#8A7A58', window: '#2C2A26', glass: '#F1E8D2', print: '#FFF6E2' },
    editable: ['body', 'panel', 'accent', 'paper', 'ink'],
    deco: function (c) { return R(53, 293, 703, 6, c.S.body) + R(53, 300, 703, 67, c.S.accent); },
    print: function (c) { return t(404, 346, 'SOUND TRACK', { size: 42, weight: 700, anchor: 'middle', fill: c.S.print, ls: 3 }); }
  });

  C.registerStyle({
    id: 'valentine', name: 'Valentine', kind: 'Opaque', note: 'Coral, white and hearts', badge: 'letter',
    slots: { body: '#EF7683', panel: '#F8F2EA', accent: '#E9505F', paper: '#FFFFFF', ink: '#C23B4E', rule: '#E69AA4', window: '#D84655', glass: '#F6DDE0', print: '#FFFFFF' },
    editable: ['body', 'panel', 'accent', 'paper', 'ink'],
    deco: function (c) {
      return R(53, 300, 703, 67, c.S.accent) + h.heart(130, 334, 1.5, c.S.print, 0.9) + h.heart(678, 334, 1.5, c.S.print, 0.9) +
        h.heart(86, 322, 0.8, c.S.print, 0.6) + h.heart(722, 346, 0.8, c.S.print, 0.6);
    },
    print: function (c) { return t(404, 343, 'WITH LOVE', { size: 32, ls: 9, weight: 700, anchor: 'middle', fill: c.S.print }); }
  });

  C.registerStyle({
    id: 'stereo', name: 'Stereo Blue', kind: 'Opaque', note: 'Three stripes, big 60', badge: 'letter',
    slots: { body: '#2D58A8', panel: '#F4F2EB', accent: '#E2453C', paper: '#FFFFFF', ink: '#1E3A74', rule: '#7D8FB8', window: '#ECE6D4', glass: '#E8EBF2', print: '#23407E' },
    editable: ['body', 'panel', 'accent', 'paper', 'ink'],
    deco: function (c) { return R(53, 141, 703, 4, c.S.accent) + R(53, 147, 703, 4, '#F08A3A') + R(53, 153, 703, 4, '#F5C443'); },
    print: function (c) {
      return t(74, 352, 'STEREO', { size: 66, italic: 1, weight: 700, fill: c.S.print }) +
        t(738, 356, '60', { size: 84, weight: 700, anchor: 'end', fill: c.S.accent }) +
        t(404, 338, '2×30 MIN', { size: 16, ls: 4, anchor: 'middle', fill: c.S.print, op: 0.7 });
    }
  });

  C.registerStyle({
    id: 'signal', name: 'Signal', kind: 'Opaque', note: 'Black body, red label', badge: 'letter',
    slots: { body: '#232325', panel: '#E4322C', accent: '#F2F1ED', paper: '#F2F1ED', ink: '#1C1C1E', rule: '#8B8B90', window: '#1B1B1D', glass: '#DAD8D2', print: '#FFFFFF' },
    editable: ['body', 'panel', 'accent', 'paper', 'ink'],
    deco: function (c) { return R(53, 318, 703, 36, c.S.accent); },
    print: function (c) {
      return t(116, 262, '60', { size: 72, weight: 700, anchor: 'middle', fill: c.S.print }) +
        t(693, 208, 'N.R.', { size: 20, ls: 2, weight: 700, anchor: 'middle', fill: c.S.print }) +
        h.circle(676, 224, 5, c.S.print) + h.circle(710, 224, 5, 'none', { stroke: c.S.print, sw: 2 }) +
        t(404, 343, 'NORMAL BIAS · 120µs EQ', { size: 19, ls: 4, anchor: 'middle', fill: '#1C1C1E', op: 0.85 });
    }
  });

  C.registerStyle({
    id: 'hifi', name: 'Hi-Fi', kind: 'Opaque', note: 'Black body, cyan label', badge: 'letter',
    slots: { body: '#1E1F22', panel: '#37B5DF', accent: '#FFFFFF', paper: '#F1ECD8', ink: '#17262E', rule: '#7B8B90', window: '#121315', glass: '#DDE7EA', print: '#FFFFFF' },
    editable: ['body', 'panel', 'paper', 'ink'],
    deco: function (c) { return R(53, 306, 703, 2, c.S.print, { op: 0.7 }); },
    print: function (c) {
      return t(114, 237, 'HI-FI', { size: 40, weight: 700, anchor: 'middle', fill: c.S.print }) +
        t(694, 237, 'C-60', { size: 40, weight: 700, anchor: 'middle', fill: c.S.print }) +
        t(404, 334, 'LOW NOISE · 120µs EQ', { size: 15, ls: 5, anchor: 'middle', fill: '#0F2A36', op: 0.8 });
    }
  });

  C.registerStyle({
    id: 'mint', name: 'Mint', kind: 'Opaque', note: 'Quiet cream and mint', badge: 'ring',
    slots: { body: '#EDE3C3', panel: '#D3E8DC', accent: '#4F7B6B', paper: '#F8F4E3', ink: '#26352F', rule: '#7E9A8E', window: '#2B312E', glass: '#E5EFE9', print: '#4F7B6B' },
    editable: ['body', 'panel', 'accent', 'paper', 'ink'],
    deco: function (c) { return R(100, 321, 150, 1.6, c.S.print, { op: 0.6 }) + R(558, 321, 150, 1.6, c.S.print, { op: 0.6 }); },
    print: function (c) { return t(404, 329, 'MIXTAPE', { size: 24, ls: 14, weight: 600, anchor: 'middle', fill: c.S.print }); }
  });

  C.registerStyle({
    id: 'white', name: 'Blank White', kind: 'Opaque', note: 'Matte, silver screws', gloss: 0.6, badge: 'letter', screw: 'silver',
    slots: { body: '#EFEFEB', panel: '#F6F6F2', accent: '#BDBDB8', paper: '#FBFBF9', ink: '#2A2A2A', rule: '#9A9A95', window: '#DCDCD7', glass: '#F0F0EC', print: '#8A8A85', hole: '#BEBEB9', hole2: '#C6C6C1' },
    editable: ['body', 'panel', 'paper', 'ink']
  });
})();
