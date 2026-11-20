// ─────────────────────────────────────────────────────────────────────────────
// transport.js — pure state machine of the cassette player: two sides, the AUTO
// (auto-reverse) latch, the manual FLIP key, end-of-side behaviour and wind.
// No DOM, no engine, no timers: reduce(state, event) -> { state, actions }; the host
// (mixtape-ui.js) performs the actions and feeds results back as events.
//
// State
//   side   'A' | 'B'      the side that is in the deck
//   auto   boolean        AUTO engaged: at the end of side A the deck reverses by itself
//   phase  'stopped' | 'playing' | 'paused' | 'flip' | 'end'
//            flip = side A ran out with AUTO off: stopped, showing "Flip tape", waiting for FLIP
//            end  = side B (or A with nothing on B) ran out: stopped, offers rewind
//   n      { A, B }       song counts (the host keeps them current)
//   pos    { A, B }       each side's OWN tape position { index, frac } (B is not a mirror of A)
//
// Events
//   play | pause | toggle | stop | rewind | flip
//   setAuto { on } | setCounts { A, B }
//   progress { index, frac }            the playing position inside the current side (every frame is fine)
//   changed { side, index }             the real playback moved to this song: with AUTO on, crossing
//                                       from A to B is the auto-reverse (the queue ran A then B as one run)
//   sideEnd {}                          the run ended: the queue's last song, or a wind hit the end
//   windEdge { edge: 'start'|'end' }    a wind reached an end of the tape (rewinding past the start of
//                                       side A stops; winding off the end is a side end)
//   seek { index, frac }                the host resolved a wind / skip to this position
//
// Actions
//   { type:'start', side, index, frac }   (re)load that song of the side and play
//   { type:'resume' } | { type:'pause' } | { type:'stopPlayback' }
//   { type:'flipAnim', to, reason }       'auto' | 'manual'
//   { type:'queueMode', playable }        which side(s) the gapless run may cover: 'both' | 'A' | 'B'
//   { type:'notice', text }               short deck message ('FLIP TAPE', 'END OF TAPE')
//   { type:'persistAuto', on }
// ─────────────────────────────────────────────────────────────────────────────

const other = (s) => (s === 'A' ? 'B' : 'A');
const out = (state, ...actions) => ({ state, actions });
const START = { index: 0, frac: 0 };

export function createTransport({ side = 'A', auto = true, nA = 0, nB = 0 } = {}) {
  return {
    side: side === 'B' ? 'B' : 'A', auto: !!auto, phase: 'stopped',
    n: { A: nA | 0, B: nB | 0 },
    pos: { A: { ...START }, B: { ...START } },
  };
}

/** Which songs the gapless run may cover for this state: AUTO on side A = both sides as one run, otherwise this side only. */
export function runMode(st) {
  return st.auto && st.side === 'A' && st.n.B > 0 ? 'both' : st.side;
}

const setPos = (st, side, p) => ({ ...st, pos: { ...st.pos, [side]: { index: Math.max(0, p.index | 0), frac: p.frac > 0 ? Math.min(1, p.frac) : 0 } } });

/** What the deck window should say about the state ('' = nothing special). */
export function deckMessage(st) {
  if (st.phase === 'flip') return 'FLIP TAPE';
  if (st.phase === 'end') return 'END';
  return '';
}

export function reduce(st, ev) {
  switch (ev.type) {
    case 'setCounts':
      return out({ ...st, n: { A: ev.A | 0, B: ev.B | 0 } }, { type: 'queueMode', playable: runMode({ ...st, n: { A: ev.A | 0, B: ev.B | 0 } }) });

    case 'setAuto': {
      const on = !!ev.on;
      if (on === st.auto) return out(st);
      const next = { ...st, auto: on };
      // Turning AUTO on while parked at "Flip tape" does not auto-flip: the owner pressed FLIP or nothing.
      return out(next, { type: 'persistAuto', on }, { type: 'queueMode', playable: runMode(next) });
    }

    case 'play': {
      if (st.phase === 'playing') return out(st);
      if (st.phase === 'flip') return out(st, { type: 'notice', text: 'FLIP TAPE' });
      if (st.phase === 'end') return out(st, { type: 'notice', text: 'REWIND' });
      if (st.n[st.side] === 0) return out(st, { type: 'notice', text: 'EMPTY SIDE' });
      if (st.phase === 'paused') return out({ ...st, phase: 'playing' }, { type: 'resume' });
      // a side that was left at its very end starts over from the top (the other side is untouched)
      const q = st.pos[st.side], p = q.index >= st.n[st.side] - 1 && q.frac >= 0.995 ? START : q;
      return out({ ...st, phase: 'playing', pos: { ...st.pos, [st.side]: { ...p } } }, { type: 'start', side: st.side, index: p.index, frac: p.frac });
    }
    case 'pause':
      return st.phase === 'playing' ? out({ ...st, phase: 'paused' }, { type: 'pause' }) : out(st);
    case 'toggle':
      return reduce(st, { type: st.phase === 'playing' ? 'pause' : 'play' });

    case 'stop': {
      // Like the real key: first press brakes (pause), a second press (already paused / stopped) winds to the top of the side.
      if (st.phase === 'playing') return out({ ...st, phase: 'paused' }, { type: 'pause' });
      if (st.phase === 'flip') return out(st);
      return reduce(st, { type: 'rewind' });
    }

    case 'rewind': {
      const s = setPos(st, st.side, START);
      const next = { ...s, phase: 'stopped' };
      return out(next, { type: 'stopPlayback' });
    }

    case 'flip': {
      const to = other(st.side);
      const next = { ...st, side: to, phase: 'stopped' };
      const acts = [];
      if (st.phase === 'playing' || st.phase === 'paused') acts.push({ type: 'stopPlayback' });
      acts.push({ type: 'flipAnim', to, reason: 'manual' }, { type: 'queueMode', playable: runMode(next) });
      return out(next, ...acts);
    }

    case 'progress': {
      if (st.phase === 'end' || st.phase === 'flip') return out(st);
      const p = st.pos[st.side];
      if (p.index === ev.index && Math.abs(p.frac - ev.frac) < 1e-4) return out(st);
      return out(setPos(st, st.side, ev));
    }

    case 'seek': {
      let next = setPos(st, st.side, ev);
      // winding back from the end of a side / a rewind from "END" leaves the tape ready, not playing
      if (st.phase === 'end') next = { ...next, phase: 'stopped' };
      return out(next);
    }

    case 'changed': {
      // Real playback crossed to a song on `side`. Only A -> B (AUTO's single run) changes the side.
      const side = ev.side === 'B' ? 'B' : 'A';
      let next = setPos(st, side, { index: ev.index, frac: 0 });
      if (side !== st.side) {
        // the side we leave is left at its end
        next = setPos({ ...next, side }, st.side, { index: Math.max(0, st.n[st.side] - 1), frac: 1 });
        return out(next, { type: 'flipAnim', to: side, reason: 'auto' }, { type: 'queueMode', playable: runMode(next) });
      }
      return out(next);
    }

    case 'windEdge': {
      if (ev.edge === 'start') {
        // rewinding past the start of the side stops there (never jumps to the other side)
        const next = { ...setPos(st, st.side, START), phase: 'stopped' };
        return out(next, { type: 'stopPlayback' });
      }
      return reduce(st, { type: 'sideEnd' });
    }

    case 'sideEnd': {
      if (st.phase === 'flip' || st.phase === 'end') return out(st);
      const stopA = (phase, text) => ({ ...st, phase, pos: { ...st.pos, [st.side]: { index: Math.max(0, st.n[st.side] - 1), frac: 1 } } });
      if (st.side === 'A' && st.n.B > 0) {
        if (st.auto) {
          // AUTO: reverse and carry on into side B from its own start
          const next = { ...setPos(st, 'B', START), side: 'B', phase: 'playing' };
          return out(next, { type: 'flipAnim', to: 'B', reason: 'auto' }, { type: 'start', side: 'B', index: 0, frac: 0 },
            { type: 'queueMode', playable: runMode(next) });
        }
        return out(stopA('flip'), { type: 'stopPlayback' }, { type: 'notice', text: 'FLIP TAPE' });
      }
      return out(stopA('end'), { type: 'stopPlayback' }, { type: 'notice', text: 'END' });
    }
    default:
      return out(st);
  }
}
