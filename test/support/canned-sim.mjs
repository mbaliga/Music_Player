// Virtual-clock simulation of a canned show through the PURE chooser (no audio, no timers): songs back to back, one plan per
// song, breaks committed at their planned start. Used by the chooser tests and the long-show test.
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePack } from '../../src/radio/canned/pack.js';
import { createChooser } from '../../src/radio/canned/chooser.js';
import { slotValues } from '../../src/radio/canned/slots.js';
import { mulberry32 } from '../../src/radio/core/util.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const STATION_IDS = ['static-city-98-1', 'kilo-hertz-rock-102-7', 'meridian-91-5', 'tape-hiss-fm', 'sunbelt-soul-1060', 'pirate-1400'];
export const loadPackFile = (id) => { const r = parsePack(readFileSync(resolve(root, 'content/stations', `${id}.json`), 'utf8')); if (!r.ok) throw new Error(`${id}: ${r.errors.join('; ')}`); return r.pack; };

export const LIB = Array.from({ length: 40 }, (_, i) => ({
  id: `t${i}`, title: ['Harbor Lights', 'Paper Moon', 'Slow Window', 'Copper Rain', 'Static Orchard', 'Salt and Ember', 'Night Shift', 'Low Tide'][i % 8] + (i >= 8 ? ` ${Math.floor(i / 8) + 1}` : ''),
  artist: ['Mara Quill', 'The Velvet Lanterns', 'Low Tide Orchestra', 'June Parlor'][i % 4], album: `Album ${String.fromCharCode(65 + (i % 5))}`, durationSec: 150 + ((i * 37) % 120),
}));

/**
 * -> { songs:[{startSec,durationSec,track}], breaks:[{plan, startSec, durSec, kind, unit, variant}], silences:[why], totalSec, chooser }
 * `actual(est, rng)` maps an estimate to the "measured" length (default est * 0.85..1.25).
 */
export function simulate(pack, { hours = 3, seed = 1, lib = LIB, cadence = {}, preferTwin = false, actual = null, withBookends = true, sparse = null } = {}) {
  const ch = createChooser(pack, { seed, cadence, preferTwin });
  const rng = mulberry32(seed * 7919 + 13);
  const act = actual || ((est) => Math.max(1, est * (0.85 + 0.4 * rng())));
  const songs = [], breaks = [], silences = [];
  let t = 0, i = 0;
  const end = hours * 3600;
  while (t < end) {
    const track = lib[i % lib.length], next = lib[(i + 1) % lib.length];
    const d = track.durationSec;
    songs.push({ startSec: t, durationSec: d, track });
    if (i === 0 && withBookends) {
      const so = ch.planSignOn({ values: slotValues({ next: track }), songDurSec: d });
      if (so.type === 'talk') { const dd = act(so.estSec); ch.commit(so, { startedSec: t + 0.4, durSec: dd }); breaks.push({ plan: so, startSec: t + 0.4, durSec: dd, kind: 'sign_on', unit: so.unit.id, variant: so.resolved.variant, resolved: so.resolved }); }
    }
    const values = slotValues({ prev: track, next: sparse ? sparse(next, i) : next });
    const plan = ch.plan({ nowSec: t, songStartSec: t, songDurSec: d, values });
    if (plan.type === 'talk') {
      const dd = act(plan.estSec), s = t + plan.startAtSec;
      ch.commit(plan, { startedSec: s, durSec: dd });
      breaks.push({ plan, startSec: s, durSec: dd, kind: plan.unit.kind, unit: plan.unit.id, variant: plan.resolved.variant, resolved: plan.resolved });
    } else silences.push(plan.why);
    t += d; i++;
  }
  if (withBookends) {
    const off = ch.planSignOff({ values: slotValues({ prev: lib[(i - 1) % lib.length] }) });
    if (off.type === 'talk') { const dd = act(off.estSec); ch.commit(off, { startedSec: t - dd - 2, durSec: dd }); breaks.push({ plan: off, startSec: t - dd - 2, durSec: dd, kind: 'sign_off', unit: off.unit.id, variant: off.resolved.variant, resolved: off.resolved }); }
  }
  return { songs, breaks, silences, totalSec: t, chooser: ch };
}

export const talkShare = (sim, from = 0, to = sim.totalSec) => {
  let talk = 0;
  for (const b of sim.breaks) { const a = Math.max(b.startSec, from), z = Math.min(b.startSec + b.durSec, to); if (z > a) talk += z - a; }
  return talk / (to - from);
};
