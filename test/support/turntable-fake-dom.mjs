// Minimal DOM stand-in for the turntable library component (no jsdom in this repo): just enough of
// createElement / tree / classList / style / events for mountTurntableLibrary. Canvas contexts are null.
class FEl {
  constructor(tag, doc) {
    this.tagName = tag.toUpperCase(); this.ownerDocument = doc; this.children = []; this.parentNode = null;
    this.attrs = {}; this.listeners = {}; this._text = ''; this.className = '';
    const props = {}; this.style = { setProperty: (k, v) => { props[k] = v; }, getPropertyValue: (k) => props[k] };
    this.scrollTop = 0; this.width = 0; this.height = 0;
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  hasAttribute(k) { return k in this.attrs; }
  appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); return c; }
  insertBefore(c, ref) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; const i = ref ? this.children.indexOf(ref) : -1; if (i < 0) this.children.push(c); else this.children.splice(i, 0, c); return c; }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) { this.children.splice(i, 1); c.parentNode = null; } return c; }
  get firstChild() { return this.children[0] || null; }
  get lastChild() { return this.children[this.children.length - 1] || null; }
  set textContent(v) { this._text = String(v); this.children.forEach((c) => { c.parentNode = null; }); this.children = []; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
  removeEventListener(t, f) { this.listeners[t] = (this.listeners[t] || []).filter((x) => x !== f); }
  dispatch(t, ev = {}) { const e = { type: t, target: this, preventDefault() {}, ...ev }; for (let n = this; n; n = n.parentNode) for (const f of n.listeners[t] || []) f(e); return e; }   // bubbles
  getBoundingClientRect() { return { x: 0, y: 0, width: 360, height: 780 }; }
  setPointerCapture() {} releasePointerCapture() {} focus() {}
  all() { return this.children.flatMap((c) => [c, ...c.all()]); }
}
export function makeDom() {
  const doc = { head: new FEl('head'), createElement: (t) => new FEl(t, doc), defaultView: null };
  const frames = [];
  const win = {
    document: doc, console, performance, devicePixelRatio: 1, matchMedia: () => ({ matches: false }),
    requestAnimationFrame: (f) => frames.push(f), cancelAnimationFrame: () => {}, setTimeout, clearTimeout,
  };
  doc.defaultView = win;
  let t = 0;
  const step = (ms = 16, n = 1) => { for (let i = 0; i < n; i++) { const q = frames.splice(0); t += ms; q.forEach((f) => f(t)); } };
  const container = new FEl('div', doc);
  return { doc, win, container, step, pending: () => frames.length, deps: { document: doc, window: win, injectCss: false, loadImage: () => Promise.reject(new Error('no images')) } };
}
