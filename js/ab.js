// Alberta snow stations: every active station with a snow-depth or snow-water sensor on
// Alberta Rivers (rivers.alberta.ca), the Alberta government's river-forecasting site. Most
// are Alberta Environment and Protected Areas stations; the site also carries Parks Canada,
// Kananaskis, Environment Canada, Alberta Agriculture and other partners' stations. Its data
// is provisional (not yet reviewed).
//
// Alberta Rivers publishes one small JSON file per station with its last 5 days of readings
// (every 15 minutes or hourly). The GitHub Action (scripts/build-ab-data.mjs) downloads them
// about every 30 minutes and publishes two files in the same shape as the BC ones, so the
// app reads both the same way (bcHours / bcDays in bc.js):
//
//   data/ab-stations.json   station list (name, location, who runs it)
//   data/ab-readings.json   last 4 days of hourly readings + 15 days of daily values
//
// Alberta only keeps 5 days, so each build carries forward the daily values the previous
// build published: the 15-day history builds up on its own.
//
// This file is shared by the Action (Node) and the app (browser): no browser-only code.

import { DAYS_PUBLISHED, HOURS_PUBLISHED, dailyFromHourly, endOfDayMs } from './bc.js';

const HOUR = 3600000;
const MIN = 60000;
export const AB_STATE = 'AB';
export const AB_NETWORK = 'ABR';
/** Daily values use midnight Mountain Standard Time, like SNOTEL uses Pacific. */
export const AB_TZ = -7;

const BASE = 'https://rivers.alberta.ca';
export const AB_SOURCES = {
  manifest: `${BASE}/EnvironmentalDataService/ReadManifest`,
  /** A station's last 5 days, e.g. table('05BB803'). */
  table: (id) => `${BASE}/apps/Basins/data/figures/river/abrivers/envdata/envdata_${encodeURIComponent(id)}_table.json`,
};

/** SnowScout's id for an Alberta station: "05BB803:AB:ABR" (same shape as SNOTEL's "588:ID:SNTL"). */
export const abTriplet = (id) => `${id}:${AB_STATE}:${AB_NETWORK}`;
export const isAbTriplet = (t) => String(t).endsWith(`:${AB_STATE}:${AB_NETWORK}`);

/** Who runs a station, from the suffix of its Alberta Rivers name ("Sunshine Village - EPA"). */
export const OPERATORS = {
  EPA: 'Alberta Environment',
  AGI: 'Alberta Agriculture',
  MSC: 'Environment Canada',
  PC: 'Parks Canada',
  FP: 'Alberta Parks',
  ToC: 'Town of Canmore',
  OSM: 'Oil Sands Monitoring',
  CDA: 'Agriculture Canada',
  GWFO: 'Global Water Futures',
};

/** "Sunshine Village - EPA" -> { name: 'Sunshine Village', operator: 'Alberta Environment' }. */
export function splitName(raw) {
  const m = /^(.*?)\s+-\s+([A-Za-z]+)\s*$/.exec(String(raw ?? '').trim());
  if (!m) return { name: String(raw ?? '').trim(), operator: null, code: null };
  return { name: m[1].trim(), operator: OPERATORS[m[2]] ?? m[2], code: m[2] };
}

/**
 * Alberta Rivers also lists neighbouring BC and SNOTEL stations, which SnowScout already
 * gets from their own networks, and stations retired years ago.
 */
export function isDuplicateOrRetired(id, rawName) {
  if (/^\d[A-Z]\d{2}[A-Z]$/.test(id)) return true;          // BC snow station, e.g. 1A01P
  if (/^\d{2}[A-Z]\d{2}S$/.test(id)) return true;           // SNOTEL, e.g. 13A19S
  if (/-OLD$/i.test(id) || /^Merchant-/i.test(id)) return true;
  return /\s-\s(BC|Snotel)\s*$/i.test(rawName ?? '');
}

const round = (v, places) => (v == null ? null : Math.round(v * 10 ** places) / 10 ** places);
const cmToIn = (v) => (v == null ? null : v / 2.54);
const mmToIn = (v) => (v == null ? null : v / 25.4);
const cToF = (v) => (v == null ? null : v * 9 / 5 + 32);

/**
 * "2026-11-23 10:30:00" -> ms since epoch. Alberta Rivers stamps everything in Mountain
 * Standard Time (UTC-7) all year, whatever the clocks in Alberta say: checked against the
 * server's own Last-Modified time (a file stamped 10:49:25 was modified at 17:49:25 UTC).
 */
export function albertaTimeToMs(stamp) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(stamp ?? '').trim());
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0)) - AB_TZ * HOUR;
}

/** Manifest stamp "20261123103000" (local time) -> ms, or null. */
export function manifestTimeToMs(stamp) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(String(stamp ?? ''));
  return m ? albertaTimeToMs(`${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}`) : null;
}

/**
 * The stations worth downloading, from Alberta Rivers' station manifest: those with a snow
 * depth or snow water sensor, a location, and a report in the last 15 days.
 */
export function snowStations(manifest, nowMs) {
  const out = [];
  for (const s of manifest?.envdata_stations ?? []) {
    const id = String(s.station_number ?? '').trim();
    if (!id || isDuplicateOrRetired(id, s.station_name)) continue;
    const params = (s.parameter_graphs ?? []).map((p) => p.parname);
    if (!params.includes('SD') && !params.includes('SW')) continue;
    const lat = Number(s.station_latitude), lon = Number(s.station_longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) continue;
    const last = manifestTimeToMs(s.parameter_table?.[0]?.parameter_data_status_time);
    if (last != null && last < nowMs - DAYS_PUBLISHED * 24 * HOUR) continue;
    out.push({ id, rawName: s.station_name, lat: round(lat, 5), lon: round(lon, 5), hasDepth: params.includes('SD') });
  }
  return out;
}

/**
 * One station's 5-day file -> { depth, swe, temp } series of [t, value] in the station's
 * own units (cm, mm, °C), oldest first. Columns are found by name, since stations carry
 * different sensors (and survey columns such as "SD-SS" are skipped).
 */
export function parseTable(table) {
  const out = { depth: [], swe: [], temp: [] };
  const meta = table?.ts_metadata ?? [];
  const col = (name) => {
    const i = meta.findIndex((m) => m.parameter_name === name);
    return i < 0 ? -1 : (meta[i].ts_data_sequence ?? i + 1);
  };
  const cols = { depth: col('SD'), swe: col('SW'), temp: col('TA') };
  for (const row of table?.data ?? []) {
    const v = row?.values ?? [];
    const t = albertaTimeToMs(v[0]);
    if (t == null) continue;
    for (const key of Object.keys(cols)) {
      const i = cols[key];
      const x = i > 0 ? v[i] : null;
      if (x != null && Number.isFinite(Number(x))) out[key].push([t, Number(x)]);
    }
  }
  for (const s of Object.values(out)) s.sort((a, b) => a[0] - b[0]);
  return out;
}

/**
 * 15-minute readings -> one per hour, like SNOTEL's: the reading on the hour, or failing
 * that the first one in the 45 minutes after it (never one from a later hour, so the newest
 * hour is never stamped ahead of its reading).
 */
export function toHourly(series) {
  const byHour = new Map();
  for (const [t, v] of series) {
    const hour = Math.floor(t / HOUR) * HOUR;
    if (t - hour > 45 * MIN) continue;
    const prev = byHour.get(hour);
    if (!prev || t < prev[0]) byHour.set(hour, [t, v]);
  }
  return [...byHour.entries()].sort((a, b) => a[0] - b[0]).map(([hour, [, v]]) => [hour, v]);
}

/**
 * Build the two published files.
 * @param stations   snowStations(manifest) (or the previous list, if the manifest failed)
 * @param tables     Map(id -> that station's 5-day file); a station whose download failed is
 *                   simply missing, and keeps its previously published daily values
 * @param nowMs      build time
 * @param previous   { stations, readings }: the files on the live site, or null
 */
export function buildAbData(stations, tables, nowMs, previous = null) {
  const prevStations = new Map((previous?.stations?.stations ?? []).map((s) => [s.id, s]));
  const prevReadings = previous?.readings?.stations ?? {};

  const startMs = Math.floor((nowMs - (HOURS_PUBLISHED - 1) * HOUR) / HOUR) * HOUR;
  const count = Math.floor((nowMs - startMs) / HOUR) + 1;
  const grid = (series, convert, places) => {
    const arr = new Array(count).fill(null);
    for (const [t, v] of series) {
      const i = (t - startMs) / HOUR;
      if (Number.isInteger(i) && i >= 0 && i < count) arr[i] = round(convert(v), places);
    }
    while (arr.length && arr[arr.length - 1] == null) arr.pop();
    return arr;
  };
  const oldestDay = new Date(nowMs + AB_TZ * HOUR - DAYS_PUBLISHED * 24 * HOUR).toISOString().slice(0, 10);

  // Same names from different agencies (Bow Summit is both an Alberta and a Parks Canada
  // station): name the partner's one after its agency.
  const named = stations.map((s) => ({ ...s, ...splitName(s.rawName) }));
  const nameCount = new Map();
  for (const s of named) nameCount.set(s.name, (nameCount.get(s.name) ?? 0) + 1);

  const outStations = [];
  const readings = {};
  let latest = 0;
  for (const st of [...named].sort((a, b) => a.id.localeCompare(b.id))) {
    const table = tables.get(st.id);
    const raw = table ? parseTable(table) : { depth: [], swe: [], temp: [] };
    const hourly = { depth: toHourly(raw.depth), swe: toHourly(raw.swe), temp: toHourly(raw.temp) };
    latest = Math.max(latest, hourly.depth.at(-1)?.[0] ?? 0, hourly.swe.at(-1)?.[0] ?? 0);

    // New daily values only for days the 5-day file fully covers; older days come from
    // the previous build.
    const firstT = Math.min(...[hourly.depth, hourly.swe, hourly.temp].map((s) => s[0]?.[0] ?? Infinity));
    const fresh = dailyFromHourly(hourly, nowMs, DAYS_PUBLISHED, AB_TZ)
      .filter((d) => endOfDayMs(d.date, AB_TZ) - 24 * HOUR >= firstT - HOUR)
      .map((d) => [d.date, d.depth, d.swe, d.tobs, d.tmax, d.tmin]);
    const byDate = new Map((prevReadings[st.id]?.days ?? []).map((d) => [d[0], d]));
    for (const d of fresh) byDate.set(d[0], d);
    const days = [...byDate.values()].filter((d) => d[0] >= oldestDay).sort((a, b) => (a[0] < b[0] ? -1 : 1));

    const hasHours = hourly.depth.length || hourly.swe.length || hourly.temp.length;
    if (!hasHours && !days.length) continue; // nothing this season (or never downloaded)
    const hasDepth = hourly.depth.length > 0 || days.some((d) => d[1] != null);
    const hasSwe = hourly.swe.length > 0 || days.some((d) => d[2] != null);
    if (!hasDepth && !hasSwe) continue; // temperature only: nothing to score

    const prev = prevStations.get(st.id);
    st.operator ??= prev?.operator ?? null;
    outStations.push({
      id: st.id,
      name: nameCount.get(st.name) > 1 && st.code !== 'EPA' && st.operator ? `${st.name} (${st.operator})` : st.name,
      lat: st.lat ?? prev?.lat ?? null,
      lon: st.lon ?? prev?.lon ?? null,
      elevFt: prev?.elevFt ?? null,
      ...(st.operator ? { operator: st.operator } : {}),
      // Snow pillows with no depth sensor: snow water only, so no sled score.
      ...(!hasDepth && hasSwe ? { sweOnly: true } : {}),
    });
    readings[st.id] = {
      depth: grid(hourly.depth, cmToIn, 1),
      swe: grid(hourly.swe, mmToIn, 2),
      temp: grid(hourly.temp, cToF, 1),
      days,
    };
  }

  return {
    stationsFile: { version: 1, generatedMs: nowMs, stations: outStations },
    readingsFile: {
      version: 1,
      generatedMs: nowMs,
      latestReadingMs: latest || null,
      startMs,
      stepMs: HOUR,
      units: { depth: 'in', swe: 'in', temp: 'F' },
      stations: readings,
    },
  };
}
