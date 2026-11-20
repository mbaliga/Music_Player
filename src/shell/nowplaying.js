// nowplaying.js — which source the mini bar describes, and whether to show it. Pure.
import { HOME_OF } from './sections.js';

/**
 * sources = { radio, mixtape, album } each null or { title, sub }. Only one source can own the engine at a time; if several report
 * playing (a radio session and a stale album record), radio wins, then mixtape, then album.
 * -> { source, home, title, sub } | null
 */
export function pickNowPlaying(sources) {
  for (const source of ['radio', 'mixtape', 'album']) {
    const s = sources && sources[source];
    if (s && s.title) return { source, home: HOME_OF[source], title: String(s.title), sub: s.sub ? String(s.sub) : '' };
  }
  return null;
}

/** The bar shows while something plays and you are NOT already on that source's home section. */
export function miniBarVisible(np, currentSection) { return !!np && np.home !== currentSection; }
