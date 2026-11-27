// ─────────────────────────────────────────────────────────────────────────────
// radio-player.js — streams real radio stations through an <audio> element and
// provides the Radio tab UI. Browser-only glue; logic is in radio.js (pure) and
// stations.js (the station-type seam).
//
// The radio plays through a plain HTMLAudioElement, NOT the vinyl worklet
// engine: a live stream has no duration, no spiral, nothing to scrub. While a
// station plays, main.js mutes the vinyl bus (onActive) and restores it on
// stop, so the two never talk over each other.
// ─────────────────────────────────────────────────────────────────────────────

import { discoverServers, searchStations, describeStation, streamCandidates, MAX_RECONNECTS } from './radio.js';
import { registerStationType, registerAiStationTypes, unregisterAiStationTypes, registerCannedStationType, createSessionFor, listStationTypes, aiYouStation } from './stations.js';
import { createStreamSession } from './radio-session.js';
import { isRadioAiEnabled, setRadioAiEnabled } from './radio/flag.js';
import {
  loadModel, saveModel, stationKey, stationFromEntry, isFavourite, toggleFavourite, recordPlayed, clearRecents,
  refreshCannedSnapshots, isMissingCanned, removeEntry,
} from './radio-store.js';

// ── StationType 'radio-browser': a Session is an <audio> element on a URL ────
// (alternate-URL fallback + reconnect/backoff live in radio-session.js)
registerStationType({
  id: 'radio-browser',
  label: 'Radio stations',
  createSession: (station, env = {}) => createStreamSession(station, env),
});

// AI stations ('ai-you', 'ai-you-city'): OFF unless the `radio.ai` flag is set; the core is only ever
// pulled in by this dynamic import when an AI station is actually started (see src/radio/core/README.md).
// The offline host (src/radio/offline/, templated writer + the phone's own speech, no network) is a second lazy door.
function registerAi() {
  return registerAiStationTypes({
    isEnabled: () => { try { return isRadioAiEnabled(window.localStorage); } catch { return false; } },
    loadCore: () => import('./radio/core/index.js'),
    loadHost: () => import('./radio/offline/index.js'),
  });
}
registerAi();

// Pre-written (canned) stations: always available, no flag. Their code is a lazy import, fetched only when the dial is shown or
// one of them starts (see src/radio/canned/).
registerCannedStationType({ loadCanned: () => import('./radio/canned/index.js') });

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

const NO_LONGER = 'This station is no longer in the app';
const GENRES = ['jazz', 'rock', 'classical', 'ambient', 'lofi', 'news', 'electronic', 'folk'];

export class RadioUI {
  /** deps = { onActive(bool): called when a station starts / fully stops (mute/restore the vinyl bus) } */
  constructor(deps = {}) {
    this.d = deps;
    this.servers = null;     // resolved lazily (discovery → fallbacks)
    this.session = null;
    this.station = null;
    this.loadedOnce = false;
    this.store = loadModel(this._storage());
    this._cannedIndex = null; // the stations index once the dial has loaded it (refreshes + missing-station checks)
    this._pill = h('div', { class: 'radio-pill hidden' },
      h('span', { class: 'radio-pill-dot' }), (this._pillName = h('span', { class: 'radio-pill-name' })),
      h('button', { class: 'radio-pill-stop', type: 'button', 'aria-label': 'Stop radio', onclick: () => this.stop() }, '■'));
    document.body.append(this._pill);
  }

  _storage() { try { return window.localStorage; } catch { return null; } }
  _commit(model) { this.store = model; saveModel(this._storage(), model); }

  mount(pane) {
    this.pane = pane;
    pane.classList.add('radio-pane');
    pane.dataset.mode = 'browse';
    this.tag = '';
    this._seq = 0;
    this.input = h('input', { class: 'mt-name radio-input', type: 'search', placeholder: 'Search stations', 'aria-label': 'Search internet radio stations', enterkeyhint: 'search', autocomplete: 'off' });
    this.clearBtn = h('button', { class: 'radio-clear hidden', type: 'button', 'aria-label': 'Clear search text', onclick: () => { this.input.value = ''; this._syncClear(); this.input.focus(); } }, '×');
    this.input.addEventListener('input', () => this._syncClear());
    this.status = h('div', { class: 'radio-status', role: 'status', 'aria-live': 'polite' });
    this.listEl = h('div', { class: 'radio-list' });
    this.dialEl = h('div', { class: 'radio-dial' });
    this.netHead = h('div', { class: 'radio-sec-head radio-net-head' }, h('span', {}, 'Internet radio'));
    this.savedEl = h('div', { class: 'radio-saved' });
    this.now = h('div', { class: 'radio-now hidden' });
    // Search results: the section that REPLACES the browse sections while a search is on (title, back control, then status + list).
    this.resTitle = h('div', { class: 'radio-res-title' });
    this.resHead = h('div', { class: 'radio-res-head' },
      h('button', { class: 'radio-back', type: 'button', onclick: () => this.exitSearch() }, h('span', { 'aria-hidden': 'true' }, '←'), ' All stations'), this.resTitle);
    const form = h('form', { class: 'radio-search', role: 'search', onsubmit: (e) => { e.preventDefault(); this.runSearch(); this.input.blur(); } },
      h('div', { class: 'radio-field' }, this.input, this.clearBtn), h('button', { class: 'lib-scan radio-go', type: 'submit', onmousedown: (e) => e.preventDefault(), onpointerdown: (e) => { if (e.pointerType !== 'mouse') e.preventDefault(); } }, 'Search'));   // keep the field focused: the keyboard closing under the tap used to swallow it
    this.chipEls = new Map();
    const mk = (label, tag) => { const b = h('button', { class: 'sort-chip', type: 'button', 'aria-pressed': 'false', onclick: () => this._pickTag(tag) }, label); this.chipEls.set(tag, b); return b; };
    const chips = h('div', { class: 'sort-chips radio-chips', role: 'group', 'aria-label': 'Genres' }, mk('Top', ''), ...GENRES.map((g) => mk(g, g)));
    this._paintChips();
    // You Radio (the radio.ai flag): a visible switch for the radio.ai flag (default OFF), the You Radio row when on, and the
    // card the offline host draws its captions and controls into.
    this.aiSec = h('div', { class: 'radio-ai-sec' });
    this._aiPanel = h('div', { class: 'ai-panel hidden' });
    const aiToggle = h('button', { type: 'button', class: 'st-switch', id: 'aiStationsToggle', role: 'switch', 'aria-describedby': 'aiStationsHelp', 'aria-checked': String(this._aiOn()) },
      h('span', { class: 'st-track' }),
      h('span', { class: 'st-grow' }, h('b', { class: 'st-label' }, 'You Radio: offline shows from your library'),
        h('span', { class: 'st-hint', id: 'aiStationsHelp' }, 'Off by default. Turn it on to add You Radio: your own songs with hosts talking in between. The talk is pre-written templates filled in with your song names, not generated by AI. It all runs on this phone, with no internet and no account.')));
    aiToggle.addEventListener('click', () => { const on = aiToggle.getAttribute('aria-checked') !== 'true'; aiToggle.setAttribute('aria-checked', String(on)); this._setAi(on); });
    this.settingsEl = h('div', { class: 'radio-sec radio-settings' },
      h('div', { class: 'radio-sec-head' }, h('span', {}, 'Settings')),
      h('div', { class: 'radio-setting' }, aiToggle));
    this.bar = h('div', { class: 'lib-toolbar radio-bar' }, form, chips);
    this.scroller = h('div', { class: 'lib-grid-wrap' }, this.bar, this.resHead, this.aiSec, this.savedEl, this.dialEl, this.netHead, this.status, this.listEl, this.settingsEl);
    // the now-playing card appears (and grows) a moment after a station starts: keep the station's card in view above it for those first seconds
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => { if (Date.now() < (this._revealUntil || 0)) this._revealCurrent(); }).observe(this.scroller);
    pane.append(this.scroller, this._aiPanel, this.now); // the card sits BEFORE the now-bar so CSS can hide the bar while the card is up (radio.css)
    // Retry when connectivity returns.
    window.addEventListener('online', () => { if (this._lastFailureOffline) this.search(this._lastParams || {}, this._lastOpts); });
    window.addEventListener('offline', () => { this.netHead.dataset.offline = '1'; });
  }

  _syncClear() { this.clearBtn.classList.toggle('hidden', !this.input.value); }
  _paintChips() { const typed = this.pane?.dataset.mode === 'results' && !!(this._lastParams && this._lastParams.name); for (const [tag, b] of this.chipEls) { const on = tag === this.tag && !(tag === '' && typed); b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on)); } }

  /** A genre chip: keeps whatever is typed (the directory takes name + tag together); tapping the selected one again deselects it. */
  _pickTag(tag) { this.tag = tag && this.tag === tag ? '' : tag; this._paintChips(); this.runSearch(); }

  /** The user's own search (Search button, Enter or a chip): switches the tab to a results view that comes first. */
  runSearch() {
    const name = this.input.value.trim();
    this._paintChips();
    this.search({ name, tag: this.tag }, { results: true });
  }

  /** Leave the results view: back to the full tab (shows, saved, the top list); the search box and genre reset. */
  exitSearch() {
    this.input.value = ''; this._syncClear(); this.tag = ''; this._paintChips();
    this._seq++;
    this.pane.dataset.mode = 'browse';
    this.search({}, { results: false });
    this.scroller.scrollTop = 0;
  }

  _resultsTitle(p) {
    const n = (p.name || '').trim(), t = p.tag || '';
    return n && t ? `“${n}” in ${t}` : n ? `Results for “${n}”` : t ? `Top ${t} stations` : 'Top stations';
  }

  /** Called when the Radio tab is shown: first visit loads the top stations. */
  activate() { this._renderSaved(); this._renderAi(); this._renderDial(); if (!this.loadedOnce) this.search({}, { results: false }); }

  /** The dial (pre-written shows, AI style cards): lazy-loaded the first time the Radio tab is shown. */
  _renderDial() {
    if (!this.dialEl) return;
    import('./radio/canned/dial.js').then((m) => m.renderDial(this.dialEl, {
      aiOn: () => this._aiOn(), isFav: (s) => isFavourite(this.store, s), toggleFav: (s) => this.toggleFav(s),
      play: (s) => this.toggle(s), isCurrent: (s) => this._isCurrent(s), isPlaying: () => !!this.session, storage: this._storage(),
      onIndex: (idx) => this._onIndex(idx), paintCard: (el) => this._paintPlayButton(el, this.station && el.dataset.k === stationKey(this.station) ? (this.session?.state?.phase || 'connecting') : ''),
    })).catch(() => { this.dialEl.replaceChildren(h('p', { class: 'radio-status err' }, 'The station list could not be loaded.')); });
  }

  /** The stations index loaded: refresh saved canned snapshots from it, and re-draw Resume / Favourites / Recents. */
  _onIndex(idx) {
    if (!Array.isArray(idx) || !idx.length) return;
    this._cannedIndex = idx;
    const m = refreshCannedSnapshots(this.store, idx);
    if (m !== this.store) this._commit(m);
    this._renderSaved();
  }

  _aiOn() { try { return isRadioAiEnabled(window.localStorage); } catch { return false; } }

  /** The settings toggle: flips the radio.ai flag and registers / removes the AI station types without a reload. */
  _setAi(on) {
    setRadioAiEnabled(this._storage(), on);
    if (on) registerAi();
    else { if (this.station && this.station.type.startsWith('ai-')) this.stop(); unregisterAiStationTypes(); }
    this._renderAi();
    this._renderDial();
  }

  _renderAi() {
    if (!this.aiSec) return;
    if (!this._aiOn()) { this.aiSec.replaceChildren(); return; }
    this.aiSec.replaceChildren(h('div', { class: 'radio-sec' },
      h('div', { class: 'radio-sec-head' }, h('span', {}, 'You Radio')),
      h('div', { class: 'radio-list' }, this._row(aiYouStation()))));
  }

  /** One station row: the whole row plays / stops it, and there is a visible, labelled Play / Stop button (>= 44 px) for it.
   *  Works for live results and stored snapshots alike. Station text is untrusted: text nodes only. */
  _row(s) {
    const fav = isFavourite(this.store, s);
    const star = h('button', { class: 'radio-star' + (fav ? ' on' : ''), type: 'button', 'aria-pressed': String(fav),
      'aria-label': (fav ? 'Remove ' : 'Add ') + s.name + (fav ? ' from favourites' : ' to favourites'),
      onclick: (e) => { e.stopPropagation(); this.toggleFav(s); } }, fav ? '★' : '☆');
    const go = h('button', { class: 'rr-play', type: 'button', 'data-name': s.name, onclick: (e) => { e.stopPropagation(); this.toggle(s); } });
    const meta = s.type === 'ai-you' ? 'Hosts chat between your own songs. Works offline.' : s.type === 'canned' ? 'Works offline' : describeStation({ country: '', codec: '', bitrate: 0, tags: [], ...s });
    const row = h('div', { class: 'radio-row', 'data-k': stationKey(s) || '', onclick: () => this.toggle(s) },
      h('div', { class: 'radio-row-main' },
        h('div', { class: 'rr-name' }, s.name),
        h('div', { class: 'rr-meta' }, meta),
        h('div', { class: 'rr-now', 'data-now': '' })),
      star, go);
    this._paintPlayButton(row, this._isCurrent(s) ? (this.session?.state?.phase || 'connecting') : '');
    return row;
  }

  /** Play / Stop wording + the "now playing" line on a row or dial card (phase '' = not the current station). */
  _paintPlayButton(el, phase) {
    const btn = el.querySelector('.rr-play, .dial-play[data-play]'); if (!btn) return;
    const name = btn.dataset.name || '';
    const on = !!phase && phase !== 'idle';
    const retry = phase === 'error';
    el.classList.toggle('on', on);
    btn.classList.toggle('stop', on && !retry);
    btn.textContent = retry ? '↻ Retry' : on ? '■ Stop' : '▶ Play';
    btn.setAttribute('aria-label', (retry ? 'Try again: ' : on ? 'Stop ' : 'Play ') + name + (btn.dataset.dial ? ', dial ' + btn.dataset.dial : ''));
    const now = el.querySelector('[data-now]');
    if (now) now.textContent = !on ? '' : { connecting: 'Connecting…', buffering: 'Buffering…', reconnecting: 'Reconnecting…', playing: 'Now playing', error: 'Could not play' }[phase] || 'Now playing';
    if (now) now.dataset.phase = phase || '';
  }

  /** Re-label every row / card for the current station + phase (called whenever either changes). */
  _syncPlayState(station, phase) {
    this.pane?.querySelectorAll('.radio-row[data-k], .dial-card[data-k][data-station]').forEach((r) => {
      this._paintPlayButton(r, station && r.dataset.k === stationKey(station) ? phase : '');
    });
  }

  /** The current station is under the now-playing card (it pushes the list up): keep it in view above the card. */
  _revealCurrent(first) {
    if (first) this._revealUntil = Date.now() + 3000;
    const el = this.pane?.querySelector('.radio-row.on, .dial-card.on'); if (!el || !this.scroller) return;
    setTimeout(() => { // the whole card if it fits above the now-playing card, else at least its Stop button
      try { (el.offsetHeight <= this.scroller.clientHeight - 8 ? el : (el.querySelector('.rr-play, .dial-play[data-play]') || el)).scrollIntoView({ block: 'nearest', behavior: 'auto' }); } catch { /* old webview */ }
    }, 80);
  }

  /** Play, or Stop when this is the station that is on. A session that is idle (a sign-off finished) or in error restarts instead. */
  toggle(station) {
    const ph = this.session && this.session.state ? this.session.state.phase : 'idle';
    if (this._isCurrent(station) && this.session && ph !== 'idle' && ph !== 'error') this.stop(); else this.play(station);
  }

  _missing(s) { return isMissingCanned(s, this._cannedIndex); }

  _removeSaved(s) { this._commit(removeEntry(this.store, stationKey(s))); this._renderSaved(); }

  /** A saved canned station whose pack is gone: say so, and offer Remove (never a play button that can only fail). */
  _missingRow(s) {
    return h('div', { class: 'radio-row missing', 'data-k': stationKey(s) || '' },
      h('div', { class: 'radio-row-main' }, h('div', { class: 'rr-name' }, s.name), h('div', { class: 'rr-meta' }, NO_LONGER)),
      h('button', { class: 'sort-chip radio-remove', type: 'button', 'aria-label': `Remove ${s.name}`, onclick: () => this._removeSaved(s) }, 'Remove'));
  }

  _isCurrent(s) { return !!this.station && stationKey(this.station) === stationKey(s); }

  toggleFav(s) {
    this._commit(toggleFavourite(this.store, s));
    this._renderSaved();
    this.listEl.querySelectorAll('.radio-row').forEach((r) => { // refresh result-list stars in place
      if (r.dataset.k === stationKey(s)) r.querySelector('.radio-star')?.replaceWith(this._row(s).querySelector('.radio-star'));
    });
    this.dialEl?.querySelectorAll('.dial-card').forEach((r) => { // and the dial cards' stars
      if (r.dataset.k === stationKey(s)) { const f = isFavourite(this.store, s); const b = r.querySelector('.dial-star'); if (b) { b.classList.toggle('on', f); b.textContent = f ? '★' : '☆'; b.setAttribute('aria-pressed', String(f)); } }
    });
    if (this.station) this._showNow(this.station, this.session?.state || { phase: 'idle', error: null });
  }

  /** Resume + Favourites + Recents, straight from stored snapshots (no network needed). */
  _renderSaved() {
    const m = this.store;
    const kids = [];
    if (m.last) {
      const last = stationFromEntry(m.last);
      const ph = this.session && this.session.state && this.session.state.phase;
      const onAir = !!(this.station && stationKey(this.station) === stationKey(last) && ph && ph !== 'idle' && ph !== 'error');   // "Resume X" while X plays is noise
      if (onAir) { /* nothing to resume */ }
      else if (this._missing(last)) kids.push(this._missingRow(last));
      else kids.push(h('button', { class: 'radio-resume', type: 'button', onclick: () => this.play(last) },
        h('span', { class: 'radio-resume-go' }, '▶'), h('span', { class: 'radio-resume-txt' }, 'Resume ', h('b', {}, last.name))));
    }
    const section = (title, entries, extra) => entries.length ? h('div', { class: 'radio-sec' },
      h('div', { class: 'radio-sec-head' }, h('span', {}, title), extra || null),
      h('div', { class: 'radio-list' }, entries.map((e) => { const s = stationFromEntry(e); return this._missing(s) ? this._missingRow(s) : this._row(s); }))) : null;
    kids.push(section('Favourites', m.favs));
    kids.push(section('Recents', m.recents.slice(0, 8), h('button', { class: 'sort-chip', type: 'button', onclick: () => { this._commit(clearRecents(this.store)); this._renderSaved(); } }, 'Clear')));
    this.savedEl.replaceChildren(...kids.filter(Boolean));
  }

  /** opts.results = the user's own search: the results come first and the other sections step aside. */
  async search(params, opts = {}) {
    this._lastParams = params; this._lastOpts = opts;
    this.loadedOnce = true;
    const seq = ++this._seq;
    const results = !!opts.results;
    this.pane.dataset.mode = results ? 'results' : 'browse';
    this._paintChips();
    if (results) { this.resTitle.textContent = this._resultsTitle(params); this.scroller.scrollTop = 0; }
    const busy = (text) => { this.status.className = 'radio-status busy'; this.status.replaceChildren(h('span', { class: 'radio-spin', 'aria-hidden': 'true' }), h('span', {}, text)); };
    busy(results ? `Searching for ${params.name ? '“' + params.name + '”' : 'stations'}…` : 'Loading top stations…');
    this.listEl.replaceChildren();
    // offline: do not even try the directory (no requests; the pre-written shows above still work)
    if (!this.servers && navigator.onLine !== false) this.servers = await discoverServers((u, o) => fetch(u, o));
    if (seq !== this._seq) return;
    const r = await searchStations((u, o) => fetch(u, o), this.servers || [], params, { isOnline: () => navigator.onLine !== false });
    if (seq !== this._seq) return; // a newer search (or Back) superseded this one
    this._lastFailureOffline = !r.ok && r.kind === 'offline';
    if (!r.ok) {
      this.status.className = 'radio-status err';
      this.status.replaceChildren(
        h('div', { class: 'radio-status-msg' }, r.kind === 'offline' ? 'You are offline. Internet radio needs a connection. The offline shows still work.' : 'Could not reach the station directory. Check your connection and try again.'),
        h('div', { class: 'radio-status-acts' }, h('button', { class: 'sort-chip', type: 'button', onclick: () => this.search(params, opts) }, 'Try again'),
          results ? h('button', { class: 'sort-chip', type: 'button', onclick: () => this.exitSearch() }, 'Back to all stations') : null));
      return;
    }
    if (!r.stations.length) {
      const what = params.name ? `“${params.name}”` : params.tag || 'that';
      this.status.className = 'radio-status empty';
      this.status.replaceChildren(h('b', {}, `No stations found for ${what}`), h('div', {}, 'Check the spelling, or try a genre or a shorter name.'),
        results ? h('div', { class: 'radio-status-acts' }, h('button', { class: 'sort-chip', type: 'button', onclick: () => this.exitSearch() }, 'Clear search')) : null);
      return;
    }
    this.status.className = 'radio-status';
    this.status.replaceChildren();
    if (results) this.resTitle.dataset.count = String(r.stations.length);
    for (const s of r.stations) this.listEl.append(this._row(s));
  }

  /** Offline shows and You Radio play the user's own songs between the talk: with none in the library there is nothing to start. */
  _needsSongs(s) { return !!s && (s.type === 'canned' || String(s.type || '').startsWith('ai-')) && !!this.d.libraryEmpty && this.d.libraryEmpty(); }

  /** Say so on the card (no session, no engine, no error state): a button to Albums, no Retry. */
  _showNeedsSongs(station) {
    this.now.className = 'radio-now info';
    this.now.replaceChildren(
      h('div', { class: 'radio-now-main' },
        h('div', { class: 'alb-name' }, station.name),
        h('div', { class: 'alb-artist' }, 'This show plays your own songs between the talk. Scan your music first, then tune in.')),
      this.d.openAlbums ? h('button', { class: 'sort-chip', type: 'button', onclick: () => { this._hideNeeds(); this.d.openAlbums(); } }, 'Open Albums') : null,
      h('button', { class: 'theme-btn', type: 'button', onclick: () => this._hideNeeds() }, 'Close'));
    this.pane?.toggleAttribute('data-playing', true);
  }
  _hideNeeds() { if (!this.session) { this.now.classList.add('hidden'); this.pane?.removeAttribute('data-playing'); } }

  play(station) {
    if (this._needsSongs(station)) { if (this.session) this.stop(); this._showNeedsSongs(station); return; }
    if (this._missing(station)) { // a renamed / removed pack: say what happened instead of a generic start failure
      if (this.session) this.stop();   // the card must not name a station that is not the one still playing underneath it
      this._showNow(station, { phase: 'error', error: { kind: 'missing', message: NO_LONGER } }); return;
    }
    try { this.d.onPlay?.(station); } catch { /* */ }   // the tap itself is the user's latest intent: a tape / album decode that began earlier is superseded, one that begins later wins
    const prevEngine = !!(this.session && this.session.usesEngine);
    this.session?.stop();
    const session = createSessionFor(station, { aiHost: this.d.aiHost });
    if (!session) { this._showNow(station, { phase: 'error', error: { message: 'No player is registered for this station type.' } }); return; }
    this.session = session; this.station = station;
    this._renderSaved();
    // A streamed station mutes the vinyl bus; an engine-backed one (You Radio) plays THROUGH the engine, so it must not.
    if (session.usesEngine) { if (this.d.onActive && !prevEngine && this._muted) { this.d.onActive(false); this._muted = false; } }
    else { this.d.onActive?.(true); this._muted = true; }
    if (session.attachPanel) session.attachPanel(this._aiPanel);
    session.onChange((st) => {
      if (this.session !== session) return;
      if (st.phase === 'playing' && !this._recorded) { this._recorded = true; // remember the URL that actually worked as the preferred one
        const urls = streamCandidates(station), i = session.urlIndex | 0;
        const worked = urls.length ? { ...station, streamUrl: urls[i], streamUrls: [urls[i], ...urls.filter((_, j) => j !== i)] } : station;
        this._commit(recordPlayed(this.store, worked, Date.now(), this._cannedIndex)); this._renderSaved(); }
      if (st.phase === 'idle' && session.isCanned && this._recorded && !this._stopping) { this.stop(); return; } // a graceful sign-off finished
      this._showNow(station, st);
      if (st.phase === 'idle' || st.phase === 'error') this._renderSaved();   // not on air any more: Resume may show again
    });
    this._recorded = false;
    this._showNow(station, { phase: 'connecting', error: null });
    session.start();
  }

  stop() {
    if (this._stopping) return;
    this._stopping = true;
    try { this._stop(); } finally { this._stopping = false; }
  }

  /** The user started their own record / tape on the shared engine: end an engine-backed station at once (no sign-off) and leave
   *  the deck, the next deck and the music bus alone. A streamed station has its own <audio> and keeps the existing mute logic. */
  foreignPlayback() {
    const s = this.session;
    if (!s || !s.usesEngine || this._stopping) return;
    this._stopping = true;
    try { this._stop(true); } finally { this._stopping = false; }
  }

  _stop(abandon = false) {
    const engineBacked = !!(this.session && this.session.usesEngine);
    if (abandon && typeof this.session?.abandon === 'function') this.session.abandon(); else this.session?.stop();
    this.session = null; this.station = null; this._shownKey = null;
    this.now.classList.add('hidden'); this._pill.classList.add('hidden');
    this._aiPanel?.classList.add('hidden');
    if (!engineBacked) { this.d.onActive?.(false); this._muted = false; }
    this._syncPlayState(null, '');
    this.pane?.removeAttribute('data-playing');
    if (this.savedEl) this._renderSaved();   // the Resume banner comes back for the show that just stopped
  }

  _showNow(station, st) {
    const label = { connecting: 'Connecting…', buffering: 'Buffering…', reconnecting: `Connection lost. Reconnecting (${st.attempt || 1}/${MAX_RECONNECTS})…`, playing: (station.tags || []).includes('canned') ? 'On air' : (station.tags || []).includes('ai') ? 'On air' : 'Live', error: 'Error', idle: '' }[st.phase] || '';
    this.now.className = 'radio-now ' + st.phase + (st.error && st.error.kind === 'empty_library' ? ' info' : '');
    this.now.replaceChildren(...[
      h('div', { class: 'radio-now-main' },
        h('div', { class: 'alb-name' }, station.name),
        h('div', { class: 'alb-artist' }, st.phase === 'error' ? st.error.message : label)),
      (() => { const f = isFavourite(this.store, station);
        return h('button', { class: 'radio-star' + (f ? ' on' : ''), type: 'button', 'aria-pressed': String(f), 'aria-label': f ? 'Remove from favourites' : 'Add to favourites', onclick: () => this.toggleFav(station) }, f ? '★' : '☆'); })(),
      st.phase === 'error' && st.error.kind === 'missing' ? h('button', { class: 'sort-chip', type: 'button', onclick: () => { this._removeSaved(station); this.stop(); } }, 'Remove')
        : st.phase === 'error' && st.error.kind === 'empty_library' ? (this.d.openAlbums ? h('button', { class: 'sort-chip', type: 'button', onclick: () => { this.stop(); this.d.openAlbums(); } }, 'Open Albums') : null)   // retrying cannot help: there are no songs
        : st.phase === 'error' ? h('button', { class: 'sort-chip', type: 'button', onclick: () => this.play(station) }, 'Retry') : null,
      h('button', { class: 'theme-btn', type: 'button', onclick: () => this.stop() }, 'Stop'),
    ].filter(Boolean));
    this._pillName.textContent = station.name;
    this._pill.className = 'radio-pill ' + st.phase;
    const was = this._shownKey; this._shownKey = stationKey(station);
    this._syncPlayState(station, st.phase);
    this.pane.toggleAttribute('data-playing', true);
    if (was !== this._shownKey) this._revealCurrent(true);
  }
}

export { listStationTypes };
