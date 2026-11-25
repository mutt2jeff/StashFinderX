// Shared SNOTEL summary for the map: the latest snow numbers for every SNOTEL station,
// built every ~3 hours by the GitHub Action (scripts/build-snotel-data.mjs) and published as
// data/snotel-latest.json. One download for everyone instead of every phone asking NRCS
// about ~900 stations.
//
// The file holds readings, not scores: each phone scores them with its own minimum base,
// using the same rules as the dashboard (scorer.js rate()).
//
// File format (kept small, ~50 KB):
//   { generatedMs, latestReadingMs, fields: [...], sites: { triplet: [depth, new24, new72, temp, asOfMs] } }

import { currentFromHourly, stationTimeToMs, atLeast24, rate } from './scorer.js';

export const SNOTEL_FIELDS = ['depth', 'new24', 'new72', 'temp', 'asOfMs'];
/** The map stops coloring dots when the file is older than this. */
export const SUMMARY_MAX_AGE_MS = 12 * 3600000;

const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

/** NRCS hourly data for one station -> [{t, depth, tobs}], oldest first. */
export function hoursFromAwdb(stationData, tz) {
  const byT = new Map();
  const key = { SNWD: 'depth', TOBS: 'tobs' };
  for (const el of stationData?.data ?? []) {
    const k = key[el.stationElement?.elementCode];
    if (!k) continue;
    for (const v of el.values ?? []) {
      const t = stationTimeToMs(v.date, tz);
      if (t == null) continue;
      const h = byT.get(t) ?? { t, depth: null, tobs: null, swe: null };
      h[k] = v.value ?? null;
      byT.set(t, h);
    }
  }
  return [...byT.values()].sort((a, b) => a.t - b.t);
}

/** One station's row for the file, or null if it has no recent depth reading. */
export function summaryRow(hours, nowMs) {
  const cur = currentFromHourly(hours, nowMs);
  if (!cur || cur.depth == null) return null;
  return [round1(cur.depth), round1(cur.new24), round1(atLeast24(cur.new72, cur.new24)), round1(cur.temp), cur.asOfMs];
}

/**
 * Build the file from NRCS hourly responses.
 * @param responses  list of StationDataDto ({stationTriplet, data: [...]})
 * @param tzOf       triplet -> hours from UTC the station's readings are stamped in
 */
export function buildSnotelSummary(responses, tzOf, nowMs = Date.now()) {
  const sites = {};
  let latest = 0;
  for (const s of responses) {
    const row = summaryRow(hoursFromAwdb(s, tzOf(s.stationTriplet)), nowMs);
    if (!row) continue;
    sites[s.stationTriplet] = row;
    latest = Math.max(latest, row[4]);
  }
  return { generatedMs: nowMs, latestReadingMs: latest || null, fields: SNOTEL_FIELDS, sites };
}

/**
 * Rating key for a station on the map ('epic', 'good', 'fair', 'marginal', 'nogo'), scored
 * with the user's minimum base, or null when there's nothing to show (no row).
 */
export function mapRating(row, minBase) {
  if (!row || row[0] == null) return null;
  const [depth, new24, new72, temp] = row;
  return rate({ depth, new24, new72, temp }, minBase).rating.key;
}
