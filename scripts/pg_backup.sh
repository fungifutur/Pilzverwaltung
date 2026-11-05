#!/usr/bin/env bash
# Täglicher, unabhängiger Datenbank-Dump (Audit OPS-01 / M2). Legt eine verschlüsselte Datei AUSSERHALB von Render ab.
#
# Benötigt: pg_dump (passend zur Postgres-Version bei Render) und gpg.
# Umgebungsvariablen:
#   BACKUP_DATABASE_URL   externe Verbindungs-URL der Render-Datenbank (Render → Datenbank → «External Database URL»)
#   BACKUP_GPG_RECIPIENT  E-Mail/ID des GPG-Schlüssels, mit dem verschlüsselt wird (öffentlicher Schlüssel genügt)
#   BACKUP_DIR            Zielordner, z. B. ein gemountetes Laufwerk bei hosttech oder ein lokaler Ordner (Standard: ./backups)
#   BACKUP_KEEP_DAYS      Aufbewahrung in Tagen (Standard 30)
# Beispiel Cron (täglich 02:30):  30 2 * * *  /pfad/zu/scripts/pg_backup.sh >> /var/log/pilz_backup.log 2>&1
set -euo pipefail
: "${BACKUP_DATABASE_URL:?BACKUP_DATABASE_URL fehlt}"
: "${BACKUP_GPG_RECIPIENT:?BACKUP_GPG_RECIPIENT fehlt}"
DIR="${BACKUP_DIR:-./backups}"; KEEP="${BACKUP_KEEP_DAYS:-30}"
mkdir -p "$DIR"
FILE="$DIR/pilzverwaltung_$(date +%Y%m%d_%H%M%S).dump.gpg"
pg_dump --format=custom --no-owner --no-privileges "$BACKUP_DATABASE_URL" | gpg --batch --yes --encrypt --recipient "$BACKUP_GPG_RECIPIENT" --output "$FILE"
[ -s "$FILE" ] || { echo "Backup ist leer: $FILE" >&2; exit 1; }
echo "Backup erstellt: $FILE ($(du -h "$FILE" | cut -f1))"
find "$DIR" -name 'pilzverwaltung_*.dump.gpg' -mtime +"$KEEP" -delete
# Wiederherstellung testen (mindestens einmal!):
#   gpg --decrypt DATEI.dump.gpg | pg_restore --no-owner --clean --if-exists -d "<URL einer LEEREN Test-Datenbank>"
