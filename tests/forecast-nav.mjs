// Forecast navigation: today's date / sunrise / sunset in the location card,
// "Can I fly now?" tiles and summary cards opening their chart (at the hour in
// question), and the back-to-top button.
import { routeAll } from './lib/mock.mjs';
import { launch, BASE_URL, ok } from './lib/env.mjs';
const b = await launch();
const mobile = process.argv.includes('--mobile');
const ctx = await b.newContext(mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block' } : { viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
const page = await ctx.newPage();
const errors = []; page.on('pageerror', e => errors.push(e.message));
await routeAll(page, {});
await page.goto(BASE_URL);
await page.evaluate(() => { localStorage.setItem('flysky_last_location', JSON.stringify({ name: 'Kyiv', latitude: 50.45, longitude: 30.52, country: 'Ukraine' })); localStorage.setItem('flysky_view', JSON.stringify('forecast')); localStorage.setItem('flysky_window', '48'); });
await page.reload();
await page.waitForSelector('#nowStrip', { timeout: 20000 });
await page.waitForTimeout(1000);
const I = (fn, arg) => page.evaluate(fn, arg);

// Sun line in the location card
const sun = await I(() => { const el = document.getElementById('flightSun'); return { inLoc: !!el.closest('section').querySelector('#btnLocation'), inFlight: !!el.closest('#flightCard'), text: el.innerText }; });
ok('date, sunrise and sunset in the location card', sun.inLoc && !sun.inFlight && /Sunrise \d\d:\d\d/.test(sun.text) && /Sunset \d\d:\d\d/.test(sun.text), sun.text);

// Chart in view: its top near the top of the scrolling forecast view.
const inView = key => I(k => { const v = document.getElementById('forecastView').getBoundingClientRect(), w = document.getElementById(`chartWrap-${k}`).getBoundingClientRect(); return w.top >= v.top - 5 && w.top < v.bottom - 200; }, key);
const tipAt = key => I(k => { const c = chartInstances[k]; const a = c && c.tooltip.getActiveElements(); return a && a.length ? a[0].index : -1; }, key);
const toTopShown = () => I(() => !document.getElementById('btnToTop').classList.contains('hidden'));

ok('back-to-top hidden at the top', !(await toTopShown()));
// Tile → chart (current hour)
await page.click('#nowMain [data-goto-chart="wind_gusts_10m"]');
await page.waitForTimeout(1200);
ok('gusts tile → gusts chart, outlined', await inView('wind_gusts_10m') && await I(() => document.getElementById('chartWrap-wind_gusts_10m').classList.contains('ring-2')));
ok('chart shows the card\'s hour (now)', await tipAt('wind_gusts_10m') === 0, await tipAt('wind_gusts_10m'));
ok('back-to-top shown once scrolled down', await toTopShown());
await page.click('#btnToTop'); await page.waitForTimeout(1200);
ok('back-to-top: at the top, button hidden', await I(() => document.getElementById('forecastView').scrollTop) === 0 && !(await toTopShown()));

// Another hour in the card → that hour on the chart
await page.locator('#nowStrip').scrollIntoViewIfNeeded();
await page.focus('#nowStrip'); for (let k = 0; k < 7; k++) await page.keyboard.press('ArrowRight');
await page.click('#nowMain [data-goto-chart="wind_aloft"]');
await page.waitForTimeout(1200);
ok('aloft tile at hour 7 → wind aloft chart at hour 7', await inView('wind_aloft') && await tipAt('wind_aloft') === 7, await tipAt('wind_aloft'));
ok('every tile opens a chart', await I(() => [...document.querySelectorAll('#nowMain [data-goto-chart]')].every(t => document.getElementById(`chartWrap-${t.dataset.gotoChart}`))) && await I(() => document.querySelectorAll('#nowMain [data-goto-chart]').length) === 6);

// Summary card → chart, at its peak hour
await I(() => document.getElementById('forecastView').scrollTo({ top: 0 }));
await page.locator('#statsGrid [data-goto-chart="wind_speed_10m"]').scrollIntoViewIfNeeded();
const peak = await I(() => Number(document.querySelector('#statsGrid [data-goto-chart="wind_speed_10m"]').dataset.gotoHour));
await page.click('#statsGrid [data-goto-chart="wind_speed_10m"]');
await page.waitForTimeout(1200);
ok('wind summary card → wind chart at the peak hour', await inView('wind_speed_10m') && peak >= 0 && await tipAt('wind_speed_10m') === peak, { peak, tip: await tipAt('wind_speed_10m') });
ok('every summary card opens a chart', await I(() => [...document.querySelectorAll('#statsGrid > *')].every(c => c.matches('[data-goto-chart]') && document.getElementById(`chartWrap-${c.dataset.gotoChart}`))));

// Map view: no back-to-top button
await page.click('#viewSwitch [data-view="map"]').catch(() => I(() => setView('map')));
await page.waitForTimeout(600);
ok('back-to-top hidden in the map view', !(await toTopShown()));
ok('no page errors', !errors.filter(e => !/tailwind/.test(e)).length, errors.filter(e => !/tailwind/.test(e)));
await b.close();
