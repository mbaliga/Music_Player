// ─────────────────────────────────────────────────────────────────────────────
// turn-taking.js — the live-call state machine (architecture 8.4).
//
//   IDLE -> THINKING (greeting) -> SPEAKING -> LISTENING -> THINKING -> SPEAKING ...
//                                   SPEAKING --barge-in--> INTERRUPTED -> LISTENING
//
// Pure reducer: step(state, event) -> {state, effects[], trace[]}. Events carry a
// timestamp `at` (ms, any monotonic origin); VAD/STT/TTS/LLM adapters feed events in
// and execute the effects. No timers: time only advances through `tick` events (the
// adapter sends one every ~50 ms), so a scripted event list is a complete test.
//
// Modes: 'full_duplex' (headphones: VAD barge-in), 'half_duplex' (mic closed while
// the RJ speaks), 'push_to_talk' (speaker without proven AEC; the button is the VAD).
//
// Events:  start{direction} vad_onset vad_offset tick ptt_down ptt_up
//          transcript_interim{text} transcript_final{text, confidence}
//          llm_first_chunk tts_audio_start tts_progress{spokenChars} tts_done
//          route_change{headphones} safety{label} connection_lost mic_denied end
// Effects: mic{open} start_llm{text|greeting} finalize_stt cancel_tts cancel_llm
//          duck_voice{db,ms} restore_voice record_interrupt{spokenChars}
//          play_backchannel say_canned{id} wrap_up_line set_mode{mode}
//          drop_bit end_call{reason}
// ─────────────────────────────────────────────────────────────────────────────

export const PHASES = Object.freeze(['idle', 'listening', 'thinking', 'speaking', 'interrupted', 'ended']);
export const MODES = Object.freeze(['full_duplex', 'half_duplex', 'push_to_talk']);

export const DEFAULTS = Object.freeze({
  mode: 'push_to_talk',
  autoMode: true,               // route_change picks full_duplex on headphones, push_to_talk on speaker
  hangoverMs: 300,              // endpointing
  bargeConfirmMs: 300,          // speech this long over the RJ = real barge-in; shorter = cough, restore
  bargeDuckDb: -18, bargeDuckMs: 80,
  maxListenerTurnMs: 40000,     // 30–45 s
  maxCallMs: 180000,            // 3 min
  wrapUpFraction: 0.8,
  sttMinConfidence: 0.5,
  backchannelAfterMs: 1400, backchannelCooldownTurns: 3,
});

export function createCall(config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  if (!MODES.includes(cfg.mode)) cfg.mode = DEFAULTS.mode;
  return {
    cfg, phase: 'idle', mode: cfg.mode, direction: null,
    startedAt: null, turn: 0,
    speech: { active: false, onsetAt: null, offsetAt: null, turnStartAt: null },
    endOfSpeechAt: null, firstChunkAt: null, interim: '',
    speaking: { startedAt: null, spokenChars: 0, bargeOnsetAt: null, canned: false },
    repeatsAsked: 0, abuseWarnings: 0, wrapUpSaid: false, endAfterSpeech: null,
    backchannelTurn: -Infinity, backchannelPlayedThisTurn: false,
    turns: [], // [{turn, endOfSpeechAt, firstAudioAt, latencyMs, interrupted}]
    endReason: null,
  };
}

const T = (state, patch) => ({ ...state, ...patch });
const stopped = (s) => s.phase === 'ended' || s.phase === 'idle';

function toListening(s, at, effects) {
  effects.push(s.mode === 'push_to_talk' ? { type: 'mic', open: false } : { type: 'mic', open: true });
  return T(s, { phase: 'listening', speech: { active: false, onsetAt: null, offsetAt: null, turnStartAt: null }, endOfSpeechAt: null, firstChunkAt: null, interim: '', speaking: { startedAt: null, spokenChars: 0, bargeOnsetAt: null, canned: false } });
}

function endCall(s, reason, effects, extra = []) {
  effects.push(...extra, { type: 'end_call', reason });
  return T(s, { phase: 'ended', endReason: reason, speech: { active: false, onsetAt: null, offsetAt: null, turnStartAt: null } });
}

function endpoint(s, at, effects, speechEndAt, forced = false) {
  effects.push({ type: 'mic', open: s.mode !== 'push_to_talk' }, { type: 'finalize_stt', forced });
  return T(s, { phase: 'thinking', endOfSpeechAt: speechEndAt, firstChunkAt: null, backchannelPlayedThisTurn: false, speech: { ...s.speech, active: false } });
}

function bargeIn(s, at, effects, trace) {
  effects.push({ type: 'cancel_tts' }, { type: 'cancel_llm' }, { type: 'record_interrupt', spokenChars: s.speaking.spokenChars });
  trace.push('interrupted');
  const turns = [...s.turns];
  if (turns.length && turns[turns.length - 1].firstAudioAt != null && turns[turns.length - 1].interrupted !== true) turns[turns.length - 1] = { ...turns[turns.length - 1], interrupted: true, spokenChars: s.speaking.spokenChars };
  const onset = s.speaking.bargeOnsetAt ?? at;
  const next = toListening(T(s, { turns, endAfterSpeech: null }), at, effects);
  trace.push('listening');
  return T(next, { speech: { active: true, onsetAt: onset, offsetAt: null, turnStartAt: onset } });
}

/** step(state, event) -> {state, effects, trace} ; never throws, ignores unknown/late events. */
export function step(state, event) {
  const effects = [];
  const trace = [state.phase];
  let s = state;
  try {
    const at = Number.isFinite(event && event.at) ? event.at : (s.startedAt ?? 0);
    const cfg = s.cfg;
    const type = event && event.type;
    if (s.phase === 'ended') return { state: s, effects, trace };

    switch (type) {
      case 'start': {
        if (s.phase !== 'idle') break;
        s = T(s, { phase: 'thinking', startedAt: at, direction: event.direction || 'listener_calls_station', endOfSpeechAt: at });
        effects.push({ type: 'start_llm', greeting: true });
        break;
      }
      case 'route_change': {
        if (cfg.autoMode) {
          const mode = event.headphones ? 'full_duplex' : 'push_to_talk';
          if (mode !== s.mode) {
            s = T(s, { mode });
            effects.push({ type: 'set_mode', mode });
            if (s.phase === 'listening') effects.push({ type: 'mic', open: mode !== 'push_to_talk' });
          }
        }
        break;
      }
      case 'mic_denied': s = endCall(s, 'mic_denied', effects); break;
      case 'connection_lost':
        s = endCall(s, 'dropped', effects, [{ type: 'cancel_tts' }, { type: 'cancel_llm' }, { type: 'say_canned', id: 'we_lost_you', local: true }]);
        break;
      case 'end': s = endCall(s, 'hangup', effects, [{ type: 'cancel_tts' }, { type: 'cancel_llm' }]); break;

      case 'vad_onset': {
        if (s.mode === 'push_to_talk') break; // the button is the VAD
        if (s.phase === 'listening') s = T(s, { speech: { active: true, onsetAt: at, offsetAt: null, turnStartAt: s.speech.turnStartAt ?? at } });
        else if (s.phase === 'speaking' && s.mode === 'full_duplex' && s.speaking.bargeOnsetAt === null) {
          s = T(s, { speaking: { ...s.speaking, bargeOnsetAt: at } });
          effects.push({ type: 'duck_voice', db: cfg.bargeDuckDb, ms: cfg.bargeDuckMs });
        } else if (s.phase === 'thinking' && s.endOfSpeechAt !== null && !s.speaking.canned) {
          // they kept talking before the RJ started: take the turn back
          effects.push({ type: 'cancel_llm' });
          s = toListening(s, at, effects);
          s = T(s, { speech: { active: true, onsetAt: at, offsetAt: null, turnStartAt: at } });
        }
        break;
      }
      case 'vad_offset': {
        if (s.mode === 'push_to_talk') break;
        if (s.phase === 'listening' && s.speech.active) s = T(s, { speech: { ...s.speech, active: false, offsetAt: at } });
        else if (s.phase === 'speaking' && s.speaking.bargeOnsetAt !== null) {
          if (at - s.speaking.bargeOnsetAt >= cfg.bargeConfirmMs) s = bargeIn(s, at, effects, trace);
          else { s = T(s, { speaking: { ...s.speaking, bargeOnsetAt: null } }); effects.push({ type: 'restore_voice' }); }
        }
        break;
      }
      case 'ptt_down': {
        if (s.mode !== 'push_to_talk') break;
        if (s.phase === 'speaking') { s = bargeIn(T(s, { speaking: { ...s.speaking, bargeOnsetAt: at } }), at, effects, trace); }
        else if (s.phase === 'thinking') { effects.push({ type: 'cancel_llm' }); s = toListening(s, at, effects); s = T(s, { speech: { active: true, onsetAt: at, offsetAt: null, turnStartAt: at } }); }
        else if (s.phase === 'listening') s = T(s, { speech: { active: true, onsetAt: at, offsetAt: null, turnStartAt: s.speech.turnStartAt ?? at } });
        if (s.phase === 'listening') effects.push({ type: 'mic', open: true });
        break;
      }
      case 'ptt_up': {
        if (s.mode !== 'push_to_talk' || s.phase !== 'listening' || !s.speech.active) break;
        s = endpoint(s, at, effects, at); // released = end of speech, no hangover
        break;
      }
      case 'transcript_interim': if (s.phase === 'listening' || s.phase === 'thinking') s = T(s, { interim: String(event.text ?? '').slice(0, 2000) }); break;
      case 'transcript_final': {
        if (s.phase !== 'thinking' || s.speaking.canned) break;
        const text = String(event.text ?? '').trim();
        const conf = Number.isFinite(event.confidence) ? event.confidence : 1;
        if (!text || conf < cfg.sttMinConfidence) {
          if (s.repeatsAsked < 1) {
            effects.push({ type: 'say_canned', id: 'ask_repeat' });
            s = T(s, { repeatsAsked: 1, phase: 'speaking', speaking: { startedAt: null, spokenChars: 0, bargeOnsetAt: null, canned: true } });
          } else {
            effects.push({ type: 'say_canned', id: 'graceful_exit' });
            s = T(s, { phase: 'speaking', endAfterSpeech: 'stt_garbage', speaking: { startedAt: null, spokenChars: 0, bargeOnsetAt: null, canned: true } });
          }
        } else {
          s = T(s, { repeatsAsked: 0, turn: s.turn + 1 });
          effects.push({ type: 'start_llm', text });
        }
        break;
      }
      case 'llm_first_chunk': if (s.phase === 'thinking' && s.firstChunkAt === null) s = T(s, { firstChunkAt: at }); break;
      case 'tts_audio_start': {
        if (s.phase !== 'thinking' && !(s.phase === 'speaking' && s.speaking.startedAt === null)) break;
        const base = s.endOfSpeechAt;
        const turns = [...s.turns, { turn: s.turn, endOfSpeechAt: base, firstAudioAt: at, latencyMs: base != null ? at - base : null, interrupted: false }];
        s = T(s, { phase: 'speaking', turns, speaking: { ...s.speaking, startedAt: at, spokenChars: 0, bargeOnsetAt: null } });
        effects.push({ type: 'mic', open: s.mode === 'full_duplex' });
        break;
      }
      case 'tts_progress': if (s.phase === 'speaking') s = T(s, { speaking: { ...s.speaking, spokenChars: Math.max(0, event.spokenChars | 0) } }); break;
      case 'tts_done': {
        if (s.phase !== 'speaking') break;
        if (s.endAfterSpeech) s = endCall(s, s.endAfterSpeech, effects);
        else s = toListening(s, at, effects);
        break;
      }
      case 'safety': {
        const label = event.label;
        if (label === 'distress') effects.push({ type: 'drop_bit' });
        else if (label === 'abuse') {
          if (s.abuseWarnings < 1) { s = T(s, { abuseWarnings: 1 }); effects.push({ type: 'say_canned', id: 'abuse_warning' }); }
          else s = endCall(s, 'abuse', effects, [{ type: 'cancel_tts' }, { type: 'cancel_llm' }]);
        }
        break;
      }
      case 'tick': break;
      default: break;
    }

    // time-driven rules run after every event (including tick)
    if (s.phase !== 'ended' && s.phase !== 'idle') {
      const cfg2 = s.cfg;
      // endpointing / max listener turn
      if (s.phase === 'listening' && s.mode !== 'push_to_talk') {
        if (!s.speech.active && s.speech.offsetAt !== null && at - s.speech.offsetAt >= cfg2.hangoverMs) s = endpoint(s, at, effects, s.speech.offsetAt);
      }
      if (s.phase === 'listening' && s.speech.turnStartAt !== null && at - s.speech.turnStartAt >= cfg2.maxListenerTurnMs) {
        s = endpoint(s, at, effects, s.speech.offsetAt ?? at, true);
      }
      // barge confirmation while still talking
      if (s.phase === 'speaking' && s.speaking.bargeOnsetAt !== null && at - s.speaking.bargeOnsetAt >= cfg2.bargeConfirmMs) s = bargeIn(s, at, effects, trace);
      // backchannel masking (only while we still have no speakable chunk)
      if (s.phase === 'thinking' && s.endOfSpeechAt !== null && s.turn > 0 && s.firstChunkAt === null && !s.backchannelPlayedThisTurn
        && at - s.endOfSpeechAt >= cfg2.backchannelAfterMs && s.turn - s.backchannelTurn >= cfg2.backchannelCooldownTurns) {
        s = T(s, { backchannelPlayedThisTurn: true, backchannelTurn: s.turn });
        effects.push({ type: 'play_backchannel' });
      }
      // call length
      if (s.startedAt !== null) {
        const elapsed = at - s.startedAt;
        if (!s.wrapUpSaid && elapsed >= cfg2.maxCallMs * cfg2.wrapUpFraction) { s = T(s, { wrapUpSaid: true }); effects.push({ type: 'wrap_up_line' }); }
        if (elapsed >= cfg2.maxCallMs) s = endCall(s, 'max_duration', effects, [{ type: 'cancel_tts' }, { type: 'cancel_llm' }]);
      }
    }
    if (s.phase !== trace[trace.length - 1]) trace.push(s.phase);
  } catch (e) {
    effects.push({ type: 'end_call', reason: 'internal_error' });
    return { state: T(state, { phase: 'ended', endReason: 'internal_error' }), effects, trace: [...trace, 'ended'] };
  }
  return { state: s, effects, trace };
}

/** Feed a scripted list of events; returns {state, log:[{event, effects, trace}]}. */
export function replay(config, events) {
  let state = createCall(config);
  const log = [];
  for (const event of events) {
    const r = step(state, event);
    state = r.state;
    log.push({ event, effects: r.effects, trace: r.trace });
  }
  return { state, log, effects: log.flatMap((l) => l.effects) };
}
