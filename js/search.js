// Station search for the Sites screen. Forgiving on purpose: case, punctuation, accents and
// extra spaces don't matter, and each word can match anywhere, in any order. So "red  mountain",
// "pass red mountain", "mt alyeska" (Mt. Alyeska) and "ward creek 3" (Ward Creek #3) all work.
// A station number still matches exactly ("327" finds Beartown). Same rules as the Android app.

/** Lowercase, accents removed, anything that isn't a letter or digit turned into one space. */
export function normalizeSearch(s) {
  return String(s ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** True if every word of the query appears in the station's name or county (or it's the station number). */
export function matchesSearch(st, query) {
  const q = normalizeSearch(query);
  if (!q) return true;
  if (String(st.id ?? '').toLowerCase() === String(query).trim().toLowerCase()) return true;
  const hay = ` ${normalizeSearch(`${st.name ?? ''} ${st.county ?? ''}`)} `;
  return q.split(' ').every((word) => hay.includes(word));
}
