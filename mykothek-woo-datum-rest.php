<?php
/**
 * Plugin Name: Mykothek WooCommerce Versanddatum REST
 * Description: Gibt das im vorhandenen Mykothek-Produktion-Plugin berechnete Versanddatum an die Pilzverwaltung weiter.
 * Version: 1.0.0
 */
if (!defined('ABSPATH')) exit;
add_filter('woocommerce_rest_prepare_shop_order_object', function($response, $order, $request) {
    if (!is_object($response) || !is_object($order)) return $response;
    if (!function_exists('mykothek_produktion_berechne_spaetestes_versanddatum_bestellung')) return $response;
    $date = mykothek_produktion_berechne_spaetestes_versanddatum_bestellung($order);
    if (is_string($date) && preg_match('/^(\d{2})\.(\d{2})\.(\d{4})$/', $date, $m)) {
        $response->data['latest_shipping_date'] = $m[3].'-'.$m[2].'-'.$m[1];
    }
    return $response;
}, 10, 3);
