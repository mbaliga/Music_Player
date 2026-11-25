// Plain-words text for failures shown to the listener (toasts). Never filenames, byte offsets or native stack text.
export const LOST_ACCESS = 'Runout lost access to your music. Tap Allow.';

/** True for a failed native read / storage permission failure (DeviceReadError, "native read failed at 0 (+640044) of x.wav: permission"). */
export function isAccessError(e) {
  if (!e) return false;
  const m = String((e && e.message) || e);
  return e.name === 'DeviceReadError' || /native read failed|permission|SecurityException|EACCES|not allowed to read/i.test(m);
}

/** A title short enough for a toast. */
export function shortTitle(t, n = 28) {
  const s = String(t == null ? '' : t).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
}

/** The reason half of "Cannot play X: <reason>": no file names, no byte offsets, capped. */
export function friendlyReason(e) {
  if (isAccessError(e)) return LOST_ACCESS;
  let m = String((e && e.message) || e || 'unknown error');
  m = m.replace(/\bat \d+ \(\+\d+\)/g, '').replace(/\b[\w .()\[\]-]+\.(wav|mp3|flac|ogg|opus|m4a|aac|aif+|wma)\b/gi, 'the file').replace(/\(\+?\d{4,}\)/g, '').replace(/\s+/g, ' ').trim();
  return m.length > 70 ? m.slice(0, 69).trimEnd() + '…' : m;
}

/** The whole toast line for a track that will not play. */
export function playFailText(title, e) {
  if (isAccessError(e)) return LOST_ACCESS;
  return `Cannot play "${shortTitle(title) || 'this track'}": ${friendlyReason(e)}`;
}
