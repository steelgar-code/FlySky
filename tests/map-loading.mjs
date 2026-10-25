// Lazy forward loading, current-frame marker, basemaps, colour key.
import { routeAll } from './lib/mock.mjs';
import { launch, BASE_URL, ok } from './lib/env.mjs';
const b = await launch();
const ctx = await b.newContext({ viewport: { width: 1280, height: 860 }, serviceWorkers: 'block' });
const page = await ctx.newPage();
const errors = []; page.on('pageerror', e => errors.push(e.message));
const tileHosts = new Set();
page.on('request', r => { const u = r.url(); if (/tile|basemaps/.test(u)) tileHosts.add(new URL(u).hostname); });
const { log } = await routeAll(page, {});
await page.goto(BASE_URL);
await page.evaluate(() => localStorage.setItem('flysky_map_settings', JSON.stringify({ basemap: 'dark', product: 'fog', productAt: Date.now() })));
await page.click('[data-view="map"]');
await page.waitForTimeout(3000);
const satReqs = () => log.getmap.filter(g => /rgb_fog/.test(g.layer));
const idxOf = time => page.evaluate(t => FlySkyMap._internals.R.frames.findIndex(f => new Date(f.t).toISOString().replace('.000Z', 'Z') === t), time);
const marker = () => page.evaluate(() => [...document.querySelectorAll('#mapTicks span')].findIndex(s => s.hasAttribute('data-current')));
const index = () => page.evaluate(() => FlySkyMap._internals.R.index);

// 1. open: only the latest frame
let n = satReqs().length;
ok('open loads only the latest frame', n === 1 && (await idxOf(satReqs()[0].time)) === 24, n);
ok('marker on latest', await marker() === 24);

// 2. select frame 10 → 10 first, then 11..24 in order, nothing before 10
const before = satReqs().length;
await page.locator('#mapSlider').fill('10'); await page.waitForTimeout(2500);
const order = await Promise.all(satReqs().slice(before).map(g => idxOf(g.time)));
ok('select 10 loads 10..23 forward only', order[0] === 10 && order.every((v, i) => !i || v > order[i - 1]) && Math.min(...order) === 10 && order.length === 14, order);
ok('marker follows selection', await marker() === 10);

// 3. prev → only frame 9 more
const b2 = satReqs().length;
await page.click('[data-map-prev]'); await page.waitForTimeout(800);
const o2 = await Promise.all(satReqs().slice(b2).map(g => idxOf(g.time)));
ok('prev loads just the previous frame', JSON.stringify(o2) === '[9]', o2);

// 4. marker with direction changes (the reported bug)
const seq = [];
for (const btn of ['prev', 'prev', 'next', 'next', 'next', 'prev']) {
  await page.click(`[data-map-${btn}]`); await page.waitForTimeout(150);
  seq.push([await index(), await marker()]);
}
ok('marker = index after each prev/next', seq.every(([i, m]) => i === m), seq);
ok('direction change moves the right way', JSON.stringify(seq.map(s => s[0])) === '[8,7,8,9,10,9]', seq.map(s => s[0]));

// 5. play: marker moves with the frames
await page.locator('#mapSlider').fill('20'); await page.waitForTimeout(1200);
await page.click('[data-map-play]');
const play = [];
for (let i = 0; i < 22; i++) { await page.waitForTimeout(300); play.push(await page.evaluate(() => [FlySkyMap._internals.R.index, [...document.querySelectorAll('#mapTicks span')].findIndex(s => s.hasAttribute('data-current'))])); }
await page.click('[data-map-play]');
ok('marker moves while playing', play.every(([i, m]) => i === m) && new Set(play.map(p => p[0])).size >= 4, play);
const wrapped = play.some(([i]) => i < 20);
ok('play wraps to start of window', wrapped, play.map(p => p[0]));
const all = await Promise.all(satReqs().map(g => idxOf(g.time)));
ok('after wrap, frames from 0 requested', all.includes(0));

await page.click('[data-map-latest]'); await page.waitForTimeout(500);
// 6. basemaps: saved "dark" migrated to OSM, only OSM/None offered, no CARTO requests
const segs = await page.$$eval('[data-map-basemap]', els => els.map(e => e.dataset.mapBasemap));
ok('basemap options', JSON.stringify(segs) === '["osmDark","osm","none"]', segs);
ok('no CARTO requests', ![...tileHosts].some(h => /carto/.test(h)), [...tileHosts]);
ok('old "dark" → OSM dark', await page.evaluate(() => FlySkyMap._internals.S.basemap) === 'osmDark');
await page.click('#btnSettings'); await page.waitForTimeout(400);

// 7. colour keys
const keyRows = () => page.$$eval('[data-map-keybox] li', els => els.length);
ok('fog colour key 9 rows', await keyRows() === 9, await keyRows());
ok('fog note + source link', /Fog and low cloud look the same/.test(await page.locator('[data-map-keybox]').innerText()) && !!(await page.$('[data-map-keybox] a[href*="night-microphysics-rgb-quick-guide"]')));
await page.click('#drawerMap [data-map-product="dayMicro"]'); await page.waitForTimeout(1500);
ok('day micro key 8 rows', await keyRows() === 8);
ok('product switch loads only the latest', log.getmap.filter(g => /microphysics/.test(g.layer)).length === 1, log.getmap.filter(g => /microphysics/.test(g.layer)).length);
await page.click('#drawerMap [data-map-product="ir108"]'); await page.waitForTimeout(800);
ok('IR: no placeholder legend', !(await page.$('[data-map-keybox]')));
await page.click('#drawerMap [data-map-key]').catch(() => {});
await page.click('#drawerMap [data-map-product="fog"]'); await page.waitForTimeout(800);
await page.click('#drawerMap [data-map-key]'); await page.waitForTimeout(200);
ok('key collapses', await keyRows() === 0);
await page.click('#drawerMap [data-map-key]');
ok('no Night Microphysics entry', !(await page.$('[data-map-product="nightMicro"]')));
await page.selectOption('#langSelect', 'uk'); await page.waitForTimeout(300);
ok('uk key', /Теплий щільний туман/.test(await page.locator('[data-map-keybox]').innerText()));
await page.selectOption('#langSelect', 'en');

// 8. precipitation: only the frame for the current image
const p0 = log.getmap.filter(g => /precip/.test(g.layer)).length;
if (!(await page.isVisible('#drawerMap'))) { await page.click('#btnSettings'); await page.waitForTimeout(400); } await page.locator('#drawerMap label:has([data-map-ov="precip"])').click(); await page.waitForTimeout(1500);
const p1 = log.getmap.filter(g => /precip/.test(g.layer)).length - p0;
ok('precip loads only current frame', p1 === 1, p1);
await page.click('#btnSettingsClose'); await page.waitForTimeout(300);
await page.screenshot({ path: 'map4.png' });
console.log('errors', errors.filter(e => !/tailwind/.test(e)));
await b.close();
