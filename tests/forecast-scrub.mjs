// "Can I fly now?" card: hour scrubber (slide by mouse and touch, tap, step
// buttons, keyboard), "Now" back to the current hour, the card following the
// selected hour, one selected hour shared with the flight bar, Map button.
import { routeAll } from './lib/mock.mjs';
import { launch, BASE_URL, ok } from './lib/env.mjs';
const b = await launch();
const mobile = process.argv.includes('--mobile');
const ctx = await b.newContext(mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block' } : { viewport: { width: 1280, height: 900 }, hasTouch: true, serviceWorkers: 'block' });
const page = await ctx.newPage();
const errors = []; page.on('pageerror', e => errors.push(e.message));
await routeAll(page, {});
await page.goto(BASE_URL);
await page.evaluate(() => { localStorage.setItem('flysky_last_location', JSON.stringify({ name: 'Kyiv', latitude: 50.45, longitude: 30.52, country: 'Ukraine' })); localStorage.setItem('flysky_view', JSON.stringify('forecast')); localStorage.setItem('flysky_window', '48'); });
await page.reload();
await page.waitForSelector('#nowStrip', { timeout: 20000 });
await page.waitForTimeout(800);
const I = (fn, arg) => page.evaluate(fn, arg);
const sel = () => I(() => Number(document.getElementById('nowStrip').getAttribute('aria-valuenow')));
const n = await I(() => processed.flight.hours.length);
const title = () => page.locator('#nowMain h3').innerText();
const strip = await I(() => { const r = document.getElementById('nowStrip').getBoundingClientRect(); return { x: r.left, y: r.top + r.height / 2, w: r.width }; });
const xOf = i => strip.x + (i + 0.5) / n * strip.w;
await page.locator('#nowStrip').scrollIntoViewIfNeeded();
const s2 = await I(() => { const r = document.getElementById('nowStrip').getBoundingClientRect(); return { y: r.top + r.height / 2 }; });
strip.y = s2.y;

ok('opens on the current hour', await sel() === 0 && /Can I fly now\?/.test(await title()) && !(await page.isVisible('[data-now-back]')));
ok('strip: one cell per hour, stacked by share', await I(() => document.querySelectorAll('#nowStrip > div:first-child > div').length) === n && await I(() => /linear-gradient/.test(document.querySelector('#nowStrip > div:first-child > div').style.background)));

// Slide with the mouse: the selection follows step by step, also past the strip's end.
await page.mouse.move(xOf(0), strip.y); await page.mouse.down();
const seen = [];
const tops = [];
for (const i of [3, 7, 12, 20]) { await page.mouse.move(xOf(i), strip.y, { steps: 3 }); seen.push(await sel()); tops.push(await I(() => document.getElementById('nowStrip').getBoundingClientRect().top)); }
await page.mouse.move(strip.x + strip.w + 80, strip.y + 40, { steps: 3 }); seen.push(await sel());
await page.mouse.move(xOf(10), strip.y + 60, { steps: 3 }); seen.push(await sel());
await page.mouse.up();
ok('strip stays under the pointer while the card changes', Math.max(...tops) - Math.min(...tops) <= 1, tops);
ok('mouse slide: follows the pointer (also off the strip)', JSON.stringify(seen) === JSON.stringify([3, 7, 12, 20, n - 1, 10]), seen);
const st = await I(() => { const i = 10, h = processed.flight.hours[i]; return { time: formatDayHour(h.time), status: t(FLIGHT_STATUS[h.status].labelKey), pinned: [...document.querySelectorAll('#flightStrip [data-flight-hour]')].findIndex(c => c.hasAttribute('data-pinned')) }; });
const main = await page.locator('#nowMain').innerText();
ok('card shows the selected hour', /Can I fly then\?/.test(await title()) && main.includes(st.time) && main.includes(st.status), { st, head: main.slice(0, 120) });
ok('flight bar pins the same hour', st.pinned === 10, st.pinned);
ok('"Now" button shown', await page.isVisible('[data-now-back]'));
// Tiles follow the hour
const tileOk = await I(() => { const h = processed.flight.hours[10]; const v = h.values.gust; return [...document.querySelectorAll('#nowMain .grid > div')][2].innerText.includes(formatValue(v, PARAMS.find(p => p.key === 'wind_speed_10m'))); });
ok('tiles show the selected hour', tileOk);

// Touch slide (real touch events → pointer events)
const cdp = await ctx.newCDPSession(page);
const touch = (type, x) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y: strip.y }] });
await touch('touchStart', xOf(2));
const tseen = [await sel()];
for (const i of [5, 9, 14]) { await touch('touchMove', xOf(i - 1)); await touch('touchMove', xOf(i)); await page.waitForTimeout(60); tseen.push(await sel()); }
await touch('touchEnd');
ok('touch slide: follows the finger', JSON.stringify(tseen) === JSON.stringify([2, 5, 9, 14]), tseen);
// Tap
await page.mouse.click(xOf(6), strip.y);
ok('tap selects an hour', await sel() === 6);

// Step buttons and keyboard
await page.click('[data-now-step="1"]');
ok('next-hour button', await sel() === 7);
await page.click('[data-now-step="-1"]'); await page.click('[data-now-step="-1"]');
ok('previous-hour button', await sel() === 5);
await page.focus('#nowStrip');
await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
ok('arrow keys', await sel() === 7);
await page.keyboard.press('End');
ok('End → last hour', await sel() === n - 1);
await page.keyboard.press('Home');
ok('Home → now', await sel() === 0 && /Can I fly now\?/.test(await title()));

// Flight bar → card
await page.evaluate(() => document.getElementById('flightCard').scrollIntoView());
await page.click('#flightStrip [data-flight-hour="15"]');
ok('pin on the flight bar moves the card', await sel() === 15);
// Now
await page.locator('[data-now-back]').scrollIntoViewIfNeeded();
await page.click('[data-now-back]');
ok('"Now": back to the current hour, flight bar unpinned', await sel() === 0 && await I(() => !document.querySelector('#flightStrip [data-pinned]')) && !(await page.isVisible('[data-now-back]')));

// Map button for the selected hour
await page.focus('#nowStrip'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
await page.click('#nowMain [data-flight-map]');
await page.waitForTimeout(800);
ok('Map button opens the satellite map', await I(() => !document.getElementById('mapView').classList.contains('hidden')));
ok('no page errors', !errors.filter(e => !/tailwind/.test(e)).length, errors.filter(e => !/tailwind/.test(e)));
await b.close();
