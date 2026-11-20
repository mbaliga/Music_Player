// ─────────────────────────────────────────────────────────────────────────────
// mixtape-ui.js — DOM wiring for mixtapes: the shelf (stack / spines), editor,
// back-of-case, JSON import/export, the cassette player and localStorage
// persistence. All decisions live in the pure mixtape.js; the cassette system
// (drawing, reels, skins, editor) in src/cassette/*. This file is glue only.
//
// Player rule (spec'd by the owner): while playing you see the MIXTAPE NAME ONLY
// (the cassette; reels visibly change size with tape progress); tapping the
// cassette reveals the song list. The reels are driven by REAL playback
// (tapeProgress from the gapless queue + the engine position); the wind keys
// (hold left = rewind, right = fast-forward) scrub the tape visually and then
// seek the real playback on release, within the track or across tracks.
// ─────────────────────────────────────────────────────────────────────────────

import {
  STORAGE_KEY, cassetteCfg, resolveTracks, tapeProgress, locateTape, estimateTapeSeconds,
  serializeMixtape, parseImport, serializeCollection, parseCollection, newMixtapeId,
  isFutureCollection, collectionVersion, MIXTAPE_VERSION, withAutoReverse, withRefDuration, withDurations,
  sideOfFlat, flatIndex, sideRefs, cleanDur,
} from './mixtape.js';
import { createTransport, reduce as tpReduce, runMode, deckMessage } from './cassette/transport.js';
import { suggestTapes, draftToMixtape, SUGGEST_KEYS, suggestionBlurb } from './mixtape-suggest.js';
import { createQueue, reduce as queueReduce } from './queue.js';
import { mountPlayer, SKINS, SKIN_IDS } from './cassette/players.js';
import { mountStack, mountLibrary } from './cassette/shelf.js';
import { openEditor, openBack, closeBack } from './cassette/editor.js';

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

const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode / quota */ } },
};

// Settings keys (documented in docs/MIXTAPES.md for the Settings page)
export const KEY_AUTO_DEFAULT = 'runout.cassette.auto';      // '1' | '0': AUTO default for NEW tapes (also written when the key is pressed)
export const KEY_CLICKS = 'runout.cassette.clicks';          // '1': a soft click on the AUTO / FLIP keys (off by default)
export const KEY_HAPTICS = 'runout.cassette.haptics';        // '1': vibrate on the keys (existing)

let active = null;
/**
 * Seam for the global search ("add to mixtape"): open the editor on a NEW draft that already holds these library
 * tracks (ids from the library; or pass `tracks` directly). Never saves by itself. -> true when the editor opened.
 *   startMixtapeFrom({ trackIds: ['t-…', …], name?: 'Late night' })
 */
export function startMixtapeFrom(opts) { return active ? active.startFrom(opts || {}) : false; }

export const WIND_MIN_MS = 450;   // a quick tap still winds this long (~10 s of tape)
const WIND_SLOW = 24;             // x real time at the start of a hold
const WIND_FAST = 64;             // x real time after WIND_RAMP_MS of holding
const WIND_RAMP_MS = 2500;

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const list = parseCollection(raw);
    // Never let an unreadable blob (e.g. written by a NEWER app) be silently
    // overwritten by the next save: park a copy first. Same for a pre-v3 blob that
    // is about to migrate (v1/v2 styles/fonts map to the nearest new ones, which
    // is one-way): keep the original once.
    if (raw) {
      if (!list.length && isFutureCollection(raw)) ls.set(STORAGE_KEY + '.backup', raw);
      const v = collectionVersion(raw);
      if (list.length && v !== null && v < MIXTAPE_VERSION) ls.set(`${STORAGE_KEY}.v${v}.backup`, raw);
    }
    return list;
  } catch { return []; }
}
function save(list) { ls.set(STORAGE_KEY, serializeCollection(list)); }

/** Fill unknown durations with the mean of the known (else 4 min) so the tape is always time-weighted. */
function fillDurations(durations) {
  const n = durations.length, ok = durations.filter((d) => d > 0 && isFinite(d));
  const mean = ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : 240;
  return durations.map((d) => (d > 0 && isFinite(d) ? d : mean)).slice(0, n);
}

/** "C60 · A 7 · B 5" for the shelf. */
export function tapeMeta(m) {
  return `${m.tape.length} · A ${m.sides.A.length} · B ${m.sides.B.length}`;
}

export class MixtapeUI {
  /**
   * deps = {
   *   getLibraryTracks: () => track[]           scanned library tracks
   *   playFile: (file) => Promise<track|void>   load + play one file (main.js)
   *   closeLibrary: () => void
   *   relink?: () => Promise<void>               user-gesture re-link of persisted tracks
   * Cassette player hooks (all optional; the player degrades without them):
   *   seekFrac(frac) -> void                     seek the loaded track to a fraction of its length
   *   setPaused(on) -> void                      pause = brake the platter (existing semantics)
   *   muteBus(on) -> void                        silence the music bus while winding
   *   levelAt(t, T) -> 0..1                      loudness envelope under the needle (deck level meter)
   * Optional gapless hooks (all five or none; see queue.js + AudioEngine.prepareNext):
   *   decodeNext(file) -> Promise<track>         decode (+ envelope) without loading
   *   prepareNext(track) -> Promise<void>        park it on the engine's next deck
   *   joinNext(fadeSec) -> boolean               swap to it now (crossfade)
   *   dropNext() -> void
   *   adoptTrack(track) -> void                  tell the UI/render layer the track changed
   * }
   */
  constructor(deps) {
    this.d = deps;
    this.list = load();
    this.play = null;      // { mix, files[], relink[], durs[], idx, loading, ended, q, paused, wind, held }
    this.sel = null;       // selected mixtape id on the shelf
    this.view = ls.get('runout.mixtapes.view') === 'spines' ? 'spines' : 'stack';
    this.skin = SKIN_IDS.includes(ls.get('runout.mixtapes.skin')) ? ls.get('runout.mixtapes.skin') : 'deck';
    this.haptics = ls.get(KEY_HAPTICS) === '1';     // off by default
    this.clicks = ls.get(KEY_CLICKS) === '1';       // off by default
    this._st = { playing: false, winding: false, progress: 0, time: 0, speed: 0, level: 0, side: 'A', auto: true, msg: '' };
    this._buildPlayer();
    active = this;
  }

  /** AUTO default for new tapes. */
  get autoDefault() { return ls.get(KEY_AUTO_DEFAULT) !== '0'; }

  mount(listEl, newBtn, importBtn) {
    this.listEl = listEl;
    newBtn.addEventListener('click', () => this.edit(null));
    importBtn.addEventListener('click', () => this.importDialog());
    const bar = newBtn.parentNode;
    bar.append(h('span', { class: 'mt-bar-sp' }));
    this.viewStack = h('button', { class: 'sort-chip', type: 'button', onclick: () => this.setView('stack') }, 'Stack');
    this.viewSpines = h('button', { class: 'sort-chip', type: 'button', onclick: () => this.setView('spines') }, 'Spines');
    this.editSel = h('button', { class: 'sort-chip', type: 'button', disabled: '', onclick: () => { const m = this.byId(this.sel); if (m) this.edit(m); } }, 'Edit');
    bar.append(this.viewStack, this.viewSpines, this.editSel);
    this.render();
  }

  /** Re-render after the library changed (persisted restore / re-link). */
  refresh() { if (this.listEl) this.render(); }

  byId(id) { return this.list.find((m) => m.id === id) || null; }
  setView(v) { this.view = v; ls.set('runout.mixtapes.view', v); this.render(); }

  // ── Shelf ──────────────────────────────────────────────────────────────────
  render() {
    const el = this.listEl;
    el.replaceChildren();
    this.viewStack?.classList.toggle('active', this.view === 'stack');
    this.viewSpines?.classList.toggle('active', this.view === 'spines');
    if (this.editSel) this.editSel.disabled = !this.byId(this.sel);
    const sug = this._suggestRow();
    if (sug) el.append(sug);
    if (!this.list.length) {
      el.append(h('div', { class: 'mt-empty' }, 'No mixtapes yet. Tap “+ New” to make one from your library.'));
      return;
    }
    const items = this.list.map((m) => ({ id: m.id, cfg: cassetteCfg(m), meta: tapeMeta(m) }));
    const onSelect = (it) => { this.sel = it ? it.id : null; if (this.editSel) this.editSel.disabled = !this.byId(this.sel); };
    const host = h('div', {});
    el.append(host);
    if (this.view === 'stack') {
      // the top tape is the one on top of the stack: tap it to play, tap another to bring it up; Edit acts on the top tape
      const top = this.byId(this.sel) ? this.sel : (this.list.length ? this.list[this.list.length - 1].id : null);
      if (!this.sel && top) { this.sel = top; if (this.editSel) this.editSel.disabled = false; }
      mountStack(host, items, { selected: top, bringToTop: true, step: this.list.length <= 4 ? 0.45 : this.list.length <= 6 ? 0.36 : 0.24, onSelect, onOpen: (it) => { const m = this.byId(it.id); if (m) this.startPlayback(m); } });
    } else {
      mountLibrary(host, items, { selected: this.sel, onSelect, onOpen: (it) => { const m = this.byId(it.id); if (m) this.back(m); } });
    }
  }

  // ── Suggested tapes: a small dismissible row of auto-generated drafts (docs/MIXTAPES.md) ──
  get suggestEnabled() { return ls.get(SUGGEST_KEYS.enabled) !== '0'; }
  _dismissed() { try { const a = JSON.parse(ls.get(SUGGEST_KEYS.dismissed) || '[]'); return Array.isArray(a) ? a.filter((x) => typeof x === 'string').slice(-200) : []; } catch { return []; } }
  _suggestions() {
    if (!this.suggestEnabled) return [];
    // The local play history (src/radio/offline/play-history.js owns the format; this is a defensive read of
    // its blob, not an import: the radio code is only reachable through its own door, see boot-path.test.mjs).
    let history = null;
    try { const j = JSON.parse(ls.get('runout.radio.offline.history.v1') || 'null'); if (j && j.v === 1 && j.tracks && typeof j.tracks === 'object') history = j; } catch { /* no history yet */ }
    try {
      const lib = this.d.getLibraryTracks(), dismissed = this._dismissed();
      // the generators walk the whole library: recompute only when it (or the history / dismissals) changed
      const sig = `${lib.length}:${lib[0] ? lib[0].id : ''}:${lib.length ? lib[lib.length - 1].id : ''}:${history ? Object.keys(history.tracks).length : 0}:${dismissed.join(',')}`;
      if (this._sugCache && this._sugCache.sig === sig) return this._sugCache.list;
      const list = suggestTapes(lib, { history, dismissed });
      this._sugCache = { sig, list };
      return list;
    } catch { return []; }
  }
  _suggestRow() {
    const list = this._suggestions();
    if (!list.length) return null;
    const row = h('section', { class: 'mt-sug', 'aria-label': 'Suggested tapes' },
      h('div', { class: 'mt-sug-head' }, h('span', {}, 'Suggested tapes'),
        h('button', { class: 'mt-sug-hide', type: 'button', 'aria-label': 'Hide suggested tapes', title: 'Hide suggestions (switch them back on in Settings)', onclick: () => { ls.set(SUGGEST_KEYS.enabled, '0'); this.render(); } }, '✕')),
      h('div', { class: 'mt-sug-row' }, ...list.map((sg) => {
        const chip = h('div', { class: 'mt-sug-chip' },
          h('button', { class: 'mt-sug-open', type: 'button', title: 'Open as a draft in the editor', onclick: () => this._openSuggestion(sg) },
            h('b', {}, sg.name), h('small', {}, sg.tagline), h('em', {}, suggestionBlurb(sg))),
          h('button', { class: 'mt-sug-x', type: 'button', 'aria-label': 'Dismiss ' + sg.name, onclick: () => { ls.set(SUGGEST_KEYS.dismissed, JSON.stringify([...this._dismissed(), sg.id])); this.render(); } }, '×'));
        return chip;
      })));
    return row;
  }
  _openSuggestion(sg) {
    const m = draftToMixtape(sg, { id: newMixtapeId(Date.now(), Math.random(), this.list) });
    this.edit({ ...m, autoReverse: this.autoDefault }, { draft: true });
  }

  /** Seam (also exported as startMixtapeFrom): a NEW draft pre-filled with library tracks, opened in the editor. */
  startFrom({ trackIds, tracks, name } = {}) {
    const lib = this.d.getLibraryTracks();
    let picks = [];
    if (Array.isArray(trackIds)) {
      const byId = new Map(lib.map((t) => [t.id, t]));
      picks = trackIds.map((id) => byId.get(id)).filter(Boolean);
    } else if (Array.isArray(tracks)) picks = tracks.filter((t) => t && typeof t.title === 'string');
    const id = newMixtapeId(Date.now(), Math.random(), this.list);
    const m = { ...draftToMixtape({ id, name: name || 'x', tracks: picks, tagline: '' }, { id }), name: name || '', autoReverse: this.autoDefault };
    const skipped = picks.length - m.tracks.length;
    this.edit(m, { draft: true, notice: skipped > 0 ? `${skipped} song${skipped === 1 ? '' : 's'} did not fit on the tape and ${skipped === 1 ? 'was' : 'were'} left off.` : '' });
    return true;
  }

  back(m) {
    openBack({ mixtape: m, onPlay: (mx, i) => this.startPlayback(mx, i), onEdit: (mx) => this.edit(mx) });
  }

  // ── Editor ─────────────────────────────────────────────────────────────────
  edit(existing, opts = {}) {
    openEditor({
      mixtape: existing,
      draft: !!opts.draft,
      notice: opts.notice || '',
      defaultAuto: this.autoDefault,
      existing: this.list,
      getLibraryTracks: () => this.d.getLibraryTracks(),
      relink: this.d.relink ? async () => { await this.d.relink(); this.refresh(); } : null,
      onSave: (m) => {
        const i = this.list.findIndex((x) => x.id === m.id);
        if (i >= 0) this.list[i] = m; else this.list.push(m);
        this.sel = m.id; save(this.list); this.render();
      },
      onDelete: (id) => { this.list = this.list.filter((x) => x.id !== id); if (this.sel === id) this.sel = null; save(this.list); this.render(); },
      onPlay: (m, i) => this.startPlayback(m, i),
      onExport: (m) => this.exportDialog(m),
      onDuplicate: (m) => {
        const copy = { ...m, id: newMixtapeId(Date.now(), Math.random(), this.list), name: (m.name + ' copy').slice(0, 40) };
        this.list.push(copy); this.sel = copy.id; save(this.list); this.render();
        return copy;
      },
      onAutoDefault: (on) => ls.set(KEY_AUTO_DEFAULT, on ? '1' : '0'),
    });
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
            h('button', { class: 'theme-btn', type: 'button', onclick: () => { try { navigator.clipboard.writeText(text); } catch { /* no clipboard */ } } }, 'Copy'),
            h('button', { class: 'theme-btn primary', type: 'button', onclick: done }, 'Close'))));
    });
  }

  importDialog() {
    this._dialog('Import mixtape', (body, done) => {
      const ta = h('textarea', { class: 'mt-textarea', spellcheck: 'false', placeholder: '{ "version": 4, "name": "…", "cfg": { … }, "tape": { "length": "C60" }, "sides": { "A": [ … ], "B": [ … ] } }' });
      const step1 = h('div', { class: 'theme-step' }, ta,
        h('div', { class: 'theme-foot' }, h('span'), h('div', { class: 'theme-foot-right' },
          h('button', { class: 'theme-btn', type: 'button', onclick: done }, 'Cancel'),
          h('button', { class: 'theme-btn primary', type: 'button', onclick: preview }, 'Preview →'))));
      const step2 = h('div', { class: 'theme-step hidden' });
      body.append(h('div', { class: 'theme-hint' }, 'Paste a mixtape JSON document (any Runout version), or the data from the standalone Mixtape Deck (its “mixtape-deck:v1” blob). You will see it back exactly as pasted before anything is added.'), step1, step2);
      const ui = this;
      function preview() {
        const raw = ta.value; // shown byte-for-byte via textContent, never reformatted
        let n = 0;
        const r = parseImport(raw, { newId: () => newMixtapeId(Date.now() + n++, Math.random(), ui.list) });
        const add = h('button', { class: 'theme-btn primary', type: 'button', disabled: r.ok ? null : '', onclick: () => {
          if (!r.ok) return;
          for (const m of r.mixtapes) ui.list.push(m);
          save(ui.list); ui.render(); done();
        } }, 'Add');
        const pre = h('pre', { class: 'theme-preview' }); pre.textContent = raw;
        const note = r.ok && r.source === 'deck' ? ' Songs from the standalone deck are names only: add them again from your library in the editor to make them playable.' : '';
        step2.replaceChildren(pre,
          r.ok ? h('div', { class: 'theme-ok' }, `Looks good — ${r.mixtapes.length} mixtape${r.mixtapes.length === 1 ? '' : 's'}: ${r.mixtapes.slice(0, 3).map((m) => '“' + m.name + '”').join(', ')}${r.mixtapes.length > 3 ? '…' : ''}.${note}`)
               : h('div', { class: 'theme-error' }, r.error),
          h('div', { class: 'theme-foot' },
            h('button', { class: 'theme-btn', type: 'button', onclick: () => { step2.classList.add('hidden'); step1.classList.remove('hidden'); } }, '← Back to edit'),
            h('div', { class: 'theme-foot-right' }, h('button', { class: 'theme-btn', type: 'button', onclick: done }, 'Cancel'), add)));
        step1.classList.add('hidden'); step2.classList.remove('hidden');
      }
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
    this.host = h('div', { class: 'tp-host' });
    this.listHead = h('div', { class: 'tp-sides', role: 'tablist', 'aria-label': 'Tape side' });
    this.listBody = h('ol', { class: 'tp-songs' });
    this.listPanel = h('div', { class: 'tp-list hidden' }, this.listHead, this.listBody);
    this.msg = h('div', { class: 'tp-msg hidden' });
    this.skinBtns = SKIN_IDS.map((id) => h('button', { class: 'tp-chip', type: 'button', 'aria-pressed': String(id === this.skin), onclick: () => this._setSkin(id) }, SKINS[id].name));
    this.hapBtn = h('button', { class: 'tp-chip', type: 'button', 'aria-pressed': String(this.haptics), title: 'Vibrate on the keys', onclick: () => {
      this.haptics = !this.haptics; ls.set(KEY_HAPTICS, this.haptics ? '1' : '0'); this.hapBtn.setAttribute('aria-pressed', String(this.haptics));
      this._buzz(20);
    } }, 'Haptics');
    this.clickBtn = h('button', { class: 'tp-chip', type: 'button', 'aria-pressed': String(this.clicks), title: 'A soft click on the AUTO and FLIP keys', onclick: () => {
      this.clicks = !this.clicks; ls.set(KEY_CLICKS, this.clicks ? '1' : '0'); this.clickBtn.setAttribute('aria-pressed', String(this.clicks));
      this._click();
    } }, 'Click');
    this.root = h('div', { class: 'tp hidden', role: 'dialog', 'aria-label': 'Mixtape player' },
      h('div', { class: 'tp-bar' }, ...this.skinBtns, this.hapBtn, this.clickBtn, h('span', { class: 'sp' }),
        h('button', { class: 'btn-close', type: 'button', 'aria-label': 'Close', onclick: () => this._closePlayer() }, '✕')),
      this.host, this.msg, this.listPanel,
      h('div', { class: 'tp-hint' }, 'Tap the cassette for the songs'));
    document.body.append(this.root);
  }

  _buzz(ms) { if (this.haptics) { try { navigator.vibrate?.(ms); } catch { /* unsupported */ } } }

  /** A short soft key click (off unless the Click chip is on). A tiny noise burst; never throws. */
  _click() {
    if (!this.clicks) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ac = this._ac || (this._ac = new AC());
      if (ac.state === 'suspended') ac.resume?.();
      const n = Math.floor(ac.sampleRate * 0.012), buf = ac.createBuffer(1, n, ac.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 3);
      const src = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain();
      f.type = 'bandpass'; f.frequency.value = 1800; g.gain.value = 0.22;
      src.buffer = buf; src.connect(f); f.connect(g); g.connect(ac.destination); src.start();
    } catch { /* no audio */ }
  }

  _setSkin(id) {
    if (id === this.skin && this.pl) return;
    this.skin = id; ls.set('runout.mixtapes.skin', id);
    this.skinBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(SKIN_IDS[i] === id)));
    if (!this.root.classList.contains('hidden')) this._mountSkin();
  }

  _mountSkin() {
    if (this.pl) this.pl.destroy();
    const sk = SKINS[this.skin];
    this.host.style.setProperty('--ar', String(sk.W / sk.H));
    const pl = this.pl = mountPlayer(this.host, { player: this.skin });
    pl.on('toggle', () => this._toggle()).on('stop', () => this._stop()).on('eject', () => this._closePlayer())
      .on('next', () => this._step(1)).on('prev', () => this._step(-1)).on('skip', (s) => this._skip(s))
      .on('hold', (dir) => this._windStart(dir)).on('release', () => this._windEnd())
      .on('auto', (on) => this._setAuto(on)).on('flip', () => this._flipKey())
      .on('tap', () => this.listPanel.classList.toggle('hidden'));
    const p = this.play;
    if (p) {
      this._pushState(0, 0, performance.now(), true);
      pl.update({ side: p.tp.side, auto: p.tp.auto, msg: deckMessage(p.tp) });
      pl.insert(cassetteCfg(p.mix, { side: p.tp.side }));
    }
  }

  _closePlayer() {
    this.root.classList.add('hidden');
    this._windCancel();
    clearTimeout(this._msgTimer);
    const p = this.play;
    if (p && p.paused) { p.paused = false; this.d.setPaused?.(false); }   // closing resumes the record, like before
    if (this.pl) { this.pl.destroy(); this.pl = null; }
  }

  async startPlayback(m, startIndex = 0) {
    closeBack();
    const resolved = resolveTracks(m, this.d.getLibraryTracks());
    const files = resolved.map((t) => (t && t.file ? t.file : null));
    const relink = resolved.map((t) => !!(t && !t.file));   // known to the library, file not linked yet
    // real durations beat the hints; a freshly learned one is written back (and may be saved) below
    m = withDurations(m, resolved);
    const durations = m.tracks.map((r, i) => (resolved[i] && resolved[i].durationSec) || cleanDur(r.dur) || null);
    this._dropQueued();
    this._windCancel();
    if (this.play && this.play.paused) this.d.setPaused?.(false);
    const nA = m.sides.A.length;
    const start = Math.max(0, Math.min(m.tracks.length - 1, startIndex | 0));
    const startSide = start >= nA ? 'B' : 'A';
    const playableIn = (lo, hi) => files.slice(lo, hi).filter(Boolean).length;
    let tp = createTransport({ side: startSide, auto: m.autoReverse, nA: playableIn(0, nA), nB: playableIn(nA, files.length) });
    tp = { ...tp, pos: { ...tp.pos, [startSide]: { index: startSide === 'B' ? start - nA : start, frac: 0 } } };
    this.play = { mix: m, files, relink, durs: durations, sideDurs: null, idx: -1, loading: false, ended: false, tok: 0,
      paused: false, wind: null, held: false, T: 0, lastT: 0, lastIdx: -1, learned: -1, tp, viewSide: startSide, lastProgAt: 0,
      q: createQueue({ playable: files.map(Boolean), durations }) };
    this._sideDurations();
    this.sel = m.id;
    this.d.closeLibrary();
    this.root.classList.remove('hidden');
    this.listPanel.classList.add('hidden');
    this._msgOverride = null; this._flipHold = null;
    this._mountSkin();
    this._fillList();
    this._applyRunMode(runMode(tp));
    if (!tp.n.A && !tp.n.B) {
      this._showMsg(relink.some(Boolean)
        ? 'This tape’s tracks are remembered but need re-linking to your music folder.'
        : 'None of this tape’s tracks are in the library right now. Scan your music folder, then play again.',
      relink.some(Boolean));
      return;
    }
    this.msg.classList.add('hidden');
    // if the requested side has nothing playable, begin on the other one
    if (!tp.n[startSide]) this._dispatch({ type: 'flip' });
    this._dispatch({ type: 'play' });
  }

  /** Per-side durations with unknowns filled by the side's mean, so a side's tape is always time-weighted. */
  _sideDurations() {
    const p = this.play, nA = p.mix.sides.A.length;
    p.sideDurs = { A: fillDurations(p.durs.slice(0, nA)), B: fillDurations(p.durs.slice(nA)) };
  }
  _nSide(side) { return this.play.mix.sides[side].length; }

  _showMsg(text, withRelink) {
    this.msg.replaceChildren(text);
    if (withRelink && this.d.relink) {
      this.msg.append(' ', h('button', { class: 'sort-chip relink-btn', type: 'button', onclick: async () => {
        await this.d.relink();
        const p = this.play; if (p) this.startPlayback(p.mix);
      } }, 'Re-link…'));
    }
    this.msg.classList.remove('hidden');
  }

  /** The tracklist behind a tap on the cassette: the CURRENT SIDE's songs, the other side one tap away. */
  _fillList() {
    const p = this.play;
    if (!p) return;
    const view = p.viewSide || p.tp.side;
    this.listHead.replaceChildren(...['A', 'B'].map((sd) => h('button', {
      class: 'tp-side' + (sd === view ? ' on' : ''), type: 'button', role: 'tab', 'aria-selected': String(sd === view),
      onclick: (e) => { e.stopPropagation(); p.viewSide = sd; this._fillList(); },
    }, `Side ${sd}`, h('small', {}, ` ${p.mix.sides[sd].length}`), sd === p.tp.side ? h('i', { class: 'tp-in', title: 'In the deck' }, ' ●') : null)));
    const off = flatIndex(p.mix, view, 0);
    this.listBody.replaceChildren(...p.mix.sides[view].map((t, i) => {
      const f = off + i;
      return h('li', {
        class: (f === p.idx ? 'now ' : '') + (p.files[f] ? '' : 'missing'),
        onclick: (e) => { e.stopPropagation(); if (p.files[f]) { this.listPanel.classList.add('hidden'); this._jumpTo(f); } },
      }, t.title, h('small', {}, ` ${t.artist}`), p.relink[f] ? h('small', { class: 'relink' }, ' · needs re-link') : null);
    }));
    if (!p.mix.sides[view].length) this.listBody.append(h('li', { class: 'missing' }, 'Nothing on this side'));
  }

  // ── Transport: the pure state machine (src/cassette/transport.js) decides, this performs ──
  _dispatch(ev) {
    const p = this.play; if (!p) return [];
    const r = tpReduce(p.tp, ev);
    p.tp = r.state;
    if (p.tp.phase === 'flip' || p.tp.phase === 'end') p.ended = true;
    for (const a of r.actions) this._act(a);
    if (this.pl) this.pl.update({ side: p.tp.side, auto: p.tp.auto, msg: this._msgOverride != null ? this._msgOverride : deckMessage(p.tp) });
    return r.actions;
  }

  _act(a) {
    const p = this.play;
    switch (a.type) {
      case 'start': {
        const side = a.side, lo = flatIndex(p.mix, side, 0), hi = lo + this._nSide(side);
        let i = -1;
        for (let k = lo + a.index; k < hi; k++) if (p.files[k]) { i = k; break; }
        if (i < 0) for (let k = lo; k < hi; k++) if (p.files[k]) { i = k; break; }
        if (i < 0) return;
        p.viewSide = side;
        p.paused = false; this.d.setPaused?.(false);
        this._applyRunMode(runMode(p.tp));
        this._goto(i, i === lo + a.index ? a.frac : 0);
        break;
      }
      case 'resume': p.paused = false; this.d.setPaused?.(false); break;
      case 'pause': case 'stopPlayback': if (!p.paused) { p.paused = true; this.d.setPaused?.(true); } break;
      case 'flipAnim': this._flipView(a.to, a.reason); break;
      case 'queueMode': this._applyRunMode(a.playable); break;
      case 'notice': this._flash(a.text); break;
      case 'persistAuto': this._persistAuto(a.on); break;
      default: break;
    }
  }

  /** Which songs the gapless run may cover: 'both' (AUTO on side A: A then B as one run), or one side. */
  _applyRunMode(mode) {
    const p = this.play; if (!p) return;
    const nA = p.mix.sides.A.length;
    const playable = p.files.map((f, i) => !!f && (mode === 'both' || (mode === 'A' ? i < nA : i >= nA)));
    if (p.q.playable.length === playable.length && p.q.playable.every((v, i) => v === playable[i])) return;
    this._dropQueued();
    p.q = { ...p.q, playable, phase: 'idle', next: -1, nextBytes: 0, cold: false };
  }
  _inRun(i) { const p = this.play; return !!p.q.playable[i]; }

  /** Flip the picture: the cassette turns over (3D), the label shows the new side, the reels start that side's own tape. */
  _flipView(to, reason) {
    const p = this.play; if (!p) return;
    p.viewSide = to;
    this._buzz(reason === 'auto' ? [14, 40, 14] : 22); this._click();
    this._fillList();
    if (!this.pl) return;
    this._flipHold = { prog: this._st.progress };             // the old side's reels stay put until the cassette is edge-on
    clearTimeout(this._flipTimer);
    this._flipTimer = setTimeout(() => { this._flipHold = null; }, 175);
    const startP = p.tp.pos[to] ? tapeProgress(p.tp.pos[to].index, this._nSide(to), p.tp.pos[to].frac, p.sideDurs[to]) : 0;
    this.pl.flipTo(cassetteCfg(p.mix, { side: to }), reason === 'auto' ? 0 : startP);
  }

  _flash(text) {
    if (!this.play || !this.pl) return;
    this._msgOverride = text;
    clearTimeout(this._msgTimer);
    this._msgTimer = setTimeout(() => { this._msgOverride = null; }, 1600);
  }

  _persistAuto(on) {
    ls.set(KEY_AUTO_DEFAULT, on ? '1' : '0');
    const p = this.play; if (!p) return;
    p.mix = withAutoReverse(p.mix, on);
    const i = this.list.findIndex((x) => x.id === p.mix.id);
    if (i >= 0) { this.list[i] = withAutoReverse(this.list[i], on); save(this.list); }
  }

  _setAuto(on) { this._buzz(18); this._click(); this._dispatch({ type: 'setAuto', on: !!on }); }
  _flipKey() { this._buzz(10); this._dispatch({ type: 'flip' }); }

  _toggle() { this._dispatch({ type: 'toggle' }); }
  _stop() {
    const p = this.play; if (!p) return;
    const was = p.tp.phase;
    this._dispatch({ type: 'stop' });
    if (was !== 'playing' && was !== 'flip') this._rewindSide();   // second press: wind back to the top, ready to play
  }
  /** Top of the current side, braked. */
  _rewindSide() {
    const p = this.play;
    const side = p.tp.side, lo = flatIndex(p.mix, side, 0), hi = lo + this._nSide(side);
    p.ended = false;
    if (!p.paused) { p.paused = true; this.d.setPaused?.(true); }
    for (let k = lo; k < hi; k++) if (p.files[k]) { this._goto(k); break; }
  }

  /** Jump to a song by flat index, flipping to its side first when it is on the other one. */
  _jumpTo(flat) {
    const p = this.play; if (!p || p.loading || !p.files[flat]) return;
    const { side, index } = sideOfFlat(p.mix, flat);
    if (side !== p.tp.side) {
      this._dispatch({ type: 'flip' });
      p.tp = { ...p.tp, pos: { ...p.tp.pos, [side]: { index, frac: 0 } } };
    } else p.tp = { ...p.tp, pos: { ...p.tp.pos, [side]: { index, frac: 0 } } };
    p.ended = false;
    this._dispatch({ type: 'play' });
    if (p.idx !== flat) this._goto(flat);
  }

  _playable(from, dir) {
    const p = this.play;
    for (let i = from; i >= 0 && i < p.files.length; i += dir) if (p.files[i] && this._inRun(i)) return i;
    return -1;
  }
  _step(dir) {
    const p = this.play; if (!p || p.loading) return;
    if (dir < 0 && p.lastT > 2 && p.idx >= 0) { this.d.seekFrac?.(0); return; }   // like a deck: restart first
    const i = this._playable(p.idx + dir, dir);
    if (i >= 0) this._goto(i); else if (dir < 0) this.d.seekFrac?.(0);
    this._buzz(10);
  }
  _skip(sec) {
    const p = this.play; if (!p || p.loading || p.idx < 0) return;
    const T = p.T, t = p.lastT + sec;
    if (T > 0 && t >= 0 && t < T - 1) { this.d.seekFrac?.(t / T); return; }
    this._step(sec > 0 ? 1 : -1);
  }

  // ── Wind: hold left = rewind, right = fast-forward — on the CURRENT SIDE's own tape ─────────
  // The reels spin and the pack radii change as the tape runs past; the music bus is silent
  // meanwhile. On release the side's tape position is resolved to (track, time) and the real
  // playback seeks there. Rewinding past the start of the side stops; winding off the end is the
  // end of the side (auto-reverse or "flip tape", per the transport).
  _windStart(dir) {
    const p = this.play; if (!p || p.idx < 0 || p.loading || p.tp.phase === 'flip' || p.tp.phase === 'end') return;
    this._windCancel(true);
    const cur = this._progressNow();
    p.wind = { dir, p: cur, t0: performance.now(), mul: WIND_SLOW, track: p.idx, time: p.lastT, lastLoc: 0 };
    p.held = true;
    this.d.muteBus?.(true);
    this._buzz(14);
  }
  _windEnd() { const p = this.play; if (p) p.held = false; }
  _windCancel(keepMute) {
    const p = this.play;
    if (!p || !p.wind) return;
    p.wind = null; p.held = false;
    if (!keepMute) this.d.muteBus?.(false);
  }
  _windCommit(edge) {
    const p = this.play, w = p.wind;
    p.wind = null; p.held = false;
    const side = p.tp.side, lo = flatIndex(p.mix, side, 0), n = this._nSide(side);
    if (edge === 'start') {
      this.d.muteBus?.(false);
      this._dispatch({ type: 'windEdge', edge: 'start' });
      this._rewindSide();
      return;
    }
    if (edge === 'end') {
      this.d.muteBus?.(false);
      this._dispatch({ type: 'windEdge', edge: 'end' });
      return;
    }
    const loc = locateTape(w.p, n, p.sideDurs[side]);
    let i = lo + loc.index;
    if (!p.files[i]) {
      let j = -1;
      for (let k = i; k >= lo && k < lo + n; k += w.dir) if (p.files[k]) { j = k; break; }
      if (j < 0) for (let k = i; k >= lo && k < lo + n; k -= w.dir) if (p.files[k]) { j = k; break; }
      i = j; loc.frac = w.dir > 0 ? 0 : 0.99;
    }
    if (i < 0) { this.d.muteBus?.(false); return; }
    const frac = Math.max(0, Math.min(0.985, loc.frac));
    this._dispatch({ type: 'seek', index: i - lo, frac });
    if (i === p.idx) { this.d.seekFrac?.(frac); this.d.muteBus?.(false); }
    else this._goto(i, frac).then(() => this.d.muteBus?.(false));
  }

  /** Whole-SIDE tape progress (each side is its own tape: B's is not a mirror of A's). */
  _progressNow() {
    const p = this.play;
    if (!p) return 0;
    if (p.wind) return p.wind.p;
    if (this._flipHold) return this._flipHold.prog;
    if (p.idx < 0) return 0;
    const side = p.tp.side, { side: isd, index } = sideOfFlat(p.mix, p.idx);
    if (isd !== side) { const q = p.tp.pos[side]; return tapeProgress(q.index, this._nSide(side), q.frac, p.sideDurs[side]); }   // flipped, not started yet
    const frac = p.ended ? 1 : (p.T > 0 ? p.lastT / p.T : 0);
    return tapeProgress(index, this._nSide(side), frac, p.sideDurs[side]);
  }

  async _goto(i, frac = 0) {
    const p = this.play;
    if (!p || !p.files[i]) return;
    p.idx = i; p.loading = true; p.ended = false;
    this._fillList();
    // Tell the queue first: jumping to the track it already decoded joins it
    // with no re-decode; any other jump discards the queued deck.
    const acts = this._q({ type: 'start', index: i });
    if (acts.some((a) => a.type === 'join') && p.nextTrack && p.nextTrack.index === i) {
      this._applyJoin(i, 0.02);
      p.loading = false;
      if (frac > 0) this.d.seekFrac?.(frac);
      return;
    }
    p.tok++; p.nextTrack = null; this.d.dropNext?.();
    try {
      const tr = await this.d.playFile(p.files[i]);
      if (tr && tr.frames) p.q = { ...p.q, curBytes: tr.frames * (tr.channels ? tr.channels.length : 2) * 4 };
      if (frac > 0) this.d.seekFrac?.(frac);
    } catch (e) { this.msg.textContent = 'Could not play “' + p.mix.tracks[i].title + '”.'; this.msg.classList.remove('hidden'); }
    p.loading = false;
  }

  // ── Gapless queue host (policy in queue.js; engine hooks in audio-engine.js) ──
  get _gapless() { return !!(this.d.decodeNext && this.d.prepareNext && this.d.joinNext && this.d.adoptTrack); }

  /** Feed an event to the pure queue; run the actions it returns. */
  _q(ev) {
    const p = this.play;
    if (!p) return [];
    const { state, actions } = queueReduce(p.q, ev);
    p.q = state;
    for (const a of actions) {
      if (ev.type === 'start') continue; // _goto handles start's actions itself
      if (a.type === 'preload') this._preload(a.index);
      else if (a.type === 'join') this._applyJoin(a.index, a.fadeSec);
      else if (a.type === 'cold') this._goto(a.index);
      else if (a.type === 'end') { p.ended = true; this._dispatch({ type: 'sideEnd' }); }
      else if (a.type === 'drop-next') { p.tok++; p.nextTrack = null; this.d.dropNext?.(); }
    }
    return actions;
  }

  async _preload(index) {
    const p = this.play;
    const tok = ++p.tok;
    try {
      const tr = await this.d.decodeNext(p.files[index]);
      if (this.play !== p || p.tok !== tok) return;   // user jumped / new tape: discard
      await this.d.prepareNext(tr);                   // engine copies the PCM...
      const bytes = tr.frames * (tr.channels ? tr.channels.length : 2) * 4;
      tr.channels = null;                             // ...so drop ours: bounded memory
      if (this.play !== p || p.tok !== tok) { this.d.dropNext?.(); return; }
      p.nextTrack = { index, tr };
      this._q({ type: 'preloaded', index, bytes });
    } catch {
      if (this.play === p && p.tok === tok) this._q({ type: 'preloadFailed', index });
    }
  }

  _applyJoin(index, fadeSec) {
    const p = this.play;
    const nt = p && p.nextTrack;
    if (!nt || nt.index !== index || !this.d.joinNext(fadeSec)) {
      // Nothing usable queued after all: fall back to a plain cold load.
      this._dropQueued();
      if (p) { p.q = createQueue({ playable: p.q.playable, durations: p.q.durations }); this._goto(index); }
      return;
    }
    p.nextTrack = null;
    p.idx = index;
    this.d.adoptTrack(nt.tr);
    this._q({ type: 'joined' });
    this._fillList();
  }

  _dropQueued() {
    if (this.play) { this.play.tok++; this.play.nextTrack = null; }
    this.d.dropNext?.();
  }

  _pushState(t, level, now, force) {
    const p = this.play, s = this._st;
    s.playing = !!p && !p.paused && !p.ended && !p.loading && p.idx >= 0;
    s.winding = !!(p && p.wind);
    s.progress = this._progressNow();
    s.time = p && p.wind ? p.wind.time || 0 : t;
    s.level = level;
    if (p) { s.side = p.tp.side; s.auto = p.tp.auto; s.msg = this._msgOverride != null ? this._msgOverride : deckMessage(p.tp); }
    if (this.pl) this.pl.update(s);
  }

  /** A real duration is known (decoded): write it onto the tape's ref (and save), so caps use the truth from now on. */
  _learn(p) {
    if (p.learned === p.idx || !(p.T > 0.5)) return;
    p.learned = p.idx;
    const next = withRefDuration(p.mix, p.idx, p.T);
    p.durs[p.idx] = p.T;
    this._sideDurations();
    if (next === p.mix) return;
    p.mix = next;
    const i = this.list.findIndex((x) => x.id === next.id);
    if (i >= 0) { this.list[i] = withRefDuration(this.list[i], p.idx, p.T); save(this.list); }
  }

  /** Called every frame by main.js with the live playback state. */
  tick(t, T, rate, dt) {
    const p = this.play;
    if (!p) return;
    p.lastT = t; p.T = T;
    if (p.idx !== p.lastIdx) {
      p.lastIdx = p.idx; if (p.wind) p.wind.track = p.idx;
      if (p.idx >= 0) { const { side, index } = sideOfFlat(p.mix, p.idx); this._dispatch({ type: 'changed', side, index }); }
    }
    if (!p.loading && p.idx >= 0) this._learn(p);
    if (!p.loading && p.idx >= 0 && !p.wind) {
      if (this._gapless) {
        // Bounded-memory gapless advance: preload the next track ahead of the runout, join at it.
        if (p.q.cur !== p.idx) p.q = { ...p.q, cur: p.idx };
        this._q({ type: 'tick', t, T, rate });
      } else if (!p.ended && T > 0.5 && t >= T - 0.05) {
        // No engine hooks: plain load-at-the-runout (a short gap).
        const next = this._playable(p.idx + 1, 1);
        if (next >= 0) this._goto(next); else { p.ended = true; this._dispatch({ type: 'sideEnd' }); }
      }
      if (p.tp.phase === 'playing') {
        const nowMs = performance.now();
        if (nowMs - p.lastProgAt > 250) {            // the side's own tape position, remembered for a later flip back
          p.lastProgAt = nowMs;
          const { side, index } = sideOfFlat(p.mix, p.idx);
          if (side === p.tp.side) this._dispatch({ type: 'progress', index, frac: T > 0 ? t / T : 0 });
        }
      }
    }
    if (this.root.classList.contains('hidden') || !this.pl) return;   // nothing visible: no per-frame work
    const now = performance.now();
    let mul = p.ended || p.loading ? 0 : rate;
    const w = p.wind;
    if (w) {
      const held = now - w.t0, side = p.tp.side, n = this._nSide(side);
      w.mul = WIND_SLOW + (WIND_FAST - WIND_SLOW) * Math.min(1, held / WIND_RAMP_MS);
      const tapeSec = estimateTapeSeconds(p.sideDurs[side], n);
      w.p = Math.max(0, Math.min(1, w.p + w.dir * w.mul * dt / tapeSec));
      mul = w.dir * w.mul;
      const edge = w.dir > 0 && w.p >= 1 ? 'end' : (w.dir < 0 && w.p <= 0 ? 'start' : null);
      if (edge || (!p.held && held >= WIND_MIN_MS)) { this._windCommit(edge); mul = 0; }
      else if (now - (w.lastLoc || 0) > 120) {            // track number / time readout, ~8x a second
        w.lastLoc = now;
        const loc = locateTape(w.p, n, p.sideDurs[side]);
        w.time = loc.frac * (p.sideDurs[side][loc.index] || 0);
        const flat = flatIndex(p.mix, side, loc.index);
        if (flat !== w.track) { w.track = flat; this._buzz(8); }
      }
    }
    const level = this.d.levelAt ? this.d.levelAt(t, T) : 0;
    this._pushState(t, level, now, false);
    this.pl.frame(this._st.progress, mul, dt, now);
  }
}
