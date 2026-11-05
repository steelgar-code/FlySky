# Phase 0 helper: fetch an Open-Meteo URL with curl, save the body and headers in data/ and log the
# X-RateLimit-Cost of each request in data/costs.tsv. A saved response is never fetched again.
import json, subprocess, sys, os, time, urllib.parse
D = os.environ.get('P0_DATA') or os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data')
os.makedirs(D, exist_ok=True)
LOG = os.path.join(D, 'costs.tsv')
def get(host, path, params, tag):
    q = urllib.parse.urlencode(params, safe=',')
    url = f'https://{host}{path}?{q}'
    out = os.path.join(D, tag + '.json'); hdr = os.path.join(D, tag + '.hdr')
    if os.path.exists(out) and os.path.getsize(out) > 0:
        return json.load(open(out)), open(hdr).read() if os.path.exists(hdr) else ''
    for attempt in range(4):
        r = subprocess.run(['curl', '-sS', '--compressed', '--max-time', '300', '-D', hdr, '-o', out, url], capture_output=True, text=True)
        if r.returncode == 0 and os.path.exists(out): break
        print('curl failed', tag, r.returncode, r.stderr.strip()[:200]); time.sleep(2 ** (attempt + 1))
    else:
        return {'error': True, 'reason': 'curl failed: ' + r.stderr.strip()[:200]}, ''
    h = open(hdr).read()
    cost = next((l.split(':',1)[1].strip() for l in h.splitlines() if l.lower().startswith('x-ratelimit-cost')), '?')
    status = [l for l in h.splitlines() if l.startswith('HTTP/')][-1]
    with open(LOG, 'a') as f: f.write(f'{tag}\t{status}\t{cost}\t{len(url)}\t{url[:300]}\n')
    try:
        body = json.load(open(out))
    except ValueError:
        body = {'error': True, 'reason': open(out).read()[:200]}
    if isinstance(body, dict) and body.get('error'):
        os.remove(out)
    return body, h
