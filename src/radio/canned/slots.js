// ─────────────────────────────────────────────────────────────────────────────
// slots.js — fill {prevTitle} {prevArtist} {nextTitle} {nextArtist} {album} from the owner's library metadata, and fall
// back to the slot-free twin whenever any slot a segment needs is empty or not worth saying aloud.
//
// PURE. Never throws. Reuses the offline host's pronounce.js cleaners (file-name cruft, "[Remastered]" tags, track-number
// prefixes, "Unknown Artist"), then adds the checks a canned line needs because it is READ VERBATIM inside a fixed
// sentence: no non-Latin names (system speech would mangle them and a fixed sentence cannot hedge), nothing too long,
// nothing that is only digits/symbols. The result is what the host says; `speakable()` (numbers, "&", "feat.") is applied
// later, at voice time, exactly as for You Radio.
// ─────────────────────────────────────────────────────────────────────────────

import { cleanTitle, cleanArtist, cleanAlbum, RAW_CAP } from '../offline/pronounce.js';

export const MAX_NAME_CHARS = 48;
export const MAX_NAME_WORDS = 9;

const LATIN_LETTER = /\p{Script=Latin}/u;
const ANY_LETTER = /\p{L}/gu;

/** true when every letter in the string is Latin script and there is at least one. Digits, punctuation, spaces are fine. */
export function isLatinText(s) {
  const letters = String(s ?? '').match(ANY_LETTER) || [];
  if (!letters.length) return false;
  return letters.every((ch) => LATIN_LETTER.test(ch));
}

// invisible/format characters (bidi overrides, zero-width, tags), controls, private use, and emoji: never read aloud, and a
// bidi override could reorder the caption. Emoji go to a space, the invisible ones vanish.
const INVISIBLE = /[\p{Cf}\p{Cc}\p{Co}]/gu;
const PICTO = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\u{1F1E6}-\u{1F1FF}\uFE0F\u20E3]/gu;

/** Library string -> a nameable value for one slot, or null. */
export function cleanSlotValue(slot, raw) {
  try {
    let v = null;
    // untrusted text: bound it first (the cleaners cap too), then drop invisibles and emoji so they can never be said or shown
    raw = String(raw ?? '').slice(0, RAW_CAP).replace(/\s+/g, ' ').replace(INVISIBLE, '').replace(PICTO, ' ');
    if (slot === 'prevTitle' || slot === 'nextTitle') v = cleanTitle(raw);
    else if (slot === 'prevArtist' || slot === 'nextArtist') v = cleanArtist(raw);
    else if (slot === 'album') v = cleanAlbum(raw);
    if (!v) return null;
    v = v.replace(/\s+/g, ' ').trim();
    if (!v || v.length > MAX_NAME_CHARS || (v.match(/\S+/g) || []).length > MAX_NAME_WORDS) return null;
    if (!isLatinText(v)) return null;
    if (!/[\p{L}\p{N}]/u.test(v)) return null; // symbols only ("???"); accented Latin ("Ø", "Éé") is a name, not a symbol
    if (/^[\d\s]+$/.test(v)) return null; // digits only ("1999")
    if (/\.(mp3|flac|ogg|m4a|wav|opus)\b/i.test(v) || /[_]{1}/.test(v) || /\b(?:www|http)/i.test(v)) return null; // cruft that survived cleaning
    return v;
  } catch { return null; }
}

/**
 * Slot values for one break. `ctx` = { prev, next } where each is a library-ish track { title, artist, album } or null.
 * `album` is the NEXT track's album, falling back to the previous one's (a host saying "from the album X" is about the
 * song that follows). -> { prevTitle, prevArtist, nextTitle, nextArtist, album }, each a clean string or null.
 */
export function slotValues({ prev = null, next = null } = {}) {
  const g = (o, k) => (o && typeof o === 'object' ? o[k] : null);
  return {
    prevTitle: cleanSlotValue('prevTitle', g(prev, 'title')),
    prevArtist: cleanSlotValue('prevArtist', g(prev, 'artist')),
    nextTitle: cleanSlotValue('nextTitle', g(next, 'title')),
    nextArtist: cleanSlotValue('nextArtist', g(next, 'artist')),
    album: cleanSlotValue('album', g(next, 'album')) || cleanSlotValue('album', g(prev, 'album')),
  };
}

/** Replace {slots} in one line of text. Unknown/empty slots are left out of the result by the caller's check, never blanked. */
export function fillText(text, values) {
  return String(text ?? '').replace(/\{(\w+)\}/g, (m, k) => (values && values[k] ? values[k] : m));
}

/** Every slot the segment's text needs has a value. */
export function slotsSatisfied(seg, values) {
  const need = (seg && Array.isArray(seg.usesSlots)) ? seg.usesSlots : [];
  return need.every((k) => !!(values && values[k]));
}

/**
 * Choose the variant of a unit to air and fill it.
 *   unit      from pack.units (root segment + twins)
 *   values    slotValues(...)
 *   opts.preferTwin  use the slot-free twin even when slots could be filled (audio-pack mode: the twin has the recording)
 * -> { seg, variant:'slots'|'twin'|'plain', lines:[{host,text,direction,pauseAfterMs}], estSec } or null when the unit cannot
 *    be aired at all (needs slots, has no twin).
 */
export function resolveUnit(unit, values, { preferTwin = false } = {}) {
  try {
    const root = unit.seg;
    const needs = Array.isArray(root.usesSlots) && root.usesSlots.length > 0;
    if (!needs) return { seg: root, variant: 'plain', lines: root.lines.map((l) => ({ ...l })), estSec: root.estSec };
    const twin = unit.twins && unit.twins[0];
    if (!preferTwin && slotsSatisfied(root, values)) {
      const lines = root.lines.map((l) => ({ ...l, text: fillText(l.text, values) }));
      // a filled line must be fully filled (belt and braces: a stray token would be read aloud)
      if (!lines.some((l) => /\{\w+\}/.test(l.text))) return { seg: root, variant: 'slots', lines, estSec: estimateFilledSec(root, lines) };
    }
    if (twin) return { seg: twin, variant: 'twin', lines: twin.lines.map((l) => ({ ...l })), estSec: twin.estSec };
    return null;
  } catch { return null; }
}

/** estSec adjusted for the real length of the filled names (a long title lengthens the line). */
function estimateFilledSec(root, lines) {
  const words = lines.reduce((n, l) => n + (String(l.text).match(/\S+/g) || []).length, 0);
  const base = root.lines.reduce((n, l) => n + (String(l.text).match(/\S+/g) || []).length, 0);
  return Math.max(1, Math.round((root.estSec + (words - base) / 2.6) * 10) / 10);
}
