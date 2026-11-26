// rowqueue.js — pure: does the queue snapshot taken at load time still describe the shelf row the user tapped?
// A rescan can add / remove tracks of the album already on the platter, so a live shelf row index is only valid against the queue if the same
// file sits at that position and the counts agree.
export function queueMatchesRow(q, item, index) {
  if (!q || !item || !Array.isArray(q.items) || !Array.isArray(item.tracks)) return false;
  if (q.albumId !== item.id) return false;
  if (q.items.length !== item.tracks.length) return false;
  const a = q.items[index], b = item.tracks[index];
  return !!(a && b && a.file && a.file === b.file);
}
