// pixelshift.js — burn-in protection: a slow, deterministic shift of the whole face. Pure.
// 13 positions (a ring plus the centre) walked with a stride coprime to 13: consecutive minutes never share an offset and every
// position is visited once per 13 minutes. `amp` scales the grid in px (default 3 -> at most +-3 px on each axis).
export const SHIFT_POSITIONS = 13;
export const SHIFT_STRIDE = 5;       // gcd(5, 13) = 1
const GRID = Object.freeze([[0, 0], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1], [2, 0], [0, 2], [-2, 0], [0, -2]]);

/** minuteIndex (integer minutes since any fixed epoch) -> {x, y} px offset. */
export function pixelShift(minuteIndex, amp = 3) {
  const m = Number.isFinite(minuteIndex) ? Math.floor(minuteIndex) : 0;
  const i = ((m * SHIFT_STRIDE) % SHIFT_POSITIONS + SHIFT_POSITIONS) % SHIFT_POSITIONS;
  const a = Math.max(0, Number(amp) || 0) / 2;
  return { x: Math.round(GRID[i][0] * a), y: Math.round(GRID[i][1] * a) };
}
export const minuteOf = (nowMs) => Math.floor((Number(nowMs) || 0) / 60000);
