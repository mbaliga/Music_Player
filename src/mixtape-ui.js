// ─────────────────────────────────────────────────────────────────────────────
// mixtape-ui.js — DOM wiring for mixtapes: list, editor, JSON import/export,
// the cassette player, and localStorage persistence. All decisions live in the
// pure mixtape.js; drawing in cassette.js. This file is glue only.
//
// Player rule (spec'd by the owner): the playback view shows ONLY the mixtape
// name on the cassette label; tapping the cassette reveals the track list.
// Reels change size with whole-tape progress (mixtape.js:reelRadii).
// ─────────────────────────────────────────────────────────────────────────────

import {
  CASSETTE_STYLES, FONTS, FONT_COLOURS, STORAGE_KEY, styleById,
  createMixtape, withName, withStyle, withFont, withFontColor,
  addTrack, removeTrack, moveTrack, resolveTracks, tapeProgress,
  serializeMixtape, parseMixtape, serializeCollection, parseCollection, newMixtapeId,
} from './mixtape.js';
import { drawCassette, cassetteRect } from './cassette.js';

const h = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) e.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null) e.append(c);
  return e;
};

function load() {
  try { return parseCollection(localStorage.getItem(STORAGE_KEY)); } catch { return []; }
}
function save(list) {
  try { localStorage.setItem(STORAGE_KEY, serializeCollection(list)); } catch {}
}

function thumb(style, w, opts = {}) {
  const c = h('canvas', { class: 'mt-thumb' });
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const ch = Math.round(w / 1.6) + 8;
  c.width = (w + 8) * dpr; c.height = ch * dpr;
  c.style.width = (w + 8) + 'px'; c.style.height = ch + 'px';
  const ctx = c.getContext('2d'); ctx.scale(dpr, dpr);
  drawCassette(ctx, style, { x: 4, y: 4, w, h: w / 1.6 }, { showName: !!opts.name, ...opts });
  return c;
}

export class MixtapeUI {
  /**
   * deps = {
   *   getLibraryTracks: () => track[]           scanned library tracks
   *   playFile: (file) => Promise<void>         load + play one file (main.js)
   *   closeLibrary: () => void
   * }
   */
  constructor(deps) {
    this.d = deps;
    this.list = load();
    this.play = null;      // { mix, files[], idx, loading, ended }
    this.angle = 0;
    this._buildPlayer();
  }

  mount(listEl, newBtn, importBtn) {
    this.listEl = listEl;
    newBtn.addEventListener('click', () => this.edit(null));
    importBtn.addEventListener('click', () => this.importDialog());
    this.render();
  }

  render() {
    const el = this.listEl;
    el.replaceChildren();
    if (!this.list.length) {
      el.append(h('div', { class: 'grid-empty' }, 'No mixtapes yet. Tap “+ New mixtape” to make one from your library.'));
    }
    for (const m of this.list) {
      const card = h('div', { class: 'mt-card', onclick: () => this.startPlayback(m) },
        thumb(styleById(m.styleId), 150, { name: m.name, fontId: m.fontId, fontColor: m.fontColor, progress: 0.35 }),
        h('div', { class: 'mt-card-meta' },
          h('div', { class: 'alb-name' }, m.name),
          h('div', { class: 'alb-artist' }, `${m.tracks.length} track${m.tracks.length === 1 ? '' : 's'}`)),
        h('button', { class: 'sort-chip mt-edit', type: 'button', onclick: (e) => { e.stopPropagation(); this.edit(m); } }, 'Edit'));
      el.append(card);
    }
  }

  // ── Editor ────────────────────────────────────────────────────────────────
  edit(existing) {
    const isNew = !existing;
    let m = existing || createMixtape({ id: newMixtapeId(Date.now(), Math.random(), this.list), name: 'My Mixtape' });
    const host = document.getElementById('libOverlay');
    host.querySelector('.mt-editor')?.remove();

    const preview = h('canvas', { class: 'mt-preview' });
    const nameIn = h('input', { class: 'mt-name', type: 'text', maxlength: '40', value: m.name, 'aria-label': 'Mixtape name' });
    const styleRow = h('div', { class: 'mt-row mt-styles' });
    const fontRow = h('div', { class: 'mt-row' });
    const colRow = h('div', { class: 'mt-row' });
    const listEl = h('ol', { class: 'mt-tracks' });
    const pickerEl = h('div', { class: 'mt-picker hidden' });

    const drawPreview = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.min(host.clientWidth - 32, 360);
      preview.width = w * dpr; preview.height = (w / 1.6 + 16) * dpr;
      preview.style.width = w + 'px'; preview.style.height = (w / 1.6 + 16) + 'px';
      const ctx = preview.getContext('2d'); ctx.scale(dpr, dpr);
      drawCassette(ctx, styleById(m.styleId), { x: 8, y: 8, w: w - 16, h: (w - 16) / 1.6 },
        { name: m.name, fontId: m.fontId, fontColor: m.fontColor, progress: 0.3 });
    };
    const refresh = () => {
      styleRow.replaceChildren(...CASSETTE_STYLES.map((s) => h('button', {
        class: 'mt-swatch' + (s.id === m.styleId ? ' on' : ''), type: 'button', title: s.name,
        onclick: () => { m = withStyle(m, s.id); refresh(); },
      }, thumb(s, 76))));
      fontRow.replaceChildren(...FONTS.map((f) => h('button', {
        class: 'sort-chip' + (f.id === m.fontId ? ' active' : ''), type: 'button',
        style: `font-family:${f.css};font-weight:${f.weight};font-style:${f.style}`,
        onclick: () => { m = withFont(m, f.id); refresh(); },
      }, f.name)));
      colRow.replaceChildren(...FONT_COLOURS.map((c) => h('button', {
        class: 'mt-dot' + (c.hex.toLowerCase() === m.fontColor.toLowerCase() ? ' on' : ''), type: 'button',
        title: c.name, style: `background:${c.hex}`,
        onclick: () => { m = withFontColor(m, c.hex); refresh(); },
      })));
      const lib = this.d.getLibraryTracks();
      const have = new Set(resolveTracks(m, lib).map((t, i) => (t ? i : -1)));
      listEl.replaceChildren(...m.tracks.map((t, i) => h('li', { class: have.has(i) ? '' : 'missing' },
        h('span', { class: 'mt-t' }, t.title, h('small', {}, ` ${t.artist}${have.has(i) ? '' : ' · not in library'}`)),
        h('button', { type: 'button', class: 'mt-mini', 'aria-label': 'Move up', onclick: () => { m = moveTrack(m, i, i - 1); refresh(); } }, '↑'),
        h('button', { type: 'button', class: 'mt-mini', 'aria-label': 'Move down', onclick: () => { m = moveTrack(m, i, i + 1); refresh(); } }, '↓'),
        h('button', { type: 'button', class: 'mt-mini', 'aria-label': 'Remove', onclick: () => { m = removeTrack(m, i); refresh(); } }, '✕'))));
      if (!m.tracks.length) listEl.append(h('li', { class: 'missing' }, 'No tracks yet — add some below.'));
      drawPreview();
    };

    const openPicker = () => {
      const lib = this.d.getLibraryTracks();
      pickerEl.classList.remove('hidden');
      pickerEl.replaceChildren();
      if (!lib.length) {
        pickerEl.append(h('div', { class: 'grid-empty' }, 'Your library is empty. Scan a music folder on the Albums tab first.'));
        return;
      }
      const q = h('input', { class: 'mt-name', type: 'search', placeholder: 'Filter tracks…' });
      const rows = h('div', { class: 'mt-pick-rows' });
      const fill = () => {
        const f = q.value.trim().toLowerCase();
        rows.replaceChildren(...lib.filter((t) => !f || `${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(f)).map((t) =>
          h('div', { class: 'mt-pick-row', onclick: () => { m = addTrack(m, t); refresh(); } },
            h('span', {}, t.title, h('small', {}, ` ${t.artist}`)), h('b', {}, '+'))));
      };
      q.addEventListener('input', fill); fill();
      pickerEl.append(q, rows, h('button', { class: 'theme-btn', type: 'button', onclick: () => pickerEl.classList.add('hidden') }, 'Done'));
    };

    // Raw while typing (so spaces/blank behave naturally); cleaned by withName on save/export.
    nameIn.addEventListener('input', () => { m = { ...m, name: nameIn.value.slice(0, 40) }; drawPreview(); });

    const close = () => sheet.remove();
    const commit = () => {
      m = withName(m, nameIn.value);
      const i = this.list.findIndex((x) => x.id === m.id);
      if (i >= 0) this.list[i] = m; else this.list.push(m);
      save(this.list); this.render(); close();
    };
    const sheet = h('div', { class: 'mt-editor' },
      h('div', { class: 'alb-detail-head' },
        h('button', { class: 'btn-close', type: 'button', 'aria-label': 'Back', onclick: close }, '←'),
        h('div', { class: 'alb-detail-title' }, isNew ? 'New mixtape' : 'Edit mixtape')),
      h('div', { class: 'mt-editor-body' },
        preview, nameIn,
        h('div', { class: 'sp-label' }, 'Cassette'), styleRow,
        h('div', { class: 'sp-label' }, 'Font'), fontRow,
        h('div', { class: 'sp-label' }, 'Font colour'), colRow,
        h('div', { class: 'sp-label' }, 'Tracks'), listEl,
        h('button', { class: 'theme-btn', type: 'button', onclick: openPicker }, '+ Add tracks from library'),
        pickerEl,
        h('div', { class: 'theme-foot' },
          h('div', { class: 'theme-foot-left' },
            h('button', { class: 'theme-btn link', type: 'button', onclick: () => this.exportDialog(withName(m, nameIn.value)) }, 'Export JSON'),
            isNew ? null : h('button', { class: 'theme-btn link', type: 'button', onclick: () => {
              this.list = this.list.filter((x) => x.id !== m.id); save(this.list); this.render(); close();
            } }, 'Delete')),
          h('div', { class: 'theme-foot-right' },
            h('button', { class: 'theme-btn primary', type: 'button', onclick: commit }, 'Save')))));
    host.append(sheet);
    refresh();
  }

  // ── JSON export (plain text, verbatim) / import (paste → verbatim preview → add) ──
  exportDialog(m) {
    this._dialog('Export mixtape', (body, done) => {
      const text = serializeMixtape(m);
      body.append(
        h('div', { class: 'theme-hint' }, 'This exact text is the mixtape. Copy it to back up or share.'),
        h('pre', { class: 'theme-preview' }, text),
        h('div', { class: 'theme-foot' }, h('span'),
          h('div', { class: 'theme-foot-right' },
            h('button', { class: 'theme-btn', type: 'button', onclick: () => { try { navigator.clipboard.writeText(text); } catch {} } }, 'Copy'),
            h('button', { class: 'theme-btn primary', type: 'button', onclick: done }, 'Close'))));
    });
  }

  importDialog() {
    this._dialog('Import mixtape', (body, done) => {
      const ta = h('textarea', { class: 'mt-textarea', spellcheck: 'false', placeholder: '{ "version": 1, "name": "…", "style": "noir", … }' });
      const step1 = h('div', { class: 'theme-step' }, ta,
        h('div', { class: 'theme-foot' }, h('span'), h('div', { class: 'theme-foot-right' },
          h('button', { class: 'theme-btn', type: 'button', onclick: done }, 'Cancel'),
          h('button', { class: 'theme-btn primary', type: 'button', onclick: preview }, 'Preview →'))));
      const step2 = h('div', { class: 'theme-step hidden' });
      body.append(h('div', { class: 'theme-hint' }, 'Paste a mixtape JSON document. You will see it back exactly as pasted before anything is added.'), step1, step2);
      function preview() {
        const raw = ta.value; // shown byte-for-byte via textContent, never reformatted
        const r = parseMixtape(raw, { id: newMixtapeId(Date.now(), Math.random(), ui.list) });
        const add = h('button', { class: 'theme-btn primary', type: 'button', disabled: r.ok ? null : '', onclick: () => {
          if (!r.ok) return; ui.list.push(r.mixtape); save(ui.list); ui.render(); done();
        } }, 'Add');
        const pre = h('pre', { class: 'theme-preview' }); pre.textContent = raw;
        step2.replaceChildren(pre,
          r.ok ? h('div', { class: 'theme-ok' }, `Looks good — “${r.mixtape.name}”, ${r.mixtape.tracks.length} track(s).`)
               : h('div', { class: 'theme-error' }, r.error),
          h('div', { class: 'theme-foot' },
            h('button', { class: 'theme-btn', type: 'button', onclick: () => { step2.classList.add('hidden'); step1.classList.remove('hidden'); } }, '← Back to edit'),
            h('div', { class: 'theme-foot-right' }, h('button', { class: 'theme-btn', type: 'button', onclick: done }, 'Cancel'), add)));
        step1.classList.add('hidden'); step2.classList.remove('hidden');
      }
      const ui = this;
    });
  }

  _dialog(title, build) {
    const ov = h('div', { class: 'theme-overlay mt-dialog' });
    const card = h('div', { class: 'theme-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, h('div', { class: 'theme-title' }, title));
    ov.append(card);
    const done = () => ov.remove();
    ov.addEventListener('click', (e) => { if (e.target === ov) done(); });
    build(card, done);
    document.body.append(ov);
  }

  // ── Player ────────────────────────────────────────────────────────────────
  _buildPlayer() {
    this.canvas = h('canvas', { class: 'tp-canvas' });
    this.listPanel = h('ol', { class: 'tp-list hidden' });
    this.msg = h('div', { class: 'tp-msg hidden' });
    this.root = h('div', { class: 'tp hidden', role: 'dialog', 'aria-label': 'Mixtape player' },
      h('button', { class: 'btn-close tp-close', type: 'button', 'aria-label': 'Close', onclick: () => this.root.classList.add('hidden') }, '✕'),
      this.canvas, this.msg, this.listPanel);
    // Tapping the cassette toggles the track list (name-only by default).
    this.canvas.addEventListener('click', () => this.listPanel.classList.toggle('hidden'));
    document.body.append(this.root);
    window.addEventListener('resize', () => this._size());
  }

  _size() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, r.width * dpr); this.canvas.height = Math.max(1, r.height * dpr);
    this._dpr = dpr; this._cw = r.width; this._ch = r.height;
  }

  async startPlayback(m) {
    const files = resolveTracks(m, this.d.getLibraryTracks()).map((t) => (t ? t.file : null));
    this.play = { mix: m, files, idx: -1, loading: false, ended: false };
    this.d.closeLibrary();
    this.root.classList.remove('hidden');
    this.listPanel.classList.add('hidden');
    this._size();
    this._fillList();
    const first = files.findIndex(Boolean);
    if (first < 0) {
      this.msg.textContent = 'None of this tape’s tracks are in the library right now. Scan your music folder, then play again.';
      this.msg.classList.remove('hidden');
      return;
    }
    this.msg.classList.add('hidden');
    await this._goto(first);
  }

  _fillList() {
    const p = this.play;
    this.listPanel.replaceChildren(...p.mix.tracks.map((t, i) => h('li', {
      class: (i === p.idx ? 'now ' : '') + (p.files[i] ? '' : 'missing'),
      onclick: (e) => { e.stopPropagation(); if (p.files[i]) this._goto(i); },
    }, t.title, h('small', {}, ` ${t.artist}`))));
  }

  async _goto(i) {
    const p = this.play;
    if (!p || !p.files[i]) return;
    p.idx = i; p.loading = true; p.ended = false;
    this._fillList();
    try { await this.d.playFile(p.files[i]); }
    catch (e) { this.msg.textContent = 'Could not play “' + p.mix.tracks[i].title + '”.'; this.msg.classList.remove('hidden'); }
    p.loading = false;
  }

  /** Called every frame by main.js with the live playback state. */
  tick(t, T, rate, dt) {
    const p = this.play;
    if (!p) return;
    // Advance to the next playable track at the runout.
    if (!p.loading && !p.ended && p.idx >= 0 && T > 0.5 && t >= T - 0.05) {
      const next = p.files.findIndex((f, i) => i > p.idx && f);
      if (next >= 0) this._goto(next); else p.ended = true;
    }
    if (this.root.classList.contains('hidden')) return;
    this.angle += rate * dt * 4;
    if (!this._cw) this._size();
    const ctx = this.canvas.getContext('2d');
    ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
    ctx.clearRect(0, 0, this._cw, this._ch);
    const frac = p.ended ? 1 : (T > 0 ? t / T : 0);
    const progress = p.idx < 0 ? 0 : tapeProgress(p.idx, p.mix.tracks.length, frac);
    drawCassette(ctx, styleById(p.mix.styleId), cassetteRect(this._cw, this._ch, 24), {
      name: p.mix.name, fontId: p.mix.fontId, fontColor: p.mix.fontColor, progress, angle: this.angle,
    });
  }
}
