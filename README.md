# FlySky

Ensemble weather forecast for drone/UAV pilots. Instead of a single "best guess", FlySky shows the full spread of answers from several ensemble weather models, so you can see how likely rain, strong wind, or gusts really are over the next 72 hours. Runs entirely in your browser, no backend required.

## Features

- **Ensemble ranges** — one chart per weather parameter with the median line plus shaded 25–75% (50% likely), 10–90% (80% likely), and min–max bands, pooled across every member of the selected models. Hover any hour for the exact numbers.
- **Parameters** — precipitation (with an hourly chance-of-precipitation bar), wind speed at 10 m, and wind gusts at 10 m, over the next 72 hours in the location's local time.
- **Summary cards** — expected 72-hour precipitation total with its 80% range and the chance of at least 1 mm, plus the median peak wind and gusts with a 1-in-10 worst case.
- **Model picker** — DWD ICON, NOAA GFS, ECMWF IFS and AIFS, Google WeatherNext 2, GEM, UK Met Office, and BOM ensembles. Toggle *Members* to draw every individual ensemble run.
- **Location search** — search any city or place, or use your current position.
- **Favorites** — star a location to save it, then switch between favorites with one tap. The last selected location is remembered.
- **Units** — wind in m/s, km/h, knots, or mph; precipitation in mm or inches.
- **Offline-friendly** — installable PWA; the last loaded forecast is kept so it can still be viewed with no network.
- **Multi-language** — available in English, Ukrainian, and Portuguese (BR).

## Usage

FlySky is a single static HTML file with no build step or dependencies. To run it:

1. Open `index.html` directly in a browser, or
2. Serve the folder with any static file server (e.g. `npx serve .`) and open it in your browser.
3. Optionally install it as a PWA from your browser's install prompt.

## Data & privacy

Forecasts come from the [Open-Meteo Ensemble API](https://open-meteo.com/en/docs/ensemble-api) and place search from the [Open-Meteo Geocoding API](https://open-meteo.com/en/docs/geocoding-api) (data licensed CC BY 4.0). Only the search text and the selected coordinates are sent to Open-Meteo. Your favorites, settings, and last forecast stay in your browser's `localStorage`.

## License

MIT — see [LICENSE](LICENSE).
