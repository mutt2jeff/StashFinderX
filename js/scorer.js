// Snow score (called the sled score before Nov 2026): a port of the Android app's SnowScorer.kt, plus (web only, for now) scoring
// from the latest HOURLY SNOTEL readings. Keep the rules in step with Android.
//
// Base depth is a gate:
//  - Below the rider's minimum base (default 18", Settings 6-48") the site is "No go"
//    and scores 0-19 on depth alone. Cold temps and new snow can't lift bare ground.
//  - At or above it, the score starts at 20 and climbs to 100:
//      55% base depth (minimum -> max(48", minimum + 24"))
//      30% new snow (12"+ in 72h for full marks)
//      15% temperature (25F or colder full marks, none at 40F+)
//
// Daily and hourly readings only differ in how depth / new snow / temperature are
// measured; both go through the same rate() rules below.

export const DEFAULT_MIN_BASE_IN = 18;
export const FULL_DEPTH_IN = 48;
export const DEPTH_HEADROOM_IN = 24;
export const FULL_FRESH_IN = 12;
export const MIN_BASE_RANGE = [6, 48];

export const RIDEABLE_FLOOR = 20;
const DEPTH_WEIGHT = 0.55;
const FRESH_WEIGHT = 0.30;
const TEMP_WEIGHT = 0.15;

/**
 * Hourly readings (including ones saved on the phone) are used until a newer daily reading
 * exists. In heavy snow a SNOTEL station often can't get its signal out and goes silent
 * for hours or days. That doesn't mean the snow is gone, so the last report keeps being
 * used (clearly marked) for up to a week rather than being thrown away.
 */
export const HOURLY_MAX_AGE_HOURS = 7 * 24;

/**
 * NRCS normally posts hourly readings 1-2 hours late. A station whose last snow-depth
 * reading is older than this is treated as silent (likely snowed in or offline).
 */
export const SILENT_AFTER_HOURS = 4;
const HOUR = 3600000;

export const Rating = Object.freeze({
  EPIC: { key: 'epic', label: 'Epic' },
  GOOD: { key: 'good', label: 'Good' },
  FAIR: { key: 'fair', label: 'Fair' },
  MARGINAL: { key: 'marginal', label: 'Marginal' },
  NOT_RIDEABLE: { key: 'nogo', label: 'No go' },
  NO_DATA: { key: 'nodata', label: 'No data' },
});

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Days between two 'YYYY-MM-DD' strings (b - a), ignoring time zones. */
export function daysBetween(a, b) {
  const toUtc = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
  return Math.round((toUtc(b) - toUtc(a)) / 86400000);
}

/** 'YYYY-MM-DD' shifted by n days. */
export function addDays(iso, n) {
  const d = new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10) + n));
  return d.toISOString().slice(0, 10);
}

/** A date's 'YYYY-MM-DD' in the phone's local time zone. */
export function localIso(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
export const todayIso = () => localIso();

const shortDate = (iso) =>
  new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

/** Base depth that earns full depth marks: at least 48", and always 24" above the minimum. */
export function fullDepthFor(minBaseIn) {
  return Math.max(FULL_DEPTH_IN, minBaseIn + DEPTH_HEADROOM_IN);
}

export function ratingFor(score) {
  if (score >= 80) return Rating.EPIC;
  if (score >= 60) return Rating.GOOD;
  if (score >= 40) return Rating.FAIR;
  if (score >= RIDEABLE_FLOOR) return Rating.MARGINAL;
  return Rating.NOT_RIDEABLE;
}

/**
 * New snow over 3 days is never shown as less than over the last day. Snow settles, so the
 * depth today can be no higher than 3 days ago even after a fresh 5" – but that 5" is still
 * new snow, and it should count in the score.
 */
export function atLeast24(new72, new24) {
  if (new72 == null) return new24 ?? null;
  if (new24 == null) return new72;
  return Math.max(new72, new24);
}

/** The scoring rules. Inputs in inches / °F; any may be null except depth. */
export function rate({ depth, new24, new72, temp }, minBaseIn = DEFAULT_MIN_BASE_IN) {
  const minBase = Math.max(1, minBaseIn);
  const notes = [];
  let value;

  if (depth < minBase) {
    value = Math.round(clamp(depth / minBase, 0, 1) * (RIDEABLE_FLOOR - 1));
    const short = Math.max(1, Math.round(minBase - depth));
    notes.push(`Too thin – needs about ${short}" more base`);
    if ((new72 ?? 0) >= 6) notes.push(`Building – ${Math.round(new72)}" new in 3 days`);
  } else {
    const fullDepth = fullDepthFor(minBase);
    const depthFactor = clamp((depth - minBase) / (fullDepth - minBase), 0, 1);
    const freshFactor = clamp((new72 ?? new24 ?? 0) / FULL_FRESH_IN, 0, 1);
    let tempFactor;
    if (temp == null) tempFactor = 0.5;
    else if (temp <= 25) tempFactor = 1;
    else if (temp >= 40) tempFactor = 0;
    else tempFactor = (40 - temp) / 15;
    const blended = DEPTH_WEIGHT * depthFactor + FRESH_WEIGHT * freshFactor + TEMP_WEIGHT * tempFactor;
    value = Math.round(RIDEABLE_FLOOR + (100 - RIDEABLE_FLOOR) * blended);

    if (depth < minBase + 6) notes.push('Thin base – watch for rocks and stumps');
    if ((new24 ?? 0) >= 6) notes.push('Fresh powder in the last 24 hours');
    else if ((new72 ?? 0) >= 8) notes.push('Good new snow over the last 3 days');
    if (temp != null && temp > 32) notes.push('Above freezing – heavy, wet snow');
  }

  const score = clamp(value, 0, 100);
  return { score, rating: depth < minBase ? Rating.NOT_RIDEABLE : ratingFor(score), notes };
}

// ---- Daily readings (same behaviour as the Android app) -----------------------------

/**
 * @param days  [{date:'YYYY-MM-DD', depth, swe, tobs, tmax, tmin, prec}] any order; values may be null
 * @param today 'YYYY-MM-DD'
 * @param minBaseIn rider's minimum rideable base, inches
 */
export function score(days, today = todayIso(), minBaseIn = DEFAULT_MIN_BASE_IN) {
  const sorted = [...days].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const lastWith = (key) => [...sorted].reverse().find((d) => d[key] != null);
  const latest = lastWith('depth');
  const latestSwe = lastWith('swe')?.swe ?? null;

  if (!latest) {
    const last = sorted[sorted.length - 1];
    return {
      score: 0, rating: Rating.NO_DATA, source: 'daily',
      depthIn: null, new24In: null, new72In: null,
      sweIn: latestSwe, tempF: last ? (last.tobs ?? last.tmax ?? null) : null,
      asOf: last?.date ?? null, asOfMs: null,
      notes: ['No snow depth reported recently'],
    };
  }

  const depth = latest.depth;
  const byDate = new Map(sorted.map((d) => [d.date, d]));
  const newSince = (daysBack) => {
    const prior = byDate.get(addDays(latest.date, -daysBack))?.depth;
    return prior == null ? null : Math.max(0, depth - prior);
  };
  // Observer stations (ACIS) measure new snowfall themselves: that beats the change in depth,
  // which settling hides. Their days carry a `snow` field; SNOTEL's and the provinces' don't.
  const reportsSnowfall = sorted.some((d) => d.snow !== undefined);
  let new24, new72;
  if (reportsSnowfall) {
    const snowOn = (back) => byDate.get(addDays(latest.date, -back))?.snow ?? null;
    const last3 = [0, 1, 2].map(snowOn);
    new24 = snowOn(0) ?? newSince(1);
    new72 = atLeast24(last3.some((v) => v != null) ? last3.reduce((a, v) => a + (v ?? 0), 0) : newSince(3), new24);
  } else {
    new24 = newSince(1);
    new72 = atLeast24(newSince(3), new24);
  }
  const swe = latest.swe ?? latestSwe;
  const temp = latest.tobs ?? latest.tmax ?? null;

  const r = rate({ depth, new24, new72, temp }, minBaseIn);
  if (daysBetween(latest.date, today) > 2) r.notes.push(`No report since ${shortDate(latest.date)}`);

  return {
    ...r, source: 'daily',
    depthIn: depth, new24In: new24, new72In: new72, sweIn: swe, tempF: temp,
    asOf: latest.date, asOfMs: null,
    ...(reportsSnowfall ? { observer: true } : {}),
  };
}

// ---- Hourly readings ----------------------------------------------------------------

/**
 * SNOTEL hourly timestamp ('YYYY-MM-DD HH:MM', station standard time, tz hours from UTC)
 * -> ms since epoch, or null if it doesn't parse.
 */
export function stationTimeToMs(stamp, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(stamp));
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - tz * HOUR : null;
}

/**
 * When a daily value was measured: the daily value for date D is the reading at midnight
 * at the END of D (checked against hourly data: daily Nov 21 = hourly Nov 22 00:00).
 */
export function dailyReadingMs(isoDate, tz) {
  return stationTimeToMs(`${addDays(isoDate, 1)} 00:00`, tz);
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Current conditions from hourly readings, or null if there are none recent enough.
 *
 * The snow-depth sensor is ultrasonic and can bounce an inch or two between hours
 * (falling snow, wind), so depth is the median of the readings in a 3-hour window.
 * One bad reading can't swing the score.
 *
 * @param hours [{t: ms since epoch, depth, tobs, swe}]
 * @param nowMs current time, ms since epoch
 */
export function currentFromHourly(hours, nowMs = Date.now(), maxAgeHours = HOURLY_MAX_AGE_HOURS) {
  const withDepth = hours
    .filter((h) => h.depth != null && h.t <= nowMs + HOUR)
    .sort((a, b) => a.t - b.t);
  if (!withDepth.length) return null;
  const latestT = withDepth[withDepth.length - 1].t;
  if (nowMs - latestT > maxAgeHours * HOUR) return null;

  // Depth around a moment: median of readings within the 3 hours ending at `t` (+1h slack
  // for the older baselines, since stations occasionally skip an hour).
  const depthAround = (t, before, after) => {
    const xs = withDepth.filter((h) => h.t >= t - before && h.t <= t + after).map((h) => h.depth);
    return xs.length ? median(xs) : null;
  };
  // Baseline for "new snow": readings around the moment, or if the station was silent
  // then (a gap in the data), its last reading in the 6 hours before.
  const baseline = (t) => {
    const near = depthAround(t, HOUR, HOUR);
    if (near != null) return near;
    const before = withDepth.filter((h) => h.t <= t && h.t >= t - 6 * HOUR);
    return before.length ? before[before.length - 1].depth : null;
  };
  const depth = depthAround(latestT, 2 * HOUR, 0);
  const ago = (hrs) => {
    const d = baseline(latestT - hrs * HOUR);
    return d == null ? null : Math.max(0, depth - d);
  };

  const sortedAll = [...hours].sort((a, b) => b.t - a.t);
  const lastOf = (key, maxAgeHrs) => {
    const h = sortedAll.find((x) => x[key] != null && latestT - x.t <= maxAgeHrs * HOUR);
    return h ? h[key] : null;
  };
  // Last time the station sent anything at all (temperature can keep coming in while
  // heavy snowfall blocks the ultrasonic depth sensor).
  const lastReport = sortedAll.find((x) => x.depth != null || x.tobs != null || x.swe != null);

  return {
    depth,
    new24: ago(24),
    new72: ago(72),
    temp: lastOf('tobs', 3),
    swe: lastOf('swe', 12),
    asOfMs: latestT,
    lastReportMs: lastReport ? lastReport.t : latestT,
  };
}

/**
 * Is the station silent? Returns null when it's reporting normally, otherwise
 * { sinceMs, hours, sensorOnly } where sensorOnly means the station is still sending
 * other readings but its snow-depth sensor isn't.
 */
export function silence(cur, nowMs = Date.now()) {
  if (!cur) return null;
  const quietHours = (nowMs - cur.asOfMs) / HOUR;
  if (quietHours < SILENT_AFTER_HOURS) return null;
  return {
    sinceMs: cur.asOfMs,
    hours: Math.floor(quietHours),
    sensorOnly: (nowMs - cur.lastReportMs) / HOUR < SILENT_AFTER_HOURS,
  };
}

/** "2:00 PM" today, "Sat 2:00 PM" otherwise, in the phone's time zone. */
export function shortTime(ms, nowMs = Date.now()) {
  const d = new Date(ms);
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return localIso(d) === localIso(new Date(nowMs)) ? time : `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${time}`;
}

/**
 * The note for a silent station. storm (from the NWS, optional):
 * { alert: 'Winter Storm Warning' | null, snowNow: boolean }.
 */
export function silenceNote(sig, storm = null, nowMs = Date.now()) {
  const when = shortTime(sig.sinceMs, nowMs);
  if (sig.sensorOnly) {
    return `Snow-depth sensor silent since ${when} – heavy snowfall can block it. Depth is from its last reading`;
  }
  if (storm?.alert) return `No report since ${when} – ${storm.alert} here, station is likely snowed in. Expect more snow than shown`;
  if (storm?.snowNow) return `No report since ${when} – snowing here per NWS, signal likely blocked. Expect more snow than shown`;
  return `No report since ${when} – station may be snowed in or offline. Numbers are from its last report`;
}

/**
 * Score from hourly readings when they are newer than the daily reading, otherwise the
 * daily score. Missing hourly pieces (temperature, 72h baseline) fall back to the daily
 * values. tz: hours from UTC the station's readings are stamped in.
 */
export function scoreHourly(hours, days, nowMs = Date.now(), minBaseIn = DEFAULT_MIN_BASE_IN, tz = -8) {
  const daily = score(days, localIso(new Date(nowMs)), minBaseIn);
  const cur = currentFromHourly(hours, nowMs);
  if (!cur) return daily;
  if (daily.asOf && daily.depthIn != null && cur.asOfMs < dailyReadingMs(daily.asOf, tz)) return daily;

  const inputs = {
    depth: cur.depth,
    new24: cur.new24 ?? daily.new24In,
    new72: null,
    temp: cur.temp ?? daily.tempF,
  };
  inputs.new72 = atLeast24(cur.new72 ?? daily.new72In, inputs.new24);
  const r = rate(inputs, minBaseIn);
  // A silent station leads its notes: it matters more than anything else on the card.
  const sig = silence(cur, nowMs);
  if (sig) r.notes.unshift(silenceNote(sig, null, nowMs));
  return {
    ...r, source: 'hourly',
    depthIn: inputs.depth, new24In: inputs.new24, new72In: inputs.new72,
    sweIn: cur.swe ?? daily.sweIn, tempF: inputs.temp,
    asOf: localIso(new Date(cur.asOfMs)), asOfMs: cur.asOfMs,
    silent: sig,
  };
}
