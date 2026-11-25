// Readings saved on the phone, so SnowScout can keep showing the last good numbers when
// the NRCS server is overloaded (it often answers "503 Service Unavailable").
//
// Per site: the last ~3 days of hourly readings and the last good 14-day daily download.
// About 5 KB per site, kept in browser storage.

import { load, save } from './store.js';

const KEY = 'ssx.readings.v1';
const HOUR = 3600000;
export const KEEP_HOURS = 80;     // covers the 72-hour new-snow baseline
const FORGET_AFTER_DAYS = 14;     // drop sites nobody has looked at in two weeks

/**
 * Merge saved and freshly downloaded hourly readings; fresh values win (NRCS fills in
 * hours a snowed-in station couldn't send once its signal gets out again).
 *
 * A station that can't get its signal out still gets hourly rows from NRCS, just with
 * empty values. Those empty hours carry no information and are dropped, and the ~3 days
 * kept are counted back from the NEWEST REAL READING, not from now: in a long storm the
 * station's last reports must survive so the app can keep showing them.
 */
export function mergeHours(saved = [], fresh = [], keepHours = KEEP_HOURS) {
  const hasData = (h) => h.depth != null || h.tobs != null || h.swe != null;
  // Saved copies from the previous version may still hold empty hours: drop them too.
  const byT = new Map(saved.filter(hasData).map((h) => [h.t, h]));
  for (const h of fresh) if (hasData(h)) byT.set(h.t, h); // an empty hour never erases a real one
  const all = [...byT.values()].sort((a, b) => a.t - b.t);
  if (!all.length) return all;
  const newest = all[all.length - 1].t;
  return all.filter((h) => h.t >= newest - keepHours * HOUR);
}

let memo = null;
const all = () => (memo ??= load(KEY, {}));

/**
 * { hours, days, savedAt, fetchedAt } for a site, or null. fetchedAt is when fresh readings
 * last actually downloaded (savedAt also changes when a failed download keeps old ones).
 */
export const savedReadings = (triplet) => all()[triplet] ?? null;

/**
 * Save readings for several sites at once: { triplet: { hours, days } }. fetched: the
 * triplets freshly downloaded just now (default: all of them).
 */
export function saveReadings(updates, nowMs = Date.now(), fetched = null) {
  const store = all();
  for (const [t, r] of Object.entries(updates)) {
    const fetchedAt = !fetched || fetched.has(t) ? nowMs : (store[t]?.fetchedAt ?? 0);
    store[t] = { ...r, savedAt: nowMs, fetchedAt };
  }
  for (const [t, r] of Object.entries(store)) {
    if (nowMs - (r.savedAt ?? 0) > FORGET_AFTER_DAYS * 24 * HOUR) delete store[t];
  }
  save(KEY, store);
}
