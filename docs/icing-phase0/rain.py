# Rain / snow split per model (v2.7 ICON rain cue): is `rain` ever > 0 with a 2 m temperature ≤ 0 °C (freezing rain / drizzle
# possible)? Last winter at Kyiv and Zaporizhzhia, ICON and UKMO, one model per request. About 15 calls.
import sys
sys.path.insert(0, ".")
from om import get
V = 'precipitation,rain,showers,snowfall,temperature_2m,weather_code'
for name, (la, lo) in {'kyiv': (50.45, 30.52), 'zap': (47.86, 35.81)}.items():
    for m in ('icon_seamless', 'ukmo_seamless'):
        b, h = get('historical-forecast-api.open-meteo.com', '/v1/forecast', {'latitude': la, 'longitude': lo, 'hourly': V, 'models': m,
            'start_date': '2025-12-01', 'end_date': '2026-02-28', 'timezone': 'GMT'}, f'rain_{name}_{m}')
        if b.get('error'): print(name, m, 'ERROR', b.get('reason')); continue
        hr = b['hourly']; n = len(hr['time'])
        have = {v: sum(1 for x in hr[v] if x is not None) for v in V.split(',')}
        cold = [i for i in range(n) if (hr['precipitation'][i] or 0) > 0 and hr['temperature_2m'][i] is not None and hr['temperature_2m'][i] <= 0]
        rain_cold = [i for i in cold if (hr['rain'][i] or 0) > 0 or (hr['showers'][i] or 0) > 0]
        codes = sum(1 for i in rain_cold if hr['weather_code'][i] in (56, 57, 66, 67))
        warm = [i for i in range(n) if (hr['precipitation'][i] or 0) > 0 and hr['temperature_2m'][i] is not None and hr['temperature_2m'][i] > 0]
        snow_warm = sum(1 for i in warm if (hr['snowfall'][i] or 0) > 0)
        tmin = min((hr['temperature_2m'][i] for i in rain_cold), default=None)
        print(f'{name:4} {m:14} values {have} | precip & T2m≤0: {len(cold):4} h, rain/showers > 0 there: {len(rain_cold):4} (coldest {tmin}) , with a freezing code: {codes} | precip & T2m>0: {len(warm)} h, snow there: {snow_warm}')
