// ─────────────────────────────────────────────────────────────────────────────
// pack.js — canned station pack (content/stations/<id>.json, schema v1): validator, loader and the unit model.
//
// PURE and dependency-free (no DOM, no node: imports, no network). One validator serves three callers:
//   • scripts/check-content.mjs (CI pass/fail contract; messages are unchanged)
//   • the app, which validates a pack before airing it (a broken pack is refused, never half-played)
//   • tests
// Nothing here throws on junk input: validatePackDoc / parsePack always return a result object.
//
// UNIT MODEL. A segment that uses slots has a slot-free twin (`fallbackOf` = the slot segment's id). The chooser reasons
// about UNITS: one unit = the root segment plus its twin(s). A unit is aired at most once per window whichever variant
// is used, and gag/bit/daypart tags are read from the root.
// ─────────────────────────────────────────────────────────────────────────────

export const SLOTS = Object.freeze(['prevTitle', 'prevArtist', 'nextTitle', 'nextArtist', 'album']);
const SLOT_SET = new Set(SLOTS);
export const KINDS = Object.freeze(['sign_on', 'station_id', 'jingle', 'banter', 'monologue', 'ad', 'news', 'skit', 'callin', 'dedication', 'liner', 'promo', 'transition', 'sign_off']);
const KIND_SET = new Set(KINDS);
export const DAYPARTS = Object.freeze(['night', 'morning', 'day', 'evening', 'any']);
const DAYPART_SET = new Set(DAYPARTS);
export const WPS = 2.6;
export const EST_TOL = 0.35;
/** A unit longer than this (estSec) is never aired by the chooser (CADENCE.maxEstSec), so it cannot carry a gag beat. */
export const GAG_MAX_EST_SEC = 140;

const BANNED = [
  [/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u, 'emoji'],
  [/https?:\/\/|www\.|\.com\b|\.net\b|\.org\b/i, 'url'],
  // bounded / bracket-excluding bodies keep every pattern linear on adversarial text ("[a [a [a ...", "(x(x(x ...")
  [/\[[^\][]*\]|\*[^*]+\*|\([^)]{0,120}(laugh|sigh|pause|beat|music|sfx)[^)]{0,120}\)/i, 'stage direction in text'],
  [/\{(?!(prevTitle|prevArtist|nextTitle|nextArtist|album)\})[^}{]*\}/, 'unknown slot'],
];

/** A station id is a file name and a URL path segment: lowercase letters, digits and hyphens only (matches session.js validStationId). */
export const isStationId = (id) => typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,60}$/.test(id);

export const wordCount = (t) => String(t ?? '').split(/\s+/).filter(Boolean).length;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const arr = (v) => (Array.isArray(v) ? v : []);

/**
 * Per-gag beats of one tag list: gagTag -> { seq:number|null, payoff:boolean, dupSeq:boolean }.
 * A `seq:n` / `payoff` tag belongs to the gag tag it FOLLOWS (to the first gag tag when it comes before any); further gag
 * tags on the same unit are free flavour for those gags. (`gag:a, seq:3, payoff, gag:b` = beat 3 + payoff of a, flavour of b.)
 */
export function gagBeatsOf(tags) {
  const m = new Map();
  const list = arr(tags).filter((t) => typeof t === 'string');
  const isGag = (t) => t.startsWith('gag:') || t.startsWith('serial:');
  const first = list.find(isGag);
  if (!first) return m;
  let cur = first;
  for (const t of list) {
    if (isGag(t)) { cur = t; if (!m.has(t)) m.set(t, { seq: null, payoff: false, dupSeq: false }); continue; }
    if (!m.has(cur)) m.set(cur, { seq: null, payoff: false, dupSeq: false });
    const b = m.get(cur);
    if (/^seq:\d+$/.test(t)) { if (b.seq != null) b.dupSeq = true; else b.seq = Number(t.slice(4)); } else if (t === 'payoff') b.payoff = true;
  }
  return m;
}

/** Can this raw segment ever be aired by the chooser? (bookends air only as the show's first/last break; silent and over-long never) */
const airableSeg = (s) => s.kind !== 'sign_on' && s.kind !== 'sign_off' && arr(s.lines).some((l) => l && String(l.text || '').trim()) && !(s.estSec > GAG_MAX_EST_SEC);

/** Estimated speaking seconds of a segment's lines (words / WPS), the same yardstick the content check uses. */
export const estimateLinesSec = (lines) => arr(lines).reduce((n, l) => n + wordCount(l && l.text), 0) / WPS;

/**
 * Validate a parsed pack document. -> { errors:[{id:string|null, msg}], stats }
 * `id` is the segment id the error belongs to (null = pack level). Never throws.
 */
export function validatePackDoc(doc) {
  const errors = [];
  const err = (id, msg) => errors.push({ id, msg });
  const stats = { id: null, segments: 0, totalSec: 0, slotSegs: 0, standalone: 0, kinds: {} };
  try {
    if (!isObj(doc)) { err(null, 'pack is not an object'); return { errors, stats }; }
    if (doc.v !== 1) err(null, 'v must be 1');
    const st = isObj(doc.station) ? doc.station : {};
    stats.id = typeof st.id === 'string' ? st.id : null;
    for (const k of ['id', 'name', 'tagline', 'dial', 'vibe', 'contentRating']) if (typeof st[k] !== 'string' || !st[k]) err(null, `station.${k} missing`);
    if (typeof st.id === 'string' && st.id && !isStationId(st.id)) err(null, `station.id "${st.id.slice(0, 40)}" is not URL-safe (lowercase letters, digits, hyphens)`);
    if (!Array.isArray(st.daypart) || !st.daypart.length || st.daypart.some((d) => !DAYPART_SET.has(d))) err(null, 'station.daypart invalid');
    const hosts = new Map();
    for (const h of arr(st.hosts)) {
      if (!isObj(h)) { err(null, 'host entry is not an object'); continue; }
      if (!h.id || hosts.has(h.id)) err(null, `host id missing/duplicate: ${h.id}`);
      hosts.set(h.id, h);
      for (const k of ['name', 'role', 'persona']) if (!h[k]) err(null, `host ${h.id}.${k} missing`);
      const v = isObj(h.voice) ? h.voice : {};
      if (!['female', 'male', 'neutral'].includes(v.genderHint)) err(null, `host ${h.id} genderHint`);
      if (!['young', 'adult', 'older'].includes(v.ageHint)) err(null, `host ${h.id} ageHint`);
      if (!v.accent || !v.style) err(null, `host ${h.id} accent/style`);
      for (const k of ['rate', 'pitch']) if (!(v[k] >= 0.8 && v[k] <= 1.3)) err(null, `host ${h.id} ${k} out of 0.8-1.3`);
    }
    const segs = arr(doc.segments).filter(isObj);
    const ids = new Set();
    for (const s of segs) { if (ids.has(s.id)) err(null, `duplicate segment id ${s.id}`); ids.add(s.id); }
    const fallbackTargets = new Set();
    stats.segments = segs.length;
    for (const s of segs) {
      if (!KIND_SET.has(s.kind)) err(s.id, `bad kind ${s.kind}`);
      stats.kinds[s.kind] = (stats.kinds[s.kind] || 0) + 1;
      if (!Array.isArray(s.lines) || !s.lines.length) { err(s.id, 'no lines'); continue; }
      const segHosts = arr(s.hosts);
      const used = new Set();
      for (const l of s.lines) {
        if (!isObj(l)) { err(s.id, 'line is not an object'); continue; }
        if (!hosts.has(l.host)) err(s.id, `unknown host ${l.host}`);
        if (!segHosts.includes(l.host)) err(s.id, `line host ${l.host} not in segment hosts`);
        if (typeof l.text !== 'string' || !l.text.trim()) { err(s.id, 'empty text'); continue; }
        for (const [re, name] of BANNED) if (re.test(l.text)) err(s.id, `${name}: "${l.text.slice(0, 60)}"`);
        for (const [, slot] of l.text.matchAll(/\{(\w+)\}/g)) { if (!SLOT_SET.has(slot)) err(s.id, `bad slot ${slot}`); used.add(slot); }
        if (l.pauseAfterMs != null && !(l.pauseAfterMs >= 0 && l.pauseAfterMs <= 5000)) err(s.id, 'pauseAfterMs out of range');
      }
      for (const h of segHosts) if (!hosts.has(h)) err(s.id, `segment host ${h} unknown`);
      const declared = new Set(arr(s.usesSlots));
      if ([...used].some((x) => !declared.has(x)) || [...declared].some((x) => !used.has(x))) err(s.id, 'usesSlots does not match text');
      if (s.fallbackOf != null) {
        if (!ids.has(s.fallbackOf)) err(s.id, `fallbackOf ${s.fallbackOf} does not resolve`);
        else fallbackTargets.add(s.fallbackOf);
        if (used.size) err(s.id, 'fallback segment uses slots');
      }
      const est = estimateLinesSec(s.lines);
      if (!(s.estSec >= est * (1 - EST_TOL) && s.estSec <= est * (1 + EST_TOL))) err(s.id, `estSec ${s.estSec} vs ~${est.toFixed(1)}`);
      if (!Array.isArray(s.tags)) err(s.id, 'tags must be an array');
      if (typeof s.weight !== 'number' || !(s.weight > 0)) err(s.id, 'weight must be > 0');
      if (Number.isFinite(s.estSec)) stats.totalSec += s.estSec;
      if (used.size) stats.slotSegs++; else stats.standalone++;
    }
    for (const s of segs) if (arr(s.usesSlots).length && !fallbackTargets.has(s.id)) err(s.id, 'slot segment has no fallback variant');
    // running gags: every seq level must be held by at least one unit that can actually air, else the gag stalls for the whole show
    const held = new Map(); // gag -> Map(level -> { airable, id })
    for (const s of segs) {
      if (s.fallbackOf != null) continue;
      for (const [g, b] of gagBeatsOf(s.tags)) {
        if (b.dupSeq) err(s.id, `two seq tags for ${g}`);
        if (b.seq == null) continue;
        if (!held.has(g)) held.set(g, new Map());
        const lv = held.get(g), prev = lv.get(b.seq);
        lv.set(b.seq, { airable: (prev && prev.airable) || airableSeg(s), id: prev ? prev.id : s.id });
      }
    }
    for (const [g, lv] of held) for (const [seq, h] of lv) if (!h.airable) err(h.id, `${g} seq ${seq} is held only by units that can never air (sign_on/sign_off, silent or over ${GAG_MAX_EST_SEC}s)`);
  } catch (e) {
    err(null, `validator crashed: ${e && e.message}`);
  }
  return { errors, stats };
}

// ── normalised pack ──────────────────────────────────────────────────────────

const tagVal = (tags, prefix) => { const t = tags.find((x) => x.startsWith(prefix)); return t ? t.slice(prefix.length) : null; };

/**
 * Parse a pack (JSON text or object) into the runtime model. -> { ok, errors[], pack|null }
 * pack = { id, name, dial, tagline, vibe, daypart[], hosts: Map-like object by id, hostList[], units[], byId, twinOf }
 * A pack that fails validation is refused (ok:false, pack:null): half-valid content is never aired.
 */
export function parsePack(input) {
  try {
    const doc = typeof input === 'string' ? JSON.parse(input) : input;
    const { errors } = validatePackDoc(doc);
    if (errors.length) return { ok: false, errors: errors.map((e) => (e.id ? `[${e.id}] ${e.msg}` : e.msg)), pack: null };
    return { ok: true, errors: [], pack: buildPack(doc) };
  } catch (e) {
    return { ok: false, errors: [`unreadable pack: ${e && e.message}`], pack: null };
  }
}

/** Build the runtime model from an already-valid document. */
export function buildPack(doc) {
  const st = doc.station;
  const hosts = {};
  for (const h of st.hosts) hosts[h.id] = h;
  const byId = new Map(doc.segments.map((s) => [s.id, s]));
  const twins = new Map(); // root id -> [twin segments]
  for (const s of doc.segments) if (s.fallbackOf) { if (!twins.has(s.fallbackOf)) twins.set(s.fallbackOf, []); twins.get(s.fallbackOf).push(s); }
  const units = [];
  for (const s of doc.segments) {
    if (s.fallbackOf) continue;
    const tags = arr(s.tags);
    const gags = [];
    for (const t of tags) if (t.startsWith('gag:') || t.startsWith('serial:')) gags.push(t);
    const seqs = tags.filter((t) => /^seq:\d+$/.test(t)).map((t) => Number(t.slice(4)));
    units.push({
      id: s.id, kind: s.kind, seg: s, twins: twins.get(s.id) || [], tags,
      gags, gagBeats: gagBeatsOf(tags), seq: seqs.length ? seqs[0] : null, payoff: tags.includes('payoff'), bit: tags.includes('bit'),
      weight: s.weight, estSec: s.estSec, silent: !s.lines.some((l) => String(l.text || '').trim()),
      slots: arr(s.usesSlots),
    });
  }
  const unitOfSeg = new Map();
  for (const u of units) { unitOfSeg.set(u.id, u); for (const t of u.twins) unitOfSeg.set(t.id, u); }
  return {
    id: st.id, name: st.name, dial: st.dial, tagline: st.tagline, vibe: st.vibe, daypart: st.daypart.slice(), contentRating: st.contentRating,
    hosts, hostList: st.hosts.slice(), units, byId, unitOfSeg,
    uniqueSec: units.reduce((a, u) => a + (u.estSec || 0), 0),
  };
}

const BOOKEND_KINDS = new Set(['sign_on', 'sign_off']);

/**
 * Beats of each gag: gagTag -> sorted distinct seq levels (units with no seq are free flavour). Only units that can air count
 * (not sign_on/sign_off, not silent, not longer than maxEstSec): a level held only by those would block the gag forever.
 */
export function gagLevels(pack, { maxEstSec = GAG_MAX_EST_SEC } = {}) {
  const m = new Map();
  for (const u of pack.units) {
    const airable = !BOOKEND_KINDS.has(u.kind) && !u.silent && !(u.estSec > maxEstSec);
    for (const g of u.gags) {
      if (!m.has(g)) m.set(g, new Set());
      const b = u.gagBeats && u.gagBeats.get(g);
      if (airable && b && b.seq != null) m.get(g).add(b.seq);
    }
  }
  return new Map([...m].map(([g, set]) => [g, [...set].sort((a, b) => a - b)]));
}

export { tagVal };
