# Notfallblatt (OPS-05) – bitte ausdrucken

Stand: Version 1.5.36. Für den Fall, dass die Pilzverwaltung, WooCommerce oder bexio ausfällt. Die technische Wiederherstellung der Datenbank steht in `docs/NOTFALL_WIEDERHERSTELLUNG.md`.

## Was passiert bei einem Ausfall?

- **WooCommerce verkauft weiter** mit dem zuletzt gemeldeten Bestand. Es besteht die Gefahr, dass mehr verkauft wird, als da ist.
- **Bestellungen**, die während des Ausfalls eintreffen, fehlen in der App. Sie werden nachgeholt, sobald die App wieder läuft (WooCommerce-Abgleich).
- **Chargen, QR-Etiketten und Bestand** sind in der App; ohne App auf Papier/Zettel notieren, was hergestellt, verbraucht, verkauft wird.

## Erkennen

- UptimeRobot meldet «Down» (E-Mail), oder die Seite lädt nicht.
- Kontrolle: `https://DEINE-APP.onrender.com/api/health` im Browser. «ok: true» = in Ordnung.

## Die ersten 15 Minuten

| # | Wer | Was |
|---|---|---|
| 1 | wer es zuerst sieht | Zweite Person informieren. Seite neu laden, Gesundheitsprüfung (oben) öffnen. |
| 2 | Verantwortliche/r Technik | In Render den Dienst und die Datenbank prüfen: Status, letzte Meldungen (Logs). Kurzer Neustart des Dienstes (Manual Deploy / Restart). |
| 3 | Verantwortliche/r Shop | Dauert es länger als 1 Stunde: in WooCommerce die Produkte mit knappem Bestand auf «nicht vorrätig» stellen oder den Shop in den Wartungsmodus setzen. |
| 4 | alle | Bis zur Rückkehr auf Papier festhalten: Herstellung, Verbrauch, Verkauf (Datum, Charge/ID, Menge). |

## Daten verloren oder beschädigt?

1. **Nicht** weiter in der App arbeiten.
2. Anleitung `docs/NOTFALL_WIEDERHERSTELLUNG.md` befolgen (Backup in Google Drive `Pilzverwaltung-Backups`, verschlüsselt; Passphrase aus dem Passwortmanager).
3. Nach der Wiederherstellung: einmal **«Mit WooCommerce abgleichen»** ausführen, dann Bestand je Artikel stichprobenartig prüfen.

## Nach dem Ausfall (manueller Abgleich)

1. In der App «Mit WooCommerce abgleichen» (holt fehlende Bestellungen).
2. Papiernotizen nachtragen (Chargen, Verkäufe).
3. Bestand in der App mit dem Lager vergleichen; Abweichungen korrigieren. Die App meldet den Bestand danach an WooCommerce.
4. Shop wieder öffnen / Produkte wieder auf «vorrätig».

## Wenn WooCommerce oder bexio ausfällt

- **WooCommerce down:** keine neuen Bestellungen. Die App bleibt nutzbar (Herstellung, Etiketten). Nach der Rückkehr abgleichen (siehe oben).
- **bexio down:** Rechnungen und Zahlungsabgleich verschieben; Direktverkäufe auf Papier notieren und nachträglich in bexio erfassen.

## Zugänge (nur ausgeben, nicht hier eintragen)

Passwörter stehen **nicht** auf diesem Blatt, sondern im Passwortmanager. Dort liegen: App-Passwort, Rescue-Passwort, Render, GitHub, Google Drive, Backup-Passphrase, WooCommerce, bexio, UptimeRobot.

## Kontakte (ausfüllen)

| Rolle | Name | Telefon |
|---|---|---|
| Technik / Render | | |
| Shop / WooCommerce | | |
| Buchhaltung / bexio | | |
| Stellvertretung | | |
