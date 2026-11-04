// ─────────────────────────────────────────────────────────────────────────────
// grounding.js — facts only from services (architecture 10.1, 9.2).
//
//  • Writer sees facts as {id, say, value}; it copies `say`, it never computes.
//  • Every utterance carries factRefs. verifyScript() rejects, per utterance:
//      missing_factrefs  unknown_fact  unmentionable_ref  service_unavailable  stale_fact
//      ungrounded_number (a number not in any referenced fact, after numeral/word
//                         normalisation and host-style rounding)
//      ungrounded_name   (a mid-sentence proper noun nobody supplied)
//      unreferenced_claim (weather/traffic/sun talk with no fact of that kind referenced)
//      pii / unmentionable_text (coordinates, addresses, phones, emails, URLs,
//                         or the text of a mentionable:false fact)
//  • Services reported down|stale|denied are never talked about; a slot that needs
//    one degrades to chat (degradeSlotForServices).
//  • Failure policy: regenerate once with diagnostics, then a canned link
//    (nextStepAfterVerify).
//
// Pure. The verifier runs on the device AFTER the model, never trusting its output.
// ─────────────────────────────────────────────────────────────────────────────

import { stripMarkup } from './markup.js';
import { extractNumbers, numbersInValue, numberMatches } from './numbers.js';
import { normText } from './util.js';

/** fact kind -> the service whose status gates it (null: always available, computed locally) */
export const KIND_SERVICE = Object.freeze({
  weather: 'weather', forecast: 'weather', traffic: 'traffic', place: 'place',
  sun: null, holiday: null, listening: null, library: null, custom: null,
});

/** claim group -> {kinds that may back it, words that make the claim} */
export const CLAIM_GROUPS = Object.freeze({
  weather: { kinds: ['weather', 'forecast'], re: /\b(rain\w*|drizzl\w*|showers?|snow\w*|sunny|cloud(?:y|s)?|overcast|storm\w*|thunder\w*|windy|humid\w*|fog(?:gy)?|forecast|degrees|temperature|heat\s?wave|freezing|chilly)\b/i },
  traffic: { kinds: ['traffic'], re: /\b(traffic|commute|congestion|gridlock|roadworks|road works|accident|delays?)\b/i },
  sun: { kinds: ['sun'], re: /\b(sunrise|sunset|sundown|dusk|dawn|golden hour)\b/i },
});

export const pickFacts = (snapshot) => (snapshot && Array.isArray(snapshot.facts) ? snapshot.facts : []);
export const factIndex = (snapshot) => new Map(pickFacts(snapshot).map((f) => [f.id, f]));
const expiryMs = (f) => Date.parse(f.asOf) + f.ttlSec * 1000;
export const factStaleAt = (f, atMs) => !(expiryMs(f) >= atMs);

/** ok | stale | down | denied for the service behind a fact kind ('ok' for local kinds). */
export function serviceStateFor(snapshot, kind) {
  const svc = KIND_SERVICE[kind];
  return (svc && snapshot && snapshot.serviceStatus && snapshot.serviceStatus[svc]) || 'ok';
}

/** Topics the writer must not mention: every service not 'ok'. */
export function forbiddenTopics(snapshot) {
  const st = (snapshot && snapshot.serviceStatus) || {};
  return Object.keys(st).filter((k) => st[k] !== 'ok').sort();
}

/** Is this fact usable on air at `atMs`? -> null if yes, else the reason code. */
export function whyUnusable(snapshot, f, atMs) {
  if (!f) return 'unknown_fact';
  if (!f.mentionable) return 'unmentionable_ref';
  if (serviceStateFor(snapshot, f.kind) !== 'ok') return 'service_unavailable';
  if (Number.isFinite(atMs) && factStaleAt(f, atMs)) return 'stale_fact';
  return null;
}

/** The only view the Writer gets: [{id, say, value}] for usable facts among `factIds`. */
export function writerFacts(snapshot, factIds, atMs) {
  const idx = factIndex(snapshot);
  return (factIds || []).map((id) => idx.get(id)).filter((f) => f && !whyUnusable(snapshot, f, atMs))
    .map((f) => ({ id: f.id, say: f.say, value: f.value }));
}

/** utterance.expiresAt derived from its facts' TTL (writer value ignored). null = no time-sensitive fact. */
export function deriveExpiry(script, snapshot) {
  const idx = factIndex(snapshot);
  return {
    ...script,
    utterances: (script.utterances || []).map((u) => {
      const ms = (u.factRefs || []).map((id) => idx.get(id)).filter(Boolean).map(expiryMs).filter(Number.isFinite);
      return { ...u, expiresAt: ms.length ? new Date(Math.min(...ms)).toISOString() : null };
    }),
  };
}

/** Does this utterance expire before atMs? */
export const utteranceStaleAt = (u, atMs) => !!(u && u.expiresAt && Date.parse(u.expiresAt) < atMs);

// ── PII / policy scan (9.2) ──────────────────────────────────────────────────

const PII = [
  ['coordinates', /-?\b\d{1,3}\.\d{3,}\s*[,;]\s*-?\d{1,3}\.\d{3,}\b/],
  ['street_address', /\b\d{1,5}\s+(?:[A-Z][a-z]+\.?\s+){1,3}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|Place|Pl)\b/],
  ['phone', /(?:\+?\d[\d\s().-]{7,}\d)/],
  ['email', /[^\s@]+@[^\s@]+\.[a-z]{2,}/i],
  ['url', /\bhttps?:\/\/|\bwww\./i],
];

/** -> array of PII category names found in text (empty = clean). */
export function piiScan(text) {
  const s = String(text ?? '');
  const hits = [];
  for (const [name, re] of PII) if (re.test(s)) hits.push(name);
  // "12.5" style ordinary numbers are not coordinates; the coordinates rule needs a pair.
  return hits;
}

// ── Proper nouns ─────────────────────────────────────────────────────────────

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

function allowedNameWords(snapshot, refs, extra) {
  const set = new Set();
  const add = (v) => { if (typeof v === 'string') for (const w of normText(v).split(' ')) if (w) set.add(w); };
  const addDeep = (v) => { if (typeof v === 'string') add(v); else if (Array.isArray(v)) v.forEach(addDeep); else if (v && typeof v === 'object') Object.values(v).forEach(addDeep); };
  for (const f of refs) { add(f.say); addDeep(f.value); }
  const pl = snapshot && snapshot.place;
  if (pl) { add(pl.label); add(pl.region); add(pl.country); }
  const l = snapshot && snapshot.listener;
  if (l) { add(l.displayName); (l.namedPlaces || []).forEach((n) => add(n.name)); }
  if (snapshot && snapshot.time) {
    add(snapshot.time.weekday);
    const m = /^\d{4}-(\d\d)/.exec(snapshot.time.localISO || '');
    if (m && MONTHS[Number(m[1]) - 1]) add(MONTHS[Number(m[1]) - 1]);
  }
  const persona = snapshot && snapshot.memory && snapshot.memory.persona;
  if (persona) { add(persona.stationName); add(persona.rjName); }
  for (const v of extra) add(v);
  return set;
}

const SENTENCE_START = /(^|[.!?]["')\]]*\s+|[—–-]\s+|:\s+)$/;
const ALWAYS_OK = new Set(['i', 'ok', 'okay', 'dj', 'rj', 'fm', 'am', 'pm', 'tv', 'uk', 'usa', 'us', 'ai']);

function properNouns(plain) {
  const out = [];
  const re = /[A-Za-z][A-Za-z'’]*/g;
  let m;
  while ((m = re.exec(plain))) {
    const w = m[0];
    if (!/^[A-Z]/.test(w)) continue;
    if (SENTENCE_START.test(plain.slice(0, m.index))) continue;
    const base = w.replace(/['’](?:m|ll|ve|d|s|re)$/i, '');
    if (ALWAYS_OK.has(base.toLowerCase())) continue;
    out.push(base);
  }
  return out;
}

// ── Verifier ─────────────────────────────────────────────────────────────────

/**
 * verifyScript(script, snapshot, {atMs, trackMeta})
 *   atMs:      air time; facts stale at that moment are rejected (default: snapshot.takenAt)
 *   trackMeta: {trackId: {title, artist, album}} for claimedTrackIds (library metadata is groundable)
 * -> {ok, problems:[{utteranceId, code, detail}], script}  (script has expiresAt derived)
 */
export function verifyScript(script, snapshot, opts = {}) {
  const problems = [];
  const bad = (utteranceId, code, detail) => problems.push({ utteranceId, code, detail });
  try {
    const atMs = Number.isFinite(opts.atMs) ? opts.atMs : Date.parse(snapshot && snapshot.takenAt);
    const idx = factIndex(snapshot);
    const trackMeta = opts.trackMeta || {};
    const claimed = (script.claimedTrackIds || []).map((id) => trackMeta[id]).filter(Boolean);
    const claimedText = claimed.flatMap((t) => [t.title, t.artist, t.album]).filter(Boolean);
    const claimedNums = claimedText.flatMap((t) => extractNumbers(t).map((n) => n.value));
    const persona = snapshot && snapshot.memory && snapshot.memory.persona;
    const personaNums = persona ? [persona.stationName, persona.rjName].filter(Boolean).flatMap((t) => extractNumbers(t).map((n) => n.value)) : [];
    const hidden = pickFacts(snapshot).filter((f) => !f.mentionable);

    for (const u of script.utterances || []) {
      const plain = stripMarkup(u.text);
      if (!Array.isArray(u.factRefs)) bad(u.id, 'missing_factrefs', 'every utterance must list factRefs (use [] for none)');
      const refs = [];
      for (const id of u.factRefs || []) {
        const f = idx.get(id);
        const why = whyUnusable(snapshot, f, atMs);
        if (why) bad(u.id, why, id); else refs.push(f);
      }
      // numbers
      const allowed = [...claimedNums, ...personaNums, ...refs.flatMap((f) => [...numbersInValue(f.say), ...numbersInValue(f.value)])];
      for (const n of extractNumbers(plain)) {
        if (!allowed.some((a) => numberMatches(n.value, a))) bad(u.id, 'ungrounded_number', n.raw);
      }
      // proper nouns
      const names = allowedNameWords(snapshot, refs, claimedText);
      for (const w of properNouns(plain)) {
        if (!names.has(normText(w))) bad(u.id, 'ungrounded_name', w);
      }
      // claims that need a fact of a given kind
      for (const [group, g] of Object.entries(CLAIM_GROUPS)) {
        const m = g.re.exec(plain);
        if (m && !refs.some((f) => g.kinds.includes(f.kind))) bad(u.id, 'unreferenced_claim', `${group}: "${m[0]}"`);
      }
      // PII / policy
      const pii = piiScan(u.text).concat(piiScan(plain)).filter((v, i, a) => a.indexOf(v) === i);
      for (const p of pii) bad(u.id, 'pii', p);
      const np = normText(plain);
      for (const f of hidden) {
        const say = normText(f.say);
        if (say && np.includes(say)) bad(u.id, 'unmentionable_text', f.id);
      }
    }
  } catch (e) {
    bad(null, 'verifier_error', e && e.message ? e.message : String(e));
  }
  let withExpiry = script;
  try { withExpiry = deriveExpiry(script, snapshot); } catch { /* keep script */ }
  return { ok: problems.length === 0, problems, script: withExpiry };
}

/** 10.1.4: regenerate once with the verifier's diagnostics, else a canned link. */
export function nextStepAfterVerify(result, attempt) {
  if (result.ok) return { action: 'accept' };
  if (attempt < 1) return { action: 'regenerate', diagnostics: result.problems.map((p) => `${p.code}${p.detail ? `: ${p.detail}` : ''}`) };
  return { action: 'canned' };
}

// ── Services down: degrade slots instead of inventing ────────────────────────

const HIT_SERVICE = { weather_hit: 'weather', traffic_hit: 'traffic', place_hit: 'place' };

/**
 * Filter a slot's talk.factIds to usable facts and convert a *_hit whose service is
 * down/stale/denied (or that has no usable fact left) into a fact-free chat break.
 * -> {slot, converted, dropped:[factIds]}
 */
export function degradeSlotForServices(slot, snapshot, atMs) {
  const idx = factIndex(snapshot);
  const ids = (slot.talk && slot.talk.factIds) || [];
  const keep = [], dropped = [];
  for (const id of ids) (whyUnusable(snapshot, idx.get(id), atMs) ? dropped : keep).push(id);
  const svc = HIT_SERVICE[slot.kind];
  const svcState = svc && snapshot && snapshot.serviceStatus && snapshot.serviceStatus[svc];
  const needsConvert = !!svc && ((svcState && svcState !== 'ok') || keep.length === 0);
  if (!needsConvert && !dropped.length) return { slot, converted: false, dropped };
  const next = { ...slot, talk: { ...(slot.talk || {}), factIds: keep } };
  if (needsConvert) { next.kind = 'talk_break'; next.talk.purpose = 'chat without facts'; }
  return { slot: next, converted: needsConvert, dropped };
}

/**
 * Air-time expiry (4.3, 10.2 "stale air-time facts"): remove utterances whose facts expired by atMs.
 * Returns {script, droppedIds}; an empty script means the slot should be skipped or swapped for a
 * non-time-sensitive variant (e.g. canned.js).
 */
export function dropStaleUtterances(script, atMs) {
  const keep = [], droppedIds = [];
  for (const u of script.utterances || []) (utteranceStaleAt(u, atMs) ? droppedIds.push(u.id) : keep.push(u));
  return { script: { ...script, utterances: keep }, droppedIds };
}
