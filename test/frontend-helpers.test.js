// Prüft reine Hilfsfunktionen der Oberfläche (IDs, Datum, Menge, Dübel-Aufteilung), ohne Browser.
// Die Funktionen werden direkt aus public/index.html gelesen, damit Test und Code nicht auseinanderlaufen.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

function fn(name) {
  const start = html.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'Funktion fehlt: ' + name);
  let i = html.indexOf('{', start), depth = 0, q = null, esc = false;
  for (let j = i; j < html.length; j++) {
    const c = html[j];
    if (q) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === '{') depth++;
    if (c === '}') { depth--; if (depth === 0) return html.slice(start, j + 1); }
  }
  throw new Error('Funktion nicht abgeschlossen: ' + name);
}
function load(names, db) {
  const src = names.map(fn).join('\n');
  return new Function('db', src + '\nreturn {' + names.join(',') + '};')(db);
}

describe('Hilfsfunktionen der Oberfläche', () => {
  it('INT-08: next() nimmt die höchste Nummer + 1, auch nach Löschungen, und vergibt nie eine vorhandene ID', () => {
    const y = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Zurich' }).format(new Date()).slice(0, 4);
    const db = { dk: [{ id: `DK-${y}-0001` }, { id: `DK-${y}-0003` }, { id: `DK-${y}-0007` }], petri: [{ id: `PET-${y}-0009` }], goods: [] };
    const h = load(['localIso', 'today', 'allIdsInUse', 'next'], db);
    assert.equal(h.next('DK', db.dk), `DK-${y}-0008`, 'höchste + 1, nicht Anzahl + 1');
    db.dk.splice(1, 1); // Löschung
    assert.equal(h.next('DK', db.dk), `DK-${y}-0008`, 'Löschung erzeugt keine doppelte ID');
    db.dk = [];
    assert.equal(h.next('DK', db.dk), `DK-${y}-0001`);
    db.goods = [{ id: `DUE-${y}-0004` }, { id: `DUESET-${y}-0020` }, { id: `DUE-${y}-0004-2` }];
    assert.equal(h.next('DUE', db.goods), `DUE-${y}-0005`, 'DUESET zählt nicht zu DUE, Packungs-Suffix stört nicht');
    // ID kommt in einer anderen Sammlung schon vor → wird übersprungen
    db.petri = [{ id: `DK-${y}-0001` }];
    assert.equal(h.next('DK', db.dk), `DK-${y}-0002`);
  });

  it('INT-08: 1000er-Dübel werden aufgeteilt, ohne die bestehende ID zu ersetzen', () => {
    const db = { goods: [{ id: 'DUE-2026-0003', type: 'Dübel', size: '1000', qty: 3, sku: 'D1000' }, { id: 'DUE-2026-0004', type: 'Dübel', size: '500', qty: 5 }] };
    const h = load(['is1000Dowel', 'normalize1000DowelPacks'], db);
    assert.equal(h.normalize1000DowelPacks(), true);
    assert.deepEqual(db.goods.map(x => x.id), ['DUE-2026-0003', 'DUE-2026-0003-2', 'DUE-2026-0003-3', 'DUE-2026-0004']);
    assert.equal(db.goods[0].packIndex, 1); assert.equal(db.goods[0].packTotal, 3); assert.equal(db.goods[0].splitFrom, 'DUE-2026-0003');
  });

  it('INT-08: eine früher umbenannte Dübel-ID (nur …-1 vorhanden) wird über splitFrom gefunden', () => {
    const db = { goods: [{ id: 'DUE-2026-0003-1', splitFrom: 'DUE-2026-0003', packIndex: 1 }, { id: 'DUE-2026-0003-2', splitFrom: 'DUE-2026-0003', packIndex: 2 }] };
    const h = load(['by'], db);
    assert.equal(h.by('goods', 'DUE-2026-0003').id, 'DUE-2026-0003-1');
    assert.equal(h.by('goods', 'DUE-2026-0003-2').id, 'DUE-2026-0003-2');
    assert.deepEqual(h.by('goods', 'GIBT-ES-NICHT'), {});
  });

  it('INT-10 (b): qtyOrOne – 0 bleibt 0, fehlend wird 1, Unsinn wird 1, negativ wird 0', () => {
    const { qtyOrOne } = load(['qtyOrOne'], {});
    assert.equal(qtyOrOne(0), 0); assert.equal(qtyOrOne('0'), 0);
    assert.equal(qtyOrOne(undefined), 1); assert.equal(qtyOrOne(null), 1); assert.equal(qtyOrOne(''), 1);
    assert.equal(qtyOrOne('abc'), 1); assert.equal(qtyOrOne(5), 5); assert.equal(qtyOrOne('7'), 7); assert.equal(qtyOrOne(-2), 0);
  });

  it('INT-10 (c): today() liefert das Datum in Schweizer Zeit; MHD +2 Jahre ohne Tagesverschiebung', () => {
    const { today, addYearsIso } = load(['localIso', 'today', 'addYearsIso'], {});
    assert.match(today(), /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(addYearsIso('2026-11-05', 2), '2028-11-05');
    assert.equal(addYearsIso('2026-01-01', 2), '2028-01-01', 'kein Vortag');
    assert.equal(addYearsIso('2028-02-29', 2), '2030-03-01', 'Schalttag wie bisher');
    // Der Kerntest: 23:30 UTC am 4.11. ist in der Schweiz bereits der 5.11. (00:30)
    const RealDate = Date; const fixed = new RealDate('2026-11-04T23:30:00Z').getTime();
    globalThis.Date = class extends RealDate { constructor(...a) { if (a.length) super(...a); else super(fixed); } static now() { return fixed; } };
    try { assert.equal(load(['localIso', 'today'], {}).today(), '2026-11-05'); } finally { globalThis.Date = RealDate; }
  });

  it('Tempo: by() liefert dasselbe wie die lineare Suche, auch nach Änderungen im selben Arbeitsschritt', () => {
    const db = { kb: [{ id: 'KB-1', n: 'a' }, { id: 'KB-2', n: 'b' }, { id: 'KB-1', n: 'doppelt' }], goods: [{ id: 'DUE-1-1', splitFrom: 'DUE-1', packIndex: 1 }, { id: 'DUE-1-2', splitFrom: 'DUE-1', packIndex: 2 }], num: [{ id: 5, n: 'fünf' }] };
    const h = load(['by'], db);
    assert.equal(h.by('kb', 'KB-1').n, 'a', 'erster Treffer gewinnt');
    assert.equal(h.by('kb', 'KB-2').n, 'b');
    assert.deepEqual(h.by('kb', 'KB-9'), {}, 'unbekannte ID gibt leeres Objekt');
    assert.equal(h.by('num', '5').n, 'fünf', 'lockerer Vergleich Zahl/Text wie bisher');
    assert.equal(h.by('goods', 'DUE-1').id, 'DUE-1-1', 'früher aufgeteilte Dübel-ID führt zur ersten Packung');
    assert.deepEqual(h.by('nichts', 'x'), {}, 'unbekannte Sammlung');
    db.kb.push({ id: 'KB-3', n: 'neu' });   // im selben Arbeitsschritt hinzugefügt
    assert.equal(h.by('kb', 'KB-3').n, 'neu', 'neue Einträge werden sofort gefunden');
    db.kb = [{ id: 'KB-1', n: 'ersetzt' }];  // ganze Liste ersetzt
    assert.equal(h.by('kb', 'KB-1').n, 'ersetzt');
    assert.deepEqual(h.by('kb', undefined), {}, 'ohne ID leeres Objekt');
  });

  it('Tempo: today() und normTxt() liefern dieselben Werte wie zuvor', () => {
    const h = load(['localIso', 'today', 'normTxt'], {});
    assert.match(h.today(), /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(h.today(), new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Zurich' }).format(new Date()));
    assert.equal(h.normTxt('Pleurotus Ostréatus – Königs-Austernpilz!'), 'pleurotus ostreatus konigs austernpilz');
    assert.equal(h.normTxt(null), '');
    assert.equal(h.normTxt('Äpfel'), h.normTxt('Äpfel'), 'zweiter Aufruf (aus dem Zwischenspeicher) gleich');
  });
});
