# Design §5.1 and §7.7: how far 950 hPa drifts from a fixed 400 m above the ground, and the shape of the icing
# layers in winter (ICON, UKMO — both native 975/950/925/900/850 hPa, RH over water). Needs winter.py's data.
import io, contextlib, importlib.util
from collections import Counter
spec = importlib.util.spec_from_file_location('an', 'analyze.py')
with contextlib.redirect_stdout(io.StringIO()):
    an = importlib.util.module_from_spec(spec); spec.loader.exec_module(an)
LV = [975, 950, 925, 900, 850]
for name, b in an.W.items():
    per = an.split(b); n = len(b['hourly']['time']); e = b['elevation']
    print(f'=== {name} (elevation {e:.0f} m), winter 2025/26, {n} h')
    for m in ('icon_seamless', 'ukmo_seamless'):
        v = per[m]
        # Q1: which level is nearest to a fixed 400 m above ground, and how far away is 950 hPa from 400 m
        near = Counter(); off = []
        for i in range(n):
            hs = {L: v[f'geopotential_height_{L}hPa'][i] - e for L in (975, 950, 925) if v.get(f'geopotential_height_{L}hPa') and v[f'geopotential_height_{L}hPa'][i] is not None}
            if len(hs) < 3: continue
            near[min(hs, key=lambda L: abs(hs[L] - 400))] += 1; off.append(hs[950] - 400)
        k = sum(near.values())
        print(f'  {an.SHORT[m]}: Q1 nearest level to a fixed 400 m AGL: ' + ', '.join(f'{L} hPa {100*near[L]/k:.0f}%' for L in (975, 950, 925))
              + f' | 950 hPa minus 400 m: p5 {an.q(off,.05):+.0f} / p50 {an.q(off,.5):+.0f} / p95 {an.q(off,.95):+.0f} m')
        # Q3: icing layer per hour (red levels among 975–850, plus ground fog cue)
        rows = []; temps = Counter()
        for i in range(n):
            st = {}
            for L in LV:
                T = v.get(f'temperature_{L}hPa', [None]*n)[i]; R = v.get(f'relative_humidity_{L}hPa', [None]*n)[i]
                st[L] = an.state(T, R)
                if st[L] == 'red': temps[('0…−5' if T > -5 else '−5…−10' if T > -10 else '−10…−15' if T > -15 else '−15…−20')] += 1
            T2 = v['temperature_2m'][i]; R2 = v['relative_humidity_2m'][i]; vis = (v.get('visibility') or [None]*n)[i]; wc = v['weather_code'][i]
            fog = wc == 48 or (T2 is not None and T2 <= 0 and ((vis is not None and vis < 1000) or (R2 is not None and R2 >= 97)))
            red = [L for L in LV if st[L] == 'red']
            if not red and not fog: continue
            base = 'ground' if fog or (red and red[0] == 975) else red[0]
            top = red[-1] if red else 'ground'
            gaps = red and any(st[L] != 'red' for L in LV if red[0] > L > red[-1])   # pressure decreases upwards
            above = LV[LV.index(red[-1]) + 1] if red and red[-1] != 850 else None
            T_ab = v.get(f'temperature_{above}hPa', [None]*n)[i] if above else None
            R_ab = v.get(f'relative_humidity_{above}hPa', [None]*n)[i] if above else None
            rows.append(dict(base=base, top=top, gaps=gaps, clear_above=above is not None and st[above] == 'grn',
                             warm_or_dry_above=above is not None and T_ab is not None and (T_ab > 0 or (R_ab is not None and R_ab < 80))))
        k = len(rows)
        c_base = Counter(r['base'] for r in rows); c_top = Counter(r['top'] for r in rows)
        print(f'  {an.SHORT[m]}: Q3 hours with an icing layer (975–850 hPa or ground fog): {k} ({100*k/n:.0f}% of hours)')
        print(f'      base: ' + ', '.join(f'{x}: {100*c_base[x]/k:.0f}%' for x in ['ground', 950, 925, 900, 850]))
        print(f'      top:  ' + ', '.join(f'{x}: {100*c_top[x]/k:.0f}%' for x in ['ground', 975, 950, 925, 900, 850]))
        print(f'      clear below 400 m (base at 925 hPa or higher): {100*sum(1 for r in rows if r["base"] in (925, 900, 850))/k:.0f}%'
              f' | top below 850 hPa with no icing signs at the next level up: {100*sum(1 for r in rows if r["clear_above"])/k:.0f}%'
              f' (and dry or above 0 °C there: {100*sum(1 for r in rows if r["clear_above"] and r["warm_or_dry_above"])/k:.0f}%)'
              f' | layer reaches 850 hPa (~1.3 km) or above: {100*c_top[850]/k:.0f}% | two separate layers: {100*sum(1 for r in rows if r["gaps"])/k:.0f}%')
        tk = sum(temps.values())
        print(f'      temperature at red levels: ' + ', '.join(f'{x} °C {100*temps[x]/tk:.0f}%' for x in ['0…−5', '−5…−10', '−10…−15', '−15…−20']))
