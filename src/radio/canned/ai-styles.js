// ─────────────────────────────────────────────────────────────────────────────
// ai-styles.js — the five AI station STYLES, as DATA (from the owner's station bibles and voice direction). PURE data.
//
// These are NOT startable yet: they depend on the cloud phase (CLOUD_AVAILABLE in policy.js is false). The dial shows them,
// greyed, only when the radio.ai flag is on. The same data will drive the real picker later, so it carries everything the
// bibles list: listening mode, daypart window, talk/music share, hosts with their persona rate/pitch/mood, and the audition
// script. Rates and pitches are multipliers on the engine's default voice (the pack format's 0.8-1.3 range). Starting guesses:
// the audition is where they get tuned (voice-direction.md section 6). Names and copy live here ONLY, so renaming is a data edit.
// ─────────────────────────────────────────────────────────────────────────────

/** Mood -> prosody multipliers for engines with no style tokens (voice-direction.md section 3). Multiply onto persona rate/pitch. */
export const MOOD_PROSODY = Object.freeze({
  neutral: { rate: 1.0, pitch: 1.0 }, warm: { rate: 0.97, pitch: 0.98 }, bright: { rate: 1.03, pitch: 1.03 }, soft: { rate: 0.93, pitch: 0.97 },
  amused: { rate: 1.0, pitch: 1.02 }, dramatic: { rate: 0.97, pitch: 1.0 }, flat: { rate: 1.0, pitch: 1.0 }, serious: { rate: 0.96, pitch: 0.97 },
});

/** Engine tiers (voice-direction.md section 1). */
export const ENGINE_TIERS = Object.freeze({
  T0: 'Flat: text only, maybe global rate/pitch (system speech)',
  T1: 'Prosodic: rate, pitch, pauses, emphasis',
  T2: 'Expressive: mood tokens, whisper, laughter',
});

/** The same ten lines for every candidate voice (voice-direction.md section 5). */
export const AUDITION_SCRIPT = Object.freeze([
  'Quarter past seven. Onward.',
  'Nineteen and clear, which is the forecast’s way of saying no excuses.',
  'You’ve come back to this record three nights running. I’ll leave it alone.',
  'Track four of eleven, and you’ve never made it past six on this one.',
  'City’s in a mood today. Jacket weather.',
  'Listeners, the legal bit: twenty-two degrees and overcast, allegedly.',
  'That’s not real, Odile.',
  'Rough weeks end. I’m not going to fix it; I’m going to play you something slow.',
  'Say that once more for me, the line’s crackling.',
  'Here’s one.',
]);

const host = (id, name, def, age, register, rate, pitch, mood, adjacent, pause, audition, flatDevice, hint) => ({ id, name, default: def, age, register, rate, pitch, mood, adjacent, pauseHabit: pause, auditionFor: audition, flatDevice, hint });

export const AI_STYLES = Object.freeze([
  {
    id: 'morning-drive', title: 'Daybreak', style: 'Morning Drive', mode: 'Getting ready, commuting, wanting to be told the time without looking.',
    tone: 'Brisk, warm, organised. The station that gets you out the door.', daypart: ['morning'], onAir: { from: 5, to: 10 }, windowNote: 'Daybreak signs off at ten.',
    talkShare: 0.28, breaksPerHour: '4-5', maxBreakSec: 40, minSilentTransitions: 2, cityWeight: 0.3,
    hosts: [
      host('nia', 'Nia Castellan', true, '30s', 'alto', 1.08, 1.0, 'bright', ['neutral', 'amused'], 'short (0-300 ms)', 'clarity at speed; dry delivery, no sing-song', 'two-clause sentences, the second shorter than the first', 'alto, slightly dry'),
      host('theo', 'Theo Marsh', false, '40s', 'baritone', 0.95, 0.9, 'warm', ['bright', 'amused'], '500 ms after the opener', 'the one-word opener must land as a sentence', 'starts breaks with a one-word sentence', 'baritone, cheerful-tired'),
    ],
  },
  {
    id: 'after-hours', title: 'The Quiet Signal', style: 'After Hours', mode: 'Late night, winding down, working late. Company that does not demand anything.',
    tone: 'Low, unhurried, kind. Thinks before speaking.', daypart: ['evening', 'night'], onAir: { from: 20, to: 4 }, windowNote: 'Best from eight in the evening to four in the morning.',
    talkShare: 0.22, breaksPerHour: '2-3', maxBreakSec: 75, minSilentTransitions: 4, cityWeight: 0.1,
    hosts: [
      host('ines', 'Ines Varga', true, '40s', 'low alto', 0.9, 0.95, 'soft', ['neutral', 'warm'], 'long (600-900 ms)', 'trailing sentence-ends without sounding cut off', 'sentences that end early, trailing into a pause', 'low alto, light non-specific European accent'),
      host('rafe', 'Rafe Oduya', false, '50s', 'bass-baritone', 0.88, 0.85, 'warm', ['soft', 'amused'], '500-800 ms', 'low register stays intelligible on a phone speaker', 'addresses the song, not the listener', 'bass-baritone'),
    ],
  },
  {
    id: 'deep-cut', title: 'KDC', style: 'The Deep Cut', mode: 'Daytime, active listening. A host who cares about your collection as much as you do.',
    tone: 'Enthusiastic nerd of the collection, not of music history.', daypart: ['day', 'evening'], onAir: { from: 10, to: 20 }, windowNote: 'Plays any time; best from ten to eight.',
    talkShare: 0.28, breaksPerHour: '3-4', maxBreakSec: 60, minSilentTransitions: 2, cityWeight: 0.2,
    hosts: [
      host('devika', 'Devika Rao', true, '30s', 'mezzo', 1.1, 1.05, 'bright', ['neutral', 'serious'], '150-300 ms', 'numbers spoken crisply: "track four of eleven"', 'every break holds exactly one count', 'mezzo, fast and precise'),
      host('marcus', 'Marcus Bell', false, '60s', 'tenor', 0.95, 0.92, 'amused', ['warm', 'neutral'], '400 ms before the half-question', 'the "... or is that just me." fall', 'starts with "Now," and ends on a half-question', 'tenor, slow burn'),
    ],
  },
  {
    id: 'town-line', title: 'Town Line', style: 'You City Radio', mode: 'The city in the room: weather, place, errands, a day at home.',
    tone: 'Community-radio friendly. Neighbourly, slightly chatty.', daypart: ['morning', 'day', 'evening', 'night'], onAir: null, windowNote: 'Any time.',
    talkShare: 0.3, breaksPerHour: '4', maxBreakSec: 60, minSilentTransitions: 2, cityWeight: 0.8,
    hosts: [
      host('hal', 'Hal Prentice', true, '50s', 'tenor', 0.95, 0.95, 'warm', ['amused', 'neutral'], '300-500 ms', 'gentle; the personified city line is not arch', 'addresses the city as a person once per break', 'tenor, unhurried'),
      host('june', 'June Okafor', false, '30s', 'mezzo', 1.05, 1.02, 'bright', ['warm', 'neutral'], '400 ms before the two-word close', 'the two-word close lands as a full stop', 'closes every break with a two-word verdict', 'mezzo, brisk and kind'),
    ],
  },
  {
    id: 'signal-pirate', title: 'Signal Pirate', style: 'Chaos with your own music', mode: 'Bits, jingles, fake ads for products that cannot exist. The game-radio feeling.',
    tone: 'Mischievous, theatrical, fast. Clearly labelled bits; real callers get sudden sincerity.', daypart: ['evening', 'night'], onAir: null, windowNote: 'Any time; best in the evening.',
    talkShare: 0.3, breaksPerHour: '5', maxBreakSec: 50, minSilentTransitions: 2, cityWeight: 0.0,
    hosts: [
      host('odile', '“Captain” Odile Faraday', true, 'indeterminate', 'mezzo', 1.2, 1.05, 'dramatic', ['amused', 'neutral'], '700 ms before the punchline', 'formal diction at speed', 'formal grammar used for absurd content', 'mezzo, rapid'),
      host('benny', 'Benny Soto', false, '20s', 'tenor', 1.0, 0.98, 'flat', ['neutral', 'amused'], '300 ms', 'deadpan that is not dead', 'three-word sentences; the straight man', 'tenor, deadpan'),
    ],
  },
]);

export const styleById = (id) => AI_STYLES.find((s) => s.id === id) || null;

/** rate/pitch for a style host in a mood (T0/T1 fallback table), clamped to the pack range. */
export function hostProsody(h, mood = null) {
  const m = MOOD_PROSODY[mood || h.mood] || MOOD_PROSODY.neutral;
  const c = (v) => Math.round(Math.min(1.3, Math.max(0.8, v)) * 100) / 100;
  return { rate: c(h.rate * m.rate), pitch: c(h.pitch * m.pitch) };
}
