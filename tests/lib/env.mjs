// Shared test setup: browser launch and the app URL.
//   BASE_URL       app under test (run.mjs starts a local server and sets it)
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
