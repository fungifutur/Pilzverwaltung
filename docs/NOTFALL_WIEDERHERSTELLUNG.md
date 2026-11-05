# Notfall: Datenbank wiederherstellen

Gilt, wenn die Render-Datenbank der Pilzverwaltung ausgefallen, beschädigt oder gelöscht ist.
Das externe Backup läuft jede Nacht (GitHub Actions → verschlüsselt → Google Drive, Ordner `Pilzverwaltung-Backups`).

## Was du brauchst
- Das Passwort `BACKUP_PASSPHRASE` (Passwortmanager). Ohne dieses Passwort lässt sich kein Backup öffnen.
- Zugang zum Google Drive mit dem Ordner `Pilzverwaltung-Backups`.
- `gpg` (Windows: Gpg4win) und `pg_restore` in **Version 18** (kommt mit PostgreSQL 18 bzw. pgAdmin; Windows-Pfad: `C:\Program Files\PostgreSQL\18\bin\pg_restore.exe`).
- Zugang zu Render (Dienst «Pilzverwaltung» und Datenbank).

## Was im Backup steckt und was nicht
- Enthalten: alle Live-Daten (`app_state`), Einstellungen, Geräte, Sitzungen, Webhook-Warteschlange.
- Nicht enthalten: der Inhalt der Tabelle `app_backups` (interne Rückgängig-Stände). Die Tabelle wird leer zurückgespielt.
- Stand = letzte Nacht. Änderungen seit dem letzten Backup (bis ca. 24 Stunden) fehlen. WooCommerce-Bestellungen holt der Abgleich nach (Schritt 7), Eingaben, die nur in der Pilzverwaltung existierten, nicht.

## Schritte

1. **Neuestes Backup holen.** Aus dem Drive-Ordner die Datei mit dem jüngsten Datum `pilzverwaltung_JJJJMMTT_HHMMSS.dump.gpg` herunterladen, z. B. nach `C:\notfall`.

2. **Entschlüsseln** (Eingabeaufforderung):
   ```
   cd C:\notfall
   gpg --output wiederherstellung.dump --decrypt pilzverwaltung_DATUM.dump.gpg
   ```
   Passwort `BACKUP_PASSPHRASE` eingeben.

3. **Ziel-Datenbank bereitstellen.**
   - Existiert die Render-Datenbank noch und ist erreichbar: diese verwenden (Schritt 4 überschreibt den Inhalt).
   - Sonst in Render eine neue PostgreSQL-Datenbank anlegen (Version 18). Dann die «External Database URL» kopieren.

4. **Zurückspielen:**
   ```
   "C:\Program Files\PostgreSQL\18\bin\pg_restore.exe" --no-owner --clean --if-exists -d "EXTERNAL_DATABASE_URL" C:\notfall\wiederherstellung.dump
   ```
   Warnungen wie «does not exist, skipping» sind bei `--clean --if-exists` normal. Bricht der Befehl mit einer Versionsmeldung ab, ist `pg_restore` zu alt (mind. Version 18).

5. **Prüfen** (pgAdmin, Query Tool auf der wiederhergestellten Datenbank):
   ```sql
   SELECT id, updated_at, pg_size_pretty(pg_column_size(data)::bigint) AS groesse FROM app_state;
   ```
   Erwartet: eine Zeile mit `id = 1`, aktuellem Zeitstempel und einigen hundert kB.

6. **App verbinden** (nur bei neuer Datenbank): In Render beim Dienst «Pilzverwaltung» unter Environment die Variable `DATABASE_URL` auf die neue **Internal** Database URL setzen und den Dienst neu starten. Danach `https://pilzverwaltung.onrender.com/api/health?strict=1` aufrufen: `"ok":true` und `"database":true` müssen erscheinen.

7. **Mit WooCommerce abgleichen.** In der Pilzverwaltung einmal «Mit WooCommerce abgleichen» klicken. Das lädt Bestellungen seit dem Backup nach und stellt die Reservierungen wieder her. Danach Bestände und Reservierungen stichprobenartig mit WooCommerce vergleichen.

8. **Aufräumen.** Entschlüsselte Datei `wiederherstellung.dump` löschen (enthält die Daten ungeschützt). Nur das verschlüsselte Original behalten.

## Danach
- Prüfen, dass das nächtliche Backup wieder läuft: GitHub → Actions → «DB-Backup nach Google Drive». Bei neuer Datenbank das Repository-Secret `BACKUP_DATABASE_URL` auf die neue **External** Database URL ändern und den Workflow einmal manuell starten (Run workflow, Branch `main`, nicht «Re-run»).
- Bei Datenverlust seit dem Backup: die Pilzverwaltung-Eingaben der letzten Stunden bzw. Tage nachtragen.

## Backup-Probleme
- Lauf rot oder Datei fehlt: Actions-Protokoll öffnen. Typische Ursachen: `PG_MAJOR` passt nicht zur Render-Postgres-Version (Repository-Variable setzen), `BACKUP_DATABASE_URL` veraltet, Google-Drive-Token abgelaufen (`GDRIVE_RCLONE_TOKEN` neu erzeugen mit `rclone authorize "drive"`).
- Mindestens alle paar Wochen kontrollieren, dass täglich eine neue Datei im Drive-Ordner liegt.
