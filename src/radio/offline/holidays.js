// ─────────────────────────────────────────────────────────────────────────────
// holidays.js — a deliberately small, offline table of holidays that are fixed-date and widely
// recognised. No region data (location may be absent), no moving feasts: better to say nothing
// than to wish the wrong country the wrong holiday. Extend FIXED_HOLIDAYS to add more.
// ─────────────────────────────────────────────────────────────────────────────

export const FIXED_HOLIDAYS = Object.freeze([
  { month: 1, day: 1, name: "New Year's Day", greeting: "Happy New Year's Day" },
  { month: 2, day: 14, name: "Valentine's Day", greeting: "Happy Valentine's Day" },
  { month: 10, day: 31, name: 'Halloween', greeting: 'Happy Halloween' },
  { month: 12, day: 24, name: 'Christmas Eve', greeting: 'Happy Christmas Eve' },
  { month: 12, day: 25, name: 'Christmas Day', greeting: 'Merry Christmas' },
  { month: 12, day: 31, name: "New Year's Eve", greeting: "Happy New Year's Eve" },
]);

/** -> {name, greeting} | null for a local calendar date. */
export function holidayOn(month, day) {
  const h = FIXED_HOLIDAYS.find((x) => x.month === month && x.day === day);
  return h ? { name: h.name, greeting: h.greeting } : null;
}
