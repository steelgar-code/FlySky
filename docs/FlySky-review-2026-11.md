# FlySky — documentation and code review, with suggestions

Reviewed on 2026-11-11 at commit `347ed05` (branch `ccr-ba41aa26-fm27b3`).

## How this review was done

- **Read in full:** the forecast logic in `index.html` (markup, styles, all JavaScript), `icing.js`, `hazard.js`, `sw.js`, `manifest.json`, `README.md`, `tests/README.md`, the test runner, and the decisions and open items of `docs/icing-forecast-handoff.md`.
- **Read in part:** `map.js` — configuration, WMS helpers, image cache, capabilities, extent handling, wind, crosshair readout, flight time calculator and the public API. The panel rendering and event binding (roughly lines 1840–2270 and 2490–3160) were skimmed, not read line by line.
- **Checked by script:** the three translation tables in `index.html` (314 keys each, no missing keys, no placeholder mismatches). The Ukrainian and Portuguese READMEs were compared with the English one for structure only (43 bullets and 8 headings each), not for wording.
- **Run:** the offline test suite — **478 checks passed, 0 failed**. The individual test suites and the mock (`tests/lib/mock.mjs`) were not reviewed line by line.

Priority means how much the item matters to a pilot relying on the app. Effort is S (hours), M (a few days) or L (a week or more).

---

## 1. Summary

The code is careful and unusually well commented, the icing engine is a clean, pure, unit-tested module, and the request budget for Open-Meteo is handled thoughtfully. The main weaknesses are not in code style. They are in three places:

1. **A few points of forecast logic can mislead** — an hour offset for rain and gusts, a headline verdict and a confidence figure that are computed by two different methods, and a wind-aloft value that mixes two heights.
2. **The app depends on unpinned CDN files and a network-first service worker**, which is fragile exactly where the app is used: in the field, on a weak connection.
3. **Several cheap changes would save a large share of the Open-Meteo allowance** — units converted in the browser, per-model caching, fewer refetches.

### Top recommendations

| # | Recommendation | Priority | Effort | Section |
|---|---|---|---|---|
| 1 | Shift rain and gusts by one hour: they describe the hour *before* their timestamp | High | S | 2.1 |
| 2 | Make the verdict and its confidence come from one calculation, with a risk-tolerance setting | High | M | 2.2 |
| 3 | Wind aloft: stop pooling two heights; follow the flight altitude | High | M | 2.3 |
| 4 | Always request SI units and convert in the browser (a unit change costs ≈ 120 calls today) | High | S | 3.1 |
| 5 | Cache forecasts per model; debounce model changes | High | M | 3.2 |
| 6 | Self-host and pin Tailwind, Chart.js, Font Awesome and Leaflet | High | M | 4.1 |
| 7 | Service worker: serve the app shell from cache first; announce updates | High | S | 4.2 |
| 8 | Reuse the icing request's data: temperature, low cloud in Ensemble mode, cloud base | Medium | M | 6.1–6.3 |
| 9 | Hazard alerts: say "no coverage" instead of "clear"; optional notifications | Medium | M | 7.1–7.2 |
| 10 | Accept coordinates and MGRS in the location search; rename favourites | Medium | S | 5.1 |
| 11 | Aircraft profiles and an endurance check in the flight time calculator | Medium | M | 6.4 |
| 12 | A sunlight-readable theme and a text-size setting | Medium | M | 5.3 |
| 13 | CI on every push, and Node unit tests for the verdict math | Medium | S–M | 9 |
| 14 | README: add `icing.js` to *Usage*, screenshots, a live link, a limitations section | Low | S | 10 |

### What is already good (keep it)

- `icing.js`: no DOM, no network, runs in Node, 96 unit checks, decisions documented.
- Consistent HTML escaping. Every external string I traced (API error text, place names, WMS layer titles, legend URLs) goes through `escapeHtml`.
- Request discipline: one combined request, per-model fallback, abort of superseded loads, a usage log from `X-RateLimit-Cost`, pacing near the limits.
- Honest wording about uncertainty ("no icing signs" is grey, not green; satellite notes say "likely").
- Offline thinking: forecasts in IndexedDB, legacy migration, a cache per app on the shared origin.

---

## 2. Forecast logic and correctness

### 2.1 Rain and gusts are one hour late — High, S

**Where:** `index.html:2994` (`processForecast`, window start) and `index.html:3535` (the hour label).

Open-Meteo stamps hourly **precipitation** with the *sum of the preceding hour* and **wind gusts** with the *maximum of the preceding hour*. Wind speed, cloud cover and visibility are instantaneous values at the timestamp.

FlySky takes the value stamped `14:00` and labels it "14:00–15:00". For rain and gusts that value describes 13:00–14:00. At 14:25 the "Can I fly now?" card therefore shows the rain chance and gusts of the hour that has just ended, and every later hour is offset the same way — in the flight bar, the planner windows and the tiles.

**How to fix** (a sketch; `valueAt` stands for the existing lookup by time):

```js
// Variables that describe the hour BEFORE their timestamp.
const PRECEDING_HOUR = new Set(['precipitation', 'wind_gusts_10m']);
// processForecast(): when cutting a series to the window
const shift = PRECEDING_HOUR.has(v) ? 1 : 0;
let values = aligned
    ? series.slice(start + shift, end + shift)
    : windowTimes.map(tm => valueAt(addHoursToLocal(tm, shift)));
```

- Pad the last hour with `null` when the series ends. Eight days are fetched, so only the final hour of the 1-week window is affected.
- For the instantaneous variables, consider the worse of the values at `t` and `t + 1` for the interval, so a wind rising during the hour is not missed.
- The icing cues use `precipitation` at hour `i` the same way (`icing.js:161`); apply the same shift there.
- Add a test with a mock that has rain in exactly one timestamp.

### 2.2 The verdict and its confidence are two different calculations — High, M

**Where:** `index.html:3090–3113` (verdict) and `index.html:3121–3208` (confidence).

- The **headline verdict** uses the *median* of pooled members for wind, gusts, wind aloft, low cloud and visibility, and the *share of wet members* for rain.
- The **confidence** gives each member its own verdict, averages per model, and reports the share of the *largest group* — whichever status that group has.

Two consequences:

1. **The pair can contradict itself.** Example: 10 % of members have rain, everything else is fine. The headline is "Uncertain" (rain chance above 0). The largest group — 90 % — says "Suitable". The card shows **"Uncertain · confidence high (90 %)"**, which reads as "90 % sure it is uncertain" and means the opposite.
2. **A median hides the tail.** With a median gust of 7.9 m/s the hour is green even if 45 % of members exceed the limit. For a go / no-go aid the tail is the point.

There is a third, smaller inconsistency: the statistics pool members, so models count by member number (ECMWF IFS + AIFS are 102 of the 206 default members), while the confidence weights each model equally.

**How to fix — one source of truth:**

- Compute, per hour, the model-weighted shares `P(bad)` and `P(marginal or worse)` (the code already has them in `h.agree.shares`).
- Derive the verdict from the shares with a **risk tolerance** setting:

  | Preset | Not suitable when | Uncertain when |
  |---|---|---|
  | Cautious | P(bad) ≥ 10 % | P(marginal or worse) ≥ 10 % |
  | Balanced (default) | P(bad) ≥ 30 % | P(marginal or worse) ≥ 30 % |
  | Median-like (today's behaviour, roughly) | P(bad) ≥ 50 % | P(marginal or worse) ≥ 50 % |

- Report confidence as the share of members that **agree with the shown verdict**, and word it that way: "Suitable — 82 % of members agree".
- Show the exceedance chance on the tiles: "Gusts 7.2 m/s · 22 % over your limit".
- Use the same model weighting for the chart bands (weighted quantiles), or say in the legend that bands count members, not models.

### 2.3 Wind aloft mixes two heights and ignores the flight altitude — High, M

**Where:** `index.html:707–715` (parameter), `index.html:3065` and `3095` (verdict), `index.html:3138` (confidence).

- In Ensemble mode the 1000 hPa (≈ 0–100 m, often inside the ground) and 925 hPa (≈ 600 m) winds are pooled into one distribution. The verdict takes the **median of that pool**, a value between the two levels that exists at neither. The confidence takes each member's **stronger** level. The two disagree by design.
- Models mode uses 950 hPa (≈ 400 m). So the two modes judge different heights.
- Neither follows the **flight altitude** setting, which the map's wind arrows, the calculator and the icing indicator all use. A pilot who sets 1000 m gets a verdict for 400–600 m. The handoff document already lists this as open item O1.

**How to fix:**

- Short term: per member take the stronger of the two levels *before* the statistics, so verdict and confidence agree, and leave 1000 hPa out where it lies at or below the ground (the icing request's surface pressure tells).
- Proper fix: in Models mode request wind and geopotential height at the three levels around the flight altitude and reuse `windAt()` from `map.js:2324` (move it to a shared module). In Ensemble mode only 1000 / 925 hPa exist, so show the nearest level with its real height and label the gap ("925 hPa ≈ 600 m; your altitude is 1000 m — see Models mode").

### 2.4 Gusts share the mean-wind limits — Medium, S

**Where:** `index.html:749`, `3102`.

Gusts are checked against `windGood` / `windBad`, the same numbers as the mean wind. Gusts are normally well above the mean, so one pair of limits is either too strict for gusts or too loose for the mean. Add `gustGood` / `gustBad` (default, for example, 10 and 16 m/s) with their own row in the thresholds form; `sanitizeFlightRules` already handles new pairs with a default.

### 2.5 "No chance of precipitation" is rarely true with 200 members — Medium, S

**Where:** `index.html:749` (`rainGood: 0`), `3084`.

One wet member out of 206 (0.5 %) makes an hour "Uncertain". In an unsettled week almost no hour can be green, so the bar stops discriminating. Options: a default of 5–10 %, or a rule that also looks at the amount (the median or 90 % amount in mm/h), so that a small chance of drizzle and a real chance of a downpour differ. Snow and rain could be told apart with the `snowfall` variable.

### 2.6 A model that ends early changes the bands silently — Low, S

ICON-EU's ensemble ends at about 5 days; in the 1-week window the later hours hold fewer members and models. The tooltip shows the count, but nothing marks the change on the chart. Draw a thin marker ("ICON-EU ends") or fade the bands the way the icing strip fades hours beyond 3 days.

### 2.7 Very old cached data is shown as "now" — Low, S

**Where:** `index.html:2995`.

If the saved forecast no longer contains the current hour (offline for more than a week), the code falls back to the last hours of the old forecast and the card titles them "Can I fly now?". Show "The saved forecast has expired" instead.

### 2.8 Daylight-saving changes — Low, verify first

The forecast keeps one `utc_offset_seconds` for the whole series (`index.html:2953`). If Open-Meteo also applies one fixed offset to the whole response, hours after a clock change inside the 8-day window are labelled one hour off the wall clock that will apply then. It is worth one test request across the next change; if confirmed, a note ("times after 29 Mar are in winter time") is enough.

---

## 3. Open-Meteo usage and performance

### 3.1 Convert units in the browser — High, S

**Where:** `index.html:2677` (`forecastKey` includes the units), `2702–2703`, `5412–5425`.

Changing the wind or precipitation unit changes the cache key and triggers a full refetch — about 120 calls in Ensemble mode — for data that differs only by a constant factor. It also splits the four saved forecasts by unit.

**How:** always request `wind_speed_unit=ms` and millimetres (as `map.js` already does), store SI, and convert in `formatValue()` and the chart datasets. Thresholds are already stored in m/s, so `toMs` and the inch branches of `wetThreshold` disappear. Remove the units from `forecastKey` and bump its version tag.

### 3.2 Cache per model, and debounce model changes — High, M

**Where:** `index.html:5372–5391`, `2673–2678`.

The selected model list is part of the cache key, so:

- **Removing** a model refetches every remaining model, although its data is already in memory.
- **Adding** one model refetches all of them.
- Three quick taps on model chips start three full requests. The earlier ones are aborted, but Open-Meteo has usually already counted them.

**How:** store one record per `mode | location | model` with its own `fetchedAt`; build `state.forecast` from the records; request only the models that are missing or stale. Apply model changes about a second after the last tap. Adding one ensemble then costs about 10–40 calls instead of 120–210, and removing one costs nothing.

### 3.3 Refetch when a new model run exists, not on a timer — Medium, M

Forecasts are reused for a fixed 3 h (Ensemble) or 2 h (Models). Open-Meteo publishes per-model metadata (last run time, availability time, update interval) as small static JSON files — see its "model updates" documentation for the exact URLs. Reading those first would let the app skip a refetch when nothing changed, fetch promptly when a run arrives, and show "ICON run 06 UTC, 3 h old" next to each model — useful information in its own right.

### 3.4 Aborted requests are logged as free — Low, S

**Where:** `index.html:1918–1920`.

Any `fetch` error, including an abort, sets the logged cost to 0. An aborted request has usually reached the server and been counted, so the usage line undercounts. Keep the estimated cost for `AbortError`; zero it only for network failures.

### 3.5 A data-saver mode — Low, S

A week of ensemble data is about 2 MB before compression. The call cost does not depend on the days requested, but the download does. With a "data saver" switch, request only the days the selected window needs (the pre-`FETCH_DAYS` behaviour), and say that switching to a longer window will then fetch again.

### 3.6 An API key or own server — Low, S

The free limits are per IP, so a team behind one connection shares them (the README says so). Add two optional settings: an API base URL and an API key (Open-Meteo's paid endpoint, or a self-hosted instance). The three URLs are already constants (`MODES.*.url`, `GEOCODING_URL`, `MAP_CONFIG.openMeteo`).

### 3.7 Wind arrows — Low, M

Each arrow point costs one call and a large screen reaches the cap of 220 points per view (`map.js:2386`). Wind fields are smooth at this scale: fetching a fixed coarse grid (for example 0.25°) and interpolating u / v for the arrows on screen would cut the calls several times and make panning free more often.

---

## 4. Offline, PWA and reliability

### 4.1 Self-host and pin the libraries — High, M

**Where:** `index.html:24–28`, `sw.js:40–51`.

- `https://cdn.tailwindcss.com` is Tailwind's Play CDN. Tailwind documents it as a development tool: it compiles the styles in the browser on every start (slow on phones, a flash of unstyled content) and can change without notice.
- `https://cdn.jsdelivr.net/npm/chart.js` has **no version**. The day Chart.js publishes a new major version, the app loads it.
- None of the tags has an integrity hash, and three third-party hosts must all be reachable for a first load.
- The tests already show the cost: the mock serves Tailwind v4 instead of the app's v3, and a `tailwind is not defined` page error is ignored (`tests/README.md`).

**How:** commit pinned copies under `vendor/` — `chart.umd.min.js`, Leaflet, the Font Awesome CSS and the two font files — and generate one static `app.css` with the Tailwind CLI, scanning `index.html`, `map.js` and `hazard.js`. That is one command before a release, not a build step for the app. Gains: a faster start, a real offline guarantee, tests against the real CSS, and the option of a Content-Security-Policy (section 8.1).

Also: `Inter` and `JetBrains Mono` are named in the font stacks (`index.html:46–47`, `map.js:1074–1087`) but never loaded, so the fallback fonts are what users see. Either ship the two fonts or remove the names.

### 4.2 Service worker — High, S

**Where:** `sw.js:64–66`, `112–140`.

- **Network-first with no timeout.** On a connection that is technically up but very slow, every app file waits for the network to fail before the cached copy is used. The app can take tens of seconds to open. Serve the precached shell **cache-first** (stale-while-revalidate): the cache name already carries the version, so freshness is not lost. At least race the network against a 2–3 s timer.
- **Updates are silent.** `skipWaiting()` plus `clients.claim()` replace the worker under an open page. That page still holds the old `index.html` and later lazy-loads `map.js?v=23`; the server ignores the query string and returns the *new* `map.js`. Old page plus new script is an untested combination. Listen for `controllerchange` and show "New version — reload".
- **Three places to bump by hand** (`index.html`, `sw.js`, the cache name). Add a test that reads both files and fails when the `?v=` values differ, or generate the list from one constant.

### 4.3 Manifest — Low, S

`manifest.json` still says "Ensemble weather forecast ranges for precipitation, wind and gusts." Update the description, and add `id`, `scope`, `lang`, `categories` and `shortcuts` (Forecast, Satellite map). `apple-touch-icon` points to the 192 px icon; iOS expects 180 px. iOS has no install prompt event, so show a one-time "Share → Add to Home Screen" hint there.

### 4.4 The app's version is invisible — Low, S

Show the version and build date at the bottom of the settings drawer (from the same constant as 4.2). It makes bug reports usable.

---

## 5. Usability

### 5.1 Location entry — Medium, S

**Where:** `index.html:5263–5283`, `5355–5366`.

- The search accepts place names only. Pilots work from fields with no name. Recognise `50.4501, 30.5234` and MGRS (the parser exists in `map.js:3726`; move it to a shared file) before calling the geocoder.
- "Use my location" names the place "My location". Starring it at two sites gives two favourites with the same name, and favourites cannot be renamed. Add rename (and reorder), and name a located point by the nearest search result or its coordinates.
- A location found by GPS has no elevation until the first icing answer; store the forecast response's `elevation` on the location.
- Removing a favourite is immediate. Offer "Undo" in the toast.

### 5.2 First use and explanations — Medium, M

The forecast view is dense: bands, medians, members, confidence, split by share, icing layers. A new user gets no introduction. Add a short first-run tour (three or four steps), an ⓘ button on each card that opens its explanation, and a glossary. The README text can be reused almost as it is.

### 5.3 Readability outdoors — Medium, M

The app is dark-only, and about 120 lines of markup use 9–11 px text, much of it `slate-500` on `slate-900` (contrast about 3.7 : 1). On a phone in sunlight this is hard to read. Add a light "daylight" theme with high contrast and a text-size setting (normal / large). The colours are mostly Tailwind utility classes, so a theme is easier after 4.1, with CSS variables.

### 5.4 Messages — Medium, S

**Where:** `index.html:5458–5484`.

Toasts disappear after 3 s whatever they say. "Open-Meteo's free limit reached" is important and easy to miss. Keep warnings until dismissed (or 8–10 s), allow a tap to close, and give the container `role="status"` and `aria-live="polite"` — today nothing announces them to a screen reader.

### 5.5 Settings — Low, S–M

- **Reset to defaults** resets thresholds, minimum window and icing thresholds, but not the flight profile, units or models. Say what it resets, or offer "Reset everything".
- **Export / import settings and favourites** as a JSON file. All four Fly apps share one origin and its storage; an export is the only backup and the only way to move to another phone.
- **Planner:** an option to count daylight only (the sun times are already computed), and "Add to calendar" (.ics) for a window.

### 5.6 Sharing — Medium, S

- **Copy briefing:** a button that puts a plain-text summary on the clipboard — place, time, verdict, limiting factors, next window, icing line. It is what people paste into a team chat.
- **Deep links:** `?lat=…&lon=…&name=…` opens a location, so a site can be shared.

### 5.7 The planner hour and the calculator are not linked — Low, S

**Where:** `map.js:3721`.

A pinned forecast hour opens the map with the wind arrows for that hour, but the calculator still departs "now" (or in 1, 2, 3, 6 h). Use the pinned hour as the default departure, and allow any hour within the wind data.

---

## 6. Features that would make the app more useful

### 6.1 Temperature — Medium, S

There is no temperature anywhere in the forecast view. It matters for battery capacity, for the pilot, and for reading rain versus snow. The icing request already brings `temperature_2m` and `relative_humidity_2m` for ICON and UKMO, so a temperature tile and chart cost **no extra calls** while the icing indicator is on. Add a "cold battery" note below a chosen temperature.

### 6.2 Low cloud in Ensemble mode — Medium, S

The ensemble API has no low cloud cover, so in Ensemble mode the verdict leaves it out (the legend says so). The icing request already carries `cloud_cover_low` for two deterministic models. Use it to fill the tile and the check in Ensemble mode, labelled "from ICON + UKMO". The same applies to visibility where ensemble members lack it.

### 6.3 Cloud base against the flight altitude — Medium, M

Low cloud cover in percent does not say whether the cloud is below the aircraft. The icing engine already places each pressure level at its height above the ground and computes relative humidity over water. A generalised `layers()` — saturated levels at any temperature, not only sub-zero ones — gives an estimated cloud base: "cloud from about 300 m; your altitude 400 m is inside it". This works all year and reuses data already downloaded.

### 6.4 Aircraft profiles and endurance — Medium, M

- The calculator's airspeed is fixed to 18–30 m/s (`map.js:1280`, `4545`), which suits one class of fixed-wing aircraft. Multirotors cannot use it.
- The flight profile has a **flight duration**, used only for icing. The calculator computes the time out and back but never compares the two.

Introduce named aircraft profiles: airspeed range and cruise speed, wind and gust limits, endurance, climb and descent rates. The calculator can then say "out and back 1 h 38 min of 2 h endurance, 22 min reserve", mark the point of no return, and warn when the wind on the way back removes the reserve.

### 6.5 Favourites overview — Medium, M

"Which of my sites is flyable now?" One line per favourite with its verdict and next window. In Models mode a site costs about 3 calls, so ten favourites stay cheap; refresh on demand only.

### 6.6 Wind direction — Medium, S

The forecast view shows wind speed only. Direction decides the launch and landing heading and the route. Add direction arrows under the wind chart from the deterministic models (`wind_direction_10m` is already requested for the map readout, `map.js:3255`); in Ensemble mode a circular mean plus spread would be enough.

### 6.7 More factors — Low, M each

- **Thunderstorm potential** from the deterministic models (CAPE, thunderstorm weather codes) as a forecast counterpart to the satellite lightning alert.
- **Wind shear / turbulence hint:** the difference between the 10 m wind and the wind at the flight altitude, and the gust factor.
- **Kp index** (NOAA SWPC publishes it as JSON) for GNSS reliability — check cross-origin access first.
- **Satellite check that feeds back:** the map readout already says which models agree with the satellite at the crosshair. Show that in the forecast view for the current hour ("ICON matches what the satellite sees; GFS does not") so the user knows which line to trust for the next hours.

### 6.8 Other regions — Low, L

There is a Portuguese (Brazil) translation, but the satellite map and the hazard alerts use Meteosat only. Either state the coverage (see 7.1) or add GOES imagery for the Americas from a public WMS / WMTS source.

---

## 7. Hazard alerts, map and icing

### 7.1 "Clear" outside satellite coverage — Medium, S

**Where:** `hazard.js:324`.

When the small image has no opaque pixel, the result is "no lightning or rain within 50 km". Outside the coverage of the product (or of the Lightning Imager) the image is also empty. The user then reads "clear" where the truth is "not observed". Check the layer's bounding box from its capabilities (already downloaded for the time steps) and the location's distance from the point below the satellite — beyond roughly 65–70° of arc the disc is not usable — and show "outside satellite coverage" instead.

### 7.2 Alerts only while the app is on screen — Medium, M

**Where:** `hazard.js:509–511`.

Polling stops when the page is hidden. A lightning alert is most useful when the pilot is looking at the aircraft, not at the phone. With the Notification permission, keep polling in a hidden tab and raise a notification (with vibration) when an alert appears or starts approaching. Say clearly that a closed app cannot alert.

### 7.3 Alert radius — Low, S

The 50 km radius is fixed (`hazard.js:39`). Offer 25 / 50 / 100 km.

### 7.4 Map tiles — Low, S

Both basemaps load from `tile.openstreetmap.org` (`map.js:83–85`). OSM's tile policy allows light use and may block heavier use without notice. Make the tile URL a setting, or add a second key-free provider as a fallback.

### 7.5 Icing — Low

- The header of `icing.js` still says "Stage 1: the engine only — not loaded by the app yet" and lists geopotential height as an input (`icing.js:10–20`). Both are out of date.
- `index.html:4361` falls back to `tMin: -20` when the engine is not loaded; the engine's value is −30 (`icing.js:76`). With the indicator off, the settings note shows the wrong range.
- `map.js:4022` reads `ICING.byKey`, `icingRequest()` and `icingMaxAge()` from `index.html` directly. Give it one function (`icingColumnFor(location, height)`) instead of three internals (see 8.3).
- Open items O6, O9 and O12 (validation against observations) remain the most valuable icing work; nothing in the code replaces them.

---

## 8. Code quality, security and accessibility

### 8.1 Security and privacy

- **Content-Security-Policy** (after 4.1): `default-src 'self'`, `connect-src` limited to Open-Meteo and EUMETSAT, `img-src` adding OSM and EUMETSAT. The inline script would move to a file. The escaping is consistent today; a CSP protects against the one future slip.
- **Shared origin.** FlyLog, FlySend, FlyStock and FlySky share `steelgar-code.github.io`: one storage quota, and a script injection in any of them reaches the data of all. A separate (sub)domain per app isolates them; it needs the export / import from 5.5 for migration.
- **Coordinates sent to the API** are rounded to 3 decimals (about 100 m). The models' grids are 2–25 km, so 2 decimals (about 1 km) would give the same forecast and reveal less. Offer it as a privacy setting. The calculator already uses 0.1° cells, which is good.

### 8.2 Accessibility

- The settings drawer is `role="dialog" aria-modal="true"` (`index.html:440`) but does not trap focus, and when closed it is only moved off-screen: its controls stay in the tab order. Set `inert` on it when closed and on the page behind when open; return focus to the menu button on close.
- The flight bars rely on green / yellow / red, which red-green colour-blind users cannot tell apart reliably. Add a pattern to "not suitable" cells (the confidence strip already uses hatching) or a colour-blind palette option.
- No `prefers-reduced-motion` handling for the smooth scrolling and transitions.

### 8.3 Structure

- `index.html` is 366 KB: about 950 lines of markup and styles, 950 lines of translations and 3,900 lines of logic. `map.js` adds 291 KB with 900 more lines of translations. Suggested split, still without a build step (plain `<script>` files or ES modules):
  - `i18n/en.js`, `uk.js`, `pt-BR.js` — load only the active language;
  - `core.js` — `quantile`, `processForecast`, `computeFlight`, `computePlan`, `splitCombined`, `sunTimes`, `sunAltitudeDeg`, the MGRS code and `windAt`, with no DOM access, exported for Node like `icing.js`;
  - `forecast-ui.js` — rendering and events.
- `map.js` and `hazard.js` use about twenty globals of `index.html` (`t`, `state`, `omFetch`, `FLIGHT_HEIGHTS`, `ICING`, …), listed only in a comment. One explicit `window.FlySky = { … }` object would make the contract visible and testable.
- Add `// @ts-check` with JSDoc types for the main data shapes (forecast, processed hour, icing result) and run `tsc --noEmit` and ESLint in CI. No build step is needed and it catches typos in a file this size.
- `runForecastLoad` rethrows unexpected errors (`index.html:2923`) and most callers of `loadForecast()` do not catch. Add one `.catch` in `loadForecast` that logs and shows a toast.

### 8.4 Small inconsistencies found

| Where | What |
|---|---|
| `index.html:492` | HTML fallback text says "≈ 5 Open-Meteo calls per update"; the translation says ≈ 4 every 3 hours |
| `index.html:380` | HTML fallback of the icing profile hint says "green no signs, grey no data"; the app uses grey and hatched |
| `index.html:607–617` | Two overlapping comment blocks about the reuse time |
| `index.html:2006–2007` | Comment for a removed setting ("Which wind the flight rules judge") |
| `index.html:2073`, `2156` | "read again after an hour"; the code uses 3 h / 12 h |
| `index.html:5512` | "Keep the 72-hour window"; the window is selectable |
| `map.js:2445` | "not refreshed for 30 min"; `WIND_MAX_AGE_MS` is 2 h |
| `index.html:830`, `915`, `1063` | Unused translation keys `currentLocationLabel`, `confMembersN`, `perHour` (in all three languages) |
| `docs/icing-phase0/select.py` | The name shadows Python's standard `select` module where that module is not built in (for example python.org builds on macOS); `om.py` imports `subprocess`, which imports it. Rename to `model_select.py` |

---

## 9. Tests

The suite is a real strength: 17 offline suites, 478 checks, everything external mocked, and it passes.

- **No CI.** There is no `.github/workflows`. Add one workflow: `npm ci`, `npx playwright install chromium`, `npm test` on every push and pull request. — Medium, S
- **No lockfile**, and three of the six dependencies use `^` ranges. Commit `tests/package-lock.json`. — Low, S
- **The safety-relevant math has no unit tests.** Only `icing.js` runs in Node. The verdict, confidence, planner, quantiles and the multi-model split are tested only through the page. After the split in 8.3, add Node tests for them, starting with the cases in 2.1–2.3. — Medium, M
- **Chromium only.** An installed PWA on an iPhone runs WebKit. Run at least the forecast suites in Playwright's WebKit. — Medium, S
- **Time-dependent results.** `tests/README.md` notes that results depend on the time of day. Playwright's clock API can fix the time per suite. — Low, S
- **Own runner.** `run.mjs` counts `PASS` / `FAIL` lines. `@playwright/test` would add timeouts, retries, parallel runs and traces for failures. — Low, M
- **Missing cases worth adding:** a version-consistency check between `index.html` and `sw.js` (4.2); the service worker offline start; a location outside satellite coverage (7.1).

---

## 10. Documentation

- **`README.md` — *Usage* omits `icing.js`.** The file list and the "bump `?v=`" rule name `map.js` and `hazard.js` only; `icing.js?v=3` is in both `index.html` and `sw.js` and needs the same bump. — S
- **No picture and no link.** Add two or three screenshots (the "Can I fly now?" card, a chart, the map with the calculator) and the address of the live app. — S
- **Very long bullets.** Several README items are single paragraphs of 100–200 words (the icing indicator, the requests, the calculator). Split the README into a short overview plus `docs/` pages: user guide, flight time calculator, icing, data and limits. — M
- **One "Limitations" section.** The caveats are good but scattered (icing, satellite, hazards). Collect them, and add one sentence for the forecast verdict itself: a decision aid, not a clearance. Show the same sentence once in the app. — S
- **Supported browsers** and what works offline, as a small table. — S
- **`docs/icing-forecast-handoff.md`** mixes the specification, the decision log and the change history in 627 lines. Keep the current design in one file and move "Recent changes" and "Changes" to a changelog. — M
- **`CHANGELOG.md`** for the app, tied to the version shown in the app (4.4). — S
- **`CONTRIBUTING.md`:** how to run the tests, the version-bump rule, how to add a translation key (three tables in `index.html`, plus `map.js` and `hazard.js`). — S
- **Three READMEs** are kept in step by hand. A note at the top of each translation with the commit of the English text it follows would show when one falls behind. — S

---

## 11. Suggested order of work

1. **Correctness first (about a week):** 2.1 hour shift, 2.2 unified verdict with risk tolerance, 2.3 wind aloft short-term fix, 2.4 gust limits. Add the Node tests for them (section 9).
2. **Quota and reliability (about a week):** 3.1 SI units, 3.2 per-model cache, 4.1 self-hosted libraries, 4.2 service worker, CI.
3. **Free data, more value (a few days):** 6.1 temperature, 6.2 low cloud in Ensemble mode, 7.1 coverage note, 5.1 coordinates and MGRS in search, 5.4 messages.
4. **Larger features:** 6.3 cloud base, 6.4 aircraft profiles and endurance, 5.3 daylight theme, 7.2 notifications, 6.5 favourites overview.
5. **Housekeeping, alongside:** 8.3 file split, 8.4 clean-ups, section 10 documentation.
