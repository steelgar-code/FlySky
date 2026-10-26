// Satellite image area reuse: zooming in past zoom 8 and panning inside the
// loaded area need no new image; going back to a recently loaded area reuses
// it (and the frames already played there); real resolution changes reload.
import { routeAll } from './lib/mock.mjs';
import { launch, BASE_URL, ok } from './lib/env.mjs';
const b = await launch();
const mobile = process.argv.includes('--mobile');
const ctx = await b.newContext(mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block' } : { viewport: { width: 1280, height: 860 }, serviceWorkers: 'block' });
const page = await ctx.newPage();
const errors = []; page.on('pageerror', e => errors.push(e.message));
const { log } = await routeAll(page, {});
await page.goto(BASE_URL);
await page.evaluate(() => { localStorage.setItem('flysky_last_location', JSON.stringify({ name: 'Kyiv', latitude: 50.45, longitude: 30.52 })); localStorage.setItem('flysky_view', JSON.stringify('map')); localStorage.setItem('flysky_map_settings', JSON.stringify({ product: 'fog', productAt: Date.now(), wind: { on: false }, view: { center: [50.45, 30.52], zoom: 6 } })); });
await page.reload();
await page.waitForFunction(() => window.FlySkyMap && FlySkyMap._internals.R.frames.length > 5, null, { timeout: 20000 });
await page.waitForTimeout(1500);
const sat = () => log.getmap.filter(g => /rgb_fog/.test(g.layer) && g.w > 200);
const I = (fn, arg) => page.evaluate(fn, arg);
const move = async (fn, arg) => { const n = sat().length; await I(fn, arg); await page.waitForTimeout(1300); return sat().length - n; };
const W = await I(() => FlySkyMap._internals.R.map.getSize().x);

ok('zoom in below 8 (6 → 7): new image (more detail)', await move(() => FlySkyMap._internals.R.map.zoomIn(1, { animate: false })) === 1);
ok('zoom in to 8: new image', await move(() => FlySkyMap._internals.R.map.zoomIn(1, { animate: false })) === 1);
const ext8 = await I(() => { const e = FlySkyMap._internals.R.extent; return { zoom: e.zoom, w: e.w, h: e.h }; });
ok('at the cap: image drawn for zoom 8, about 1.6× the screen', ext8.zoom === 8, ext8);
for (const z of [9, 11, 14, 18]) {
    const n = await move(z2 => FlySkyMap._internals.R.map.setZoom(z2, { animate: false }), z);
    ok(`zoom in to ${z}: no new image`, n === 0 && await I(() => FlySkyMap._internals.R.map.getZoom()) === z, n);
}
ok('panning at zoom 18: no new image', await move(() => FlySkyMap._internals.R.map.panBy([300, -200], { animate: false })) === 0);
await I(() => FlySkyMap._internals.R.map.setView([50.45, 30.52], 8, { animate: false }));
await page.waitForTimeout(1300);
ok('pan a quarter screen at zoom 8: no new image (margin)', await move(w => FlySkyMap._internals.R.map.panBy([Math.round(w * 0.25), 0], { animate: false }), W) === 0);
await I(() => FlySkyMap._internals.R.map.setView([50.45, 30.52], 8, { animate: false }));
await page.waitForTimeout(1300);

// Play a few frames here, then go far away and come back by hand.
await page.locator('#mapSlider').fill(String(await I(() => FlySkyMap._internals.R.frames.length - 4))); await page.waitForTimeout(2500);
const here = sat().length;
ok('picking an earlier image loads it and the later ones', here >= 4);
ok('pan far away: new image area', await move(() => FlySkyMap._internals.R.map.panBy([900, 0], { animate: false })) >= 1);
const back = await move(() => FlySkyMap._internals.R.map.panBy([-893, 6], { animate: false }));
ok('back (not exactly) to the earlier area: reused, no new image', back === 0, back);
ok('the frames played there are still loaded', await I(() => { const { R, cache } = FlySkyMap._internals; return R.frames.slice(-4).every(f => (cache.get(f.key) || {}).status === 'ok'); }));
ok('a handful of areas remembered', await I(() => FlySkyMap._internals.R.extents.length) <= 6);

// Zoom out past the loaded area: a new (coarser) image.
ok('zoom out past the area: new image', await move(() => FlySkyMap._internals.R.map.setZoom(5, { animate: false })) >= 1);
ok('no page errors', !errors.filter(e => !/tailwind/.test(e)).length, errors.filter(e => !/tailwind/.test(e)));
await b.close();
