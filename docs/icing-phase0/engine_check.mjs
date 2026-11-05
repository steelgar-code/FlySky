// Runs the app's icing engine (../../icing.js) on the Phase 0 data: last winter's ICON and UKMO
// hours (winter.py) and the saved 8-day forecasts (live.py). A cross-check of the engine against
// the Python analysis, and a look at what it reports.
//   node engine_check.mjs            (P0_DATA=<folder> for another data folder)
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const I = require('../../icing.js');
const here = path.dirname(fileURLToPath(import.meta.url));
const D = process.env.P0_DATA || path.join(here, 'data');
const load = tag => { const p = path.join(D, tag + '.json'); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null; };
const pct = (n, d) => `${(100 * n / d).toFixed(1)}%`.padStart(6);
const MODELS = I.DEFAULT_MODELS;

// One body with both models' columns suffixed, like a two-model response.
function merge(name) {
    const parts = MODELS.map(m => [m, load(`hw_${name}_${m}`)]);
    if (parts.some(([, b]) => !b)) return null;
    const first = parts[0][1];
    const hourly = { time: first.hourly.time };
    parts.forEach(([m, b]) => Object.entries(b.hourly).forEach(([k, v]) => { if (k !== 'time') hourly[`${k}_${m}`] = v; }));
    return { ...first, hourly };
}

console.log('Winter 2025/26 (Dec–Feb), ICON + UKMO, flight 400 m above takeoff, climb / descent 2 m/s');
console.log('(winter files have heights for 1000–925 hPa only: levels above are not placed)\n');
for (const name of ['kyiv', 'zap']) {
    const body = merge(name);
    if (!body) { console.log(name, ': no winter data (run winter.py)'); continue; }
    const n = body.hourly.time.length;
    for (const [label, durationMin] of [['one instant', 1], ['2 h flight', 120]]) {
        const r = I.evaluate(body, { profile: { durationMin } });
        const valid = r.hours.slice(0, n - Math.round(durationMin / 60));
        const per = MODELS.map(m => {
            const f = valid.map(h => h.models[m].flight);
            return `${I.MODELS[m].name}: red ${pct(f.filter(x => x.state === 'red').length, f.length)}, cruise red ${pct(f.filter(x => x.cruise.state === 'red').length, f.length)}, climb only ${pct(f.filter(x => x.climbOnly).length, f.length)}`;
        });
        const either = valid.filter(h => h.state === 'red').length, one = valid.filter(h => h.combined.red === 1).length;
        console.log(`${name.padEnd(4)} ${label.padEnd(11)} | ${per.join(' | ')} | either red ${pct(either, valid.length)} (1 of 2: ${pct(one, valid.length)})`);
    }
}
console.log('\nPython analysis for comparison (950 hPa as the flight level, one instant, 2 m through the fog cue only):');
console.log('  Kyiv ICON 44.5 %, UKMO 54.9 %, either 62.0 %;  Zaporizhzhia ICON 38.1 %, UKMO 44.1 %, either 49.5 %');
console.log('  2 h flights: Kyiv ICON 51.3 %, UKMO 63.9 %;  Zaporizhzhia ICON 44.2 %, UKMO 51.1 %');

// What the engine reports for the saved 8-day forecasts (2026-11-05 00 UTC run).
const fmt = (a) => (a === null || a === undefined ? '—' : `${Math.round(a)} m`);
for (const name of ['kyiv', 'carp']) {
    const full = load(`live_v1_${name}`);
    if (!full) continue;
    const body = { ...full, hourly: Object.fromEntries(Object.entries(full.hourly).filter(([k]) => k === 'time' || MODELS.some(m => k.endsWith('_' + m)))) };
    const r = I.evaluate(body);
    console.log(`\n${name}: forecast from ${r.times[0]} UTC, elevation ${r.elevation} m, flight 400 m above takeoff (${r.elevation + 400} m above sea level), every 6 h`);
    console.log('  time              state     models                 ICON cruise (levels, T, RH)            ICON layers');
    r.hours.forEach((h, i) => {
        if (i % 6) return;
        const f = h.models.icon_seamless.flight, L = h.models.icon_seamless.layers;
        const s = f.cruise && f.cruise.slots && f.cruise.slots[0];
        const cruise = !s ? '—' : s.reason ? s.reason : `${s.levels.join('/')} hPa ${s.t !== undefined ? s.t.toFixed(1) : '?'} °C ${s.rhw !== undefined ? Math.round(s.rhw) : '?'} %${s.coarse ? ' coarse' : ''}`;
        const lay = L.layers.length ? L.layers.map(l => `red ${fmt(l.bottomAgl)}–${fmt(l.topAgl)} (${l.tMax.toFixed(0)}…${l.tMin.toFixed(0)} °C)`).join('; ')
            : `none (clear to ${fmt(L.clearToAgl)})`;
        const models = `${h.combined.red} of ${h.combined.known} red`;
        console.log(`  ${h.time}  ${h.state.padEnd(8)}  ${models.padEnd(22)} ${cruise.padEnd(38)} ${lay}`);
    });
}
