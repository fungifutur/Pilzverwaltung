'use strict';
// Lieferzeit und spätestes Versanddatum aus WooCommerce-Daten (ACF-Felder, Bestellungs-Metadaten).

function metaValue(obj, key) {
  if (!obj) return '';
  const fromMeta = (obj.meta_data || []).find(m => m && m.key === key)?.value;
  const raw = fromMeta ?? obj.acf?.[key] ?? obj[key] ?? '';
  return (typeof raw === 'object' && raw !== null) ? '' : String(raw ?? '').trim();
}

// «12 - 14 Wochen» → 98, «3 Tage» → 3. Zweistellige Zahlen sind kein Problem; die grösste Zahl zählt.
function parseDeliveryDays(text) {
  const s = String(text || '').toLowerCase();
  const matches = s.match(/\d+/g);
  if (!matches) return 0;
  const n = Math.max(...matches.map(Number));
  return /woche/.test(s) ? n * 7 : /tag/.test(s) ? n : 0;
}

// Ist der Artikel im Lieferrückstand (kein Lagerbestand mehr)?
function isBackorder(node) {
  if (!node) return false;
  const st = String(node.stock_status || '').toLowerCase();
  if (node.on_backorder || st === 'onbackorder') return true;
  if (node.manage_stock && node.stock_quantity !== null && node.stock_quantity !== undefined && Number(node.stock_quantity) < 0) return true;
  return false;
}

// Welcher Lieferzeit-Text gilt für diesen Artikel?
// 1) Feld «lieferzeit» (direkt), 2) «Lieferzeit an Lager» bzw. «bei Lieferrückstand» je nach Lagerlage,
// jeweils zuerst am Artikel/der Variante, dann am Elternprodukt.
function pickDeliveryText(node, parent) {
  const direct = metaValue(node, 'lieferzeit');
  if (direct) return direct;
  const backorder = isBackorder(node) || (!(node && node.manage_stock) && isBackorder(parent));
  const wanted = backorder ? 'lieferzeit_lieferrueckstand' : 'lieferzeit_lager';
  const other = wanted === 'lieferzeit_lager' ? 'lieferzeit_lieferrueckstand' : 'lieferzeit_lager';
  for (const key of [wanted, other, 'lieferzeit']) {
    const v = metaValue(node, key) || metaValue(parent, key);
    if (v) return v;
  }
  return '';
}

function normalizeDate(value) {
  const v = String(value || '').trim();
  let m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = v.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return '';
}

// Spätestes Versanddatum, das ein anderes Plugin an der Bestellung gespeichert hat.
function latestShippingFromMeta(order) {
  const direct = normalizeDate(order?.latest_shipping_date);
  if (direct) return direct;
  const list = (order?.meta_data || []).filter(m => m && m.key);
  for (const key of ['latest_shipping_date', '_mykothek_latest_shipping_date']) {
    const hit = list.find(m => m.key === key);
    const d = normalizeDate(hit?.value);
    if (d) return d;
  }
  const re = /(latest|late|spaet|spät)/i, re2 = /(ship|versand|deliver|liefer)/i;
  for (const m of list) {
    if (re.test(m.key) && re2.test(m.key)) { const d = normalizeDate(m.value); if (d) return d; }
  }
  return '';
}

module.exports = { metaValue, parseDeliveryDays, isBackorder, pickDeliveryText, normalizeDate, latestShippingFromMeta };
