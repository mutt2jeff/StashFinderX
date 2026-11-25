// British Columbia snow stations: the province's Automated Snow Weather Station (ASWS)
// network, run by the BC River Forecast Centre. Open Government Licence – British Columbia.
//
// BC publishes each reading type as one big CSV for the whole season (hourly, UTC, one
// column per station). Those files don't allow web pages to read them directly (no CORS
// header), so a small GitHub Action (scripts/build-bc-data.mjs) downloads them about every
// 30 minutes and publishes two trimmed files next to the app:
//
//   data/bc-stations.json   station list (name, location, elevation)
//   data/bc-readings.json   last 4 days of hourly readings + 15 days of daily values
//
// Everything is converted to the units SnowScout uses (inches, °F) when the files are
// built, so the app scores BC stations exactly like SNOTEL ones.
//
// This file is shared by the Action (Node) and the app (browser): no browser-only code.

import { addDays } from './scorer.js';

const HOUR = 3600000;
export const BC_STATE = 'BC';
export const BC_NETWORK = 'ASWS';
/** BC readings are in UTC; daily values use midnight Pacific Standard Time, like SNOTEL. */
export const BC_TZ = -8;
export const HOURS_PUBLISHED = 96;  // covers the 72-hour new-snow baseline with room to spare
export const DAYS_PUBLISHED = 15;

export const BC_SOURCES = {
  stations: 'https://openmaps.gov.bc.ca/geo/pub/wfs?service=WFS&version=2.0.0&request=GetFeature' +
    '&typeName=WHSE_WATER_MANAGEMENT.SSL_SNOW_ASWS_STNS_SP&outputFormat=application/json&srsName=EPSG:4326',
  depth: 'https://www.env.gov.bc.ca/wsd/data_searches/snow/asws/data/SD.csv', // snow depth, cm
  swe: 'https://www.env.gov.bc.ca/wsd/data_searches/snow/asws/data/SW.csv',   // snow water equivalent, mm
  temp: 'https://www.env.gov.bc.ca/wsd/data_searches/snow/asws/data/TA.csv',  // air temperature, °C
};

/** SnowScout's id for a BC station: "1A01P:BC:ASWS" (same shape as SNOTEL's "588:ID:SNTL"). */
export const bcTriplet = (id) => `${id}:${BC_STATE}:${BC_NETWORK}`;
export const isBcTriplet = (t) => String(t).endsWith(`:${BC_STATE}:${BC_NETWORK}`);

const round = (v, places) => (v == null ? null : Math.round(v * 10 ** places) / 10 ** places);
const cmToIn = (v) => (v == null ? null : v / 2.54);
const mmToIn = (v) => (v == null ? null : v / 25.4);
const cToF = (v) => (v == null ? null : v * 9 / 5 + 32);
const mToFt = (v) => (v == null ? null : v * 3.28084);

/** "2026-11-23 02:00" (UTC) -> ms since epoch, or null. */
export function parseUtc(stamp) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(stamp).trim());
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : null;
}

/**
 * Parse one of BC's wide CSVs:
 *   DATE(UTC),1A01P Yellowhead Lake,1A02P McBride Upper,...
 *   2026-10-01 00:00,0.0,,3.0,...
 * -> Map(stationId -> { name, series: [[t, value], ...] oldest first, empty cells skipped }).
 * An empty cell means no reading reached BC that hour (often a snowed-in station).
 */
export function parseWideCsv(text) {
  const lines = String(text).split(/\r?\n/).filter((l) => l.trim());
  const out = new Map();
  if (!lines.length) return out;
  const cols = lines[0].split(',').slice(1).map((h) => {
    const label = h.trim();
    const id = label.split(/\s+/)[0].toUpperCase();
    return { id, name: label.slice(id.length).trim() };
  });
  for (const c of cols) if (c.id && !out.has(c.id)) out.set(c.id, { name: c.name, series: [] });
  for (const line of lines.slice(1)) {
    const cells = line.split(',');
    const t = parseUtc(cells[0]);
    if (t == null) continue;
    cols.forEach((c, i) => {
      const raw = cells[i + 1];
      if (raw == null || raw.trim() === '') return;
      const v = Number(raw);
      if (Number.isFinite(v)) out.get(c.id).series.push([t, v]);
    });
  }
  for (const s of out.values()) s.series.sort((a, b) => a[0] - b[0]);
  return out;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const within = (series, from, to) => series.filter(([t]) => t > from && t <= to).map(([, v]) => v);

/** Date ('YYYY-MM-DD') of an instant in standard time tz hours from UTC (BC: Pacific). */
const localDate = (ms, tz) => new Date(ms + tz * HOUR).toISOString().slice(0, 10);

/** The instant of midnight (standard time, tz hours from UTC) at the END of date. */
export const endOfDayMs = (date, tz) =>
  Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10) + 1) - tz * HOUR;

/**
 * Daily values from hourly series, matching SNOTEL's convention: the daily value for date D
 * is the reading at midnight (PST) at the END of D. Snow depth and SWE use the median of
 * the readings in the 3 hours up to midnight (the depth sensor jitters); high/low are over
 * the day. Only finished days are produced. tz: the province's standard time (BC -8, AB -7).
 */
export function dailyFromHourly({ depth = [], swe = [], temp = [] }, nowMs, days = DAYS_PUBLISHED, tz = BC_TZ) {
  const out = [];
  const today = localDate(nowMs, tz);
  for (let i = days; i >= 1; i--) {
    const date = addDays(today, -i);
    const midnight = endOfDayMs(date, tz);
    const near = (series) => {
      const xs = within(series, midnight - 3 * HOUR, midnight);
      return xs.length ? median(xs) : null;
    };
    const dayTemps = within(temp, midnight - 24 * HOUR, midnight);
    const lastTemp = temp.filter(([t]) => t > midnight - 2 * HOUR && t <= midnight).pop();
    const day = {
      date,
      depth: round(cmToIn(near(depth)), 1),
      swe: round(mmToIn(near(swe)), 2),
      tobs: round(cToF(lastTemp ? lastTemp[1] : null), 1),
      // Need most of the day for a believable high/low.
      tmax: dayTemps.length >= 12 ? round(cToF(Math.max(...dayTemps)), 1) : null,
      tmin: dayTemps.length >= 12 ? round(cToF(Math.min(...dayTemps)), 1) : null,
    };
    if (day.depth != null || day.swe != null || day.tobs != null) out.push(day);
  }
  return out;
}

/**
 * Build the two published files from BC's raw downloads.
 * @param csv { depth, swe, temp }: CSV texts (any may be missing)
 * @param stationsGeo the WFS GeoJSON of station locations (may be null)
 * @param nowMs build time
 * @param previousStations last published station list, used if the WFS download failed
 */
export function buildBcData(csv, stationsGeo, nowMs, previousStations = []) {
  const parsed = {
    depth: parseWideCsv(csv.depth ?? ''),
    swe: parseWideCsv(csv.swe ?? ''),
    temp: parseWideCsv(csv.temp ?? ''),
  };
  const ids = new Set([...parsed.depth.keys(), ...parsed.swe.keys(), ...parsed.temp.keys()]);

  const located = new Map();
  for (const f of stationsGeo?.features ?? []) {
    const p = f.properties ?? {};
    const id = String(p.LOCATION_ID ?? '').toUpperCase();
    if (!id) continue;
    const [lon, lat] = f.geometry?.coordinates ?? [p.LONGITUDE, p.LATITUDE];
    located.set(id, {
      name: p.LOCATION_NAME, status: p.STATUS,
      lat: round(lat ?? p.LATITUDE, 5), lon: round(lon ?? p.LONGITUDE, 5),
      elevFt: p.ELEVATION != null ? Math.round(mToFt(p.ELEVATION)) : null,
    });
  }
  const prev = new Map(previousStations.map((s) => [s.id, s]));

  const startMs = Math.floor((nowMs - (HOURS_PUBLISHED - 1) * HOUR) / HOUR) * HOUR;
  const count = Math.floor((nowMs - startMs) / HOUR) + 1;
  const grid = (series, convert, places) => {
    const arr = new Array(count).fill(null);
    for (const [t, v] of series) {
      const i = (t - startMs) / HOUR;
      if (Number.isInteger(i) && i >= 0 && i < count) arr[i] = round(convert(v), places);
    }
    // Trailing hours nobody has reported yet are left off (the newest hour is usually
    // still filling in); the app treats any missing hour as "no reading".
    while (arr.length && arr[arr.length - 1] == null) arr.pop();
    return arr;
  };

  const stations = [];
  const readings = {};
  for (const id of [...ids].sort()) {
    const series = {
      depth: parsed.depth.get(id)?.series ?? [],
      swe: parsed.swe.get(id)?.series ?? [],
      temp: parsed.temp.get(id)?.series ?? [],
    };
    const recent = (s) => s.some(([t]) => t >= nowMs - DAYS_PUBLISHED * 24 * HOUR);
    if (!recent(series.depth) && !recent(series.swe) && !recent(series.temp)) continue; // retired / no data this season

    const loc = located.get(id) ?? prev.get(id) ?? {};
    const csvName = parsed.depth.get(id)?.name || parsed.temp.get(id)?.name || parsed.swe.get(id)?.name;
    stations.push({
      id,
      name: loc.name || csvName || id,
      lat: loc.lat ?? null,
      lon: loc.lon ?? null,
      elevFt: loc.elevFt ?? null,
      // Some BC stations only weigh the snowpack (snow water equivalent) and have no
      // depth sensor, so they can't get a sled score.
      ...(!recent(series.depth) && recent(series.swe) ? { sweOnly: true } : {}),
    });
    readings[id] = {
      depth: grid(series.depth, cmToIn, 1),
      swe: grid(series.swe, mmToIn, 2),
      temp: grid(series.temp, cToF, 1),
      days: dailyFromHourly(series, nowMs).map((d) => [d.date, d.depth, d.swe, d.tobs, d.tmax, d.tmin]),
    };
  }

  const latestReading = Math.max(0, ...[...parsed.depth.values()].map((s) => s.series.at(-1)?.[0] ?? 0));
  return {
    stationsFile: { version: 1, generatedMs: nowMs, stations },
    readingsFile: {
      version: 1,
      generatedMs: nowMs,
      latestReadingMs: latestReading || null,
      startMs,
      stepMs: HOUR,
      units: { depth: 'in', swe: 'in', temp: 'F' },
      stations: readings,
    },
  };
}

// ---- Reading the published files (app side) -----------------------------------------

/** Hourly readings for one station -> [{t, depth, tobs, swe}], skipping empty hours. */
export function bcHours(file, id) {
  const r = file?.stations?.[id];
  if (!r) return [];
  const n = Math.max(r.depth?.length ?? 0, r.swe?.length ?? 0, r.temp?.length ?? 0);
  const out = [];
  for (let i = 0; i < n; i++) {
    const h = { t: file.startMs + i * (file.stepMs || HOUR), depth: r.depth?.[i] ?? null, tobs: r.temp?.[i] ?? null, swe: r.swe?.[i] ?? null };
    if (h.depth != null || h.tobs != null || h.swe != null) out.push(h);
  }
  return out;
}

/** Daily values for one station -> [{date, depth, swe, tobs, tmax, tmin, prec}], oldest first. */
export function bcDays(file, id) {
  return (file?.stations?.[id]?.days ?? []).map(([date, depth, swe, tobs, tmax, tmin]) =>
    ({ date, depth, swe, tobs, tmax, tmin, prec: null }));
}
