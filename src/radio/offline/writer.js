// ─────────────────────────────────────────────────────────────────────────────
// writer.js — the TEMPLATED offline Writer: a deterministic, seedable stand-in for the cloud LLM Writer.
//
// Same seam as the core's FakeWriter / the P2 backend writer:
//     write({ slot, facts, persona, seed, brief }) -> Script        (`brief` is an optional additive extra)
// `facts` are exactly what the Writer is allowed to see: [{id, say, value}] (core writerFacts). Every slot a line
// fills is read from one of those facts and that fact's id goes into the utterance's factRefs; clock words are
// late-bound tokens ({{time.spoken}} ...) listed in `templates`. Nothing is computed or invented, so the core's
// verifyScript passes by construction (and is still run on air, see show-runner.js). Names that cannot be said
// safely (file-name cruft, weather words in a title, long digit runs) switch the line to a nameless variant.
//
// Variety: per-kind anti-repeat (a line is not reused until the kind's eligible lines are spent, then only the
// older half returns), recent-show ids from the core memory module are de-preferred, lines are filtered by daypart
// and by the next song's energy (tone), and {a|b} choices vary the phrasing. Same seed + same call sequence =
// same scripts. Data lives in bank.js; this file is logic only.
// ─────────────────────────────────────────────────────────────────────────────

import { mulberry32, hashSeed, normText } from '../core/util.js';
import { CLAIM_GROUPS, piiScan } from '../core/grounding.js';
import { validateMarkup } from '../core/markup.js';
import { BANK } from './bank.js';
import { HOSTS } from './context.js';
import { cleanTitle, cleanArtist, cleanAlbum } from './pronounce.js';

export const WORDS_PER_SEC = 2.6; // system voices at rate 1; calibrated on-device later

// A name is only spoken if the grounding verifier can compare it: Latin letters (accents are fine), no claim words, no PII.
// Names in other scripts (Cyrillic, CJK ...) normalise to nothing, so they are skipped in favour of a nameless line.
const comparable = (s) => s.split(/\s+/).filter(Boolean).every((w) => !/\p{L}/u.test(w) || normText(w) !== '');
const nameSafe = (s) => typeof s === 'string' && s.length > 0 && !piiScan(s).length && !Object.values(CLAIM_GROUPS).some((g) => g.re.test(s)) && !/[{}\\|]/.test(s) && comparable(s);
const safe = (s) => (nameSafe(s) ? s : null);

// slot name -> { facts: [fact ids it reads], get(ctx) -> string | null | {text, token} }
const fv = (c, id) => (c.f[id] ? c.f[id].value || {} : null);
const slotOf = (id, pick, extra = {}) => ({ facts: [id], get: (c) => { const v = fv(c, id); if (!v) return null; const x = pick(v, c.f[id]); return x === undefined || x === null || x === '' ? null : String(x); }, ...extra });
export const SLOTS = Object.freeze({
  station: { facts: [], get: (c) => c.persona.stationName || 'You Radio' },
  hostA: { facts: [], get: () => HOSTS.a },
  hostB: { facts: [], get: () => HOSTS.b },
  me: { facts: [], get: (c) => c.speaker.name },
  other: { facts: [], get: (c) => c.other.name },
  time: { facts: [], token: 'time.spoken' },
  daypart: { facts: [], token: 'time.daypart' },
  date: { facts: [], token: 'date.spoken' },
  weekday: slotOf('time.weekday', (v) => v.weekday),
  holiday: slotOf('holiday.today', (v) => v.name),
  greeting: slotOf('holiday.today', (v) => v.greeting),
  season: slotOf('season.now', (v) => v.season),
  sun_rise: slotOf('sun.rise', (v, f) => f.say, { lead: true }),
  sun_set: slotOf('sun.set', (v, f) => f.say, { lead: true }),
  sun_polar: slotOf('sun.polar', (v, f) => f.say, { lead: true }),
  tracks: slotOf('lib.counts', (v) => v.tracks),
  albums: slotOf('lib.counts', (v) => v.albums),
  artists: slotOf('lib.counts', (v) => v.artists),
  recent_album: slotOf('lib.recent', (v) => safe(v.album)),
  longest_title: slotOf('lib.longest', (v) => safe(v.title)),
  longest_min: slotOf('lib.longest', (v) => v.minutes),
  top_artist: slotOf('lib.artist', (v) => safe(v.artist)),
  top_artist_n: slotOf('lib.artist', (v) => v.tracks),
  top_genre: slotOf('lib.genre', (v) => safe(v.genre)),
  top_title: slotOf('hist.top', (v) => safe(v.title)),
  top_plays: slotOf('hist.top', (v) => v.plays),
  total_plays: slotOf('hist.total', (v) => v.plays),
  next_title: slotOf('trk.next', (v) => safe(v.title)),
  next_artist: slotOf('trk.next', (v) => safe(v.artist)),
  next_album: slotOf('trk.next', (v) => safe(v.album)),
  next_song: slotOf('trk.next', (v) => (safe(v.title) ? (safe(v.artist) ? `${v.title} by ${v.artist}` : v.title) : null)),
  prev_title: slotOf('trk.prev', (v) => safe(v.title)),
  prev_artist: slotOf('trk.prev', (v) => safe(v.artist)),
  prev_album: slotOf('trk.prev', (v) => safe(v.album)),
  prev_song: slotOf('trk.prev', (v) => (safe(v.title) ? (safe(v.artist) ? `${v.title} by ${v.artist}` : v.title) : null)),
});

const CONDITIONS = {
  many_tracks: (c) => { const v = fv(c, 'lib.counts'); return !!v && v.tracks >= 5 && v.albums >= 2 && v.artists >= 2; },
};

const SLOT_RE = /\[([A-Za-z_]+)\]/g;
const slotsIn = (text) => [...text.matchAll(SLOT_RE)].map((m) => m[1]);

// precompute which slots/facts each entry reads (a lines entry = union)
const meta = new Map();
for (const e of BANK) {
  const texts = e.lines ? e.lines.map((l) => l.text) : [e.text];
  const names = [...new Set(texts.flatMap(slotsIn))];
  for (const n of names) if (!SLOTS[n]) throw new Error(`bank line uses unknown slot [${n}]: ${texts[0]}`);
  meta.set(e.id, { names, factIds: [...new Set([...names.flatMap((n) => SLOTS[n].facts), ...(e.needs || [])])] });
}

/** bank entry id -> { names: slot names it uses, factIds: facts it reads } (for tests and tooling) */
export const ENTRY_META = meta;

const KIND_PLAN = {
  sign_on: ['sign_on'], sign_off: ['sign_off'], station_id: ['station_id'], talk_over_intro: ['song_intro'], back_sell: ['back_sell'],
};
const PURPOSE_KIND = {
  intro: 'song_intro', back_sell: 'back_sell', time: 'time_check', trivia: 'trivia', you: 'you_moment', sun: 'sun', holiday: 'holiday',
  banter: 'banter', chat: 'filler', filler: 'filler', station_id: 'station_id', sign_on: 'sign_on', sign_off: 'sign_off',
};

const toneOf = (energy) => (Number.isFinite(energy) ? (energy < 0.4 ? 'low' : energy > 0.65 ? 'high' : null) : null);
const sentenceStart = (s) => /(^|[.!?]["')\]]*\s+|[:—–]\s+)$/.test(s);

export function createTemplateWriter({ seed = 1, bank = BANK, recentIds = () => [], hostNames = HOSTS } = {}) {
  const used = new Map(); // kind -> ordered ids
  const usedAll = [];
  let n = 0, lastSpeaker = 'b', lastKind = null;
  const calls = [];

  function eligible(kind, ctx, o) {
    return bank.filter((e) => {
      if (e.kind !== kind) return false;
      const m = meta.get(e.id) || { names: [], factIds: [] };
      if (o.nameless && e.name !== false) return false;
      if (!o.nameless && e.name === false && o.preferNamed) return false;
      if (e.tone && e.tone !== ctx.tone) return false;
      if (e.parts && !(ctx.daypart && e.parts.includes(ctx.daypart))) return false;
      if (e.when && !(CONDITIONS[e.when] && CONDITIONS[e.when](ctx))) return false;
      for (const id of m.factIds) if (!ctx.f[id]) return false;
      for (const nm of m.names) { const sp = SLOTS[nm]; if (!sp.token && sp.get({ ...ctx, speaker: { name: hostNames.a }, other: { name: hostNames.b } }) === null) return false; }
      return true;
    });
  }

  function choose(kind, ctx, rng, o = {}) {
    let pool = eligible(kind, ctx, o);
    if (!pool.length) return null;
    const usedK = used.get(kind) || [];
    let fresh = pool.filter((e) => !usedK.includes(e.id));
    if (!fresh.length) {
      const blocked = new Set(usedK.slice(-Math.floor(pool.length / 2)));
      fresh = pool.filter((e) => !blocked.has(e.id));
      if (!fresh.length) fresh = pool;
    }
    const recent = new Set(recentIds() || []);
    const weights = fresh.map((e) => (recent.has(e.id) ? 0.25 : 1) * (e.name === false && !o.nameless ? 0.5 : 1));
    const total = weights.reduce((a, b) => a + b, 0);
    let r = rng() * total;
    for (let i = 0; i < fresh.length; i++) { r -= weights[i]; if (r <= 0) return fresh[i]; }
    return fresh[fresh.length - 1];
  }

  function render(text, ctx, rng) {
    let t = text.replace(/\{([^{}|]*\|[^{}]*)\}/g, (m, g) => { const opts = g.split('|'); return opts[Math.floor(rng() * opts.length)]; });
    const refs = new Set(), templates = new Set();
    let out = '', last = 0;
    for (const m of t.matchAll(SLOT_RE)) {
      out += t.slice(last, m.index);
      last = m.index + m[0].length;
      const sp = SLOTS[m[1]];
      if (sp.token) { out += `{{${sp.token}}}`; templates.add(sp.token); continue; }
      let v = sp.get(ctx);
      if (v === null) return null;
      for (const id of sp.facts) refs.add(id);
      if (sp.lead && sentenceStart(out) && v) v = v[0].toUpperCase() + v.slice(1);
      out += v;
    }
    out += t.slice(last);
    out = out.replace(/\s+/g, ' ').replace(/\s+([,.;:!?])/g, '$1').trim();
    if (out.length > 400) return null;
    return { text: out, refs: [...refs], templates: [...templates] };
  }

  function useEntry(e) {
    const a = used.get(e.kind) || [];
    a.push(e.id);
    used.set(e.kind, a.slice(-200));
    usedAll.push(e.id);
  }

  return {
    /** The cloud Writer's contract. `brief` = { daypart, nextEnergy } (optional, additive). */
    async write({ slot, facts = [], persona = {}, seed: s = seed, brief = {} } = {}) {
      const idx = n++;
      const rng = mulberry32(hashSeed(`${slot.slotId}|${s}|${idx}`));
      const f = {};
      for (const x of facts) if (x && x.id) f[x.id] = x;
      const nextV = f['trk.next'] && f['trk.next'].value;
      const energy = Number.isFinite(brief.nextEnergy) ? brief.nextEnergy : (nextV && Number.isFinite(nextV.energy) ? nextV.energy : null);
      const base = { f, persona, daypart: brief.daypart || null, tone: toneOf(energy) };
      const budgetSec = (slot.talk && slot.talk.budgetSec) || 12;
      const maxWords = Math.max(6, Math.floor(budgetSec * WORDS_PER_SEC * 0.9));
      const purpose = String((slot.talk && slot.talk.purpose) || '').toLowerCase();

      // which kinds, in order
      let kinds;
      if (KIND_PLAN[slot.kind]) kinds = [...KIND_PLAN[slot.kind]];
      else {
        const main = PURPOSE_KIND[purpose] || 'filler';
        kinds = [];
        if (f['trk.prev'] && main !== 'back_sell' && main !== 'song_intro' && rng() < 0.55 && budgetSec >= 14) kinds.push('back_sell');
        kinds.push(main);
        if (f['trk.next'] && main !== 'song_intro' && rng() < 0.5 && budgetSec >= 22) kinds.push('song_intro');
        else if (main !== 'filler' && rng() < 0.3 && budgetSec >= 26) kinds.push('filler');
      }
      if (slot.kind === 'sign_on' && f['holiday.today'] && rng() < 0.6) kinds.push('holiday');

      const utterances = [];
      const claimed = new Set();
      let words = 0, cur = lastSpeaker === 'a' ? 'b' : 'a';
      const names = { a: hostNames.a, b: hostNames.b };
      const pushUtt = (e, who, rendered, st) => {
        const id = `${slot.slotId}.${utterances.length + 1}`;
        const text = rendered.text;
        const style = { emotion: e.emotion, energy: Math.min(1, Math.max(0, e.energy + (base.tone === 'high' ? 0.05 : base.tone === 'low' ? -0.05 : 0))), pace: Math.min(1.25, Math.max(0.8, e.pace)) };
        const u = { id, text, style, speaker: who, factRefs: rendered.refs, droppable: utterances.length > 0, pauseAfterMs: 180 + Math.floor(rng() * 220) };
        if (rendered.templates.length) u.templates = rendered.templates;
        utterances.push(u);
        for (const r of rendered.refs) if (r.startsWith('trk.') && f[r].value && f[r].value.trackId) claimed.add(f[r].value.trackId);
        words += (text.match(/\S+/g) || []).length;
        useEntry(e);
        if (st) st.last = who;
      };

      for (const kind of kinds) {
        if (utterances.length >= 4) break;
        let e = choose(kind, base, rng, kind === 'song_intro' || kind === 'back_sell' ? { preferNamed: true } : {});
        if (!e && (kind === 'song_intro' || kind === 'back_sell')) e = choose(kind, base, rng, { nameless: true });
        if (!e) { if (utterances.length === 0) e = choose('filler', base, rng); if (!e) continue; }
        const lines = e.lines || [{ who: e.who || cur, text: e.text }];
        const pending = [];
        let ok = true;
        for (const [li, ln] of lines.entries()) {
          const who = e.lines ? ln.who : (e.who || cur);
          const ctx = { ...base, speaker: { name: names[who] }, other: { name: names[who === 'a' ? 'b' : 'a'] } };
          const r = render(ln.text, ctx, rng);
          if (!r || !validateMarkup(r.text).ok) { ok = false; break; }
          pending.push({ who, r });
        }
        if (!ok) continue;
        const addWords = pending.reduce((a, p) => a + (p.r.text.match(/\S+/g) || []).length, 0);
        if (utterances.length && words + addWords > maxWords) continue;
        for (const p of pending) { pushUtt(e, p.who, p.r); cur = p.who === 'a' ? 'b' : 'a'; }
        lastKind = kind;
      }
      if (!utterances.length) {
        // absolute fallback: a fact-free station line, always eligible
        const e = bank.find((x) => x.kind === 'filler') || bank[0];
        const r = render(e.text || e.lines[0].text, { ...base, speaker: { name: names.a }, other: { name: names.b } }, rng);
        pushUtt(e, 'a', r || { text: 'Back to the music.', refs: [], templates: [] });
      }
      lastSpeaker = utterances[utterances.length - 1].speaker;
      calls.push({ slotId: slot.slotId, kinds });
      if (calls.length > 200) calls.shift();
      return { schemaVersion: 1, slotId: slot.slotId, utterances, ...(claimed.size ? { claimedTrackIds: [...claimed].slice(0, 12) } : {}) };
    },
    /** Template ids used so far, in order (feed memory.recordShow so the next show avoids them). */
    usedIds: () => [...usedAll],
    reset() { used.clear(); usedAll.length = 0; n = 0; lastKind = null; },
    get callCount() { return n; },
    calls,
  };
}

/** Cleaned names for a library track, ready for makeTrackFact. */
export const nameable = (t) => ({ title: cleanTitle(t && t.title), artist: cleanArtist(t && t.artist), album: cleanAlbum(t && t.album) });

/** Estimated seconds a Script takes to speak (words / wps / pace + pauses). */
export function estimateScriptSec(script, wps = WORDS_PER_SEC) {
  return script.utterances.reduce((a, u) => a + ((u.text.replace(/\{\{[^}]*\}\}/g, 'twelve fifty').match(/\S+/g) || []).length / (wps * (u.style.pace || 1))) + (u.pauseAfterMs || 0) / 1000, 0);
}
