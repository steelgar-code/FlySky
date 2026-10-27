# FlySky Weather Forecasts

Weather for drone/UAV pilots. Instead of a single "best guess", FlySky shows the full spread of answers from several weather models, so you can see how likely rain, strong wind, gusts, low clouds or poor visibility really are over the coming hours or week — and checks it against live satellite imagery. Runs entirely in your browser, no backend required.

The app has two views, switched with the buttons in the header: **Forecast** and **Satellite map**.

## Forecast

- **"Can I fly now?"** — a card at the top: the hour's verdict and its confidence, what limits it, one tile per factor (rain chance, wind, gusts, wind aloft, low cloud, visibility) coloured green / yellow / red by its own check with a strip of that factor over the 6 hours from it, and the next suitable window. Under the tiles, an **hour scrubber** covers the whole time window, each hour stacked by the share of members / models per verdict (like *Split by share*): slide along it (mouse or finger), tap, use the ‹ › buttons or the arrow keys to check another hour — the card follows, *Now* goes back to the current hour, and *Map* opens the satellite map for that hour. The selected hour is the one pinned on the flight bar, and the other way round. A tap on a tile opens that factor's chart at the hour shown. The nearby-hazard chips and the satellite note (current hour only) sit in this card; *Details* jumps to the flight bar.
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
- **Forecast confidence** — every member (Ensemble) or model (Models) gets its own verdict per hour, each model weighted equally (a model without a factor others have, e.g. no wind aloft, takes that factor as those models see it, so missing data doesn't count as agreement on "fine"); a strip under the flight bar shows how many agree (high ≥ 80%, medium 60–80%, low < 60%). *Split by share* shows each hour stacked by the share of suitable / uncertain / not suitable.
- **Breakdown by cause** — the same zones separately for precipitation, wind + gusts, wind aloft, low clouds and visibility, with their own details box (tap to pin an hour). A pinned hour on the flight bar offers a **Map** button that opens the satellite map at that time (later hours: the latest image with forecast wind arrows).
- **Flight Window Planner** — flyable windows day by day, with the causes and worst values for uncertain slots and the forecast's confidence; windows shorter than the minimum duration (1 h by default) are left out.
- **Nearby hazards** — chips in the "Can I fly now?" card when satellite data shows **lightning or rain within 50 km** of the location (distance, direction, intensity, and whether it's approaching and when: for a new alert the last ~40 min are read in a few small images, so the ETA shows within seconds). A tap opens the map with that overlay on, zoomed out to include the cell. On the map, an alert whose layer is off has a **Show** button (layer on, cell in view). When satellite and forecast clearly disagree at the location (rain, low cloud), a note says so. On by default; switch off in either settings menu.
- **Day and night** — dotted lines mark midnight, a thin band shades daylight and night, and today's date, sunrise and sunset are shown in the location card (computed on the device).
- **Forecast summary** — expected precipitation with its 80% range and chance of at least 1 mm, peak wind, gusts and wind aloft with a 1-in-10 worst case, low cloud cover and lowest visibility (two cards per row on phones); a tap on a card opens its chart at the peak / clearest / worst hour.
- **Reorderable charts** — move chart panels with the arrows, or drag them by the grip on desktop. Once scrolled down, a round ↑ button takes you back to the top.
- **Time windows** — 3 h, 8 h, 24 h (default), 48 h, 72 h or 1 week from the current hour in the location's local time.
- **Model picker** — in the side menu (☰, or *Models* on the "Can I fly now?" card), for the current mode, with what one update costs of Open-Meteo's free allowance. Defaults suit Ukraine and Eastern Europe (ensembles: DWD ICON-EU, ECMWF IFS Europe and AIFS, Google WeatherNext 2; models: DWD ICON, ECMWF IFS and AIFS, Météo-France, UK Met Office), with NOAA GFS, GEM, JMA and BOM also available. A model that fails to load is flagged and skipped.
- **Requests** — Open-Meteo counts every variable of every ensemble member, so an ensemble update is costly (≈ 120 calls with the 4 default ensembles, ≈ 180–210 with all 8; free use: 600 a minute, 5,000 an hour, 10,000 a day). FlySky always asks for 8 days at once (any request up to 14 days counts the same), so changing the time window needs no new request; a forecast is reused for 2 h in Ensemble mode and 1 h in Models mode (*Refresh* always asks). A per-minute limit is retried once after a minute; an hourly or daily limit stops with one note, and the last forecast stays.
- **Locations** — search, current position, favorites (star a location); the last location, mode, models and window are remembered.

## Satellite map

Live EUMETSAT imagery (EUMETView) over a region of your choice, centred on the forecast location.

- **Products** — *Auto (day / night)* by default: Fog / Low Clouds RGB at night, Day Microphysics by day, GeoColour at twilight, chosen for each image by the sun. Also Fog / Low Clouds RGB (Night Microphysics), GeoColour (day & night), Day Microphysics, Cloud Type (incl. supercooled water — icing risk), Cloud Phase, Natural Colour, Cloud Mask and Infrared 10.8 / 10.5 µm. Each RGB has a **colour key** from EUMETSAT's quick guides; when several satellites offer a product (MSG, MTG, MSG Rapid Scan), pick the source.
- **Overlays** — satellite **precipitation** (MTG blended rate), **lightning** (MTG Lightning Imager, last 30 min) and **fires** (MTG fire radiative power, accumulating from the selected time — play from an earlier time to see risk areas build up), with opacity and legends (lightning and fire stacks are drawn as one picture each, light on phones); **forecast wind arrows** (on by default) at 10 m, 120 m (default), ~500 m, ~800 m or ~1500 m — one wind height shared with the flight time calculator — coloured by your flight thresholds (wind aloft limits above 120 m).
- **Animation** — last 6 or 12 hours of real image times; play, step, slider, latest, speed; local time (default) or UTC. Only the latest image is loaded on open; picking a time loads it and the later ones (never earlier ones). The time bar is hidden when nothing on the map has times (no satellite product, no precipitation / lightning / fire layer) and while the flight time calculator is open (a small pill shows the image time and age; tap it for the latest image).
- **Crosshair readout** — read once the map has settled (folded to its header while you drag; nearby moves reuse what was read, on a ~1 km grid for the satellite and ~5 km for the models), and it never covers the crosshair (long content scrolls). What is under the crosshair for the image on screen: likely cloud type from the colour key (or the exact Cloud Mask class), satellite rain rate, nearest lightning / fire within 50 km, and the forecast models' low cloud, visibility, precipitation and wind for that hour, with which models agree with the satellite. *Set location* makes the crosshair point the forecast location.
- **Flight time calculator** (stopwatch button) — an optional tool for measuring mid-flight. Start A is where the crosshair is when it opens (or after "start here").
  - **Aim** mode: B is the crosshair, so panning measures live; zooming keeps B in place, and a tap takes the crosshair there.
  - **Tap** mode: a tap sets B, and the map pans and zooms freely to look around the route (switching back to Aim takes the map to B).
  - Always visible: A in MGRS, the airspeed slider (18–30 m/s) and B in MGRS. Tap A or B to paste an MGRS reference (several for B make waypoints); A and B can also be dragged. Wind height (the same setting as the map's wind arrows) and departure (now or in 1–6 h) sit next to the mode switch.
  - Shows the flight time, ETA and the way back; a tag beside the route line shows time, distance and ground speed and stays in view while any of the line is on screen.
  - Each part of the route uses the forecast wind of the hour the drone gets there (wind triangle: heading into the crosswind, then ground speed); if the wind is too strong for the airspeed it says so.
  - While it is open, playback stops, the time bar is hidden, and hazard alerts fold into icons so the crosshair stays clear.
- **Navigation** — zoom down to street level (18; the satellite image is drawn for zoom 8 at most — finer than the satellite's own 1–5 km pixels — so zooming in or panning inside the loaded area needs no new image, and the last few areas are remembered so going back reuses their images; zoomed in past the wind grid one arrow shows the wind by the crosshair), distance rings around the location, favorites as stars, place names and borders on top (off by default: the basemaps have them), dark / OSM / no basemap, regions (Ukraine, Europe, around the location, drawn boxes, saved views), full screen, phone landscape layout.
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

Only the search text, the selected coordinates, the map area and (with the flight time calculator) points along the route are sent to these services. Favorites, settings and saved forecasts stay in your browser (localStorage and IndexedDB).

## License

MIT — see [LICENSE](LICENSE).
