# StashFinder X

The experimental test version of the StashFinder web app, for trying new features before they
go into the regular app (stashfinder.app). Started Nov 25 2026 as a copy of web V9.9.

Live at https://x.stashfinder.app (Cloudflare Pages project `stashfinderx`; not listed by
search engines). Until v1.2 it was at mutt2jeff.github.io/StashFinderX, which now only sends
visitors to the new address.

## What's being tested

- **R1: Plains, Midwest and Northeast snow reports.** Daily snow depth and new snowfall from National
  Weather Service cooperative observers and CoCoRaHS volunteers in MT, ND, SD, NE, MN, WI, MI, NY,
  VT, NH and ME (added MT, ND, SD and NE in v1.2; the western parts of ND, SD and NE are on
  Mountain time, set per station by `acisZone`),
  through NOAA's Applied Climate Information System (ACIS). See `js/acis.js`.
  - People measure these by hand, usually once a day around 7 AM, so the app says
    "Observer report · this morning" and there are no hourly charts.
  - New snow is the observer's measured snowfall, not the change in depth.
  - The map colors them like every other station; reports more than 3 days old stay gray.

## How it differs from the main app

- Its own web address (x.stashfinder.app), so its saved sites and offline copy are completely
  separate from the main app's. Storage keys (`ssx.*`) and cache names (`stashfinderx-*`) are
  still distinct, left over from when both lived on mutt2jeff.github.io.
- No visit counts (no GoatCounter), no beta invitation, and Support and Privacy link to the main
  app's pages.
- BC, Alberta and SNOTEL map data are read from the main app's site
  (mutt2jeff.github.io/Snowscout/data/), not built again here.
- The GitHub Action only builds `data/acis-*.json` (scripts/build-acis-data.mjs): one ACIS
  request per state, about every 3 hours. It then pushes main plus those files to the `live`
  branch, which Cloudflare Pages (connected to this repo) publishes. No Cloudflare keys.

## Trying it on this PC

    powershell -ExecutionPolicy Bypass -File serve.ps1 -Dev -Port 8766

then open http://localhost:8766/tests/build-acis.html once (builds the ACIS files), and
http://localhost:8766/ for the app. Tests: http://localhost:8766/tests/index.html.
