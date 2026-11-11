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
  isFutureCollection, collectionVersion, MIXTAPE_VERSION,
} from './mixtape.js';
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
    this.haptics = ls.get('runout.cassette.haptics') === '1';     // off by default
    this._st = { playing: false, winding: false, progress: 0, time: 0, speed: 0, level: 0 };
    this._buildPlayer();
  }

  mount(listEl, newBtn, importBtn) {
    this.listEl = listEl;
    newBtn.addEventListener('click', () => this.edit(null));
    importBtn.addEventListener('click', () => this.importDialog());
    const bar = newBtn.parentNode;
    this.viewStack = h('button', { class: 'sort-chip', type: 'button', onclick: () => this.setView('stack') }, 'Stack');
    this.viewSpines = h('button', { class: 'sort-chip', type: 'button', onclick: () => this.setView('spines') }, 'Spines');
    this.editSel = h('button', { class: 'sort-chip', type: 'button', disabled: '', onclick: () => { const m = this.byId(this.sel); if (m) this.edit(m); } }, 'Edit selected');
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
    if (!this.list.length) {
      el.append(h('div', { class: 'mt-empty' }, 'No mixtapes yet. Tap “+ New mixtape” to make one from your library.'));
      return;
    }
    const items = this.list.map((m) => ({ id: m.id, cfg: cassetteCfg(m) }));
    const onSelect = (it) => { this.sel = it ? it.id : null; if (this.editSel) this.editSel.disabled = !this.byId(this.sel); };
    const host = h('div', {});
    el.append(host);
    if (this.view === 'stack') {
      mountStack(host, items, { selected: this.sel, onSelect, onOpen: (it) => { const m = this.byId(it.id); if (m) this.startPlayback(m); } });
    } else {
      mountLibrary(host, items, { selected: this.sel, onSelect, onOpen: (it) => { const m = this.byId(it.id); if (m) this.back(m); } });
    }
  }

  back(m) {
    openBack({ mixtape: m, onPlay: (mx, i) => this.startPlayback(mx, i), onEdit: (mx) => this.edit(mx) });
  }

  // ── Editor ─────────────────────────────────────────────────────────────────
  edit(existing) {
    openEditor({
      mixtape: existing,
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
      const ta = h('textarea', { class: 'mt-textarea', spellcheck: 'false', placeholder: '{ "version": 3, "name": "…", "cfg": { … }, "tracks": [ … ] }' });
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
    this.listPanel = h('ol', { class: 'tp-list hidden' });
    this.msg = h('div', { class: 'tp-msg hidden' });
    this.skinBtns = SKIN_IDS.map((id) => h('button', { class: 'tp-chip', type: 'button', 'aria-pressed': String(id === this.skin), onclick: () => this._setSkin(id) }, SKINS[id].name));
    this.hapBtn = h('button', { class: 'tp-chip', type: 'button', 'aria-pressed': String(this.haptics), title: 'Vibrate on the wind keys', onclick: () => {
      this.haptics = !this.haptics; ls.set('runout.cassette.haptics', this.haptics ? '1' : '0'); this.hapBtn.setAttribute('aria-pressed', String(this.haptics));
      this._buzz(20);
    } }, 'Haptics');
    this.root = h('div', { class: 'tp hidden', role: 'dialog', 'aria-label': 'Mixtape player' },
      h('div', { class: 'tp-bar' }, ...this.skinBtns, this.hapBtn, h('span', { class: 'sp' }),
        h('button', { class: 'btn-close', type: 'button', 'aria-label': 'Close', onclick: () => this._closePlayer() }, '✕')),
      this.host, this.msg, this.listPanel,
      h('div', { class: 'tp-hint' }, 'Tap the cassette for the songs'));
    document.body.append(this.root);
  }

  _buzz(ms) { if (this.haptics) { try { navigator.vibrate?.(ms); } catch { /* unsupported */ } } }

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
      .on('tap', () => this.listPanel.classList.toggle('hidden'));
    const p = this.play;
    if (p) { this._pushState(0, 0, performance.now(), true); pl.insert(cassetteCfg(p.mix)); }
  }

  _closePlayer() {
    this.root.classList.add('hidden');
    this._windCancel();
    const p = this.play;
    if (p && p.paused) { p.paused = false; this.d.setPaused?.(false); }   // closing resumes the record, like before
    if (this.pl) { this.pl.destroy(); this.pl = null; }
  }

  async startPlayback(m, startIndex = 0) {
    closeBack();
    const resolved = resolveTracks(m, this.d.getLibraryTracks());
    const files = resolved.map((t) => (t && t.file ? t.file : null));
    const relink = resolved.map((t) => !!(t && !t.file));   // known to the library, file not linked yet
    const durations = resolved.map((t) => (t && t.durationSec) || null);
    this._dropQueued();
    this._windCancel();
    if (this.play && this.play.paused) this.d.setPaused?.(false);
    this.play = { mix: m, files, relink, durs: fillDurations(durations), idx: -1, loading: false, ended: false, tok: 0,
      paused: false, wind: null, held: false, T: 0, lastT: 0, lastIdx: -1,
      q: createQueue({ playable: files.map(Boolean), durations }) };
    this.sel = m.id;
    this.d.closeLibrary();
    this.root.classList.remove('hidden');
    this.listPanel.classList.add('hidden');
    this._mountSkin();
    this._fillList();
    const want = files[startIndex] ? startIndex : files.findIndex(Boolean);
    if (want < 0) {
      this._showMsg(relink.some(Boolean)
        ? 'This tape’s tracks are remembered but need re-linking to your music folder.'
        : 'None of this tape’s tracks are in the library right now. Scan your music folder, then play again.',
      relink.some(Boolean));
      return;
    }
    this.msg.classList.add('hidden');
    await this._goto(want);
  }

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

  _fillList() {
    const p = this.play;
    this.listPanel.replaceChildren(...p.mix.tracks.map((t, i) => h('li', {
      class: (i === p.idx ? 'now ' : '') + (p.files[i] ? '' : 'missing'),
      onclick: (e) => { e.stopPropagation(); if (p.files[i]) { this.listPanel.classList.add('hidden'); this._goto(i); } },
    }, t.title, h('small', {}, ` ${t.artist}`), p.relink[i] ? h('small', { class: 'relink' }, ' · needs re-link') : null)));
  }

  // ── Transport (keys on the skin) ────────────────────────────────────────────
  _toggle() {
    const p = this.play; if (!p) return;
    p.paused = !p.paused; this.d.setPaused?.(p.paused);
  }
  _stop() {
    const p = this.play; if (!p) return;
    if (!p.paused) { p.paused = true; this.d.setPaused?.(true); return; }
    const first = p.files.findIndex(Boolean);
    if (first >= 0) this._goto(first);        // stays braked: wind back to the top, ready to play
  }
  _playable(from, dir) {
    const p = this.play;
    for (let i = from; i >= 0 && i < p.files.length; i += dir) if (p.files[i]) return i;
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

  // ── Wind: hold left = rewind, right = fast-forward ──────────────────────────
  // The reels spin and the pack radii change as the tape runs past; the music bus
  // is silent meanwhile. On release the tape position is resolved to (track, time)
  // and the real playback seeks there: inside the current track with a seek, into
  // another track via the queue (goto + seek).
  _windStart(dir) {
    const p = this.play; if (!p || p.idx < 0 || p.loading) return;
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
  _windCommit() {
    const p = this.play, w = p.wind;
    p.wind = null; p.held = false;
    const loc = locateTape(w.p, p.files.length, p.durs);
    let i = loc.index;
    if (!p.files[i]) {
      i = this._playable(i, w.dir);
      if (i < 0) i = this._playable(loc.index, -w.dir);
      loc.frac = w.dir > 0 ? 0 : 0.99;
    }
    if (i < 0) { this.d.muteBus?.(false); return; }
    const frac = Math.max(0, Math.min(0.985, loc.frac));
    if (i === p.idx) { this.d.seekFrac?.(frac); this.d.muteBus?.(false); }
    else this._goto(i, frac).then(() => this.d.muteBus?.(false));
  }

  _progressNow() {
    const p = this.play;
    if (!p) return 0;
    if (p.wind) return p.wind.p;
    if (p.idx < 0) return 0;
    const frac = p.ended ? 1 : (p.T > 0 ? p.lastT / p.T : 0);
    return tapeProgress(p.idx, p.mix.tracks.length, frac, p.durs);
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
      else if (a.type === 'end') p.ended = true;
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
      if (p) { p.q = createQueue({ playable: p.files.map(Boolean), durations: p.q.durations }); this._goto(index); }
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
    if (this.pl) this.pl.update(s);
  }

  /** Called every frame by main.js with the live playback state. */
  tick(t, T, rate, dt) {
    const p = this.play;
    if (!p) return;
    p.lastT = t; p.T = T;
    if (p.idx !== p.lastIdx) { p.lastIdx = p.idx; if (p.wind) p.wind.track = p.idx; }
    if (!p.loading && p.idx >= 0 && !p.wind) {
      if (this._gapless) {
        // Bounded-memory gapless advance: preload the next track ahead of the runout, join at it.
        if (p.q.cur !== p.idx) p.q = { ...p.q, cur: p.idx };
        this._q({ type: 'tick', t, T, rate });
      } else if (!p.ended && T > 0.5 && t >= T - 0.05) {
        // No engine hooks: plain load-at-the-runout (a short gap).
        const next = p.files.findIndex((f, i) => i > p.idx && f);
        if (next >= 0) this._goto(next); else p.ended = true;
      }
    }
    if (this.root.classList.contains('hidden') || !this.pl) return;   // nothing visible: no per-frame work
    const now = performance.now();
    let mul = p.ended || p.loading ? 0 : rate;
    const w = p.wind;
    if (w) {
      const held = now - w.t0;
      w.mul = WIND_SLOW + (WIND_FAST - WIND_SLOW) * Math.min(1, held / WIND_RAMP_MS);
      const tapeSec = estimateTapeSeconds(p.durs, p.files.length);
      w.p = Math.max(0, Math.min(1, w.p + w.dir * w.mul * dt / tapeSec));
      mul = w.dir * w.mul;
      const hitEnd = (w.dir > 0 && w.p >= 1) || (w.dir < 0 && w.p <= 0);
      if ((!p.held && held >= WIND_MIN_MS) || hitEnd) { this._windCommit(); mul = 0; }
      else if (now - (w.lastLoc || 0) > 120) {            // track number / time readout, ~8x a second
        w.lastLoc = now;
        const loc = locateTape(w.p, p.files.length, p.durs);
        w.time = loc.frac * p.durs[loc.index];
        if (loc.index !== w.track) { w.track = loc.index; this._buzz(8); }
      }
    }
    const level = this.d.levelAt ? this.d.levelAt(t, T) : 0;
    this._pushState(t, level, now, false);
    this.pl.frame(this._st.progress, mul, dt, now);
  }
}
