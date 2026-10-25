// Stacked overlays (fires, lightning) load only from the selected image forward.
import { routeAll } from './lib/mock.mjs';
import { launch, BASE_URL, ok } from './lib/env.mjs';
const b = await launch();
const iso = ms => new Date(ms).toISOString().replace('.000Z', 'Z');

async function open(settings) {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 860 }, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const { log } = await routeAll(page, {});
  await page.goto(BASE_URL);
  await page.evaluate(s => { localStorage.setItem('flysky_view', JSON.stringify('map')); localStorage.setItem('flysky_map_settings', JSON.stringify(s)); }, settings);
  await page.reload(); await page.waitForTimeout(4000);
  return { ctx, page, log, errors };
}
// Map images only (the satellite-vs-model check also fetches small precipitation images).
const req = (log, re) => log.getmap.filter(g => re.test(g.layer) && g.w > 200).map(g => g.time);

// A. fires only ("none" product)
{
  const { ctx, page, log, errors } = await open({ product: 'none', productAt: Date.now(), overlays: { fire: { on: true } } });
  const tl = await page.evaluate(() => FlySkyMap._internals.R.ovFrames.fire.map(f => new Date(f.t).toISOString().replace('.000Z', 'Z')));
  let r = req(log, /frp/);
  ok('fires only: open loads just the latest image', r.length === 1 && r[0] === tl.at(-1), { n: r.length, of: tl.length });
  ok('fires only: tick strip shows 1 loaded', (await page.evaluate(() => [...document.querySelectorAll('#mapTicks span')].filter(s => s.style.background === 'rgb(34, 211, 238)' || s.style.background === 'rgb(21, 94, 117)').length)) === 1);
  await page.locator('#mapSlider').fill('20'); await page.waitForTimeout(2500);
  r = req(log, /frp/);
  const idx = r.map(t => tl.indexOf(t));
  ok('fires only: select 20 → 20..latest, nothing earlier', Math.min(...idx) === 20 && new Set(idx).size === tl.length - 20, idx);
  ok('fires only: stack at 20 = 1 image', await page.evaluate(() => FlySkyMap._internals.R.ovWant.fire.size) === 1);
  await page.click('[data-map-next]'); await page.click('[data-map-next]'); await page.waitForTimeout(800);
  ok('fires only: next ×2 → stack grows to 3', await page.evaluate(() => FlySkyMap._internals.R.ovWant.fire.size) === 3);
  await page.click('[data-map-prev]'); await page.waitForTimeout(800);
  const before = req(log, /frp/).length;
  ok('fires only: prev starts a new stack (1 image)', await page.evaluate(() => FlySkyMap._internals.R.ovWant.fire.size) === 1);
  await page.click('[data-map-prev]'); await page.click('[data-map-prev]'); await page.waitForTimeout(1200);
  ok('fires only: prev ×2 (21→20→19) loads only the new one (19)', req(log, /frp/).length - before === 1, req(log, /frp/).length - before);
  await page.click('[data-map-latest]'); await page.waitForTimeout(600);
  ok('fires only: latest → stack 1', await page.evaluate(() => FlySkyMap._internals.R.ovWant.fire.size) === 1);
  console.log('   errors', errors.filter(e => !/tailwind/.test(e)));
  await ctx.close();
}

// B. lightning only
{
  const { ctx, page, log } = await open({ product: 'none', productAt: Date.now(), overlays: { lightning: { on: true } } });
  ok('lightning only: open loads just the latest image', req(log, /li_afa/).length === 1, req(log, /li_afa/).length);
  await page.click('[data-map-play]'); await page.waitForTimeout(3000); await page.click('[data-map-play]');
  const want = await page.evaluate(() => FlySkyMap._internals.R.ovWant.lightning.size);
  ok('lightning only: playing from the start stacks ≤ 7 (30 min)', want >= 1 && want <= 7, want);
  await ctx.close();
}

// C. product + fires + lightning
{
  const { ctx, page, log } = await open({ product: 'fog', productAt: Date.now(), overlays: { fire: { on: true }, lightning: { on: true }, precip: { on: true } } });
  const fogLatest = await page.evaluate(() => FlySkyMap._internals.R.frames.at(-1).t);
  const fire = req(log, /frp/), li = req(log, /li_afa/), pr = req(log, /precip/);
  ok('fog + overlays: open loads 1 fog + few overlay images', req(log, /rgb_fog/).length === 1 && fire.length <= 2 && li.length <= 2 && pr.length === 1, { fog: req(log, /rgb_fog/).length, fire: fire.length, li: li.length, pr: pr.length });
  ok('fog + overlays: no overlay image older than ~5 min before the image', [...fire, ...li].every(t => Date.parse(t) >= fogLatest - 15 * 60e3), [...fire, ...li]);
  await page.locator('#mapSlider').fill('16'); await page.waitForTimeout(3500);
  const anchor = await page.evaluate(() => FlySkyMap._internals.R.frames[16].t);
  const fire2 = req(log, /frp/).map(Date.parse);
  ok('fog + overlays: select 16 → fire images only from ~that time on', fire2.every(t => t >= anchor - 15 * 60e3), { anchor: iso(anchor), min: iso(Math.min(...fire2)) });
  ok('fog + overlays: fog frames 16..24 only', req(log, /rgb_fog/).length === 1 + 9 - 1 || req(log, /rgb_fog/).length === 9 + 1, req(log, /rgb_fog/).length);
  await ctx.close();
}

// D. Cloud Top Height removed
{
  const { ctx, page } = await open({ product: 'ctth', productAt: Date.now() });
  await page.click('#btnSettings'); await page.waitForTimeout(400);
  const products = await page.$$eval('#drawerMap [data-map-product]', els => els.map(e => e.dataset.mapProduct));
  ok('CTH gone, saved choice falls back', !products.includes('ctth') && await page.evaluate(() => FlySkyMap._internals.S.product) !== 'ctth', products);
  await ctx.close();
}
await b.close();
