const http = require('http');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

let Pool = null;
let QRCode = null;
try { ({ Pool } = require('pg')); } catch (_) { Pool = null; }
try { QRCode = require('qrcode'); } catch (_) { QRCode = null; }

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'pilzverwaltung.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const MAX_BODY = 50 * 1024 * 1024;
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const DATABASE_URL = process.env.DATABASE_URL || '';

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
  archive: [], minStocks: [], testGroups: [], masterCultures: [], masterCounters: {}
};

let pool = null;
if (DATABASE_URL && Pool) {
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false }
  });
}

function noCacheHeaders(extra = {}) {
  return { 'Cache-Control': 'no-store', ...extra };
}

function send(res, status, body, contentType = 'text/plain; charset=utf-8', headers = {}) {
  res.writeHead(status, noCacheHeaders({ 'Content-Type': contentType, ...headers }));
  res.end(body);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8');
}

function hash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function isAuthorized(req) {
  if (!APP_PASSWORD) return true;
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  return token && hash(token) === hash(APP_PASSWORD);
}

function requireAuth(req, res) {
  if (isAuthorized(req)) return false;
  sendJson(res, 401, { error: 'Nicht angemeldet oder falsches Passwort.' });
  return true;
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > MAX_BODY) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function normalizeDb(data) {
  const db = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  for (const key of Object.keys(DEFAULT_DB)) {
    if (Array.isArray(DEFAULT_DB[key])) {
      if (!Array.isArray(db[key])) db[key] = [];
    } else if (!db[key] || typeof db[key] !== 'object' || Array.isArray(db[key])) {
      db[key] = {};
    }
  }
  return db;
}

async function ensurePostgres() {
  if (!pool) return false;
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
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  return true;
}

async function readData() {
  if (pool) {
    await ensurePostgres();
    const result = await pool.query('SELECT data FROM app_state WHERE id = 1');
    if (!result.rows.length) return normalizeDb(JSON.parse(JSON.stringify(DEFAULT_DB)));
    return normalizeDb(result.rows[0].data);
  }

  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    return normalizeDb(JSON.parse(raw));
  } catch (err) {
    if (err.code === 'ENOENT') return normalizeDb(JSON.parse(JSON.stringify(DEFAULT_DB)));
    throw err;
  }
}

async function writeData(data) {
  const db = normalizeDb(data);
  if (pool) {
    await ensurePostgres();
    const old = await pool.query('SELECT data FROM app_state WHERE id = 1');
    if (old.rows.length) {
      await pool.query('INSERT INTO app_backups(data) VALUES($1)', [old.rows[0].data]);
    }
    await pool.query(`
      INSERT INTO app_state(id, data, updated_at)
      VALUES(1, $1, now())
      ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()
    `, [db]);
    return;
  }

  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(BACKUP_DIR, { recursive: true });
  try {
    const old = await fs.readFile(DATA_FILE, 'utf8');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await fs.writeFile(path.join(BACKUP_DIR, `pilzverwaltung-${stamp}.json`), old, 'utf8');
  } catch (_) {}
  const tmp = DATA_FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(db, null, 2), 'utf8');
  await fs.rename(tmp, DATA_FILE);
}


async function createManualBackup() {
  const db = await readData();
  if (pool) {
    await ensurePostgres();
    const result = await pool.query('INSERT INTO app_backups(data) VALUES($1) RETURNING id, created_at', [db]);
    return result.rows[0];
  }
  await fs.mkdir(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `manual-${stamp}.json`;
  await fs.writeFile(path.join(BACKUP_DIR, filename), JSON.stringify(db, null, 2), 'utf8');
  return { id: filename, created_at: new Date().toISOString() };
}

async function listBackups() {
  if (pool) {
    await ensurePostgres();
    const result = await pool.query(`SELECT id, created_at, pg_column_size(data)::int AS bytes FROM app_backups ORDER BY created_at DESC LIMIT 30`);
    return result.rows.map(r => ({ id: r.id, created_at: r.created_at, bytes: r.bytes }));
  }
  await fs.mkdir(BACKUP_DIR, { recursive: true });
  const files = await fs.readdir(BACKUP_DIR).catch(() => []);
  const rows = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const st = await fs.stat(path.join(BACKUP_DIR, f)).catch(() => null);
    if (st) rows.push({ id: f, created_at: st.mtime.toISOString(), bytes: st.size });
  }
  return rows.sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at))).slice(0,30);
}

async function restoreBackup(id) {
  if (!id) throw new Error('Backup-ID fehlt');
  if (pool) {
    await ensurePostgres();
    const result = await pool.query('SELECT data FROM app_backups WHERE id = $1', [id]);
    if (!result.rows.length) throw new Error('Backup nicht gefunden');
    await writeData(result.rows[0].data);
    return true;
  }
  const file = path.basename(String(id));
  const raw = await fs.readFile(path.join(BACKUP_DIR, file), 'utf8');
  await writeData(JSON.parse(raw));
  return true;
}

async function systemStatus() {
  const db = await readData();
  let dbSize = null;
  let updatedAt = null;
  if (pool) {
    await ensurePostgres();
    const s = await pool.query(`SELECT pg_database_size(current_database())::bigint AS size`);
    dbSize = Number(s.rows[0]?.size || 0);
    const u = await pool.query('SELECT updated_at FROM app_state WHERE id = 1');
    updatedAt = u.rows[0]?.updated_at || null;
  } else {
    const st = await fs.stat(DATA_FILE).catch(()=>null);
    dbSize = st ? st.size : 0;
    updatedAt = st ? st.mtime.toISOString() : null;
  }
  const backups = await listBackups();
  const count = k => Array.isArray(db[k]) ? db[k].length : 0;
  return {
    ok: true,
    version: '1.2.2',
    storage: pool ? 'postgres' : 'json-file',
    time: new Date().toISOString(),
    updatedAt,
    dbSize,
    lastBackup: backups[0] || null,
    counts: {
      dk: count('dk'), petri: count('petri'), lc: count('lc'), kb: count('kb'), sub: count('sub'),
      buckets: count('buckets'), lots: count('lots'), goods: count('goods'), logs: count('logs'),
      archive: count('archive'), masterCultures: count('masterCultures')
    }
  };
}

async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/qr') {
    const data = url.searchParams.get('data') || '';
    if (!data) return send(res, 400, 'QR-Daten fehlen');
    if (!QRCode) return send(res, 500, 'QR-Modul fehlt');
    try {
      const svg = await QRCode.toString(data, { type: 'svg', errorCorrectionLevel: 'M', margin: 1, width: 220 });
      return send(res, 200, svg, 'image/svg+xml; charset=utf-8');
    } catch (err) {
      console.error(err);
      return send(res, 500, 'QR konnte nicht erstellt werden');
    }
  }

  if (url.pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, storage: pool ? 'postgres' : 'json-file', time: new Date().toISOString() });
  }


  if (url.pathname === '/api/status') {
    if (requireAuth(req, res)) return;
    try { return sendJson(res, 200, await systemStatus()); }
    catch (err) { console.error(err); return sendJson(res, 500, { error: 'Systemstatus konnte nicht geladen werden.' }); }
  }

  if (url.pathname === '/api/backups') {
    if (requireAuth(req, res)) return;
    try {
      if (req.method === 'POST') return sendJson(res, 200, { ok: true, backup: await createManualBackup() });
      return sendJson(res, 200, { ok: true, backups: await listBackups() });
    } catch (err) { console.error(err); return sendJson(res, 500, { error: 'Backup konnte nicht verarbeitet werden.' }); }
  }

  if (url.pathname === '/api/restore') {
    if (requireAuth(req, res)) return;
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      await restoreBackup(body.id);
      return sendJson(res, 200, { ok: true });
    } catch (err) { console.error(err); return sendJson(res, 500, { error: 'Backup konnte nicht wiederhergestellt werden.' }); }
  }

  if (url.pathname === '/api/login') {
    if (!APP_PASSWORD) return sendJson(res, 200, { ok: true, auth: 'disabled' });
    const body = JSON.parse(await readBody(req) || '{}');
    if (String(body.password || '') === APP_PASSWORD) return sendJson(res, 200, { ok: true, token: body.password });
    return sendJson(res, 401, { error: 'Falsches Passwort.' });
  }

  if (url.pathname === '/api/data') {
    if (requireAuth(req, res)) return;
    if (req.method === 'GET') {
      try { return sendJson(res, 200, await readData()); }
      catch (err) { console.error(err); return sendJson(res, 500, { error: 'Daten konnten nicht gelesen werden.' }); }
    }
    if (req.method === 'POST') {
      try {
        const parsed = JSON.parse(await readBody(req) || '{}');
        await writeData(parsed);
        return sendJson(res, 200, { ok: true, savedAt: new Date().toISOString() });
      } catch (err) {
        console.error(err);
        return sendJson(res, 500, { error: 'Daten konnten nicht gespeichert werden.' });
      }
    }
  }

  if (url.pathname === '/api/export') {
    if (requireAuth(req, res)) return;
    const db = await readData();
    return send(res, 200, JSON.stringify(db, null, 2), 'application/json; charset=utf-8', {
      'Content-Disposition': 'attachment; filename="pilzverwaltung-export.json"'
    });
  }

  return sendJson(res, 404, { error: 'API-Endpunkt nicht gefunden.' });
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let filePath = decodeURIComponent(url.pathname);
  if (filePath === '/' || filePath.startsWith('/scan/')) filePath = '/index.html';
  const safePath = path.normalize(filePath).replace(/^(\.\.(\/|\\|$))+/, '');
  const fullPath = path.join(PUBLIC_DIR, safePath);
  if (!fullPath.startsWith(PUBLIC_DIR)) return send(res, 403, 'Forbidden');

  try {
    const data = await fs.readFile(fullPath);
    const ext = path.extname(fullPath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  } catch (_) {
    send(res, 404, 'Nicht gefunden');
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith('/api/')) return handleApi(req, res);
    return serveStatic(req, res);
  } catch (err) {
    console.error(err);
    return sendJson(res, 500, { error: 'Serverfehler.' });
  }
});

server.listen(PORT, () => {
  console.log(`Pilzverwaltung 1.2.2 läuft auf Port ${PORT}`);
  console.log(`Speicher: ${pool ? 'Postgres/DATABASE_URL' : DATA_FILE}`);
});
