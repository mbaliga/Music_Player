// ─────────────────────────────────────────────────────────────────────────────
// context.js — the OFFLINE ContextProvider: a valid ContextSnapshot from device-only facts.
//
// Implements the core's ContextProvider seam (`getSnapshot({nowMs}) -> ContextSnapshot`, see
// fake-adapters.js FakeContext) with no network and no permission prompts:
//   • time: local time zone, date, weekday, daypart, season (needs a hemisphere), a few fixed holidays
//   • sun:  sunrise / sunset from a pure formula — ONLY if the owner typed a city-level lat/lon
//           (never auto-requested here; without it there is simply no sun fact)
//   • library: counts, newest album (by file date), longest track, top genre / artist — the owner's OWN metadata
//   • listening: first-time flag, total plays, most-played track — from the local play history
//   • weather / traffic / place: serviceStatus 'down' (the schema's states are ok|stale|down|denied; there is no
//     'unavailable'), so the grounding verifier forbids any weather or traffic talk
// Every fact carries id/kind/value/say/asOf/ttlSec/source/mentionable, like a cloud fact would.
// ─────────────────────────────────────────────────────────────────────────────

import { validateContextSnapshot } from '../core/schemas.js';
import { hashSeed } from '../core/util.js';
import { cleanTitle, cleanArtist, cleanAlbum } from './pronounce.js';
import { sunTimes, season, clockText } from './sun.js';
import { holidayOn } from './holidays.js';
import { mostPlayed, playCount, lastPlayedAgoSec, totalPlays } from './play-history.js';

export const STATION_NAME = 'You Radio';
export const HOSTS = Object.freeze({ a: 'Casey', b: 'Jo' });
export const DEFAULT_PERSONA = Object.freeze({
  stationName: STATION_NAME, rjName: `${HOSTS.a} and ${HOSTS.b}`, voiceId: 'system-default',
  tone: { warmth: 0.7, wit: 0.6, formality: 0.2 }, banned: [],
});

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_MS = 86400000;
const pad = (n) => String(n).padStart(2, '0');

/** early_morning 04-06, morning 07-10, midday 11-13, afternoon 14-17, evening 18-21, late_night 22-03 (local hour). */
export function daypartFor(hour) {
  const h = ((Math.floor(hour) % 24) + 24) % 24;
  if (h >= 4 && h < 7) return 'early_morning';
  if (h >= 7 && h < 11) return 'morning';
  if (h >= 11 && h < 14) return 'midday';
  if (h >= 14 && h < 18) return 'afternoon';
  if (h >= 18 && h < 22) return 'evening';
  return 'late_night';
}

/** Calendar parts of an instant in a zone given by utcOffsetMin (east positive). */
export function localParts(nowMs, utcOffsetMin = 0) {
  const d = new Date(nowMs + utcOffsetMin * 60000);
  return {
    year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(), weekdayIndex: d.getUTCDay(), weekday: WEEKDAYS[d.getUTCDay()],
    secondsToMidnight: Math.max(60, 86400 - (d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds())),
  };
}

export function localISO(nowMs, utcOffsetMin = 0) {
  const p = localParts(nowMs, utcOffsetMin);
  const a = Math.abs(utcOffsetMin);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${utcOffsetMin < 0 ? '-' : '+'}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

/** Rough energy 0..1 from genre words; null when the genre says nothing. Used only to shape the show's arc. */
export function energyFromGenre(genre) {
  const g = String(genre || '').toLowerCase();
  if (!g) return null;
  if (/ambient|classical|sleep|lullaby|new age|chill|downtempo|meditat|piano|acoustic|folk|bossa|lounge/.test(g)) return 0.25;
  if (/metal|punk|hardcore|dance|techno|house|drum|dnb|edm|hip.?hop|rap|trap|rock|electro|disco|funk/.test(g)) return 0.8;
  if (/jazz|soul|blues|r&b|indie|pop|country|reggae|world|latin|singer/.test(g)) return 0.5;
  return null;
}

const cleanGenre = (g) => { const s = String(g || '').replace(/[\u0000-\u001f<>{}|\\]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase(); return /^[a-z][a-z &'/-]{1,28}$/.test(s) && !/^(other|unknown|misc|genre|none|blues\/r&b)$/.test(s) ? s : null; };

/** Facts about one track for a break (roles: next, prev). Names are cleaned for air; raw forms stay out of the value. */
export function makeTrackFact(role, track, asOfIso, { energy = null } = {}) {
  const title = cleanTitle(track && track.title), artist = cleanArtist(track && track.artist), album = cleanAlbum(track && track.album);
  const say = title ? (artist ? `${title} by ${artist}` : title) : (artist ? `a track by ${artist}` : 'the next track');
  return {
    id: `trk.${role}`, kind: 'library', value: { title, artist, album, energy, trackId: (track && track.id) || null },
    say: say.slice(0, 160), asOf: asOfIso, ttlSec: 3600, source: 'library', mentionable: true,
  };
}

/** Candidate title/artist must be non-empty strings <= 120; the writer re-cleans names before saying them. */
const clip = (s, n) => String(s || '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

export function createOfflineContext({
  getTracks = () => [], getHistory = () => null, getMemory = () => null, getLocation = () => null,
  isPlayable = (t) => !!(t && t.file && !t.relink), utcOffsetMin = null, tzName = null, persona = DEFAULT_PERSONA, maxCandidates = 60, seed = 1,
} = {}) {
  const calls = [];
  const offsetAt = (nowMs) => (Number.isFinite(utcOffsetMin) ? utcOffsetMin : -new Date(nowMs).getTimezoneOffset());
  const zone = () => { if (tzName) return tzName; try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };

  async function getSnapshot({ nowMs, excludeTrackIds = [], seed: s = seed } = {}) {
    nowMs = Number.isFinite(nowMs) ? nowMs : 0;
    const off = offsetAt(nowMs);
    const p = localParts(nowMs, off);
    const asOf = new Date(nowMs).toISOString();
    const ttlDay = p.secondsToMidnight;
    const fact = (id, kind, value, say, ttlSec, source = 'device') => ({ id, kind, value, say: say.slice(0, 160), asOf, ttlSec: Math.max(0, Math.round(ttlSec)), source, mentionable: true });
    const facts = [];
    let hist = null; try { hist = getHistory(); } catch { /* no history */ }
    let mem = null; try { mem = getMemory(); } catch { /* no memory */ }
    let loc = null; try { loc = getLocation(); } catch { /* none */ }
    if (loc && !(Number.isFinite(loc.lat) && Number.isFinite(loc.lon))) loc = null;

    facts.push(fact('time.weekday', 'custom', { weekday: p.weekday }, `it is ${p.weekday}`, ttlDay));
    const hol = holidayOn(p.month, p.day);
    if (hol) facts.push(fact('holiday.today', 'holiday', { name: hol.name, greeting: hol.greeting }, `it is ${hol.name}`, ttlDay));
    const seas = loc ? season({ lat: loc.lat, month: p.month, day: p.day }) : null;
    if (seas) facts.push(fact('season.now', 'custom', { season: seas }, `it is ${seas} where you are`, ttlDay));
    if (loc) {
      const sun = sunTimes({ lat: loc.lat, lon: loc.lon, year: p.year, month: p.month, day: p.day, utcOffsetMin: off });
      const nowMin = p.hour * 60 + p.minute;
      if (sun.kind === 'normal') {
        const rPast = nowMin >= sun.sunriseMin, sPast = nowMin >= sun.sunsetMin;
        facts.push(fact('sun.rise', 'sun', { minutes: sun.sunriseMin, text: clockText(sun.sunriseMin), past: rPast }, `sunrise ${rPast ? 'was' : 'is'} at ${clockText(sun.sunriseMin)} today`, ttlDay));
        facts.push(fact('sun.set', 'sun', { minutes: sun.sunsetMin, text: clockText(sun.sunsetMin), past: sPast }, `sunset ${sPast ? 'was' : 'is'} at ${clockText(sun.sunsetMin)} today`, ttlDay));
      } else if (sun.kind === 'polar_day') facts.push(fact('sun.polar', 'sun', { polar: 'day' }, 'the sun does not set today', ttlDay));
      else if (sun.kind === 'polar_night') facts.push(fact('sun.polar', 'sun', { polar: 'night' }, 'the sun does not rise today', ttlDay));
    }

    // ── library ──
    const all = (() => { try { return getTracks() || []; } catch { return []; } })();
    const playable = all.filter((t) => { try { return isPlayable(t) && t.id; } catch { return false; } });
    const albums = new Set(), artists = new Set();
    const byArtist = new Map(), byGenre = new Map(), newestAlbum = { ms: -1, album: null, artist: null };
    let longest = null;
    for (const t of playable) {
      const al = cleanAlbum(t.album), ar = cleanArtist(t.artist), g = cleanGenre(t.genre);
      if (al) albums.add(`${ar || ''}|${al}`);
      if (ar) { artists.add(ar); byArtist.set(ar, (byArtist.get(ar) || 0) + 1); }
      if (g) byGenre.set(g, (byGenre.get(g) || 0) + 1);
      const lm = t.file && Number.isFinite(t.file.lastModified) ? t.file.lastModified : null;
      if (al && lm !== null && lm > newestAlbum.ms) { newestAlbum.ms = lm; newestAlbum.album = al; newestAlbum.artist = ar; }
      if (Number.isFinite(t.durationSec) && t.durationSec > 0 && cleanTitle(t.title) && (!longest || t.durationSec > longest.durationSec)) longest = t;
    }
    const LIB_TTL = 6 * 3600;
    if (playable.length) {
      facts.push(fact('lib.counts', 'library', { tracks: playable.length, albums: albums.size, artists: artists.size },
        `your library holds ${playable.length} ${playable.length === 1 ? 'track' : 'tracks'}${albums.size ? ` from ${albums.size} ${albums.size === 1 ? 'album' : 'albums'}` : ''}`, LIB_TTL, 'library'));
    }
    if (newestAlbum.album) {
      facts.push(fact('lib.recent', 'library', { album: newestAlbum.album, artist: newestAlbum.artist }, `${newestAlbum.album} is the newest album on your shelf, going by file dates`, LIB_TTL, 'library'));
    }
    if (longest && longest.durationSec >= 420) {
      const minutes = Math.round(longest.durationSec / 60);
      facts.push(fact('lib.longest', 'library', { title: cleanTitle(longest.title), artist: cleanArtist(longest.artist), minutes }, `${cleanTitle(longest.title)} runs about ${minutes} minutes`, LIB_TTL, 'library'));
    }
    const topArtist = [...byArtist.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
    if (topArtist && topArtist[1] >= 3) facts.push(fact('lib.artist', 'library', { artist: topArtist[0], tracks: topArtist[1] }, `${topArtist[0]} has the most tracks on your shelf, ${topArtist[1]} of them`, LIB_TTL, 'library'));
    const topGenre = [...byGenre.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
    if (topGenre && topGenre[1] >= 3) facts.push(fact('lib.genre', 'library', { genre: topGenre[0] }, `${topGenre[0]} is the genre you have the most of`, LIB_TTL, 'library'));

    // ── listening history ──
    if (hist) {
      if (hist.sessions === 0 && totalPlays(hist) === 0) facts.push(fact('hist.first', 'listening', { first: true }, 'this is your first time tuning in', 3600, 'history'));
      const total = totalPlays(hist);
      if (total >= 10) facts.push(fact('hist.total', 'listening', { plays: total }, `you have played ${total} songs on this station so far`, 3600, 'history'));
      const byId = new Map(playable.map((t) => [t.id, t]));
      for (const m of mostPlayed(hist, 3, 3)) {
        const t = byId.get(m.id);
        const title = t && cleanTitle(t.title), artist = t && cleanArtist(t.artist);
        if (title) { facts.push(fact('hist.top', 'listening', { title, artist, plays: m.n }, `you have played ${title}${artist ? ` by ${artist}` : ''} ${m.n} times`, 3600, 'history')); break; }
      }
    }

    // ── digest: a seeded shortlist of playable tracks the show may pick from ──
    const excl = new Set(excludeTrackIds);
    let pool = playable.filter((t) => !excl.has(t.id));
    if (pool.length > maxCandidates) {
      pool = pool.map((t) => ({ t, k: hashSeed(`${s}|${t.id}`) })).sort((a, b) => a.k - b.k || (a.t.id < b.t.id ? -1 : 1)).slice(0, maxCandidates).map((x) => x.t);
    }
    const seen = new Set();
    const candidates = [];
    for (const t of pool) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      const c = { trackId: String(t.id).slice(0, 80), title: clip(t.title, 120) || 'Untitled', artist: clip(t.artist, 120) || 'Unknown artist' };
      const al = clip(t.album, 120); if (al) c.album = al;
      const g = clip(t.genre, 60); if (g) c.genre = g;
      if (Number.isFinite(t.durationSec) && t.durationSec > 0) c.durationSec = t.durationSec;
      const e = energyFromGenre(t.genre); if (e !== null) c.energy = e;
      c.lastPlayedAgoSec = hist ? lastPlayedAgoSec(hist, t.id, nowMs) : null;
      c.playCount = hist ? playCount(hist, t.id) : 0;
      candidates.push(c);
    }

    const memory = (mem && typeof mem === 'object') ? { ...mem, persona: { ...persona, ...(mem.persona || {}) } } : { schemaVersion: 1, persona: { ...persona }, recentShows: [], listenerNotes: [] };
    const snapshot = {
      schemaVersion: 1,
      snapshotId: `offline-${asOf}-${hashSeed(`${s}|${nowMs}|${playable.length}`).toString(36)}`,
      takenAt: asOf,
      time: { tz: zone(), localISO: localISO(nowMs, off), daypart: daypartFor(p.hour), weekday: p.weekday, holiday: hol ? hol.name : null },
      place: loc && loc.label ? { label: String(loc.label).slice(0, 80) } : null,
      facts,
      serviceStatus: { weather: 'down', traffic: 'down', place: 'down' },
      listener: { displayName: null, namedPlaces: [], sessionContext: 'unknown' },
      libraryDigest: { candidates, excludeTrackIds: [...excl].slice(0, 500) },
      memory,
    };
    calls.push({ method: 'getSnapshot', atMs: nowMs });
    if (calls.length > 100) calls.splice(0, calls.length - 100);
    const v = validateContextSnapshot(snapshot);
    if (!v.ok) {
      // never hand the core an invalid snapshot: degrade to facts-free time only
      const bare = { ...snapshot, facts: facts.filter((f) => f.id === 'time.weekday'), libraryDigest: { candidates: [], excludeTrackIds: [] }, place: null };
      if (!validateContextSnapshot(bare).ok) throw Object.assign(new Error(`offline context invalid: ${v.errors[0]}`), { code: 'invalid_context' });
      return bare;
    }
    return snapshot;
  }

  const playableCount = () => { try { return (getTracks() || []).filter((t) => { try { return isPlayable(t) && t.id; } catch { return false; } }).length; } catch { return 0; } };
  return { getSnapshot, playableCount, calls, name: 'offline-context' };
}

export const DAY = DAY_MS;
