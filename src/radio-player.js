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

import {
  discoverServers, searchStations, describeStation, classifyPlaybackFailure, reduceSession,
} from './radio.js';
import { registerStationType, createSessionFor, listStationTypes } from './stations.js';

const CONNECT_TIMEOUT_MS = 12000;

// ── StationType 'radio-browser': a Session is an <audio> element on a URL ────
registerStationType({
  id: 'radio-browser',
  label: 'Radio stations',
  createSession(station, env = {}) {
    const audio = env.audioElement || new Audio();
    const isOnline = env.isOnline || (() => navigator.onLine !== false);
    let state = { phase: 'idle', error: null };
    let cb = () => {};
    let timer = null;
    let gen = 0; // ignore events from a superseded start()/stop()

    const dispatch = (event) => { state = reduceSession(state, event); cb(state); };
    const fail = (info) => { clearTimeout(timer); dispatch({ type: 'error', failure: classifyPlaybackFailure({ online: isOnline(), ...info }) }); };

    const on = (name, fn) => audio.addEventListener(name, fn);
    on('playing', () => { clearTimeout(timer); dispatch({ type: 'playing' }); });
    on('waiting', () => dispatch({ type: 'buffering' }));
    on('stalled', () => dispatch({ type: 'buffering' }));
    on('error', () => { if (state.phase !== 'idle') fail({ mediaErrorCode: audio.error ? audio.error.code : 0 }); });
    on('ended', () => { if (state.phase !== 'idle') fail({ mediaErrorCode: 2 }); }); // a live stream should never end

    return {
      onChange(fn) { cb = fn; },
      get state() { return state; },
      async start() {
        const my = ++gen;
        dispatch({ type: 'play' });
        if (!isOnline()) return fail({});
        clearTimeout(timer);
        timer = setTimeout(() => { if (my === gen && state.phase === 'connecting') { try { audio.pause(); } catch {} fail({ timedOut: true }); } }, CONNECT_TIMEOUT_MS);
        audio.src = station.streamUrl;
        try { await audio.play(); }
        catch (e) {
          if (my !== gen || (e && e.name === 'AbortError')) return; // superseded / interrupted by stop()
          if (e && e.name === 'NotAllowedError') return fail({}); // autoplay policy: needs a tap
          if (state.phase === 'connecting') fail({ mediaErrorCode: audio.error ? audio.error.code : 4 });
        }
      },
      stop() {
        gen++; clearTimeout(timer);
        try { audio.pause(); audio.removeAttribute('src'); audio.load(); } catch {}
        dispatch({ type: 'stop' });
      },
    };
  },
});

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
    this._pill = h('div', { class: 'radio-pill hidden' },
      h('span', { class: 'radio-pill-dot' }), (this._pillName = h('span', { class: 'radio-pill-name' })),
      h('button', { class: 'radio-pill-stop', type: 'button', 'aria-label': 'Stop radio', onclick: () => this.stop() }, '■'));
    document.body.append(this._pill);
  }

  mount(pane) {
    this.input = h('input', { class: 'mt-name', type: 'search', placeholder: 'Search stations…', 'aria-label': 'Search radio stations' });
    this.status = h('div', { class: 'radio-status' });
    this.listEl = h('div', { class: 'radio-list' });
    this.now = h('div', { class: 'radio-now hidden' });
    const form = h('form', { class: 'radio-search', onsubmit: (e) => { e.preventDefault(); this.search({ name: this.input.value }); } },
      this.input, h('button', { class: 'lib-scan', type: 'submit' }, 'Search'));
    const chips = h('div', { class: 'sort-chips radio-chips' },
      h('button', { class: 'sort-chip', type: 'button', onclick: () => { this.input.value = ''; this.search({}); } }, 'Top'),
      ...GENRES.map((g) => h('button', { class: 'sort-chip', type: 'button', onclick: () => { this.input.value = ''; this.search({ tag: g }); } }, g)));
    pane.append(h('div', { class: 'lib-toolbar radio-bar' }, form, chips),
      h('div', { class: 'lib-grid-wrap' }, this.status, this.listEl),
      this.now);
    // Retry when connectivity returns.
    window.addEventListener('online', () => { if (this._lastFailureOffline) this.search(this._lastParams || {}); });
  }

  /** Called when the Radio tab is shown: first visit loads the top stations. */
  activate() { if (!this.loadedOnce) this.search({}); }

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
    for (const s of r.stations) {
      this.listEl.append(h('div', { class: 'radio-row' + (this.station && this.station.id === s.id ? ' on' : ''), onclick: () => this.play(s) },
        h('div', { class: 'radio-row-main' },
          h('div', { class: 'alb-name' }, s.name),
          h('div', { class: 'alb-artist' }, describeStation(s))),
        h('span', { class: 'radio-row-go' }, '▶')));
    }
  }

  play(station) {
    this.session?.stop();
    const session = createSessionFor(station, {});
    if (!session) { this._showNow(station, { phase: 'error', error: { message: 'No player is registered for this station type.' } }); return; }
    this.session = session; this.station = station;
    this.d.onActive?.(true);
    session.onChange((st) => this._showNow(station, st));
    this._showNow(station, { phase: 'connecting', error: null });
    session.start();
  }

  stop() {
    this.session?.stop();
    this.session = null; this.station = null;
    this.now.classList.add('hidden'); this._pill.classList.add('hidden');
    this.d.onActive?.(false);
    this.listEl.querySelectorAll('.radio-row.on').forEach((r) => r.classList.remove('on'));
  }

  _showNow(station, st) {
    const label = { connecting: 'Connecting…', buffering: 'Buffering…', playing: 'Live', error: 'Error', idle: '' }[st.phase] || '';
    this.now.className = 'radio-now ' + st.phase;
    this.now.replaceChildren(...[
      h('div', { class: 'radio-now-main' },
        h('div', { class: 'alb-name' }, station.name),
        h('div', { class: 'alb-artist' }, st.phase === 'error' ? st.error.message : label)),
      st.phase === 'error' ? h('button', { class: 'sort-chip', type: 'button', onclick: () => this.play(station) }, 'Retry') : null,
      h('button', { class: 'theme-btn', type: 'button', onclick: () => this.stop() }, 'Stop'),
    ].filter(Boolean));
    this._pillName.textContent = station.name;
    this._pill.className = 'radio-pill ' + st.phase;
    this.listEl.querySelectorAll('.radio-row').forEach((r, i) => r.classList.toggle('on', r.querySelector('.alb-name')?.textContent === station.name));
  }
}

export { listStationTypes };
