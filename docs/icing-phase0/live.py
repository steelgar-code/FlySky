# Phase 0 against the live forecast API (V1, V2, V5, V6, V9, V10). About 160 calls.
# Every response is saved in data/ with its X-RateLimit-Cost (data/costs.tsv);
# a saved response is never fetched again.
import sys, time
sys.path.insert(0, '.')
from om import get

MODELS = 'icon_seamless,ecmwf_ifs025,ecmwf_aifs025_single,meteofrance_seamless,ukmo_seamless,gfs_seamless,gem_seamless,jma_seamless'
PTS = {'kyiv': (50.45, 30.52), 'zap': (47.86, 35.81), 'carp': (48.16, 24.50)}

def stop_if_limited(body, what):
    if isinstance(body, dict) and body.get('error'):
        print(what, 'ERROR', body.get('reason'))
        if 'limit' in str(body.get('reason', '')).lower():
            sys.exit(2)
        return True
    return False

# ---- V1 / V5 / V6 / V10: what the forecast API returns, 8 days like FlySky
LEVELS = [1000, 985, 975, 970, 950, 925, 900, 875, 850, 800, 700]
pl = [f'{v}_{l}hPa' for l in LEVELS for v in ('temperature', 'relative_humidity', 'geopotential_height')]
pl += [f'dew_point_{l}hPa' for l in (925, 850, 700)]
sfc = ['temperature_2m', 'relative_humidity_2m', 'dew_point_2m', 'temperature_80m', 'temperature_120m', 'temperature_180m',
       'weather_code', 'visibility', 'cloud_cover_low', 'freezing_level_height', 'surface_pressure', 'pressure_msl']
for name, (la, lo) in PTS.items():
    body, _ = get('api.open-meteo.com', '/v1/forecast', {
        'latitude': la, 'longitude': lo, 'hourly': ','.join(pl + sfc), 'models': MODELS,
        'forecast_days': 8, 'timezone': 'GMT'}, f'live_v1_{name}')
    stop_if_limited(body, f'V1 {name}')
    time.sleep(1)

# ---- V2 / V9: route-style requests (best_match, several locations)
route4 = [(50.45, 30.52), (50.55, 30.72), (50.65, 30.92), (50.75, 31.12)]
lat = ','.join(str(p[0]) for p in route4); lon = ','.join(str(p[1]) for p in route4)
icing_flight = 'wind_speed_950hPa,wind_direction_950hPa,temperature_950hPa,relative_humidity_950hPa,geopotential_height_950hPa'
for tag, extra in [('live_v2_bm4', {}), ('live_v2_2m4', {'models': 'icon_seamless,ecmwf_ifs025'})]:
    body, _ = get('api.open-meteo.com', '/v1/forecast', {'latitude': lat, 'longitude': lon, 'hourly': icing_flight,
        'forecast_days': 2, 'timezone': 'GMT', 'wind_speed_unit': 'ms', **extra}, tag)
    stop_if_limited(body, tag)
    time.sleep(1)
# best_match at Kyiv, every low level: which levels does best_match have, and from which model
bm_levels = ','.join(f'{v}_{l}hPa' for l in (1000, 975, 950, 925, 900, 850) for v in ('temperature', 'relative_humidity'))
body, _ = get('api.open-meteo.com', '/v1/forecast', {'latitude': 50.45, 'longitude': 30.52, 'hourly': bm_levels + ',wind_speed_950hPa,wind_speed_120m,temperature_120m',
    'forecast_days': 8, 'timezone': 'GMT', 'wind_speed_unit': 'ms'}, 'live_v2_bm_kyiv')
stop_if_limited(body, 'V2 best_match Kyiv')
time.sleep(1)
# today's route request shape: 16 locations x 2 variables (expected cost 16)
r16 = [(50.45 + 0.1 * k, 30.52 + 0.1 * k) for k in range(16)]
body, _ = get('api.open-meteo.com', '/v1/forecast', {'latitude': ','.join(f'{a:.2f}' for a, _ in r16), 'longitude': ','.join(f'{b:.2f}' for _, b in r16),
    'hourly': 'wind_speed_950hPa,wind_direction_950hPa', 'forecast_days': 2, 'timezone': 'GMT', 'wind_speed_unit': 'ms'}, 'live_v9_r16_2v')
stop_if_limited(body, 'V9 r16 2 vars')
time.sleep(1)
# same with the flight-level icing variables (expected still 16)
body, _ = get('api.open-meteo.com', '/v1/forecast', {'latitude': ','.join(f'{a:.2f}' for a, _ in r16), 'longitude': ','.join(f'{b:.2f}' for _, b in r16),
    'hourly': icing_flight, 'forecast_days': 2, 'timezone': 'GMT', 'wind_speed_unit': 'ms'}, 'live_v9_r16_5v')
stop_if_limited(body, 'V9 r16 5 vars')
time.sleep(1)
# the proposed forecast-tab icing request, 5 default models (expected 8.5)
icing_vars = [f'{v}_{l}hPa' for l in (1000, 975, 950, 925) for v in ('temperature', 'relative_humidity', 'geopotential_height')]
icing_vars += ['temperature_2m', 'relative_humidity_2m', 'weather_code', 'visibility', 'cloud_cover_low']
body, _ = get('api.open-meteo.com', '/v1/forecast', {'latitude': 50.45, 'longitude': 30.52, 'hourly': ','.join(icing_vars),
    'models': 'icon_seamless,ecmwf_ifs025,ecmwf_aifs025_single,meteofrance_seamless,ukmo_seamless',
    'forecast_days': 8, 'timezone': 'auto'}, 'live_v9_icing5')
stop_if_limited(body, 'V9 icing request')
time.sleep(1)

# Last winter (V3, V4, flag rates): winter.py — one model per request.
print('done')
