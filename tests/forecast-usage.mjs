// Open-Meteo calls used and left: the two meters in the side menu (last hour, last 24 h: the
// share, "used · left", the mark where map requests pause, the fuller of the two APIs, calm /
// amber / red at 60 % and at the pause mark, never a negative "left", an over-full log clamped),
// the gauge on the "Can I fly now?" card (same state, numbers in its title, a tap opens the side
// menu), the meters updating after a request without reopening the menu, Ukrainian, the map's
// side menu, and the card's footer row on a 390 px phone.
import { routeAll } from './lib/mock.mjs';
import { launch, BASE_URL, ok } from './lib/env.mjs';
const b = await launch();
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
const page = await ctx.newPage();
const errors = []; page.on('pageerror', e => errors.push(e.message));
await routeAll(page, {});
await page.goto(BASE_URL);
await page.evaluate(() => { localStorage.clear(); localStorage.setItem('flysky_last_location', JSON.stringify({ name: 'Kyiv', latitude: 50.45, longitude: 30.52, country: 'Ukraine', elevation: 179 })); });
await page.reload(); await page.waitForTimeout(5000);
const I = (fn, arg) => page.evaluate(fn, arg);
const drawerOpen = () => I(() => !document.getElementById('settingsDrawer').classList.contains('-translate-x-full'));
const drawer = async on => { if ((await drawerOpen()) !== on) { await page.click(on ? '#btnSettings' : '#btnSettingsClose'); await page.waitForTimeout(400); } };
// Fills the log: [ms ago, cost, pool]; the meters are redrawn.
const fill = entries => I(e => { omLog.length = 0; for (const [ago, cost, pool] of [...e].sort((a, b) => b[0] - a[0])) omLog.push([Date.now() - ago, cost, pool]); renderOmUsage(); }, entries);
// What the two meters (in the side menu) and the gauge show.
const meters = () => I(() => [...document.querySelectorAll('#omMeters [role=meter], [data-om-meters] [role=meter]')].slice(0, 2).map(m => ({
    now: +m.getAttribute('aria-valuenow'), max: +m.getAttribute('aria-valuemax'), text: m.getAttribute('aria-valuetext'), label: m.getAttribute('aria-label'),
    fill: m.querySelector('.om-fill').style.width, color: getComputedStyle(m.querySelector('.om-fill')).backgroundColor, mark: m.querySelector('.om-mark').style.left,
    line: m.parentElement.querySelector('p').innerText })));
const gauge = () => I(() => { const g = document.getElementById('omGauge'); return { title: g.title, aria: g.getAttribute('aria-label'), fills: [...g.querySelectorAll('.om-fill')].map(f => ({ w: f.style.width, c: getComputedStyle(f).backgroundColor })) }; });
const CALM = 'rgb(34, 211, 238)', AMBER = 'rgb(250, 178, 25)', RED = 'rgb(208, 59, 59)';
const MIN = 60e3, HOUR = 3600e3;

await drawer(true);
// ---- Nothing used: empty bars, not hidden
await fill([]);
let m = await meters();
ok('nothing used: both bars there and empty, 0 used · all left', m.length === 2 && m[0].fill === '0%' && m[1].fill === '0%' && m[0].text === '0 used · 5,000 left of 5,000' && m[1].text === '0 used · 10,000 left of 10,000', m);
ok('each meter: role, range and value announced; the label says which period', m[0].max === 5000 && m[1].max === 10000 && m[0].label === 'Last hour' && m[1].label === 'Last 24 h', m);
ok('the pause mark is at 85 % of the hour, 90 % of the day (from OM_SOFT)', m[0].mark === '85%' && m[1].mark === '90%', m);

// ---- Shares match the log
await fill([[10 * MIN, 312, 'f'], [5 * HOUR, 1000, 'f']]);
m = await meters();
ok('312 in the hour, 1,312 in the day: shares, numbers in words', m[0].fill === '6.2%' && m[0].text === '312 used · 4,688 left of 5,000' && m[1].fill === '13.1%' && m[1].text === '1,312 used · 8,688 left of 10,000', m);
ok('calm below 60 %', m[0].color === CALM && m[1].color === CALM, m);
ok('the caption says it is this browser\'s own use and that others count too', /own use/.test(await page.locator('#omMeters, [data-om-meters]').first().innerText()) && /Others on the same connection/.test(await page.locator('[data-om-meters]').first().innerText()));

// ---- The two APIs apart
await fill([[10 * MIN, 290, 'e'], [10 * MIN, 22, 'f'], [2 * HOUR, 100, 'e']]);
m = await meters();
ok('two APIs: the bar follows the fuller one (ensemble 290), left is the limit minus it', m[0].now === 290 && m[0].text === '290 used · 4,710 left of 5,000' && m[0].fill === '5.8%', m);
ok('the line under it names both; the day line has the ensemble\'s 390', m[0].line === 'ensemble 290 · forecast 22' && m[1].line === 'ensemble 390 · forecast 22', m.map(x => x.line));
await fill([[10 * MIN, 100, 'e'], [10 * MIN, 400, 'f'], [3 * HOUR, 50, 'e']]);
m = await meters();
ok('the forecast API fuller: the bar follows it; an entry without a pool counts as forecast', m[0].now === 400 && m[0].line === 'ensemble 100 · forecast 400', m);
await fill([[10 * MIN, 5, undefined]]);
ok('entry without a pool: forecast', (await meters())[0].line === 'ensemble 0 · forecast 5');

// ---- Colours: hour at 3,000 (60 %) and at the pause mark 4,250 (85 %)
await fill([[MIN * 10, 2999, 'f']]);
ok('hour at 59.98 %: calm', (await meters())[0].color === CALM);
await fill([[MIN * 10, 3000, 'f']]);
m = await meters();
ok('hour at 60 %: amber, the gauge too', m[0].color === AMBER && (await gauge()).fills[0].c === AMBER && (await gauge()).fills[1].c === CALM, m[0]);
await fill([[MIN * 10, 4249, 'f']]);
ok('hour just below the pause mark: amber', (await meters())[0].color === AMBER);
await fill([[MIN * 10, 4250, 'f']]);
ok('hour at the pause mark (85 %): red, the gauge too', (await meters())[0].color === RED && (await gauge()).fills[0].c === RED);
// The day: spread over the day so the hour stays calm.
await fill([[5 * HOUR, 6000, 'e']]);
m = await meters();
ok('day at 60 %: amber, the hour calm', m[1].color === AMBER && m[0].color === CALM && m[1].fill === '60%', m);
await fill([[5 * HOUR, 8999, 'e']]);
ok('day just below its mark (90 %): amber', (await meters())[1].color === AMBER);
await fill([[5 * HOUR, 9000, 'e']]);
ok('day at the pause mark (90 %): red, the gauge\'s second bar too', (await meters())[1].color === RED && (await gauge()).fills[1].c === RED);

// ---- Over-full log
await fill([[MIN * 10, 7000, 'f']]);
m = await meters();
ok('over the limit: bar clamped to 100 %, the true number kept, left is 0 (never negative)', m[0].fill === '100%' && m[0].text === '7,000 used · 0 left of 5,000' && m[0].now === 5000 && m[0].color === RED, m);
ok('the gauge clamps too', (await gauge()).fills[0].w === '100%');

// ---- The gauge on the card
await drawer(false);
await fill([[MIN * 10, 312, 'f'], [5 * HOUR, 1000, 'f']]);
const g = await gauge();
ok('gauge: two bars of the same shares, numbers in the title and the label, no text', g.fills.length === 2 && g.fills[0].w === '6.2%' && g.fills[1].w === '13.1%' && g.title === 'Open-Meteo calls used by this browser, last hour: 312 of 5,000 · last 24 h: 1,312 of 10,000' && g.aria === g.title && await I(() => document.getElementById('omGauge').innerText) === '', g);
await page.click('#omGauge'); await page.waitForTimeout(400);
ok('a tap on the gauge opens the side menu', await drawerOpen());

// ---- Updates after a request, without reopening the menu
await fill([]);
const before = (await meters())[0].now;
await page.click('#btnSettingsClose'); await page.waitForTimeout(400);
await page.click('#btnSettings'); await page.waitForTimeout(400);
await I(() => { document.querySelector('#modelChips').dataset.keep = '1'; });
await I(() => document.getElementById('btnRefresh').click()); await page.waitForTimeout(800);
const after = await meters();
ok('Refresh with the menu open: the meters follow the new calls, the menu itself not redrawn', before === 0 && after[0].now > 0 && after[0].now === await I(() => Math.round(omUsed(3600e3, 'e'))) && await I(() => document.querySelector('#modelChips').dataset.keep) === '1', { before, after: after[0] });
ok('and the gauge', (await gauge()).fills[0].w !== '0%');
// Old calls drop out as time passes (the minute timer calls the same function)
await I(() => { omLog[omLog.length - 1][0] -= 3700e3; omLog.sort((a, b) => a[0] - b[0]); renderOmUsage(); });
ok('a call older than an hour is out of the hour, still in the day', (await meters())[0].now < after[0].now && (await meters())[1].now >= after[0].now);

// ---- Ukrainian
await fill([[10 * MIN, 312, 'f']]);
await page.selectOption('#langSelect', 'uk'); await page.waitForTimeout(600);
m = await meters();
ok('Ukrainian: label, numbers with the page\'s grouping, the line under', m[0].label === 'Остання година' && m[0].text.startsWith('312 використано · 4') && /залишилось із 5\s000$/.test(m[0].text.replace(/[  ]/g, ' ')) && m[0].line === 'ансамбль 0 · прогноз 312', m);
ok('Ukrainian gauge title', /^Виклики Open-Meteo цим браузером, остання година: 312 з /.test((await gauge()).title), await gauge());
await page.selectOption('#langSelect', 'en'); await page.waitForTimeout(500);
await drawer(false);

// ---- The map's side menu
await page.evaluate(() => localStorage.setItem('flysky_view', JSON.stringify('map')));
await page.reload(); await page.waitForTimeout(3500);
await fill([[10 * MIN, 312, 'f'], [5 * HOUR, 1000, 'f']]);
await drawer(true);
const mm = await I(() => [...document.querySelectorAll('#drawerMap [role=meter]')].map(x => x.getAttribute('aria-valuetext')));
ok('map side menu: the same two meters (Layers card)', mm.length === 2 && mm[0] === '312 used · 4,688 left of 5,000' && mm[1] === '1,312 used · 8,688 left of 10,000' && await I(() => !!document.querySelector('#drawerMap section [data-om-meters]')), mm);
await I(() => omRecord(100, 'f')); await I(() => renderOmUsage());
ok('and they update with the log', (await I(() => document.querySelector('#drawerMap [role=meter]').getAttribute('aria-valuetext'))).startsWith('412 used'));

// ---- A 390 px phone: the footer row of the card
const phone = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
const p2 = await phone.newPage(); await routeAll(p2, {});
await p2.goto(BASE_URL);
await p2.evaluate(() => { localStorage.clear(); localStorage.setItem('flysky_last_location', JSON.stringify({ name: 'Kyiv', latitude: 50.45, longitude: 30.52, country: 'Ukraine', elevation: 179 })); });
await p2.reload(); await p2.waitForTimeout(5000);
await p2.evaluate(() => { omLog.length = 0; omRecord(4300); renderOmUsage(); });
const row = await p2.evaluate(() => {
    const meta = document.getElementById('forecastMeta'), row = meta.parentElement, gb = document.getElementById('omGauge').getBoundingClientRect(), mb = row.querySelector('button:not(#omGauge)').getBoundingClientRect(), r = row.getBoundingClientRect();
    return { scroll: document.documentElement.scrollWidth, row: [Math.round(r.left), Math.round(r.right)], gauge: [Math.round(gb.left), Math.round(gb.right), Math.round(gb.height)], models: [Math.round(mb.left), Math.round(mb.right), Math.round(mb.height)], metaRight: Math.round(meta.getBoundingClientRect().right) };
});
ok('390 px: no horizontal overflow; gauge and Models inside the row, side by side, the source line left of them', row.scroll <= 390 && row.gauge[1] <= row.models[0] + 1 && row.models[1] <= row.row[1] + 1 && row.metaRight <= row.gauge[0] + 1 && row.gauge[2] <= row.models[2], row);
await p2.locator('#forecastMeta').locator('..').screenshot({ path: 'usage-phone.png' });
await p2.click('#omGauge'); await p2.waitForTimeout(500);
await p2.screenshot({ path: 'usage-phone-menu.png' });
await page.screenshot({ path: 'usage-desktop.png' });

ok('no page errors', errors.every(e => /tailwind is not defined/.test(e)), errors.filter(e => !/tailwind is not defined/.test(e)));
await b.close();
