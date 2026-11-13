// Icing along the route (flight time calculator, experimental): the route request (every second
// point and B, ICON + UKMO, the levels around the flight height), A's column from the forecast
// view's data or a request of its own, the outbound / back / at-A lines, the coloured line and the
// tag's mark, one model only, freezing rain from the weather code, hilly ground (height above it),
// no return flight, cached answers, the icing indicator off, Ukrainian.
import { routeAll, icingSfcScenario } from './lib/mock.mjs';
import { launch, BASE_URL, ok, newContext } from './lib/env.mjs';
const b = await launch();
const mobile = process.argv.includes('--mobile');
const ctxOpts = mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block' } : { viewport: { width: 1280, height: 860 }, serviceWorkers: 'block' };
const KYIV = { name: 'Kyiv', latitude: 50.45, longitude: 30.52, country: 'Ukraine', elevation: 179 };

// k = hours from now. A layer east of 30.75° E at 950 / 925 hPa (the 400 m flight) for the next hours;
// a low layer at A (975 hPa) 6–8 h ahead; dry otherwise. opts.ukmoOff: UKMO has no data.
const WET = { temperature: -4, relative_humidity: 96 };
const opts = {
    icing: (m, k, p, la, lo) => {
        if (opts.ukmoOff && m === 'ukmo_seamless') return null;
        if (k >= -2 && k < 6 && lo > 30.75 && (p === 950 || p === 925)) return WET;
        if (k >= 6 && k < 9 && lo < 30.6 && p === 975) return WET;
        return {};
    }
};
const ctx = await newContext(b, ctxOpts);
const page = await ctx.newPage();
const errors = []; page.on('pageerror', e => errors.push(e.message));
const { log } = await routeAll(page, opts);
await page.goto(BASE_URL);
await page.evaluate(k => { localStorage.setItem('flysky_last_location', JSON.stringify(k)); localStorage.setItem('flysky_view', JSON.stringify('map')); localStorage.setItem('flysky_map_settings', JSON.stringify({ product: 'fog', productAt: Date.now(), wind: { on: false }, view: { center: [50.45, 30.52], zoom: 8 } })); }, KYIV);
await page.reload(); await page.waitForTimeout(4000);
const I = (fn, arg) => page.evaluate(fn, arg);
const ice = () => page.locator('#mapRouteIce').innerText().then(s => s.replace(/\n/g, ' | '));
const reqs = () => (log.routeIcingReq || []).map(u => { const x = new URL(u); return { n: x.searchParams.get('latitude').split(',').length, vars: x.searchParams.get('hourly').split(','), models: x.searchParams.get('models'), tz: x.searchParams.get('timezone') }; });
const setView = (lat, lng) => I(([la, lo]) => FlySkyMap._internals.R.map.setView([la, lo], FlySkyMap._internals.R.map.getZoom(), { animate: false }), [lat, lng]);
const level = async m => { await page.selectOption('[data-route-level]', String(m)); await page.waitForTimeout(2500); };
const tagMark = () => I(() => { const i = document.querySelector('.fs-route-tag .fa-snowflake'); return i ? i.style.color : ''; });
const segs = () => I(() => [...document.querySelectorAll('path.fs-route-ice')].map(p => p.getAttribute('stroke')));

// A at Kyiv (the forecast location), B 40 km east; 6 m/s from the west.
await page.click('#mapRouteBtn'); await page.waitForTimeout(400);
await setView(50.45, 31.083); await page.waitForTimeout(3000);
let r = reqs();
ok('one route request: ICON + UKMO, GMT, the points east of A (every second one and B), T / RH at 975 / 950 / 925 hPa + surface pressure, 2 m temperature, weather code',
    r.length === 1 && r[0].n === 2 && r[0].models === 'icon_seamless,ukmo_seamless' && r[0].tz === 'GMT'
    && r[0].vars.join() === 'temperature_975hPa,relative_humidity_975hPa,temperature_950hPa,relative_humidity_950hPa,temperature_925hPa,relative_humidity_925hPa,surface_pressure,temperature_2m,weather_code', r);
ok('A at the forecast location: its column from the forecast view\'s data (no request of its own)', !r.some(x => x.n === 1));
let t = await ice();
ok('out: potential icing from about 7 km to B, with the time in it, values and models', /^Icing \(experimental\) · Out: Potential icing 7–40 km \(≈ \d+ min\), −4\.0 °C, RH 96 % · 2 of 2 models/.test(t), t);
ok('back: the same stretch from B, more slowly (against the wind)', /\| Back: Potential icing 0–33 km \(≈ \d+ min\), −4\.0 °C, RH 96 % · 2 of 2 models/.test(t) && +t.match(/Back: Potential icing 0–33 km \(≈ (\d+) min/)[1] > +t.match(/Out: Potential icing 7–40 km \(≈ (\d+) min/)[1], t);
ok('no climb or descent icing at A now: no "At A" line', !/At A/.test(t), t);
ok('the tag gets a red snowflake; the icing stretch drawn red under the route line', /239, 68, 68|#ef4444/i.test(await tagMark()) && (await segs()).length >= 2 && (await segs()).every(c => c === '#ef4444'), { mark: await tagMark(), segs: await segs() });
await setView(50.45, 31.0); await page.waitForTimeout(2000);   // other points: their cells read
const n0 = reqs().length;
await setView(50.45, 31.083); await page.waitForTimeout(1500);
await setView(50.45, 31.0); await page.waitForTimeout(1500);
await setView(50.45, 31.083); await page.waitForTimeout(1500);
ok('panning back and forth: answers reused, no new request', reqs().length === n0, { n0, n: reqs().length });

// 6 h later: no icing on the way, but the low layer at A — climb and descent
await page.selectOption('[data-route-depart]', '6'); await page.waitForTimeout(800);
t = await ice();
ok('+6 h: no icing signs on the way; climb and descent at A through the low layer', /Out: No icing signs in the forecast data · 2 of 2 models/.test(t) && /Back: No icing signs/.test(t)
    && /At A: climb: ≈ 3\.2 min in potential icing \(0–380 m\) · descent: ≈ 3\.2 min in potential icing \(0–380 m\)/.test(t) && reqs().length === n0 && (await segs()).length === 0, t);
await page.selectOption('[data-route-depart]', '0'); await page.waitForTimeout(800);

// 1500 m: other levels (850 / 800 hPa), above the layer
await level(1500);
r = reqs();
ok('1500 m: a request for 850 / 800 hPa (7 variables), no icing signs at that height', r.at(-1).vars.slice(0, 4).join() === 'temperature_850hPa,relative_humidity_850hPa,temperature_800hPa,relative_humidity_800hPa' && r.at(-1).vars.length === 7 && /Out: No icing signs/.test(await ice()), { r: r.at(-1), t: await ice() });

// UKMO without data (1000 m: levels not read yet): one model counted
opts.ukmoOff = true;
await level(1000);
t = await ice();
ok('UKMO without data: "1 of 2 models"', /Out: No icing signs in the forecast data · 1 of 2 models/.test(t), t);
opts.ukmoOff = false;

// freezing rain (weather code 66) east of 30.75°
opts.icingSfc = (m, k, la, lo) => (lo > 30.75 ? { weather_code: 66 } : icingSfcScenario(m, k));
await level(120);
t = await ice();
ok('120 m (following the ground): freezing rain from the weather code', /Out: Potential icing 7–40 km \(≈ \d+ min\), freezing rain or drizzle · 2 of 2 models/.test(t), t);
opts.icingSfc = null;

// hilly ground east of 30.8° (400 m): the height above the ground there
opts.routeElevation = (la, lo) => (lo > 30.8 ? 400 : 179);
await level(600);
t = await ice();
ok('hilly ground: the height above the ground where icing is (≈ 380 m, not 600 m)', /Out: Potential icing \d+–40 km \(≈ \d+ min\), −4\.0 °C, RH 96 %, 380 m above the ground/.test(t), t);
opts.routeElevation = null;

// a tailwind out that is too strong to come back against
opts.routeWind = { speed: 23, from: 270 };
await level(800);
t = await ice();
ok('no return flight: the back line says so', /Back: not worked out \(no return flight\)\./.test(t), t);
opts.routeWind = null;
await level(400);

// A elsewhere: a column request of its own there
await I(() => { FlySkyMap._internals.RT.a = L.latLng(50.2, 30.9); });
await setView(50.2, 31.4); await page.waitForTimeout(3000);
r = reqs();
const col = r.find(x => x.n === 1);
ok('A away from the forecast location: one column request there (all levels, surface values)', !!col && col.vars.includes('cloud_cover_low') && col.vars.includes('temperature_850hPa') && col.tz === 'GMT', r.map(x => `${x.n}:${x.vars.length}`));

// Ukrainian
await page.selectOption('#langSelect', 'uk'); await page.waitForTimeout(800);
t = await ice();
ok('Ukrainian', /^Обледеніння \(експериментально\) · Туди: Можливе обледеніння \d+–\d+ км \(≈ \d+ хв\)/.test(t), t);
await page.selectOption('#langSelect', 'en'); await page.waitForTimeout(500);

// the icing indicator off: no lines, no requests
await I(() => { state.flightProfile.icing = false; });
const n1 = reqs().length;
await level(300);
ok('icing indicator off: no icing lines, no icing request, no mark', !(await ice()) && reqs().length === n1 && !(await tagMark()) && (await segs()).length === 0, { t: await ice(), n: reqs().length });

ok('no page errors', !errors.filter(e => !/tailwind/.test(e)).length, errors.filter(e => !/tailwind/.test(e)));
await ctx.close();
await b.close();
