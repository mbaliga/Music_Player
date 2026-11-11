// A complete canned station on virtual time: real runner + chooser + voice adapter + duck controller, fake synth/player/audio.
import { createCannedRunner } from '../../src/radio/canned/runner.js';
import { createSystemVoice, webSpeechBackend } from '../../src/radio/offline/voice.js';
import { createDuckController } from '../../src/radio/offline/ducking.js';
import { assignHostVoices } from '../../src/radio/canned/voices.js';
import { fakeTime, FakeSynth, FakeUtterance, VOICES, fakeLibrary, fakePlayer, fakeParam } from '../radio-offline/helpers.mjs';
import { loadPackFile } from '../support/canned-sim.mjs';

export const MANY_VOICES = [
  { name: 'Samantha', lang: 'en-US', voiceURI: 'samantha', localService: true, default: true },
  { name: 'Daniel', lang: 'en-GB', voiceURI: 'daniel', localService: true, default: false },
  { name: 'Karen', lang: 'en-AU', voiceURI: 'karen', localService: true, default: false },
  { name: 'Moira', lang: 'en-IE', voiceURI: 'moira', localService: true, default: false },
  { name: 'Alex', lang: 'en-US', voiceURI: 'alex', localService: true, default: false },
];

/** a fake <audio> backend: plays a segment for its durationSec of virtual time; modes: ok | fail | unsupported */
export function fakeAudioBackend(time, { mode = () => 'ok' } = {}) {
  const calls = [];
  let cancel = null;
  return {
    calls,
    cancel() { if (cancel) cancel(); },
    async play({ candidates, durationSec, onStart }) {
      const m = mode(candidates, calls.length);
      calls.push({ candidates, durationSec, mode: m });
      if (m === 'unsupported') return { ok: false, reason: 'unsupported' };
      if (m === 'fail') return { ok: false, reason: 'load_failed:error', tried: candidates.length };
      return new Promise((resolve) => {
        let done = false;
        const t1 = time.setTimeout(() => onStart && onStart(), 30);
        const t2 = time.setTimeout(() => { if (!done) { done = true; cancel = null; resolve({ ok: true, reason: 'done' }); } }, 30 + durationSec * 1000);
        cancel = () => { if (done) return; done = true; time.clearTimeout(t1); time.clearTimeout(t2); cancel = null; resolve({ ok: false, reason: 'cancelled' }); };
      });
    },
  };
}

export async function rig({ id = 'meridian-91-5', n = 16, tracks, mode = 'normal', voices = MANY_VOICES, failLoad, failDecode, seed = 1, audioEntries = null, audioMode, slotsInAudioMode, startMs, pack = null, cadence = {}, noSynth = false, loadMs = 0 } = {}) {
  const time = fakeTime(startMs);
  const lib = tracks || fakeLibrary(n);
  const p = pack || loadPackFile(id);
  const player = fakePlayer(time, { failLoad: failLoad || new Set(), failDecode: failDecode || new Set(), loadMs });
  const synth = noSynth ? null : new FakeSynth(time, { voices, mode });
  const voice = createSystemVoice({ backends: [webSpeechBackend({ synth, Utterance: FakeUtterance, timers: time.timers })], timers: time.timers, now: time.now });
  const param = fakeParam(1);
  const duck = createDuckController({ param, now: () => time.now() / 1000 });
  const events = [];
  let assign = { byHost: {} };
  const audio = audioEntries ? fakeAudioBackend(time, { mode: audioMode }) : null;
  const audioPack = audioEntries ? { entries: audioEntries, base: 'audio', stationId: p.id } : null;
  const runner = createCannedRunner({
    now: time.now, timers: time.timers, pack: p, voice, audio, audioPack, player, duck, seed, cadence,
    getTracks: () => lib.map((t) => ({ ...t, file: t.file || {} })), emit: (e) => events.push(e), getVoiceAssign: () => assign, slotsInAudioMode,
  });
  const initP = voice.init().then(() => { assign = assignHostVoices(p.hostList, voice.allVoices(), {}); });
  if (!voices.length) await time.advance(2000);
  await initP;
  return { time, lib, pack: p, player, synth, voice, param, duck, events, runner, audio, get assign() { return assign; } };
}
