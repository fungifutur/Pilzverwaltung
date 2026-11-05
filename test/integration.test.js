// Integrationstest gegen eine ECHTE PostgreSQL-Testdatenbank (nie die Produktion!).
//   TEST_DATABASE_URL=postgres://user@localhost:5432/pilz_test npm test
// Der Test löscht in dieser Datenbank alle app_*-Tabellen und legt sie im Format der Version 1.5.24 neu an.
// Er dient als Regressionstest für die Audit-Massnahmen M3 bis M5, M7, M9 und für die Kompatibilität mit bestehenden Daten.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const http = require('node:http');
const path = require('node:path');

const DB_URL = process.env.TEST_DATABASE_URL || '';
const skip = !DB_URL ? 'TEST_DATABASE_URL nicht gesetzt' : (/(localhost|127\.0\.0\.1|\[::1\])/.test(DB_URL) ? false : 'TEST_DATABASE_URL muss auf localhost zeigen (Schutz vor Datenverlust)');
const PORT = 3900 + Math.floor(Math.random() * 90);
const WOO_PORT = PORT + 100;
const BASE = `http://127.0.0.1:${PORT}`;
const APP_PW = 'test-app-password-0123456789';
const RESCUE_PW = 'test-rescue-password-0123456789';
const WH_SECRET = 'whsec-test';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36';

class Browser {
  constructor(ip) { this.ip = ip; this.cookies = {}; }
  async req(method, url, { body, headers = {}, raw } = {}) {
    const h = { 'user-agent': UA, 'x-forwarded-for': this.ip, ...headers };
    const cookie = Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) h.cookie = cookie;
    if (body !== undefined && !raw) h['content-type'] = 'application/json';
    const res = await fetch(BASE + url, { method, headers: h, body: raw !== undefined ? raw : (body !== undefined ? JSON.stringify(body) : undefined) });
    for (const sc of res.headers.getSetCookie()) { const [kv] = sc.split(';'); const i = kv.indexOf('='); this.cookies[kv.slice(0, i)] = kv.slice(i + 1); }
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch (_) { /* kein JSON */ }
    return { status: res.status, json, text, headers: res.headers };
  }
  async login(pw = APP_PW) { return this.req('POST', '/api/login', { body: { password: pw } }); }
}
function sign(body) { return crypto.createHmac('sha256', WH_SECRET).update(body).digest('base64'); }
async function webhook(order, topic = 'order.updated', { badSignature = false } = {}) {
  const raw = typeof order === 'string' ? order : JSON.stringify(order);
  return fetch(`${BASE}/api/woo/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-wc-webhook-signature': badSignature ? 'AAAA' : sign(raw), 'x-wc-webhook-topic': topic }, body: raw });
}
const wooOrder = (id, status, items = [{ id: id * 10, name: 'Körnerbrut', sku: 'KB_TEST', quantity: 1, product_id: 1, variation_id: 0, total: '10' }], extra = {}) => ({
  id, number: String(id), status, date_created: '2026-10-30T10:00:00', date_modified: '2026-10-30T10:00:00',
  billing: { first_name: 'Anna', last_name: 'Muster', address_1: 'Geheimweg 1', email: 'anna@example.com', phone: '0791234567' },
  shipping: { first_name: 'Anna', last_name: 'Muster', address_1: 'Geheimweg 1', city: 'Bern' },
  payment_method_title: 'Twint', shipping_lines: [], customer_note: '', line_items: items, ...extra
});
const until = async (fn, ms = 8000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('Zeitüberschreitung'); await new Promise(r => setTimeout(r, 100)); } };

describe('Pilzverwaltung 1.5.32 gegen PostgreSQL', { skip }, () => {
  let server, serverLog = '', pg, db, wooServer, wooStock = {}, wooFail = false, wooOrdersProcessing = [];
  const A = new Browser('10.0.0.1');      // Hauptgerät
  const B = new Browser('10.0.0.2');      // zweites Gerät

  async function startServer() {
    server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: { ...process.env, PORT: String(PORT), DATABASE_URL: DB_URL, PGSSLMODE: 'disable', APP_PASSWORD: APP_PW, RESCUE_PASSWORD: RESCUE_PW, WC_WEBHOOK_SECRET: WH_SECRET,
        WC_STORE_URL: `http://127.0.0.1:${WOO_PORT}`, WC_CONSUMER_KEY: 'ck', WC_CONSUMER_SECRET: 'cs' }
    });
    server.stdout.on('data', d => { serverLog += d; }); server.stderr.on('data', d => { serverLog += d; });
    await until(async () => { try { return (await fetch(BASE + '/api/health')).ok; } catch (_) { return false; } }, 15000);
  }

  before(async () => {
    ({ Pool: pg } = require('pg'));
    db = new pg({ connectionString: DB_URL });
    // Bestehende Datenbank im Format der Version 1.5.24 nachbauen (nur die vier alten Tabellen).
    await db.query('DROP TABLE IF EXISTS app_state, app_backups, app_settings, app_devices, app_sessions, app_webhook_queue');
    await db.query(`CREATE TABLE app_state (id INTEGER PRIMARY KEY CHECK (id = 1), data JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await db.query(`CREATE TABLE app_backups (id BIGSERIAL PRIMARY KEY, data JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), backup_kind TEXT NOT NULL DEFAULT 'change')`);
    await db.query(`CREATE TABLE app_settings (key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await db.query(`CREATE TABLE app_devices (id BIGSERIAL PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, name TEXT NOT NULL DEFAULT '', approved BOOLEAN NOT NULL DEFAULT false, first_seen TIMESTAMPTZ NOT NULL DEFAULT now(), last_seen TIMESTAMPTZ NOT NULL DEFAULT now(), user_agent TEXT NOT NULL DEFAULT '', last_ip TEXT NOT NULL DEFAULT '')`);
    const old = new Date(Date.now() - 30 * 86400000).toISOString();
    const seed = {
      dk: [], petri: [], lc: [], mix: [], sub: [], harv: [], buckets: [], lots: [], logs: [], archive: [{ id: 'A1', note: 'Altdaten' }], minStocks: [], testGroups: [], masterCultures: [], storageLocations: [], stockTransactions: [], productionRequests: [], personalTasks: [{ id: 'T1', title: 'Alt', done: false }], personalTaskCategories: [], masterCounters: { kb: 4 }, wooSyncLog: [],
      kb: [{ id: 'KB-2026-0001', sku: 'KB_TEST', status: 'im Kühlschrank', date: '2026-10-01', strain: 'Test' }, { id: 'KB-2026-0002', sku: 'KB_TEST', status: 'im Kühlschrank', date: '2026-10-02', strain: 'Test' }],
      goods: [], productCatalog: [{ id: 'C1', sku: 'KB_TEST', name: 'Körnerbrut', area: 'kb', stockMode: 'batch', qty: 0, active: true, syncActive: false }, { id: 'C2', sku: 'SIMPLE_1', name: 'Simpel', area: 'goods', stockMode: 'simple', qty: 5, active: true, syncActive: true }],
      wooOrders: [{ id: 777, number: '777', status: 'processing', date_created: '2026-10-01T10:00:00', customer: 'Alt Kunde', billing: { first_name: 'Alt', last_name: 'Kunde', address_1: 'Alte Strasse 1', email: 'alt@example.com' }, shipping: { first_name: 'Alt', last_name: 'Kunde', city: 'Zürich' }, items: [], archived: false }],
      wooReservations: [{ id: 'WR-old-1', orderId: 1, status: 'replaced', releasedAt: old, createdAt: old, qty: 1 }, { id: 'WR-new-1', orderId: 1, status: 'replaced', releasedAt: new Date().toISOString(), qty: 1 }]
    };
    await db.query('INSERT INTO app_state(id,data) VALUES(1,$1)', [seed]);
    await db.query(`INSERT INTO app_backups(data, backup_kind) VALUES($1,'daily')`, [seed]);
    // Attrappe für WooCommerce
    wooServer = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x'); res.setHeader('content-type', 'application/json');
      if (wooFail) { res.statusCode = 500; return res.end(JSON.stringify({ message: 'kaputt' })); }
      const sku = u.searchParams.get('sku');
      if (u.pathname.endsWith('/orders') && req.method === 'GET') { const st = u.searchParams.get('status'); return res.end(JSON.stringify(st === 'processing' && u.searchParams.get('page') === '1' ? wooOrdersProcessing : [])); }
      if (u.pathname.match(/\/orders\/\d+$/)) { const id = Number(u.pathname.split('/').pop()); const o = wooOrdersProcessing.find(x => x.id === id); if (o) return res.end(JSON.stringify(o)); res.statusCode = 404; return res.end(JSON.stringify({ code: 'woocommerce_rest_shop_order_invalid_id', message: 'Ungültige ID.' })); }
      if (req.method === 'GET' && u.pathname.endsWith('/products') && sku) return res.end(JSON.stringify(sku === 'UNKNOWN' ? [{ id: 99, sku: 'ANDERE_SKU', manage_stock: true }] : [{ id: 1, sku, manage_stock: true, stock_quantity: wooStock[sku] ?? 0, type: 'simple' }]));
      if (u.pathname.match(/\/products\/\d+$/)) {
        if (req.method === 'PUT') { let b = ''; req.on('data', c => b += c); req.on('end', () => { const p = JSON.parse(b); wooStock.last = p.stock_quantity; wooStock.SIMPLE_1 = p.stock_quantity; res.end(JSON.stringify({ id: 1, sku: 'SIMPLE_1', manage_stock: true, stock_quantity: p.stock_quantity, type: 'simple' })); }); return; }
        return res.end(JSON.stringify({ id: 1, sku: 'SIMPLE_1', manage_stock: true, stock_quantity: wooStock.SIMPLE_1 ?? 0, type: 'simple' }));
      }
      res.end('[]');
    });
    await new Promise(r => wooServer.listen(WOO_PORT, '127.0.0.1', r));
    await startServer();
  });
  after(async () => { server?.kill('SIGTERM'); wooServer?.close(); await db?.end?.(); });

  it('startet mit einer Datenbank im alten Format und ergänzt nur neue Tabellen', async () => {
    const t = await db.query(`SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'app\\_%' ORDER BY 1`);
    const names = t.rows.map(r => r.table_name);
    for (const n of ['app_state', 'app_backups', 'app_settings', 'app_devices', 'app_sessions', 'app_webhook_queue']) assert.ok(names.includes(n), n);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM app_backups WHERE backup_kind=$1', ['daily'])).rows[0].n, 1, 'alte Backups bleiben');
  });

  it('Sicherheits-Header sind gesetzt und der Health-Check ist öffentlich', async () => {
    const r = await A.req('GET', '/api/health');
    assert.equal(r.status, 200); assert.equal(r.json.ok, true);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    const p = await A.req('GET', '/');
    assert.equal(p.status, 200); assert.match(p.text, /Pilzverwaltung/);
    assert.ok(p.headers.get('content-security-policy'));
  });

  it('SEC-01: fehlerhafte Anfragen beenden den Server nicht mehr', async () => {
    assert.equal((await A.req('POST', '/api/login', { raw: '{kaputt' })).status, 400);
    assert.ok([400, 404].includes((await A.req('GET', '/%E0%A4%A')).status));
    assert.equal((await A.req('GET', '/api/health', { headers: { cookie: 'pilz_auth=%E0%A4%A' } })).status, 200);
    assert.equal((await A.req('GET', '/api/data', { headers: { cookie: 'pilz_device=%E0%A4%A; pilz_auth=%zz' } })).status, 401);
    assert.ok([403, 404].includes((await A.req('GET', '/..%2f..%2fserver.js')).status));
    assert.ok(!(await A.req('GET', '/..%2fserver.js')).text.includes('handleApi'));
    assert.equal((await A.req('GET', '/api/health')).status, 200, 'Server lebt noch');
  });

  it('Ohne Anmeldung kein Zugriff und keine Geräteeinträge (SEC-07)', async () => {
    assert.equal((await B.req('GET', '/api/data')).status, 401);
    assert.equal((await B.req('GET', '/api/qr?data=abc')).status, 401);
    assert.equal((await B.req('GET', '/api/device-self')).status, 200);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM app_devices')).rows[0].n, 0);
  });

  it('SEC-02: Durchprobieren wird gesperrt, richtiges Passwort funktioniert vorher', async () => {
    const C = new Browser('10.0.0.99');
    for (let i = 0; i < 5; i++) assert.equal((await C.login('falsch' + i)).status, 401);
    const locked = await C.login(APP_PW);
    assert.equal(locked.status, 429); assert.ok(Number(locked.headers.get('retry-after')) > 0);
  });

  it('Anmeldung: erstes Gerät wird freigegeben, bestehende Daten sind vollständig lesbar', async () => {
    const l = await A.login();
    assert.equal(l.status, 200, l.text);
    assert.match(A.cookies.pilz_auth, /^[A-Za-z0-9_-]{40,}$/);
    const d = await A.req('GET', '/api/data');
    assert.equal(d.status, 200);
    assert.ok(d.headers.get('x-data-version'));
    assert.equal(d.json.kb.length, 2); assert.equal(d.json.archive[0].note, 'Altdaten'); assert.equal(d.json.masterCounters.kb, 4);
    assert.equal(d.json.personalTasks[0].title, 'Alt');
  });

  it('Zweites Gerät braucht Freigabe; Freigabe nur mit Admin-Passwort', async () => {
    const l = await B.login();
    assert.equal(l.status, 403); assert.equal(l.json.code, 'DEVICE_NOT_APPROVED'); assert.ok(l.json.deviceId);
    assert.equal((await B.login()).json.deviceId, l.json.deviceId, 'kein zweiter Geräteeintrag');
    assert.equal((await A.req('POST', '/api/devices', { body: { id: l.json.deviceId, approved: true } })).status, 401);
    const ok = await A.req('POST', '/api/devices', { body: { id: l.json.deviceId, approved: true }, headers: { authorization: 'Bearer ' + APP_PW } });
    assert.equal(ok.status, 200);
    assert.equal((await B.login()).status, 200);
  });

  let version;
  it('INT-01/INT-03: Speichern nur auf aktuellem Stand (409 bei veraltetem Stand)', async () => {
    const a = await A.req('GET', '/api/data'); version = a.headers.get('x-data-version');
    const noVersion = await A.req('POST', '/api/data', { body: a.json });
    assert.equal(noVersion.status, 409); assert.equal(noVersion.json.code, 'STALE_DATA');
    const doc = a.json; doc.archive.push({ id: 'A2', note: 'von A' });
    const saved = await A.req('POST', '/api/data', { body: doc, headers: { 'x-data-version': version } });
    assert.equal(saved.status, 200, saved.text);
    assert.notEqual(saved.json.version, version); assert.equal(saved.json.prevVersion, version);
    // Gerät B hat noch den alten Stand
    const staleDoc = JSON.parse(JSON.stringify(a.json)); staleDoc.archive.push({ id: 'A3', note: 'von B' });
    const stale = await B.req('POST', '/api/data', { body: staleDoc, headers: { 'x-data-version': version } });
    assert.equal(stale.status, 409);
    const now = await B.req('GET', '/api/data');
    assert.deepEqual(now.json.archive.map(x => x.id), ['A1', 'A2']);
    version = now.headers.get('x-data-version');
  });

  it('INT-09/DSG-01: alte Reservierungen und Kundendaten werden beim Speichern bereinigt', async () => {
    const r = (await db.query('SELECT data FROM app_state')).rows[0].data;
    assert.ok(!r.wooReservations.some(x => x.id === 'WR-old-1'), 'alter replaced-Datensatz entfernt');
    assert.ok(r.wooReservations.some(x => x.id === 'WR-new-1'), 'junger replaced-Datensatz bleibt');
    const o = r.wooOrders.find(x => x.id === 777);
    assert.deepEqual(o.billing, { first_name: 'Alt', last_name: 'Kunde' });
    assert.deepEqual(o.shipping, { first_name: 'Alt', last_name: 'Kunde' });
    assert.equal(o.customer, 'Alt Kunde');
  });

  it('SEC-06: Massenlöschen braucht das Admin-Passwort', async () => {
    const a = await A.req('GET', '/api/data'); version = a.headers.get('x-data-version');
    const big = a.json; big.dk = Array.from({ length: 12 }, (_, i) => ({ id: 'DK-' + i, status: 'fertig durchwachsen' }));
    const s1 = await A.req('POST', '/api/data', { body: big, headers: { 'x-data-version': version } });
    assert.equal(s1.status, 200); version = s1.json.version;
    const wipe = JSON.parse(JSON.stringify(big)); wipe.dk = [];
    const denied = await A.req('POST', '/api/data', { body: wipe, headers: { 'x-data-version': version } });
    assert.equal(denied.status, 403); assert.equal(denied.json.code, 'ADMIN_CONFIRM_REQUIRED');
    assert.equal((await db.query('SELECT jsonb_array_length(data->\'dk\') AS n FROM app_state')).rows[0].n, 12);
    const allowed = await A.req('POST', '/api/data', { body: wipe, headers: { 'x-data-version': version, authorization: 'Bearer ' + APP_PW } });
    assert.equal(allowed.status, 200); version = allowed.json.version;
  });

  it('Speichern zuerst, dann WooCommerce: Bestand wird gemeldet, Protokoll gespeichert; Fehler gehen nicht verloren (INT-05)', async () => {
    const a = await A.req('GET', '/api/data'); version = a.headers.get('x-data-version');
    const doc = a.json; doc.productCatalog.find(p => p.sku === 'SIMPLE_1').qty = 7;
    const ok = await A.req('POST', '/api/data', { body: doc, headers: { 'x-data-version': version } });
    assert.equal(ok.status, 200); version = ok.json.version;
    assert.equal(wooStock.SIMPLE_1, 7);
    assert.ok(ok.json.wooSyncLog.some(e => e.sku === 'SIMPLE_1' && e.status === 'ok'));
    assert.ok((await db.query(`SELECT data->'wooSyncLog' AS l FROM app_state`)).rows[0].l.some(e => e.sku === 'SIMPLE_1' && e.status === 'ok'), 'Protokoll in Datenbank');
    wooFail = true;
    const doc2 = JSON.parse(JSON.stringify(ok.json && doc)); doc2.productCatalog.find(p => p.sku === 'SIMPLE_1').qty = 3;
    const fail = await A.req('POST', '/api/data', { body: doc2, headers: { 'x-data-version': version } });
    wooFail = false;
    assert.equal(fail.status, 200, 'Speichern gelingt auch wenn WooCommerce ausfällt');
    version = fail.json.version;
    assert.equal((await db.query(`SELECT (data->'productCatalog'->1->>'qty') AS q FROM app_state`)).rows[0].q, '3');
    assert.ok(fail.json.wooSyncLog.some(e => e.sku === 'SIMPLE_1' && e.status === 'pending'));
  });

  it('INT-02: gleichzeitige Webhooks verlieren keine Bestellung', async () => {
    const ids = Array.from({ length: 10 }, (_, i) => 5000 + i);
    const results = await Promise.all(ids.map(id => webhook(wooOrder(id, 'processing', [{ id: id * 10, name: 'X', sku: 'NIX_' + id, quantity: 1, product_id: 0, variation_id: 0, total: '1' }]), 'order.created')));
    assert.ok(results.every(r => r.status === 200));
    await until(async () => (await db.query(`SELECT count(*)::int AS n FROM app_webhook_queue WHERE status='done'`)).rows[0].n >= 10);
    const orders = (await db.query(`SELECT data->'wooOrders' AS o FROM app_state`)).rows[0].o.map(o => o.id);
    for (const id of ids) assert.ok(orders.includes(id), 'Bestellung ' + id);
  });

  it('Webhook: Signatur, Ping, Topic und Form werden geprüft (WOO-01)', async () => {
    assert.equal((await webhook(wooOrder(6001, 'processing'), 'order.created', { badSignature: true })).status, 401);
    const ping = await fetch(`${BASE}/api/woo/webhook`, { method: 'POST', body: 'webhook_id=1' });
    assert.equal(ping.status, 200);
    const signedPing = await webhook('webhook_id=1', 'action.woocommerce_ping');
    assert.equal(signedPing.status, 200); assert.equal((await signedPing.json()).ignored, true);
    const product = await webhook({ id: 55, name: 'Produkt', status: 'publish' }, 'product.updated');
    assert.equal((await product.json()).ignored, true);
    const before = (await db.query(`SELECT count(*)::int AS n FROM app_webhook_queue`)).rows[0].n;
    await webhook(wooOrder(6002, 'processing'), 'product.updated');
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM app_webhook_queue`)).rows[0].n, before, 'Produkt-Webhook nicht eingereiht');
  });

  it('INT-01: Webhook ändert nur Bestellungen → Browser darf weiter speichern; Ausbuchung → Browser muss neu laden', async () => {
    const a = await A.req('GET', '/api/data'); version = a.headers.get('x-data-version');
    await webhook(wooOrder(7001, 'processing', [{ id: 70010, name: 'K', sku: 'NIX', quantity: 1, product_id: 0, variation_id: 0, total: '1' }]), 'order.created');
    await until(async () => (await db.query(`SELECT 1 FROM app_state WHERE data->'wooOrders' @> '[{"id":7001}]'`)).rows.length);
    const same = await A.req('GET', '/api/data');
    assert.equal(same.headers.get('x-data-version'), version, 'Version unverändert, da nur Bestellungen betroffen');
    // Bestellung mit Körnerbrut reservieren, dann abschliessen → Charge wird als verkauft ausgebucht
    await webhook(wooOrder(7002, 'processing'), 'order.created');
    await until(async () => (await db.query(`SELECT 1 FROM app_state WHERE data->'wooReservations' @> '[{"orderId":7002,"status":"reserved"}]'`)).rows.length);
    const upd = JSON.parse(JSON.stringify(wooOrder(7002, 'completed'))); upd.date_modified = '2026-10-31T10:00:00';
    await webhook(upd, 'order.updated');
    await until(async () => (await db.query(`SELECT 1 FROM app_state WHERE data->'kb' @> '[{"status":"verkauft"}]'`)).rows.length);
    const stale = await A.req('POST', '/api/data', { body: a.json, headers: { 'x-data-version': version } });
    assert.equal(stale.status, 409, 'Browser mit altem Stand würde die verkaufte Charge sonst wieder verfügbar machen');
    const fresh = await A.req('GET', '/api/data');
    assert.equal(fresh.json.kb.filter(k => k.status === 'verkauft').length, 1);
  });

  it('Veraltete Webhook-Ereignisse setzen einen neueren Stand nicht zurück', async () => {
    const older = wooOrder(7002, 'processing'); older.date_modified = '2026-10-29T10:00:00';
    await webhook(older, 'order.updated');
    await until(async () => (await db.query(`SELECT count(*)::int AS n FROM app_webhook_queue WHERE status='pending'`)).rows[0].n === 0);
    const o = (await db.query(`SELECT data->'wooOrders' AS o FROM app_state`)).rows[0].o.find(x => x.id === 7002);
    assert.equal(o.status, 'completed');
  });

  it('DSG-01: neue Bestellungen speichern keine Adresse, E-Mail oder Telefonnummer', async () => {
    const o = (await db.query(`SELECT data->'wooOrders' AS o FROM app_state`)).rows[0].o.find(x => x.id === 7001);
    assert.deepEqual(o.billing, { first_name: 'Anna', last_name: 'Muster' });
    assert.deepEqual(o.shipping, { first_name: 'Anna', last_name: 'Muster' });
    assert.equal(o.customer, 'Anna Muster');
  });

  it('INT-05: fehlerhafte Webhooks werden wiederholt, nicht verworfen', async () => {
    const bad = wooOrder(8001, 'processing', [null]);   // löst beim Verarbeiten einen Fehler aus
    assert.equal((await webhook(bad, 'order.created')).status, 200, 'WooCommerce erhält trotzdem 200');
    const row = await until(async () => { const q = await db.query(`SELECT attempts, status, last_error, next_attempt_at > now() AS later FROM app_webhook_queue WHERE order_id='8001'`); return q.rows[0]?.attempts >= 1 ? q.rows[0] : null; });
    assert.equal(row.status, 'pending'); assert.equal(row.later, true); assert.ok(row.last_error);
    const h = await A.req('GET', '/api/health?strict=1');
    assert.equal(h.status, 200, 'ein einzelner Wiederholungsversuch ist noch kein Alarm');
    await db.query(`UPDATE app_webhook_queue SET attempts=9 WHERE order_id='8001'`);
    await db.query(`UPDATE app_webhook_queue SET next_attempt_at=now() WHERE order_id='8001'`);
    await until(async () => (await db.query(`SELECT status FROM app_webhook_queue WHERE order_id='8001'`)).rows[0].status === 'failed', 20000);
    assert.equal((await A.req('GET', '/api/health?strict=1')).status, 503, 'endgültig fehlgeschlagen → Uptime-Monitor schlägt an');
    await db.query(`DELETE FROM app_webhook_queue WHERE order_id='8001'`);
  });

  it('INT-06: kein falsches Produkt bei unbekannter SKU', async () => {
    const r = await A.req('POST', '/api/woo/lookup', { body: { skus: ['UNKNOWN'] } });
    assert.equal(r.json.products[0].found, false);
  });

  it('SEC-06: Backup einspielen nur mit Admin-Passwort; Rückgängig wird bei Shop-Änderung gesperrt', async () => {
    const list = await A.req('GET', '/api/backups');
    const daily = list.json.backups.find(b => b.kind === 'daily');
    assert.equal((await A.req('POST', '/api/restore', { body: { id: daily.id } })).status, 401);
    // letzter Schreibvorgang war der Webhook (server_limited) → Rückgängig verweigert
    const undo = await A.req('POST', '/api/undo-last');
    assert.equal(undo.status, 409);
    const a = await A.req('GET', '/api/data'); const doc = a.json; doc.archive.push({ id: 'A9' });
    const s = await A.req('POST', '/api/data', { body: doc, headers: { 'x-data-version': a.headers.get('x-data-version') } });
    assert.equal(s.status, 200);
    const undo2 = await A.req('POST', '/api/undo-last');
    assert.equal(undo2.status, 200, undo2.text);
    assert.ok(!(await A.req('GET', '/api/data')).json.archive.some(x => x.id === 'A9'));
    const restored = await A.req('POST', '/api/restore', { body: { id: daily.id }, headers: { authorization: 'Bearer ' + APP_PW } });
    assert.equal(restored.status, 200, restored.text);
    assert.equal((await A.req('GET', '/api/data')).json.archive.length, 1, 'Stand des Backups');
    assert.ok((await db.query(`SELECT 1 FROM app_backups WHERE backup_kind='undo'`)).rows.length >= 1, 'Vorheriger Stand als undo-Backup gesichert');
  });

  it('Abgleich mit WooCommerce: importiert neue Bestellungen, erkennt gelöschte, überschreibt keine Bemerkungen (WOO-02)', async () => {
    const item = id => [{ id: id * 10, name: 'X', sku: 'NIX', quantity: 1, product_id: 0, variation_id: 0, total: '1' }];
    await webhook(wooOrder(7101, 'processing', item(7101)), 'order.created');   // bereits bekannte Bestellung
    await until(async () => (await db.query(`SELECT 1 FROM app_state WHERE data->'wooOrders' @> '[{"id":7101}]'`)).rows.length);
    assert.equal((await A.req('POST', '/api/woo/order-internal-note', { body: { id: 7101, note: 'Meine Notiz' } })).status, 200);
    wooOrdersProcessing = [wooOrder(9001, 'processing', item(9001)), { ...wooOrder(7101, 'processing', item(7101)), date_modified: '2026-11-01T10:00:00' }];
    const r = await A.req('POST', '/api/woo/reconcile-orders?progressId=t1', { body: {} });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.summary.imported, 1);
    const ids = r.json.orders.map(o => o.id);
    assert.ok(ids.includes(9001));
    const known = r.json.orders.find(o => o.id === 7101);
    assert.equal(known.internal_note, 'Meine Notiz'); assert.equal(known.date_modified, '2026-11-01T10:00:00');
    assert.equal(r.json.orders.find(o => o.id === 777).externalDeleted, true, 'in WooCommerce nicht mehr vorhanden');
    assert.equal((await A.req('GET', '/api/woo/reconcile-progress?id=t1')).json.done, true);
    wooOrdersProcessing = [];
  });

  it('Vorauskasse (on-hold) reserviert; Storno gibt frei; bezahlte Bestellungen haben Vorrang', async () => {
    const kbItem = (id, q) => [{ id: id * 10, name: 'Körnerbrut', sku: 'KB_TEST', quantity: q, product_id: 1, variation_id: 0, total: '10' }];
    const reserved = async id => Number((await db.query(`SELECT COALESCE(sum((r->>'qty')::int),0) AS n FROM app_state, jsonb_array_elements(data->'wooReservations') r WHERE (r->>'orderId')::int=$1 AND r->>'status'='reserved'`, [id])).rows[0].n);
    const settled = async () => until(async () => (await db.query(`SELECT count(*)::int AS n FROM app_webhook_queue WHERE status='pending'`)).rows[0].n === 0);
    // 1) wartende Bestellung reserviert sofort
    await webhook(wooOrder(9101, 'on-hold', kbItem(9101, 1)), 'order.created'); await settled();
    assert.equal(await reserved(9101), 1, 'on-hold reserviert');
    // 2) Storno gibt wieder frei
    await webhook({ ...wooOrder(9101, 'cancelled', kbItem(9101, 1)), date_modified: '2026-10-31T12:00:00' }, 'order.updated'); await settled();
    assert.equal(await reserved(9101), 0, 'Storno gibt frei');
    // 3) Älterer wartender Auftrag über den ganzen Bestand, jüngerer bezahlter Auftrag: bezahlt wird zuerst bedient
    await webhook(wooOrder(9102, 'on-hold', kbItem(9102, 2), { date_created: '2026-10-01T09:00:00' }), 'order.created'); await settled();
    assert.equal(await reserved(9102), 2);
    await webhook(wooOrder(9103, 'processing', kbItem(9103, 1), { date_created: '2026-10-05T09:00:00' }), 'order.created'); await settled();
    const a = await A.req('GET', '/api/data');
    const save = await A.req('POST', '/api/data', { body: a.json, headers: { 'x-data-version': a.headers.get('x-data-version') } });
    assert.equal(save.status, 200);
    assert.equal(await reserved(9103), 1, 'bezahlte Bestellung bekommt ihre Ware');
    assert.equal(await reserved(9102), 1, 'wartende Bestellung erhält nur den Rest');
    // 4) Zahlung geht ein: on-hold → processing behält die Reservierung
    await webhook({ ...wooOrder(9102, 'processing', kbItem(9102, 2), { date_created: '2026-10-01T09:00:00' }), date_modified: '2026-10-31T13:00:00' }, 'order.updated'); await settled();
    assert.equal(await reserved(9103) + await reserved(9102), 2);
  });

  it('INT-10 (b): Menge 0 zählt nicht als 1 (kein Phantom-Bestand), fehlende Menge schon', async () => {
    const reserved = async id => Number((await db.query(`SELECT COALESCE(sum((r->>'qty')::int),0) AS n FROM app_state, jsonb_array_elements(data->'wooReservations') r WHERE (r->>'orderId')::int=$1 AND r->>'status'='reserved'`, [id])).rows[0].n);
    const settled = async () => until(async () => (await db.query(`SELECT count(*)::int AS n FROM app_webhook_queue WHERE status='pending'`)).rows[0].n === 0);
    const a = await A.req('GET', '/api/data'); const doc = a.json;
    doc.lots = (doc.lots || []).concat([
      { id: 'LOT-Z0', sku: 'ZERO_TEST', product: 'Null', qty: 0, status: 'lagernd', packDate: '2026-01-01' },
      { id: 'LOT-Z1', sku: 'ONE_TEST', product: 'Eins', qty: 1, status: 'lagernd', packDate: '2026-01-01' },
      { id: 'LOT-ZM', sku: 'MISSING_TEST', product: 'Ohne Menge', status: 'lagernd', packDate: '2026-01-01' }]);
    const save = await A.req('POST', '/api/data', { body: doc, headers: { 'x-data-version': a.headers.get('x-data-version') } });
    assert.equal(save.status, 200);
    const item = (id, sku) => [{ id: id * 10, name: 'Test', sku, quantity: 1, product_id: 1, variation_id: 0, total: '10' }];
    await webhook(wooOrder(9201, 'processing', item(9201, 'ZERO_TEST')), 'order.created');
    await webhook(wooOrder(9202, 'processing', item(9202, 'ONE_TEST')), 'order.created');
    await webhook(wooOrder(9203, 'processing', item(9203, 'MISSING_TEST')), 'order.created'); await settled();
    assert.equal(await reserved(9201), 0, 'Charge mit Menge 0 ist kein Bestand');
    assert.equal(await reserved(9202), 1, 'Charge mit Menge 1 wird reserviert');
    assert.equal(await reserved(9203), 1, 'Charge ohne Mengenangabe zählt wie bisher als 1');
  });

  it('INT-07: zwei Positionen derselben Ware in einer Bestellung reservieren nicht dieselbe Charge doppelt', async () => {
    const settled = async () => until(async () => (await db.query(`SELECT count(*)::int AS n FROM app_webhook_queue WHERE status='pending'`)).rows[0].n === 0);
    const a = await A.req('GET', '/api/data'); const doc = a.json;
    doc.kb = (doc.kb || []).concat([1, 2, 3].map(n => ({ id: 'KB-DUP-' + n, sku: 'DUP_TEST', strain: 'Dup', status: 'im Kühlschrank', date: '2026-01-0' + n })));
    const save = await A.req('POST', '/api/data', { body: doc, headers: { 'x-data-version': a.headers.get('x-data-version') } });
    assert.equal(save.status, 200);
    const items = [{ id: 93011, name: 'Test', sku: 'DUP_TEST', quantity: 1, product_id: 1, variation_id: 0, total: '10' }, { id: 93012, name: 'Test', sku: 'DUP_TEST', quantity: 1, product_id: 1, variation_id: 0, total: '10' }];
    await webhook(wooOrder(9301, 'processing', items), 'order.created'); await settled();
    const rows = (await db.query(`SELECT r->>'batchId' AS b, sum((r->>'qty')::int) AS q FROM app_state, jsonb_array_elements(data->'wooReservations') r WHERE (r->>'orderId')::int=9301 AND r->>'status'='reserved' GROUP BY 1`)).rows;
    assert.equal(rows.reduce((n, r) => n + Number(r.q), 0), 2, 'beide Positionen sind reserviert');
    assert.ok(rows.every(r => Number(r.q) <= 1), 'keine Charge (Menge 1) ist doppelt reserviert: ' + JSON.stringify(rows));
    assert.equal(rows.length, 2, 'zwei verschiedene Chargen');
  });

  it('INT-07: angebrochene 1000er-Dübel zählen nicht als Bestand (wie in der Oberfläche)', async () => {
    const reserved = async id => Number((await db.query(`SELECT COALESCE(sum((r->>'qty')::int),0) AS n FROM app_state, jsonb_array_elements(data->'wooReservations') r WHERE (r->>'orderId')::int=$1 AND r->>'status'='reserved'`, [id])).rows[0].n);
    const settled = async () => until(async () => (await db.query(`SELECT count(*)::int AS n FROM app_webhook_queue WHERE status='pending'`)).rows[0].n === 0);
    const a = await A.req('GET', '/api/data'); const doc = a.json;
    doc.goods = (doc.goods || []).concat([
      { id: 'DUE-T-OPEN', type: 'Dübel', sku: 'D1000_OPEN', size: '1000 Stück', qty: 1, status: 'fertig durchwachsen', anbruch: true, date: '2026-01-01' },
      { id: 'DUE-T-FULL', type: 'Dübel', sku: 'D1000_FULL', size: '1000 Stück', qty: 1, status: 'fertig durchwachsen', date: '2026-01-01' }]);
    const save = await A.req('POST', '/api/data', { body: doc, headers: { 'x-data-version': a.headers.get('x-data-version') } });
    assert.equal(save.status, 200);
    const item = (id, sku) => [{ id: id * 10, name: 'Test', sku, quantity: 1, product_id: 1, variation_id: 0, total: '10' }];
    await webhook(wooOrder(9302, 'processing', item(9302, 'D1000_OPEN')), 'order.created');
    await webhook(wooOrder(9303, 'processing', item(9303, 'D1000_FULL')), 'order.created'); await settled();
    assert.equal(await reserved(9302), 0, 'angebrochenes Paket ist kein Bestand');
    assert.equal(await reserved(9303), 1, 'volles Paket wird reserviert');
  });

  it('INT-07: angebrochene Körnerbrut ist nicht verkäuflich', async () => {
    const reserved = async id => Number((await db.query(`SELECT COALESCE(sum((r->>'qty')::int),0) AS n FROM app_state, jsonb_array_elements(data->'wooReservations') r WHERE (r->>'orderId')::int=$1 AND r->>'status'='reserved'`, [id])).rows[0].n);
    const settled = async () => until(async () => (await db.query(`SELECT count(*)::int AS n FROM app_webhook_queue WHERE status='pending'`)).rows[0].n === 0);
    const a = await A.req('GET', '/api/data'); const doc = a.json;
    doc.kb = (doc.kb || []).concat([
      { id: 'KB-T-OPEN', sku: 'KB_OPEN', status: 'im Kühlschrank', anbruch: true, date: '2026-01-01', strain: 'Test' },
      { id: 'KB-T-FULL', sku: 'KB_FULL', status: 'im Kühlschrank', date: '2026-01-01', strain: 'Test' }]);
    const save = await A.req('POST', '/api/data', { body: doc, headers: { 'x-data-version': a.headers.get('x-data-version') } });
    assert.equal(save.status, 200);
    const item = (id, sku) => [{ id: id * 10, name: 'Test', sku, quantity: 1, product_id: 1, variation_id: 0, total: '10' }];
    await webhook(wooOrder(9304, 'processing', item(9304, 'KB_OPEN')), 'order.created');
    await webhook(wooOrder(9305, 'processing', item(9305, 'KB_FULL')), 'order.created'); await settled();
    assert.equal(await reserved(9304), 0, 'angebrochene Körnerbrut ist kein Bestand');
    assert.equal(await reserved(9305), 1, 'volle Körnerbrut wird reserviert');
  });

  it('INT-07: Der Server rechnet den Bestand; WooCommerce bekommt nie die Zahl des Browsers', async () => {
    const a = await A.req('GET', '/api/data'); const doc = a.json;
    doc.kb = (doc.kb || []).concat([
      { id: 'KB-T-S1', sku: 'KB_SYNC', status: 'im Kühlschrank', date: '2026-01-01', strain: 'Test' },
      { id: 'KB-T-S2', sku: 'KB_SYNC', status: 'im Kühlschrank', date: '2026-01-02', strain: 'Test' },
      { id: 'KB-T-S3', sku: 'KB_SYNC', status: 'im Kühlschrank', anbruch: true, date: '2026-01-03', strain: 'Test' }]);
    const save = await A.req('POST', '/api/data', { body: doc, headers: { 'x-data-version': a.headers.get('x-data-version') } });
    assert.equal(save.status, 200);
    assert.equal(save.json.stock.KB_SYNC.available, 2, 'Antwort des Speicherns enthält den Serverbestand');
    const st = await A.req('GET', '/api/stock');
    assert.equal(st.status, 200);
    assert.equal(st.json.stock.KB_SYNC.available, 2);
    assert.equal(st.json.stock.KB_SYNC.physical, 2, 'angebrochene Körnerbrut zählt nicht');
    assert.equal(st.json.version, save.json.version);
    const r = await A.req('POST', '/api/woo/sync-stock', { body: { items: [{ sku: 'KB_SYNC', stock: 999 }] } });
    assert.equal(r.status, 200);
    assert.equal(r.json.results[0].requested_stock, 2, 'Serverzahl statt Browserzahl');
    assert.equal(wooStock.last, 2);
    assert.equal((await Browser_noauth_stock()), 401);
    async function Browser_noauth_stock() { return (await new Browser('10.0.0.9').req('GET', '/api/stock')).status; }
  });

  it('COD-02/M16: Set-Rezepte stehen in den Daten, der Server verwaltet sie', async () => {
    const a = await A.req('GET', '/api/data'); const doc = a.json;
    assert.ok(Array.isArray(doc.setBoms.Ppul_Exp_600g) && doc.setBoms.Ppul_Exp_600g.length >= 1, 'Standardrezepte sind in den Daten vorhanden');
    // Ein Browser darf die Rezepte nicht überschreiben
    const orig = JSON.stringify(doc.setBoms);
    doc.setBoms = { Boese: [{ sku: 'X', qty: 1 }] };
    const save = await A.req('POST', '/api/data', { body: doc, headers: { 'x-data-version': a.headers.get('x-data-version') } });
    assert.equal(save.status, 200);
    assert.equal(JSON.stringify((await A.req('GET', '/api/data')).json.setBoms), orig);
    // Ein neues Rezept in den Daten wirkt sofort auf Bestand und Reservierung
    await db.query(`UPDATE app_state SET data = jsonb_set(data, '{setBoms,TEST_SET}', '[{"sku":"KB_TEST","qty":1,"label":"Test"}]'::jsonb) WHERE id = 1`);
    const st = await A.req('GET', '/api/stock');
    assert.equal(st.json.stock.TEST_SET.set, true);
    assert.equal(st.json.stock.TEST_SET.available, st.json.stock.KB_TEST.available);
  });

  it('Teamaufgaben: atomar, liefert Versionen', async () => {
    const a = await A.req('GET', '/api/data'); const v0 = a.headers.get('x-data-version');
    const r = await A.req('POST', '/api/personal-tasks', { body: { action: 'upsert', task: { id: 'T2', title: 'Neu' } } });
    assert.equal(r.status, 200); assert.equal(r.json.prevVersion, v0); assert.notEqual(r.json.version, v0);
    assert.equal((await A.req('GET', '/api/data')).headers.get('x-data-version'), r.json.version);
    assert.equal((await A.req('POST', '/api/personal-tasks', { raw: 'nix' })).status, 400);
  });

  it('Abmelden beendet die Sitzung; Passwortwechsel macht Sitzungen ungültig', async () => {
    const C = new Browser('10.0.0.5'); C.cookies.pilz_device = A.cookies.pilz_device;
    assert.equal((await C.login()).status, 200);
    assert.equal((await C.req('GET', '/api/data')).status, 200);
    await C.req('POST', '/api/logout');
    assert.equal((await C.req('GET', '/api/data')).status, 401);
    // Neustart mit anderem Passwort
    server.kill('SIGTERM'); await new Promise(r => server.once('exit', r));
    const keep = process.env.APP_PASSWORD; process.env.APP_PASSWORD = 'ein-ganz-anderes-passwort-123';
    const oldPw = APP_PW;
    server = null;
    try {
      server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(PORT), DATABASE_URL: DB_URL, PGSSLMODE: 'disable', APP_PASSWORD: 'ein-ganz-anderes-passwort-123', RESCUE_PASSWORD: RESCUE_PW, WC_WEBHOOK_SECRET: WH_SECRET } });
      await until(async () => { try { return (await fetch(BASE + '/api/health')).ok; } catch (_) { return false; } }, 15000);
      assert.equal((await A.req('GET', '/api/data')).status, 401, 'alte Sitzung ungültig');
      assert.equal((await A.login(oldPw)).status, 401);
    } finally { server.kill('SIGTERM'); if (keep === undefined) delete process.env.APP_PASSWORD; else process.env.APP_PASSWORD = keep; server = null; }
  });
});
