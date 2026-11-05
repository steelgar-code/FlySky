# Last winter (Dec 2025 – Feb 2026) from the historical-forecast API for V3, V4 and the flag rates: one model
# per request (8 models in one archive request fail server-side with 'timeoutReached'). About 280 calls.
# Optional arguments: model ids to fetch (default: all 8).
import sys, time
sys.path.insert(0, '.')
from om import get
MODELS = ['icon_seamless', 'ecmwf_ifs025', 'ecmwf_aifs025_single', 'meteofrance_seamless', 'ukmo_seamless', 'gfs_seamless', 'gem_seamless', 'jma_seamless']
PTS = {'kyiv': (50.45, 30.52), 'zap': (47.86, 35.81)}
win = [f'{v}_{l}hPa' for l in (1000, 975, 950, 925, 900, 850, 500, 300) for v in ('temperature', 'relative_humidity')]
win += [f'geopotential_height_{l}hPa' for l in (1000, 975, 950, 925)]
win += ['temperature_2m', 'relative_humidity_2m', 'weather_code', 'visibility', 'cloud_cover_low', 'surface_pressure', 'precipitation']
only = sys.argv[1:] or MODELS
for name, (la, lo) in PTS.items():
    for m in only:
        t0 = time.time()
        body, _ = get('historical-forecast-api.open-meteo.com', '/v1/forecast', {'latitude': la, 'longitude': lo, 'hourly': ','.join(win),
            'models': m, 'start_date': '2025-12-01', 'end_date': '2026-02-28', 'timezone': 'GMT'}, f'hw_{name}_{m}')
        print(name, m, 'ERROR ' + str(body.get('reason')) if body.get('error') else 'ok', f'{time.time() - t0:.0f}s', flush=True)
        if body.get('error') and 'limit' in str(body.get('reason', '')).lower(): sys.exit(2)
        time.sleep(1)
