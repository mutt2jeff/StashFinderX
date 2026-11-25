// StashFinder web app: screens and navigation.
// Mirrors the Android app: dashboard (ranked sites), site picker (map + list),
// site detail (chart, forecast, daily table), settings (minimum base).

import * as api from './api.js';
import { matchesSearch } from './search.js';
import { avalancheForecast, DANGER, US_HOME, CA_HOME } from './avalanche.js';
import { getSettings, updateSettings, onSettingsChange, toggleSite, isSelected, removeSite, restoreSite, MAX_SITES } from './store.js';
import { MIN_BASE_RANGE, RIDEABLE_FLOOR, FULL_FRESH_IN, fullDepthFor, addDays, shortTime, daysBetween, localIso } from './scorer.js';

const app = document.getElementById('app');

// ---- Helpers ------------------------------------------------------------------------

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

const ICONS = {
  refresh: 'M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z',
  settings: 'M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z',
  back: 'M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z',
  add: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z',
  search: 'M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z',
  close: 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
  check: 'M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z',
  map: 'M20.5 3l-.16.03L15 5.1 9 3 3.36 4.9c-.21.07-.36.25-.36.48V20.5c0 .28.22.5.5.5l.16-.03L9 18.9l6 2.1 5.64-1.9c.21-.07.36-.25.36-.48V3.5c0-.28-.22-.5-.5-.5zM15 19l-6-2.11V5l6 2.11V19z',
  list: 'M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z',
  globe: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z',
  snow: 'M22 11h-4.17l3.24-3.24-1.41-1.42L15 11h-2V9l4.66-4.66-1.42-1.41L13 6.17V2h-2v4.17L7.76 2.93 6.34 4.34 11 9v2H9L4.34 6.34 2.93 7.76 6.17 11H2v2h4.17l-3.24 3.24 1.41 1.42L9 13h2v2l-4.66 4.66 1.42 1.41L11 17.83V22h2v-4.17l3.24 3.24 1.42-1.41L13 15v-2h2l4.66 4.66 1.41-1.42L17.83 13H22z',
};
const icon = (name, size = 24) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><path d="${ICONS[name]}"/></svg>`;

const inches = (v) => (v == null ? '–' : `${Math.round(v)}"`);
const newInches = (v) => (v == null ? '–' : v < 0.5 ? '0"' : `+${Math.round(v)}"`);
const sweInches = (v) => (v == null ? '–' : `${v.toFixed(1)}"`);
const degF = (v) => (v == null ? '–' : `${Math.round(v)}°F`);
const isoToDate = (iso) => new Date(iso + 'T12:00:00');
const fmtShort = (iso) => isoToDate(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

/**
 * "As of 4:00 PM" for hourly scores (in the phone's time zone), "Daily reading · Nov 21"
 * otherwise; "(saved)" when NRCS didn't answer and the phone's saved readings are shown.
 */
function readingTime(s, c = {}) {
  if (s.source === 'hourly' && s.asOfMs) {
    const when = shortTime(s.asOfMs);
    // Our BC or Alberta data feed is behind: that's not the station's fault.
    if (s.feedStale) return `Last update ${when} · ${s.feedStale} data delayed`;
    // Silent station (snowed in / no signal): say so plainly, it's not current.
    if (s.silent) return s.silent.sensorOnly ? `Depth sensor silent since ${when}` : `Last report ${when} · no signal`;
    return `As of ${when}${c.hourlyFromSave ? ' (saved)' : ''}`;
  }
  if (s.asOf && s.observer) {
    // Observer stations (ACIS) report once a day, usually around 7 AM.
    const ago = daysBetween(s.asOf, localIso());
    const when = ago <= 0 ? 'this morning' : ago === 1 ? 'yesterday morning' : `${fmtShort(s.asOf)} (morning)`;
    return `Observer report · ${when}${c.dailyFromSave ? ' (saved)' : ''}`;
  }
  return s.asOf ? `Daily reading · ${fmtShort(s.asOf)}${c.dailyFromSave ? ' (saved)' : ''}` : '';
}

const badge = (s, large = false) =>
  `<div class="badge ${s.rating.key}${large ? ' lg' : ''}" role="img" aria-label="Snow score ${s.score}, ${s.rating.label}">` +
  `<b>${s.rating.key === 'nodata' ? '–' : s.score}</b><span>${s.rating.label}</span></div>`;

const metric = (label, value, hot = false) =>
  `<div class="metric${hot ? ' hot' : ''}"><b>${value}</b><span>${label}</span></div>`;

const errorBanner = (msg) =>
  `<div class="banner" role="alert"><span>${esc(msg)}</span><button type="button" data-retry>Retry</button></div>`;

const backButton = () => `<button class="icon-btn" data-back aria-label="Back">${icon('back')}</button>`;

function goBack() {
  if (history.length > 1) history.back();
  else location.hash = '#/';
}

const siteHref = (triplet) => `#/site/${encodeURIComponent(triplet)}`;

// ---- Visit counts -------------------------------------------------------------------
// Anonymous screen counts through GoatCounter (see index.html). If its script hasn't loaded
// yet, the view is counted once it does; offline or blocked, nothing is counted.
// Paths and titles are written to read well in the GoatCounter dashboard, e.g.
// "/station/CA/Ebbetts Pass" titled "Ebbetts Pass, CA (SNOTEL 462)".

// StashFinder X counts nothing: index.html doesn't load GoatCounter, so this does nothing.
function countView(path, title) {
  window.goatcounter?.count?.({ path, title });
}

function countStation(st) {
  const network = api.isAlberta(st) ? 'Alberta snow station' : api.isCanadian(st) ? 'BC snow station' : 'SNOTEL';
  countView(`/station/${st.state}/${st.name}`, `${st.name}, ${st.state} (${network} ${st.id})`);
}

// ---- Phone app beta invitation ------------------------------------------------------
// The phone apps are going into closed betas (Nov 2026): Android through Google Play testing,
// iPhone through TestFlight. Testers are added by the email on their Google Play account or
// Apple ID, so the invitation asks people to email the developer address with their phone
// type and that email. The address is put together here rather than written out, to keep it
// away from simple scrapers.

const BETA_EMAIL = ['support', 'stashfinder.app'].join('@'); // forwards to the developer Gmail (Cloudflare Email Routing)
const BETA_DISMISS_KEY = 'ssx.betaInviteDismissed.v2';

function betaMailto() {
  const subject = 'StashFinder beta tester';
  const body = "Hi! I'd like to test the StashFinder phone app.\n\n" +
    'My phone (Android or iPhone): \n' +
    'My Google Play or Apple ID email: \n';
  return `mailto:${BETA_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

// StashFinder X: the beta invitation stays in the main app only.
function betaDismissed() {
  return true;
}

/** What StashFinder X is, shown on the dashboard and in Settings. */
const xNotice = () => `
  <section class="invite x-notice" aria-label="About StashFinder X">
    <b>StashFinder X: experimental</b>
    <p>This is the test bench for new StashFinder features, and things here may change or break. Now testing:
      daily snow reports from NWS co-op and CoCoRaHS observers in Minnesota, Wisconsin, Michigan, New York, Vermont,
      New Hampshire and Maine (through NOAA's ACIS). The regular app is at
      <a href="https://stashfinder.app/">stashfinder.app</a>.</p>
  </section>`;

/** The beta invitation card. [closable]: show the × (dashboard); settings keeps it for good. */
const betaInvite = (closable) => `
  <section class="invite" aria-label="Phone app beta">
    <b>StashFinder phone apps: beta testers wanted</b>
    <p>StashFinder is starting closed betas for Android (Google Play) and iPhone (TestFlight). To join,
      email <a href="${betaMailto()}">${BETA_EMAIL}</a> with your phone type and the email address on
      your Google Play account or Apple ID. You'll get an invitation when your phone's beta is ready.</p>
    <a class="btn" href="${betaMailto()}">Join the beta</a>
    ${closable ? `<button type="button" class="x" data-beta-close aria-label="Hide this message">${icon('close')}</button>` : ''}
  </section>`;

// ---- Router -------------------------------------------------------------------------

let cleanup = null;

function route() {
  if (cleanup) cleanup();
  cleanup = null;
  const hash = location.hash || '#/';
  window.scrollTo(0, 0);
  // Station pages are counted by renderDetail once the station's name is known.
  if (hash.startsWith('#/site/')) cleanup = renderDetail(decodeURIComponent(hash.slice('#/site/'.length)));
  else if (hash === '#/sites') { countView('/choose-sites', 'Choose sites (map and search)'); cleanup = renderSites(); }
  else if (hash === '#/settings') { countView('/settings', 'Settings'); cleanup = renderSettings(); }
  else { countView('/dashboard', 'Dashboard (my sites)'); cleanup = renderDashboard(); }
}

app.addEventListener('click', (e) => {
  if (e.target.closest('[data-back]')) goBack();
});

// ---- Dashboard ----------------------------------------------------------------------

const SORTS = [
  { key: 'score', label: 'Best overall', by: (c) => c.score.score },
  { key: 'depth', label: 'Deepest base', by: (c) => c.score.depthIn ?? -1 },
  { key: 'fresh', label: 'Most new snow', by: (c) => c.score.new72In ?? c.score.new24In ?? -1 },
];

// undo: { triplet, name } of a site just removed on its detail page, for the Undo bar.
const dash = { sites: [], loading: false, error: null, updatedAt: null, sort: 'score', key: null, undo: null };

function renderDashboard() {
  let alive = true;
  app.innerHTML = `
    <div class="screen">
      <header class="topbar">
        <div class="title-block"><h1>StashFinder <span class="x-tag">X</span></h1><div class="sub" id="updated"></div></div>
        <button class="icon-btn" id="refresh" type="button" aria-label="Refresh">${icon('refresh')}</button>
        <a class="icon-btn" href="#/settings" aria-label="Settings">${icon('settings')}</a>
      </header>
      <main class="content" id="body"></main>
      <a class="fab" id="fab" href="#/sites">${icon('add')}<span>Sites</span></a>
    </div>`;
  const body = app.querySelector('#body');
  const fab = app.querySelector('#fab');
  const updated = app.querySelector('#updated');

  function draw() {
    const { selected } = getSettings();
    fab.hidden = selected.length === 0;
    updated.textContent = dash.updatedAt
      ? `Updated ${dash.updatedAt.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
      : '';

    if (selected.length === 0) {
      body.innerHTML = `
        <div class="empty">
          ${icon('snow', 72)}
          <h2>Where's the best snow?</h2>
          <p>Pick the SNOTEL, BC, Alberta or Midwest and Northeast snow stations near the places you go. StashFinder pulls their latest snow depth,
             new snow, and temperature and ranks them so you can see where the best snow is.</p>
          <a class="btn" href="#/sites">${icon('add')}Choose sites</a>
        </div>
        ${xNotice()}`;
      return;
    }

    const sort = SORTS.find((s) => s.key === dash.sort) ?? SORTS[0];
    const sorted = [...dash.sites].sort((a, b) => sort.by(b) - sort.by(a));
    const usedSaved = dash.sites.some((c) => c.hourlyFromSave || c.dailyFromSave);
    body.innerHTML = `
      ${dash.loading && dash.sites.length ? '<div class="progress" aria-label="Updating"></div>' : ''}
      ${dash.error ? errorBanner(dash.error) : ''}
      ${betaDismissed() ? '' : betaInvite(true)}
      ${usedSaved ? `<p class="small muted">The snow data server didn't answer for some readings, so the last ones saved on
        this phone are shown (marked "saved"). Tap refresh to try again.</p>` : ''}
      <div class="chips" role="group" aria-label="Sort">
        ${SORTS.map((s) => `<button type="button" class="chip" data-sort="${s.key}" aria-pressed="${s.key === dash.sort}">${s.label}</button>`).join('')}
      </div>
      ${dash.loading && !dash.sites.length ? '<div class="spinner" aria-label="Loading"></div>' : ''}
      ${sorted.map((c, i) => siteCard(c, i + 1)).join('')}`;
  }

  const settingsKey = ({ selected, minBase, useHourly }) => JSON.stringify([selected, minBase, useHourly]);

  async function refresh() {
    const st = getSettings();
    dash.key = settingsKey(st);
    if (!st.selected.length) { dash.sites = []; draw(); return; }
    dash.loading = true; dash.error = null; draw();
    try {
      const sites = await api.conditions(st.selected, st.minBase, st.useHourly);
      if (!alive) return;
      // "Updated" is when the readings were downloaded, which may be a few minutes ago when
      // recent readings were reused.
      const times = sites.map((c) => c.fetchedAt).filter((t) => t > 0);
      dash.sites = sites; dash.updatedAt = times.length ? new Date(Math.min(...times)) : new Date();
    } catch (e) {
      if (!alive) return;
      dash.error = e.message;
    }
    dash.loading = false;
    draw();
  }

  body.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-sort]');
    if (chip) { dash.sort = chip.dataset.sort; draw(); }
    if (e.target.closest('[data-retry]')) refresh();
    if (e.target.closest('[data-beta-close]')) {
      try { localStorage.setItem(BETA_DISMISS_KEY, '1'); } catch { /* private mode: hide for now only */ }
      e.target.closest('.invite')?.remove();
    }
  });
  app.querySelector('#refresh').addEventListener('click', refresh);

  // "Removed Beartown · Undo", for a few seconds after removing a site on its page.
  let undoTimer = null;
  if (dash.undo) {
    const { triplet, name } = dash.undo;
    dash.undo = null;
    const bar = document.createElement('div');
    bar.className = 'snackbar';
    bar.setAttribute('role', 'status');
    bar.innerHTML = `<span>Removed ${esc(name)}</span><button type="button">Undo</button>`;
    bar.querySelector('button').addEventListener('click', () => {
      restoreSite(triplet); bar.remove(); clearTimeout(undoTimer);
      if (alive) refresh(); // re-scores from saved readings; nothing new to download
    });
    app.querySelector('.screen').appendChild(bar);
    undoTimer = setTimeout(() => bar.remove(), 6000);
  }

  if (dash.key !== settingsKey(getSettings()) || !dash.updatedAt) refresh();
  else draw();

  return () => { alive = false; clearTimeout(undoTimer); };
}

function siteCard(c, rank) {
  const s = c.score;
  return `
    <a class="card site-card" href="${siteHref(c.station.triplet)}">
      ${badge(s)}
      <div class="site-main">
        <div class="site-name">${rank}. ${esc(c.station.name)}</div>
        <div class="site-sub">${esc(api.stationSubtitle(c.station))}</div>
        <div class="metrics">
          ${metric('Base', inches(s.depthIn))}
          ${metric('24h', newInches(s.new24In), (s.new24In ?? 0) >= 4)}
          ${metric('72h', newInches(s.new72In), (s.new72In ?? 0) >= 8)}
          ${metric('Temp', degF(s.tempF))}
        </div>
        ${s.notes[0] ? `<div class="note">${esc(s.notes[0])}</div>` : ''}
        <div class="asof${s.silent ? ' warn' : ''}">${esc(readingTime(s, c))}</div>
      </div>
    </a>`;
}

// ---- Site picker (map + list) -------------------------------------------------------

const picker = { mode: 'map', query: '', state: null, mineOnly: false };

const USGS_TOPO = 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}';
const DEFAULT_CENTER = [45.5, -114.0]; // the western US and southern BC
const DEFAULT_ZOOM = 5;
const MAX_ZOOM = 12; // county level: enough to pick sites, keeps downloads small (matches Android)

function renderSites() {
  let alive = true;
  let stations = [];
  let map = null, markers = null, canvas = null;
  let fitTimer = null, lastFitKey = undefined;
  let previewFor = null;
  // Snow-score colors for the dots (F1): { ratings: Map(triplet -> rating key), asOfMs, minBase },
  // or null while loading / when the shared files aren't available (plain dots then).
  let colors = null;

  app.innerHTML = `
    <div class="screen sites-screen">
      <header class="topbar has-back">${backButton()}<h1>Choose snow stations</h1></header>
      <div class="controls">
        <label class="search">
          ${icon('search', 20)}
          <input id="q" type="search" placeholder="Search by name, county, or site #" autocomplete="off" enterkeyhint="search" aria-label="Search sites">
          <button class="icon-btn" id="clear" type="button" aria-label="Clear search" hidden>${icon('close', 20)}</button>
        </label>
        <div class="segmented" role="tablist">
          <button type="button" role="tab" data-mode="list">${icon('list')}List</button>
          <button type="button" role="tab" data-mode="map">${icon('map')}Map</button>
        </div>
        <div class="chips" id="chips" role="group" aria-label="Filter"></div>
        <p class="small limit-msg" id="limit" role="status" hidden>You can save up to ${MAX_SITES} sites. Remove one to add another.</p>
        <div id="missing"></div>
      </div>
      <div class="sites-body">
        <div class="map-wrap" id="map-wrap" hidden>
          <div class="map" id="map"></div>
          <div class="legend" id="legend" aria-hidden="true"></div>
          <div class="card preview" id="preview" hidden></div>
        </div>
        <div class="list" id="list" hidden></div>
        <div id="status"></div>
      </div>
    </div>`;

  const q = app.querySelector('#q');
  const clearBtn = app.querySelector('#clear');
  const chipsEl = app.querySelector('#chips');
  const mapWrap = app.querySelector('#map-wrap');
  const listEl = app.querySelector('#list');
  const statusEl = app.querySelector('#status');
  const previewEl = app.querySelector('#preview');
  const limitEl = app.querySelector('#limit');
  const missingEl = app.querySelector('#missing');
  // Adds or removes a site; shows the limit message when a 26th site is refused.
  const toggle = (t) => { const ok = toggleSite(t); limitEl.hidden = ok; return ok; };
  q.value = picker.query;
  clearBtn.hidden = !picker.query;

  const narrowed = () => picker.query.trim() !== '' || picker.state != null || picker.mineOnly;

  function filtered() {
    const sel = new Set(getSettings().selected);
    return stations.filter((st) =>
      (picker.state == null || st.state === picker.state) &&
      (!picker.mineOnly || sel.has(st.triplet)) &&
      matchesSearch(st, picker.query));
  }

  function drawChips() {
    const states = [...new Set(stations.map((s) => s.state))].sort();
    const n = getSettings().selected.length;
    chipsEl.innerHTML =
      `<button type="button" class="chip" data-mine aria-pressed="${picker.mineOnly}">My sites (${n} of ${MAX_SITES})</button>` +
      `<button type="button" class="chip" data-state="" aria-pressed="${picker.state == null}">All</button>` +
      states.map((s) => `<button type="button" class="chip" data-state="${esc(s)}" aria-pressed="${picker.state === s}">${esc(s)}</button>`).join('');
  }

  function drawMode() {
    app.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.mode === picker.mode)));
    mapWrap.hidden = picker.mode !== 'map';
    listEl.hidden = picker.mode !== 'list';
    if (picker.mode === 'map') { ensureMap(); drawMarkers(); scheduleFit(0); }
    else { closePreview(); drawList(); }
  }

  // List ---------------------------------------------------------------------------
  function drawList() {
    const items = filtered();
    const sel = new Set(getSettings().selected);
    listEl.innerHTML =
      `<div class="count">${items.length === 1 ? '1 site' : `${items.length.toLocaleString('en-US')} sites`}</div>` +
      items.map((st) => `
        <label class="row">
          <div class="row-text"><div class="row-title">${esc(st.name)}</div><div class="row-sub">${esc(api.stationSubtitle(st))}</div></div>
          <input type="checkbox" data-t="${esc(st.triplet)}" ${sel.has(st.triplet) ? 'checked' : ''} aria-label="Save ${esc(st.name)}">
        </label>`).join('');
  }
  listEl.addEventListener('change', (e) => {
    const t = e.target.dataset?.t;
    if (t && !toggle(t)) e.target.checked = false;
  });

  // Map ----------------------------------------------------------------------------
  function ensureMap() {
    if (map || !window.L) return;
    map = L.map(app.querySelector('#map'), {
      center: DEFAULT_CENTER, zoom: DEFAULT_ZOOM, minZoom: 3, maxZoom: MAX_ZOOM,
      zoomControl: false, attributionControl: true, worldCopyJump: true,
    });
    L.control.zoom({ position: 'topright' }).addTo(map);
    L.tileLayer(USGS_TOPO, {
      maxZoom: MAX_ZOOM, maxNativeZoom: 16, tileSize: 256,
      attribution: 'Map: <a href="https://www.usgs.gov/programs/national-geospatial-program/national-map" target="_blank" rel="noopener">USGS The National Map</a>',
    }).addTo(map);
    map.attributionControl.setPrefix(false);
    canvas = L.canvas({ padding: 0.5, tolerance: 8 }); // tolerance: easier to hit dots with a finger
    markers = L.layerGroup().addTo(map);
    setTimeout(() => map && map.invalidateSize(), 0);
  }

  // Dot colors: the score badge colors (canvas needs real colors, not CSS variables).
  const css = getComputedStyle(document.documentElement);
  const RATING_COLOR = Object.fromEntries(['epic', 'good', 'fair', 'marginal', 'nogo']
    .map((k) => [k, css.getPropertyValue(`--r-${k}`).trim()]));
  const NO_READING = '#9AA5AF';
  const PLAIN = '#1E4E79';
  const RING = '#14212E';
  const LEGEND = [['epic', 'Epic'], ['good', 'Good'], ['fair', 'Fair'], ['marginal', 'Marginal'], ['nogo', 'No go']];

  function drawLegend() {
    const el = app.querySelector('#legend');
    const ring = `<div><i class="dot ring"></i>My sites</div>`;
    if (!colors) {
      el.innerHTML = `<div><i class="dot" style="background:${PLAIN}"></i>Snow station</div>${ring}` +
        (colors === null && colorsFailed ? '<div class="muted">Snow colors unavailable</div>' : '');
      return;
    }
    const when = colors.asOfMs ? shortTime(colors.asOfMs) : '';
    el.innerHTML =
      `<div class="legend-grid">${LEGEND.map(([k, label]) => `<div><i class="dot" style="background:${RATING_COLOR[k]}"></i>${label}</div>`).join('')}` +
      `<div><i class="dot" style="background:${NO_READING}"></i>No reading</div></div>` +
      `<div class="legend-foot">${ring}<span class="muted">Your ${colors.minBase}" min${when ? ` · updated ${esc(when)}` : ''}</span></div>`;
  }

  let colorsFailed = false;
  async function loadColors() {
    const { minBase } = getSettings();
    try {
      const r = await api.mapRatings(minBase);
      if (!alive) return;
      colors = r.ratings.size ? { ...r, minBase } : null;
      colorsFailed = !colors;
    } catch {
      colors = null; colorsFailed = true;
    }
    drawLegend();
    drawMarkers();
  }

  function drawMarkers() {
    if (!map) return;
    markers.clearLayers();
    const sel = new Set(getSettings().selected);
    const items = filtered().filter((s) => s.lat != null && s.lon != null);
    // Stations with readings draw over gray ones, and saved sites on top.
    const layer = (s) => (sel.has(s.triplet) ? 2 : colors?.ratings.has(s.triplet) ? 1 : 0);
    items.sort((a, b) => layer(a) - layer(b));
    for (const st of items) {
      const mine = sel.has(st.triplet);
      const isPreview = previewFor === st.triplet;
      const rating = colors?.ratings.get(st.triplet);
      const fill = colors ? (rating ? RATING_COLOR[rating] : NO_READING) : PLAIN;
      L.circleMarker([st.lat, st.lon], {
        renderer: canvas,
        // Saved sites: bigger, with a dark ring (orange now means a score, so it can't mark them).
        radius: isPreview ? 10 : mine ? 8 : colors && !rating ? 4.5 : 6,
        weight: isPreview ? 3 : mine ? 3 : 1.5,
        color: mine || isPreview ? RING : '#FFFFFF',
        fillColor: fill,
        fillOpacity: 0.95,
      }).on('click', () => showPreview(st)).addTo(markers);
    }
  }

  // Fly to: search results / chosen state / "my sites", else the saved sites.
  // Each filter combination fits once, so adding a site from the map doesn't move it.
  function scheduleFit(delay) {
    clearTimeout(fitTimer);
    fitTimer = setTimeout(() => {
      if (!alive || !map) return;
      const key = JSON.stringify([picker.query.trim(), picker.state, picker.mineOnly]);
      if (key === lastFitKey) return;
      const sel = new Set(getSettings().selected);
      const focus = (narrowed() ? filtered() : stations.filter((s) => sel.has(s.triplet)))
        .filter((s) => s.lat != null && s.lon != null);
      if (!focus.length) return;
      lastFitKey = key;
      if (focus.length === 1) map.flyTo([focus[0].lat, focus[0].lon], MAX_ZOOM - 1, { duration: 0.6 });
      else map.flyToBounds(focus.map((s) => [s.lat, s.lon]), { padding: [36, 36], maxZoom: MAX_ZOOM - 1, duration: 0.6 });
    }, delay);
  }

  // Preview card ---------------------------------------------------------------------
  async function showPreview(st) {
    previewFor = st.triplet;
    drawMarkers();
    const { minBase, useHourly } = getSettings();
    const cached = api.cachedConditions(st.triplet, minBase, useHourly);
    drawPreview(st, cached, cached ? null : 'loading');
    if (cached) return;
    try {
      const [c] = await api.conditions([st.triplet], minBase, useHourly);
      if (alive && previewFor === st.triplet) drawPreview(st, c, null);
    } catch (e) {
      if (alive && previewFor === st.triplet) drawPreview(st, null, e.message);
    }
  }

  function drawPreview(st, c, status) {
    const saved = isSelected(st.triplet);
    const s = c?.score;
    let info;
    if (s) {
      info = `<div class="line">Base ${inches(s.depthIn)} · ${newInches(s.new72In)} in 72h · ${degF(s.tempF)}</div>` +
        (s.notes[0] ? `<div class="note" style="margin-top:2px">${esc(s.notes[0])}</div>` : '') +
        `<div class="asof${s.silent ? ' warn' : ''}">${esc(readingTime(s, c))}</div>`;
    } else if (status === 'loading') {
      info = '<div class="small muted">Loading latest snow…</div>';
    } else {
      info = `<div class="small" style="color:var(--error)">Couldn't load conditions: ${esc(status)}</div>`;
    }
    previewEl.innerHTML = `
      <div class="preview-top">
        ${s ? badge(s) : status === 'loading' ? '<div class="badge" style="background:transparent"><div class="spinner sm"></div></div>' : ''}
        <div class="site-main">
          <div class="site-name">${esc(st.name)}</div>
          <div class="site-sub">${esc(api.stationSubtitle(st))}</div>
          ${info}
        </div>
        <button class="icon-btn" type="button" data-close aria-label="Close">${icon('close')}</button>
      </div>
      <button type="button" class="btn block ${saved ? 'outline' : ''}" data-toggle>
        ${saved ? `${icon('check')}In my sites – tap to remove` : `${icon('add')}Add to my sites`}
      </button>
      ${s ? `<a class="btn outline block" href="${siteHref(st.triplet)}">Details &amp; forecast</a>` : ''}`;
    previewEl.hidden = false;
    previewEl.onclick = (e) => {
      if (e.target.closest('[data-close]')) closePreview();
      else if (e.target.closest('[data-toggle]')) { toggle(st.triplet); drawPreview(st, c, status); }
    };
  }

  function closePreview() {
    previewFor = null;
    previewEl.hidden = true;
    drawMarkers();
  }

  // Wiring -------------------------------------------------------------------------
  q.addEventListener('input', () => {
    picker.query = q.value;
    clearBtn.hidden = !q.value;
    refreshResults();
  });
  clearBtn.addEventListener('click', () => { q.value = ''; picker.query = ''; clearBtn.hidden = true; refreshResults(); q.focus(); });

  chipsEl.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    if (chip.hasAttribute('data-mine')) picker.mineOnly = !picker.mineOnly;
    else picker.state = chip.dataset.state === '' || picker.state === chip.dataset.state ? null : chip.dataset.state;
    drawChips();
    refreshResults(0);
  });

  app.querySelector('.segmented').addEventListener('click', (e) => {
    const b = e.target.closest('[data-mode]');
    if (b && b.dataset.mode !== picker.mode) { picker.mode = b.dataset.mode; drawMode(); }
  });

  function refreshResults(fitDelay = 350) {
    if (picker.mode === 'map') { drawMarkers(); scheduleFit(fitDelay); }
    else drawList();
  }

  const unsubscribe = onSettingsChange((s) => {
    drawChips();
    if (picker.mode === 'map') drawMarkers(); else drawList();
    if (colors && s.minBase !== colors.minBase) loadColors(); // re-score with the new minimum (no new download)
  });

  const onKey = (e) => { if (e.key === 'Escape' && previewFor) closePreview(); };
  document.addEventListener('keydown', onKey);

  // Load stations -------------------------------------------------------------------
  async function load() {
    statusEl.innerHTML = '<div class="spinner" aria-label="Loading sites"></div>';
    try {
      stations = await api.allStations();
      if (!alive) return;
      statusEl.innerHTML = '';
      const missing = api.missingStationLists;
      missingEl.innerHTML = missing.length ? errorBanner(`${missing.join(' and ')} stations couldn't load`) : '';
      drawChips();
      drawLegend();
      drawMode();
      loadColors(); // dots start plain and take their colors when the shared files arrive
    } catch (e) {
      if (!alive) return;
      statusEl.innerHTML = `<div style="padding:16px">${errorBanner(e.message)}</div>`;
    }
  }
  statusEl.addEventListener('click', (e) => { if (e.target.closest('[data-retry]')) load(); });
  missingEl.addEventListener('click', (e) => { if (e.target.closest('[data-retry]')) load(); });
  load();

  return () => {
    alive = false;
    clearTimeout(fitTimer);
    unsubscribe();
    document.removeEventListener('keydown', onKey);
    if (map) map.remove();
  };
}

// ---- Site detail --------------------------------------------------------------------

function renderDetail(triplet) {
  let alive = true;
  app.innerHTML = `
    <div class="screen">
      <header class="topbar has-back">${backButton()}<h1 id="title">Site</h1><span id="ext"></span></header>
      <main class="content" id="body"><div class="spinner" aria-label="Loading"></div></main>
    </div>`;
  const body = app.querySelector('#body');
  let counted = false;
  const countOnce = (st) => { if (!counted) { counted = true; countStation(st); } };

  async function load() {
    const { minBase, useHourly } = getSettings();
    let c = api.cachedConditions(triplet, minBase, useHourly);
    if (!c) {
      body.innerHTML = '<div class="spinner" aria-label="Loading"></div>';
      try {
        [c] = await api.conditions([triplet], minBase, useHourly);
      } catch (e) {
        if (alive) { countOnce(api.stationFromTriplet(triplet)); body.innerHTML = errorBanner(e.message); }
        return;
      }
    }
    if (!alive) return;
    countOnce(c?.station ?? api.stationFromTriplet(triplet));
    if (!c) { body.innerHTML = errorBanner('No data for this site'); return; }
    app.querySelector('#title').textContent = c.station.name;
    document.title = `${c.station.name} · StashFinder X`;
    const link = api.sourceLink(c.station);
    app.querySelector('#ext').innerHTML =
      `<a class="icon-btn" href="${esc(link.url)}" target="_blank" rel="noopener" aria-label="${esc(link.label)}">${icon('globe')}</a>`;
    const hasSpot = c.station.lat != null;
    let fc = { loading: hasSpot };
    let avy = !getSettings().showAvalanche ? null : hasSpot ? { loading: true } : { none: true };
    const redraw = () => { if (alive) drawDetail(c, fc, avy); };
    redraw();
    if (!hasSpot) return;
    // Weather and avalanche forecasts load side by side; each redraws when it arrives.
    const weather = api.forecast(c.station)
      .then((periods) => { fc = { periods }; }, (e) => { fc = { error: e.message }; })
      .then(redraw);
    const avalanche = !avy ? null : avalancheForecast(c.station, { canadian: api.isCanadian(c.station) })
      .then((data) => { avy = data ? { data } : { none: true }; }, (e) => { avy = { error: e.message }; })
      .then(redraw);
    await Promise.all([weather, avalanche]);
  }

  function drawDetail(c, fc, avy) {
    const s = c.score;
    const newest = [...c.days].reverse();
    const byDate = new Map(c.days.map((d) => [d.date, d]));
    const priorDate = (iso) => addDays(iso, -1);

    let forecastHtml;
    if (fc.loading) forecastHtml = '<div class="spinner" aria-label="Loading forecast"></div>';
    else if (fc.error) forecastHtml = `<p class="small" style="color:var(--error)">Forecast unavailable: ${esc(fc.error)}</p>`;
    else if (!fc.periods?.length) forecastHtml = '<p class="small muted">No forecast available for this location.</p>';
    else forecastHtml = fc.periods.slice(0, 8).map((p) => {
      const snowy = /snow/i.test(p.short);
      const extras = [p.wind, p.precip != null ? `${p.precip}% precip` : null].filter(Boolean).join(' · ');
      return `
        <div class="card forecast">
          <div class="what">
            <div class="name">${esc(p.name)}</div>
            <div class="short${snowy ? ' snow' : ''}">${esc(p.short)}</div>
            ${extras ? `<div class="small muted">${esc(extras)}</div>` : ''}
          </div>
          ${p.temperature != null ? `<div class="temp">${p.isDaytime ? 'High' : 'Low'} ${p.temperature}°${esc(p.unit)}</div>` : ''}
        </div>`;
    }).join('');

    body.innerHTML = `
      <section class="card summary">
        <div class="summary-top">
          ${badge(s, true)}
          <div>
            <div>${esc(api.stationSubtitle(c.station))}</div>
            ${s.asOf ? `<div class="small ${s.silent ? 'asof warn' : 'muted'}">${esc(readingTime(s, c))}${s.source === 'hourly' && !s.silent ? ' · hourly' : ''}</div>` : ''}
            <div class="notes">${s.notes.map((n) => `• ${esc(n)}`).join('<br>')}</div>
          </div>
        </div>
        <div class="metrics">
          ${metric('Base', inches(s.depthIn))}
          ${metric('New 24h', newInches(s.new24In), (s.new24In ?? 0) >= 4)}
          ${metric('New 72h', newInches(s.new72In), (s.new72In ?? 0) >= 8)}
          ${metric('SWE', sweInches(s.sweIn))}
          ${metric('Temp', degF(s.tempF))}
        </div>
      </section>

      ${c.hours?.length ? `
        <h2 class="section-title">Last 48 hours (hourly)</h2>
        <section class="card chart">${hourlyChart(c.hours, s.silent)}</section>` : ''}

      <h2 class="section-title">Snow depth – last ${c.days.length} days</h2>
      <section class="card chart">${depthChart(c.days)}</section>

      ${avy ? `
        <h2 class="section-title">Avalanche forecast</h2>
        ${avalancheCard(avy, api.isCanadian(c.station))}` : ''}

      <h2 class="section-title">${api.forecastSource(c.station)} forecast</h2>
      ${forecastHtml}

      <h2 class="section-title">Daily observations</h2>
      <section class="card" style="padding:8px 12px">
        <table class="daily">
          <thead><tr><th>Date</th><th>Depth</th><th>New</th><th>SWE</th><th>Hi / Lo</th></tr></thead>
          <tbody>${newest.map((d) => {
            const prev = byDate.get(priorDate(d.date))?.depth;
            // Observer stations measure new snowfall themselves; elsewhere it's the change in depth.
            const n = d.snow !== undefined ? d.snow
              : d.depth != null && prev != null ? Math.max(0, d.depth - prev) : null;
            const hiLo = d.tmax != null || d.tmin != null
              ? `${d.tmax != null ? Math.round(d.tmax) : '–'} / ${d.tmin != null ? Math.round(d.tmin) : '–'}` : '–';
            const day = isoToDate(d.date).toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' });
            return `<tr><td>${day}</td><td>${inches(d.depth)}</td><td class="${(n ?? 0) >= 4 ? 'hot' : ''}">${newInches(n)}</td><td>${sweInches(d.swe)}</td><td>${hiLo}</td></tr>`;
          }).join('')}</tbody>
        </table>
      </section>

      <p class="footnote">${api.isObserver(c.station)
        ? `Snow data: ${c.station.operator === 'CoCoRaHS' ? 'a CoCoRaHS volunteer observer' : 'a National Weather Service cooperative observer'}, through NOAA's Applied Climate Information System (ACIS). Measured by hand once a day, usually around 7 AM; new snow is the observer's own snowfall measurement. Forecast: National Weather Service.`
        : api.isAlberta(c.station)
        ? `Snow data: ${esc(c.station.operator ?? 'Alberta Environment and Protected Areas')}, through Alberta Rivers (provisional data: not yet reviewed, and may change). Forecast: Environment and Climate Change Canada.`
        : api.isCanadian(c.station)
        ? 'Snow data: BC Ministry of Environment, Automated Snow Weather Stations (raw readings, not quality-checked), under the Open Government Licence – British Columbia. Forecast: Environment and Climate Change Canada.'
        : 'Snow data: USDA NRCS SNOTEL (provisional, subject to revision). Forecast: National Weather Service.'}
        ${avy?.data ? `Avalanche forecast: ${esc(avy.data.center)}.` : ''}
        The snow score doesn't include avalanche danger – read the full avalanche forecast before heading out.</p>

      <div class="saved-site" id="saved-site">${savedSiteButton()}</div>`;
  }

  // Bottom of the page: remove the site from (or add it to) my sites.
  function savedSiteButton(limitHit = false) {
    if (isSelected(triplet)) {
      return `<button type="button" class="btn outline block" data-remove>${icon('close')}Remove from my sites</button>`;
    }
    return `<button type="button" class="btn block" data-add>${icon('add')}Add to my sites</button>` +
      (limitHit ? `<p class="small limit-msg">You can save up to ${MAX_SITES} sites. Remove one to add another.</p>` : '');
  }

  body.addEventListener('click', (e) => {
    if (e.target.closest('[data-remove]')) {
      removeSite(triplet);
      // Back to the dashboard, which offers Undo for a few seconds.
      dash.undo = { triplet, name: app.querySelector('#title').textContent || 'site' };
      location.hash = '#/';
    } else if (e.target.closest('[data-add]')) {
      const ok = toggleSite(triplet);
      app.querySelector('#saved-site').innerHTML = savedSiteButton(!ok);
    }
  });
  body.addEventListener('click', (e) => { if (e.target.closest('[data-retry]')) load(); });
  load();
  return () => { alive = false; document.title = 'StashFinder X'; };
}

// ---- Avalanche card -----------------------------------------------------------------

const dangerChip = (level, fallback = 'No rating') => {
  const d = DANGER[level];
  return d
    ? `<span class="danger d-${d.key}">${level} · ${d.name}</span>`
    : `<span class="danger d-none">${esc(fallback)}</span>`;
};

/** The avalanche center's forecast for the site: loading, error, none, or the forecast. */
function avalancheCard(avy, canadian) {
  const home = canadian ? CA_HOME : US_HOME;
  const homeLink = `<a href="${esc(home.url)}" target="_blank" rel="noopener">${esc(home.label)}</a>`;
  if (avy.loading) return '<section class="card avy"><div class="spinner" aria-label="Loading avalanche forecast"></div></section>';
  if (avy.error) {
    return `<section class="card avy"><p class="small" style="color:var(--error)">Avalanche forecast unavailable: ${esc(avy.error)}.
      Check ${homeLink} before heading out.</p></section>`;
  }
  if (avy.none) {
    return `<section class="card avy"><p class="small">No avalanche center forecasts for this area.
      Avalanches can still happen wherever there's snow on slopes steeper than about 30°.
      See ${homeLink} for the nearest forecast.</p></section>`;
  }

  const f = avy.data;
  const bandLabel = (b) => b.label && !DANGER[b.level] ? b.label : 'No rating';
  const rows = (f.today ?? []).map((b, i) => `
    <tr><th>${esc(b.name)}</th><td>${dangerChip(b.level, bandLabel(b))}</td>
      ${f.tomorrow ? `<td>${dangerChip(f.tomorrow[i]?.level, bandLabel(f.tomorrow[i] ?? {}))}</td>` : ''}</tr>`).join('');
  const notes = [];
  if (f.distanceMi > 0) notes.push(`This site is about ${Math.max(1, Math.round(f.distanceMi))} mi outside this forecast area, the closest one.`);
  if (f.offSeason) notes.push(canadian ? 'Early season: daily danger ratings haven\'t started yet.' : 'This center is not issuing daily forecasts right now.');
  if (f.expired) notes.push(`This forecast expired ${shortTime(f.expiresMs)} – check the center for a newer one.`);
  const issued = f.issuedMs ? ` · issued ${new Date(f.issuedMs).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : '';

  return `
    <section class="card avy">
      <div class="avy-head">
        ${dangerChip(f.overall, f.offSeason ? (canadian ? 'Early season' : 'Off season') : 'No rating')}
        <div>
          <div class="avy-zone">${esc(f.zone)}</div>
          <div class="small muted">${esc(f.center)}${esc(issued)}</div>
        </div>
      </div>
      ${notes.map((n) => `<p class="small asof warn">${esc(n)}</p>`).join('')}
      ${rows ? `
        <table class="avy-bands">
          <thead><tr><th>${canadian ? 'Terrain' : 'Elevation'}</th><th>Today</th>${f.tomorrow ? '<th>Tomorrow</th>' : ''}</tr></thead>
          <tbody>${rows}</tbody>
        </table>` : ''}
      ${f.problems.length ? `
        <div class="avy-problems"><b>Avalanche problems</b>
          <ul>${f.problems.map((p) => `<li>${esc(p.name)}${p.detail ? ` <span class="muted">(${esc(p.detail)})</span>` : ''}</li>`).join('')}</ul>
        </div>` : ''}
      ${f.summary ? `<p class="small avy-summary">${esc(f.summary)}</p>` : ''}
      ${f.url ? `<a class="avy-link" href="${esc(f.url)}" target="_blank" rel="noopener">Read the full forecast at ${esc(f.center)}</a>` : ''}
    </section>`;
}

function depthChart(days) {
  const pts = days.filter((d) => d.depth != null);
  if (pts.length < 2) return '<p class="small muted">Not enough data to chart yet.</p>';
  const W = 340, H = 170, top = 18, bottom = 18, chartH = H - top - bottom;
  const max = Math.max(12, ...pts.map((d) => d.depth));
  const slot = W / pts.length, bw = slot * 0.62;
  const labelEvery = pts.length > 10 ? 2 : 1;
  const last = pts.length - 1;
  let out = '';
  pts.forEach((d, i) => {
    const h = (d.depth / max) * chartH;
    const x = i * slot + (slot - bw) / 2;
    const y = top + chartH - h;
    out += `<rect class="bar" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="3"><title>${fmtShort(d.date)}: ${Math.round(d.depth)}"</title></rect>`;
    if (i === last || (last - i) % labelEvery === 0) out += `<text x="${(x + bw / 2).toFixed(1)}" y="${(y - 4).toFixed(1)}">${Math.round(d.depth)}</text>`;
    if (i === last || (last - i) % 3 === 0) {
      const md = isoToDate(d.date).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' });
      out += `<text x="${(x + bw / 2).toFixed(1)}" y="${H - 3}">${md}</text>`;
    }
  });
  out += `<line class="axis" x1="0" x2="${W}" y1="${top + chartH}" y2="${top + chartH}"/>`;
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Snow depth over the last ${pts.length} days">${out}</svg>`;
}

/**
 * Hourly snow depth (bars) and air temperature (line, own scale) for the last 48 hours,
 * so riders can see today's snowfall and whether the sensor is bouncing around.
 * Hours with no data (empty readings) are left as gaps; if the station has gone silent,
 * the chart runs up to now with the silent stretch shaded "No signal".
 */
function hourlyChart(hours, silent = null) {
  const HOUR = 3600000;
  const lastRow = hours[hours.length - 1].t;
  const latest = silent ? Math.max(lastRow, Math.floor((Date.now() - HOUR) / HOUR) * HOUR) : lastRow;
  const pts = hours.filter((h) => h.t > latest - 48 * HOUR);
  const withDepth = pts.filter((h) => h.depth != null);
  if (withDepth.length < 4) return '<p class="small muted">Not enough hourly readings to chart.</p>';

  const W = 340, H = 170, top = 18, bottom = 18, chartH = H - top - bottom;
  const t0 = latest - 47 * HOUR;
  const slot = W / 48, bw = Math.max(2, slot * 0.7);
  const xOf = (t) => ((t - t0) / HOUR) * slot;
  const max = Math.max(12, ...withDepth.map((h) => h.depth));
  let out = '';

  if (silent) {
    const gx = Math.max(0, xOf(silent.sinceMs) + slot);
    if (gx < W - 2) {
      out += `<rect class="gap" x="${gx.toFixed(1)}" y="${top}" width="${(W - gx).toFixed(1)}" height="${chartH}"/>`;
      if (W - gx > 44) out += `<text class="gap-label" x="${((gx + W) / 2).toFixed(1)}" y="${top + chartH / 2}">No signal</text>`;
    }
  }

  for (const h of withDepth) {
    const bh = (h.depth / max) * chartH;
    out += `<rect class="bar soft" x="${(xOf(h.t) + (slot - bw) / 2).toFixed(1)}" y="${(top + chartH - bh).toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="1">` +
      `<title>${new Date(h.t).toLocaleString('en-US', { weekday: 'short', hour: 'numeric' })}: ${Math.round(h.depth)}"${h.tobs != null ? `, ${Math.round(h.tobs)}°F` : ''}</title></rect>`;
  }
  const last = withDepth[withDepth.length - 1];
  out += `<text x="${Math.min(W - 10, xOf(last.t) + slot / 2).toFixed(1)}" y="${(top + chartH - (last.depth / max) * chartH - 4).toFixed(1)}">${Math.round(last.depth)}"</text>`;

  // Temperature line on its own scale, with 32°F marked.
  const temps = pts.filter((h) => h.tobs != null);
  if (temps.length >= 2) {
    const lo = Math.min(...temps.map((h) => h.tobs), 20), hi = Math.max(...temps.map((h) => h.tobs), 40);
    const yT = (v) => top + chartH - ((v - lo) / (hi - lo)) * chartH;
    out += `<line class="freeze" x1="0" x2="${W}" y1="${yT(32).toFixed(1)}" y2="${yT(32).toFixed(1)}"/>`;
    out += `<text class="freeze-label" x="2" y="${(yT(32) - 3).toFixed(1)}">32°F</text>`;
    // Break the line wherever hours are missing, so a gap isn't drawn as real data.
    const segments = [];
    for (const h of temps) {
      const seg = segments[segments.length - 1];
      if (seg && h.t - seg[seg.length - 1].t <= 1.5 * HOUR) seg.push(h);
      else segments.push([h]);
    }
    // Each line is drawn twice: a wide outline in the card's colour, then the line itself,
    // so it stays readable where it crosses the depth bars.
    for (const seg of segments.filter((s) => s.length >= 2)) {
      const points = seg.map((h) => `${(xOf(h.t) + slot / 2).toFixed(1)},${yT(h.tobs).toFixed(1)}`).join(' ');
      out += `<polyline class="temp-halo" points="${points}"/><polyline class="temp" points="${points}"/>`;
    }
  }

  // Time labels every 12 hours, in the phone's time zone.
  for (let k = 0; k <= 48; k += 12) {
    const t = latest - (48 - k) * HOUR;
    const x = Math.min(W - 14, Math.max(14, xOf(t) + slot / 2));
    out += `<text x="${x.toFixed(1)}" y="${H - 3}">${new Date(t).toLocaleString('en-US', { hour: 'numeric' })}</text>`;
  }
  out += `<line class="axis" x1="0" x2="${W}" y1="${top + chartH}" y2="${top + chartH}"/>`;
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Hourly snow depth and temperature, last 48 hours">${out}</svg>` +
    '<p class="small muted" style="margin-top:6px">Bars: snow depth · Line: air temperature</p>';
}

// ---- Settings -----------------------------------------------------------------------

function renderSettings() {
  const s = getSettings();
  const [lo, hi] = MIN_BASE_RANGE;
  app.innerHTML = `
    <div class="screen">
      <header class="topbar has-back">${backButton()}<h1>Settings</h1></header>
      <main class="content">
        <h2 class="section-title">Minimum base</h2>
        <section class="card setting">
          <h3 id="min-label">Minimum base: ${s.minBase}"</h3>
          <p class="small muted">Sites with less snow on the ground are marked "No go", no matter how cold it is or how
            much fell recently. Rough guide: about 10" for flat trails and snowshoeing, 18" for mountain trails and
            mellow touring, 48" for steep or rocky backcountry terrain.</p>
          <input type="range" id="min-base" min="${lo}" max="${hi}" step="1" value="${s.minBase}" aria-labelledby="min-label">
        </section>

        <h2 class="section-title">Readings</h2>
        <section class="card setting">
          <label class="switch-row">
            <span>
              <b class="switch-title">Use latest hourly readings</b>
              <span class="small muted">SNOTEL stations report every hour. On, scores use the newest reading
                (usually under an hour old), so today's snowfall shows up right away. Off, they use the
                once-a-day midnight reading, which NRCS checks more carefully.</span>
            </span>
            <input type="checkbox" id="hourly" role="switch" ${s.useHourly ? 'checked' : ''}>
          </label>
        </section>

        <h2 class="section-title">Avalanche forecasts</h2>
        <section class="card setting">
          <label class="switch-row">
            <span>
              <b class="switch-title">Show avalanche forecasts</b>
              <span class="small muted">Each site's page shows today's and tomorrow's avalanche danger from the
                forecast center that covers it (US centers through avalanche.org, Avalanche Canada in BC and Alberta). It doesn't
                change the snow score. Always read the full forecast before entering avalanche terrain.</span>
            </span>
            <input type="checkbox" id="avalanche" role="switch" ${s.showAvalanche ? 'checked' : ''}>
          </label>
        </section>

        <h2 class="section-title">How the snow score works</h2>
        <section class="card setting" id="score-help"></section>

        <h2 class="section-title">About StashFinder X</h2>
        ${xNotice()}

        <h2 class="section-title">Install on your iPhone</h2>
        <section class="card setting">
          <ol class="steps">
            <li>Open StashFinder in <b>Safari</b>.</li>
            <li>Tap the <b>Share</b> button (the square with an arrow pointing up).</li>
            <li>Scroll down and tap <b>Add to Home Screen</b>, then <b>Add</b>.</li>
            <li>Open StashFinder from its new home-screen icon and choose your sites there.</li>
          </ol>
          <p class="small muted">The home-screen app keeps its own saved sites, separate from Safari.
            Android phones: use the menu in Chrome and choose <b>Add to Home screen</b> or <b>Install app</b>.</p>
        </section>

        <h2 class="section-title">Data sources</h2>
        <p class="small muted">Snow and temperature: USDA NRCS SNOTEL network (US) and the BC Ministry of
          Environment's Automated Snow Weather Stations (British Columbia, Open Government Licence – British
          Columbia), and Alberta Rivers (Alberta Environment and Protected Areas, with Parks Canada, Alberta Parks,
          Environment Canada, Alberta Agriculture and other partners' stations). Canadian data refreshes about every
          30 minutes. Midwest and Northeast: daily reports from National Weather Service cooperative observers and
          CoCoRaHS volunteers, through NOAA's Applied Climate Information System (ACIS), refreshed every few hours.
          Values are provisional and stations occasionally report bad
          readings. Forecasts: National Weather Service (US), Environment and Climate Change Canada (Canada).
          Avalanche forecasts: the US forecast centers through avalanche.org (National Avalanche Center), and
          Avalanche Canada (BC and Alberta). Map: USGS The National Map.
          The web version can't send fresh-snow alerts; open it to check conditions. StashFinder shows the avalanche
          centers' forecasts as published and makes no avalanche assessment of its own.</p>

        <h2 class="section-title">Privacy</h2>
        <p class="small muted">StashFinder X doesn't count visits, uses no cookies and doesn't collect your name,
          location or anything that identifies you. Your saved sites stay on your phone, separate from the regular
          StashFinder app's.</p>
        <p class="small"><a href="https://stashfinder.app/support.html">Help and support</a> · <a href="https://stashfinder.app/privacy.html">Privacy policy</a></p>
      </main>
    </div>`;

  const slider = app.querySelector('#min-base');
  const label = app.querySelector('#min-label');
  const help = app.querySelector('#score-help');

  function drawHelp(minBase) {
    help.innerHTML = `
      <p class="small muted">Base depth comes first. Below your minimum base (${minBase}") a site scores 0–19 on depth
        alone and is marked No go. Sites at or above it start at ${RIDEABLE_FLOOR} and climb to 100:</p>
      <div class="score-line"><b>Base depth</b><span>55%</span></div>
      <p class="small muted">from your minimum up to ${fullDepthFor(minBase)}"+</p>
      <div class="score-line"><b>New snow (72h)</b><span>30%</span></div>
      <p class="small muted">full marks at ${FULL_FRESH_IN}"+</p>
      <div class="score-line"><b>Temperature</b><span>15%</span></div>
      <p class="small muted">full at 25°F or colder, none at 40°F+</p>
      <p class="small"><b>80+ Epic · 60+ Good · 40+ Fair · 20+ Marginal · below 20 No go</b></p>`;
  }
  drawHelp(s.minBase);

  slider.addEventListener('input', () => {
    label.textContent = `Minimum base: ${slider.value}"`;
    drawHelp(+slider.value);
  });
  slider.addEventListener('change', () => updateSettings({ minBase: +slider.value }));
  const hourly = app.querySelector('#hourly');
  hourly.addEventListener('change', () => updateSettings({ useHourly: hourly.checked }));
  const avalanche = app.querySelector('#avalanche');
  avalanche.addEventListener('change', () => updateSettings({ showAvalanche: avalanche.checked }));
  return null;
}

// ---- Start --------------------------------------------------------------------------

window.addEventListener('hashchange', route);
route();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
