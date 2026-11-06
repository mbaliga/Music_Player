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
import { registerStationType, registerAiStationTypes, unregisterAiStationTypes, createSessionFor, listStationTypes, aiYouStation } from './stations.js';
import { createStreamSession } from './radio-session.js';
import { isRadioAiEnabled, setRadioAiEnabled } from './radio/flag.js';
import {
  loadModel, saveModel, stationKey, stationFromEntry, isFavourite, toggleFavourite, recordPlayed, clearRecents,
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

const AI_CSS = `.radio-setting{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border-radius:10px;background:var(--surface);border:1px solid var(--border);cursor:pointer;font-size:14px}
.radio-setting small{display:block;color:var(--ink2);font-size:12px;margin-top:2px;line-height:1.35}
.radio-setting input{margin-top:3px;width:18px;height:18px;flex:0 0 auto}
.radio-ai-sec{margin-bottom:12px}
.ai-panel.hidden{display:none}
.radio-now.info .alb-artist{color:var(--ink2);white-space:normal}`;

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
    this._pill = h('div', { class: 'radio-pill hidden' },
      h('span', { class: 'radio-pill-dot' }), (this._pillName = h('span', { class: 'radio-pill-name' })),
      h('button', { class: 'radio-pill-stop', type: 'button', 'aria-label': 'Stop radio', onclick: () => this.stop() }, '■'));
    document.body.append(this._pill);
  }

  _storage() { try { return window.localStorage; } catch { return null; } }
  _commit(model) { this.store = model; saveModel(this._storage(), model); }

  mount(pane) {
    this.pane = pane;
    this.input = h('input', { class: 'mt-name', type: 'search', placeholder: 'Search stations…', 'aria-label': 'Search radio stations' });
    this.status = h('div', { class: 'radio-status' });
    this.listEl = h('div', { class: 'radio-list' });
    this.savedEl = h('div', { class: 'radio-saved' });
    this.now = h('div', { class: 'radio-now hidden' });
    const form = h('form', { class: 'radio-search', onsubmit: (e) => { e.preventDefault(); this.search({ name: this.input.value }); } },
      this.input, h('button', { class: 'lib-scan', type: 'submit' }, 'Search'));
    const chips = h('div', { class: 'sort-chips radio-chips' },
      h('button', { class: 'sort-chip', type: 'button', onclick: () => { this.input.value = ''; this.search({}); } }, 'Top'),
      ...GENRES.map((g) => h('button', { class: 'sort-chip', type: 'button', onclick: () => { this.input.value = ''; this.search({ tag: g }); } }, g)));
    // AI stations (experimental): a visible toggle for the radio.ai flag (default OFF), the You Radio row when on, and the
    // card the offline host draws its captions and controls into.
    this.aiSec = h('div', { class: 'radio-ai-sec' });
    this._aiPanel = h('div', { class: 'ai-panel hidden' });
    const aiToggle = h('input', { type: 'checkbox', id: 'aiStationsToggle', 'aria-describedby': 'aiStationsHelp' });
    aiToggle.checked = this._aiOn();
    aiToggle.addEventListener('change', () => this._setAi(aiToggle.checked));
    this.settingsEl = h('div', { class: 'radio-sec' },
      h('div', { class: 'radio-sec-head' }, h('span', {}, 'Settings')),
      h('label', { class: 'radio-setting' }, aiToggle,
        h('span', {}, h('b', {}, 'AI stations (experimental)'),
          h('small', { id: 'aiStationsHelp' }, 'Adds You Radio: automated hosts who talk between your own songs, with lines written and spoken on this phone. Needs no network and no account. Off by default.'))));
    const css = document.createElement('style'); css.textContent = AI_CSS; document.head.append(css);
    pane.append(h('div', { class: 'lib-toolbar radio-bar' }, form, chips),
      h('div', { class: 'lib-grid-wrap' }, this.aiSec, this.savedEl, this.status, this.listEl, this.settingsEl),
      this.now, this._aiPanel);
    // Retry when connectivity returns.
    window.addEventListener('online', () => { if (this._lastFailureOffline) this.search(this._lastParams || {}); });
  }

  /** Called when the Radio tab is shown: first visit loads the top stations. */
  activate() { this._renderSaved(); this._renderAi(); if (!this.loadedOnce) this.search({}); }

  _aiOn() { try { return isRadioAiEnabled(window.localStorage); } catch { return false; } }

  /** The settings toggle: flips the radio.ai flag and registers / removes the AI station types without a reload. */
  _setAi(on) {
    setRadioAiEnabled(this._storage(), on);
    if (on) registerAi();
    else { if (this.station && this.station.type.startsWith('ai-')) this.stop(); unregisterAiStationTypes(); }
    this._renderAi();
  }

  _renderAi() {
    if (!this.aiSec) return;
    if (!this._aiOn()) { this.aiSec.replaceChildren(); return; }
    this.aiSec.replaceChildren(h('div', { class: 'radio-sec' },
      h('div', { class: 'radio-sec-head' }, h('span', {}, 'AI stations')),
      h('div', { class: 'radio-list' }, this._row(aiYouStation()))));
  }

  /** One list row: tap to play, star to favourite. Works for live results and stored snapshots alike. */
  _row(s) {
    const fav = isFavourite(this.store, s);
    const star = h('button', { class: 'radio-star' + (fav ? ' on' : ''), type: 'button', 'aria-pressed': String(fav),
      'aria-label': (fav ? 'Remove ' : 'Add ') + s.name + (fav ? ' from favourites' : ' to favourites'),
      onclick: (e) => { e.stopPropagation(); this.toggleFav(s); } }, fav ? '★' : '☆');
    return h('div', { class: 'radio-row' + (this._isCurrent(s) ? ' on' : ''), 'data-k': stationKey(s) || '', onclick: () => this.play(s) },
      h('div', { class: 'radio-row-main' },
        h('div', { class: 'alb-name' }, s.name),
        h('div', { class: 'alb-artist' }, s.type === 'ai-you' ? 'Your own songs, with automated hosts · works offline' : describeStation({ country: '', codec: '', bitrate: 0, tags: [], ...s }))),
      star, h('span', { class: 'radio-row-go' }, '▶'));
  }

  _isCurrent(s) { return !!this.station && stationKey(this.station) === stationKey(s); }

  toggleFav(s) {
    this._commit(toggleFavourite(this.store, s));
    this._renderSaved();
    this.listEl.querySelectorAll('.radio-row').forEach((r) => { // refresh result-list stars in place
      if (r.dataset.k === stationKey(s)) r.querySelector('.radio-star')?.replaceWith(this._row(s).querySelector('.radio-star'));
    });
    if (this.station) this._showNow(this.station, this.session?.state || { phase: 'idle', error: null });
  }

  /** Resume + Favourites + Recents, straight from stored snapshots (no network needed). */
  _renderSaved() {
    const m = this.store;
    const kids = [];
    if (m.last) {
      const last = stationFromEntry(m.last);
      kids.push(h('button', { class: 'radio-resume', type: 'button', onclick: () => this.play(last) },
        h('span', { class: 'radio-resume-go' }, '▶'), h('span', { class: 'radio-resume-txt' }, 'Resume ', h('b', {}, last.name))));
    }
    const section = (title, entries, extra) => entries.length ? h('div', { class: 'radio-sec' },
      h('div', { class: 'radio-sec-head' }, h('span', {}, title), extra || null),
      h('div', { class: 'radio-list' }, entries.map((e) => this._row(stationFromEntry(e))))) : null;
    kids.push(section('Favourites', m.favs));
    kids.push(section('Recents', m.recents.slice(0, 8), h('button', { class: 'sort-chip', type: 'button', onclick: () => { this._commit(clearRecents(this.store)); this._renderSaved(); } }, 'Clear')));
    this.savedEl.replaceChildren(...kids.filter(Boolean));
  }

  async search(params) {
    this._lastParams = params;
    this.loadedOnce = true;
    this.status.className = 'radio-status';
    this.status.textContent = 'Searching…';
    this.listEl.replaceChildren();
    if (!this.servers) this.servers = await discoverServers((u, o) => fetch(u, o));
    const r = await searchStations((u, o) => fetch(u, o), this.servers, params, { isOnline: () => navigator.onLine !== false });
    this._lastFailureOffline = !r.ok && r.kind === 'offline';
    if (!r.ok) {
      this.status.className = 'radio-status err';
      this.status.replaceChildren(
        r.kind === 'offline' ? 'You are offline. Radio needs a connection.' : 'Could not reach the station directory.',
        ' ', h('button', { class: 'sort-chip', type: 'button', onclick: () => this.search(params) }, 'Retry'));
      return;
    }
    this.status.textContent = r.stations.length ? '' : 'No stations found. Try another search.';
    for (const s of r.stations) this.listEl.append(this._row(s));
  }

  play(station) {
    const prevEngine = !!(this.session && this.session.usesEngine);
    this.session?.stop();
    const session = createSessionFor(station, { aiHost: this.d.aiHost });
    if (!session) { this._showNow(station, { phase: 'error', error: { message: 'No player is registered for this station type.' } }); return; }
    this.session = session; this.station = station;
    // A streamed station mutes the vinyl bus; an engine-backed one (You Radio) plays THROUGH the engine, so it must not.
    if (session.usesEngine) { if (this.d.onActive && !prevEngine && this._muted) { this.d.onActive(false); this._muted = false; } }
    else { this.d.onActive?.(true); this._muted = true; }
    if (session.attachPanel) session.attachPanel(this._aiPanel);
    session.onChange((st) => {
      if (this.session !== session) return;
      if (st.phase === 'playing' && !this._recorded) { this._recorded = true; // remember the URL that actually worked as the preferred one
        const urls = streamCandidates(station), i = session.urlIndex | 0;
        const worked = urls.length ? { ...station, streamUrl: urls[i], streamUrls: [urls[i], ...urls.filter((_, j) => j !== i)] } : station;
        this._commit(recordPlayed(this.store, worked)); this._renderSaved(); }
      this._showNow(station, st);
    });
    this._recorded = false;
    this._showNow(station, { phase: 'connecting', error: null });
    session.start();
  }

  stop() {
    const engineBacked = !!(this.session && this.session.usesEngine);
    this.session?.stop();
    this.session = null; this.station = null;
    this.now.classList.add('hidden'); this._pill.classList.add('hidden');
    this._aiPanel?.classList.add('hidden');
    if (!engineBacked) { this.d.onActive?.(false); this._muted = false; }
    this.pane?.querySelectorAll('.radio-row.on').forEach((r) => r.classList.remove('on'));
  }

  _showNow(station, st) {
    const label = { connecting: 'Connecting…', buffering: 'Buffering…', reconnecting: `Connection lost. Reconnecting (${st.attempt || 1}/${MAX_RECONNECTS})…`, playing: (station.tags || []).includes('ai') ? 'On air' : 'Live', error: 'Error', idle: '' }[st.phase] || '';
    this.now.className = 'radio-now ' + st.phase + (st.error && st.error.kind === 'empty_library' ? ' info' : '');
    this.now.replaceChildren(...[
      h('div', { class: 'radio-now-main' },
        h('div', { class: 'alb-name' }, station.name),
        h('div', { class: 'alb-artist' }, st.phase === 'error' ? st.error.message : label)),
      (() => { const f = isFavourite(this.store, station);
        return h('button', { class: 'radio-star' + (f ? ' on' : ''), type: 'button', 'aria-pressed': String(f), 'aria-label': f ? 'Remove from favourites' : 'Add to favourites', onclick: () => this.toggleFav(station) }, f ? '★' : '☆'); })(),
      st.phase === 'error' ? h('button', { class: 'sort-chip', type: 'button', onclick: () => this.play(station) }, 'Retry') : null,
      h('button', { class: 'theme-btn', type: 'button', onclick: () => this.stop() }, 'Stop'),
    ].filter(Boolean));
    this._pillName.textContent = station.name;
    this._pill.className = 'radio-pill ' + st.phase;
    this.pane?.querySelectorAll('.radio-row').forEach((r) => r.classList.toggle('on', r.dataset.k === stationKey(station)));
  }
}

export { listStationTypes };
