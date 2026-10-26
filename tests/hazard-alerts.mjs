// Nearby hazard alerts: movement read back for a new alert (no map playing
// needed), "Show" on the map alert, and the map's time bar hiding when it has
// nothing to show or the flight time calculator is open.
import { routeAll } from './lib/mock.mjs';
import { launch, BASE_URL, ok } from './lib/env.mjs';
const b = await launch();
const mobile = process.argv.includes('--mobile');
const ctxOpts = mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block' } : { viewport: { width: 1280, height: 860 }, serviceWorkers: 'block' };
const KYIV = { name: 'Kyiv', latitude: 50.45, longitude: 30.52, country: 'Ukraine' };

async function open(view, settings, opts = {}) {
    const ctx = await b.newContext(ctxOpts);
    const page = await ctx.newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    const { log } = await routeAll(page, { rainCell: true, ...opts });
    await page.goto(BASE_URL);
    await page.evaluate(([k, v, s]) => {
        localStorage.setItem('flysky_last_location', JSON.stringify(k)); localStorage.setItem('flysky_view', JSON.stringify(v));
        if (s) localStorage.setItem('flysky_map_settings', JSON.stringify(s));
    }, [KYIV, view, settings]);
    await page.reload();
    return { ctx, page, log, errors: () => errors.filter(e => !/tailwind/.test(e)) };
}
const I = (page, fn, arg) => page.evaluate(fn, arg);

// A. Forecast view: a new rain alert gets its movement without the map
{
    const { ctx, page, log, errors } = await open('forecast');
    await page.waitForSelector('#hazardChips [data-hazard="rain"]', { timeout: 20000 });
    await page.waitForFunction(() => /approaching|getting closer|moving away|no movement|no clear/.test(document.querySelector('#hazardChips [data-hazard="rain"]').textContent), null, { timeout: 20000 });
    const chip = (await page.textContent('#hazardChips [data-hazard="rain"]')).replace(/\s+/g, ' ').trim();
    console.log('    rain chip:', chip);
    ok('rain alert: movement read back → approaching ~30 km/h with an ETA', /approaching ~(2[6-9]|3[0-4]) km\/h · ETA ~(55 min|1 h \d+ min)/.test(chip), chip);
    const rain = log.rain || [];
    const latest = Math.max(...rain.map(r => Date.parse(r.time)));
    const ages = rain.map(r => (latest - Date.parse(r.time)) / 60e3).sort((x, y) => x - y);
    ok('read back: small images only, the last 40 min, 10 min apart', rain.every(r => r.w === 96) && JSON.stringify(ages) === '[0,10,20,30,40]', ages);
    ok('no map images for it', !log.getmap.some(g => /h40b/.test(g.layer) && g.w > 96));
    // Lightning (same spot in every image): steady.
    const li = (await page.textContent('#hazardChips [data-hazard="lightning"]')).replace(/\s+/g, ' ').trim();
    ok('lightning alert: movement read back → not getting closer', /not getting closer/.test(li), li);
    // Polling again does not read back again.
    const n = rain.length;
    await I(page, () => { FlySkyHazard._internals.H.lastPoll = 0; return FlySkyHazard._internals.poll(); });
    await page.waitForTimeout(800);
    ok('read back once per alert', (log.rain || []).length <= n + 1, { before: n, after: (log.rain || []).length });
    ok('no page errors', !errors().length, errors());
    await ctx.close();
}

// B. Map with no satellite product and no layers: no time bar; "Show" on the alert
{
    const { ctx, page, log, errors } = await open('map', { product: 'none', productAt: Date.now(), wind: { on: false }, view: { center: [50.45, 30.52], zoom: 11 } });
    await page.waitForSelector('#mapStatus [data-hazard-show="rain"]', { timeout: 20000 });
    ok('nothing with times on the map: time bar hidden', await I(page, () => document.getElementById('mapBar').classList.contains('hidden')));
    ok('notes moved down', await I(page, () => { const s = document.getElementById('mapSide').getBoundingClientRect(), m = document.getElementById('satMap').getBoundingClientRect(); return m.bottom - s.bottom < 40; }));
    ok('"Show" on both alerts', await I(page, () => !!document.querySelector('#mapStatus [data-hazard-show="lightning"]')));
    await page.click('#mapStatus [data-hazard-show="rain"]');
    await page.waitForTimeout(2500);
    const st = await I(page, () => { const { S, R } = FlySkyMap._internals; const w = FlySkyHazard.where('rain'); return { on: S.overlays.precip.on, zoom: R.map.getZoom(), w, c: R.map.getCenter() }; });
    ok('Show: precipitation layer on, time bar back', st.on && await I(page, () => !document.getElementById('mapBar').classList.contains('hidden')), st);
    ok('Show: zoomed out to include the rain, location in the middle', st.zoom < 11 && Math.abs(st.c.lat - 50.45) < 0.02 && Math.abs(st.c.lng - 30.52) < 0.03, st);
    const inView = await I(page, () => { const { R } = FlySkyMap._internals; const w = FlySkyHazard.where('rain'), r = w.deg * Math.PI / 180; const p = L.latLng(50.45 + w.km / 111.32 * Math.cos(r), 30.52 + w.km / (111.32 * Math.cos(50.45 * Math.PI / 180)) * Math.sin(r)); return R.map.getBounds().contains(p); });
    ok('Show: the rain cell is on screen', inView);
    ok('Show button gone for rain, still there for lightning', await I(page, () => !document.querySelector('#mapStatus [data-hazard-show="rain"]') && !!document.querySelector('#mapStatus [data-hazard-show="lightning"]')));
    ok('map precipitation images requested', log.getmap.some(g => /blended_precip|h40b/.test(g.layer) && g.w > 200), [...new Set(log.getmap.map(g => g.layer + ':' + g.w))]);
    // A tap on the alert itself still folds it.
    await page.click('#mapStatus [data-hazard="lightning"]'); await page.waitForTimeout(300);
    ok('tap on the alert folds it into icons', await I(page, () => !!document.querySelector('#mapHazardIcons [data-hazard]') && !document.querySelector('#mapStatus [data-hazard]')));
    ok('no page errors', !errors().length, errors());
    await ctx.close();
}

// C. Calculator: no time bar, a time pill instead (tap → latest image)
{
    const { ctx, page, errors } = await open('map', { product: 'fog', productAt: Date.now(), wind: { on: false }, hazardMin: true, view: { center: [50.45, 30.52], zoom: 8 } });
    await page.waitForFunction(() => window.FlySkyMap && FlySkyMap._internals.R.frames.length > 5, null, { timeout: 20000 });
    await page.waitForTimeout(800);
    await page.locator('#mapSlider').fill('2'); await page.waitForTimeout(600);
    await page.click('[data-map-play]'); await page.waitForTimeout(300);
    await page.click('#mapRouteBtn'); await page.waitForTimeout(400);
    ok('calculator: playback stopped, time bar hidden', await I(page, () => !FlySkyMap._internals.R.playing && document.getElementById('mapBar').classList.contains('hidden')));
    const pill = await page.textContent('#mapTimePill');
    ok('time pill: image time, age, "latest"', await page.isVisible('#mapTimePill') && /Image \d\d:\d\d · [\d.]+ (min|h) ago\s*latest/.test(pill), pill);
    await page.click('#mapTimePill'); await page.waitForTimeout(800);
    const last = await I(page, () => { const { R } = FlySkyMap._internals; return R.index === R.frames.length - 1; });
    ok('tap → latest image, no "latest" link', last && !/latest/.test(await page.textContent('#mapTimePill')) && await I(page, () => document.getElementById('mapTimePill').disabled));
    await page.click('[data-route-close]'); await page.waitForTimeout(300);
    ok('closed: time bar back, pill hidden', await I(page, () => !document.getElementById('mapBar').classList.contains('hidden') && document.getElementById('mapTimePill').classList.contains('hidden')));
    ok('no page errors', !errors().length, errors());
    await ctx.close();
}
await b.close();
