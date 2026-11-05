# FIXED-WING UAV ATMOSPHERIC ICING FORECASTING
## Technical Handoff & Architecture Specification — v2.2 (FlySky integration)

| Document status | Purpose | Intended use |
|---|---|---|
| **Integration design, decisions recorded, pending API verification** | Adapt the v2.1 two-mode icing screening architecture to FlySky (browser-only PWA on Open-Meteo), record design decisions, and list what still has to be verified with live API calls. | Implementation in FlySky (`index.html`, `map.js`, new `icing.js`), test planning, Phase 0 API verification. |

> **Safety notice**
> Proxy indicators and exposure estimates are not validated icing forecasts. They do not estimate ice accretion or a probability of icing, and **must not be used to authorize flight into icing conditions**. A small fixed-wing UAV should be kept out of forecast or observed icing unless the complete aircraft is designed, tested and approved for it. In FlySky the icing indicator is a separate, clearly labelled, **experimental** screening aid; by default it does not change the flight verdict.

---

## 1. Executive summary

FlySky gets an atmospheric icing screening indicator in two places:

1. **Forecast tab (Mode A — local flight profile).** For every hour of the selected time window, a predefined flight from the forecast location: climb to the flight altitude, cruise there for the flight duration, descend. Shown as a separate **Icing** indicator (row in "Can I fly now?", strip in Flight conditions, height-by-time chart, details). Uses the deterministic models selected for Models mode, in both forecast modes; model agreement gives the confidence.
2. **Flight time calculator on the map (Mode B — route).** Along the calculator's route, at the time the aircraft reaches each part (the same timing the wind calculation already uses), at the flight altitude; plus the climb at A and the descent at the end. Risky stretches are coloured on the route line and described in the panel; outbound and return reported separately.

Both use one shared engine (`icing.js`), the same evidence states and thresholds, and one **Flight altitude** setting shared with the wind arrows and the calculator (§5).

What is unchanged from v2.1: meteorological hazard evidence is kept separate from aircraft exposure; multi-state evidence instead of a yes/no answer; no clearance function; unknown data is never scored as "no icing".

### 1.1 Decisions (summary)

| # | Decision | Status |
|---|---|---|
| D1 | Icing is a **separate risk indicator**; it does **not** affect the flight verdict, planner or confidence by default. Settings option "Include icing in the flight verdict" (off by default). | Decided |
| D2 | Icing exposed **only during climb or descent** is shown **red**, with a clear note ("climb only: ~3 min through 150–300 m above ground"). | Decided |
| D3 | Defaults: flight altitude **950 hPa level (~300–450 m above ground over most of Ukraine)**, climb **2 m/s**, descent **2 m/s**, flight duration **2 h**. Fallback default 925 hPa (~550–650 m AGL) if Phase 0 shows 950 hPa missing for too many selected models. | Decided, default level pending V1 |
| D4 | **One altitude setting** ("Flight altitude") for wind arrows, calculator wind and icing: feasible because wind and icing come from the same pressure level (§5). | Decided, pending V1/V2 |
| D5 | Forecast-tab icing uses a **separate deterministic request** (not merged into existing requests): merging saves at most ~1 call per update in Models mode and nothing in Ensemble mode (§6). | Decided |
| D6 | Calculator icing at the flight level is **added to the existing route-wind request at no extra API cost** (§6). The climb/descent column at A reuses the forecast-tab data when A is in the forecast location's area, otherwise one small extra request. | Decided |
| D7 | Icing comes from **deterministic models only** (Models-mode selection), also in Ensemble mode: on Open-Meteo only the ECMWF ensembles have pressure-level temperature/humidity (§4.3). | Decided |
| D8 | Vertical velocity is **not used** in v1. | Decided |
| D9 | Freezing fog / sub-zero low stratus is added as its own surface cue (missing in v2.1). | Decided |
| D10 | Thresholds are experimental defaults, configurable under advanced settings, to be tuned after Phase 0 (§7.4). | Decided (values provisional) |

---

## 2. Scope, assumptions, non-goals

**Context.** FlySky is a static, browser-only PWA (no server). Weather comes from Open-Meteo's free API (limits: 600 calls/minute, 5,000/hour, 10,000/day, shared by all features), satellite imagery from EUMETSAT EUMETView. All logic runs on the device.

**Objectives**
- Screen the atmosphere along altitude, position and time, not surface weather alone.
- Local flight-profile screening (forecast tab) and route screening (calculator).
- Keep evidence, exposure and the operational verdict separate (D1).
- Show provenance in the details: model, forecast hour, level used, actual height of the level above ground, missing data.

**Non-goals (v1)**
- Ice mass, accretion rate, calibrated probability or severity.
- Certifying a route or hour as ice-free.
- Replacing official aviation products or operator judgement.
- Sub-grid resolution, free (interpolated) altitudes (§5.4), audit logs / machine-readable export, single exposure index (§8).

**Simplifications vs v2.1**
- Altitudes are above ground (AGL), computed as level geopotential height − location elevation (both returned by Open-Meteo). No AMSL datum handling in the UI.
- One cruise altitude per flight/route (no per-leg altitude profile).
- Turns, loiter patterns and alternate routes are not modelled; the calculator's round trip is outbound + return along the same line.

---

## 3. Shared processing architecture (FlySky)

```text
[ Settings: Flight profile ]  altitude level · climb · descent · duration · (airspeed in calculator)
            │
            ├── Forecast tab ──► icing request (deterministic, selected models, 1 location)
            │                       │
            └── Calculator ──────► route-wind request (+ T/RH/gph at flight level, same call cost)
                                    + column at A (reuse forecast data or 1 small request)
            │
            ▼
[ icing.js — engine ]
   ├── profile builder: levels → height AGL (gph − elevation), mask levels below ground
   ├── evidence per model / level / hour (§7)
   ├── band evaluation (worse of the two bracketing levels, no RH interpolation)
   ├── exposure: climb / cruise / descent timing (Mode A) or route samples (Mode B)
   └── agreement across models (share per state)
            │
            ▼
[ UI ]  forecast: Icing row · strip · height-time chart · details      calculator: coloured route · panel line
```

`icing.js` is loaded on demand like `hazard.js`, versioned (`?v=`) in `index.html` and `sw.js`.

---

## 4. Weather data — what Open-Meteo provides

Verified from the Open-Meteo website documentation source (github.com/open-meteo/open-meteo-website, docs pages, state of 2026-11-04). **Not yet verified with live API calls** (see §11): open-meteo.com was blocked in the development session and the API daily limit from that environment was used up.

### 4.1 Deterministic models (FlySky Models-mode list)

Pressure levels offered at or below 700 hPa (≈ 3 km), by provider docs page. Approximate heights are the standard atmosphere above sea level; above ground over Ukrainian lowlands (100–250 m) subtract the terrain.

| Level | ≈ height ASL | DWD ICON (`icon_seamless`) | ECMWF IFS 0.25° (`ecmwf_ifs025`) | ECMWF AIFS (`ecmwf_aifs025_single`) | Météo-France (`meteofrance_seamless`) | UK Met Office (`ukmo_seamless`) | NOAA GFS (`gfs_seamless`) | GEM (`gem_seamless`) | JMA (`jma_seamless`) |
|---|---|---|---|---|---|---|---|---|---|
| 1000 hPa | 110 m | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 975 hPa | 320 m | ✓ | — | — | — | ✓ | ✓ | — (985, 970) | ✓ |
| 950 hPa | 540 m | ✓ | — | — | ✓ | ✓ | ✓ | ✓ | ✓ |
| 925 hPa | 760 m | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 900 hPa | 990 m | ✓ | — | — | ✓ | ✓ | ✓ | ✓ | ✓ |
| 850 hPa | 1460 m | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 800 hPa | 1950 m | ✓ | — | — | ✓ | ✓ | ✓ | ✓ | ✓ |
| 700 hPa | 3010 m | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

Extra intermediate levels exist for some (GFS every 25 hPa; GEM 985/970/875; Météo-France/UKMO 750). Seamless models combine regional and global components; the levels actually returned for Ukraine may differ from the provider page (V1).

**Per pressure level:** `temperature`, `relative_humidity`, `dew_point`, `cloud_cover`, `wind_speed`, `wind_direction`, `geopotential_height`; `vertical_velocity` for ECMWF, UKMO, GFS, JMA (not ICON, Météo-France, GEM).

**Height levels (no humidity):** `temperature_80m/120m/180m` — ICON (all three), GEM (80, 120), GFS (80). Wind at 80/100/120/180/200 m depending on the model. **There is no relative humidity at height levels**; humidity exists only at 2 m and on pressure levels.

**Surface:** `temperature_2m`, `relative_humidity_2m`, `dew_point_2m`, `weather_code`, `cloud_cover_low`, `visibility` (ICON, ECMWF, UKMO, GFS listed; not Météo-France, GEM, JMA), `freezing_level_height` (ICON, UKMO, GFS listed), `surface_pressure`.

### 4.2 How fields are derived (affects their value as evidence)

| Field | Derivation (per Open-Meteo docs) | Consequence |
|---|---|---|
| ECMWF IFS HRES 9 km | **No pressure-level fields**; only the 0.25° open-data models have them. | Confirmed v2.1. FlySky's Models list already uses `ecmwf_ifs025`. |
| Pressure-level `cloud_cover` | Estimated from pressure-level relative humidity (Sundqvist et al. 1989). | Not independent evidence; **not used**. |
| Relative humidity | Native on pressure levels for ICON, Météo-France, UKMO, GFS, GEM, JMA. ECMWF: 2 m RH from 2 m temperature and dew point; AIFS pressure levels from specific humidity. | Whether RH below 0 °C is relative to water or (partly) to ice may differ by model → V3. |
| `weather_code` | **ICON: native DWD WW code** (adjusted by Open-Meteo). ECMWF, Météo-France, UKMO, GFS, GEM, JMA: **computed by Open-Meteo** from cloud cover, temperature, precipitation, snowfall, CAPE etc. | Freezing-precipitation / rime-fog codes are a model-diagnosed cue only for ICON; for the others a weak derived cue (shown with its source). → V4. |
| `vertical_velocity` | ECMWF omega (Pa/s) **converted by Open-Meteo to m/s**. | v2.1's "negative omega = upward" does not apply to the API output; sign/unit to confirm. Not used in v1 (D8). |
| ECMWF IFS 0.25° time step | 3-hourly (later 6-hourly) at source. | How hourly values are returned for pressure levels → V6. |

### 4.3 Ensemble models

Pressure-level temperature/humidity/height are listed only for the **ECMWF IFS 0.25° ensemble and AIFS ensemble** (levels 1000, 925, 850, 700 hPa). ICON-EU EPS, GFS ensemble and others list none. Ensemble icing would therefore be ECMWF-only, coarse in the vertical, and costly (51 members × variables). **Decision D7:** icing from the deterministic models in both forecast modes.

---

## 5. Flight profile and the altitude setting

### 5.1 One altitude setting (D4)

The existing wind height setting (shared by wind arrows and calculator) becomes **Flight altitude** in a new **Flight profile** settings section (side menu, both views); the calculator keeps a selector for it. Wind and icing at a pressure level come from the same level, so one setting serves both.

| Option | Data source for wind | Data source for icing | Models missing the level (icing handling) |
|---|---|---|---|
| 10 m | 10 m | surface cues only (2 m T/RH, fog, codes) | — |
| ~120 m | 120 m height level | T: 120 m where available (ICON, GEM), else between 2 m and 1000 hPa; RH: 2 m and 1000 hPa (no RH at height levels) — lower confidence | — |
| ~300 m (new) | 975 hPa | 975 hPa | ECMWF IFS/AIFS, Météo-France, GEM → bracketing levels |
| **~500 m (default)** | **950 hPa** | **950 hPa** | ECMWF IFS/AIFS → 1000 & 925 hPa (worse of the two) |
| ~800 m | 925 hPa | 925 hPa | — |
| ~1000 m (new) | 900 hPa | 900 hPa | ECMWF IFS/AIFS → 925 & 850 |
| ~1500 m | 850 hPa | 850 hPa | — |
| ~2000 m (optional) | 800 hPa | 800 hPa | ECMWF → 850 & 700 |
| ~3000 m (optional) | 700 hPa | 700 hPa | — |

- **Labels** show the approximate height **above ground at the current location** once data is known (e.g. "950 hPa · ~370 m above ground here"), from geopotential height − elevation; the nominal "~500 m" label is used before that.
- **Wind** for a model missing the level: excluded (as today); the wind-aloft confidence logic already imputes missing factors.
- **Icing** for a model missing the level: evaluated on the two bracketing levels it has, taking the worse state, and marked "coarse levels" in the details.
- **Default (D3):** 950 hPa — the fixed level nearest to the requested 300–600 m: ≈ 540 m ASL, i.e. ≈ 300–450 m above ground over most of Ukraine (lower over high ground or in deep lows). If Phase 0 shows 950 hPa missing for too many of the selected models, use 925 hPa (≈ 550–650 m AGL, offered by all models).
- Existing users keep their stored wind height; new users start at 950 hPa (wind arrows then also default to ~500 m instead of 120 m).
- The forecast tab's existing **wind-aloft factor** (1000+925 hPa pooled in Ensemble mode, 950 hPa in Models mode) is **not changed** in this work (open item O1).

### 5.2 Profile parameters and defaults

| Setting | Default | Range | Used by |
|---|---|---|---|
| Flight altitude | 950 hPa (~500 m) | §5.1 options | wind arrows, calculator wind + icing, forecast icing |
| Climb rate | 2 m/s | 0.5–10 m/s | climb exposure (Mode A and B) |
| Descent rate | 2 m/s | 0.5–10 m/s | descent exposure |
| Flight duration | 2 h | 15 min – 6 h | Mode A cruise time |
| Airspeed | 22 m/s (existing calculator setting, 18–30) | — | Mode B timing |
| Include icing in the flight verdict | off | on/off | D1 |
| Icing thresholds (advanced, "experimental") | §7.4 | — | engine |

Example: climb to 400 m above ground at 2 m/s ≈ 3.3 min; the same for descent.

### 5.3 Vertical handling

- Height above ground of a level = `geopotential_height_XhPa − elevation` (elevation from the API response).
- Levels with height above ground < 20 m (below or at model ground) are masked as invalid, never treated as real samples.
- No vertical interpolation of humidity for decisions: an altitude band between two valid levels takes the **worse** state of the two (conservative; cloud layers are not linear in RH).
- 2 m values describe the ground layer (0 m).
- No extrapolation above the highest requested level.

### 5.4 Not in v1: free altitude

A free AGL altitude (e.g. 450 m) would need interpolation between bracketing levels for wind and icing. In the route request that means two levels × (wind 2 + T + RH + gph) = 10 variables — still one call per location — but adds complexity and pretends precision the models' vertical resolution doesn't have. Revisit after v1 (O2).

---

## 6. API requests and call budget

### 6.1 How Open-Meteo counts calls

From the Open-Meteo pricing page (and its calculator code): per location,

```
weight = max(1, variables × models / 10)                 for up to 14 days
weight = max(1, variables × models / 10 × days / 14)     beyond 14 days
total  = weight × number of locations
```

So a request costs **at least 1 call per location**; adding variables is free only while `variables × models ≤ 10`. Merging two requests that are each ≥ 1 call saves only the variables they share.

### 6.2 Current FlySky requests and icing additions

| Request | Today | With icing | Call impact | Decision |
|---|---|---|---|---|
| Ensemble forecast (ensemble API) | ≈ 120 calls/update (4 default ensembles) | — (no icing here) | 0 | D7 |
| Models-mode forecast (forecast API, 6 vars × 5 models) | 3 calls/update | — | 0 | — |
| **Icing request** (forecast API, selected Models-mode models, 1 location) | — | T, RH and gph from 1000 hPa up to one level above the flight level (default 1000/975/950/925 → 12) + 2 m T, 2 m RH, weather code, visibility, low cloud (5) = **17 vars × 5 models ≈ 8.5 calls** (8 models ≈ 13.6) | +8.5 per update, cached like the forecast (1 h) | D5: separate request |
| — merged into Models-mode request instead | | shared vars only visibility + low cloud | saves ≈ 1 call/update, Models mode only; Ensemble mode can't merge (different endpoint) | **not worth the coupling** |
| **Route wind** (forecast API, best_match, ≤ 16 locations, 2 vars) | max(1, 0.2) × 16 = **16 calls** per new route (cells cached 30 min) | + T, RH, gph at flight level = 5 vars → 0.5 → still 1 per location | **0** | D6: piggyback |
| Column at A (and B for one-way) | — | reuse forecast icing data if A is within the forecast location's 0.1° cell and the hours are covered; else 1 location × ~14 vars × 1 model ≈ 1.4 calls (2.8 for A+B) | small, only when needed | D6 |
| *Option:* 2 models in the route request | | 2 models × 5 vars = 10 → still 1 per location | 0, but wind then from named models instead of best_match | O3 (decide after V2) |
| *Option:* icing marks on the wind-arrow grid | arrows: 2 vars per location | + T, RH at flight level = 4 vars | 0 | O4 (later) |
| Map readout (crosshair) | 6 vars × models | + T, RH at flight level | +≈1 call per read | not in v1 |

---

## 7. Meteorological evidence

### 7.1 Dew point (kept from v2.1)

Magnus approximation (T in °C, RH in %):

γ = ln(RH/100) + 17.625·T / (243.04 + T),  T_d = 243.04·γ / (17.625 − γ),  ΔT = T − T_d

Used for display and for normalising humidity if Phase 0 shows inconsistent RH conventions (V3). RH and dew-point depression are not counted as two independent pieces of evidence.

### 7.2 Evidence states (per model, per level or band, per hour)

| State | Meaning | UI colour |
|---|---|---|
| `POTENTIAL ICING ENVIRONMENT — LWC UNKNOWN` | sub-freezing air with near-saturation (cloud environment likely), supercooled liquid not known | red |
| `FREEZING FOG / LOW STRATUS` (new, D9) | sub-zero near-ground fog or saturated low layer | red |
| `FREEZING PRECIPITATION INDICATOR` | weather code 56/57/66/67 at the location and hour (ICON native, others derived) | red |
| `MARGINAL` | near a threshold (see §7.4) | yellow |
| `NO ICING INDICATION FROM AVAILABLE PROXIES` | none of the above; **not** "no icing" / "safe" | green, text "No icing signs in the forecast data" |
| `UNKNOWN / INSUFFICIENT DATA` | required fields missing, masked or not returned | grey |

`METEOROLOGICAL ICING HAZARD INDICATED` (v2.1) stays unavailable: no authoritative icing product is accessible client-side.

`CONFLICTING EVIDENCE` is expressed through model agreement: per hour, the share of models in each state; agreement < 60 % is shown as low confidence with the split (reusing FlySky's confidence levels: high ≥ 80 %, medium 60–80 %, low < 60 %). A model missing a level is evaluated from its bracketing levels (§5.1); a model with no usable data at all counts as unknown, not as "no indication".

### 7.3 Cues

- **Pressure-level evidence:** temperature and RH at each valid level (§5.3).
- **Freezing fog / low stratus (D9):** weather code 48 (depositing rime fog); or 2 m temperature ≤ 0 °C with visibility < 1000 m or 2 m RH ≥ 97 %; low cloud ≥ 70 % with the lowest valid level sub-zero and RH ≥ 90 % (already covered by the level evidence, reported as low stratus when below the flight altitude).
- **Freezing precipitation:** weather code 56/57 (freezing drizzle), 66/67 (freezing rain). A surface cue for the location and hour; **not** assigned to any altitude. Source shown ("ICON code" vs "derived by Open-Meteo").
- **Not used:** pressure-level cloud cover (RH-derived), vertical velocity (D8), freezing-level height (derived from the profile instead; optional context line on the chart).

### 7.4 Experimental thresholds (configurable, unvalidated)

| State | Default rule |
|---|---|
| Potential icing environment | −20 °C ≤ T ≤ 0 °C and RH ≥ 90 % |
| Marginal | −20 °C ≤ T ≤ +1 °C and 80 % ≤ RH < 90 %; or 0 °C < T ≤ +1 °C and RH ≥ 90 % (temperature uncertainty); or −30 °C ≤ T < −20 °C and RH ≥ 90 % (mostly glaciated, supercooled liquid possible) |
| No indication | otherwise, with T and RH available |

Labelled "experimental" in settings and details. To be reviewed with Phase 0 data (RH convention V3) and later observations (§12). Never presented as universal icing thresholds.

---

## 8. Mode A — Forecast tab (local flight profile)

### 8.1 Exposure for departure hour h

1. **Climb** at hour h: ground → flight altitude at the climb rate; time in each band = band thickness / climb rate.
2. **Cruise** at the flight altitude from h to h + duration (default 2 h → hours h, h+1, part of h+2).
3. **Descent** at h + duration: flight altitude → ground at the descent rate.
4. Surface cues (fog, freezing precipitation) at h and at h + duration.

Per model: the hour's state is the worst state met in any phase (D2: climb/descent-only exposure is red too). The details keep the phases apart: minutes of cruise in each state; bands crossed in climb/descent and the minutes in them; surface cues with their source. Agreement across models as in §7.2. Unknown time is reported, never scored as zero.

### 8.2 UI

- **"Can I fly now?" card:** a separate Icing row under the factor tiles (not one of the verdict tiles unless D1's option is on), e.g. "❄ Icing: potential icing environment at ~380 m (−3 °C, RH 96 %) · 4 of 5 models", or "❄ Icing: climb only — ~2 min through 150–300 m (freezing fog layer)". Follows the hour slider.
- **Flight conditions:** an Icing strip under the confidence strip, hours coloured by state; pinned-hour details list phases, levels, values and models.
- **Chart "Icing profile":** height (ground → one level above the flight altitude) by time; cells coloured by state (share of models), 0 °C line, flight-altitude line, climb/descent phases indicated; tooltip with T, RH and models per level.
- **Planner:** icing windows listed as warnings; excluded from "suitable" only when D1's option is on.
- **Option on (D1):** icing becomes a verdict factor (tile, breakdown bar, reasons, planner, confidence) like the others.

---

## 9. Mode B — Flight time calculator (route)

### 9.1 Profile

- Climb at A at the departure time (calculator's departure: now or +1–6 h).
- Outbound cruise A → (waypoints) → B at the flight altitude; each sample evaluated at its arrival time (existing wind-triangle timing).
- Return cruise B → A, then descent at A at the return ETA.
- If the return can't be computed (no wind data, no headway), the result says it covers the outbound leg only; descent is then evaluated at B as a one-way case.

### 9.2 Data

- Flight-level T, RH, gph added to the route-wind request (same samples, ≈ 15 km spacing, 0.1° cells, cached 30 min): no extra calls (§6).
- Climb/descent column at A (and B for one-way): forecast-tab data when A is in the forecast location's cell and the hours are covered; otherwise one small request (≈ 1.4 calls).
- Single model (`best_match`) unless O3 is adopted; the details say which model supplied the data.

### 9.3 UI

- Route line segments coloured by state (outbound); the tag gets a ❄ mark when icing is indicated.
- Panel line, e.g. "❄ Potential icing 15–32 km (≈ 25 min) at ~380 m, −4 °C, RH 95 % · climb at A through 150–300 m (~1 min)"; return leg summarised separately ("Back: no icing signs" / "Back: potential icing 8–20 km").
- Wind-triangle infeasibility stays as implemented (where/when/wind message).

---

## 10. Settings summary

New side-menu section **Flight profile** (shown in both views): flight altitude, climb rate, descent rate, flight duration; **Icing**: include in flight verdict (off), thresholds (advanced, experimental). The calculator's height selector edits the same flight altitude. Airspeed stays in the calculator.

---

## 11. Still to verify with live API calls (Phase 0)

Run against `api.open-meteo.com` at Ukrainian test points (e.g. Kyiv 50.45/30.52, Zaporizhzhia 47.86/35.81, a Carpathian point 48.16/24.50), ideally on a cold, cloudy day. Each item names the decision it affects.

| ID | Check | Request (sketch) | Affects |
|---|---|---|---|
| V1 | Which levels and variables each selected model **actually returns** for Ukraine (non-null), incl. 975/950/900 hPa, `temperature_120m`, `visibility`, `weather_code`, `freezing_level_height`; forecast horizon | `/v1/forecast?...&hourly=temperature_{1000..700}hPa,relative_humidity_…,dew_point_…,geopotential_height_…,temperature_2m,relative_humidity_2m,temperature_120m,weather_code,visibility,cloud_cover_low,surface_pressure&models=icon_seamless,ecmwf_ifs025,ecmwf_aifs025_single,meteofrance_seamless,ukmo_seamless,gfs_seamless,gem_seamless,jma_seamless&forecast_days=3&timezone=GMT` | D3 default level, D4 level options, §5.1 gaps |
| V2 | `best_match` (route request): which model supplies pressure-level T/RH/gph for Ukraine; same model as for the wind? multi-location + 2-model response format | route URL + `temperature_950hPa,relative_humidity_950hPa,geopotential_height_950hPa`, 4 locations; then with `models=icon_seamless,ecmwf_ifs025` | D6, O3 |
| V3 | RH convention below 0 °C per model: compare returned RH with RH computed from returned T and dew point (over water and over ice) at levels with T ≤ −5 °C | same as V1, compare columns | §7.4 thresholds, normalisation |
| V4 | Weather codes 48/56/57/66/67: do they occur, per model; ICON native vs derived; agreement with freezing-rain events (historical forecast API if available on the free tier) | V1 over several days/locations in winter | §7.3 cue weight |
| V5 | Geopotential height vs response `elevation`; values at levels below ground (Carpathian point); masking rule | V1 at 48.16/24.50 | §5.3 |
| V6 | Hourly behaviour of ECMWF IFS 0.25°/AIFS pressure-level fields (interpolated or null between 3-hourly steps) | V1, inspect hourly arrays | §8 hour evaluation |
| V7 | Ensemble API confirms no pressure-level T/RH for ICON-EU EPS / GFS ensemble | `ensemble-api/v1/ensemble?...&hourly=temperature_925hPa,relative_humidity_925hPa&models=icon_eu_eps,gfs_seamless` | D7 |
| V8 | `vertical_velocity` units/sign (only if reconsidered) | V1 + `vertical_velocity_925hPa` for ECMWF/GFS | D8 |
| V9 | Call weight as in §6.1 also for multi-location, multi-model requests on the free tier (no usage API; observe limit messages under load if needed) | — | §6 estimates |
| V10 | `icon_seamless` component used for pressure levels in Ukraine (ICON-EU vs global) and its level set | V1 | §5.1 |

Phase 0 needs access to api.open-meteo.com with daily quota available (the development session's quota was exhausted on the day this was written; open-meteo.com docs were blocked by the session's network policy — the docs facts above come from the website's source repository).

---

## 12. Validation and tests

**Automated (Playwright, mocked Open-Meteo), synthetic profiles:**
- cold and dry; sub-zero saturated layer at the flight altitude; layer only below (climb/descent only → red with note); layer above the flight altitude; two layers separated by dry air;
- freezing fog at ground (code 48; T2m ≤ 0 with low visibility); freezing rain code with dry profile (surface cue only);
- levels below ground (masked); model missing 950 hPa (bracketing); all models missing → unknown;
- models disagreeing (share/confidence); time progression within a 2 h flight;
- route: icing on part of the outbound leg, return leg different, return not computable (outbound only), A outside the forecast cell (extra column request), no extra calls for flight-level variables (request counts in the mock log);
- settings: defaults (950 hPa, 2/2 m/s, 2 h), verdict option off/on, one altitude setting shared by arrows/calculator/icing.

**Live sanity (Phase 0+):** spot checks on cold, cloudy days; compare model states with EUMETSAT imagery.

**Later (O5):** satellite cross-check for the current hour — FlySky already shows Cloud Type RGB (with a supercooled-water class) and Cloud Phase RGB; a note "satellite sees supercooled liquid cloud tops here" like the existing satellite-vs-forecast note.

**Meteorological validation** (thresholds, false alarms/misses) needs independent observations (PIREPs are US-centric; regional aviation products and operator reports for Ukraine) and is outside v1.

---

## 13. Implementation plan

| Phase | Work | Files |
|---|---|---|
| 0 | API verification V1–V10; fix default level, level options, thresholds | — |
| 1 | Engine: profile builder, masking, evidence states, band evaluation, Mode A exposure, route sample evaluation, agreement; unit tests with synthetic profiles | `icing.js`, tests |
| 2 | Settings "Flight profile" (altitude shared with wind arrows/calculator, climb, descent, duration, verdict option, thresholds); migration of the stored wind height | `index.html`, `map.js` |
| 3 | Forecast tab: icing request + cache, Icing row/strip/details, height-time chart, planner warnings, verdict option | `index.html`, `icing.js` |
| 4 | Calculator: flight-level variables in the route request, column at A/B, coloured segments, panel lines, return leg | `map.js`, `icing.js` |
| 5 | Optional: O3 (2-model route), O4 (icing marks on the wind grid), O5 (satellite cross-check) | — |

READMEs (en/uk/pt-BR) updated with each phase; `?v=` and service-worker cache bumped for changed scripts.

---

## 14. Open items

- **O1** Wind-aloft factor in the forecast tab to follow the flight altitude (currently fixed levels).
- **O2** Free AGL altitude with interpolation (§5.4).
- **O3** Two models in the route request (no extra cost; changes the wind source).
- **O4** Icing marks on the wind-arrow grid at the flight level (no extra cost).
- **O5** Satellite supercooled-cloud cross-check for the current hour.
- **O6** Threshold tuning after Phase 0 and with operator feedback.

---

## 15. Changes from v2.1

1. Mapped the two modes onto FlySky: forecast tab (Mode A extended to climb + cruise + descent with a 2 h default duration) and the flight time calculator (Mode B).
2. Recorded decisions D1–D10 (separate indicator, climb-only = red with note, defaults, one altitude setting, request strategy, deterministic-only icing, no vertical velocity, freezing fog cue, experimental thresholds).
3. Added verified Open-Meteo facts: level availability per model, no humidity at height levels, RH-derived pressure-level cloud cover, weather codes native only for ICON, vertical velocity converted to m/s, ensemble pressure levels only for ECMWF.
4. Corrected v2.1 §5.3: the API returns vertical velocity in m/s (converted from omega), so the omega sign rule does not apply to it.
5. Added freezing fog / sub-zero low stratus — the most relevant icing case for low-level UAV operations — as a surface cue.
6. Added the Open-Meteo call-weight formula and per-request cost estimates; merging the forecast icing data into existing requests is not worth it, the route data piggybacks for free.
7. Replaced vertical interpolation of humidity with worst-of-bracketing-levels evaluation.
8. Dropped the ordinal exposure index from the UI in favour of durations, bands and model agreement.
9. Added the Phase 0 verification list (§11) and FlySky-specific tests (§12).

---

## 16. References

- Open-Meteo documentation source: github.com/open-meteo/open-meteo-website (`src/routes/en/docs/*`, `src/routes/en/pricing`) — ECMWF, DWD, Météo-France, UKMO, GFS, GEM, JMA, Ensemble API pages; WMO code subset in `wmo-codes-table.svelte`.
- Open-Meteo API: https://api.open-meteo.com/v1/forecast, https://ensemble-api.open-meteo.com/v1/ensemble
- Sundqvist, H., Berge, E., Kristjánsson, J.E. (1989): Condensation and cloud parameterization studies with a mesoscale NWP model (pressure-level cloud cover derivation used by Open-Meteo).
- WMO 4677 present-weather code table (subset emitted by Open-Meteo: 0–3, 45, 48, 51–57, 61–67, 71–77, 80–82, 85–86, 95, 96, 97, 99).
- ECMWF IFS open data (0.25°) pressure-level fields; DWD ICON open data.
- FAA Aviation Weather Handbook / AWC icing guidance (US reference only).

*END OF TECHNICAL HANDOFF DOCUMENT v2.2 — FLYSKY INTEGRATION*
