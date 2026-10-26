// Flight time calculator (map tool): points, airspeed, wind triangle, ETA, return leg.
import { routeAll } from './lib/mock.mjs';
import { launch, BASE_URL, ok } from './lib/env.mjs';
const b = await launch();
const mobile = process.argv.includes('--mobile');
const ctx = await b.newContext(mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block' } : { viewport: { width: 1280, height: 860 }, serviceWorkers: 'block' });
const page = await ctx.newPage();
const errors = []; page.on('pageerror', e => errors.push(e.message));
const opts = {};
const { log } = await routeAll(page, opts);
await page.goto(BASE_URL);
await page.evaluate(() => { localStorage.setItem('flysky_last_location', JSON.stringify({ name: 'Kyiv', latitude: 50.45, longitude: 30.52, country: 'Ukraine' })); localStorage.setItem('flysky_view', JSON.stringify('map')); localStorage.setItem('flysky_map_settings', JSON.stringify({ product: 'fog', productAt: Date.now(), view: { center: [50.45, 30.52], zoom: 8 } })); });
await page.reload(); await page.waitForTimeout(3500);
const I = fn => page.evaluate(fn);
const result = () => page.locator('#mapRouteResult').innerText();
// Screen point of a lat/lng (for taps).
const pt = (lat, lng) => page.evaluate(([la, lo]) => { const p = FlySkyMap._internals.R.map.latLngToContainerPoint([la, lo]); const r = document.getElementById('satMap').getBoundingClientRect(); return { x: r.left + p.x, y: r.top + p.y }; }, [lat, lng]);
const tap = async (lat, lng) => { const p = await pt(lat, lng); await page.mouse.click(p.x, p.y); };

// open the tool: A = forecast location, readout makes way
await page.click('#mapRouteBtn'); await page.waitForTimeout(400);
ok('panel opens, readout hidden', await page.isVisible('#mapRoute') && !(await page.isVisible('#mapProbe')) && !(await page.isVisible('#mapCrosshair')));
ok('A at the forecast location, hint to set B', await I(() => document.querySelectorAll('.fs-route-pt').length) === 1 && /destination B/.test(await page.locator('#mapRouteHint').innerText()));

// tap B ~40 km due east; wind 6 m/s from the west = tailwind
await tap(50.45, 31.083); await page.waitForTimeout(1200);
let r = await result();
console.log('    east, 22 m/s:', r.replace(/\n/g, ' | '));
const gs = +(r.match(/ground speed ([\d.]+)/) || [])[1];
ok('B set: line, two points, wind read once', await I(() => document.querySelectorAll('.fs-route-pt').length) === 2 && (log.routeReq || []).length === 1, log.routeReq);
ok('tailwind 6 → ground speed ≈ 28 m/s', gs > 27.8 && gs <= 28.05 && /tailwind 6\.0/.test(r), gs);
const minutes = s => { const m = s.match(/(?:(\d+) h )?(\d+) min/); return m ? (+(m[1] || 0)) * 60 + +m[2] : NaN; };
const out = minutes(r.split('\n')[0]), back = minutes(r.split('Back:')[1] || '');
ok('flight time ≈ 40 km / 28 m/s ≈ 24 min, ETA shown', Math.abs(out - 24) <= 1 && /ETA \d\d:\d\d/.test(r), { out });
ok('back against the wind takes longer (≈ 42 min)', Math.abs(back - 42) <= 1, { back });
ok('distance and time on the map', /km · \d+ min/.test(await I(() => document.querySelector('.fs-route-label').textContent)));

// airspeed slider: slower → longer, no new request
await page.locator('[data-route-speed]').fill('18'); await page.waitForTimeout(300);
r = await result();
ok('airspeed 18 m/s → ground speed 24, longer flight', /ground speed 24\.0/.test(r) && minutes(r.split('\n')[0]) > out && (log.routeReq || []).length === 1, r.split('\n')[0]);
ok('airspeed shown in m/s and km/h', /18 m\/s · 65 km\/h/.test(await page.locator('#mapRouteSpeed').innerText()));

// another height: one request for it
await page.selectOption('[data-route-level]', '800m'); await page.waitForTimeout(1000);
ok('wind height ~800 m asks 925 hPa', (log.routeReq || []).at(-1) === 'wind_speed_925hPa,wind_direction_925hPa', log.routeReq);

// swap: now against the wind
await page.click('[data-route-swap]'); await page.waitForTimeout(800);
r = await result();
ok('swap → headwind', /headwind 6\.0/.test(r), r.split('\n')[1]);

// a crosswind stronger than the airspeed
opts.routeWind = { speed: 25, from: 0 };
await page.selectOption('[data-route-level]', '1500m'); await page.waitForTimeout(1000);
ok('too strong a crosswind: no headway', /Can't make headway/.test(await result()));
opts.routeWind = null;

// drag B
const before = await I(() => JSON.parse(localStorage.getItem('flysky_map_settings')).route.b);
// B into the open upper part of the map (the panels sit at the bottom).
await page.evaluate(([la, lo]) => { const m = FlySkyMap._internals.R.map; m.setView([la, lo], m.getZoom(), { animate: false }); m.panBy([0, 200], { animate: false }); }, before);
await page.waitForTimeout(500);
const pb = await pt(before[0], before[1]);
await page.mouse.move(pb.x, pb.y); await page.mouse.down(); await page.mouse.move(pb.x, pb.y - 60, { steps: 6 }); await page.mouse.up(); await page.waitForTimeout(800);
const afterB = await I(() => JSON.parse(localStorage.getItem('flysky_map_settings')).route.b);
ok('dragging B moves it (saved)', afterB[0] > before[0] + 0.05, { before, afterB });

// clear + close
await page.click('[data-route-clear]'); await page.waitForTimeout(300);
ok('clear: back to A only', await I(() => document.querySelectorAll('.fs-route-pt').length) === 1);
await page.click('[data-route-close]'); await page.waitForTimeout(300);
ok('close: tool gone, readout back', !(await page.isVisible('#mapRoute')) && await page.isVisible('#mapProbe') && await I(() => document.querySelectorAll('.fs-route-pt').length) === 0);
ok('taps do nothing with the tool closed', await (async () => { await tap(50.6, 31.2); await page.waitForTimeout(300); return I(() => !JSON.parse(localStorage.getItem('flysky_map_settings')).route.b); })());
ok('no page errors', !errors.filter(e => !/tailwind/.test(e)).length, errors.filter(e => !/tailwind/.test(e)));
await b.close();
