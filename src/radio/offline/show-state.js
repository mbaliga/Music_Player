// ─────────────────────────────────────────────────────────────────────────────
// show-state.js — the pure session reducer for the offline You station.
//
//     reduceShow(state, event) -> { state, actions }
//
// Same pattern as queue.js: the host (show-runner.js) performs the actions and feeds results back as events, so
// the policy is testable with no audio, no timers and no speech. It owns the questions "what phase are we in",
// "what happens on skip / stop / a bad file / a mute voice", and nothing about WHEN things air.
//
// Phases: idle (also: stopped) -> starting -> playing;  empty (no playable library);  error.
// Events                                   Actions
//   start { tracks, speechAvailable }        begin
//   first-sound                              -
//   song-started { slotId, trackId }         -
//   skip                                     cancel-speech, advance
//   decode-failed { trackId }                advance (silently; 5 in a row = error, halt)
//   preload-failed { trackId }               - (counts toward the same limit; the host picks another next track)
//   speech-failed { reason } / speech-ok     notice (when speech goes off after 3 in a row)
//   voice-changed                            -
//   stop                                     cancel-speech, restore-music, drop-next, halt
//   fail { message }                         cancel-speech, restore-music, drop-next, halt
// ─────────────────────────────────────────────────────────────────────────────

export const MAX_DECODE_FAILS = 5;
export const MAX_SPEECH_FAILS = 3;

export const initialShow = () => ({
  phase: 'idle', error: null, speech: 'off', speechAvailable: false, speechFails: 0, decodeFails: 0, played: 0, skipped: 0, cur: null,
});

const out = (state, ...actions) => ({ state, actions });
const HALT = [{ type: 'cancel-speech' }, { type: 'restore-music' }, { type: 'drop-next' }, { type: 'halt' }];

export const EMPTY_MESSAGE = 'Your library has no playable songs yet. Scan your music folder in the Albums tab, then tune in again.';

export function reduceShow(state, ev) {
  switch (ev.type) {
    case 'start': {
      const base = { ...initialShow(), speechAvailable: !!ev.speechAvailable, speech: ev.speechAvailable ? 'ok' : 'off' };
      if (!(ev.tracks > 0)) return out({ ...base, phase: 'empty', error: { kind: 'empty_library', message: EMPTY_MESSAGE } });
      return out({ ...base, phase: 'starting' }, { type: 'begin' });
    }
    case 'first-sound':
      return state.phase === 'starting' ? out({ ...state, phase: 'playing' }) : out(state);
    case 'song-started':
      if (state.phase !== 'starting' && state.phase !== 'playing') return out(state);
      return out({ ...state, phase: 'playing', cur: { slotId: ev.slotId, trackId: ev.trackId }, played: state.played + 1, decodeFails: 0 });
    case 'skip':
      if (state.phase !== 'starting' && state.phase !== 'playing') return out(state);
      return out({ ...state, skipped: state.skipped + 1 }, { type: 'cancel-speech' }, { type: 'advance', why: 'skip' });
    case 'decode-failed': {
      if (state.phase !== 'starting' && state.phase !== 'playing') return out(state);
      const n = state.decodeFails + 1;
      if (n >= MAX_DECODE_FAILS) return out({ ...state, decodeFails: n, phase: 'error', error: { kind: 'nothing_playable', message: 'None of the next songs could be opened. Check that the music folder is still available, then tune in again.' } }, ...HALT);
      return out({ ...state, decodeFails: n }, { type: 'advance', why: 'decode_failed', trackId: ev.trackId });
    }
    case 'preload-failed': {
      if (state.phase !== 'starting' && state.phase !== 'playing') return out(state);
      const n = state.decodeFails + 1;
      if (n >= MAX_DECODE_FAILS) return out({ ...state, decodeFails: n, phase: 'error', error: { kind: 'nothing_playable', message: 'None of the next songs could be opened. Check that the music folder is still available, then tune in again.' } }, ...HALT);
      return out({ ...state, decodeFails: n });
    }
    case 'speech-failed': {
      if (state.speech === 'off') return out(state);
      const n = state.speechFails + 1;
      if (n >= MAX_SPEECH_FAILS) return out({ ...state, speechFails: n, speech: 'off' }, { type: 'notice', text: 'The phone’s voice is not responding, so the hosts are staying quiet. Music only.' });
      return out({ ...state, speechFails: n });
    }
    case 'speech-ok':
      return state.speechFails ? out({ ...state, speechFails: 0 }) : out(state);
    case 'voice-changed':
      return out({ ...state, speech: state.speechAvailable ? 'ok' : 'off', speechFails: 0 });
    case 'stop':
      return out({ ...state, phase: 'idle', error: null, cur: null }, ...HALT);
    case 'fail':
      return out({ ...state, phase: 'error', error: { kind: 'unavailable', message: String(ev.message || 'The station stopped unexpectedly.').slice(0, 200) } }, ...HALT);
    default:
      return out(state);
  }
}
