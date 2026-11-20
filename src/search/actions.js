// actions.js — the `searchActions` seam. Search shows results; it does not know how to play anything. main.js (and later the Albums
// coverflow / the mixtape creator) bind these functions to the app's real behaviour with bindSearchActions({...}). Every function
// returns a Promise<boolean> (true = handled) and never throws, so an unbound or failing seam shows "can't do that here" instead
// of breaking the overlay.
//
//   playTrack(id)           load + play a library song (id = library track id)       today: library select callback in main.js
//   openAlbum(id)           show an album (its track list) on the Albums page        today: the shelf's detail sheet; T1/T2 coverflow: its focus API
//   openArtist(name)        show an artist's albums / songs                          today: the overlay's own drill-down; Albums may filter by artist
//   openMixtape(id)         open a mixtape in the Mixtapes section                   today: MixtapeUI.startPlayback
//   playStation(station)    start a radio station (a Station object, or 'type|id')   today: RadioUI.play via the existing stations flow
//   playTracks(trackIds)    play these library songs in order (artist "Play all")     today: a queue of the picked songs in main.js
//   addToMixtape(trackIds)  offer these songs to the mixtape creator                 seam for Workstream D: no binding today, the UI hides the button
//
// `has(name)` tells the UI whether a seam is bound (so it can hide an action that has no behaviour yet).
export const ACTION_NAMES = Object.freeze(['playTrack', 'openAlbum', 'openArtist', 'openMixtape', 'playStation', 'addToMixtape', 'playTracks']);

export function createSearchActions(impl = {}) {
  const bound = {};
  const api = {
    bind(more = {}) {
      for (const n of ACTION_NAMES) if (typeof more[n] === 'function') bound[n] = more[n];
      return api;
    },
    has: (n) => typeof bound[n] === 'function',
    names: ACTION_NAMES,
  };
  for (const n of ACTION_NAMES) {
    api[n] = async (...args) => {
      const f = bound[n];
      if (typeof f !== 'function') return false;
      try { return (await f(...args)) !== false; } catch (e) { try { console.error('searchActions.' + n, e); } catch { /* */ } return false; }
    };
  }
  return api.bind(impl);
}

/** The shared instance the app binds in main.js and the overlay calls. */
export const searchActions = createSearchActions();
export const bindSearchActions = (impl) => searchActions.bind(impl);
