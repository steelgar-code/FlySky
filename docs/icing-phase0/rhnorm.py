# V3: does the RH convention explain the spread between models? Converts ice / blended RH to RH over water
# (ECMWF's documented rule for IFS/AIFS/GFS, ice below 0 °C assumed for MF/JMA) and recounts the red hours.
import math, sys
sys.path.insert(0, '.')
import importlib.util
from collections import Counter
spec = importlib.util.spec_from_file_location('an', 'analyze.py')
import io, contextlib
with contextlib.redirect_stdout(io.StringIO()):
    an = importlib.util.module_from_spec(spec); spec.loader.exec_module(an)
def esw(t): return 6.112 * math.exp(17.62 * t / (243.12 + t))
def esi(t): return 6.112 * math.exp(22.46 * t / (272.62 + t))
def ecmwf_mixed(t):   # IFS: water above 0 °C, ice below −23 °C, quadratic blend between
    if t >= 0: return esw(t)
    if t <= -23: return esi(t)
    a = ((t + 23) / 23) ** 2
    return a * esw(t) + (1 - a) * esi(t)
CONV = {'ecmwf_ifs025': ecmwf_mixed, 'ecmwf_aifs025_single': ecmwf_mixed, 'meteofrance_seamless': esi, 'gfs_seamless': ecmwf_mixed, 'jma_seamless': esi}
for name, b in an.W.items():
    if not b: continue
    per = an.split(b); n = len(b['hourly']['time']); elev = b['elevation']
    print(f'-- {name}: cruise red at 950 hPa (2m=fog), reported RH vs RH converted to water (IFS/AIFS/GFS: ECMWF blend; MF/JMA: ice below 0 °C — assumption)')
    out = []
    for m in an.MODELS:
        if not per[m]: continue
        v = dict(per[m])
        raw = sum(1 for x in an.model_hours(v, elev, n, two_m='fog') if x[0] == 'red') / n
        f = CONV.get(m)
        if f:
            for L in (1000, 975, 950, 925):
                t = v.get(f'temperature_{L}hPa'); r = v.get(f'relative_humidity_{L}hPa')
                if t and r: v[f'relative_humidity_{L}hPa'] = [None if (T is None or R is None) else R * f(T) / esw(T) for T, R in zip(t, r)]
        conv = sum(1 for x in an.model_hours(v, elev, n, two_m='fog') if x[0] == 'red') / n
        rh = [R for T, R in zip(v.get('temperature_925hPa', []), v.get('relative_humidity_925hPa', [])) if T is not None and R is not None and -20 <= T <= 0]
        out.append(f'{an.SHORT[m]} {100*raw:4.1f}→{100*conv:4.1f}% (RH925 p50 in −20..0 °C: {an.q(rh, .5):.0f})')
    print('   ' + '\n   '.join(out))
