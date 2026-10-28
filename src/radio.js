// ─────────────────────────────────────────────────────────────────────────────
// radio.js — pure Radio Browser (https://www.radio-browser.info) client logic.
//
// Real, free, public stations only. No DOM, no browser globals: the network
// call takes an injected `fetchImpl` so server-fallback behaviour is tested
// with fakes (test/radio.test.mjs, fixtures in test/fixtures/). Playback lives
// in radio-player.js; the station-type seam (where AI / "You" / "You City"
// stations will plug in later) is stations.js.
//
// Radio Browser is a community directory: any of several mirrors may be down,
// so we (1) ask the DNS-ish list endpoint for the current servers, (2) fall
// back to a hard-coded list, and (3) try them in order until one answers.
// ─────────────────────────────────────────────────────────────────────────────

export const DISCOVERY_URL = 'https://all.api.radio-browser.info/json/servers';

/** Primary first (de1 per project decision), then known mirrors. */
export const FALLBACK_SERVERS = Object.freeze([
  'de1.api.radio-browser.info',
  'de2.api.radio-browser.info',
  'fi1.api.radio-browser.info',
  'nl1.api.radio-browser.info',
  'at1.api.radio-browser.info',
]);

const HOST_RE = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)*\.radio-browser\.info$/i;

/** Discovery JSON ([{ip,name}...]) -> unique, validated hostnames (input order). */
export function parseServerList(json) {
  if (!Array.isArray(json)) return [];
  const seen = new Set();
  const out = [];
  for (const e of json) {
    const n = e && typeof e.name === 'string' ? e.name.trim().toLowerCase() : '';
    if (HOST_RE.test(n) && !seen.has(n)) { seen.add(n); out.push(n); }
  }
  return out;
}

/**
 * Try order: discovered servers (shuffled with the injected rand01 so load
 * spreads), then any fallback not already listed. Always non-empty.
 */
export function buildServerList(discovered = [], rand01 = Math.random) {
  const d = [...new Set(discovered)];
  for (let i = d.length - 1; i > 0; i--) { // Fisher-Yates
    const j = Math.floor(rand01() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return [...d, ...FALLBACK_SERVERS.filter((s) => !d.includes(s))];
}

/**
 * Search URL for one server. params: { name, tag, countrycode, limit, offset }.
 * Always asks for hidebroken + order=votes so the top of the list is the
 * stations people actually keep working.
 */
export function buildSearchUrl(server, params = {}) {
  const q = new URLSearchParams();
  if (params.name && params.name.trim()) q.set('name', params.name.trim());
  if (params.tag && params.tag.trim()) q.set('tag', params.tag.trim());
  if (params.countrycode && /^[a-z]{2}$/i.test(params.countrycode)) q.set('countrycode', params.countrycode.toUpperCase());
  q.set('limit', String(Math.max(1, Math.min(100, params.limit || 30))));
  if (params.offset > 0) q.set('offset', String(params.offset | 0));
  q.set('hidebroken', 'true');
  q.set('order', 'votes');
  q.set('reverse', 'true');
  return `https://${server}/json/stations/search?${q.toString()}`;
}

const isHttp = (u) => typeof u === 'string' && /^https?:\/\//i.test(u);

/**
 * Raw API JSON -> clean stations. Drops: non-objects, no id/name/URL, stations
 * the directory itself marked as failing its last check (lastcheckok 0), HLS
 * (.m3u8) streams (<audio> can't play them on Chromium/Android WebView), and —
 * by default — plain-http streams (a Capacitor https origin blocks them as
 * mixed content). Dedupes by (name, url). Sorted by votes, stable.
 * Returns { stations, skipped }.
 */
export function parseStations(json, { httpsOnly = true, allowHls = false } = {}) {
  if (!Array.isArray(json)) return { stations: [], skipped: 0 };
  const seen = new Set();
  const stations = [];
  let skipped = 0;
  json.forEach((r, order) => {
    const url = r && (isHttp(r.url_resolved) ? r.url_resolved : isHttp(r.url) ? r.url : '');
    const name = r && typeof r.name === 'string' ? r.name.replace(/\s+/g, ' ').trim() : '';
    const id = r && typeof r.stationuuid === 'string' ? r.stationuuid : '';
    const bad = !url || !name || !id
      || r.lastcheckok === 0 || r.lastcheckok === false
      || (!allowHls && (r.hls === 1 || r.hls === true || /\.m3u8(\?|$)/i.test(url)))
      || (httpsOnly && !/^https:/i.test(url));
    if (bad) { skipped++; return; }
    const dedupe = `${name.toLowerCase()}\0${url}`;
    if (seen.has(dedupe)) { skipped++; return; }
    seen.add(dedupe);
    const tags = typeof r.tags === 'string' ? r.tags.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 5) : [];
    const codec = typeof r.codec === 'string' ? r.codec.toUpperCase() : '';
    const bitrate = Number(r.bitrate) > 0 ? Number(r.bitrate) : 0;
    stations.push({
      type: 'radio-browser',
      id: `rb:${id}`,
      name,
      streamUrl: url,
      country: typeof r.country === 'string' ? r.country : '',
      tags,
      codec, bitrate,
      votes: Number(r.votes) > 0 ? Number(r.votes) : 0,
      homepage: isHttp(r.homepage) ? r.homepage : '',
      favicon: isHttp(r.favicon) ? r.favicon : '',
      _order: order,
    });
  });
  stations.sort((a, b) => b.votes - a.votes || a._order - b._order);
  for (const s of stations) delete s._order;
  return { stations, skipped };
}

/** One-line secondary text for a list row: "Germany · MP3 128k · jazz, lounge". */
export function describeStation(s) {
  const q = s.codec ? `${s.codec}${s.bitrate ? ' ' + s.bitrate + 'k' : ''}` : (s.bitrate ? s.bitrate + 'k' : '');
  return [s.country, q, s.tags.slice(0, 2).join(', ')].filter(Boolean).join(' · ');
}

// ── Network with server fallback (fetchImpl injected → testable) ─────────────

/**
 * Query servers in order until one returns a JSON array. Per-server timeout.
 * Result: { ok:true, stations, skipped, server } or
 *         { ok:false, kind:'offline'|'unreachable', error, tried:[...] }.
 * `kind` is 'offline' when `isOnline()` is false (don't blame the directory).
 */
export async function searchStations(fetchImpl, servers, params, opts = {}) {
  const { timeoutMs = 6000, isOnline = () => true, parse = {} } = opts;
  if (!isOnline()) return { ok: false, kind: 'offline', error: 'You appear to be offline.', tried: [] };
  const tried = [];
  for (const server of servers) {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
    try {
      const res = await fetchImpl(buildSearchUrl(server, params), { signal: ctl?.signal, headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (!Array.isArray(json)) throw new Error('Unexpected response shape');
      return { ok: true, ...parseStations(json, parse), server };
    } catch (e) {
      tried.push(`${server}: ${e && e.name === 'AbortError' ? 'timed out' : (e && e.message) || 'failed'}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return {
    ok: false,
    kind: isOnline() ? 'unreachable' : 'offline',
    error: 'The station directory is not reachable right now.',
    tried,
  };
}

/** Discovery with graceful degrade: any failure -> fallback list only. */
export async function discoverServers(fetchImpl, { timeoutMs = 4000, rand01 = Math.random } = {}) {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  try {
    const res = await fetchImpl(DISCOVERY_URL, { signal: ctl?.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return buildServerList(parseServerList(await res.json()), rand01);
  } catch {
    return buildServerList([], rand01);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── Playback failure classification ──────────────────────────────────────────
// HTMLMediaElement error codes: 1 aborted, 2 network, 3 decode, 4 src not supported.

/**
 * What went wrong, in words a listener can act on.
 *   input = { online:boolean, mediaErrorCode?:number, timedOut?:boolean }
 * -> { kind: 'offline'|'timeout'|'dead'|'unsupported'|'decode'|'unknown', message }
 */
export function classifyPlaybackFailure({ online = true, mediaErrorCode = 0, timedOut = false } = {}) {
  if (!online) return { kind: 'offline', message: 'You are offline. Reconnect and try again.' };
  if (timedOut) return { kind: 'timeout', message: 'The station took too long to respond.' };
  switch (mediaErrorCode) {
    case 2: return { kind: 'dead', message: 'The stream dropped or is unreachable. The station may be down.' };
    case 3: return { kind: 'decode', message: 'The stream could not be decoded.' };
    case 4: return { kind: 'unsupported', message: 'This stream is dead or in a format this device cannot play.' };
    default: return { kind: 'unknown', message: 'Could not play this station.' };
  }
}

/** Playback-session reducer (pure). state = { phase, error }. */
export function reduceSession(state, event) {
  switch (event.type) {
    case 'play': return { phase: 'connecting', error: null };
    case 'playing': return state.phase === 'connecting' || state.phase === 'buffering' ? { phase: 'playing', error: null } : state;
    case 'buffering': return state.phase === 'playing' ? { phase: 'buffering', error: null } : state;
    case 'error': return { phase: 'error', error: event.failure };
    case 'stop': return { phase: 'idle', error: null };
    default: return state;
  }
}
