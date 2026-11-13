// "Can I fly now?" card, wind aloft as a flight factor, models in the side menu,
// Open-Meteo request budget (no refetch on window switch, limits), confidence legend, the
// confidence text naming its group ("90% of members: suitable"); the flight conditions card
// (low-confidence hatch, the ⓘ panel, the pinned hour's lines, its height on a phone).
import { routeAll } from './lib/mock.mjs';
import { launch, BASE_URL, ok } from './lib/env.mjs';
const b = await launch();
const mobile = process.argv.includes('--mobile');
const ctx = await b.newContext(mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block' } : { viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
const page = await ctx.newPage();
const errors = []; page.on('pageerror', e => errors.push(e.message));
const forecastReqs = [];
page.on('request', r => { const u = r.url(); if (/open-meteo\.com/.test(u) && /models=/.test(u) && !/past_days/.test(u) && !/surface_pressure/.test(u)) forecastReqs.push(u); /* not the icing request */ });
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
    tiles: document.querySelectorAll('#nowMain .grid > button').length, text: document.getElementById('nowMain').innerText + '\n' + document.getElementById('nowNext').innerText };
});
ok('now card above the flight card', card.visible && card.aboveFlight);
ok('now card: verdict, 6 factor tiles, next window', /Can I fly now\?/.test(card.text) && card.tiles === 6 && /(Suitable now until|Next suitable|No suitable window)/.test(card.text), card.text.replace(/\n/g, ' | ').slice(0, 160));
ok('now card: tiles coloured by their own check', await I(() => [...document.querySelectorAll('#nowMain .grid > button')].every(d => /rgba?\(|#/.test(d.getAttribute('style')))));
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

// Confidence for every hour: the chart under the hour bar, one short legend line ("Confidence: high 18 h · …" and the ⓘ)
const legend = await I(() => { const k = document.getElementById('flightConfCounts'); return { text: k.innerText.replace(/\s+/g, ' ').trim(), shown: !k.classList.contains('hidden'), h: k.parentElement.getBoundingClientRect().height, info: !!document.querySelector('#flightMain #btnFlightInfo'), chart: !document.getElementById('flightConf').classList.contains('hidden'), gone: ['flightHatchKey', 'flightConfLegend'].filter(id => document.getElementById(id)) }; });
ok('confidence legend: one short line, "Confidence: … h · … h" and the ⓘ, the chart above it; no hatch key', legend.shown && /^Confidence: (high \d+ h)?( · )?(medium \d+ h)?( · )?(low \d+ h)?$/.test(legend.text) && legend.h < 30 && legend.info && legend.chart && !legend.gone.length, legend);

// Daily limit: one request, no per-model retries, one toast, forecast kept
opts.forecastLimit = { n: 99, reason: 'Daily API request limit exceeded. Please try again tomorrow.' };
const n1 = forecastReqs.length;
await page.click('#btnRefresh'); await page.waitForTimeout(2500);
ok('daily limit: one request only', forecastReqs.length - n1 === 1, forecastReqs.length - n1);
const toasts = await page.locator('#toastContainer > div').allInnerTexts();
ok('daily limit: one toast', toasts.filter(x => /limit/i.test(x)).length === 1, toasts);
ok('daily limit: forecast kept', await I(() => !!processed && state.forecastFromCache && document.querySelectorAll('#flightStrip [data-flight-hour]').length > 0));
opts.forecastLimit = null;

// Confidence with a factor some models lack: 8 models, wind aloft from 5 of them (one series
// per model, as in Models mode: the wind aloft is computed and named after its parameter).
const conf = await page.evaluate(() => {
    const ms = Array.from({ length: 8 }, (_, k) => `m${k + 1}`);
    const param = (variable, models, valueOf) => ({ members: models.map(m => ({ model: m, variable, key: variable, values: [valueOf(m)] })),
        stats: { median: [models.map(valueOf).sort((x, y) => x - y)[Math.floor(models.length / 2)]] } });
    const run = (aloft, wind = () => 5) => {
        const save = state.windUnit; state.windUnit = 'ms';
        const r = computeFlight({ times: ['2030-01-01T10:00'], params: { wind_speed_10m: param('wind_speed_10m', ms, wind), wind_aloft: param('wind_aloft', ms.slice(0, 5), aloft) } });
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

// The confidence names the group it counts. Ensemble: 10 members per model, one of them wet in
// the current hour (rain is stamped one hour ahead), everything else fine → the median verdict
// "Uncertain" (any chance of rain), the largest group "suitable" with 90 %.
const calm = (v, k) => (v === 'wind_speed_10m' ? 3 : /hPa|gust/.test(v) ? 4 : v === 'visibility' ? 20000 : v === 'cloud_cover_low' ? 0 : undefined);
opts.forecastMembers = 10;
opts.forecastValue = (v, k, m, member) => (v === 'precipitation' ? (k === 1 && member === 0 ? 2 : 0) : calm(v, k));
await page.click('#btnRefresh'); await page.waitForTimeout(2500);
let nowText = await page.locator('#nowMain').innerText();
ok('10 % of members wet: "Uncertain" and "90% of members: suitable"', /Uncertain/.test(nowText) && /90% of members: suitable/.test(nowText), nowText.split('\n').slice(0, 3).join(' | '));
ok('hour bar cell title names the group too', await I(() => [...document.querySelectorAll('#flightStrip [data-flight-hour][title]')].some(e => /90% of members: suitable/.test(e.title))));
// Models mode: one of the five default models wet → 80 % of models suitable.
opts.forecastValue = (v, k, m) => (v === 'precipitation' ? (k === 1 && m === 'icon_seamless' ? 2 : 0) : calm(v, k));
await page.click('[data-mode="deterministic"]'); await page.waitForTimeout(3500);
nowText = await page.locator('#nowMain').innerText();
ok('Models mode: "80% of models: suitable"', /Uncertain/.test(nowText) && /80% of models: suitable/.test(nowText), nowText.split('\n').slice(0, 3).join(' | '));
await page.selectOption('#langSelect', 'uk'); await page.waitForTimeout(800);
nowText = await page.locator('#nowMain').innerText();
ok('Ukrainian: "80% моделей: придатно"', /80% моделей: придатно/.test(nowText), nowText.split('\n').slice(0, 3).join(' | '));
await page.selectOption('#langSelect', 'en'); await page.waitForTimeout(500);
opts.forecastMembers = null; opts.forecastValue = undefined;

// Batch 1e: the Map button in the title row, the short source line, the Models button, the zone
// on the sun line. A 390 px phone, another hour selected so that Now and Map are both there.
await page.setViewportSize({ width: 390, height: 844 });
await I(() => selectHour(2)); await page.waitForTimeout(500);
const lay = await I(() => {
  const lines = el => { const r = el.getBoundingClientRect(), lh = parseFloat(getComputedStyle(el).lineHeight) || 16; return Math.round(r.height / lh); };
  const row = document.querySelector('#nowMain [data-flight-map]').closest('div'), verdict = document.querySelector('#nowMain [data-icing-flag], #nowMain span.rounded-xl').parentElement;
  const rects = ['[data-now-back]', '[data-flight-map]', '[data-now-details]'].map(s => document.querySelector('#nowMain ' + s).getBoundingClientRect());
  return { titleH: Math.round(row.getBoundingClientRect().height), tops: rects.map(r => Math.round((r.top + r.bottom) / 2 / 6)), order: rects[0].right <= rects[1].left + 1 && rects[1].right <= rects[2].left + 1,
    verdictLines: new Set([...verdict.children].map(c => { const r = c.getBoundingClientRect(); return Math.round((r.top + r.bottom) / 2 / 12); })).size, mapInVerdict: !!verdict.querySelector('[data-flight-map]'), scroll: document.documentElement.scrollWidth };
});
ok('390 px: Now, Map, Details in one line of the title row, in that order', lay.order && Math.max(...lay.tops) - Math.min(...lay.tops) <= 1 && lay.titleH < 30 && lay.scroll <= 390, lay);
ok('…and the verdict row has at most two lines, no Map in it', lay.verdictLines <= 2 && !lay.mapInVerdict, lay);
const hourSel = await I(() => { const h = processed.flight.hours[nowIndex()].time; const orig = openMapAt; window.__mapAt = null; openMapAt = t => { window.__mapAt = t; orig(t); }; return h; });
await page.click('#nowMain [data-flight-map]'); await page.waitForTimeout(800);
ok('Map in the title row opens the map at the selected hour', await I(() => !document.getElementById('mapView').classList.contains('hidden')) && await I(() => window.__mapAt) === hourSel, { hourSel, at: await I(() => window.__mapAt) });
await I(() => setView('forecast')); await page.waitForTimeout(500);
const src = await I(() => { const m = document.getElementById('forecastMeta'); const b = document.getElementById('modelsButton'); return { text: m.innerText, lines: Math.round(m.getBoundingClientRect().height / parseFloat(getComputedStyle(m).lineHeight)), label: b.innerText, title: b.title, aria: b.getAttribute('aria-label'), names: modeModels().filter(x => state.forecast.models[x.id]).map(x => x.name), sun: document.getElementById('flightSun').innerText.replace(/\s+/g, ' ') }; });
ok('source line: one line, "Updated <time>", no model name', src.lines === 1 && /^Updated (\d\d:\d\d|\w{3} \d\d:\d\d)$/.test(src.text) && !src.names.some(n => src.text.includes(n)), src);
ok('Models button: the count, the title and the label list the models with data', src.names.length > 1 && src.label === `Models · ${src.names.length}` && src.title === src.names.join(', ') && src.aria.endsWith(src.names.join(', ')), src);
ok('sun line ends with the time zone', /Sunset \d\d:\d\d · ?EET \(UTC\+2\)$|Sunset \d\d:\d\d\s*EET \(UTC\+2\)$/.test(src.sun), src.sun);
await page.selectOption('#langSelect', 'uk'); await page.waitForTimeout(800);
const srcUk = await I(() => ({ text: document.getElementById('forecastMeta').innerText, label: document.getElementById('modelsButton').innerText }));
ok('Ukrainian: "Оновлено …" and "Моделі · N"', /^Оновлено \d\d:\d\d$|^Оновлено \S+ \d\d:\d\d$/.test(srcUk.text) && /^Моделі · \d+$/.test(srcUk.label), srcUk);
await page.selectOption('#langSelect', 'en'); await page.waitForTimeout(500);
ok('English again: the Models label is not overwritten by the static string', /^Models · \d+$/.test(await page.locator('#modelsButton').innerText()));

// Batch 1f: the flight conditions card. A 390 px phone with touch, the mock's icing scenario,
// hour 1 pinned. Before the batch the part of the card above its first folding section was
// 630 px (the hour bar, three strips, two legends and the pinned hour's ~20 lines; measured at
// 8990e25 with the same steps); the whole card 2,004 px with the breakdown and the profile open.
{
  const ctx2 = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  const p2 = await ctx2.newPage();
  p2.on('pageerror', e => errors.push(e.message));
  await routeAll(p2, {});
  await p2.goto(BASE_URL);
  await p2.evaluate(() => { localStorage.clear(); localStorage.setItem('flysky_last_location', JSON.stringify({ name: 'Kyiv', latitude: 50.45, longitude: 30.52, country: 'Ukraine', elevation: 179 })); });
  await p2.reload(); await p2.waitForTimeout(5000);
  const J = (fn, arg) => p2.evaluate(fn, arg);
  const OLD_TOP = 630;

  // Low confidence: a light hatch over the hour's colour, only there; none in Split by share.
  const hatch = () => J(() => [...document.querySelectorAll('#flightStrip [data-flight-hour]')].map((c, i) => ({ i, low: c.hasAttribute('data-low-conf'), img: getComputedStyle(c).backgroundImage, level: (processed.flight.hours[i].agree || {}).level })));
  let cells = await hatch();
  const lowC = cells.find(c => c.level === 'low'), highC = cells.find(c => c.level && c.level !== 'low');
  ok('a low-confidence hour carries the hatch, a medium / high one does not', lowC && highC && lowC.low && /repeating-linear-gradient/.test(lowC.img) && !highC.low && highC.img === 'none' && cells.every(c => c.low === (c.level === 'low')), { low: lowC, high: highC });
  await p2.tap('#btnFlightSplit'); await p2.waitForTimeout(300);
  cells = await hatch();
  ok('Split by share: no hatch (the shares are drawn), no hatch swatch in the legend', cells.every(c => !c.low && !/repeating/.test(c.img)) && await J(() => !document.querySelector('#flightConfCounts [data-hatch-swatch]')));
  // The confidence chart stays in Split by share, its columns under the split bar's cells.
  const chartGeo = () => J(() => {
    const box = el => { const r = el.getBoundingClientRect(); return { l: r.left, w: r.width, h: r.height }; };
    const cols = [...document.querySelectorAll('#flightConf [data-flight-hour]')], cells = [...document.querySelectorAll('#flightStrip [data-flight-hour]')];
    return { n: cols.length, hours: processed.flight.hours.length, cells: cells.length, maxDl: Math.max(...cols.map((c, i) => Math.abs(box(c).l - box(cells[i]).l))), maxDw: Math.max(...cols.map((c, i) => Math.abs(box(c).w - box(cells[i]).w))),
      shown: !document.getElementById('flightConf').classList.contains('hidden'), chartH: box(document.getElementById('flightConf')).h };
  });
  const splitGeo = await chartGeo();
  ok('Split by share: the chart stays, one column per hour under the split cells (±1 px)', splitGeo.shown && splitGeo.n === splitGeo.hours && splitGeo.maxDl <= 1 && splitGeo.maxDw <= 1, splitGeo);
  await p2.tap('#btnFlightSplit'); await p2.waitForTimeout(300);

  // Batch 1g: the confidence chart (18 px) under the hour bar, one column per hour.
  const geo = await chartGeo();
  ok('confidence chart: one column per hour, same left / width as the hour bar\'s cells (±1 px), 18 px high', geo.shown && geo.n === geo.hours && geo.n === geo.cells && geo.maxDl <= 1 && geo.maxDw <= 1 && Math.abs(geo.chartH - 18) <= 0.5, geo);
  const colInfo = await J(() => processed.flight.hours.map((h, i) => {
    const col = document.querySelector(`#flightConf [data-flight-hour="${i}"]`), bar = col.firstElementChild, a = h.agree;
    return { i, conf: a && a.conf, level: a && a.level, bar: !!bar, h: bar ? bar.getBoundingClientRect().height : 0, bg: bar ? getComputedStyle(bar).backgroundColor : '', bottom: bar ? Math.round(col.getBoundingClientRect().bottom - bar.getBoundingClientRect().bottom) : 0 };
  }));
  const rgb = hex => `rgb(${[1, 3, 5].map(k => parseInt(hex.slice(k, k + 2), 16)).join(', ')})`;
  const COL = { high: '#67e8f9', medium: '#0e7490', low: '#64748b' };
  ok('confidence chart: a column\'s height is the hour\'s share × 18 px, drawn from the bottom', colInfo.every(c => c.bar && Math.abs(c.h - c.conf * 18) <= 0.6 && c.bottom === 0), colInfo.slice(0, 4));
  ok('confidence chart: colours by level (high bright cyan, medium mid cyan, low slate), levels at 60 / 80 %', colInfo.every(c => c.bg === rgb(COL[c.level]) && c.level === (c.conf >= 0.8 ? 'high' : c.conf >= 0.6 ? 'medium' : 'low')) && new Set(colInfo.map(c => c.level)).size >= 2, colInfo.map(c => c.level).join(','));
  // The colour function at the edges: 59 % low, 60 % medium, 80 % high (synthetic hours through the chart's own markup).
  const edge = await J(() => {
    const host = document.createElement('div');
    host.style.cssText = 'position: fixed; left: 0; top: 0; width: 100px; display: flex';
    host.innerHTML = confChartHtml([[0.59, 'low'], [0.6, 'medium'], [0.8, 'high']].map(([conf, level]) => ({ status: 'good', agree: { conf, level } })), false);
    document.body.appendChild(host);
    const r = [...host.children].map(c => getComputedStyle(c.firstElementChild).backgroundColor); host.remove(); return r;
  });
  ok('confidence chart: 59 % slate, 60 % mid cyan, 80 % bright cyan', edge.join('|') === [COL.low, COL.medium, COL.high].map(rgb).join('|'), edge);
  const dash = await J(() => ({ lines: [...document.querySelectorAll('#flightConf > div')].filter(d => /dashed/.test(d.style.borderTop)).map(d => d.style.bottom), seps: document.querySelectorAll('#flightConf [data-day-seps] > div').length, barSeps: document.querySelectorAll('#flightMain .relative [data-day-seps] > div').length }));
  ok('confidence chart: dashed guides at 60 % and 80 %, the day separators like the bar', dash.lines.join() === '60%,80%' && dash.seps > 0 && dash.seps === dash.barSeps, dash);
  // No label covers the first columns; the chart is named for assistive technology and has a title.
  const nm = await J(() => { const c = document.getElementById('flightConf'), col = document.querySelector('#flightConf [data-flight-hour="0"]'), r = col.getBoundingClientRect(), el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { top: !!el && el.closest('[data-flight-hour]') === col, role: c.getAttribute('role'), aria: c.getAttribute('aria-label'), counts: document.getElementById('flightConfCounts').innerText.replace(/\s+/g, ' ').trim(), title: c.title, label: !!document.getElementById('flightConfLabel') }; });
  ok('confidence chart: nothing covers the first column; role img, aria-label = the legend counts, a title', nm.top && nm.role === 'img' && nm.aria === nm.counts && /^Confidence: high|^Confidence: medium|^Confidence: low/.test(nm.aria) && nm.title === 'Confidence: how many members agree on each hour\'s verdict' && !nm.label, nm);
  // Counts add up to the window.
  const cnt = await J(() => ({ sum: [...document.querySelectorAll('#flightConfCounts [data-conf-count]')].reduce((a, e) => a + Number(e.innerText.match(/\d+/)[0]), 0), hours: processed.flight.hours.length, text: document.getElementById('flightConfCounts').innerText.replace(/\s+/g, ' ').trim() }));
  ok('legend counts add up to the window\'s hours', cnt.sum === cnt.hours && cnt.hours > 0, cnt);
  // Hover previews the hour, a tap pins it (the hour bar's cell is marked).
  const colBox = await J(() => { const r = document.querySelector('#flightConf [data-flight-hour="3"]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await p2.mouse.move(colBox.x, colBox.y); await p2.waitForTimeout(200);
  const prev = await J(() => ({ text: document.getElementById('flightDetail').innerText, want: formatDayHour(processed.flight.hours[3].time), pinned: document.querySelectorAll('#flightStrip [data-pinned]').length }));
  ok('hover on a chart column previews that hour in the details (nothing pinned)', prev.text.includes(prev.want) && prev.pinned === 0, prev);
  await p2.tap('#flightConf [data-flight-hour="3"]'); await p2.waitForTimeout(300);
  const pinC = await J(() => ({ text: document.getElementById('flightDetail').innerText, want: formatDayHour(processed.flight.hours[3].time), pinned: [...document.querySelectorAll('#flightStrip [data-pinned]')].map(c => c.dataset.flightHour), chartPinned: [...document.querySelectorAll('#flightConf [data-pinned]')].map(c => c.dataset.flightHour) }));
  ok('a tap on a chart column pins that hour: the hour bar\'s cell and the column are marked', pinC.text.includes(pinC.want) && pinC.pinned.join() === '3' && pinC.chartPinned.join() === '3', pinC);
  await p2.tap('#flightConf [data-flight-hour="3"]'); await p2.waitForTimeout(300);
  ok('…and a second tap unpins it', await J(() => !document.querySelector('#flightMain [data-pinned]')));

  // The ⓘ panel: touch, mouse, keyboard; Escape; the settings drawer keeps its own Escape.
  const panel = () => J(() => ({ open: !document.getElementById('flightInfo').classList.contains('hidden'), expanded: document.getElementById('btnFlightInfo').getAttribute('aria-expanded'), controls: document.getElementById('btnFlightInfo').getAttribute('aria-controls'), text: document.getElementById('flightInfo').innerText.replace(/\s*\n\s*/g, ' '), focus: document.activeElement && document.activeElement.id }));
  await p2.tap('#btnFlightInfo'); await p2.waitForTimeout(200);
  let pn = await panel();
  ok('ⓘ by touch: the panel opens (aria-expanded, aria-controls) and explains colours, hatch, the chart, band and split', pn.open && pn.expanded === 'true' && pn.controls === 'flightInfo' && /green suitable, yellow uncertain, red not suitable/.test(pn.text) && /Hatched: low confidence — fewer than 60 % of the members agree/.test(pn.text) && /sky blue daylight, indigo night/.test(pn.text) && /The small chart under the bar: how many of the members agree on the hour's largest verdict — taller is more certain; the dashed lines are 60 % and 80 %\./.test(pn.text) && /“Split by share” stacks each hour/.test(pn.text), pn);
  await p2.tap('#btnFlightInfo'); await p2.waitForTimeout(200);
  ok('ⓘ by touch: a second tap closes it', !(await panel()).open);
  await p2.click('#btnFlightInfo'); await p2.waitForTimeout(200);
  ok('ⓘ by mouse: opens', (await panel()).open);
  await p2.click('#btnIcingInfo'); await p2.waitForTimeout(200);
  ok('one ⓘ panel at a time', !(await panel()).open && await J(() => !document.getElementById('icingInfo').classList.contains('hidden')));
  await p2.click('#btnIcingInfo'); await p2.waitForTimeout(200);
  await J(() => document.getElementById('btnFlightInfo').focus());
  await p2.keyboard.press('Enter'); await p2.waitForTimeout(200);
  ok('ⓘ by keyboard: Enter opens', (await panel()).open);
  await p2.keyboard.press('Escape'); await p2.waitForTimeout(200);
  pn = await panel();
  ok('Escape closes it, the focus back on the ⓘ', !pn.open && pn.expanded === 'false' && pn.focus === 'btnFlightInfo', pn);
  await p2.keyboard.press('Space'); await p2.waitForTimeout(200);
  await J(() => setSettingsDrawer(true)); await p2.waitForTimeout(400);
  await p2.keyboard.press('Escape'); await p2.waitForTimeout(400);
  const drawerOpen = () => J(() => !document.getElementById('settingsDrawer').classList.contains('-translate-x-full'));
  ok('with the settings drawer open, Escape closes the drawer only', !(await drawerOpen()) && (await panel()).open);
  await p2.keyboard.press('Escape'); await p2.waitForTimeout(200);
  ok('…the next Escape the panel', !(await panel()).open);

  // The icing ⓘ: the owner's four paragraphs, English word for word.
  await p2.tap('#btnIcingInfo'); await p2.waitForTimeout(200);
  const ic = await J(() => [...document.querySelectorAll('#icingInfo p')].map(e => e.textContent));
  ok('icing ⓘ: the four paragraphs, English exactly', JSON.stringify(ic) === JSON.stringify([
    'What this shows: Where DWD ICON and UK Met Office forecasts indicate sub-zero, near-saturated air, freezing fog, or freezing rain/drizzle during climb, cruise, and descent.',
    'Important: This is a potential icing hazard screen, not an icing forecast or a safety assessment. “No signs” does not mean safe. It assumes a fixed-wing drone without ice protection. Ice can rapidly affect thrust and airspeed readings and remain on the aircraft. Avoid icing conditions.',
    'Colours: Red = potential icing; yellow = marginal; grey = no signs detected; hatched = no data. Striped = only one model indicates a hazard. Faded = forecast is more than 3 days ahead.',
    'Profile: Each row shows a model pressure level at its typical local altitude. The dashed line marks your selected flight altitude.']), ic);
  await p2.tap('#btnIcingInfo'); await p2.waitForTimeout(200);

  // The pinned hour: time · verdict · flag · Map; values; confidence; the split, then the
  // models' shares on a line of their own named by the largest group's verdict; one icing line.
  await p2.tap('#flightStrip [data-flight-hour="1"]'); await p2.waitForTimeout(400);
  const pin = await J(() => {
    const d = document.getElementById('flightDetail'), q = s => d.querySelector(s);
    const split = q('[data-conf-split]'), models = q('[data-conf-models]');
    return { head: q('[data-hour-head]').innerText.replace(/\s+/g, ' ').trim(), map: !!q('[data-hour-head] [data-flight-map]'), values: q('[data-hour-values]').innerText, conf: q('[data-hour-conf]').innerText,
      split: split.firstElementChild.innerText, models: models ? models.innerText : '', below: models ? models.getBoundingClientRect().top >= split.firstElementChild.getBoundingClientRect().bottom - 1 : false,
      top: t(FLIGHT_STATUS[processed.flight.hours[1].agree.top].labelKey), icing: d.querySelectorAll('[data-icing-line]').length, text: d.innerText };
  });
  ok('pinned hour, line 1: time, verdict, "Icing risk", Map', /^\w{3} \d\d:\d\d (Suitable|Uncertain|Not suitable) Icing risk Map$/.test(pin.head) && pin.map, pin.head);
  ok('pinned hour, lines 2 and 3: the values, the confidence', /rain chance .* wind .* gusts/.test(pin.values) && /^\d+% of members: (suitable|uncertain|not suitable)$/.test(pin.conf), pin);
  ok('pinned hour: the split, then "Uncertain: …" (the largest group\'s verdict) on its own line, no "by model"', /^suitable \d+% · uncertain \d+% · not suitable \d+%$/.test(pin.split) && new RegExp(`^${pin.top}: DWD ICON-EU \\d+% · `).test(pin.models) && pin.below && !/by model/.test(pin.text), pin);
  ok('pinned hour: icing in one line', pin.icing === 1 && !/climb:|Experimental screening/.test(pin.text), pin.text);
  const hs = await J(() => { const c = document.getElementById('flightCard').getBoundingClientRect().top, at = id => Math.round(document.getElementById(id).getBoundingClientRect().top - c);
    return { top: at('icingSection'), breakdown: at('btnFlightDetails'), whole: document.getElementById('flightCard').offsetHeight }; });
  console.log(`    pinned card at 390 px: ${hs.top} px above the icing section (was ${OLD_TOP} px above the first folding section), ${hs.breakdown} px above "Breakdown by cause", whole card ${hs.whole} px (breakdown and icing folded, planner open)`);
  ok('pinned card on a phone: the hour bar and the hour\'s details at most about half their old height (≤ 55 %)', hs.top <= OLD_TOP * 0.55, { ...hs, old: OLD_TOP });
  ok('no horizontal scroll at 390 px', await J(() => document.documentElement.scrollWidth <= 390));

  // Three languages: the ⓘ text.
  for (const [lang, re] of [['uk', /Штрихування: низька впевненість — менше 60 % членів ансамблю згодні/], ['pt-BR', /Hachurado: confiança baixa — menos de 60 % dos membros concordam/]]) {
    await p2.selectOption('#langSelect', lang); await p2.waitForTimeout(600);
    const tx = await J(() => ({ info: document.getElementById('flightInfo').textContent, counts: document.getElementById('flightConfCounts').innerText.replace(/\s+/g, ' ').trim(), chart: document.getElementById('flightConf').title, label: document.getElementById('btnFlightInfo').getAttribute('aria-label'), icing: [...document.querySelectorAll('#icingInfo p')].map(e => e.textContent.trim()) }));
    ok(`${lang}: the ⓘ panel, its label, the chart label and the legend counts`, re.test(tx.info) && tx.counts.startsWith(lang === 'uk' ? 'Впевненість: ' : 'Confiança: ') && tx.chart.startsWith(lang === 'uk' ? 'Впевненість: скільки' : 'Confiança: quantos') && tx.label === (lang === 'uk' ? 'Що показує смуга' : 'O que a barra mostra'), tx);
    ok(`${lang}: the icing note has four paragraphs, none empty`, tx.icing.length === 4 && tx.icing.every(x => x.length > 40) && (lang !== 'uk' || /^Важливо:/.test(tx.icing[1])), tx.icing);
  }
  await ctx2.close();
}

ok('no page errors', !errors.filter(e => !/tailwind/.test(e)).length, errors.filter(e => !/tailwind/.test(e)));
await b.close();
