// ─────────────────────────────────────────────────────────────────────────────
// director.js — the OFFLINE Director: a rule-based rundown planner behind the core's Director seam.
//
//     plan({ snapshot, wantSlots, nowMs }) -> raw Rundown JSON          (same as FakeDirector / the cloud Director)
//
// The device never trusts a Director, this one included: the output goes through repairRundown like any other.
// Rules (deterministic per snapshot + call counter):
//   • the very first plan opens with a station ID, then the sign-on welcome (spoken over the first song), then songs
//   • music is roughly three quarters of the time: units of song / talk-over-intro+song / song+break / song+back-sell
//   • each break gets a PURPOSE the writer understands (time, trivia, you, sun, holiday, banter, chat, back_sell), and only
//     purposes whose facts exist; weather and traffic are never planned (the offline context reports them down)
//   • song constraints carry an energy arc by daypart (the song selector scores it when tracks have energy)
// ─────────────────────────────────────────────────────────────────────────────

import { mulberry32, hashSeed } from '../core/util.js';

const ARC = {
  early_morning: [0.3, 0.4, 0.5], morning: [0.4, 0.55, 0.7], midday: [0.6, 0.65, 0.6], afternoon: [0.55, 0.65, 0.6],
  evening: [0.55, 0.5, 0.4], late_night: [0.3, 0.25, 0.3],
};

const UNITS = [['song'], ['over', 'song'], ['song', 'break'], ['song'], ['over', 'song'], ['song', 'back_sell'], ['song', 'break'], ['over', 'song'], ['song'], ['song', 'break']];
const PURPOSES = ['time', 'trivia', 'banter', 'you', 'trivia', 'chat', 'sun', 'banter', 'holiday', 'time', 'you', 'trivia'];
const KIND_SEC = { song: 200, talk_over_intro: 12, talk_break: 40, back_sell: 16, station_id: 6, sign_on: 20 };

export function createOfflineDirector({ seed = 1 } = {}) {
  const calls = [];
  let seq = 0, unit = 0, purposeIx = 0;

  function purposeFacts(snapshot, purpose) {
    const ids = new Set((snapshot.facts || []).map((f) => f.id));
    const pick = (...want) => want.filter((id) => ids.has(id));
    switch (purpose) {
      case 'time': return pick('time.weekday');
      case 'trivia': return pick('lib.counts', 'lib.recent', 'lib.longest', 'lib.artist', 'lib.genre');
      case 'you': return pick('hist.top', 'hist.total', 'hist.first');
      case 'sun': return pick('sun.rise', 'sun.set', 'sun.polar');
      case 'holiday': return pick('holiday.today', 'season.now');
      default: return [];
    }
  }
  const available = (snapshot, purpose) => ['banter', 'chat', 'back_sell'].includes(purpose) || purposeFacts(snapshot, purpose).length > 0;

  return {
    name: 'offline-director',
    calls,
    async plan({ snapshot, wantSlots = 8, nowMs = 0 } = {}) {
      const rng = mulberry32(hashSeed(`odir|${seed}|${unit}|${snapshot.snapshotId}`));
      const arc = ARC[snapshot.time.daypart] || ARC.afternoon;
      const slots = [];
      const first = seq === 0;
      const id = () => `o${seq++}`;
      if (first) {
        slots.push({ slotId: id(), kind: 'station_id', targetSec: KIND_SEC.station_id, talk: { budgetSec: 6, purpose: 'station_id', factIds: [] } });
        slots.push({ slotId: id(), kind: 'sign_on', targetSec: KIND_SEC.sign_on, talk: { budgetSec: 14, purpose: 'sign_on', factIds: purposeFacts(snapshot, 'holiday').concat(purposeFacts(snapshot, 'you').filter((x) => x === 'hist.first')), mood: 'warm', mode: 'over_intro' } });
        slots.push({ slotId: id(), kind: 'song', targetSec: KIND_SEC.song, song: { constraints: { energy: arc[0] }, trackIdHint: null } });
      }
      let songs = slots.filter((s) => s.kind === 'song').length;
      const songSlot = () => ({ slotId: id(), kind: 'song', targetSec: KIND_SEC.song, song: { constraints: { energy: Math.round(Math.min(1, Math.max(0, arc[songs++ % arc.length] + (rng() - 0.5) * 0.2)) * 100) / 100 }, trackIdHint: null } });
      let guard = 0;
      while (slots.filter((s) => s.kind !== 'talk_over_intro').length < wantSlots && guard++ < 200) {
        const u = UNITS[(unit++ + Math.floor(rng() * 3)) % UNITS.length];
        for (const k of u) {
          if (k === 'song') slots.push(songSlot());
          else if (k === 'over') slots.push({ slotId: id(), kind: 'talk_over_intro', targetSec: KIND_SEC.talk_over_intro, talk: { budgetSec: 10, purpose: 'intro', factIds: [], mode: 'over_intro', mood: 'warm' } });
          else if (k === 'back_sell') slots.push({ slotId: id(), kind: 'back_sell', targetSec: KIND_SEC.back_sell, talk: { budgetSec: 12, purpose: 'back_sell', factIds: [], mood: 'warm' } });
          else {
            let p = PURPOSES[purposeIx++ % PURPOSES.length], tries = 0;
            while (!available(snapshot, p) && tries++ < PURPOSES.length) p = PURPOSES[purposeIx++ % PURPOSES.length];
            slots.push({ slotId: id(), kind: 'talk_break', targetSec: KIND_SEC.talk_break, talk: { budgetSec: 30, purpose: p, factIds: purposeFacts(snapshot, p), mood: p === 'banter' ? 'wry' : 'warm', mode: 'between_songs' } });
          }
        }
        // never end a unit on an overlay
        if (slots[slots.length - 1].kind === 'talk_over_intro') slots.push(songSlot());
      }
      const real = slots.filter((s) => s.kind !== 'talk_over_intro').reduce((a, s) => a + s.targetSec, 0);
      calls.push({ method: 'plan', atMs: nowMs, count: slots.length });
      if (calls.length > 100) calls.shift();
      return {
        schemaVersion: 1, rundownId: `offline-rd-${calls.length}`, snapshotId: snapshot.snapshotId, horizonSec: real,
        showSeed: { theme: `${snapshot.time.daypart.replace('_', ' ')} on the shelf`, moodArc: ['warm', 'wry'], runningGag: null, callbackFromMemory: null },
        slots: slots.slice(0, 12),
      };
    },
  };
}
