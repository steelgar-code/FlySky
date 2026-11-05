// Icing engine (icing.js): unit tests with synthetic Open-Meteo responses.
// Node only (no browser); prints PASS / FAIL lines like the other suites.
//   node icing-engine.mjs
import { createRequire } from 'module';
import fs from 'fs';
import vm from 'vm';

const require = createRequire(import.meta.url);
const I = require('../icing.js');
const ok = (name, cond, extra) => console.log(cond ? 'PASS' : 'FAIL', name, extra !== undefined ? JSON.stringify(extra) : '');
const near = (a, b, tol = 0.01) => Number.isFinite(a) && Math.abs(a - b) <= tol;

// Lowland atmosphere like Kyiv in winter: elevation 169 m; level heights
// above the ground (1000 hPa just below it).
const ELEV = 169;
const AGL = { 1000: -20, 975: 180, 950: 380, 925: 590, 900: 865, 850: 1320, 800: 1800, 700: 2840 };
const TWO = ['icon_seamless', 'ukmo_seamless'];

// A response shaped like Open-Meteo's. `level(model, i, p)` may override
// { z, t, rh } of a level (null drops it: no data); `sfc(model, i)` the
// surface values. Default: cold, dry air — no icing signs.
function makeBody({ hours = 6, models = TWO, elevation = ELEV, agl = AGL, level = () => ({}), sfc = () => ({}) } = {}) {
    const hourly = { time: Array.from({ length: hours }, (_, i) => `2026-01-10T${String(i).padStart(2, '0')}:00`) };
    const put = (name, m, i, v) => {
        const key = models.length > 1 ? `${name}_${m}` : name;
        (hourly[key] || (hourly[key] = Array(hours).fill(null)))[i] = v;
    };
    models.forEach(m => {
        for (let i = 0; i < hours; i++) {
            I.LEVELS.forEach(p => {
                const o = level(m, i, p);
                const v = o === null ? { z: null, t: null, rh: null } : { z: elevation + agl[p], t: -4 - agl[p] * 0.005, rh: 60, ...o };
                put(`geopotential_height_${p}hPa`, m, i, v.z);
                put(`temperature_${p}hPa`, m, i, v.t);
                put(`relative_humidity_${p}hPa`, m, i, v.rh);
            });
            const s = sfc(m, i);
            const v = s === null ? { t2: null, rh2: null, code: null, vis: null, precip: null }
                : { t2: -3, rh2: 80, code: 3, vis: 20000, precip: 0, ...s };
            put('temperature_2m', m, i, v.t2);
            put('relative_humidity_2m', m, i, v.rh2);
            put('weather_code', m, i, v.code);
            put('visibility', m, i, v.vis);
            put('precipitation', m, i, v.precip);
        }
    });
    return { latitude: 50.45, longitude: 30.52, elevation, hourly };
}
const WET = { t: -4, rh: 96 };      // sub-zero, near saturation: red
const run = (body, opts) => I.evaluate(body, opts);
const h0 = (body, opts) => run(body, opts).hours[0];

// ---- Request and cost
{
    const p = I.requestParams({ latitude: 50.45, longitude: 30.52, elevation: ELEV });
    const vars = p.hourly.split(',');
    ok('request: ICON + UKMO by default', p.models === 'icon_seamless,ukmo_seamless', p.models);
    ok('request: levels 1000–850 hPa with T, RH and height, plus T at 700 hPa', ['1000', '975', '950', '925', '900', '850'].every(l => vars.includes(`geopotential_height_${l}hPa`) && vars.includes(`relative_humidity_${l}hPa`)) && vars.includes('temperature_700hPa') && !vars.includes('geopotential_height_800hPa'));
    ok('request: surface variables', ['temperature_2m', 'relative_humidity_2m', 'weather_code', 'visibility', 'precipitation'].every(v => vars.includes(v)));
    ok('request: 24 variables × 2 models = 4.8 calls', near(I.requestCost(p), 4.8), I.requestCost(p));
    const high = I.requestParams({ latitude: 0, longitude: 0, heightM: 1500, elevation: ELEV }).hourly.split(',');
    ok('request: 1500 m above takeoff asks up to 800 hPa', high.includes('geopotential_height_800hPa'));
    const mtn = I.requestParams({ latitude: 0, longitude: 0, elevation: 2025 }).hourly.split(',');
    ok('request: high ground asks up to 700 hPa in full, once', mtn.includes('relative_humidity_700hPa') && mtn.filter(v => v === 'temperature_700hPa').length === 1);
    ok('request: same timezone as the forecast (auto)', p.timezone === 'auto' && p.forecast_days === 8);
    ok('cost: 16 locations × 2 variables = 16 (Phase 0)', I.requestCost({ latitude: Array(16).fill(50).join(','), hourly: 'a,b', forecast_days: 2 }) === 16);
    ok('cost: 1 location × 15 variables = 1.5 (Phase 0)', near(I.requestCost({ latitude: 50, hourly: Array(15).fill('x').join(','), forecast_days: 8 }), 1.5));
    ok('cost: 27 variables × 8 models, 31 days = 47.83 (Phase 0)', near(I.requestCost({ latitude: 50, hourly: Array(27).fill('x').join(','), models: Object.keys(I.MODELS).join(','), forecast_days: 31 }), 47.83, 0.01));
}

// ---- Response parsing
{
    const s = I.splitModels({ time: ['t'], temperature_950hPa_icon_seamless: [1], temperature_950hPa_ukmo_seamless: [2], temperature_2m_icon_seamless: [3] }, TWO);
    ok('split: columns go to their model', s.icon_seamless.temperature_950hPa[0] === 1 && s.ukmo_seamless.temperature_950hPa[0] === 2 && s.icon_seamless.temperature_2m[0] === 3);
    const one = I.splitModels({ time: ['t'], temperature_950hPa: [5] }, ['icon_seamless']);
    ok('split: one model keeps plain names', one.icon_seamless.temperature_950hPa[0] === 5);
}

// ---- Evidence rules
{
    ok('level: −4 °C, 96 % → red', I.levelState(-4, 96) === 'red');
    ok('level: −5 °C, 85 % → marginal', I.levelState(-5, 85) === 'marginal');
    ok('level: +0.5 °C, 95 % → marginal (temperature margin)', I.levelState(0.5, 95) === 'marginal');
    ok('level: −25 °C, 95 % → marginal (mostly glaciated)', I.levelState(-25, 95) === 'marginal');
    ok('level: −5 °C, 70 % → none', I.levelState(-5, 70) === 'none');
    ok('level: +3 °C, 99 % → none', I.levelState(3, 99) === 'none');
    ok('level: missing RH → unknown', I.levelState(-5, null) === 'unknown');
    ok('RH: ECMWF 95 % at −15 °C is ≈ 84 % over water', near(I.rhOverWater(95, -15, 'ecmwf'), 83.6, 0.5), I.rhOverWater(95, -15, 'ecmwf'));
    ok('RH: over ice at −10 °C × 0.907 over water', near(I.rhOverWater(100, -10, 'ice'), 90.7, 0.3));
    ok('RH: water convention unchanged', I.rhOverWater(95, -15, 'water') === 95);
    ok('dew point: 10 °C, 50 % ≈ 0 °C', near(I.dewPoint(10, 50), 0, 0.5), I.dewPoint(10, 50));
}

// ---- Mode A, one model's flight
{
    const dry = h0(makeBody());
    ok('cold and dry: no icing signs', dry.state === 'none' && dry.models.icon_seamless.flight.state === 'none', dry.state);
    ok('cold and dry: both models known', dry.combined.known === 2 && dry.combined.total === 2);
    ok('cold and dry: clear up to 800 hPa (the ~1 km gap to 700 hPa is not "clear")', dry.models.icon_seamless.layers.clearToAgl === AGL[800] && dry.models.icon_seamless.layers.topOfDataAgl === AGL[700] && !dry.models.icon_seamless.layers.layers.length);
    const fl = dry.models.icon_seamless.flight;
    ok('climb: 400 m at 2 m/s = 3.33 min', near(Object.values(fl.climb.minutes).reduce((a, b) => a + b, 0), 400 / 2 / 60));
    ok('cruise: 2 h = two hourly slots, 120 min', fl.cruise.slots.length === 2 && fl.cruise.minutes.none === 120);
    ok('descent at the hour the flight ends', fl.descent.index === 2);
    ok('flight height 400 m above takeoff → 569 m above sea level', fl.targetAsl === ELEV + 400);
}
{
    // Layer at the flight altitude: 950 and 925 hPa saturated, −4 °C.
    const body = makeBody({ level: (m, i, p) => (p === 950 || p === 925 ? WET : {}) });
    const h = h0(body), f = h.models.icon_seamless.flight, L = h.models.icon_seamless.layers;
    ok('layer at flight altitude: red, cruise red', h.state === 'red' && f.cruise.state === 'red' && !f.climbOnly);
    ok('layer at flight altitude: cruise from 950 + 925 hPa', f.cruise.slots[0].levels.join() === '950,925' && !f.cruise.slots[0].coarse, f.cruise.slots[0]);
    ok('layer at flight altitude: climb red from 180 m (220 m at 2 m/s = 1.83 min)', near(f.climb.minutes.red, 220 / 2 / 60), f.climb.minutes);
    ok('layer report: red at 380–590 m, clear at 180 and 865 m', L.layers.length === 1 && L.layers[0].bottomAgl === 380 && L.layers[0].topAgl === 590 && L.layers[0].belowAgl === 180 && L.layers[0].aboveAgl === 865, L.layers[0]);
    ok('layer report: −4 °C, clear below 180 m', L.layers[0].tMin === -4 && L.layers[0].tMax === -4 && L.clearToAgl === 180);
}
{
    // Layer only below the flight altitude (975 hPa).
    const h = h0(makeBody({ level: (m, i, p) => (p === 975 ? WET : {}) }));
    const f = h.models.icon_seamless.flight;
    ok('layer below only: red, climb only', h.state === 'red' && f.climbOnly && f.cruise.state === 'none');
    ok('layer below only: 380 m of climb in it (worse of the levels around)', near(f.climb.minutes.red, 380 / 2 / 60), f.climb.minutes);
    ok('layer below only: descent red too', f.descent.state === 'red');
}
{
    // Layer above the flight altitude only (900 hPa).
    const h = h0(makeBody({ level: (m, i, p) => (p === 900 ? WET : {}) }));
    const L = h.models.icon_seamless.layers;
    ok('layer above only: no icing signs on the flight', h.state === 'none');
    ok('layer above only: reported at 865 m, clear to 590 m', L.layers.length === 1 && L.layers[0].bottomAgl === 865 && L.clearToAgl === 590);
}
{
    // Two layers separated by moist (marginal) air; warm above the upper one.
    const h = h0(makeBody({ level: (m, i, p) => (p === 975 || p === 900 ? WET : p === 950 ? { rh: 85 } : p === 850 ? { t: 2, rh: 50 } : {}) }));
    const L = h.models.icon_seamless.layers.layers;
    ok('two layers', L.length === 2 && L[0].bottomAgl === 180 && L[1].bottomAgl === 865, L.map(l => [l.bottomAgl, l.topAgl]));
    ok('upper layer: dry or warm above', L[1].dryOrWarmAbove === true && L[0].dryOrWarmAbove === false);
}

// ---- Surface cues
{
    const fog = h0(makeBody({ sfc: () => ({ code: 48, t2: -2 }) })).models.icon_seamless;
    ok('rime fog code 48: red, climb only, source code', fog.flight.state === 'red' && fog.flight.climbOnly && fog.flight.cues.start.fog.source === 'code');
    ok('fog: nothing clear from the ground', fog.layers.clearToAgl === 0);
    const vis = h0(makeBody({ sfc: () => ({ t2: -2, vis: 500 }) })).models.icon_seamless.flight;
    ok('fog: −2 °C and 500 m visibility', vis.state === 'red' && vis.cues.start.fog.source === 'visibility');
    const hum = h0(makeBody({ sfc: () => ({ t2: -2, rh2: 98, vis: null }) })).models.icon_seamless.flight;
    ok('fog: −2 °C and 98 % without visibility data', hum.state === 'red' && hum.cues.start.fog.source === 'humidity');
    const mist = h0(makeBody({ sfc: () => ({ t2: -2, rh2: 92 }) })).models.icon_seamless.flight;
    ok('2 m at −2 °C, 92 %: no fog, and the 2 m layer never takes the 90 % rule', mist.state === 'none' && !mist.cues.start.fog);
    const warm = h0(makeBody({ sfc: () => ({ t2: 2, vis: 300 }) })).models.icon_seamless.flight;
    ok('fog above 0 °C: no cue', warm.state === 'none');
}
{
    const fzra = h0(makeBody({ sfc: () => ({ code: 66, t2: -1, precip: 0.4 }) })).models.icon_seamless.flight;
    ok('freezing rain code 66: red, also in the cruise', fzra.state === 'red' && fzra.cruise.state === 'red' && fzra.cues.start.freezingPrecip.source === 'code');
    const nose = h0(makeBody({ level: (m, i, p) => (p === 850 ? { t: 2, rh: 95 } : {}), sfc: () => ({ t2: -1, precip: 0.5 }) })).models.icon_seamless.flight;
    ok('warm nose: rain, −1 °C at 2 m, +2 °C at 850 hPa → freezing precipitation', nose.state === 'red' && nose.cues.start.freezingPrecip.source === 'profile' && nose.cues.start.freezingPrecip.warmLevel === 850, nose.cues.start);
    const dryNose = h0(makeBody({ level: (m, i, p) => (p === 850 ? { t: 2 } : {}), sfc: () => ({ t2: -1, precip: 0 }) })).models.icon_seamless.flight;
    ok('warm layer without precipitation: no cue', dryNose.state === 'none');
    const warmGround = h0(makeBody({ level: (m, i, p) => (p === 850 ? { t: 2 } : {}), sfc: () => ({ t2: 1, precip: 1 }) })).models.icon_seamless.flight;
    ok('rain with +1 °C at 2 m: no freezing cue', warmGround.state === 'none');
}

// ---- Heights: masking, missing levels, high ground
{
    // 1000 hPa is 20 m below ground in AGL: masked even if saturated.
    const h = h0(makeBody({ level: (m, i, p) => (p === 1000 ? WET : {}) }));
    ok('level below ground is masked', h.state === 'none' && !h.models.icon_seamless.layers.layers.length);
    // A model without 975 / 950 hPa (like ECMWF IFS): 925 hPa only, flagged coarse; 2 m never used.
    const ifs = h0(makeBody({ models: ['ecmwf_ifs025'], level: (m, i, p) => ([975, 950, 900, 800].includes(p) ? null : {}), sfc: () => ({ t2: -2, rh2: 95 }) }), { models: ['ecmwf_ifs025'] });
    const slot = ifs.models.ecmwf_ifs025.flight.cruise.slots[0];
    ok('missing levels: 925 hPa used, coarse, not the 2 m layer', slot.levels.join() === '925' && slot.coarse === true && slot.state === 'none', slot);
    // ECMWF RH: 95 % at −15 °C is marginal after conversion, red for ICON.
    const conv = h0(makeBody({ models: ['ecmwf_ifs025', 'icon_seamless'], level: (m, i, p) => (p === 950 || p === 925 ? { t: -15, rh: 95 } : {}) }), { models: ['ecmwf_ifs025', 'icon_seamless'] });
    ok('RH normalisation: same reported RH, ECMWF marginal, ICON red', conv.models.ecmwf_ifs025.flight.cruise.state === 'marginal' && conv.models.icon_seamless.flight.cruise.state === 'red');
    // High ground: every level up to 800 hPa below the terrain.
    const mtnAgl = Object.fromEntries(Object.entries(I.STD_HEIGHT).map(([p, z]) => [p, z - 2025]));
    const mtn = h0(makeBody({ elevation: 2025, agl: mtnAgl, level: () => WET }));
    const f = mtn.models.icon_seamless.flight;
    ok('high ground: levels inside the terrain ignored, flight unknown (no level near 2425 m)', mtn.state === 'unknown' && f.cruise.slots[0].reason === 'no-level-near', f.cruise.slots[0]);
    const dryMtn = h0(makeBody({ elevation: 2025, agl: mtnAgl })).models.icon_seamless.layers;
    ok('high ground: not "clear" over a gap of ~1 km without a level', dryMtn.clearToAgl === 0 && dryMtn.topOfDataAgl > 900, dryMtn);
    // Route point where the ground is higher than the flight height.
    const cols = I.splitModels(makeBody({ models: ['icon_seamless'], elevation: 600 }).hourly, ['icon_seamless']).icon_seamless;
    const pt = I.pointState(cols, 0, 600, ELEV + 400, 'icon_seamless');
    ok('route point below ground: unknown, below-ground', pt.state === 'unknown' && pt.reason === 'below-ground', pt);
    const cols2 = I.splitModels(makeBody({ models: ['icon_seamless'], level: (m, i, p) => (p === 950 ? WET : {}) }).hourly, ['icon_seamless']).icon_seamless;
    const pt2 = I.pointState(cols2, 0, ELEV, ELEV + 400, 'icon_seamless');
    ok('route point: layer at the flight height → red, 400 m above the ground', pt2.state === 'red' && pt2.agl === 400);
}

// ---- Several models, time
{
    const split = h0(makeBody({ level: (m, i, p) => (m === 'icon_seamless' && (p === 950 || p === 925) ? WET : {}) }));
    ok('disagreeing models: red if either (v1)', split.state === 'red' && split.combined.red === 1 && split.combined.known === 2 && split.combined.redModels.join() === 'icon_seamless');
    const maj = h0(makeBody({ level: (m, i, p) => (m === 'icon_seamless' && (p === 950 || p === 925) ? WET : {}) }), { rule: 'majority' });
    ok('majority rule: 1 of 2 red is not red', maj.state === 'none');
    const horizon = run(makeBody({ level: (m, i, p) => (m === 'ukmo_seamless' && i >= 3 ? null : {}), sfc: (m, i) => (m === 'ukmo_seamless' && i >= 3 ? null : {}) }));
    ok('model beyond its forecast length: left out, counted', horizon.hours[3].combined.known === 1 && horizon.hours[3].combined.total === 2 && horizon.hours[3].models.ukmo_seamless.flight.state === 'unknown');
    const none = h0(makeBody({ level: () => null, sfc: () => null }));
    ok('no data at all: unknown', none.state === 'unknown' && none.combined.known === 0);
}
{
    // Layer at the flight altitude only at hours 2–3.
    const r = run(makeBody({ hours: 8, level: (m, i, p) => ((i === 2 || i === 3) && (p === 950 || p === 925) ? WET : {}) }));
    const d0 = r.hours[0].models.icon_seamless.flight, d1 = r.hours[1].models.icon_seamless.flight, d4 = r.hours[4].models.icon_seamless.flight;
    ok('time: leaving 2 h before — cruise clear, red on the descent', d0.state === 'red' && d0.cruise.state === 'none' && d0.descent.state === 'red' && d0.climbOnly);
    ok('time: leaving 1 h before — 60 min of cruise in it', d1.cruise.minutes.red === 60 && d1.cruise.minutes.none === 60);
    ok('time: leaving after it — no icing signs', d4.state === 'none');
    const last = r.hours[7].models.icon_seamless.flight;
    ok('flight running past the data: partly unknown', last.partlyUnknown && last.descent.state === 'unknown');
    const short = run(makeBody(), { profile: { durationMin: 30 } }).hours[0].models.icon_seamless.flight;
    ok('30 min flight: one slot of 30 min', short.cruise.slots.length === 1 && short.cruise.minutes.none === 30);
}
{
    const low = run(makeBody({ sfc: () => ({ t2: -1, vis: 400 }) }), { profile: { heightM: 10 } }).hours[0].models.icon_seamless.flight;
    ok('10 m flight: surface cues only (fog → red)', low.state === 'red' && !low.climb.bands.length);
    const lowOk = run(makeBody(), { profile: { heightM: 10 } }).hours[0].models.icon_seamless.flight;
    ok('10 m flight without cues: none, fully known', lowOk.state === 'none' && !lowOk.partlyUnknown, lowOk);
    const strict = run(makeBody({ level: (m, i, p) => (p === 950 ? { t: -4, rh: 92 } : {}) }), { thresholds: { rhRed: 95 } }).hours[0];
    ok('thresholds: RH 92 % is marginal with rhRed 95', strict.models.icon_seamless.flight.cruise.state === 'marginal');
}

// ---- Browser global
{
    const sandbox = { window: {} };
    vm.runInNewContext(fs.readFileSync(new URL('../icing.js', import.meta.url), 'utf8'), sandbox);
    ok('browser: window.FlySkyIcing', sandbox.window.FlySkyIcing && typeof sandbox.window.FlySkyIcing.evaluate === 'function');
}
