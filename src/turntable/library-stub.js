// library-stub.js — A CLEARLY MARKED STUB of the zoom-out library (`mountTurntableLibrary`), so the player works end to end until
// Workstream T2's real component (src/turntable/library.js) is wired in (one import line in main.js). It implements the agreed
// interface: mountTurntableLibrary(container, deps) -> { setAlbums, setNowPlaying, focus, getFocus, setOpacity, show, hide,
// getSlotRect, layout, on, destroy } with events focus / selectTrack / tapCover / scan / filter / sort. Plain DOM, one cover, a list.
export function mountTurntableLibrary(container, _deps = {}) {
  const root = document.createElement('div');
  root.dataset.stub = 'library';
  root.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;overflow:auto;color:#e9e9ee;font:13px system-ui,sans-serif';
  root.innerHTML = '<div class="stub-cover" style="margin-top:12%;background:linear-gradient(135deg,#6a5acd,#241a54);border-radius:2px;box-shadow:0 16px 34px rgba(0,0,0,.65);cursor:pointer"></div>'
    + '<div class="stub-title" style="margin-top:14px;font-weight:600;letter-spacing:.14em;text-transform:uppercase"></div>'
    + '<div class="stub-tools" style="margin-top:6px;display:flex;gap:8px"><button class="stub-scan" style="padding:6px 12px;border-radius:14px;border:1px solid #555;background:#1a1a22;color:#eee" id="libScan">Scan music folder…</button></div>'
    + '<ol class="stub-list" style="list-style:none;margin:10px 0 24px;padding:0 7%;width:100%;box-sizing:border-box"></ol>';
  container.append(root);
  const cover = root.querySelector('.stub-cover'), title = root.querySelector('.stub-title'), list = root.querySelector('.stub-list');
  const handlers = {};
  const emit = (e, ...a) => (handlers[e] || []).forEach((f) => f(...a));
  let albums = [], focus = 0, np = null, opacity = 0;
  const cur = () => albums[Math.round(focus)];
  function render() {
    const a = cur();
    title.textContent = a ? a.title : '';
    list.innerHTML = '';
    if (a) a.tracks.forEach((t, i) => {
      const li = document.createElement('li');
      li.style.cssText = 'padding:10px 0;border-top:1px solid rgba(255,255,255,.07);cursor:pointer;letter-spacing:.08em;text-transform:uppercase';
      li.textContent = `${i < 9 ? '0' : ''}${i + 1}  ${t.title}`;
      li.addEventListener('click', () => emit('selectTrack', a.id, i));
      list.append(li);
    });
  }
  cover.addEventListener('click', () => { const a = cur(); if (a) emit('tapCover', a.id); });
  root.querySelector('.stub-scan').addEventListener('click', () => emit('scan'));
  return {
    setAlbums(list_) { albums = list_ || []; focus = Math.min(focus, Math.max(0, albums.length - 1)); render(); },
    setNowPlaying(o) { np = o; },
    focus(i) { focus = Math.max(0, Math.min(albums.length - 1, i)); render(); emit('focus', Math.round(focus)); },
    getFocus: () => Math.round(focus),
    setOpacity(o) { opacity = o; root.style.opacity = String(o); },
    show() { root.style.display = 'flex'; }, hide() { root.style.display = 'none'; },
    getSlotRect() { return cover.getBoundingClientRect(); },
    layout({ width, height, portrait }) { const cs = Math.round(portrait ? width * 0.62 : height * 0.44); cover.style.width = cover.style.height = cs + 'px'; },
    on(e, fn) { (handlers[e] = handlers[e] || []).push(fn); },
    destroy() { root.remove(); },
    get _opacity() { return opacity; }, get _np() { return np; },
  };
}
