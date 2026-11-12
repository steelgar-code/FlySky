# FlySky Weather Forecasts

English · [Українська](README.uk.md) · [Português (BR)](README.pt-BR.md)

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
- **Parameters** — precipitation (with an hourly chance-of-precipitation bar), wind speed and gusts at 10 m, low cloud cover (Models mode; the ensemble API doesn't provide it), visibility, and wind aloft (Ensemble: 1000 and 925 hPa pooled, up to roughly 600 m above the ground; Models: 950 hPa, roughly 400 m above the ground over lowland Ukraine).
- **Flight conditions** — a color-coded bar marking each hour as suitable (green), uncertain (yellow) or not suitable (red), from the median wind, gusts, wind aloft, low clouds and visibility plus the chance of precipitation:
  - *Suitable*: no chance of precipitation, wind and gusts under 8 m/s, wind aloft under 8 m/s, low clouds under 30%, visibility over 5 km.
  - *Uncertain*: any of: precipitation chance under 40%, wind or gusts 8–14 m/s, wind aloft 8–14 m/s, low clouds 30–60%, visibility 3–5 km.
  - *Not suitable*: any of: precipitation chance 40% or more, wind or gusts 14 m/s or more, wind aloft 14 m/s or more, low clouds 60% or more, visibility under 3 km.
  All thresholds are adjustable in Settings; wind aloft has limits of its own (raise them a lot to leave it out).
- **Forecast confidence** — every member (Ensemble) or model (Models) gets its own verdict per hour, each model weighted equally (a model without a factor others have, e.g. no wind aloft, takes that factor as those models see it, so missing data doesn't count as agreement on "fine"); a strip under the flight bar shows how many agree (high ≥ 80%, medium 60–80%, low < 60%). The percentage shown is the share of members / models in the largest group, named with that group's verdict ("90% of members: suitable"); the hour's own verdict is worked out separately (median values, chance of rain) and can differ (one wet member in ten already makes an hour uncertain). *Split by share* shows each hour stacked by the share of suitable / uncertain / not suitable.
- **Breakdown by cause** — the same zones separately for precipitation, wind + gusts, wind aloft, low clouds and visibility, with their own details box (tap to pin an hour). A pinned hour on the flight bar offers a **Map** button that opens the satellite map at that time (later hours: the latest image with forecast wind arrows).
- **Icing indicator** (experimental, on by default) — screens a flight from the location (climb to the flight altitude, cruise for the flight duration, descent; 400 m, 2 m/s, 2 h by default) through DWD ICON and the UK Met Office for sub-zero air near saturation, freezing fog, freezing rain and freezing drizzle from low stratus: an *Icing* row in the "Can I fly now?" card (what, at which height, how many of the two models; the icing layers — where they are, clear air below, dry or warmer air above), a thin icing strip under the flight bar with each model's minutes in icing on the climb, cruise and descent for a pinned hour, an *Icing profile* (model levels × hours) and icing notes in the planner. An **Icing risk** flag next to the flight verdict when both models show icing at the flight altitude or either shows freezing rain or drizzle — also while icing is not part of the verdict. "No icing signs" is grey, not green; hours with one model only are striped, hours more than 3 days ahead faded. Its own request (≈ 4 calls, read again after 3 hours — 12 hours in warm weather — kept for offline use). Can count in the flight verdict (off by default). Assumes a fixed-wing UAV without ice protection. Not a validated icing forecast: "no icing signs" never means safe — stay out of icing layers rather than passing through them.
- **Flight Window Planner** — flyable windows day by day, with the causes and worst values for uncertain slots and the forecast's confidence; windows shorter than the minimum duration (1 h by default) are left out.
- **Nearby hazards** — chips in the "Can I fly now?" card when satellite data shows **lightning or rain within 50 km** of the location (distance, direction, intensity, and whether it's approaching and when: for a new alert the last ~40 min are read in a few small images, so the ETA shows within seconds). A tap opens the map with that overlay on, zoomed out to include the cell. On the map, an alert whose layer is off has a **Show** button (layer on, cell in view). When satellite and forecast clearly disagree at the location (rain, low cloud), a note says so. On by default; switch off in either settings menu.
- **Day and night** — dotted lines mark midnight, a thin band shades daylight and night, and today's date, sunrise and sunset are shown in the location card (computed on the device).
- **Forecast summary** — expected precipitation with its 80% range and chance of at least 1 mm, peak wind, gusts and wind aloft with a 1-in-10 worst case, low cloud cover and lowest visibility (two cards per row on phones); a tap on a card opens its chart at the peak / clearest / worst hour.
- **Reorderable charts** — move chart panels with the arrows, or drag them by the grip on desktop. Once scrolled down, a round ↑ button takes you back to the top.
- **Time windows** — 3 h, 8 h, 24 h (default), 48 h, 72 h or 1 week from the current hour in the location's local time.
- **Model picker** — in the side menu (☰, or *Models* on the "Can I fly now?" card), for the current mode, with what one update costs of Open-Meteo's free allowance. Defaults suit Ukraine and Eastern Europe (ensembles: DWD ICON-EU, ECMWF IFS Europe and AIFS, Google WeatherNext 2; models: DWD ICON, ECMWF IFS and AIFS, Météo-France, UK Met Office), with NOAA GFS, GEM, JMA and BOM also available. A model that fails to load is flagged and skipped.
- **Requests** — Open-Meteo counts every variable of every ensemble member, so an ensemble update is costly (≈ 120 calls with the 4 default ensembles, ≈ 180–210 with all 8; free use: 600 a minute, 5,000 an hour, 10,000 a day). FlySky always asks for 8 days at once (any request up to 14 days counts the same), so changing the time window needs no new request; values are always asked in m/s and mm and converted in the browser (changing a unit asks nothing); each model's forecast is saved on its own, so removing a model asks nothing and adding one asks only for that model (model taps are sent a second after the last one); a model's forecast is reused for 3 h in Ensemble mode and 2 h in Models mode, map wind arrows for 2 h, the map's model readout for 1 h (*Refresh* always asks); a model that fails (no data, or a limit reply) is asked again after 30 minutes or with *Refresh*. The side menu shows this browser's Open-Meteo use in the last hour and day (from each answer's cost); near the hourly or daily free limit, map requests (wind arrows, route wind, readout) pause with a note while the forecast and icing data still load. A per-minute limit is retried once after a minute; an hourly or daily limit stops with one note, and the last forecast stays. The limits are per connection: other users on the same network count too.
- **Locations** — search, current position, favorites (star a location); the last location, mode, models and window are remembered.

## Satellite map

Live EUMETSAT imagery (EUMETView) over a region of your choice, centred on the forecast location.

- **Products** — *Auto (day / night)* by default: Fog / Low Clouds RGB at night, Day Microphysics by day, GeoColour at twilight, chosen for each image by the sun. Also Fog / Low Clouds RGB (Night Microphysics), GeoColour (day & night), Day Microphysics, Cloud Type (incl. supercooled water — icing risk), Cloud Phase, Natural Colour, Cloud Mask and Infrared 10.8 / 10.5 µm. Each RGB has a **colour key** from EUMETSAT's quick guides; when several satellites offer a product (MSG, MTG, MSG Rapid Scan), pick the source.
- **Overlays** — satellite **precipitation** (MTG blended rate), **lightning** (MTG Lightning Imager, last 30 min) and **fires** (MTG fire radiative power, accumulating from the selected time — play from an earlier time to see risk areas build up), with opacity and legends (lightning and fire stacks are drawn as one picture each, light on phones); **forecast wind arrows** (on by default) at the **flight altitude** above the ground at each arrow — 10 m, 120 m or 200–1500 m (400 m by default); above 120 m the wind is interpolated between the model's pressure levels around that height, and arrows are left out where those levels are inside high ground — one setting with the flight time calculator and the forecast view's flight profile — coloured by your flight thresholds (wind aloft limits above 120 m).
- **Animation** — last 6 or 12 hours of real image times; play, step, slider, latest, speed; local time (default) or UTC. Only the latest image is loaded on open; picking a time loads it and the later ones (never earlier ones). The time bar is hidden when nothing on the map has times (no satellite product, no precipitation / lightning / fire layer) and while the flight time calculator is open (a small pill shows the image time and age; tap it for the latest image).
- **Crosshair readout** — read once the map has settled (nothing is asked while you drag; nearby moves reuse what was read, on a ~1 km grid for the satellite and ~5 km for the models), and it never covers the crosshair (long content scrolls). What is under the crosshair for the image on screen: likely cloud type from the colour key (or the exact Cloud Mask class), satellite rain rate, nearest lightning / fire within 50 km, and the forecast models' low cloud, visibility, precipitation and wind for that hour, with which models agree with the satellite. *Set location* makes the crosshair point the forecast location.
- **Flight time calculator** (stopwatch button) — an optional tool for measuring mid-flight. Start A is where the crosshair is when it opens (or after "start here").
  - **Aim** mode: B is the crosshair, so panning measures live; zooming keeps B in place, and a tap takes the crosshair there.
  - **Tap** mode: a tap sets B, and the map pans and zooms freely to look around the route (switching back to Aim takes the map to B).
  - Always visible: A in MGRS, the airspeed slider (18–30 m/s) and B in MGRS. Tap A or B to paste an MGRS reference (several for B make waypoints); A and B can also be dragged. Flight altitude above A (the same setting as the map's wind arrows and the forecast view's flight profile) and departure (now or in 1–6 h) sit next to the mode switch. The route is flown at a constant height above sea level (A's ground + the flight altitude, shown under the route); where the ground along the route rises above it, it says where and how high.
  - Shows the flight time, ETA and the way back; a tag beside the route line shows time, distance and ground speed and stays in view while any of the line is on screen.
  - Each part of the route uses the forecast wind of the hour the drone gets there (wind triangle: heading into the crosswind, then ground speed; on a long, slow stretch the wind changes on the way as the hours pass); if the wind is too strong for the airspeed it says where, when (the drone may get there hours later, when the wind is stronger than the map's arrows for the image's hour) and with what wind.
  - **Icing along the route** (experimental, with the forecast view's icing indicator on, from 50 m up): DWD ICON and the UK Met Office at the flight height at every second point of the route and B, each at the time the drone gets there — "Out: Potential icing 7–40 km (≈ 20 min), −4.0 °C, RH 96 % · 2 of 2 models", the same for the way back, and the climb and descent at A through any layer below the flight altitude; the stretches with icing signs are drawn red (yellow: marginal) under the route line and the tag gets a ❄. About 1.8 Open-Meteo calls per point with its own data (≈ 30 for a long new route with the wind), A's column from the forecast view's data when A is the forecast location (else ≈ 4 calls), answers reused for 3 hours.
  - While it is open, playback stops, the time bar is hidden, and hazard alerts fold into icons so the crosshair stays clear.
- **Navigation** — zoom down to street level (18; the satellite image is drawn for zoom 8 at most — finer than the satellite's own 1–5 km pixels — so zooming in or panning inside the loaded area needs no new image, and the last few areas are remembered so going back reuses their images; zoomed in past the wind grid one arrow shows the wind by the crosshair), distance rings around the location, favorites as stars, place names and borders on top (off by default: the basemaps have them), dark / OSM / no basemap, regions (Ukraine, Europe, around the location, drawn boxes, saved views), full screen, phone landscape layout.
- All map settings are in the side menu (☰) while the map is shown, as cards that fold — *Satellite product*, *Layers* (precipitation, lightning, fires, wind, hazard alerts; each switched-on layer folds its own settings), *Map*, *Region*, *Animation*, *Diagnostics* — each saying what is set while folded.

Satellite RGB imagery shows *likely* fog and low cloud visually; it does not measure cloud-base height. Satellite rain is an estimate and lightning arrives with a few minutes' delay — the alerts are a heads-up, not a warning service.

## Settings, languages, offline

- **Settings** (☰ menu): models, **flight profile** (flight altitude above the takeoff point — shared with the map's wind arrows and the flight time calculator — with its height above sea level at the location; climb and descent rates, flight duration; the icing indicator, icing in the flight verdict, experimental icing thresholds), units (wind m/s, km/h, kn, mph; precipitation mm or inch), flight thresholds (including wind aloft), planner minimum window, nearby-hazard alerts, full screen; in the map view the same menu holds the map settings.
- **Languages**: English, Ukrainian and Portuguese (BR).
- **Installable PWA**: works offline with the last loaded forecasts (the four most recent location / mode combinations are kept); the map needs a connection.

## Usage

FlySky is static files with no build step: `index.html` (forecast), `map.js` (satellite map, loaded when first opened, with Leaflet), `hazard.js` (nearby-hazard alerts), `icing.js` (icing engine, loaded with the icing indicator), `sw.js` (offline cache). To run it, serve the folder with any static file server (e.g. `npx serve .`) and open it in a browser; optionally install it from the browser's install prompt.

When changing `map.js`, `hazard.js` or `icing.js`, bump their `?v=` in `index.html` and in `sw.js`, and the service worker cache version.

## Documentation

- [`docs/plan-2026-11.md`](docs/plan-2026-11.md) — the current work plan: the 2026-11 review checked against the code, what is done, what is next, open decisions.
- [`docs/FlySky-review-2026-11.md`](docs/FlySky-review-2026-11.md) — documentation and code review with suggestions (2026-11).
- [`docs/icing-forecast-handoff.md`](docs/icing-forecast-handoff.md) — the icing indicator's design, data checks and decisions; Phase 0 scripts in [`docs/icing-phase0/`](docs/icing-phase0/).

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
