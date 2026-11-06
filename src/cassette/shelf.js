// shelf.js — the Mixtapes shelf: a Stack of cassettes (label strips) and the
// full-bleed Library of tape-case spines. Ported from the owner's
// cassette-players.js (Stack, Library, spineSvg); fonts are the bundled pen
// fonts + system stacks (no network). Items are {id, cfg} with cfg from
// mixtape.js:cassetteCfg.
import { Cassette } from './index.js';

const H = Cassette.helpers;
const H0 = H;
const COND = "'Arial Narrow','Roboto Condensed',sans-serif-condensed,Impact,sans-serif";
const MARKER = "'Permanent Marker','Marker Felt',cursive";
const TYPEW = "'Special Elite','American Typewriter','Courier New',monospace";
let uid = 0;

  /* ---- stack: cassettes piled with later ones on top, each showing its label strip ---- */
  export function mountStack(el, items, opts) {
    
    opts = opts || {};
    var step = opts.step || 0.24;
    var selected = opts.selected || null, cards = {};
    el.classList.add('cs-stack');
    function ratio(it) { var st = Cassette.style(it.cfg.style) || {}, vb = st.vb || [808, 495]; return vb[1] / vb[0]; }
    function layout() {
      var w = el.clientWidth || 360, ch = w * 495 / 808;
      var n = items.length, total = ch + (n - 1) * ch * step;
      el.style.height = total + 'px';
      items.forEach(function (it, i) {
        var b = cards[it.id], isSel = it.id === selected, jig = ((i * 37) % 7 - 3) * 0.5, lx = ((i * 53) % 9 - 4) * 1.2;
        b.style.top = (i * ch * step) + 'px';
        b.style.zIndex = isSel ? 100 : i + 1;
        b.style.transform = isSel ? 'translate(18px,-8px) rotate(0deg) scale(1.02)' : 'translate(' + lx + 'px,0) rotate(' + jig + 'deg)';
        b.setAttribute('aria-pressed', String(isSel));
      });
    }
    function build() {
      el.textContent = ''; cards = {};
      items.forEach(function (it) {
        var b = document.createElement('button'); b.type = 'button'; b.className = 'cs-card'; b.setAttribute('aria-label', 'Mixtape: ' + ((it.cfg.text && it.cfg.text.title) || 'Untitled'));
        var holder = document.createElement('div'); b.appendChild(holder);
        Cassette.mount(holder, Object.assign({}, it.cfg, { static: true }));
        b.addEventListener('click', function () { api.select(it.id); opts.onOpen && opts.onOpen(it); });
        b.addEventListener('mouseenter', function () { if (it.id !== selected) b.style.transform += ' translateY(-10px)'; });
        b.addEventListener('mouseleave', layout);
        el.appendChild(b); cards[it.id] = b;
      });
      layout();
    }
    var api = {
      select: function (id) { selected = id; layout(); opts.onSelect && opts.onSelect(items.filter(function (i) { return i.id === id; })[0]); return api; },
      get selected() { return selected; },
      update: function (next) { items = next; build(); return api; },
      add: function (it) { items.push(it); build(); return api; }
    };
    var ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(layout) : null; ro && ro.observe(el);
    build();
    return api;
  }

  /* ---- spines: tape cases seen edge-on, drawn as glossy clear tubes with printed art ---- */
  var SPINE_FONTS = [
    COND, MARKER, COND,
    TYPEW, COND, MARKER
  ];
  function spineSvg(it, i) {
    var cfg = it.cfg, st = Cassette.style(cfg.style) || {}, H = H0;
    var S = Object.assign({ panel: '#CDA760', body: '#353537', accent: '#E9463C', paper: '#EDEBE3', ink: '#2B2A28' }, st.slots || {}, cfg.slots || {});
    var bg = st.clear ? H.mix(S.body, S.panel, 0.55) : S.panel, acc = S.accent;
    if (st.clear && H.lum(bg) > 0.8) bg = H.mix(bg, '#8E949B', 0.3);
    if (H.lum(acc) > 0.85) acc = S.ink;
    var dark = H.lum(bg) < 0.5, fg = dark ? '#FFFFFF' : S.ink, inv = dark ? S.ink : '#FFFFFF';
    var id = 'sp' + (++uid) + '-', v = i % 6, e = H.esc;
    var title = String((cfg.text && cfg.text.title) || 'Untitled').toUpperCase(), sub = String((cfg.text && cfg.text.subtitle) || '').toUpperCase(), side = String((cfg.text && cfg.text.side) || 'A').slice(0, 2);
    var font = SPINE_FONTS[v], size = [78, 58, 84, 44, 80, 56][v], x = 52, y = [92, 80, 94, 74, 90, 80][v], maxW = 660, art = '', txt;
    function T(extra, fill, str) { return '<text x="' + x + '" y="' + y + '" font-family="' + font + '" font-weight="700" font-size="' + size + '" ' + (extra || '') + ' fill="' + fill + '" data-fit="' + maxW + '" data-size="' + size + '">' + e(str || title) + '</text>'; }
    if (v === 0) {            /* block type with a hard drop and chevron stripes */
      art = '<path d="M520 0h50L470 118h-50zM600 0h50L550 118h-50zM680 0h60L640 118h-60z" fill="' + acc + '"/>';
      txt = '<g transform="translate(4 4)">' + T('', S.ink === fg ? acc : '#000', title) + '</g>' + T('', fg);
    } else if (v === 1) {     /* marker tag, big dots */
      art = '<circle cx="690" cy="40" r="46" fill="' + acc + '" opacity=".95"/><circle cx="740" cy="92" r="26" fill="' + fg + '" opacity=".2"/><path d="M40 108H640" stroke="' + acc + '" stroke-width="4" stroke-dasharray="14 8"/>';
      txt = T('', fg);
    } else if (v === 2) {     /* white label, black type, tiny repeated line */
      bg = dark ? '#F4F2EC' : bg; fg = '#111';
      art = '<rect x="34" y="82" width="732" height="26" fill="' + acc + '"/><text x="44" y="102" font-family="system-ui,sans-serif" font-weight="700" font-size="14" letter-spacing=".2em" fill="#fff">' + e((sub || title) + '   ·   ' + (sub || title) + '   ·   ' + (sub || title)) + '</text>';
      y = 70; size = 66; txt = T('font-style="italic"', fg);
    } else if (v === 3) {     /* typewriter on a halftone field */
      art = '<defs><pattern id="' + id + 'h" width="14" height="14" patternUnits="userSpaceOnUse" patternTransform="rotate(30)"><circle cx="7" cy="7" r="3.2" fill="' + acc + '"/></pattern></defs><rect x="34" y="10" width="732" height="98" fill="url(#' + id + 'h)" opacity=".7"/><rect x="40" y="38" width="' + Math.min(700, 30 + title.length * 28) + '" height="62" fill="' + (dark ? '#111' : '#fff') + '"/>';
      y = 84; x = 52; txt = T('', dark ? '#fff' : '#111');
    } else if (v === 4) {     /* sticker type with thick outline on an accent field */
      bg = acc; fg = '#fff';
      art = '<g opacity=".25" fill="#000"><path d="M34 90Q200 60 400 96T766 78V108H34Z"/></g>';
      txt = T('stroke="#111" stroke-width="9" paint-order="stroke" stroke-linejoin="round"', '#fff');
    } else {                  /* checker band and spray */
      art = '<defs><pattern id="' + id + 'k" width="24" height="24" patternUnits="userSpaceOnUse"><rect width="12" height="12" fill="#000"/><rect x="12" y="12" width="12" height="12" fill="#000"/></pattern></defs><rect x="34" y="10" width="732" height="16" fill="url(#' + id + 'k)" opacity=".85"/><rect x="34" y="92" width="732" height="16" fill="url(#' + id + 'k)" opacity=".85"/><circle cx="720" cy="60" r="30" fill="' + acc + '"/><text x="720" y="72" text-anchor="middle" font-family="'+COND+'" font-weight="700" font-size="40" fill="' + inv + '">' + e(side) + '</text>';
      maxW = 600; txt = T('', fg);
    }
    var subTxt = (sub && v !== 2 && v !== 3) ? '<text x="' + (x + 2) + '" y="' + (v === 4 ? 22 : 30) + '" font-family="system-ui,sans-serif" font-weight="600" font-size="12" letter-spacing=".22em" fill="' + (v === 4 ? '#fff' : fg) + '" fill-opacity=".85" data-fit="' + maxW + '" data-size="12">' + e(sub) + '</text>' : '';
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 118" data-cassette="' + id + '" role="img" aria-label="' + e(title) + '"><defs>' +
      '<clipPath id="' + id + 'c"><rect x="34" y="8" width="732" height="102" rx="3"/></clipPath>' +
      '<clipPath id="' + id + 'o"><rect x="0" y="0" width="800" height="118" rx="7"/></clipPath>' +
      '<linearGradient id="' + id + 'g" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#fff" stop-opacity=".7"/><stop offset=".1" stop-color="#fff" stop-opacity=".18"/><stop offset=".3" stop-color="#fff" stop-opacity="0"/><stop offset=".62" stop-color="#000" stop-opacity=".05"/><stop offset=".86" stop-color="#000" stop-opacity=".38"/><stop offset="1" stop-color="#000" stop-opacity=".6"/></linearGradient>' +
      '<linearGradient id="' + id + 'e" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#3A3C42"/><stop offset=".5" stop-color="#16171A"/><stop offset="1" stop-color="#0B0B0D"/></linearGradient></defs>' +
      '<g clip-path="url(#' + id + 'o)"><rect width="800" height="118" fill="#0E0F12"/>' +
      '<g clip-path="url(#' + id + 'c)"><rect x="34" y="8" width="732" height="102" fill="' + bg + '"/>' + art + subTxt + txt + '</g>' +
      '<rect x="34" y="8" width="732" height="102" fill="url(#' + id + 'g)"/>' +
      '<rect x="40" y="13" width="720" height="3" rx="1.5" fill="#fff" fill-opacity=".55"/>' +
      '<rect x="0" y="0" width="34" height="118" fill="url(#' + id + 'e)"/><rect x="766" y="0" width="34" height="118" fill="url(#' + id + 'e)"/>' +
      '<rect x="12" y="38" width="10" height="42" rx="5" fill="#000" fill-opacity=".55"/><rect x="778" y="38" width="10" height="42" rx="5" fill="#000" fill-opacity=".55"/>' +
      '<rect x="32" y="0" width="3" height="118" fill="#fff" fill-opacity=".12"/><rect x="765" y="0" width="3" height="118" fill="#fff" fill-opacity=".12"/>' +
      '</g><rect x=".75" y=".75" width="798.5" height="116.5" rx="15.5" fill="none" stroke="#fff" stroke-opacity=".22" stroke-width="1.5"/></svg>';
  }

  /* ---- library: the spines fill the screen edge to edge and scroll, nothing else on screen ---- */
  export function mountLibrary(el, items, opts) {
     opts = opts || {};
    var selected = opts.selected || null;
    var root = document.createElement('div');
    root.className = 'cs-lib';
    var list = document.createElement('div'); list.className = 'lib-list';
    list.style.cssText = 'display:grid;gap:5px;align-content:start;padding:14px 16px 24px 0';
    root.appendChild(list); el.textContent = ''; el.appendChild(root);
    var btns = {};
    function find(id) { return items.filter(function (i) { return i.id === id; })[0]; }
    function paint() {
      items.forEach(function (it) {
        var b = btns[it.id], on = it.id === selected;
        b.style.transform = on ? 'translateX(14px)' : '';
        b.style.filter = on ? 'drop-shadow(0 8px 10px rgba(0,0,0,.55)) brightness(1.06)' : (selected ? 'brightness(.82)' : '');
        b.setAttribute('aria-pressed', String(on));
      });
    }
    function build() {
      list.textContent = ''; btns = {};
      items.forEach(function (it, i) {
        var b = document.createElement('button'); b.type = 'button'; b.setAttribute('aria-label', 'Mixtape: ' + ((it.cfg.text && it.cfg.text.title) || 'Untitled'));
        b.style.cssText = 'display:block;width:100%;border:0;padding:0;background:none;cursor:pointer;transition:transform .35s cubic-bezier(.25,.8,.25,1),filter .25s;flex:none';
        b.innerHTML = spineSvg(it, i); b.firstChild.style.cssText = 'display:block;width:100%;height:auto';
        b.addEventListener('click', function () { api.select(it.id); opts.onOpen && opts.onOpen(it); });
        list.appendChild(b); btns[it.id] = b;
      });
      paint(); Cassette.refit();
    }
    var api = {
      el: root, get selected() { return selected; },
      select: function (id) { selected = id; paint(); opts.onSelect && opts.onSelect(find(id)); var b = btns[id]; if (b && b.scrollIntoView) b.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); return api; },
      update: function (next) { items = next; build(); return api; }
    };
    build();
    return api;
  }
