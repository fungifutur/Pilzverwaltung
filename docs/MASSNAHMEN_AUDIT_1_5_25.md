# Massnahmen aus dem IT-Audit – Version 1.5.25

Grundlage: «IT-Audit Pilzverwaltung – Fungi Futuri» vom 26.10.2026.
Leitlinie: Die bestehende PostgreSQL-Datenbank bleibt unverändert nutzbar. Bestehende Tabellen und das Datenformat
(`app_state` mit einem JSON-Dokument, `app_backups`, `app_settings`, `app_devices`) werden weiterverwendet.
Neu sind nur die zwei Tabellen `app_sessions` und `app_webhook_queue`, die beim Start automatisch angelegt werden.

## Was geändert wurde

| Audit-Nr. | Massnahme | Umsetzung |
|---|---|---|
| SEC-01 / M3 | Absturzfehler | `await` bei `handleApi`/`serveStatic`, ungültiges JSON → 400, fehlerhafte %-Kodierung und Cookies abgefangen, globale Fehler-Handler, Fehler auf ruhenden DB-Verbindungen beenden den Prozess nicht mehr, Zeitlimit für WooCommerce-Aufrufe |
| INT-02 / M4 | Webhooks gehen nicht mehr verloren | Alle Schreibvorgänge laufen unter einer Sperre (Warteschlange im Prozess plus `pg_advisory_lock` in der DB, auch bei überlappenden Deployments) |
| INT-01, INT-03 / M5 | Veraltete Browserstände überschreiben nichts mehr | Der Server liefert einen Datenstand (Header `X-Data-Version`). Speichern ist nur auf aktuellem Stand möglich, sonst 409 und der Browser lädt neu. Bestellungen, Reservierungen und Sync-Protokoll zählen nicht mit (kein Konflikt bei jeder neuen Bestellung) |
| INT-05 / M7 | Fehlgeschlagene Bestellungen werden wiederholt | Webhook wird sofort quittiert und in `app_webhook_queue` abgelegt. Wiederholung mit steigenden Abständen (bis 10 Versuche). Optional täglicher Abgleich mit `AUTO_RECONCILE_HOURS` |
| INT-05 | Reihenfolge Speichern/Sync | Erst speichern, dann an WooCommerce melden. Fehlgeschlagene Meldungen werden alle 10 Minuten automatisch wiederholt |
| INT-02 | Verspätete Ereignisse | Ein älteres Webhook-Ereignis setzt einen neueren Stand nicht zurück (`date_modified`) |
| WOO-01 | Webhook-Topic | Nur `order.*`-Ereignisse mit Bestellform werden verarbeitet; `order.deleted` gilt als Papierkorb |
| WOO-02 | Abgleich | Archivierte Bestellungen werden nicht mehr einzeln abgefragt; Lieferzeit-Cache verfällt nach 1 Stunde; Lesen und Anwenden getrennt, damit der Abgleich Speichern und Webhooks nicht blockiert |
| INT-06 | SKU-Fallback | Nur exakter SKU-Treffer, kein erstes Suchergebnis mehr |
| INT-09 | Datenwachstum | Reservierungsdatensätze `replaced` nach 7 Tagen, `released` nach 90 Tagen gelöscht; Rückgängig-Sicherungen auf 10 begrenzt; erledigte Webhook-Einträge nach 7 Tagen gelöscht |
| SEC-02 / M9 | Durchprobieren | Sperre nach 5 Fehlversuchen je IP (steigend bis 15 Min.), zusätzliche Gesamtgrenze, auch für das Admin-Passwort im Header. Ohne `APP_PASSWORD` ist jetzt alles gesperrt (früher offen). Warnung bei Passwörtern unter 12 Zeichen |
| SEC-03 | Sitzungen | Zufällige Sitzungen in `app_sessions` (90 Tage), zeitkonstanter Vergleich, Abmelden möglich (`/api/logout`), Passwortwechsel macht alle Sitzungen ungültig |
| SEC-05 | Header | CSP, `X-Frame-Options`, `nosniff`, HSTS, Referrer-Policy; Notschalter `CSP_REPORT_ONLY=1` |
| SEC-06 | Destruktive Aktionen | Backup einspielen nur mit Admin-Passwort; Massenlöschung (eine Sammlung mit mind. 10 Einträgen um mehr als die Hälfte kleiner, z. B. Reset) verlangt das Admin-Passwort. Rückgängig wird gesperrt, wenn seither WooCommerce Daten geändert hat |
| SEC-07 | Ressourcen | Geräte werden erst nach korrektem Passwort registriert; `/api/qr` nur nach Anmeldung; Body-Limits (Login 10 KB, Webhook 2 MB, übrige 1 MB) |
| SEC-08 | TLS | Mit `PGSSL_CA` wird das Datenbankzertifikat geprüft (sonst unverändert) |
| DSG-01 / M11 | Kundendaten | Es werden nur Vor- und Nachname gespeichert; bestehende Bestellungen werden beim nächsten Schreiben bereinigt |
| OPS-02 | Aufbewahrung | Rückgängig-Sicherungen begrenzt; neue Backup-Arten sind in der Liste beschriftet |
| OPS-03 / M6 | Alarmierung | `/api/health?strict=1` mit Status 503 bei Problemen; optional `ALERT_WEBHOOK_URL` |
| OPS-04 | Konfiguration | `render.yaml` um fehlende Variablen ergänzt, `npm ci`; `.gitignore` |
| COD-03 | Tests | Integrationstest `test/integration.test.js` (22 Tests, siehe unten); veraltetes MySQL-Schema gekennzeichnet |
| COD-04 | Toter Code | Endpunkt `/api/woo/orders` (rief eine nicht vorhandene Funktion auf) entfernt |
| OPS-01 / M2 | Backup | `scripts/pg_backup.sh` (verschlüsselter `pg_dump` ausserhalb von Render). Muss noch eingerichtet und geplant werden |

## Was bewusst NICHT geändert wurde

- **INT-04 / M8:** Umgang mit on-hold ist entschieden und umgesetzt (Vorauskasse reserviert, Storno gibt frei). Offen bleibt die grundsätzliche Frage, welches System den Bestand führt.
- **SEC-04** (Escaping im Frontend, `innerHTML`) und **SEC-05 SRI**: erfordern eine Durchsicht der rund 6000 Zeilen Oberfläche. SheetJS konnte in dieser Umgebung nicht heruntergeladen werden, um es lokal auszuliefern oder mit Prüfsumme zu sichern.
- **INT-07, INT-08, INT-10, COD-01, COD-02, M14–M18** (doppelte Bestandslogik, IDs, Stammdaten, Zielarchitektur): gehören in die Migration.
- **OPS-04 Lock-Datei:** konnte hier nicht erzeugt werden (kein Zugriff auf das npm-Register). Einmal `npm install` ausführen und `package-lock.json` einchecken.
- Organisatorisches (ORG-*, DSG-02/03, FIN-*, WOO-03/04, OPS-05): nicht Sache des Codes.

## Hinweise zum Betrieb

- Nach dem Update müssen sich alle einmal neu anmelden. Gerätefreigaben bleiben bestehen.
- Wird ein Browser mit veraltetem Stand abgewiesen, erscheint eine Meldung, die Daten werden neu geladen und die Änderung muss wiederholt werden. Das ist beabsichtigt (vorher wurden Daten stillschweigend überschrieben).
- Wer die Oberfläche geöffnet hat, sollte sie einmal neu laden (Strg+Shift+R), damit die neue Version aktiv ist. Ältere Browserseiten senden keinen Datenstand mit und werden abgewiesen.
- Nach dem Deployment kurz durchklicken: Etikettendruck, QR-Scan, Excel-Import, Export. Die neue Inhaltsrichtlinie wurde nur für Anmeldung, Laden und Speichern im Browser geprüft. Falls etwas blockiert wird, `CSP_REPORT_ONLY=1` setzen und melden.
- Datenbank sichern, bevor die neue Version eingespielt wird (Administration → Backup erstellen).

## Tests

`npm test` mit `TEST_DATABASE_URL=postgres://…@localhost/…` (nur lokale Testdatenbank, der Test löscht dort die `app_*`-Tabellen und legt sie im Format 1.5.24 mit Beispieldaten an).
Geprüft werden unter anderem: Start mit Datenbank im alten Format, Login und Sperre, Geräte-Freigabe, Versionskonflikt, gleichzeitige Webhooks, Wiederholung fehlerhafter Webhooks, Ausbuchung durch Webhook, Datenminimierung, Backup/Restore/Undo, Abgleich, Passwortwechsel.
Die Tests wurden gegen PostgreSQL 16 ausgeführt: 22 von 22 bestanden. Die Oberfläche wurde zusätzlich in Chromium für Anmeldung, Laden, Speichern, Konfliktmeldung und Admin-Abfrage beim Massenlöschen geprüft.
Nicht geprüft werden konnte: ein echter WooCommerce-Shop (die Tests verwenden eine Attrappe), die Render-Umgebung, QR-Code-Erzeugung (Modul `qrcode` war hier nicht installierbar) und der Excel-Import.
