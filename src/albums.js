// ─────────────────────────────────────────────────────────────────────────────
// albums.js — pure album model: Vinyl vs CD classification + track grouping.
//
// No DOM, no browser globals (portable like model.js; tested in
// test/albums.test.mjs). library.js feeds it plain track records and only
// does UI/file work around the result.
//
// THE RULE (decided here; see HANDOFF.md "Albums"):
//   An album is a CD if its album tag, or any folder in the track's path,
//   carries a disc label, otherwise it is a Vinyl. A disc label is the word
//   CD / Disc / Disk (any case), an optional single separator (space, ".",
//   "-", "_"), then a 1-2 digit number, standing alone as a word:
//       "CD1"  "cd 2"  "CD-3"  "Disc 2"  "Disk_1"  "Album [CD1]"  "Album (Disc 2)"
//   Optional trailing "of N" / "/N" is allowed ("Disc 1 of 2").
//   NOT a label: "CD" with no number, "Discovery", "ACD1" (no word boundary),
//   "CD123" (3 digits), a bare disc-number ID3 tag (a disc tag orders discs
//   but does not on its own make a CD: plenty of vinyl box sets have "1/2").
//   A multi-disc CD is ONE album with several discs; each disc is presented
//   as its own CD (see shelfItems).
// ─────────────────────────────────────────────────────────────────────────────

export const KIND_VINYL = 'vinyl';
export const KIND_CD = 'cd';

// Group 1 = disc number. Boundaries are explicit (not \b) so "_" counts as a
// separator: leading edge = start or non-alphanumeric; trailing = not a digit/letter.
const DISC_LABEL = /(?:^|[^a-z0-9])(?:cd|disc|disk)[\s._-]?0*(\d{1,2})(?:\s*(?:of|\/)\s*\d{1,2})?(?![a-z0-9])/i;

/** Disc number from a label found in `text`, or null. "CD 02" -> 2. */
export function discNumberFromLabel(text) {
  if (typeof text !== 'string') return null;
  const m = DISC_LABEL.exec(text);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return n >= 1 ? n : null;
}

/** Remove the disc label (and the bracket/dash debris around it) from a title. */
export function stripDiscLabel(text) {
  if (typeof text !== 'string') return '';
  // Swallow one optional opening/closing bracket around the label too.
  const re = /\s*[[(]?\s*(?<![a-z0-9])(?:cd|disc|disk)[\s._-]?0*\d{1,2}(?:\s*(?:of|\/)\s*\d{1,2})?(?![a-z0-9])\s*[\])]?/gi;
  let s = text.replace(re, ' ');
  s = s.replace(/\s+[-–—:,]\s*$/, '').replace(/^\s*[-–—:,]\s+/, '');
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Classify an album from the places a disc label can hide.
 *   input = { album?: string, folders?: string[] }   (folders: path segments, root→leaf)
 * Returns { kind, disc }: disc is the 1-based disc number for a CD, else null.
 * The album tag wins over folders; deeper folders win over shallower ones.
 */
export function classifyAlbum({ album = '', folders = [] } = {}) {
  const sources = [album, ...[...folders].reverse()];
  for (const s of sources) {
    const disc = discNumberFromLabel(s);
    if (disc != null) return { kind: KIND_CD, disc };
  }
  return { kind: KIND_VINYL, disc: null };
}

/** "/Music/Artist/Album CD1/01 x.mp3" -> ['Music','Artist','Album CD1'] */
export function foldersOf(path) {
  if (typeof path !== 'string' || !path) return [];
  const parts = path.split(/[\\/]+/).filter(Boolean);
  parts.pop(); // the file name
  return parts;
}

function naturalCmp(a, b) {
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Group tracks into albums.
 *   track = { title, artist, albumArtist?, album?, path?, ... }  (extra fields pass through)
 * The album name is the album tag; with no tag it falls back to the track's
 * parent folder (stripped of disc label), then to the title. Disc-labelled
 * variants of one album (tags "X CD1" / "X CD2", or folders) merge into ONE
 * album keyed by (artist, label-stripped name).
 *
 * Returns albums: { key, title, artist, kind, discs: [{ number, tracks }], tracks }
 *   - vinyl: one pseudo-disc (number 1); kind 'vinyl'
 *   - cd: discs sorted by number; a CD track with no number in an album that
 *     has numbered discs joins the lowest-numbered disc (1 if none).
 * Output order is stable: by artist, then title.
 */
export function groupTracks(tracks) {
  const byKey = new Map();
  for (const t of tracks) {
    const folders = foldersOf(t.path);
    const rawAlbum = (t.album && String(t.album).trim()) || folders[folders.length - 1] || t.title || '';
    const { kind, disc } = classifyAlbum({ album: rawAlbum, folders });
    const title = stripDiscLabel(rawAlbum) || rawAlbum;
    const artist = (t.albumArtist && String(t.albumArtist).trim()) || t.artist || 'Unknown Artist';
    const key = `${norm(artist)}\0${norm(title)}`;
    let a = byKey.get(key);
    if (!a) { a = { key, title, artist, isCd: false, byDisc: new Map() }; byKey.set(key, a); }
    // Any labelled member makes the whole album a CD (tags often label only some tracks).
    if (kind === KIND_CD) a.isCd = true;
    const d = kind === KIND_CD ? disc : null;
    if (!a.byDisc.has(d)) a.byDisc.set(d, []);
    a.byDisc.get(d).push(t);
  }

  const out = [];
  for (const a of byKey.values()) {
    const sortTracks = (arr) => arr.sort((x, y) =>
      naturalCmp(x.path || x.title || '', y.path || y.title || ''));
    let discs;
    if (a.isCd) {
      const nums = [...a.byDisc.keys()].filter((n) => n != null).sort((x, y) => x - y);
      const home = nums.length ? nums[0] : 1;
      const merged = new Map();
      for (const [n, arr] of a.byDisc) {
        const k = n == null ? home : n;
        merged.set(k, (merged.get(k) || []).concat(arr));
      }
      discs = [...merged.entries()].sort((x, y) => x[0] - y[0])
        .map(([number, arr]) => ({ number, tracks: sortTracks(arr) }));
    } else {
      discs = [{ number: 1, tracks: sortTracks([...a.byDisc.values()].flat()) }];
    }
    out.push({
      key: a.key, title: a.title, artist: a.artist,
      kind: a.isCd ? KIND_CD : KIND_VINYL,
      discs, tracks: discs.flatMap((d) => d.tracks),
    });
  }
  out.sort((x, y) => naturalCmp(x.artist, y.artist) || naturalCmp(x.title, y.title));
  return out;
}

/**
 * What the shelf shows: a vinyl is one item; a CD album is one item PER DISC
 * (multi-disc = several CDs). `label` is e.g. "Title" for vinyl / single-disc
 * CD, "Title · CD 2" for a disc of a multi-disc set.
 */
export function shelfItems(albums) {
  const items = [];
  for (const a of albums) {
    if (a.kind === KIND_VINYL) {
      items.push({ id: a.key, kind: KIND_VINYL, label: a.title, album: a, disc: null, tracks: a.tracks });
      continue;
    }
    const multi = a.discs.length > 1;
    for (const d of a.discs) {
      items.push({
        id: `${a.key}\0cd${d.number}`, kind: KIND_CD,
        label: multi ? `${a.title} · CD ${d.number}` : a.title,
        album: a, disc: d.number, tracks: d.tracks,
      });
    }
  }
  return items;
}
