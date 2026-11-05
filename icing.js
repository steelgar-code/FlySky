// FlySky — atmospheric icing screening engine (experimental)
//
// Screens the forecast atmosphere for conditions in which a small fixed-wing
// UAV could pick up ice: sub-zero air near saturation (a cloud environment),
// freezing fog at the ground, and freezing precipitation. It does NOT
// forecast ice accretion, a probability or a severity, and "no icing signs"
// never means "safe". Design, decisions and the API checks behind it:
// docs/icing-forecast-handoff.md.
//
// Stage 1: the engine only — not loaded by the app yet. The forecast tab
// (stage 3) and the flight time calculator (stage 4) will use it. Pure
// functions: no DOM, no network, no translations. Callers build the request
// with requestParams(), fetch it, and pass the response to evaluate() (forecast
// tab) or pointState() (a point of a route).
//
// Data: Open-Meteo forecast API, deterministic models (v1: DWD ICON and UK Met
// Office — both have the 975 / 950 hPa levels and report RH over water). Per
// pressure level: temperature, relative humidity, geopotential height; at the
// surface: 2 m temperature and humidity, weather code, visibility,
// precipitation.
//
// Heights: the flight altitude is metres above the takeoff point. With the
// takeoff elevation (the response's `elevation`) that is a fixed height above
// sea level. Each hour, the pressure levels just below and above that height
// (placed by their geopotential height) give its state — the worse of the two;
// humidity is never interpolated. Levels less than 20 m above the ground are
// inside the terrain (Open-Meteo extrapolates values there) and are ignored.
// The 2 m values feed only the surface cues (freezing fog, freezing
// precipitation), never the level rule.
//
// Works in the browser (window.FlySkyIcing) and in Node (module.exports):
// tests in tests/icing-engine.mjs.
(function (root) {
    'use strict';

    const VERSION = 1;

    // Pressure levels (hPa) the engine knows, from the ground up, with their
    // height above sea level in the standard atmosphere (m) — only used to
    // choose which levels to request; the real heights come with the data.
    const LEVELS = [1000, 975, 950, 925, 900, 850, 800, 700];
    const STD_HEIGHT = { 1000: 110, 975: 320, 950: 540, 925: 760, 900: 990, 850: 1460, 800: 1950, 700: 3010 };
    const SURFACE_VARS = ['temperature_2m', 'relative_humidity_2m', 'weather_code', 'visibility', 'precipitation'];

    // How each model reports relative humidity below 0 °C (design §4.4):
    //  'water' — over water (used as is);
    //  'ecmwf' — ECMWF's definition: over water above 0 °C, over ice below
    //            −23 °C, a quadratic blend between (converted to over water);
    //  'ice'   — over ice below 0 °C (converted to over water).
    // `rhConfirmed` false: the convention is not documented / not clear from
    // the Phase 0 data, so the values are used as given and the details say so.
    const MODELS = {
        icon_seamless: { name: 'DWD ICON', rh: 'water', rhConfirmed: true, codes: true },
        ukmo_seamless: { name: 'UK Met Office', rh: 'water', rhConfirmed: false },
        ecmwf_ifs025: { name: 'ECMWF IFS', rh: 'ecmwf', rhConfirmed: true },
        ecmwf_aifs025_single: { name: 'ECMWF AIFS', rh: 'ecmwf', rhConfirmed: false },
        meteofrance_seamless: { name: 'Météo-France', rh: 'water', rhConfirmed: false },
        gfs_seamless: { name: 'NOAA GFS', rh: 'water', rhConfirmed: false, codes: true },
        gem_seamless: { name: 'GEM', rh: 'water', rhConfirmed: true },
        jma_seamless: { name: 'JMA', rh: 'water', rhConfirmed: false }
    };
    // v1: two models, "red if either is red" (design D16).
    const DEFAULT_MODELS = ['icon_seamless', 'ukmo_seamless'];

    // Experimental thresholds (design §7.4). Temperatures °C, RH % over water.
    const DEFAULT_THRESHOLDS = {
        tMin: -20, tMax: 0,         // red: tMin ≤ T ≤ tMax and RH ≥ rhRed
        tWarm: 1, tCold: -30,       // marginal margins in temperature
        rhRed: 90, rhMarginal: 80,
        fogT2m: 0, fogRh2m: 97, fogVisM: 1000,   // freezing fog at the ground
        precipMm: 0.1               // mm/h: precipitation for the freezing-precipitation cue
    };
    // Flight profile defaults (design §5.2): metres above takeoff, m/s, minutes.
    const DEFAULT_PROFILE = { heightM: 400, climbMs: 2, descentMs: 2, durationMin: 120 };

    const MIN_AGL = 20;             // a level lower than this above the ground is inside the terrain
    const SURFACE_ONLY_M = 50;      // below this flight height: surface cues only
    const MAX_LEVEL_DIST = 500;     // a level farther than this from the flight height is not used for it
    const COARSE_DIST = 300;        // … and one farther than this makes the result "coarse"
    const DRY_ABOVE_RH = 80;        // above a layer: "dry" below this RH (over water)
    const FREEZING_CODES = [56, 57, 66, 67];
    const FOG_CODE = 48;

    const RANK = { unknown: -1, none: 0, marginal: 1, red: 2 };
    const STATES = ['none', 'marginal', 'red'];

    // The worst known state of the arguments (arrays are flattened); 'unknown'
    // only when nothing is known.
    function worst(...states) {
        return states.flat().reduce((w, s) => (RANK[s] > RANK[w] ? s : w), 'unknown');
    }

    // ---- Humidity

    // Saturation vapour pressure (hPa) over water and over ice (Magnus form,
    // WMO), and ECMWF's water/ice blend.
    const esWater = t => 6.112 * Math.exp(17.62 * t / (243.12 + t));
    const esIce = t => 6.112 * Math.exp(22.46 * t / (272.62 + t));
    function esEcmwf(t) {
        if (t >= 0) return esWater(t);
        if (t <= -23) return esIce(t);
        const a = ((t + 23) / 23) ** 2;
        return a * esWater(t) + (1 - a) * esIce(t);
    }

    // RH as reported by a model → RH over water.
    function rhOverWater(rh, t, convention) {
        if (!Number.isFinite(rh) || !Number.isFinite(t)) return null;
        if (convention === 'ecmwf') return rh * esEcmwf(t) / esWater(t);
        if (convention === 'ice' && t < 0) return rh * esIce(t) / esWater(t);
        return rh;
    }

    // Dew point (°C) from T and RH over water — for display only.
    function dewPoint(t, rh) {
        if (!Number.isFinite(t) || !(rh > 0)) return null;
        const g = Math.log(rh / 100) + 17.625 * t / (243.04 + t);
        return 243.04 * g / (17.625 - g);
    }

    // ---- Evidence

    // State of one level from T and RH over water (design §7.4).
    function levelState(t, rhw, th = DEFAULT_THRESHOLDS) {
        if (!Number.isFinite(t) || !Number.isFinite(rhw)) return 'unknown';
        if (t >= th.tMin && t <= th.tMax && rhw >= th.rhRed) return 'red';
        if ((t >= th.tMin && t <= th.tWarm && rhw >= th.rhMarginal && rhw < th.rhRed)
            || (t > th.tMax && t <= th.tWarm && rhw >= th.rhRed)
            || (t >= th.tCold && t < th.tMin && rhw >= th.rhRed)) return 'marginal';
        return 'none';
    }

    // Surface cues for one hour: freezing fog (code 48, or sub-zero 2 m air
    // with low visibility or near saturation) and freezing precipitation
    // (code 56/57/66/67, or precipitation with sub-zero 2 m air under a layer
    // warmer than 0 °C — the warm nose). `source` says which data showed it.
    function surfaceCues(sfc, levels, th = DEFAULT_THRESHOLDS) {
        const out = { fog: null, freezingPrecip: null };
        const cold = Number.isFinite(sfc.t2) && sfc.t2 <= th.fogT2m;
        if (sfc.code === FOG_CODE) out.fog = { source: 'code' };
        else if (cold && Number.isFinite(sfc.vis) && sfc.vis < th.fogVisM) out.fog = { source: 'visibility' };
        else if (cold && Number.isFinite(sfc.rh2) && sfc.rh2 >= th.fogRh2m) out.fog = { source: 'humidity' };
        if (FREEZING_CODES.includes(sfc.code)) out.freezingPrecip = { source: 'code', code: sfc.code };
        else if (Number.isFinite(sfc.precip) && sfc.precip >= th.precipMm && Number.isFinite(sfc.t2) && sfc.t2 <= 0) {
            const warm = levels.find(l => Number.isFinite(l.t) && l.t > 0 && !(l.agl !== null && l.agl < MIN_AGL));
            if (warm) out.freezingPrecip = { source: 'profile', warmLevel: warm.p, warmT: warm.t };
        }
        return out;
    }

    // ---- Request

    // Pressure levels to request for a flight height (m above sea level): up
    // to 500 m above it and at least up to 850 hPa (for the layer report),
    // plus the next level when none of those is 300 m or more above it.
    function levelsFor(targetAsl) {
        const top = Math.max(targetAsl + 500, STD_HEIGHT[850]);
        const out = LEVELS.filter(p => STD_HEIGHT[p] <= top);
        const next = LEVELS.find(p => !out.includes(p));
        if (next && STD_HEIGHT[out[out.length - 1]] < targetAsl + COARSE_DIST) out.push(next);
        return out;
    }

    // Query parameters of the forecast-tab icing request (one location).
    // `elevation` (m) of the location if known — it decides which levels are
    // needed; without it 300 m is assumed.
    function requestParams({ latitude, longitude, heightM = DEFAULT_PROFILE.heightM, elevation, models = DEFAULT_MODELS, days = 8, timezone = 'auto' }) {
        const targetAsl = (Number.isFinite(elevation) ? elevation : 300) + heightM;
        const levels = levelsFor(targetAsl);
        const hourly = [];
        levels.forEach(p => hourly.push(`temperature_${p}hPa`, `relative_humidity_${p}hPa`, `geopotential_height_${p}hPa`));
        // The warm-nose check looks up to 700 hPa.
        if (!levels.includes(700)) hourly.push('temperature_700hPa');
        hourly.push(...SURFACE_VARS);
        return { latitude, longitude, hourly: hourly.join(','), models: models.join(','), forecast_days: days, timezone };
    }

    // Open-Meteo's call weight of a request (verified in Phase 0): per
    // location max(1, variables × models / 10), × days / 14 beyond 14 days.
    function requestCost(params) {
        const vars = String(params.hourly || '').split(',').filter(Boolean).length;
        const models = params.models ? String(params.models).split(',').filter(Boolean).length : 1;
        const locations = String(params.latitude).split(',').length;
        const days = Number(params.forecast_days) || 7;
        return locations * Math.max(1, vars * models / 10 * (days > 14 ? days / 14 : 1));
    }

    // ---- Response

    // Splits the hourly columns of a response into one set per model. With
    // several models every column ends with the model id
    // ("temperature_950hPa_icon_seamless"); with one model the names are plain.
    function splitModels(hourly, models) {
        const out = {};
        models.forEach(m => { out[m] = { time: hourly.time }; });
        if (models.length === 1) { Object.assign(out[models[0]], hourly); return out; }
        const byLength = models.slice().sort((a, b) => b.length - a.length);
        Object.keys(hourly).forEach(k => {
            if (k === 'time') return;
            const m = byLength.find(id => k.endsWith('_' + id));
            if (m) out[m][k.slice(0, -(m.length + 1))] = hourly[k];
        });
        return out;
    }

    // One model's atmosphere at hour i: levels from the ground up with their
    // height above sea level (z) and above the ground (agl), T, reported RH,
    // RH over water and state; surface values and cues.
    function profileAt(cols, i, elevation, model, th = DEFAULT_THRESHOLDS) {
        const at = k => { const s = cols && cols[k]; const v = s ? s[i] : null; return Number.isFinite(v) ? v : null; };
        const conv = (MODELS[model] || {}).rh || 'water';
        const levels = [];
        LEVELS.forEach(p => {
            const z = at(`geopotential_height_${p}hPa`), t = at(`temperature_${p}hPa`), rh = at(`relative_humidity_${p}hPa`);
            if (z === null && t === null && rh === null) return;
            const agl = z === null || !Number.isFinite(elevation) ? null : z - elevation;
            const valid = z !== null && t !== null && rh !== null && agl !== null && agl >= MIN_AGL;
            const rhw = rhOverWater(rh, t, conv);
            levels.push({ p, z, agl, t, rh, rhw, valid, state: valid ? levelState(t, rhw, th) : 'unknown' });
        });
        levels.sort((a, b) => b.p - a.p);
        const sfc = { t2: at('temperature_2m'), rh2: at('relative_humidity_2m'), code: at('weather_code'), vis: at('visibility'), precip: at('precipitation') };
        const hasData = levels.some(l => l.valid) || sfc.t2 !== null;
        return { i, time: cols && cols.time ? cols.time[i] : null, model, elevation, levels, sfc, cues: surfaceCues(sfc, levels, th), hasData };
    }

    // State at a fixed height above sea level: the worse of the nearest
    // usable levels below and above (within MAX_LEVEL_DIST). Never the 2 m
    // values. { state, levels: [p…], t, rhw (of the worse level), coarse,
    // reason } — reason 'below-ground' / 'no-levels' / 'no-level-near'.
    function stateAt(prof, zAsl) {
        if (!prof) return { state: 'unknown', levels: [], reason: 'no-data' };
        if (Number.isFinite(prof.elevation) && zAsl - prof.elevation < MIN_AGL) return { state: 'unknown', levels: [], reason: 'below-ground' };
        const v = prof.levels.filter(l => l.valid);
        if (!v.length) return { state: 'unknown', levels: [], reason: 'no-levels' };
        let below = null, above = null;
        v.forEach(l => {
            if (l.z <= zAsl) below = l;
            else if (!above) above = l;
        });
        const used = [below, above].filter(l => l && Math.abs(l.z - zAsl) <= MAX_LEVEL_DIST);
        if (!used.length) return { state: 'unknown', levels: [], reason: 'no-level-near' };
        const exact = used.find(l => Math.abs(l.z - zAsl) < 1);
        const pick = exact ? [exact] : used;
        const w = pick.reduce((a, b) => (RANK[b.state] > RANK[a.state] ? b : a));
        return {
            state: w.state, levels: pick.map(l => l.p), t: w.t, rhw: w.rhw,
            coarse: !exact && (pick.length < 2 || pick.some(l => Math.abs(l.z - zAsl) > COARSE_DIST))
        };
    }

    // The bands crossed between two heights above the ground (climb or
    // descent): split at every usable level; each band takes the worse of the
    // levels around it. Neighbouring bands of the same state are merged.
    // [{ fromAgl, toAgl, state, levels }]
    function bands(prof, fromAgl, toAgl) {
        if (!prof || !(toAgl > fromAgl)) return [];
        const cuts = [fromAgl, ...prof.levels.filter(l => l.valid && l.agl > fromAgl && l.agl < toAgl).map(l => l.agl), toAgl];
        const out = [];
        for (let k = 1; k < cuts.length; k++) {
            const a = cuts[k - 1], b = cuts[k];
            const s = stateAt(prof, prof.elevation + Math.max((a + b) / 2, MIN_AGL));
            const last = out[out.length - 1];
            if (last && last.state === s.state) { last.toAgl = b; last.levels = [...new Set(last.levels.concat(s.levels))]; }
            else out.push({ fromAgl: a, toAgl: b, state: s.state, levels: s.levels });
        }
        return out;
    }

    // Minutes per state for bands flown at `rate` m/s.
    function bandMinutes(list, rate) {
        const m = { red: 0, marginal: 0, none: 0, unknown: 0 };
        list.forEach(b => { m[b.state] += (b.toAgl - b.fromAgl) / rate / 60; });
        return m;
    }

    // Icing layers in one hour's profile: runs of red levels from the ground
    // up. Each: the lowest / highest red level (bottomAgl / topAgl), the
    // levels around the run without red (belowAgl — 0 for the ground —, and
    // aboveAgl, null when the run reaches the top of the data): the layer's
    // real edges lie somewhere between. tMin / tMax over the red levels;
    // dryOrWarmAbove when the level above is above 0 °C or drier than 80 %.
    // clearToAgl: height up to which every level shows no icing signs and no
    // fog at the ground (0 when the lowest level already shows some). It stops
    // at a gap of more than MAX_LEVEL_DIST without a level (high ground).
    function layers(prof) {
        const v = prof ? prof.levels.filter(l => l.valid) : [];
        const runs = [];
        let cur = null;
        v.forEach((l, k) => {
            if (l.state === 'red') { if (cur) cur.to = k; else cur = { from: k, to: k }; }
            else if (cur) { runs.push(cur); cur = null; }
        });
        if (cur) runs.push(cur);
        const list = runs.map(r => {
            const red = v.slice(r.from, r.to + 1), up = v[r.to + 1];
            return {
                bottomAgl: v[r.from].agl, topAgl: v[r.to].agl,
                belowAgl: r.from > 0 ? v[r.from - 1].agl : 0,
                aboveAgl: up ? up.agl : null,
                tMin: Math.min(...red.map(l => l.t)), tMax: Math.max(...red.map(l => l.t)),
                dryOrWarmAbove: !!up && (up.t > 0 || up.rhw < DRY_ABOVE_RH),
                levels: red.map(l => l.p)
            };
        });
        let clearToAgl = 0;
        if (prof && !prof.cues.fog) {
            for (const l of v) {
                if (l.state !== 'none' || l.agl - clearToAgl > MAX_LEVEL_DIST) break;
                clearToAgl = l.agl;
            }
        }
        return { layers: list, clearToAgl, topOfDataAgl: v.length ? v[v.length - 1].agl : null };
    }

    // ---- Mode A: a flight from the location, leaving at hour i

    // One model, departure at hour index i: climb at hour i, cruise from i for
    // durationMin, descent at the hour the flight ends; surface cues at both
    // ends; freezing precipitation also during the cruise. The state is the
    // worst of all phases (design D2: climb / descent only is red too).
    function flight(profiles, i, profile = DEFAULT_PROFILE) {
        const p = { ...DEFAULT_PROFILE, ...profile };
        const start = profiles[i];
        if (!start || !start.hasData) return { state: 'unknown', reason: 'no-data' };
        const endIndex = i + Math.round(p.durationMin / 60);
        const end = profiles[endIndex];
        const targetAsl = start.elevation + p.heightM;
        const surfaceOnly = p.heightM < SURFACE_ONLY_M;

        const climbBands = surfaceOnly ? [] : bands(start, 0, p.heightM);
        const descentBands = surfaceOnly || !end ? [] : bands(end, 0, p.heightM);

        const slots = [];
        for (let j = 0; j * 60 < p.durationMin; j++) {
            const prof = profiles[i + j];
            const minutes = Math.min(60, p.durationMin - j * 60);
            const at = !prof || !prof.hasData ? { state: 'unknown', levels: [], reason: 'no-data' }
                : surfaceOnly ? { state: Number.isFinite(prof.sfc.t2) ? 'none' : 'unknown', levels: [] }
                : stateAt(prof, targetAsl);
            const fzp = prof && prof.cues.freezingPrecip;
            slots.push({ index: i + j, minutes, ...at, state: fzp ? 'red' : at.state, freezingPrecip: fzp || null, levelState: at.state });
        }
        const cruiseMinutes = { red: 0, marginal: 0, none: 0, unknown: 0 };
        slots.forEach(s => { cruiseMinutes[s.state] += s.minutes; });

        const cuesStart = start.cues, cuesEnd = end ? end.cues : null;
        const cueRed = [cuesStart, cuesEnd].some(c => c && (c.fog || c.freezingPrecip));
        // A phase without levels to cross (surface-only flight): the fog cue,
        // or "none" when the ground values are there.
        const phase = (list, prof) => !prof ? 'unknown'
            : worst(list.map(b => b.state), prof.cues.fog ? 'red' : [], surfaceOnly && Number.isFinite(prof.sfc.t2) ? 'none' : []);
        const climbState = phase(climbBands, start);
        const descentState = phase(descentBands, end);
        const cruiseState = worst(slots.map(s => s.state));
        const state = worst(climbState, cruiseState, descentState, cueRed ? 'red' : []);
        return {
            state,
            // red only on the way up or down (or at the ground), while the cruise is known and not red
            climbOnly: state === 'red' && (cruiseState === 'none' || cruiseState === 'marginal'),
            targetAsl,
            climb: { state: climbState, bands: climbBands, minutes: bandMinutes(climbBands, p.climbMs), index: i },
            cruise: { state: cruiseState, slots, minutes: cruiseMinutes },
            descent: end ? { state: descentState, bands: descentBands, minutes: bandMinutes(descentBands, p.descentMs), index: endIndex }
                : { state: 'unknown', bands: [], minutes: null, index: endIndex, reason: 'beyond-data' },
            cues: { start: cuesStart, end: cuesEnd },
            partlyUnknown: cruiseMinutes.unknown > 0 || !end || climbState === 'unknown' || descentState === 'unknown'
        };
    }

    // ---- Several models

    // Combines the models' states for one hour. 'either' (v1): red if any
    // model with data is red, else the worst; 'majority': red when ≥ 60 % of
    // them are red, marginal when ≥ 60 % are red or marginal. Models without
    // data are left out and counted as such.
    function combine(statesByModel, rule = 'either') {
        const ids = Object.keys(statesByModel);
        const known = ids.filter(id => statesByModel[id] !== 'unknown');
        const count = s => known.filter(id => statesByModel[id] === s).length;
        const out = { total: ids.length, known: known.length, red: count('red'), marginal: count('marginal'), none: count('none'),
            redModels: known.filter(id => statesByModel[id] === 'red') };
        if (!known.length) return { ...out, state: 'unknown', share: null };
        out.share = out.red / known.length;
        if (rule === 'majority') {
            out.state = out.share >= 0.6 ? 'red' : (out.red + out.marginal) / known.length >= 0.6 ? 'marginal' : 'none';
        } else {
            out.state = worst(known.map(id => statesByModel[id]));
        }
        return out;
    }

    // ---- Mode A for a whole response

    // Evaluates the forecast-tab icing response: every hour as a departure
    // hour, per model and combined, plus each hour's icing layers.
    //   opts: { models, profile: { heightM, climbMs, descentMs, durationMin },
    //           thresholds, rule: 'either' | 'majority' }
    // → { elevation, times, models, hours: [{ time, state, combined,
    //      models: { id: { flight, layers } } }], profiles }
    function evaluate(body, opts = {}) {
        const models = opts.models || DEFAULT_MODELS;
        const th = { ...DEFAULT_THRESHOLDS, ...(opts.thresholds || {}) };
        const profile = { ...DEFAULT_PROFILE, ...(opts.profile || {}) };
        const rule = opts.rule || 'either';
        const times = (body && body.hourly && body.hourly.time) || [];
        const elevation = body ? body.elevation : null;
        const cols = splitModels((body && body.hourly) || { time: [] }, models);
        const profiles = {};
        models.forEach(m => { profiles[m] = times.map((_, i) => profileAt(cols[m], i, elevation, m, th)); });
        const hours = times.map((time, i) => {
            const per = {};
            models.forEach(m => { per[m] = { flight: flight(profiles[m], i, profile), layers: layers(profiles[m][i]) }; });
            const combined = combine(Object.fromEntries(models.map(m => [m, per[m].flight.state])), rule);
            return { time, state: combined.state, combined, models: per };
        });
        return { elevation, times, models, profile, thresholds: th, rule, hours, profiles };
    }

    // ---- Mode B: one point of a route

    // State at a route point at hour i for a flight height above sea level:
    // the levels around it, and freezing precipitation (red at any height
    // under a warm nose). Fog at the ground does not count at cruise height.
    // `cols`: one model's hourly columns for that point (splitModels()).
    function pointState(cols, i, elevation, targetAsl, model, thresholds) {
        const th = { ...DEFAULT_THRESHOLDS, ...(thresholds || {}) };
        const prof = profileAt(cols, i, elevation, model, th);
        if (!prof.hasData) return { state: 'unknown', reason: 'no-data', levels: [] };
        const at = stateAt(prof, targetAsl);
        const fzp = prof.cues.freezingPrecip;
        return { ...at, state: fzp ? 'red' : at.state, levelState: at.state, freezingPrecip: fzp || null, agl: targetAsl - elevation };
    }

    const api = {
        VERSION, LEVELS, STD_HEIGHT, MODELS, DEFAULT_MODELS, DEFAULT_THRESHOLDS, DEFAULT_PROFILE, STATES, RANK,
        worst, esWater, esIce, esEcmwf, rhOverWater, dewPoint, levelState, surfaceCues,
        levelsFor, requestParams, requestCost, splitModels, profileAt, stateAt, bands, layers, flight, combine,
        evaluate, pointState
    };
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.FlySkyIcing = api;
})(typeof window !== 'undefined' ? window : globalThis);
