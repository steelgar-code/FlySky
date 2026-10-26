# FlySky Weather Forecasts

Weather for drone/UAV pilots. Instead of a single "best guess", FlySky shows the full spread of answers from several weather models, so you can see how likely rain, strong wind, gusts, low clouds or poor visibility really are over the coming hours or week — and checks it against live satellite imagery. Runs entirely in your browser, no backend required.

The app has two views, switched with the buttons in the header: **Forecast** and **Satellite map**.

## Forecast

- **"Can I fly now?"** — a card at the top: the current hour's verdict and its confidence, what limits it, one tile per factor (rain chance, wind, gusts, wind aloft, low cloud, visibility) coloured green / yellow / red by its own check with a strip of that factor over the next 6 hours, and the next suitable window. The nearby-hazard chips and the satellite note sit in this card; *Details* jumps to the flight bar.
- **Two forecast modes**
  - **Ensemble**: every run (member) of each selected ensemble model, which shows how likely each outcome is.
  - **Models**: the single main (deterministic) forecast of each selected model, which shows how much the models disagree.
  Both modes use the same charts, and the switch floats at the bottom of the screen so you can flip it while looking at any chart.
- **Per-member / per-model view** — the toggle next to the mode switch overlays every ensemble member in Ensemble mode (wind-aloft members coloured by height), and in Models mode replaces the combined range with one colored line per model.
- **Probability ranges** — one chart per parameter with the median line plus shaded 25–75% (50% likely), 10–90% (80% likely) and min–max bands. Hover any hour for the exact numbers.
- **Parameters** — precipitation (with an hourly chance-of-precipitation bar), wind speed and gusts at 10 m, low cloud cover (Models mode; the ensemble API doesn't provide it), visibility, and wind aloft (Ensemble: 1000 and 925 hPa pooled, roughly 110–800 m; Models: 950 hPa, roughly 500 m).
- **Flight conditions** — a color-coded bar marking each hour as suitable (green), uncertain (yellow) or not suitable (red), from the median wind, gusts, wind aloft, low clouds and visibility plus the chance of precipitation:
  - *Suitable*: no chance of precipitation, wind and gusts under 8 m/s, wind aloft under 8 m/s, low clouds under 30%, visibility over 5 km.
  - *Uncertain*: any of: precipitation chance under 40%, wind or gusts 8–14 m/s, wind aloft 8–14 m/s, low clouds 30–60%, visibility 3–5 km.
  - *Not suitable*: any of: precipitation chance 40% or more, wind or gusts 14 m/s or more, wind aloft 14 m/s or more, low clouds 60% or more, visibility under 3 km.
  All thresholds are adjustable in Settings; wind aloft has limits of its own (raise them a lot to leave it out).
- **Forecast confidence** — every member (Ensemble) or model (Models) gets its own verdict per hour, each model weighted equally; a strip under the flight bar shows how many agree (high ≥ 80%, medium 60–80%, low < 60%). *Split by share* shows each hour stacked by the share of suitable / uncertain / not suitable.
- **Breakdown by cause** — the same zones separately for precipitation, wind + gusts, wind aloft, low clouds and visibility, with their own details box (tap to pin an hour). A pinned hour on the flight bar offers a **Map** button that opens the satellite map at that time (later hours: the latest image with forecast wind arrows).
- **Flight Window Planner** — flyable windows day by day, with the causes and worst values for uncertain slots and the forecast's confidence; windows shorter than the minimum duration (1 h by default) are left out.
- **Nearby hazards** — chips in the "Can I fly now?" card when satellite data shows **lightning or rain within 50 km** of the location (distance, direction, intensity, and once several images are seen, whether it's approaching and when). A tap opens the map with that overlay on. When satellite and forecast clearly disagree at the location (rain, low cloud), a note says so. On by default; switch off in either settings menu.
- **Day and night** — dotted lines mark midnight, a thin band shades daylight and night, and today's sunrise and sunset are shown under the flight bar (computed on the device).
- **Forecast summary** — expected precipitation with its 80% range and chance of at least 1 mm, peak wind, gusts and wind aloft with a 1-in-10 worst case, low cloud cover and lowest visibility (two cards per row on phones).
- **Reorderable charts** — move chart panels with the arrows, or drag them by the grip on desktop.
- **Time windows** — 3 h, 8 h, 24 h (default), 48 h, 72 h or 1 week from the current hour in the location's local time.
- **Model picker** — in the side menu (☰, or *Models* on the "Can I fly now?" card), for the current mode, with what one update costs of Open-Meteo's free allowance. Defaults suit Ukraine and Eastern Europe (ensembles: DWD ICON-EU, ECMWF IFS Europe and AIFS, Google WeatherNext 2; models: DWD ICON, ECMWF IFS and AIFS, Météo-France, UK Met Office), with NOAA GFS, GEM, JMA and BOM also available. A model that fails to load is flagged and skipped.
- **Requests** — Open-Meteo counts every variable of every ensemble member, so an ensemble update is costly (≈ 120 calls with the 4 default ensembles, ≈ 180–210 with all 8; free use: 600 a minute, 5,000 an hour, 10,000 a day). FlySky always asks for 8 days at once (any request up to 14 days counts the same), so changing the time window needs no new request; a forecast is reused for 2 h in Ensemble mode and 1 h in Models mode (*Refresh* always asks). A per-minute limit is retried once after a minute; an hourly or daily limit stops with one note, and the last forecast stays.
- **Locations** — search, current position, favorites (star a location); the last location, mode, models and window are remembered.

## Satellite map

Live EUMETSAT imagery (EUMETView) over a region of your choice, centred on the forecast location.

- **Products** — *Auto (day / night)* by default: Fog / Low Clouds RGB at night, Day Microphysics by day, GeoColour at twilight, chosen for each image by the sun. Also Fog / Low Clouds RGB (Night Microphysics), GeoColour (day & night), Day Microphysics, Cloud Type (incl. supercooled water — icing risk), Cloud Phase, Natural Colour, Cloud Mask and Infrared 10.8 / 10.5 µm. Each RGB has a **colour key** from EUMETSAT's quick guides; when several satellites offer a product (MSG, MTG, MSG Rapid Scan), pick the source.
- **Overlays** — satellite **precipitation** (MTG blended rate), **lightning** (MTG Lightning Imager, last 30 min) and **fires** (MTG fire radiative power, accumulating from the selected time — play from an earlier time to see risk areas build up), with opacity and legends; **forecast wind arrows** (10 m or ~800 m, on by default) coloured by your flight thresholds.
- **Animation** — last 6 or 12 hours of real image times; play, step, slider, latest, speed; local time (default) or UTC. Only the latest image is loaded on open; picking a time loads it and the later ones (never earlier ones).
- **Crosshair readout** — what is under the crosshair for the image on screen: likely cloud type from the colour key (or the exact Cloud Mask class), satellite rain rate, nearest lightning / fire within 50 km, and the forecast models' low cloud, visibility, precipitation and wind for that hour, with which models agree with the satellite. *Set location* makes the crosshair point the forecast location.
- **Flight time calculator** (stopwatch button) — an optional tool for measuring mid-flight: start A is where the crosshair is when it opens (or after "start here"), and the destination B follows the crosshair while you pan, so the numbers update live. A tap on the map pins B (switch "B follows the crosshair" back on in the options to measure by panning again), and A, B and waypoints can be dragged. Paste MGRS references to jump to them: one sets B, several make waypoints A → 1 → 2 … → B; the options list the MGRS of every point. With an airspeed of 18–30 m/s and the forecast wind along the route at a chosen height (10 m, 120 m, ~500 m, ~800 m, ~1500 m; departure now or in 1–6 h) it shows the flight time and ETA, ground speed, head/tailwind and crosswind, and the way back. Each part of the route uses the wind of the hour the drone gets there (wind triangle: heading into the crosswind, then ground speed); if the wind is too strong for the airspeed it says so.
- **Navigation** — zoom down to street level (18; the satellite image keeps its own resolution, and zoomed in past the wind grid one arrow shows the wind by the crosshair), distance rings around the location, favorites as stars, place names and borders on top (off by default: the basemaps have them), dark / OSM / no basemap, regions (Ukraine, Europe, around the location, drawn boxes, saved views), full screen, phone landscape layout.
- All map settings are in the side menu (☰) while the map is shown.

Satellite RGB imagery shows *likely* fog and low cloud visually; it does not measure cloud-base height. Satellite rain is an estimate and lightning arrives with a few minutes' delay — the alerts are a heads-up, not a warning service.

## Settings, languages, offline

- **Settings** (☰ menu): models, units (wind m/s, km/h, kn, mph; precipitation mm or inch), flight thresholds (including wind aloft), planner minimum window, nearby-hazard alerts, full screen; in the map view the same menu holds the map settings.
- **Languages**: English, Ukrainian and Portuguese (BR).
- **Installable PWA**: works offline with the last loaded forecasts (the four most recent location / mode combinations are kept); the map needs a connection.

## Usage

FlySky is static files with no build step: `index.html` (forecast), `map.js` (satellite map, loaded when first opened, with Leaflet), `hazard.js` (nearby-hazard alerts), `sw.js` (offline cache). To run it, serve the folder with any static file server (e.g. `npx serve .`) and open it in a browser; optionally install it from the browser's install prompt.

When changing `map.js` or `hazard.js`, bump their `?v=` in `index.html` and in `sw.js`, and the service worker cache version.

## Tests

Browser tests (Playwright, all external services mocked) live in [`tests/`](tests/README.md):

```sh
cd tests && npm install && npm test
```

## Data & privacy

- Forecasts: [Open-Meteo Ensemble API](https://open-meteo.com/en/docs/ensemble-api) and [Forecast API](https://open-meteo.com/en/docs); place search: [Open-Meteo Geocoding API](https://open-meteo.com/en/docs/geocoding-api) (CC BY 4.0).
- Satellite imagery and products: [EUMETSAT EUMETView](https://view.eumetsat.int/) (© EUMETSAT; check EUMETSAT's data policy before public or commercial use).
- Map tiles: © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors.

Only the search text, the selected coordinates and the map area are sent to these services. Favorites, settings and saved forecasts stay in your browser (localStorage and IndexedDB).

## License

MIT — see [LICENSE](LICENSE).
