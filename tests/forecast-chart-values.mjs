// Values of the selected hour above each parameter chart (instead of the Chart.js tooltip): the
// tooltip is off; hover or tap on a chart selects an hour whose values — matching the processed
// statistics — are shown above it and stay when the pointer leaves; a fixed height whatever the hour
// (desktop and a 390 px phone); the per-model legend carries each model's value; the default hour is
// the "Can I fly now?" card's hour and follows its pin; the hour survives a chart rebuild; Ukrainian.
import { routeAll } from './lib/mock.mjs';
import { launch, BASE_URL, ok, newContext } from './lib/env.mjs';
const b = await launch();
const errors = [];
const KYIV = { name: 'Kyiv', latitude: 50.45, longitude: 30.52, country: 'Ukraine', elevation: 179 };
async function open(ctxOpts) {
  const ctx = await newContext(b, { serviceWorkers: 'block', ...ctxOpts });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(e.message));
  await routeAll(page, {});
  await page.goto(BASE_URL);
  await page.evaluate(k => { localStorage.clear(); localStorage.setItem('flysky_last_location', JSON.stringify(k)); }, KYIV);
  await page.reload(); await page.waitForSelector('#nowStrip', { timeout: 20000 }); await page.waitForTimeout(3500);
  return { ctx, page };
}
// Page position of hour i on a chart (the canvas is scrolled into view first).
const at = async (page, key, i) => {
  await page.locator(`#chart-${key}`).scrollIntoViewIfNeeded(); await page.waitForTimeout(250);
  return page.evaluate(([k, i]) => { const c = chartInstances[k], r = c.canvas.getBoundingClientRect(); return { x: r.left + c.scales.x.getPixelForValue(i), y: r.top + (c.chartArea.top + c.chartArea.bottom) / 2 }; }, [key, i]);
};
const shown = (page, key) => page.evaluate(k => { const c = chartInstances[k]; return { hour: c.$hour, active: c.getActiveElements().map(a => a.index), text: document.getElementById(`chartValues-${k}`).innerText.replace(/\s+/g, ' ').trim(), h: document.getElementById(`chartValues-${k}`).offsetHeight }; }, key);
// What hour i must read for a chart (from the processed statistics).
const want = (page, key, i) => page.evaluate(([k, i]) => {
  const p = PARAMS.find(x => x.key === k), s = processed.params[k].stats, f = v => formatValue(v, p);
  return { hour: formatDayHour(processed.times[i]), med: f(s.median[i]), r50: `${f(s.p25[i])}–${f(s.p75[i])}`, r80: `${f(s.p10[i])}–${f(s.p90[i])}`, full: `${f(s.min[i])}–${f(s.max[i])}`, chance: s.chance && s.chance[i] !== null ? formatPercent(s.chance[i]) : null, count: String(s.count[i]) };
}, [key, i]);
const fits = (text, w) => text.startsWith(w.hour) && text.includes(`Median ${w.med}`) && text.includes(`50% ${w.r50}`) && text.includes(`80% ${w.r80}`) && text.includes(`Range ${w.full}`) && text.includes(`Members ${w.count}`);

// ---- Desktop
{
  const { ctx, page } = await open({ viewport: { width: 1280, height: 900 } });
  const W = 'wind_speed_10m';
  ok('tooltip off on every chart', await page.evaluate(() => Object.values(chartInstances).length > 5 && Object.values(chartInstances).every(c => c.options.plugins.tooltip.enabled === false)));
  ok('one values element above each chart', await page.evaluate(() => PARAMS.every(p => document.getElementById(`chartValues-${p.key}`) && document.getElementById(`chartValues-${p.key}`).compareDocumentPosition(document.getElementById(`chart-${p.key}`)) & Node.DOCUMENT_POSITION_FOLLOWING)));
  // Default: the card's hour (now).
  let s = await shown(page, W);
  ok('default: the card\'s hour (hour 0) with its values, and the vertical line\'s hour', s.hour === 0 && fits(s.text, await want(page, W, 0)), s);
  // Hover hour 5.
  let p5 = await at(page, W, 5);
  await page.mouse.move(p5.x - 30, p5.y); await page.mouse.move(p5.x, p5.y, { steps: 3 }); await page.waitForTimeout(300);
  s = await shown(page, W);
  ok('hover on hour 5: its values match the statistics', s.hour === 5 && fits(s.text, await want(page, W, 5)), { s, w: await want(page, W, 5) });
  ok('the hovered points are highlighted', s.active.length > 0 && s.active.every(i => i === 5), s.active);
  ok('no tooltip is drawn', await page.evaluate(k => chartInstances[k].options.plugins.tooltip.enabled === false && !(chartInstances[k].tooltip.opacity > 0), W));
  // The hour stays when the pointer leaves, with its points.
  await page.mouse.move(5, 5); await page.waitForTimeout(400);
  s = await shown(page, W);
  ok('the pointer leaves: hour 5 stays (values, highlighted points)', s.hour === 5 && /^\S+ \d\d:\d\d/.test(s.text) && fits(s.text, await want(page, W, 5)) && s.active.length > 0 && s.active.every(i => i === 5), s);
  ok('other charts keep the card\'s hour', (await shown(page, 'wind_gusts_10m')).hour === 0);
  // Fixed height between hours.
  const heights = [];
  for (const i of [0, 5, 10, 47]) { const p = await at(page, W, i); await page.mouse.move(p.x, p.y, { steps: 2 }); await page.waitForTimeout(200); heights.push((await shown(page, W)).h); }
  ok('the values line has the same height at hours 0, 5, 10 and 47 (the hour, then one line of values, on a desktop)', new Set(heights).size === 1 && heights[0] === 36, heights);
  // Precipitation: chance of rain too.
  const pk = 'precipitation';
  const pp = await at(page, pk, 20); await page.mouse.move(pp.x, pp.y, { steps: 3 }); await page.waitForTimeout(250);
  s = await shown(page, pk); const wp = await want(page, pk, 20);
  ok('precipitation: the chance of rain as well', s.hour === 20 && fits(s.text, wp) && wp.chance !== null && s.text.includes(`Chance ${wp.chance}`), { s, wp });
  // Hour on its own line above the values; every value has its unit, spelled without inner spaces.
  const lay = await page.evaluate(([w, p]) => [w, p].map(k => { const [h, v] = document.getElementById(`chartValues-${k}`).children; return { hour: h.innerText, hb: h.getBoundingClientRect().bottom, vt: v.getBoundingClientRect().top, vals: v.innerText.replace(/\s+/g, ' '), title: document.getElementById(`chartUnit-${k}`).textContent }; }), [W, pk]);
  ok('range view: the hour on its own line above the values, 4 px apart', lay.every(l => /\d\d:\d\d$/.test(l.hour) && !l.vals.includes(l.hour) && Math.round(l.vt - l.hb) === 4), lay);
  ok('range view: each value has its unit: "m/s" on wind, "mm/h" on precipitation (also the chart title)', /^Median [\d.]+ m\/s · 50% [\d.]+–[\d.]+ m\/s · 80% [\d.]+–[\d.]+ m\/s · Range [\d.]+–[\d.]+ m\/s · Members \d+$/.test(lay[0].vals) && /^Median [\d.]+ mm\/h · 50% [\d.]+–[\d.]+ mm\/h · 80% [\d.]+–[\d.]+ mm\/h · Range [\d.]+–[\d.]+ mm\/h · Chance \d+% · Members \d+$/.test(lay[1].vals) && lay[1].title === 'mm/h', lay);
  // The card's hour moves the charts.
  await page.locator('#flightStrip').scrollIntoViewIfNeeded();
  await page.click('#flightStrip [data-flight-hour="7"]'); await page.waitForTimeout(400);
  const all = await page.evaluate(() => PARAMS.filter(p => processed.params[p.key].members.length).map(p => [p.key, chartInstances[p.key].$hour, document.getElementById(`chartValues-${p.key}`).innerText.startsWith(formatDayHour(processed.times[7]))]));
  ok('pin hour 7 on the flight bar: every chart shows hour 7', all.every(([k, h, t]) => h === 7 && t), all);
  // A chart can be moved off it; unpinning follows the card again.
  p5 = await at(page, W, 12); await page.mouse.move(p5.x, p5.y, { steps: 3 }); await page.waitForTimeout(250);
  ok('hover moves one chart only', (await shown(page, W)).hour === 12 && (await shown(page, 'wind_gusts_10m')).hour === 7);
  // A rebuild keeps it.
  const before = await page.evaluate(() => chartInstances.wind_speed_10m.id);
  await page.evaluate(() => rebuildAllCharts()); await page.waitForTimeout(800);
  s = await shown(page, W);
  ok('rebuildAllCharts: new chart, the selected hour (and its points) kept', await page.evaluate(([k, id]) => chartInstances[k].id !== id, [W, before]) && s.hour === 12 && s.active.every(i => i === 12) && s.active.length > 0 && fits(s.text, await want(page, W, 12)), s);
  // Jumping from a tile selects through the same function.
  await page.evaluate(() => gotoChart('wind_speed_10m', 20)); await page.waitForTimeout(600);
  ok('gotoChart selects the hour', (await shown(page, W)).hour === 20 && fits((await shown(page, W)).text, await want(page, W, 20)));
  // Ukrainian.
  await page.selectOption('#langSelect', 'uk'); await page.waitForTimeout(700);
  s = await shown(page, W);
  ok('Ukrainian labels', /Медіана .* 50% .* 80% .* Діапазон .* Членів \d+/.test(s.text), s.text);
  await page.selectOption('#langSelect', 'pt-BR'); await page.waitForTimeout(700);
  s = await shown(page, W);
  ok('Portuguese labels', /Mediana .* 50% .* 80% .* Faixa .* Membros \d+/.test(s.text), s.text);
  await page.selectOption('#langSelect', 'en'); await page.waitForTimeout(500);

  // Models mode, one line per model in the legend.
  await page.click('[data-mode="deterministic"]'); await page.waitForTimeout(3500);
  s = await shown(page, W);
  ok('Models mode, range view: the values with the number of models', /Models \d+$/.test(s.text) && s.text.includes('Median'), s.text);
  await page.evaluate(() => document.getElementById('btnMembers').click()); await page.waitForTimeout(800);
  const pm = await at(page, W, 9); await page.mouse.move(pm.x, pm.y, { steps: 3 }); await page.waitForTimeout(300);
  const leg = await page.evaluate(k => {
    const c = chartInstances[k], p = PARAMS.find(x => x.key === k), data = processed.params[k], i = c.$hour;
    const items = [...document.querySelectorAll(`#chartLegend-${k} [data-legend-model]`)];
    return { i, hidden: document.getElementById(`chartLegend-${k}`).classList.contains('hidden'), n: items.length, models: data.members.length, ok: items.every((el, j) => el.textContent === valueUnit(data.members[j].values[i], p)),
      names: items.map(el => el.parentNode.innerText.trim()), widths: items.map(el => Math.round(el.getBoundingClientRect().width)), min: items.every(el => el.getBoundingClientRect().width >= 3 * parseFloat(getComputedStyle(el).fontSize)),
      units: items.map(el => el.textContent),
      gap: Math.round(document.getElementById(`chartLegend-${k}`).getBoundingClientRect().top - document.getElementById(`chartValues-${k}`).getBoundingClientRect().bottom),
      rowGap: parseFloat(getComputedStyle(document.getElementById(`chartLegend-${k}`)).rowGap),
      values: document.getElementById(`chartValues-${k}`).innerText.replace(/\s+/g, ' ').trim(), want: formatDayHour(processed.times[i]) };
  }, W);
  ok('Models mode, per model: a value after each model\'s name in the legend, the hour above', leg.i === 9 && !leg.hidden && leg.n === leg.models && leg.n >= 2 && leg.ok && leg.values === leg.want && leg.min && /\d/.test(leg.names[0]), leg);
  ok('per model: no range values', !/Median|range/i.test(leg.values));
  ok('per model: each legend value has its unit, "m/s" on the wind chart', leg.units.length === leg.n && leg.units.every(v => /^\d+(\.\d)? m\/s$/.test(v)), leg.units);
  ok('per model: the gap from the hour to the legend is the legend\'s row gap (4 px)', leg.gap === 4 && leg.rowGap === 4, { gap: leg.gap, rowGap: leg.rowGap });
  // Legend values do not move the layout from hour to hour.
  const lw = [];
  for (const i of [3, 9, 30]) { const p = await at(page, W, i); await page.mouse.move(p.x, p.y, { steps: 2 }); await page.waitForTimeout(200); lw.push(await page.evaluate(k => [document.getElementById(`chartLegend-${k}`).offsetHeight, ...[...document.querySelectorAll(`#chartLegend-${k} > span`)].map(e => Math.round(e.getBoundingClientRect().width))].join(), W)); }
  ok('per model: the legend\'s size does not change with the hour', new Set(lw).size === 1, lw);
  await ctx.close();
}

// ---- A 390 px phone with touch
{
  const { ctx, page } = await open({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const W = 'wind_speed_10m';
  const heights = [];
  const p = await at(page, W, 5);
  await page.touchscreen.tap(p.x, p.y); await page.waitForTimeout(400);
  let s = await shown(page, W);
  heights.push(s.h);
  ok('tap on hour 5 (touch): its values match the statistics', s.hour === 5 && fits(s.text, await want(page, W, 5)), { s, w: await want(page, W, 5) });
  for (const i of [0, 10, 40]) { const q = await at(page, W, i); await page.touchscreen.tap(q.x, q.y); await page.waitForTimeout(300); const t = await shown(page, W); heights.push(t.h); if (i === 10) ok('tap on hour 10', t.hour === 10 && fits(t.text, await want(page, W, 10)), t); }
  ok('phone: the values line has the same height at hours 5, 0, 10, 40 (the hour and two lines reserved)', new Set(heights).size === 1 && heights[0] === 52, heights);
  const fit = await page.evaluate(() => PARAMS.map(p => { const e = document.getElementById(`chartValues-${p.key}`); return [p.key, e.scrollHeight <= e.clientHeight + 1]; }).filter(([, f]) => !f));
  ok('phone: the text of every chart fits in the reserved lines', fit.length === 0, fit);
  const pq = await at(page, 'precipitation', 30); await page.touchscreen.tap(pq.x, pq.y); await page.waitForTimeout(300);
  ok('phone: the precipitation line (with the chance) fits too', await page.evaluate(() => { const e = document.getElementById('chartValues-precipitation'); return /Chance \d/.test(e.innerText) && e.scrollHeight <= e.clientHeight + 1; }));
  await page.selectOption('#langSelect', 'uk'); await page.waitForTimeout(700);
  const pu = await at(page, 'precipitation', 30); await page.touchscreen.tap(pu.x, pu.y); await page.waitForTimeout(300);
  const ukFit = await page.evaluate(() => PARAMS.filter(p => processed.params[p.key].members.length).map(p => { const e = document.getElementById(`chartValues-${p.key}`); return [p.key, e.scrollHeight, e.clientHeight, e.innerText]; }).filter(r => !r[1] || r[1] > r[2] + 1));
  ok('phone, Ukrainian: every values line fits in the reserved lines (three of values for precipitation)', ukFit.length === 0, ukFit);
  await page.selectOption('#langSelect', 'en'); await page.waitForTimeout(500);
  // Models mode: the range view keeps two lines, per model (hour only) is one line.
  await page.evaluate(() => document.querySelector('[data-mode="deterministic"]').click()); await page.waitForTimeout(3500);
  const hh = () => page.evaluate(() => document.getElementById('chartValues-wind_speed_10m').offsetHeight);
  const hRange = await hh();
  await page.evaluate(() => document.getElementById('btnMembers').click()); await page.waitForTimeout(800);
  const hModel = await hh();
  ok('phone: per-model values element the hour only (16 px), range view the hour and two lines (52 px)', hModel === 16 && hRange === 52, { hRange, hModel });
  ok('no horizontal scroll from the values line', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1 && document.getElementById('chartWrap-precipitation').scrollWidth <= document.getElementById('chartWrap-precipitation').clientWidth + 1));
  await ctx.close();
}
ok('no page errors', !errors.filter(e => !/tailwind/.test(e)).length, errors.filter(e => !/tailwind/.test(e)));
await b.close();
