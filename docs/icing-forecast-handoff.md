# FIXED-WING UAV ATMOSPHERIC ICING FORECASTING
## Technical Handoff & Architecture Specification — v2.5 (FlySky integration)

| Document status | Purpose | Intended use |
|---|---|---|
| **Design decided (D1–D17); Phase 0 API verification done (2026-11-05); stage 1 (engine `icing.js` + unit tests) and stage 2 (flight altitude in metres, wind at a fixed height) implemented** | The icing screening design for FlySky: Phase 0 results (live Open-Meteo APIs, last winter's archived forecasts), v1 with two models (ICON + UKMO), flight altitude in metres above takeoff, icing-layer report, and the staged implementation. | Implementation of stages 2–5 in FlySky (`index.html`, `map.js`, `icing.js`), test planning. Phase 0 scripts and output: [`docs/icing-phase0/`](icing-phase0/); engine tests: `tests/icing-engine.mjs`. |

> **Safety notice**
> Proxy indicators and exposure estimates are not validated icing forecasts. They do not estimate ice accretion or a probability of icing, and **must not be used to authorize flight into icing conditions**. A small fixed-wing UAV should be kept out of forecast or observed icing unless the complete aircraft is designed, tested and approved for it. In FlySky the icing indicator is a separate, clearly labelled, **experimental** screening aid; by default it does not change the flight verdict. It shows where the icing layers are and how long a flight would spend in them; it never recommends flying through them (§7.7).

---

## 0. Recent changes

**v2.5 — stage 2 implemented** (§13): one **Flight altitude** setting in metres above takeoff (10 m … 1500 m, default 400 m) in the forecast view's side menu (*Flight profile*, with its height above sea level at the location), the map's wind block and the calculator; the stored wind height is carried over (§5.1). Wind arrows and calculator wind at that height: three pressure levels around it with their geopotential height, u / v interpolated, levels inside the terrain left out (arrows hidden with a note; the calculator says where the ground rises above the flight height). Wind-aloft labels corrected to heights above the ground. Same call cost as before.

**v2.4:**

1. **Flight altitude in metres above the takeoff point**, not a pressure level (D4). A pressure level drifts up to ~190 m away from a fixed flight altitude with the weather; each hour the engine now takes the levels just below and above the aircraft's height. ASL and height above the ground are shown alongside (§5).
2. **v1 starts with two models, ICON + UKMO, "red if either"** (D16): same data types (975/950 hPa levels, RH over water, visibility), 2–3 % of the hours a 5-model majority flags are missed (ICON alone: 14–15 %, ECMWF IFS alone: 17–21 %), 4.8 calls per update. The engine works with any list of models; a consensus of more models is a later option (§7.6).
3. **Icing-layer report** (D17): base and top of each layer, clear air below, conditions above, minutes in the layer at the climb rate; the planner names hours with the layer above the flight altitude. Winter statistics in §7.7.
4. **Route request** with three levels around the flight height for two models: ≈ 3 calls per route point instead of 1 (§6).
5. **Stage 1 implemented** (§13): `icing.js` — request builder, response parsing, RH normalisation, evidence, surface cues, fixed-height evaluation, Mode A flights, layers, two-model combination, route-point evaluation; 72 unit tests; cross-checked against the Phase 0 winter data. Not yet loaded by the app.
6. D11–D15 (proposed in v2.3) are **decided**.

v2.3 (Phase 0) changes are listed in §15.

---

## 1. Executive summary

FlySky gets an atmospheric icing screening indicator in two places:

1. **Forecast tab (Mode A — local flight profile).** For every hour of the selected time window, a predefined flight from the forecast location: climb to the flight altitude, cruise there for the flight duration, descend. Shown as a separate **Icing** indicator (row in "Can I fly now?", strip in Flight conditions, icing-layer line, height-by-time chart, details). Two models, ICON and UKMO, in both forecast modes.
2. **Flight time calculator on the map (Mode B — route).** Along the calculator's route, at the time the aircraft reaches each part (the same timing the wind calculation already uses), at a constant height above sea level (A's elevation + flight altitude); plus the climb at A and the descent at the end. Risky stretches are coloured on the route line and described in the panel; outbound and return reported separately. Same two models.

Both use one shared engine (`icing.js`), the same evidence states and thresholds, and one **Flight altitude** setting in metres above takeoff, shared with the wind arrows and the calculator (§5).

Unchanged since v2.1: meteorological hazard evidence is kept separate from aircraft exposure; multi-state evidence instead of a yes/no answer; no clearance function; unknown data is never scored as "no icing".

### 1.1 Decisions

| # | Decision | Status |
|---|---|---|
| D1 | Icing is a **separate risk indicator**; it does **not** affect the flight verdict, planner or confidence by default. Settings option "Include icing in the flight verdict" (off by default). In Ensemble mode with the option on, each ensemble member takes the icing factor as the icing models see it; the icing models are not added to the confidence as extra models (§8.2). With the option on, expect about half of winter hours to be rated bad (§7.5). | Decided |
| D2 | Icing exposed **only during climb or descent** is shown **red**, with a clear note ("climb only: ~3 min through 150–300 m above ground"). Happens in up to ~1 in 5 winter hours for some models. | Decided |
| D3 | Defaults: flight altitude **400 m above takeoff** (≈ the 950 hPa level over lowland Ukraine), climb **2 m/s**, descent **2 m/s**, flight duration **2 h**. | Decided (v2.4) |
| D4 | **One altitude setting** ("Flight altitude", metres above takeoff) for wind arrows, calculator wind and icing. Each hour the levels are placed by their geopotential height and the flight height is evaluated between the two around it (D14); the app shows the height above sea level and above the ground with it. | Decided (v2.4) |
| D5 | Forecast-tab icing uses a **separate request** with the **icing models** (v1: ICON + UKMO), not the Models-mode selection: T, RH, height at 1000–850 hPa (more for high flights / high ground), T at 700 hPa, 2 m T and RH, weather code, visibility, precipitation = 24 variables × 2 models = **4.8 calls**; same `timezone` as the forecast request. | Decided (v2.4) |
| D6 | Route icing data come with the **route request** (same samples, same timing). With three levels around the flight height for two models it costs ≈ **3 calls per route point** (≤ 48 for a new 16-point route; today 16). The climb/descent column at A reuses the forecast-tab data when A is in the forecast location's area, otherwise one small request. | Decided (v2.4) |
| D7 | Icing comes from **deterministic models only**, also in Ensemble mode: ensemble pressure-level T/RH exists only for ECMWF IFS 0.25°, AIFS, the GFS ensemble and WeatherNext 2, only at 1000 / 925 hPa below ~1 km, not for FlySky's default ECMWF ensemble (IFS Europe) or ICON-EU EPS, and ~200 members would cost far more. | Decided |
| D8 | Vertical velocity is **not used** in v1. | Decided |
| D9 | Freezing fog / sub-zero low stratus is its own surface cue: weather code 48 (ICON only), or 2 m temperature ≤ 0 °C with visibility < 1 km (ICON first ~5 days, UKMO, GFS) or 2 m RH ≥ 97 %. | Decided |
| D10 | Thresholds are experimental defaults, configurable under advanced settings (§7.4); they apply to RH over water. | Decided (values provisional) |
| D11 | **RH normalised to RH over water per model** before any threshold (§4.4). Implemented in the engine; ICON and UKMO need no conversion. | Decided |
| D12 | **Freezing-precipitation cue from the profile** (warm nose: precipitation, 2 m ≤ 0 °C, a level above 0 °C up to 700 hPa) besides codes 56/57/66/67; red in all phases including the cruise. | Decided; implemented |
| D13 | **Below-ground masking** for icing and wind: a level less than 20 m above the ground is ignored; a flight height with no usable level within 500 m is unknown ("no level near", e.g. high ground); a route point whose ground is above the flight height is "below ground". | Decided; implemented (icing: stage 1, wind: stage 2) |
| D14 | **Evaluation at a fixed height:** the worse of the nearest usable levels below and above it (within 500 m); "coarse" when only one side exists or a level used is more than 300 m away; the 2 m layer is never used — it feeds only the surface cues. | Decided; implemented |
| D15 | **Route models: ICON + UKMO**; wind for the wind triangle from ICON, UKMO's where ICON has none; route icing red if either model is red. | Decided |
| D16 | **v1 = two models, ICON + UKMO, "red if either is red"**, with the count shown ("2 of 2 models", "1 of 2"). The engine takes any list of models and a 'majority' rule; a consensus of more models comes later, once the remaining RH conventions are confirmed (V3b). | Decided (v2.4) |
| D17 | **Icing-layer report:** per hour, each layer's lowest / highest red level, the clear levels around it, its temperatures, the height up to which there are no icing signs, whether it is dry or warmer above, and the minutes in it at the climb / descent rate. The planner names hours with the layer base at least 150 m above the flight altitude. The app shows layers and exposure; it does not recommend transits (§7.7). | Decided (v2.4) |

---

## 2. Scope, assumptions, non-goals

**Context.** FlySky is a static, browser-only PWA (no server). Weather comes from Open-Meteo's free API (limits: 600 calls/minute, 5,000/hour, 10,000/day per IP, shared by all features), satellite imagery from EUMETSAT EUMETView. All logic runs on the device.

**Objectives**
- Screen the atmosphere along altitude, position and time, not surface weather alone.
- Local flight-profile screening (forecast tab) and route screening (calculator).
- Show where the icing layers are, so a flight can stay out of them.
- Keep evidence, exposure and the operational verdict separate (D1).
- Show provenance in the details: model, forecast hour, levels used and their height, missing data, "coarse" levels.

**Non-goals (v1)**
- Ice mass, accretion rate, calibrated probability or severity.
- Certifying a route or hour as ice-free; recommending a transit through a layer.
- Replacing official aviation products or operator judgement.
- Sub-grid resolution, interpolation of humidity between levels, audit logs / machine-readable export, single exposure index.

**Simplifications**
- Heights: the flight altitude is metres above the takeoff point; with the takeoff elevation (the API response's `elevation`, Open-Meteo's 90 m terrain model) it is a height above sea level. Level heights come from their geopotential height.
- One cruise altitude per flight/route (no per-leg altitude profile); the route is flown at a constant height above sea level (§9).
- Turns, loiter patterns and alternate routes are not modelled; the calculator's round trip is outbound + return along the same line.

---

## 3. Shared processing architecture (FlySky)

```text
[ Settings: Flight profile ]  flight altitude (m above takeoff) · climb · descent · duration · (airspeed in calculator)
            │
            ├── Forecast tab ──► icing request: ICON + UKMO, 1 location, ≈ 4.8 calls   (icing.js requestParams)
            │
            └── Calculator ────► route request: ICON + UKMO, 3 levels around the flight height, ≈ 3 calls / point
                                 + column at A (reuse forecast data or 1 small request)
            │
            ▼
[ icing.js — engine (stage 1, implemented) ]
   ├── splitModels: response → columns per model
   ├── profileAt: levels → height above sea level / ground; mask < 20 m above ground; RH → RH over water (D11)
   ├── levelState (§7.4); surfaceCues: freezing fog (D9), freezing precipitation incl. warm nose (D12)
   ├── stateAt: fixed height → worse of the levels around it (D14); bands: climb / descent through the levels
   ├── flight: Mode A per departure hour (climb · cruise · descent · cues)
   ├── layers: icing layers, clear-to height, conditions above (D17)
   ├── combine: models → "red if either" (v1) or majority
   └── evaluate (Mode A, whole response) · pointState (Mode B, one route point)
            │
            ▼
[ UI ]  forecast: Icing row · layer line · strip · height-time chart · details · planner      calculator: coloured route · panel lines
```

`icing.js` is loaded on demand like `hazard.js`, versioned (`?v=`) in `index.html` and `sw.js` (from stage 3). It has no DOM, network or translation code: the UI formats its structured results in the app's languages.

---

## 4. Weather data — what Open-Meteo returns (verified)

Verified with live API calls on 2026-11-05 (Phase 0, §11) at Kyiv 50.45/30.52, Zaporizhzhia 47.86/35.81 and the Carpathian point 48.16/24.50, and with last winter's archived forecasts.

### 4.1 Deterministic models

Levels from 1000 to 700 hPa that return values (✓) in an 8-day request. Heights above ground: winter 2025/26 medians for 1000–925 hPa, November 2026 medians above that (Kyiv / Zaporizhzhia). **v1 uses ICON and UKMO** (D16); the others are listed for later options.

| Level | ≈ height above ground | ICON (`icon_seamless`) | UK Met Office (`ukmo_seamless`) | ECMWF IFS 0.25° | ECMWF AIFS | Météo-France | NOAA GFS | GEM | JMA |
|---|---|---|---|---|---|---|---|---|---|
| 1000 hPa | ≈ 0 m — **below ground 71 % / 45 % of winter hours** | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 985 hPa | — | — | — | — | — | — | — | ✓ | — |
| 975 hPa | 180 / 235 m | ✓ | ✓ | — | — | — | ✓ | — | — |
| 970 hPa | — | — | — | — | — | — | — | ✓ | — |
| 950 hPa | **380 / 440 m** | ✓ | ✓ | — | — | ✓ | ✓ | ✓ | — |
| 925 hPa | 590 / 650 m | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 900 hPa | 865 / 910 m | ✓ | ✓ | — | — | ✓ | ✓ | ✓ | — |
| 875 hPa | 1070 / 1130 m | — | — | — | — | — | ✓ | ✓ | — |
| 850 hPa | 1320 / 1360 m | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 800 hPa | 1800 / 1840 m | ✓ | ✓ | — | — | ✓ | ✓ | ✓ | — |
| 700 hPa | 2840 / 2870 m | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| **Forecast length** (8-day request) | | **~7 days** (ICON-EU ~5, then ICON global, same levels) | **~6.5 days** | ≥ 8 days | ≥ 8 days | ~4 days | ≥ 8 days | ≥ 8 days | ≥ 8 days |

750, 775 and 825 hPa (would fill the 800–700 hPa gap over high ground) are not checked yet (V11).

**Per pressure level:** `temperature`, `relative_humidity`, `geopotential_height`; `dew_point` is computed by Open-Meteo from T and RH (no independent information). Pressure-level `cloud_cover` is RH-derived (not used). `vertical_velocity` not used (D8).

**Height levels (no humidity):** `temperature_80m` / `_120m` — ICON, Météo-France, GFS, GEM; `temperature_180m` — ICON, Météo-France. Not used: the engine works with pressure levels and the surface.

**Surface:** `temperature_2m`, `relative_humidity_2m`, `weather_code`, `precipitation`, `surface_pressure` — all models. `visibility` — ICON (first ~5 days), UKMO, GFS. `freezing_level_height` — ICON and GFS only (not used).

**Below ground:** all models return values at levels below the ground (extrapolated). At the Carpathian point (elevation 2025 m) every level from 1000 to 850 hPa is below ground and still has values. Masking (D13) is mandatory.

**Level heights move with the weather.** A pressure level is not at a fixed height: in winter 950 hPa was between 120–190 m lower and 105–140 m higher than a fixed 400 m above the ground (5–95 %); 950 hPa was the level nearest to 400 m in 73–76 % of hours, 975 hPa in 5–19 %, 925 hPa in 7–22 %. Hence D4: the setting is a height, and the levels are placed by their geopotential height each hour.

### 4.2 How fields are derived (affects their value as evidence)

| Field | Finding | Consequence |
|---|---|---|
| ECMWF IFS HRES 9 km | No pressure-level fields; only the 0.25° open-data models have them. | — |
| Pressure-level `cloud_cover` | Estimated from pressure-level RH (Sundqvist et al. 1989). | Not used. |
| Relative humidity | Convention differs by model (§4.4). | Normalise (D11). |
| Dew point | Computed from T and RH. | Display only. |
| `weather_code` | In 2,160 winter hours at Kyiv: **ICON** fog 45: 99 h, rime fog 48: 7 h, freezing drizzle 56/57: 5 h, freezing rain 66/67: 25 h; **GFS** 45: 115 h, 56/57: 42 h; **UKMO** 45: 37 h; IFS, AIFS, Météo-France, GEM, JMA: none of 45/48/56/57/66/67, although they had 310–450 h of precipitation with 2 m temperature below 0 °C. | Codes are a cue only where emitted; profile-based freezing-precipitation cue (D12). In v1 the codes come from ICON. |
| Time step | All models return hourly values; ECMWF values between its 3-hourly steps are interpolated. | Hourly evaluation. |

### 4.3 Ensemble models

| Ensemble model (Ensemble API) | Pressure-level T / RH | Levels below ~1 km |
|---|---|---|
| ECMWF IFS 0.25° (`ecmwf_ifs025`, 51) | ✓ | 1000, 925 hPa |
| ECMWF AIFS (`ecmwf_aifs025`, 51) | ✓ | 1000, 925 hPa |
| NOAA GFS ensemble (`gfs_seamless`, 31) | ✓ | 1000, 925 hPa |
| Google WeatherNext 2 (`google_weathernext2_ensemble`, 64) | ✓ | 1000, 925 hPa |
| ECMWF IFS Europe (`ecmwf_ifs_europe_ensemble`) — FlySky default | — | — |
| DWD ICON-EU EPS, UKMO 20 km, GEM, BOM ACCESS | — | — |

Columns without data are billed like any other. D7 stands.

### 4.4 Relative-humidity conventions

Supercooled liquid needs saturation over **water**. Test: at 300 hPa in winter (median −52 °C), air saturated over ice has only ~60 % RH over water, so a water-convention model cannot go much above that, while an ice-convention model reaches 100 %.

| Model | 300 hPa RH, Dec–Feb, Kyiv (p99 / max) | Convention | In the engine (`MODELS` in `icing.js`) |
|---|---|---|---|
| ICON | 64 / 66 % | over water | as reported (`rhConfirmed`) |
| UKMO | 74 / 92 % | over water (mostly) | as reported; to confirm (V3b) |
| GEM | 62 / 68 % | over water | as reported (`rhConfirmed`) |
| ECMWF IFS 0.25° | 100 / 100 % | documented: water above 0 °C, ice below −23 °C, quadratic blend between (ECMWF parameter 157) | converted to over water (`rhConfirmed`) |
| ECMWF AIFS | 100 / 100 % | ice at low temperatures; not documented | converted as IFS; to confirm |
| Météo-France, GFS, JMA | 100 / 100 % | ice at low temperatures | as reported (conservative: more red); to confirm |

e_w(T) = 6.112·exp(17.62·T / (243.12 + T)), e_i(T) = 6.112·exp(22.46·T / (272.62 + T)) (hPa, °C); for −23 °C < T < 0 °C, e_mix = α·e_w + (1 − α)·e_i with α = ((T + 23) / 23)². RH_w = RH × e_mix / e_w (ECMWF) or RH × e_i / e_w (ice).

Effect (Kyiv, winter, 950 hPa red): ECMWF IFS 59 % → 41 % of hours with the documented rule, then close to ICON's 43 %. Without normalisation, model agreement partly measures conventions — one reason v1 uses two water-convention models (D16).

---

## 5. Flight profile and the altitude setting

### 5.1 Flight altitude in metres above takeoff (D4)

The existing wind height setting (shared by wind arrows and calculator) becomes **Flight altitude** in a new **Flight profile** settings section (side menu, both views); the calculator keeps a selector for it.

- **Unit and datum:** metres **above the takeoff point** — the number a pilot sets in the ground control station (most small-UAV autopilots hold barometric altitude relative to home).
- **Options:** 10 m, 120 m, 200 m, 300 m, **400 m (default)**, 500 m, 600 m, 800 m, 1000 m, 1500 m.
- **Height above sea level** = takeoff elevation + flight altitude (forecast tab: the forecast location; calculator: point A). Shown with it: "400 m above takeoff · 569 m above sea level".
- **Evaluation (D14):** each hour, the levels are placed by their geopotential height; the flight height takes the worse state of the levels just below and above. Humidity is never interpolated. Wind (stage 2) is interpolated linearly between the two levels (u and v components).
- **10 m:** surface cues only (and the 10 m wind). **120 m:** wind from the 120 m height level; icing from the lowest usable pressure level (usually 975 hPa, ~180 m; "coarse" when it is the only one) and the surface cues.
- **Wind arrows** on the map: the same number as metres above the ground at each arrow (over flat terrain the same as above takeoff). Requested: the three pressure levels whose standard-atmosphere height is nearest to the height over typical ground (150 m above sea level) — wind speed, direction and geopotential height, 9 variables, still 1 call per point; e.g. 975 / 950 / 925 hPa for 400 m, 950 / 925 / 900 hPa for 600 m, 900 / 850 / 800 hPa for 1500 m. At each arrow u and v are interpolated in height between the levels below and above it; one level alone stands for the height within 250 m; levels less than 20 m above the ground are left out. Where no level is left near the height (high ground) the arrow is left out and the info line says how many (D13; implemented in stage 2).
- **Calculator:** a constant height above sea level from A (A's ground — the elevation of A's grid cell in the response — + the flight altitude; shown under the route: "400 m above A ≈ 579 m above sea level along the route"); wind from the same three levels, interpolated at that height at each route point. Where the ground rises to within 20 m of it the result is "Below the ground", saying how far along and how high (stage 2). Per-point heights above the ground and a 50 m warning come with the icing in stage 4 (§9).
- **Migration** of the stored wind height (map settings `wind.level`, or the calculator's older `route.level`): `10m` → 10 m, `120m` → 120 m, `500m` (950 hPa) → 400 m, `800m` and the older `925` (925 hPa) → 600 m, `1500m` (850 hPa) → 1500 m; saved at once as `flysky_flight_profile`, and the map keeps no height of its own. New users start at 400 m (wind arrows then show ~400 m instead of 120 m).
- **Where it is set:** forecast view's side menu, section *Flight profile* (with "≈ 579 m above sea level at Kyiv (ground 179 m)" when the location's elevation is known); the map side menu's wind block ("Above the ground"); the calculator ("Flight altitude above A"). One value (`state.flightProfile.heightM`, `setFlightHeight()`).
- **Labels** (stage 2): the map's "~500 m", "~800 m", "~1500 m" are replaced by the setting; the forecast's wind-aloft labels are corrected to heights above the ground: "Wind ~400 m" (Models), "Wind up to ~600 m" (Ensemble), members "≤ 100 m · 1000 hPa" / "~600 m · 925 hPa".
- The forecast tab's **wind-aloft factor** (1000+925 hPa pooled in Ensemble mode, 950 hPa in Models mode) is **not changed** in this work (O1).

### 5.2 Profile parameters and defaults

| Setting | Default | Range | Used by |
|---|---|---|---|
| Flight altitude | 400 m above takeoff | §5.1 options | wind arrows, calculator wind + icing, forecast icing |
| Climb rate | 2 m/s | 0.5–10 m/s | climb exposure (Mode A and B) |
| Descent rate | 2 m/s | 0.5–10 m/s | descent exposure |
| Flight duration | 2 h | 15 min – 6 h | Mode A cruise time |
| Airspeed | 22 m/s (existing calculator setting, 18–30) | — | Mode B timing |
| Include icing in the flight verdict | off | on/off | D1 |
| Icing thresholds (advanced, "experimental") | §7.4 | — | engine |

Example: climb to 400 m at 2 m/s ≈ 3.3 min; at 5 m/s ≈ 1.3 min.

Stage 2 shows only the flight altitude; climb, descent, duration, the verdict option and the thresholds join the *Flight profile* section in stage 3, when the icing indicator uses them.

### 5.3 Vertical handling (implemented in `icing.js`)

- Height of a level above sea level = `geopotential_height_XhPa`; above the ground = that − `elevation`.
- Levels less than **20 m** above the ground are inside the terrain (Open-Meteo extrapolates values there) and are ignored.
- **At a fixed height (D14):** the nearest usable levels below and above, each within **500 m**; the worse of their states (exactly on a level: that level). **Coarse** when only one side exists or a level used is more than **300 m** away. Nothing within 500 m → unknown, reason "no level near".
- **Climb / descent bands:** the ascent from the ground to the flight height is split at every usable level; each band takes the worse of the levels around it (the band from the ground to the lowest level takes that level). Minutes per band = thickness / climb or descent rate.
- **2 m values** feed only the surface cues (freezing fog, freezing precipitation), never the level rule.

### 5.4 High ground

A fixed pressure level can be below ground: at the Carpathian test point (elevation 2025 m) every level up to 850 hPa is. With heights in metres above takeoff the engine uses whatever levels are above the terrain; between 800 and 700 hPa there is a ~1 km gap, so a 400 m flight from 2025 m (2425 m above sea level) usually has no level within 500 m and is **unknown — no level near**; "no icing signs up to …" also stops at such a gap. 750 / 775 / 825 hPa would close it (V11, O7).

---

## 6. API requests and call budget

### 6.1 How Open-Meteo counts calls (verified)

Per location:

```
weight = max(1, variables × models / 10)                 for up to 14 days
weight = max(1, variables × models / 10 × days / 14)     beyond 14 days
total  = weight × number of locations
```

Ensemble models count every member. Verified with the `X-RateLimit-Cost` response header: no rounding; multi-location requests add up per location; columns without data are billed. The header is readable in the browser (`Access-Control-Expose-Headers` lists `x-ratelimit-cost`, `-limit`, `-remaining`, `-reset`, `-window`, `retry-after`) — FlySky could track its real usage (O8). `icing.js` `requestCost()` implements the formula.

### 6.2 FlySky requests with icing

| Request | Today | With icing | Calls |
|---|---|---|---|
| Ensemble forecast (ensemble API) | ≈ 120 calls/update (4 default ensembles) | unchanged (no icing here, D7) | 0 extra |
| Models-mode forecast | 3 calls/update | unchanged | 0 extra |
| **Icing request** (forecast API, ICON + UKMO, 1 location; `requestParams()`) | — | T, RH, height at 1000/975/950/925/900/850 hPa (18) + T 700 hPa + 2 m T, 2 m RH, weather code, visibility, precipitation (5) = 24 variables × 2 models; more levels for flights above ~1 km or high ground (up to 800 / 700 hPa) | **4.8** (up to ≈ 5.8) per update, cached like the forecast (1 h) |
| **Route request** (forecast API, ≤ 16 points) | stage 2: `best_match`, three levels × (wind speed, direction, height) = 9 variables → 1 per point: 16 calls for 16 points (as before) | stage 4: ICON + UKMO, three levels around the flight height × (wind speed, direction, T, RH, height) = 30 variables → **3 per point** (≤ 48 for a new 16-point route; points cached 30 min) | +2 per point |
| Column at A (and B for one-way) | — | reuse forecast icing data if A is in the forecast location's 0.1° cell and the hours are covered; else one icing request (4.8) | only when needed |
| Wind-arrow grid | `best_match`, up to 220 points per view: up to ≈ 220 calls per refresh | three levels × (speed, direction, height) = 9 variables → still 1 per point (stage 2, implemented) | 0 extra |
| Map readout (crosshair) | 6 vars × models | unchanged (no icing in v1) | 0 |

---

## 7. Meteorological evidence

### 7.1 Dew point

Magnus: γ = ln(RH/100) + 17.625·T / (243.04 + T), T_d = 243.04·γ / (17.625 − γ). Display only (`dewPoint()`); Open-Meteo's dew point is computed from RH.

### 7.2 Evidence states (per model, per level or band, per hour)

| State (`icing.js`) | Meaning | UI colour |
|---|---|---|
| `red` — potential icing environment | sub-freezing air near saturation over water (cloud environment likely); supercooled liquid not known | red |
| `red` — freezing fog / low stratus (cue) | sub-zero fog at the ground (D9) | red |
| `red` — freezing precipitation (cue) | warm nose with precipitation, or code 56/57/66/67 (D12) | red |
| `marginal` | near a threshold (§7.4) | yellow |
| `none` — no icing indication from available proxies | **not** "no icing" / "safe" | green, text "No icing signs in the forecast data" |
| `unknown` | data missing, levels inside the terrain or none near the flight height, model beyond its forecast length | grey |

**Two models (v1, D16):** an hour is red if either model is red, otherwise the worse of the two. The count is shown instead of a confidence level: "2 of 2 models", "1 of 2 models" (red from one model), "1 of 1" after UKMO's forecast ends (~6.5 days), unknown after ICON's (~7 days). Models without data are left out and counted as such. The engine's 'majority' rule (red at ≥ 60 % of models) is for a later consensus of more models.

### 7.3 Cues

- **Pressure-level evidence:** temperature and RH over water (D11) at each usable level (§5.3).
- **Freezing fog / low stratus (D9):** code 48 (ICON); or 2 m temperature ≤ 0 °C with visibility < 1000 m or 2 m RH ≥ 97 %. Red for the climb and descent (and a 10 m flight); deep fog / low stratus also shows in the levels.
- **Freezing precipitation (D12):** precipitation ≥ 0.1 mm/h with 2 m temperature ≤ 0 °C and a level above 0 °C up to 700 hPa (warm nose); or code 56/57/66/67. Red in every phase of a flight, including the cruise (the aircraft is under the warm layer); source shown ("profile", "ICON code").
- **Not used:** pressure-level cloud cover, vertical velocity (D8), freezing-level height.

### 7.4 Experimental thresholds (configurable, unvalidated)

RH is RH over water.

| State | Default rule (`DEFAULT_THRESHOLDS`) |
|---|---|
| Potential icing environment | −20 °C ≤ T ≤ 0 °C and RH ≥ 90 % |
| Marginal | −20 °C ≤ T ≤ +1 °C and 80 % ≤ RH < 90 %; or 0 °C < T ≤ +1 °C and RH ≥ 90 %; or −30 °C ≤ T < −20 °C and RH ≥ 90 % |
| No indication | otherwise, with T and RH available |

Labelled "experimental". Air saturated over ice has RH over water of ≈ 91 % at −10 °C and ≈ 82 % at −20 °C: an ice-saturated cloud at −10 °C is red, at −20 °C marginal — conservative by design. Tuning (O6) can use the winter harness in `docs/icing-phase0/`.

### 7.5 How often it is red in winter

Last winter (Dec 2025 – Feb 2026, 2,160 hours) at Kyiv / Zaporizhzhia:

| Measure | Kyiv | Zaporizhzhia |
|---|---|---|
| **v1 engine** (`engine_check.mjs`): ICON + UKMO, 400 m above takeoff, one instant — red if either | 67 % | 52 % |
| … of which "1 of 2 models" | 25 % | 17 % |
| … 2-hour flights: departure hours red, ICON / UKMO | 56 / 69 % | 47 / 54 % |
| … red only in climb or descent, ICON / UKMO (2-hour flights) | 5 / 18 % | 6 / 6 % |
| v2.2 rules, 950 hPa, 5 default models: ≥ 60 % of them red | 52–59 % | 44–48 % |

- Ukrainian winters have extensive sub-zero low cloud; **red is common** whatever the tuning. The UI must stay useful when red: the layer line (§7.7), and the next hours with the layer above the flight altitude or without icing signs.
- The engine's numbers are 3–5 points above the Python analysis at 950 hPa (ICON 49 vs 45 %, UKMO 60 vs 55 %, either 67 vs 62 % at Kyiv): at a fixed 400 m it takes the worse of the two levels around the aircraft — expected, and a cross-check of the engine against Phase 0.
- The archive holds early forecast hours: this measures how often the models put such conditions there, not forecast skill.

### 7.6 Consensus or one or two models?

Deterministic models only (D7). Winter data, 950 hPa, one instant of Mode A, IFS and AIFS normalised (D11). "Consensus red" = at least 3 of the 5 default Models-mode models red. Kyiv / Zaporizhzhia:

5-model consensus: red 45 / 40 % of hours, **split (1–2 of 5 red) 27 / 25 %**, none red 28 / 36 %.

| Choice | Red hours | Same as the consensus | Misses consensus-red hours |
|---|---|---|---|
| ICON alone | 44 / 38 % | 88 / 91 % | 15 / 14 % |
| ECMWF IFS alone | 41 / 39 % | 85 / 88 % | 21 / 17 % |
| ECMWF AIFS alone | 32 / 31 % | 82 / 82 % | 35 / 34 % |
| Météo-France alone | 53 / 52 % | 83 / 83 % | 9 / 6 % |
| UKMO alone | 55 / 44 % | 81 / 89 % | 10 / 9 % |
| GFS alone (not one of the 5) | 49 / 33 % | 70 / 78 % | 29 / 36 % |
| **ICON + UKMO, red if either (v1)** | **62 / 50 %** | **80 / 89 %** | **3 / 2 %** |
| ICON + UKMO, red if both | 37 / 33 % | 88 / 91 % | 21 / 21 % |
| ICON + IFS, red if either | 56 / 49 % | 89 / 91 % | 0.3 / 0.6 % |
| ICON + IFS, red if both | 29 / 28 % | 84 / 88 % | 35 / 30 % |

Any two models agree on red vs not red in only 60–88 % of winter hours (typically ~75 %).

Why ICON + UKMO for v1 (D16):
- One model turns the split hours (a quarter of winter) into a confident-looking red or green and misses 6–35 % of the hours a majority flags; ICON + UKMO "either" misses 2–3 %.
- Same data types: both have 975 / 950 / 900 hPa, report RH over water and give visibility — no RH conversion and no "coarse" levels in the 0–1 km range where the UAV flies. ECMWF IFS (excellent in general) has no level between the ground and ~600 m on Open-Meteo, no visibility and no codes; ICON + IFS would bring back conversion and coarse levels.
- Independent model families (DWD, Met Office); 4.8 calls per update.
- Costs: red more often than one model (+5 to +12 points); only a "2 of 2 / 1 of 2" signal instead of a graded confidence; unknown after ICON's ~7 days (the last day of the 1-week window).
- Agreement with the consensus is not skill: which models are best for supercooled low cloud over Ukraine needs observations (O9). A consensus of more models, or ECMWF IFS as a long-range filler after day 7, can be added later (O10, O11).

### 7.7 Icing layers: where the danger is (D17)

The engine reports, per hour and model (`layers()`), each run of red levels — its lowest and highest red level, the clear levels around it (the layer's real edges lie in between), its temperatures, and whether the air above is drier than 80 % or warmer than 0 °C — plus the height up to which there are no icing signs ("clear to"), and, for a flight, the minutes in each band at the climb / descent rate.

Last winter (ICON and UKMO, Kyiv and Zaporizhzhia; `layers.py`):

| | Share of the hours with an icing layer (975–850 hPa or freezing fog: 51–72 % of all hours) |
|---|---|
| Layer from the ground (freezing fog or 975 hPa red) — no "below" option | 47–60 % |
| Layer base right around 400 m (950 hPa) — the default flight altitude | 15–26 % |
| Clear up to ~400 m (base at 925 hPa, ~600 m, or higher) — flying below is an option | 25–32 % |
| Top below ~1.3 km with no icing signs above (always dry or warmer there: an inversion) | 25–32 % |
| Layer reaching 850 hPa (~1.3 km) or higher | 36–49 % |
| Two separate layers | 5–7 % |
| Temperature at red levels: 0…−5 °C / −5…−10 °C / −10…−15 °C / below | 55–58 / 27–31 / 10–15 / 0–2 % |

What the app shows (stage 3), e.g. "Icing layer ~380–590 m (−3 to −6 °C) · no icing signs below ~180 m · dry above ~870 m · climb through ≈ 2 min at 2 m/s, ≈ 1 min at 5 m/s". The planner names hours with the layer base at least 150 m above the flight altitude ("below the layer").

Rules of thumb shown in the details (meteorology, not data from the engine):
- **Avoid rather than pass through.** Ice picked up on the climb stays on: in sub-zero air above or below the layer it does not melt or shed quickly, so it is carried for the whole flight, and the descent adds more. Every flight crosses a layer twice.
- **Small UAVs ice quickly.** Thin leading edges and propellers collect supercooled droplets more efficiently than larger aircraft; a minute or two in a layer can degrade performance.
- **In layer cloud the liquid water usually increases from base to top** — the zone just below the top is typically the worst. Above the top there is often an inversion with dry, warmer air.
- **Freezing rain / drizzle is a no-go:** the danger runs from the ground up to the warm layer, with large drops.
- **Margins:** layer edges are known only to about ±100–150 m (levels 200–450 m apart), and models often misplace the timing and height of winter low cloud — keep at least 150 m from a reported base; the satellite fog / cloud-phase images are the check for the current hour (O5).

---

## 8. Mode A — Forecast tab (local flight profile)

### 8.1 Exposure for departure hour h (`flight()`)

1. **Climb** at hour h: ground → flight altitude through the bands of §5.3; minutes per band at the climb rate; freezing fog at the ground makes it red.
2. **Cruise** from h for the flight duration at a fixed height above sea level: one slot per hour (h, h+1, …; the last one partial), each the state at that height (D14); freezing precipitation in that hour makes a slot red.
3. **Descent** at the hour the flight ends (h + duration, rounded): flight altitude → ground; fog at the ground makes it red.
4. Per model: the flight's state is the worst of all phases (D2: "climb only" when the cruise is known and not red). Hours beyond a model's data are unknown; a flight running past the data is "partly unknown".
5. Models combined per §7.2; layers per §7.7 for the departure hour.

### 8.2 UI (stage 3)

- **"Can I fly now?" card:** a separate Icing row under the factor tiles (not a verdict tile unless D1's option is on), e.g. "❄ Icing: potential icing at 400 m (−3 °C, RH 96 %) · 2 of 2 models", "❄ Icing: climb only — ~2 min through 180–380 m", and the layer line (§7.7). Follows the hour slider.
- **Flight conditions:** an Icing strip under the confidence strip, hours coloured by state; pinned-hour details list phases, bands, levels with their heights, values and models, "coarse" and RH-convention notes.
- **Chart "Icing profile":** height above the ground (ground → top of the data) by time; cells coloured by state per level, 0 °C line, flight-altitude line, climb / descent marked; tooltip with T, RH and models per level.
- **Planner:** icing windows as warnings; "below the layer" hours named; excluded from "suitable" only when D1's option is on.
- **Option on (D1):** icing becomes a verdict factor (tile, breakdown bar, reasons, planner, confidence). Models mode: each Models-mode model takes the icing factor as the icing models see it, like a factor it lacks today. Ensemble mode: each member takes it the same way; the icing models never enter the confidence as extra models.

---

## 9. Mode B — Flight time calculator (route) (stage 4)

### 9.1 Profile

- Climb at A at the departure time (calculator's departure: now or +1–6 h).
- Outbound cruise A → (waypoints) → B at a **constant height above sea level** (A's elevation + flight altitude); each point evaluated at its arrival time (existing wind-triangle timing) with `pointState()`.
- Return cruise B → A, then descent at A at the return ETA.
- If the return can't be computed (no wind data, no headway, flight height below ground somewhere), the result says it covers the outbound leg only; descent is then evaluated at B as a one-way case.

### 9.2 Data

- Route request: `models=icon_seamless,ukmo_seamless`; for each of the three standard levels nearest the flight height above sea level (e.g. 975 / 950 / 925 hPa for 569 m): wind speed, direction, T, RH, height — 30 variables → ≈ 3 calls per point.
- Wind for the wind triangle: interpolated between the levels around the flight height (u, v) — in stage 2 from `best_match` (ICON-based), from stage 4 from ICON, UKMO's where ICON has none.
- Icing per point: red if either model is red; "1 of 2 models" shown when only one is.
- Each point's height above the ground is shown; within 50 m of the ground flagged; below the ground: unknown ("below ground").
- Climb/descent column at A (and B for one-way): forecast-tab data when A is in the forecast location's cell and the hours are covered; otherwise one icing request (4.8 calls).
- The multi-model, multi-location response is an array with one object per location; columns are suffixed by model; `splitModels()` splits them.

### 9.3 UI

- Route line segments coloured by state (outbound); the tag gets a ❄ mark when icing is indicated.
- Panel line, e.g. "❄ Potential icing 15–32 km (≈ 25 min) at 400 m above takeoff (≈ 380–450 m above the ground), −4 °C, RH 95 % · ICON and UKMO · climb at A through 180–380 m (~2 min)"; return leg summarised separately ("Back: no icing signs" / "Back: potential icing 8–20 km, UKMO only").
- Wind-triangle infeasibility stays as implemented (where/when/wind message).

---

## 10. Settings summary

New side-menu section **Flight profile** (both views): flight altitude (m above takeoff, §5.1), climb rate, descent rate, flight duration; **Icing**: include in the flight verdict (off), thresholds (advanced, experimental, RH over water). The calculator's height selector edits the same flight altitude. Airspeed stays in the calculator. Icing models (ICON + UKMO), RH conversion and the "either" rule are not settings in v1.

---

## 11. Phase 0 — API verification (2026-11-05)

Run against `api.open-meteo.com` (live, 8-day request), `ensemble-api.open-meteo.com` and `historical-forecast-api.open-meteo.com` (Dec 2025 – Feb 2026), at Kyiv 50.45/30.52, Zaporizhzhia 47.86/35.81 and the Carpathian point 48.16/24.50. ≈ 630 calls. Scripts, instructions and output: [`docs/icing-phase0/`](icing-phase0/).

| ID | Check | Result | Status |
|---|---|---|---|
| V1 | Levels and variables per model, forecast length | §4.1 | done |
| V2 | `best_match` for the route; multi-location / 2-model format | `best_match` returns T, RH, height at 1000–850 hPa for all 8 days, ICON-based (mean absolute temperature difference to ICON 0.1 °C). Array of per-location objects; model-suffixed columns. | done; v1 route uses named models (D15) |
| V3 | RH convention below 0 °C | §4.4; dew point derived from RH | done |
| V3b | Exact RH rule between 0 and −20 °C for UKMO, AIFS, Météo-France, GFS, JMA | provider documentation | **open** (UKMO matters for v1) |
| V4 | Weather codes 48/56/57/66/67 | §4.2 | done; observations open (O9) |
| V5 | Heights; levels below ground | §4.1; values returned below ground; masking works | done |
| V6 | Hourly behaviour of ECMWF fields | hourly, interpolated between 3-hourly steps | done |
| V7 | Ensemble pressure-level T/RH | §4.3 | done |
| V8 | `vertical_velocity` | not run (D8) | — |
| V9 | Call weight | §6.1 verified with `X-RateLimit-Cost` | done |
| V10 | `icon_seamless` component | ICON-EU (0.0625°) then ICON global, same levels | done |
| V11 | 750 / 775 / 825 hPa for ICON and UKMO (high ground) | not run: daily limit used up | **open** |
| — | Level drift and icing layers in winter | §4.1, §7.7 (`layers.py`) | done |
| — | Engine on the Phase 0 data | §7.5 (`engine_check.mjs`, `engine_check.txt`) | done |

Notes for re-running: Open-Meteo's daily limit is per IP and shared by the forecast, historical-forecast, previous-runs and single-runs hosts (the ensemble host counts separately); from a shared cloud IP run just after 00:00 UTC. The historical-forecast host fails mid-stream (`timeoutReached`, still billed) for 8 models × 27 variables in one request; one model per request works.

---

## 12. Validation and tests

**Engine unit tests (stage 1, implemented):** `tests/icing-engine.mjs`, Node only (`node run.mjs icing-engine`), 72 checks with synthetic Open-Meteo responses:
- request: models, levels for 400 m / 1500 m / high ground, T at 700 hPa, timezone, call cost (Phase 0 values);
- response split per model (two models, one model);
- level rules (red, marginal margins, none, unknown), RH conversion (ECMWF blend, ice), dew point;
- cold and dry; layer at the flight altitude (cruise red, climb minutes, layer report); layer only below (climb only, descent); layer above only; two layers, dry/warm above;
- freezing fog (code 48, visibility, 2 m humidity without visibility; 2 m at 92 % is not red; above 0 °C no cue); freezing rain code (red in the cruise); warm nose; warm layer without precipitation; rain above 0 °C;
- level below ground masked; model without 975/950 hPa (925 hPa, coarse, never 2 m); same reported RH, ECMWF marginal vs ICON red; high ground (no level near; no "clear" over a 1 km gap); route point below ground; route point in a layer;
- two models disagreeing (red if either; majority rule); model beyond its forecast length; no data at all;
- time: layer during the descent only, 60 min of cruise in it, after it; flight running past the data; 30 min flight; 10 m flight with / without fog; thresholds override;
- browser global `window.FlySkyIcing`.

**Cross-check on real data:** `docs/icing-phase0/engine_check.mjs` — the engine on last winter's ICON / UKMO hours reproduces the Python analysis within the expected 3–5 points (§7.5) and prints its output for the saved 8-day forecasts (`engine_check.txt`: e.g. a sub-zero layer at ~200–650 m over Kyiv on 9–11 November 2026, both models; unknown at the Carpathian point — no level near 2425 m).

**Browser tests, stage 2 (implemented; `tests/map-route.mjs`, `map-layers.mjs`, `map-settings.mjs`; the mock answers any wind height with per-level wind, standard level heights and a configurable ground elevation):** new users at 400 m; migration of '925', '~500 m' and the calculator's '~1500 m', saved, no height left in the map settings; forecast side menu shows the setting with its height above sea level, and a change there reaches the map; request variables for 10 m / 400 m / 600 m / 1500 m; interpolation (halfway between two levels, 400 m above a 179 m ground), one level within 250 m, inside the terrain; arrows left out over high ground with the note; calculator and side menu set the same height; the calculator's "400 m above A ≈ 579 m above sea level" line; "Below the ground" where the route reaches higher ground; the selector fits the card.

**Browser tests (Playwright, mocked Open-Meteo), stages 3–4:**
- settings: climb, descent, duration, verdict option, thresholds (defaults 2/2 m/s, 2 h);
- forecast tab: icing request (ICON + UKMO, call count in the mock log), Icing row, "2 of 2 / 1 of 2", climb-only note, layer line, strip, chart, planner "below the layer", verdict option off/on (Models and Ensemble mode), model count falling through the week;
- calculator: route request with three levels × two models, icing on part of the outbound leg, return different, outbound only, A outside the forecast cell (extra request), point below ground / near the ground.

**Live sanity:** spot checks on cold, cloudy days; compare model states with EUMETSAT imagery; re-run `docs/icing-phase0/` after model changes at Open-Meteo.

**Meteorological validation** (thresholds, false alarms/misses, which models are best — O9) needs independent observations (regional aviation products, station reports, operator reports, satellite cloud phase) and is outside v1.

---

## 13. Implementation plan

| Stage | Work | Files | Status |
|---|---|---|---|
| 0 | Phase 0 API verification (§11) | `docs/icing-phase0/` | done |
| 1 | **Engine:** request builder and cost, response split, profiles (heights, masking, RH conversion), evidence, surface cues, fixed-height evaluation, climb/descent bands, Mode A flights, icing layers, model combination, route points; unit tests; cross-check on Phase 0 data. Not loaded by the app yet. | `icing.js`, `tests/icing-engine.mjs`, `docs/icing-phase0/engine_check.mjs` | **done** |
| 2 | **Settings and wind:** flight altitude in m above takeoff, shared by the forecast side menu (*Flight profile*), the map's wind block and the calculator; migration of the stored wind height; wind arrows and calculator wind at a fixed height (three levels, interpolated, masked below ground — D13; arrows left out with a note, "Below the ground" in the calculator); ASL shown; corrected wind-aloft labels; READMEs | `index.html`, `map.js`, `sw.js`, tests | **done** |
| 3 | **Forecast tab:** *Flight profile* gets climb, descent, duration, the verdict option and the thresholds; load `icing.js` on demand (`?v=`, `sw.js`); icing request (ICON + UKMO) + cache with the forecast; Icing row, layer line, strip, details, height-time chart, planner ("below the layer"), verdict option (incl. Ensemble mode) | `index.html` | next |
| 4 | **Calculator:** route request (three levels × ICON + UKMO), constant height above sea level, per-point height above the ground, coloured segments, panel lines, return leg, column at A/B | `map.js` | |
| 5 | **Options:** consensus of more models (after V3b, O11), ECMWF IFS after ICON's forecast ends (O10), icing marks on the wind grid (O4), satellite cross-check (O5), terrain-relative levels (O7), real call costs (O8) | — | |

READMEs (en/uk/pt-BR) updated with each user-facing stage; `?v=` and service-worker cache bumped for changed scripts.

---

## 14. Open items

- **O1** Wind-aloft factor in the forecast tab to follow the flight altitude (currently fixed levels).
- ~~**O2** Free altitude~~ → D4 (heights in metres; humidity still not interpolated).
- ~~**O3** Two models in the route request~~ → D15.
- **O4** Icing marks on the wind-arrow grid at the flight height (T, RH at three levels: 15 variables → 1.5 calls per point).
- **O5** Satellite supercooled-cloud cross-check for the current hour (Cloud Type / Cloud Phase RGB).
- **O6** Threshold tuning with operator feedback; the winter harness in `docs/icing-phase0/` gives the red-hour rates for any rule change.
- **O7** High ground: 750 / 775 / 825 hPa (V11) to close the 800–700 hPa gap.
- **O8** Use `X-RateLimit-Cost` / `-Remaining` for FlySky's request budget instead of estimates.
- **O9** Verify the models' icing states against observations (which models are best; how much they diverge at days 3–7 — the previous-runs API can give lead-time series).
- **O10** ECMWF IFS as a long-range filler after ICON's ~7 days (coarse; RH converted).
- **O11** Consensus of more models (Models-mode selection, 'majority' rule) once V3b is done.

---

## 15. Changes

### From v2.4 to v2.5
1. Stage 2 implemented: the shared flight altitude (forecast *Flight profile*, map wind block, calculator) with migration; wind arrows and calculator wind at a fixed height from three pressure levels (chosen around the height over 150 m ground, interpolated, one level within 250 m, levels inside the terrain left out); arrows left out over high ground with a note; "Below the ground" in the calculator; height above sea level shown; wind-aloft labels corrected.
2. §5.1 / §5.2 / §6.2 / §9.2 / §12 / §13 updated with what was built; the other *Flight profile* settings move to stage 3.

### From v2.3 to v2.4
1. Flight altitude in metres above takeoff instead of a pressure level; levels placed by their geopotential height each hour; ASL / AGL shown; constant height above sea level on the route; migration of the stored wind height (D3, D4, §5).
2. v1 with two models, ICON + UKMO, red if either; count shown instead of a confidence level (D5, D16, §7.2, §7.6).
3. Icing-layer report and the "avoid rather than pass through" framing (D17, §7.7); winter layer statistics.
4. Route request: three levels × two models, ≈ 3 calls per point (D6, §6, §9).
5. D11–D15 decided; D14 made precise (500 m / 300 m); freezing precipitation red in the cruise (D12).
6. Stage 1 implemented: `icing.js`, 72 unit tests, cross-check on the Phase 0 data (§12, §13); V11 and O7, O10, O11 added; O2 and O3 closed.

### From v2.2 to v2.3
1. §4 rebuilt from live responses: per-model level table, forecast lengths, visibility, freezing level, height levels, values below ground, measured heights above ground.
2. §4.3 corrected: ensemble pressure-level T/RH also in the GFS ensemble and WeatherNext 2, not in FlySky's default ECMWF IFS Europe ensemble; all at 1000/925 hPa only.
3. §4.4: RH conventions differ by model; normalisation to RH over water (D11). Dew point found to be derived from RH.
4. §4.2: weather codes measured; profile-based freezing-precipitation cue (D12).
5. Below-ground masking (D13); bracketing without the 2 m layer (D14); height labels corrected.
6. Costs verified with `X-RateLimit-Cost`; wind-arrow grid added to the budget.
7. Winter screening test (§7.5); consensus vs one or two models (§7.6); route models ICON + UKMO (D15).
8. Agreement shows the model count; D1 rule for Ensemble mode; Phase 0 results (§11).

---

## 16. References

- Open-Meteo documentation source: github.com/open-meteo/open-meteo-website (`src/routes/en/docs/*`, `src/routes/en/pricing`).
- Open-Meteo API: https://api.open-meteo.com/v1/forecast, https://ensemble-api.open-meteo.com/v1/ensemble, https://historical-forecast-api.open-meteo.com/v1/forecast
- Phase 0 scripts and output: `docs/icing-phase0/`; engine: `icing.js`; tests: `tests/icing-engine.mjs` (this repository).
- ECMWF Parameter Database, relative humidity (parameter 157): saturation over water above 0 °C, over ice below −23 °C, quadratic interpolation between.
- WMO Guide to Instruments and Methods of Observation (WMO-No. 8), Annex 4.B: saturation vapour pressure over water and ice (Magnus form).
- Hann, R., Johansen, T. A. (2020): Unsettled Topics in Unmanned Aerial Vehicle Icing. SAE EDGE Research Report EPR2020008 (UAV icing: small airframes and propellers, operational aspects).
- Sundqvist, H., Berge, E., Kristjánsson, J.E. (1989): Condensation and cloud parameterization studies with a mesoscale NWP model (pressure-level cloud cover derivation used by Open-Meteo).
- WMO 4677 present-weather code table (subset emitted by Open-Meteo: 0–3, 45, 48, 51–57, 61–67, 71–77, 80–82, 85–86, 95, 96, 97, 99).
- FAA Aviation Weather Handbook / AWC icing guidance (US reference only).

*END OF TECHNICAL HANDOFF DOCUMENT v2.5 — FLYSKY INTEGRATION*
