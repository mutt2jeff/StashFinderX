// Builds data/acis-stations.json and data/acis-readings.json: daily snow reports from NWS
// co-op and CoCoRaHS observers in the Plains, Midwest and Northeast (R1, see js/acis.js). Run by the
// GitHub Action (.github/workflows/publish.yml) about every 30 minutes; it only asks ACIS for
// new data when the live files are about 3 hours old, otherwise it republishes them as they are.
//
//   node scripts/build-acis-data.mjs            (FORCE=1 to download regardless)
//
// One request per state (7 in all, one at a time), so about 56 a day however many people
// use the app. If ACIS doesn't answer for a state, that state's stations are kept from the
// previous files; if nothing at all comes back, the previous files are republished.

import { mkdir, writeFile } from 'node:fs/promises';
import { ACIS_DAYS, ACIS_STATES, ACIS_URL, acisRequest, buildAcisData } from '../js/acis.js';

const OUT_DIR = new URL('../data/', import.meta.url);
const UA = 'StashFinder/1.0 (backcountry snow-conditions app; GitHub Pages)';
const GAP_MS = 1500;                       // pause between requests: be polite to ACIS
const REFRESH_AFTER_MS = 2.75 * 3600000;   // with 30-minute runs, refreshes every ~3 hours

const repo = process.env.GITHUB_REPOSITORY;
const LIVE = process.env.STASHFINDER_LIVE_URL ||
  (repo ? `https://${repo.split('/')[0].toLowerCase()}.github.io/${repo.split('/')[1]}/` : null);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(url, init = {}, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    if (i) await sleep(5000 * i);
    try {
      const res = await fetch(url, {
        ...init,
        headers: { 'User-Agent': UA, Accept: 'application/json', ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(120000),
      });
      if (res.ok) {
        const json = await res.json();
        if (json?.error) throw new Error(json.error); // ACIS reports bad requests in the body
        return json;
      }
      last = new Error(`${res.status} ${res.statusText}`);
    } catch (e) { last = e; }
  }
  throw new Error(`${url.slice(0, 100)}: ${last?.message ?? last}`);
}

const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

async function main() {
  const now = Date.now();
  await mkdir(OUT_DIR, { recursive: true });
  const write = (name, obj) => writeFile(new URL(name, OUT_DIR), JSON.stringify(obj));
  const live = (name) => (LIVE ? request(new URL(`data/${name}`, LIVE).href, {}, 2).catch(() => null) : null);

  const [prevStations, prevReadings] = await Promise.all([live('acis-stations.json'), live('acis-readings.json')]);
  const havePrevious = prevStations?.stations && prevReadings?.stations;
  const age = havePrevious && prevReadings.generatedMs ? now - prevReadings.generatedMs : Infinity;
  if (!process.env.FORCE && age < REFRESH_AFTER_MS) {
    await write('acis-stations.json', prevStations);
    await write('acis-readings.json', prevReadings);
    console.log(`ACIS: kept the live files (${Math.round(age / 60000)} min old)`);
    return;
  }

  // ACIS dates are the observers' local dates; "today" in Eastern time covers every state.
  const end = iso(now - 5 * 3600000);
  const start = iso(Date.parse(end) - (ACIS_DAYS - 1) * 86400000);
  const byState = {};
  const failed = [];
  for (const state of Object.keys(ACIS_STATES)) {
    try {
      byState[state] = await request(ACIS_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(acisRequest(state, start, end)),
      });
    } catch (e) { failed.push(`${state} (${e.message})`); }
    await sleep(GAP_MS);
  }
  if (!Object.keys(byState).length) {
    if (!havePrevious) throw new Error('No ACIS data, and no previous files to fall back on');
    await write('acis-stations.json', prevStations);
    await write('acis-readings.json', prevReadings);
    console.warn('ACIS: nothing downloaded, republished the previous files');
    return;
  }

  const { stationsFile, readingsFile } = buildAcisData(byState, now, start);
  // A state that failed keeps its stations from the previous build (values move to the new
  // start date; anything older than the new window falls off).
  if (failed.length && havePrevious) {
    const shift = Math.round((Date.parse(start) - Date.parse(prevReadings.startDate)) / 86400000);
    const failedStates = new Set(failed.map((f) => f.slice(0, 2)));
    for (const s of prevStations.stations) {
      if (!failedStates.has(s.state)) continue;
      const r = prevReadings.stations[s.id];
      if (!r) continue;
      const move = (a) => (a ?? []).slice(Math.max(0, shift));
      stationsFile.stations.push(s);
      readingsFile.stations[s.id] = { state: r.state, depth: move(r.depth), snow: move(r.snow), temp: move(r.temp) };
    }
  }
  await write('acis-stations.json', stationsFile);
  await write('acis-readings.json', readingsFile);
  const perState = Object.fromEntries(Object.keys(ACIS_STATES).map((st) =>
    [st, stationsFile.stations.filter((s) => s.state === st).length]));
  console.log(`ACIS ${start}..${end}: ${stationsFile.stations.length} stations ${JSON.stringify(perState)}, ` +
    `latest report ${readingsFile.latestDate}${failed.length ? `; failed: ${failed.join(', ')}` : ''}`);
}

main().catch((e) => {
  // Don't fail the whole publish: the app just shows no Plains/Midwest/Northeast stations.
  console.error('ACIS files not built:', e.message);
  process.exitCode = 0;
});
