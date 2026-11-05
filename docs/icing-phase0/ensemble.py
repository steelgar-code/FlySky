# V7: which ensemble models of the Ensemble API return pressure-level temperature / humidity, and at which
# low levels. About 160 calls (every member of every variable counts, null columns too).
import sys
sys.path.insert(0, '.')
from om import get

def cost(h):
    return next((l.split(':', 1)[1].strip() for l in h.splitlines() if l.lower().startswith('x-ratelimit-cost')), '?')

ENS = ['icon_eu_eps', 'icon_seamless', 'ecmwf_ifs025', 'ecmwf_ifs_europe_ensemble', 'ecmwf_aifs025', 'google_weathernext2_ensemble',
       'gfs_seamless', 'ukmo_global_ensemble_20km', 'gem_global', 'bom_access_global_ensemble']
print('925 hPa temperature / relative humidity: member columns with any value')
for m in ENS:
    body, h = get('ensemble-api.open-meteo.com', '/v1/ensemble', {'latitude': 50.45, 'longitude': 30.52,
        'hourly': 'temperature_925hPa,relative_humidity_925hPa', 'models': m, 'forecast_days': 1, 'timezone': 'GMT'}, f'v7_{m}')
    if body.get('error'): print(f'{m:32} ERROR {body.get("reason")}'); continue
    hr = body['hourly']
    t = [k for k in hr if k.startswith('temperature')]; r = [k for k in hr if k.startswith('relative')]
    nn = lambda ks: sum(1 for k in ks if any(v is not None for v in hr[k]))
    print(f'{m:32} cost {cost(h):>5}  T {nn(t):3}/{len(t):3}  RH {nn(r):3}/{len(r):3}')

LV = [1000, 975, 950, 900]
print('\nOther low levels, for the ensembles that have 925 hPa')
for m in ['ecmwf_ifs025', 'ecmwf_aifs025', 'google_weathernext2_ensemble', 'gfs_seamless']:
    body, h = get('ensemble-api.open-meteo.com', '/v1/ensemble', {'latitude': 50.45, 'longitude': 30.52,
        'hourly': ','.join(f'temperature_{l}hPa' for l in LV), 'models': m, 'forecast_days': 1, 'timezone': 'GMT'}, f'v7b_{m}')
    if body.get('error'): print(m, 'ERROR', body.get('reason')); continue
    hr = body['hourly']
    res = {l: any(v is not None for v in hr.get(f'temperature_{l}hPa', [None])) for l in LV}
    print(f'{m:30} cost {cost(h):>5} ' + '  '.join(f'{l}:{"yes" if ok else "—"}' for l, ok in res.items()))
