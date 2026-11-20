// ─────────────────────────────────────────────────────────────────────────────
// mixtape-search.js — the thin adapter that lets the mixtape picker use the global search core
// (src/search/index.js: diacritic-insensitive, ranked, typo-tolerant) behind the picker's own
// `{ buildIndex, query, browse }` shape (see mixtape-pick.js). Pure, no DOM.
//
// Songs are searched by the global core; results are mapped back to the library track objects and
// grouped by album (the album grouping and the empty-query browse stay mixtape-pick's). If the
// global core ever throws or returns nothing usable, the built-in search answers instead, so the
// picker never breaks.
// ─────────────────────────────────────────────────────────────────────────────

import { buildIndex as gBuild, query as gQuery, MAX_LIMIT } from './search/index.js';
import { defaultSearch } from './mixtape-pick.js';

export const globalSearch = Object.freeze({
  buildIndex(tracks) {
    const base = defaultSearch.buildIndex(tracks);
    let ix = null;
    try {
      const data = { tracks: base.rows.map((r, i) => ({ id: String(i), title: r.t.title, artist: r.t.artist, album: r.t.album || base.albums[r.ai].title, genre: r.t.genre, relink: !!r.t.relink })) };
      ix = gBuild(data);
    } catch { ix = null; }
    return { ...base, ix };
  },
  query(index, text, opts = {}) {
    if (!index.ix) return defaultSearch.query(index, text, opts);
    try {
      const limit = Math.min(MAX_LIMIT, opts.limit || MAX_LIMIT);
      const r = gQuery(index.ix, text, { types: ['songs'], limit });
      if (r.empty || !r.tokens.length) return defaultSearch.query(index, text, opts);   // nothing typed: browse by album
      const groups = new Map();                                                         // ai -> { rank, rows }
      r.songs.forEach((s, rank) => {
        const row = index.rows[+s.id]; if (!row) return;
        let g = groups.get(row.ai);
        if (!g) { g = { rank, rows: [] }; groups.set(row.ai, g); }
        g.rows.push(row);
      });
      const out = [...groups.entries()].sort((a, b) => a[1].rank - b[1].rank)
        .map(([ai, g]) => ({ album: { key: index.albums[ai].key, title: index.albums[ai].title, artist: index.albums[ai].artist, kind: index.albums[ai].kind, count: index.albums[ai].tracks.length },
          tracks: g.rows.sort((a, b) => a.ti - b.ti).map((x) => x.t) }));
      const total = r.counts.songs;
      return { groups: out, total, truncated: total > r.songs.length, empty: false };
    } catch { return defaultSearch.query(index, text, opts); }
  },
  browse: defaultSearch.browse,
});
