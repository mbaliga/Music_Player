// arbitration.js — who owns a touch: the drawer or the page under it. Pure decisions, tested in test/shell-arbitration.test.mjs.
//
// The rule (docs/SHELL.md):
//   * the drawer's grab strip is a real element ABOVE the page. A press whose x (relative to the shell) is inside the first
//     EDGE_STRIP_PX px, below the page header, belongs to the drawer; the page never sees it. The platter / tonearm / cassettes / sliders
//     only ever receive presses that start outside that strip, so a disc sitting near the left edge keeps all of its gestures.
//   * the other way round: while a page gesture is live (platter scrub, tonearm seek, pinch, a second finger down) the drawer cannot
//     start, and a drag already in progress is not stolen by the page.
//   * while the drawer is open the covered card is inert: every press on it is the drawer's (tap = close, drag = move).
//   * overlays above the shell (cassette player, editors, walkthrough, theme, back-of-case) swallow edge presses: drawer cannot start.
import { DRAWER } from './drawer.js';

/** Is x (px from the shell's left edge) inside the grab strip? */
export function inEdgeStrip(x, cfg = DRAWER) { return x >= 0 && x <= cfg.EDGE_STRIP_PX; }

/**
 * May a press start (or continue) a drawer gesture?
 * ctx = { open, where: 'strip'|'cover'|'page', pageGestureLive, otherPointers, overlayOpen }
 */
export function drawerMayStart(ctx) {
  if (ctx.overlayOpen) return false;
  if (ctx.pageGestureLive) return false;
  if ((ctx.otherPointers | 0) > 0) return false;
  if (ctx.open) return ctx.where === 'cover' || ctx.where === 'strip';
  return ctx.where === 'strip';
}

/** Owner of a press, for documentation and tests: 'drawer' or 'page'. */
export function owner(ctx) { return drawerMayStart(ctx) ? 'drawer' : 'page'; }
