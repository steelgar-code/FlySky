// Crosshair point readout + centring on the forecast location.
import { routeAll } from './lib/mock.mjs';
import { launch, BASE_URL, ok } from './lib/env.mjs';
const b = await launch();
const mobile = process.argv.includes('--mobile');
const ctx = await b.newContext(mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block' } : { viewport: { width: 1280, height: 860 }, serviceWorkers: 'block' });
const page = await ctx.newPage();
const errors = []; page.on('pageerror', e => errors.push(e.message));
const { log } = await routeAll(page, {});
await page.goto(BASE_URL);
await page.evaluate(() => { localStorage.setItem('flysky_last_location', JSON.stringify({ name: 'Lviv', latitude: 49.84, longitude: 24.03, country: 'Ukraine' })); localStorage.setItem('flysky_view', JSON.stringify('map')); localStorage.setItem('flysky_map_settings', JSON.stringify({ product: 'fog', productAt: Date.now() })); });
await page.reload(); await page.waitForTimeout(3500);
const center = () => page.evaluate(() => { const c = FlySkyMap._internals.R.map.getCenter(); return [+c.lat.toFixed(1), +c.lng.toFixed(1), FlySkyMap._internals.R.map.getZoom()]; });
ok('centred on forecast location', JSON.stringify((await center()).slice(0, 2)) === '[49.8,24]', await center());
ok('crosshair visible', await page.isVisible('#mapCrosshair'));
const card = () => page.locator('#mapProbe').innerText();
let txt = await card();
console.log('    card:', txt.replace(/\n/g, ' | '));
ok('satellite match (aqua → warm fog)', /Warm, thick fog \/ low cloud/.test(txt) && /close colour match/.test(txt));
ok('rain rate shown', /1\.2 mm\/h/.test(txt) && /quality 60%/.test(txt));
ok('model values', /low clouds 85% · visibility 0\.4 km · precip 0\.2 mm/.test(txt));
ok('coords = exact location + name', /Lviv · 49\.840°N 24\.030°E/.test(txt), txt.split('\n')[0]);
const gfi1 = log.gfi.length;
ok('GFI on precip uses MTG-like layer', log.gfi.some(g => /precip/.test(g.layer)) && log.gfi.some(g => /rgb_fog/.test(g.layer)));

// pan: readout follows the crosshair
await page.evaluate(() => FlySkyMap._internals.R.map.panBy([200, 0], { animate: false }));
await page.waitForTimeout(1200);
txt = await card();
const c2 = await center();
ok('pan re-reads values', log.gfi.length > gfi1 && txt.includes(`${c2[0].toFixed(3).slice(0, 4)}`), { gfi: log.gfi.length - gfi1, c2 });
// frame change re-reads for that time
const g2 = log.gfi.length;
await page.click('[data-map-prev]'); await page.waitForTimeout(1200);
const lastSat = log.gfi.filter(g => /rgb_fog/.test(g.layer)).at(-1);
const fr = await page.evaluate(() => { const { R } = FlySkyMap._internals; return new Date(R.frames[R.index].t).toISOString().replace('.000Z', 'Z'); });
ok('frame change reads that frame', log.gfi.length > g2 && lastSat.time === fr, { got: lastSat.time, want: fr });
// playing: no requests, hint
await page.click('[data-map-play]'); await page.waitForTimeout(500);
const g3 = log.gfi.length;
await page.waitForTimeout(2000);
ok('no reads while playing', log.gfi.length === g3 && /Pause the animation/.test(await card()), log.gfi.length - g3);
await page.click('[data-map-play]'); await page.waitForTimeout(1200);
ok('reads again after pause', log.gfi.length > g3);
// caching: same point/time again → no new GFI
await page.click('[data-map-next]'); await page.waitForTimeout(900); await page.click('[data-map-prev]'); await page.waitForTimeout(900);
const g4 = log.gfi.length; await page.click('[data-map-next]'); await page.waitForTimeout(900);
ok('cached reads not repeated', log.gfi.length === g4, log.gfi.length - g4);
ok('model fetched once per point', log.model <= 3, log.model);
// collapse
await page.click('[data-map-probemin]'); await page.waitForTimeout(200);
ok('collapse hides rows', !/Satellite/.test(await card()));
await page.click('[data-map-probemin]');
// toggle off
await page.click('#mapProbeBtn'); await page.waitForTimeout(200);
ok('toggle off hides crosshair + card', !(await page.isVisible('#mapCrosshair')) && !(await page.isVisible('#mapProbe')));
await page.click('#mapProbeBtn'); await page.waitForTimeout(800);
// unclear colour
// Set location: the crosshair point becomes the forecast location, the map stays
await page.evaluate(() => FlySkyMap._internals.R.map.setView([48.5, 32.25], 7, { animate: false })); await page.waitForTimeout(1000);
const target = await page.evaluate(() => { const c = FlySkyMap._internals.R.map.getCenter(); return [Math.round(c.lat * 1e4) / 1e4, Math.round(c.lng * 1e4) / 1e4]; });
await page.click('[data-map-goforecast]'); await page.waitForTimeout(800);
const loc = await page.evaluate(() => state.location);
ok('set location: forecast location = crosshair, map stays', await page.isVisible('#mapView') && loc.latitude === target[0] && loc.longitude === target[1], { loc, target });
ok('set location: button hidden while on it', !(await page.isVisible('[data-map-goforecast]')));
// centre button after panning away
await page.evaluate(() => FlySkyMap._internals.R.map.panBy([300, 200], { animate: false })); await page.waitForTimeout(300);
await page.click('#mapCenterBtn'); await page.waitForTimeout(800);
const c3 = await page.evaluate(() => { const c = FlySkyMap._internals.R.map.getCenter(); return [c.lat, c.lng]; });
ok('centre button returns to the location', Math.abs(c3[0] - target[0]) < 0.05 && Math.abs(c3[1] - target[1]) < 0.05, c3);
await page.selectOption('#langSelect', 'uk'); await page.waitForTimeout(1200);
ok('uk readout', /Теплий щільний туман/.test(await card()) && /низька хмарність 85%/.test(await card()), (await card()).slice(0, 200));
await page.selectOption('#langSelect', 'en'); await page.waitForTimeout(800);
await page.screenshot({ path: mobile ? 'probe_mobile.png' : 'probe_desktop.png' });
console.log('errors', errors.filter(e => !/tailwind/.test(e)));
await b.close();
