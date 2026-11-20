// wire.js — creates the Search overlay lazily (the UI, the adapters and the directory client are fetched on first use; none of them is on the boot path), and binds the buttons and
// shortcuts that open it. main.js passes what only it knows (the library, the mixtape list, the radio store).
import { searchActions } from './actions.js';
import { isSearchShortcut } from './view.js';
import { loadRecents, clearRecents as clearStoredRecents } from './recents.js';

/**
 * deps = { getSources(), getCannedIndex(), storage, remember(), onOpen(), onClose() }
 * -> { open(opts), close(), toggle(), isOpen(), invalidate(), clearRecents() }
 */
export function createSearchLauncher(deps) {
  let overlay = null, loading = null, pendingInvalidate = false;
  async function ensure() {
    if (overlay) return overlay;
    if (!loading) {
      loading = Promise.all([import('./ui.js'), import('./directory.js')]).then(([m, d]) => {
        overlay = m.createSearchOverlay({ ...deps, actions: searchActions, directory: d.createDirectorySearch() });
        if (pendingInvalidate) overlay.invalidate();
        return overlay;
      });
    }
    return loading;
  }
  const api = {
    async open(opts) { const o = await ensure(); try { if (deps.prepare) await deps.prepare(); } catch { /* sources are optional */ } o.open(opts); },
    close() { if (overlay) overlay.close(); },
    async toggle() { const o = await ensure(); o.toggle(); },
    isOpen: () => !!overlay && overlay.isOpen(),
    invalidate() { if (overlay) overlay.invalidate(); else pendingInvalidate = true; },
    clearRecents() { clearStoredRecents(deps.storage); if (overlay) overlay.rememberCleared(); },
    recents: () => loadRecents(deps.storage),
  };
  // Ctrl/Cmd+K, and "/" when nothing is being typed
  document.addEventListener('keydown', (e) => {
    if (document.querySelector('.wt-overlay:not(.hidden), .theme-overlay:not(.hidden)')) return;
    if (isSearchShortcut(e, e.target)) { e.preventDefault(); api.toggle(); }
  });
  return api;
}
