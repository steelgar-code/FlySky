# Icing forecast — Phase 0 API checks

Scripts behind §11 of [the icing handoff](../icing-forecast-handoff.md): what Open-Meteo actually returns
for the icing indicator, what it costs, and how the proposed rules behave on last winter's data.
Not part of the app (nothing here is loaded by it). [`results.txt`](results.txt) is the output of the run on 2026-11-05.

| Script | Checks | Host | Calls |
|---|---|---|---|
| `live.py` | V1 levels / variables / forecast length, V2 `best_match` and multi-location format, V5 heights and below-ground values, V6 hourly steps, V9 costs, V10 ICON component | `api.open-meteo.com` | ≈ 160 |
| `winter.py` | Dec 2025 – Feb 2026 at Kyiv and Zaporizhzhia, 8 models: V3 RH conventions, V4 weather codes, flag rates | `historical-forecast-api.open-meteo.com` | ≈ 280 |
| `ensemble.py` | V7 pressure-level temperature / humidity in the ensembles | `ensemble-api.open-meteo.com` | ≈ 160 |
| `rain.py` | the models' rain / snow split below 0 °C at 2 m (ICON has rain there, UKMO's split follows the 2 m temperature) — the v2.7 ICON rain cue | `historical-forecast-api.open-meteo.com` | ≈ 15 |
| `analyze.py` | tables for V1–V6, V9, V10, flag rates, 950 vs 925 hPa | — (saved data) | 0 |
| `rhnorm.py` | V3: red hours with RH converted to RH over water | — | 0 |
| `select.py` | one or two models instead of the 5-model consensus (§7.6) | — | 0 |
| `layers.py` | how far 950 hPa drifts from a fixed 400 m above the ground (§5.1); the icing layers in winter (§7.7) | — | 0 |
| `engine_check.mjs` | the app's engine (`../../icing.js`) on the same data: cross-check with the Python numbers, and what it reports for the saved forecasts ([`engine_check.txt`](engine_check.txt)) | — | 0 |

```sh
cd docs/icing-phase0
python3 live.py && python3 winter.py && python3 ensemble.py && python3 rain.py
python3 analyze.py; python3 rhnorm.py; python3 select.py; python3 layers.py
node engine_check.mjs
```

Python 3 and `curl` (and Node for `engine_check.mjs`). Every response is saved in `data/` (ignored by git, ≈ 6 MB) with its headers;
`data/costs.tsv` logs each request's `X-RateLimit-Cost`. A saved response is never fetched again, so a
run can be resumed; delete `data/` for fresh data. `P0_DATA=<folder>` uses another data folder.

Notes from the first run:
- Open-Meteo's daily limit (10,000) is per IP and shared by the forecast, historical-forecast, previous-runs and
  single-runs hosts; the ensemble host counts separately. From a shared cloud IP it can be used up for most of
  the day — run right after 00:00 UTC.
- The historical-forecast host fails with `Unexpected error while streaming data: timeoutReached` (and still bills
  the request) when 8 models × 27 variables are asked for in one request; one model per request works in about a second.
- In the 2026-11-05 run GEM and JMA were not fetched for Zaporizhzhia (not default models); `results.txt` has 6 models there.
- The winter data are archived early forecast hours: they show how often the models put such conditions there,
  not how good the forecasts are.
