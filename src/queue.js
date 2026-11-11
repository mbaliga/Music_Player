// ─────────────────────────────────────────────────────────────────────────────
// queue.js — pure gapless-queue scheduler for mixtape (and album) playback.
//
// The engine decodes a WHOLE track to Float32 (about 85 MB for 4 min stereo at
// 44.1 kHz), so "decode everything up front" is out and so is a naive
// load-at-the-boundary (an audible gap, plus the previous buffer still alive).
// This model keeps memory BOUNDED and the join tight:
//
//   playing track N                              resident: N
//   ~preloadLeadSec before its end: decode N+1   resident: N + N+1   (the cap)
//   at the end: equal-power join into N+1        resident: N+1 (N freed after fade)
//
// Never more than TWO decoded tracks, and only if the budget allows
// (maxResidentBytes, estimated from the library's known durations). If the next
// track would bust the budget (e.g. a 40-minute DJ mix) the model skips the
// preload and the boundary falls back to a cold load (a short gap) rather than
// risking an out-of-memory kill. This honours docs/RADIO_ARCHITECTURE.md §4.5
// ("at most 2 songs ... release the previous").
//
// It is a pure reducer: reduce(state, event) -> { state, actions }. The host
// (mixtape-ui.js) performs the actions (decode, engine.prepareNext/joinNext,
// cold load) and feeds results back as events. No timers, no DOM, no engine.
//
// Events                                    Actions emitted
//   start    { index, bytes? }               drop-next | join (if that index is queued)
//   tick     { t, T, rate }  (every frame)   preload | join | cold | end
//   preloaded{ index, bytes }                -
//   preloadFailed { index }                  -
//   joined   {}                              -
//   stop     {}                              drop-next
//
// Actions: { type:'preload', index } | { type:'join', index, fadeSec }
//        | { type:'cold', index } | { type:'end' } | { type:'drop-next' }
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULTS = Object.freeze({
  preloadLeadSec: 40,          // start decoding the next track this long before the end
  fadeSec: 0.05,               // join overlap: a click-free "gapless" (raise for a crossfade)
  maxResidentBytes: 200e6,     // two ~4-minute stereo tracks (2 x 85 MB) plus slack
  bytesPerSec: 44100 * 2 * 4,  // stereo Float32 at 44.1 kHz (engine decode format)
  assumedDurationSec: 300,     // when a track's duration is unknown
});

/** Estimated resident bytes for track `i`. */
export function estimateBytes(state, i) {
  const d = state.durations[i];
  const sec = d > 0 && isFinite(d) ? d : state.opts.assumedDurationSec;
  return Math.ceil(sec * state.opts.bytesPerSec);
}

/**
 * playable: boolean[] (which tape slots resolve to a playable file)
 * durations: optional (number|null)[] seconds per slot (library durationSec)
 */
export function createQueue({ playable, durations = [], opts = {} } = {}) {
  const n = playable ? playable.length : 0;
  return {
    n,
    playable: playable ? playable.slice() : [],
    durations: Array.from({ length: n }, (_, i) => durations[i] ?? null),
    opts: { ...DEFAULTS, ...opts },
    cur: -1,
    curBytes: 0,
    next: -1,               // slot being / already preloaded, or -1
    nextBytes: 0,
    phase: 'idle',          // idle | preloading | ready | joining | skipped
    cold: false,            // cold fallback already requested for this boundary
    ended: false,
    failed: [],             // slots that failed to preload/decode (skipped from now on)
  };
}

/** First playable, non-failed slot after `i`, or -1. */
export function nextPlayable(state, i) {
  for (let j = i + 1; j < state.n; j++) if (state.playable[j] && !state.failed.includes(j)) return j;
  return -1;
}

const out = (state, ...actions) => ({ state, actions });

export function reduce(state, ev) {
  switch (ev.type) {
    case 'start': { // the host is (cold-)loading slot `index` as the playing track
      const i = ev.index;
      const wasQueued = state.next === i && state.phase === 'ready';
      const base = { ...state, cur: i, curBytes: ev.bytes || estimateBytes(state, i), cold: false, ended: false };
      if (wasQueued) {
        // Jumping to the very track we already decoded: join to it, no re-decode.
        return out({ ...base, next: -1, nextBytes: 0, phase: 'joining' }, { type: 'join', index: i, fadeSec: 0.02 });
      }
      const hadNext = state.next >= 0 || state.phase === 'preloading';
      return out({ ...base, next: -1, nextBytes: 0, phase: 'idle' }, ...(hadNext ? [{ type: 'drop-next' }] : []));
    }

    case 'preloaded':
      if (state.phase !== 'preloading' || state.next !== ev.index) return out(state); // stale
      return out({ ...state, phase: 'ready', nextBytes: ev.bytes || estimateBytes(state, ev.index) });

    case 'preloadFailed': {
      if (state.next !== ev.index) return out(state);
      return out({ ...state, phase: 'idle', next: -1, nextBytes: 0, failed: [...state.failed, ev.index] });
    }

    case 'joined': {
      if (state.phase !== 'joining') return out(state);
      return out({ ...state, cur: state.next >= 0 ? state.next : state.cur, curBytes: state.nextBytes || state.curBytes,
        next: -1, nextBytes: 0, phase: 'idle', cold: false });
    }

    case 'stop':
      return out({ ...state, cur: -1, curBytes: 0, next: -1, nextBytes: 0, phase: 'idle', cold: false, ended: false },
        ...(state.next >= 0 || state.phase === 'preloading' ? [{ type: 'drop-next' }] : []));

    case 'tick': {
      const { t, T, rate } = ev;
      if (state.cur < 0 || state.ended || !(T > 0.5) || state.phase === 'joining') return out(state);
      const o = state.opts;
      const remaining = T - t;
      const speed = rate > 0 ? rate : 0;
      const nxt = state.phase === 'idle' || state.phase === 'skipped' ? nextPlayable(state, state.cur) : state.next;

      // No successor: the tape ends at the runout.
      if (nxt < 0 && state.phase !== 'preloading') {
        if (remaining <= 0.05 && speed > 0) return out({ ...state, ended: true }, { type: 'end' });
        return out(state);
      }

      // Decode-ahead: start the next track inside the lead window, if memory allows.
      if (state.phase === 'idle' && remaining / Math.max(speed, 1) <= o.preloadLeadSec) {
        if (state.curBytes + estimateBytes(state, nxt) > o.maxResidentBytes) {
          return out({ ...state, phase: 'skipped', next: nxt }); // cold join at the boundary
        }
        return out({ ...state, phase: 'preloading', next: nxt }, { type: 'preload', index: nxt });
      }

      const atEnd = speed > 0 && remaining <= o.fadeSec + 0.016; // + one frame of tick jitter

      if (state.phase === 'ready' && atEnd) {
        return out({ ...state, phase: 'joining' }, { type: 'join', index: state.next, fadeSec: o.fadeSec });
      }
      // Skipped (over budget) or failed preload: cold-load at the boundary.
      if ((state.phase === 'skipped' || state.phase === 'idle') && remaining <= 0.05 && speed > 0 && !state.cold && nxt >= 0) {
        return out({ ...state, cold: true }, { type: 'cold', index: nxt });
      }
      return out(state);
    }

    default:
      return out(state);
  }
}
