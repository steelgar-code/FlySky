# FlySky

Ensemble weather forecast for drone/UAV pilots. Instead of a single "best guess", FlySky shows the full spread of answers from several weather models, so you can see how likely rain, strong wind, gusts, or low clouds really are over the coming hours or week. Runs entirely in your browser, no backend required.

## Features

- **Two forecast modes**
  - **Ensemble**: every run (member) of each selected ensemble model, which shows how likely each outcome is.
  - **Models**: the single main (deterministic) forecast of each selected model, which shows how much the models disagree.
  Both modes use the same charts.
- **Probability ranges** — one chart per weather parameter with the median line plus shaded 25–75% (50% likely), 10–90% (80% likely), and min–max bands, pooled across all members or models. Hover any hour for the exact numbers.
- **Parameters** — precipitation (with an hourly chance-of-precipitation bar), wind speed at 10 m, wind gusts at 10 m, and low cloud cover.
- **Time windows** — 3 h, 8 h, 24 h (default), 48 h, 72 h, or 1 week, starting from the current hour in the location's local time.
- **Summary cards** — expected precipitation total with its 80% range and the chance of at least 1 mm, the median peak wind and gusts with a 1-in-10 worst case, and the average low cloud cover with its clearest hour.
- **Model picker** — defaults suit Ukraine and Eastern Europe (DWD ICON, ECMWF IFS and AIFS, plus Google WeatherNext 2 for ensembles and Météo-France and UK Met Office for the Models mode), with NOAA GFS, GEM, JMA, CMA, and BOM also available. A model that fails to load is flagged and skipped without breaking the rest. Toggle *Members* to draw every individual series.
- **Location search** — search any city or place, or use your current position.
- **Favorites** — star a location to save it, then switch between favorites with one tap. The last selected location, mode, models, and time window are remembered.
- **Units** — wind in m/s, km/h, knots, or mph; precipitation in mm or inches.
- **Offline-friendly** — installable PWA; the last loaded forecast is kept so it can still be viewed with no network.
- **Multi-language** — available in English, Ukrainian, and Portuguese (BR).

## Usage

FlySky is a single static HTML file with no build step or dependencies. To run it:

1. Open `index.html` directly in a browser, or
2. Serve the folder with any static file server (e.g. `npx serve .`) and open it in your browser.
3. Optionally install it as a PWA from your browser's install prompt.

## Data & privacy

Forecasts come from the [Open-Meteo Ensemble API](https://open-meteo.com/en/docs/ensemble-api) and [Forecast API](https://open-meteo.com/en/docs) and place search from the [Open-Meteo Geocoding API](https://open-meteo.com/en/docs/geocoding-api) (data licensed CC BY 4.0). Only the search text and the selected coordinates are sent to Open-Meteo. Your favorites, settings, and last forecast stay in your browser's `localStorage`.

## License

MIT — see [LICENSE](LICENSE).
