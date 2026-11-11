// ─────────────────────────────────────────────────────────────────────────────
// catalog.js — the station catalog the dial renders. PURE and data-driven.
//
//   canned stations   read from the stations index (content/stations/index.json, generated from the pack JSON at build time),
//                     so a station's name, dial number, tagline, vibe and hosts come from the pack and NOTHING here names one:
//                     renaming a station is a content-only change.
//   AI styles         ai-styles.js data (bibles + voice direction), shown only when the radio.ai flag is on, never startable
//                     until the cloud phase exists (cloudAvailable).
//
// Ordering: stations whose daypart fits the current hour come first (hint only; every canned station plays at any time),
// then the rest, each group in dial order.
// ─────────────────────────────────────────────────────────────────────────────

import { AI_STYLES } from './ai-styles.js';

export const CANNED_TYPE = 'canned';
export const AI_STYLE_TYPE = 'ai-style';
export const PRE_WRITTEN_LABEL = 'Pre-written show';
export const NEEDS_INTERNET = 'Needs internet — coming soon';

/** local hour (0-23) -> the pack daypart vocabulary: morning 5-10, day 10-17, evening 17-21, night 21-5 */
export function daypartOfHour(hour) {
  const h = ((Math.floor(Number(hour)) % 24) + 24) % 24;
  if (h >= 5 && h < 10) return 'morning';
  if (h >= 10 && h < 17) return 'day';
  if (h >= 17 && h < 21) return 'evening';
  return 'night';
}

export const daypartFits = (dayparts, hour) => !Array.isArray(dayparts) || !dayparts.length || dayparts.includes('any') || dayparts.includes(daypartOfHour(hour));

/** 2 = names this time of day, 1 = plays any time, 0 = suits another time of day (all of them still play) */
export function daypartFit(dayparts, hour) {
  const d = Array.isArray(dayparts) ? dayparts : [];
  if (!d.length) return 1;
  if (d.includes(daypartOfHour(hour))) return 2;
  return d.includes('any') ? 1 : 0;
}

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
/** badge text: "Any time", "Evening / night" */
export function daypartBadge(dayparts) {
  const d = Array.isArray(dayparts) ? dayparts : [];
  if (!d.length || d.includes('any') && d.length === 1) return 'Any time';
  const real = d.filter((x) => x !== 'any');
  return real.length >= 4 ? 'Any time' : real.map(cap).join(' / ') + (d.includes('any') ? ' (any time)' : '');
}

/** Stations index (parsed JSON) -> sanitised entries. Never throws; junk is dropped. */
export function parseStationsIndex(input) {
  try {
    const j = typeof input === 'string' ? JSON.parse(input) : input;
    if (!j || j.v !== 1 || !Array.isArray(j.stations)) return [];
    const out = [];
    for (const s of j.stations) {
      if (!s || typeof s.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(s.id) || typeof s.name !== 'string' || !s.name) continue;
      out.push({
        id: s.id, name: s.name.slice(0, 80), dial: String(s.dial ?? '').slice(0, 12), tagline: String(s.tagline ?? '').slice(0, 200), vibe: String(s.vibe ?? '').slice(0, 400),
        daypart: Array.isArray(s.daypart) ? s.daypart.filter((d) => typeof d === 'string') : [], contentRating: String(s.contentRating ?? ''),
        file: typeof s.file === 'string' && /^[a-z0-9][a-z0-9-]*\.json$/.test(s.file) ? s.file : `${s.id}.json`,
        hosts: (Array.isArray(s.hosts) ? s.hosts : []).filter((h) => h && typeof h.id === 'string' && typeof h.name === 'string').map((h) => ({ id: h.id, name: h.name.slice(0, 80), role: String(h.role ?? '') })),
        segments: Number(s.segments) || 0, minutes: Math.round(Number(s.minutes) || 0), audio: s.audio === true,
      });
    }
    return out;
  } catch { return []; }
}

/** The Station object the rest of the app stores and plays (radio-store snapshot, favourites, resume). */
export const cannedStation = (e) => ({ type: CANNED_TYPE, id: e.id, name: e.name, dial: e.dial, tagline: e.tagline, tags: ['canned', 'pre-written'] });

export function cannedCard(e, hour) {
  const speakers = e.hosts.filter((h) => h.role === 'host' || h.role === 'co-host');
  return {
    kind: 'canned', key: `${CANNED_TYPE}|${e.id}`, id: e.id, name: e.name, dial: e.dial, tagline: e.tagline, vibe: e.vibe,
    label: PRE_WRITTEN_LABEL, dayparts: e.daypart, daypartBadge: daypartBadge(e.daypart), inDaypart: daypartFits(e.daypart, hour), fit: daypartFit(e.daypart, hour),
    hostChips: (speakers.length ? speakers : e.hosts.slice(0, 3)).map((h) => ({ id: h.id, name: h.name, role: h.role })),
    castCount: Math.max(0, e.hosts.length - speakers.length), minutes: e.minutes, segments: e.segments,
    startable: true, station: cannedStation(e),
  };
}

export function styleCard(s, hour, { cloudAvailable = false } = {}) {
  const inWin = !s.onAir ? true : s.onAir.from < s.onAir.to ? hour >= s.onAir.from && hour < s.onAir.to : (hour >= s.onAir.from || hour < s.onAir.to);
  return {
    kind: 'style', key: `${AI_STYLE_TYPE}|${s.id}`, id: s.id, name: s.title, subtitle: s.style, mode: s.mode, tone: s.tone,
    dayparts: s.daypart, daypartBadge: s.onAir ? `${String(s.onAir.from).padStart(2, '0')}:00 to ${String(s.onAir.to).padStart(2, '0')}:00` : 'Any time', inDaypart: inWin, windowNote: s.windowNote,
    talkShare: s.talkShare, musicShare: Math.round((1 - s.talkShare) * 100) / 100, hostChips: s.hosts.map((h) => ({ id: h.id, name: h.name, role: h.default ? 'default host' : 'host' })),
    startable: cloudAvailable === true, status: cloudAvailable === true ? '' : NEEDS_INTERNET, style: s,
  };
}

const dialNum = (c) => { const n = parseFloat(c.dial); return Number.isFinite(n) ? n : 1e9; };

/** stations that name this time of day first, then 'any time' ones, then the rest; each group by dial number then name */
export function orderCanned(cards) {
  return cards.slice().sort((a, b) => ((b.fit ?? Number(b.inDaypart)) - (a.fit ?? Number(a.inDaypart))) || (dialNum(a) - dialNum(b)) || (a.name < b.name ? -1 : 1));
}

/**
 * Everything the dial lists besides real stations.
 *   index      stations index JSON (or already-parsed entries)
 *   flagOn     the radio.ai flag: AI style cards and the You Radio row appear only when true
 *   hour       local hour (ordering/hinting only)
 * -> { canned: [card], styles: [card], youRadio: boolean }
 */
export function buildCatalog({ index, flagOn = false, hour = 12, cloudAvailable = false } = {}) {
  const entries = Array.isArray(index) ? index : parseStationsIndex(index);
  const canned = orderCanned(entries.map((e) => cannedCard(e, hour)));
  const styles = flagOn ? AI_STYLES.map((s) => styleCard(s, hour, { cloudAvailable })) : [];
  return { canned, styles, youRadio: !!flagOn };
}
