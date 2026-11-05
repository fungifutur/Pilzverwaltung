#!/usr/bin/env node
'use strict';
// M17: Abgleichbericht für die Datenmigration (Anzahl, IDs, Bestand je SKU, Reservierungen vorher/nachher).
//
//   Bericht vom laufenden System erstellen (alt oder neu), das dieselben Schnittstellen /api/export und /api/stock hat:
//     node scripts/migration_report.js erstellen --url https://DEINE-APP.onrender.com --passwort RESCUE_PASSWORT --out vorher.json
//   Oder aus bereits gespeicherten Dateien (Export und Bestand):
//     node scripts/migration_report.js erstellen --export export.json --stock stock.json --out vorher.json
//   Zwei Berichte vergleichen (Exit-Code 1, sobald es Unterschiede gibt):
//     node scripts/migration_report.js vergleichen vorher.json nachher.json
//
// Der Bericht enthält nur IDs, Zahlen und SKUs, keine Kunden- oder Freitextdaten.
const fs = require('node:fs');

// Sammlungen, deren IDs auf Etiketten (QR-Codes /scan/<Bereich>/<ID>) stehen können: jede ID muss im neuen System auflösbar bleiben.
const ID_COLLECTIONS = ['dk', 'petri', 'lc', 'kb', 'mix', 'sub', 'harv', 'buckets', 'lots', 'goods', 'logs', 'archive'];

function arg(args, name) { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : undefined; }
function die(msg) { console.error('Fehler: ' + msg); process.exit(2); }

const UA = 'Mozilla/5.0 Migrationsbericht';
// Anmeldung wie im Browser (Sitzungs-Cookie). Das Rescue-Passwort umgeht die Gerätefreigabe und ist hierfür am einfachsten.
async function login(base, pw) {
  const res = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': UA }, body: JSON.stringify({ password: pw }) });
  if (!res.ok) die(`Anmeldung fehlgeschlagen (Status ${res.status}). Das Rescue-Passwort verwenden, falls die Gerätefreigabe aktiv ist.`);
  return res.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
}
async function getJson(url, cookie) {
  const res = await fetch(url, { headers: { cookie, 'user-agent': UA } });
  if (!res.ok) die(`${url} lieferte Status ${res.status}`);
  return res.json();
}

function buildReport(exp, stockPayload, source) {
  const counts = {}; const ids = {};
  for (const [k, v] of Object.entries(exp)) if (Array.isArray(v)) counts[k] = v.length;
  for (const k of ID_COLLECTIONS) ids[k] = (exp[k] || []).map(x => String(x && x.id)).sort();
  const stock = {};
  const raw = stockPayload && stockPayload.stock ? stockPayload.stock : (stockPayload || {});
  for (const sku of Object.keys(raw).sort()) {
    const s = raw[sku]; stock[sku] = { verfuegbar: s.available, physisch: s.physical, reserviert: s.reserved };
  }
  const reservations = (exp.wooReservations || []).filter(r => r.status === 'reserved')
    .map(r => [String(r.orderId), String(r.itemId), String(r.sku), String(r.batchId), Number(r.qty) || 0]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const openOrders = (exp.wooOrders || []).filter(o => ['processing', 'on-hold'].includes(String(o.status))).map(o => String(o.id)).sort();
  return { erstelltAm: new Date().toISOString(), quelle: source, zaehlung: counts, ids, bestand: stock, reservierungen: reservations, offeneBestellungen: openOrders };
}

function compare(a, b) {
  const out = []; const add = (titel, zeilen) => { if (zeilen.length) out.push({ titel, zeilen }); };
  const keys = [...new Set([...Object.keys(a.zaehlung), ...Object.keys(b.zaehlung)])].sort();
  add('Anzahl Datensätze weicht ab', keys.filter(k => a.zaehlung[k] !== b.zaehlung[k]).map(k => `${k}: vorher ${a.zaehlung[k] ?? '–'}, nachher ${b.zaehlung[k] ?? '–'}`));
  const missing = [], extra = [];
  for (const k of ID_COLLECTIONS) {
    const sa = new Set(a.ids[k] || []), sb = new Set(b.ids[k] || []);
    for (const id of sa) if (!sb.has(id)) missing.push(`${k}/${id}`);
    for (const id of sb) if (!sa.has(id)) extra.push(`${k}/${id}`);
  }
  add('IDs fehlen im neuen System (gedruckte QR-Etiketten würden ins Leere führen)', missing);
  add('IDs sind im neuen System dazugekommen', extra);
  const skus = [...new Set([...Object.keys(a.bestand), ...Object.keys(b.bestand)])].sort();
  add('Bestand je SKU weicht ab', skus.filter(s => JSON.stringify(a.bestand[s] || null) !== JSON.stringify(b.bestand[s] || null))
    .map(s => `${s}: vorher ${JSON.stringify(a.bestand[s] || null)}, nachher ${JSON.stringify(b.bestand[s] || null)}`));
  const ra = new Set(a.reservierungen.map(x => JSON.stringify(x))), rb = new Set(b.reservierungen.map(x => JSON.stringify(x)));
  add('Reservierungen weichen ab', [...[...ra].filter(x => !rb.has(x)).map(x => 'nur vorher: ' + x), ...[...rb].filter(x => !ra.has(x)).map(x => 'nur nachher: ' + x)]);
  const oa = new Set(a.offeneBestellungen), ob = new Set(b.offeneBestellungen);
  add('Offene Bestellungen weichen ab', [...[...oa].filter(x => !ob.has(x)).map(x => 'nur vorher: ' + x), ...[...ob].filter(x => !oa.has(x)).map(x => 'nur nachher: ' + x)]);
  return out;
}

(async () => {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'erstellen') {
    const out = arg(args, 'out'); if (!out) die('--out Datei fehlt');
    let exp, stock, source;
    if (arg(args, 'url')) {
      const base = arg(args, 'url').replace(/\/$/, ''); const pw = arg(args, 'passwort') || process.env.RESCUE_PASSWORD;
      if (!pw) die('--passwort (oder Umgebungsvariable RESCUE_PASSWORD) fehlt');
      const cookie = await login(base, pw);
      exp = await getJson(base + '/api/export', cookie); stock = await getJson(base + '/api/stock', cookie); source = base;
    } else if (arg(args, 'export') && arg(args, 'stock')) {
      exp = JSON.parse(fs.readFileSync(arg(args, 'export'), 'utf8')); stock = JSON.parse(fs.readFileSync(arg(args, 'stock'), 'utf8')); source = 'Dateien';
    } else die('Entweder --url und --passwort oder --export und --stock angeben.');
    const report = buildReport(exp, stock, source);
    fs.writeFileSync(out, JSON.stringify(report, null, 1) + '\n');
    console.log(`Bericht gespeichert: ${out}`);
    console.log(`  ${Object.values(report.zaehlung).reduce((x, y) => x + y, 0)} Datensätze in ${Object.keys(report.zaehlung).length} Sammlungen, ${Object.keys(report.bestand).length} Artikel mit Bestand, ${report.reservierungen.length} Reservierungen`);
  } else if (cmd === 'vergleichen') {
    if (args.length < 2) die('Zwei Berichte angeben: vergleichen vorher.json nachher.json');
    const diffs = compare(JSON.parse(fs.readFileSync(args[0], 'utf8')), JSON.parse(fs.readFileSync(args[1], 'utf8')));
    if (!diffs.length) { console.log('Abgleich in Ordnung: Anzahl, IDs, Bestand je SKU, Reservierungen und offene Bestellungen sind identisch.'); return; }
    for (const d of diffs) { console.log(`\n${d.titel} (${d.zeilen.length}):`); for (const z of d.zeilen.slice(0, 50)) console.log('  - ' + z); if (d.zeilen.length > 50) console.log(`  … und ${d.zeilen.length - 50} weitere`); }
    console.log('\nABGLEICH NICHT IN ORDNUNG'); process.exit(1);
  } else {
    console.log('Aufruf:\n  node scripts/migration_report.js erstellen --url URL --passwort PW --out bericht.json\n  node scripts/migration_report.js erstellen --export export.json --stock stock.json --out bericht.json\n  node scripts/migration_report.js vergleichen vorher.json nachher.json');
    process.exit(cmd ? 2 : 0);
  }
})().catch(e => die(e.message));
