// "Can I fly now?" card, wind aloft as a flight factor, models in the side menu,
// Open-Meteo request budget (no refetch on window switch, limits), confidence legend.
import { routeAll } from './lib/mock.mjs';
import { launch, BASE_URL, ok } from './lib/env.mjs';
const b = await launch();
const mobile = process.argv.includes('--mobile');
const ctx = await b.newContext(mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block' } : { viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
const page = await ctx.newPage();
const errors = []; page.on('pageerror', e => errors.push(e.message));
const forecastReqs = [];
page.on('request', r => { const u = r.url(); if (/open-meteo\.com/.test(u) && /models=/.test(u) && !/past_days/.test(u)) forecastReqs.push(u); });
const opts = {};
await routeAll(page, opts);
await page.goto(BASE_URL);
await page.evaluate(() => {
  localStorage.clear();
  localStorage.setItem('flysky_last_location', JSON.stringify({ name: 'Kyiv', latitude: 50.45, longitude: 30.52, country: 'Ukraine' }));
});
await page.reload(); await page.waitForTimeout(5000);
const I = fn => page.evaluate(fn);

// "Can I fly now?" card
const card = await I(() => {
  const c = document.getElementById('nowCard');
  return { visible: !c.classList.contains('hidden'), aboveFlight: c.getBoundingClientRect().top < document.getElementById('flightCard').getBoundingClientRect().top,
    tiles: document.querySelectorAll('#nowMain .grid > div').length, text: document.getElementById('nowMain').innerText + '\n' + document.getElementById('nowNext').innerText };
});
ok('now card above the flight card', card.visible && card.aboveFlight);
ok('now card: verdict, 6 factor tiles, next window', /Can I fly now\?/.test(card.text) && card.tiles === 6 && /(Suitable now until|Next suitable|No suitable window)/.test(card.text), card.text.replace(/\n/g, ' | ').slice(0, 160));
ok('now card: tiles coloured by their own check', await I(() => [...document.querySelectorAll('#nowMain .grid > div')].every(d => /rgba?\(|#/.test(d.getAttribute('style')))));
await page.click('[data-now-details]'); await page.waitForTimeout(900);
ok('Details scrolls to the flight card', await I(() => Math.abs(document.getElementById('flightCard').getBoundingClientRect().top) < 150));

// Models in the side menu
ok('model chips in the side menu, not the forecast view', !(await page.$('#forecastView #modelChips')) && !!(await page.$('#drawerForecast #modelChips')));
await page.click('#nowCard [data-open-settings]'); await page.waitForTimeout(400);
ok('"Models" opens the menu with the models', await page.isVisible('#drawerForecast #modelChips [data-model]'));
ok('cost of an update shown', /≈ \d+ Open-Meteo calls/.test(await page.locator('#modelCost').innerText()));
ok('old "wind for flight rules" choice gone, wind aloft thresholds there', !(await page.$('#flightWindSourceSelect')) && await page.locator('[data-threshold="aloftGood"]').count() === 1);

// Wind aloft is its own factor: low aloft limits make every hour not suitable because of it
for (const [f, v] of [['aloftGood', '1'], ['aloftBad', '2']]) {
  const input = page.locator(`[data-threshold="${f}"]`);
  await input.fill(v); await input.dispatchEvent('change'); await page.waitForTimeout(300);
}
await page.click('#btnSettingsClose'); await page.waitForTimeout(500);
const h0 = await I(() => { const h = processed.flight.hours[0]; return { status: h.status, reasons: h.reasons }; });
ok('wind aloft limits the verdict', h0.status === 'bad' && h0.reasons.includes('aloft'), h0);
ok('now card names wind aloft', /wind aloft/i.test(await page.locator('#nowMain').innerText()));
ok('breakdown has a wind-aloft bar', await page.locator('[data-flight-bar="aloft"]').count() === 1);
ok('rules legend lists wind aloft', /wind aloft ≥ 2/.test(await I(() => document.getElementById('flightLegend').innerText)));
await page.click('#btnSettings'); await page.waitForTimeout(300);
await page.click('#btnResetSettings'); await page.waitForTimeout(500);
await page.click('#btnSettingsClose'); await page.waitForTimeout(300);

// Request budget: 8 days asked once; switching windows needs no new request
const n0 = forecastReqs.length;
ok('8 days requested', /forecast_days=8/.test(forecastReqs.at(-1)), forecastReqs.at(-1).match(/forecast_days=\d+/));
for (const w of ['48', '72', '168', '24']) { await page.click(`#windowButtons [data-window="${w}"]`); await page.waitForTimeout(600); }
ok('window switches: no new requests', forecastReqs.length === n0, forecastReqs.length - n0);

// Confidence legend: the three levels stay together (one line each, never split)
ok('confidence legend levels kept whole', await I(() => [...document.querySelectorAll('#flightConfLegend > span:last-child > span')].every(s => s.getBoundingClientRect().height < 16)));

// Daily limit: one request, no per-model retries, one toast, forecast kept
opts.forecastLimit = { n: 99, reason: 'Daily API request limit exceeded. Please try again tomorrow.' };
const n1 = forecastReqs.length;
await page.click('#btnRefresh'); await page.waitForTimeout(2500);
ok('daily limit: one request only', forecastReqs.length - n1 === 1, forecastReqs.length - n1);
const toasts = await page.locator('#toastContainer > div').allInnerTexts();
ok('daily limit: one toast', toasts.filter(x => /limit/i.test(x)).length === 1, toasts);
ok('daily limit: forecast kept', await I(() => !!processed && state.forecastFromCache && document.querySelectorAll('#flightStrip [data-flight-hour]').length > 0));
opts.forecastLimit = null;

// Confidence with a factor some models lack: 8 models, wind aloft from 5 of them.
const conf = await page.evaluate(() => {
    const ms = Array.from({ length: 8 }, (_, k) => `m${k + 1}`);
    const param = (variable, models, valueOf) => ({ members: models.map(m => ({ model: m, variable, key: `${variable}_${m}`, values: [valueOf(m)] })),
        stats: { median: [models.map(valueOf).sort((x, y) => x - y)[Math.floor(models.length / 2)]] } });
    const run = (aloft, wind = () => 5) => {
        const save = state.windUnit; state.windUnit = 'ms';
        const r = computeFlight({ times: ['2030-01-01T10:00'], params: { wind_speed_10m: param('wind_speed_10m', ms, wind), wind_aloft: param('wind_speed_950hPa', ms.slice(0, 5), aloft) } });
        state.windUnit = save;
        const a = r.hours[0].agree;
        return { status: r.hours[0].status, top: a.top, conf: Math.round(a.conf * 1000) / 1000, level: a.level, aloft: Math.round(a.checkConf.aloft * 1000) / 1000 };
    };
    return {
        allStrong: run(() => 16),                                  // the 5 agree: too strong
        split: run(m => (['m1', 'm2', 'm3'].includes(m) ? 16 : 5)),   // 3 strong, 2 calm
        ownBad: run(m => (['m1', 'm2', 'm3'].includes(m) ? 16 : 5), m => (m === 'm8' ? 15 : 5))
    };
});
console.log('    confidence:', JSON.stringify(conf));
ok('models without wind aloft take it as the others see it: all 5 strong → 100% high', conf.allStrong.top === 'bad' && conf.allStrong.conf === 1 && conf.allStrong.level === 'high');
ok('split among the 5 (3 strong, 2 calm) → 60% not suitable, medium', conf.split.top === 'bad' && conf.split.conf === 0.6 && conf.split.level === 'medium' && conf.split.aloft === 0.6);
ok('a model that is not suitable on its own stays so', conf.ownBad.conf === 0.65, conf.ownBad);

ok('no page errors', !errors.filter(e => !/tailwind/.test(e)).length, errors.filter(e => !/tailwind/.test(e)));
await b.close();
