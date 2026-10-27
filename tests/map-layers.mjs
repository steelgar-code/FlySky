// First batch: side-menu map settings, new products, overlays, wind, labels.
import { routeAll } from './lib/mock.mjs';
import { launch, BASE_URL, ok } from './lib/env.mjs';
const b = await launch();
const mobile = process.argv.includes('--mobile');
const ctx = await b.newContext(mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block' } : { viewport: { width: 1280, height: 860 }, serviceWorkers: 'block' });
const page = await ctx.newPage();
const errors = []; page.on('pageerror', e => errors.push(e.message));
const { log } = await routeAll(page, {});
await page.goto(BASE_URL);
await page.evaluate(() => {
  localStorage.setItem('flysky_last_location', JSON.stringify({ name: 'Kyiv', latitude: 50.45, longitude: 30.52, country: 'Ukraine' }));
  localStorage.setItem('flysky_view', JSON.stringify('map'));
  // a user of the previous version with precipitation switched on
  localStorage.setItem('flysky_map_settings', JSON.stringify({ precipOn: true, precipOpacity: 0.85, basemap: 'osm', panelOpen: true, wind: { on: false, level: '10m' }, labels: true, sections: { product: true, layers: true, map: true, region: true, time: true } }));
});
await page.reload(); await page.waitForTimeout(3500);
const I = fn => page.evaluate(fn);
const drawerOpen = () => I(() => !document.getElementById('settingsDrawer').classList.contains('-translate-x-full'));
const openDrawer = async () => { if (!(await drawerOpen())) { await page.click('#btnSettings'); await page.waitForTimeout(350); } };
const closeDrawer = async () => { if (await drawerOpen()) { await page.click('#btnSettingsClose'); await page.waitForTimeout(350); } };

ok('migrated precip on, opacity back to default', JSON.stringify(await I(() => FlySkyMap._internals.S.overlays.precip)) === JSON.stringify({ on: true, opacity: 0.4 }), await I(() => FlySkyMap._internals.S.overlays));
ok('unasked basemap osm → dark', await I(() => FlySkyMap._internals.S.basemap) === 'osmDark');
ok('dark tiles class', await I(() => !!document.querySelector('.fs-tiles-dark')));
ok('no floating panel', !(await page.$('#mapPanel')));

// 1. side menu shows map settings in map view
await openDrawer();
ok('drawer title Map settings', (await page.locator('#settingsDrawerTitleText').innerText()) === 'Map settings');
ok('map section visible, forecast hidden', await page.isVisible('#drawerMap') && !(await page.isVisible('#drawerForecast')));
const products = await page.$$eval('#drawerMap [data-map-product]', els => els.map(e => e.dataset.mapProduct + (e.disabled ? '(x)' : '')));
ok('products', JSON.stringify(products) === JSON.stringify(['auto', 'fog', 'geocolour', 'dayMicro', 'cloudType', 'cloudPhase', 'natural', 'clm', 'ir108', 'none']), products);

// 2. map controls stay under the side menu
const covered = await I(() => {
  const pts = [[innerWidth / 2, innerHeight / 2], [innerWidth / 2, innerHeight - 60], [innerWidth - 24, 130]];
  return pts.map(([x, y]) => { const el = document.elementFromPoint(x, y); return el.closest('#settingsDrawer') ? 'drawer' : el.closest('#settingsOverlay') || el.id === 'settingsOverlay' ? 'overlay' : (el.closest('#mapView') ? 'MAP' : el.tagName); });
});
ok('drawer/backdrop above crosshair, timeline, map buttons', !covered.includes('MAP'), covered);

// 3. source picker
await page.click('#drawerMap [data-map-product="fog"]'); await page.waitForTimeout(800);
const src = await page.$$eval('#drawerMap [data-map-src="fog"]', els => els.map(e => [e.dataset.value, e.getAttribute('aria-checked'), e.innerText.replace(/\n/g, ' | ')]));
ok('fog sources as radio cards', src.length === 2 && src[0][1] === 'true' && /Meteosat MSG · 0°/.test(src[0][2]) && /every 15 min/.test(src[0][2]) && /Meteosat MTG · 0°/.test(src[1][2]) && /every 10 min/.test(src[1][2]), src);
await page.click('#drawerMap [data-map-src="fog"][data-value="mtg_fd:rgb_fog"]'); await page.waitForTimeout(1500);
ok('picking MTG switches frames', await I(() => FlySkyMap._internals.R.frames[0].key.startsWith('mtg_fd:rgb_fog')));
await page.click('#drawerMap [data-map-src="fog"][data-value="msg_fes:rgb_fog"]'); await page.waitForTimeout(800);
ok('no native select for sources', !(await page.$('#drawerMap select[data-map-source]')));

// 4. colour keys
const keyRows = () => page.$$eval('#drawerMap [data-map-keybox] li', els => els.length);
for (const [p, n] of [['geocolour', 7], ['cloudType', 8], ['cloudPhase', 11], ['clm', 3]]) {
  await page.click(`#drawerMap [data-map-product="${p}"]`); await page.waitForTimeout(700);
  ok(`${p} key ${n} rows`, await keyRows() === n, await keyRows());
}
ok('cloud type guide link', !!(await page.$('#drawerMap [data-map-product="cloudType"]')));

// 5. overlays: precipitation (migrated on), lightning, fire
const fireSrc = await page.$$eval('#drawerMap [data-map-ov]', els => els.map(e => e.dataset.mapOv));
ok('overlay switches', JSON.stringify(fireSrc) === '["precip","lightning","fire"]', fireSrc);
await page.click('#drawerMap [data-map-product="fog"]'); await page.waitForTimeout(800);
await page.locator('#drawerMap label:has([data-map-ov="lightning"])').click(); await page.waitForTimeout(1500);
await page.locator('#drawerMap label:has([data-map-ov="fire"])').click(); await page.waitForTimeout(3500);
const fireSources = await page.$$eval('#drawerMap [data-map-src="fire"]', els => els.map(e => e.dataset.value));
ok('fire sources (no RGB / Sentinel-3)', JSON.stringify(fireSources) === '["mtg_fd:frp","msg_fes:fire"]', fireSources);
const ov = await I(() => { const { R } = FlySkyMap._internals; return Object.fromEntries(['precip', 'lightning', 'fire'].map(id => [id, { want: (R.ovWant[id] || new Set()).size, shown: (R.ovShown[id] || new Map()).size, frames: (R.ovFrames[id] || []).length }])); });
ok('precip shows 1 image', ov.precip.want === 1 && ov.precip.shown === 1, ov.precip);
ok('lightning stack starts at the selected image', ov.lightning.want >= 1 && ov.lightning.want <= 2 && ov.lightning.shown === ov.lightning.want, ov.lightning);
ok('fire stack starts at the selected image', ov.fire.want === 1 && ov.fire.shown === 1, ov.fire);
const info = await page.locator('#mapOvInfo_lightning').innerText();
ok('lightning info line', /Image:|images ·/.test(info), info);
ok('badges on map chip', (await page.$$('#mapPanelBtnBadges i')).length === 3);

// 6. readout: lightning + fire nearest
await closeDrawer();
await page.waitForTimeout(2500);
let card = await page.locator('#mapProbe').innerText();
console.log('    card:', card.replace(/\n/g, ' | '));
ok('lightning nearest NW', /Lightning:\s*\|?\s*2\d km NW/.test(card.replace(/\n/g, ' | ')), card.match(/Lightning[^|]*\|[^|]*/)?.[0]);
ok('fire at latest: only the latest image counts', /Fires:\s*\|?\s*none within 50 km/.test(card.replace(/\n/g, ' | ')), card.match(/Fires[^|]*\|[^|]*/)?.[0]);
ok('wind (model) row', /Wind \(model\):\s*\|?\s*from SW · 6\.\d m\/s, gusts 9\.5 m\/s/.test(card.replace(/\n/g, ' | ')));
// go back 4 h: fire seen then; lightning not
await page.locator('#mapSlider').fill('8'); await page.waitForTimeout(3000);
card = (await page.locator('#mapProbe').innerText()).replace(/\n/g, ' | ');
ok('4 h ago: no lightning within 50 km', /Lightning:\s*\|?\s*none within 50 km/.test(card), card.match(/Lightning[^|]*\|[^|]*/)?.[0]);
ok('4 h ago: fire SW', /Fires:\s*\|?\s*(3[0-9]|4[0-9]) km SW/.test(card), card.match(/Fires[^|]*\|[^|]*/)?.[0]);

// 7. clm exact readout
await openDrawer(); await page.click('#drawerMap [data-map-product="clm"]'); await closeDrawer(); await page.waitForTimeout(1800);
card = (await page.locator('#mapProbe').innerText()).replace(/\n/g, ' | ');
ok('cloud mask exact class', /Clear — land · exact/.test(card), card.slice(0, 160));
await openDrawer(); await page.click('#drawerMap [data-map-product="geocolour"]'); await closeDrawer(); await page.waitForTimeout(1500);
card = (await page.locator('#mapProbe').innerText()).replace(/\n/g, ' | ');
ok('geocolour: pixel colour only', /pixel colour — see the colour key/.test(card));
await openDrawer(); await page.click('#drawerMap [data-map-product="fog"]'); await page.waitForTimeout(500);

// 8. wind arrows
await page.locator('#drawerMap label:has([data-map-wind])').click(); await page.waitForTimeout(1800);
const arrows = await I(() => document.querySelectorAll('.fs-wind').length);
ok('wind arrows drawn from one grid request', arrows > 10 && log.windReq === 1, { arrows, req: log.windReq, pts: log.windPts });
const rot10 = await I(() => document.querySelector('.fs-wind svg').style.transform);
await page.click('#drawerMap [data-map-windlevel="800m"]'); await page.waitForTimeout(800);
const rot925 = await I(() => document.querySelector('.fs-wind svg').style.transform);
// Only the level shown is requested (Open-Meteo counts every variable):
// the first switch asks once for the other level, later switches are cached.
ok('level switch: one request for that level, arrows turn', log.windReq === 2 && rot10 === 'rotate(45deg)' && rot925 === 'rotate(90deg)', { rot10, rot925, req: log.windReq });
await page.click('#drawerMap [data-map-windlevel="10m"]'); await page.waitForTimeout(600);
const rotBack = await I(() => document.querySelector('.fs-wind svg').style.transform);
await page.click('#drawerMap [data-map-windlevel="800m"]'); await page.waitForTimeout(600);
ok('switching back and forth: no more requests', log.windReq === 2 && rotBack === 'rotate(45deg)', { rotBack, req: log.windReq });
const colors = await I(() => [...new Set([...document.querySelectorAll('.fs-wind path')].map(p => p.getAttribute('fill')))]);
ok('arrow colours follow flight thresholds', colors.length >= 2, colors);
ok('wind info line', /Wind for/.test(await page.locator('#mapWindInfo').innerText()));

// 9. labels
await closeDrawer();
const labels = await I(() => [...document.querySelectorAll('.fs-place-name')].map(e => e.textContent));
ok('place names on top', labels.includes('Kyiv') && labels.length > 5, labels.slice(0, 8));
await page.selectOption('#langSelect', 'uk'); await page.waitForTimeout(600);
ok('place names in Ukrainian', await I(() => [...document.querySelectorAll('.fs-place-name')].some(e => e.textContent === 'Київ')));
await openDrawer();
ok('uk drawer title', (await page.locator('#settingsDrawerTitleText').innerText()) === 'Налаштування карти');
await page.screenshot({ path: mobile ? 'b1_drawer_mobile_uk.png' : 'b1_drawer_uk.png' });
await page.selectOption('#langSelect', 'en').catch(() => {});
await closeDrawer();
await page.selectOption('#langSelect', 'en'); await page.waitForTimeout(400);
await openDrawer();
await page.locator('#drawerMap label:has([data-map-labels])').click(); await page.waitForTimeout(300);
ok('labels off', await I(() => document.querySelectorAll('.fs-place-name').length === 0));
await page.locator('#drawerMap label:has([data-map-labels])').click();

// 10. draw box closes the menu
await page.click('#drawerMap [data-map-draw]'); await page.waitForTimeout(400);
ok('draw closes menu', !(await drawerOpen()) && await page.isVisible('#mapDrawHint'));
await page.keyboard.press('Escape');

// 11. forecast view: forecast settings
await page.click('[data-view="forecast"]'); await page.waitForTimeout(500);
await openDrawer();
ok('forecast drawer in forecast view', (await page.locator('#settingsDrawerTitleText').innerText()) === 'Settings' && await page.isVisible('#drawerForecast') && !(await page.isVisible('#drawerMap')));
await closeDrawer();
await page.click('[data-view="map"]'); await page.waitForTimeout(1500);
await page.click('#mapPanelBtn'); await page.waitForTimeout(400);
ok('map chip opens map settings', await drawerOpen() && await page.isVisible('#drawerMap'));
await page.screenshot({ path: mobile ? 'b1_drawer_mobile.png' : 'b1_drawer.png' });
await closeDrawer(); await page.waitForTimeout(800);
await page.screenshot({ path: mobile ? 'b1_map_mobile.png' : 'b1_map.png' });
console.log('errors', errors.filter(e => !/tailwind/.test(e)));
await b.close();
