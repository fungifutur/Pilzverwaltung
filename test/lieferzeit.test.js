'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../lib/lieferzeit');

test('Zweistellige Wochen werden richtig gelesen', () => {
  assert.equal(L.parseDeliveryDays('12 - 14 Wochen'), 98);
  assert.equal(L.parseDeliveryDays('0 - 2 Wochen'), 14);
  assert.equal(L.parseDeliveryDays('3 Tage'), 3);
  assert.equal(L.parseDeliveryDays('sofort lieferbar'), 0);
});

test('Lieferzeit: Lager oder Lieferrückstand je nach Lagerlage (einfaches Produkt)', () => {
  const acf = { acf: { lieferzeit_lager: '0 - 2 Wochen', lieferzeit_lieferrueckstand: '12 - 14 Wochen' } };
  assert.equal(L.pickDeliveryText({ ...acf, stock_status: 'instock', manage_stock: true, stock_quantity: 5 }, null), '0 - 2 Wochen');
  assert.equal(L.pickDeliveryText({ ...acf, stock_status: 'onbackorder', manage_stock: true, stock_quantity: 0 }, null), '12 - 14 Wochen');
  assert.equal(L.pickDeliveryText({ ...acf, manage_stock: true, stock_quantity: -2 }, null), '12 - 14 Wochen');
});

test('Lieferzeit: Felder am Elternprodukt bei Varianten, Fallback auf das andere Feld', () => {
  const parent = { meta_data: [{ key: 'lieferzeit_lager', value: '1 - 2 Wochen' }] };
  assert.equal(L.pickDeliveryText({ manage_stock: true, stock_status: 'onbackorder' }, parent), '1 - 2 Wochen');
  assert.equal(L.pickDeliveryText({ meta_data: [{ key: 'lieferzeit', value: '3 Tage' }] }, parent), '3 Tage');
  assert.equal(L.pickDeliveryText({}, {}), '');
});

test('Spätestes Versanddatum aus Bestellungs-Metadaten (auch andere Plugin-Schlüssel)', () => {
  assert.equal(L.latestShippingFromMeta({ meta_data: [{ key: 'latest_shipping_date', value: '10.02.2027' }] }), '2027-02-10');
  assert.equal(L.latestShippingFromMeta({ meta_data: [{ key: '_production_latest_ship_date', value: '2027-02-10 00:00:00' }] }), '2027-02-10');
  assert.equal(L.latestShippingFromMeta({ meta_data: [{ key: '_billing_phone', value: '2027-02-10' }] }), '');
  assert.equal(L.latestShippingFromMeta({}), '');
});
