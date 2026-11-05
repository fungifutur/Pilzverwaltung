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
| OPS-01 / M2 | Backup | Nächtlicher verschlüsselter `pg_dump` nach Google Drive über GitHub Actions (siehe unten), Wiederherstellung getestet |

## Was bewusst NICHT geändert wurde

- **INT-04 / M8:** Umgang mit on-hold ist entschieden und umgesetzt (Vorauskasse reserviert, Storno gibt frei). Offen bleibt die grundsätzliche Frage, welches System den Bestand führt.
- **SEC-04** (Escaping im Frontend): in Version 1.5.27 umgesetzt (siehe Änderungsliste in README.md). **SEC-05 SRI**: weiterhin offen, SheetJS konnte in dieser Umgebung nicht heruntergeladen werden, um es lokal auszuliefern oder mit Prüfsumme zu sichern.
- **INT-08, INT-10 (b)(c):** in Version 1.5.28 umgesetzt (siehe README.md). **INT-10 (a)** erledigt: Dübel-Sets bestehen nur noch aus Einzelprodukten.
- **INT-07 (Vorbereitung):** in Version 1.5.29 Server/Browser-Vergleich mit 0 Abweichungen, zwei Serverfehler behoben.
- **INT-07 (Hauptschritt):** in Version 1.5.31 umgesetzt: Bestand rechnet der Server, WooCommerce bekommt nur noch Serverzahlen. Rest: FIFO-Vorschau im Browser.
- **COD-02/M16 (Teil), INT-07 (Rest):** in Version 1.5.32: Set-Rezepte in den Daten, FIFO-Zuteilung nur noch auf dem Server.
- **COD-02/M16 (Rezepte, Katalog):** in Version 1.5.33: Rezepte in der Oberfläche bearbeitbar (Admin-Passwort), Katalog folgt den Rezepten.
- **INT-07, COD-01, COD-02, M14–M18** (doppelte Bestandslogik, IDs, Stammdaten, Zielarchitektur): gehören in die Migration.
- **OPS-04 Lock-Datei:** `package-lock.json` ist eingecheckt.
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

## Automatisches Backup nach Google Drive (GitHub Actions)

Workflow: `.github/workflows/db-backup.yml`, läuft täglich ca. 02:30 und manuell über Actions → «DB-Backup nach Google Drive» → Run workflow.
Ablauf: `pg_dump` der Render-Datenbank → Verschlüsselung (AES256, Passwort) → Upload nach Google Drive, Ordner `Pilzverwaltung-Backups` → Dateien älter als 30 Tage werden gelöscht. Schlägt ein Lauf fehl, schickt GitHub eine E-Mail.

Benötigte Repository-Secrets (Settings → Secrets and variables → Actions):
- `BACKUP_DATABASE_URL`: «External Database URL» der Render-Datenbank
- `BACKUP_PASSPHRASE`: langes Passwort für die Verschlüsselung. Separat und sicher aufbewahren, ohne das Passwort lässt sich kein Backup öffnen.
- `GDRIVE_RCLONE_TOKEN`: Google-Drive-Token von `rclone config` / `rclone authorize "drive"`

Optionale Variablen: `PG_MAJOR` (Standard 16; auf Render läuft Postgres 18, dort ist die Variable auf 18 gesetzt), `BACKUP_KEEP_DAYS` (Standard 30).
Hinweis: Der Inhalt der Tabelle `app_backups` (interne Rückgängig-Stände der App, auf Render ca. 1,5 GB) wird im externen Backup standardmässig weggelassen; die Live-Daten (`app_state`) sind vollständig gesichert. Vollsicherung: Skript-Variable `BACKUP_EXCLUDE_DATA` leer setzen.

Wiederherstellung testen: `gpg --decrypt DATEI.dump.gpg | pg_restore --no-owner --clean --if-exists -d "<URL einer LEEREN Test-Datenbank>"`
