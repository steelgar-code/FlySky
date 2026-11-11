// Forecast data handling: rain and gusts describe the hour before their timestamp (shifted by
// one hour), values always asked in m/s and mm and converted in the browser (a unit change asks
// nothing), one saved record per model (removing a model asks nothing, adding one asks only for
// it, quick model taps make one request), and a cancelled request keeps its estimated cost.
import { routeAll } from './lib/mock.mjs';
import { launch, BASE_URL, ok } from './lib/env.mjs';
const b = await launch();
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
const page = await ctx.newPage();
const errors = []; page.on('pageerror', e => errors.push(e.message));
// Rain and 30 m/s gusts stamped one hour ahead only (k = 1): they describe the hour from now.
const opts = { forecastValue: (v, k) => (v === 'precipitation' ? (k === 1 ? 2 : 0) : v === 'wind_gusts_10m' ? (k === 1 ? 30 : 5) : v === 'wind_speed_10m' ? 4 : undefined) };
const { log } = await routeAll(page, opts);
await page.goto(BASE_URL);
await page.evaluate(() => { localStorage.clear(); localStorage.setItem('flysky_last_location', JSON.stringify({ name: 'Kyiv', latitude: 50.45, longitude: 30.52, country: 'Ukraine', elevation: 179 })); });
await page.reload(); await page.waitForTimeout(5000);
const I = (fn, arg) => page.evaluate(fn, arg);
const fq = () => (log.forecastReq || []).filter(u => !u.includes('surface_pressure'));

// ---- The hour shift
const sh = await I(() => { const p = processed.params; return { rain0: p.precipitation.stats.chance[0], rain1: p.precipitation.stats.chance[1], gust0: p.wind_gusts_10m.stats.median[0], gust1: p.wind_gusts_10m.stats.median[1], wind0: p.wind_speed_10m.stats.median[0] }; });
ok('rain and gusts stamped at the end of their hour: the value stamped +1 h is this hour\'s', sh.rain0 === 100 && sh.rain1 === 0 && sh.gust0 === 30 && sh.gust1 === 5, sh);
ok('wind speed (a value at its timestamp) not shifted', sh.wind0 === 4, sh);
ok('"Can I fly now?" names rain and gusts for this hour', /Limited by/.test(await page.locator('#nowMain').innerText()) && await I(() => processed.flight.hours[0].reasons.includes('gust') && processed.flight.hours[0].values.rain === 100), await I(() => processed.flight.hours[0].reasons));

// ---- Units: always m/s and mm from the API, converted here
const u0 = new URL(fq()[0]);
ok('requests ask m/s and mm whatever the display unit', u0.searchParams.get('wind_speed_unit') === 'ms' && u0.searchParams.get('precipitation_unit') === 'mm', u0.search.slice(0, 200));
let n = fq().length;
await page.click('#btnSettings'); await page.waitForTimeout(400);
await page.selectOption('#windUnitSelect', 'kmh'); await page.waitForTimeout(800);
await page.selectOption('#precipUnitSelect', 'inch'); await page.waitForTimeout(800);
const conv = await I(() => ({ wind: processed.params.wind_speed_10m.stats.median[0], gust: processed.params.wind_gusts_10m.stats.median[0], rainMax: processed.params.precipitation.stats.max[0] }));
ok('km/h and inches: no new request, values converted (4 m/s → 14.4 km/h, 30 → 108, 2 mm → 0.079 in)', fq().length === n && Math.abs(conv.wind - 14.4) < 1e-6 && Math.abs(conv.gust - 108) < 1e-6 && Math.abs(conv.rainMax - 2 / 25.4) < 1e-6, { n0: n, n: fq().length, conv });
ok('the verdict is the same in any unit (gusts still the limiting factor)', await I(() => processed.flight.hours[0].reasons.includes('gust')));
await page.selectOption('#windUnitSelect', 'ms'); await page.selectOption('#precipUnitSelect', 'mm'); await page.waitForTimeout(600);
await page.click('#btnSettingsClose'); await page.waitForTimeout(300);

// ---- One record per model (Models mode)
await page.click('[data-mode="deterministic"]'); await page.waitForTimeout(3500);
const models = () => I(() => selectedModels().join());
const base = await models();
n = fq().length;
const chip = id => I(id => document.querySelector(`#modelChips [data-model="${id}"]`).click(), id);   // in the side menu
await chip('meteofrance_seamless'); await page.waitForTimeout(1800);
ok('removing a model: no request, the others shown at once', fq().length === n && !(await models()).includes('meteofrance_seamless') && await I(() => !!processed && !processed.modelsWithData.has('meteofrance_seamless')), { n0: n, n: fq().length });
await chip('meteofrance_seamless'); await page.waitForTimeout(1800);
ok('adding it back: read already, no request', fq().length === n && await models() === base, { n: fq().length });
await chip('gfs_seamless'); await page.waitForTimeout(1800);
const added = fq().slice(n);
ok('adding a new model: one request for that model only', added.length === 1 && new URL(added[0]).searchParams.get('models') === 'gfs_seamless' && await I(() => processed.modelsWithData.has('gfs_seamless')), added.map(u => new URL(u).searchParams.get('models')));
n = fq().length;
await chip('gem_seamless'); await page.waitForTimeout(150);
await chip('jma_seamless'); await page.waitForTimeout(150);
await chip('gem_seamless'); await page.waitForTimeout(1800);
const quick = fq().slice(n);
ok('quick taps (add, add, remove): one request after they stop, for what is still selected', quick.length === 1 && new URL(quick[0]).searchParams.get('models') === 'jma_seamless', quick.map(u => new URL(u).searchParams.get('models')));
await page.click('#btnRefresh'); await page.waitForTimeout(2500);
const all = fq().at(-1);
ok('Refresh: every selected model asked again', new URL(all).searchParams.get('models').split(',').length === (await models()).split(',').length, new URL(all).searchParams.get('models'));

// ---- The records survive a reload (IndexedDB): no request for fresh ones
n = fq().length;
await page.reload(); await page.waitForTimeout(5000);
ok('after a reload: the saved models shown, nothing asked', fq().length === n && await I(() => !!processed && processed.modelsWithData.size >= 5), { n0: n, n: fq().length });

// ---- A cancelled request keeps its estimated cost
const cost = await I(async () => {
    const c = new AbortController();
    c.abort();
    await omFetch('https://api.open-meteo.com/v1/forecast?latitude=1&longitude=1&hourly=x', { cost: 7, signal: c.signal }).catch(() => {});
    return omLog.at(-1)[1];
});
ok('a cancelled request is logged with its estimated cost (it has usually been counted)', cost === 7, cost);

ok('no page errors', !errors.filter(e => !/tailwind/.test(e)).length, errors.filter(e => !/tailwind/.test(e)));
await ctx.close();
await b.close();
