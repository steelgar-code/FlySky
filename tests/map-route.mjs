// Flight time calculator (map tool): A at the crosshair, B following the crosshair
// or pinned by a tap / drag / MGRS, airspeed, wind triangle, ETA, return leg.
// Also the map defaults for new users and the deeper zoom.
import { routeAll } from './lib/mock.mjs';
import { launch, BASE_URL, ok } from './lib/env.mjs';
const b = await launch();
const mobile = process.argv.includes('--mobile');
const ctxOpts = mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block' } : { viewport: { width: 1280, height: 860 }, serviceWorkers: 'block' };
const KYIV = { name: 'Kyiv', latitude: 50.45, longitude: 30.52, country: 'Ukraine' };

// ---- new users: map defaults
{
    const ctx = await b.newContext(ctxOpts);
    const page = await ctx.newPage();
    await routeAll(page, {});
    await page.goto(BASE_URL);
    await page.evaluate(k => { localStorage.setItem('flysky_last_location', JSON.stringify(k)); localStorage.setItem('flysky_view', JSON.stringify('map')); }, KYIV);
    await page.reload(); await page.waitForTimeout(3000);
    const d = await page.evaluate(() => { const { S, R } = FlySkyMap._internals; return { labels: S.labels, borders: S.borders, wind: S.wind.on, utc: S.utc, max: R.map.getMaxZoom() }; });
    ok('new users: place names and borders off, wind on, local time', !d.labels && !d.borders && d.wind && !d.utc, d);
    ok('map zooms in to 18', d.max === 18, d.max);
    // Deep zoom: the satellite image stays at its own resolution (zoom 11 extent).
    await page.evaluate(() => FlySkyMap._internals.R.map.setZoom(16, { animate: false }));
    await page.waitForTimeout(1500);
    const z = await page.evaluate(() => { const { R } = FlySkyMap._internals; return { zoom: R.map.getZoom(), ext: R.extent && R.extent.zoom }; });
    ok('zoom 16: satellite extent capped at zoom 11', z.zoom === 16 && z.ext === 11, z);
    await ctx.close();
}

const ctx = await b.newContext(ctxOpts);
const page = await ctx.newPage();
const errors = []; page.on('pageerror', e => errors.push(e.message));
const opts = {};
const { log } = await routeAll(page, opts);
await page.goto(BASE_URL);
await page.evaluate(k => { localStorage.setItem('flysky_last_location', JSON.stringify(k)); localStorage.setItem('flysky_view', JSON.stringify('map')); localStorage.setItem('flysky_map_settings', JSON.stringify({ product: 'fog', productAt: Date.now(), wind: { on: false }, view: { center: [50.45, 30.52], zoom: 8 } })); }, KYIV);
await page.reload(); await page.waitForTimeout(3500);
const I = (fn, arg) => page.evaluate(fn, arg);
const result = () => page.locator('#mapRouteResult').innerText();
const head = () => page.locator('#mapRouteHead').innerText();
const reqs = () => (log.routeReq || []).length;
const points = () => I(() => [...document.querySelectorAll('.fs-route-pt')].map(m => m.textContent).join(''));
const center = () => I(() => { const c = FlySkyMap._internals.R.map.getCenter(); return [c.lat, c.lng]; });
const setView = (lat, lng) => I(([la, lo]) => FlySkyMap._internals.R.map.setView([la, lo], FlySkyMap._internals.R.map.getZoom(), { animate: false }), [lat, lng]);
// Screen point of a lat/lng (for taps).
const pt = (lat, lng) => I(([la, lo]) => { const p = FlySkyMap._internals.R.map.latLngToContainerPoint([la, lo]); const r = document.getElementById('satMap').getBoundingClientRect(); return { x: r.left + p.x, y: r.top + p.y }; }, [lat, lng]);
const tap = async (lat, lng) => { const p = await pt(lat, lng); await page.mouse.click(p.x, p.y); };
const minutes = s => { const m = s.match(/(?:(\d+) h )?(\d+) min/); return m ? (+(m[1] || 0)) * 60 + +m[2] : NaN; };

// open the tool: A at the crosshair, B follows it
await page.click('#mapRouteBtn'); await page.waitForTimeout(400);
ok('panel opens, readout hidden, crosshair shown', await page.isVisible('#mapRoute') && !(await page.isVisible('#mapProbe')) && await page.isVisible('#mapCrosshair'));
ok('A at the crosshair, B on it, hint to pan', await points() === 'AB' && /Pan the map/.test(await result()));

// pan with the mouse: B follows the crosshair while dragging
const sm = await I(() => { const r = document.getElementById('satMap').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 120 }; });
await page.mouse.move(sm.x, sm.y); await page.mouse.down();
await page.mouse.move(sm.x - 60, sm.y, { steps: 6 });
await page.waitForTimeout(100);
const mid = await I(() => { const { RT, R } = FlySkyMap._internals; const b = RT.markers.at(-1).getLatLng(), c = R.map.getCenter(); return Math.abs(b.lng - c.lng) + Math.abs(b.lat - c.lat); });
ok('B follows the crosshair during the drag', mid < 1e-6, mid);
await page.mouse.move(sm.x - 100, sm.y, { steps: 4 }); await page.mouse.up();
await page.waitForTimeout(1200);
ok('panning reads the wind once (debounced)', reqs() === 1, log.routeReq);
ok('result after panning', /min/.test(await head()) && /tailwind/.test(await result()), await head());

// exactly 40 km east of A: 6 m/s from the west = tailwind
await setView(50.45, 31.083); await page.waitForTimeout(1200);
let r = await result();
console.log('    east, 22 m/s:', (await head()) + ' | ' + r.replace(/\n/g, ' | '));
const gs = +(r.match(/ground speed ([\d.]+)/) || [])[1];
ok('tailwind 6 → ground speed ≈ 28 m/s', gs > 27.8 && gs <= 28.05 && /tailwind 6\.0/.test(r), gs);
const out = minutes(await head()), back = minutes(r.split('Back:')[1] || '');
ok('flight time ≈ 40 km / 28 m/s ≈ 24 min, ETA shown', Math.abs(out - 24) <= 1 && /ETA \d\d:\d\d/.test(await head()), { out });
ok('back against the wind takes longer (≈ 42 min)', Math.abs(back - 42) <= 1, { back });
ok('distance and time on the map', /km · \d+ min/.test(await I(() => document.querySelector('.fs-route-label').textContent)));

// airspeed slider: slower → longer, no new request
await page.click('[data-route-more]'); await page.waitForTimeout(200);
const n0 = reqs();
await page.locator('[data-route-speed]').fill('18'); await page.waitForTimeout(300);
r = await result();
ok('airspeed 18 m/s → ground speed 24, longer flight', /ground speed 24\.0/.test(r) && minutes(await head()) > out && reqs() === n0, await head());
ok('airspeed shown in m/s and km/h', /18 m\/s · 65 km\/h/.test(await page.locator('#mapRouteSpeed').innerText()));
ok('MGRS of A and B listed', /^A 36U \w\w \d{5} \d{5}\nB 36U \w\w \d{5} \d{5}$/.test(await page.locator('#mapRouteCoords').innerText()), await page.locator('#mapRouteCoords').innerText());

// another height: one request for it
await page.selectOption('[data-route-level]', '800m'); await page.waitForTimeout(1000);
ok('wind height ~800 m asks 925 hPa', (log.routeReq || []).at(-1) === 'wind_speed_925hPa,wind_direction_925hPa', log.routeReq);
await page.selectOption('[data-route-level]', '120m'); await page.waitForTimeout(800);

// a tap pins B; panning then leaves it alone
// in the open upper part of the map (hazard chips at the top, panels at the bottom)
const tapAt = await I(() => { const m = FlySkyMap._internals.R.map, r = document.getElementById('satMap').getBoundingClientRect(); const ll = m.containerPointToLatLng([r.width / 2 - 40, 190]); return { x: r.left + r.width / 2 - 40, y: r.top + 190, lat: ll.lat, lng: ll.lng }; });
await page.mouse.click(tapAt.x, tapAt.y); await page.waitForTimeout(800);
let rt = await I(() => { const { RT } = FlySkyMap._internals; return { follow: RT.follow, b: RT.markers.at(-1).getLatLng() }; });
ok('tap pins B there', !rt.follow && Math.abs(rt.b.lat - tapAt.lat) < 0.01 && Math.abs(rt.b.lng - tapAt.lng) < 0.01 && !(await page.isChecked('[data-route-follow]')), rt);
await setView(50.3, 30.2); await page.waitForTimeout(300);
rt = await I(() => FlySkyMap._internals.RT.markers.at(-1).getLatLng());
ok('pinned B stays when the map moves', Math.abs(rt.lat - tapAt.lat) < 0.01, rt);
await tap(50.7, 30.3); await page.waitForTimeout(600);
ok('another tap moves the pinned B', await I(() => Math.abs(FlySkyMap._internals.RT.markers.at(-1).getLatLng().lat - 50.7) < 0.01) && await points() === 'AB');

// follow on again: B jumps to the crosshair
await page.click('label:has([data-route-follow])'); await page.waitForTimeout(400);
const c1 = await center();
ok('follow on: B back at the crosshair', await I(c => { const b = FlySkyMap._internals.RT.markers.at(-1).getLatLng(); return Math.abs(b.lat - c[0]) < 1e-6 && Math.abs(b.lng - c[1]) < 1e-6; }, c1));

// swap: now against the wind
await setView(50.45, 31.083); await page.waitForTimeout(300);
await I(() => { FlySkyMap._internals.RT.a = L.latLng(50.45, 30.52); });   // A back at Kyiv, B (following) 40 km east
await page.click('[data-route-swap]'); await page.waitForTimeout(900);
r = await result();
ok('swap → headwind, B pinned', /headwind 6\.0/.test(r) && await I(() => !FlySkyMap._internals.RT.follow), r);

// a crosswind stronger than the airspeed
opts.routeWind = { speed: 25, from: 0 };
await page.selectOption('[data-route-level]', '1500m'); await page.waitForTimeout(1000);
ok('too strong a crosswind: no headway', /Can't make headway/.test(await result()));
opts.routeWind = null;
await page.selectOption('[data-route-level]', '120m'); await page.waitForTimeout(800);

// drag the pinned B (into the open upper part of the map, panels sit at the bottom)
const before = await I(() => { const b = FlySkyMap._internals.RT.markers.at(-1).getLatLng(); return [b.lat, b.lng]; });
await I(([la, lo]) => { const m = FlySkyMap._internals.R.map; m.setView([la, lo], m.getZoom(), { animate: false }); m.panBy([0, 200], { animate: false }); }, before);
await page.waitForTimeout(500);
const pb = await pt(before[0], before[1]);
await page.mouse.move(pb.x, pb.y); await page.mouse.down(); await page.mouse.move(pb.x, pb.y - 60, { steps: 6 }); await page.mouse.up(); await page.waitForTimeout(800);
const afterB = await I(() => { const b = FlySkyMap._internals.RT.markers.at(-1).getLatLng(); return [b.lat, b.lng]; });
ok('dragging B moves it', afterB[0] > before[0] + 0.05, { before, afterB });

// MGRS: two references = waypoint 1 and B; the map jumps to them
const refs = await I(() => { const { MGRS } = FlySkyMap._internals; return [MGRS.forward(49.9, 31.5), MGRS.forward(49.6, 32.0)]; });
await page.fill('[data-route-mgrs] input', `${refs[0]}\n${refs[1].replace(/ /g, '')}`);
await page.click('[data-route-mgrs] button'); await page.waitForTimeout(1200);
const mg = await I(() => { const { RT, R } = FlySkyMap._internals; return { pts: RT.markers.map(m => [m.getLatLng().lat, m.getLatLng().lng]), inView: RT.markers.every(m => R.map.getBounds().contains(m.getLatLng())) }; });
ok('MGRS paste → A, 1, B', await points() === 'A1B' && Math.abs(mg.pts[1][0] - 49.9) < 0.001 && Math.abs(mg.pts[2][1] - 32.0) < 0.001, { refs, mg });
ok('map jumps to show the route', mg.inView);
ok('waypoints in the result', /waypoints: 1/.test(await result()));
await page.fill('[data-route-mgrs] input', 'hello'); await page.click('[data-route-mgrs] button'); await page.waitForTimeout(300);
ok('bad MGRS: message, route kept', /Not an MGRS reference: HELLO/.test(await page.locator('#mapRouteMgrsMsg').innerText()) && await points() === 'A1B');
ok('MGRS parse round trip ≤ 1.5 m', await I(() => { const { MGRS } = FlySkyMap._internals; return [[50.45, 30.52], [-33.9, 18.4], [64.1, -21.9], [-45, 170]].every(([la, lo]) => { const p = MGRS.parse(MGRS.forward(la, lo)); return Math.abs(p.lat - la) * 111e3 < 1.5 && Math.abs(p.lon - lo) * 111e3 * Math.cos(la * Math.PI / 180) < 1.5; }); }));

// start here: A moves to the crosshair
const c2 = await center();
await page.click('[data-route-start]'); await page.waitForTimeout(300);
ok('start here: A at the crosshair', await I(c => { const a = FlySkyMap._internals.RT.markers[0].getLatLng(); return Math.abs(a.lat - c[0]) < 1e-6 && Math.abs(a.lng - c[1]) < 1e-6; }, c2));

// clear + close
await page.click('[data-route-clear]'); await page.waitForTimeout(300);
ok('clear: A and B at the crosshair, following again', await points() === 'AB' && await I(() => FlySkyMap._internals.RT.follow));
await page.click('[data-route-close]'); await page.waitForTimeout(300);
ok('close: tool gone, readout back', !(await page.isVisible('#mapRoute')) && await page.isVisible('#mapProbe') && await I(() => document.querySelectorAll('.fs-route-pt').length) === 0);
ok('taps do nothing with the tool closed', await (async () => { await tap(50.6, 31.2); await page.waitForTimeout(300); return I(() => document.querySelectorAll('.fs-route-pt').length === 0); })());
ok('no page errors', !errors.filter(e => !/tailwind/.test(e)).length, errors.filter(e => !/tailwind/.test(e)));
await b.close();
