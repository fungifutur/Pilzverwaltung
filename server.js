const http = require('http');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

let Pool = null;
let QRCode = null;
try { ({ Pool } = require('pg')); } catch (_) { Pool = null; }
try { QRCode = require('qrcode'); } catch (_) { QRCode = null; }

const APP_VERSION = '1.5.41';
const PORT = Number(process.env.PORT || 3000);
const wooReconcileProgress = new Map();

const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 50 * 1024 * 1024;          // nur für /api/data (ganzer Datenbestand)
const DEFAULT_BODY = 1024 * 1024;            // alle übrigen Endpunkte
const LOGIN_BODY = 10 * 1024;
const WEBHOOK_BODY = 2 * 1024 * 1024;
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const RESCUE_PASSWORD = process.env.RESCUE_PASSWORD || '';
const AUTH_COOKIE = 'pilz_auth';
const SESSION_DAYS = Math.max(1, Number(process.env.SESSION_DAYS || 90));
const DATABASE_URL = process.env.DATABASE_URL || '';
const WC_STORE_URL = (process.env.WC_STORE_URL || '').replace(/\/$/, '');
const WC_CONSUMER_KEY = process.env.WC_CONSUMER_KEY || '';
const WC_CONSUMER_SECRET = process.env.WC_CONSUMER_SECRET || '';
const WC_WEBHOOK_SECRET = process.env.WC_WEBHOOK_SECRET || '';
const WC_TIMEOUT_MS = Number(process.env.WC_TIMEOUT_MS || 30000);
const ALERT_WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL || '';   // optional: Slack/ntfy/Discord-kompatibler Webhook
const DEVICE_COOKIE = 'pilz_device';
const DEVICE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365 * 3; // 3 Jahre
const STATE_LOCK_KEY = 730124;               // pg_advisory_lock für alle Schreibzugriffe auf app_state
const WEBHOOK_MAX_ATTEMPTS = 10;
const RESERVATION_REPLACED_KEEP_DAYS = 7;
const RESERVATION_RELEASED_KEEP_DAYS = 90;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.sql': 'application/sql; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const DEFAULT_DB = {
  dk: [], petri: [], lc: [], kb: [], mix: [], sub: [], harv: [], buckets: [], lots: [], goods: [], logs: [],
  archive: [], minStocks: [], testGroups: [], masterCultures: [], productCatalog: [], storageLocations: [], stockTransactions: [], wooOrders: [], wooReservations: [], wooSyncLog: [], productionRequests: [], personalTasks: [], personalTaskCategories: [], masterCounters: {}
};
// Sammlungen, die der Server führt bzw. die der Browser nicht überschreiben darf.
const SERVER_OWNED_KEYS = ['wooOrders', 'wooReservations', 'wooSyncLog'];

let pool = null;
function pgSslConfig() {
  if (process.env.PGSSLMODE === 'disable') return false;
  // SEC-08: Mit PGSSL_CA (PEM-Zertifikat der Datenbank) wird das Serverzertifikat geprüft.
  if (process.env.PGSSL_CA) return { ca: process.env.PGSSL_CA.replace(/\\n/g, '\n'), rejectUnauthorized: true };
  return { rejectUnauthorized: false };
}
if (!Pool) {
  console.error('PostgreSQL-Modul pg fehlt. Bitte npm install ausführen.');
} else if (!DATABASE_URL) {
  console.error('DATABASE_URL fehlt. Die Pilzverwaltung verwendet ausschliesslich PostgreSQL.');
} else {
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: pgSslConfig(),
    max: 10,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000
  });
  // Ohne diesen Handler beendet ein Fehler auf einer ruhenden Verbindung den ganzen Prozess.
  pool.on('error', err => console.error('Datenbankverbindung (Pool):', err.message));
}
if (!APP_PASSWORD) console.error('APP_PASSWORD fehlt: Anmeldung und alle internen Funktionen bleiben gesperrt.');
else if (APP_PASSWORD.length < 12) console.warn('APP_PASSWORD ist kürzer als 12 Zeichen. Empfohlen: zufälliges Passwort mit mindestens 16 Zeichen.');

// ---------------------------------------------------------------------------
// HTTP-Hilfen
// ---------------------------------------------------------------------------
function securityHeaders() {
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join('; ');
  return {
    'Content-Security-Policy': csp,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Strict-Transport-Security': 'max-age=31536000',
    'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()'
  };
}
// CSP_REPORT_ONLY=1 schaltet die Inhaltsrichtlinie auf reinen Testbetrieb, falls etwas im Browser blockiert wird.
function securityHeadersForResponse() {
  const h = securityHeaders();
  if (process.env.CSP_REPORT_ONLY === '1') { h['Content-Security-Policy-Report-Only'] = h['Content-Security-Policy']; delete h['Content-Security-Policy']; }
  return h;
}

function noCacheHeaders(extra = {}) {
  return { 'Cache-Control': 'no-store', ...securityHeadersForResponse(), ...extra };
}

function send(res, status, body, contentType = 'text/plain; charset=utf-8', headers = {}) {
  res.writeHead(status, noCacheHeaders({ 'Content-Type': contentType, ...headers }));
  res.end(body);
}

function sendJson(res, status, obj, headers = {}) {
  send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8', headers);
}

// Fehler mit passendem Statuscode beantworten (400 ungültige Eingabe, 413 zu gross, sonst Rückfall).
function failJson(res, err, fallbackStatus = 500, fallbackMessage = 'Serverfehler.') {
  const status = Number(err && err.statusCode) || fallbackStatus;
  if (status >= 500) console.error(err);
  const message = (err && err.statusCode && err.message) ? err.message : (fallbackMessage || (err && err.message) || 'Serverfehler.');
  return sendJson(res, status, { error: message, ...(err && err.statusCode && err.code ? { code: err.code } : {}) });
}
function httpError(status, message, code) {
  const e = new Error(message); e.statusCode = status; if (code) e.code = code; return e;
}

function safeDecode(value) {
  try { return decodeURIComponent(value); } catch (_) { return value; }
}
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('='); if (i < 0) continue;
    out[part.slice(0, i).trim()] = safeDecode(part.slice(i + 1).trim());
  }
  return out;
}

function hash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}
// Zeitkonstanter Vergleich beliebig langer Strings (über SHA-256 auf gleiche Länge gebracht).
function safeEqual(a, b) {
  return crypto.timingSafeEqual(crypto.createHash('sha256').update(String(a)).digest(), crypto.createHash('sha256').update(String(b)).digest());
}

function clientIp(req) { return String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim().slice(0, 120); }
function deviceDescription(req) { return String(req.headers['user-agent'] || 'Unbekanntes Gerät').slice(0, 500); }
function isRealBrowserDevice(req) {
  const ua = deviceDescription(req);
  if (!ua || /go-http-client|curl\/|wget\/|postmanruntime|insomnia|uptimerobot|healthcheck|render\//i.test(ua)) return false;
  return /mozilla\/5\.0|chrome\/|crios\/|firefox\/|fxios\/|safari\/|edg\//i.test(ua);
}

async function readBody(req, limit = DEFAULT_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0, finished = false;
    req.on('data', chunk => {
      if (finished) return;
      size += chunk.length;
      if (size > limit) {
        finished = true;
        reject(httpError(413, 'Anfrage zu gross.'));
        req.resume(); // Rest verwerfen, damit die Antwort noch gesendet werden kann
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!finished) { finished = true; resolve(Buffer.concat(chunks).toString('utf8')); } });
    req.on('error', err => { if (!finished) { finished = true; reject(err); } });
  });
}
async function readJson(req, limit = DEFAULT_BODY) {
  const raw = await readBody(req, limit);
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); }
  catch (_) { throw httpError(400, 'Ungültiges JSON.'); }
}

// ---------------------------------------------------------------------------
// Anmeldung: Passwortvergleich, Sperre gegen Durchprobieren, Sitzungen in der Datenbank
// ---------------------------------------------------------------------------
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_FREE_ATTEMPTS = 5;
const LOGIN_GLOBAL_MAX = 60;
const loginFailures = new Map();   // ip -> { count, first, lockedUntil }
const globalLoginFailures = { count: 0, first: 0, lockedUntil: 0 };

function loginLockSeconds(req) {
  const now = Date.now();
  if (globalLoginFailures.lockedUntil > now) return Math.ceil((globalLoginFailures.lockedUntil - now) / 1000);
  const e = loginFailures.get(clientIp(req));
  if (e && e.lockedUntil > now) return Math.ceil((e.lockedUntil - now) / 1000);
  return 0;
}
function registerLoginFailure(req) {
  const now = Date.now(), ip = clientIp(req);
  let e = loginFailures.get(ip);
  if (!e || now - e.first > LOGIN_WINDOW_MS) e = { count: 0, first: now, lockedUntil: 0 };
  e.count++;
  if (e.count >= LOGIN_FREE_ATTEMPTS) e.lockedUntil = now + Math.min(LOGIN_WINDOW_MS, 30000 * 2 ** (e.count - LOGIN_FREE_ATTEMPTS));
  loginFailures.set(ip, e);
  if (now - globalLoginFailures.first > LOGIN_WINDOW_MS) { globalLoginFailures.count = 0; globalLoginFailures.first = now; }
  globalLoginFailures.count++;
  if (globalLoginFailures.count >= LOGIN_GLOBAL_MAX) {
    globalLoginFailures.lockedUntil = now + 10 * 60 * 1000;
    globalLoginFailures.count = 0; globalLoginFailures.first = now;
    notifyAlert('Viele fehlgeschlagene Anmeldeversuche bei der Pilzverwaltung. Anmeldung für 10 Minuten gesperrt.');
  }
}
function clearLoginFailures(req) { loginFailures.delete(clientIp(req)); }
setInterval(() => { const now = Date.now(); for (const [k, v] of loginFailures) if (now - v.first > LOGIN_WINDOW_MS && v.lockedUntil < now) loginFailures.delete(k); }, 10 * 60 * 1000).unref();

function sessionCookie(token) {
  return `${AUTH_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; Secure; SameSite=Strict`;
}
function expiredSessionCookie() {
  return `${AUTH_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}
function deviceTokenHash(token) { return hash('device:' + String(token || '')); }
function deviceCookie(token) {
  return `${DEVICE_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${DEVICE_COOKIE_MAX_AGE}; HttpOnly; Secure; SameSite=Strict`;
}
async function createSession(req, kind) {
  await ensurePostgres();
  const token = crypto.randomBytes(32).toString('base64url');
  await pool.query(
    `INSERT INTO app_sessions(token_hash, kind, expires_at, last_ip, user_agent) VALUES($1,$2, now() + ($3 || ' days')::interval, $4, $5)`,
    [hash('session:' + token), kind, String(SESSION_DAYS), clientIp(req), deviceDescription(req)]
  );
  return token;
}
async function loadSessionKind(req) {
  const raw = parseCookies(req)[AUTH_COOKIE] || '';
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(raw)) return '';   // alte Cookies (Format «app.<hash>») sind ungültig → neu anmelden
  await ensurePostgres();
  const q = await pool.query('SELECT kind FROM app_sessions WHERE token_hash=$1 AND expires_at > now()', [hash('session:' + raw)]);
  const kind = q.rows[0]?.kind || '';
  if (kind === 'app' && APP_PASSWORD) return 'app';
  if (kind === 'rescue' && RESCUE_PASSWORD) return 'rescue';
  return '';
}
async function destroySession(req) {
  const raw = parseCookies(req)[AUTH_COOKIE] || '';
  if (!raw) return;
  await ensurePostgres();
  await pool.query('DELETE FROM app_sessions WHERE token_hash=$1', [hash('session:' + raw)]);
}
// Wird in handleApi einmal je Anfrage gesetzt.
function authKind(req) { return req.pilzAuth || ''; }
function requireAppLogin(req, res) {
  if (authKind(req)) return false;
  sendJson(res, 401, { error: 'Bitte zuerst mit dem Zugangspasswort anmelden.', code: 'LOGIN_REQUIRED' });
  return true;
}

// Admin-Funktionen: Rescue-Sitzung oder Passwort im Authorization-Header.
function isAuthorized(req) {
  if (authKind(req) === 'rescue') return true;
  if (!APP_PASSWORD) return false;      // ohne gesetztes Passwort bleibt alles gesperrt (früher: offen)
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return false;
  return safeEqual(token, APP_PASSWORD) || (!!RESCUE_PASSWORD && safeEqual(token, RESCUE_PASSWORD));
}
function requireAuth(req, res) {
  const wait = loginLockSeconds(req);
  if (wait) { sendJson(res, 429, { error: `Zu viele Fehlversuche. Bitte in ${wait} Sekunden erneut versuchen.` }, { 'Retry-After': String(wait) }); return true; }
  if (isAuthorized(req)) return false;
  if ((req.headers.authorization || '').startsWith('Bearer ')) registerLoginFailure(req);
  sendJson(res, 401, { error: 'Nicht angemeldet oder falsches Passwort.' });
  return true;
}

// ---------------------------------------------------------------------------
// Alarmierung (optional): ALERT_WEBHOOK_URL erhält eine JSON-Meldung {"text": "..."}.
// Gleiche Meldungen werden höchstens einmal pro Stunde gesendet.
// ---------------------------------------------------------------------------
const alertSent = new Map();
function notifyAlert(message) {
  console.error('ALARM:', message);
  if (!ALERT_WEBHOOK_URL) return;
  const last = alertSent.get(message) || 0;
  if (Date.now() - last < 60 * 60 * 1000) return;
  alertSent.set(message, Date.now());
  fetch(ALERT_WEBHOOK_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: `Pilzverwaltung: ${message}`, content: `Pilzverwaltung: ${message}` }),
    signal: AbortSignal.timeout(10000)
  }).catch(err => console.error('Alarm konnte nicht gesendet werden:', err.message));
}

// ---------------------------------------------------------------------------
// Datenmodell
// ---------------------------------------------------------------------------
function normalizeDb(data) {
  const db = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  for (const key of Object.keys(DEFAULT_DB)) {
    if (Array.isArray(DEFAULT_DB[key])) {
      if (!Array.isArray(db[key])) db[key] = [];
    } else if (!db[key] || typeof db[key] !== 'object' || Array.isArray(db[key])) {
      db[key] = {};
    }
  }
  if (!db.setBoms || !Object.keys(db.setBoms).length) db.setBoms = JSON.parse(JSON.stringify(SET_BOMS_DEFAULT));
  return db;
}

// Datenminimierung (DSG-01): Von Kunden werden nur Namen gespeichert, keine Adressen, E-Mail oder Telefon.
function minimizeContact(c) {
  return { first_name: String(c?.first_name || ''), last_name: String(c?.last_name || '') };
}
function minimizeOrders(db) {
  for (const o of (db.wooOrders || [])) {
    if (o && typeof o === 'object') {
      if (o.billing) o.billing = minimizeContact(o.billing);
      if (o.shipping) o.shipping = minimizeContact(o.shipping);
    }
  }
}
// DSG-03: Namen in abgeschlossenen/stornierten Bestellungen werden nach Ablauf der Frist gelöscht. Die Bestellung (Nummer, Artikel, Mengen)
// bleibt für die Bestandshistorie; Rechnungs- und Kundendaten liegen in WooCommerce und bexio.
const ORDER_NAME_KEEP_DAYS = Math.max(1, Number(process.env.ORDER_NAME_KEEP_DAYS || 90));
function anonymizeOldOrders(db, now = Date.now()) {
  for (const o of (db.wooOrders || [])) {
    if (!o || !o.archived || o.anonymized) continue;
    const t = Date.parse(o.archivedAt || o.date_modified || o.date_created || '');
    if (!Number.isFinite(t) || now - t < ORDER_NAME_KEEP_DAYS * 86400000) continue;
    o.customer = ''; o.billing = { first_name: '', last_name: '' }; o.shipping = { first_name: '', last_name: '' };
    o.customer_note = ''; o.anonymized = true; o.anonymizedAt = new Date(now).toISOString();
  }
}
// Bereinigung (INT-09): überholte Reservierungsdatensätze wachsen sonst bei jedem Speichern.
function pruneDb(db) {
  const now = Date.now(), DAY = 86400000;
  if (Array.isArray(db.wooReservations)) {
    db.wooReservations = db.wooReservations.filter(r => {
      const keepDays = r.status === 'replaced' ? RESERVATION_REPLACED_KEEP_DAYS
        : (r.status === 'released' || r.status === 'external-deleted') ? RESERVATION_RELEASED_KEEP_DAYS : null;
      if (keepDays === null) return true;
      const t = Date.parse(r.releasedAt || r.createdAt || '');
      return !(Number.isFinite(t) && now - t > keepDays * DAY);
    });
  }
  minimizeOrders(db);
  anonymizeOldOrders(db);
  return db;
}

// Version = Prüfsumme des vom Browser geführten Teils der Daten. Bestellungen, Reservierungen und
// Sync-Protokoll gehören dem Server und zählen nicht mit, sonst würde jede neue Bestellung das Speichern blockieren.
const VERSION_SQL = `md5((data - 'wooOrders' - 'wooReservations' - 'wooSyncLog')::text)`;

let schemaReady = null;
function ensurePostgres() {
  if (!pool) return Promise.reject(new Error('PostgreSQL ist nicht konfiguriert. DATABASE_URL fehlt oder pg konnte nicht geladen werden.'));
  if (!schemaReady) {
    schemaReady = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS app_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          data JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS app_backups (
          id BIGSERIAL PRIMARY KEY,
          data JSONB NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          backup_kind TEXT NOT NULL DEFAULT 'change'
        )
      `);
      await pool.query(`ALTER TABLE app_backups ADD COLUMN IF NOT EXISTS backup_kind TEXT NOT NULL DEFAULT 'change'`);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS app_settings (
          key TEXT PRIMARY KEY,
          value JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS app_devices (
          id BIGSERIAL PRIMARY KEY,
          token_hash TEXT UNIQUE NOT NULL,
          name TEXT NOT NULL DEFAULT '',
          approved BOOLEAN NOT NULL DEFAULT false,
          first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
          last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
          user_agent TEXT NOT NULL DEFAULT '',
          last_ip TEXT NOT NULL DEFAULT ''
        )
      `);
      // Neu ab 1.5.25 (nur Ergänzungen, bestehende Tabellen und Daten bleiben unverändert):
      await pool.query(`
        CREATE TABLE IF NOT EXISTS app_sessions (
          token_hash TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          expires_at TIMESTAMPTZ NOT NULL,
          last_ip TEXT NOT NULL DEFAULT '',
          user_agent TEXT NOT NULL DEFAULT ''
        )
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS app_webhook_queue (
          id BIGSERIAL PRIMARY KEY,
          received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          topic TEXT NOT NULL DEFAULT '',
          order_id TEXT NOT NULL DEFAULT '',
          payload JSONB NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          attempts INTEGER NOT NULL DEFAULT 0,
          next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          last_error TEXT,
          processed_at TIMESTAMPTZ
        )
      `);
      await pool.query(`CREATE INDEX IF NOT EXISTS app_webhook_queue_pending_idx ON app_webhook_queue(status, next_attempt_at)`);
      // Wird ein Passwort geändert, werden alle bestehenden Sitzungen ungültig.
      const fp = hash(`fp:${APP_PASSWORD}|${RESCUE_PASSWORD}`);
      const cur = await pool.query(`SELECT value FROM app_settings WHERE key='auth_fingerprint'`);
      if (!cur.rows.length || cur.rows[0].value !== fp) {
        await pool.query('DELETE FROM app_sessions');
        await pool.query(`INSERT INTO app_settings(key,value,updated_at) VALUES('auth_fingerprint',$1::jsonb,now()) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`, [JSON.stringify(fp)]);
      }
      return true;
    })().catch(err => { schemaReady = null; throw err; });
  }
  return schemaReady;
}

// Serialisiert alle Lese-ändern-schreiben-Vorgänge auf dem Gesamtdokument (INT-01 bis INT-03):
// innerhalb des Prozesses über eine Warteschlange, zwischen Prozessen (z. B. bei Deployments) über pg_advisory_lock.
let stateLockChain = Promise.resolve();
function withStateLock(fn) {
  const run = stateLockChain.then(async () => {
    await ensurePostgres();
    const client = await pool.connect();
    let broken = false;
    try {
      await client.query('SELECT pg_advisory_lock($1)', [STATE_LOCK_KEY]);
      try { return await fn(); }
      finally { await client.query('SELECT pg_advisory_unlock($1)', [STATE_LOCK_KEY]).catch(() => { broken = true; }); }
    } catch (err) { broken = true; throw err; }
    finally { client.release(broken); }   // bei Fehler Verbindung verwerfen, damit keine Sperre hängen bleibt
  });
  stateLockChain = run.catch(() => {});
  return run;
}

async function readState() {
  await ensurePostgres();
  const result = await pool.query(`SELECT data, updated_at, ${VERSION_SQL} AS version FROM app_state WHERE id = 1`);
  if (!result.rows.length) return { db: normalizeDb(JSON.parse(JSON.stringify(DEFAULT_DB))), version: 'none', updatedAt: null };
  return { db: normalizeDb(result.rows[0].data), version: result.rows[0].version, updatedAt: result.rows[0].updated_at };
}
async function readData() { return (await readState()).db; }

// Schreibt das Dokument und das Vorher-Backup in einer Transaktion.
// kind: 'change_limited' (Browser-Speicherung, rückgängig machbar) oder 'server_limited' (Webhook, Abgleich).
async function writeData(data, kind = 'change_limited') {
  const db = pruneDb(normalizeDb(data));
  await ensurePostgres();
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query('BEGIN');
    const old = await client.query('SELECT 1 FROM app_state WHERE id = 1 FOR UPDATE');
    if (old.rows.length) {
      // Tempo: Die Vorher-Kopie entsteht in der Datenbank selbst (kein Hin- und Herschicken von rund 1,7 MB).
      await client.query('INSERT INTO app_backups(data, backup_kind) SELECT data, $1::text FROM app_state WHERE id = 1', [kind]);
      // Nur die ab Version 1.5.17 angelegten Änderungs-Backups begrenzen.
      await client.query(`DELETE FROM app_backups WHERE backup_kind=$1 AND id NOT IN (SELECT id FROM app_backups WHERE backup_kind=$1 ORDER BY id DESC LIMIT 50)`, [kind]);
    }
    const res = await client.query(`
      INSERT INTO app_state(id, data, updated_at)
      VALUES(1, $1, now())
      ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()
      RETURNING updated_at, ${VERSION_SQL} AS version
    `, [db]);
    await client.query('COMMIT');
    return { updatedAt: res.rows[0].updated_at, version: res.rows[0].version };
  } catch (err) {
    broken = true;
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { client.release(broken); }
}

// Nur das Sync-Protokoll nachschreiben (kein zusätzliches Backup, ändert die Version nicht).
async function persistSyncLog(db) {
  await ensurePostgres();
  await pool.query(`UPDATE app_state SET data = jsonb_set(data, '{wooSyncLog}', $1::jsonb, true), updated_at = now() WHERE id = 1`, [JSON.stringify(db.wooSyncLog || [])]);
}

async function createManualBackup() {
  const db = await readData();
  await ensurePostgres();
  const result = await pool.query('INSERT INTO app_backups(data, backup_kind) VALUES($1, $2) RETURNING id, created_at, backup_kind', [db, 'manual']);
  return result.rows[0];
}

async function listBackups() {
  await ensurePostgres();
  const result = await pool.query(`WITH chosen AS (\n    (SELECT id, created_at, backup_kind, data FROM app_backups WHERE backup_kind IN ('daily','daily_limited') ORDER BY created_at DESC LIMIT 30)\n    UNION ALL\n    (SELECT id, created_at, backup_kind, data FROM app_backups WHERE backup_kind NOT IN ('daily','daily_limited') ORDER BY created_at DESC LIMIT 20)\n  ) SELECT id, created_at, backup_kind, pg_column_size(data)::int AS bytes FROM chosen ORDER BY created_at DESC`);
  return result.rows.map(r => ({ id: r.id, created_at: r.created_at, kind: r.backup_kind || 'change', bytes: r.bytes }));
}

// OPS-02/DSG-03: Einheitliche Aufbewahrung für alle Backup-Arten in der Datenbank (jedes Backup enthält Namen von Kundinnen und Kunden).
// Pro Art gilt: höchstens so alt wie angegeben UND mindestens die neuesten «behalte» Einträge bleiben immer (damit nie alles verschwindet).
const BACKUP_RETENTION = [
  { kinds: ['daily', 'daily_limited'], days: 30, keep: 2 },
  { kinds: ['change', 'change_limited', 'server_limited'], days: 14, keep: 2 },
  { kinds: ['undo'], days: 7, keep: 1 },
  { kinds: ['manual'], days: 90, keep: 2 }
];
async function purgeOldBackups() {
  let removed = 0;
  for (const r of BACKUP_RETENTION) {
    const ph = r.kinds.map((_, i) => '$' + (i + 1)).join(',');
    const n = r.kinds.length;
    const res = await pool.query(
      `DELETE FROM app_backups WHERE backup_kind IN (${ph}) AND created_at < now() - ($${n + 1} || ' days')::interval
         AND id NOT IN (SELECT id FROM app_backups WHERE backup_kind IN (${ph}) ORDER BY created_at DESC, id DESC LIMIT $${n + 2})`, [...r.kinds, String(r.days), r.keep]);
    removed += res.rowCount || 0;
  }
  return removed;
}

async function ensureDailyBackup() {
  await ensurePostgres();
  const exists = await pool.query(`SELECT 1 FROM app_backups WHERE backup_kind IN ('daily','daily_limited') AND created_at >= date_trunc('day', now()) LIMIT 1`);
  if (!exists.rows.length) {
    const db = await readData();
    await pool.query(`INSERT INTO app_backups(data, backup_kind) VALUES($1, 'daily_limited')`, [db]);
    // Nur neue Tagesbackups begrenzen; alle bisherigen 'daily'-Einträge behalten.
    await pool.query(`DELETE FROM app_backups WHERE backup_kind='daily_limited' AND id NOT IN (SELECT id FROM app_backups WHERE backup_kind='daily_limited' ORDER BY id DESC LIMIT 30)`);
  }
  // Rückgängig-Sicherungen (OPS-02) sowie erledigte Webhook-Einträge und abgelaufene Sitzungen aufräumen.
  await pool.query(`DELETE FROM app_backups WHERE backup_kind='undo' AND id NOT IN (SELECT id FROM app_backups WHERE backup_kind='undo' ORDER BY id DESC LIMIT 10)`);
  await purgeOldBackups();
  await pool.query(`DELETE FROM app_webhook_queue WHERE status='done' AND processed_at < now() - interval '7 days'`);
  await pool.query(`DELETE FROM app_webhook_queue WHERE status='failed' AND received_at < now() - interval '30 days'`);
  await pool.query(`DELETE FROM app_sessions WHERE expires_at < now()`);
  return !exists.rows.length;
}

async function restoreBackup(id) {
  if (!id) throw httpError(400, 'Backup-ID fehlt');
  await ensurePostgres();
  const result = await pool.query('SELECT data FROM app_backups WHERE id = $1', [id]);
  if (!result.rows.length) throw httpError(404, 'Backup nicht gefunden');
  const saved = await writeData(result.rows[0].data, 'undo');   // aktueller Stand wird als Rückgängig-Sicherung abgelegt
  return saved;
}

async function undoLastChange() {
  await ensurePostgres();
  const { db: cur, version: prevVersion } = await readState();
  const r = await pool.query("SELECT id, data, created_at, backup_kind FROM app_backups WHERE backup_kind IN ('change','change_limited','server_limited') ORDER BY created_at DESC, id DESC LIMIT 1");
  if (!r.rows.length) throw httpError(400, 'Kein letzter Schritt zum Rückgängigmachen vorhanden.');
  if (r.rows[0].backup_kind === 'server_limited') {
    // Seit dem letzten Speichern hat der Server (Webhook, Abgleich) Daten geändert. Ein Rückgängig würde diese Änderung überschreiben.
    throw httpError(409, 'Seit dem letzten Speichern wurden Daten durch WooCommerce (Bestellung/Abgleich) geändert. Rückgängig machen würde diese Änderung überschreiben und ist deshalb gesperrt.');
  }
  const target = normalizeDb(r.rows[0].data);
  // Vom Server geführte Sammlungen bleiben aktuell, Reservierungen werden neu berechnet.
  for (const k of SERVER_OWNED_KEYS) target[k] = cur[k];
  rebuildProcessingReservations(target);
  // Der aktuelle Stand wird dabei als 'undo'-Sicherung abgelegt (kein neuer normaler change-Eintrag).
  const saved = await writeData(target, 'undo');
  await pool.query('DELETE FROM app_backups WHERE id=$1', [r.rows[0].id]);
  const syncResults = await syncChangedSkus(cur, target, 'Letzten Schritt rückgängig');
  if (syncResults.length) await persistSyncLog(target);
  return { restoredFrom: r.rows[0].created_at, syncResults, version: saved.version, prevVersion };
}

// ---------------------------------------------------------------------------
// Geräte
// ---------------------------------------------------------------------------
// create=true: unbekanntes Gerät wird neu eingetragen (nur nach erfolgreicher Passwort-Anmeldung).
// create=false: nur bereits bekannte Geräte werden aktualisiert (unangemeldete Besucher erzeugen keine Einträge mehr).
async function touchDevice(req, { create = false } = {}) {
  if (!isRealBrowserDevice(req)) return { device: null, setCookie: '' };
  await ensurePostgres();
  const cookies = parseCookies(req);
  let token = cookies[DEVICE_COOKIE] || '';
  let isNew = false;
  if (!/^[A-Za-z0-9_-]{30,200}$/.test(token)) {
    if (!create) return { device: null, setCookie: '' };
    token = crypto.randomBytes(32).toString('base64url'); isNew = true;
  }
  const th = deviceTokenHash(token);
  const ua = deviceDescription(req), ip = clientIp(req);
  let q;
  if (create) {
    q = await pool.query(`INSERT INTO app_devices(token_hash,user_agent,last_ip) VALUES($1,$2,$3)
      ON CONFLICT(token_hash) DO UPDATE SET last_seen=now(), user_agent=$2, last_ip=$3
      RETURNING id,name,approved,first_seen,last_seen,user_agent,last_ip`, [th, ua, ip]);
  } else {
    q = await pool.query(`UPDATE app_devices SET last_seen=now(), user_agent=$2, last_ip=$3
      WHERE token_hash=$1 AND (last_seen < now() - interval '1 minute' OR user_agent <> $2 OR last_ip <> $3)
      RETURNING id,name,approved,first_seen,last_seen,user_agent,last_ip`, [th, ua, ip]);
  }
  return { device: q.rows[0] || null, setCookie: isNew ? deviceCookie(token) : '' };
}
async function listDevices() {
  await ensurePostgres();
  // Alte Healthcheck/API-Clients aus der Geräteverwaltung entfernen.
  await pool.query(`DELETE FROM app_devices WHERE user_agent IS NULL OR user_agent = '' OR user_agent ~* '(go-http-client|curl/|wget/|postmanruntime|insomnia|uptimerobot|healthcheck|render/)' OR user_agent !~* '(mozilla/5\\.0|chrome/|crios/|firefox/|fxios/|safari/|edg/)'`);
  const q=await pool.query(`SELECT id,name,approved,first_seen,last_seen,user_agent,last_ip FROM app_devices ORDER BY approved DESC,last_seen DESC`);
  return q.rows;
}
async function updateDevice(id, patch={}) {
  await ensurePostgres();
  if (!Number.isInteger(id)) throw httpError(400, 'Geräte-ID ungültig.');
  const q=await pool.query(`UPDATE app_devices SET name=COALESCE($2,name), approved=COALESCE($3,approved) WHERE id=$1 RETURNING id,name,approved,first_seen,last_seen,user_agent,last_ip`, [id, patch.name == null ? null : String(patch.name).slice(0,120), typeof patch.approved==='boolean'?patch.approved:null]);
  if(!q.rows.length) throw httpError(404, 'Gerät nicht gefunden'); return q.rows[0];
}

async function currentDevice(req) {
  await ensurePostgres();
  const token = parseCookies(req)[DEVICE_COOKIE] || '';
  if (!token) return null;
  const q = await pool.query(`SELECT id,name,approved,first_seen,last_seen,user_agent,last_ip FROM app_devices WHERE token_hash=$1 LIMIT 1`, [deviceTokenHash(token)]);
  return q.rows[0] || null;
}
async function approvedDeviceCount() {
  await ensurePostgres();
  const q = await pool.query(`SELECT count(*)::int AS n FROM app_devices WHERE approved=true`);
  return Number(q.rows[0]?.n || 0);
}
async function deviceEnforcementEnabled() {
  await ensurePostgres();
  const q = await pool.query(`SELECT value FROM app_settings WHERE key='device_enforcement' LIMIT 1`);
  if (!q.rows.length) return true; // sicherer Standard
  return q.rows[0].value !== false;
}
async function setDeviceEnforcement(enabled) {
  await ensurePostgres();
  await pool.query(`INSERT INTO app_settings(key,value,updated_at) VALUES('device_enforcement',$1::jsonb,now())
    ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`, [JSON.stringify(!!enabled)]);
  return !!enabled;
}
async function requireApprovedDevice(req, res) {
  if (!(await deviceEnforcementEnabled())) return false;
  const d = await currentDevice(req);
  if (d?.approved) return false;
  sendJson(res, 403, { error: 'Dieses Gerät ist nicht freigegeben.', code: 'DEVICE_NOT_APPROVED', deviceId: d?.id || null });
  return true;
}

async function systemStatus() {
  const { db, version, updatedAt } = await readState();
  let dbSize = null;
  await ensurePostgres();
  const s = await pool.query(`SELECT pg_database_size(current_database())::bigint AS size`);
  dbSize = Number(s.rows[0]?.size || 0);
  const backups = await listBackups();
  const queue = await webhookQueueStats();
  const count = k => Array.isArray(db[k]) ? db[k].length : 0;
  return {
    ok: true,
    version: APP_VERSION,
    storage: 'postgres',
    time: new Date().toISOString(),
    updatedAt,
    dataVersion: version,
    dbSize,
    lastBackup: backups[0] || null,
    webhookQueue: queue,
    counts: {
      dk: count('dk'), petri: count('petri'), lc: count('lc'), kb: count('kb'), sub: count('sub'),
      buckets: count('buckets'), lots: count('lots'), goods: count('goods'), logs: count('logs'),
      archive: count('archive'), masterCultures: count('masterCultures')
    }
  };
}

async function webhookQueueStats() {
  await ensurePostgres();
  const q = await pool.query(`SELECT
      count(*) FILTER (WHERE status='pending')::int AS pending,
      count(*) FILTER (WHERE status='failed')::int AS failed,
      COALESCE(extract(epoch FROM (now() - min(received_at) FILTER (WHERE status='pending')))::int, 0) AS oldest_pending_seconds
    FROM app_webhook_queue`);
  return q.rows[0];
}

function wooConfigured() {
  return !!(WC_STORE_URL && WC_CONSUMER_KEY && WC_CONSUMER_SECRET);
}
function wooAuthHeader() {
  return 'Basic ' + Buffer.from(`${WC_CONSUMER_KEY}:${WC_CONSUMER_SECRET}`).toString('base64');
}
async function wooRequest(apiPath, options = {}) {
  if (!wooConfigured()) throw new Error('WooCommerce ist noch nicht konfiguriert. WC_STORE_URL, WC_CONSUMER_KEY und WC_CONSUMER_SECRET fehlen.');
  const url = `${WC_STORE_URL}/wp-json/wc/v3${apiPath}`;
  const headers = { Authorization: wooAuthHeader(), Accept: 'application/json', ...(options.headers || {}) };
  if (options.body) headers['Content-Type'] = 'application/json';
  let response;
  try { response = await fetch(url, { ...options, headers, signal: AbortSignal.timeout(WC_TIMEOUT_MS) }); }
  catch (err) {
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) throw new Error(`WooCommerce antwortet nicht (Zeitüberschreitung nach ${Math.round(WC_TIMEOUT_MS / 1000)} s).`);
    throw err;
  }
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
  if (!response.ok) {
    const msg = data && typeof data === 'object' ? (data.message || data.code || JSON.stringify(data)) : String(data || response.statusText);
    throw new Error(`WooCommerce ${response.status}: ${msg}`);
  }
  return data;
}
async function wooFindProductBySku(sku) {
  const list = await wooRequest(`/products?sku=${encodeURIComponent(sku)}&per_page=100`, { method: 'GET' });
  // Nur ein exakter SKU-Treffer zählt. Früher wurde bei fehlendem Treffer das erste Suchergebnis genommen (INT-06),
  // wodurch Bestand auf ein falsches Produkt geschrieben werden konnte.
  const product = Array.isArray(list) ? (list.find(p => String(p.sku || '') === String(sku)) || null) : null;
  return product || null;
}
function wooProductSummary(sku, p) {
  if (!p) return { sku, found: false };
  const isVariation = String(p.type || '').toLowerCase() === 'variation' || Number(p.parent_id || 0) > 0;
  return {
    sku,
    found: true,
    id: p.id,
    parent_id: Number(p.parent_id || 0) || null,
    variation_id: isVariation ? p.id : null,
    is_variation: isVariation,
    name: p.name,
    type: p.type,
    manage_stock: !!p.manage_stock,
    stock_quantity: p.stock_quantity,
    stock_status: p.stock_status,
    permalink: p.permalink || ''
  };
}
function wooProductApiPath(p) {
  const isVariation = String(p?.type || '').toLowerCase() === 'variation' || Number(p?.parent_id || 0) > 0;
  if (isVariation) {
    const parentId = Number(p.parent_id || 0);
    if (!parentId) throw new Error(`Variation ${p.id} hat keine Parent-ID.`);
    return `/products/${parentId}/variations/${p.id}`;
  }
  return `/products/${p.id}`;
}
async function wooReadProductState(p) {
  return await wooRequest(wooProductApiPath(p), { method: 'GET' });
}


async function wooListAllProductsWithSkus(){
  const out=[];
  for(let page=1; page<=20; page++){
    const list=await wooRequest(`/products?per_page=100&page=${page}`,{method:'GET'});
    if(!Array.isArray(list)||!list.length) break;
    for(const p of list){
      if(p.sku) out.push(wooProductSummary(p.sku,p));
      if(String(p.type||'').toLowerCase()==='variable'){
        for(let vp=1; vp<=20; vp++){
          const vars=await wooRequest(`/products/${p.id}/variations?per_page=100&page=${vp}`,{method:'GET'});
          if(!Array.isArray(vars)||!vars.length) break;
          for(const v of vars){if(v.sku) out.push(wooProductSummary(v.sku,{...v,parent_id:p.id,type:'variation',name:`${p.name}${v.name&&v.name!==p.name?' - '+v.name:''}`}));}
          if(vars.length<100) break;
        }
      }
    }
    if(list.length<100) break;
  }
  const seen=new Set(); return out.filter(p=>p.sku&&!seen.has(p.sku)&&seen.add(p.sku));
}
// ACF-Lieferzeiten aus WooCommerce-Produkt-Metadaten lesen (wenn über REST verfügbar).
const wooProductDeliveryCache = new Map();   // key -> { value, at }; Einträge verfallen nach 1 Stunde (WOO-02)
const WOO_DELIVERY_CACHE_MS = 60 * 60 * 1000;
async function wooDeliveryDaysForItem(item) {
  const productId=Number(item.product_id||0), variationId=Number(item.variation_id||0);
  if(!productId) return null;
  const key=`${productId}:${variationId}`;
  const cached=wooProductDeliveryCache.get(key);
  if(cached && Date.now()-cached.at<WOO_DELIVERY_CACHE_MS) return cached.value;
  const meta=(p,k)=>{const raw=(p?.meta_data||[]).find(m=>m.key===k)?.value ?? p?.acf?.[k] ?? p?.[k] ?? '';return String(raw??'').trim();};
  const days=s=>{const matches=String(s||'').toLowerCase().match(/\d+/g);if(!matches)return 0;const n=Math.max(...matches.map(Number));return /woche/.test(s.toLowerCase())?n*7:/tag/.test(s.toLowerCase())?n:0;};
  try {
    let delivery='';
    if(variationId){
      const variation=await wooRequest(`/products/${productId}/variations/${variationId}`,{method:'GET'});
      delivery=meta(variation,'lieferzeit');
      if(!delivery){
        const parent=await wooRequest(`/products/${productId}`,{method:'GET'});
        if(variation.manage_stock){delivery=meta(parent,(variation.on_backorder || variation.stock_status==='onbackorder')?'lieferzeit_lieferrueckstand':'lieferzeit_lager');}
      }
    }else{
      const product=await wooRequest(`/products/${productId}`,{method:'GET'});
      delivery=meta(product,'lieferzeit');
    }
    // Leere bzw. nicht freigegebene ACF-Felder dürfen kein erfundenes Datum erzeugen.
    const value=delivery?days(delivery):null;
    wooProductDeliveryCache.set(key,{value,at:Date.now()});return value;
  }catch(e){console.warn('Woo Lieferzeit nicht verfügbar:',key,e.message);return null;}
}
async function enrichWooOrder(o){
  const normalized=normalizeWooOrder(o);
  const explicit=o.latest_shipping_date || (o.meta_data||[]).find(m=>m.key==='latest_shipping_date'||m.key==='_mykothek_latest_shipping_date')?.value;
  if(explicit){const value=String(explicit);normalized.latest_shipping_date=/^\d{2}\.\d{2}\.\d{4}$/.test(value)?value.slice(6)+'-'+value.slice(3,5)+'-'+value.slice(0,2):value;return normalized;}
  const lengths=await Promise.all((o.line_items||[]).map(wooDeliveryDaysForItem));
  if(!lengths.length || lengths.some(v=>v===null) || Math.max(...lengths)<=0) return normalized;
  const created=String(o.date_created||'').slice(0,10);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(created))return normalized;
  const date=new Date(`${created}T12:00:00Z`);date.setUTCDate(date.getUTCDate()+Math.max(...lengths));
  normalized.latest_shipping_date=date.toISOString().slice(0,10);
  return normalized;
}
async function wooListActiveOrders(onProgress=()=>{}){
  const result=[];
  for(const status of ['processing','on-hold']){
    onProgress(`Lade WooCommerce-Bestellungen: ${status} …`);
    for(let page=1;page<=20;page++){
      const list=await wooRequest(`/orders?status=${status}&per_page=100&page=${page}&orderby=date&order=asc`,{method:'GET'});
      if(!Array.isArray(list)||!list.length)break;
      onProgress(`${status}: ${result.length + list.length} Bestellungen gefunden, Lieferdaten werden gelesen …`);
      result.push(...await Promise.all(list.map(enrichWooOrder)));
      if(list.length<100)break;
    }
  }
  return result;
}

async function wooReadOrderById(id){
  try { return await wooRequest(`/orders/${encodeURIComponent(id)}`, {method:'GET'}); }
  catch(err){
    if(String(err && err.message || '').startsWith('WooCommerce 404:')) return null;
    throw err;
  }
}



// Stücklisten / Sets 1.4.62: Eine Verkaufs-SKU kann mehrere interne Lagerartikel reservieren.
// COD-02/M16: Standard-Stücklisten. Die gültigen Rezepte stehen in den Daten (db.setBoms); dies ist nur der Startwert.
const SET_BOMS_DEFAULT = {
  'Ppul_Exp_150g': [
    {sku:'Ppul_Kör_150g', qty:1, label:'Lungenseitling Körnerbrut 150 g'},
    {sku:'INT_Stroh_500g', qty:1, label:'Strohpellets 500 g'},
    {sku:'INT_Nadelholz_500g', qty:1, label:'Nadelholzpellets 500 g'}
  ],
  'Ppul_Exp_600g': [
    {sku:'Ppul_Kör_600g', qty:1, label:'Lungenseitling Körnerbrut 600 g'},
    {sku:'INT_Stroh_2000g', qty:1, label:'Strohpellets 2000 g'},
    {sku:'INT_Nadelholz_2000g', qty:1, label:'Nadelholzpellets 2000 g'}
  ],
  'Ppul_Exp_1000g': [
    {sku:'Ppul_Kör_1000g', qty:1, label:'Lungenseitling Körnerbrut 1000 g'},
    {sku:'INT_Stroh_3500g', qty:1, label:'Strohpellets 3500 g'},
    {sku:'INT_Nadelholz_3500g', qty:1, label:'Nadelholzpellets 3500 g'}
  ],
  'Trio_Düb_225stk': [
    {sku:'Ledo_Düb_75stk',qty:1,label:'Shiitake Dübel 75 Stk.'},{sku:'Ppul_Düb_75stk',qty:1,label:'Lungenseitling Dübel 75 Stk.'},{sku:'Fvel_Düb_75stk',qty:1,label:'Samtfussrübling Dübel 75 Stk.'}
  ],
  'Trio_Düb_450stk': [
    {sku:'Ledo_Düb_150stk',qty:1,label:'Shiitake Dübel 150 Stk.'},{sku:'Ppul_Düb_150stk',qty:1,label:'Lungenseitling Dübel 150 Stk.'},{sku:'Fvel_Düb_150stk',qty:1,label:'Samtfussrübling Dübel 150 Stk.'}
  ],
  'Star_Düb_225stk': [
    {sku:'Post_Düb_75stk',qty:1,label:'Austernseitling Dübel 75 Stk.'},{sku:'Ppul_Düb_75stk',qty:1,label:'Lungenseitling Dübel 75 Stk.'},{sku:'Kmut_Düb_Bu_75stk',qty:1,label:'Stockschwämmchen Dübel 75 Stk.'}
  ],
  'Star_Düb_450stk': [
    {sku:'Post_Düb_150stk',qty:1,label:'Austernseitling Dübel 150 Stk.'},{sku:'Ppul_Düb_150stk',qty:1,label:'Lungenseitling Dübel 150 Stk.'},{sku:'Kmut_Düb_Bu_150stk',qty:1,label:'Stockschwämmchen Dübel 150 Stk.'}
  ]
};
function setBom(db, sku){ const m=db&&db.setBoms; return (m && Array.isArray(m[String(sku||'')]) && m[String(sku||'')].length) ? m[String(sku||'')] : null; }
function dedupeProductCatalog(db){
  if(!Array.isArray(db.productCatalog)) db.productCatalog=[];
  const bySku=new Map(), idMap=new Map(), out=[];
  const meaningfulArea=a=>a && !['unassigned','other'].includes(String(a));
  for(const item of db.productCatalog){
    const sku=String(item?.sku||'').trim();
    if(!sku){ out.push(item); continue; }
    const key=sku.toLowerCase();
    if(!bySku.has(key)){ bySku.set(key,item); out.push(item); continue; }
    const keep=bySku.get(key), drop=item;
    if(drop.id && keep.id) idMap.set(String(drop.id),String(keep.id));
    // Bestand niemals addieren: doppelte Katalogzeilen stellen denselben physischen Bestand dar.
    keep.qty=Math.max(Number(keep.qty)||0,Number(drop.qty)||0);
    if(!meaningfulArea(keep.area) && meaningfulArea(drop.area)) keep.area=drop.area;
    if((!keep.stockMode || keep.stockMode==='none') && drop.stockMode && drop.stockMode!=='none') keep.stockMode=drop.stockMode;
    if(!keep.name && drop.name) keep.name=drop.name;
    if(!keep.storageLocation && drop.storageLocation) keep.storageLocation=drop.storageLocation;
    if(!keep.defaultLocationId && drop.defaultLocationId) keep.defaultLocationId=drop.defaultLocationId;
    keep.syncActive=Boolean(keep.syncActive || drop.syncActive);
    keep.active=keep.active!==false || drop.active!==false;
    keep.internalOnly=Boolean(keep.internalOnly && drop.internalOnly);
  }
  db.productCatalog=out;
  if(idMap.size){
    for(const t of (db.stockTransactions||[])) if(t.productId && idMap.has(String(t.productId))) t.productId=idMap.get(String(t.productId));
    for(const r of (db.wooReservations||[])) if(r.collection==='productCatalog' && r.batchId && idMap.has(String(r.batchId))) r.batchId=idMap.get(String(r.batchId));
  }
  return idMap.size;
}

// COD-02: Der Katalog richtet sich nach den Daten. Für jede Komponente eines Set-Rezepts (db.setBoms), die noch keinen
// Katalogeintrag hat, wird ein interner Eintrag angelegt. Bereich und Bestandsart ergeben sich aus der SKU-Schreibweise.
function inferCatalogKind(sku){
  const s=String(sku||'');
  if(s.startsWith('INT_')) return {area:'rawmaterials',stockMode:'simple'};
  if(s.includes('_Kör_')) return {area:'kb',stockMode:'batch'};
  if(s.includes('_Düb_')) return {area:'dowels',stockMode:'batch'};
  if(s.includes('_Flü_')) return {area:'syringes',stockMode:'batch'};
  return {area:'other',stockMode:'batch'};
}
function ensureSetCatalog(db){
  if(!Array.isArray(db.productCatalog)) db.productCatalog=[];
  for(const comps of Object.values(db.setBoms||{})){
    for(const c of (Array.isArray(comps)?comps:[])){
      const sku=String(c&&c.sku||''); if(!sku || db.productCatalog.some(p=>p.sku===sku)) continue;
      const {area,stockMode}=inferCatalogKind(sku);
      db.productCatalog.push({id:'INT-'+sku,sku,name:String(c.label||sku),area,stockMode,qty:0,active:true,syncActive:false,internalOnly:true});
    }
  }
}

// INT-10 (b): fehlende Menge zählt als 1, eine ausdrückliche 0 bleibt 0 (früher wurde 0 zu 1 und erzeugte Phantom-Bestand)
function qtyOrOne(v) { if (v === undefined || v === null || v === '') return 1; const n = Number(v); return Number.isFinite(n) ? Math.max(0, n) : 1; }
function isArchivedStockStatus(status) {
  const s = String(status || '').toLowerCase();
  return ['verkauft','archiviert','aufgebraucht','verbraucht','kontaminiert','entsorgt'].includes(s);
}
function catalogItem(db, sku) {
  return (db.productCatalog || []).find(p => String(p.sku || '') === String(sku || '') && p.active !== false) || null;
}
// Angebrochene 1000er-Dübelpakete und angebrochene Körnerbrut sind keine vollständigen Verkaufsprodukte mehr (nicht verkäuflich).
function is1000Dowel(x) { return !!x && x.type==='Dübel' && /(^|\D)1000(\D|$)/.test(String(x.size||x.variant||'')); }
function batchRowsForSku(db, sku) {
  const rows = [];
  const add = (collection, list, filter = () => true, dateKey = 'date') => {
    for (const x of (list || [])) {
      if (String(x.sku || '') !== String(sku || '') || isArchivedStockStatus(x.status) || !filter(x)) continue;
      rows.push({ collection, id: x.id, date: x[dateKey] || x.date || x.packDate || '', qty: qtyOrOne(x.qty), storageLocation: x.storageLocation || '', orderId: x.orderId || null, orderItemId: x.orderItemId || null });
    }
  };
  add('goods', db.goods, x => ['Spritzen','Dübel','Dübel-Set'].includes(x.type) && !(x.type==='Dübel' && is1000Dowel(x) && x.anbruch) && (x.type!=='Dübel' && x.type!=='Dübel-Set' || String(x.status||'').toLowerCase()==='fertig durchwachsen'));
  // Körnerbrut ist erst verkaufs-/reservierbar, wenn sie ausdrücklich im Kühlschrank liegt.
  // 'am durchwachsen' und andere Zwischenstatus dürfen weder Woo-Bestand noch FIFO erhöhen.
  add('kb', db.kb, x => String(x.status || '').toLowerCase() === 'im kühlschrank' && !x.anbruch);
  add('sub', db.sub, x => !x.forTest && String(x.status||'').toLowerCase()==='fertig durchwachsen');
  add('lots', db.lots, () => true, 'packDate');
  add('logs', db.logs, x => String(x.status||'').toLowerCase()==='fertig durchwachsen');
  return rows.sort((a,b) => String(a.date || '').localeCompare(String(b.date || '')) || String(a.id).localeCompare(String(b.id), 'de', {numeric:true}));
}
function activeReservations(db, exceptOrderId = null) {
  return (db.wooReservations || []).filter(r => r.status === 'reserved' && (exceptOrderId == null || String(r.orderId) !== String(exceptOrderId)));
}
function reservedQtyForBatch(db, collection, id, exceptOrderId = null) {
  return activeReservations(db, exceptOrderId).filter(r => r.collection === collection && String(r.batchId || '') === String(id || '')).reduce((a,r)=>a+(Number(r.qty)||0),0);
}
function reservedSimpleQty(db, sku, exceptOrderId = null) {
  return activeReservations(db, exceptOrderId).filter(r => r.collection === 'productCatalog' && String(r.sku || '') === String(sku || '')).reduce((a,r)=>a+(Number(r.qty)||0),0);
}
function productionReserveForSku(db, sku) {
  // Produktionsreserve aus Mindestbestände/Verkaufsreserve: diese Menge bleibt intern
  // geschützt und darf weder an Woo gemeldet noch für Bestellungen reserviert werden.
  // Bei älteren/doppelten Definitionen verwenden wir bewusst den höchsten aktiven Wert
  // statt die Werte zu addieren.
  return (db.minStocks || [])
    .filter(m => String(m.sku || '') === String(sku || '') && m.reserveActive !== false && m.reserveActive !== 'nein')
    .reduce((max,m) => Math.max(max, Math.max(0, Number(m.reserve) || 0)), 0);
}
function allocatableStock(db, sku, exceptOrderId = null, forSet = false) {
  const cat = catalogItem(db, sku);
  let available = cat && cat.stockMode === 'simple'
    ? Math.max(0, (Number(cat.qty)||0) - reservedSimpleQty(db, sku, exceptOrderId))
    : batchRowsForSku(db, sku).reduce((sum,b)=>sum + Math.max(0, b.qty - reservedQtyForBatch(db,b.collection,b.id,exceptOrderId)),0);
  available=Math.max(0,available-productionReserveForSku(db,sku));
  // Eine einstellbare Set-Reserve schützt z.B. 1-kg-Lungenseitlingsbrut vor Einzelverkäufen.
  // Stücklisten selbst dürfen auf diese zusätzliche Set-Reserve zugreifen.
  if(!forSet && cat && Number(cat.setReserve)>0) available=Math.max(0,available-Number(cat.setReserve));
  return available;
}
function saleableStock(db, sku) {
  const bom=setBom(db,sku);
  if(bom) return Math.max(0, Math.floor(Math.min(...bom.map(c=>allocatableStock(db,c.sku,null,true)/(Number(c.qty)||1)))));
  return Math.max(0, Math.floor(allocatableStock(db, sku, null, false)));
}
// INT-07: Der Server ist die einzige Stelle, die den Bestand rechnet. Der Browser zeigt diese Zahlen nur an.
// «available» ist genau der Wert, der an WooCommerce gemeldet wird (saleableStock).
function stockBreakdown(db, sku) {
  const bom = setBom(db, sku);
  const available = saleableStock(db, sku);
  if (bom) return { physical: available, reserved: 0, productionReserve: 0, reserve: 0, available, set: true };
  const cat = catalogItem(db, sku);
  const physical = cat && cat.stockMode === 'simple' ? (Number(cat.qty)||0) : batchRowsForSku(db, sku).reduce((a,b)=>a+(Number(b.qty)||0),0);
  const reserved = (db.wooReservations||[]).filter(r=>r.status==='reserved' && String(r.sku||'')===String(sku||'')).reduce((a,r)=>a+(Number(r.qty)||0),0);
  return { physical: Math.max(0,physical), reserved: Math.max(0,reserved), productionReserve: productionReserveForSku(db, sku), reserve: Math.max(0, Number(cat?.setReserve)||0), available };
}
function stockMap(db) {
  const skus = new Set();
  for (const k of ['productCatalog','minStocks','dk','kb','sub','lots','logs','goods','petri','buckets']) for (const x of (db[k]||[])) if (x && x.sku) skus.add(String(x.sku));
  for (const sku of Object.keys(db.setBoms||{})) skus.add(sku);
  for (const sku of (db.wooSync?.selectedSkus || [])) if (sku) skus.add(String(sku));
  const out = {};
  for (const sku of [...skus].sort()) out[sku] = stockBreakdown(db, sku);
  return out;
}
function allSyncSkus(db) {
  const skus=new Set((db.productCatalog || []).filter(p => p.active !== false && p.syncActive && p.sku).map(p => String(p.sku)));
  for(const sku of (db.wooSync?.selectedSkus || [])) if(sku) skus.add(String(sku));
  return [...skus];
}
function addSyncLog(db, entry) {
  if (!Array.isArray(db.wooSyncLog)) db.wooSyncLog = [];
  db.wooSyncLog.unshift({ id:'WSL-'+Date.now()+'-'+Math.random().toString(36).slice(2,7), at:new Date().toISOString(), ...entry });
  db.wooSyncLog = db.wooSyncLog.slice(0,500);
}
async function syncSkuToWoo(db, sku, reason='Bestandsänderung') {
  const cat = catalogItem(db, sku);
  const selected=(db.wooSync?.selectedSkus || []).includes(sku);
  if (!(cat?.syncActive || selected)) return {sku, skipped:true};
  const stock = saleableStock(db, sku);
  try {
    const product = await wooFindProductBySku(sku);
    if (!product) throw new Error('SKU in WooCommerce nicht gefunden.');
    const payload = { stock_quantity: stock, stock_status: stock > 0 ? 'instock' : 'outofstock' };
    if (!product.manage_stock) payload.manage_stock = true;
    const endpoint = wooProductApiPath(product);
    const before = product.stock_quantity;
    const updated = await wooRequest(endpoint, { method:'PUT', body:JSON.stringify(payload) });
    const verified = await wooReadProductState(updated || product);
    const ok = Number(verified.stock_quantity) === stock;
    addSyncLog(db,{sku,reason,stock,before,status:ok?'ok':'error',message:ok?'WooCommerce synchronisiert.':`Kontrollbestand ${verified.stock_quantity} statt ${stock}.`});
    return {sku,stock,ok};
  } catch (err) {
    addSyncLog(db,{sku,reason,stock,status:'pending',message:err.message});
    return {sku,stock,ok:false,error:err.message};
  }
}
async function syncChangedSkus(oldDb, newDb, reason='Bestandsänderung') {
  if (!wooConfigured()) return [];
  const oldSync = new Set(allSyncSkus(oldDb));
  const newSync = new Set(allSyncSkus(newDb));
  const candidates = new Set([...oldSync, ...newSync]);
  // Neu aktivierte Auto-Sync-SKUs werden sofort initial nach WooCommerce geschrieben,
  // auch wenn sich der interne Bestand beim Einschalten selbst nicht verändert hat.
  const changed = [...candidates].filter(sku =>
    (newSync.has(sku) && !oldSync.has(sku)) ||
    saleableStock(oldDb,sku) !== saleableStock(newDb,sku)
  );
  const results=[];
  for (const sku of changed) {
    const initial = newSync.has(sku) && !oldSync.has(sku);
    results.push(await syncSkuToWoo(newDb,sku,initial ? 'Auto-Sync aktiviert – Initialbestand' : reason));
  }
  return results;
}
function normalizeWooOrder(o) {
  return {
    id:o.id, number:o.number, status:o.status, date_created:o.date_created, date_modified:o.date_modified||'',
    customer:[o.shipping?.first_name,o.shipping?.last_name].filter(Boolean).join(' ') || [o.billing?.first_name,o.billing?.last_name].filter(Boolean).join(' '),
    shipping:minimizeContact(o.shipping), billing:minimizeContact(o.billing), payment_method:o.payment_method_title||o.payment_method||'',
    shipping_lines:o.shipping_lines||[], shipping_method:o.shipping_method||'', latest_shipping_date:o.latest_shipping_date||'', customer_note:String(o.customer_note||''),
    items:(o.line_items||[]).map(i=>({id:i.id,name:i.name,sku:i.sku||'',quantity:Number(i.quantity)||0,product_id:i.product_id,variation_id:i.variation_id,total:i.total}))
  };
}

function isTerminalWooStatus(status) {
  return ['completed','cancelled','refunded','failed','trash'].includes(String(status||'').toLowerCase());
}
function markWooOrderArchived(order, reason='') {
  return {...order, archived:true, archivedAt:new Date().toISOString(), archiveReason:reason||String(order.status||'')};
}

function releaseOrderReservations(db, orderId, status='released') {
  for (const r of (db.wooReservations || [])) if (String(r.orderId)===String(orderId) && r.status==='reserved') { r.status=status; r.releasedAt=new Date().toISOString(); }
}
function reserveOrderFifo(db, order) {
  if (!Array.isArray(db.wooReservations)) db.wooReservations=[];
  if (!Array.isArray(db.productionRequests)) db.productionRequests=[];
  releaseOrderReservations(db, order.id, 'replaced');
  // INT-07: Die alten Reservierungen dieser Bestellung sind jetzt 'replaced'. Alle Verfügbarkeitsrechnungen unten zählen deshalb
  // auch die Reservierungen mit, die in dieser Schleife für frühere Positionen derselben Bestellung entstehen (kein doppeltes Reservieren derselben Charge).
  const created=[];
  for (const item of (order.items||[])) {
    let need = Number(item.quantity)||0;
    const bom=setBom(db,item.sku);
    if(bom){
      for(const component of bom){
        let componentNeed=need*(Number(component.qty)||1);
        const componentAllocatable=allocatableStock(db,component.sku,null,true);
        const componentReserveNeed=Math.min(componentNeed,componentAllocatable);
        const cat=catalogItem(db,component.sku);
        if(cat && cat.stockMode==='simple'){
          const take=Math.min(componentReserveNeed,Math.max(0,(Number(cat.qty)||0)-reservedSimpleQty(db,component.sku,null)));
          if(take>0){const r={id:'WR-'+Date.now()+'-'+Math.random().toString(36).slice(2,8),orderId:order.id,orderNumber:order.number,itemId:item.id,sku:component.sku,parentSku:item.sku,name:component.label||component.sku,collection:'productCatalog',batchId:cat.id,qty:take,storageLocation:cat.storageLocation||'',status:'reserved',createdAt:new Date().toISOString()};db.wooReservations.push(r);created.push(r);}
        }else{
          let left=componentReserveNeed;
          for(const b of batchRowsForSku(db,component.sku)){
            if(left<=0)break;
            const available=Math.max(0,b.qty-reservedQtyForBatch(db,b.collection,b.id,null)); const take=Math.min(left,available);
            if(take>0){const r={id:'WR-'+Date.now()+'-'+Math.random().toString(36).slice(2,8),orderId:order.id,orderNumber:order.number,itemId:item.id,sku:component.sku,parentSku:item.sku,name:component.label||component.sku,collection:b.collection,batchId:b.id,qty:take,storageLocation:b.storageLocation||'',status:'reserved',createdAt:new Date().toISOString()};db.wooReservations.push(r);created.push(r);left-=take;}
          }
        }
        const got=(db.wooReservations||[]).filter(r=>r.status==='reserved'&&String(r.orderId)===String(order.id)&&String(r.itemId)===String(item.id)&&r.sku===component.sku).reduce((a,r)=>a+(Number(r.qty)||0),0);
        const shortage=Math.max(0,componentNeed-got);
        const reqId='BOM-'+order.id+'-'+item.id+'-'+component.sku;
        const existing=db.productionRequests.find(r=>r.id===reqId);
        // Für unbezahlte (wartende) Bestellungen wird nur reserviert, aber noch nichts zur Produktion aufgeboten.
        if(order.status==='on-hold'){ /* keine Produktionsaufträge */ }
        else if(shortage>0){
          const area=(catalogItem(db,component.sku)?.area)|| (component.sku.includes('_Kör_')?'kb':'other');
          const req={id:reqId,orderId:order.id,orderNumber:order.number,itemId:item.id,sku:component.sku,parentSku:item.sku,name:component.label||component.sku,qty:shortage,area,status:'offen',autoBom:true,createdAt:existing?.createdAt||new Date().toISOString()};
          if(existing) Object.assign(existing,req); else db.productionRequests.push(req);
        } else if(existing && existing.autoBom) existing.status='erledigt';
      }
      continue;
    }
    const cat = catalogItem(db,item.sku);
    need=Math.min(need,allocatableStock(db,item.sku,null,false));
    if (cat && cat.stockMode === 'simple') {
      const take=Math.min(need, Math.max(0,(Number(cat.qty)||0)-reservedSimpleQty(db,item.sku,null)));
      if(take>0){ const r={id:'WR-'+Date.now()+'-'+Math.random().toString(36).slice(2,8),orderId:order.id,orderNumber:order.number,itemId:item.id,sku:item.sku,name:item.name,collection:'productCatalog',batchId:cat.id,qty:take,storageLocation:cat.storageLocation||'',status:'reserved',createdAt:new Date().toISOString()}; db.wooReservations.push(r); created.push(r); need-=take; }
    } else {
      // Ware, die ausdrücklich für diese Bestellposition produziert wurde, hat Vorrang
      // vor dem allgemeinen FIFO-Bestand. So deckt z.B. ein fertig durchwachsener
      // Bestell-Substratsack genau seine Bestellung und wird nicht als freie Ware behandelt.
      const batches=batchRowsForSku(db,item.sku).sort((a,b)=>{
        const ap=String(a.orderId||'')===String(order.id)&&String(a.orderItemId||'')===String(item.id)?0:1;
        const bp=String(b.orderId||'')===String(order.id)&&String(b.orderItemId||'')===String(item.id)?0:1;
        return ap-bp || String(a.date||'').localeCompare(String(b.date||'')) || String(a.id).localeCompare(String(b.id),'de',{numeric:true});
      });
      for (const b of batches) {
        if(need<=0) break;
        // Bestellgebundene Ware einer anderen noch aktiven processing-Bestellung bleibt geschützt.
        // Nach Storno/Freigabe darf die bereits hergestellte Ware wieder als normaler Bestand dienen.
        if(b.orderId && (String(b.orderId)!==String(order.id) || String(b.orderItemId||'')!==String(item.id))) {
          const ownerActive=(db.wooOrders||[]).some(o=>String(o.id)===String(b.orderId)&&['processing','on-hold'].includes(String(o.status||'').toLowerCase())&&!o.archived&&!o.externalDeleted);
          if(ownerActive) continue;
        }
        const available=Math.max(0,b.qty-reservedQtyForBatch(db,b.collection,b.id,null));
        const take=Math.min(need,available);
        if(take>0){ const r={id:'WR-'+Date.now()+'-'+Math.random().toString(36).slice(2,8),orderId:order.id,orderNumber:order.number,itemId:item.id,sku:item.sku,name:item.name,collection:b.collection,batchId:b.id,qty:take,storageLocation:b.storageLocation||'',status:'reserved',createdAt:new Date().toISOString()}; db.wooReservations.push(r); created.push(r); need-=take; }
      }
    }
  }
  return created;
}

function rebuildProcessingReservations(db) {
  // Bezahlte Bestellungen (processing) haben Vorrang vor wartenden (on-hold, z. B. Vorauskasse); innerhalb gleich nach Bestelldatum.
  const rank=o=>o.status==='processing'?0:1;
  const processing=(db.wooOrders||[]).filter(o=>['processing','on-hold'].includes(o.status)&&!o.archived&&!o.externalDeleted).sort((a,b)=>rank(a)-rank(b)||String(a.date_created||'').localeCompare(String(b.date_created||''))||Number(a.id||0)-Number(b.id||0));
  const prevReserved=(db.wooReservations||[]).filter(r=>r.status==='reserved'); const prevSet=new Set(prevReserved);
  for(const r of prevReserved) { r.status='replaced'; r.releasedAt=new Date().toISOString(); }
  for(const o of processing) reserveOrderFifo(db,o);
  // Tempo: Eine unveränderte Reservierung behält ihren bisherigen Datensatz (sonst entstehen bei jedem Speichern neue «ersetzte» Einträge,
  // die das Dokument aufblähen und jedes Speichern verlangsamen).
  const keyOf=r=>[r.orderId,r.itemId,r.sku,r.parentSku||'',r.collection,r.batchId,r.qty,r.storageLocation||''].join('|');
  const pool=new Map(); for(const r of prevReserved){ const k=keyOf(r); if(!pool.has(k)) pool.set(k,[]); pool.get(k).push(r); }
  const drop=new Set();
  for(const r of (db.wooReservations||[])) if(r.status==='reserved' && !prevSet.has(r)) {
    const list=pool.get(keyOf(r));
    if(list && list.length) { const old=list.shift(); old.status='reserved'; delete old.releasedAt; drop.add(r); }
  }
  if(drop.size) db.wooReservations=db.wooReservations.filter(r=>!drop.has(r));
}

function consumeOrderReservations(db, orderId) {
  for (const r of (db.wooReservations||[]).filter(r=>String(r.orderId)===String(orderId)&&r.status==='reserved')) {
    if(r.collection==='productCatalog') {
      const p=(db.productCatalog||[]).find(x=>x.id===r.batchId || x.sku===r.sku); if(p) p.qty=Math.max(0,(Number(p.qty)||0)-(Number(r.qty)||0));
    } else {
      const arr=db[r.collection]||[]; const x=arr.find(v=>String(v.id)===String(r.batchId));
      if(x){ const q=qtyOrOne(x.qty), left=Math.max(0,q-(Number(r.qty)||0)); if('qty' in x) x.qty=left; if(left<=0 || !('qty' in x)) { x.status='verkauft'; x.finishedAt=new Date().toISOString().slice(0,10); } }
    }
    r.status='consumed'; r.consumedAt=new Date().toISOString();
  }
}

// ---------------------------------------------------------------------------
// WooCommerce-Abgleich in zwei Phasen:
//  1. Lesen (langsam, Netzwerk): ohne Sperre, damit Speichern und Webhooks nicht blockiert werden.
//  2. Anwenden (schnell): unter der Sperre auf dem dann aktuellen Datenstand.
// ---------------------------------------------------------------------------
async function fetchWooReconcileData(knownOrders, onProgress=()=>{}) {
  // Neue processing/on-hold Bestellungen zuerst laden, bevor Altbestellungen geprüft werden.
  const active=await wooListActiveOrders(onProgress);
  onProgress(`${active.length} aktive Bestellungen geladen …`);
  const activeById=new Map(active.map(o=>[String(o.id),o]));
  const known=new Map();
  const toCheck=[];
  for(const local of knownOrders){
    const id=String(local.id);
    if(activeById.has(id)){ known.set(id,{remote:activeById.get(id)}); continue; }
    // Archivierte und extern gelöschte Bestellungen werden nicht mehr einzeln abgefragt (WOO-02).
    if(local.externalDeleted || local.archived) continue;
    toCheck.push(local);
  }
  onProgress('Prüfe vorhandene Bestellungen auf Änderungen …');
  for(let i=0;i<toCheck.length;i++){
    if(i%5===0) onProgress(`Prüfe bestehende Bestellungen: ${i+1} von ${toCheck.length} …`);
    const raw=await wooReadOrderById(toCheck[i].id);
    // Bestellungen, die in WooCommerce in den Papierkorb verschoben oder endgültig gelöscht wurden, werden erkannt.
    if(!raw || String(raw.status||'').toLowerCase()==='trash') known.set(String(toCheck[i].id),{missing:true});
    else known.set(String(toCheck[i].id),{remote:await enrichWooOrder(raw)});
  }
  return {active,known};
}
function isOlderThanLocal(remote, local) {
  // Webhooks können während des Lesens neuere Daten geliefert haben; ältere Abgleichsdaten dürfen sie nicht überschreiben.
  return !!(remote?.date_modified && local?.date_modified && String(remote.date_modified) < String(local.date_modified));
}
function applyWooReconcile(db, fetched) {
  if (!Array.isArray(db.wooOrders)) db.wooOrders=[];
  if (!Array.isArray(db.productionRequests)) db.productionRequests=[];
  const summary={checked:0,updated:0,deleted:0,imported:0};
  for(const order of fetched.active) {
    const idx=db.wooOrders.findIndex(x=>String(x.id)===String(order.id));
    if(idx<0){ db.wooOrders.push({...order,archived:false}); summary.imported++; }
    else if(db.wooOrders[idx].externalDeleted || db.wooOrders[idx].archived){
      if(isOlderThanLocal(order,db.wooOrders[idx])) continue;
      db.wooOrders[idx]={...order,internal_note:db.wooOrders[idx].internal_note||'',manual_shipping_date:db.wooOrders[idx].manual_shipping_date||'',externalDeleted:false,archived:false,archivedAt:'',archiveReason:''}; summary.imported++;
    }
  }
  for (let i=0;i<db.wooOrders.length;i++) {
    const local=db.wooOrders[i];
    const f=fetched.known.get(String(local.id));
    if(!f || local.externalDeleted) continue;
    summary.checked++;
    if(f.missing) {
      const oldStatus=local.status||'';
      releaseOrderReservations(db,local.id,'external-deleted');
      for(const pr of db.productionRequests) if(String(pr.orderId)===String(local.id) && pr.status!=='erledigt') {
        pr.status='erledigt'; pr.externalDeleted=true; pr.finishedAt=new Date().toISOString();
      }
      db.wooOrders[i]={...local,previousStatus:oldStatus,status:'external-deleted',externalDeleted:true,externalDeletedAt:new Date().toISOString()};
      addSyncLog(db,{sku:'*',reason:`Woo Bestellung #${local.number||local.id} extern gelöscht`,status:'info',message:'Reservierungen freigegeben; Bestellung lokal archiviert.'});
      summary.deleted++;
      continue;
    }
    const remote=f.remote;
    if(isOlderThanLocal(remote,local)) continue;
    const previous=String(local.status||'');
    if(remote.status==='completed' && previous!=='completed') consumeOrderReservations(db,remote.id);
    else if(!['processing','on-hold'].includes(remote.status)) releaseOrderReservations(db,remote.id,'released');
    db.wooOrders[i]=isTerminalWooStatus(remote.status) ? markWooOrderArchived({...remote,internal_note:local.internal_note||'',manual_shipping_date:local.manual_shipping_date||''}, remote.status) : {...remote,internal_note:local.internal_note||'',manual_shipping_date:local.manual_shipping_date||'',archived:false,archivedAt:'',archiveReason:''};
    if(previous!==String(remote.status||'')) summary.updated++;
  }
  // Alle aktuell verarbeitbaren Bestellungen in stabiler Reihenfolge neu FIFO reservieren.
  rebuildProcessingReservations(db);
  return summary;
}

async function runWooReconcile(onProgress=()=>{}) {
  onProgress('Starte WooCommerce-Abgleich …');
  const snapshot=await readData();
  const fetched=await fetchWooReconcileData(snapshot.wooOrders||[],onProgress);   // langsam, ohne Sperre
  onProgress('Synchronisiere Lagerbestand und speichere …');
  return withStateLock(async()=>{
    const db=await readData(); const before=JSON.parse(JSON.stringify(db));
    const summary=applyWooReconcile(db,fetched);
    await writeData(db,'server_limited');
    const syncResults=await syncChangedSkus(before,db,'Bestellungen mit WooCommerce abgeglichen');
    if(syncResults.length) await persistSyncLog(db);
    return {summary,db};
  });
}
// Optionaler automatischer Abgleich (AUTO_RECONCILE_HOURS, z. B. 24): fängt Bestellungen auf, die ein Webhook verpasst hat.
async function autoReconcile() {
  if (!wooConfigured()) return;
  const {summary}=await runWooReconcile();
  if (summary.imported || summary.updated || summary.deleted) console.log('Automatischer WooCommerce-Abgleich:', JSON.stringify(summary));
}

// ---------------------------------------------------------------------------
// Bestellereignisse (Webhook). Läuft nur noch über die Warteschlange und unter der Sperre.
// ---------------------------------------------------------------------------
async function processWooOrderEvent(rawOrder, source='webhook', topic='') {
  // WooCommerce meldet bei «order.deleted» noch den letzten Status; gelöscht bedeutet hier Papierkorb.
  if (topic === 'order.deleted') rawOrder = { ...rawOrder, status: 'trash' };
  const order=await enrichWooOrder(rawOrder);   // Netzwerkzugriffe bewusst vor der Sperre
  return withStateLock(async () => {
    const db=await readData();
    const before=JSON.parse(JSON.stringify(db));
    const idx=(db.wooOrders||[]).findIndex(x=>String(x.id)===String(order.id));
    const terminal=isTerminalWooStatus(order.status);
    let ignored=null;

    // Ein älteres Ereignis (z. B. verspätete Wiederholung) darf einen neueren Stand nicht zurücksetzen.
    if(idx>=0 && isOlderThanLocal(order,db.wooOrders[idx])) {
      ignored=`Quelle: ${source}; veraltetes Ereignis ignoriert.`;
    }
    // Neue Bestellungen werden nur dann in die aktive Pilzverwaltung übernommen,
    // wenn WooCommerce sie tatsächlich als "processing" oder "on-hold" meldet.
    else if(idx<0 && !['processing','on-hold'].includes(order.status)) {
      ignored=`Quelle: ${source}; nicht importiert (nur processing/on-hold wird neu übernommen).`;
    }
    // Bereits archivierte/abgeschlossene Bestellungen werden durch verspätete
    // Webhook-Wiederholungen nicht wieder aktiviert. Ein echtes Wiederöffnen auf
    // processing wird beim manuellen Woo-Abgleich sicher erkannt.
    else if(idx>=0 && db.wooOrders[idx].archived && ['processing','on-hold'].includes(order.status)) {
      ignored=`Quelle: ${source}; ignoriert, da lokal bereits abgeschlossen. Mit WooCommerce abgleichen zum Wiederöffnen.`;
    }
    if(ignored) {
      addSyncLog(db,{sku:'*',reason:`Woo Bestellung #${order.number} → ${order.status}`,status:'info',message:ignored});
      await persistSyncLog(db);
      return {order,ignored:true,reservations:[]};
    }

    if(['processing','on-hold'].includes(order.status)) {
      const active={...order,internal_note:idx>=0?(db.wooOrders[idx].internal_note||''):'',manual_shipping_date:idx>=0?(db.wooOrders[idx].manual_shipping_date||''):'',archived:false,archivedAt:'',archiveReason:'',externalDeleted:false};
      if(idx>=0) db.wooOrders[idx]=active; else db.wooOrders.push(active);
      reserveOrderFifo(db,active);   // processing und on-hold (Vorauskasse) reservieren; Storno/Ablehnung gibt über den Endstatus wieder frei
    } else if(terminal) {
      if(order.status==='completed') consumeOrderReservations(db,order.id);
      else releaseOrderReservations(db,order.id,'released');
      if(idx>=0) db.wooOrders[idx]=markWooOrderArchived({...order,internal_note:db.wooOrders[idx].internal_note||'',manual_shipping_date:db.wooOrders[idx].manual_shipping_date||''},order.status);
    } else {
      if(idx>=0) db.wooOrders[idx]={...order,internal_note:db.wooOrders[idx].internal_note||'',manual_shipping_date:db.wooOrders[idx].manual_shipping_date||'',archived:false};
      releaseOrderReservations(db,order.id,'released');
    }

    // Frei gewordene Ware (Storno, Abschluss) geht sofort an wartende Bestellungen; die Zuteilung ist dieselbe wie beim Speichern (bezahlte zuerst, dann nach Datum).
    rebuildProcessingReservations(db);
    addSyncLog(db,{sku:'*',reason:`Woo Bestellung #${order.number} → ${order.status}`,status:'info',message:`Quelle: ${source}${terminal?'; Bestellung abgeschlossen/archiviert.':''}`});
    // Erst speichern, dann an WooCommerce melden (INT-05): Schlägt das Speichern fehl, hat der Shop keinen Bestand erhalten,
    // den die Pilzverwaltung nicht kennt. Fehlgeschlagene Meldungen werden als «pending» protokolliert und automatisch wiederholt.
    await writeData(db,'server_limited');
    const syncResults=await syncChangedSkus(before,db,`Woo Bestellung #${order.number}`);
    if(syncResults.length) await persistSyncLog(db);
    return {order,reservations:(db.wooReservations||[]).filter(r=>String(r.orderId)===String(order.id)&&r.status==='reserved')};
  });
}
function verifyWooWebhook(rawBody, signature) {
  if(!WC_WEBHOOK_SECRET) return false;
  const expected=crypto.createHmac('sha256',WC_WEBHOOK_SECRET).update(rawBody).digest('base64');
  try { return crypto.timingSafeEqual(Buffer.from(expected),Buffer.from(String(signature||''))); } catch (_) { return false; }
}

// ---------------------------------------------------------------------------
// Webhook-Warteschlange (INT-02, INT-05): Der Webhook wird sofort in der Datenbank abgelegt und mit 200 quittiert.
// Die Verarbeitung erfolgt nacheinander; Fehler werden mit steigenden Abständen wiederholt.
// ---------------------------------------------------------------------------
let webhookQueueRunning = false;
function kickWebhookQueue() {
  setImmediate(() => runWebhookQueue().catch(err => console.error('Webhook-Warteschlange:', err)));
}
async function runWebhookQueue() {
  if (webhookQueueRunning || !pool) return;
  webhookQueueRunning = true;
  try {
    for (let n = 0; n < 100; n++) {
      await ensurePostgres();
      const q = await pool.query(`SELECT id, payload, topic, attempts FROM app_webhook_queue WHERE status='pending' AND next_attempt_at <= now() ORDER BY id LIMIT 1`);
      if (!q.rows.length) break;
      const job = q.rows[0];
      try {
        await processWooOrderEvent(job.payload, 'webhook', job.topic);
        await pool.query(`UPDATE app_webhook_queue SET status='done', processed_at=now(), attempts=attempts+1, last_error=NULL, payload=jsonb_build_object('id', payload->'id', 'number', payload->'number', 'status', payload->'status') WHERE id=$1`, [job.id]);
        // DSG-03: Nach erfolgreicher Verarbeitung bleiben von der Bestellung nur Nummer und Status im Warteschlangen-Eintrag (keine Adresse, E-Mail, Telefon).
      } catch (err) {
        const attempts = job.attempts + 1;
        const failed = attempts >= WEBHOOK_MAX_ATTEMPTS;
        const delaySec = Math.min(3600, 30 * 2 ** Math.min(attempts - 1, 7));
        console.error(`Webhook ${job.id} (Versuch ${attempts}) fehlgeschlagen:`, err.message);
        await pool.query(
          `UPDATE app_webhook_queue SET attempts=$2, status=$3, last_error=$4, next_attempt_at = now() + ($5 || ' seconds')::interval WHERE id=$1`,
          [job.id, attempts, failed ? 'failed' : 'pending', String(err.message || err).slice(0, 500), String(delaySec)]
        );
        if (failed) notifyAlert(`Bestellung aus WooCommerce konnte nach ${attempts} Versuchen nicht verarbeitet werden (Webhook ${job.id}): ${String(err.message || err).slice(0, 200)}`);
      }
    }
  } finally { webhookQueueRunning = false; }
}

// Fehlgeschlagene Bestandsmeldungen an WooCommerce automatisch wiederholen (höchstens 6 Versuche in Folge je SKU).
async function retryPendingSyncs() {
  if (!wooConfigured()) return;
  await withStateLock(async () => {
    const db = await readData();
    const recent = new Map();   // sku -> Anzahl aufeinanderfolgender Fehler (Protokoll ist neueste-zuerst)
    const done = new Set();
    for (const e of (db.wooSyncLog || [])) {
      if (!e.sku || e.sku === '*' || done.has(e.sku)) continue;
      if (e.status === 'ok') { done.add(e.sku); continue; }
      if (e.status === 'pending' || e.status === 'error') recent.set(e.sku, (recent.get(e.sku) || 0) + 1);
      else done.add(e.sku);
    }
    const skus = allSyncSkus(db).filter(s => recent.has(s) && recent.get(s) <= 6);
    if (!skus.length) return;
    for (const sku of skus) await syncSkuToWoo(db, sku, 'Automatische Wiederholung');
    await persistSyncLog(db);
    const stuck = skus.filter(s => recent.get(s) === 6);   // genau beim 6. Fehlversuch einmal melden
    if (stuck.length) notifyAlert(`Bestand konnte für ${stuck.length} Artikel wiederholt nicht an WooCommerce gemeldet werden (z. B. ${stuck[0]}).`);
  });
}

// Prüft, ob sich der Browser-Teil der Daten massiv verkleinert (z. B. Reset). Dafür ist das Admin-Passwort nötig.
const BROWSER_COLLECTIONS = Object.keys(DEFAULT_DB).filter(k => Array.isArray(DEFAULT_DB[k]) && !SERVER_OWNED_KEYS.includes(k) && !['productionRequests', 'personalTasks'].includes(k));
function shrinkingCollections(prev, next) {
  return BROWSER_COLLECTIONS.filter(k => {
    const a = (prev[k] || []).length, b = (next[k] || []).length;
    return a >= 10 && b <= a * 0.5;
  });
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function handleApi(req, res) {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api/woo/webhook') {
    if (req.method !== 'POST') return sendJson(res,405,{error:'Nur POST erlaubt.'});
    try {
      const raw=await readBody(req, WEBHOOK_BODY);
      const signature=req.headers['x-wc-webhook-signature'];
      // Beim erstmaligen Aktivieren sendet WooCommerce einen Ping an die Delivery-URL.
      // Dieser kann ohne Webhook-Signatur eintreffen und darf niemals eine Lageraktion auslösen.
      // Unsigned POSTs werden deshalb nur als Erreichbarkeitstest mit 200 bestätigt und ignoriert.
      if(!signature) return sendJson(res,200,{ok:true,ping:true,ignored:true});
      if(!verifyWooWebhook(raw,signature)) return sendJson(res,401,{error:'Ungültige WooCommerce-Webhook-Signatur. WC_WEBHOOK_SECRET prüfen.'});
      let order;
      try { order=JSON.parse(raw||'{}'); }
      catch (_) { return sendJson(res,200,{ok:true,ping:true,ignored:true}); }   // signierter Ping (webhook_id=…) ist kein JSON
      // WOO-01: Nur Bestell-Ereignisse zählen. Produkt- oder Kunden-Webhooks auf dieselbe URL werden ignoriert.
      const topic=String(req.headers['x-wc-webhook-topic']||'');
      const looksLikeOrder=order && typeof order==='object' && Number.isFinite(Number(order.id)) && Array.isArray(order.line_items);
      if((topic && !/^order\./.test(topic)) || !looksLikeOrder) return sendJson(res,200,{ok:true,ignored:true,reason:'kein Bestell-Ereignis'});
      await ensurePostgres();
      const ins=await pool.query(`INSERT INTO app_webhook_queue(topic, order_id, payload) VALUES($1,$2,$3) RETURNING id`,[topic.slice(0,60),String(order.id),order]);
      kickWebhookQueue();
      return sendJson(res,200,{ok:true,queued:true,id:ins.rows[0].id,orderId:order.id});
    } catch(err){
      // Ein 5xx lässt WooCommerce die Zustellung wiederholen. Nichts wurde gespeichert.
      return failJson(res,err,500,'Webhook konnte nicht angenommen werden.');
    }
  }

  if (url.pathname === '/api/health') {
    // Öffentlich und ohne Daten. Mit ?strict=1 antwortet er bei Problemen mit 503 (für Uptime-Monitore).
    try {
      const q = await webhookQueueStats();
      const problems = [];
      if (q.failed > 0) problems.push(`${q.failed} Bestellung(en) nicht verarbeitet`);
      if (q.oldest_pending_seconds > 900) problems.push('Webhook-Warteschlange staut sich');
      const strict = url.searchParams.get('strict') === '1';
      return sendJson(res, strict && problems.length ? 503 : 200, { ok: problems.length === 0, storage: 'postgres', database: true, webhookQueue: { pending: q.pending, failed: q.failed }, problems, version: APP_VERSION, time: new Date().toISOString() });
    } catch (err) {
      console.error('Health:', err.message);
      return sendJson(res, 503, { ok: false, storage: 'postgres', database: false, problems: ['Datenbank nicht erreichbar'], time: new Date().toISOString() });
    }
  }

  req.pilzAuth = await loadSessionKind(req);

  // Geräteerkennung für noch nicht freigegebene Browser. Legt keine Einträge mehr an (SEC-07).
  if (url.pathname === '/api/device-self') {
    try {
      const d = await currentDevice(req);
      const approvedCount = await approvedDeviceCount();
      const enforcement = await deviceEnforcementEnabled();
      return sendJson(res,200,{id:d?.id||null,name:d?.name||'',approved:!!d?.approved,enforcement,bootstrap:enforcement && approvedCount===0});
    } catch(err){ console.error(err); return sendJson(res,500,{error:'Geräteerkennung fehlgeschlagen.'}); }
  }

  // Normaler Zugang: APP_PASSWORD ist immer erforderlich, unabhängig davon,
  // ob die Gerätesperre ein- oder ausgeschaltet ist. Die erfolgreiche Anmeldung
  // erzeugt eine zufällige Sitzung (Datenbank) und einen HttpOnly-Cookie. RESCUE_PASSWORD ist ein
  // unabhängiger Notfallzugang und umgeht die Gerätefreigabe.
  if (url.pathname === '/api/login') {
    if (req.method !== 'POST') return sendJson(res,405,{error:'Nur POST erlaubt.'});
    if (!APP_PASSWORD) return sendJson(res, 503, { error: 'APP_PASSWORD muss gesetzt sein.' });
    try {
      const wait = loginLockSeconds(req);
      if (wait) return sendJson(res, 429, { error: `Zu viele Fehlversuche. Bitte in ${wait} Sekunden erneut versuchen.` }, { 'Retry-After': String(wait) });
      const body = await readJson(req, LOGIN_BODY);
      const password = String(body.password || '').slice(0, 500);
      const isRescue = !!RESCUE_PASSWORD && safeEqual(password, RESCUE_PASSWORD);
      const isApp = safeEqual(password, APP_PASSWORD);
      if (!isRescue && !isApp) { registerLoginFailure(req); await sleep(400); return sendJson(res, 401, { error: 'Falsches Passwort.' }); }
      clearLoginFailures(req);
      if (isRescue) {
        const token = await createSession(req, 'rescue');
        return sendJson(res, 200, { ok:true, rescue:true }, { 'Set-Cookie': sessionCookie(token) });
      }
      // Das Gerät wird erst nach korrektem Passwort registriert.
      const t = await touchDevice(req, { create: true });
      const d = t.device;
      const cookies = t.setCookie ? [t.setCookie] : [];
      if (!d) return sendJson(res, 403, { error: 'Dieses Gerät konnte nicht registriert werden.', code:'DEVICE_NOT_APPROVED' });
      const enforcement = await deviceEnforcementEnabled();
      if (enforcement && !d.approved) {
        const n = await approvedDeviceCount();
        if (n === 0) {
          await updateDevice(Number(d.id), { approved:true, name:d.name || 'Erstes Admin-Gerät' });
        } else {
          return sendJson(res, 403, { error: 'Dieses Gerät ist noch nicht freigegeben. Bitte in der Geräteverwaltung freigeben oder den Rescue-Zugang verwenden.', code:'DEVICE_NOT_APPROVED', deviceId:d.id }, cookies.length ? { 'Set-Cookie': cookies } : {});
        }
      }
      const token = await createSession(req, 'app');
      return sendJson(res, 200, { ok:true, rescue:false, enforcement }, { 'Set-Cookie': [sessionCookie(token), ...cookies] });
    } catch (err) { return failJson(res, err, 500, 'Anmeldung fehlgeschlagen.'); }
  }

  if (url.pathname === '/api/logout') {
    if (req.method !== 'POST') return sendJson(res,405,{error:'Nur POST erlaubt.'});
    try { await destroySession(req); } catch (err) { console.error(err); }
    return sendJson(res, 200, { ok:true }, { 'Set-Cookie': expiredSessionCookie() });
  }

  // Zentraler Schalter für die Gerätesperre. Nur mit Admin-Passwort änderbar.
  // Der Endpunkt liegt bewusst vor der Gerätesperre, damit sie mit APP_PASSWORD
  // auch wieder aktiviert werden kann, wenn das aktuelle Gerät noch nicht freigegeben ist.
  if (url.pathname === '/api/device-enforcement') {
    if (req.method === 'GET') return sendJson(res,200,{enforcement:await deviceEnforcementEnabled()});
    if (req.method !== 'POST') return sendJson(res,405,{error:'Nur GET/POST erlaubt.'});
    if (requireAuth(req,res)) return;
    try {
      const body=await readJson(req);
      if (typeof body.enforcement !== 'boolean') return sendJson(res,400,{error:'enforcement muss true oder false sein.'});
      return sendJson(res,200,{ok:true,enforcement:await setDeviceEnforcement(body.enforcement)});
    } catch(err){ return failJson(res,err,400,'Gerätesperre konnte nicht geändert werden.'); }
  }

  // Ab hier ist für sämtliche internen API-Funktionen zuerst eine Anmeldung Pflicht.
  // Bei aktiver Gerätesperre muss zusätzlich das Gerät freigegeben sein. Ein gültiger
  // Rescue-Zugang darf die Gerätesperre im Notfall umgehen.
  if (requireAppLogin(req, res)) return;
  if (authKind(req) !== 'rescue' && await requireApprovedDevice(req, res)) return;
  await touchDevice(req).catch(err => console.warn('Geräteerkennung:', err.message));

  if (url.pathname === '/api/qr') {
    const data = url.searchParams.get('data') || '';
    if (!data) return send(res, 400, 'QR-Daten fehlen');
    if (data.length > 500) return send(res, 400, 'QR-Daten zu lang');
    if (!QRCode) return send(res, 500, 'QR-Modul fehlt');
    try {
      const svg = await QRCode.toString(data, { type: 'svg', errorCorrectionLevel: 'M', margin: 1, width: 220 });
      return send(res, 200, svg, 'image/svg+xml; charset=utf-8');
    } catch (err) {
      console.error(err);
      return send(res, 500, 'QR konnte nicht erstellt werden');
    }
  }

  if (url.pathname === '/api/set-boms') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Nur POST erlaubt.' });
    // Rezepte bestimmen den Bestand, der an WooCommerce gemeldet wird: nur mit Admin-Passwort.
    if (!isAuthorized(req)) return sendJson(res, 401, { error: 'Admin-Passwort erforderlich.' });
    try {
      const body = await readJson(req);
      const action = body.action;
      const sku = String(body.sku || '').trim();
      if (!['upsert', 'delete'].includes(action)) return sendJson(res, 400, { error: 'Unbekannte Aktion.' });
      if (!sku || sku.length > 100) return sendJson(res, 400, { error: 'Set-SKU fehlt oder ist zu lang.' });
      let comps = null;
      if (action === 'upsert') {
        if (!Array.isArray(body.components) || body.components.length < 1 || body.components.length > 20) return sendJson(res, 400, { error: 'Ein Set braucht 1 bis 20 Komponenten.' });
        comps = [];
        for (const c of body.components) {
          const csku = String(c && c.sku || '').trim(); const qty = Number(c && c.qty);
          if (!csku || csku.length > 100) return sendJson(res, 400, { error: 'Komponenten-SKU fehlt.' });
          if (!Number.isInteger(qty) || qty < 1 || qty > 1000) return sendJson(res, 400, { error: `Menge für ${csku} muss eine ganze Zahl von 1 bis 1000 sein.` });
          if (csku === sku) return sendJson(res, 400, { error: 'Ein Set kann nicht sich selbst enthalten.' });
          comps.push({ sku: csku, qty, label: String(c.label || '').trim().slice(0, 200) });
        }
        if (new Set(comps.map(c => c.sku)).size !== comps.length) return sendJson(res, 400, { error: 'Eine Komponente kommt doppelt vor.' });
      }
      const out = await withStateLock(async () => {
        const db = await readData(); const before = JSON.parse(JSON.stringify(db));
        if (!db.setBoms || typeof db.setBoms !== 'object') db.setBoms = {};
        if (action === 'delete') { delete db.setBoms[sku]; }
        else {
          // Keine Verschachtelung: eine Komponente darf kein anderes Set sein, und das neue Set darf nirgends Komponente sein.
          for (const c of comps) if (db.setBoms[c.sku]) throw httpError(400, `${c.sku} ist selbst ein Set und kann keine Komponente sein.`);
          for (const [k, list] of Object.entries(db.setBoms)) if (k !== sku && list.some(x => x.sku === sku)) throw httpError(400, `${sku} wird im Set ${k} als Komponente verwendet und kann kein Set sein.`);
          db.setBoms[sku] = comps;
        }
        ensureSetCatalog(db);
        rebuildProcessingReservations(db);
        const saved = await writeData(db, 'server_limited');
        const syncResults = await syncChangedSkus(before, db, 'Set-Rezept geändert');
        if (syncResults.length) await persistSyncLog(db);
        return { db, saved, syncResults };
      });
      return sendJson(res, 200, { ok: true, setBoms: out.db.setBoms, productCatalog: out.db.productCatalog, wooReservations: out.db.wooReservations, wooSyncLog: out.db.wooSyncLog, stock: stockMap(out.db), version: out.saved.version, syncResults: out.syncResults });
    } catch (err) { return failJson(res, err, 500, 'Rezept konnte nicht gespeichert werden.'); }
  }

  if (url.pathname === '/api/stock') {
    try {
      const st = await readState();
      return sendJson(res, 200, { ok:true, version: st.version, stock: stockMap(st.db) });
    } catch (err) { return failJson(res, err, 500, 'Bestand konnte nicht berechnet werden.'); }
  }

  if (url.pathname === '/api/live-state') {
    try {
      await ensurePostgres();
      const meta = await pool.query(`SELECT updated_at, ${VERSION_SQL} AS version FROM app_state WHERE id = 1`);
      return sendJson(res, 200, { ok:true, updatedAt: meta.rows[0]?.updated_at || null, version: meta.rows[0]?.version || 'none' });
    } catch (err) {
      console.error(err);
      return sendJson(res, 500, { error: 'Live-Status konnte nicht geladen werden.' });
    }
  }

  if (url.pathname === '/api/status') {
    try { return sendJson(res, 200, await systemStatus()); }
    catch (err) { console.error(err); return sendJson(res, 500, { error: 'Systemstatus konnte nicht geladen werden.' }); }
  }

  if (url.pathname === '/api/undo-last') {
    if (req.method !== 'POST') return sendJson(res,405,{error:'Nur POST erlaubt.'});
    try { return sendJson(res,200,{ok:true,...await withStateLock(() => undoLastChange())}); }
    catch(err){ return failJson(res,err,500,'Rückgängig machen fehlgeschlagen.'); }
  }

  if (url.pathname === '/api/backups') {
    try {
      if (req.method === 'POST') return sendJson(res, 200, { ok: true, backup: await createManualBackup() });
      return sendJson(res, 200, { ok: true, backups: await listBackups() });
    } catch (err) { console.error(err); return sendJson(res, 500, { error: 'Backup konnte nicht verarbeitet werden.' }); }
  }

  // Ein Backup einspielen ersetzt alle Daten: nur mit Admin-Passwort (SEC-06). Der aktuelle Stand wird vorher als «undo»-Backup gesichert.
  if (url.pathname === '/api/restore') {
    if (req.method !== 'POST') return sendJson(res,405,{error:'Nur POST erlaubt.'});
    if (requireAuth(req, res)) return;
    try {
      const body = await readJson(req);
      const saved = await withStateLock(() => restoreBackup(body.id));
      return sendJson(res, 200, { ok: true, version: saved.version });
    } catch (err) { return failJson(res, err, 500, 'Backup konnte nicht wiederhergestellt werden.'); }
  }

  if (url.pathname === '/api/devices') {
    // Nur die Geräteverwaltung selbst benötigt zusätzlich das Admin-Passwort.
    if (requireAuth(req,res)) return;
    if (req.method === 'GET') return sendJson(res,200,{ enforcement:await deviceEnforcementEnabled(), devices:await listDevices() });
    if (req.method === 'POST') {
      try { const body=await readJson(req); return sendJson(res,200,{ok:true,device:await updateDevice(Number(body.id),body)}); }
      catch(err){ return failJson(res,err,400,'Gerät konnte nicht geändert werden.'); }
    }
    return sendJson(res,405,{error:'Nur GET/POST erlaubt.'});
  }

  // Schlanker, atomarer Teamaufgaben-Endpunkt: kein Woo-Abgleich, keine Lager-Neuberechnung.
  if (url.pathname === '/api/personal-tasks') {
    if (req.method !== 'POST') return sendJson(res,405,{error:'Nur POST erlaubt.'});
    try {
      const body=await readJson(req);
      const action=body.action;
      if (!['upsert','delete','toggle','addCategory'].includes(action)) return sendJson(res,400,{error:'Unbekannte Aktion.'});
      if (action==='upsert' && (!body.task || typeof body.task.id!=='string' || typeof body.task.title!=='string' || !body.task.title.trim())) return sendJson(res,400,{error:'Titel fehlt.'});
      if (action==='addCategory' && (typeof body.category!=='string' || !body.category.trim())) return sendJson(res,400,{error:'Kategorie fehlt.'});
      if (['delete','toggle'].includes(action) && typeof body.id!=='string') return sendJson(res,400,{error:'ID fehlt.'});
      const out = await withStateLock(async () => {
        await ensurePostgres();
        const client=await pool.connect();
        let broken=false;
        try {
          await client.query('BEGIN');
          const locked=await client.query(`SELECT data, ${VERSION_SQL} AS version FROM app_state WHERE id=1 FOR UPDATE`);
          if (!locked.rows.length) throw new Error('App-Daten fehlen.');
          const original=locked.rows[0].data;
          const prevVersion=locked.rows[0].version;
          const tasks=Array.isArray(original.personalTasks)?[...original.personalTasks]:[];
          const categories=Array.isArray(original.personalTaskCategories)?[...original.personalTaskCategories]:[];
          if (action==='upsert') {
            const t=body.task;
            const clean={id:t.id.slice(0,120),title:t.title.trim().slice(0,500),category:String(t.category||'Allgemein').slice(0,120),description:String(t.description||'').slice(0,20000),due:String(t.due||'').slice(0,10),assignee:String(t.assignee||'Andere').slice(0,120),done:!!t.done,createdAt:String(t.createdAt||new Date().toISOString())};
            const i=tasks.findIndex(x=>x.id===clean.id);
            if(i>=0) tasks[i]={...tasks[i],...clean}; else tasks.push(clean);
          } else if(action==='delete') {
            const i=tasks.findIndex(x=>x.id===body.id);if(i>=0)tasks.splice(i,1);
          } else if(action==='toggle') {
            const t=tasks.find(x=>x.id===body.id);if(t)t.done=!!body.done;
          } else if(action==='addCategory') {
            const name=body.category.trim().slice(0,120);
            if(![...categories,'Allgemein',...tasks.map(t=>t.category)].some(c=>String(c).toLocaleLowerCase('de')===name.toLocaleLowerCase('de')))categories.push(name);
          }
          await client.query('INSERT INTO app_backups(data, backup_kind) VALUES($1,$2)',[original,'change_limited']);
          await client.query(`DELETE FROM app_backups WHERE backup_kind='change_limited' AND id NOT IN (SELECT id FROM app_backups WHERE backup_kind='change_limited' ORDER BY id DESC LIMIT 50)`);
          const updated=await client.query(`UPDATE app_state SET data=jsonb_set(jsonb_set(data::jsonb,'{personalTasks}',$1::jsonb,true),'{personalTaskCategories}',$2::jsonb,true),updated_at=now() WHERE id=1 RETURNING updated_at, ${VERSION_SQL} AS version`,[JSON.stringify(tasks),JSON.stringify(categories)]);
          await client.query('COMMIT');
          return {tasks,categories,updatedAt:updated.rows[0].updated_at,version:updated.rows[0].version,prevVersion};
        } catch (e) {
          broken=true;
          await client.query('ROLLBACK').catch(()=>{});
          throw e;
        } finally { client.release(broken); }
      });
      return sendJson(res,200,{ok:true,personalTasks:out.tasks,personalTaskCategories:out.categories,updatedAt:out.updatedAt,version:out.version,prevVersion:out.prevVersion});
    } catch(err) {
      console.error('Teamaufgaben:',err);
      return failJson(res,err,500,'Teamaufgabe konnte nicht gespeichert werden.');
    }
  }

  if (url.pathname === '/api/data') {
    if (req.method === 'GET') {
      try {
        const { db, version } = await readState();
        return sendJson(res, 200, db, { 'X-Data-Version': version });
      }
      catch (err) { console.error(err); return sendJson(res, 500, { error: 'Daten konnten nicht gelesen werden.' }); }
    }
    if (req.method === 'POST') {
      try {
        const parsed = normalizeDb(await readJson(req, MAX_BODY));
        const baseVersion = String(req.headers['x-data-version'] || '');
        const out = await withStateLock(async () => {
          const { db: previous, version } = await readState();
          // INT-01/INT-03: Nur wer auf dem aktuellen Stand aufbaut, darf speichern. Sonst würde ein Browser mit
          // älterem Stand fremde Änderungen (andere Geräte, ausgebuchte Chargen durch Webhooks) überschreiben.
          if (baseVersion !== version) throw httpError(409, 'Die Daten wurden inzwischen geändert (anderes Gerät oder WooCommerce-Bestellung). Ihre letzte Änderung wurde NICHT gespeichert. Die aktuellen Daten werden jetzt geladen; bitte die Änderung danach wiederholen.', 'STALE_DATA');
          // SEC-06: Massenlöschen (z. B. Reset) braucht das Admin-Passwort.
          const shrunk = shrinkingCollections(previous, parsed);
          if (shrunk.length && !isAuthorized(req)) throw httpError(403, `Diese Änderung würde viele Datensätze löschen (${shrunk.join(', ')}). Dafür ist das Admin-Passwort nötig.`, 'ADMIN_CONFIRM_REQUIRED');
          // Woo-Bestellungen, Reservierungen und Sync-Protokoll sind servergeführt. So kann ein Webhook
          // nicht durch einen gleichzeitig geöffneten Browser mit älterem Datenstand überschrieben werden.
          parsed.wooOrders = previous.wooOrders || [];
          ensureSetCatalog(parsed);
          dedupeProductCatalog(parsed);
          parsed.setBoms = previous.setBoms;
          parsed.wooReservations = previous.wooReservations || [];
          parsed.wooSyncLog = previous.wooSyncLog || [];
          rebuildProcessingReservations(parsed);
          // Erst speichern, dann an WooCommerce melden (INT-05).
          const saved = await writeData(parsed, 'change_limited');
          const syncResults = await syncChangedSkus(previous, parsed, 'Pilzverwaltung geändert');
          if (syncResults.length) await persistSyncLog(parsed);
          return { saved, syncResults, prevVersion: version };
        });
        return sendJson(res, 200, { ok: true, savedAt: new Date().toISOString(), syncResults: out.syncResults, wooOrders: parsed.wooOrders, wooReservations: parsed.wooReservations, wooSyncLog: parsed.wooSyncLog, stock: stockMap(parsed), version: out.saved.version, prevVersion: out.prevVersion });
      } catch (err) {
        return failJson(res, err, 500, 'Daten konnten nicht gespeichert werden.');
      }
    }
    return sendJson(res,405,{error:'Nur GET/POST erlaubt.'});
  }


  if (url.pathname === '/api/woo/status') {
    return sendJson(res, 200, {
      configured: wooConfigured(),
      store: WC_STORE_URL || '',
      webhookConfigured: !!WC_WEBHOOK_SECRET,
      webhookUrl: WC_STORE_URL ? '' : '',
      message: wooConfigured() ? 'WooCommerce-Zugangsdaten sind gesetzt.' : 'Bitte WC_STORE_URL, WC_CONSUMER_KEY und WC_CONSUMER_SECRET bei Render hinterlegen.'
    });
  }


  if (url.pathname === '/api/woo/catalog') {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'Nur GET erlaubt.' });
    try { return sendJson(res, 200, { ok:true, products: await wooListAllProductsWithSkus() }); }
    catch (err) { console.error(err); return sendJson(res, 500, { error: err.message || 'WooCommerce-Produktpalette konnte nicht geladen werden.' }); }
  }

  if (url.pathname === '/api/woo/reconcile-progress') {
    if(req.method!=='GET') return sendJson(res,405,{error:'Nur GET erlaubt.'});
    const key=String(url.searchParams.get('id')||'');
    return sendJson(res,200,wooReconcileProgress.get(key)||{message:'Noch kein Abgleich gestartet.',done:false});
  }
  if (url.pathname === '/api/woo/refresh-orders' || url.pathname === '/api/woo/reconcile-orders') {
    if (req.method !== 'POST') return sendJson(res,405,{error:'Nur POST erlaubt.'});
    const progressId=String(url.searchParams.get('progressId')||'').slice(0,100);
    const progress=message=>{if(progressId){ wooReconcileProgress.set(progressId,{message,done:false,at:Date.now()}); if(wooReconcileProgress.size>50){ const oldest=[...wooReconcileProgress.entries()].sort((a,b)=>a[1].at-b[1].at)[0]; if(oldest) wooReconcileProgress.delete(oldest[0]); } }};
    try {
      const out=await runWooReconcile(progress);
      if(progressId)wooReconcileProgress.set(progressId,{message:'Abgleich abgeschlossen.',done:true,at:Date.now()});
      return sendJson(res,200,{ok:true,summary:out.summary,orders:out.db.wooOrders,reservations:out.db.wooReservations||[],wooSyncLog:out.db.wooSyncLog||[]});
    } catch(err){
      if(progressId)wooReconcileProgress.set(progressId,{message:'Abgleich fehlgeschlagen.',done:true,at:Date.now()});
      return failJson(res,err,500,err.message||'Bestellungen konnten nicht mit WooCommerce abgeglichen werden.');
    }
  }
  if (url.pathname === '/api/woo/order-internal-note') {
    if (req.method !== 'POST') return sendJson(res,405,{error:'Nur POST erlaubt.'});
    try {
      const body=await readJson(req);
      const note=String(body.note||'');
      if(note.length>10000) return sendJson(res,400,{error:'Bemerkung ist zu lang (max. 10000 Zeichen).'});
      const out=await withStateLock(async()=>{
        const db=await readData();
        const order=(db.wooOrders||[]).find(o=>String(o.id)===String(body.id));
        if(!order) throw httpError(404,'Bestellung nicht gefunden.');
        order.internal_note=note;
        await writeData(db,'server_limited');
        return db.wooOrders;
      });
      return sendJson(res,200,{ok:true,orders:out});
    } catch(err){ return failJson(res,err,500,'Bemerkung konnte nicht gespeichert werden.'); }
  }
  if (url.pathname === '/api/woo/order-manual-date') {
    if (req.method !== 'POST') return sendJson(res,405,{error:'Nur POST erlaubt.'});
    try {
      const body=await readJson(req);
      const date=String(body.date||'').trim();
      if(date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date+'T12:00:00Z')) || new Date(date+'T12:00:00Z').toISOString().slice(0,10)!==date)) return sendJson(res,400,{error:'Ungültiges Datum.'});
      const out=await withStateLock(async()=>{
        const db=await readData();
        const order=(db.wooOrders||[]).find(o=>String(o.id)===String(body.id));
        if(!order) throw httpError(404,'Bestellung nicht gefunden.');
        order.manual_shipping_date=date;
        await writeData(db,'server_limited');
        return db.wooOrders;
      });
      return sendJson(res,200,{ok:true,orders:out});
    } catch(err){ return failJson(res,err,500,'Wunschdatum konnte nicht gespeichert werden.'); }
  }
  if (url.pathname === '/api/woo/delete-local-order') {
    if (req.method !== 'POST') return sendJson(res,405,{error:'Nur POST erlaubt.'});
    try {
      const body=await readJson(req); const id=body.id;
      const out=await withStateLock(async()=>{
        const db=await readData(); const order=(db.wooOrders||[]).find(o=>String(o.id)===String(id));
        if(!order) throw httpError(404,'Lokale Bestellung nicht gefunden.');
        if(!order.externalDeleted && order.status!=='external-deleted') throw httpError(409,'Nur bereits als extern gelöscht erkannte Bestellungen können lokal endgültig gelöscht werden.');
        db.wooOrders=(db.wooOrders||[]).filter(o=>String(o.id)!==String(id));
        db.wooReservations=(db.wooReservations||[]).filter(r=>String(r.orderId)!==String(id));
        db.productionRequests=(db.productionRequests||[]).filter(r=>String(r.orderId)!==String(id));
        addSyncLog(db,{sku:'*',reason:`Bestellung #${order.number||order.id} lokal gelöscht`,status:'info',message:'Bereits extern gelöschte Bestellung endgültig aus der Pilzverwaltung entfernt.'});
        await writeData(db,'server_limited');
        return db;
      });
      return sendJson(res,200,{ok:true,orders:out.wooOrders,reservations:out.wooReservations||[],wooSyncLog:out.wooSyncLog||[]});
    } catch(err){return failJson(res,err,500,'Lokale Bestellung konnte nicht gelöscht werden.');}
  }
  if (url.pathname === '/api/woo/retry-sync') {
    if (req.method !== 'POST') return sendJson(res,405,{error:'Nur POST erlaubt.'});
    try {
      const results=await withStateLock(async()=>{
        const db=await readData(); const results=[];
        for(const sku of allSyncSkus(db)) results.push(await syncSkuToWoo(db,sku,'Manueller Sync-Wiederholungsversuch'));
        await persistSyncLog(db);
        return results;
      });
      return sendJson(res,200,{ok:true,results});
    }
    catch(err){return failJson(res,err,500,'Sync konnte nicht wiederholt werden.');}
  }

  if (url.pathname === '/api/woo/lookup') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Nur POST erlaubt.' });
    try {
      const body = await readJson(req);
      const skus = Array.isArray(body.skus) ? body.skus.slice(0, 100) : [];
      const products = [];
      for (const sku of skus) {
        try { products.push(wooProductSummary(sku, await wooFindProductBySku(sku))); }
        catch (err) { products.push({ sku, found: false, error: err.message }); }
      }
      return sendJson(res, 200, { ok: true, products });
    } catch (err) { return failJson(res, err, 500, 'WooCommerce-Produkte konnten nicht geprüft werden.'); }
  }

  if (url.pathname === '/api/woo/sync-stock') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Nur POST erlaubt.' });
    try {
      const body = await readJson(req);
      const items = Array.isArray(body.items) ? body.items.slice(0, 100) : [];
      const enableManageStock = !!body.enableManageStock;
      const syncDb = await readData();
      const results = [];
      for (const item of items) {
        const sku = String(item.sku || '').trim();
        if (!sku) continue;
        // INT-07: Es zählt allein der Serverbestand, nicht die Zahl, die der Browser mitschickt.
        const stock = Math.max(0, Math.floor(saleableStock(syncDb, sku)));
        try {
          const product = await wooFindProductBySku(sku);
          if (!product) { results.push({ sku, found: false, error: 'SKU in WooCommerce nicht gefunden.' }); continue; }
          if (!product.manage_stock && !enableManageStock) {
            results.push({ ...wooProductSummary(sku, product), error: 'WooCommerce-Bestandsverwaltung ist für dieses Produkt deaktiviert. Im Formular „bei Sync aktivieren“ wählen oder zuerst in WooCommerce aktivieren.' });
            continue;
          }
          const payload = { stock_quantity: stock, stock_status: stock > 0 ? 'instock' : 'outofstock' };
          if (enableManageStock) payload.manage_stock = true;
          const apiPath = wooProductApiPath(product);
          const before = wooProductSummary(sku, product);
          const updated = await wooRequest(apiPath, { method: 'PUT', body: JSON.stringify(payload) });
          const verified = await wooReadProductState(updated || product);
          const verifiedSummary = wooProductSummary(sku, verified);
          const verifiedQty = Number(verifiedSummary.stock_quantity ?? -1);
          const ok = verifiedQty === stock;
          results.push({
            ...verifiedSummary,
            synced: ok,
            requested_stock: stock,
            previous_stock: before.stock_quantity,
            endpoint: apiPath,
            error: ok ? undefined : `Kontroll-Lesen ergab Bestand ${verifiedSummary.stock_quantity ?? '–'} statt ${stock}.`
          });
        } catch (err) { results.push({ sku, found: false, error: err.message }); }
      }
      return sendJson(res, 200, { ok: true, results });
    } catch (err) { return failJson(res, err, 500, 'WooCommerce-Synchronisation fehlgeschlagen.'); }
  }

  if (url.pathname === '/api/export') {
    try {
      const db = await readData();
      return send(res, 200, JSON.stringify(db, null, 2), 'application/json; charset=utf-8', {
        'Content-Disposition': 'attachment; filename="pilzverwaltung-export.json"'
      });
    } catch (err) { console.error(err); return sendJson(res, 500, { error: 'Export fehlgeschlagen.' }); }
  }

  return sendJson(res, 404, { error: 'API-Endpunkt nicht gefunden.' });
}

async function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let filePath = safeDecode(url.pathname);      // fehlerhafte %-Kodierung führt nicht mehr zum Absturz
  if (filePath.includes('\0')) return send(res, 400, 'Ungültiger Pfad');
  if (filePath === '/' || filePath.startsWith('/scan/')) filePath = '/index.html';
  const fullPath = path.join(PUBLIC_DIR, path.normalize(filePath));
  if (fullPath !== PUBLIC_DIR && !fullPath.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden');

  try {
    const data = await fs.readFile(fullPath);
    const ext = path.extname(fullPath).toLowerCase();
    res.writeHead(200, noCacheHeaders({ 'Content-Type': MIME[ext] || 'application/octet-stream' }));
    res.end(data);
  } catch (_) {
    send(res, 404, 'Nicht gefunden');
  }
}

async function handleRequest(req, res) {
  if (req.url.startsWith('/api/')) return handleApi(req, res);
  return serveStatic(req, res);
}

const server = http.createServer((req, res) => {
  // SEC-01: Jeder Fehler wird hier abgefangen; ohne await in handleApi/serveStatic würden Fehler den Prozess beenden.
  handleRequest(req, res).catch(err => {
    console.error('Anfragefehler:', req.method, String(req.url).slice(0, 200), err);
    if (!res.headersSent) { try { sendJson(res, err?.statusCode || 500, { error: err?.statusCode ? err.message : 'Serverfehler.' }); } catch (_) { /* Antwort nicht mehr möglich */ } }
    else { try { res.end(); } catch (_) { /* ignorieren */ } }
  });
});
server.keepAliveTimeout = 65 * 1000;

process.on('unhandledRejection', err => console.error('Unbehandelter Promise-Fehler:', err));
process.on('uncaughtException', err => console.error('Unerwarteter Fehler:', err));
process.on('SIGTERM', () => {
  console.log('SIGTERM empfangen, Server wird beendet.');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 15000).unref();
});

server.listen(PORT, () => {
  console.log(`Pilzverwaltung ${APP_VERSION} läuft auf Port ${PORT}`);
  console.log(`Speicher: Postgres/DATABASE_URL${pool ? '' : ' (nicht verbunden)'}`);
  if (!pool) return;
  const background = (name, fn) => () => fn().catch(err => console.error(`${name} fehlgeschlagen:`, err.message));
  const dailyBackup = background('Tagesbackup', ensureDailyBackup);
  ensurePostgres().then(() => {
    dailyBackup();
    runWebhookQueue().catch(err => console.error('Webhook-Warteschlange:', err));
  }).catch(err => console.error('Datenbank-Initialisierung fehlgeschlagen:', err.message));
  setInterval(dailyBackup, 60 * 60 * 1000);
  setInterval(() => runWebhookQueue().catch(err => console.error('Webhook-Warteschlange:', err)), 15 * 1000);
  setInterval(background('Sync-Wiederholung', retryPendingSyncs), 10 * 60 * 1000);
  const autoHours = Number(process.env.AUTO_RECONCILE_HOURS || 0);
  if (autoHours > 0) {
    console.log(`Automatischer WooCommerce-Abgleich alle ${autoHours} Stunden aktiviert.`);
    setInterval(background('Automatischer Abgleich', autoReconcile), autoHours * 60 * 60 * 1000);
  }
});
