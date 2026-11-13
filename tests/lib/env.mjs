// Shared test setup: browser launch and the app URL.
//   BASE_URL       app under test (run.mjs starts a local server and sets it)
//   TEST_NOW       the test time, an ISO string (run.mjs picks it: today 10:30 UTC unless set in the environment)
//   CHROMIUM_PATH  browser to use (default: Playwright's own, or /opt/pw-browsers/chromium if present)
import { chromium } from 'playwright';
import fs from 'fs';

export const BASE_URL = process.env.BASE_URL || 'http://localhost:8765/';

export function launch() {
    const path = process.env.CHROMIUM_PATH || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
    return chromium.launch(path ? { executablePath: path } : {});
}

// Prints PASS / FAIL lines; run.mjs counts them.
export const ok = (name, cond, extra) => console.log(cond ? 'PASS' : 'FAIL', name, extra !== undefined ? JSON.stringify(extra) : '');

// The test time: one moment for the whole run, then moving with real time from the start of
// this suite. The mock stamps its data with testNow(); newContext() gives every page the same clock.
const t0 = Date.now();
const base = process.env.TEST_NOW ? Date.parse(process.env.TEST_NOW) : t0;
export const testNow = () => base + (Date.now() - t0);

// browser.newContext() with the page clock set to the test time. install() fakes Date and the
// timer functions but lets the time flow in real time, so timeouts, intervals and "N min ago" still run.
export async function newContext(browser, options) {
    const ctx = await browser.newContext(options);
    await ctx.clock.install({ time: testNow() });
    return ctx;
}

// For a suite whose checks address the hours by their place in the data the mock stamps (k = hours
// from now): if the test time is less than `ms` before a full hour, wait until just after it.
export async function pastHourChange(ms = 45000) {
    const left = 3600e3 - (testNow() % 3600e3);
    if (left < ms) await new Promise(r => setTimeout(r, left + 500));
}
