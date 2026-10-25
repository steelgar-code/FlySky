// Shared mock for FlySky tests: CDN files from node_modules, Open-Meteo,
// map tiles and a fake EUMETView WMS (shaped like GeoServer 1.3.0 output).
import fs from 'fs';
import { PNG } from 'pngjs';
const nm = p => fs.readFileSync(new URL('../node_modules/' + p, import.meta.url));

export function png(w, h, rgba) {
  const p = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) p.data.set(rgba(i % w, Math.floor(i / w)), i * 4);
  return PNG.sync.write(p);
}
const tilePng = png(256, 256, () => [20, 24, 40, 255]);
const labelPng = png(256, 256, (x, y) => (x % 64 < 2 ? [255, 255, 255, 200] : [0, 0, 0, 0]));

const iso = ms => new Date(ms).toISOString().replace('.000Z', 'Z');
const floor = (ms, step) => Math.floor(ms / step) * step;

export function makeWms(opts = {}) {
  const now = Date.now();
  const s15 = 15 * 60e3, s10 = 10 * 60e3;
  const fogEnd = floor(now - 20 * 60e3, s15);
  const microTimes = []; for (let k = 0; k < 60; k++) microTimes.push(iso(fogEnd - k * s15 - (k % 7 === 3 ? 5 * 60e3 : 0)));
  const precipEnd = floor(now - 30 * 60e3, s10);
  const precipTimes = []; for (let k = 0; k < 80; k++) precipTimes.push(iso(precipEnd - k * s10));
  const layers = [
    { name: 'msg_fes:rgb_fog', title: 'Fog/Low Clouds RGB - MSG - 0 degree', bbox: [-77, -77, 77, 77], time: `${iso(fogEnd - 48 * 3600e3)}/${iso(fogEnd)}/PT15M` },
    { name: 'msg_fes:rgb_microphysics', title: 'Day Microphysics RGB - MSG - 0 degree', bbox: [-77, -77, 77, 77], time: microTimes.reverse().join(',') },
    { name: 'msg_fes:rgb_naturalenhncd', title: 'Natural Colour Enhanced RGB - MSG - 0 degree', bbox: [-77, -77, 77, 77], time: `${iso(fogEnd - 24 * 3600e3)}/${iso(fogEnd)}/PT15M` },
    { name: 'msg_fes:ir108', title: 'IR 10.8 - MSG - 0 degree', bbox: [-77, -77, 77, 77], time: `${iso(fogEnd - 24 * 3600e3)}/${iso(fogEnd)}/PT15M` },
    { name: 'mtg_fd:rgb_fog', title: 'Fog RGB - MTG - 0 degree', bbox: [-80, -80, 80, 80], time: `${iso(fogEnd - 12 * 3600e3)}/${iso(fogEnd)}/PT10M` },
    { name: 'mtg_fd:blended_precip', title: 'Blended FCI IR + LEO MW Precipitation rate at ground - MTG', bbox: [-60, -60, 60, 60], time: precipTimes.reverse().join(','),
      styles: [{ name: 'precip_rate', legend: 'https://view.eumetsat.int/geoserver/wms?request=GetLegendGraphic&layer=mtg_fd:blended_precip&format=image/png' }] },
    { name: 'backgrounds:ne_boundary_lines_land', title: 'Boundary lines (land)', bbox: [-180, -90, 180, 90] },
    { name: 'mtg_fd:rgb_geocolour', title: 'Geo Colour RGB - MTG-I - 0 degree', bbox: [-80, -80, 80, 80], time: `${iso(fogEnd - 12 * 3600e3)}/${iso(fogEnd)}/PT10M` },
    { name: 'mtg_fd:rgb_cloudtype', title: 'Cloud Type RGB - MTG-I - 0 degree', bbox: [-80, -80, 80, 80], time: `${iso(fogEnd - 12 * 3600e3)}/${iso(fogEnd)}/PT10M` },
    { name: 'mtg_fd:rgb_cloudphase', title: 'Cloud Phase RGB - MTG-I - 0 degree', bbox: [-80, -80, 80, 80], time: `${iso(fogEnd - 12 * 3600e3)}/${iso(fogEnd)}/PT10M` },
    { name: 'msg_fes:clm', title: 'Cloud Mask - MSG - 0 degree', bbox: [-77, -77, 77, 77], time: `${iso(fogEnd - 12 * 3600e3)}/${iso(fogEnd)}/PT15M` },
    { name: 'mtg_fd:li_afa', title: 'LI Accumulated Flash Area - MTG-I - 0 degree', bbox: [-80, -80, 80, 80], time: `${iso(floor(now - 10 * 60e3, 5 * 60e3) - 24 * 3600e3)}/${iso(floor(now - 10 * 60e3, 5 * 60e3))}/PT5M`,
      styles: [{ name: 'mtg_li_afa', legend: 'https://view.eumetsat.int/geoserver/ows?service=WMS&request=GetLegendGraphic&format=image%2Fpng&width=640&height=80&layer=mtg_fd%3Ali_afa' }] },
    { name: 'mtg_fd:frp', title: 'Fire Radiative Power (FRP)', bbox: [-80, -80, 80, 80], time: `${iso(fogEnd - 24 * 3600e3)}/${iso(fogEnd)}/PT10M` },
    { name: 'msg_fes:fire', title: 'Active Fire Monitoring (GRIB) - MSG - 0 degree', bbox: [-77, -77, 77, 77], time: `${iso(fogEnd - 24 * 3600e3)}/${iso(fogEnd)}/PT15M` },
    { name: 'mtg_fd:rgb_firetemperature', title: 'Fire Temperature RGB - MTG-I - 0 degree', bbox: [-80, -80, 80, 80], time: `${iso(fogEnd - 12 * 3600e3)}/${iso(fogEnd)}/PT10M` },
    { name: 'copernicus:sentinel3a_slstr_level2_frp', title: 'SLSTR Level 2 Fire Radiative Power (FRP) - Sentinel-3A', bbox: [-180, -90, 180, 90], time: `${iso(fogEnd - 24 * 3600e3)}/${iso(fogEnd)}/PT1H40M` },
    { name: 'msg_fes:rgb_dust', title: 'Dust RGB - MSG - 0 degree', bbox: [-77, -77, 77, 77], time: `${iso(fogEnd - 6 * 3600e3)}/${iso(fogEnd)}/PT15M` },
  ];
  if (opts.noPrecip) layers.splice(5, 1);
  const layerXml = (l, local) => `<Layer queryable="1"><Name>${local ? l.name.split(':')[1] : l.name}</Name><Title>${l.title}</Title><Abstract>abstract</Abstract>
    <EX_GeographicBoundingBox><westBoundLongitude>${l.bbox[0]}</westBoundLongitude><eastBoundLongitude>${l.bbox[2]}</eastBoundLongitude><southBoundLatitude>${l.bbox[1]}</southBoundLatitude><northBoundLatitude>${l.bbox[3]}</northBoundLatitude></EX_GeographicBoundingBox>
    ${l.time ? `<Dimension name="time" default="current" units="ISO8601">${l.time}</Dimension>` : ''}
    ${(l.styles || [{ name: 'default' }]).map(s => `<Style><Name>${s.name}</Name><Title>${s.name}</Title>${s.legend ? `<LegendURL width="20" height="20"><Format>image/png</Format><OnlineResource xmlns:xlink="http://www.w3.org/1999/xlink" xlink:type="simple" xlink:href="${s.legend.replace(/&/g, '&amp;')}"/></LegendURL>` : ''}</Style>`).join('')}</Layer>`;
  const caps = (ls, local) => `<?xml version="1.0" encoding="UTF-8"?><WMS_Capabilities version="1.3.0" xmlns="http://www.opengis.net/wms" xmlns:xlink="http://www.w3.org/1999/xlink">
    <Service><Name>WMS</Name><Title>EUMETView</Title></Service><Capability><Request/><Layer><Title>EUMETView</Title><CRS>EPSG:4326</CRS><CRS>EPSG:3857</CRS><CRS>CRS:84</CRS>
    ${ls.map(l => layerXml(l, local)).join('')}</Layer></Capability></WMS_Capabilities>`;
  return { layers, caps, fogEnd, precipEnd, now };
}

const exc = msg => `<?xml version="1.0" encoding="UTF-8"?><ServiceExceptionReport version="1.3.0" xmlns="http://www.opengis.net/ogc"><ServiceException code="InvalidDimensionValue">${msg}</ServiceException></ServiceExceptionReport>`;

export async function routeAll(page, opts = {}) {
  const wms = makeWms(opts);
  const log = { caps: 0, layerCaps: [], getmap: [], tiles: 0, legend: 0 };
  const cors = opts.noCors ? {} : { 'Access-Control-Allow-Origin': '*' };
  await page.route('**/*', async route => {
    const url = route.request().url();
    if (url.includes('cdn.jsdelivr.net/npm/chart.js')) return route.fulfill({ body: nm('chart.js/dist/chart.umd.js'), contentType: 'text/javascript' });
    if (url.includes('cdn.tailwindcss.com')) return route.fulfill({ body: nm('@tailwindcss/browser/dist/index.global.js'), contentType: 'text/javascript' });
    if (url.includes('font-awesome')) { const f = url.split('/font-awesome/6.4.0/')[1]; return route.fulfill({ body: nm('@fortawesome/fontawesome-free/' + f) }); }
    if (url.includes('/leaflet/1.9.4/leaflet.min.css')) return route.fulfill({ body: nm('leaflet/dist/leaflet.css'), contentType: 'text/css' });
    if (url.includes('/leaflet/1.9.4/leaflet.min.js')) return opts.leafletFail ? route.abort() : route.fulfill({ body: nm('leaflet/dist/leaflet.js'), contentType: 'text/javascript' });
    if (url.includes('basemaps.cartocdn.com') || url.includes('tile.openstreetmap.org')) { log.tiles++; return route.fulfill({ body: url.includes('only_labels') ? labelPng : tilePng, contentType: 'image/png' }); }
    if (url.includes('geocoding-api')) return route.fulfill({ json: { results: [{ id: 1, name: 'Kyiv', latitude: 50.45, longitude: 30.52, country: 'Ukraine' }] } });
    if (url.includes('api.open-meteo.com/v1/forecast') && url.includes('past_days')) {
      const u = new URL(url);
      const lats = u.searchParams.get('latitude').split(','), lons = u.searchParams.get('longitude').split(',');
      const start = Math.floor(Date.now() / 86400e3) * 86400e3 - 86400e3;
      const series = (lat, lon) => { const time = [], c = [], v = [], pr = [], ws = [], wd = [], wg = [], ws9 = [], wd9 = [];
        for (let i = 0; i < 72; i++) { time.push(new Date(start + i * 3600e3).toISOString().slice(0, 16)); c.push(85); v.push(400); pr.push(0.2);
          ws.push(+(3 + Math.abs(lat - 48) * 1.5).toFixed(1)); wd.push(225); wg.push(9.5); ws9.push(+(8 + Math.abs(lon - 30)).toFixed(1)); wd9.push(270); }
        return { time, cloud_cover_low: c, visibility: v, precipitation: pr, wind_speed_10m: ws, wind_direction_10m: wd, wind_gusts_10m: wg, wind_speed_925hPa: ws9, wind_direction_925hPa: wd9 }; };
      if (lats.length > 1 || url.includes('925hPa')) {
        log.windReq = (log.windReq || 0) + 1; log.windPts = (log.windPts || 0) + lats.length;
        if (opts.windFail) return route.fulfill({ status: 500, json: { error: true, reason: 'boom' } });
        const list = lats.map((la, i) => ({ latitude: +la, longitude: +lons[i], hourly: series(+la, +lons[i]) }));
        return route.fulfill({ json: list.length === 1 ? list[0] : list });
      }
      log.model = (log.model || 0) + 1; log.modelUrls = (log.modelUrls || []).concat(url);
      // Several models → one column per variable and model, like the real API.
      const ids = (u.searchParams.get('models') || '').split(',').filter(Boolean);
      if (ids.length > 1) {
        const hourly = { time: series(+lats[0], +lons[0]).time };
        ids.forEach((id, k) => { const one = series(+lats[0], +lons[0]); Object.keys(one).forEach(v => { if (v !== 'time') hourly[`${v}_${id}`] = one[v].map(x => (v === 'cloud_cover_low' ? x + (k - 2) * 2 : x)); }); });
        return route.fulfill({ json: { hourly } });
      }
      return route.fulfill({ json: { hourly: series(+lats[0], +lons[0]) } });
    }
    if ((url.includes('ensemble-api.open-meteo.com') || url.includes('api.open-meteo.com/v1/forecast')) && url.includes('models=')) {
      // Forecast mock: every requested model / variable, ensemble members for the ensemble API.
      const u = new URL(url); const ens = url.includes('ensemble-api');
      const models = u.searchParams.get('models').split(','); const vars = u.searchParams.get('hourly').split(',');
      const days = +(u.searchParams.get('forecast_days') || 2); const start = Math.floor(Date.now() / 86400e3) * 86400e3;
      const time = []; for (let i = 0; i < days * 24; i++) time.push(new Date(start + i * 3600e3).toISOString().slice(0, 16));
      const hourly = { time };
      models.forEach((m, mi) => {
        const suffix = models.length > 1 ? '_' + m : '';
        const n = ens ? 6 : 1;
        for (let k = 0; k < n; k++) {
          const mem = k ? `_member${String(k).padStart(2, '0')}` : '';
          const ph = (mi * 7 + k) * 0.37;
          vars.forEach(v => {
            if (ens && v === 'cloud_cover_low') return;
            hourly[v + mem + suffix] = time.map((_, i) => {
              const w = Math.sin(i / 9 + ph);
              if (v === 'precipitation') return i % 24 > 14 && i % 24 < 19 && (k + mi) % 3 === 0 ? +(0.4 + w).toFixed(1) > 0 ? +(0.4 + Math.abs(w)).toFixed(1) : 0 : 0;
              if (v === 'cloud_cover_low') return Math.round(45 + 40 * w);
              if (v === 'visibility') return Math.round(9000 + 7000 * w);
              if (/gust/.test(v)) return +(9 + 5 * w + (i % 24 > 11 && i % 24 < 17 ? 4 : 0)).toFixed(1);
              return +(5 + 3 * w + (i % 24 > 11 && i % 24 < 17 ? 3 : 0) + (/hPa/.test(v) ? 4 : 0)).toFixed(1);
            });
          });
        }
      });
      return route.fulfill({ json: { latitude: +u.searchParams.get('latitude'), longitude: +u.searchParams.get('longitude'), utc_offset_seconds: 7200, timezone: 'Europe/Kyiv', timezone_abbreviation: 'EET', elevation: 179, hourly } });
    }
    if (url.includes('open-meteo.com')) return route.fulfill({ status: 503, json: { error: true, reason: 'offline in test' } });
    if (url.startsWith('https://view.eumetsat.int/')) {
      // Playwright-fulfilled responses skip CORS checks, so a server without
      // CORS headers is simulated by failing script (fetch/XHR) requests.
      if (opts.noCors && ['fetch', 'xhr'].includes(route.request().resourceType())) return route.abort('failed');
      const u = new URL(url);
      const p = Object.fromEntries([...u.searchParams].map(([k, v]) => [k.toUpperCase(), v]));
      if (opts.wmsDelay) await new Promise(r => setTimeout(r, opts.wmsDelay));
      if (p.REQUEST === 'GetCapabilities') {
        const m = u.pathname.match(/^\/geoserver\/([^/]+)\/([^/]+)\/wms$/);
        if (m) {
          log.layerCaps.push(`${m[1]}:${m[2]}`);
          if (opts.noLayerCaps) return route.fulfill({ status: 404, body: 'not found', headers: cors });
          const l = wms.layers.filter(x => x.name === `${m[1]}:${m[2]}`);
          return route.fulfill({ body: wms.caps(l, true), contentType: 'application/vnd.ogc.wms_xml', headers: cors });
        }
        log.caps++;
        if (opts.capsFail) return route.fulfill({ status: 500, body: 'boom', headers: cors });
        return route.fulfill({ body: wms.caps(wms.layers, false), contentType: 'application/vnd.ogc.wms_xml', headers: cors });
      }
      if (p.REQUEST === 'GetLegendGraphic' || /GetLegendGraphic/i.test(url)) { log.legend++; return route.fulfill({ body: png(120, 30, x => [x * 2, 80, 255 - x * 2, 255]), contentType: 'image/png', headers: cors }); }
      if (p.REQUEST === 'GetFeatureInfo') {
        log.gfi = (log.gfi || []).concat({ layer: p.QUERY_LAYERS, time: p.TIME, bbox: p.BBOX });
        const props = /precip/.test(p.QUERY_LAYERS) ? { Instantaneous_rain_rate: 1.24, Quality_index: 60 }
          : /clm/.test(p.QUERY_LAYERS) ? { RED_BAND: 1, GREEN_BAND: 192, BLUE_BAND: 1 }
          : /fog/.test(p.QUERY_LAYERS) ? (opts.gfiRgb ? { RED_BAND: opts.gfiRgb[0], GREEN_BAND: opts.gfiRgb[1], BLUE_BAND: opts.gfiRgb[2] } : { RED_BAND: 160, GREEN_BAND: 205, BLUE_BAND: 214 })
          : { RED_BAND: 121, GREEN_BAND: 121, BLUE_BAND: 121 };
        return route.fulfill({ json: { type: 'FeatureCollection', features: [{ type: 'Feature', properties: props }] }, headers: cors });
      }
      if (p.REQUEST === 'GetMap') {
        log.getmap.push({ layer: p.LAYERS, time: p.TIME, crs: p.CRS, bbox: p.BBOX, w: +p.WIDTH, h: +p.HEIGHT, styles: p.STYLES });
        if (opts.badTime && p.TIME === opts.badTime) return route.fulfill({ body: exc(`Time ${p.TIME} not available`), contentType: 'application/vnd.ogc.se_xml', headers: cors });
        const ms = Date.parse(p.TIME || new Date().toISOString());
        const shade = Math.floor((ms / 60e3) % 256);
        const w = Math.min(+p.WIDTH, 400), hgt = Math.min(+p.HEIGHT, 400);
        const isPrecip = /precip/.test(p.LAYERS);
        const [bx0, by0, bx1, by1] = p.BBOX.split(',').map(Number);
        const toPx = (lat, lon) => { const X = lon * 20037508.34 / 180, Y = Math.log(Math.tan((90 + lat) * Math.PI / 360)) * 20037508.34 / Math.PI; return [(X - bx0) / (bx1 - bx0) * w, (by1 - Y) / (by1 - by0) * hgt]; };
        if (/li_afa|frp|:fire/.test(p.LAYERS)) {
          log.marks = (log.marks || []).concat({ layer: p.LAYERS, time: p.TIME });
          const age = (wms.now - ms) / 3600e3;
          // Lightning NW of Kyiv only in the latest 20 min; a fire SW of Kyiv only 3–5 h ago.
          const spot = /li_afa/.test(p.LAYERS) ? (age < 0.6 ? [50.6, 30.3] : null) : (age > 3 && age < 5 ? [50.2, 30.1] : null);
          const c = spot ? toPx(...spot) : null;
          const body = png(w, hgt, (x, y) => (c && x === Math.floor(c[0]) && y === Math.floor(c[1]) ? (/li_afa/.test(p.LAYERS) ? [255, 230, 80, 255] : [255, 0, 0, 255]) : [0, 0, 0, 0]));
          return route.fulfill({ body, contentType: 'image/png', headers: cors });
        }
        const body = png(w, hgt, (x, y) => isPrecip
          ? ((x - w / 2) ** 2 + (y - hgt / 2) ** 2 < (w / 6) ** 2 ? [30, 120, 255, 200] : [0, 0, 0, 0])
          : [shade, 200 - shade / 2, 255 - shade, 255]);
        return route.fulfill({ body, contentType: 'image/png', headers: cors });
      }
      return route.fulfill({ status: 400, body: exc('bad request'), contentType: 'application/vnd.ogc.se_xml', headers: cors });
    }
    return url.startsWith(new URL(process.env.BASE_URL || 'http://localhost:8765/').origin) ? route.continue() : route.abort();
  });
  return { wms, log };
}
