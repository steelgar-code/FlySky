// Map settings side menu: folding cards with a summary of what is set, layer
// settings folded per layer, wind heights fitting the card.
import { routeAll } from './lib/mock.mjs';
import { launch, BASE_URL, ok } from './lib/env.mjs';
const b = await launch();
const mobile = process.argv.includes('--mobile');
const ctx = await b.newContext(mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block' } : { viewport: { width: 1280, height: 860 }, serviceWorkers: 'block' });
const page = await ctx.newPage();
const errors = []; page.on('pageerror', e => errors.push(e.message));
await routeAll(page, {});
await page.goto(BASE_URL);
await page.evaluate(() => { localStorage.setItem('flysky_last_location', JSON.stringify({ name: 'Kyiv', latitude: 50.45, longitude: 30.52 })); localStorage.setItem('flysky_view', JSON.stringify('map')); });
await page.reload();
await page.waitForFunction(() => window.FlySkyMap && FlySkyMap._internals.R.frames.length > 0, null, { timeout: 20000 });
await page.waitForTimeout(800);
await page.click('#mapPanelBtn'); await page.waitForTimeout(300);
const I = (fn, arg) => page.evaluate(fn, arg);
const openCards = () => I(() => [...document.querySelectorAll('#drawerMap [data-map-section]')].filter(b => b.getAttribute('aria-expanded') === 'true').map(b => b.dataset.mapSection).join(','));

ok('cards: satellite product, layers, map, region, animation, diagnostics', await I(() => [...document.querySelectorAll('#drawerMap [data-map-section]')].map(b => b.dataset.mapSection).join(',')) === 'product,layers,map,region,time,diag');
ok('new user: only "Layers" open', await openCards() === 'layers', await openCards());
const sums = await I(() => Object.fromEntries([...document.querySelectorAll('#drawerMap [data-map-section]')].map(b => [b.dataset.mapSection, b.querySelector('span.truncate').innerText.trim()])));
ok('folded cards say what is set', /Auto/.test(sums.product) && /Dark/.test(sums.map) && /Ukraine/.test(sums.region) && /6 h · Local/.test(sums.time), sums);
ok('no product list while folded', !(await page.isVisible('#drawerMap [data-map-product="fog"]')));
await page.click('[data-map-section="product"]'); await page.waitForTimeout(200);
ok('open "Satellite product": the list', await page.isVisible('#drawerMap [data-map-product="fog"]') && await openCards() === 'product,layers');
await page.click('[data-map-section="layers"]'); await page.waitForTimeout(200);
ok('fold "Layers"; remembered', await openCards() === 'product' && await I(() => JSON.parse(localStorage.getItem('flysky_map_settings')).sections.layers === false));
await page.click('[data-map-section="layers"]'); await page.waitForTimeout(200);

// A layer switched on shows its settings; the sliders button folds them.
await page.locator('#drawerMap label:has([data-map-ov="precip"])').click(); await page.waitForTimeout(800);
ok('precipitation on: its settings show', await page.isVisible('#drawerMap [data-map-opacity="precip"]') && await page.isVisible('#drawerMap [data-map-ovopen="precip"]'));
await page.click('[data-map-ovopen="precip"]'); await page.waitForTimeout(200);
ok('sliders button folds them (image time still shown)', !(await page.isVisible('#drawerMap [data-map-opacity="precip"]')) && await page.isVisible('#mapOvInfo_precip'));
ok('"Layers" summary shows what is on', await I(() => !!document.querySelector('[data-map-section="layers"] .fa-cloud-showers-heavy')));
// Wind heights fit inside the card
const fit = await I(() => { const c = document.querySelector('[data-map-section="layers"]').closest('section').getBoundingClientRect(); return [...document.querySelectorAll('[data-map-windlevel]')].every(b => { const r = b.getBoundingClientRect(); return r.left >= c.left && r.right <= c.right; }); });
ok('wind heights fit the card', fit);
ok('no page errors', !errors.filter(e => !/tailwind/.test(e)).length, errors.filter(e => !/tailwind/.test(e)));
await b.close();
