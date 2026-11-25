// Plains, Midwest and Northeast snow reports (R1, StashFinder X only for now: MT ND SD NE MN
// WI MI NY VT NH ME): daily snow depth and
// new snowfall from National Weather Service cooperative observers and CoCoRaHS volunteers,
// through NOAA's Applied Climate Information System (ACIS, data.rcc-acis.org).
//
// These are people, not automatic sensors: most measure once a day, around 7 AM, and the
// report is dated that morning. So these stations have no hourly readings, and their new
// snow is the snowfall the observer measured (not the change in depth, as for SNOTEL).
//
// A GitHub Action (scripts/build-acis-data.mjs) asks ACIS for each state's last 15 days every
// few hours and publishes two trimmed files next to the app, so phones never ask ACIS:
//
//   data/acis-stations.json   stations that reported snow depth in the last week
//   data/acis-readings.json   their daily depth, new snow and observation-time temperature
//
// This file is shared by the Action (Node) and the app (browser): no browser-only code.

import { addDays } from './scorer.js';

export const ACIS_NETWORK = 'ACIS';
export const ACIS_URL = 'https://data.rcc-acis.org/MultiStnData';
/**
 * States covered, with the standard time (hours from UTC) their mornings are in. ND, SD and NE
 * are split between Central and Mountain time: see acisZone.
 */
export const ACIS_STATES = {
  MT: -7, ND: -6, SD: -6, NE: -6,
  MN: -6, WI: -6, MI: -5, NY: -5, VT: -5, NH: -5, ME: -5,
};
export const ACIS_DAYS = 15;
/** A station must have reported a snow depth this recently to be listed. */
const RECENT_DAYS = 7;

/** StashFinder's id for an ACIS station: "25028:VT:ACIS" (ACIS's own station number, then the state). */
export const acisTriplet = (id, state) => `${id}:${state}:${ACIS_NETWORK}`;
export const isAcisTriplet = (t) => /^[^:]+:[A-Z]{2}:ACIS$/.test(String(t));
/**
 * Standard time for a station. The western parts of ND, SD and NE are on Mountain time; the
 * lines here follow the county lines roughly, so a station right at the edge may be an hour
 * off (that only moves "this morning" vs "yesterday morning" for a 7 AM report).
 */
export function acisZone(state, lat, lon) {
  const base = ACIS_STATES[state] ?? -5;
  if (lat == null || lon == null) return base;
  if (state === 'SD' && lon < -100.6) return -7; // West River
  if (state === 'NE' && lon < -101.3) return -7; // panhandle and the southwest
  if (state === 'ND' && ((lat < 46.65 && lon < -100.8) || (lat < 47.4 && lon < -102.0))) return -7; // southwest corner
  return base;
}
/** Time zone of a station or readings record: its own if the file has one, else its state's. */
export const acisTz = (rec) => rec?.tz ?? ACIS_STATES[rec?.state] ?? -5;

/** The request body for one state's days sdate..edate ('YYYY-MM-DD'). */
export const acisRequest = (state, sdate, edate) => ({
  state, sdate, edate, elems: 'snwd,snow,obst', meta: 'name,ll,elev,sids,uid,state',
});

/**
 * One ACIS value -> number or null. "T" (trace) counts as 0. "M" (missing) and "S" (included
 * in a later multi-day total) are null. "3A" is a total over several days: counted on the day
 * it was reported.
 */
export function acisValue(v) {
  const s = String(v ?? '').trim();
  if (s === 'T') return 0;
  const m = /^(-?\d+(?:\.\d+)?)A?$/.exec(s);
  return m ? Number(m[1]) : null;
}

/** Who reports for a station, from its ids ("123456 10" = CoCoRaHS, "436335 2" = NWS co-op). */
export function acisOperator(sids = []) {
  const types = new Set(sids.map((s) => String(s).trim().split(/\s+/).pop()));
  if (types.has('10')) return 'CoCoRaHS';
  if (types.has('2')) return 'NWS co-op';
  return 'NWS';
}

/** "N SPRINGFIELD LAKE" -> "N Springfield Lake"; "MINNEAPOLIS 3.2 SW" keeps its "SW". */
export function acisName(raw) {
  return String(raw ?? '').trim().toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase())
    .replace(/\b(Nw|Ne|Sw|Se|Nnw|Nne|Ssw|Sse|Wnw|Wsw|Ene|Ese)\b/g, (d) => d.toUpperCase());
}

const round = (v, places) => (v == null ? null : Math.round(v * 10 ** places) / 10 ** places);
const trimEnd = (arr) => { const a = [...arr]; while (a.length && a[a.length - 1] == null) a.pop(); return a; };

/**
 * Build the two published files from ACIS answers.
 * @param byState { MN: response, ... } (a state may be missing if its request failed)
 * @param startDate first day asked for ('YYYY-MM-DD'); every station's values start there
 */
export function buildAcisData(byState, nowMs, startDate) {
  const stations = [];
  const readings = {};
  let latestDate = null;
  for (const [state, res] of Object.entries(byState)) {
    for (const s of res?.data ?? []) {
      const rows = (s.data ?? []).map((day) => day.map(acisValue)); // [depth, snow, temp]
      const depth = rows.map((r) => r[0]);
      if (!depth.slice(-RECENT_DAYS).some((v) => v != null)) continue; // no snow reports lately
      const [lon, lat] = s.meta?.ll ?? [];
      if (lat == null || lon == null || s.meta?.uid == null) continue;
      const id = String(s.meta.uid);
      const tz = acisZone(state, lat, lon);
      stations.push({
        id, state, tz, name: acisName(s.meta.name) || `Station ${id}`,
        lat: round(lat, 4), lon: round(lon, 4),
        elevFt: s.meta.elev != null ? Math.round(s.meta.elev) : null, // ACIS elevations are in feet
        operator: acisOperator(s.meta.sids),
      });
      readings[id] = {
        state, tz,
        depth: trimEnd(depth),
        snow: trimEnd(rows.map((r) => r[1])),
        temp: trimEnd(rows.map((r) => r[2])),
      };
      const last = depth.findLastIndex((v) => v != null);
      const date = addDays(startDate, last);
      if (!latestDate || date > latestDate) latestDate = date;
    }
  }
  stations.sort((a, b) => a.state.localeCompare(b.state) || a.name.localeCompare(b.name));
  return {
    stationsFile: { version: 1, generatedMs: nowMs, stations },
    readingsFile: {
      version: 1, generatedMs: nowMs, startDate, latestDate,
      units: { depth: 'in', snow: 'in', temp: 'F' },
      stations: readings,
    },
  };
}

// ---- Reading the published files (app side) -----------------------------------------

/**
 * Daily values for one station -> [{date, depth, snow, tobs, ...}], oldest first. `snow` is the
 * observer's measured new snowfall, which the scorer uses for new snow when it's there.
 */
export function acisDays(file, id) {
  const r = file?.stations?.[id];
  if (!r || !file.startDate) return [];
  const n = Math.max(r.depth?.length ?? 0, r.snow?.length ?? 0, r.temp?.length ?? 0);
  const out = [];
  for (let i = 0; i < n; i++) {
    const day = {
      date: addDays(file.startDate, i),
      depth: r.depth?.[i] ?? null, snow: r.snow?.[i] ?? null, tobs: r.temp?.[i] ?? null,
      swe: null, tmax: null, tmin: null, prec: null,
    };
    if (day.depth != null || day.snow != null || day.tobs != null) out.push(day);
  }
  return out;
}

/** ACIS stations have no hourly readings. */
export const acisHours = () => [];
