// Forecast data handling: rain and gusts describe the hour before their timestamp (shifted by
// one hour), values always asked in m/s and mm and converted in the browser (a unit change asks
// nothing), one saved record per model (removing a model asks nothing, adding one asks only for
// it, quick model taps make one request), a cancelled request keeps its estimated cost, a
// model that fails is asked again only after 30 minutes or on Refresh, and the wind aloft:
// Models mode at the flight altitude (levels asked, interpolation, altitude changes, records
// without the levels), Ensemble mode at 925 hPa.
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

// ---- A model that fails is not asked on every trigger (Models mode, GEM always answers 400)
{
    const ctx2 = await b.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
    const p = await ctx2.newPage();
    const errs = []; p.on('pageerror', e => errs.push(e.message));
    // Every toast shown (they close after 10 s, so the container alone is not enough).
    await p.addInitScript(() => {
        window.toastLog = [];
        document.addEventListener('DOMContentLoaded', () => new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => window.toastLog.push(n.textContent.trim()))))
            .observe(document.getElementById('toastContainer'), { childList: true }));
    });
    const o = { forecastModelFail: { model: 'gem_seamless', reason: 'No data is available for this location', status: 400 } };
    const { log: l2 } = await routeAll(p, o);
    await p.goto(BASE_URL);
    await p.evaluate(() => {
        localStorage.clear();
        localStorage.setItem('flysky_last_location', JSON.stringify({ name: 'Kyiv', latitude: 50.45, longitude: 30.52, country: 'Ukraine', elevation: 179 }));
        localStorage.setItem('flysky_mode', JSON.stringify('deterministic'));
        localStorage.setItem('flysky_models_by_mode', JSON.stringify({ deterministic: ['icon_seamless', 'ecmwf_ifs025', 'gem_seamless'] }));
    });
    await p.reload(); await p.waitForTimeout(5000);
    const E = fn => p.evaluate(fn);
    const reqs = () => (l2.forecastReq || []).filter(u => !u.includes('surface_pressure') && !u.includes('ensemble-api')).map(u => new URL(u).searchParams.get('models'));
    const toasts = () => E(() => window.toastLog);
    const gemToasts = async () => (await toasts()).filter(x => /GEM unavailable: No data is available/.test(x)).length;
    const meta = () => p.locator('#forecastMeta').innerText();
    ok('failing model: combined request, then one per model', JSON.stringify(reqs()) === JSON.stringify(['icon_seamless,ecmwf_ifs025,gem_seamless', 'icon_seamless', 'ecmwf_ifs025', 'gem_seamless']), reqs());
    let n2 = reqs().length;
    for (let i = 0; i < 3; i++) await E(() => loadForecast());
    await p.waitForTimeout(500);
    ok('three more loads (automatic triggers): nothing asked', reqs().length === n2, reqs().slice(n2));
    ok('one "unavailable" toast in all, no "Offline" toast', await gemToasts() === 1 && !(await toasts()).some(x => /Offline/.test(x)), await toasts());
    let m = await meta();
    ok('source line: "Updated", not "Cached", one model missing', /^Updated/.test(m) && !/Cached/.test(m) && /1 model\(s\) missing/.test(m), m);
    await p.click('#btnRefresh'); await p.waitForTimeout(2500);
    ok('Refresh asks for the failed model again', reqs().slice(n2).some(x => x.split(',').includes('gem_seamless')), reqs().slice(n2));
    ok('Refresh: the toast shows again', await gemToasts() === 2, await toasts());
    n2 = reqs().length;
    const t0 = (await toasts()).length;
    await E(() => { modelFailures.forEach(f => { f.at -= 31 * 60 * 1000; }); return loadForecast(); });
    await p.waitForTimeout(500);
    ok('after 30 min one automatic load asks for it once, silently', JSON.stringify(reqs().slice(n2)) === '["gem_seamless"]' && (await toasts()).length === t0, { asked: reqs().slice(n2), toasts: (await toasts()).slice(t0) });
    m = await meta();
    ok('…and the source line stays "Updated … 1 model(s) missing"', /^Updated/.test(m) && /1 model\(s\) missing/.test(m), m);

    // A daily limit on due records: the old data stays "Cached" while the retry is held back.
    o.forecastLimit = { n: 99, reason: 'Daily API request limit exceeded. Please try again tomorrow.' };
    n2 = reqs().length;
    await E(() => { modelRecords.forEach(r => { r.fetchedAt -= 24 * 3600e3; }); return loadForecast(); });
    await p.waitForTimeout(500);
    ok('limit reply on due records: one request, "Cached" source line', reqs().length - n2 === 1 && /^Cached/.test(await meta()), { asked: reqs().slice(n2), meta: await meta() });
    const t1 = (await toasts()).length;
    await E(() => loadForecast());
    await p.waitForTimeout(500);
    ok('next automatic load: nothing asked, no toast, still "Cached"', reqs().length - n2 === 1 && (await toasts()).length === t1 && /^Cached/.test(await meta()), { asked: reqs().slice(n2), meta: await meta() });
    o.forecastLimit = null;

    // Every model held back at a place with nothing saved: the source line keeps the reason
    // once the toast has closed; automatic loads ask nothing, Refresh asks.
    o.forecastLimit = { n: 99, reason: 'Hourly API request limit exceeded. Please try again in one hour.' };
    n2 = reqs().length;
    await E(() => selectLocation({ name: 'Lviv', latitude: 49.84, longitude: 24.03, country: 'Ukraine' }));
    await p.waitForTimeout(11500);   // the 10 s toast closes
    const held = { asked: reqs().length - n2, toastsOpen: await p.locator('#toastContainer > div').count(), meta: await meta() };
    await E(() => loadForecast()); await E(() => loadForecast()); await p.waitForTimeout(500);
    held.after = reqs().length - n2; held.meta2 = await meta();
    await p.click('#btnRefresh'); await p.waitForTimeout(2500);
    held.refresh = reqs().length - n2;
    ok('nothing saved, every model limited: the reason stays in the source line, automatic loads ask nothing, Refresh asks', held.asked === 1 && held.toastsOpen === 0 && /free limit reached for 3 model\(s\) \(Hourly/.test(held.meta) && held.after === 1 && held.meta2 === held.meta && held.refresh === 2, held);
    o.forecastLimit = null;

    ok('no page errors (failing model)', !errs.filter(e => !/tailwind/.test(e)).length, errs.filter(e => !/tailwind/.test(e)));
    await ctx2.close();
}

// ---- Wind aloft. Models mode: the speed at the flight altitude above the ground, from the
// pressure levels around it. Levels (m above sea level): 975 hPa 380 m / 4 m/s, 950 hPa 560 m /
// 10 m/s, 925 hPa 800 m / 20 m/s. ECMWF IFS lacks 975 and 950 hPa; Météo-France's 975 hPa is
// 11 m above a 179 m ground (inside the terrain, 50 m/s) and it lacks 950 hPa.
{
    const ctx3 = await b.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
    const p = await ctx3.newPage();
    const errs = []; p.on('pageerror', e => errs.push(e.message));
    const LV = { 975: { s: 4, z: 380 }, 950: { s: 10, z: 560 }, 925: { s: 20, z: 800 } };
    const levelValue = (v, m) => {
        const x = v.match(/^(wind_speed|geopotential_height)_(\d+)hPa$/);
        if (!x) return undefined;
        const lv = +x[2], speed = x[1] === 'wind_speed';
        if (m === 'ecmwf_ifs025' && (lv === 975 || lv === 950)) return null;
        if (m === 'meteofrance_seamless' && lv === 975) return speed ? 50 : 190;
        if (m === 'meteofrance_seamless' && lv === 950) return null;
        return LV[lv] ? (speed ? LV[lv].s : LV[lv].z) : undefined;
    };
    const o = { forecastValue: (v, k, m) => (v === 'wind_speed_120m' ? 7.5 : v === 'wind_speed_10m' ? 4 : levelValue(v, m)) };
    const { log: l3 } = await routeAll(p, o);
    await p.goto(BASE_URL);
    await p.evaluate(() => {
        localStorage.clear();
        localStorage.setItem('flysky_last_location', JSON.stringify({ name: 'Kyiv', latitude: 50.45, longitude: 30.52, country: 'Ukraine' }));
        localStorage.setItem('flysky_mode', JSON.stringify('deterministic'));
    });
    await p.reload(); await p.waitForTimeout(5000);
    const E = (fn, arg) => p.evaluate(fn, arg);
    const reqs = () => (l3.forecastReq || []).filter(u => !u.includes('surface_pressure') && !u.includes('ensemble-api'));
    const hourlyOf = u => new URL(u).searchParams.get('hourly').split(',');
    const perModel = () => E(() => Object.fromEntries(processed.params.wind_aloft.members.map(m => [m.model, Math.round(m.values[0] * 1000) / 1000])));
    const height = async m => { await E(m => setFlightHeight(m), m); await p.waitForTimeout(2000); };
    const near = (a, b) => Math.abs(a - b) < 0.01;

    const v0 = hourlyOf(reqs()[0]);
    const levelVars = v0.filter(v => /hPa$/.test(v)).sort();
    ok('Models request for 400 m: speed and height of 975, 950, 925 hPa, no direction', JSON.stringify(levelVars) === JSON.stringify(['geopotential_height_925hPa', 'geopotential_height_950hPa', 'geopotential_height_975hPa', 'wind_speed_925hPa', 'wind_speed_950hPa', 'wind_speed_975hPa']) && !v0.some(v => /direction/.test(v)), v0);
    let pm = await perModel();
    // 400 m over 179 m = 579 m: between 950 (560 m, 10) and 925 hPa (800 m, 20) → 10 + 10 × 19 / 240.
    ok('interpolated in height between the levels below and above (10.79 m/s)', ['icon_seamless', 'ecmwf_aifs025_single', 'ukmo_seamless'].every(m => near(pm[m], 10 + 10 * 19 / 240)), pm);
    ok('a model with only one level within reach (925 hPa, 221 m away) still counts', near(pm.ecmwf_ifs025, 20) && await E(() => processed.modelsWithData.has('ecmwf_ifs025')), pm);
    ok('a level inside the terrain is left out (975 hPa 11 m above the ground)', near(pm.meteofrance_seamless, 20), pm);
    ok('one wind-aloft series per model', await E(() => processed.params.wind_aloft.members.length) === 5);
    ok('title "Wind at 400 m", levels as the note', await E(() => document.getElementById('chartTitle-wind_aloft').textContent) === 'Wind at 400 m' && await E(() => document.getElementById('chartNote-wind_aloft').textContent) === '975/950/925 hPa');
    ok('the record keeps the variables asked and the ground', await E(() => [...modelRecords.values()].every(r => r.mode !== 'deterministic' || (Array.isArray(r.vars) && r.vars.includes('geopotential_height_950hPa') && r.meta.elevation === 179))));

    let n3 = reqs().length;
    await height(120);
    ok('120 m: one request, the height level, no pressure level', reqs().length - n3 === 1 && hourlyOf(reqs().at(-1)).includes('wind_speed_120m') && !hourlyOf(reqs().at(-1)).some(v => /hPa/.test(v)), reqs().slice(n3).map(hourlyOf));
    ok('120 m: the value of wind_speed_120m', Object.values(await perModel()).every(v => v === 7.5), await perModel());
    n3 = reqs().length;
    await height(10);
    ok('10 m: nothing asked (the 10 m wind is there), the value of wind_speed_10m', reqs().length === n3 && Object.values(await perModel()).every(v => v === 4) && await E(() => document.getElementById('chartTitle-wind_aloft').textContent) === 'Wind at 10 m', { asked: reqs().length - n3, pm: await perModel() });
    await height(400);
    n3 = reqs().length;
    await E(() => { modelRecords.forEach(r => { delete r.vars; }); return loadForecast(); });
    await p.waitForTimeout(2000);
    ok('a record saved without the list of variables is read again (once)', reqs().length - n3 === 1, reqs().length - n3);
    n3 = reqs().length;
    await E(() => loadForecast()); await p.waitForTimeout(500);
    ok('…and then not again', reqs().length === n3);

    // Over a 150 m ground 400 m and 500 m share 975 / 950 / 925 hPa; 1000 m does not.
    o.forecastElevation = 150;
    await E(() => selectLocation({ name: 'Lviv', latitude: 49.84, longitude: 24.03, country: 'Ukraine' }));
    await p.waitForTimeout(3000);
    pm = await perModel();
    ok('400 m over 150 m: 550 m, between 975 (380 m, 4) and 950 hPa (560 m, 10)', near(pm.icon_seamless, 4 + 6 * 170 / 180), pm);
    n3 = reqs().length;
    await height(500);
    pm = await perModel();
    ok('400 → 500 m: same levels, nothing asked, the value changes (650 m: 13.75)', reqs().length === n3 && near(pm.icon_seamless, 10 + 10 * 90 / 240), { asked: reqs().length - n3, pm });
    await height(1000);
    const v1 = reqs().slice(n3).map(hourlyOf);
    ok('500 → 1000 m: other levels, asked once (925, 900, 850 hPa)', v1.length === 1 && ['wind_speed_900hPa', 'geopotential_height_850hPa'].every(v => v1[0].includes(v)) && !v1[0].includes('wind_speed_975hPa'), v1);
    await height(400); await p.waitForTimeout(500);

    // Ensemble mode: 925 hPa only, named with its height above the ground (760 − 150 m ≈ 600 m).
    await p.click('[data-mode="ensemble"]'); await p.waitForTimeout(3500);
    const ens = (l3.forecastReq || []).filter(u => u.includes('ensemble-api')).at(-1);
    const ev = hourlyOf(ens);
    ok('Ensemble request: 925 hPa wind, no 1000 hPa', ev.includes('wind_speed_925hPa') && !ev.some(v => /1000hPa/.test(v)) && !ev.some(v => /geopotential/.test(v)), ev);
    ok('Ensemble title names 925 hPa and its height: "Wind ~600 m (925 hPa)"', await E(() => document.getElementById('chartTitle-wind_aloft').textContent) === 'Wind ~600 m (925 hPa)', await E(() => document.getElementById('chartTitle-wind_aloft').textContent));
    ok('Ensemble: no member-level legend', await E(() => document.getElementById('chartLegend-wind_aloft').classList.contains('hidden')));
    const high = await E(() => {
        const ground = g => { modelRecords.forEach(r => { r.meta.elevation = g; }); processForecast(); };
        ground(700);
        const title = paramTitle(PARAMS.find(x => x.key === 'wind_aloft'));
        ground(750);
        const out = { title, members: processed.params.wind_aloft.members.length, missing: processed.flight.missing.slice(), wind: processed.params.wind_speed_10m.members.length };
        ground(150);
        return out;
    });
    ok('Ensemble over 700 m ground: "~50 m"; over 750 m (925 hPa 10 m above it) the factor is left out', high.title === 'Wind ~50 m (925 hPa)' && high.members === 0 && high.missing.includes('flightFactorWindAloft') && high.wind > 0, high);

    ok('no page errors (wind aloft)', !errs.filter(e => !/tailwind/.test(e)).length, errs.filter(e => !/tailwind/.test(e)));
    await ctx3.close();
}
await b.close();
