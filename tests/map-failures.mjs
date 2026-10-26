// Failure paths, day/night choice and mobile layout.
import { routeAll, makeWms } from './lib/mock.mjs';
import { launch, BASE_URL, ok } from './lib/env.mjs';
const b = await launch();
const iso = ms => new Date(ms).toISOString().replace('.000Z', 'Z');

async function open(opts, ctxOpts = {}, before) {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 860 }, serviceWorkers: 'block', ...ctxOpts });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  if (before) await before(page);
  const r = await routeAll(page, opts);
  await page.goto(BASE_URL);
  await page.evaluate(() => localStorage.setItem('flysky_view', JSON.stringify('map')));
  await page.reload();
  await page.waitForTimeout(3500);
  const st = () => page.evaluate(() => {
    if (!window.FlySkyMap) return null;
    const { R, S, cache } = FlySkyMap._internals;
    const tl = R.frames.length ? R.frames : R.precipFrames;
    return { product: S.product, shown: R.frames[R.index] && R.frames[R.index].product, frames: tl.length, index: R.index, mode: R.requestMode, catalog: R.catalogStatus,
      stat: tl.map(f => ({ ok: 'o', error: 'E', loading: 'L', queued: 'q' })[(cache.get(f.key) || {}).status] || '-').join(''),
      layers: Object.fromEntries(Object.entries(R.resolved).filter(([, v]) => v.length).map(([k, v]) => [k, v.map(l => l.name + (l.guessed ? '?' : ''))])),
      err: R.lastError && R.lastError.msg, status: document.getElementById('mapStatus').innerText, time: document.getElementById('mapTime').textContent,
      precipText: document.getElementById('drawerMap').innerText.match(/PRECIPITATION\n[^\n]*\n?[^\n]*/i)?.[0] };
  });
  return { ctx, page, st, errors, ...r };
}

// A. one frame returns a WMS exception
{
  const w = makeWms();
  const bad = iso(w.fogEnd - 2 * 15 * 60e3);
  const { page, st, ctx, errors } = await open({ badTime: bad });
  await page.locator('#mapSlider').fill('19'); await page.waitForTimeout(2000);
  let s = await st();
  ok('bad frame marked failed (loaded from 19 forward)', s.stat === '-'.repeat(19) + 'ooo' + 'E' + 'oo', s.stat);
  ok('error text from exception', /InvalidDimensionValue: Time .* not available/.test(s.err), s.err);
  await page.locator('#mapSlider').fill('19');
  await page.click('[data-map-play]');
  const seen = new Set(); for (let i = 0; i < 40; i++) { await page.waitForTimeout(120); seen.add(await page.evaluate(() => FlySkyMap._internals.R.index)); }
  await page.click('[data-map-play]');
  ok('playback skips failed frame', !seen.has(22) && seen.has(23) && seen.has(21), [...seen].sort((a, b) => a - b));
  ok('progress shows failed', /1 failed/.test(await page.locator('#mapProgress').innerText()));
  console.log('   errors', errors.filter(e => !/tailwind/.test(e)));
  await ctx.close();
}

// B. no CORS headers: capabilities unreadable → preferred names, <img> mode, latest only
{
  const { page, st, ctx, log, errors } = await open({ noCors: true });
  const s = await st();
  ok('no-CORS: guessed preferred layers', JSON.stringify(s.layers) === JSON.stringify({ fog: ['msg_fes:rgb_fog?'], dayMicro: ['msg_fes:rgb_microphysics?'], clm: ['msg_fes:clm?'] }), s.layers);
  ok('no-CORS: latest image via <img>', s.frames === 1 && s.stat === 'o' && s.mode === 'img', s);
  ok('no-CORS: status explains', /Time steps unavailable/.test(s.status) && /layer list/i.test(s.status), s.status);
  await page.screenshot({ path: 'map_nocors.png' });
  console.log('   errors', errors.filter(e => !/tailwind/.test(e)));
  await ctx.close();
}

// C. full capabilities fails but per-layer capabilities work (CORS ok)
{
  const { st, ctx, log } = await open({ capsFail: true });
  const s = await st();
  ok('caps fail: preferred layer verified via own capabilities, has time steps', s.frames === 25 && /^-+o$/.test(s.stat) && s.mode === 'fetch', { frames: s.frames, stat: s.stat, layerCaps: log.layerCaps });
  ok('caps fail: other products shown unavailable', !s.layers.natural && !!s.layers.fog);
  await ctx.close();
}

// D. Leaflet fails to load → back to forecast with a toast
{
  const ctx = await b.newContext({ viewport: { width: 1280, height: 860 }, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  await routeAll(page, { leafletFail: true });
  await page.goto(BASE_URL); await page.waitForTimeout(500);
  await page.click('[data-view="map"]'); await page.waitForTimeout(700);
  ok('leaflet fail falls back', await page.isVisible('#forecastView') && /Could not load the map/.test(await page.locator('#toastContainer').innerText()));
  await ctx.close();
}

// E. Daytime → Day Microphysics; night hint when user picks a day product at night
{
  const noon = new Date(); noon.setUTCHours(10, 0, 0, 0);
  // Images from the same daytime as the page's clock.
  const { page, st, ctx } = await open({ now: noon.getTime() }, {}, async p => { await p.clock.setFixedTime(noon); });
  let s = await st();
  ok('daytime: Auto shows Day Microphysics', s.product === 'auto' && s.shown === 'dayMicro', [s.product, s.shown]);
  await page.evaluate(() => document.querySelector('#drawerMap [data-map-product="fog"]').click()); await page.waitForTimeout(800);
  s = await st();
  ok('night product by day: hint offers switch', /Daytime over this area/.test(s.status), s.status);
  await page.click('#mapStatus [data-map-product]'); await page.waitForTimeout(800);
  ok('hint switch works', (await st()).product === 'dayMicro');
  await ctx.close();
}

// F. offline
{
  const { page, ctx } = await open({});
  await ctx.setOffline(true); await page.evaluate(() => window.dispatchEvent(new Event('offline'))); await page.waitForTimeout(300);
  ok('offline note', /Offline/.test(await page.locator('#mapStatus').innerText()));
  await ctx.close();
}

// G. no precipitation product in the service
{
  const { page, st, ctx } = await open({ noPrecip: true });
  ok('no precip product: overlay marked as not offered', await page.evaluate(() => /Precipitation\s*Not offered by the service/.test(document.getElementById('drawerMap').textContent)));
  await ctx.close();
}

// H. mobile layout
{
  const { page, st, ctx, errors } = await open({}, { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const s = await st();
  ok('mobile loads latest only', s.frames === 25 && /^-+o$/.test(s.stat), s.stat);
  ok('mobile panel starts closed', !(await page.isVisible('#mapPanel')));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  ok('no horizontal overflow', !overflow);
  await page.screenshot({ path: 'map_m1.png' });
  await page.click('#mapPanelBtn'); await page.waitForTimeout(300);
  await page.screenshot({ path: 'map_m2.png' });
  // header fits
  const hdr = await page.evaluate(() => { const r = document.getElementById('btnRefresh').getBoundingClientRect(); return r.right <= window.innerWidth; });
  ok('header fits 390', hdr);
  await page.setViewportSize({ width: 360, height: 760 }); await page.waitForTimeout(400);
  ok('header fits 360', await page.evaluate(() => document.getElementById('btnRefresh').getBoundingClientRect().right <= window.innerWidth + 0.5));
  await page.screenshot({ path: 'map_m360.png' });
  console.log('   errors', errors.filter(e => !/tailwind/.test(e)));
  await ctx.close();
}
await b.close();
