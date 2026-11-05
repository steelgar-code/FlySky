# Phase 0 analysis of the responses saved by live.py and winter.py (V1–V6, V9, V10, flag rates, 950 vs 925 hPa).
import json, os, math, sys
from collections import Counter, defaultdict
D = os.environ.get('P0_DATA') or os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data')
MODELS = ['icon_seamless', 'ecmwf_ifs025', 'ecmwf_aifs025_single', 'meteofrance_seamless', 'ukmo_seamless', 'gfs_seamless', 'gem_seamless', 'jma_seamless']
DEFAULT5 = MODELS[:5]
SHORT = {'icon_seamless': 'ICON', 'ecmwf_ifs025': 'IFS', 'ecmwf_aifs025_single': 'AIFS', 'meteofrance_seamless': 'MF',
         'ukmo_seamless': 'UKMO', 'gfs_seamless': 'GFS', 'gem_seamless': 'GEM', 'jma_seamless': 'JMA'}

def load(tag):
    p = os.path.join(D, tag + '.json')
    return json.load(open(p)) if os.path.exists(p) else None

def split(body, models=MODELS):
    """{model: {var: series}} from a multi-model response."""
    hr = body['hourly']; out = {m: {} for m in models}
    for k, s in hr.items():
        if k == 'time': continue
        m = next((m for m in sorted(models, key=len, reverse=True) if k.endswith('_' + m)), None)
        if m: out[m][k[:-len(m) - 1]] = s
    return out

def nn(s): return [v for v in s if v is not None]
def frac(s): return len(nn(s)) / len(s) if s else 0
def pct(x): return f'{100 * x:5.1f}%'
def q(vals, p):
    v = sorted(vals)
    if not v: return None
    i = (len(v) - 1) * p; lo = math.floor(i); hi = math.ceil(i)
    return v[lo] + (v[hi] - v[lo]) * (i - lo)

def es_w(t): return 6.112 * math.exp(17.62 * t / (243.12 + t))     # WMO/Magnus over water
def es_i(t): return 6.112 * math.exp(22.46 * t / (272.62 + t))     # over ice

section = lambda s: print('\n' + '=' * 100 + '\n' + s + '\n' + '=' * 100)

# ---------------------------------------------------------------- V9 costs
section('V9  X-RateLimit-Cost per request')
if os.path.exists(os.path.join(D, 'costs.tsv')):
    for line in open(os.path.join(D, 'costs.tsv')):
        tag, status, cost, *_ = line.rstrip('\n').split('\t')
        if '200 OK' not in status: continue          # refused (daily limit) or never reached the API
        note = '  (8 models in one archive request: stream failed "timeoutReached" — billed anyway)' if tag.startswith('hist_win') else ''
        print(f'{tag:34} cost {cost}{note}')

# ---------------------------------------------------------------- V1 availability
LEVELS = [1000, 985, 975, 970, 950, 925, 900, 875, 850, 800, 700]
SFC = ['temperature_2m', 'relative_humidity_2m', 'temperature_80m', 'temperature_120m', 'temperature_180m', 'weather_code', 'visibility',
       'cloud_cover_low', 'freezing_level_height', 'surface_pressure']
for name in ('kyiv', 'zap', 'carp'):
    b = load(f'live_v1_{name}')
    if not b: continue
    per = split(b); n = len(b['hourly']['time'])
    section(f'V1  {name}: share of the {n} forecast hours (8 days) with a value — T / RH / gph per level   (elevation {b.get("elevation")} m, cell {b.get("latitude")},{b.get("longitude")})')
    print(f'{"level":>8} ' + ''.join(f'{SHORT[m]:>14}' for m in MODELS))
    for L in LEVELS:
        row = []
        for m in MODELS:
            v = per[m]
            t, r, g = (frac(v.get(f'{x}_{L}hPa', [])) for x in ('temperature', 'relative_humidity', 'geopotential_height'))
            row.append('—' if t == r == g == 0 else f'{t*100:.0f}/{r*100:.0f}/{g*100:.0f}')
        print(f'{L:>5}hPa ' + ''.join(f'{x:>14}' for x in row))
    for s in SFC:
        print(f'{s[:22]:>22} ' + ''.join(f'{("—" if frac(per[m].get(s, [])) == 0 else f"{frac(per[m].get(s, []))*100:.0f}"):>11}' for m in MODELS))
    # horizon: last hour with T at 925 / 950
    print('last hour with T925 | T950 | T2m:')
    for m in MODELS:
        def last(var):
            s = per[m].get(var, [])
            idx = [i for i, v in enumerate(s) if v is not None]
            return b['hourly']['time'][idx[-1]][5:13] if idx else '—'
        print(f'   {SHORT[m]:6} {last("temperature_925hPa"):>12} {last("temperature_950hPa"):>12} {last("temperature_2m"):>12}')

# ---------------------------------------------------------------- V5 heights / below ground
for name in ('carp', 'kyiv', 'zap'):
    b = load(f'live_v1_{name}')
    if not b: continue
    per = split(b); elev = b.get('elevation')
    section(f'V5  {name}: level height above the response elevation ({elev} m): median [min..max] of gph − elevation; '
            f'"bg" = hours with level pressure > model surface_pressure but a temperature returned')
    for m in MODELS:
        v = per[m]; sp = v.get('surface_pressure', [])
        cells = []
        for L in (1000, 975, 950, 925, 900, 850):
            g = v.get(f'geopotential_height_{L}hPa', []); t = v.get(f'temperature_{L}hPa', [])
            hs = [x - elev for x in nn(g)]
            if not hs: cells.append(f'{L}: —'); continue
            bg = sum(1 for i in range(len(t)) if t[i] is not None and i < len(sp) and sp[i] is not None and L > sp[i])
            cells.append(f'{L}: {q(hs, .5):.0f} [{min(hs):.0f}..{max(hs):.0f}]' + (f' bg{bg}' if bg else ''))
        spv = nn(sp)
        print(f'{SHORT[m]:5} sp {q(spv,.5) if spv else float("nan"):6.1f} | ' + ' | '.join(cells))

# ---------------------------------------------------------------- V6 ECMWF hourly behaviour
b = load('live_v1_kyiv')
if b:
    section('V6  hours with a value per forecast day (24 = hourly) — T925, T2m')
    per = split(b); times = b['hourly']['time']
    for m in MODELS:
        for var in ('temperature_925hPa', 'temperature_2m'):
            s = per[m].get(var, [])
            days = [sum(1 for v in s[d*24:(d+1)*24] if v is not None) for d in range(len(s) // 24)]
            # interpolation check: are values between 3-hourly nodes linear?
            lin = []
            for i in range(1, len(s) - 2):
                if i % 3 == 1 and None not in (s[i-1], s[i], s[i+1], s[i+2]):
                    lin.append(abs((s[i] - s[i-1]) - (s[i+2] - s[i-1]) / 3))
            print(f'{SHORT[m]:5} {var:20} per day {days}   mean |dev from linear 3-h| {sum(lin)/len(lin) if lin else float("nan"):.3f}')

# ---------------------------------------------------------------- V2 best_match source
bm = load('live_v2_bm_kyiv'); b = load('live_v1_kyiv')
if bm and b:
    section('V2  best_match at Kyiv: share of hours with a value per level, and mean |difference| to each model (0 = same source)')
    per = split(b); hb = bm['hourly']
    print('best_match cell', bm.get('latitude'), bm.get('longitude'), '| v1 cell', b.get('latitude'), b.get('longitude'))
    for L in (1000, 975, 950, 925, 900, 850):
        for var in ('temperature', 'relative_humidity'):
            k = f'{var}_{L}hPa'; s = hb.get(k, [])
            diffs = []
            for m in MODELS:
                o = per[m].get(k, [])
                pairs = [(x, y) for x, y in zip(s, o) if x is not None and y is not None]
                diffs.append(f'{SHORT[m]}:{sum(abs(x - y) for x, y in pairs)/len(pairs):.2f}' if pairs else f'{SHORT[m]}:—')
            print(f'{k:26} have {pct(frac(s))}  ' + ' '.join(diffs))
    # does best_match switch source with lead time?
    s = hb.get('temperature_925hPa', [])
    for m in ('icon_seamless', 'ecmwf_ifs025', 'gfs_seamless'):
        o = per[m].get('temperature_925hPa', [])
        same = [i for i, (x, y) in enumerate(zip(s, o)) if x is not None and y is not None and abs(x - y) < 0.05]
        if same: print(f'T925 equal to {SHORT[m]} for hours {same[0]}..{same[-1]} ({len(same)} h)')
for tag in ('live_v2_bm4', 'live_v2_2m4'):
    x = load(tag)
    if not x: continue
    lst = x if isinstance(x, list) else [x]
    print(f'{tag}: {len(lst)} location objects; keys of first hourly: {sorted(lst[0]["hourly"].keys())}')
    for o in lst:
        hr = o['hourly']
        print('   ', o.get('latitude'), o.get('longitude'), 'elev', o.get('elevation'), ' '.join(f'{k}:{pct(frac(v))}' for k, v in hr.items() if k != 'time'))

# ---------------------------------------------------------------- V3 RH convention
b = load('live_v1_kyiv')
if b:
    section('V3a dew point returned vs dew point from T and RH (Magnus over water): mean |diff| — 0 means dew point is derived from RH')
    per = split(b)
    for m in MODELS:
        out = []
        for L in (925, 850, 700):
            t, r, d = (per[m].get(f'{x}_{L}hPa', []) for x in ('temperature', 'relative_humidity', 'dew_point'))
            diffs = []
            for T, RH, Td in zip(t, r, d):
                if None in (T, RH, Td) or RH <= 0: continue
                g = math.log(RH / 100) + 17.625 * T / (243.04 + T)
                diffs.append(abs(243.04 * g / (17.625 - g) - Td))
            out.append(f'{L}: {sum(diffs)/len(diffs):.2f}' if diffs else f'{L}: —')
        print(f'{SHORT[m]:5} ' + '  '.join(out))

def load_winter(name):
    # per-model files (hw_<point>_<model>) merged back into one multi-model body
    body = None
    for m in MODELS:
        b = load(f'hw_{name}_{m}')
        if not b: continue
        if body is None: body = {k: v for k, v in b.items() if k != 'hourly'} | {'hourly': {'time': b['hourly']['time']}}
        assert b['hourly']['time'] == body['hourly']['time']
        body['hourly'].update({f'{k}_{m}': v for k, v in b['hourly'].items() if k != 'time'})
    return body
W = {n: load_winter(n) for n in ('kyiv', 'zap')}
if any(W.values()):
    section('V3b RH at cold levels, winter 2025/26 (Dec–Feb): RH p50 / p95 / p99 / max, hours > 100 %; '
            '"ice sat." = RH over water of air saturated over ice at the median T (water-RH models cannot exceed it much)')
    for name, b in W.items():
        if not b: continue
        per = split(b)
        print(f'-- {name}')
        for L in (300, 500, 850, 925):
            print(f'  {L} hPa')
            for m in MODELS:
                t = per[m].get(f'temperature_{L}hPa', []); r = per[m].get(f'relative_humidity_{L}hPa', [])
                pairs = [(T, RH) for T, RH in zip(t, r) if T is not None and RH is not None]
                if not pairs: print(f'    {SHORT[m]:5} —'); continue
                rh = [x[1] for x in pairs]; tm = q([x[0] for x in pairs], .5)
                print(f'    {SHORT[m]:5} T50 {tm:6.1f}  RH {q(rh,.5):5.0f} {q(rh,.95):5.0f} {q(rh,.99):5.0f} {max(rh):5.0f}  >100: {sum(1 for x in rh if x > 100):4}'
                      f'   ice sat. {100*es_i(tm)/es_w(tm):5.0f}%')

# ---------------------------------------------------------------- V4 weather codes
if any(W.values()):
    section('V4  winter weather codes: hours with 45 / 48 (fog, rime fog), 56 / 57 (freezing drizzle), 66 / 67 (freezing rain) per model')
    for name, b in W.items():
        if not b: continue
        per = split(b); n = len(b['hourly']['time'])
        print(f'-- {name} ({n} h)')
        for m in MODELS:
            wc = per[m].get('weather_code', []); t2 = per[m].get('temperature_2m', []); pr = per[m].get('precipitation', [])
            c = Counter(int(x) for x in wc if x is not None)
            fz = [i for i, x in enumerate(wc) if x in (56, 57, 66, 67)]
            fz_cold = sum(1 for i in fz if t2[i] is not None and t2[i] < 0)
            rain_cold = sum(1 for i in range(len(wc)) if t2 and pr and t2[i] is not None and pr[i] is not None and pr[i] > 0 and t2[i] < 0)
            print(f'  {SHORT[m]:5} 45:{c[45]:4} 48:{c[48]:4} 56:{c[56]:3} 57:{c[57]:3} 66:{c[66]:3} 67:{c[67]:3}  | freezing codes with T2m<0: {fz_cold}/{len(fz)}'
                  f'  | hours precip>0 & T2m<0: {rain_cold}   coverage {pct(frac(wc))}')

# ---------------------------------------------------------------- flag rates with the §7.4 rules
def state(T, RH, rh_red=90, rh_marg=80):
    if T is None or RH is None: return 'unk'
    if -20 <= T <= 0 and RH >= rh_red: return 'red'
    if (-20 <= T <= 1 and rh_marg <= RH < rh_red) or (0 < T <= 1 and RH >= rh_red) or (-30 <= T < -20 and RH >= rh_red): return 'yel'
    return 'grn'
RANK = {'unk': -1, 'grn': 0, 'yel': 1, 'red': 2}
def worst(*s):
    k = [x for x in s if x != 'unk']
    return max(k, key=RANK.get) if k else 'unk'

def model_hours(v, elev, n, flight=950, rh_red=90, two_m='pie'):
    """Per hour: (cruise state, climb state, surface-cue red, overall)."""
    out = []
    for i in range(n):
        lv = {}
        for L in (1000, 975, 950, 925):
            T = v.get(f'temperature_{L}hPa', [None] * n)[i]; RH = v.get(f'relative_humidity_{L}hPa', [None] * n)[i]
            g = v.get(f'geopotential_height_{L}hPa', [None] * n)[i]
            if T is None or RH is None or g is None: continue
            if g - elev < 20: continue                        # masked: at or below ground
            lv[L] = state(T, RH, rh_red)
        T2 = v.get('temperature_2m', [None] * n)[i]; R2 = v.get('relative_humidity_2m', [None] * n)[i]
        vis = v.get('visibility', [None] * n)[i]; wc = v.get('weather_code', [None] * n)[i]
        fog = wc == 48 or (T2 is not None and T2 <= 0 and ((vis is not None and vis < 1000) or (R2 is not None and R2 >= 97)))
        fzp = wc in (56, 57, 66, 67)
        s2 = state(T2, R2, rh_red) if two_m == 'pie' else ('red' if fog else ('grn' if T2 is not None else 'unk'))
        # cruise at the flight level: the level itself, else the worse of the bracketing ones (2 m if nothing below)
        if flight in lv: cruise = lv[flight]
        else:
            below = [L for L in lv if L > flight]; above = [L for L in lv if L < flight]
            lo = lv[min(below)] if below else s2
            cruise = worst(lo, lv[max(above)]) if above else 'unk'
        climb = worst(s2, *[lv[L] for L in lv if L > flight])
        if fog: climb = 'red'
        out.append((cruise, climb, fog or fzp, worst(cruise, climb, 'red' if fzp else 'grn')))
    return out

if any(W.values()):
    section('Flag rates, winter 2025/26 — per model, all hours Dec–Feb, flight level 950 hPa, rules of §7.4 (RH ≥ 90 % red)\n'
            'cruise = state at the flight level; any = climb + cruise + surface cues (one instant); climb-only = red only below the flight level;\n'
            'variant "2m=PIE": the ground layer takes the T/RH rule at 2 m (as §5.3 reads); "2m=fog": only the fog cue at the ground')
    for name, b in W.items():
        if not b: continue
        per = split(b); n = len(b['hourly']['time']); elev = b['elevation']
        print(f'-- {name} (elevation {elev} m, {n} h)')
        print(f'  {"model":6} {"cruise red":>10} {"cruise yel":>10} {"cruise unk":>10} | {"any red 2m=PIE":>14} {"climb-only":>10} | {"any red 2m=fog":>14} {"climb-only":>10} | red at RH≥85 / 95')
        res = {}
        for m in MODELS:
            a = model_hours(per[m], elev, n, two_m='pie'); f = model_hours(per[m], elev, n, two_m='fog')
            res[m] = (a, f)
            c = Counter(x[0] for x in a)
            co_a = sum(1 for x in a if x[3] == 'red' and x[0] != 'red'); co_f = sum(1 for x in f if x[3] == 'red' and x[0] != 'red')
            r85 = sum(1 for x in model_hours(per[m], elev, n, rh_red=85, two_m='fog') if x[0] == 'red')
            r95 = sum(1 for x in model_hours(per[m], elev, n, rh_red=95, two_m='fog') if x[0] == 'red')
            print(f'  {SHORT[m]:6} {pct(c["red"]/n):>10} {pct(c["yel"]/n):>10} {pct(c["unk"]/n):>10} | {pct(sum(1 for x in a if x[3]=="red")/n):>14} {pct(co_a/n):>10} |'
                  f' {pct(sum(1 for x in f if x[3]=="red")/n):>14} {pct(co_f/n):>10} | {pct(r85/n)} / {pct(r95/n)}')
        # agreement among the 5 default models, Mode A one instant, 2m=fog variant
        for variant, idx in (('2m=PIE', 0), ('2m=fog', 1)):
            shares = []
            for i in range(n):
                st = [res[m][idx][i][3] for m in DEFAULT5 if res[m][idx][i][3] != 'unk']
                if st: shares.append((sum(1 for s in st if s == 'red') / len(st), Counter(st).most_common(1)[0][1] / len(st)))
            k = len(shares)
            print(f'  5 default models, {variant}: any model red {pct(sum(1 for s in shares if s[0] > 0)/k)} | ≥60 % red {pct(sum(1 for s in shares if s[0] >= .6)/k)}'
                  f' | all red {pct(sum(1 for s in shares if s[0] == 1)/k)} | low agreement (<60 %) {pct(sum(1 for s in shares if s[1] < .6)/k)}')
        # 2-hour flight (Mode A): departure hour red if any phase red over h..h+2 (cruise h, h+1, h+2; climb at h; descent at h+2)
        for variant, idx in (('2m=PIE', 0), ('2m=fog', 1)):
            line = []
            for m in DEFAULT5:
                r = res[m][idx]
                red = sum(1 for i in range(n - 2) if 'red' in (r[i][1], r[i][0], r[i+1][0], r[i+2][0], r[i+2][1]) or r[i][2] or r[i+2][2])
                line.append(f'{SHORT[m]} {pct(red/(n-2))}')
            print(f'  2 h flight, {variant}: departure hours red  ' + '  '.join(line))
        # by month
        times = b['hourly']['time']
        for mon in ('2025-12', '2026-01', '2026-02'):
            idx = [i for i, tm in enumerate(times) if tm.startswith(mon)]
            if not idx: continue
            print(f'  {mon} cruise red: ' + '  '.join(f'{SHORT[m]} {pct(sum(1 for i in idx if res[m][1][i][0]=="red")/len(idx))}' for m in DEFAULT5))

# ---------------------------------------------------------------- D3: 950 vs 925 hPa as the flight level
if any(W.values()):
    section('D3  flight level 950 hPa (bracketing for IFS/AIFS/JMA) vs 925 hPa (native everywhere): cruise red per model and 5-model agreement (2m=fog variant)')
    for name, b in W.items():
        if not b: continue
        per = split(b); n = len(b['hourly']['time']); elev = b['elevation']
        for fl in (950, 925):
            r = {m: model_hours(per[m], elev, n, flight=fl, two_m='fog') for m in MODELS}
            line = '  '.join(f'{SHORT[m]} {pct(sum(1 for x in r[m] if x[0] == "red") / n)}' for m in MODELS)
            low = split_ = 0; k = 0
            for i in range(n):
                st = [r[m][i][0] for m in DEFAULT5 if r[m][i][0] != 'unk']
                if not st: continue
                k += 1
                top = Counter(st).most_common(1)[0][1] / len(st)
                low += top < .6
                split_ += ('red' in st and len(set(st)) > 1)
            print(f'  {name} {fl} hPa cruise red: {line}\n      5 defaults: low agreement {pct(low / k)} | red by some but not all {pct(split_ / k)}')
