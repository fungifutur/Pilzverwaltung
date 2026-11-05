# Löschkonzept und Aufbewahrung (M18, DSG-03, OPS-02)

Stand: Version 1.5.36. Dieses Dokument legt fest, **welche Daten wo wie lange** aufbewahrt werden und wie ein Auskunfts- oder Löschbegehren bearbeitet wird. Es ist keine Rechtsberatung. Die mit **«prüfen»** markierten Punkte bitte mit der Treuhänderin oder dem Treuhänder bzw. der Datenschutzberatung bestätigen.

## 1. Welche Personendaten gibt es überhaupt?

Die Pilzverwaltung speichert von Kundinnen und Kunden **nur Vor- und Nachname** (keine Adresse, E-Mail, Telefon; seit DSG-01). Adressen und Rechnungsdaten liegen in **WooCommerce** und **bexio**. Weitere Personenbezüge: IP-Adresse und Browserkennung der Geräte, Freitext-Bemerkungen.

## 2. Fristen je Datenobjekt und System

| Datenobjekt | System | Frist | Wie durchgesetzt |
|---|---|---|---|
| Name in offener Bestellung (bezahlt/Vorauskasse) | Pilzverwaltung | solange die Bestellung offen ist | – |
| Name in abgeschlossener/stornierter Bestellung | Pilzverwaltung | **90 Tage** nach Abschluss, danach gelöscht (Bestellnummer, Artikel, Mengen bleiben) | automatisch bei jedem Speichern (`ORDER_NAME_KEEP_DAYS`, Standard 90) |
| Bestellung mit Adresse, E-Mail, Telefon | WooCommerce | gesetzliche Aufbewahrung (Geschäftsunterlagen, 10 Jahre) – **prüfen** | ausserhalb der App |
| Rechnung, Zahlungen | bexio | gesetzliche Aufbewahrung, 10 Jahre – **prüfen** | ausserhalb der App |
| Webhook-Eingang (Bestellung als Rohdaten) | Pilzverwaltung | nach erfolgreicher Verarbeitung nur noch Nummer und Status, Eintrag nach 7 Tagen gelöscht; **fehlgeschlagene** Einträge (mit vollständigen Daten, für die Wiederholung) nach 30 Tagen | automatisch |
| Freitext «Interne Bemerkung» zur Bestellung | Pilzverwaltung | wird von Hand geführt: **keine Personendaten hineinschreiben** | Hinweis an das Team |
| Reservierungsdatensätze | Pilzverwaltung | ersetzte nach 7 Tagen, freigegebene nach 90 Tagen | automatisch |
| Geräteeintrag (Gerätename, Browser, letzte IP) | Pilzverwaltung | bis zum Entfernen in der Geräteverwaltung; Vorschlag: nicht mehr benutzte Geräte nach **12 Monaten** entfernen (von Hand, 2× pro Jahr prüfen) | manuell |
| Sitzung (Anmeldung) | Pilzverwaltung | 90 Tage (`SESSION_DAYS`), abgelaufene werden stündlich gelöscht | automatisch |
| Chargen, Bestand, Produktion | Pilzverwaltung | unbefristet (keine Personendaten) | – |

## 3. Backups (enthalten die oben genannten Namen)

| Backup | Wo | Frist | Wie durchgesetzt |
|---|---|---|---|
| Tages-Backups | Datenbank der Pilzverwaltung | **30 Tage** (die neuesten 2 bleiben immer) | automatisch, stündlich geprüft |
| Änderungs-Backups (bei Speichern/Webhook) | Datenbank | **14 Tage** (höchstens 50 je Art, die neuesten 2 bleiben) | automatisch |
| «Rückgängig»-Sicherung | Datenbank | **7 Tage** (höchstens 10) | automatisch |
| Manuelle Backups | Datenbank | **90 Tage** (die neuesten 2 bleiben) | automatisch |
| Nächtliche Sicherung (verschlüsselt) | Google Drive `Pilzverwaltung-Backups` | **30 Tage** (`BACKUP_KEEP_DAYS`) | automatisch durch den Backup-Lauf |
| Datenbank-Backups des Hosters | Render | je nach Tarif – **prüfen**, welche Frist gilt | ausserhalb der App |

Folge: **Spätestens 90 Tage** nach einer Löschung in der App sind die Namen auch aus allen Sicherungen verschwunden (manuelle Backups sind die längsten; die übrigen früher). Bei einem Löschbegehren wird die Sicherung nicht einzeln bereinigt, sondern läuft ab; stellt man ein altes Backup wieder her, muss die Löschung danach erneut ausgeführt werden.

## 4. Auskunfts- oder Löschbegehren bearbeiten

1. **Eingang notieren** (Datum, Person, Anliegen) und die Identität prüfen. Frist für die Antwort: in der Regel 30 Tage.
2. **WooCommerce:** Kunde und Bestellungen suchen. Auskunft: Daten exportieren. Löschung: Kundenkonto löschen; Bestellungen mit Aufbewahrungspflicht nur anonymisieren oder sperren, nicht löschen – **prüfen**.
3. **bexio:** Kontakt und Belege suchen. Belege unterliegen der Aufbewahrungspflicht; nicht mehr benötigte Kontaktangaben anonymisieren – **prüfen**.
4. **Pilzverwaltung, Auskunft:** In der Bestellliste nach dem Namen suchen (Bestellungen sind Name, Nummer, Artikel). Mehr Daten gibt es zur Person nicht.
5. **Pilzverwaltung, sofortige Löschung des Namens** (statt 90 Tage zu warten): in pgAdmin (Render-Datenbank) die folgende Abfrage ausführen. Zuerst `beispiel` durch den **Nachnamen** (Kleinbuchstaben genügen) ersetzen und mit der SELECT-Zeile prüfen, welche Bestellungen betroffen sind:

```sql
-- Prüfen: welche Bestellungen enthalten den Namen?
SELECT o->>'number' AS bestellung, o->>'customer' AS name
FROM app_state, jsonb_array_elements(data->'wooOrders') o
WHERE id = 1 AND (lower(o->>'customer') LIKE lower('%beispiel%') OR lower(o#>>'{billing,last_name}') LIKE lower('%beispiel%'));

-- Löschen: Namen und Kundenhinweis dieser Bestellungen leeren (Bestellung selbst bleibt)
UPDATE app_state SET data = jsonb_set(data, '{wooOrders}', (
  SELECT COALESCE(jsonb_agg(CASE
    WHEN lower(o->>'customer') LIKE lower('%beispiel%') OR lower(o#>>'{billing,last_name}') LIKE lower('%beispiel%')
    THEN o || '{"customer":"","billing":{"first_name":"","last_name":""},"shipping":{"first_name":"","last_name":""},"customer_note":"","anonymized":true}'::jsonb
    ELSE o END), '[]'::jsonb)
  FROM jsonb_array_elements(data->'wooOrders') o))
WHERE id = 1;
```
   Danach in den internen Bemerkungen der Bestellungen nach dem Namen suchen und von Hand entfernen.
6. **Backups:** laufen innerhalb der Fristen in Abschnitt 3 ab. Bei einem Wiederherstellen eines alten Backups Schritt 5 wiederholen.
7. **Antwort** an die Person mit Übersicht, was in welchem System gelöscht, anonymisiert oder aus Rechtsgründen behalten wurde. Vorgang mit Datum festhalten.

## 5. Regelmässige Kontrollen (2× pro Jahr)

- Geräteverwaltung: nicht mehr benutzte Geräte entfernen.
- Google Drive: Ordner `Pilzverwaltung-Backups` enthält nur Dateien der letzten 30 Tage.
- Render: Backup-Frist des Datenbank-Tarifs prüfen und hier eintragen.
- Dieses Dokument aktuell halten, wenn Fristen oder Systeme ändern.
