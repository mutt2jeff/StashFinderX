// Data access.
//  US: NRCS SNOTEL (AWDB) snow data, National Weather Service forecasts. Both send
//      "Access-Control-Allow-Origin: *", so the browser calls them directly.
//  BC: the province's ASWS snow stations, from files our GitHub Action publishes next to the
//      app (data/bc-*.json, see js/bc.js), and Environment Canada forecasts (CORS-enabled).
//  AB: Alberta Rivers' snow stations, the same way (data/ab-*.json, see js/ab.js).

import { addDays, daysBetween, score, scoreHourly, shortTime, silenceNote, stationTimeToMs, todayIso } from './scorer.js';
import { load, save } from './store.js';
import { mergeHours, saveReadings, savedReadings } from './readings.js';
import { BC_STATE, BC_TZ, bcDays, bcHours, bcTriplet, isBcTriplet } from './bc.js';
import { AB_STATE, AB_TZ, abTriplet, isAbTriplet } from './ab.js';
import { SUMMARY_MAX_AGE_MS, mapRating } from './snotel.js';
import { acisDays, acisHours, acisTriplet, acisTz, isAcisTriplet } from './acis.js';

const AWDB = 'https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1';
const NWS = 'https://api.weather.gov';
const ECCC = 'https://api.weather.gc.ca/collections/citypageweather-realtime/items';
// Relative to this file (js/), not the page, so they work from any page of the site.
const dataFile = (name) => new URL(`../data/${name}`, import.meta.url).href;
// StashFinder X builds only its own ACIS files. The BC, Alberta and SNOTEL files come from the
// main app's site, so nobody's servers are asked for them twice.
const MAIN_DATA = 'https://mutt2jeff.github.io/Snowscout/data/';
const mainDataFile = (name) => MAIN_DATA + name;
const STATION_CACHE_KEY = 'ssx.stations.v2'; // v2: adds each station's time zone
const HOUR = 3600000;
const STATION_CACHE_MS = 7 * 24 * 60 * 60 * 1000;
const PROVINCE_STATION_CACHE_MS = 24 * HOUR;
/** The province files normally refresh every ~30 min. Older than this, the feed itself is behind. */
const FEED_STALE_MS = 3 * HOUR;

/**
 * Canadian provinces whose snow stations come from files our GitHub Action publishes. Both
 * use the same file layout, read with bcHours / bcDays.
 */
const PROVINCES = [
  {
    state: BC_STATE, tz: BC_TZ, triplet: bcTriplet, owns: isBcTriplet, label: 'BC', country: 'CA',
    stationsUrl: mainDataFile('bc-stations.json'), readingsUrl: mainDataFile('bc-readings.json'),
    cacheKey: 'ssx.bcstations.v1', hours: bcHours, days: bcDays,
    link: {
      url: 'https://www2.gov.bc.ca/gov/content/environment/air-land-water/water/water-science-data/water-data-tools/snow-survey-data/automated-snow-weather-stations',
      label: 'Open BC snow station info',
    },
  },
  {
    state: AB_STATE, tz: AB_TZ, triplet: abTriplet, owns: isAbTriplet, label: 'Alberta', country: 'CA',
    stationsUrl: mainDataFile('ab-stations.json'), readingsUrl: mainDataFile('ab-readings.json'),
    cacheKey: 'ssx.abstations.v1', hours: bcHours, days: bcDays,
    link: { url: 'https://rivers.alberta.ca/', label: 'Open Alberta Rivers' },
  },
  // R1: daily observer reports in the Plains, Midwest and Northeast (js/acis.js). Several
  // states, so each station carries its own state and time zone.
  {
    state: null, tzOf: acisTz, triplet: (id, s) => acisTriplet(id, s?.state), owns: isAcisTriplet,
    label: 'Plains, Midwest and Northeast', country: 'US', observer: true,
    stationsUrl: dataFile('acis-stations.json'), readingsUrl: dataFile('acis-readings.json'),
    cacheKey: 'ssx.acisstations.v2', // v2: added MT, ND, SD, NE (and per-station time zones)
    hours: acisHours, days: acisDays,
    /** Older than this, a report no longer colors the map. */
    mapMaxAgeDays: 3,
    link: { url: 'https://www.rcc-acis.org/', label: 'Open NOAA ACIS' },
  },
];

/** The province a triplet belongs to, or null for SNOTEL. */
const provinceOf = (triplet) => PROVINCES.find((p) => p.owns(String(triplet ?? ''))) ?? null;
const HISTORY_DAYS = 14;
const BATCH = 40;
/** Readings newer than this are re-scored instead of downloaded again. */
const REUSE_READINGS_MS = 15 * 60 * 1000;

// The NRCS server often answers "503 Service Unavailable" when busy, but a retry a moment
// later usually works (measured: ~half of requests 503 at busy times, each failing in
// ~0.2 s). So every request gets two quick retries before we give up.
const RETRY_DELAYS_MS = [700, 1800];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, init = {}) {
  let lastError;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt) await sleep(RETRY_DELAYS_MS[attempt - 1]);
    let res;
    try {
      res = await fetch(url, { headers: { Accept: 'application/json' }, ...init });
    } catch {
      // Includes a 503 the browser couldn't read. Offline: no point retrying.
      lastError = new Error(navigator.onLine === false ? 'No internet connection' : 'Could not reach the server');
      if (navigator.onLine === false) break;
      continue;
    }
    if (res.ok) return res.json();
    lastError = new Error(`Server error (${res.status}) – try again shortly`);
    if (res.status < 500 && res.status !== 429) break; // a real error, not "busy"
  }
  throw lastError;
}

// ---- Stations ---------------------------------------------------------------------

let stationsPromise = null;

function toStation(s) {
  return {
    triplet: s.stationTriplet,
    id: s.stationId || s.stationTriplet.split(':')[0],
    name: s.name || `Site ${s.stationTriplet.split(':')[0]}`,
    state: s.stateCode || '',
    county: s.countyName || null,
    elev: s.elevation != null ? Math.round(s.elevation) : null,
    lat: s.latitude ?? null,
    lon: s.longitude ?? null,
    // Hours from UTC that the station's readings are stamped in. SNOTEL uses standard
    // time all year: -8 (Pacific) for every lower-48 station, -9 for Alaska.
    tz: s.dataTimeZone ?? defaultTz(s.stateCode),
  };
}

const defaultTz = (state) => (state === 'AK' ? -9 : -8);

function toProvinceStation(p, s) {
  const state = s.state ?? p.state;
  return {
    triplet: p.triplet(s.id, s), id: s.id, name: s.name || `Station ${s.id}`, state, county: null,
    elev: s.elevFt ?? null, lat: s.lat ?? null, lon: s.lon ?? null,
    tz: p.tzOf ? p.tzOf({ ...s, state }) : p.tz, country: p.country,
    sweOnly: !!s.sweOnly, operator: s.operator ?? null, observer: !!p.observer,
  };
}

/** A station list cached on the phone: fresh copy if old, saved copy if offline. */
async function cachedList(key, maxAgeMs, fetchList) {
  const cached = load(key, null);
  if (cached && Date.now() - cached.savedAt < maxAgeMs && cached.list?.length) return cached.list;
  try {
    const list = await fetchList();
    save(key, { savedAt: Date.now(), list });
    return list;
  } catch (e) {
    if (cached?.list?.length) return cached.list; // offline: use the stale copy
    throw e;
  }
}

const snotelStations = () => cachedList(STATION_CACHE_KEY, STATION_CACHE_MS, async () => {
  const raw = await getJson(`${AWDB}/stations?stationTriplets=*:*:SNTL&returnStationElements=false&activeOnly=true`);
  return raw.filter((s) => !s.networkCode || s.networkCode === 'SNTL').map(toStation);
});

const provinceStations = (p) => cachedList(p.cacheKey, PROVINCE_STATION_CACHE_MS, async () => {
  const file = await getJson(p.stationsUrl, { cache: 'no-cache' });
  return (file?.stations ?? []).map((s) => toProvinceStation(p, s));
});

/**
 * All active SNOTEL stations (~900, cached a week) plus BC's (~150) and Alberta's (~40) snow
 * stations (cached a day). If one network can't be loaded the others still show.
 */
/** Regions whose station list couldn't be loaded last time ("US", "BC", "Alberta"). */
export let missingStationLists = [];

export function allStations() {
  if (!stationsPromise) {
    stationsPromise = (async () => {
      const lists = await Promise.allSettled([snotelStations(), ...PROVINCES.map(provinceStations)]);
      const labels = ['US', ...PROVINCES.map((p) => p.label)];
      missingStationLists = labels.filter((_, i) => lists[i].status === 'rejected');
      if (lists.every((l) => l.status === 'rejected')) throw lists[0].reason;
      // A partial list isn't kept: the next visit to Sites tries the missing region again.
      if (missingStationLists.length) setTimeout(() => { stationsPromise = null; }, 0);
      return lists.flatMap((l) => l.value ?? [])
        .sort((a, b) => a.state.localeCompare(b.state) || a.name.localeCompare(b.name));
    })();
    stationsPromise.catch(() => { stationsPromise = null; }); // allow retry after a failure
  }
  return stationsPromise;
}

export function stationFromTriplet(triplet) {
  const [id, state] = triplet.split(':');
  const p = provinceOf(triplet);
  if (p) return toProvinceStation(p, { id, state: p.state ? undefined : state });
  return { triplet, id, name: `Site ${id}`, state: state || '', county: null, elev: null, lat: null, lon: null, tz: defaultTz(state) };
}

export const isCanadian = (st) => st?.country === 'CA' || provinceOf(st?.triplet)?.country === 'CA';
export const isAlberta = (st) => isAbTriplet(st?.triplet ?? '');
/** A daily observer station (ACIS): one report a day, no hourly readings. */
export const isObserver = (st) => isAcisTriplet(st?.triplet ?? '');

export function stationSubtitle(st) {
  const parts = [st.state];
  if (st.county) parts.push(`${st.county} Co.`);
  if (st.operator) parts.push(st.operator);
  if (st.elev != null) parts.push(`${st.elev.toLocaleString('en-US')} ft`);
  if (st.sweOnly) parts.push('snow water only');
  return parts.join(' · ');
}

/** The agency's own page for a station: NRCS for SNOTEL, the province's site in Canada. */
export function sourceLink(st) {
  const p = provinceOf(st?.triplet);
  if (p) return p.link;
  return { url: `https://wcc.sc.egov.usda.gov/nwcc/site?sitenum=${encodeURIComponent(st.id)}`, label: 'Open NRCS site page' };
}

// ---- Conditions ---------------------------------------------------------------------

const ELEMENT_KEYS = { SNWD: 'depth', WTEQ: 'swe', TOBS: 'tobs', TMAX: 'tmax', TMIN: 'tmin', PREC: 'prec' };
const conditionsCache = new Map(); // triplet -> { station, days, score, minBase }

function toDays(stationData) {
  const byDate = new Map();
  for (const el of stationData?.data ?? []) {
    const key = ELEMENT_KEYS[el.stationElement?.elementCode];
    if (!key) continue;
    for (const v of el.values ?? []) {
      const date = String(v.date).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      const day = byDate.get(date) ?? { date, depth: null, swe: null, tobs: null, tmax: null, tmin: null, prec: null };
      day[key] = v.value ?? null;
      byDate.set(date, day);
    }
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

const HOURLY_KEYS = { SNWD: 'depth', TOBS: 'tobs', WTEQ: 'swe' };

/** Hourly readings -> [{t (ms since epoch), depth, tobs, swe}], oldest first. */
function toHours(stationData, tz) {
  const byT = new Map();
  for (const el of stationData?.data ?? []) {
    const key = HOURLY_KEYS[el.stationElement?.elementCode];
    if (!key) continue;
    for (const v of el.values ?? []) {
      // Stamped in station standard time (tz hours from UTC): convert to a real instant.
      const t = stationTimeToMs(v.date, tz);
      if (t == null) continue;
      const h = byT.get(t) ?? { t, depth: null, tobs: null, swe: null };
      h[key] = v.value ?? null;
      byT.set(t, h);
    }
  }
  return [...byT.values()].sort((a, b) => a.t - b.t);
}

function chunked(list) {
  const chunks = [];
  for (let i = 0; i < list.length; i += BATCH) chunks.push(list.slice(i, i + BATCH));
  return chunks;
}

// Triplets are only digits, capitals and colons, which are safe in a query string as-is.
const dataUrl = (triplets, elements, duration, begin, end) =>
  `${AWDB}/data?stationTriplets=${triplets.join(',')}&elements=${elements}` +
  `&duration=${duration}&beginDate=${begin}&endDate=${end}`;

/**
 * Run one request per group of up to 40 sites. Returns the data by triplet, plus the
 * triplets whose request failed even after retries, and the last error.
 */
async function fetchGroups(triplets, urlFor) {
  const groups = chunked(triplets);
  const results = await Promise.allSettled(groups.map((g) => getJson(urlFor(g))));
  const data = new Map();
  const failed = new Set();
  let error = null;
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') for (const s of r.value ?? []) data.set(s.stationTriplet, s);
    else { groups[i].forEach((t) => failed.add(t)); error = r.reason; }
  });
  return { data, failed, error };
}

/**
 * Latest conditions for each triplet, best score first.
 *
 * Daily readings are always fetched (chart, table, fallback). With useHourly, hourly
 * readings are fetched too, and the score uses whichever is newer.
 *
 * Every good download is saved on the phone. When NRCS doesn't answer (even after
 * retries), the saved readings are used instead, up to the last hour they cover, and the
 * site is marked so the screen can say "saved". Once the phone has the earlier hours, only
 * the latest day of hourly readings is requested, which keeps requests small.
 */
export async function conditions(triplets, minBase, useHourly = false) {
  if (!triplets.length) return [];
  const stations = await allStations().catch(() => []);
  const byTriplet = new Map(stations.map((s) => [s.triplet, s]));
  const today = todayIso();
  const now = Date.now();
  const saved = new Map(triplets.map((t) => [t, savedReadings(t)]));
  // Readings downloaded in the last 15 minutes are re-scored, not downloaded again: NRCS only
  // updates hourly, and this keeps settings changes, new sites and repeat refreshes from
  // sending the whole list again.
  const recentEnough = (t) => {
    const p = saved.get(t);
    if (!p || now - (p.fetchedAt ?? 0) >= REUSE_READINGS_MS) return false;
    return !useHourly || !!provinceOf(t) || !!p.hours?.length || !p.days?.length;
  };
  const reused = new Set(triplets.filter(recentEnough));
  const toFetch = triplets.filter((t) => !reused.has(t));
  const fetched = new Set();
  const us = toFetch.filter((t) => !provinceOf(t));
  const NONE = { data: new Map(), failed: new Set(), error: null };

  // Do we already have the older hours (back past 72h) and something from the last day?
  const hasRecentHours = (t) => {
    const h = saved.get(t)?.hours;
    return !!h?.length && h[0].t <= now - 70 * HOUR && h[h.length - 1].t >= now - 20 * HOUR;
  };

  const [daily, hourly, ...provinceFiles] = await Promise.all([
    us.length
      ? fetchGroups(us, (g) => dataUrl(g, 'SNWD,WTEQ,TOBS,TMAX,TMIN,PREC', 'DAILY', addDays(today, -HISTORY_DAYS), today))
      : NONE,
    useHourly && us.length
      // 3 days back covers the 72h baseline (1 day if saved hours cover the rest);
      // "tomorrow" covers phones in time zones ahead of the stations' Pacific Standard Time.
      ? fetchGroups(us, (g) => dataUrl(g, 'SNWD,TOBS,WTEQ', 'HOURLY',
        addDays(today, g.every(hasRecentHours) ? -1 : -3), addDays(today, 1)))
      : null,
    // BC and Alberta: one small file per province with every station's latest readings.
    ...PROVINCES.map((p) => (toFetch.some(p.owns)
      ? getJson(p.readingsUrl, { cache: 'no-cache' }).then((file) => ({ file }), (error) => ({ error }))
      : null)),
  ]);
  const feedOf = new Map(PROVINCES.map((p, i) => [p, provinceFiles[i]]));
  const feedStale = (f) => !!f?.file && now - f.file.generatedMs > FEED_STALE_MS;

  const updates = {};
  let anyData = false;
  const result = triplets.map((t) => {
    const station = byTriplet.get(t) ?? stationFromTriplet(t);
    const tz = station.tz ?? defaultTz(station.state);
    const prev = saved.get(t);
    const province = provinceOf(t);
    const feed = province ? feedOf.get(province) : null;

    // Fresh readings, or null where the download failed (then the saved ones are used).
    let freshDays, freshHours;
    if (reused.has(t)) {
      // Downloaded a few minutes ago: use what's on the phone as if it were fresh.
      freshDays = prev.days ?? [];
      freshHours = useHourly ? [] : null;
    } else if (province) {
      freshDays = feed.file ? province.days(feed.file, station.id) : null;
      freshHours = feed.file ? province.hours(feed.file, station.id) : null;
    } else {
      freshDays = daily.failed.has(t) ? null : toDays(daily.data.get(t));
      freshHours = hourly && !hourly.failed.has(t) ? toHours(hourly.data.get(t), tz) : null;
    }

    const dailyFailed = freshDays == null;
    const days = freshDays ?? prev?.days ?? [];

    let hours = prev?.hours ?? [];
    const hourlyFailed = useHourly && freshHours == null;
    if (useHourly && freshHours) hours = mergeHours(hours, freshHours);

    updates[t] = { days, hours };
    if (!reused.has(t) && !dailyFailed && !hourlyFailed) fetched.add(t);
    if (days.length || hours.length) anyData = true;

    let s = useHourly ? scoreHourly(hours, days, now, minBase, tz) : score(days, today, minBase);
    const couldntLoad = (dailyFailed || hourlyFailed) && !days.length && !hours.length;
    if (couldntLoad) s = { ...s, notes: [province ? `Couldn't load ${province.label} snow data – try refreshing` : "Couldn't reach NRCS – try refreshing"] };

    if (station.sweOnly && s.depthIn == null) {
      s = { ...s, notes: ['No snow-depth sensor here – this station only measures snow water (SWE), so it has no snow score'] };
    }
    // The province feed itself is behind (our updater stopped): don't blame the station.
    if (province && feedStale(feed) && s.silent) {
      s.notes[0] = `${province.label} data hasn't updated since ${shortTime(feed.file.generatedMs, now)} – numbers may be out of date`;
      s.feedStale = province.label;
    }

    const c = {
      station, days, hours, score: s, minBase, useHourly,
      // Which parts of the shown numbers came from readings saved earlier on this phone.
      dailyFromSave: dailyFailed && days.length > 0,
      hourlyFromSave: hourlyFailed && s.source === 'hourly',
      // When these readings were last downloaded (0 = never).
      fetchedAt: fetched.has(t) ? now : (prev?.fetchedAt ?? 0),
    };
    conditionsCache.set(t, c);
    return c;
  });

  saveReadings(updates, now, fetched);
  // Nothing downloaded and nothing saved to fall back on: report the error.
  const firstError = daily.error ?? hourly?.error ?? provinceFiles.find((f) => f?.error)?.error;
  if (!anyData && firstError) throw firstError;

  // Silent stations (no signal for hours): ask the weather service whether it's storming
  // there, so the note can say "likely snowed in" instead of just "offline". Only silent
  // sites are checked, so this costs nothing on a normal day.
  await Promise.allSettled(result
    .filter((c) => c.score.silent && !c.score.silent.sensorOnly && !c.score.feedStale && c.station.lat != null)
    .map(async (c) => {
      const storm = await stormInfo(c.station);
      if (storm.alert || storm.snowNow) c.score.notes[0] = silenceNote(c.score.silent, storm, now);
      c.storm = storm;
    }));

  return result.sort((a, b) => b.score.score - a.score.score);
}

// ---- Map colors (F1) -----------------------------------------------------------------

const SNOTEL_SUMMARY_URL = mainDataFile('snotel-latest.json'); // built by the main app's Action
let mapFilesPromise = null, mapFilesAt = 0;
const MAP_FILES_REUSE_MS = 15 * 60 * 1000;

/** The shared files behind the map colors, downloaded at most every 15 minutes. */
function mapFiles() {
  if (!mapFilesPromise || Date.now() - mapFilesAt > MAP_FILES_REUSE_MS) {
    mapFilesAt = Date.now();
    const get = (url) => getJson(url, { cache: 'no-cache' }).catch(() => null);
    mapFilesPromise = Promise.all([get(SNOTEL_SUMMARY_URL), ...PROVINCES.map((p) => get(p.readingsUrl))]);
  }
  return mapFilesPromise;
}

/**
 * Snow-score rating for every station the shared files cover, scored with this user's
 * minimum base: { ratings: Map(triplet -> 'epic'|'good'|'fair'|'marginal'|'nogo'), asOfMs }.
 * No phone asks NRCS for this: the US numbers come from data/snotel-latest.json, built every
 * ~3 hours by the GitHub Action, and BC/Alberta from their own shared files. Files missing
 * or more than 12 hours old are skipped, so those dots stay plain.
 */
export async function mapRatings(minBase) {
  const [snotel, ...provinceFiles] = await mapFiles();
  const now = Date.now();
  const ratings = new Map();
  let asOfMs = null;
  const fresh = (f) => f && f.generatedMs && now - f.generatedMs < SUMMARY_MAX_AGE_MS;
  if (fresh(snotel)) {
    for (const [t, row] of Object.entries(snotel.sites ?? {})) {
      const k = mapRating(row, minBase);
      if (k) ratings.set(t, k);
    }
    // When the file was built. (Not the newest reading: NRCS labels an hour by its end, and
    // some stations post it a few minutes early, which would read as a time in the future.)
    asOfMs = snotel.generatedMs;
  }
  PROVINCES.forEach((p, i) => {
    const file = provinceFiles[i];
    if (!fresh(file)) return;
    const today = todayIso();
    for (const [id, rec] of Object.entries(file.stations ?? {})) {
      const tz = p.tzOf ? p.tzOf(rec) : p.tz;
      const s = scoreHourly(p.hours(file, id), p.days(file, id), now, minBase, tz);
      if (s.depthIn == null || !s.rating?.key || s.rating.key === 'nodata') continue;
      if (p.mapMaxAgeDays && s.asOf && daysBetween(s.asOf, today) > p.mapMaxAgeDays) continue;
      ratings.set(p.triplet(id, rec), s.rating.key);
    }
  });
  return { ratings, asOfMs };
}

// ---- Storm check for silent stations -------------------------------------------------

const WINTER_ALERT = /blizzard|winter storm|ice storm|heavy snow|snowfall|lake effect snow|snow squall|winter weather/i;
const stormCache = new Map(); // "lat,lon" -> { at, info }
const STORM_CACHE_MS = 30 * 60 * 1000;

/** Most serious first: warnings, then watches, statements and advisories. */
const seriousness = (e) => (/warning/i.test(e) ? 0 : /watch/i.test(e) ? 1 : 2);

/**
 * { alert: 'Winter Storm Warning' | null, snowNow: boolean } for a station, from the
 * weather service's active alerts and the current/next forecast period (NWS in the US,
 * Environment Canada in BC). Cached for 30 minutes.
 */
export async function stormInfo(station) {
  const { lat, lon } = station;
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  const hit = stormCache.get(key);
  if (hit && Date.now() - hit.at < STORM_CACHE_MS) return hit.info;

  let events = [], periods = [];
  if (isCanadian(station)) {
    const place = await ecccNearest(lat, lon).catch(() => null);
    events = place?.warnings ?? [];
    periods = place?.periods ?? [];
  } else {
    const [alerts, fc] = await Promise.allSettled([
      getJson(`${NWS}/alerts/active?point=${lat.toFixed(4)},${lon.toFixed(4)}`),
      nwsForecast(lat, lon),
    ]);
    events = alerts.status === 'fulfilled'
      ? (alerts.value?.features ?? []).map((f) => f.properties?.event).filter(Boolean) : [];
    periods = fc.status === 'fulfilled' ? fc.value : [];
  }
  const alert = events.filter((e) => WINTER_ALERT.test(e)).sort((a, b) => seriousness(a) - seriousness(b))[0] ?? null;
  const snowNow = periods.slice(0, 2).some((p) => /snow|blizzard|flurr/i.test(p.short));
  const info = { alert, snowNow };
  stormCache.set(key, { at: Date.now(), info });
  return info;
}

/** Cached conditions, only if scored with the same settings. */
export function cachedConditions(triplet, minBase, useHourly = false) {
  const c = conditionsCache.get(triplet);
  return c && c.minBase === minBase && c.useHourly === useHourly ? c : null;
}

// ---- Forecast -----------------------------------------------------------------------

/** Forecast periods for a station, from the NWS (US) or Environment Canada (BC). */
export async function forecast(station) {
  if (isCanadian(station)) return (await ecccNearest(station.lat, station.lon))?.periods ?? [];
  return nwsForecast(station.lat, station.lon);
}

/** Which weather service the forecast comes from, for labels. */
export const forecastSource = (station) => (isCanadian(station) ? 'Environment Canada' : 'NWS');

async function nwsForecast(lat, lon) {
  const point = await getJson(`${NWS}/points/${lat.toFixed(4)},${lon.toFixed(4)}`);
  const url = point?.properties?.forecast;
  if (!url) return [];
  const fc = await getJson(url);
  return (fc?.properties?.periods ?? []).map((p) => ({
    name: p.name,
    isDaytime: p.isDaytime,
    temperature: p.temperature,
    unit: p.temperatureUnit || 'F',
    wind: [p.windDirection, p.windSpeed].filter(Boolean).join(' ') || null,
    short: p.shortForecast || '',
    precip: p.probabilityOfPrecipitation?.value ?? null,
  }));
}

// ---- Environment Canada (BC and Alberta stations) --------------------------------------

const ecccCache = new Map(); // "lat,lon" -> { at, promise }
const en = (v) => (v && typeof v === 'object' ? v.en : v);
const titleCase = (s) => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

/** "YELLOW WARNING - SNOWFALL" -> "Snowfall Warning"; "SPECIAL WEATHER STATEMENT" as is. */
export function ecccWarningName(w) {
  const d = String(en(w?.description) ?? '').trim();
  const m = /^(?:\w+\s+)?(WARNING|WATCH|ADVISORY|STATEMENT)\s*-\s*(.+)$/i.exec(d);
  return m ? `${titleCase(m[2])} ${titleCase(m[1])}` : titleCase(d);
}

/** One Environment Canada city forecast -> SnowScout's forecast periods (°F, mph). */
export function ecccPeriods(props) {
  return (props?.forecastGroup?.forecasts ?? []).map((f) => {
    const t = [].concat(f.temperatures?.temperature ?? [])[0];
    const c = Number(en(t?.value));
    const w = [].concat(f.winds?.periods ?? [])[0];
    const kmh = Number(en(w?.speed?.value));
    const dir = en(w?.direction);
    const pop = Number(en(f.abbreviatedForecast?.pop?.value ?? f.abbreviatedForecast?.pop));
    return {
      name: en(f.period?.textForecastName) || en(f.period?.value) || '',
      isDaytime: en(t?.class) !== 'low',
      temperature: Number.isFinite(c) ? Math.round(c * 9 / 5 + 32) : null,
      unit: 'F',
      wind: Number.isFinite(kmh) && kmh > 0 ? `${dir && dir !== 'VR' ? `${dir} ` : ''}${Math.round(kmh / 1.609)} mph` : null,
      short: en(f.abbreviatedForecast?.textSummary) || en(f.textSummary) || '',
      precip: Number.isFinite(pop) && pop > 0 ? pop : null,
    };
  });
}

/**
 * Forecast and active warnings for the Environment Canada forecast location nearest a point:
 * { place, periods, warnings: ['Snowfall Warning', ...] }. Cached for 30 minutes.
 */
function ecccNearest(lat, lon) {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  const hit = ecccCache.get(key);
  if (hit && Date.now() - hit.at < STORM_CACHE_MS) return hit.promise;
  const promise = (async () => {
    // Widen the search until a forecast location turns up (most stations have a town
    // within ~80 km); small boxes keep the download small.
    for (const d of [0.75, 2, 4]) {
      const bbox = [lon - d * 1.5, lat - d, lon + d * 1.5, lat + d].map((v) => v.toFixed(3)).join(',');
      const res = await getJson(`${ECCC}?f=json&limit=50&bbox=${bbox}`);
      const feats = (res?.features ?? []).filter((f) => f.geometry?.coordinates);
      if (!feats.length) continue;
      const dist = (f) => {
        const [x, y] = f.geometry.coordinates;
        return (x - lon) ** 2 * Math.cos(lat * Math.PI / 180) ** 2 + (y - lat) ** 2;
      };
      const best = feats.sort((a, b) => dist(a) - dist(b))[0];
      return {
        place: en(best.properties?.name) ?? null,
        periods: ecccPeriods(best.properties),
        warnings: [].concat(best.properties?.warnings ?? []).map(ecccWarningName).filter(Boolean),
      };
    }
    return null;
  })();
  ecccCache.set(key, { at: Date.now(), promise });
  promise.catch(() => ecccCache.delete(key));
  return promise;
}
