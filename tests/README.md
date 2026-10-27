# FlySky browser tests

Playwright tests for the app in the folder above. Not part of the app (nothing here is loaded by it).

```sh
cd tests
npm install            # Playwright + local copies of the CDN files used by the mock
npx playwright install chromium   # unless a Chromium is already available (see CHROMIUM_PATH)
npm test               # all offline suites
node run.mjs map-readout forecast  # selected suites
npm run test:live      # also live-eumetsat.mjs (real EUMETView data)
```

`run.mjs` serves the repository on a free local port, runs each suite with `BASE_URL` set,
and prints `N passed, M failed` (exit code 1 on any failure or crash).

Environment:
- `CHROMIUM_PATH` — browser executable to use (default: Playwright's own; `/opt/pw-browsers/chromium` if present).
- `BASE_URL` — app URL when running a suite directly (`node map-layers.mjs`), default `http://localhost:8765/`.

## Mocks (`lib/mock.mjs`)
Every external request is answered locally, so the suites run offline and are repeatable:
- CDN files (Tailwind, Chart.js, Font Awesome, Leaflet) from `node_modules`. The mock serves Tailwind v4
  instead of the app's v3 Play CDN, so a `tailwind is not defined` page error is expected and ignored.
- **EUMETView WMS**: full and per-layer GetCapabilities (fog, microphysics, natural colour, GeoColour,
  Cloud Type / Phase, Cloud Mask, IR, blended precipitation, lightning li_afa, fires frp / fire, borders,
  plus layers that must be ignored), GetMap PNGs (lightning NW and a fire SW of Kyiv at known times),
  GetFeatureInfo, GetLegendGraphic, WMS exceptions. Options: `badTime`, `noCors`, `capsFail`,
  `noLayerCaps`, `noPrecip`, `leafletFail`, `windFail`, `wmsDelay`, `gfiRgb`, `now` (pretend it is
  this time, e.g. for daytime images), `rainCell` (adds the alerts' rain product h40b with a cell
  NW of Kyiv closing in at 30 km/h).
- **Open-Meteo**: ensemble / models forecasts (members and per-model columns like the real API),
  the map readout's point request (one column per model) and the wind-arrow grid request.
  Option `forecastLimit: { n, reason }` (may be set on the options object later): the next `n`
  forecast requests get a 429 "limit exceeded". The flight time calculator's wind request gets a
  uniform wind, `routeWind: { speed, from, ramp }` (default 6 m/s from the west; `ramp`: m/s more per hour ahead).
- OSM tiles: flat dark tiles.

## Suites
| File | Covers |
|---|---|
| `forecast.mjs` | combined request, charts, flight bar, 72 h window, Models mode, thresholds + reset, planner, language, saved forecast |
| `forecast-now.mjs` | "Can I fly now?" card, wind aloft as a factor, models in the side menu, 8 days asked once (no request on window switch), daily limit, confidence legend |
| `forecast-scrub.mjs` | "Can I fly now?" hour scrubber: mouse and touch sliding (also off the strip), strip kept under the pointer, tap, ‹ › buttons, keyboard, card following the hour, shared pin with the flight bar, *Now*, *Map* |
| `forecast-nav.mjs` | date / sunrise / sunset in the location card, card tiles and summary cards opening their chart at the hour in question, back-to-top button |
| `map-loading.mjs` | lazy loading (latest only; selected frame forward), frame marker on prev/next/play, basemaps, colour keys, precipitation |
| `map-readout.mjs` | crosshair readout (colour match, rain rate, model line), caching, no reads while playing, Set location, centre button |
| `map-layers.mjs` | side-menu map settings, products, source cards, colour keys, overlays, nearest lightning / fire, Cloud Mask class, wind arrows, place names |
| `map-route.mjs` | map defaults for new users, zoom 18; flight time calculator: Aim mode (B at the crosshair while panning, zoom keeps it, tap recentres), Tap mode (tap sets B, free map), switching between them, MGRS for A / B (waypoints, bad input, cancel, round trip), route tag (beside the line, stays in view, hidden off screen), start here, swap, clear, wind triangle, airspeed, height, return leg, hazards folded while open; one wind height for the calculator and the map's wind arrows (both directions, earlier '925' setting carried over) |
| `map-drag.mjs` | lightning / fire stacks as one canvas each (also while stepping), no backdrop blur on map panels, readout kept open while dragging and read once settled (no reads in between, tiny moves reuse it), crosshair clear of the notes / readout, scrolling them by touch |
| `map-settings.mjs` | map side menu: folding cards (only Layers open for a new user, remembered), summaries while folded, a layer's settings shown when switched on and folded by its sliders button, wind heights fitting the card |
| `map-extent.mjs` | image area reuse: no new image when zooming in past 8 or panning inside the area (margin), going back to a recent area reuses it and its played frames, new images for real resolution changes |
| `map-overlays.mjs` | lightning / fire stacks load only from the selected image forward; Cloud Top Height removed |
| `hazard-alerts.mjs` | nearby-hazard alerts: movement read back for a new alert (small images, last 40 min, once), "Show" on the map alert (layer on, cell in view), time bar hidden with nothing to show / in the calculator, time pill |
| `map-failures.mjs` | WMS exception frame, no-CORS fallback, capabilities failure, Leaflet failure, day/night hint, offline, phone layout |
| `live-eumetsat.mjs` | real EUMETView: products / overlays resolve, frames load, readout (Open-Meteo stays mocked out) |

Notes:
- Results depend on the time of day (Auto product, day/night hint): suites pin a product where it matters.
- The settings switches are visually hidden checkboxes: click their `<label>`.
- Add `--mobile` to a suite (`node map-layers.mjs --mobile`) for a 390 × 844 phone viewport.
