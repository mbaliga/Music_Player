// ─────────────────────────────────────────────────────────────────────────────
// players.js — the two player skins ('deck' and 'player') around a mounted
// mixtape cassette. Ported from the owner's cassette-players.js; the synthesized
// engine is gone: the skin is a pure VIEW + key surface driven by Runout's real
// playback.
//
//   const pl = Players.mount(el, { player: 'deck'|'player', cassette: cfg });
//   pl.update({ playing, progress, time, speed, side, title, loaded })   // state in
//   pl.frame(progress, speedMul, dt)       // once per animation frame (reels)
//   pl.on('toggle'|'stop'|'eject'|'next'|'prev'|'hold'|'release'|'skip'|'tap', fn)  // keys out
//   pl.insert(cfg) / pl.eject() / pl.destroy()
//
// Name-only rule (owner): the skin never prints a song name; the deck prints
// the mixtape title (down the left of the window) and "SIDE A". Tapping the
// cassette emits 'tap' (the host reveals the song list).
//
// Every id / url(#) / href="#" in the (generic-id) chassis SVG is prefixed per
// instance (nsIds) so two skins or a skin and a cassette can never collide.
// ─────────────────────────────────────────────────────────────────────────────

import { Cassette } from './index.js';
import { DECK_SVG, PLAYER_SVG } from './player-skins.js';
import { createReelDriver } from './reels-driver.js';

const NS = 'http://www.w3.org/2000/svg';
const UI = 'system-ui,-apple-system,"Segoe UI",Roboto,sans-serif';

/** Prefix every id, url(#x) and href="#x" in a markup string. */
export function nsIds(markup, pfx) {
  return markup
    .replace(/(\s)id="([^"]+)"/g, (m, sp, id) => `${sp}id="${pfx}${id}"`)
    .replace(/url\(#([^)]+)\)/g, (m, id) => `url(#${pfx}${id})`)
    .replace(/href="#([^"]+)"/g, (m, id) => `href="#${pfx}${id}"`);
}

function sv(name, attrs, parent) {
  const n = document.createElementNS(NS, name);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(n);
  return n;
}

const SEGMAP = { 0: 'abcdef', 1: 'bc', 2: 'abdeg', 3: 'abcdg', 4: 'bcfg', 5: 'acdfg', 6: 'acdefg', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg', ' ': '' };

/* skin: Deck. A counter, level meter and five transport keys. */
function deckSkin(X) {
  const svg = X.svg, api = X.api, $ = X.$;
  const lcd = $('lcd'), W = 56, T = 10;
  const hseg = (cy) => { const x0 = 6, x1 = W - 6, h = T / 2; return [[x0, cy], [x0 + h, cy - h], [x1 - h, cy - h], [x1, cy], [x1 - h, cy + h], [x0 + h, cy + h]]; };
  const vseg = (cx, y0, y1) => { const h = T / 2; return [[cx, y0], [cx + h, y0 + h], [cx + h, y1 - h], [cx, y1], [cx - h, y1 - h], [cx - h, y0 + h]]; };
  const SEG = { a: hseg(5), g: hseg(50), d: hseg(95), f: vseg(5, 8, 47), b: vseg(W - 5, 8, 47), e: vseg(5, 53, 92), c: vseg(W - 5, 53, 92) };
  const digits = [0, 70, 185, 255].map((x) => {
    const g = sv('g', { transform: 'translate(' + x + ' 0)' }, lcd), segs = {};
    Object.keys(SEG).forEach((k) => { segs[k] = sv('polygon', { class: 'seg', points: SEG[k].map((p) => p.join(',')).join(' ') }, g); });
    return { segs, val: -1 };
  });
  const colon = [38, 66].map((y) => sv('rect', { class: 'seg on', x: 150, y: y - 6, width: 12, height: 12, rx: 2 }, lcd));
  const setDigit = (i, d) => {
    const D = digits[i]; if (D.val === d) return; D.val = d; const on = SEGMAP[d];
    Object.keys(D.segs).forEach((k) => { D.segs[k].setAttribute('class', on.indexOf(k) >= 0 ? 'seg on' : 'seg'); });
  };
  const setTime = (sec) => {
    const m = Math.floor(sec / 60) % 100, s = Math.floor(sec % 60);
    setDigit(0, Math.floor(m / 10)); setDigit(1, m % 10); setDigit(2, Math.floor(s / 10)); setDigit(3, s % 10);
  };
  const vuG = $('vu'), vuSegs = [];
  for (let v = 0; v < 11; v++) vuSegs.push(sv('rect', { class: 'vu', x: 210 + v * 105.5, y: 1881, width: 80, height: 26, rx: 4, fill: '#3a3b40' }, vuG));
  const vuColor = (i) => (i < 7 ? '#46c52e' : (i < 9 ? '#e3a51c' : '#dc4630'));
  const lit = new Array(11).fill(-1);
  /* printed title, reads down the left of the window; the mixtape NAME only */
  const host = lcd.parentNode;
  const title = sv('text', { transform: 'translate(335 520) rotate(90)', 'font-family': UI, 'font-weight': 700, fill: '#8d8e96', 'letter-spacing': 4 }, host);
  const sub = sv('text', { transform: 'translate(395 520) rotate(90)', 'font-family': UI, 'font-weight': 500, 'font-size': 38, fill: '#6c6d75', 'letter-spacing': 6 }, host);
  const keysG = $('keys'), keyEls = {};
  const KEYS = [{ id: 'rew', x: 55, w: 275, label: 'Rewind (hold)' }, { id: 'play', x: 343, w: 287, label: 'Play or pause' }, { id: 'stop', x: 643, w: 287, label: 'Stop' }, { id: 'ff', x: 943, w: 285, label: 'Fast forward (hold)' }, { id: 'eject', x: 1240, w: 275, label: 'Close the player' }];
  const KY = 2006, KH = 316, CY = 2165;
  const tri = (pts, fill) => sv('polygon', { points: pts, fill, stroke: fill, 'stroke-width': 7, 'stroke-linejoin': 'round' });
  KEYS.forEach((k) => {
    const cx = k.x + k.w / 2, g = sv('g', { class: 'key', tabindex: 0, role: 'button', 'aria-label': k.label, 'data-key': k.id }, keysG);
    sv('rect', { x: k.x, y: KY + 6, width: k.w, height: KH, rx: 18, fill: '#0b0b0d' }, g);
    const cap = sv('g', { class: 'cap' }, g);
    sv('rect', { class: 'face', x: k.x, y: KY, width: k.w, height: KH, rx: 18, fill: X.url('gKey'), stroke: '#0e0e10', 'stroke-width': 3 }, cap);
    sv('path', { d: 'M' + (k.x + 14) + ' ' + (KY + 3) + ' H' + (k.x + k.w - 14), stroke: 'rgba(255,255,255,.10)', 'stroke-width': 3, 'stroke-linecap': 'round' }, cap);
    const lt = '#d8d8da';
    let icon;
    if (k.id === 'rew') { icon = sv('g', {}, cap); icon.appendChild(tri((cx - 3) + ',' + (CY - 44) + ' ' + (cx - 3) + ',' + (CY + 44) + ' ' + (cx - 56) + ',' + CY, lt)); icon.appendChild(tri((cx + 57) + ',' + (CY - 44) + ' ' + (cx + 57) + ',' + (CY + 44) + ' ' + (cx + 4) + ',' + CY, lt)); }
    else if (k.id === 'ff') { icon = sv('g', {}, cap); icon.appendChild(tri((cx - 57) + ',' + (CY - 44) + ' ' + (cx - 57) + ',' + (CY + 44) + ' ' + (cx - 4) + ',' + CY, lt)); icon.appendChild(tri((cx + 3) + ',' + (CY - 44) + ' ' + (cx + 3) + ',' + (CY + 44) + ' ' + (cx + 56) + ',' + CY, lt)); }
    else if (k.id === 'play') { cap.appendChild(tri((cx - 36) + ',' + (CY - 46) + ' ' + (cx - 36) + ',' + (CY + 46) + ' ' + (cx + 42) + ',' + CY, '#3fb81f')); }
    else if (k.id === 'stop') { sv('rect', { x: cx - 37, y: CY - 38, width: 75, height: 75, rx: 5, fill: lt }, cap); }
    else { icon = sv('g', {}, cap); icon.appendChild(tri((cx - 42) + ',' + (CY - 12) + ' ' + (cx + 42) + ',' + (CY - 12) + ' ' + cx + ',' + (CY - 56), lt)); sv('rect', { x: cx - 44, y: CY + 2, width: 88, height: 20, rx: 5, fill: lt }, icon); }
    sv('rect', { class: 'ring', x: k.x + 4, y: KY + 4, width: k.w - 8, height: KH - 8, rx: 16 }, cap);
    keyEls[k.id] = g;
  });
  let heldKey = null;
  const release = () => { if (heldKey) { heldKey.classList.remove('down'); heldKey = null; api.release(); } };
  const blip = (g) => { g.classList.add('down'); setTimeout(() => { g.classList.remove('down'); paint(true); }, 140); };
  const act = (id, g) => {
    if (id === 'play') api.toggle(); else if (id === 'stop') { api.stop(); blip(g); } else if (id === 'eject') { api.eject(); blip(g); }
  };
  keysG.addEventListener('pointerdown', (e) => {
    const g = e.target.closest ? e.target.closest('.key') : null; if (!g) return; e.preventDefault();
    const id = g.getAttribute('data-key');
    if (id === 'rew' || id === 'ff') { heldKey = g; g.classList.add('down'); api.hold(id === 'ff' ? 1 : -1); } else act(id, g);
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach((t) => keysG.addEventListener(t, release));
  keysG.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const g = e.target.closest ? e.target.closest('.key') : null; if (!g) return; e.preventDefault();
    const id = g.getAttribute('data-key'); if (id !== 'rew' && id !== 'ff') act(id, g);
  });
  let lastTitle = null, lastPlaying = null, lastBlink = null;
  function paint(force) {
    const st = X.state, now = performance.now();
    setTime(st.loaded ? st.time : 0);
    const blink = st.playing ? (Math.floor(now / 500) % 2 === 0) : true;
    if (blink !== lastBlink) { lastBlink = blink; colon.forEach((c) => c.setAttribute('class', blink ? 'seg on' : 'seg')); }
    if (st.playing !== lastPlaying || force) { lastPlaying = st.playing; keyEls.play.classList.toggle('down', !!st.playing); }
    // The level meter is the REAL loudness envelope of the track under the needle (host: st.level).
    const n = st.playing || st.winding ? Math.round(Math.min(1, st.level || 0) * 11) : 0;
    for (let i = 0; i < 11; i++) {
      const on = i < n ? i : -2;
      if (lit[i] !== on) { lit[i] = on; vuSegs[i].setAttribute('fill', i < n ? vuColor(i) : '#3a3b40'); }
    }
    const key = (st.loaded ? st.title : 'NO TAPE') + '|' + st.side;
    if (key !== lastTitle) {
      lastTitle = key;
      const t = (st.loaded ? (st.title || 'Untitled mixtape') : 'NO TAPE').toUpperCase();
      title.textContent = t; title.setAttribute('font-size', Math.max(30, Math.min(92, 1080 / (t.length * 0.62))).toFixed(1));
      sub.textContent = st.loaded ? 'SIDE ' + (st.side || 'A') : 'INSERT A CASSETTE';
    }
  }
  paint(true);
  return { paint, dispose: release };
}

/* skin: Player. LCD with time and bars, prev / next / play, skip, eject, power. */
function playerSkin(X) {
  const svg = X.svg, api = X.api, $ = X.$;
  const st = { on: true, msg: null, msgUntil: 0 };
  const tri = (pts, fill) => '<polygon points="' + pts + '" fill="' + (fill || '#dcdcdc') + '"/>';
  const defs = [
    { id: 'prev', x: 190, y: 1775, w: 275, h: 150, fill: X.url('blue'), label: 'Previous track', icon: (c, m) => tri((c - 52) + ',' + m + ' ' + (c - 6) + ',' + (m - 30) + ' ' + (c - 6) + ',' + (m + 30)) + tri((c - 6) + ',' + m + ' ' + (c + 40) + ',' + (m - 30) + ' ' + (c + 40) + ',' + (m + 30)) },
    { id: 'next', x: 540, y: 1775, w: 272, h: 150, fill: X.url('blue'), label: 'Next track', icon: (c, m) => tri((c + 52) + ',' + m + ' ' + (c + 6) + ',' + (m - 30) + ' ' + (c + 6) + ',' + (m + 30)) + tri((c + 6) + ',' + m + ' ' + (c - 40) + ',' + (m - 30) + ' ' + (c - 40) + ',' + (m + 30)) },
    { id: 'play', x: 958, y: 1775, w: 308, h: 150, fill: X.url('red'), label: 'Play or pause', icon: (c, m) => (X.state.playing ? '<path d="M' + (c - 30) + ' ' + (m - 44) + 'h24v88h-24zM' + (c + 6) + ' ' + (m - 44) + 'h24v88h-24z" fill="#dcdcdc"/>' : tri((c - 28) + ',' + (m - 46) + ' ' + (c - 28) + ',' + (m + 46) + ' ' + (c + 44) + ',' + m)) },
    // plus / minus: the original were volume keys; Runout has no master gain (device volume
    // buttons own it), so they skip 15 s forward / back through the real playback instead.
    { id: 'plus', x: 868, y: 2065, w: 190, h: 150, fill: X.url('key'), label: 'Skip forward 15 seconds', k: 1, icon: (c, m) => '<path d="M' + (c - 34) + ' ' + m + 'H' + (c + 34) + 'M' + c + ' ' + (m - 34) + 'V' + (m + 34) + '" stroke="#e8e8e4" stroke-width="10"/>' },
    { id: 'minus', x: 1104, y: 2065, w: 190, h: 150, fill: X.url('key'), label: 'Skip back 15 seconds', k: 1, icon: (c, m) => '<path d="M' + (c - 34) + ' ' + m + 'H' + (c + 34) + '" stroke="#e8e8e4" stroke-width="10"/>' },
    { id: 'eject', x: 868, y: 2268, w: 190, h: 150, fill: X.url('key'), label: 'Close the player', k: 1, icon: (c, m) => tri(c + ',' + (m - 34) + ' ' + (c - 36) + ',' + (m + 6) + ' ' + (c + 36) + ',' + (m + 6), '#e8e8e4') + '<rect x="' + (c - 36) + '" y="' + (m + 18) + '" width="72" height="13" fill="#e8e8e4"/>' },
    { id: 'power', x: 1104, y: 2268, w: 190, h: 150, fill: X.url('key'), label: 'Power', k: 1, icon: (c, m) => '<path d="M' + (c - 26) + ' ' + (m - 30) + 'A40 40 0 1 0 ' + (c + 26) + ' ' + (m - 30) + '" fill="none" stroke="#e8e8e4" stroke-width="8" stroke-linecap="round"/><path d="M' + c + ' ' + (m - 50) + 'V' + (m - 8) + '" stroke="#e8e8e4" stroke-width="8" stroke-linecap="round"/>' },
  ];
  const bg = $('buttons'), btn = {};
  function drawBtn(d) {
    const c = d.x + d.w / 2, m = d.y + d.h / 2;
    let g = btn[d.id];
    if (!g) g = btn[d.id] = sv('g', { class: 'btn', tabindex: 0, role: 'button', 'aria-label': d.label }, bg);
    g.innerHTML = '<rect x="' + (d.x - 6) + '" y="' + (d.y - 2) + '" width="' + (d.w + 12) + '" height="' + (d.h + 18) + '" rx="14" fill="#08080a" opacity=".75"/><g class="face">' +
      '<rect class="rim" x="' + d.x + '" y="' + d.y + '" width="' + d.w + '" height="' + d.h + '" rx="' + (d.k ? 14 : 10) + '" fill="' + d.fill + '" stroke="' + (d.k ? '#3a3a3d' : '#000') + '" stroke-opacity="' + (d.k ? 1 : 0.55) + '" stroke-width="3"/>' +
      '<rect x="' + (d.x + 4) + '" y="' + (d.y + 4) + '" width="' + (d.w - 8) + '" height="10" rx="5" fill="#fff" opacity="' + (d.k ? 0.08 : 0.25) + '"/>' + d.icon(c, m) + '</g>';
  }
  defs.forEach(drawBtn);
  /* seven-segment time */
  const W = 68, H = 132, T = 17, G = 3;
  const hor = (x, y, l) => { const h = T / 2; return [[x, y], [x + h, y - h], [x + l - h, y - h], [x + l, y], [x + l - h, y + h], [x + h, y + h]]; };
  const ver = (x, y, l) => { const h = T / 2; return [[x, y], [x + h, y + h], [x + h, y + l - h], [x, y + l], [x - h, y + l - h], [x - h, y + h]]; };
  const hl = W - T - 2 * G, vl = H / 2 - T / 2 - 2 * G;
  const segDefs = { a: hor(T / 2 + G, T / 2, hl), g: hor(T / 2 + G, H / 2, hl), d: hor(T / 2 + G, H - T / 2, hl), f: ver(T / 2, T / 2 + G + T / 2, vl), b: ver(W - T / 2, T / 2 + G + T / 2, vl), e: ver(T / 2, H / 2 + G + T / 2, vl), c: ver(W - T / 2, H / 2 + G + T / 2, vl) };
  const digitsG = $('digits'), X0 = 244, Y0 = 2108;
  digitsG.setAttribute('transform', 'translate(0 2174) skewX(-5) translate(0 -2174)');
  const cells = [X0, X0 + 115, X0 + 205].map((x) => {
    const g = sv('g', { transform: 'translate(' + x + ' ' + Y0 + ')' }, digitsG), o = {};
    Object.keys(segDefs).forEach((k) => { o[k] = sv('polygon', { points: segDefs[k].map((q) => q.join(',')).join(' '), class: 'seg' }, g); });
    return o;
  });
  const colon = [0, 1].map((i) => sv('rect', { x: X0 + 82, y: Y0 + (i ? 82 : 32), width: 17, height: 17, class: 'seg' }, digitsG));
  const setCell = (o, ch) => { const on = SEGMAP[ch] || ''; Object.keys(o).forEach((k) => { o[k].classList.toggle('on', on.indexOf(k) >= 0); }); };
  const NB = 26, barsG = $('bars'), bars = [];
  for (let i = 0; i < NB; i++) bars.push(sv('rect', { x: 248 + i * 20, y: 2268, width: 12, height: 100, class: 'bar off' }, barsG));
  const lcdOff = $('lcdOff'), lcdIcon = $('lcdIcon'), lcdMsg = $('lcdMsg');
  let lastChars = '', lastBars = -1, lastPlaying = null, lastOn = null;
  function flash(num, text) { st.msg = { num: String(num), text }; st.msgUntil = Date.now() + 1000; paint(true); setTimeout(() => paint(true), 1050); }
  function paint(force) {
    const s = X.state, showMsg = st.msg && Date.now() < st.msgUntil, p = s.loaded ? s.progress : 0;
    if (s.playing !== lastPlaying || force) { lastPlaying = s.playing; drawBtn(defs[2]); }
    if (st.on !== lastOn) { lastOn = st.on; lcdOff.setAttribute('opacity', st.on ? 0 : 0.88); }
    if (!st.on) {
      if (lastChars !== 'off') {
        lastChars = 'off'; cells.forEach((c) => setCell(c, ' ')); colon.forEach((c) => c.classList.remove('on'));
        bars.forEach((b) => b.setAttribute('class', 'bar off')); lastBars = -1; lcdIcon.style.display = 'none'; lcdMsg.textContent = '';
      }
      return;
    }
    let chars;
    if (showMsg) chars = st.msg.num.length > 1 ? [' ', st.msg.num[0], st.msg.num[1]] : [' ', ' ', st.msg.num];
    else { const sec = Math.floor(s.loaded ? s.time : 0), mm = Math.min(9, Math.floor(sec / 60)), ss = Math.min(59, sec - Math.floor(sec / 60) * 60); chars = [String(s.loaded && sec >= 600 ? 9 : mm), String(Math.floor(ss / 10)), String(ss % 10)]; }
    const sig = chars.join('') + (showMsg ? st.msg.text : '');
    if (sig !== lastChars || force) {
      lastChars = sig;
      cells.forEach((c, i) => setCell(c, chars[i]));
      colon.forEach((c) => c.classList.toggle('on', !showMsg));
      lcdMsg.textContent = showMsg ? st.msg.text : '';
      lcdIcon.style.display = showMsg ? 'none' : '';
    }
    const n = Math.round(p * NB);
    if (n !== lastBars) { lastBars = n; bars.forEach((b, i) => b.setAttribute('class', 'bar' + (i < n ? '' : ' off'))); }
  }
  const acts = {
    prev: () => api.prev(),
    next: () => api.next(),
    play: () => api.toggle(),
    plus: () => { api.skip(15); flash(15, 'FWD'); },
    minus: () => { api.skip(-15); flash(15, 'BACK'); },
    eject: () => api.eject(),
    power: () => { st.on = !st.on; if (!st.on && X.state.playing) api.toggle(); paint(true); },
  };
  Object.keys(acts).forEach((id) => {
    const el = btn[id];
    const run = () => { if (!st.on && id !== 'power') return; acts[id](); };
    el.addEventListener('click', run);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.classList.add('down'); run(); } });
    el.addEventListener('keyup', () => el.classList.remove('down'));
  });
  paint(true);
  return { paint, dispose() {} };
}

/* skin table: window rectangle, where the cassette sits and how big, which way it is turned */
export const SKINS = {
  player: { name: 'Player', note: 'LCD, prev and next, skip', W: 1449, H: 2576, svg: PLAYER_SVG, cls: 'sk-player', make: playerSkin, rot: 90,
    win: { x: 165, y: 80, w: 1150, h: 1630, r: 12 }, fit: 'body', len: 1565, at: [750, 887], out: 1500 },
  deck: { name: 'Deck', note: 'Counter, level meter, wind keys', W: 1568, H: 2352, svg: DECK_SVG, cls: 'sk-deck', make: deckSkin, rot: -90,
    win: { x: 460, y: 168, w: 490, h: 1500, r: 20 }, fit: 'reels', gap: 730, at: [705, 915], out: 1000 },
};
export const SKIN_IDS = Object.freeze(['deck', 'player']);

let uid = 0;

/**
 * Mount a player skin in `el`. opts: { player, cassette (cfg), windStart(dir), windEnd() }
 * Returns the handle documented at the top of this file.
 */
export function mountPlayer(el, opts = {}) {
  const sk = SKINS[opts.player] || SKINS.deck, u = 'cp' + (++uid) + '-', w = sk.W, hh = sk.H;
  const fit = document.createElement('div'); fit.className = 'cp-fit';
  const p = document.createElement('div'); p.className = 'cp ' + sk.cls; p.style.width = w + 'px'; p.style.height = hh + 'px';
  p.innerHTML = '<svg class="cp-art" viewBox="0 0 ' + w + ' ' + hh + '" xmlns="http://www.w3.org/2000/svg">' + nsIds(sk.svg, u) + '</svg>';
  fit.appendChild(p); el.textContent = ''; el.appendChild(fit);
  const svg = p.firstChild;

  const win = document.createElement('div'); win.className = 'cp-win';
  win.style.cssText = 'left:' + sk.win.x + 'px;top:' + sk.win.y + 'px;width:' + sk.win.w + 'px;height:' + sk.win.h + 'px;border-radius:' + sk.win.r + 'px;clip-path:inset(0 round ' + sk.win.r + 'px)';
  const cass = document.createElement('div'); cass.className = 'cp-cass'; win.appendChild(cass); p.appendChild(win);
  p.insertAdjacentHTML('beforeend', '<svg class="cp-over" viewBox="0 0 ' + w + ' ' + hh + '" xmlns="http://www.w3.org/2000/svg"><defs><clipPath id="' + u + 'gc"><rect x="' + sk.win.x + '" y="' + sk.win.y + '" width="' + sk.win.w + '" height="' + sk.win.h + '" rx="' + sk.win.r + '"/></clipPath><linearGradient id="' + u + 'gl" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".16"/><stop offset=".35" stop-color="#fff" stop-opacity=".02"/><stop offset=".7" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#fff" stop-opacity=".08"/></linearGradient></defs><g clip-path="url(#' + u + 'gc)"><rect x="' + sk.win.x + '" y="' + sk.win.y + '" width="' + sk.win.w + '" height="' + sk.win.h + '" fill="url(#' + u + 'gl)"/></g></svg>');

  let scale = 1;
  const outX = sk.out;
  const pose = (mode) => { cass.style.transform = 'translate(-50%,-50%) translateX(' + (mode === 'in' ? 0 : outX) + 'px) rotate(' + sk.rot + 'deg) scale(' + scale + ')'; };
  const poseNow = (mode) => { cass.style.transition = 'none'; pose(mode); cass.getBoundingClientRect(); cass.style.transition = ''; };

  const listeners = {};
  const state = { loaded: false, inserted: false, playing: false, winding: false, progress: 0, time: 0, speed: 0, level: 0, title: '', side: 'A', cfg: null };
  let driver = null, cassH = null, skin = null, fade = null, lastPaint = 0, ro = null;
  const emit = (type, d) => { (listeners[type] || []).forEach((f) => f(d, api)); };

  function loadCass(cfg) {
    const st = Cassette.style(cfg.style) || {}, vb = st.vb || [808, 495], bodyW = st.bodyW || 792, m = Cassette.mounts(cfg.style);
    clearTimeout(fade); cass.style.pointerEvents = ''; cass.textContent = '';
    if (driver) driver.destroy();
    driver = createReelDriver({ onWindStart: (d) => emit('hold', d), onWindEnd: () => emit('release') });
    cassH = Cassette.mount(cass, Object.assign({}, cfg, { static: true, reelStandIns: true, progress: state.progress }), {
      onRender: (h) => { driver.bind(h, st); driver.set(state.progress); },
    });
    cass.style.width = vb[0] + 'px'; cass.style.height = vb[1] + 'px';
    /* scale, then slide the cassette so the reels' midpoint (or the shell's centre) lands on the skin's target */
    let mid;
    const glass = st.kind === 'Glass';
    if (sk.fit === 'body') { scale = sk.len / bodyW; mid = glass ? [337.5, 219.5] : [404, 245.5]; }
    else { scale = sk.gap / (m.right.x - m.left.x); mid = [(m.left.x + m.right.x) / 2, m.left.y]; }
    const dx = mid[0] - vb[0] / 2, dy = mid[1] - vb[1] / 2, a = sk.rot * Math.PI / 180;
    const rx = dx * Math.cos(a) - dy * Math.sin(a), ry = dx * Math.sin(a) + dy * Math.cos(a);
    cass.style.left = (sk.at[0] - scale * rx - sk.win.x) + 'px'; cass.style.top = (sk.at[1] - scale * ry - sk.win.y) + 'px';
    cass.style.opacity = 1;
  }

  const api = {
    el: p, slot: cass, state, skin: sk,
    get cassette() { return cassH; },
    on(type, fn) { (listeners[type] = listeners[type] || []).push(fn); return api; },
    // keys out (skins call these)
    toggle() { emit('toggle'); }, stop() { emit('stop'); }, eject() { emit('eject'); },
    next() { emit('next'); }, prev() { emit('prev'); }, skip(s) { emit('skip', s); },
    hold(dir) { emit('hold', dir); }, release() { emit('release'); },

    insert(cfg) {
      state.cfg = cfg; state.loaded = true; state.title = (cfg.text && cfg.text.title) || ''; state.side = (cfg.text && cfg.text.side) || 'A';
      loadCass(cfg); poseNow('out'); paint(true);
      requestAnimationFrame(() => requestAnimationFrame(() => { pose('in'); state.inserted = true; emit('insert', cfg); }));
      return api;
    },
    /** Re-draw the loaded cassette after its cfg changed (label edit); keeps progress. */
    restyle(cfg) { if (state.inserted) { state.cfg = cfg; loadCass(cfg); poseNow('in'); } return api; },
    slideOut() {
      if (!state.inserted) return api;
      pose('out'); cass.style.pointerEvents = 'none'; state.inserted = false;
      clearTimeout(fade);
      fade = setTimeout(() => { if (!state.inserted) { cass.style.opacity = 0; state.cfg = null; state.loaded = false; paint(true); } }, 1100);
      return api;
    },
    /** State in. Cheap; call whenever something changed. */
    update(patch) {
      let structural = false;
      for (const k in patch) {
        if (state[k] !== patch[k]) { state[k] = patch[k]; if (k === 'playing' || k === 'winding' || k === 'loaded' || k === 'title' || k === 'side') structural = true; }
      }
      if (structural) paint(false);   // continuous values (progress, time, level) repaint from frame(), throttled
      return api;
    },
    /** One animation frame: reels from real progress + speed multiple. Throttles the skin repaint. */
    frame(progress, mul, dt, now) {
      if (driver) driver.frame(progress, mul, dt);
      if (now - lastPaint > 66) { lastPaint = now; paint(false); }
    },
    destroy() { clearTimeout(fade); if (driver) driver.destroy(); if (skin && skin.dispose) skin.dispose(); if (ro) ro.disconnect(); el.textContent = ''; },
  };
  const $ = (id) => svg.querySelector('#' + u + id);
  skin = sk.make({ svg, api, state, p, $, url: (id) => 'url(#' + u + id + ')' });
  function paint(force) { if (skin) skin.paint(force); }
  const resize = () => {
    const s = el.clientWidth / w;
    if (!isFinite(s) || s <= 0) return;
    p.style.transform = 'scale(' + s + ')'; fit.style.height = (hh * s) + 'px';
  };
  ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
  if (ro) ro.observe(el);
  resize();
  poseNow('out'); cass.style.opacity = 0;
  // tap the cassette (anywhere except the reels, which wind) -> host reveals the song list
  win.addEventListener('click', () => emit('tap'));
  paint(true);
  if (opts.cassette) { api.insert(opts.cassette); poseNow('in'); }
  return api;
}

export const Players = { mount: mountPlayer, skins: SKINS, list: () => SKIN_IDS.map((k) => ({ id: k, ...SKINS[k] })) };
