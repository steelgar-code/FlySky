// Icing indicator (experimental) in the forecast view: its request, the "Can I fly now?" row and
// layer line, the icing strip and pinned-hour details, the icing profile, planner notes, the flight
// profile settings, the indicator off / on, "Include icing in the flight verdict" (both modes),
// the "Icing risk" flag, the fade beyond 3 days and one-model stripes, the Open-Meteo usage line,
// failures and the stored copy, Ukrainian. The mock's icing scenario: lib/mock.mjs icingScenario().
import { routeAll, icingSfcScenario } from './lib/mock.mjs';
import { launch, BASE_URL, ok } from './lib/env.mjs';
const b = await launch();
const mobile = process.argv.includes('--mobile');
const ctxOpts = mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block' } : { viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' };
const KYIV = { name: 'Kyiv', latitude: 50.45, longitude: 30.52, country: 'Ukraine', elevation: 179 };

const ctx = await b.newContext(ctxOpts);
const page = await ctx.newPage();
const errors = []; page.on('pageerror', e => errors.push(e.message));
const opts = {};
const { log } = await routeAll(page, opts);
await page.goto(BASE_URL);
await page.evaluate(k => { localStorage.clear(); localStorage.setItem('flysky_last_location', JSON.stringify(k)); }, KYIV);
await page.reload(); await page.waitForTimeout(5000);
const I = (fn, arg) => page.evaluate(fn, arg);
const reqs = () => (log.icingReq || []).length;
const row = () => I(() => { const r = document.querySelector('[data-now-icing]'); return r ? r.innerText.replace(/\s*\n\s*/g, ' | ') : ''; });
const at = async k => { await I(k => selectHour(k), k); await page.waitForTimeout(150); return row(); };
const drawer = async open => { const isOpen = await I(() => !document.getElementById('settingsDrawer').classList.contains('-translate-x-full')); if (isOpen !== open) { await page.click(open ? '#btnSettings' : '#btnSettingsClose'); await page.waitForTimeout(350); } };

// ---- The request
const u = new URL((log.icingReq || [''])[0] || 'http://x/');
const vars = (u.searchParams.get('hourly') || '').split(',');
ok('one icing request: ICON + UKMO, levels, surface pressure (heights worked out from it), surface values, same timezone as the forecast', reqs() === 1 && u.searchParams.get('models') === 'icon_seamless,ukmo_seamless'
    && ['temperature_950hPa', 'relative_humidity_950hPa', 'temperature_850hPa', 'temperature_700hPa', 'surface_pressure', 'temperature_2m', 'relative_humidity_2m', 'weather_code', 'visibility', 'precipitation', 'rain', 'cloud_cover_low'].every(v => vars.includes(v))
    && !vars.some(v => /geopotential/.test(v)) && !vars.includes('relative_humidity_700hPa') && vars.length === 21
    && u.searchParams.get('timezone') === 'auto' && u.searchParams.get('forecast_days') === '8', { n: reqs(), models: u.searchParams.get('models'), vars });
await page.click('#windowButtons button:nth-child(4)'); await page.waitForTimeout(500);
await page.click('#windowButtons button:nth-child(3)'); await page.waitForTimeout(500);
ok('window switch: no new icing request', reqs() === 1);

// ---- "Can I fly now?" row: what, where, how many models; the layer line
let r = await at(0);
ok('now: potential icing at the flight altitude, both models', /Icing.*Potential icing at 400 m \(−4\.0 °C, RH 96 %\) · 2 of 2 models/.test(r), r);
ok('now: the layer, clear below, dry above', /layer ~380–590 m \(−4\.0 °C\) · no signs below ~180 m · dry or warmer above ~810 m/.test(r), r);
ok('experimental label', /experimental/i.test(r));
r = await at(3);
ok('+3 h: one model only, the layer of that model named', /Potential icing at 400 m \(−4\.0 °C, RH 96 %\) · DWD ICON only/.test(r) && /\(DWD ICON\)$/.test(r), r);
r = await at(6);
ok('+6 h: a layer below the flight altitude — climb and descent only, with what icing does', /Potential icing on the climb or descent only — ≈ 6 min in the layer \(0–380 m\); propeller thrust and airspeed readings can be lost within 1–3 min · 2 of 2 models/.test(r), r);
r = await at(9);
ok('+9 h: no icing signs (never "safe"), no layer up to the top of the data', /No icing signs in the forecast data .*· 2 of 2 models/.test(r) && /no icing layer up to ~1240 m/.test(r) && !/safe/i.test(r), r);
r = await at(10);
ok('+10 h: freezing fog at the ground when landing', /Potential icing: freezing fog at the ground · 2 of 2 models/.test(r), r);
r = await at(15);
ok('+15 h: flight clear, the layer above it shown', /No icing signs/.test(r) && /layer at ~800 m \(−4\.0 °C\) · no signs below ~590 m · dry or warmer above ~1250 m/.test(r), r);
const rowColor = await I(() => document.querySelector('[data-now-icing] .font-semibold[style]').style.color);
ok('row coloured by the state (neutral grey for no signs — not green)', /rgb\(203, 213, 225\)/.test(rowColor), rowColor);

// ---- The "Icing risk" flag next to the verdict; with the verdict option off, a line saying the verdict does not count it
const flag = async k => { await at(k); return I(() => { const f = document.querySelector('#nowMain [data-icing-flag]'); const l = document.querySelector('#nowIcing [data-icing-flagline]'); return { flag: f ? f.dataset.icingFlag : null, line: l ? l.innerText : '' }; }); };
let fl = await flag(0);
ok('flag: both models with potential icing at the flight altitude → "Icing risk", not counted by the verdict', fl.flag === 'cruise' && /both models show potential icing at the flight altitude\. The verdict above does not count it/.test(fl.line), fl);
fl = await flag(3);
ok('flag: one model only → no flag (the row still says so)', fl.flag === null && !fl.line, fl);
await at(0);

// ---- Flight conditions: icing strip, hovered and pinned hour
const strip = await I(() => { const cells = [...document.querySelectorAll('#flightIcing [data-flight-hour]')]; return { n: cells.length, hours: processed.flight.hours.length, c0: cells[0] && cells[0].style.background, c9: cells[9] && cells[9].style.background, legend: document.getElementById('flightIcingLegend').innerText }; });
ok('icing strip: one cell per hour, red now, grey at +9 h, with its legend', strip.n === strip.hours && /rgb\(208, 59, 59\)/.test(strip.c0) && /rgb\(100, 116, 139\)/.test(strip.c9) && /Lower strip: icing \(experimental\) — red potential icing, yellow marginal, grey no signs, hatched no data; striped: one model only; faded: more than 3 days ahead/.test(strip.legend), strip);
// More than 3 days ahead: faded; past UKMO's range (+100 h): one model only, striped.
await page.click('#windowButtons [data-window="168"]'); await page.waitForTimeout(800);
const far = await I(() => { const cells = [...document.querySelectorAll('#flightIcing [data-flight-hour]')]; const c = i => cells[i] && { bg: cells[i].style.background, op: cells[i].style.opacity }; return { n: cells.length, near: c(50), mid: c(80), one: c(120) }; });
ok('1 week: cells beyond 3 days faded, past UKMO\'s range striped (one model only)', far.n >= 160 && !far.near.op && far.mid.op === '0.45' && !/repeating/.test(far.mid.bg) && /repeating-linear-gradient/.test(far.one.bg) && far.one.op === '0.45', far);
r = await at(120);
ok('+120 h: "beyond 3 days", one model named', /beyond 3 days: less reliable/.test(r) && /only DWD ICON forecasts this hour/.test(r), r);
await page.click('#windowButtons [data-window="24"]'); await page.waitForTimeout(800);
await at(0);
await page.locator('#flightIcing [data-flight-hour="3"]').hover(); await page.waitForTimeout(200);
ok('hovering the icing strip: the icing line for that hour', /Icing: Potential icing at 400 m .*DWD ICON only/.test(await page.locator('#flightDetail').innerText()));
await page.locator('#flightIcing [data-flight-hour="0"]').click(); await page.waitForTimeout(300);
const det = (await page.locator('#flightDetail').innerText()).replace(/\n/g, ' | ');
ok('pinned hour: each model\'s climb, cruise and descent', /DWD ICON: climb: ≈ 1\.9 min in potential icing \(180–400 m\) · cruise: ≈ 120 min in potential icing at 400 m \(−4\.0 °C, RH 96 %\) · descent: ≈ 1\.9 min in potential icing \(180–400 m\)/.test(det) && /UK Met Office: climb: ≈ 1\.9 min/.test(det), det);
ok('pinned hour: the flight described, what the indicator is not, the platform it assumes', /2 h at 400 m above takeoff, climb 2 m\/s, descent 2 m\/s/.test(det) && /Not a validated icing forecast/.test(det) && /no ice protection, an unheated pitot tube and a fixed-wing climb \(not a VTOL hover\)/.test(det) && /the ice stays on/.test(det), det);
ok('pinned hour: the "Icing risk" flag next to the verdict', /Uncertain Icing risk/.test(det) && await page.locator('#flightDetail [data-icing-flag="cruise"]').count() === 1, det);
await page.locator('#flightIcing [data-flight-hour="0"]').click(); await page.waitForTimeout(200);

// ---- Icing profile
ok('icing profile folded by default', await page.isVisible('#btnIcingProfile') && !(await page.isVisible('#icingProfileRows')));
await page.click('#btnIcingProfile'); await page.waitForTimeout(400);
const prof = await I(() => {
    const rows = [...document.querySelectorAll('#icingProfileRows > div')];
    const labels = rows.map(r => r.innerText.trim());
    const cellAt = (label, i) => { const r = rows.find(x => x.innerText.trim() === label); return r && r.querySelectorAll('[data-icing-cell]')[i].style.background; };
    return { labels, red950: cellAt('~380 m', 0), dry950: cellAt('~380 m', 9), red975: cellAt('~180 m', 6), red900: cellAt('~800 m', 15), open: JSON.parse(localStorage.getItem('flysky_icing_profile_open')) };
});
ok('profile: model levels by height, the flight altitude line between ~590 and ~380 m', prof.labels.join(',') === '~1240 m,~800 m,~590 m,✈ 400 m,~380 m,~180 m', prof.labels);
ok('profile: cells coloured by the worse model (layers at the expected hours and heights)', /208, 59, 59/.test(prof.red950) && /100, 116, 139/.test(prof.dry950) && /208, 59, 59/.test(prof.red975) && /208, 59, 59/.test(prof.red900) && prof.open === true, prof);
await page.locator('#icingProfileRows [data-icing-cell]').first().hover(); await page.waitForTimeout(200);
ok('profile: a cell\'s values per model', /~1240 m \(850 hPa\) · No icing signs in the forecast data · DWD ICON −10\.6 °C 60 % · UK Met Office −10\.6 °C 60 %/.test(await page.locator('#icingProfileDetail').innerText()), await page.locator('#icingProfileDetail').innerText());

// ---- Planner notes
const notes = await I(() => { const hs = processed.flight.hours; return { red: icingSlotNote(hs, { start: 0, end: 4 }), next: icingSlotNote(hs, { start: 9, end: 9 }), above: icingSlotNote(hs, { start: 15, end: 16 }), none: icingSlotNote(hs, { start: 20, end: 20 }) }; });
ok('planner: icing signs in a slot, a layer above to stay below, nothing otherwise', notes.red && notes.red.red && /^Icing signs \d\d:\d\d–\d\d:\d\d$/.test(notes.red.text) && notes.above && /^Icing layer above — no signs up to ~590 m; stay below$/.test(notes.above.text) && notes.none === null, notes);
ok('planner: icing signs the hour before the slot count (a late or early take-off)', notes.next && notes.next.red, notes);

// ---- Flight profile settings (no new request: the same data, evaluated again)
const climb2 = await I(() => icingHour(processed.flight.hours[0].time).models.icon_seamless.flight.climb.minutes.red);
await drawer(true);
const usage = await I(() => ({ text: document.getElementById('omUsage').innerText, h: omUsed(3600e3), d: omUsed(86400e3) }));
ok('side menu: this browser\'s Open-Meteo use (last hour, last 24 h) with the free limits', /^This browser's Open-Meteo use: [\d,]+ calls in the last hour, [\d,]+ in the last 24 h \(free limits per connection: 600 a minute, 5,000 an hour, 10,000 a day\)\.$/.test(usage.text) && usage.h >= 5 && usage.d === usage.h, usage);
ok('flight profile: climb, descent, duration, icing switches and thresholds', await page.inputValue('#climbRateSelect') === '2' && await page.inputValue('#descentRateSelect') === '2' && await page.inputValue('#durationSelect') === '120' && await page.isChecked('#icingToggle') && !(await page.isChecked('#icingVerdictToggle')) && await page.inputValue('#icingRhRed') === '90');
await page.selectOption('#climbRateSelect', '4'); await page.waitForTimeout(300);
await page.selectOption('#durationSelect', '30'); await page.waitForTimeout(300);
const f0 = await I(() => { const f = icingHour(processed.flight.hours[0].time).models.icon_seamless.flight; return { climb: f.climb.minutes.red, slots: f.cruise.slots.length, saved: JSON.parse(localStorage.getItem('flysky_flight_profile')) }; });
ok('climb 4 m/s, 30 min: the same data evaluated again, saved, no request', Math.abs(f0.climb - climb2 / 2) < 0.01 && f0.slots === 1 && f0.saved.climbMs === 4 && f0.saved.durationMin === 30 && reqs() === 1, f0);
await page.selectOption('#flightHeightSelect', '300'); await page.waitForTimeout(400);
ok('300 m: the same levels (no request), the row follows', reqs() === 1 && /Potential icing at 300 m/.test(await row()), await row());
await page.selectOption('#flightHeightSelect', '1500'); await page.waitForTimeout(1200);
ok('1500 m: other levels needed → one request (800 / 700 hPa in full)', reqs() === 2 && /relative_humidity_800hPa/.test(log.icingReq.at(-1)) && /relative_humidity_700hPa/.test(log.icingReq.at(-1)), log.icingReq.at(-1));
await page.selectOption('#flightHeightSelect', '400'); await page.waitForTimeout(600);
ok('back to 400 m: the earlier answer, no request', reqs() === 2 && /Potential icing at 400 m/.test(await row()));
await page.click('#icingThresholds summary'); await page.waitForTimeout(200);
await page.fill('#icingRhRed', '97'); await page.dispatchEvent('#icingRhRed', 'change'); await page.waitForTimeout(400);
ok('threshold RH 97 %: 96 % is no longer potential icing', /Marginal at 400 m/.test(await row()), await row());
await page.fill('#icingRhMarginal', '98'); await page.dispatchEvent('#icingRhMarginal', 'change'); await page.waitForTimeout(200);
ok('marginal above potential icing: refused with a note', /marginal below potential icing/.test(await page.locator('#icingThresholdsNote').innerText()) && await I(() => state.flightProfile.icingRhMarginal === 80));
await page.click('#btnResetSettings'); await page.waitForTimeout(400);
ok('reset to defaults: icing thresholds back to 90 / 80 %', await I(() => state.flightProfile.icingRhRed === 90 && state.flightProfile.icingRhMarginal === 80) && /Potential icing at 400 m/.test(await row()));
await page.selectOption('#climbRateSelect', '2'); await page.selectOption('#durationSelect', '120'); await page.waitForTimeout(300);

// ---- Indicator off / on
await page.locator('label:has(#icingToggle)').click(); await page.waitForTimeout(400);
ok('indicator off: no row, strip or profile; the verdict option greyed', !(await row()) && await I(() => document.getElementById('flightIcing').classList.contains('hidden') && document.getElementById('icingProfileSection').classList.contains('hidden') && document.getElementById('icingVerdictToggle').disabled));
await page.click('#btnSettingsClose'); await page.waitForTimeout(300);
await page.click('#btnRefresh'); await page.waitForTimeout(1500);
ok('indicator off: Refresh asks no icing data', reqs() === 2);
await drawer(true);
await page.locator('label:has(#icingToggle)').click(); await page.waitForTimeout(600);
ok('indicator on again: back from the data already read', reqs() === 2 && /Potential icing at 400 m/.test(await row()));

// ---- Include icing in the flight verdict
const before = await I(() => { const h = processed.flight.hours[0]; return { members: h.agree && h.agree.members, status: h.status, bars: document.querySelectorAll('#flightFactorBars [data-flight-bar]').length }; });
await page.locator('label:has(#icingVerdictToggle)').click(); await page.waitForTimeout(500);
await drawer(false);
const on = await I(() => { const hs = processed.flight.hours; const h = hs[0]; return { flag: !!document.querySelector('#nowMain [data-icing-flag]'), flagline: !!document.querySelector('#nowIcing [data-icing-flagline]'), members: h.agree && h.agree.members, status: h.status, check: h.checks.icing, check9: hs[9].checks.icing, reasons: h.reasons, conf: h.agree && h.agree.checkConf.icing, bars: document.querySelectorAll('#flightFactorBars [data-flight-bar]').length, limit: document.getElementById('nowMain').innerText }; });
ok('verdict option: icing red → not suitable, named as the cause', on.status === 'bad' && on.check === 'bad' && on.check9 === 'good' && on.reasons.includes('icing') && /Limited by icing/.test(on.limit), on);
ok('verdict option: the flag stays, the "not counted" line goes', on.flag && !on.flagline, on);
ok('verdict option: an Icing bar in the breakdown', on.bars === before.bars + 1 && await page.locator('#flightFactorBars [data-flight-bar="icing"]').count() === 1);
ok('verdict option: confidence from the icing models, no extra members (Ensemble)', on.members === before.members && on.conf === 1, { before, on });
await page.click('[data-mode="deterministic"]'); await page.waitForTimeout(3000);
const det2 = await I(() => { const h = processed.flight.hours[0]; return { status: h.status, members: h.agree && h.agree.members, models: h.agree && h.agree.models.map(m => m.model), check: h.checks.icing }; });
ok('verdict option in Models mode: the same; the icing models add no models (5 stay 5)', det2.status === 'bad' && det2.check === 'bad' && det2.members === 5 && det2.models.length === 5, det2);
await I(() => selectHour(3)); await page.waitForTimeout(200);
const h3 = await I(() => { const h = processed.flight.hours[3]; return { check: h.checks.icing, conf: h.agree && h.agree.checkConf.icing }; });
ok('one of two icing models red: red check, confidence 50 % on icing', h3.check === 'bad' && Math.abs(h3.conf - 0.5) < 1e-9, h3);
await page.click('[data-mode="ensemble"]'); await page.waitForTimeout(3000);
await drawer(true);
await page.locator('label:has(#icingVerdictToggle)').click(); await page.waitForTimeout(400);
await drawer(false);
ok('verdict option off again: no icing check', await I(() => !('icing' in processed.flight.hours[0].checks)));
await I(() => selectHour(0));

// ---- Freezing drizzle from low stratus: precipitation from a saturated sub-zero layer under dry air → flagged
opts.icingSfc = (m, k) => (k === 0 && m === 'ukmo_seamless' ? { precipitation: 0.2 } : icingSfcScenario(m, k));
await page.click('#btnRefresh'); await page.waitForTimeout(3000);
fl = await flag(0);
const fzdz = await I(() => icingHour(processed.flight.hours[0].time).models.ukmo_seamless.flight.cues.start.freezingPrecip);
ok('drizzle: the flag says freezing rain or drizzle (it outranks a red cruise)', fl.flag === 'freezingPrecip' && /freezing rain or drizzle in the forecast/.test(fl.line) && fzdz && fzdz.source === 'drizzle', { fl, fzdz });
opts.icingSfc = null;
await page.click('#btnRefresh'); await page.waitForTimeout(3000);
ok('back to the default scenario', (await flag(0)).flag === 'cruise');

// ---- Ukrainian
await page.selectOption('#langSelect', 'uk'); await page.waitForTimeout(600);
r = await row();
ok('Ukrainian row', /Обледеніння.*Можливе обледеніння на 400 м \(−4,0 °C, вологість 96 %\) · 2 з 2 моделей/.test(r) && /шар ~380–590 м/.test(r), r);
await page.selectOption('#langSelect', 'en'); await page.waitForTimeout(400);
ok('no page errors', !errors.filter(e => !/tailwind/.test(e)).length, errors.filter(e => !/tailwind/.test(e)));
await ctx.close();

// ---- A failing icing request: said so, the forecast unaffected; the stored copy offline
{
    const ctx2 = await b.newContext(ctxOpts);
    const p2 = await ctx2.newPage();
    const o2 = { icingFail: 'boom' };
    const { log: log2 } = await routeAll(p2, o2);
    await p2.goto(BASE_URL);
    await p2.evaluate(k => { localStorage.clear(); localStorage.setItem('flysky_last_location', JSON.stringify(k)); }, KYIV);
    await p2.reload(); await p2.waitForTimeout(5000);
    const r2 = await p2.evaluate(() => { const r = document.querySelector('[data-now-icing]'); return { row: r ? r.innerText.replace(/\s*\n\s*/g, ' ') : '', verdict: !!document.querySelector('#nowMain [data-flight-map]'), strip: document.getElementById('flightIcing').classList.contains('hidden') }; });
    ok('icing request failing: "data unavailable (boom)", the forecast still shown', /Icing.*data unavailable \(boom\)/.test(r2.row) && r2.verdict && r2.strip, r2);
    // Now it works: read and stored; after a reload with the service failing, the stored copy (under an hour old) is used without asking.
    o2.icingFail = null;
    await p2.click('#btnRefresh'); await p2.waitForTimeout(2500);
    const n = (log2.icingReq || []).length;
    o2.icingFail = 'down';
    await p2.reload(); await p2.waitForTimeout(5000);
    const r3 = await p2.evaluate(() => document.querySelector('[data-now-icing]').innerText);
    ok('stored icing data reused after a reload (no request)', (log2.icingReq || []).length === n && /Potential icing at 400 m/.test(r3), { n, after: (log2.icingReq || []).length, r3 });
    await ctx2.close();
}
await b.close();
