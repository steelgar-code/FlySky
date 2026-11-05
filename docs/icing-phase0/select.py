# Model choice: one or two models instead of the 5-model consensus — what changes? (winter 2025/26,
# 950 hPa, Mode A at one instant, ground layer through the fog cue only). Needs the data of winter.py.
import sys, math, io, contextlib, importlib.util, itertools
from collections import Counter
spec = importlib.util.spec_from_file_location('an', 'analyze.py')
with contextlib.redirect_stdout(io.StringIO()):
    an = importlib.util.module_from_spec(spec); spec.loader.exec_module(an)
def esw(t): return 6.112 * math.exp(17.62 * t / (243.12 + t))
def esi(t): return 6.112 * math.exp(22.46 * t / (272.62 + t))
def mixed(t):
    if t >= 0: return esw(t)
    if t <= -23: return esi(t)
    a = ((t + 23) / 23) ** 2
    return a * esw(t) + (1 - a) * esi(t)
def normalise(v, f):
    v = dict(v)
    for L in (1000, 975, 950, 925):
        t = v.get(f'temperature_{L}hPa'); r = v.get(f'relative_humidity_{L}hPa')
        if t and r: v[f'relative_humidity_{L}hPa'] = [None if None in (T, R) else R * f(T) / esw(T) for T, R in zip(t, r)]
    return v
M6 = ['icon_seamless', 'ecmwf_ifs025', 'ecmwf_aifs025_single', 'meteofrance_seamless', 'ukmo_seamless', 'gfs_seamless']
D5 = M6[:5]
S = an.SHORT
for variant in ('reported RH', 'IFS/AIFS RH converted to water (documented ECMWF rule)'):
    print('\n' + '#' * 110 + f'\n# {variant}\n' + '#' * 110)
    for name, b in an.W.items():
        per = an.split(b); n = len(b['hourly']['time']); elev = b['elevation']
        red = {}
        for m in M6:
            v = per[m]
            if variant.startswith('IFS') and m in ('ecmwf_ifs025', 'ecmwf_aifs025_single'): v = normalise(v, mixed)
            red[m] = [x[3] == 'red' for x in an.model_hours(v, elev, n, two_m='fog')]
        share = [sum(red[m][i] for m in D5) / 5 for i in range(n)]
        cons = ['red' if s >= .6 else 'split' if s > 0 else 'clear' for s in share]
        c = Counter(cons)
        print(f'\n-- {name}: 5-model consensus  red (≥3 of 5) {an.pct(c["red"]/n)} | split (1–2 of 5) {an.pct(c["split"]/n)} | none red {an.pct(c["clear"]/n)}')
        print(f'   {"choice":22} {"red hours":>9} | {"agrees w/ consensus":>19} | {"misses consensus red":>20} | {"red where none of 5 red":>23} | {"red in split hours":>18}')
        def row(label, r):
            agree = sum(1 for i in range(n) if r[i] == (cons[i] == 'red')) / n
            miss = sum(1 for i in range(n) if cons[i] == 'red' and not r[i]) / max(1, c['red'])
            fa = sum(1 for i in range(n) if cons[i] == 'clear' and r[i]) / max(1, c['clear'])
            sp = sum(1 for i in range(n) if cons[i] == 'split' and r[i]) / max(1, c['split'])
            print(f'   {label:22} {an.pct(sum(r)/n):>9} | {an.pct(agree):>19} | {an.pct(miss):>20} | {an.pct(fa):>23} | {an.pct(sp):>18}')
        for m in M6: row(S[m] + ' alone', red[m])
        for a, b2 in (('icon_seamless', 'ukmo_seamless'), ('icon_seamless', 'ecmwf_ifs025'), ('icon_seamless', 'gfs_seamless'), ('ukmo_seamless', 'ecmwf_ifs025')):
            row(f'{S[a]}+{S[b2]} either', [x or y for x, y in zip(red[a], red[b2])])
            row(f'{S[a]}+{S[b2]} both', [x and y for x, y in zip(red[a], red[b2])])
        print('   pairwise agreement on red / not red (share of hours):')
        print('   ' + ' ' * 6 + ''.join(f'{S[m]:>7}' for m in M6))
        for a in M6:
            print(f'   {S[a]:6}' + ''.join(f'{100*sum(1 for x, y in zip(red[a], red[b2]) if x == y)/n:6.0f}%' for b2 in M6))
