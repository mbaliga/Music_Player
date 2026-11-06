// ─────────────────────────────────────────────────────────────────────────────
// editor.js — the mixtape editor and the back-of-the-case view, adapted from the
// owner's deck-page.js to Runout's data: songs are REAL library refs (picked
// from the scanned library, matched by stable id), not typed-in metadata.
//
//   openEditor({ mixtape|null, ... })   full-screen: live cassette, title /
//       tagline / by, PLAY + ADD SONG plates, song rows with a ⋮ menu (move,
//       play from here, remove), a look sheet (37 styles, pen, ink colour, wear,
//       gloss, side + note), needs-re-link states with a Re-link button,
//       discard guard, delete.
//   openBack({ mixtape, ... })          the case back: track list (tap a song to
//       start there), Play from the top, Edit, Close.
//
// All model decisions live in mixtape.js (pure); this file is DOM glue.
// ─────────────────────────────────────────────────────────────────────────────

import { Cassette } from './index.js';
import {
  createMixtape, withName, withAuthor, withStyle, withPen, withInk, withWear, withGloss, withText, inkHex,
  addTrack, removeTrack, moveTrack, resolveTracks, cassetteCfg, newMixtapeId, FONT_COLOURS, cassetteStyles,
  MAX_NAME, MAX_TAGLINE, MAX_NOTE, MAX_AUTHOR,
} from '../mixtape.js';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function hashS(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function barcode(seed) {
  let h = hashS(seed), x = 0, r = '';
  while (x < 100) { h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0; const w = 0.6 + (h % 5) * 0.45, g = 0.5 + ((h >>> 5) % 3) * 0.45; r += '<rect x="0" y="' + x.toFixed(2) + '" width="10" height="' + w.toFixed(2) + '"/>'; x += w + g; }
  return '<svg class="bk-bar" viewBox="0 0 10 100" preserveAspectRatio="none" fill="#151515">' + r + '</svg>';
}

// ── back of the case ─────────────────────────────────────────────────────────
let backEl = null, backKey = null;
export function closeBack() {
  if (backEl) { backEl.remove(); backEl = null; document.removeEventListener('keydown', backKey); }
}

export function openBack({ mixtape: m, onPlay, onEdit }) {
  closeBack();
  const year = new Date().getFullYear(), side = m.cfg.text.side || 'A';
  const num = 10000 + (hashS(m.id + m.name) % 89999);
  const ov = document.createElement('div');
  ov.className = 'bk-ov'; ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-label', 'Back of the case: ' + m.name);
  const blurb = [m.cfg.text.subtitle || 'A mixtape', m.cfg.text.note].filter(Boolean).join('. ');
  ov.innerHTML = '<div class="bk-stage"><div class="bk-card">' +
    '<div class="bk-top"><b>' + esc(m.name) + '</b><span>' + year + '©</span><svg viewBox="0 0 24 24" fill="none" stroke="#181818" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><ellipse cx="12" cy="12" rx="4.2" ry="10"/><path d="M2 12h20M4 7h16M4 17h16"/></svg></div>' +
    '<ol class="bk-list">' + (m.tracks.length
      ? m.tracks.map((t, i) => '<li><button type="button" data-i="' + i + '">' + ('0' + (i + 1)).slice(-2) + ' ' + esc(t.title) + '</button></li>').join('')
      : '<li style="opacity:.55">No songs yet</li>') + '</ol>' +
    '<div class="bk-side">' + esc(m.name) + ' · side ' + esc(side) + '<br>mixtape copy</div>' + barcode(m.id + m.name) +
    '<div class="bk-foot"><span class="id">MX—#' + num + '</span><p>' + esc(blurb) + '. Best played in order, start to finish.</p>' +
    '<small>All rights reserved © ' + esc(m.author || 'You') + '   Since ' + year + '</small></div>' +
    '</div></div><div class="bk-actions"><button type="button" class="chip primary" id="bk-ins"' + (m.tracks.length ? '' : ' disabled') + '>Play from the top</button><button type="button" class="chip ghost" id="bk-edit">Edit</button><button type="button" class="chip ghost" id="bk-x">Close</button></div>';
  ov.addEventListener('click', (e) => { if (e.target === ov) closeBack(); });
  document.body.appendChild(ov); backEl = ov;
  backKey = (e) => { if (e.key === 'Escape') closeBack(); };
  document.addEventListener('keydown', backKey);
  ov.querySelector('#bk-x').addEventListener('click', closeBack);
  ov.querySelector('#bk-edit').addEventListener('click', () => { closeBack(); onEdit(m); });
  ov.querySelector('#bk-ins').addEventListener('click', () => { closeBack(); onPlay(m, 0); });
  ov.querySelectorAll('.bk-list button').forEach((b) => b.addEventListener('click', () => { closeBack(); onPlay(m, +b.dataset.i); }));
  ov.querySelector('#bk-x').focus();
}

// ── editor ───────────────────────────────────────────────────────────────────
let edEl = null;

/**
 * ctx = {
 *   mixtape: existing mixtape | null (new),
 *   existing: mixtape[] (for collision-free ids),
 *   getLibraryTracks(): track[],
 *   relink?(): Promise,                 user-gesture re-link
 *   onSave(m): void,                    persist (add or replace by id)
 *   onDelete(id): void,
 *   onPlay(m, startIndex): void,        save already done
 *   onExport?(m): void,                 show the JSON text
 * }
 */
export function openEditor(ctx) {
  closeBack();
  if (edEl) edEl.remove();
  const isNewInit = !ctx.mixtape;
  let isNew = isNewInit;
  let m = ctx.mixtape || createMixtape({ id: newMixtapeId(Date.now(), Math.random(), ctx.existing || []), name: '' });
  if (isNewInit) m = { ...m, name: '' };
  let orig = JSON.stringify(m), menuAt = -1;
  const dirty = () => JSON.stringify(m) !== orig;

  const ov = document.createElement('div'); ov.className = 'ed-ov';
  ov.innerHTML = '<div class="ed" role="dialog" aria-label="' + (isNew ? 'New mixtape' : 'Edit mixtape') + '">' +
    '<div class="ed-bar"><button type="button" id="ed-back" aria-label="Back"><svg width="12" height="20" viewBox="0 0 12 20" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2L2 10l8 8"/></svg></button><h2>' + (isNew ? 'New mixtape' : 'Edit mixtape') + '</h2><button type="button" class="sv" id="ed-save">Save</button></div>' +
    '<div class="ed-scroll" id="ed-scroll"><div class="ed-hero"><button type="button" class="ed-tape" id="ed-tape" aria-label="Change the look of the tape"></button><div class="ed-hint">Tap the tape to change its look</div>' +
    '<input class="f t" id="ed-title" maxlength="' + MAX_NAME + '" placeholder="Name your mixtape" autocomplete="off" aria-label="Title">' +
    '<input class="f g" id="ed-tag" maxlength="' + MAX_TAGLINE + '" placeholder="A few words about it" autocomplete="off" aria-label="Line on the label">' +
    '<div class="ed-by"><span>by</span><input class="f" id="ed-by" maxlength="' + MAX_AUTHOR + '" placeholder="your name" autocomplete="off" aria-label="Made by"></div></div>' +
    '<div class="ed-plates"><button type="button" class="plate" id="ed-play">Play</button><button type="button" class="plate" id="ed-add">Add song</button></div>' +
    '<div id="ed-relink"></div>' +
    '<div class="ed-head"><span>Songs</span><span id="ed-count"></span></div><div id="ed-list"></div>' +
    '<button type="button" class="ed-del" id="ed-del"' + (isNew ? ' style="display:none"' : '') + '>Delete mixtape</button>' +
    (ctx.onExport ? '<button type="button" class="ed-del" id="ed-exp" style="color:#b9b9be;margin-top:4px">Export JSON</button>' : '') +
    '</div></div>';
  document.body.appendChild(ov); edEl = ov;
  const $e = (id) => ov.querySelector('#' + id);
  $e('ed-title').value = m.name; $e('ed-tag').value = m.cfg.text.subtitle; $e('ed-by').value = m.author;

  // ── live cassette (debounced redraw; reels shown at a static mid position)
  let tapeH = null, ut = null;
  const cfgNow = () => cassetteCfg(m.name ? m : { ...m, name: 'Untitled mix' }, { reelStandIns: true, progress: 0.35, static: false });
  const mountTape = () => { tapeH = Cassette.mount($e('ed-tape'), cfgNow(), { onRender: (h) => { const hits = h.svg.querySelector('[data-layer="reel-hit"]'); if (hits) hits.remove(); } }); };
  const retape = () => { clearTimeout(ut); ut = setTimeout(() => tapeH.update(cfgNow()), 120); };
  mountTape();

  // ── songs
  const status = (resolved, i) => (!resolved[i] ? 'miss' : (resolved[i].file ? '' : 'relink'));
  function renderList() {
    const L = $e('ed-list'); L.textContent = '';
    $e('ed-count').textContent = m.tracks.length + (m.tracks.length === 1 ? ' song' : ' songs');
    $e('ed-play').disabled = !m.tracks.length;
    const res = resolveTracks(m, ctx.getLibraryTracks());
    const needs = res.some((r, i) => status(res, i) === 'relink');
    const rl = $e('ed-relink'); rl.textContent = '';
    if (needs && ctx.relink) {
      rl.innerHTML = '<div class="ed-relink"><span>Some songs are remembered but need re-linking to your music folder.</span><button type="button" id="ed-rl">Re-link…</button></div>';
      rl.querySelector('#ed-rl').addEventListener('click', async () => { try { await ctx.relink(); } catch { /* user cancelled */ } renderList(); });
    }
    if (!m.tracks.length) { L.innerHTML = '<div class="ed-empty">No songs yet. Add the first one.</div>'; return; }
    m.tracks.forEach((t, i) => {
      const st = status(res, i);
      const r = document.createElement('div'); r.className = 'ed-row' + (st === 'miss' ? ' dim' : '');
      const tag = st === 'miss' ? '<span class="tag miss">not in library</span>' : (st === 'relink' ? '<span class="tag">needs re-link</span>' : '');
      r.innerHTML = '<div class="ed-main" style="cursor:default"><b>' + esc(t.title) + '</b><small>' + esc([t.artist, t.album].filter(Boolean).join(' - ') || 'Unknown artist') + tag + '</small></div>' +
        '<button type="button" class="ed-dots" aria-label="More for ' + esc(t.title) + '" aria-haspopup="true"><svg width="4" height="18" viewBox="0 0 4 18" fill="#fff"><circle cx="2" cy="2" r="2"/><circle cx="2" cy="9" r="2"/><circle cx="2" cy="16" r="2"/></svg></button>';
      r.querySelector('.ed-dots').addEventListener('click', (e) => { e.stopPropagation(); menuAt = menuAt === i ? -1 : i; renderList(); });
      L.appendChild(r);
      if (menuAt === i) {
        const mm = document.createElement('div'); mm.className = 'ed-menu'; mm.setAttribute('role', 'menu');
        mm.innerHTML = '<button type="button" data-a="up"' + (i === 0 ? ' disabled' : '') + '>Move up</button><button type="button" data-a="down"' + (i === m.tracks.length - 1 ? ' disabled' : '') + '>Move down</button><button type="button" data-a="play">Play from here</button><button type="button" data-a="rm" class="rm">Remove</button>';
        mm.addEventListener('click', (e) => {
          const a = e.target.getAttribute && e.target.getAttribute('data-a'); if (!a) return; e.stopPropagation(); menuAt = -1;
          if (a === 'up' && i > 0) { m = moveTrack(m, i, i - 1); changed(); }
          else if (a === 'down' && i < m.tracks.length - 1) { m = moveTrack(m, i, i + 1); changed(); }
          else if (a === 'rm') { m = removeTrack(m, i); changed(); }
          else if (a === 'play') { const saved = commit(); if (saved) { closeEd(); ctx.onPlay(saved, i); } }
          else renderList();
        });
        r.appendChild(mm);
      }
    });
  }
  const changed = () => { renderList(); retape(); };
  ov.addEventListener('click', (e) => { if (menuAt >= 0 && !(e.target.closest && e.target.closest('.ed-menu'))) { menuAt = -1; renderList(); } });
  renderList();

  // ── text fields
  $e('ed-title').addEventListener('input', (e) => { m = { ...m, name: e.target.value.slice(0, MAX_NAME) }; retape(); });
  $e('ed-tag').addEventListener('input', (e) => { m = withText(m, { subtitle: e.target.value }); retape(); });
  $e('ed-by').addEventListener('input', (e) => { m = withAuthor(m, e.target.value); });

  // ── sheets
  let sheetEl = null;
  const closeSheet = () => { if (sheetEl) { sheetEl.scrim.remove(); sheetEl.sheet.remove(); sheetEl = null; } };
  function openSheet(html) {
    closeSheet();
    const host = ov.querySelector('.ed'), scrim = document.createElement('div'); scrim.className = 'ed-scrim';
    const sheet = document.createElement('div'); sheet.className = 'ed-sheet'; sheet.innerHTML = html;
    scrim.addEventListener('click', closeSheet); host.appendChild(scrim); host.appendChild(sheet); sheetEl = { scrim, sheet };
    return sheet;
  }

  // Add songs from the real library (multi-add; rows show what is already on the tape).
  function pickSheet() {
    const lib = ctx.getLibraryTracks();
    const sh = openSheet('<h3>Add songs</h3>' + (lib.length
      ? '<input class="pick-q" id="pk-q" type="search" placeholder="Filter by title, artist or album" autocomplete="off"><div class="pick-rows" id="pk-rows"></div>'
      : '<p style="color:#5b5f66;line-height:1.5">Your library is empty. Scan your music folder on the Albums tab first.</p>') +
      '<div class="acts"><button type="button" class="go" id="pk-ok">Done</button></div>');
    sh.querySelector('#pk-ok').addEventListener('click', closeSheet);
    if (!lib.length) return;
    const q = sh.querySelector('#pk-q'), rows = sh.querySelector('#pk-rows');
    const have = () => new Set(resolveTracks(m, lib).filter(Boolean));
    const fill = () => {
      const f = q.value.trim().toLowerCase(), inTape = have();
      rows.textContent = '';
      let n = 0;
      for (const t of lib) {
        if (f && !`${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(f)) continue;
        if (++n > 300) break;      // keep the list light on a phone; filter to find the rest
        const b = document.createElement('button'); b.type = 'button'; b.className = 'pick-row' + (inTape.has(t) ? ' added' : '');
        b.innerHTML = '<span>' + esc(t.title) + '<small>' + esc([t.artist, t.album].filter(Boolean).join(' - ')) + '</small></span><b>' + (inTape.has(t) ? '✓' : '+') + '</b>';
        b.addEventListener('click', () => {
          m = addTrack(m, t); changed();
          b.classList.add('added'); b.querySelector('b').textContent = '✓';
          const sc = $e('ed-scroll'); if (sc) sc.scrollTop = sc.scrollHeight;
        });
        rows.appendChild(b);
      }
      if (!n) rows.innerHTML = '<div style="padding:16px;color:#6b7078">No matching songs.</div>';
    };
    q.addEventListener('input', fill); fill();
  }

  // Look: style grid, pen, ink, wear, gloss, side + note.
  function lookSheet() {
    const sh = openSheet('<h3>Look of the tape</h3><div class="ed-grid" id="g-s"></div>' +
      '<h3>Handwriting</h3><div class="ed-pens" id="g-p"></div>' +
      '<h3>Ink</h3><div class="ed-dots-row" id="g-i"></div>' +
      '<label class="rng">Wear<input type="range" id="g-w" min="0" max="1" step="0.01"></label>' +
      '<label class="rng">Gloss<input type="range" id="g-g" min="0" max="1" step="0.01"></label>' +
      '<div class="row2"><label>Side<input id="g-side" maxlength="2" autocomplete="off"></label><label>Note on the label<input id="g-note" maxlength="' + MAX_NOTE + '" autocomplete="off" placeholder="Side A · ' + m.tracks.length + ' songs"></label></div>' +
      '<div class="acts"><button type="button" class="go" id="g-ok">Done</button></div>');
    const grid = sh.querySelector('#g-s'), pens = sh.querySelector('#g-p'), inks = sh.querySelector('#g-i');
    cassetteStyles().forEach((s) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'ed-sty'; b.setAttribute('aria-pressed', String(s.id === m.cfg.style)); b.setAttribute('aria-label', s.name);
      b.innerHTML = '<span class="th"></span><span>' + esc(s.name) + '</span>';
      Cassette.mount(b.firstChild, { style: s.id, static: true, wear: 0, text: { title: m.name || 'Mixtape', subtitle: '', note: '', side: 'A' } });
      b.addEventListener('click', () => { m = withStyle(m, s.id); grid.childNodes.forEach((x) => x.setAttribute('aria-pressed', String(x === b))); tapeH.update(cfgNow()); });
      grid.appendChild(b);
    });
    Object.keys(Cassette.PENS).forEach((k) => {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = Cassette.PENS[k].label; b.style.fontFamily = Cassette.PENS[k].family; b.setAttribute('aria-pressed', String(k === m.cfg.pen));
      b.addEventListener('click', () => { m = withPen(m, k); pens.childNodes.forEach((x) => x.setAttribute('aria-pressed', String(x === b))); tapeH.update(cfgNow()); });
      pens.appendChild(b);
    });
    const dots = [{ id: 'auto', name: 'Style default', hex: null }, ...FONT_COLOURS];
    dots.forEach((c) => {
      const b = document.createElement('button'); b.type = 'button'; b.title = c.name; b.setAttribute('aria-label', 'Ink: ' + c.name);
      b.style.background = c.hex || 'conic-gradient(#c0392b,#e07a1f,#1e7a4a,#1f4fd8,#6d4cff,#c0392b)';
      b.setAttribute('aria-pressed', String((inkHex(m) || null) === c.hex || (c.hex && inkHex(m) && inkHex(m).toLowerCase() === c.hex)));
      b.addEventListener('click', () => { m = withInk(m, c.hex); inks.childNodes.forEach((x) => x.setAttribute('aria-pressed', String(x === b))); tapeH.update(cfgNow()); });
      inks.appendChild(b);
    });
    const w = sh.querySelector('#g-w'), g = sh.querySelector('#g-g');
    w.value = m.cfg.wear; g.value = m.cfg.gloss;
    w.addEventListener('input', () => { m = withWear(m, +w.value); retape(); });
    g.addEventListener('input', () => { m = withGloss(m, +g.value); retape(); });
    const side = sh.querySelector('#g-side'), note = sh.querySelector('#g-note');
    side.value = m.cfg.text.side; note.value = m.cfg.text.note;
    side.addEventListener('input', () => { m = withText(m, { side: side.value }); retape(); });
    note.addEventListener('input', () => { m = withText(m, { note: note.value }); retape(); });
    sh.querySelector('#g-ok').addEventListener('click', closeSheet);
  }
  $e('ed-tape').addEventListener('click', lookSheet);
  $e('ed-add').addEventListener('click', pickSheet);

  // ── save, play, delete, leave
  function finalizeName() { if (!m.name.trim()) { m = withName(m, 'Untitled mix'); $e('ed-title').value = m.name; } else m = withName(m, m.name); }
  function commit() {
    clearTimeout(ut);
    finalizeName();
    ctx.onSave(m);
    orig = JSON.stringify(m); isNew = false;
    return m;
  }
  function closeEd() { closeSheet(); document.removeEventListener('keydown', edKey); clearTimeout(ut); ov.remove(); if (edEl === ov) edEl = null; }
  function askLeave() {
    if (!dirty()) { closeEd(); return; }
    if (ov.querySelector('.ed-warn')) return;
    const w = document.createElement('div'); w.className = 'ed-warn';
    w.innerHTML = '<span>Discard your changes?</span><span style="display:flex;gap:8px"><button type="button" class="kp">Keep editing</button><button type="button" class="dc">Discard</button></span>';
    w.querySelector('.kp').addEventListener('click', () => w.remove());
    w.querySelector('.dc').addEventListener('click', closeEd);
    ov.querySelector('.ed').appendChild(w);
  }
  function edKey(e) { if (e.key === 'Escape') { if (sheetEl) closeSheet(); else askLeave(); } }
  document.addEventListener('keydown', edKey);
  $e('ed-back').addEventListener('click', askLeave);
  $e('ed-save').addEventListener('click', () => { commit(); closeEd(); });
  $e('ed-play').addEventListener('click', () => { const saved = commit(); closeEd(); ctx.onPlay(saved, 0); });
  const del = $e('ed-del');
  let armed = null;
  del.addEventListener('click', () => {
    if (!armed) { del.textContent = 'Tap again to delete'; armed = setTimeout(() => { armed = null; del.textContent = 'Delete mixtape'; }, 3000); return; }
    clearTimeout(armed); ctx.onDelete(m.id); closeEd();
  });
  const exp = $e('ed-exp');
  if (exp) exp.addEventListener('click', () => { finalizeName(); ctx.onExport(m); });
  setTimeout(() => { if (isNewInit) $e('ed-title').focus(); }, 80);
  return { close: closeEd, el: ov };
}
