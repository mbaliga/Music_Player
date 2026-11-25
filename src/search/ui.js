// ui.js — the global Search overlay (DOM). All library / station / mixtape text is untrusted: it only ever reaches the page through
// textContent / text nodes / attributes set with setAttribute — never innerHTML (the only innerHTML here is static icon markup).
//
//   const search = createSearchOverlay(deps)       search.open({ query, chip }) · close() · toggle() · isOpen() · invalidate() · destroy()
//   deps = {
//     getSources(): { library, mixtapes, radioModel, aiOn }       read live when the overlay opens / data changes
//     getCannedIndex(): Promise<entry[]>                          the pre-written stations index (local asset, no network)
//     actions: searchActions                                      src/search/actions.js
//     storage, remember(): boolean                                recents (src/search/recents.js) and the "don't remember" setting
//     directory: createDirectorySearch()                          the one explicit network use
//     onOpen(), onClose()                                         shell hooks (close the drawer / inert the page)
//   }
import { createIndexBuilder, buildIndex, replaceType, indexSize, query, TYPES, SINGULAR } from './index.js';
import { adaptLibrary, adaptStations, adaptMixtapes } from './adapters.js';
import { loadRecents, saveRecents, addRecent, removeRecent, clearRecents } from './recents.js';
import { stepActive, debounceMs, librarySignature, segments, CHIPS, limitsFor } from './view.js';
import { OFFLINE_NOTE, clean } from './directory.js';
import { trapFocus } from '../ui/focus-trap.js';
import { shortCountry } from '../radio.js';

const ICONS = {   // static markup only
  song: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M9 18V6l10-2v12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><circle cx="7" cy="18" r="2.4" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="17" cy="16" r="2.4" fill="none" stroke="currentColor" stroke-width="1.7"/></svg>',
  album: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="12" cy="12" r="2.6" fill="none" stroke="currentColor" stroke-width="1.7"/></svg>',
  artist: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><circle cx="12" cy="8.5" r="3.6" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M5 20c.8-4 3.6-5.6 7-5.6s6.2 1.6 7 5.6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  mixtape: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><rect x="3.5" y="6" width="17" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="9" cy="12" r="1.9" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="15" cy="12" r="1.9" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
  station: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M4 9h16v10H4zM8 9l9-5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round"/><circle cx="9" cy="14" r="2.2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M14 13h4M14 16h4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  search: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M15 15l5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  back: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  globe: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M3.5 12h17M12 3.5c3 3.2 3 13.8 0 17M12 3.5c-3 3.2-3 13.8 0 17" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
};
const GROUP_LABEL = { songs: 'Songs', albums: 'Albums', artists: 'Artists', mixtapes: 'Mixtapes', stations: 'Radio' };
const CHUNK_AT = 1500;     // above this many songs the index is built in idle-time chunks instead of on the spot

const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v; else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v); else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(String(k)));
  return e;
};
const icon = (name) => { const s = document.createElement('span'); s.className = 'so-ico'; s.setAttribute('aria-hidden', 'true'); s.innerHTML = ICONS[name] || ''; return s; };
/** text + ranges -> a fragment of text nodes and <mark>s. */
export function highlighted(text, ranges) {
  const f = document.createDocumentFragment();
  for (const s of segments(text, ranges)) { if (s.mark) { const m = document.createElement('mark'); m.textContent = s.t; f.append(m); } else f.append(document.createTextNode(s.t)); }
  return f;
}
const idle = (fn) => { try { if (typeof requestIdleCallback === 'function') return requestIdleCallback(fn, { timeout: 120 }); } catch { /* */ } return setTimeout(fn, 0); };

export function createSearchOverlay(deps) {
  const doc = document;
  let root = null, input, clearBtn, chipsEl, bodyEl, statusEl, liveEl, backBtn, headTitle;
  let isOpen = false, releaseTrap = null, historyPushed = false;
  let index = null, builder = null, sig = null, lookup = null, cannedIndex = null;
  let q = '', chip = 'all', stack = [], result = null, rows = [], active = -1, dirState = null, timer = 0, composing = false, noteText = '';
  let recents = [];

  const storage = () => deps.storage || null;
  const remember = () => { try { return deps.remember ? !!deps.remember() : true; } catch { return true; } };
  const act = deps.actions;

  // ── DOM ──
  function build() {
    input = h('input', { class: 'so-input', type: 'search', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'so-list', 'aria-autocomplete': 'list', 'aria-label': 'Search songs, albums, artists, mixtapes and radio', placeholder: 'Search your music and radio', enterkeyhint: 'search', autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', maxlength: '200' });
    clearBtn = h('button', { type: 'button', class: 'so-clear', 'aria-label': 'Clear search', hidden: true, onclick: () => { input.value = ''; onInput(); input.focus(); } }, '×');
    backBtn = h('button', { type: 'button', class: 'so-back', 'aria-label': 'Close search', onclick: () => back() });
    backBtn.innerHTML = ICONS.back;
    headTitle = h('div', { class: 'so-drill-title', hidden: true });
    chipsEl = h('div', { class: 'so-chips', role: 'radiogroup', 'aria-label': 'Search in' });
    for (const c of CHIPS) chipsEl.append(h('button', { type: 'button', class: 'so-chip', role: 'radio', 'data-chip': c.id, onclick: () => setChip(c.id) }, c.label, h('span', { class: 'so-n' })));
    chipsEl.addEventListener('keydown', (e) => {
      const bs = [...chipsEl.children]; const i = bs.indexOf(doc.activeElement);
      const st = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!st || i < 0) return; e.preventDefault(); e.stopPropagation();
      const n = bs[(i + st + bs.length) % bs.length]; setChip(n.dataset.chip); chipsEl.querySelector('[data-chip="' + n.dataset.chip + '"]').focus();
    });
    bodyEl = h('div', { class: 'so-body', id: 'so-list', role: 'listbox', 'aria-label': 'Results' });
    statusEl = h('div', { class: 'so-status' });
    liveEl = h('div', { class: 'so-live', 'aria-live': 'polite', role: 'status' });
    const field = h('div', { class: 'so-field' }, icon('search'), input, clearBtn);
    root = h('div', { class: 'search-ov hidden', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Search', onkeydown: onKey },
      h('div', { class: 'so-card' }, h('div', { class: 'so-head' }, backBtn, field), chipsEl, statusEl, bodyEl, liveEl));
    root.addEventListener('click', (e) => { if (e.target === root) close(); });
    input.addEventListener('input', onInput);
    input.addEventListener('compositionstart', () => { composing = true; });
    input.addEventListener('compositionend', () => { composing = false; onInput(); });
    (deps.mount || doc.body).append(root);
  }

  // ── data ──
  function refreshSources({ force = false } = {}) {
    let src = {};
    try { src = deps.getSources() || {}; } catch { src = {}; }
    const lib = src.library;
    let tracks = [];
    try { tracks = lib ? (Array.isArray(lib) ? lib : (typeof lib.tracks === 'function' ? lib.tracks() : lib.tracks)) : []; } catch { tracks = []; }
    const s = librarySignature(tracks);
    if (force || s !== sig || !index) {
      const { data, lookup: lk } = adaptLibrary(lib);
      sig = s; lookup = lk;
      if (builder) builder.cancel();
      if (data.tracks.length > CHUNK_AT) {
        builder = createIndexBuilder({ tracks: data.tracks, albums: data.albums, artists: data.artists }, { schedule: idle, chunk: 1500, onProgress: () => { if (isOpen) paintStatus(); } });
        index = builder.index;
        builder.done.then(() => { if (isOpen) run(); });
      } else { builder = null; index = buildIndex({ tracks: data.tracks, albums: data.albums, artists: data.artists }); }
    }
    replaceType(index, 'mixtapes', adaptMixtapes(src.mixtapes));
    replaceType(index, 'stations', adaptStations({ radioModel: src.radioModel, cannedIndex: cannedIndex || [], aiOn: !!src.aiOn }));
  }
  function loadCanned() {
    if (cannedIndex || !deps.getCannedIndex) return;
    Promise.resolve().then(() => deps.getCannedIndex()).then((idx) => { if (Array.isArray(idx) && idx.length) { cannedIndex = idx; if (index) { refreshSources(); if (isOpen) run(); } } }).catch(() => {});
  }

  // ── query + render ──
  function run() {
    if (!isOpen || !index) return;
    q = input.value;
    const cur = stack[stack.length - 1];
    if (cur && cur.kind !== 'results') { renderDrill(cur); return; }
    result = query(index, q, { limit: limitsFor(chip) });
    paintChips(); render();
  }
  function setChip(id) { chip = CHIPS.some((c) => c.id === id) ? id : 'all'; run(); input.focus(); }
  function paintChips() {
    for (const b of chipsEl.children) {
      const id = b.dataset.chip, on = id === chip;
      b.setAttribute('aria-checked', String(on)); b.classList.toggle('on', on); b.tabIndex = on ? 0 : -1;
      const n = b.querySelector('.so-n'); const c = CHIPS.find((x) => x.id === id);
      const cnt = result && !result.empty ? (id === 'all' ? result.counts.total : result.counts[c.types[0]]) : 0;
      n.textContent = cnt ? String(cnt > 999 ? '999+' : cnt) : '';
    }
  }
  function paintStatus() {
    let s = '';
    if (builder && builder.progress() < 1) s = `Indexing your library… ${Math.round(builder.progress() * 100)}%`;
    statusEl.textContent = s; statusEl.hidden = !s;
  }
  function typesShown() { const c = CHIPS.find((x) => x.id === chip); return c && c.types ? c.types : TYPES; }

  function rowEl(res, n) {
    const id = `so-opt-${n}`;
    const t = h('span', { class: 'so-t' }, highlighted(res.title, res.ranges && res.ranges.title));
    const kids = [t];
    if (res.subtitle) kids.push(h('span', { class: 'so-s' }, highlighted(res.subtitle, res.ranges && res.ranges.subtitle)));
    if (res.detail) kids.push(h('span', { class: 'so-d' }, highlighted(res.detail, res.ranges && res.ranges.detail)));
    const tags = [];
    if (res.type === 'station' && res.disabled) tags.push(h('span', { class: 'so-tag' }, res.note || 'Coming soon'));
    if (res.type === 'station' && res.fav) tags.push(h('span', { class: 'so-tag fav', 'aria-label': 'Favourite' }, '★'));
    if (res.type === 'song' && res.relink) tags.push(h('span', { class: 'so-tag' }, 'Re-link'));
    if (res.type === 'album' && res.kind === 'cd') tags.push(h('span', { class: 'so-tag' }, 'CD'));
    const r = h('div', { class: 'so-row' + (res.disabled ? ' off' : ''), role: 'option', id, 'aria-selected': 'false', 'aria-disabled': res.disabled ? 'true' : null, 'data-type': res.type, tabindex: '-1' },
      icon(res.type), h('span', { class: 'so-txt' }, ...kids), tags.length ? h('span', { class: 'so-tags' }, ...tags) : null);
    r._res = res;
    r.addEventListener('click', () => { const all = [...bodyEl.querySelectorAll('.so-row')]; setActive(Math.max(0, all.indexOf(r)), false); activate(res); });
    return r;
  }
  function header(type, count, shown) {
    const hd = h('div', { class: 'so-sec', role: 'presentation' }, h('span', { class: 'so-sec-t' }, GROUP_LABEL[type]), h('span', { class: 'so-sec-n' }, String(count)));
    if (count > shown && chip === 'all') hd.append(h('button', { type: 'button', class: 'so-more', onclick: () => setChip(type) }, `See all ${count}`));
    return hd;
  }

  function render() {
    rows = []; active = -1;
    input.removeAttribute('aria-activedescendant');
    const frag = document.createDocumentFragment();
    const r = result;
    let any = false;
    if (r.empty) {
      // nothing typed: recents + what you played lately + a tip
      if (recents.length) {
        const sec = h('div', { class: 'so-sec' }, h('span', { class: 'so-sec-t' }, 'Recent searches'), h('button', { type: 'button', class: 'so-more', onclick: () => { recents = []; clearRecents(storage()); render(); } }, 'Clear'));
        frag.append(sec);
        const list = h('div', { class: 'so-recents' });
        for (const t of recents) {
          list.append(h('div', { class: 'so-rec' },
            h('button', { type: 'button', class: 'so-rec-go', onclick: () => { input.value = t; onInput(); input.focus(); } }, icon('search'), h('span', { class: 'so-t' }, t)),
            h('button', { type: 'button', class: 'so-rec-x', 'aria-label': 'Remove ' + t + ' from recent searches', onclick: () => { recents = removeRecent(recents, t); saveRecents(storage(), recents); render(); } }, '×')));
        }
        frag.append(list);
      }
      for (const type of typesShown()) {
        const items = r[type]; if (!items.length) continue; any = true;
        frag.append(h('div', { class: 'so-sec' }, h('span', { class: 'so-sec-t' }, type === 'stations' ? 'Played lately on Radio' : 'Played lately: ' + GROUP_LABEL[type].toLowerCase())));
        for (const it of items) { const n = rows.length; const el = rowEl(it, n); rows.push({ el, res: it }); frag.append(el); }
      }
      const total = indexSize(index);
      if (!any && !recents.length) {
        frag.append(h('div', { class: 'so-empty' }, h('b', {}, 'Search your music and radio'),
          total ? 'Songs, albums, artists, mixtapes and stations, all on this phone. Try a name, or filter with the chips.' : 'Your library is empty. Scan a folder in Albums, then search it here. The pre-written radio shows are searchable already.'));
      }
      frag.append(h('div', { class: 'so-tip' }, 'Try an artist, album or song. The chips above narrow it to one kind.'));
      liveEl.textContent = '';
    } else {
      for (const type of typesShown()) {
        const items = r[type]; if (!items.length) continue; any = true;
        frag.append(header(type, r.counts[type], items.length));
        for (const it of items) { const n = rows.length; const el = rowEl(it, n); rows.push({ el, res: it }); frag.append(el); }
      }
      if (!any) frag.append(h('div', { class: 'so-empty' }, h('b', {}, `Nothing matches “${r.text.trim().slice(0, 60)}”`), 'Check the spelling, or pick All above.'));
      if (r.fuzzy && any) frag.append(h('div', { class: 'so-tip' }, 'Showing close matches.'));
      liveEl.textContent = any ? `${r.counts.total} result${r.counts.total === 1 ? '' : 's'}` : 'No results';
    }
    // the explicit, user-started network search: only for a typed query, never automatic
    if (!r.empty && r.tokens.length && (chip === 'all' || chip === 'stations') && (chip === 'stations' || !any || RADIO_LIKE.test(r.text))) frag.append(directoryBlock(r.text));   // not under every query: only for a radio-like query, the Radio chip, or when nothing local matched
    bodyEl.replaceChildren(frag);
    clearBtn.hidden = !input.value;
    paintStatus();
    if (!r.empty && bodyEl.querySelector('.so-row')) setActive(0, false);
  }

  const RADIO_LIKE = /\b(fm|am|radio|station|stations|bbc|npr|kexp|live|stream|\d{2,3}[.,]\d)\b/i;

function directoryBlock(text) {
    const wrap = h('div', { class: 'so-dir' });
    const label = clean(text);
    const go = h('button', { type: 'button', class: 'so-dirbtn', onclick: () => searchDirectory(label) }, icon('globe'), h('span', { class: 'so-txt' }, h('span', { class: 'so-t' }, `Search the internet radio directory for “${label}”`), h('span', { class: 'so-s' }, 'Uses the network, only when you tap this')));
    wrap.append(go);
    if (dirState && dirState.q === label) {
      if (dirState.busy) wrap.append(h('div', { class: 'so-note' }, 'Searching the directory…'));
      else if (dirState.error) wrap.append(h('div', { class: 'so-note', role: 'status' }, dirState.error));
      else if (dirState.stations) {
        if (!dirState.stations.length) wrap.append(h('div', { class: 'so-note' }, 'No stations found. Try another search.'));
        wrap.append(h('div', { class: 'so-sec' }, h('span', { class: 'so-sec-t' }, 'Internet radio'), h('span', { class: 'so-sec-n' }, String(dirState.stations.length))));
        for (const st of dirState.stations) {
          const n = 1000 + rows.length + wrap.querySelectorAll('.so-row').length;
          const res = { type: 'station', id: st.id, title: st.name, subtitle: [shortCountry(st.country), st.tags && st.tags.slice(0, 2).join(', ')].filter(Boolean).join(' · '), station: st, ranges: { title: [], subtitle: [] }, stationType: st.type };
          wrap.append(rowEl(res, n));
        }
      }
    }
    return wrap;
  }
  async function searchDirectory(label) {
    if (!label) return;
    dirState = { q: label, busy: true };
    render(); rememberQuery();
    const r = await deps.directory.search(label);
    if (r.kind === 'superseded') return;
    dirState = r.ok ? { q: label, stations: r.stations } : { q: label, error: r.error };
    if (isOpen && clean(input.value) === label) { render(); const first = bodyEl.querySelector('.so-dir .so-row'); if (first) first.scrollIntoView({ block: 'nearest' }); }
  }

  // ── drill-downs ──
  const recSong = (t, extra = {}) => ({ type: 'song', id: t.id, title: t.title, subtitle: [t.artist, t.album].filter(Boolean).join(' · '), relink: t.relink, ranges: { title: [], subtitle: [] }, ...extra });
  const recAlbum = (a) => ({ type: 'album', id: a.id, title: a.name, subtitle: a.artist, kind: a.kind, detail: `${a.kind === 'cd' ? 'CD' : 'Vinyl'} · ${a.trackCount} song${a.trackCount === 1 ? '' : 's'}`, ranges: { title: [], subtitle: [] } });
  function push(view) { stack.push(view); renderDrill(view); }
  function renderDrill(view) {
    rows = []; active = -1; input.removeAttribute('aria-activedescendant');
    backBtn.setAttribute('aria-label', 'Back to results'); headTitle.hidden = false; chipsEl.hidden = true; statusEl.hidden = true;
    const frag = document.createDocumentFragment();
    let ids = [], title = '', sub = '';
    if (view.kind === 'album') {
      const a = lookup && lookup.album(view.id); const tr = lookup ? lookup.albumTracks(view.id) : [];
      title = a ? a.name : 'Album'; sub = a ? [a.artist, a.kind === 'cd' ? 'CD' : 'Vinyl', `${tr.length} song${tr.length === 1 ? '' : 's'}`].filter(Boolean).join(' · ') : '';
      ids = tr.map((t) => t.id);
      frag.append(actionsBar(ids, [{ label: 'Play album', primary: true, run: () => ids.length && act.playTrack(ids[0]).then(done) }, { label: 'Open in Albums', run: () => act.openAlbum(view.id).then((ok) => (ok ? close() : note('Albums could not show this one.'))), show: () => act.has('openAlbum') }]));
      tr.forEach((t, i) => { const n = rows.length; const el = rowEl(recSong(t, { subtitle: `${i + 1}. ${[t.artist].filter(Boolean).join('')}` }), n); rows.push({ el, res: recSong(t) }); frag.append(el); });
      if (!tr.length) frag.append(h('div', { class: 'so-empty' }, 'No songs found for this album.'));
    } else if (view.kind === 'artist') {
      const al = lookup ? lookup.artistAlbums(view.name) : [], tr = lookup ? lookup.artistTracks(view.name) : [];
      title = view.name; sub = `${al.length} album${al.length === 1 ? '' : 's'} · ${tr.length} song${tr.length === 1 ? '' : 's'}`;
      ids = tr.map((t) => t.id);
      frag.append(actionsBar(ids, [{ label: 'Play all', primary: true, run: () => ids.length && act.playTracks(ids).then((ok) => (ok ? done(true) : act.playTrack(ids[0]).then(done))) }]));
      if (al.length) { frag.append(h('div', { class: 'so-sec' }, h('span', { class: 'so-sec-t' }, 'Albums'), h('span', { class: 'so-sec-n' }, String(al.length)))); for (const a of al) { const n = rows.length; const r = recAlbum(a); const el = rowEl(r, n); rows.push({ el, res: r }); frag.append(el); } }
      if (tr.length) { frag.append(h('div', { class: 'so-sec' }, h('span', { class: 'so-sec-t' }, 'Songs'), h('span', { class: 'so-sec-n' }, String(tr.length)))); for (const t of tr.slice(0, 300)) { const n = rows.length; const r = recSong(t); const el = rowEl(r, n); rows.push({ el, res: r }); frag.append(el); } }
      if (!al.length && !tr.length) frag.append(h('div', { class: 'so-empty' }, 'Nothing found for this artist.'));
    }
    headTitle.replaceChildren(h('b', {}, title), h('span', {}, sub));
    bodyEl.replaceChildren(frag);
    bodyEl.scrollTop = 0;
    bodyEl.prepend(headTitle);
    if (bodyEl.querySelector('.so-row')) setActive(0, false);
  }
  function actionsBar(ids, list) {
    const bar = h('div', { class: 'so-actions' });
    for (const a of list) { if (a.show && !a.show()) continue; bar.append(h('button', { type: 'button', class: 'so-act' + (a.primary ? ' primary' : ''), disabled: ids.length ? null : true, onclick: a.run }, a.label)); }
    if (act.has('addToMixtape') && ids.length) bar.append(h('button', { type: 'button', class: 'so-act', onclick: () => act.addToMixtape(ids).then((ok) => { if (ok) close(); else note('The mixtape maker could not take these songs.'); }) }, 'Add to mixtape'));
    return bar;
  }

  // ── activation ──
  function rememberQuery() { try { if (remember()) { recents = addRecent(recents, input.value); saveRecents(storage(), recents); } } catch { /* */ } }
  function note(text) { noteText = text; liveEl.textContent = text; const n = h('div', { class: 'so-toast', role: 'status' }, text); bodyEl.prepend(n); setTimeout(() => n.remove(), 3500); }
  function done(ok) { if (ok) close(); else note('That could not be played here. If the song needs re-linking, open Albums and choose Re-link.'); }
  async function activate(res) {
    if (!res || res.disabled) { if (res && res.disabled) note(`${res.title}: ${res.note || 'coming soon'}.`); return; }
    rememberQuery();
    if (res.type === 'song') return done(await act.playTrack(res.id));
    if (res.type === 'album') return push({ kind: 'album', id: res.id });
    if (res.type === 'artist') return push({ kind: 'artist', name: res.id || res.title });
    if (res.type === 'mixtape') { const ok = await act.openMixtape(res.id); return ok ? close() : note('That mixtape could not be opened.'); }
    if (res.type === 'station') { const ok = await act.playStation(res.station || res.key || `${res.stationType}|${res.id}`); return ok ? close() : note('That station could not be started.'); }
  }

  // ── input + keyboard ──
  function onInput() {
    if (composing) return;
    clearBtn.hidden = !input.value;
    dirState = dirState && dirState.q === clean(input.value) ? dirState : null;
    if (deps.directory && deps.directory.cancel && !dirState) deps.directory.cancel();
    clearTimeout(timer);
    const cur = stack[stack.length - 1];
    if (cur && cur.kind !== 'results') { stack = [{ kind: 'results' }]; leaveDrill(); }
    const d = debounceMs(index ? indexSize(index) : 0);
    if (d) timer = setTimeout(run, d); else run();
  }
  function leaveDrill() { headTitle.hidden = true; chipsEl.hidden = false; backBtn.setAttribute('aria-label', 'Close search'); }
  function setActive(n, scroll = true) {
    const all = [...bodyEl.querySelectorAll('.so-row')];
    if (!all.length) { active = -1; return; }
    active = Math.max(0, Math.min(all.length - 1, n));
    all.forEach((el, i) => { const on = i === active; el.setAttribute('aria-selected', String(on)); el.classList.toggle('on', on); });
    input.setAttribute('aria-activedescendant', all[active].id);
    if (scroll) all[active].scrollIntoView({ block: 'nearest' });
  }
  const resOf = (el) => el && el._res;
  function onKey(e) {
    if (e.isComposing || composing) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); back(); return; }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key) && (doc.activeElement === input || e.key.startsWith('Arrow'))) {
      if ((e.key === 'Home' || e.key === 'End') && doc.activeElement === input) return;   // caret movement inside the field
      const n = bodyEl.querySelectorAll('.so-row').length;
      if (!n) return;
      e.preventDefault(); setActive(stepActive(active, e.key, n)); return;
    }
    if (e.key === 'Enter' && doc.activeElement === input) {
      e.preventDefault();
      const all = [...bodyEl.querySelectorAll('.so-row')];
      const el = all[active]; const res = el && resOf(el);
      if (res) { activate(res); return; }
      if (!all.length && clean(input.value) && (chip === 'all' || chip === 'stations')) { rememberQuery(); }
    }
  }
  function back() {
    if (stack.length > 1) { stack.pop(); leaveDrill(); run(); input.focus(); return; }
    close();
  }

  // ── open / close ──
  function open(o = {}) {
    if (!root) build();
    if (isOpen) { if (typeof o.query === 'string') { input.value = o.query; onInput(); } input.focus(); return; }
    try { deps.onOpen && deps.onOpen(); } catch { /* */ }
    recents = loadRecents(storage());
    refreshSources(); loadCanned();
    isOpen = true; stack = [{ kind: 'results' }]; dirState = null; leaveDrill();
    chip = CHIPS.some((c) => c.id === o.chip) ? o.chip : 'all';
    input.value = typeof o.query === 'string' ? o.query.slice(0, 200) : '';
    root.classList.remove('hidden');
    releaseTrap = trapFocus(root, { initial: input, restore: true });   // Tab stays inside; Escape is the overlay's own back() (drill-down aware)
    try { history.pushState({ runoutSearch: 1 }, ''); historyPushed = true; } catch { historyPushed = false; }
    run();
    requestAnimationFrame(() => { try { input.focus({ preventScroll: true }); input.select(); } catch { /* */ } });
  }
  function close(fromPop = false) {
    if (!isOpen) return;
    isOpen = false; clearTimeout(timer);
    if (builder && builder.progress() < 1) { /* keep building in the background: the next open is instant */ }
    if (deps.directory && deps.directory.cancel) deps.directory.cancel();
    root.classList.add('hidden');
    if (historyPushed && !fromPop) { historyPushed = false; try { history.back(); } catch { /* */ } }
    historyPushed = false;
    try { deps.onClose && deps.onClose(); } catch { /* */ }
    if (releaseTrap) { const r = releaseTrap; releaseTrap = null; r(); }
  }
  const onPop = () => { if (isOpen) close(true); };
  window.addEventListener('popstate', onPop);

  return {
    open, close, toggle: () => (isOpen ? close() : open()), isOpen: () => isOpen,
    /** Sources changed (library scanned, mixtape saved, station favourited): rebuild on the next open / now if open. */
    invalidate() { sig = null; if (isOpen) { refreshSources(); run(); } },
    rememberCleared() { recents = []; },
    get element() { return root; },
    destroy() { window.removeEventListener('popstate', onPop); root && root.remove(); },
  };
}
