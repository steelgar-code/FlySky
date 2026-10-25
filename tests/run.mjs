// Runs the browser test suites against a local copy of the app.
//   node run.mjs                 all offline suites (EUMETView, Open-Meteo and CDNs are mocked)
//   node run.mjs map-readout     only the named suite(s)
//   node run.mjs --live          also live-eumetsat.mjs (needs network access to view.eumetsat.int)
import http from 'http';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const args = process.argv.slice(2);
const live = args.includes('--live');
const only = args.filter(a => !a.startsWith('--')).map(a => a.replace(/\.mjs$/, ''));
const suites = fs.readdirSync(here)
    .filter(f => f.endsWith('.mjs') && f !== 'run.mjs' && (live || f !== 'live-eumetsat.mjs'))
    .filter(f => !only.length || only.includes(f.replace(/\.mjs$/, '')))
    .sort();

// Minimal static server for the app (repo root).
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.css': 'text/css' };
const server = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file = path.join(root, p === '/' ? 'index.html' : p);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE_URL = `http://localhost:${server.address().port}/`;

let pass = 0, fail = 0;
const failed = [];
for (const suite of suites) {
    console.log(`\n=== ${suite}`);
    const out = await new Promise(resolve => {
        const child = spawn(process.execPath, [path.join(here, suite)], { env: { ...process.env, BASE_URL }, cwd: here });
        let text = '';
        child.stdout.on('data', d => { text += d; process.stdout.write(d); });
        child.stderr.on('data', d => { text += d; process.stderr.write(d); });
        child.on('close', code => resolve({ text, code }));
    });
    const p = (out.text.match(/^PASS /gm) || []).length, f = (out.text.match(/^FAIL /gm) || []).length;
    pass += p; fail += f;
    if (f || out.code) failed.push(`${suite}${out.code ? ` (exit ${out.code})` : ''}`);
}
server.close();
console.log(`\n${pass} passed, ${fail} failed${failed.length ? ` — ${failed.join(', ')}` : ''}`);
process.exit(fail || failed.length ? 1 : 0);
