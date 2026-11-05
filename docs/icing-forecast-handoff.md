# FIXED-WING UAV ATMOSPHERIC ICING FORECASTING
## Technical Handoff & Architecture Specification — v2.3 (FlySky integration, Phase 0 results)

| Document status | Purpose | Intended use |
|---|---|---|
| **Integration design; Phase 0 API verification done (2026-11-05); D11–D15 proposed, awaiting decision** | v2.2 plus the results of the Phase 0 checks against the live Open-Meteo APIs and last winter's archived forecasts, the corrections they require, and the comparison of a multi-model consensus with one or two models. | Implementation in FlySky (`index.html`, `map.js`, new `icing.js`), test planning. Phase 0 scripts and output: [`docs/icing-phase0/`](icing-phase0/). |

> **Safety notice**
> Proxy indicators and exposure estimates are not validated icing forecasts. They do not estimate ice accretion or a probability of icing, and **must not be used to authorize flight into icing conditions**. A small fixed-wing UAV should be kept out of forecast or observed icing unless the complete aircraft is designed, tested and approved for it. In FlySky the icing indicator is a separate, clearly labelled, **experimental** screening aid; by default it does not change the flight verdict.

---

## 0. What v2.3 changes

Phase 0 ran on 2026-11-05 against `api.open-meteo.com`, `ensemble-api.open-meteo.com` and `historical-forecast-api.open-meteo.com` (Kyiv, Zaporizhzhia and a Carpathian point; last winter, Dec 2025 – Feb 2026, at Kyiv and Zaporizhzhia). Full output: [`icing-phase0/results.txt`](icing-phase0/results.txt). Details in §15.

1. **Data availability corrected (§4):** JMA has only 1000/925/850/700 hPa; 950 hPa is native in 3 of the 5 default models (not ECMWF IFS / AIFS); Météo-France ends after ~4 days, UKMO ~6.5, ICON ~7; visibility not from ECMWF; ensemble pressure levels also in the GFS ensemble and WeatherNext 2, but not in FlySky's default ECMWF ensemble.
2. **RH conventions differ between models (§4.4):** some report RH over water, others over ice or a water/ice blend. Without normalisation (D11) ECMWF IFS shows 59 % red winter hours instead of 41 %.
3. **Winter screening test (§7.5):** with the v2.2 rules the indicator is red in roughly half of all winter hours; part of it real, part artefact.
4. **Freezing-precipitation codes** come only from ICON (and partly GFS): a profile-based freezing-rain cue is added (D12).
5. **Values below ground are returned** (extrapolated): masking is mandatory, also for the existing wind arrows over high ground (D13).
6. **Bracketing never uses the 2 m layer**; the ground layer feeds only the fog cue (D14).
7. **Call costs verified** with the `X-RateLimit-Cost` header, which the browser can read (§6).
8. **Consensus vs one or two models (§7.6):** keep the consensus in the forecast tab; give the route two models at no extra cost (D15, replaces O3).

---

## 1. Executive summary

FlySky gets an atmospheric icing screening indicator in two places:

1. **Forecast tab (Mode A — local flight profile).** For every hour of the selected time window, a predefined flight from the forecast location: climb to the flight altitude, cruise there for the flight duration, descend. Shown as a separate **Icing** indicator (row in "Can I fly now?", strip in Flight conditions, height-by-time chart, details). Uses the deterministic models selected for Models mode, in both forecast modes; model agreement gives the confidence.
2. **Flight time calculator on the map (Mode B — route).** Along the calculator's route, at the time the aircraft reaches each part (the same timing the wind calculation already uses), at the flight altitude; plus the climb at A and the descent at the end. Risky stretches are coloured on the route line and described in the panel; outbound and return reported separately. Two models, ICON and UKMO (D15).

Both use one shared engine (`icing.js`), the same evidence states and thresholds, and one **Flight altitude** setting shared with the wind arrows and the calculator (§5).

Unchanged from v2.1/v2.2: meteorological hazard evidence is kept separate from aircraft exposure; multi-state evidence instead of a yes/no answer; no clearance function; unknown data is never scored as "no icing".

### 1.1 Decisions

| # | Decision | Status |
|---|---|---|
| D1 | Icing is a **separate risk indicator**; it does **not** affect the flight verdict, planner or confidence by default. Settings option "Include icing in the flight verdict" (off by default). *v2.3:* in Ensemble mode with the option on, each ensemble member takes the icing factor as the deterministic models see it (their shares); the deterministic models are **not** added to the confidence as extra models (§8.2). With the option on, expect about half of winter hours to be rated bad (§7.5). | Decided; Ensemble-mode rule added |
| D2 | Icing exposed **only during climb or descent** is shown **red**, with a clear note ("climb only: ~3 min through 150–300 m above ground"). *Phase 0:* this happens in up to ~1 in 5 winter hours for some models (UKMO, Météo-France) — the note must be prominent. | Decided |
| D3 | Defaults: flight altitude **950 hPa level**, climb **2 m/s**, descent **2 m/s**, flight duration **2 h**. *Phase 0:* in winter 950 hPa is a median **380 m (Kyiv) / 440 m (Zaporizhzhia) above ground** (5–95 %: 210–510 m / 280–535 m) — the intended height. Native in ICON, Météo-France, UKMO, GFS, GEM; not in ECMWF IFS, AIFS, JMA (evaluated "coarse", D14). 925 hPa (median 590 / 650 m above ground, native everywhere) stays the alternative. | Decided; V1 done |
| D4 | **One altitude setting** ("Flight altitude") for wind arrows, calculator wind and icing: wind and icing come from the same pressure level (§5). *v2.3:* masked where the level is below ground (D13). | Decided |
| D5 | Forecast-tab icing uses a **separate deterministic request** (not merged into existing requests). *Phase 0:* the v2.2 variable set costs **8.5 calls** with 5 models (measured); v2.3 adds precipitation and T at 850 / 700 hPa for D12 → **10 calls**. Same `timezone` as the forecast request (`auto`) so the hours line up. | Decided; cost verified |
| D6 | Calculator icing at the flight level is **added to the existing route-wind request at no extra API cost**. *Phase 0:* 16 locations cost 16.0 calls with 2 variables and 16.0 with 5 (measured). The climb/descent column at A reuses the forecast-tab data when A is in the forecast location's area, otherwise one small extra request. | Decided; verified |
| D7 | Icing comes from **deterministic models only** (Models-mode selection), also in Ensemble mode. *Reason corrected (V7):* ensemble pressure-level T/RH exists for ECMWF IFS 0.25°, AIFS, the GFS ensemble and Google WeatherNext 2, but only at 1000 and 925 hPa below ~1 km; FlySky's default ECMWF ensemble (IFS Europe) and ICON-EU EPS have none; ~200 members × variables would cost far more than the deterministic request. | Decided; V7 done |
| D8 | Vertical velocity is **not used** in v1. | Decided |
| D9 | Freezing fog / sub-zero low stratus is its own surface cue. *Phase 0:* weather code 48 only from ICON; visibility only from ICON (first ~5 days), UKMO, GFS — for the other models the cue rests on 2 m temperature and humidity. | Decided; sources per V1/V4 |
| D10 | Thresholds are experimental defaults, configurable under advanced settings, tuned after Phase 0 (§7.4). *v2.3:* they apply to **RH over water** after D11. | Decided (values provisional) |
| D11 | **RH normalised to RH over water per model** before any threshold, from a per-model convention table (§4.4). | **Proposed (v2.3)** |
| D12 | **Freezing-precipitation cue from the profile:** precipitation > 0, 2 m temperature ≤ 0 °C and a layer warmer than 0 °C above (warm nose); weather codes 56/57/66/67 count as well where a model emits them (§7.3). | **Proposed (v2.3)** |
| D13 | **Below-ground masking also for wind:** a level less than 20 m above the ground at a place gives no wind arrow, no route wind and no icing state there ("below ground here"); the arrow-grid request gets the level's geopotential height (still 1 call per location). | **Proposed (v2.3)** |
| D14 | **Bracketing without the 2 m layer:** a model without the flight level takes the worse of its nearest valid pressure levels below and above, each within 300 m of the flight altitude; the 2 m layer is never a bracketing level (it feeds only the fog cue). Such models are marked "coarse". | **Proposed (v2.3)** |
| D15 | **Route icing from ICON + UKMO** (`icon_seamless,ukmo_seamless`) in the route request at the same cost (2 models × 5 variables = 10 → 1 call per location); wind from ICON (≈ today's `best_match`), UKMO as fallback. Replaces O3. | **Proposed (v2.3)** |

---

## 2. Scope, assumptions, non-goals

**Context.** FlySky is a static, browser-only PWA (no server). Weather comes from Open-Meteo's free API (limits: 600 calls/minute, 5,000/hour, 10,000/day per IP, shared by all features), satellite imagery from EUMETSAT EUMETView. All logic runs on the device.

**Objectives**
- Screen the atmosphere along altitude, position and time, not surface weather alone.
- Local flight-profile screening (forecast tab) and route screening (calculator).
- Keep evidence, exposure and the operational verdict separate (D1).
- Show provenance in the details: model, forecast hour, level used, actual height of the level above ground, missing data, "coarse" levels.

**Non-goals (v1)**
- Ice mass, accretion rate, calibrated probability or severity.
- Certifying a route or hour as ice-free.
- Replacing official aviation products or operator judgement.
- Sub-grid resolution, free (interpolated) altitudes (§5.4), audit logs / machine-readable export, single exposure index.

**Simplifications**
- Altitudes are above ground (AGL): level geopotential height − elevation, both returned by Open-Meteo. The response `elevation` is the terrain height at the point (Open-Meteo's 90 m elevation model), not the model's smoothed terrain.
- One cruise altitude per flight/route (no per-leg altitude profile).
- Turns, loiter patterns and alternate routes are not modelled; the calculator's round trip is outbound + return along the same line.

---

## 3. Shared processing architecture (FlySky)

```text
[ Settings: Flight profile ]  altitude level · climb · descent · duration · (airspeed in calculator)
            │
            ├── Forecast tab ──► icing request (deterministic, selected models, 1 location, ≈ 10 calls)
            │                       │
            └── Calculator ──────► route request: ICON + UKMO, wind + T/RH/gph at the flight level (1 call / location)
                                    + column at A (reuse forecast data or 1 small request)
            │
            ▼
[ icing.js — engine ]
   ├── profile builder: levels → height AGL (gph − elevation), mask levels < 20 m above ground (D13)
   ├── RH normalisation to RH over water, per model (D11)
   ├── evidence per model / level / hour (§7); fog cue; freezing-precipitation cue incl. warm nose (D12)
   ├── band evaluation (worse of the two bracketing levels, never 2 m — D14)
   ├── exposure: climb / cruise / descent timing (Mode A) or route samples (Mode B)
   └── agreement across models (share per state, model count, "coarse" flags)
            │
            ▼
[ UI ]  forecast: Icing row · strip · height-time chart · details      calculator: coloured route · panel line
```

`icing.js` is loaded on demand like `hazard.js`, versioned (`?v=`) in `index.html` and `sw.js`.

---

## 4. Weather data — what Open-Meteo returns (verified)

Verified with live API calls on 2026-11-05 (Phase 0, §11) at Kyiv 50.45/30.52, Zaporizhzhia 47.86/35.81 and the Carpathian point 48.16/24.50, and with last winter's archived forecasts.

### 4.1 Deterministic models (FlySky Models-mode list)

Levels from 1000 to 700 hPa that return values (✓) in an 8-day request. Heights above ground: winter 2025/26 medians for 1000–925 hPa, November 2026 medians above that (Kyiv / Zaporizhzhia).

| Level | ≈ height above ground | ICON (`icon_seamless`) | ECMWF IFS 0.25° (`ecmwf_ifs025`) | ECMWF AIFS (`ecmwf_aifs025_single`) | Météo-France (`meteofrance_seamless`) | UK Met Office (`ukmo_seamless`) | NOAA GFS (`gfs_seamless`) | GEM (`gem_seamless`) | JMA (`jma_seamless`) |
|---|---|---|---|---|---|---|---|---|---|
| 1000 hPa | ≈ 0 m — **below ground 71 % / 45 % of winter hours** | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 985 hPa | — | — | — | — | — | — | — | ✓ | — |
| 975 hPa | 180 / 235 m | ✓ | — | — | — | ✓ | ✓ | — | — |
| 970 hPa | — | — | — | — | — | — | — | ✓ | — |
| 950 hPa | **380 / 440 m** | ✓ | — | — | ✓ | ✓ | ✓ | ✓ | — |
| 925 hPa | 590 / 650 m | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 900 hPa | 865 / 910 m | ✓ | — | — | ✓ | ✓ | ✓ | ✓ | — |
| 875 hPa | 1070 / 1130 m | — | — | — | — | — | ✓ | ✓ | — |
| 850 hPa | 1320 / 1360 m | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 800 hPa | 1800 / 1840 m | ✓ | — | — | ✓ | ✓ | ✓ | ✓ | — |
| 700 hPa | 2840 / 2870 m | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| **Forecast length** (8-day request) | | **~7 days** (ICON-EU ~5, then ICON global, same levels) | ≥ 8 days | ≥ 8 days | **~4 days** | **~6.5 days** | ≥ 8 days | ≥ 8 days | ≥ 8 days |

Of the 5 default models, **950 hPa is native in ICON, Météo-France and UKMO only** — and after ~day 4 in two of them, after ~day 7 in none (IFS and AIFS remain).

**Per pressure level:** `temperature`, `relative_humidity`, `geopotential_height`; `dew_point` is returned but **computed by Open-Meteo from T and RH** (Magnus over water, agreement 0.03 °C) — no independent information. Pressure-level `cloud_cover` is RH-derived (not used). `vertical_velocity` not used (D8).

**Height levels (no humidity):** `temperature_80m` and `temperature_120m` — ICON, Météo-France, GFS, GEM; `temperature_180m` — ICON, Météo-France. There is no relative humidity at height levels.

**Surface:** `temperature_2m`, `relative_humidity_2m`, `weather_code`, `cloud_cover_low`, `surface_pressure` — all models. `visibility` — **ICON (first ~5 days), UKMO, GFS only** (not ECMWF, Météo-France, GEM, JMA). `freezing_level_height` — **ICON and GFS only**.

**Below ground:** all models return values at levels below the ground (extrapolated). At the Carpathian point (elevation 2025 m) every level from 1000 to 850 hPa is below ground and still has values; in Kyiv 1000 hPa is below the model surface in 22–95 of 192 forecast hours, depending on the model. Masking (§5.3, D13) is mandatory.

### 4.2 How fields are derived (affects their value as evidence)

| Field | Finding | Consequence |
|---|---|---|
| ECMWF IFS HRES 9 km | No pressure-level fields; only the 0.25° open-data models have them. | FlySky's Models list already uses `ecmwf_ifs025`. |
| Pressure-level `cloud_cover` | Estimated from pressure-level RH (Sundqvist et al. 1989). | Not independent evidence; **not used**. |
| Relative humidity | **Convention differs by model** (§4.4). | Normalise (D11). |
| Dew point | Computed from T and RH (V3). | Display only; useless for checking RH. |
| `weather_code` (V4) | In 2,160 winter hours at Kyiv: **ICON** fog 45: 99 h, rime fog 48: 7 h, freezing drizzle 56/57: 5 h, freezing rain 66/67: 25 h; **GFS** 45: 115 h, 56/57: 42 h; **UKMO** 45: 37 h; **IFS, AIFS, Météo-France, GEM, JMA: none of 45/48/56/57/66/67** — although they had 310–450 h of precipitation with 2 m temperature below 0 °C. Zaporizhzhia alike. | Codes are a cue only where emitted; a missing code is no evidence. Profile-based freezing-rain cue (D12). |
| Time step (V6) | Every model returns hourly values; ECMWF values between its 3-hourly steps are interpolated (near-linear). | Hourly evaluation is fine; ECMWF hours between steps carry no extra information. |
| `vertical_velocity` | ECMWF omega converted to m/s by Open-Meteo. | Not used (D8). |

### 4.3 Ensemble models (V7)

| Ensemble model (Ensemble API) | Pressure-level T / RH | Levels below ~1 km |
|---|---|---|
| ECMWF IFS 0.25° (`ecmwf_ifs025`, 51) | ✓ | 1000, 925 hPa |
| ECMWF AIFS (`ecmwf_aifs025`, 51) | ✓ | 1000, 925 hPa |
| NOAA GFS ensemble (`gfs_seamless`, 31) | ✓ | 1000, 925 hPa |
| Google WeatherNext 2 (`google_weathernext2_ensemble`, 64) | ✓ | 1000, 925 hPa |
| **ECMWF IFS Europe (`ecmwf_ifs_europe_ensemble`) — FlySky default** | — | — |
| DWD ICON-EU EPS, UKMO 20 km, GEM, BOM ACCESS | — | — |

Columns without data are billed like any other (ICON-EU EPS: 8.0 calls for two all-empty variables). Icing from ensembles would be coarse (no level between the ground and ~600 m), would not cover FlySky's default ECMWF ensemble, and would cost ~200 members × variables / 10 per update. **D7 stands.**

### 4.4 Relative-humidity conventions (V3, new)

Supercooled liquid needs saturation over **water**. Models report RH relative to water, to ice, or to a blend. Test: at 300 hPa in winter (median −52 °C), air saturated over ice has only ~60 % RH over water, so a water-convention model cannot go much above that, while an ice-convention model reaches 100 %.

| Model | 300 hPa RH, Dec–Feb, Kyiv (p99 / max) | Convention | Normalisation to RH over water (D11) |
|---|---|---|---|
| ICON | 64 / 66 % | over water | none |
| GEM | 62 / 68 % | over water | none |
| UKMO | 74 / 92 % | over water (mostly) | none — confirm |
| ECMWF IFS 0.25° | 100 / 100 % | **documented:** water above 0 °C, ice below −23 °C, quadratic blend between (ECMWF parameter 157) | RH_w = RH × e_mix(T) / e_w(T) |
| ECMWF AIFS | 100 / 100 % | ice at low temperatures; rule not documented | as IFS, provisionally — confirm |
| Météo-France | 100 / 100 % | ice at low temperatures | to confirm from provider documentation |
| GFS | 100 / 100 % | ice at low temperatures | to confirm |
| JMA | 100 / 100 % | ice at low temperatures | to confirm |

With e_w(T) = 6.112·exp(17.62·T / (243.12 + T)), e_i(T) = 6.112·exp(22.46·T / (272.62 + T)) (hPa, T in °C) and, for −23 °C < T < 0 °C, e_mix = α·e_w + (1 − α)·e_i with α = ((T + 23) / 23)².

**Effect** (Kyiv, winter, cruise at 950 hPa red with the §7.4 rules): ECMWF IFS **59 % → 41 %** of hours with the documented rule — then close to ICON's 43 %. With assumed rules (ECMWF blend for AIFS and GFS, ice below 0 °C for Météo-France and JMA): AIFS 43 → 32 %, GFS 40 → 27 %, Météo-France 46 → 28 %, JMA 33 → 18 % — these fall below the water-convention models, so the assumed rules probably over-correct; their exact rule between 0 and −20 °C must come from the providers (open check V3b, §11). Until then the engine normalises only IFS (and AIFS provisionally) and marks the others' RH convention as unconfirmed in the details.

---

## 5. Flight profile and the altitude setting

### 5.1 One altitude setting (D4)

The existing wind height setting (shared by wind arrows and calculator) becomes **Flight altitude** in a new **Flight profile** settings section (side menu, both views); the calculator keeps a selector for it. Wind and icing at a pressure level come from the same level, so one setting serves both.

| Option | Wind | Icing | Models without the level (icing: "coarse", D14) |
|---|---|---|---|
| 10 m | 10 m | surface cues only (2 m T/RH, fog, codes, freezing precipitation) | — |
| ~120 m | 120 m height level | surface cues + `temperature_120m` where available (ICON, Météo-France, GFS, GEM); no humidity at 120 m — lower confidence | — |
| ~200 m (new) | 975 hPa | 975 hPa | IFS, AIFS, Météo-France, GEM, JMA |
| **~400 m (default)** | **950 hPa** | **950 hPa** | IFS, AIFS, JMA |
| ~600 m | 925 hPa | 925 hPa | — |
| ~900 m (new) | 900 hPa | 900 hPa | IFS, AIFS, JMA |
| ~1300 m | 850 hPa | 850 hPa | — |
| ~1800 m (optional) | 800 hPa | 800 hPa | IFS, AIFS, JMA |
| ~2800 m (optional) | 700 hPa | 700 hPa | — |

- Nominal labels follow the measured lowland heights above ground (v2.2's "~500 m / ~800 m / ~1500 m" overstated them by 60–200 m). FlySky's current labels need the same correction: the map's wind heights "~500 m", "~800 m", "~1500 m" (`rtLevel_*` in `map.js`), Models mode's "Wind ~500 m" (`paramWindAloftDet`), and the wind-aloft member labels "~110 m · 1000 hPa" / "~800 m · 925 hPa" (heights above sea level; above ground they are ≈ 0 m and ≈ 600 m).
- **Labels** show the height **above ground at the current location** once data is known (e.g. "950 hPa · ~370 m above ground here"), from geopotential height − elevation.
- **Wind** for a model missing the level: excluded (as today); the wind-aloft confidence logic already imputes missing factors.
- **Default (D3):** 950 hPa. Existing users keep their stored wind height; new users start at 950 hPa (wind arrows then also default to ~400 m instead of 120 m).
- The forecast tab's existing **wind-aloft factor** (1000+925 hPa pooled in Ensemble mode, 950 hPa in Models mode) is **not changed** in this work (O1).

### 5.2 Profile parameters and defaults

| Setting | Default | Range | Used by |
|---|---|---|---|
| Flight altitude | 950 hPa (~400 m) | §5.1 options | wind arrows, calculator wind + icing, forecast icing |
| Climb rate | 2 m/s | 0.5–10 m/s | climb exposure (Mode A and B) |
| Descent rate | 2 m/s | 0.5–10 m/s | descent exposure |
| Flight duration | 2 h | 15 min – 6 h | Mode A cruise time |
| Airspeed | 22 m/s (existing calculator setting, 18–30) | — | Mode B timing |
| Include icing in the flight verdict | off | on/off | D1 |
| Icing thresholds (advanced, "experimental") | §7.4 | — | engine |

Example: climb to 400 m above ground at 2 m/s ≈ 3.3 min; the same for descent.

### 5.3 Vertical handling

- Height above ground of a level = `geopotential_height_XhPa − elevation` (both from the API response; elevation is the real terrain at the point).
- Levels less than 20 m above the ground are **masked** as invalid, never treated as real samples (D13). Open-Meteo returns extrapolated values below ground (§4.1).
- **Bracketing (D14):** a band between two valid pressure levels takes the **worse** state of the two (no RH interpolation; cloud layers are not linear in RH). A model without the flight level uses its nearest valid levels below and above within 300 m of the flight altitude (the worse of the two, or the one that exists); with neither, its state is unknown. The 2 m layer is **never** a bracketing level. Example: ECMWF IFS at 950 hPa uses 925 hPa (~200 m higher), and 1000 hPa only when it is above ground and within 300 m.
- **2 m values** feed only the surface cues (freezing fog / low stratus, freezing precipitation — §7.3), not the T/RH rule of §7.4. (Read literally, v2.2 applied the 90 % rule to the 2 m layer as the bottom of the climb band, in conflict with the fog cue's 97 %; in the winter test that added up to 12 points of red hours.)
- No extrapolation above the highest requested level.

### 5.4 Not in v1: free altitude

A free AGL altitude (e.g. 450 m) would need interpolation between bracketing levels for wind and icing. In the route request that means two levels × (wind 2 + T + RH + gph) = 10 variables per model — still one call per location for one model, two for two. It adds complexity and pretends precision the models' vertical resolution doesn't have. Revisit after v1 (O2).

### 5.5 High ground (new, D13)

A fixed pressure level can be below ground: at the Carpathian test point (elevation 2025 m) every level up to 850 hPa is. In v1:
- Icing (Mode A): if the flight level is below ground at the location, the Icing row says "Flight altitude below ground here (elevation 2025 m) — choose a higher level" and the state is unknown; the climb band uses the valid levels only.
- Route (Mode B): samples where the level is below ground are unknown ("below ground") for wind and icing; the wind triangle stops there like for missing wind.
- Wind arrows: no arrow where the level is below ground. **This also applies today:** FlySky's wind arrows and calculator at ~500 / ~800 / ~1500 m currently show extrapolated below-ground winds over the Carpathians. The arrow request needs the level's geopotential height (3 variables, still 1 call per location); the route request already has it (D6).
- Choosing levels relative to the terrain (e.g. "400 m above ground" → the level nearest to elevation + 400 m) is O7.

---

## 6. API requests and call budget

### 6.1 How Open-Meteo counts calls (verified, V9)

Per location:

```
weight = max(1, variables × models / 10)                 for up to 14 days
weight = max(1, variables × models / 10 × days / 14)     beyond 14 days
total  = weight × number of locations
```

Ensemble models count every member (`members × variables / 10`). Verified with the `X-RateLimit-Cost` response header: no rounding (18 members × 1 variable = 1.8; one location × 15 variables = 1.5); multi-location requests add up per location; **columns without data are billed**; beyond 14 days the factor is exact (31 days: × 31/14).

The header is **readable in the browser** (`Access-Control-Expose-Headers` lists `x-ratelimit-cost`, `x-ratelimit-limit`, `x-ratelimit-remaining`, `x-ratelimit-reset`, `x-ratelimit-window`, `retry-after`). FlySky's `forecastCost()` estimates with `Math.ceil`; the real cost could be tracked instead (O8).

### 6.2 Current FlySky requests and icing additions

| Request | Today | With icing | Call impact | Decision |
|---|---|---|---|---|
| Ensemble forecast (ensemble API) | ≈ 120 calls/update (4 default ensembles) | — (no icing here) | 0 | D7 |
| Models-mode forecast (forecast API, 6 vars × 5 models) | 3 calls/update | — | 0 | — |
| **Icing request** (forecast API, selected Models-mode models, 1 location) | — | T, RH, gph at 1000/975/950/925 (12) + 2 m T, 2 m RH, weather code, visibility, low cloud (5) = 17 vars × 5 models = **8.5 calls (measured)**; v2.3 adds precipitation and T at 850 / 700 hPa (D12) → 20 vars = **10 calls** (8 models: 16). For higher flight levels: up to one level above the flight level. | +10 per update, cached like the forecast (1 h) | D5 |
| — merged into Models-mode request instead | | shared vars only visibility, low cloud, precipitation | saves ≈ 1.5 calls/update, Models mode only | **not worth the coupling** |
| **Route request** (forecast API, ≤ 16 locations) | `best_match`, 2 vars: **16.0 calls** for 16 locations (measured), cells cached 30 min | + T, RH, gph at the flight level: **16.0** (measured); with ICON + UKMO (D15): 2 × 5 = 10 → still 1 per location (4 locations × 2 models × 5 vars measured at 4.0) | **0** | D6, D15 |
| Column at A (and B for one-way) | — | reuse forecast icing data if A is in the forecast location's 0.1° cell and the hours are covered; else 1 location × ~14 vars × 2 models ≈ 2.8 calls | small, only when needed | D6 |
| **Wind-arrow grid** (missing in v2.2) | `best_match`, 2 vars, up to 220 points per view in chunks of 100: **up to ≈ 220 calls per refresh** (cached 30 min per point) — the largest map consumer | + gph at the level (D13): 3 vars, still 1 per location | 0 | D13 |
| *Option:* icing marks on the wind-arrow grid | | + T, RH at the flight level = 5 vars | 0 | O4 (later) |
| Map readout (crosshair) | 6 vars × models | + T, RH at flight level | +≈ 1 call per read | not in v1 |

---

## 7. Meteorological evidence

### 7.1 Dew point

Magnus approximation (T in °C, RH in %): γ = ln(RH/100) + 17.625·T / (243.04 + T), T_d = 243.04·γ / (17.625 − γ). **Display only.** v2.2 planned to use it to check RH conventions; Open-Meteo's dew point is itself computed from RH (§4.1), so it cannot. RH conventions are handled by D11.

### 7.2 Evidence states (per model, per level or band, per hour)

| State | Meaning | UI colour |
|---|---|---|
| `POTENTIAL ICING ENVIRONMENT — LWC UNKNOWN` | sub-freezing air with near-saturation over water (cloud environment likely), supercooled liquid not known | red |
| `FREEZING FOG / LOW STRATUS` (D9) | sub-zero near-ground fog or saturated low layer | red |
| `FREEZING PRECIPITATION INDICATOR` (D12) | precipitation with a warm layer aloft over sub-zero air at the ground, or weather code 56/57/66/67 | red |
| `MARGINAL` | near a threshold (§7.4) | yellow |
| `NO ICING INDICATION FROM AVAILABLE PROXIES` | none of the above; **not** "no icing" / "safe" | green, text "No icing signs in the forecast data" |
| `UNKNOWN / INSUFFICIENT DATA` | required fields missing, masked (below ground) or not returned; model beyond its forecast length | grey |

`METEOROLOGICAL ICING HAZARD INDICATED` (v2.1) stays unavailable: no authoritative icing product is accessible client-side.

**Agreement.** Per hour, the share of models in each state; agreement < 60 % is shown as low confidence with the split (FlySky's levels: high ≥ 80 %, medium 60–80 %, low < 60 %). Only models with data at that hour count, and the **number of models is shown**: the count falls through the week (Météo-France ends after ~4 days, UKMO ~6.5, ICON ~7 — by days 7–8 only IFS and AIFS remain, both "coarse" at 950 hPa). With fewer than 3 models the confidence is shown as at most medium, however much they agree. "Coarse" models (D14) count, and the details say which ones they are. A model with no usable data counts as unknown, not as "no indication".

### 7.3 Cues

- **Pressure-level evidence:** temperature and RH over water (D11) at each valid level (§5.3).
- **Freezing fog / low stratus (D9):** weather code 48 (ICON only); or 2 m temperature ≤ 0 °C with visibility < 1000 m (ICON first ~5 days, UKMO, GFS) or 2 m RH ≥ 97 % (all models); low cloud ≥ 70 % with the lowest valid level sub-zero and RH ≥ 90 % (already covered by the level evidence, reported as low stratus when below the flight altitude).
- **Freezing precipitation (D12):** precipitation ≥ 0.1 mm/h with 2 m temperature ≤ 0 °C **and** a temperature above 0 °C at any valid level up to 700 hPa (warm nose: snow melts aloft and refreezes on contact) → red; weather code 56/57 (freezing drizzle) or 66/67 (freezing rain) → red where emitted (ICON; GFS 56/57). A surface and climb/descent cue for the location and hour, not assigned to a cruise altitude. Source shown ("profile", "ICON code", "GFS code").
- **Not used:** pressure-level cloud cover (RH-derived), vertical velocity (D8), freezing-level height (only ICON and GFS; derived from the profile instead; optional context line on the chart).

### 7.4 Experimental thresholds (configurable, unvalidated)

RH is RH over water after D11.

| State | Default rule |
|---|---|
| Potential icing environment | −20 °C ≤ T ≤ 0 °C and RH ≥ 90 % |
| Marginal | −20 °C ≤ T ≤ +1 °C and 80 % ≤ RH < 90 %; or 0 °C < T ≤ +1 °C and RH ≥ 90 % (temperature uncertainty); or −30 °C ≤ T < −20 °C and RH ≥ 90 % (mostly glaciated, supercooled liquid possible) |
| No indication | otherwise, with T and RH available |

Labelled "experimental" in settings and details. Never presented as universal icing thresholds. For reference, air saturated over ice has RH over water of ≈ 91 % at −10 °C and ≈ 82 % at −20 °C: with the 90 % rule an ice-saturated (glaciated) cloud at −10 °C is red, at −20 °C marginal — conservative by design. Tuning (O6) can use the winter harness in `docs/icing-phase0/`.

### 7.5 Winter screening test (new, Phase 0)

The §7.4 rules (as in v2.2, RH as reported) on last winter's archived forecasts, Dec 2025 – Feb 2026 (2,160 hours), flight level 950 hPa, at Kyiv / Zaporizhzhia:

| Measure | Kyiv | Zaporizhzhia |
|---|---|---|
| Cruise level red, per model (Kyiv: 8 models; Zaporizhzhia: 6, no GEM / JMA) | 32–62 % of hours | 25–49 % |
| 5 default models: ≥ 60 % of them red | 52–59 % | 44–48 % |
| 5 default models: at least one red | 76–79 % | 66–68 % |
| 2-hour flight (climb + cruise + descent): departure hours red, per default model | 47–72 % | 44–63 % |
| Red only in climb or descent (D2), per model | 0–23 % | 0–18 % |
| Models disagreeing on red vs not red ("split") — 950 hPa / 925 hPa | 50 % / 40 % | 40 % / 30 % |
| 5-model consensus red with D11 (IFS, AIFS normalised) | 45 % | 40 % |

Reading:
- Ukrainian winters do have extensive sub-zero low cloud; **red will be common** whatever the tuning. The UI must stay informative when red: show the layer's base and top, the minutes in it per phase, and the next hours without icing signs. With D1's option on, about half of winter hours would be rated bad.
- Part of the red is artefact: the RH convention (IFS 59 → 41 %, §4.4) and v2.2's bracketing with the 2 m layer (IFS 51 % at its native 925 hPa vs 59 % at 950 hPa via 2 m and 925) — addressed by D11 and D14.
- The archive holds early forecast hours: this measures how often the models put such conditions there, not forecast skill; at longer lead times the models disagree more than shown here.

### 7.6 Consensus or one or two models? (new)

Only deterministic models are in question (D7 rules out the ensembles). Same winter data, 950 hPa, one instant of Mode A (climb + cruise + surface cues), IFS and AIFS normalised (D11). "Consensus red" = at least 3 of the 5 default models red. Kyiv / Zaporizhzhia:

5-model consensus: red 45 / 40 % of hours, **split (1–2 of 5 red) 27 / 25 %**, none red 28 / 36 %.

| Choice | Red hours | Same as the consensus | Misses consensus-red hours |
|---|---|---|---|
| ICON alone | 44 / 38 % | 88 / 91 % | 15 / 14 % |
| ECMWF IFS alone | 41 / 39 % | 85 / 88 % | 21 / 17 % |
| ECMWF AIFS alone | 32 / 31 % | 82 / 82 % | 35 / 34 % |
| Météo-France alone | 53 / 52 % | 83 / 83 % | 9 / 6 % |
| UKMO alone | 55 / 44 % | 81 / 89 % | 10 / 9 % |
| GFS alone (not one of the 5) | 49 / 33 % | 70 / 78 % | 29 / 36 % — and red in 17 / 2 % of the hours none of the 5 is |
| ICON + UKMO, red if either | 62 / 50 % | 80 / 89 % | 3 / 2 % |
| ICON + UKMO, red if both | 37 / 33 % | 88 / 91 % | 21 / 21 % |
| ICON + IFS, red if either | 56 / 49 % | 89 / 91 % | 0.3 / 0.6 % |
| ICON + IFS, red if both | 29 / 28 % | 84 / 88 % | 35 / 30 % |

Any two models agree on red vs not red in only 60–88 % of winter hours (typically ~75 %).

Conclusions:
- **It makes a difference in about a quarter of winter hours** — the split hours. One model turns them into a confident-looking red or green, set by that model's habits (UKMO and Météo-France red more often, AIFS less), and drops the confidence signal. One model alone misses 6–35 % of the hours a majority flags.
- **Cost is no argument:** one model 2 calls, two 4, five 10 per update — against ≈ 120 for an ensemble update.
- **Agreement with the consensus is not skill.** Which model is best for supercooled low cloud over Ukraine can only be settled against observations (O9). On data alone ICON is best equipped (975/950 hPa, RH over water, visibility, native fog / freezing-precipitation codes, 7 km) and closest to the consensus; UKMO is next (975/950 hPa, RH over water, visibility); ECMWF IFS is the strongest global model in general but on Open-Meteo has no level between the ground and ~600 m, no visibility and no codes.
- **Forecast tab:** keep the consensus of the Models-mode selection (D5, D7), with D11 and D14; show each model's state in the details.
- **Route:** today it is effectively ICON alone (`best_match`). ICON + UKMO costs nothing extra (both have the flight level; 2 × 5 variables = 10) and misses only 2–3 % of consensus-red hours with "red if either" — **D15**. "Red if both" would miss a fifth of them.
- A "single preferred model" option is not recommended.

---

## 8. Mode A — Forecast tab (local flight profile)

### 8.1 Exposure for departure hour h

1. **Climb** at hour h: ground → flight altitude at the climb rate; time in each band = band thickness / climb rate.
2. **Cruise** at the flight altitude from h to h + duration (default 2 h → hours h, h+1, part of h+2).
3. **Descent** at h + duration: flight altitude → ground at the descent rate.
4. Surface cues (fog, freezing precipitation) at h and at h + duration.

Per model: the hour's state is the worst state met in any phase (D2). The details keep the phases apart: minutes of cruise in each state; bands crossed in climb/descent and the minutes in them; surface cues with their source; levels used ("coarse" where D14 applies). Agreement across models as in §7.2, with the model count. Unknown time is reported, never scored as zero; hours beyond a model's forecast length are unknown for that model.

### 8.2 UI

- **"Can I fly now?" card:** a separate Icing row under the factor tiles (not one of the verdict tiles unless D1's option is on), e.g. "❄ Icing: potential icing environment at ~380 m (−3 °C, RH 96 %) · 4 of 5 models", or "❄ Icing: climb only — ~2 min through 150–300 m (freezing fog layer)". Follows the hour slider.
- **Flight conditions:** an Icing strip under the confidence strip, hours coloured by state; pinned-hour details list phases, levels, values and models.
- **Chart "Icing profile":** height (ground → one level above the flight altitude) by time; cells coloured by state (share of models), 0 °C line, flight-altitude line, climb/descent phases indicated; tooltip with T, RH and models per level.
- **Planner:** icing windows listed as warnings; excluded from "suitable" only when D1's option is on. Because red is common in winter (§7.5), the planner names the next hours without icing signs.
- **Option on (D1):** icing becomes a verdict factor (tile, breakdown bar, reasons, planner, confidence) like the others. Confidence in **Models mode**: each model's own icing state, like its other factors. In **Ensemble mode**: the members have no icing data, so each member takes the icing factor as the deterministic models see it (their shares — the existing "factor a member lacks is taken as the others see it" rule); the deterministic models must **not** enter the confidence as extra models.

---

## 9. Mode B — Flight time calculator (route)

### 9.1 Profile

- Climb at A at the departure time (calculator's departure: now or +1–6 h).
- Outbound cruise A → (waypoints) → B at the flight altitude; each sample evaluated at its arrival time (existing wind-triangle timing).
- Return cruise B → A, then descent at A at the return ETA.
- If the return can't be computed (no wind data, no headway, flight level below ground), the result says it covers the outbound leg only; descent is then evaluated at B as a one-way case.

### 9.2 Data

- Route request with `models=icon_seamless,ukmo_seamless` (D15): wind speed, wind direction, T, RH, gph at the flight level (5 variables × 2 models = 10 → 1 call per location, same as today). At 10 m / ~120 m: wind at that height, `temperature_120m`, 2 m T and RH (5 variables).
- Wind for the wind triangle from ICON (≈ today's `best_match`, mean |ΔT| 0.1 °C to ICON); UKMO's wind only where ICON has none.
- Icing per sample: red if either model is red; "1 of 2 models" shown when only one is.
- Samples where the level is below ground: unknown ("below ground", D13).
- Climb/descent column at A (and B for one-way): forecast-tab data when A is in the forecast location's cell and the hours are covered; otherwise one small request (≈ 2.8 calls).
- The multi-model, multi-location response is an array with one object per location; columns are suffixed by model (`temperature_950hPa_icon_seamless`), as in the forecast tab.

### 9.3 UI

- Route line segments coloured by state (outbound); the tag gets a ❄ mark when icing is indicated.
- Panel line, e.g. "❄ Potential icing 15–32 km (≈ 25 min) at ~380 m, −4 °C, RH 95 % · ICON and UKMO · climb at A through 150–300 m (~1 min)"; return leg summarised separately ("Back: no icing signs" / "Back: potential icing 8–20 km, UKMO only").
- Wind-triangle infeasibility stays as implemented (where/when/wind message).

---

## 10. Settings summary

New side-menu section **Flight profile** (shown in both views): flight altitude, climb rate, descent rate, flight duration; **Icing**: include in flight verdict (off), thresholds (advanced, experimental, on RH over water). The calculator's height selector edits the same flight altitude. Airspeed stays in the calculator. The RH normalisation (D11) is not a setting.

---

## 11. Phase 0 — API verification (done 2026-11-05)

Run against `api.open-meteo.com` (live, 8-day request), `ensemble-api.open-meteo.com` and `historical-forecast-api.open-meteo.com` (Dec 2025 – Feb 2026), at Kyiv 50.45/30.52, Zaporizhzhia 47.86/35.81 and the Carpathian point 48.16/24.50. ≈ 630 calls. Scripts, instructions and output: [`docs/icing-phase0/`](icing-phase0/).

| ID | Check | Result | Affects |
|---|---|---|---|
| V1 | Levels and variables per model, forecast length | §4.1. 950 hPa native in 3 of the 5 defaults; JMA only 1000/925/850/700; Météo-France ~4 d, UKMO ~6.5 d, ICON ~7 d; visibility ICON (~5 d) / UKMO / GFS; freezing level ICON / GFS; `temperature_120m` ICON / Météo-France / GFS / GEM. | D3, D9, §5.1, §7.2 — **done** |
| V2 | `best_match` for the route; multi-location / 2-model format | `best_match` returns T, RH, gph at 1000–850 hPa for all 8 days; mean absolute temperature difference to ICON 0.1 °C, to the others ≥ 0.6 °C — ICON-based. Array of per-location objects; model-suffixed columns. ECMWF returns nothing at 950 hPa (billed anyway). | D6, D15 — **done** |
| V3 | RH convention below 0 °C | Dew point is derived from RH (no help). Conventions differ (§4.4): water — ICON, GEM, UKMO (mostly); ice / blend — IFS (documented), AIFS, Météo-France, GFS, JMA. | D10, D11 — **done**; V3b open |
| V3b | Exact RH rule between 0 and −20 °C for AIFS, Météo-France, GFS, JMA (and UKMO) | provider documentation | D11 — **open** |
| V4 | Weather codes 48/56/57/66/67 | Emitted only by ICON (all of them) and GFS (45, 56, 57); UKMO 45 only; none from IFS, AIFS, Météo-France, GEM, JMA (§4.2). Agreement with observed freezing rain not checked. | D9, D12 — **done**; observations open (O9) |
| V5 | Geopotential height vs elevation; levels below ground | Values are returned below ground (extrapolated) at all levels at the Carpathian point; `gph − elevation` identifies them. 1000 hPa below ground 71 % (Kyiv) / 45 % (Zaporizhzhia) of winter hours. | §5.3, D13 — **done** |
| V6 | Hourly behaviour of ECMWF pressure-level fields | Hourly values, interpolated between 3-hourly steps. | §8 — **done** |
| V7 | Ensemble pressure-level T/RH | §4.3: ECMWF IFS 0.25°, AIFS, GFS ensemble, WeatherNext 2 at 1000 / 925 hPa; none in ECMWF IFS Europe, ICON-EU EPS, UKMO, GEM, BOM. | D7 — **done** |
| V8 | `vertical_velocity` units/sign | Not run (D8). | — |
| V9 | Call weight for multi-location, multi-model requests | §6.1 verified with `X-RateLimit-Cost`; null columns billed; header readable from the browser. | §6 — **done** |
| V10 | `icon_seamless` component in Ukraine | ICON-EU grid (0.0625°) with 1000/975/950/925/900/850/800/700 hPa; visibility ends after ~5 days and data after ~7 — ICON-EU, then ICON global with the same levels. | §5.1 — **done** |

Notes for re-running:
- Open-Meteo's daily limit is per IP and **shared by the forecast, historical-forecast, previous-runs and single-runs hosts** (the ensemble host counts separately). From a shared cloud IP it may be used up for most of the day; run just after 00:00 UTC.
- The historical-forecast host fails mid-stream (`timeoutReached`, still billed) for 8 models × 27 variables in one request; one model per request works.

---

## 12. Validation and tests

**Automated (Playwright, mocked Open-Meteo), synthetic profiles:**
- cold and dry; sub-zero saturated layer at the flight altitude; layer only below (climb/descent only → red with note); layer above the flight altitude; two layers separated by dry air;
- freezing fog at ground (code 48; T2m ≤ 0 with low visibility; T2m ≤ 0 with RH2m ≥ 97 % for a model without visibility); freezing rain code with dry profile (surface cue only); **warm nose** (precipitation, T2m < 0, +2 °C at 850 hPa, no code) → freezing-precipitation indicator (D12);
- **RH normalisation** (D11): the same vapour content reported over ice by IFS and over water by ICON gives the same state;
- levels below ground (masked); **elevated location** (all levels to 850 hPa below ground → "below ground here", no wind arrows, route unknown) (D13); model missing 950 hPa → 925 hPa used, **never the 2 m layer** (D14); all models missing → unknown;
- models disagreeing (share/confidence); **model count falling** through the week (Météo-France after 4 days) and confidence capped with < 3 models; time progression within a 2 h flight;
- route: two models (D15) — request has `models=icon_seamless,ukmo_seamless` and stays 1 call per location; red if either; "1 of 2 models"; icing on part of the outbound leg, return leg different, return not computable (outbound only), A outside the forecast cell (extra column request), no extra calls for flight-level variables (request counts in the mock log);
- D1 option in Ensemble mode: members take the icing factor from the deterministic shares; the deterministic models don't appear as extra models in the confidence;
- settings: defaults (950 hPa, 2/2 m/s, 2 h), verdict option off/on, one altitude setting shared by arrows/calculator/icing, corrected height labels.

**Live sanity:** spot checks on cold, cloudy days; compare model states with EUMETSAT imagery; re-run `docs/icing-phase0/` after model changes at Open-Meteo.

**Later (O5):** satellite cross-check for the current hour — FlySky already shows Cloud Type RGB (with a supercooled-water class) and Cloud Phase RGB; a note "satellite sees supercooled liquid cloud tops here" like the existing satellite-vs-forecast note.

**Meteorological validation** (thresholds, false alarms/misses, which models are best — O9) needs independent observations (regional aviation products, station reports, operator reports, satellite cloud phase) and is outside v1.

---

## 13. Implementation plan

| Phase | Work | Files |
|---|---|---|
| 0 | API verification V1–V10 — **done** (§11) | `docs/icing-phase0/` |
| 0b | Confirm RH conventions (V3b); decide D11–D15 | — |
| 1 | Engine: profile builder, masking, RH normalisation, evidence states, fog and freezing-precipitation cues, band evaluation (D14), Mode A exposure, route sample evaluation, agreement with model count; unit tests with synthetic profiles | `icing.js`, tests |
| 2 | Settings "Flight profile" (altitude shared with wind arrows/calculator, climb, descent, duration, verdict option, thresholds); migration of the stored wind height; corrected height labels; below-ground masking of wind arrows (D13 — also a fix for today's app) | `index.html`, `map.js` |
| 3 | Forecast tab: icing request + cache, Icing row/strip/details, height-time chart, planner warnings, verdict option (incl. Ensemble-mode rule) | `index.html`, `icing.js` |
| 4 | Calculator: ICON + UKMO route request (D15) with flight-level variables, column at A/B, coloured segments, panel lines, return leg | `map.js`, `icing.js` |
| 5 | Optional: O4 (icing marks on the wind grid), O5 (satellite cross-check), O7 (terrain-relative levels), O8 (real call costs) | — |

READMEs (en/uk/pt-BR) updated with each phase; `?v=` and service-worker cache bumped for changed scripts.

---

## 14. Open items

- **O1** Wind-aloft factor in the forecast tab to follow the flight altitude (currently fixed levels).
- **O2** Free AGL altitude with interpolation (§5.4).
- ~~**O3** Two models in the route request~~ → D15 (ICON + UKMO).
- **O4** Icing marks on the wind-arrow grid at the flight level (no extra cost).
- **O5** Satellite supercooled-cloud cross-check for the current hour.
- **O6** Threshold tuning with operator feedback; the winter harness in `docs/icing-phase0/` gives the red-hour rates for any rule change.
- **O7** Terrain-relative levels: pick the level nearest to elevation + chosen height per location (high ground, §5.5).
- **O8** Use `X-RateLimit-Cost` / `-Remaining` for FlySky's request budget instead of estimates.
- **O9** Verify the models' icing states against observations (which models are best; how much they diverge at days 3–7 — the previous-runs API can give lead-time series).

---

## 15. Changes from v2.2

1. §4 rebuilt from live responses: per-model level table (JMA only 1000/925/850/700; 975 hPa only ICON, UKMO, GFS; 950 hPa not in IFS, AIFS, JMA), forecast lengths (Météo-France ~4 d, UKMO ~6.5 d, ICON ~7 d), visibility (not ECMWF), freezing level (ICON, GFS), height-level temperatures, values below ground, measured heights above ground.
2. §4.3 corrected: ensemble pressure-level T/RH also in the GFS ensemble and WeatherNext 2, not in FlySky's default ECMWF IFS Europe ensemble; all at 1000/925 hPa only below 1 km. D7 kept for corrected reasons.
3. §4.4 new: RH conventions differ by model; D11 normalises to RH over water. Dew point found to be derived from RH; its use for normalisation (§7.1) dropped.
4. §4.2: weather codes measured — freezing / fog codes only from ICON (and GFS 45/56/57, UKMO 45); D12 adds a profile-based freezing-precipitation cue (warm nose).
5. §5: height labels corrected (950 hPa ≈ 400 m, not ~500 m); D13 below-ground masking for wind and icing, also fixing today's wind arrows over high ground (§5.5); D14 bracketing without the 2 m layer; 2 m values only through the surface cues (resolves the v2.2 conflict between §5.3 and §7.3).
6. §6: costs verified with `X-RateLimit-Cost` (route 16.0 with 2 or 5 variables; icing request 8.5; null columns billed); wind-arrow grid added to the budget; icing request grows to 10 calls (D12).
7. §7.5 new: winter screening test — red in about half of winter hours; RH convention and 2 m bracketing as artefacts.
8. §7.6 new: consensus vs one or two models; forecast tab keeps the consensus, route gets ICON + UKMO (D15, replaces O3).
9. §7.2: agreement shows the model count; confidence capped with < 3 models; models beyond their forecast length are unknown.
10. §8.2: D1 rule for Ensemble mode.
11. §11: Phase 0 results; §12 tests and §13 plan updated; O7–O9 added.

---

## 16. References

- Open-Meteo documentation source: github.com/open-meteo/open-meteo-website (`src/routes/en/docs/*`, `src/routes/en/pricing`) — ECMWF, DWD, Météo-France, UKMO, GFS, GEM, JMA, Ensemble API pages; WMO code subset in `wmo-codes-table.svelte`.
- Open-Meteo API: https://api.open-meteo.com/v1/forecast, https://ensemble-api.open-meteo.com/v1/ensemble, https://historical-forecast-api.open-meteo.com/v1/forecast
- Phase 0 scripts and output: `docs/icing-phase0/` (this repository).
- ECMWF Parameter Database, relative humidity (parameter 157): saturation over water above 0 °C, over ice below −23 °C, quadratic interpolation between.
- WMO Guide to Instruments and Methods of Observation (WMO-No. 8), Annex 4.B: saturation vapour pressure over water and ice (Magnus form).
- Sundqvist, H., Berge, E., Kristjánsson, J.E. (1989): Condensation and cloud parameterization studies with a mesoscale NWP model (pressure-level cloud cover derivation used by Open-Meteo).
- WMO 4677 present-weather code table (subset emitted by Open-Meteo: 0–3, 45, 48, 51–57, 61–67, 71–77, 80–82, 85–86, 95, 96, 97, 99).
- ECMWF IFS open data (0.25°) pressure-level fields; DWD ICON open data.
- FAA Aviation Weather Handbook / AWC icing guidance (US reference only).

*END OF TECHNICAL HANDOFF DOCUMENT v2.3 — FLYSKY INTEGRATION*
