// ─────────────────────────────────────────────────────────────────────────────
// editor.js — the mixtape editor and the back-of-the-case view.
//
//   openEditor(ctx)  a phone-first full-screen flow: live cassette preview (tap to flip it A/B)
//       with a capacity gauge per side, and four tabs —
//         Tape    name, author, tagline, tape length (C30 / C60 / C90), auto-reverse, duplicate /
//                 export / delete
//         Add     search the whole library and add songs to the selected side (editor-songs.js)
//         Tracks  the selected side's list: reorder, move across, remove, per-row times (editor-songs.js)
//         Style   cassette type (37), pen, ink, wear, gloss, label note
//       Songs are REAL library refs (matched by stable id); needs-re-link states keep working.
//       Caps (tape length per side, 20 songs per side) are enforced by the pure model.
//   openBack(ctx)    the case back: both sides' lists (tap a song to start there), Play, Edit, Close.
//
// All model decisions live in mixtape.js / mixtape-pick.js (pure); this file is DOM glue and builds
// everything from text nodes (never innerHTML with song data).
// ─────────────────────────────────────────────────────────────────────────────

import { Cassette } from './index.js';
import { trapFocus } from '../ui/focus-trap.js';
import { h, icon, ICONS, reducedMotion } from './dom.js';
import {
  createMixtape, withName, withAuthor, withStyle, withPen, withInk, withWear, withGloss, withText, inkHex, withTape, withAutoReverse,
  canResize, withDurations, resolveTracks, cassetteCfg, newMixtapeId, FONT_COLOURS, cassetteStyles, sideInfo, sideCapacity, remaining, fmtDur,
  TAPES, TAPE_IDS, MAX_SONGS_PER_SIDE, MAX_NAME, MAX_TAGLINE, MAX_NOTE, MAX_AUTHOR,
} from '../mixtape.js';
import { createPicker } from '../mixtape-pick.js';
import { globalSearch } from '../mixtape-search.js';   // the global search core behind the picker's adapter shape (swap to defaultSearch to go back)
import { createAddTab, createTracksTab } from './editor-songs.js';

function hashS(s) { let x = 2166136261; for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); } return x >>> 0; }
function barcodeSvg(seed) {
  let x = hashS(seed), y = 0, r = '';
  while (y < 100) { x = Math.imul(x ^ (x >>> 13), 1274126177) >>> 0; const w = 0.6 + (x % 5) * 0.45, g = 0.5 + ((x >>> 5) % 3) * 0.45; r += '<rect x="0" y="' + y.toFixed(2) + '" width="10" height="' + w.toFixed(2) + '"/>'; y += w + g; }
  const s = h('span', { class: 'bk-barwrap' });
  s.innerHTML = '<svg class="bk-bar" viewBox="0 0 10 100" preserveAspectRatio="none" fill="#151515">' + r + '</svg>';   // static, hash-derived markup only
  return s.firstChild;
}

// ── back of the case ─────────────────────────────────────────────────────────
let backEl = null, backKey = null;
export function closeBack() {
  if (backEl) { backEl.remove(); backEl = null; document.removeEventListener('keydown', backKey); }
}

export function openBack({ mixtape: m, onPlay, onEdit }) {
  closeBack();
  const year = new Date().getFullYear();
  const num = 10000 + (hashS(m.id + m.name) % 89999);
  const blurb = [m.cfg.text.subtitle || 'A mixtape', m.cfg.text.note].filter(Boolean).join('. ');
  const ov = h('div', { class: 'bk-ov', role: 'dialog', 'aria-label': 'Back of the case: ' + m.name });
  const globe = h('span', { class: 'bk-globe' });
  globe.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="#181818" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><ellipse cx="12" cy="12" rx="4.2" ry="10"/><path d="M2 12h20M4 7h16M4 17h16"/></svg>';
  const items = [];
  let flat = 0;
  for (const side of ['A', 'B']) {
    if (!m.sides[side].length && side === 'B') continue;
    if (m.sides.B.length || side === 'B') items.push(h('li', { class: 'bk-sidehead' }, `Side ${side} · ${m.tape.length}`));
    if (!m.sides[side].length) items.push(h('li', { style: { opacity: '.55' } }, 'No songs yet'));
    m.sides[side].forEach((t, i) => {
      const idx = flat++;
      items.push(h('li', {}, h('button', { type: 'button', onclick: () => { closeBack(); onPlay(m, idx); } }, ('0' + (i + 1)).slice(-2) + ' ' + t.title)));
    });
  }
  const card = h('div', { class: 'bk-card' },
    h('div', { class: 'bk-top' }, h('b', {}, m.name), h('span', {}, year + '©'), globe),
    h('ol', { class: 'bk-list' }, ...items),
    h('div', { class: 'bk-side' }, m.name, ' · ', m.tape.length, h('br'), 'mixtape copy'),
    barcodeSvg(m.id + m.name),
    h('div', { class: 'bk-foot' }, h('span', { class: 'id' }, 'MX—#' + num), h('p', {}, blurb + '. Best played in order, start to finish.'),
      h('small', {}, 'All rights reserved © ' + (m.author || 'You') + '   Since ' + year)));
  const close = h('button', { type: 'button', class: 'chip ghost', onclick: closeBack }, 'Close');
  ov.append(h('div', { class: 'bk-stage' }, card),
    h('div', { class: 'bk-actions' },
      h('button', { type: 'button', class: 'chip primary', disabled: m.tracks.length ? null : '', onclick: () => { closeBack(); onPlay(m, 0); } }, 'Play from the top'),
      h('button', { type: 'button', class: 'chip ghost', onclick: () => { closeBack(); onEdit(m); } }, 'Edit'), close));
  ov.addEventListener('click', (e) => { if (e.target === ov) closeBack(); });
  document.body.appendChild(ov); backEl = ov;
  backKey = (e) => { if (e.key === 'Escape') closeBack(); };
  document.addEventListener('keydown', backKey);
  close.focus();
}

// ── editor ───────────────────────────────────────────────────────────────────
let edEl = null, edCloser = null;

/**
 * ctx = {
 *   mixtape: existing mixtape | null (new),
 *   draft?: true  the mixtape is a NEW unsaved draft (suggested tape, "add to mixtape"): Save adds it
 *   notice?: string  shown as a toast on open
 *   defaultAuto?: boolean  AUTO default for a new tape
 *   existing: mixtape[] (for collision-free ids),
 *   getLibraryTracks(): track[],
 *   relink?(): Promise,                 user-gesture re-link
 *   onSave(m): void,                    persist (add or replace by id)
 *   onDelete(id): void,
 *   onPlay(m, flatIndex): void,         save already done
 *   onExport?(m): void,                 show the JSON text
 *   onDuplicate?(m): mixtape            persist a copy
 * }
 */
export function openEditor(ctx) {
  closeBack();
  if (edCloser) edCloser(); else if (edEl) edEl.remove();
  const isNewInit = !ctx.mixtape || !!ctx.draft;
  let isNew = isNewInit;
  let m = ctx.mixtape || createMixtape({ id: newMixtapeId(Date.now(), Math.random(), ctx.existing || []), name: '', autoReverse: ctx.defaultAuto !== false });
  if (!ctx.mixtape) m = { ...m, name: '' };
  const lib = () => ctx.getLibraryTracks() || [];
  m = withDurations(m, resolveTracks(m, lib()));          // real durations beat estimates
  let orig = ctx.draft ? '' : JSON.stringify(m);          // a draft is dirty from the start (nothing saved yet)
  const dirty = () => JSON.stringify(m) !== orig;
  let side = 'A', tab = m.tracks.length ? 'tracks' : 'tape';

  // ── frame
  const live = h('div', { class: 'ed-live', 'aria-live': 'polite', role: 'status' });
  const toastEl = h('div', { class: 'ed-toast hidden', role: 'status' });
  const title = h('h2', {}, isNew ? 'New mixtape' : 'Edit mixtape');
  const saveBtn = h('button', { type: 'button', class: 'sv', onclick: () => { commit(); closeEd(); } }, 'Save');
  const playBtn = h('button', { type: 'button', class: 'pl', 'aria-label': 'Save and play', onclick: () => { if (!m.tracks.length) { goTab('add'); toast('Add songs first'); return; } const saved = commit(); closeEd(); ctx.onPlay(saved, 0); } }, icon(ICONS.play, { size: 14, fill: 'currentColor', stroke: 0 }), ' Play');
  const backBtn = h('button', { type: 'button', id: 'ed-back', class: 'bk', 'aria-label': 'Back', onclick: () => askLeave() }, icon(ICONS.back, { size: 20, stroke: 2.6 }), h('span', {}, 'Back'));
  // the tape's name on every tab (it lived only on the Tape tab while the editor opens on Add): tap to rename
  const nameChip = h('button', { type: 'button', class: 'ed-namechip', onclick: () => { goTab('tape'); try { fName.focus(); fName.select(); } catch { /* */ } } });
  const paintName = () => { const n = (m.name || '').trim(); nameChip.replaceChildren(h('b', {}, n || 'Name it'), h('span', { 'aria-hidden': 'true' }, ' ✎')); nameChip.classList.toggle('unnamed', !n); nameChip.setAttribute('aria-label', n ? `Tape name: ${n}. Tap to rename` : 'Name your mixtape'); };
  const bar = h('div', { class: 'ed-bar' }, backBtn, title, nameChip, playBtn, saveBtn);

  const prev = h('button', { type: 'button', class: 'ed-tape', onclick: () => api.setSide(side === 'A' ? 'B' : 'A') });
  const prevWrap = h('div', { class: 'ed-prevwrap' }, prev, h('span', { class: 'ed-flipchip' }, icon(ICONS.flip, { size: 13, stroke: 2.2 }), h('span', { class: 'ed-sidelabel' })));
  const gA = h('button', { type: 'button', class: 'ed-gauge', onclick: () => api.setSide('A') });
  const gB = h('button', { type: 'button', class: 'ed-gauge', onclick: () => api.setSide('B') });
  const top = h('div', { class: 'ed-top' }, prevWrap, h('div', { class: 'ed-gauges', role: 'group', 'aria-label': 'Tape capacity per side' }, gA, gB));
  const TABS = [['tape', 'Tape'], ['add', 'Add'], ['tracks', 'Tracks'], ['style', 'Style']];
  const tabBtns = {};
  const tabs = h('div', { class: 'ed-tabs', role: 'tablist' }, ...TABS.map(([id, label]) => (tabBtns[id] = h('button', { type: 'button', role: 'tab', id: 'edtab-' + id, onclick: () => api.goTab(id) }, label))));
  const panels = {};
  const panel = h('div', { class: 'ed-panel' });
  const ed = h('div', { class: 'ed', role: 'dialog', 'aria-modal': 'true', 'aria-label': isNew ? 'New mixtape' : 'Edit mixtape' }, bar, top, tabs, panel, toastEl, live);
  const ov = h('div', { class: 'ed-ov' }, ed);
  document.body.appendChild(ov); edEl = ov;
  // modal: the app shell behind is inert (screen readers + Tab can't reach it) and focus is trapped in the editor until it closes
  const shellEl = document.getElementById('shell'); const shellWasInert = !!(shellEl && shellEl.inert);
  if (shellEl) shellEl.inert = true;
  let releaseTrap = () => {};
  edCloser = closeEd;

  // ── shared state / services for the tabs
  let picker = null, pickerSig = '', toastT = 0, ut = null, tapeH = null;
  const api = {
    get m() { return m; },
    setM(next) { if (next !== m) { m = next; changed(); } },
    get side() { return side; },
    setSide(s) {
      if (s !== 'A' && s !== 'B') return;
      const flipped = s !== side;
      side = s;
      paintTop();
      if (flipped) flipPreview();
      addTab.refresh(); tracksTab.refresh();
      announce(`Side ${s}`);
    },
    lib,
    picker() {
      const l = lib(), sig = l.length + ':' + (l[0] ? l[0].id : '') + ':' + (l.length ? l[l.length - 1].id : '');
      if (!picker || sig !== pickerSig) { pickerSig = sig; picker = createPicker(l, { search: globalSearch }); }
      return picker;
    },
    toast, announce, goTab: (t) => goTab(t), ctx,
    play(i) { const saved = commit(); closeEd(); ctx.onPlay(saved, i); },
    libraryChanged() { m = withDurations(m, resolveTracks(m, lib())); picker = null; addTab.libraryChanged(); changed(); },
    goTab,
  };
  const addTab = createAddTab(api), tracksTab = createTracksTab(api);
  function announce(t) { live.textContent = ''; setTimeout(() => { live.textContent = t; }, 30); }
  function toast(msg, o = {}) {
    clearTimeout(toastT);
    toastEl.replaceChildren(...[h('span', {}, msg), o.undo ? h('button', { type: 'button', onclick: () => { o.undo(); toastEl.classList.add('hidden'); } }, 'Undo') : null].filter(Boolean));
    toastEl.classList.toggle('bad', !!o.bad); toastEl.classList.remove('hidden');
    toastT = setTimeout(() => toastEl.classList.add('hidden'), o.undo ? 5200 : (o.bad ? 4600 : 3200));
    announce(msg);
  }

  // ── live cassette preview (debounced redraw; reels shown at a static mid position)
  const cfgNow = () => cassetteCfg(m.name ? m : { ...m, name: 'Untitled mix' }, { side, reelStandIns: true, progress: 0.35, static: false });
  const mountTape = () => { tapeH = Cassette.mount(prev, cfgNow(), { onRender: (hh) => { const hits = hh.svg.querySelector('[data-layer="reel-hit"]'); if (hits) hits.remove(); } }); };
  const retape = () => { clearTimeout(ut); ut = setTimeout(() => tapeH && tapeH.update(cfgNow()), 120); };
  function flipPreview() {
    const el = prev;
    if (reducedMotion() || typeof el.animate !== 'function') { tapeH.update(cfgNow()); return; }
    el.getAnimations().forEach((a) => a.cancel());
    el.animate([{ transform: 'perspective(700px) rotateY(0deg)' }, { transform: 'perspective(700px) rotateY(90deg)' }], { duration: 130, easing: 'ease-in', fill: 'forwards' }).finished
      .then(() => { tapeH.update(cfgNow()); return el.animate([{ transform: 'perspective(700px) rotateY(-90deg)' }, { transform: 'perspective(700px) rotateY(0deg)' }], { duration: 150, easing: 'ease-out', fill: 'forwards' }).finished; })
      .then(() => { el.getAnimations().forEach((a) => a.cancel()); }).catch(() => {});
  }

  // ── capacity gauges: 'A 21:40 / 30:00' and '7 songs, 13 left'
  function paintGauge(btn, s) {
    const info = sideInfo(m, s), cap = sideCapacity(m), r = remaining(m, s), over = info.sec > cap || info.count > MAX_SONGS_PER_SIDE;
    btn.replaceChildren(
      h('span', { class: 'g-top' }, h('b', {}, s), h('span', {}, `${fmtDur(info.sec, info.est)} / ${fmtDur(cap)}`)),
      h('span', { class: 'g-bar' }, h('i', { style: { width: Math.min(100, info.sec / cap * 100).toFixed(1) + '%' } })),
      h('span', { class: 'g-sub' }, over ? 'Over capacity' : `${info.count} song${info.count === 1 ? '' : 's'}, ${Math.max(0, MAX_SONGS_PER_SIDE - info.count)} left`));
    btn.setAttribute('aria-pressed', String(side === s));
    btn.setAttribute('aria-label', `Side ${s}: ${fmtDur(info.sec, info.est)} of ${fmtDur(cap)}, ${info.count} songs. ${side === s ? 'Selected' : 'Select'}`);
    btn.classList.toggle('on', side === s); btn.classList.toggle('over', over);
    btn.classList.toggle('full', !over && (r.sec < 30 || r.slots === 0));
  }
  function paintTop() {
    paintGauge(gA, 'A'); paintGauge(gB, 'B');
    prev.setAttribute('aria-label', `Cassette preview, side ${side}. Tap to flip to side ${side === 'A' ? 'B' : 'A'}.`);
    prevWrap.querySelector('.ed-sidelabel').textContent = `Side ${side}`;
  }

  // Play needs a song: an empty tape would save as "Untitled mix" and open a player with nothing in it
  function paintPlay() { const none = !m.tracks.length; playBtn.setAttribute('aria-disabled', String(none)); playBtn.classList.toggle('off', none); playBtn.style.opacity = none ? '.55' : ''; playBtn.title = none ? 'Add songs first' : ''; }
  function changed() { paintPlay(); paintName(); paintTop(); retape(); addTab.refresh(); tracksTab.refresh(); paintTape(); }

  // ── tabs
  function goTab(id) {
    tab = id; ed.dataset.tab = id;
    for (const [k] of TABS) { tabBtns[k].setAttribute('aria-selected', String(k === id)); tabBtns[k].classList.toggle('on', k === id); }
    for (const k of Object.keys(panels)) panels[k].classList.toggle('hidden', k !== id);
    panel.classList.toggle('fill', id === 'add');
    if (id === 'add') { addTab.show(); }
    else if (id === 'tracks') tracksTab.show();
    else if (id === 'style') buildStyle();
    else paintTape();
    panel.scrollTop = 0;
  }

  // ── Tape tab
  const tapeP = panels.tape = h('div', { class: 'ed-tab ed-tape-tab' });
  const fName = h('input', { class: 'fld', maxlength: MAX_NAME, placeholder: 'Name your mixtape', autocomplete: 'off', 'aria-label': 'Title' });
  const fTag = h('input', { class: 'fld', maxlength: MAX_TAGLINE, placeholder: 'A few words about it', autocomplete: 'off', 'aria-label': 'Line on the label' });
  const fBy = h('input', { class: 'fld', maxlength: MAX_AUTHOR, placeholder: 'your name', autocomplete: 'off', 'aria-label': 'Made by' });
  fName.value = m.name; fTag.value = m.cfg.text.subtitle; fBy.value = m.author;
  fName.addEventListener('input', () => { m = { ...m, name: fName.value.slice(0, MAX_NAME) }; retape(); paintName(); });
  fTag.addEventListener('input', () => { m = withText(m, { subtitle: fTag.value }); retape(); });
  fBy.addEventListener('input', () => { m = withAuthor(m, fBy.value); });
  const lenBox = h('div', { class: 'ed-lens', role: 'radiogroup', 'aria-label': 'Tape length' });
  const autoSw = h('button', { type: 'button', class: 'ed-switch', role: 'switch', onclick: () => { m = withAutoReverse(m, !m.autoReverse); paintTape(); } },
    h('span', { class: 'sw-track' }, h('i', {})), h('span', { class: 'sw-txt' }, h('b', {}, 'Auto-reverse'), h('small', {}, 'At the end of side A the player flips to side B by itself. You can still switch it on the player.')));
  const caps = h('p', { class: 'ed-caps' });
  const manage = h('div', { class: 'ed-manage' });
  tapeP.append(
    h('label', { class: 'ed-l' }, 'Title', fName), h('label', { class: 'ed-l' }, 'Line on the label', fTag), h('label', { class: 'ed-l' }, 'Made by', fBy),
    h('div', { class: 'ed-h' }, 'Tape length'), lenBox, caps, autoSw, manage);
  function paintTape() {
    lenBox.replaceChildren(...TAPE_IDS.map((id) => {
      const t = TAPES[id], on = m.tape.length === id;
      return h('button', { type: 'button', class: 'ed-len' + (on ? ' on' : ''), role: 'radio', 'aria-checked': String(on), onclick: () => {
        if (on) return;
        const ok = canResize(m, id);
        if (!ok.ok) { toast(`Cannot switch to ${id}. ${ok.reason}`, { bad: true }); return; }
        m = withTape(m, id); changed(); announce(`${id} tape`);
      } }, h('b', {}, id), h('small', {}, `${t.minutes / 2}+${t.minutes / 2} min`));
    }));
    caps.textContent = `A ${m.tape.length} side holds ${fmtDur(sideCapacity(m))} and at most ${MAX_SONGS_PER_SIDE} songs. A song that does not fit is refused, never squeezed. Songs with an unknown length count as ~4:00 until they have played once.`;
    autoSw.setAttribute('aria-checked', String(!!m.autoReverse)); autoSw.classList.toggle('on', !!m.autoReverse);
    manage.replaceChildren(...[
      !isNew && ctx.onDuplicate ? h('button', { type: 'button', class: 'ed-act', onclick: () => { finalizeName(); const copy = ctx.onDuplicate(m); if (copy) toast(`Duplicated as “${copy.name}”.`); } }, 'Duplicate') : null,
      ctx.onExport ? h('button', { type: 'button', class: 'ed-act', onclick: () => { finalizeName(); ctx.onExport(m); } }, 'Export JSON') : null,
      !isNew ? delBtn : null].filter(Boolean));
  }
  let armed = null;
  const delBtn = h('button', { type: 'button', class: 'ed-act danger', onclick: () => {
    if (!armed) { delBtn.textContent = 'Tap again to delete'; armed = setTimeout(() => { armed = null; delBtn.textContent = 'Delete mixtape'; }, 3000); return; }
    clearTimeout(armed); ctx.onDelete(m.id); closeEd();
  } }, 'Delete mixtape');

  // ── Style tab (built on first view: 37 thumbnails)
  const styleP = panels.style = h('div', { class: 'ed-tab ed-style-tab' });
  let styleBuilt = false;
  function buildStyle() {
    if (styleBuilt) return;
    styleBuilt = true;
    const grid = h('div', { class: 'ed-grid' }), pens = h('div', { class: 'ed-pens' }), inks = h('div', { class: 'ed-dots-row' });
    const retag = (box, btn) => box.childNodes.forEach((x) => x.setAttribute('aria-pressed', String(x === btn)));
    cassetteStyles().forEach((s) => {
      const b = h('button', { type: 'button', class: 'ed-sty', 'aria-pressed': String(s.id === m.cfg.style), 'aria-label': 'Cassette type: ' + s.name }, h('span', { class: 'th' }), h('span', {}, s.name));
      Cassette.mount(b.firstChild, { style: s.id, static: true, wear: 0, text: { title: m.name || 'Mixtape', subtitle: '', note: '', side: 'A' } });
      b.addEventListener('click', () => { m = withStyle(m, s.id); retag(grid, b); tapeH.update(cfgNow()); });
      grid.append(b);
    });
    Object.keys(Cassette.PENS).forEach((k) => {
      const b = h('button', { type: 'button', 'aria-pressed': String(k === m.cfg.pen), style: { fontFamily: Cassette.PENS[k].family } }, Cassette.PENS[k].label);
      b.addEventListener('click', () => { m = withPen(m, k); retag(pens, b); tapeH.update(cfgNow()); });
      pens.append(b);
    });
    [{ id: 'auto', name: 'Style default', hex: null }, ...FONT_COLOURS].forEach((c) => {
      const b = h('button', { type: 'button', title: c.name, 'aria-label': 'Ink: ' + c.name });
      b.style.background = c.hex || 'conic-gradient(#c0392b,#e07a1f,#1e7a4a,#1f4fd8,#6d4cff,#c0392b)';
      b.setAttribute('aria-pressed', String((inkHex(m) || null) === c.hex || (c.hex && inkHex(m) && inkHex(m).toLowerCase() === c.hex)));
      b.addEventListener('click', () => { m = withInk(m, c.hex); retag(inks, b); tapeH.update(cfgNow()); });
      inks.append(b);
    });
    const w = h('input', { type: 'range', min: '0', max: '1', step: '0.01', 'aria-label': 'Wear' }), g = h('input', { type: 'range', min: '0', max: '1', step: '0.01', 'aria-label': 'Gloss' });
    w.value = m.cfg.wear; g.value = m.cfg.gloss;
    w.addEventListener('input', () => { m = withWear(m, +w.value); retape(); });
    g.addEventListener('input', () => { m = withGloss(m, +g.value); retape(); });
    const note = h('input', { class: 'fld light', maxlength: MAX_NOTE, autocomplete: 'off', placeholder: 'Side A · 6 songs', 'aria-label': 'Note on the label' });
    note.value = m.cfg.text.note;
    note.addEventListener('input', () => { m = withText(m, { note: note.value }); retape(); });
    styleP.append(h('div', { class: 'ed-h' }, 'Cassette type'), grid, h('div', { class: 'ed-h' }, 'Handwriting'), pens, h('div', { class: 'ed-h' }, 'Ink'), inks,
      h('label', { class: 'rng' }, 'Wear', w), h('label', { class: 'rng' }, 'Gloss', g),
      h('label', { class: 'ed-l light' }, 'Note on the label (blank = side and song count)', note));
  }

  panels.add = addTab.el; panels.tracks = tracksTab.el;
  panel.append(panels.tape, panels.add, panels.tracks, panels.style);

  // ── save, play, leave
  function finalizeName() { if (!m.name.trim()) { m = withName(m, 'Untitled mix'); fName.value = m.name; } else m = withName(m, m.name); }
  function commit() {
    clearTimeout(ut);
    finalizeName();
    ctx.onSave(m);
    orig = JSON.stringify(m); isNew = false;
    return m;
  }
  function closeEd() { if (edCloser === closeEd) edCloser = null; if (shellEl && !shellWasInert) shellEl.inert = false; releaseTrap(); releaseTrap = () => {}; document.removeEventListener('keydown', edKey); clearTimeout(ut); clearTimeout(toastT); ov.remove(); if (edEl === ov) edEl = null; }
  function askLeave() {
    if (!dirty()) { closeEd(); return; }
    if (ed.querySelector('.ed-warn')) return;
    const w = h('div', { class: 'ed-warn', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': 'Unsaved changes' },
      h('div', { class: 'ed-warn-card' }, h('b', {}, 'Discard your changes?'), h('p', {}, 'This mixtape has changes that are not saved yet.'),
        h('div', { class: 'ed-warn-acts' },
          h('button', { type: 'button', class: 'sv2', onclick: () => { commit(); closeEd(); } }, 'Save'),
          h('button', { type: 'button', class: 'kp', onclick: () => w.remove() }, 'Keep editing'),
          h('button', { type: 'button', class: 'dc', onclick: closeEd }, 'Discard'))));
    ed.append(w);
    w.querySelector('.kp').focus();
  }
  function edKey(e) {
    if (e.key !== 'Escape') return;
    const warn = ed.querySelector('.ed-warn');
    if (warn) { warn.remove(); return; }
    askLeave();
  }
  document.addEventListener('keydown', edKey);
  releaseTrap = trapFocus(ed, { onEscape: () => edKey({ key: 'Escape' }) });

  mountTape();
  paintPlay(); paintName(); paintTop();
  goTab(tab);
  if (ctx.notice) toast(ctx.notice);
  setTimeout(() => { if (isNewInit && !ctx.mixtape) fName.focus(); }, 80);
  return { close: closeEd, el: ov };
}
