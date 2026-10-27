// Dragging the map: stacked overlays drawn as one canvas each, no backdrop
// blur on the map panels, readout folded while moving and read only once the
// map settles (on a small grid, so tiny moves reuse it), and the notes /
// readout never covering the crosshair.
import { routeAll } from './lib/mock.mjs';
import { launch, BASE_URL, ok } from './lib/env.mjs';
const b = await launch();
const mobile = process.argv.includes('--mobile');
const ctx = await b.newContext(mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block' } : { viewport: { width: 1280, height: 860 }, hasTouch: true, serviceWorkers: 'block' });
const page = await ctx.newPage();
const errors = []; page.on('pageerror', e => errors.push(e.message));
const { log } = await routeAll(page, { rainCell: true });
await page.goto(BASE_URL);
await page.evaluate(() => { localStorage.setItem('flysky_last_location', JSON.stringify({ name: 'Kyiv', latitude: 50.45, longitude: 30.52 })); localStorage.setItem('flysky_view', JSON.stringify('map')); localStorage.setItem('flysky_map_settings', JSON.stringify({ product: 'fog', productAt: Date.now(), wind: { on: false }, overlays: { precip: { on: true }, lightning: { on: true }, fire: { on: true } }, view: { center: [50.45, 30.52], zoom: 10 } })); });
await page.reload();
await page.waitForFunction(() => window.FlySkyMap && FlySkyMap._internals.R.frames.length > 5, null, { timeout: 20000 });
await page.waitForTimeout(3000);
const I = (fn, arg) => page.evaluate(fn, arg);

// ---- Stacks: one canvas per stacked overlay, also after playing
await page.locator('#mapSlider').fill(String(await I(() => FlySkyMap._internals.R.frames.length - 6))); await page.waitForTimeout(3000);
const stack = () => I(() => ['lightning', 'fire'].map(id => {
    const pane = document.querySelector(`.leaflet-ov_${id}-pane`);
    const { R } = FlySkyMap._internals;
    return { imgs: pane.querySelectorAll('img').length, canvases: pane.querySelectorAll('canvas').length, drawn: R.ovShown[id].size, want: R.ovWant[id].size };
}));
let st = await stack();
ok('lightning and fires: one canvas each, all wanted images drawn', st.every(x => x.imgs === 0 && x.canvases === 1 && x.drawn === x.want && x.want >= 1), st);
for (let k = 0; k < 4; k++) { await page.click('[data-map-next]'); await page.waitForTimeout(700); }
st = await stack();
ok('stepping forward: still one canvas each, the stack follows the time', st.every(x => x.imgs === 0 && x.canvases === 1 && x.drawn === x.want), st);
await page.click('[data-map-latest]'); await page.waitForTimeout(1500);
const lit = await I(() => { const c = document.querySelector('.leaflet-ov_lightning-pane canvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 80) n++; return { n, w: c.width, ew: FlySkyMap._internals.R.extent.w }; });
ok('latest: the lightning canvas holds the flashes, at the image size', lit.n > 0 && lit.w === lit.ew, lit);

// ---- No backdrop blur on the map's panels
ok('no backdrop blur on map panels', await I(() => ['mapProbe', 'mapBar', 'mapPanelBtn', 'mapStatus'].every(id => [document.getElementById(id), ...document.getElementById(id).querySelectorAll('*')].every(el => getComputedStyle(el).backdropFilter === 'none'))));

// ---- Readout: folded while dragging, read once settled
await page.waitForSelector('#mapProbeRows', { timeout: 10000 });
const box = await I(() => { const r = document.getElementById('satMap').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 150 }; });
const gfi0 = (log.gfi || []).length, model0 = log.model || 0;
await page.mouse.move(box.x, box.y); await page.mouse.down();
await page.mouse.move(box.x - 40, box.y + 10, { steps: 5 });
const during = await I(() => ({ moving: document.getElementById('mapView').classList.contains('fs-moving'), rows: !!document.getElementById('mapProbeRows') && getComputedStyle(document.getElementById('mapProbeRows')).display !== 'none' }));
ok('while dragging: readout folded to its header', during.moving && !during.rows, during);
await page.mouse.move(box.x - 80, box.y + 20, { steps: 5 });
await page.waitForTimeout(400);
ok('no readout requests while the finger is down', (log.gfi || []).length === gfi0 && (log.model || 0) === model0);
await page.mouse.up();
await page.waitForTimeout(300);
ok('released: readout back (previous values until the new ones)', await I(() => !document.getElementById('mapView').classList.contains('fs-moving') && !!document.getElementById('mapProbeRows')));
ok('…and not read yet (waits for the map to settle)', (log.gfi || []).length === gfi0);
await page.waitForTimeout(1500);
ok('settled: read once', (log.gfi || []).length > gfi0 && (log.model || 0) === model0 + 1, { gfi: (log.gfi || []).length - gfi0, model: (log.model || 0) - model0 });

// Quick pans in a row: nothing until the last one settles.
const gfi1 = (log.gfi || []).length, model1 = log.model || 0;
for (let k = 0; k < 3; k++) { await I(() => FlySkyMap._internals.R.map.panBy([120, 0], { animate: false })); await page.waitForTimeout(250); }
ok('quick pans: no reads in between', (log.gfi || []).length === gfi1 && (log.model || 0) === model1);
await page.waitForTimeout(1500);
ok('then one read', (log.model || 0) === model1 + 1, (log.model || 0) - model1);

// Tiny moves (well under 1 km) reuse what was read.
const gfi2 = (log.gfi || []).length, model2 = log.model || 0;
const px = await I(() => { const m = FlySkyMap._internals.R.map; const a = m.getCenter(); const p = m.latLngToContainerPoint(a); const bpt = m.containerPointToLatLng([p.x + 1, p.y]); return 1 / (Math.abs(bpt.lng - a.lng) * 111.32 * Math.cos(a.lat * Math.PI / 180)); });   // px per km
const center = await I(() => { const { R } = FlySkyMap._internals; return R.map.getCenter(); });
// put the crosshair a bit west of the middle of a 0.01° cell first (the map snaps to whole pixels)
await I(c => { const m = FlySkyMap._internals.R.map; m.setView([Math.round(c.lat * 100) / 100, Math.round(c.lng * 100) / 100 - 0.002], m.getZoom(), { animate: false }); }, center);
await page.waitForTimeout(1500);
const gfi3 = (log.gfi || []).length, model3 = log.model || 0;
await I(d => FlySkyMap._internals.R.map.panBy([Math.round(d), 0], { animate: false }), px * 0.25);
await page.waitForTimeout(1300);
ok('a move of ~250 m: no new readout requests', (log.gfi || []).length === gfi3 && (log.model || 0) === model3, { gfi: (log.gfi || []).length - gfi3, model: (log.model || 0) - model3 });

// ---- The crosshair stays clear of the notes / readout
const clear = await I(() => { const c = document.getElementById('mapCrosshair').getBoundingClientRect(), s = document.getElementById('mapSide').getBoundingClientRect(); return { cross: c.bottom, side: s.top, scroll: document.getElementById('mapSide').scrollHeight > document.getElementById('mapSide').clientHeight }; });
ok('crosshair above the notes and readout', clear.cross <= clear.side + 1, clear);
if (clear.scroll && mobile) {
    const cdp = await ctx.newCDPSession(page);
    const r = await I(() => { const e = document.getElementById('mapSide').getBoundingClientRect(); return { x: e.left + 60, y: e.top + e.height / 2 - 80 }; });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: r.x, y: r.y + 80 }] });
    for (let k = 1; k <= 6; k++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: r.x, y: r.y + 80 - k * 15 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(400);
    ok('long notes / readout scroll by touch', await I(() => document.getElementById('mapSide').scrollTop > 0));
}
ok('no page errors', !errors.filter(e => !/tailwind/.test(e)).length, errors.filter(e => !/tailwind/.test(e)));
await b.close();
