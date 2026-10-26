// Flight time calculator (map tool): A at the crosshair; Aim mode (B is the crosshair,
// zoom keeps it) and Tap mode (a tap sets B, the map moves freely); MGRS for A / B,
// airspeed, wind triangle, ETA, return leg, the route tag on the map.
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
    const d = await page.evaluate(() => { const { S, R } = FlySkyMap._internals; return { labels: S.labels, borders: S.borders, wind: S.wind.on, level: S.wind.level, utc: S.utc, max: R.map.getMaxZoom() }; });
    ok('new users: place names and borders off, wind on at 120 m, local time', !d.labels && !d.borders && d.wind && d.level === '120m' && !d.utc, d);
    ok('map zooms in to 18', d.max === 18, d.max);
    // Deep zoom: the satellite image stays at its own resolution (zoom 8 image).
    await page.evaluate(() => FlySkyMap._internals.R.map.setZoom(16, { animate: false }));
    await page.waitForTimeout(1500);
    const z = await page.evaluate(() => { const { R } = FlySkyMap._internals; return { zoom: R.map.getZoom(), ext: R.extent && R.extent.zoom }; });
    ok('zoom 16: satellite image drawn for zoom 8', z.zoom === 16 && z.ext === 8, z);
    await ctx.close();
}

// ---- earlier versions' wind height ('925' for the arrows) carries over
{
    const ctx = await b.newContext(ctxOpts);
    const page = await ctx.newPage();
    await routeAll(page, {});
    await page.goto(BASE_URL);
    await page.evaluate(k => { localStorage.setItem('flysky_last_location', JSON.stringify(k)); localStorage.setItem('flysky_view', JSON.stringify('map')); localStorage.setItem('flysky_map_settings', JSON.stringify({ wind: { on: true, level: '925' }, route: { level: '1500m' } })); }, KYIV);
    await page.reload(); await page.waitForTimeout(2500);
    ok("earlier '925' wind height → ~800 m for arrows and calculator", await page.evaluate(() => { const { S } = FlySkyMap._internals; return S.wind.level === '800m' && !('level' in S.route); }));
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
const head = () => page.locator('#mapRouteHead').innerText();
const msg = () => page.locator('#mapRouteMsg').innerText();
const tagText = () => I(() => { const t = document.querySelector('.fs-route-tag'); return t && t.closest('.leaflet-marker-icon').style.visibility !== 'hidden' ? t.innerText.replace(/\n/g, ' | ') : ''; });
const reqs = () => (log.routeReq || []).length;
const points = () => I(() => [...document.querySelectorAll('.fs-route-pt')].map(m => m.textContent).join(''));
const center = () => I(() => { const c = FlySkyMap._internals.R.map.getCenter(); return [c.lat, c.lng]; });
const bPos = () => I(() => { const b = FlySkyMap._internals.RT.markers.at(-1).getLatLng(); return [b.lat, b.lng]; });
const near = (p, q, tol = 1e-4) => Math.abs(p[0] - q[0]) < tol && Math.abs(p[1] - q[1]) < tol;
const setView = (lat, lng) => I(([la, lo]) => FlySkyMap._internals.R.map.setView([la, lo], FlySkyMap._internals.R.map.getZoom(), { animate: false }), [lat, lng]);
const panBy = (x, y) => I(([x, y]) => FlySkyMap._internals.R.map.panBy([x, y], { animate: false }), [x, y]);
// A screen point in the open upper part of the map (hazard chips at the top, panels at the bottom).
const upper = (dx = -40, y = 190) => I(([dx, y]) => { const m = FlySkyMap._internals.R.map, r = document.getElementById('satMap').getBoundingClientRect(); const ll = m.containerPointToLatLng([r.width / 2 + dx, y]); return { x: r.left + r.width / 2 + dx, y: r.top + y, ll: [ll.lat, ll.lng] }; }, [dx, y]);
const zoomOpt = () => I(() => FlySkyMap._internals.R.map.options.touchZoom);
const minutes = s => { const m = s.match(/(?:(\d+) h )?(\d+) min/); return m ? (+(m[1] || 0)) * 60 + +m[2] : NaN; };

// open the tool: A at the crosshair, Aim mode, B is the crosshair
await page.click('#mapRouteBtn'); await page.waitForTimeout(400);
ok('panel opens, readout hidden, crosshair shown', await page.isVisible('#mapRoute') && !(await page.isVisible('#mapProbe')) && await page.isVisible('#mapCrosshair'));
ok('A and B at the crosshair, Aim on, hint to pan', await points() === 'AB' && /Pan the map/.test(await msg()) && await page.getAttribute('[data-route-mode="aim"]', 'aria-pressed') === 'true');
ok('crosshair kept clear: hazards as icons, no product hints', await I(() => !!document.querySelector('#mapHazardIcons [data-hazard]') && !document.querySelector('#mapStatus [data-hazard]') && !/Daytime|Night-time|Switch/.test(document.getElementById('mapStatus').innerText)));
ok('Aim: zoom keeps the crosshair', await zoomOpt() === 'center' && await I(() => FlySkyMap._internals.R.map.options.scrollWheelZoom === 'center'));
ok('row: A MGRS · airspeed · B MGRS', /^36U \w\w$/.test(await page.locator('#mapRouteZ_a').innerText()) && /^\d{5} \d{5}$/.test(await page.locator('#mapRouteN_b').innerText()) && await page.isVisible('[data-route-speed]'));

// pan with the mouse: B follows the crosshair while dragging
const sm = await upper(0, 120);
await page.mouse.move(sm.x, sm.y); await page.mouse.down();
await page.mouse.move(sm.x - 60, sm.y, { steps: 6 });
await page.waitForTimeout(100);
ok('B follows the crosshair during the drag', near(await bPos(), await center(), 1e-6));
await page.mouse.move(sm.x - 100, sm.y, { steps: 4 }); await page.mouse.up();
await page.waitForTimeout(1200);
ok('panning reads the wind once (debounced)', reqs() === 1, log.routeReq);
ok('result after panning', /min · ETA/.test(await head()), await head());

// exactly 40 km east of A: 6 m/s from the west = tailwind
await setView(50.45, 31.083); await page.waitForTimeout(1200);
let hd = await head(), tg = await tagText();
console.log('    east, 22 m/s:', hd, '| tag:', tg);
const out = minutes(hd), back = minutes(hd.split('back')[1] || '');
ok('flight time ≈ 40 km / 28 m/s ≈ 24 min, ETA, way back ≈ 42 min', Math.abs(out - 24) <= 1 && /ETA \d\d:\d\d/.test(hd) && Math.abs(back - 42) <= 1, { out, back });
ok('tag on the map: time, distance, ground speed 28 m/s', /^\d+ min \| 39\.7 km · 28\.0 m\/s$/.test(tg), tg);
ok('no wind breakdown in the panel', !/tailwind|headwind|crosswind/.test(await page.locator('#mapRoute').innerText()));
const overlap = await I(() => { const t = document.querySelector('.fs-route-tag').getBoundingClientRect(); return [...document.querySelectorAll('.fs-route-pt span')].some(m => { const r = m.getBoundingClientRect(); return r.left < t.right && r.right > t.left && r.top < t.bottom && r.bottom > t.top; }); });
ok('tag does not cover A or B', !overlap);

// wheel zoom (pointer away from the centre) keeps B
const c0 = await center();
const wp = await upper(-120, 200);
await page.mouse.move(wp.x, wp.y); await page.mouse.wheel(0, 300); await page.waitForTimeout(900);
ok('Aim: wheel zoom keeps B at the crosshair', near(await center(), c0, 0.03) && near(await bPos(), await center(), 1e-9) && await I(() => FlySkyMap._internals.R.map.getZoom()) < 8, { c: await center(), c0, b: await bPos(), z: await I(() => FlySkyMap._internals.R.map.getZoom()) });
await I(() => FlySkyMap._internals.R.map.setZoom(8, { animate: false })); await page.waitForTimeout(300);

// airspeed slider: slower → longer, no new request
const n0 = reqs();
await page.locator('[data-route-speed]').fill('18'); await page.waitForTimeout(300);
ok('airspeed 18 m/s → ground speed 24, longer flight', /24\.0 m\/s/.test(await tagText()) && minutes(await head()) > out && reqs() === n0, await tagText());
ok('airspeed shown in m/s and km/h', await page.locator('#mapRouteSpeed').innerText() === '18 m/s' && await page.locator('#mapRouteKmh').innerText() === '65 km/h');

// another height: one request for it
await page.selectOption('[data-route-level]', '800m'); await page.waitForTimeout(1000);
ok('wind height ~800 m asks 925 hPa', (log.routeReq || []).at(-1) === 'wind_speed_925hPa,wind_direction_925hPa', log.routeReq);
ok('one wind height: the calculator sets the map wind height (saved)', await I(() => FlySkyMap._internals.S.wind.level === '800m' && JSON.parse(localStorage.getItem('flysky_map_settings')).wind.level === '800m'));
// Arrows on from the side menu: they ask that height, and the menu shows it.
await page.click('#mapPanelBtn'); await page.waitForTimeout(300);
await page.click('#drawerMap label:has([data-map-wind])'); await page.waitForTimeout(1200);
ok('wind arrows at the calculator height', (log.windVars || []).length > 0 && log.windVars.every(r => r === 'wind_speed_925hPa,wind_direction_925hPa') && await I(() => document.querySelectorAll('.fs-wind').length > 0) && await page.getAttribute('#drawerMap [data-map-windlevel="800m"]', 'class') === 'active', log.windVars);
// …and the side menu sets the calculator's height.
await page.click('#drawerMap [data-map-windlevel="500m"]'); await page.waitForTimeout(1000);
ok('side menu height → calculator and arrows', await page.inputValue('[data-route-level]') === '500m' && (log.routeReq || []).includes('wind_speed_950hPa,wind_direction_950hPa') && log.windVars.at(-1) === 'wind_speed_950hPa,wind_direction_950hPa');
await page.click('#drawerMap label:has([data-map-wind])'); await page.waitForTimeout(300);
await page.click('#btnSettingsClose'); await page.waitForTimeout(300);
await page.selectOption('[data-route-level]', '120m'); await page.waitForTimeout(800);

// Tap mode: B pinned, map free
const bAim = await bPos();
await page.click('[data-route-mode="tap"]'); await page.waitForTimeout(300);
ok('Tap: B pinned where the crosshair was, zoom around the pointer', near(await bPos(), bAim, 1e-6) && await zoomOpt() === true && /tap the map to set B/i.test(await page.getAttribute('[data-route-mode="tap"]', 'title')), { b: await bPos(), bAim, z: await zoomOpt(), title: await page.getAttribute('[data-route-mode="tap"]', 'title') });
await panBy(-150, 80); await page.waitForTimeout(400);
ok('Tap: panning leaves B', near(await bPos(), bAim, 1e-6));
const tp = await upper();
await page.mouse.click(tp.x, tp.y); await page.waitForTimeout(800);
ok('Tap: a tap sets B', near(await bPos(), tp.ll, 1e-3) && await points() === 'AB', { b: await bPos(), want: tp.ll });
// The tag stays on screen while part of the line is; hidden when none is.
const tagIn = () => I(() => { const w = document.querySelector('.fs-route-tag').closest('.leaflet-marker-icon'); const t = w.firstElementChild.getBoundingClientRect(), m = document.getElementById('satMap').getBoundingClientRect(); return w.style.visibility !== 'hidden' && t.left >= m.left && t.right <= m.right && t.top >= m.top && t.bottom <= m.bottom; });
await I(() => { const { RT, R } = FlySkyMap._internals; R.map.setView(RT.a, 11, { animate: false }); R.map.panBy([-120, 0], { animate: false }); });
await page.waitForTimeout(400);
ok('zoomed in near A (B off screen): tag still in view', await tagIn());
await I(() => { const { RT, R } = FlySkyMap._internals; R.map.setView([RT.a.lat - 1.5, RT.a.lng - 2], 9, { animate: false }); });
await page.waitForTimeout(400);
ok('route off screen: tag hidden', !(await I(() => document.querySelector('.fs-route-tag').closest('.leaflet-marker-icon').style.visibility !== 'hidden')));
await I(() => FlySkyMap._internals.R.map.setZoom(8, { animate: false }));

// back to Aim: the map goes to B, B stays
const bTap = await bPos();
await page.click('[data-route-mode="aim"]'); await page.waitForTimeout(1200);
ok('Aim again: map centred on B, B unchanged', near(await center(), bTap, 1e-4) && near(await bPos(), bTap, 1e-4) && await zoomOpt() === 'center');
// a tap in Aim mode takes the crosshair there
const ap = await upper(60, 200);
await page.mouse.click(ap.x, ap.y); await page.waitForTimeout(1200);
ok('Aim: a tap moves the crosshair (and B) there', near(await center(), ap.ll, 1e-3) && near(await bPos(), ap.ll, 1e-3));

// swap (Aim): A = old B, the map goes to the old A; now against the wind
await I(() => { FlySkyMap._internals.RT.a = L.latLng(50.45, 30.52); });
await setView(50.45, 31.083); await page.waitForTimeout(900);
const t1 = minutes(await head());
await page.click('[data-route-swap]'); await page.waitForTimeout(1500);
ok('swap → A east, the crosshair (B) at the old A, slower', near(await center(), [50.45, 30.52], 0.005) && await I(() => Math.abs(FlySkyMap._internals.RT.a.lng - 31.083) < 0.005) && minutes(await head()) > t1, { h: await head(), t1, c: await center(), a: await I(() => FlySkyMap._internals.RT.a) });

// a crosswind stronger than the airspeed
opts.routeWind = { speed: 25, from: 0 };
await page.selectOption('[data-route-level]', '1500m'); await page.waitForTimeout(1000);
ok('too strong a crosswind: no headway', /No headway/.test(await head()) && /No headway/.test(await tagText()) && /Can't make headway/.test(await msg()), { h: await head(), t: await tagText(), m: await msg() });
opts.routeWind = null;
await page.selectOption('[data-route-level]', '120m'); await page.waitForTimeout(800);

// drag the pinned B (Tap mode)
await page.click('[data-route-mode="tap"]'); await page.waitForTimeout(300);
const before = await bPos();
await I(([la, lo]) => { const m = FlySkyMap._internals.R.map; m.setView([la, lo], m.getZoom(), { animate: false }); m.panBy([0, 200], { animate: false }); }, before);
await page.waitForTimeout(500);
const pb = await I(([la, lo]) => { const p = FlySkyMap._internals.R.map.latLngToContainerPoint([la, lo]); const r = document.getElementById('satMap').getBoundingClientRect(); return { x: r.left + p.x, y: r.top + p.y }; }, before);
await page.mouse.move(pb.x, pb.y); await page.mouse.down(); await page.mouse.move(pb.x, pb.y - 60, { steps: 6 }); await page.mouse.up(); await page.waitForTimeout(800);
const afterB = await bPos();
ok('dragging B moves it', afterB[0] > before[0] + 0.05, { before, afterB });

// MGRS: tap B, paste two references = waypoint 1 and B; the map shows them
const refs = await I(() => { const { MGRS } = FlySkyMap._internals; return [MGRS.forward(49.9, 31.5), MGRS.forward(49.6, 32.0), MGRS.forward(50.1, 30.9), MGRS.forward(50.3, 30.1)]; });
await page.click('[data-route-edit="b"]'); await page.waitForTimeout(200);
ok('B field opens with the current MGRS', /^36U \w\w \d{5} \d{5}$/.test(await page.inputValue('[data-route-mgrs] input')) && await I(() => document.activeElement.name === 'mgrs'));
await page.fill('[data-route-mgrs] input', `${refs[0]}\n${refs[1].replace(/ /g, '')}`);
await page.press('[data-route-mgrs] input', 'Enter'); await page.waitForTimeout(1200);
const mg = await I(() => { const { RT, R } = FlySkyMap._internals; return { pts: RT.markers.map(m => [m.getLatLng().lat, m.getLatLng().lng]), inView: RT.markers.every(m => R.map.getBounds().contains(m.getLatLng())) }; });
ok('MGRS for B: two references → A, 1, B; map shows them', await points() === 'A1B' && near(mg.pts[1], [49.9, 31.5], 1e-3) && near(mg.pts[2], [49.6, 32.0], 1e-3) && mg.inView, mg);
ok('waypoint count by B', /\+1 via/.test(await page.locator('#mapRouteZ_b').innerText()));
// bad input: message, editor stays, route kept; cancel closes
await page.click('[data-route-edit="a"]'); await page.fill('[data-route-mgrs] input', 'hello'); await page.click('[data-route-mgrs] button'); await page.waitForTimeout(300);
ok('bad MGRS: message, field stays open, route kept', /Not an MGRS reference: HELLO/.test(await msg()) && await page.isVisible('[data-route-mgrs]') && await points() === 'A1B');
await page.click('[data-route-editcancel]'); await page.waitForTimeout(200);
ok('cancel closes the field', !(await page.isVisible('[data-route-mgrs]')) && await page.isVisible('[data-route-edit="a"]'));
// A by MGRS
await page.click('[data-route-edit="a"]'); await page.fill('[data-route-mgrs] input', refs[2]); await page.click('[data-route-mgrs] button'); await page.waitForTimeout(800);
ok('MGRS for A moves A', await I(() => { const a = FlySkyMap._internals.RT.a; return Math.abs(a.lat - 50.1) < 1e-3 && Math.abs(a.lng - 30.9) < 1e-3; }));
// single B in Aim: the crosshair goes there, A stays in view
await page.click('[data-route-mode="aim"]'); await page.waitForTimeout(1200);
await page.click('[data-route-edit="b"]'); await page.fill('[data-route-mgrs] input', refs[3]); await page.click('[data-route-mgrs] button'); await page.waitForTimeout(1200);
ok('MGRS for B in Aim: crosshair (B) there, A in view', near(await center(), [50.3, 30.1], 0.01) && near(await bPos(), await center(), 1e-9) && await points() === 'AB' && await I(() => { const { RT, R } = FlySkyMap._internals; return R.map.getBounds().contains(RT.a); }), { c: await center(), p: await points() });
ok('MGRS parse round trip ≤ 1.5 m', await I(() => { const { MGRS } = FlySkyMap._internals; return [[50.45, 30.52], [-33.9, 18.4], [64.1, -21.9], [-45, 170]].every(([la, lo]) => { const p = MGRS.parse(MGRS.forward(la, lo)); return Math.abs(p.lat - la) * 111e3 < 1.5 && Math.abs(p.lon - lo) * 111e3 * Math.cos(la * Math.PI / 180) < 1.5; }); }));

// start here: A moves to the crosshair
await panBy(80, -60); await page.waitForTimeout(300);
const c2 = await center();
await page.click('[data-route-start]'); await page.waitForTimeout(300);
ok('start here: A at the crosshair', await I(c => { const a = FlySkyMap._internals.RT.markers[0].getLatLng(); return Math.abs(a.lat - c[0]) < 1e-6 && Math.abs(a.lng - c[1]) < 1e-6; }, c2));

// mode is remembered
ok('mode saved', await I(() => JSON.parse(localStorage.getItem('flysky_map_settings')).route.mode) === 'aim');

// clear + close
await page.click('[data-route-clear]'); await page.waitForTimeout(300);
ok('clear: A and B at the crosshair', await points() === 'AB' && !(await tagText()));
await page.click('[data-route-close]'); await page.waitForTimeout(300);
ok('close: tool gone, readout back, normal zoom', !(await page.isVisible('#mapRoute')) && await page.isVisible('#mapProbe') && await I(() => document.querySelectorAll('.fs-route-pt, .fs-route-tag').length) === 0 && await zoomOpt() === true);
ok('hazard chips back after closing', await I(() => !!document.querySelector('#mapStatus [data-hazard]')));
ok('taps do nothing with the tool closed', await (async () => { const p = await upper(); await page.mouse.click(p.x, p.y); await page.waitForTimeout(300); return I(() => document.querySelectorAll('.fs-route-pt').length === 0); })());
ok('no page errors', !errors.filter(e => !/tailwind/.test(e)).length, errors.filter(e => !/tailwind/.test(e)));
await b.close();
