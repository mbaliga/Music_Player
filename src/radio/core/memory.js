// ─────────────────────────────────────────────────────────────────────────────
// memory.js — station memory, anti-repeat, listener notes (architecture 7.3).
//
// Lives only on the device. Immutable helpers: every function returns a new memory.
//   • recentShows (<= 7): themes, signature lines, track ids -> anti-repeat
//   • listenerNotes (<= 20): short, EXPIRING (default 7 days), from callers or the user
//   • compactSummary: what the Writer/Director see — never the raw log
//   • viewMemory / forgetNote / forgetShow / forgetAll: the Settings "view and forget" surface
//   • notes from distress/abuse calls are never recorded; text is sanitised, PII- and
//     injection-scanned before it can be stored (it comes from a microphone)
// Persistence is injected (anything with getItem/setItem) and fully try/caught.
// ─────────────────────────────────────────────────────────────────────────────

import { validateStationMemory, LIMITS } from './schemas.js';
import { sanitizeText, scanInjection } from './untrusted.js';
import { piiScan } from './grounding.js';
import { hashSeed, mulberry32, normText } from './util.js';

export const MEMORY_KEY = 'runout.radio.ai.memory.v1';
export const NOTE_TTL_MS = 7 * 24 * 3600 * 1000;
const MAX_LINES_PER_SHOW = 40;

export const emptyMemory = (persona) => ({ schemaVersion: 1, persona: persona || undefined, recentShows: [], listenerNotes: [] });

const iso = (ms) => new Date(ms).toISOString();

/** -> {memory, added, reason?} ; reasons: not_recorded_safety | empty | pii | injection | duplicate */
export function addListenerNote(mem, { text, source = 'caller', nowMs, ttlMs = NOTE_TTL_MS, safety = 'ok' }) {
  if (safety !== 'ok') return { memory: mem, added: false, reason: 'not_recorded_safety' };
  const t = sanitizeText(text, { max: LIMITS.maxListenerNoteChars });
  if (!t) return { memory: mem, added: false, reason: 'empty' };
  if (piiScan(t).length) return { memory: mem, added: false, reason: 'pii' };
  if (scanInjection(t).length) return { memory: mem, added: false, reason: 'injection' };
  const notes = pruneExpired(mem, nowMs).listenerNotes;
  if (notes.some((n) => normText(n.text) === normText(t))) return { memory: mem, added: false, reason: 'duplicate' };
  const note = { id: `n${hashSeed(`${t}|${nowMs}`).toString(36)}`, text: t, source: source === 'user_set' ? 'user_set' : 'caller', at: iso(nowMs), expiresAt: iso(nowMs + ttlMs) };
  return { memory: { ...mem, listenerNotes: [...notes, note].slice(-LIMITS.maxListenerNotes) }, added: true };
}

export function pruneExpired(mem, nowMs) {
  return { ...mem, listenerNotes: (mem.listenerNotes || []).filter((n) => !n.expiresAt || Date.parse(n.expiresAt) > nowMs) };
}

/** Newest first, max 7 shows; lines/themes/tracks bounded. */
export function recordShow(mem, { date, themes = [], lines = [], trackIds = [] }) {
  const show = {
    date: sanitizeText(date, { max: 40 }),
    themes: themes.map((x) => sanitizeText(x, { max: 80 })).filter(Boolean).slice(0, 10),
    lines: lines.map((x) => sanitizeText(x, { max: 160 })).filter(Boolean).slice(0, MAX_LINES_PER_SHOW),
    trackIds: trackIds.filter((x) => typeof x === 'string').slice(0, 200),
  };
  const rest = (mem.recentShows || []).filter((s) => s.date !== show.date);
  return { ...mem, recentShows: [show, ...rest].slice(0, LIMITS.maxRecentShows) };
}

export const recentLines = (mem) => (mem.recentShows || []).flatMap((s) => s.lines || []);
export const recentTrackIds = (mem) => [...new Set((mem.recentShows || []).flatMap((s) => s.trackIds || []))];

const words = (s) => new Set(normText(s).split(' ').filter(Boolean));
/** Has this signature line (or a near-copy, Jaccard >= 0.8) been used in a recent show? */
export function isRepeatLine(mem, line) {
  const a = words(line);
  if (!a.size) return false;
  return recentLines(mem).some((l) => {
    const b = words(l);
    let inter = 0;
    for (const w of a) if (b.has(w)) inter++;
    return inter / (a.size + b.size - inter) >= 0.8;
  });
}

/** What the model sees: compact, never the raw log. */
export function compactSummary(mem, nowMs) {
  const m = pruneExpired(mem, nowMs);
  const p = m.persona || {};
  return {
    persona: { stationName: p.stationName, rjName: p.rjName, voiceId: p.voiceId, banned: p.banned || [] },
    recentThemes: [...new Set((m.recentShows || []).flatMap((s) => s.themes || []))].slice(0, 10),
    avoidLines: recentLines(m).slice(0, 12),
    notes: m.listenerNotes.slice(-5).map((n) => n.text),
  };
}

/** Continuity rule: callbacks are deliberate and rare. Returns a note text or null (deterministic per seed). */
export function pickCallback(mem, nowMs, seed = 0, chance = 0.25) {
  const notes = pruneExpired(mem, nowMs).listenerNotes;
  if (!notes.length) return null;
  const r = mulberry32(hashSeed(`cb|${seed}`));
  if (r() >= chance) return null;
  return notes[Math.floor(r() * notes.length)].text;
}

/** Settings view: everything stored, readable. */
export function viewMemory(mem, nowMs) {
  const rows = [];
  for (const s of mem.recentShows || []) rows.push({ kind: 'show', id: s.date, label: `Show ${s.date}`, detail: `${(s.themes || []).join(', ') || 'no themes'}; ${(s.lines || []).length} signature line(s); ${(s.trackIds || []).length} track(s)` });
  for (const n of pruneExpired(mem, nowMs).listenerNotes) rows.push({ kind: 'note', id: n.id, label: n.text, detail: `${n.source}, expires ${n.expiresAt || 'never'}` });
  return rows;
}

export const forgetNote = (mem, id) => ({ ...mem, listenerNotes: (mem.listenerNotes || []).filter((n) => n.id !== id) });
export const forgetShow = (mem, date) => ({ ...mem, recentShows: (mem.recentShows || []).filter((s) => s.date !== date) });
/** "Forget everything": all shows and notes. The station persona (not user data) stays. */
export const forgetAll = (mem) => emptyMemory(mem.persona);

// ── persistence (injected storage, never throws) ─────────────────────────────

export function loadMemory(storage, persona) {
  try {
    const j = JSON.parse(storage.getItem(MEMORY_KEY));
    const v = validateStationMemory(j);
    if (!v.ok) return emptyMemory(persona);
    return { ...j, persona: j.persona || persona };
  } catch { return emptyMemory(persona); }
}
export function saveMemory(storage, mem) {
  try { storage.setItem(MEMORY_KEY, JSON.stringify(mem)); return true; } catch { return false; }
}
