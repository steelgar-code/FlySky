// Forecast view: data, charts, flight bar, planner, modes, windows, settings, language.
import { routeAll } from './lib/mock.mjs';
import { launch, BASE_URL, ok } from './lib/env.mjs';
const b = await launch();
const mobile = process.argv.includes('--mobile');
const ctx = await b.newContext(mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block' } : { viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
const page = await ctx.newPage();
const errors = []; page.on('pageerror', e => errors.push(e.message));
const forecastReqs = [];
page.on('request', r => { const u = r.url(); if (/open-meteo\.com/.test(u) && /models=/.test(u) && !/past_days/.test(u)) forecastReqs.push(u); });
await routeAll(page, {});
await page.goto(BASE_URL);
await page.evaluate(() => {
  localStorage.clear();
  localStorage.setItem('flysky_last_location', JSON.stringify({ name: 'Kyiv', latitude: 50.45, longitude: 30.52, country: 'Ukraine' }));
});
await page.reload(); await page.waitForTimeout(5000);
const I = fn => page.evaluate(fn);

// data + layout
ok('one combined ensemble request', forecastReqs.length === 1 && /ensemble-api/.test(forecastReqs[0]), forecastReqs.length);
ok('charts drawn', await I(() => document.querySelectorAll('#chartsContainer canvas').length) >= 6);
ok('flight bar: 24 hours', await I(() => document.querySelectorAll('#flightStrip [data-flight-hour]').length) === 24);
ok('summary cards', await I(() => document.querySelectorAll('#statsGrid > *').length) >= 6);
ok('low clouds listed as not included (ensemble)', /Low Cloud Cover/.test(await I(() => document.getElementById('flightLegend').innerText)));
const statuses = await I(() => [...new Set([...document.querySelectorAll('#flightStrip [data-flight-hour]')].map(c => c.style.background))]);
ok('flight bar has several statuses', statuses.length >= 2, statuses);

// time window
await page.click('#windowButtons button:has-text("72")'); await page.waitForTimeout(2500);
ok('72 h window', await I(() => document.querySelectorAll('#flightStrip [data-flight-hour]').length) === 72);
await page.click('#windowButtons button:has-text("24")'); await page.waitForTimeout(1500);

// Models mode
await page.click('[data-mode="deterministic"]'); await page.waitForTimeout(3500);
ok('models mode: forecast API request', forecastReqs.some(u => /api\.open-meteo\.com\/v1\/forecast/.test(u)));
ok('models mode: low clouds included', !/Low Cloud Cover/.test(await I(() => document.getElementById('flightLegend').innerText)));
await page.click('[data-mode="ensemble"]'); await page.waitForTimeout(2500);

// thresholds: a much higher wind limit makes more hours suitable
const good = () => I(() => [...document.querySelectorAll('#flightStrip [data-flight-hour]')].filter(c => c.style.background === 'rgb(12, 163, 12)').length);
const before = await good();
await page.click('#btnSettings'); await page.waitForTimeout(400);
for (const [f, v] of [['windBad', '60'], ['windGood', '50'], ['aloftBad', '60'], ['aloftGood', '50'], ['rainBad', '100'], ['rainGood', '99']]) {
  const input = page.locator(`[data-threshold="${f}"]`);
  await input.fill(v); await input.dispatchEvent('change'); await page.waitForTimeout(300);
}
await page.click('#btnSettingsClose'); await page.waitForTimeout(500);
const after = await good();
ok('raising thresholds → more suitable hours', after > before, { before, after });
ok('thresholds saved', await I(() => JSON.parse(localStorage.getItem('flysky_flight_rules')).windGood === 50));
await page.click('#btnSettings'); await page.waitForTimeout(300);
await page.click('#btnResetSettings'); await page.waitForTimeout(500);
await page.click('#btnSettingsClose'); await page.waitForTimeout(300);
ok('reset restores defaults', await good() === before);

// planner
const plannerText = await I(() => document.getElementById('plannerBody').innerText);
ok('planner lists windows', /\d\d:\d\d–\d\d:\d\d/.test(plannerText), plannerText.slice(0, 80));

// language
await page.selectOption('#langSelect', 'uk'); await page.waitForTimeout(800);
ok('Ukrainian UI', /Умови для польоту|Прогноз/.test(await I(() => document.body.innerText)));
await page.selectOption('#langSelect', 'en'); await page.waitForTimeout(500);

// reload uses the saved forecast (no new request needed to draw)
const n = forecastReqs.length;
await page.reload(); await page.waitForTimeout(1500);
ok('saved forecast shown after reload', await I(() => document.querySelectorAll('#flightStrip [data-flight-hour]').length) === 24, forecastReqs.length - n);
ok('no page errors', !errors.filter(e => !/tailwind/.test(e)).length, errors.filter(e => !/tailwind/.test(e)));
await b.close();
