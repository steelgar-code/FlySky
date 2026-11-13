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
  forecast requests get a 429 "limit exceeded". `forecastModelFail: { model, reason, status }`: every forecast request naming that
  model gets that status (default 400) with `{ error: true, reason }`, so a combined request fails and the app asks one model at a time.
  `forecastMembers`: members per ensemble model (default 6). `forecastValue(variable, k, model, member)` overrides a value (k = the timestamp's hours
  from the current hour; `null` makes a level the model lacks); a pressure level's `geopotential_height_…` is its
  standard height unless overridden, and `forecastElevation` sets the ground in the answer (default 179 m); forecast requests are logged in `forecastReq`.
  The map readout's point request takes `pointValue(variable, time)` for `precipitation` and `wind_gusts_10m` per timestamp. The flight time calculator's wind request gets a
  uniform wind, `routeWind: { speed, from, ramp }` (default 6 m/s from the west; `ramp`: m/s more per hour ahead).
  The icing requests (ICON + UKMO with pressure levels, recognised by `surface_pressure`: the forecast view's, and
  the calculator's route points and column at A in GMT, several points at once) get profiles over a 179 m ground
  (`routeElevation(lat, lon)` for other points) from `icingScenario()` — a surface pressure for that ground (the app
  works the level heights out from it; geopotential heights only if asked), a layer at the flight altitude for
  both models for 3 h, then ICON only, a layer below, freezing fog, a layer above, UKMO ending after 100 h;
  `icing(model, k, level, lat, lon)` / `icingSfc(model, k, lat, lon)` override it (e.g. `precipitation` for the
  drizzle cue, `weather_code` 66 for freezing rain), `icingFail` fails it. Logged in `icingReq` (the calculator's
  also in `routeIcingReq`).
- OSM tiles: flat dark tiles.

## Suites
| File | Covers |
|---|---|
| `forecast.mjs` | combined request, charts, flight bar, 72 h window, Models mode, thresholds + reset, planner, language, saved forecast |
| `forecast-now.mjs` | "Can I fly now?" card (Map in the title row, one-line source line, Models button with the count and the names, the time zone on the sun line, Ukrainian), wind aloft as a factor, models in the side menu, 8 days asked once (no request on window switch), daily limit, the confidence legend line, the confidence text naming its group ("90% of members: suitable" with an uncertain hour, "… of models: …", Ukrainian, the hour bar's titles); the flight conditions card on a 390 px phone with touch: the low-confidence hatch (on low hours only, none in *Split by share*), the ⓘ panel (touch, mouse, keyboard, Escape, one panel at a time, the settings drawer's Escape first), the pinned hour's lines (time · verdict · flag · Map, values, confidence, the split with "Uncertain: …" on its own line), the card's height against the old one, Ukrainian and Portuguese |
| `forecast-scrub.mjs` | "Can I fly now?" hour scrubber: mouse and touch sliding (also off the strip), strip kept under the pointer, tap, ‹ › buttons, keyboard, card following the hour, shared pin with the flight bar, *Now*, *Map* |
| `forecast-nav.mjs` | date / sunrise / sunset in the location card, card tiles and summary cards opening their chart at the hour in question, back-to-top button |
| `map-loading.mjs` | lazy loading (latest only; selected frame forward), frame marker on prev/next/play, basemaps, colour keys, precipitation |
| `map-readout.mjs` | crosshair readout (colour match, rain rate, model line; rain and gusts from the stamp closing the image's hour), caching, no reads while playing, Set location, centre button |
| `map-layers.mjs` | side-menu map settings, products, source cards, colour keys, overlays, nearest lightning / fire, Cloud Mask class, wind arrows (and their pause near Open-Meteo's hourly limit, the per-minute pacing), place names |
| `forecast-data.mjs` | forecast data: rain and gusts shifted to the hour they describe, requests always in m/s and mm (unit changes ask nothing, values converted), one saved record per model (removing / re-adding a model asks nothing, a new model is asked alone, quick taps make one request, Refresh asks all, records survive a reload), a cancelled request keeps its estimated cost; a model that always fails: asked once per load at first, then not on automatic loads (one toast, no "Offline", "Updated …" with "· 1 model(s) missing"), again with Refresh (toast again) and after 30 min (silently), a limit reply keeping "Cached" while the retry waits, every model limited at a new place (the reason stays in the source line); wind aloft: the Models request for 400 m (speed and height of three levels, no direction), the interpolated value, a model with one level within reach, a level inside the terrain left out, 120 m / 10 m from the height levels, altitude changes (same levels: nothing asked, value changes; other levels: one request), a record without the list of variables read again once, the Ensemble request (925 hPa, no 1000 hPa) and title with its height, 925 hPa inside high ground left out |
| `map-route-icing.mjs` | icing along the route in the flight time calculator: the route request (every second point and B, ICON + UKMO, the levels around the flight height), A's column from the forecast data or its own request, out / back / at-A lines, red stretches and the tag's ❄, panning without requests, +6 h climb and descent at A, 1500 m, one model, freezing rain code, hilly ground, no return flight, Ukrainian, the indicator off |
| `map-route.mjs` | map defaults for new users, zoom 18; flight time calculator: Aim mode (B at the crosshair while panning, zoom keeps it, tap recentres), Tap mode (tap sets B, free map), switching between them, MGRS for A / B (waypoints, bad input, cancel, round trip), route tag (beside the line, stays in view, hidden off screen), start here, swap, clear, wind triangle, airspeed, height, return leg, hazards folded while open; one wind height for the calculator and the map's wind arrows (both directions, earlier '925' setting carried over) |
| `map-drag.mjs` | lightning / fire stacks as one canvas each (also while stepping), no backdrop blur on map panels, readout kept open while dragging and read once settled (no reads in between, tiny moves reuse it), crosshair clear of the notes / readout, scrolling them by touch |
| `map-settings.mjs` | map side menu: folding cards (only Layers open for a new user, remembered), summaries while folded, a layer's settings shown when switched on and folded by its sliders button, wind heights fitting the card |
| `map-extent.mjs` | image area reuse: no new image when zooming in past 8 or panning inside the area (margin), going back to a recent area reuses it and its played frames, new images for real resolution changes |
| `map-overlays.mjs` | lightning / fire stacks load only from the selected image forward; Cloud Top Height removed |
| `hazard-alerts.mjs` | nearby-hazard alerts: movement read back for a new alert (small images, last 40 min, once), "Show" on the map alert (layer on, cell in view), time bar hidden with nothing to show / in the calculator, time pill |
| `map-failures.mjs` | WMS exception frame, no-CORS fallback, capabilities failure, Leaflet failure, day/night hint, offline, phone layout |
| `forecast-icing.mjs` | icing indicator in the forecast view: one ICON + UKMO request (surface pressure, no level heights), the "Can I fly now?" row and layer line hour by hour (both models, one model, climb only, freezing fog, no signs in grey, a layer above), the "Icing risk" flag (both models, freezing drizzle; with and without the verdict option), the icing section above the breakdown (folded by default: the header and the strip, aligned with the hour bar, with its day separators; faded beyond 3 days, striped with one model; the ⓘ note), the hovered / pinned hour's one icing line and "Icing details" opening the section on that hour (in view, remembered), the selected hour's per-model climb / cruise / descent and layers (from a pin, the "Can I fly now?" card, a tap in the strip or the profile; a tap on the folded strip opens it), the side menu's Open-Meteo usage meter counting the icing request, the icing profile, planner notes, flight profile settings (climb, duration, altitude needing other levels, thresholds, reset), the indicator off / on, icing in the flight verdict (Ensemble and Models mode, no extra members; the icing bar's one-line detail), a failing request, the stored copy after a reload, Ukrainian and Portuguese |
| `forecast-usage.mjs` | Open-Meteo calls used and left: the side menu's two meters (nothing used, shares and "used · left" from a filled log, the pause mark from `OM_SOFT`, the fuller of the two APIs and the line naming both, calm / amber / red at 60 % and at the pause mark for the hour and the day, an over-full log clamped and "left" never negative), no gauge on the card (the Models button opens the side menu), the meters following a Refresh with the menu open, Ukrainian, the map's side menu, the card's footer row at 390 px |
| `icing-engine.mjs` | icing engine (`icing.js`) — Node only, no browser: request and call cost, response split per model, level rules, RH conversion, surface cues (fog, freezing rain incl. warm nose, freezing drizzle from stratus, ICON rain, thin layer), heights from the surface pressure, the strong signal, heights (below-ground masking, missing levels, high ground), a flight's climb / cruise / descent, icing layers, two models (red if either, model beyond its forecast length), thresholds |
| `live-eumetsat.mjs` | real EUMETView: products / overlays resolve, frames load, readout (Open-Meteo stays mocked out) |

Notes:
- Results depend on the time of day (Auto product, day/night hint): suites pin a product where it matters.
- The settings switches are visually hidden checkboxes: click their `<label>`.
- Add `--mobile` to a suite (`node map-layers.mjs --mobile`) for a 390 × 844 phone viewport.
