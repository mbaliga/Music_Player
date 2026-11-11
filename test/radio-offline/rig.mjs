import { createShowRunner } from '../../src/radio/offline/show-runner.js';
import { createOfflineContext } from '../../src/radio/offline/context.js';
import { createOfflineDirector } from '../../src/radio/offline/director.js';
import { createTemplateWriter } from '../../src/radio/offline/writer.js';
import { createSystemVoice, webSpeechBackend } from '../../src/radio/offline/voice.js';
import { createDuckController } from '../../src/radio/offline/ducking.js';
import { emptyHistory, recordPlay } from '../../src/radio/offline/play-history.js';
import { fakeTime, FakeSynth, FakeUtterance, VOICES, fakeLibrary, fakePlayer, fakeParam } from './helpers.mjs';

/** A complete offline station on virtual time: real runner/context/director/writer/voice/duck, fake synth + player. */
export async function rig({ n = 12, tracks, mode = 'normal', voices = VOICES, failLoad, failDecode, loadMs = 0, seed = 1, history = true, location = null, startMs } = {}) {
  const time = fakeTime(startMs);
  const lib = tracks || fakeLibrary(n);
  const player = fakePlayer(time, { failLoad: failLoad || new Set(), failDecode: failDecode || new Set(), loadMs });
  const synth = new FakeSynth(time, { voices, mode });
  const voice = createSystemVoice({ backends: [webSpeechBackend({ synth, Utterance: FakeUtterance, timers: time.timers })], timers: time.timers, now: time.now });
  let hist = history ? emptyHistory() : null;
  const context = createOfflineContext({ getTracks: () => lib, getHistory: () => hist, getLocation: () => location, utcOffsetMin: 0, seed });
  const director = createOfflineDirector({ seed });
  const writer = createTemplateWriter({ seed });
  const param = fakeParam(1);
  const duck = createDuckController({ param, now: () => time.now() / 1000 });
  const events = [];
  let memory = { schemaVersion: 1, persona: undefined, recentShows: [], listenerNotes: [] };
  const runner = createShowRunner({
    now: time.now, timers: time.timers, context, director, writer, voice, player, duck, seed, utcOffsetMin: 0, tickMs: 250,
    getTrack: (id) => lib.find((t) => t.id === id) || null, emit: (e) => events.push(e),
    getHistory: () => hist, setHistory: (h) => { hist = h; }, getMemory: () => memory, setMemory: (m) => { memory = m; },
  });
  const initP = voice.init();
  if (!voices.length) await time.advance(2000); // an empty voice list waits briefly for a late one
  await initP;
  return { time, lib, player, synth, voice, context, director, writer, param, duck, events, runner, get history() { return hist; }, get memory() { return memory; } };
}
