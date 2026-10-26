const http = require('http');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

let Pool = null;
let QRCode = null;
try { ({ Pool } = require('pg')); } catch (_) { Pool = null; }
try { QRCode = require('qrcode'); } catch (_) { QRCode = null; }

const PORT = Number(process.env.PORT || 3000);
const wooReconcileProgress = new Map();

const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 50 * 1024 * 1024;
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const RESCUE_PASSWORD = process.env.RESCUE_PASSWORD || '';
const AUTH_COOKIE = 'pilz_auth';
const AUTH_COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 Jahr
const DATABASE_URL = process.env.DATABASE_URL || '';
const WC_STORE_URL = (process.env.WC_STORE_URL || '').replace(/\/$/, '');
const WC_CONSUMER_KEY = process.env.WC_CONSUMER_KEY || '';
const WC_CONSUMER_SECRET = process.env.WC_CONSUMER_SECRET || '';
const WC_WEBHOOK_SECRET = process.env.WC_WEBHOOK_SECRET || '';
const DEVICE_COOKIE = 'pilz_device';
const DEVICE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365 * 3; // 3 Jahre

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

let pool = null;
if (!Pool) {
  console.error('PostgreSQL-Modul pg fehlt. Bitte npm install ausführen.');
} else if (!DATABASE_URL) {
  console.error('DATABASE_URL fehlt. Die Pilzverwaltung 1.4.5 verwendet ausschliesslich PostgreSQL.');
} else {
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

function sendJson(res, status, obj, headers = {}) {
  send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8', headers);
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('='); if (i < 0) continue;
    out[part.slice(0,i).trim()] = decodeURIComponent(part.slice(i+1).trim());
  }
  return out;
}
function deviceTokenHash(token) { return hash('device:' + String(token || '')); }
function deviceCookie(token) {
  return `${DEVICE_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${DEVICE_COOKIE_MAX_AGE}; HttpOnly; Secure; SameSite=Strict`;
}
function authCookie(kind) {
  const secret = kind === 'rescue' ? RESCUE_PASSWORD : APP_PASSWORD;
  const value = secret ? hash(`pilz-auth:${kind}:${secret}`) : '';
  return `${AUTH_COOKIE}=${encodeURIComponent(kind + '.' + value)}; Path=/; Max-Age=${AUTH_COOKIE_MAX_AGE}; HttpOnly; Secure; SameSite=Strict`;
}
function authKind(req) {
  const raw = parseCookies(req)[AUTH_COOKIE] || '';
  const [kind, value] = raw.split('.', 2);
  if (kind === 'app' && APP_PASSWORD && value === hash(`pilz-auth:app:${APP_PASSWORD}`)) return 'app';
  if (kind === 'rescue' && RESCUE_PASSWORD && value === hash(`pilz-auth:rescue:${RESCUE_PASSWORD}`)) return 'rescue';
  return '';
}
function requireAppLogin(req, res) {
  if (authKind(req)) return false;
  sendJson(res, 401, { error: 'Bitte zuerst mit dem Zugangspasswort anmelden.', code: 'LOGIN_REQUIRED' });
  return true;
}

function clientIp(req) { return String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim().slice(0,120); }
function deviceDescription(req) { return String(req.headers['user-agent'] || 'Unbekanntes Gerät').slice(0,500); }
function isRealBrowserDevice(req) {
  const ua = deviceDescription(req);
  if (!ua || /go-http-client|curl\/|wget\/|postmanruntime|insomnia|uptimerobot|healthcheck|render\//i.test(ua)) return false;
  return /mozilla\/5\.0|chrome\/|crios\/|firefox\/|fxios\/|safari\/|edg\//i.test(ua);
}


function hash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function isAuthorized(req) {
  if (authKind(req) === 'rescue') return true;
  if (!APP_PASSWORD) return true;
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  return !!token && (hash(token) === hash(APP_PASSWORD) || (RESCUE_PASSWORD && hash(token) === hash(RESCUE_PASSWORD)));
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
  if (!pool) throw new Error('PostgreSQL ist nicht konfiguriert. DATABASE_URL fehlt oder pg konnte nicht geladen werden.');
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
  return true;
}

async function readData() {
  await ensurePostgres();
  const result = await pool.query('SELECT data FROM app_state WHERE id = 1');
  if (!result.rows.length) return normalizeDb(JSON.parse(JSON.stringify(DEFAULT_DB)));
  return normalizeDb(result.rows[0].data);
}

async function writeData(data) {
  const db = normalizeDb(data);
  await ensurePostgres();
  const old = await pool.query('SELECT data FROM app_state WHERE id = 1');
  if (old.rows.length) {
    await pool.query('INSERT INTO app_backups(data, backup_kind) VALUES($1, $2)', [old.rows[0].data, 'change_limited']);
    // Nur die ab Version 1.5.17 angelegten Änderungs-Backups begrenzen.
    await pool.query(`DELETE FROM app_backups WHERE backup_kind='change_limited' AND id NOT IN (SELECT id FROM app_backups WHERE backup_kind='change_limited' ORDER BY id DESC LIMIT 50)`);
  }
  await pool.query(`
    INSERT INTO app_state(id, data, updated_at)
    VALUES(1, $1, now())
    ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()
  `, [db]);
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

async function ensureDailyBackup() {
  await ensurePostgres();
  const exists = await pool.query(`SELECT 1 FROM app_backups WHERE backup_kind IN ('daily','daily_limited') AND created_at >= date_trunc('day', now()) LIMIT 1`);
  if (exists.rows.length) return false;
  const db = await readData();
  await pool.query(`INSERT INTO app_backups(data, backup_kind) VALUES($1, 'daily_limited')`, [db]);
  // Nur neue Tagesbackups begrenzen; alle bisherigen 'daily'-Einträge behalten.
  await pool.query(`DELETE FROM app_backups WHERE backup_kind='daily_limited' AND id NOT IN (SELECT id FROM app_backups WHERE backup_kind='daily_limited' ORDER BY id DESC LIMIT 30)`);
  return true;
}

async function restoreBackup(id) {
  if (!id) throw new Error('Backup-ID fehlt');
  await ensurePostgres();
  const result = await pool.query('SELECT data FROM app_backups WHERE id = $1', [id]);
  if (!result.rows.length) throw new Error('Backup nicht gefunden');
  await writeData(result.rows[0].data);
  return true;
}

async function undoLastChange() {
  await ensurePostgres();
  const cur = await readData();
  const r = await pool.query("SELECT id, data, created_at FROM app_backups WHERE backup_kind IN ('change','change_limited') ORDER BY created_at DESC, id DESC LIMIT 1");
  if (!r.rows.length) throw new Error('Kein letzter Schritt zum Rückgängigmachen vorhanden.');
  const target = normalizeDb(r.rows[0].data);
  // aktuellen Stand separat sichern, ohne einen neuen normalen change-Eintrag zu erzeugen
  await pool.query("INSERT INTO app_backups(data, backup_kind) VALUES($1, 'undo')", [cur]);
  const syncResults = await syncChangedSkus(cur, target, 'Letzten Schritt rückgängig');
  await pool.query(`INSERT INTO app_state(id,data,updated_at) VALUES(1,$1,now()) ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data, updated_at=now()`, [target]);
  await pool.query('DELETE FROM app_backups WHERE id=$1', [r.rows[0].id]);
  return { restoredFrom: r.rows[0].created_at, syncResults };
}


async function touchDevice(req, res) {
  if (!isRealBrowserDevice(req)) return null;
  await ensurePostgres();
  const cookies = parseCookies(req);
  let token = cookies[DEVICE_COOKIE] || '';
  let isNew = false;
  if (!/^[A-Za-z0-9_-]{30,200}$/.test(token)) { token = crypto.randomBytes(32).toString('base64url'); isNew = true; }
  const th = deviceTokenHash(token);
  const ua = deviceDescription(req), ip = clientIp(req);
  const q = await pool.query(`INSERT INTO app_devices(token_hash,user_agent,last_ip) VALUES($1,$2,$3)
    ON CONFLICT(token_hash) DO UPDATE SET last_seen=now(), user_agent=$2, last_ip=$3
    RETURNING id,name,approved,first_seen,last_seen,user_agent,last_ip`, [th,ua,ip]);
  if (isNew) res.setHeader('Set-Cookie', deviceCookie(token));
  return q.rows[0];
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
  const q=await pool.query(`UPDATE app_devices SET name=COALESCE($2,name), approved=COALESCE($3,approved) WHERE id=$1 RETURNING id,name,approved,first_seen,last_seen,user_agent,last_ip`, [id, patch.name == null ? null : String(patch.name).slice(0,120), typeof patch.approved==='boolean'?patch.approved:null]);
  if(!q.rows.length) throw new Error('Gerät nicht gefunden'); return q.rows[0];
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
  const db = await readData();
  let dbSize = null;
  let updatedAt = null;
  await ensurePostgres();
  const s = await pool.query(`SELECT pg_database_size(current_database())::bigint AS size`);
  dbSize = Number(s.rows[0]?.size || 0);
  const u = await pool.query('SELECT updated_at FROM app_state WHERE id = 1');
  updatedAt = u.rows[0]?.updated_at || null;
  const backups = await listBackups();
  const count = k => Array.isArray(db[k]) ? db[k].length : 0;
  return {
    ok: true,
    version: '1.5.24',
    storage: 'postgres',
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
  const response = await fetch(url, { ...options, headers });
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
  const product = Array.isArray(list) ? (list.find(p => String(p.sku || '') === String(sku)) || list[0]) : null;
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
const wooProductDeliveryCache = new Map();
async function wooDeliveryDaysForItem(item) {
  const productId=Number(item.product_id||0), variationId=Number(item.variation_id||0);
  if(!productId) return null;
  const key=`${productId}:${variationId}`;
  if(wooProductDeliveryCache.has(key)) return wooProductDeliveryCache.get(key);
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
    wooProductDeliveryCache.set(key,value);return value;
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
const SET_BOMS = {
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
function setBom(sku){ return SET_BOMS[String(sku||'')] || null; }
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

function ensureSetCatalog(db){
  if(!Array.isArray(db.productCatalog)) db.productCatalog=[];
  const defs=[
    ['Ppul_Kör_150g','Lungenseitling Körnerbrut 150 g','kb','batch'],
    ['Ppul_Kör_600g','Lungenseitling Körnerbrut 600 g','kb','batch'],
    ['Ppul_Kör_1000g','Lungenseitling Körnerbrut 1000 g','kb','batch'],
    ['INT_Stroh_500g','Strohpellets 500 g','rawmaterials','simple'],['INT_Stroh_2000g','Strohpellets 2000 g','rawmaterials','simple'],['INT_Stroh_3500g','Strohpellets 3500 g','rawmaterials','simple'],
    ['INT_Nadelholz_500g','Nadelholzpellets 500 g','rawmaterials','simple'],['INT_Nadelholz_2000g','Nadelholzpellets 2000 g','rawmaterials','simple'],['INT_Nadelholz_3500g','Nadelholzpellets 3500 g','rawmaterials','simple']
  ];
  for(const [sku,name,area,stockMode] of defs){ if(!db.productCatalog.some(p=>p.sku===sku)) db.productCatalog.push({id:'INT-'+sku,sku,name,area,stockMode,qty:0,active:true,syncActive:false,internalOnly:true}); }
}

function isArchivedStockStatus(status) {
  const s = String(status || '').toLowerCase();
  return ['verkauft','archiviert','aufgebraucht','verbraucht','kontaminiert','entsorgt'].includes(s);
}
function catalogItem(db, sku) {
  return (db.productCatalog || []).find(p => String(p.sku || '') === String(sku || '') && p.active !== false) || null;
}
function batchRowsForSku(db, sku) {
  const rows = [];
  const add = (collection, list, filter = () => true, dateKey = 'date') => {
    for (const x of (list || [])) {
      if (String(x.sku || '') !== String(sku || '') || isArchivedStockStatus(x.status) || !filter(x)) continue;
      rows.push({ collection, id: x.id, date: x[dateKey] || x.date || x.packDate || '', qty: Math.max(0, Number(x.qty) || 1), storageLocation: x.storageLocation || '', orderId: x.orderId || null, orderItemId: x.orderItemId || null });
    }
  };
  add('goods', db.goods, x => ['Spritzen','Dübel','Dübel-Set'].includes(x.type) && (x.type!=='Dübel' && x.type!=='Dübel-Set' || String(x.status||'').toLowerCase()==='fertig durchwachsen'));
  // Körnerbrut ist erst verkaufs-/reservierbar, wenn sie ausdrücklich im Kühlschrank liegt.
  // 'am durchwachsen' und andere Zwischenstatus dürfen weder Woo-Bestand noch FIFO erhöhen.
  add('kb', db.kb, x => String(x.status || '').toLowerCase() === 'im kühlschrank');
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
  const bom=setBom(sku);
  if(bom) return Math.max(0, Math.floor(Math.min(...bom.map(c=>allocatableStock(db,c.sku,null,true)/(Number(c.qty)||1)))));
  return Math.max(0, Math.floor(allocatableStock(db, sku, null, false)));
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
    shipping:o.shipping||{}, billing:o.billing||{}, payment_method:o.payment_method_title||o.payment_method||'',
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
  const created=[];
  for (const item of (order.items||[])) {
    let need = Number(item.quantity)||0;
    const bom=setBom(item.sku);
    if(bom){
      for(const component of bom){
        let componentNeed=need*(Number(component.qty)||1);
        const componentAllocatable=allocatableStock(db,component.sku,order.id,true);
        const componentReserveNeed=Math.min(componentNeed,componentAllocatable);
        const cat=catalogItem(db,component.sku);
        if(cat && cat.stockMode==='simple'){
          const take=Math.min(componentReserveNeed,Math.max(0,(Number(cat.qty)||0)-reservedSimpleQty(db,component.sku,order.id)));
          if(take>0){const r={id:'WR-'+Date.now()+'-'+Math.random().toString(36).slice(2,8),orderId:order.id,orderNumber:order.number,itemId:item.id,sku:component.sku,parentSku:item.sku,name:component.label||component.sku,collection:'productCatalog',batchId:cat.id,qty:take,storageLocation:cat.storageLocation||'',status:'reserved',createdAt:new Date().toISOString()};db.wooReservations.push(r);created.push(r);}
        }else{
          let left=componentReserveNeed;
          for(const b of batchRowsForSku(db,component.sku)){
            if(left<=0)break;
            const available=Math.max(0,b.qty-reservedQtyForBatch(db,b.collection,b.id,order.id)); const take=Math.min(left,available);
            if(take>0){const r={id:'WR-'+Date.now()+'-'+Math.random().toString(36).slice(2,8),orderId:order.id,orderNumber:order.number,itemId:item.id,sku:component.sku,parentSku:item.sku,name:component.label||component.sku,collection:b.collection,batchId:b.id,qty:take,storageLocation:b.storageLocation||'',status:'reserved',createdAt:new Date().toISOString()};db.wooReservations.push(r);created.push(r);left-=take;}
          }
        }
        const got=(db.wooReservations||[]).filter(r=>r.status==='reserved'&&String(r.orderId)===String(order.id)&&String(r.itemId)===String(item.id)&&r.sku===component.sku).reduce((a,r)=>a+(Number(r.qty)||0),0);
        const shortage=Math.max(0,componentNeed-got);
        const reqId='BOM-'+order.id+'-'+item.id+'-'+component.sku;
        const existing=db.productionRequests.find(r=>r.id===reqId);
        if(shortage>0){
          const area=(catalogItem(db,component.sku)?.area)|| (component.sku.includes('_Kör_')?'kb':'other');
          const req={id:reqId,orderId:order.id,orderNumber:order.number,itemId:item.id,sku:component.sku,parentSku:item.sku,name:component.label||component.sku,qty:shortage,area,status:'offen',autoBom:true,createdAt:existing?.createdAt||new Date().toISOString()};
          if(existing) Object.assign(existing,req); else db.productionRequests.push(req);
        } else if(existing && existing.autoBom) existing.status='erledigt';
      }
      continue;
    }
    const cat = catalogItem(db,item.sku);
    need=Math.min(need,allocatableStock(db,item.sku,order.id,false));
    if (cat && cat.stockMode === 'simple') {
      const take=Math.min(need, Math.max(0,(Number(cat.qty)||0)-reservedSimpleQty(db,item.sku,order.id)));
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
          const ownerActive=(db.wooOrders||[]).some(o=>String(o.id)===String(b.orderId)&&String(o.status||'').toLowerCase()==='processing'&&!o.archived&&!o.externalDeleted);
          if(ownerActive) continue;
        }
        const available=Math.max(0,b.qty-reservedQtyForBatch(db,b.collection,b.id,order.id));
        const take=Math.min(need,available);
        if(take>0){ const r={id:'WR-'+Date.now()+'-'+Math.random().toString(36).slice(2,8),orderId:order.id,orderNumber:order.number,itemId:item.id,sku:item.sku,name:item.name,collection:b.collection,batchId:b.id,qty:take,storageLocation:b.storageLocation||'',status:'reserved',createdAt:new Date().toISOString()}; db.wooReservations.push(r); created.push(r); need-=take; }
      }
    }
  }
  return created;
}

function rebuildProcessingReservations(db) {
  const processing=(db.wooOrders||[]).filter(o=>o.status==='processing').sort((a,b)=>String(a.date_created||'').localeCompare(String(b.date_created||''))||Number(a.id||0)-Number(b.id||0));
  for(const r of (db.wooReservations||[])) if(r.status==='reserved') { r.status='replaced'; r.releasedAt=new Date().toISOString(); }
  for(const o of processing) reserveOrderFifo(db,o);
}

function consumeOrderReservations(db, orderId) {
  for (const r of (db.wooReservations||[]).filter(r=>String(r.orderId)===String(orderId)&&r.status==='reserved')) {
    if(r.collection==='productCatalog') {
      const p=(db.productCatalog||[]).find(x=>x.id===r.batchId || x.sku===r.sku); if(p) p.qty=Math.max(0,(Number(p.qty)||0)-(Number(r.qty)||0));
    } else {
      const arr=db[r.collection]||[]; const x=arr.find(v=>String(v.id)===String(r.batchId));
      if(x){ const q=Number(x.qty)||1, left=Math.max(0,q-(Number(r.qty)||0)); if('qty' in x) x.qty=left; if(left<=0 || !('qty' in x)) { x.status='verkauft'; x.finishedAt=new Date().toISOString().slice(0,10); } }
    }
    r.status='consumed'; r.consumedAt=new Date().toISOString();
  }
}
async function reconcileWooOrders(db, onProgress=()=>{}) {
  if (!Array.isArray(db.wooOrders)) db.wooOrders=[];
  if (!Array.isArray(db.productionRequests)) db.productionRequests=[];
  const summary={checked:0,updated:0,deleted:0,imported:0};
  const knownCount=db.wooOrders.length;
  // Neue processing/on-hold Bestellungen zuerst importieren, bevor die Altbestellungen geprüft werden.
  // Zusätzlich aktuelle processing-Bestellungen importieren, die lokal noch nicht bekannt sind.
  const processing=await wooListActiveOrders(onProgress);
  onProgress(`${processing.length} aktive Bestellungen geladen, Import läuft …`);
  for(const order of processing) {
    const idx=db.wooOrders.findIndex(x=>String(x.id)===String(order.id));
    if(idx<0){ db.wooOrders.push({...order,archived:false}); summary.imported++; }
    else if(db.wooOrders[idx].externalDeleted || db.wooOrders[idx].archived){ db.wooOrders[idx]={...order,internal_note:db.wooOrders[idx].internal_note||'',manual_shipping_date:db.wooOrders[idx].manual_shipping_date||'',externalDeleted:false,archived:false,archivedAt:'',archiveReason:''}; summary.imported++; }
  }
  onProgress("Prüfe vorhandene Bestellungen auf Änderungen …");
  // Zuerst bereits bekannte Aufträge direkt in WooCommerce prüfen. So werden auch
  // Bestellungen erkannt, die in WooCommerce in den Papierkorb verschoben oder endgültig gelöscht wurden.
  for (let i=0;i<knownCount;i++) {
    if(i%5===0) onProgress(`Prüfe bestehende Bestellungen: ${i+1} von ${knownCount} …`);
    const local=db.wooOrders[i];
    if(local && local.externalDeleted) continue;
    const raw=await wooReadOrderById(local.id);
    summary.checked++;
    if(!raw || String(raw.status||'').toLowerCase()==='trash') {
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
    const remote=await enrichWooOrder(raw);
    const previous=String(local.status||'');
    if(remote.status==='completed' && previous!=='completed') consumeOrderReservations(db,remote.id);
    else if(remote.status!=='processing') releaseOrderReservations(db,remote.id,'released');
    db.wooOrders[i]=isTerminalWooStatus(remote.status) ? markWooOrderArchived({...remote,internal_note:local.internal_note||'',manual_shipping_date:local.manual_shipping_date||''}, remote.status) : {...remote,internal_note:local.internal_note||'',manual_shipping_date:local.manual_shipping_date||'',archived:false,archivedAt:'',archiveReason:''};
    if(previous!==String(remote.status||'')) summary.updated++;
  }
  // Alle aktuell verarbeitbaren Bestellungen in stabiler Reihenfolge neu FIFO reservieren.
  onProgress("Reservierungen aktualisiert, speichere Daten …");
  rebuildProcessingReservations(db);
  return summary;
}

async function processWooOrderEvent(rawOrder, source='webhook') {
  const db=await readData();
  const before=JSON.parse(JSON.stringify(db));
  const order=await enrichWooOrder(rawOrder);
  const idx=(db.wooOrders||[]).findIndex(x=>String(x.id)===String(order.id));
  const terminal=isTerminalWooStatus(order.status);

  // Neue Bestellungen werden nur dann in die aktive Pilzverwaltung übernommen,
  // wenn WooCommerce sie tatsächlich als "processing" meldet. Dadurch können
  // verspätete Webhooks bereits abgeschlossener Altbestellungen keine neue
  // aktive Bestellung erzeugen.
  if(idx<0 && !['processing','on-hold'].includes(order.status)) {
    addSyncLog(db,{sku:'*',reason:`Woo Bestellung #${order.number} → ${order.status}`,status:'info',message:`Quelle: ${source}; nicht importiert (nur processing/on-hold wird neu übernommen).`});
    await writeData(db);
    return {order,ignored:true,reservations:[]};
  }

  // Bereits archivierte/abgeschlossene Bestellungen werden durch verspätete
  // Webhook-Wiederholungen nicht wieder aktiviert. Ein echtes Wiederöffnen auf
  // processing wird beim manuellen Woo-Abgleich sicher erkannt.
  if(idx>=0 && db.wooOrders[idx].archived && order.status==='processing') {
    addSyncLog(db,{sku:'*',reason:`Woo Bestellung #${order.number} → processing`,status:'info',message:`Quelle: ${source}; ignoriert, da lokal bereits abgeschlossen. Mit WooCommerce abgleichen zum Wiederöffnen.`});
    await writeData(db);
    return {order,ignored:true,reservations:[]};
  }

  if(['processing','on-hold'].includes(order.status)) {
    const active={...order,internal_note:idx>=0?(db.wooOrders[idx].internal_note||''):'',manual_shipping_date:idx>=0?(db.wooOrders[idx].manual_shipping_date||''):'',archived:false,archivedAt:'',archiveReason:'',externalDeleted:false};
    if(idx>=0) db.wooOrders[idx]=active; else db.wooOrders.push(active);
    if(order.status==='processing') reserveOrderFifo(db,active);
    else releaseOrderReservations(db,order.id,'released');
  } else if(terminal) {
    if(order.status==='completed') consumeOrderReservations(db,order.id);
    else releaseOrderReservations(db,order.id,'released');
    if(idx>=0) db.wooOrders[idx]=markWooOrderArchived({...order,internal_note:db.wooOrders[idx].internal_note||'',manual_shipping_date:db.wooOrders[idx].manual_shipping_date||''},order.status);
  } else {
    if(idx>=0) db.wooOrders[idx]={...order,internal_note:db.wooOrders[idx].internal_note||'',manual_shipping_date:db.wooOrders[idx].manual_shipping_date||'',archived:false};
    releaseOrderReservations(db,order.id,'released');
  }

  addSyncLog(db,{sku:'*',reason:`Woo Bestellung #${order.number} → ${order.status}`,status:'info',message:`Quelle: ${source}${terminal?'; Bestellung abgeschlossen/archiviert.':''}`});
  await syncChangedSkus(before,db,`Woo Bestellung #${order.number}`);
  await writeData(db);
  return {order,reservations:(db.wooReservations||[]).filter(r=>String(r.orderId)===String(order.id)&&r.status==='reserved')};
}
function verifyWooWebhook(rawBody, signature) {
  if(!WC_WEBHOOK_SECRET) return false;
  const expected=crypto.createHmac('sha256',WC_WEBHOOK_SECRET).update(rawBody).digest('base64');
  try { return crypto.timingSafeEqual(Buffer.from(expected),Buffer.from(String(signature||''))); } catch (_) { return false; }
}

async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/woo/webhook') {
    if (req.method !== 'POST') return sendJson(res,405,{error:'Nur POST erlaubt.'});
    try {
      const raw=await readBody(req);
      const signature=req.headers['x-wc-webhook-signature'];
      // Beim erstmaligen Aktivieren sendet WooCommerce einen Ping an die Delivery-URL.
      // Dieser kann ohne Webhook-Signatur eintreffen und darf niemals eine Lageraktion auslösen.
      // Unsigned POSTs werden deshalb nur als Erreichbarkeitstest mit 200 bestätigt und ignoriert.
      if(!signature) return sendJson(res,200,{ok:true,ping:true,ignored:true});
      if(!verifyWooWebhook(raw,signature)) return sendJson(res,401,{error:'Ungültige WooCommerce-Webhook-Signatur. WC_WEBHOOK_SECRET prüfen.'});
      const order=JSON.parse(raw||'{}');
      const result=await processWooOrderEvent(order,'webhook');
      return sendJson(res,200,{ok:true,orderId:result.order.id,reserved:result.reservations.length});
    } catch(err){ console.error(err); return sendJson(res,500,{error:err.message||'Webhook konnte nicht verarbeitet werden.'}); }
  }

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
    return sendJson(res, 200, { ok: !!pool, storage: 'postgres', database: !!pool, time: new Date().toISOString() });
  }

  // Geräteerkennung bleibt auch für noch nicht freigegebene Browser erreichbar.
  if (url.pathname === '/api/device-self') {
    try {
      const d = await touchDevice(req,res);
      const approvedCount = await approvedDeviceCount();
      const enforcement = await deviceEnforcementEnabled();
      return sendJson(res,200,{id:d?.id||null,name:d?.name||'',approved:!!d?.approved,enforcement,bootstrap:enforcement && approvedCount===0});
    } catch(err){ return sendJson(res,500,{error:'Geräteerkennung fehlgeschlagen.'}); }
  }

  // Normaler Zugang: APP_PASSWORD ist immer erforderlich, unabhängig davon,
  // ob die Gerätesperre ein- oder ausgeschaltet ist. Die erfolgreiche Anmeldung
  // wird als sicherer HttpOnly-Cookie gespeichert. RESCUE_PASSWORD ist ein
  // unabhängiger Notfallzugang und umgeht die Gerätefreigabe.
  if (url.pathname === '/api/login') {
    if (!APP_PASSWORD) return sendJson(res, 503, { error: 'APP_PASSWORD muss gesetzt sein.' });
    const body = JSON.parse(await readBody(req) || '{}');
    const password = String(body.password || '');
    if (RESCUE_PASSWORD && password === RESCUE_PASSWORD) {
      return sendJson(res, 200, { ok:true, rescue:true }, { 'Set-Cookie': authCookie('rescue') });
    }
    if (password !== APP_PASSWORD) return sendJson(res, 401, { error: 'Falsches Passwort.' });
    const d = await currentDevice(req);
    if (!d) return sendJson(res, 403, { error: 'Dieses Gerät konnte nicht registriert werden.', code:'DEVICE_NOT_APPROVED' });
    const enforcement = await deviceEnforcementEnabled();
    if (enforcement && !d.approved) {
      const n = await approvedDeviceCount();
      if (n === 0) {
        await updateDevice(Number(d.id), { approved:true, name:d.name || 'Erstes Admin-Gerät' });
      } else {
        return sendJson(res, 403, { error: 'Dieses Gerät ist noch nicht freigegeben. Bitte in der Geräteverwaltung freigeben oder den Rescue-Zugang verwenden.', code:'DEVICE_NOT_APPROVED', deviceId:d.id });
      }
    }
    return sendJson(res, 200, { ok:true, rescue:false, enforcement }, { 'Set-Cookie': authCookie('app') });
  }

  // Zentraler Schalter für die Gerätesperre. Nur mit Admin-Passwort änderbar.
  // Der Endpunkt liegt bewusst vor der Gerätesperre, damit sie mit APP_PASSWORD
  // auch wieder aktiviert werden kann, wenn das aktuelle Gerät noch nicht freigegeben ist.
  if (url.pathname === '/api/device-enforcement') {
    if (req.method === 'GET') return sendJson(res,200,{enforcement:await deviceEnforcementEnabled()});
    if (req.method !== 'POST') return sendJson(res,405,{error:'Nur GET/POST erlaubt.'});
    if (requireAuth(req,res)) return;
    try {
      const body=JSON.parse((await readBody(req))||'{}');
      if (typeof body.enforcement !== 'boolean') return sendJson(res,400,{error:'enforcement muss true oder false sein.'});
      return sendJson(res,200,{ok:true,enforcement:await setDeviceEnforcement(body.enforcement)});
    } catch(err){ return sendJson(res,400,{error:err.message||'Gerätesperre konnte nicht geändert werden.'}); }
  }

  // Ab hier ist für sämtliche internen API-Funktionen zuerst eine Anmeldung Pflicht.
  // Bei aktiver Gerätesperre muss zusätzlich das Gerät freigegeben sein. Ein gültiger
  // Rescue-Zugang darf die Gerätesperre im Notfall umgehen.
  if (requireAppLogin(req, res)) return;
  if (authKind(req) !== 'rescue' && await requireApprovedDevice(req, res)) return;

  if (url.pathname === '/api/live-state') {
    try {
      await ensurePostgres();
      const meta = await pool.query('SELECT updated_at FROM app_state WHERE id = 1');
      return sendJson(res, 200, { ok:true, updatedAt: meta.rows[0]?.updated_at || null });
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
    try { return sendJson(res,200,{ok:true,...await undoLastChange()}); }
    catch(err){ console.error(err); return sendJson(res,500,{error:err.message||'Rückgängig machen fehlgeschlagen.'}); }
  }

  if (url.pathname === '/api/backups') {
    try {
      if (req.method === 'POST') return sendJson(res, 200, { ok: true, backup: await createManualBackup() });
      return sendJson(res, 200, { ok: true, backups: await listBackups() });
    } catch (err) { console.error(err); return sendJson(res, 500, { error: 'Backup konnte nicht verarbeitet werden.' }); }
  }

  if (url.pathname === '/api/restore') {
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      await restoreBackup(body.id);
      return sendJson(res, 200, { ok: true });
    } catch (err) { console.error(err); return sendJson(res, 500, { error: 'Backup konnte nicht wiederhergestellt werden.' }); }
  }

  if (url.pathname === '/api/devices') {
    // Nur die Geräteverwaltung selbst benötigt zusätzlich das Admin-Passwort.
    if (requireAuth(req,res)) return;
    if (req.method === 'GET') return sendJson(res,200,{ enforcement:await deviceEnforcementEnabled(), devices:await listDevices() });
    if (req.method === 'POST') {
      try { const body=JSON.parse((await readBody(req))||'{}'); return sendJson(res,200,{ok:true,device:await updateDevice(Number(body.id),body)}); }
      catch(err){ return sendJson(res,400,{error:err.message||'Gerät konnte nicht geändert werden.'}); }
    }
    return sendJson(res,405,{error:'Nur GET/POST erlaubt.'});
  }

  // Schlanker, atomarer Teamaufgaben-Endpunkt: kein Woo-Abgleich, keine Lager-Neuberechnung.
  if (url.pathname === '/api/personal-tasks') {
    if (req.method !== 'POST') return sendJson(res,405,{error:'Nur POST erlaubt.'});
    let client;
    try {
      const body=JSON.parse((await readBody(req))||'{}');
      const action=body.action;
      if (!['upsert','delete','toggle','addCategory'].includes(action)) return sendJson(res,400,{error:'Unbekannte Aktion.'});
      if (action==='upsert' && (!body.task || typeof body.task.id!=='string' || typeof body.task.title!=='string' || !body.task.title.trim())) return sendJson(res,400,{error:'Titel fehlt.'});
      if (action==='addCategory' && (typeof body.category!=='string' || !body.category.trim())) return sendJson(res,400,{error:'Kategorie fehlt.'});
      if (['delete','toggle'].includes(action) && typeof body.id!=='string') return sendJson(res,400,{error:'ID fehlt.'});
      await ensurePostgres();
      client=await pool.connect();
      await client.query('BEGIN');
      const locked=await client.query('SELECT data FROM app_state WHERE id=1 FOR UPDATE');
      if (!locked.rows.length) throw new Error('App-Daten fehlen.');
      const original=locked.rows[0].data;
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
      const updated=await client.query(`UPDATE app_state SET data=jsonb_set(jsonb_set(data::jsonb,'{personalTasks}',$1::jsonb,true),'{personalTaskCategories}',$2::jsonb,true),updated_at=now() WHERE id=1 RETURNING updated_at`,[JSON.stringify(tasks),JSON.stringify(categories)]);
      await client.query('COMMIT');
      return sendJson(res,200,{ok:true,personalTasks:tasks,personalTaskCategories:categories,updatedAt:updated.rows[0].updated_at});
    } catch(err) {
      if(client) await client.query('ROLLBACK').catch(()=>{});
      console.error('Teamaufgaben:',err);
      return sendJson(res,500,{error:'Teamaufgabe konnte nicht gespeichert werden.'});
    } finally { if(client)client.release(); }
  }

  if (url.pathname === '/api/data') {
    if (req.method === 'GET') {
      try { return sendJson(res, 200, await readData()); }
      catch (err) { console.error(err); return sendJson(res, 500, { error: 'Daten konnten nicht gelesen werden.' }); }
    }
    if (req.method === 'POST') {
      try {
        const parsed = normalizeDb(JSON.parse(await readBody(req) || '{}'));
        const previous = await readData();
        // Woo-Bestellungen, Reservierungen und Sync-Protokoll sind servergeführt. So kann ein Webhook
        // nicht durch einen gleichzeitig geöffneten Browser mit älterem Datenstand überschrieben werden.
        parsed.wooOrders = previous.wooOrders || [];
        ensureSetCatalog(parsed);
        dedupeProductCatalog(parsed);
        parsed.wooReservations = previous.wooReservations || [];
        parsed.wooSyncLog = previous.wooSyncLog || [];
        rebuildProcessingReservations(parsed);
        const syncResults = await syncChangedSkus(previous, parsed, 'Pilzverwaltung geändert');
        await writeData(parsed);
        return sendJson(res, 200, { ok: true, savedAt: new Date().toISOString(), syncResults, wooOrders: parsed.wooOrders, wooReservations: parsed.wooReservations, wooSyncLog: parsed.wooSyncLog });
      } catch (err) {
        console.error(err);
        return sendJson(res, 500, { error: 'Daten konnten nicht gespeichert werden.' });
      }
    }
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
    try {
      const progressId=String(url.searchParams.get('progressId')||'').slice(0,100);
      const progress=message=>{if(progressId)wooReconcileProgress.set(progressId,{message,done:false,at:Date.now()});};
      progress('Starte WooCommerce-Abgleich …');
      const db=await readData(); const before=JSON.parse(JSON.stringify(db));
      const summary=await reconcileWooOrders(db,progress);
      progress('Synchronisiere Lagerbestand und speichere …');
      await syncChangedSkus(before,db,'Bestellungen mit WooCommerce abgeglichen'); await writeData(db);
      if(progressId)wooReconcileProgress.set(progressId,{message:'Abgleich abgeschlossen.',done:true,at:Date.now()});
      return sendJson(res,200,{ok:true,summary,orders:db.wooOrders,reservations:db.wooReservations||[],wooSyncLog:db.wooSyncLog||[]});
    } catch(err){console.error(err);return sendJson(res,500,{error:err.message||'Bestellungen konnten nicht mit WooCommerce abgeglichen werden.'});}
  }
  if (url.pathname === '/api/woo/order-internal-note') {
    if (req.method !== 'POST') return sendJson(res,405,{error:'Nur POST erlaubt.'});
    try {
      const body=JSON.parse(await readBody(req)||'{}');
      const note=String(body.note||'');
      if(note.length>10000) return sendJson(res,400,{error:'Bemerkung ist zu lang (max. 10000 Zeichen).'});
      const db=await readData();
      const order=(db.wooOrders||[]).find(o=>String(o.id)===String(body.id));
      if(!order) return sendJson(res,404,{error:'Bestellung nicht gefunden.'});
      order.internal_note=note;
      await writeData(db);
      return sendJson(res,200,{ok:true,orders:db.wooOrders});
    } catch(err){ console.error(err); return sendJson(res,500,{error:'Bemerkung konnte nicht gespeichert werden.'}); }
  }
  if (url.pathname === '/api/woo/order-manual-date') {
    if (req.method !== 'POST') return sendJson(res,405,{error:'Nur POST erlaubt.'});
    try {
      const body=JSON.parse(await readBody(req)||'{}');
      const date=String(body.date||'').trim();
      if(date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date+'T12:00:00Z')) || new Date(date+'T12:00:00Z').toISOString().slice(0,10)!==date)) return sendJson(res,400,{error:'Ungültiges Datum.'});
      const db=await readData();
      const order=(db.wooOrders||[]).find(o=>String(o.id)===String(body.id));
      if(!order) return sendJson(res,404,{error:'Bestellung nicht gefunden.'});
      order.manual_shipping_date=date;
      await writeData(db);
      return sendJson(res,200,{ok:true,orders:db.wooOrders});
    } catch(err){ console.error(err); return sendJson(res,500,{error:'Wunschdatum konnte nicht gespeichert werden.'}); }
  }
  if (url.pathname === '/api/woo/delete-local-order') {
    if (req.method !== 'POST') return sendJson(res,405,{error:'Nur POST erlaubt.'});
    try {
      const body=JSON.parse(await readBody(req)||'{}'); const id=body.id;
      const db=await readData(); const order=(db.wooOrders||[]).find(o=>String(o.id)===String(id));
      if(!order) return sendJson(res,404,{error:'Lokale Bestellung nicht gefunden.'});
      if(!order.externalDeleted && order.status!=='external-deleted') return sendJson(res,409,{error:'Nur bereits als extern gelöscht erkannte Bestellungen können lokal endgültig gelöscht werden.'});
      db.wooOrders=(db.wooOrders||[]).filter(o=>String(o.id)!==String(id));
      db.wooReservations=(db.wooReservations||[]).filter(r=>String(r.orderId)!==String(id));
      db.productionRequests=(db.productionRequests||[]).filter(r=>String(r.orderId)!==String(id));
      addSyncLog(db,{sku:'*',reason:`Bestellung #${order.number||order.id} lokal gelöscht`,status:'info',message:'Bereits extern gelöschte Bestellung endgültig aus der Pilzverwaltung entfernt.'});
      await writeData(db);
      return sendJson(res,200,{ok:true,orders:db.wooOrders,reservations:db.wooReservations||[],wooSyncLog:db.wooSyncLog||[]});
    } catch(err){console.error(err);return sendJson(res,500,{error:err.message||'Lokale Bestellung konnte nicht gelöscht werden.'});}
  }
  if (url.pathname === '/api/woo/retry-sync') {
    if (req.method !== 'POST') return sendJson(res,405,{error:'Nur POST erlaubt.'});
    try { const db=await readData(); const results=[]; for(const sku of allSyncSkus(db)) results.push(await syncSkuToWoo(db,sku,'Manueller Sync-Wiederholungsversuch')); await writeData(db); return sendJson(res,200,{ok:true,results}); }
    catch(err){console.error(err);return sendJson(res,500,{error:err.message||'Sync konnte nicht wiederholt werden.'});}
  }

  if (url.pathname === '/api/woo/orders') {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'Nur GET erlaubt.' });
    try { return sendJson(res, 200, { ok:true, orders: await wooListProcessingOrders() }); }
    catch (err) { console.error(err); return sendJson(res, 500, { error: err.message || 'WooCommerce-Bestellungen konnten nicht geladen werden.' }); }
  }

  if (url.pathname === '/api/woo/lookup') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Nur POST erlaubt.' });
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const skus = Array.isArray(body.skus) ? body.skus.slice(0, 100) : [];
      const products = [];
      for (const sku of skus) {
        try { products.push(wooProductSummary(sku, await wooFindProductBySku(sku))); }
        catch (err) { products.push({ sku, found: false, error: err.message }); }
      }
      return sendJson(res, 200, { ok: true, products });
    } catch (err) { console.error(err); return sendJson(res, 500, { error: err.message || 'WooCommerce-Produkte konnten nicht geprüft werden.' }); }
  }

  if (url.pathname === '/api/woo/sync-stock') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Nur POST erlaubt.' });
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const items = Array.isArray(body.items) ? body.items.slice(0, 100) : [];
      const enableManageStock = !!body.enableManageStock;
      const results = [];
      for (const item of items) {
        const sku = String(item.sku || '').trim();
        const stock = Math.max(0, Math.floor(Number(item.stock) || 0));
        if (!sku) continue;
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
    } catch (err) { console.error(err); return sendJson(res, 500, { error: err.message || 'WooCommerce-Synchronisation fehlgeschlagen.' }); }
  }

  if (url.pathname === '/api/export') {
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
    if (!req.url.startsWith('/api/woo/webhook')) { try { await touchDevice(req,res); } catch(e) { console.warn('Geräteerkennung:', e.message); } }
    if (req.url.startsWith('/api/')) return handleApi(req, res);
    return serveStatic(req, res);
  } catch (err) {
    console.error(err);
    return sendJson(res, 500, { error: 'Serverfehler.' });
  }
});

server.listen(PORT, () => {
  console.log(`Pilzverwaltung 1.5.24 läuft auf Port ${PORT}`);
  ensureDailyBackup().catch(err => console.error('Tagesbackup fehlgeschlagen:', err));
  setInterval(() => ensureDailyBackup().catch(err => console.error('Tagesbackup fehlgeschlagen:', err)), 60 * 60 * 1000);
  console.log(`Speicher: Postgres/DATABASE_URL${pool ? '' : ' (nicht verbunden)'}`);
});
