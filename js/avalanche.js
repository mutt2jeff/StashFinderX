// Avalanche forecasts for a snow station.
//   US: avalanche.org, the National Avalanche Center's feed of every US forecast center.
//       One map file lists each forecast zone's outline and today's danger; a second call
//       gets that zone's full forecast (danger by elevation, problems, bottom line).
//   BC: Avalanche Canada's forecast for the point.
// Both allow requests straight from the browser. SnowScout only shows what the forecast
// center published; it never makes its own avalanche call.

const US_MAP_URL = 'https://api.avalanche.org/v2/public/products/map-layer';
const US_PRODUCT_URL = 'https://api.avalanche.org/v2/public/product';
const CA_POINT_URL = 'https://api.avalanche.ca/forecasts/en/products/point';
const CA_PRODUCT_URL = 'https://api.avalanche.ca/forecasts/en/products';
const CA_AREAS_URL = 'https://api.avalanche.ca/forecasts/en/areas';
const CA_METADATA_URL = 'https://api.avalanche.ca/forecasts/en/metadata';
export const US_HOME = { url: 'https://avalanche.org/', label: 'avalanche.org' };
export const CA_HOME = { url: 'https://avalanche.ca/', label: 'Avalanche Canada' };

const CACHE_MS = 30 * 60 * 1000;
/** A site this close to a zone's edge (but outside it) is shown that zone, marked as nearby. */
export const NEAR_ZONE_MI = 10;

/** North American Public Avalanche Danger Scale. */
export const DANGER = {
  1: { name: 'Low', key: 'low' },
  2: { name: 'Moderate', key: 'moderate' },
  3: { name: 'Considerable', key: 'considerable' },
  4: { name: 'High', key: 'high' },
  5: { name: 'Extreme', key: 'extreme' },
};

/** 1–5, or null for "no rating" / early season / missing. */
export function dangerLevel(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v >= 1 && v <= 5 ? Math.round(v) : null;
  const s = String(v).toLowerCase();
  const n = s.match(/[1-5]/);
  if (n) return +n[0];
  const byName = { low: 1, moderate: 2, considerable: 3, high: 4, extreme: 5 };
  return byName[s.trim()] ?? null;
}

const levelsMax = (levels) => {
  const real = levels.filter((l) => l != null);
  return real.length ? Math.max(...real) : null;
};

// ---- Geometry (zone outlines are GeoJSON, [lon, lat]) -----------------------------

function inRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const polygons = (geom) =>
  !geom ? [] : geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : [];

export function inGeometry(geom, lat, lon) {
  return polygons(geom).some(([outer, ...holes]) => inRing(lon, lat, outer) && !holes.some((h) => inRing(lon, lat, h)));
}

/** Miles from a point to the nearest edge of a zone outline (flat-earth, fine at this scale). */
export function milesToGeometry(geom, lat, lon) {
  const kx = 69.17 * Math.cos((lat * Math.PI) / 180), ky = 69.17;
  let best = Infinity;
  for (const poly of polygons(geom)) {
    for (const ring of poly) {
      for (let i = 1; i < ring.length; i++) {
        const ax = (ring[i - 1][0] - lon) * kx, ay = (ring[i - 1][1] - lat) * ky;
        const bx = (ring[i][0] - lon) * kx, by = (ring[i][1] - lat) * ky;
        const dx = bx - ax, dy = by - ay;
        const len2 = dx * dx + dy * dy;
        const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
        best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
      }
    }
  }
  return best;
}

/** The forecast zone containing the point, or the nearest one within NEAR_ZONE_MI. */
export function findZone(features, lat, lon) {
  const inside = features.filter((f) => inGeometry(f.geometry, lat, lon));
  if (inside.length) {
    // Overlapping zones are rare; prefer one that is actually rated today.
    inside.sort((a, b) => (dangerLevel(b.properties?.danger_level) ?? 0) - (dangerLevel(a.properties?.danger_level) ?? 0));
    return { feature: inside[0], distanceMi: 0 };
  }
  let best = null;
  for (const f of features) {
    const d = milesToGeometry(f.geometry, lat, lon);
    if (d <= NEAR_ZONE_MI && (!best || d < best.distanceMi)) best = { feature: f, distanceMi: d };
  }
  return best;
}

// ---- Text ---------------------------------------------------------------------------

/** Forecast text arrives as HTML; show it as plain text so nothing from it runs in the app. */
export function htmlToText(html) {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(String(html), 'text/html');
  doc.querySelectorAll('script, style').forEach((el) => el.remove());
  doc.querySelectorAll('br, p, li, div').forEach((el) => el.append(' '));
  return (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
}

const capitalize = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// ---- Fetching -----------------------------------------------------------------------

async function getJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Avalanche forecast server answered ${res.status}`);
  return res.json();
}

let usMap = null; // { at, promise }
function usZones() {
  if (!usMap || Date.now() - usMap.at > CACHE_MS) {
    const promise = getJson(US_MAP_URL).then((j) => j?.features ?? []);
    usMap = { at: Date.now(), promise };
    promise.catch(() => { if (usMap?.promise === promise) usMap = null; });
  }
  return usMap.promise;
}

/** Turns avalanche.org's map entry (+ the zone's full forecast, if it loaded) into our shape. */
export function usForecastFrom(feature, distanceMi, product) {
  const p = feature.properties ?? {};
  const bandsFor = (day) => {
    const d = product?.danger?.find((x) => x.valid_day === day);
    if (!d) return null;
    return [
      { name: 'Upper', level: dangerLevel(d.upper) },
      { name: 'Middle', level: dangerLevel(d.middle) },
      { name: 'Lower', level: dangerLevel(d.lower) },
    ];
  };
  const today = bandsFor('current');
  const tomorrow = bandsFor('tomorrow');
  const overall = levelsMax(today?.map((b) => b.level) ?? []) ?? dangerLevel(p.danger_level);
  const problems = (product?.forecast_avalanche_problems ?? []).map((x) => ({
    name: x.name,
    detail: [
      x.likelihood ? capitalize(String(x.likelihood)) : null,
      Array.isArray(x.size) && x.size.length ? `size ${[...new Set(x.size)].join('–')}` : null,
    ].filter(Boolean).join(', '),
  }));
  const expiresMs = Date.parse(product?.expires_time ?? '') || null;
  return {
    region: 'US',
    zone: product?.forecast_zone?.find?.((z) => z.id === feature.id)?.name ?? p.name,
    center: p.center,
    url: product?.forecast_zone?.find?.((z) => z.id === feature.id)?.url || p.link || p.center_link,
    distanceMi,
    offSeason: !!p.off_season,
    overall,
    today,
    tomorrow,
    problems,
    summary: htmlToText(product?.bottom_line) || p.travel_advice || '',
    issuedMs: Date.parse(product?.published_time ?? '') || null,
    expiresMs,
    expired: expiresMs != null && expiresMs < Date.now(),
  };
}

async function usForecast(lat, lon) {
  const zones = await usZones();
  const hit = findZone(zones, lat, lon);
  if (!hit) return null;
  const p = hit.feature.properties ?? {};
  let product = null;
  if (p.center_id && hit.feature.id != null && !p.off_season) {
    const q = new URLSearchParams({ type: 'forecast', center_id: p.center_id, zone_id: String(hit.feature.id) });
    product = await getJson(`${US_PRODUCT_URL}?${q}`).catch(() => null); // fall back to the map entry
  }
  return usForecastFrom(hit.feature, hit.distanceMi, product);
}

/**
 * Avalanche Canada titles a forecast with every area it covers, joined by "-" (the
 * early-season bulletin lists ~90). Keep the first few so it fits on a phone.
 */
export function shortRegionName(title) {
  if (title.length <= 60) return title;
  const parts = title.split('-').map((s) => s.trim()).filter(Boolean);
  if (parts.length > 30) return 'All Avalanche Canada regions';
  return `${parts.slice(0, 3).join(', ')} and ${parts.length - 3} more areas`;
}

/** Turns an Avalanche Canada forecast into our shape (null when nothing covers it). */
export function caForecastFrom(j) {
  const r = j?.report;
  if (!r || !j.url || (!r.title && !r.dangerRatings)) return null;
  const bandsFor = (day) => {
    const d = r.dangerRatings?.[day]?.ratings;
    if (!d) return null;
    return [
      { name: 'Alpine', level: dangerLevel(d.alp?.rating?.value), label: d.alp?.rating?.display },
      { name: 'Treeline', level: dangerLevel(d.tln?.rating?.value), label: d.tln?.rating?.display },
      { name: 'Below treeline', level: dangerLevel(d.btl?.rating?.value), label: d.btl?.rating?.display },
    ];
  };
  const today = bandsFor(0);
  const tomorrow = bandsFor(1);
  const early = (r.dangerRatings ?? []).some((d) => /early/i.test(d?.ratings?.alp?.rating?.value ?? ''));
  const title = r.title || 'Avalanche Canada forecast';
  const problems = (r.problems ?? []).map((x) => ({
    name: x.type?.display ?? x.type?.value ?? x.name ?? String(x.type ?? 'Avalanche problem'),
    detail: '', // Avalanche Canada's problem notes are long; the full forecast has them
  }));
  const expiresMs = Date.parse(r.validUntil ?? '') || null;
  return {
    region: 'CA',
    zone: shortRegionName(title),
    center: j.owner?.display || 'Avalanche Canada',
    url: j.url,
    distanceMi: 0,
    offSeason: early,
    overall: levelsMax(today?.map((b) => b.level) ?? []),
    today,
    tomorrow,
    problems,
    summary: htmlToText(r.highlights),
    issuedMs: Date.parse(r.dateIssued ?? '') || null,
    expiresMs,
    expired: expiresMs != null && expiresMs < Date.now(),
  };
}

let caAreas = null; // { at, promise } -> { features, metadata }
function caAreaList() {
  if (!caAreas || Date.now() - caAreas.at > CACHE_MS) {
    const promise = Promise.all([getJson(CA_AREAS_URL), getJson(CA_METADATA_URL)])
      .then(([areas, metadata]) => ({ features: areas?.features ?? [], metadata: Array.isArray(metadata) ? metadata : [] }));
    caAreas = { at: Date.now(), promise };
    promise.catch(() => { if (caAreas?.promise === promise) caAreas = null; });
  }
  return caAreas.promise;
}

async function caForecast(lat, lon) {
  const q = new URLSearchParams({ lat: lat.toFixed(4), long: lon.toFixed(4) });
  const direct = caForecastFrom(await getJson(`${CA_POINT_URL}?${q}`));
  if (direct) return direct;
  // Avalanche Canada's point lookup misses sites on or just past a region's edge
  // (e.g. Yellowhead Lake on the Jasper boundary), so check the region outlines too.
  const { features, metadata } = await caAreaList();
  const hit = findZone(features, lat, lon);
  const meta = hit && metadata.find((m) => m.area?.id === hit.feature.id);
  if (!meta?.product?.slug) return null;
  const j = await getJson(`${CA_PRODUCT_URL}/${encodeURIComponent(meta.product.slug)}`);
  const f = caForecastFrom({ ...j, url: j.url || meta.url, owner: j.owner || meta.owner });
  return f && { ...f, distanceMi: hit.distanceMi };
}

const byStation = new Map(); // triplet -> { at, promise }

/**
 * The avalanche forecast that covers a station, or null if no forecast center covers it.
 * Throws if the forecast server can't be reached.
 */
export function avalancheForecast(station, { canadian = false } = {}) {
  if (station?.lat == null || station?.lon == null) return Promise.resolve(null);
  const hit = byStation.get(station.triplet);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.promise;
  const promise = canadian ? caForecast(station.lat, station.lon) : usForecast(station.lat, station.lon);
  byStation.set(station.triplet, { at: Date.now(), promise });
  promise.catch(() => byStation.delete(station.triplet));
  return promise;
}
