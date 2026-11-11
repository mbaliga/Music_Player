// ─────────────────────────────────────────────────────────────────────────────
// audio-pack.js — the pre-rendered voice source: manifest parsing, the path convention, voice-source selection, captions.
// PURE (no DOM, no network). The player that actually decodes the files is audio.js.
//
// PATH CONVENTION (served lazily from the app's own origin; ABSENT in this build — the owner is still auditioning voices):
//     <audioBase>/<stationId>/manifest.json          written by scripts/render-shows.py
//     <audioBase>/<stationId>/<file>                 one Opus file per slot-free segment ("<segmentId>.opus")
// audioBase is `audio` in the shipped app (build-web copies content/audio/ there if it exists) and `content/audio` when the
// repo root is served directly (serve.py); the loader tries them in that order.
//
// MANIFEST (render-shows.py v1): { v, station, codec, bitrateKbps, targetLufs,
//     segments: [{ id, kind, file, durationSec, sha256, bytes, lufs, alt?: [{ file, type? }] }] }
// `alt` is an OPTIONAL extension: other encodings of the same segment (e.g. an .m4a) because Opus decode in the Android
// WebView is unverified. The player picks the first candidate the element says it can play (canPlayType) and moves to the
// next on a load error; when every candidate fails the segment is spoken by system TTS instead.
//
// Slot segments are never pre-rendered (their text is only known at run time): render-shows.py renders their slot-free twin.
// So in audio-pack mode a slot unit is aired as its TWIN (the recording) unless `slotsInAudioMode: 'tts'` is chosen.
// ─────────────────────────────────────────────────────────────────────────────

export const AUDIO_BASES = Object.freeze(['audio', 'content/audio']);
export const MAX_AUDIO_SEC = 300;

const safeFile = (f) => typeof f === 'string' && f.length > 0 && f.length < 160 && !/^[a-z][a-z0-9+.-]*:/i.test(f) && !f.startsWith('/') && !f.startsWith('//') && !f.includes('..') && !f.includes('\\') && !/[?#]/.test(f);

const TYPES = { opus: 'audio/ogg; codecs="opus"', ogg: 'audio/ogg', m4a: 'audio/mp4; codecs="mp4a.40.2"', mp4: 'audio/mp4', mp3: 'audio/mpeg', webm: 'audio/webm; codecs="opus"', wav: 'audio/wav', aac: 'audio/aac' };
export const mimeFor = (file, hint) => (typeof hint === 'string' && hint ? hint : TYPES[String(file).split('.').pop().toLowerCase()] || '');

/** Manifest JSON (text or object) -> { ok, station, entries: Map(segmentId -> { id, candidates:[{file,type}], durationSec }) , errors[] }. Never throws. */
export function parseAudioManifest(input, stationId = null) {
  const errors = [];
  const entries = new Map();
  try {
    const j = typeof input === 'string' ? JSON.parse(input) : input;
    if (!j || typeof j !== 'object' || !Array.isArray(j.segments)) return { ok: false, station: null, entries, errors: ['manifest has no segments array'] };
    if (j.v !== 1) errors.push('manifest v must be 1');
    if (stationId && j.station !== stationId) return { ok: false, station: j.station || null, entries, errors: [`manifest is for "${j.station}", not "${stationId}"`] };
    for (const e of j.segments) {
      if (!e || typeof e.id !== 'string' || !e.id) { errors.push('entry without id'); continue; }
      const cands = [];
      if (safeFile(e.file)) cands.push({ file: e.file, type: mimeFor(e.file) });
      else errors.push(`${e.id}: unsafe or missing file`);
      for (const a of Array.isArray(e.alt) ? e.alt : []) if (a && safeFile(a.file)) cands.push({ file: a.file, type: mimeFor(a.file, a.type) });
      const d = Number(e.durationSec);
      if (!cands.length) continue;
      if (!(d > 0 && d <= MAX_AUDIO_SEC)) { errors.push(`${e.id}: bad durationSec`); continue; }
      entries.set(e.id, { id: e.id, candidates: cands, durationSec: d });
    }
    return { ok: entries.size > 0, station: j.station || null, entries, errors };
  } catch (e) {
    return { ok: false, station: null, entries, errors: [`unreadable manifest: ${e && e.message}`] };
  }
}

export const audioUrl = (base, stationId, file) => `${String(base).replace(/\/+$/, '')}/${encodeURIComponent(stationId)}/${String(file).split('/').map(encodeURIComponent).join('/')}`;

/**
 * Which voice airs a segment? -> 'audio' | 'tts' | 'none'
 *   entry          the manifest entry for the exact segment about to air (or null)
 *   audioDisabled  audio failed too often this session (see MAX_AUDIO_FAILS in the runner)
 *   failedIds      Set of segment ids whose recording failed to load/decode this session
 *   ttsAvailable   a speech backend exists
 */
export function chooseVoiceSource({ entry = null, audioDisabled = false, failedIds = null, ttsAvailable = false, segmentId = null } = {}) {
  if (entry && !audioDisabled && !(failedIds && failedIds.has(segmentId || entry.id))) return 'audio';
  return ttsAvailable ? 'tts' : 'none';
}

/** Audio-pack mode swaps a slot unit for its twin; returns true when the twin should be preferred for this unit. */
export const preferTwinForAudio = ({ entries, unit, slotsInAudioMode = 'twin', audioDisabled = false }) =>
  !audioDisabled && slotsInAudioMode === 'twin' && !!entries && entries.size > 0 && !!unit && unit.twins.length > 0 && entries.has(unit.twins[0].id);

/**
 * Caption timeline for a recording: the file has one duration, so each line is revealed at its estimated share of it
 * (words / 2.6 + pause). -> [{ atSec, host, text }]
 */
export function captionTimeline(lines, totalSec) {
  const L = Array.isArray(lines) ? lines.filter((l) => l && typeof l.text === 'string') : [];
  if (!L.length) return [];
  const w = L.map((l) => Math.max(0.4, (String(l.text).split(/\s+/).filter(Boolean).length) / 2.6 + (Number(l.pauseAfterMs) || 0) / 1000));
  const sum = w.reduce((a, b) => a + b, 0);
  const k = (Number.isFinite(totalSec) && totalSec > 0 ? totalSec : sum) / sum;
  let at = 0;
  return L.map((l, i) => { const o = { atSec: Math.round(at * 100) / 100, host: l.host, text: l.text }; at += w[i] * k; return o; });
}
