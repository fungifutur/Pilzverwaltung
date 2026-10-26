const { spawn } = require('node:child_process');
const http = require('node:http');
const assert = require('node:assert/strict');

const port = 31000 + Math.floor(Math.random() * 1000);
const server = spawn(process.execPath, ['server.js'], {
  env: { ...process.env, PORT: String(port), APP_PASSWORD: 'test-password', DATABASE_URL: '', WC_STORE_URL: '', WC_CONSUMER_KEY: '', WC_CONSUMER_SECRET: '' },
  stdio: ['ignore', 'pipe', 'pipe']
});
let output = '';
server.stdout.on('data', d => output += d);
server.stderr.on('data', d => output += d);
function request(path, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method: opts.method || 'GET', headers: opts.headers || {} }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}
async function waitReady() {
  for (let i = 0; i < 50; i++) {
    if (server.exitCode !== null) throw Error('Server exited early: ' + output);
    try { await request('/'); return; } catch (_) { await new Promise(r => setTimeout(r, 100)); }
  }
  throw Error('Server did not start: ' + output);
}
(async () => {
  try {
    await waitReady();
    assert.equal(await request('/%ZZ'), 400, 'Malformed URL must return 400');
    const cookieStatus = await request('/', { headers: { Cookie: 'pilz_auth=%ZZ' } });
    assert.ok(cookieStatus >= 200 && cookieStatus < 500, 'Malformed cookie must not crash server');
    assert.equal(await request('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{kaputt' }), 400, 'Malformed JSON must return 400');
    assert.equal(await request('/'), 200, 'Server must remain alive');
    console.log('PASS: malformed URL, cookie, login JSON, and server survival');
  } finally { server.kill('SIGTERM'); }
})().catch(e => { console.error(e, output); server.kill('SIGTERM'); process.exitCode = 1; });
