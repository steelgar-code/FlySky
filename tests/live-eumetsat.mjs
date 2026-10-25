import { execFile } from 'child_process';
import fs from 'fs';
import { png } from './lib/mock.mjs';
import { launch, BASE_URL, ok } from './lib/env.mjs';
const nm = p => fs.readFileSync(new URL('./node_modules/' + p, import.meta.url));
const tile = png(256, 256, () => [20, 24, 40, 255]);
const curl = url => new Promise((res, rej) => execFile('curl', ['-sS', '-m', '90', '-D', '-', '-H', 'Origin: https://steelgar-code.github.io', url], { encoding: 'buffer', maxBuffer: 64e6 }, (e, out) => {
  if (e) return rej(e);
  let i = 0, headersText = '';
  // skip proxy "Connection Established" block(s)
  while (true) { const end = out.indexOf('\r\n\r\n', i); const block = out.slice(i, end).toString(); i = end + 4; if (!/Connection Established/i.test(block)) { headersText = block; break; } }
  const lines = headersText.split('\r\n'); const status = +lines[0].split(' ')[1];
  const headers = {}; lines.slice(1).forEach(l => { const k = l.indexOf(':'); if (k > 0) headers[l.slice(0, k).toLowerCase()] = l.slice(k + 1).trim(); });
  delete headers['content-length']; delete headers['content-encoding']; delete headers['transfer-encoding'];
  res({ status, headers, body: out.slice(i) });
}));
const mobile = process.argv.includes('--mobile');
const b = await launch();
const ctx = await b.newContext(mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block' } : { viewport: { width: 1280, height: 860 }, serviceWorkers: 'block' });
const page = await ctx.newPage();
const errors = []; page.on('pageerror', e => errors.push(e.message));
const reqs = [];
await page.route('**/*', async route => {
  const url = route.request().url();
  if (url.includes('cdn.jsdelivr.net/npm/chart.js')) return route.fulfill({ body: nm('chart.js/dist/chart.umd.js'), contentType: 'text/javascript' });
  if (url.includes('cdn.tailwindcss.com')) return route.fulfill({ body: nm('@tailwindcss/browser/dist/index.global.js'), contentType: 'text/javascript' });
  if (url.includes('font-awesome')) { const f = url.split('/font-awesome/6.4.0/')[1]; return route.fulfill({ body: nm('@fortawesome/fontawesome-free/' + f) }); }
  if (url.includes('/leaflet/1.9.4/leaflet.min.css')) return route.fulfill({ body: nm('leaflet/dist/leaflet.css'), contentType: 'text/css' });
  if (url.includes('/leaflet/1.9.4/leaflet.min.js')) return route.fulfill({ body: nm('leaflet/dist/leaflet.js'), contentType: 'text/javascript' });
  if (url.includes('tile.openstreetmap.org')) { try { const r = await curl(url); return route.fulfill(r); } catch (e) { return route.fulfill({ body: tile, contentType: 'image/png' }); } }
  if (url.includes('open-meteo.com')) return route.fulfill({ status: 503, json: { error: true } });
  if (url.startsWith('https://view.eumetsat.int/')) {
    const t0 = Date.now();
    try { const r = await curl(url); reqs.push({ url, status: r.status, bytes: r.body.length, ms: Date.now() - t0, type: r.headers['content-type'] }); return route.fulfill(r); }
    catch (e) { reqs.push({ url, err: e.message }); return route.abort(); }
  }
  return url.startsWith(new URL(BASE_URL).origin) ? route.continue() : route.abort();
});
await page.goto(BASE_URL);
await page.evaluate(() => { localStorage.clear(); localStorage.setItem('flysky_view', JSON.stringify('map')); });
const t0 = Date.now();
await page.reload();

await page.evaluate(() => { localStorage.setItem('flysky_last_location', JSON.stringify({ name: 'Kyiv', latitude: 50.45, longitude: 30.52 })); localStorage.setItem('flysky_map_settings', JSON.stringify({ overlays: { lightning: { on: true }, fire: { on: true }, precip: { on: true } } })); });
await page.reload();
await page.waitForTimeout(6000);
const rep = async tag => console.log(tag, JSON.stringify(await page.evaluate(() => { const { R, S, cache } = FlySkyMap._internals; return {
  product: S.product, resolved: Object.fromEntries(Object.entries(R.resolved).map(([k, v]) => [k, v.map(l => l.name)])),
  ov: Object.fromEntries(Object.entries(R.ovLayers).map(([k, v]) => [k, v.map(l => l.name + '@' + l.step)])),
  shown: Object.fromEntries(['precip', 'lightning', 'fire'].map(id => [id, `${(R.ovShown[id] || new Map()).size}/${(R.ovWant[id] || new Set()).size} of ${(R.ovFrames[id] || []).length}`])),
  err: R.lastError && R.lastError.msg }; })));
await rep('A');
for (const p of ['geocolour', 'cloudType', 'cloudPhase', 'clm']) {
  await page.evaluate(p => { const b = document.querySelector(`#drawerMap [data-map-product="${p}"]`); b.click(); }, p);
  await page.waitForTimeout(5000);
  const ok = await page.evaluate(() => { const { R, cache } = FlySkyMap._internals; const f = R.frames[R.index]; const e = f && cache.get(f.key); return e && e.status; });
  const card = await page.evaluate(() => document.getElementById('mapProbe').innerText.replace(/\n/g, ' | ').slice(0, 260));
  console.log(p, 'frame', ok, '|', card);
  await page.screenshot({ path: `live_${p}.png` });
}
console.log('errors', errors.filter(e => !/tailwind/.test(e)));
await b.close();
