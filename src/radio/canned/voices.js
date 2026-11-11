// ─────────────────────────────────────────────────────────────────────────────
// voices.js — give every host, caller and cast member of a canned station a DISTINGUISHABLE system voice.
//
// PURE. Input: the pack's hosts (each with voice hints: genderHint, ageHint, accent, rate, pitch) and the device's voice list
// ({ id, name, lang, local }). Output: hostId -> { voiceId|null, rate, pitch, shared } for the speech adapter's `override`.
//
//   1. Score each system voice per host: accent (en-GB for the "UK"/"scottish" hints, en-AU, en-IE ...), gender when the voice
//      name tells (Android voice names usually do not: then the hint is applied to pitch instead), local (offline) voices
//      first, and a penalty for voices already given to another host, so a station with 6 voices uses 6.
//   2. Start from the pack's rate/pitch hint and nudge it for age and for a gender mismatch.
//   3. Anyone who still shares a voice (a phone with one English voice is the common case) is spread apart in pitch and rate
//      until each pair differs audibly. Hosts therefore never collapse into one voice, they only get less natural.
//   4. `directionTweak(direction)` colours a single line ("whispered", "gleeful") with a small, bounded rate/pitch change.
// ─────────────────────────────────────────────────────────────────────────────

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const FEMALE = /\b(samantha|victoria|karen|moira|tessa|fiona|susan|zira|hazel|kate|serena|allison|ava|nicky|joanna|amy|emma|salli|kimberly|kendra|ivy|aria|jenny|libby|sonia|natasha|veena|catherine|heera|female|woman|anna|alice|ellen|laura|lucia|monica|paulina|sara|ioana|yelda|zoe|nora|mia)\b/i;
const MALE = /\b(alex|daniel|fred|tom|oliver|george|david|mark|james|guy|ryan|matthew|justin|joey|brian|russell|arthur|rishi|male|man|thomas|gordon|lee|jorge|diego|luca|reed|ralph|aaron|evan|eric|liam|noah)\b/i;

/** Classify a system voice: { gender:'female'|'male'|'unknown', region:'us'|'uk'|'au'|'ie'|'in'|'ca'|'za'|'other', local } */
export function describeVoice(v) {
  const name = String((v && v.name) || '');
  const lang = String((v && v.lang) || '').toLowerCase().replace('_', '-');
  const region = ({ 'en-us': 'us', 'en-gb': 'uk', 'en-au': 'au', 'en-ie': 'ie', 'en-in': 'in', 'en-ca': 'ca', 'en-za': 'za', 'en-nz': 'au', 'en-sc': 'uk' })[lang] || (lang.startsWith('en') ? 'other' : 'other');
  const gender = FEMALE.test(name) ? 'female' : MALE.test(name) ? 'male' : 'unknown';
  return { gender, region, local: v && v.local !== false, english: lang.startsWith('en') };
}

const ACCENT_REGION = {
  'neutral-us': ['us'], us: ['us'], american: ['us'],
  'neutral-uk': ['uk'], uk: ['uk'], british: ['uk'], english: ['uk'],
  scottish: ['uk', 'ie'], welsh: ['uk'], irish: ['ie', 'uk'], australian: ['au'], indian: ['in'], canadian: ['ca', 'us'],
};
const regionsFor = (accent) => ACCENT_REGION[String(accent || '').toLowerCase()] || ['us'];

function score(voice, hint, taken) {
  const d = describeVoice(voice);
  if (!d.english) return -100;
  let s = 0;
  const regs = regionsFor(hint.accent);
  const ri = regs.indexOf(d.region);
  s += ri === 0 ? 3 : ri > 0 ? 1.8 : (d.region === 'us' || d.region === 'uk' ? 0.4 : 0);
  if (hint.genderHint === 'female' || hint.genderHint === 'male') s += d.gender === hint.genderHint ? 3 : d.gender === 'unknown' ? 0.6 : -3;
  if (d.local) s += 0.8;
  s -= 2.6 * (taken.get(voice.id) || 0);
  return s;
}

const ROLE_ORDER = { host: 0, 'co-host': 1, cast: 2, caller: 3 };

/** The direction word a pack puts on a line -> a small bounded tweak. */
export function directionTweak(direction) {
  const d = String(direction || '').toLowerCase();
  if (!d) return { rate: 0, pitch: 0 };
  let rate = 0, pitch = 0;
  if (/whisper|hush|soft|quiet|murmur|low voice|close-mic|intimate/.test(d)) { rate -= 0.07; pitch -= 0.04; }
  if (/gleeful|huge|boom|shout|excit|bright|proclam|hype|loud|squawk|triumph/.test(d)) { rate += 0.05; pitch += 0.05; }
  if (/deadpan|flat|dry|monoton|bored|weary|tired|sigh/.test(d)) { rate -= 0.03; pitch -= 0.03; }
  if (/slow|dreamy|wistful|sleepy|gentle|tender|warm/.test(d)) { rate -= 0.05; }
  if (/fast|rapid|rush|breathless|panic|quick|manic/.test(d)) { rate += 0.07; }
  if (/queasy|fretful|nervous|anxious|trembl/.test(d)) { pitch += 0.03; rate += 0.02; }
  return { rate: clamp(rate, -0.1, 0.1), pitch: clamp(pitch, -0.08, 0.08) };
}

/**
 * Assign voices. `prefs` = { hostId: voiceId } (the owner's explicit choices win). `voices` may be empty (engine default only).
 * -> { byHost: { hostId: { voiceId, voiceName, rate, pitch, shared } }, distinct: number }
 */
export function assignHostVoices(hostList, voices = [], prefs = {}) {
  const hosts = (Array.isArray(hostList) ? hostList : []).filter((h) => h && h.id);
  // network voices (local === false) are never assigned: they would send the show's text to a cloud service
  const list = (Array.isArray(voices) ? voices : []).filter((v) => v && v.id && v.local !== false);
  const order = hosts.slice().sort((a, b) => (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9));
  const taken = new Map();
  const picked = new Map();
  for (const h of order) {
    const hint = h.voice || {};
    let chosen = null;
    const pref = prefs && prefs[h.id];
    if (pref && list.some((v) => v.id === pref)) chosen = list.find((v) => v.id === pref);
    else if (list.length) {
      let best = -1e9;
      for (const v of list) { const sc = score(v, hint, taken); if (sc > best) { best = sc; chosen = v; } }
      if (best < -50) chosen = null;
    }
    picked.set(h.id, chosen);
    if (chosen) taken.set(chosen.id, (taken.get(chosen.id) || 0) + 1);
  }

  const out = {};
  for (const h of hosts) {
    const hint = h.voice || {};
    const v = picked.get(h.id);
    const d = v ? describeVoice(v) : { gender: 'unknown' };
    let rate = Number.isFinite(hint.rate) ? hint.rate : 1;
    let pitch = Number.isFinite(hint.pitch) ? hint.pitch : 1;
    if (hint.ageHint === 'older') { pitch *= 0.95; rate *= 0.95; } else if (hint.ageHint === 'young') { pitch *= 1.04; rate *= 1.03; }
    if (hint.genderHint === 'female') pitch *= d.gender === 'male' ? 1.2 : d.gender === 'unknown' ? 1.05 : 1;
    else if (hint.genderHint === 'male') pitch *= d.gender === 'female' ? 0.82 : d.gender === 'unknown' ? 0.95 : 1;
    out[h.id] = { voiceId: v ? v.id : null, voiceName: v ? v.name : '', rate, pitch, shared: false, _g: d.gender };
  }

  // spread anyone who shares a voice (including "the engine default") apart in pitch, then in rate
  const groups = new Map();
  for (const h of order) { const k = out[h.id].voiceId || '__default__'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(h.id); }
  const STEPS = [0, 0.1, -0.1, 0.2, -0.2, 0.3, -0.3];
  const RATE_STEPS = [0, 0.05, -0.05, 0.1, -0.1];
  for (const ids of groups.values()) {
    if (ids.length < 2) continue;
    const placed = [];
    for (const id of ids) {
      const base = out[id];
      let ok = null;
      outer: for (const rs of RATE_STEPS) for (const ps of STEPS) {
        const p = clamp(base.pitch * (1 + ps), 0.6, 1.55), r = clamp(base.rate * (1 + rs), 0.7, 1.45);
        // audibly apart: pitch ratio differs by >= 7 % or rate by >= 6 % from everyone already placed on this voice
        if (placed.every((q) => Math.abs(Math.log(p / q.p)) >= 0.07 || Math.abs(Math.log(r / q.r)) >= 0.06)) { ok = { p, r }; break outer; }
      }
      const f = ok || { p: clamp(base.pitch, 0.6, 1.55), r: clamp(base.rate, 0.7, 1.45) };
      base.pitch = f.p; base.rate = f.r; base.shared = true;
      placed.push(f);
    }
  }
  let distinct = 0;
  const seen = [];
  for (const h of hosts) {
    const o = out[h.id];
    o.rate = Math.round(clamp(o.rate, 0.6, 1.6) * 100) / 100;
    o.pitch = Math.round(clamp(o.pitch, 0.5, 1.6) * 100) / 100;
    delete o._g;
    if (!seen.some((s) => s.voiceId === o.voiceId && Math.abs(Math.log(s.pitch / o.pitch)) < 0.05 && Math.abs(Math.log(s.rate / o.rate)) < 0.04)) { seen.push(o); distinct++; }
  }
  return { byHost: out, distinct };
}

/** Rate/pitch to hand the speech adapter for one line: the host's assignment plus the line's direction tweak. */
export function lineVoice(assign, direction) {
  const t = directionTweak(direction);
  return { voiceId: assign ? assign.voiceId : null, rate: clamp(((assign && assign.rate) || 1) * (1 + t.rate), 0.6, 1.6), pitch: clamp(((assign && assign.pitch) || 1) * (1 + t.pitch), 0.5, 1.6) };
}

export const VOICE_PREFS_KEY = 'runout.radio.canned.voices.v1';
export function loadCannedVoicePrefs(storage) {
  try { const j = JSON.parse(storage.getItem(VOICE_PREFS_KEY)); if (j && j.v === 1 && j.byStation && typeof j.byStation === 'object') return j.byStation; } catch { /* none */ }
  return {};
}
export function saveCannedVoicePrefs(storage, stationId, prefs) {
  try {
    let all = {};
    try { const j = JSON.parse(storage.getItem(VOICE_PREFS_KEY)); if (j && j.v === 1 && j.byStation) all = j.byStation; } catch { /* fresh */ }
    all[stationId] = prefs;
    storage.setItem(VOICE_PREFS_KEY, JSON.stringify({ v: 1, byStation: all }));
    return true;
  } catch { return false; }
}
