# Version 1.5.41 – Auto-Sync ist Standard für zugeordnete Produkte

Jedes Produkt mit zugeordnetem Bereich (alles ausser «Sonstige / nicht zugeordnet») hat jetzt automatisch Auto-Sync an. Das gilt für Stammdaten und für importierte Produkte, sobald ihnen ein Bereich zugeordnet wird. Beim Start der App werden fehlende Einschaltungen nachgeholt und gespeichert. Aus bleibt Auto-Sync nur, wenn du ein Produkt oder eine Gruppe bewusst ausschaltest. Die App merkt sich das und schaltet es nicht wieder ein. Interne Komponenten (INT_…) werden nie synchronisiert.

Vorherige Version 1.5.40:

Unter Einstellungen → WooCommerce Sync → «Lokaler Produktkatalog / Bestandsart» zeigt die Tabelle jetzt standardmässig nur Produkte, die noch keinem Bereich zugeordnet sind, mit Zähler («55 nicht zugeordnet · 65 im Katalog insgesamt»). Mit dem Haken «Nur nicht zugeordnete Produkte zeigen» lassen sich alle Katalogeinträge anzeigen. Ein Produkt bleibt nach der Zuordnung sichtbar, bis die Tabelle neu gezeichnet wird. Zusätzlich behoben: Die Prüfung «SKU ist schon im Katalog» erkannte Katalogeinträge nicht, ein zweiter Import konnte dieselben SKUs doppelt anlegen.

Vorherige Version 1.5.39:

Wenn bei einer Bestellung ein Fehlbestand besteht und «Produzieren» gedrückt wird, wählt die Pilzverwaltung jetzt automatisch die passende Quelle vor: den ältesten fertigen Eintrag mit gleichem Strain (Substratsack und Dübel: Körnerbrut, bei Substrat sonst Flüssigmyzel; Holzstämme: Körnerbrut, sonst Dübel; Körnerbrut: Flüssigmyzel). Gibt es keine passende fertige Quelle, steht ein Hinweis im Formular. Die Auswahl kann wie bisher von Hand geändert werden.

Vorherige Version 1.5.38:

Die Excel-Bibliothek SheetJS (Version 0.20.3) liegt jetzt in `public/vendor/xlsx.full.min.js` und wird von der Pilzverwaltung selbst ausgeliefert. Die Seite lädt keine Programme mehr von fremden Servern, und `https://cdn.sheetjs.com` ist aus der Sicherheitsregel (CSP) entfernt. Damit ist SEC-05 erledigt. Excel-Import und -Export funktionieren wie bisher.

Vorherige Version 1.5.37:

Anlass: Beim Scannen mehrerer QR-Codes mit Statusänderungen dauerte das Speichern spürbar lange. Gemessen mit den anonymisierten Echtdaten (1,7 MB Datenbestand):

- **Anzeige nach jedem Speichern ca. 3× schneller** (Neuaufbau der Seite: 550–900 ms → 180–270 ms). Ursache war vor allem das ständige lineare Nachschlagen derselben Einträge und die Berechnung des heutigen Datums über die Zeitzonen-Funktion bei jeder Zeile. Die Seite ist danach Zeichen für Zeichen identisch (3,5 MB HTML verglichen).
- **Serverseitig ca. 30 % schneller** (Speichern 280 ms → 200 ms lokal): Die Vorher-Kopie für «Rückgängig» entsteht jetzt in der Datenbank selbst statt über den Server, und der Browser lädt Bestellungen, Reservierungen und Sync-Protokoll (rund 1 MB) nicht mehr bei jedem Speichern hoch (der Server ersetzt sie ohnehin).
- **Weniger Wachstum:** Unveränderte Reservierungen behalten ihren Datensatz. Bisher entstand bei jedem Speichern für jede offene Bestellung ein neuer «ersetzter» Eintrag, der das Dokument aufblähte (im Testbestand 1281 Einträge, davon rund 1000 ersetzte).
- Auf dem Render-Tarif mit 0,1 CPU wirkt sich das stärker aus als auf einem normalen Rechner.
- Neue Tests (Nachschlagen, Datum, Reservierungen wachsen nicht); Suite 41/41 und 7/7 grün.

# Version 1.5.36 – Löschkonzept, einheitliche Aufbewahrung und Notfallblatt (M18: DSG-03, OPS-02, OPS-05)

- **Backups, einheitlich:** Alle Backup-Arten in der Datenbank haben jetzt eine Frist (bisher blieben manuelle, Rückgängig- und alte Backups für immer): Tages-Backups 30 Tage, Änderungs-Backups 14 Tage, Rückgängig 7 Tage, manuelle 90 Tage. Die neuesten Einträge bleiben immer erhalten. Die Dokumentation sagt nicht mehr «90 Tage» für alles.
- **Kundennamen:** Namen in abgeschlossenen oder stornierten Bestellungen werden 90 Tage nach Abschluss gelöscht (`ORDER_NAME_KEEP_DAYS`); Bestellnummer, Artikel und Mengen bleiben. Offene Bestellungen sind nicht betroffen.
- **Webhook-Warteschlange:** Nach erfolgreicher Verarbeitung enthält der Eintrag nur noch Nummer und Status (vorher blieben Adresse, E-Mail und Telefon 7 Tage in der Warteschlange).
- **Neue Dokumente:** `docs/LOESCHKONZEPT.md` (Fristen je Datenobjekt und System, Ablauf bei Auskunfts- oder Löschbegehren, Abfrage zur sofortigen Namenslöschung) und `docs/NOTFALLBLATT.md` (einseitig, zum Ausdrucken). Punkte mit «prüfen» bitte mit Treuhand/Datenschutz bestätigen.
- Drei neue Tests; Suite 40/40 grün.

# Version 1.5.35 – Frei gewordene Ware geht sofort an wartende Bestellungen

- Bisher bekamen wartende Bestellungen nach einer Stornierung (oder Abschluss) die frei gewordene Ware erst beim nächsten Speichern oder Abgleich; Fehlmenge und Produktionsauftrag blieben bis dahin offen. Jetzt wird die Zuteilung bei jedem WooCommerce-Ereignis neu gerechnet, mit denselben Regeln wie beim Speichern (bezahlte Bestellungen zuerst, dann Vorauskasse, jeweils nach Datum).
- Folge: Wird eine ältere Vorauskasse-Bestellung bezahlt, kann sie Ware einer jüngeren bezahlten Bestellung übernehmen (so war es beim Speichern schon).
- Abnahmebasis (`test/golden/expected.json`) bewusst angepasst: Schritt 4 und 5 zeigen das neue Verhalten. Suite 37/37 grün.

# Version 1.5.34 – Vorbereitung der Migration: Abnahmebasis und Abgleichbericht (M15, M17)

- **Abnahmebasis (M15):** `test/golden/` hält das heutige Verhalten von Bestand, Reservierung, FIFO und Sets als Referenz fest (erfundene Testdaten, 5 Bestell-Schritte). Ein neues System muss dasselbe liefern. Läuft als Test mit.
- **Abgleichbericht (M17):** `scripts/migration_report.js` erstellt aus `/api/export` und `/api/stock` einen Bericht (Anzahl, IDs für QR-Etiketten, Bestand je SKU, Reservierungen, offene Bestellungen) und vergleicht zwei Berichte vorher/nachher. Anleitung: `docs/MIGRATION_ABNAHME.md`.
- Die Anwendung selbst ist unverändert (nur Versionsnummer). Suite 37/37 grün.
- Beobachtung aus der Abnahmebasis (Storno gibt Ware erst beim nächsten Speichern frei): in Version 1.5.35 behoben.

# Version 1.5.33 – Set-Rezepte bearbeiten, Katalog folgt den Daten (COD-02, M16)

- **Rezepte bearbeiten:** Unter WooCommerce → «Lokaler Produktkatalog» gibt es neu die Karte «Set-Rezepte (Stücklisten)». Dort können Sets angelegt, geändert und gelöscht werden (eine Zeile pro Komponente: `SKU | Menge | Bezeichnung`). Speichern braucht das Admin-Passwort, weil Rezepte den Bestand bestimmen, der an WooCommerce gemeldet wird. Bestand, Reservierungen und WooCommerce-Meldung werden danach sofort neu berechnet.
- **Prüfungen auf dem Server:** ganze Zahlen von 1 bis 1000, keine doppelten Komponenten, ein Set kann sich nicht selbst enthalten, keine Verschachtelung (eine Komponente darf kein Set sein).
- **Katalog ohne feste Liste:** Die bisher fest im Programm stehende Liste interner Artikel (Körnerbrut, Stroh- und Nadelholzpellets) ist entfernt. Für jede Komponente eines Rezepts, die im Katalog fehlt, legt der Server einen internen Eintrag an (Bereich und Bestandsart aus der SKU-Schreibweise). Bestehende Einträge bleiben unverändert; gelöschte Katalogeinträge, die in keinem Rezept vorkommen, kehren nicht mehr zurück.
- Mit den anonymisierten Echtdaten in der Oberfläche geprüft (7 Sets: Anzeige, unveränderte Speicherung, Neuanlage, Löschen). Neuer Test; Suite 35/35 grün.
- Offen: Die Auswahl «Dübel-Set» im alten Herstellungsformular ist weiterhin nur über die Einzelprodukte vorgesehen; weitere feste Listen im Browser (z. B. SKU-Muster für Bereiche) folgen mit der Migration (M15/M17).

# Version 1.5.32 – Stammdaten in den Daten, FIFO-Zuteilung nur noch auf dem Server (COD-02, M16, INT-07)

- **Set-Rezepte in den Daten:** Die Stücklisten der Sets (z. B. Ppul_Exp_*, Trio_Düb_*, Star_Düb_*) stehen jetzt in den Daten (`setBoms`) statt fest im Programm. Beim ersten Start werden die bisherigen Rezepte eingetragen, Inhalt und Verhalten bleiben gleich. Der Server verwaltet sie; ein Browser kann sie nicht überschreiben. Die Bearbeitung über die Oberfläche folgt später.
- **FIFO nur auf dem Server:** Welche Charge zu welcher Bestellung gehört, entscheidet allein der Server beim Reservieren. Die Oberfläche zeigt nur noch die Reservierungen und die Fehlmenge. Die eigene FIFO-Berechnung im Browser (und eine nicht mehr genutzte Vorschau für wartende Bestellungen) ist entfernt.
- Geprüft mit den anonymisierten Echtdaten: Bestellliste (7 aktive Bestellungen) ist Zeichen für Zeichen identisch zur Vorversion. Neuer Test; Suite 34/34 grün.
- Offen: Rezepte in der Oberfläche bearbeiten; SKU-Katalog (COD-02) weiter in die Daten verlagern.

# Version 1.5.31 – Bestand wird nur noch vom Server gerechnet (INT-07, Hauptschritt)

- **Server rechnet:** Neue Abfrage `/api/stock` und jede Antwort beim Speichern liefern den Bestand pro Artikel (Physisch, Bestellungen, Produktionsreserve, Set-Reserve, Verfügbar). Die Oberfläche zeigt diese Zahlen an, statt selbst zu rechnen. Nur wenn die Serverzahlen fehlen oder nicht zum Datenstand passen, rechnet der Browser notfalls wie bisher.
- **WooCommerce:** «Bestand nach WooCommerce schreiben» (einzeln und mehrere) verwendet immer den Serverbestand. Die Zahl, die der Browser mitschickt, wird ignoriert. Damit können Browser und Server nie mehr unterschiedliche Zahlen melden.
- Geprüft mit den echten (anonymisierten) Daten: 208 Artikel, 0 Abweichungen zwischen Anzeige und lokaler Berechnung. Neuer Test; Suite 33/33 grün.
- Offen für INT-07: Die Auswahl der Chargen bei der Bestellplanung (FIFO-Vorschau) rechnet noch im Browser, die endgültige Reservierung macht aber der Server.

# Version 1.5.30 – Angebrochene Ware nicht verkäuflich, Dübel-Set aus der Auswahl

- **Nicht verkäuflich:** Angebrochene 1000er-Dübelpakete (schon in 1.5.29) und neu auch **angebrochene Körnerbrut** zählen weder als Shop-Bestand noch werden sie für Bestellungen reserviert. Gilt im Server und im Browser. Betroffene Bestellungen bekommen beim nächsten Speichern/Abgleich automatisch die nächste vollständige Charge. Der WooCommerce-Bestand der betroffenen Artikel kann sinken.
- **Dübel-Set:** Die Option «Dübel-Set / Trio» unter «Dübel herstellen» ist aus der Auswahl entfernt. Sets bestehen nur noch aus den Einzelprodukten (bestehende Set-Einträge bleiben sichtbar).
- Neuer Test: angebrochene Körnerbrut wird nicht reserviert.

# Version 1.5.29 – Bestandsabweichungen Server/Browser (INT-07, Vorbereitung)

- **Vergleich mit echten Daten:** Der Bestand wurde für alle 150 Artikel einmal vom Server und einmal vom Browser berechnet (anonymisierter Export). Es gab drei Abweichungen, zwei echte Fehler im Server wurden behoben, danach 0 Abweichungen.
- **Doppelte Reservierung in einer Bestellung:** Hatte eine Bestellung zwei Positionen derselben Ware (z. B. 2 × Ppul_Exp_600g), konnte dieselbe Charge doppelt reserviert werden. Jetzt zählt jede neue Reservierung sofort mit, die zweite Position bekommt die nächste Charge. Bestehende doppelte Reservierungen korrigieren sich beim nächsten Speichern oder Abgleich von selbst.
- **Angebrochene 1000er-Dübelpackungen:** Der Server zählte sie noch als Bestand (der Browser nicht). Jetzt zählen sie auch auf dem Server nicht mehr. Die Bestandsmeldung von Post_Düb_1000stk an WooCommerce kann dadurch um 1 sinken.
- Neue Tests: zwei Integrationstests (keine doppelte Charge, angebrochene 1000er-Dübel).
- Weiterhin offen: INT-10 (a) Dübel-Sets (inzwischen nur noch über die Einzelprodukte, Option «Dübel-Set» unter «Dübel herstellen» kann entfernt werden); restliche Schritte von INT-07 (Logik nur noch auf dem Server).

# Version 1.5.28 – IDs und Logikfehler (INT-08, INT-10)

- **INT-08 IDs:** Neue IDs werden aus der höchsten vorhandenen Nummer + 1 gebildet (früher Anzahl + 1, dadurch doppelte IDs nach Löschungen) und überspringen jede ID, die irgendwo schon vorkommt. Beim Aufteilen von 1000er-Dübeln behält die erste Packung die ursprüngliche ID (Packungen 2 bis n erhalten `-2`, `-3` …); bestehende IDs werden nicht mehr ersetzt, damit gedruckte QR-Etiketten und Bezüge gültig bleiben. Bereits früher umbenannte Dübel (`…-1`) werden über `splitFrom` auch unter der alten ID gefunden (Suche und QR-Scan). Bei zwei Geräten gleichzeitig verhindert weiterhin die Versionsprüfung (Meldung «Stand veraltet», neu laden) doppelte Speicherung; eine serverseitige ID-Sequenz gibt es noch nicht.
- **INT-10 (b) Menge 0:** Eine ausdrückliche Menge 0 zählt nicht mehr als 1 (kein Phantom-Bestand). Fehlt die Mengenangabe ganz, gilt weiterhin 1. Betrifft Bestandsberechnung (Browser und Server), Ausbuchung beim Verkauf und Zusammenfassungen.
- **INT-10 (c) Datum:** «Heute» und das MHD (+2 Jahre) werden in Schweizer Zeit (Europe/Zurich) gebildet, nicht mehr in UTC. Damit gibt es zwischen 00:00 und 02:00 Uhr nicht mehr das Vortagesdatum, und das MHD ist nicht mehr einen Tag zu früh.
- **Offen: INT-10 (a)** Dübel-Sets werden als «beimpft» angelegt, gezählt wird nur «fertig durchwachsen» (sie sind nie Bestand). Das muss fachlich entschieden werden.
- **Achtung beim Einspielen:** Chargen mit Menge 0, die noch nicht archiviert sind, zählten bisher als 1 und zählen jetzt 0. Die Bestandsmeldung an WooCommerce kann dadurch bei einzelnen Artikeln sinken (richtigerweise). Vorher prüfen, siehe Anleitung im Pull Request.
- Neue Tests: `test/frontend-helpers.test.js` (IDs, Dübel-Aufteilung, Menge, Schweizer Datum) und ein Integrationstest für Menge 0.

# Version 1.5.27 – Absicherung der Oberfläche gegen eingeschleusten Code (SEC-04)

- **Escaping im Frontend:** Texte aus Daten (Sorte, SKU, Quelle, Notiz, Herkunft, Statusanzeigen, Etiketten, QR-Seite, Zusammenfassungs-Schaltflächen) werden jetzt überall maskiert, bevor sie in die Seite geschrieben werden. Werte in `onclick`-Attributen werden zusätzlich für HTML-Attribute maskiert.
- Geprüft mit Testdaten, die in allen Textfeldern Schadcode enthielten: vorher wurde er an 24 Stellen ausgeführt, jetzt an keiner mehr. Mit normalen Daten sieht die Oberfläche in 16 verglichenen Bereichen identisch aus.
- Nicht geändert: IDs (`x.id`) werden weiterhin direkt eingesetzt, sie entstehen in der App selbst (`next()`), nicht aus freien Texteingaben. Bei einem Import von Fremddaten mit ungewöhnlichen IDs sollte dies nachgezogen werden.
- Weiterhin offen: SheetJS (CDN) lokal ausliefern bzw. mit Prüfsumme (SRI) absichern (SEC-05).
- Keine Änderung an Server, Datenbank oder Datenformat.

# Version 1.5.26 – Vorauskasse reserviert Bestand

- Vorauskasse: Bestellungen im Status «wartend» (on-hold) reservieren jetzt ebenfalls Bestand; Storno/Ablehnung gibt ihn wieder frei. Bezahlte Bestellungen haben bei knappem Bestand Vorrang. Für wartende Bestellungen werden noch keine Produktionsaufträge ausgelöst.
- Bereits vorhandene wartende Bestellungen werden nach dem Update beim ersten «Mit WooCommerce abgleichen» nachträglich reserviert.

# Version 1.5.25 – Massnahmen aus dem IT-Audit (Phase 0 und Teile von Phase 1)

Datenbank und Datenformat bleiben kompatibel: bestehende Tabellen und Daten werden unverändert weiterverwendet,
es kommen nur zwei neue Tabellen hinzu (`app_sessions`, `app_webhook_queue`). Details: `docs/MASSNAHMEN_AUDIT_1_5_25.md`.

- Absturzfehler behoben (SEC-01): fehlerhafte Anfragen können den Server nicht mehr beenden.
- Gleichzeitige Webhooks gehen nicht mehr verloren (INT-02); Webhooks werden sofort quittiert, in der Datenbank eingereiht und bei Fehlern automatisch wiederholt (INT-05).
- Speichern nur auf aktuellem Datenstand (INT-01, INT-03): ein Browser mit veraltetem Stand wird abgewiesen und lädt neu.
- Bestand wird erst nach dem Speichern an WooCommerce gemeldet; fehlgeschlagene Meldungen werden automatisch wiederholt.
- Login: Sperre gegen Durchprobieren, zufällige Sitzungen in der Datenbank, zeitkonstanter Passwortvergleich (SEC-02, SEC-03).
- Sicherheits-Header (SEC-05), Backup-Wiederherstellung und Massenlöschung nur mit Admin-Passwort (SEC-06), keine Geräteeinträge für Unangemeldete (SEC-07).
- Kundendaten reduziert auf Namen (DSG-01); alte Reservierungsdatensätze werden bereinigt (INT-09).
- Falsche SKU-Zuordnung beseitigt (INT-06); Webhook-Topic wird geprüft (WOO-01); Timeout für WooCommerce-Aufrufe.
- Alarmierung über `/api/health?strict=1` und optional `ALERT_WEBHOOK_URL` (OPS-03).

# Version 1.5.24 – Wunschdatum je Bestellung

- Manuelles Versand- oder Bereitstellungsdatum je Bestellung, nur lokal gespeichert.
- Wunschdatum in der Übersicht deutlich markiert; für Sortierung vorrangig.
- Automatisch berechnetes Datum bleibt sichtbar; manuelles Datum kann entfernt werden.
- Bestehende Bemerkungen, Bestellgruppen und Reservierungen bleiben erhalten.

# Version 1.5.24 – Bemerkungen in Bestellübersicht hervorheben

- Bestellungen mit WooCommerce-Kundenbemerkung oder interner Bemerkung erhalten eine dezente gelbe Hervorhebung und den Hinweis «Bemerkung vorhanden».
- Bestellungen ohne Bemerkung bleiben unverändert.
- Bestehende Bestell-, Lager- und Reservierungslogik bleibt unverändert.

# Version 1.5.22 – Bestellbemerkungen

- WooCommerce-Kundenbemerkungen in der Bestellübersicht anzeigen.
- Separate interne Bemerkung pro Bestellung, dauerhaft serverseitig gespeichert.
- Interne Bemerkungen bleiben beim WooCommerce-Abgleich erhalten und werden nicht an WooCommerce übertragen.
- Versionsnummern aktualisiert.

# Version 1.5.22 – Abholbereit

- In der Bestellübersicht steht bei abholbereiten Abholbestellungen «Abholbereit» statt «Versandbereit».
- Die Anzeige für Versandbestellungen sowie Reservierungen und Bestandsberechnung bleiben unverändert.
- Versionsangaben auf 1.5.22 aktualisiert.

# Pilzverwaltung 1.5.22 – WooCommerce-Abgleich

- Sichtbare Statusanzeige beim manuellen Abgleich, mit laufenden Fortschrittsmeldungen.
- Aktuelle processing- und on-hold-Bestellungen werden vor der Einzelprüfung älterer Bestellungen importiert.
- Bereits vorhandene Bestellungen und Reservierungslogik bleiben erhalten.

# Version 1.5.22 – Bestellübersicht Korrektur

- Verarbeitung von WooCommerce `on-hold` und `processing` im Bestellabgleich.
- Datumsübernahme aus WooCommerce-Feld `latest_shipping_date` oder `_mykothek_latest_shipping_date`, ansonsten aus öffentlich zugänglichen ACF-Produktfeldern.
- Achtung: Falls ACF-Felder nicht per WooCommerce-REST ausgegeben werden, muss das beigefügte WordPress-Zusatzplugin aktiviert werden.
- Bestehende Reservierungs- und Archivlogik bleibt erhalten.

# Pilzverwaltung 1.5.18 – Bestellübersicht

- Drei Gruppen: In Bearbeitung – Versand, In Bearbeitung – Abholung, In Wartestellung.
- Aufsteigend nach spätestem Versand-/Bereitstellungsdatum, soweit aus WooCommerce-Produktmetadaten verfügbar.
- Datum am rechten Rand jeder Bestellung.
- WooCommerce on-hold wird neu importiert, ohne FIFO-Reservierung.
- Versionsnummern in Programm, Server und package.json vereinheitlicht.
- Hinweis: ACF-Lieferzeitfelder müssen über WooCommerce REST als Produkt-meta_data verfügbar sein, sonst erscheint „nicht verfügbar“.

# Pilzverwaltung – Projektstand 1.5.14

## Gerätesperre ein-/ausschaltbar
- In Administration → Geräteverwaltung gibt es jetzt einen zentralen Schalter für die Gerätesperre.
- Deaktiviert: alle Browsergeräte dürfen zugreifen und werden automatisch registriert; vorhandene Freigaben bleiben gespeichert.
- Aktiviert: nur ausdrücklich freigegebene Geräte dürfen auf interne APIs zugreifen.
- Das Umschalten ist immer mit APP_PASSWORD geschützt.
- So können zunächst alle gewünschten Geräte ohne Mitnahme des Master-PCs registriert und später gesammelt freigegeben werden.

# Pilzverwaltung – Projektstand 1.5.13

## Konsolidierte Gerätefreigabe
- Es gibt nur noch eine normale Zugangssperre: die serverseitige Gerätefreigabe.
- Ein freigegebenes Gerät benötigt im täglichen Betrieb kein zusätzliches APP_PASSWORD/Login mehr.
- APP_PASSWORD wird nur noch für die Erstfreigabe (Bootstrap) und für Änderungen in der Geräteverwaltung verwendet.
- Der Admin-Schlüssel wird nur für die aktuelle Browser-Sitzung gespeichert (sessionStorage), nicht dauerhaft in localStorage.
- Die frühere Funktion „Dieses Gerät abmelden“ wurde durch „Admin-Zugang sperren“ ersetzt; die Gerätefreigabe selbst bleibt dabei bestehen.
- Wird einem Gerät die Freigabe entzogen, sind die internen APIs für dieses Gerät sofort gesperrt.
- WooCommerce-Webhooks bleiben separat über ihren bestehenden Schutz erreichbar.

# Pilzverwaltung – Projektstand 1.5.11

## Änderungen 1.5.11
- 1000er-Dübelgebinde werden einzeln verwaltet; bestehende Bündel werden automatisch in Einzelpackungen aufgeteilt (z. B. 1/4 bis 4/4).
- Beim Abpacken aus einem 1000er-Gebinde wird nur die gewählte Einzelpackung als angebrochen markiert.
- Angebrochene 1000er-Dübelgebinde werden nicht mehr als WooCommerce-/FIFO-Verkaufsbestand gezählt; ungeöffnete 1000er bleiben verfügbar. Andere Dübelgrößen behalten die bisherige Bündellogik.
- Substratmischungen können bearbeitet und gelöscht werden.
- Sichtbare Erfolgsmeldungen oben für die zentralen Erstellvorgänge ergänzt.
- Verkaufsspritzen zeigen in der Übersicht zusätzlich Master/Herkunft.
- Enthält weiterhin den Aufgaben-Fix aus 1.5.10.

# Pilzverwaltung 1.5.8 stabil


## Änderungen in 1.4.61

- Mindestbestände können jetzt auch für **Rohstoffe** und **Labormaterialien** definiert werden.
- Die Auswahl greift direkt auf die im Produktkatalog aktivierten einfachen Lagerartikel dieser beiden Bereiche zu.
- Bei Unterschreitung erscheinen die Fehlmengen im Menü **Aufgaben** als eigene Gruppen **Rohstoffe** bzw. **Labormaterialien**.
- Die Aufgaben zeigen Bestand, Mindestbestand und Fehlmenge; der Aktionsbutton führt direkt in den jeweiligen Lagerbereich zur Zu-/Abgangsbuchung.

## Änderungen in 1.4.60

- Körnerbrut-Etiketten drucken neu zusätzlich das Gewicht des Beutels (z. B. `Gewicht: 2500 g`). Dies gilt sowohl für den Einzelbeutel- als auch den Chargendruck.

## Änderungen in 1.4.59

- Pro WooCommerce-SKU kann unter **Einstellungen → SKU-Mapping → Alle WooCommerce-SKUs** ein Standard-Lagerplatz hinterlegt werden.
- Der Standard-Lagerplatz gilt auch für bereits vorhandenen Bestand ohne eigene Lagerplatzangabe und wird dadurch in FIFO/Packliste berücksichtigt.
- Neu hergestellte Körnerbrut, Substratsäcke, Dübel, Verkaufsspritzen, Baumstämme und Dörrpilz-Lots übernehmen den Standard-Lagerplatz ihrer SKU automatisch.
- Importierte/einfache Lagerprodukte verwenden dieselbe Lagerplatz-Zuordnung; eine individuelle Lagerplatzangabe am Datensatz bleibt vorrangig.

## Änderungen in 1.4.56

- Bestellbezogen produzierte und versandbereite Chargen werden in der Bestellübersicht jetzt direkt als Deckung der zugehörigen Bestellposition erkannt.
- Explizit für eine Bestellung hergestellte Ware hat bei der Reservierung Vorrang vor allgemeinem FIFO-Bestand.
- Bestellgebundene Ware einer anderen Bestellung kann nicht versehentlich für eine fremde Bestellung reserviert werden.
- Sobald die bestellbezogene Ware versandbereit ist, verschwindet „Fehlen … / Kein Bestand zugeordnet“ und der Bestellstatus wechselt bei vollständiger Deckung auf „Versandbereit“.

## Änderungen in 1.4.55
- Dashboard auf Substratsäcke im Test und die drei Bestellstatus-Kennzahlen reduziert.
- Aufgaben: Auswahl-Checkboxen für Produktionsblätter vergrössert und sauber ausgerichtet.
- Mindestbestand: doppelte Karte „Aktive Warnungen“ entfernt; Warnungen bleiben zentral unter Aufgaben.
- SKU-Mapping: Stammdaten und alle WooCommerce-SKUs standardmässig eingeklappt; Aktion „Aus Auto-Zuordnung entfernen“ direkt neben der SKU.
- WooCommerce Sync: Auto-Sync nach Produktgruppe steht zuoberst; Sync-Protokoll ist standardmässig eingeklappt.
- Daten: Testdaten-Reset erfordert die Texteingabe TESTDATEN und erstellt vorher ein Server-Backup.
- Lagerplätze: zusätzliches freies Feld für neue Orte/Räume.
- Backups: automatisches Tagesbackup beim Serverstart bzw. stündliche Prüfung, 90 Tage Aufbewahrung; Tagesbackups werden in der Wiederherstellungsliste gekennzeichnet.


Änderungen in 1.4.53:

- WooCommerce-Bestandsanzeige zeigt jetzt getrennt: **Physisch · Reserviert · Verfügbar**.
- Der an WooCommerce geschriebene Bestand bleibt **Verfügbar = Physisch − Reserviert**.
- Nach Abschluss einer Bestellung wird die Reservierung zur endgültigen Ausbuchung; dadurch stimmen physischer und verfügbarer Bestand wieder überein.
- QR-Verkauf Körnerbrut korrigiert: Es wird nur noch der konkret gescannte Beutel ausgebucht; kein FIFO-Ausbuchung anderer Beutel derselben SKU.
- QR-Verkauf Baumstämme bleibt datensatzbezogen: Die eingegebene Menge wird ausschliesslich vom gescannten Baumstamm-Datensatz abgezogen.

- QR-Scan Holzstämme: neue Aktion „Verkaufen“ mit Mengeneingabe; Teilverkauf reduziert den Bestand, vollständiger Verkauf setzt den Datensatz auf verkauft.
- Baumstamm-Verkäufe werden im Archiv protokolliert und lösen über die bestehende Auto-Sync-Logik die WooCommerce-Bestandsaktualisierung aus.
- Neue WooCommerce-Bestellungen werden über Webhooks nur noch dann aktiv importiert, wenn ihr Status `processing` ist.
- Bereits abgeschlossene (`completed`), stornierte, erstattete oder fehlgeschlagene Bestellungen können durch verspätete Webhooks nicht mehr als neue aktive Aufträge erscheinen.
- Bekannte Bestellungen werden beim Wechsel auf einen Endstatus automatisch aus den aktiven Bestell-, Dashboard- und Packlisten entfernt und unter „Abgeschlossen / archiviert“ geführt.
- Bei `completed` werden bestehende FIFO-Reservierungen weiterhin endgültig ausgebucht; bei Storno/Erstattung/Fehler werden sie freigegeben.
- Der manuelle WooCommerce-Abgleich kann eine tatsächlich wieder auf `processing` gesetzte Bestellung wieder aktivieren.


- Auswahl „Quelle unbekannt“ unterscheidet gleiche Arten jetzt nach Master bzw. Herkunft; die gewählte Identität wird am neuen Datensatz mitgespeichert.

Änderungen in 1.4.47:
- Körnerbrut und Verkaufs-/Master-Spritzen: Aktion „beimpft“ verschiebt den verwendeten Datensatz sofort ins Archiv.
- Dübel-Etikett L7874: Pilzart steht neu an erster Stelle gross/fett; Quelle/Master, Datum und DUE-ID folgen; die Zeile „Anzahl“ entfällt.
- „Quelle Typ: unbekannt“ verwendet in Flüssigmyzel, Körnerbrut, Substrat, Dübel, Spritzen und Holzstämmen eine gemeinsame Auswahl bestehender Strains statt freier Neubenennung.
- Übergangsbestand mit unbekannter exakter Quelle wird bei identischer SKU trotzdem in Mindestbeständen mitgezählt.


Änderungen in 1.4.45:
- WooCommerce-Bestellungen können mit „Mit WooCommerce abgleichen“ vollständig geprüft werden.
- In WooCommerce gelöschte/weggeworfene Bestellungen werden lokal als „extern gelöscht“ archiviert und ihre FIFO-Reservierungen freigegeben.
- Zugehörige offene Produktionsaufträge werden bei extern gelöschten Bestellungen beendet.
- Extern gelöschte Bestellungen verschwinden aus aktiven Dashboard-/Packlisten und können anschließend lokal endgültig gelöscht werden.
- Der Abgleich importiert weiterhin neue processing-Bestellungen und aktualisiert Statusänderungen.

- Live-Aktualisierung: geöffnete Pilzverwaltung prüft alle 5 Sekunden schlank den Serverstatus.
- Bei serverseitigen Änderungen (z. B. WooCommerce-Webhooks) werden die aktuellen Daten automatisch nachgeladen; F5 ist nicht mehr nötig.
- Neue bzw. auf `processing` wechselnde WooCommerce-Bestellungen werden mit einer kurzen Meldung eingeblendet.
- Während Eingabefelder aktiv bearbeitet werden oder ein Speichervorgang läuft, wird die automatische Aktualisierung zurückgestellt, damit keine Eingabe überschrieben wird.

Änderungen in 1.4.42:

- WooCommerce-Sync übersichtlicher: alle alten Stammdaten-SKUs und später importierten SKUs werden gemeinsam angezeigt.
- Auto-Sync zentral je SKU und gruppenweise ein-/ausschaltbar.
- Neue Gruppen Rohstoffe und Labormaterialien ergänzt.
- Nicht mehr benötigte Verbindung-prüfen-Karte aus der Oberfläche entfernt.

- WooCommerce-Erst-Ping an `/api/woo/webhook` wird mit HTTP 200 bestätigt, auch wenn er keine Signatur enthält.
- Nicht signierte Ping-/Testanfragen lösen ausdrücklich keine Bestellung, Reservierung oder Bestandsbewegung aus.
- Echte signierte Webhooks werden weiterhin mit `WC_WEBHOOK_SECRET` geprüft; eine falsche Signatur ergibt weiterhin HTTP 401.

Änderungen in 1.4.40:
- L7872 aus der Druckvorlagen-Auswahl entfernt.
- Flüssigmyzel, Körnerbrut und Dübel verwenden automatisch L7874.
- Normale Substratsäcke bleiben L7871; nur aus Bestellung → Fehlbestand → Produzieren erzeugte Substratsäcke verwenden L7874.
- Bestellbezogene Substratetiketten zeigen die Bestellnummer.
- Automatischer Etikettendruck gruppiert unterschiedliche Formate auf getrennte A4-Seiten.
- Separate Startposition sowie horizontale/vertikale Druckkorrektur für L7871 und L7874.

# Projektstand 1.4.30 stabil

Aktueller Schwerpunkt: Druckkorrektur L7874.

Korrigiert:
- Grosse Etiketten L7874: spaltenabhängige horizontale Korrektur.
- QR-Code kleiner und nicht mehr randbündig.
- Inhalte sollen auf linker/rechter Spalte nicht mehr angeschnitten werden.

Weiterhin prüfen:
- Testdruck L7874 auf Normalpapier, gegen Etikettenbogen halten.
- Falls nötig nur noch Feinkalibrierung über mm-Korrektur.


## 1.4.30
- Mindestbestände können jetzt bearbeitet werden.
- Formular lädt bestehende Werte und aktualisiert den vorhandenen Eintrag.


## 1.4.30
- Flüssigmyzel-Tabelle und L7874-Flaschenetiketten korrigiert.


## Version 1.4.30
- Flüssigmyzel verwendet standardmäßig Avery L7874.
- Etikett: Pilzart, Quelle/Master, Datum und ID links untereinander.
- QR-Code rechts; keine SKU auf Flüssigmyzel-Etiketten.


## Neu in 1.4.30
- Archiv-Detailansicht mit vollständigen Produktdaten und Rückverfolgbarkeit.
- Neuer Reiter Aufgaben: Arbeiten nach Petrischalen, Flüssigmyzel, Körnerbrut, Substratsäcken, Dübeln, Holzstämmen und Lager gebündelt.


## Version 1.4.30
- Aufgaben-Reiter vollständig auf Mindestbestände umgestellt.
- Nur tatsächliche Fehlmengen werden angezeigt.
- Aufgaben nach Produktionsbereich als aufklappbare Gruppen gebündelt.
- Anzeige von Bestand, Mindestbestand und konkret herzustellender Menge.


## 1.4.30
- Master/Herkunft wird bei Mindestbeständen explizit gespeichert und beim Bearbeiten wiederhergestellt.
- Bestehende Mindestbestände bleiben erhalten; eindeutige ältere Einträge werden automatisch ergänzt, mehrdeutige als „Zuordnung prüfen“ markiert.
- Mindestbestände und Warnungen sind nach Bereich als Accordions gebündelt.


## Version 1.4.30
- Fünf zusätzliche 20-ml-SKUs für Verkaufsspritzen ergänzt: Aaur_Flü_20ml, Srug_Flü_20ml, Gfro_Flü_20ml, Tver_Flü_20ml, Ledo_Flü_20ml.
- Bestehende SKU-Einträge unverändert belassen.


## Version 1.4.30
- Petrischalen-Mindestbestand zeigt Master/Herkunft wie die übrigen Kulturstufen.
- Für jeden aktiven Wild-Master wird automatisch ein Petrischalen-Mindestbestand von 2 angelegt, sofern noch kein passender Eintrag existiert. Manuelle Werte werden nicht überschrieben.
- Aufgaben zeigen Master/Herkunft.
- Aufgabenblatt kann nach Bereichen ausgewählt und gedruckt werden.

## Version 1.4.30
- Petrischalen können jetzt bei Anlageart direkt **aus einer bestehenden, durchgewachsenen Petrischale** erzeugt werden.
- Strain, Master/Herkunft und Rückverfolgbarkeit werden automatisch von der Quell-Petrischale übernommen.


## 1.4.30 – Etikettenkorrekturen
- Dörrpilz-Eimer L7874: Pilzart gross oben, Eimer-ID darunter, Datum darunter.
- Petri aus Petri: bei gekauften/sonstigen Kulturen wird die ursprüngliche Herkunft vererbt und auf dem Etikett verwendet; die Quell-Petri-ID wird nicht als Herkunft gedruckt.


## 1.4.30
- Petri→Petri-Etiketten verfolgen bei gekauften/sonstigen Kulturen die ursprüngliche Herkunft rekursiv zurück.
- Interne Kultur-IDs (PET-/DK-/LC-/KB-) werden nicht mehr als Herkunft auf Petri-Etiketten gedruckt.


## 1.4.30
- Flüssigmyzel-Übersicht: separate Spalte Herkunft (Wild = Master-ID, gekauft = ursprüngliche Herkunft).
- Direktes Elternprodukt bleibt separat sichtbar.
- Etikettendruck für Flüssigmyzel unverändert.


## 1.4.30
- Datensatz-Bearbeitung für Produktionsbereiche ergänzt.
- WooCommerce-Testintegration vorbereitet: Gruppenauswahl, Einzel-SKU-Auswahl, Bestand prüfen und kontrolliert synchronisieren.
- Automatischer Dauerabgleich ist bewusst noch nicht aktiviert.


## 1.4.32 WooCommerce Variations-Sync
- Bestands-Sync erkennt variable WooCommerce-Produkte/Child-Variationen.
- Child-Bestand wird über `/products/<parent_id>/variations/<variation_id>` geschrieben.
- Nach dem Schreiben wird der Bestand nochmals gelesen und nur bei bestätigtem Wert als synchronisiert gemeldet.

## Neu in 1.4.32
- WooCommerce-Produktpalette kann vollständig (alle Produkte/Variationen mit SKU) eingelesen werden.
- Bestehende SKUs werden beim Import ausdrücklich nicht verändert; nur neue SKUs werden ergänzt.
- Lokaler Produktkatalog mit Bereich, Bestandsart (keine / einfacher Stückbestand / Chargen-FIFO) und Sync-Aktivierung.
- Neue Verkaufsbereiche Rohstoffe und Labormaterialien.
- Einfache Bestandsbuchungen mit + Zugang / - Abgang und Buchungsprotokoll.
- Lagerplatzverwaltung (z.B. Kühlraum / Regal / Kiste 123) und Zuordnung im Bearbeiten-Dialog.
- WooCommerce-Bestellungen mit Status "In Bearbeitung" können eingelesen werden; FIFO-Kommissioniervorschlag zeigt Batch und Lagerplatz.
- Der Bestellbereich verändert Bestände in dieser Version bewusst noch nicht automatisch; er dient zuerst der sicheren Zuordnungs-/Kommissionierprüfung.


## 1.4.35 – Bestellungen abrufen
- `showWrap()` ist jetzt eine globale UI-Hilfsfunktion.
- WooCommerce-Bestellungen lassen sich abrufen, ohne den JavaScript-Fehler `showWrap is not defined`.
- Keine Änderungen an Bestands- oder Datenbanklogik.


## 1.4.35
- „Säcke im Verkauf“ korrigiert: gemeint sind leere Mikrofiltersäcke, nicht beimpfte Substratsäcke.
- Neuer Katalogbereich „Mikrofiltersäcke“ mit einfachem Stückbestand (+/- Buchungen) und Lagerplatz.
- Produktions-Substratsäcke bleiben vollständig getrennt und unverändert.
- WooCommerce-Gruppe „Mikrofiltersäcke“ ergänzt, ohne bestehende SKU-Zuordnungen automatisch umzuschreiben.

## 1.4.36 – Lagerplätze / Packliste
- Lagerplätze neu als Raum → Regal → Kiste aufgebaut; separates Code-Feld entfernt.
- Raum ist ein Dropdown mit Kühlraum, Durchwachsungsraum, Abpackraum und Sonstiges.
- Lagerplätze können bearbeitet, deaktiviert und wieder aktiviert werden; bestehende Zuordnungen bleiben erhalten.
- Alte Lagerplätze aus früheren Versionen werden weiterhin lesbar dargestellt.
- Pack-/Versandliste ist nach Raum → Regal → Kiste → Bestellung sortiert und zeigt diese drei Angaben in getrennten Spalten.


## 1.4.37 – Bestellproduktion / Quellenverbrauch
- Dashboard-Warnliste entfernt; stattdessen Bestellungen offen, packbereit und mit Fehlbestand.
- Neu importierte WooCommerce-SKUs erscheinen sofort im SKU-Mapping.
- Dübel können aus bestehenden Dübeln/Grossgebinden umgepackt werden; Rückverfolgbarkeit bleibt erhalten.
- Körnerbrut- und Dübelquellen können als „Angebraucht“ markiert oder per Checkbox vollständig aufgebraucht und archiviert werden.
- Bestell-Fehlbestand öffnet die normale Produktionsmaske (KB/Substrat/Dübel/Spritzen), mit Bestellbezug auf erzeugten Datensätzen und Etiketten.
- Körnerbrut-Quellenauswahl für Substratproduktion robuster (Kühlschrank-Status normalisiert).


## 1.4.38 – Körnerbrut aus Körnerbrut / Quellenstatus
- Körnerbrut kann neu auch aus vorhandener, fertiger Körnerbrut hergestellt werden.
- Bei KB → KB kann die Quelle manuell als vollständig aufgebraucht markiert und ins Archiv verschoben werden.
- Ohne Markierung bleibt die Quell-Körnerbrut aktiv und erhält den Hinweis „Angebraucht“.
- Hinweisfeld bei Substrat aus Körnerbrut sprachlich/optisch bereinigt.


## Version 1.4.40 – WooCommerce Echtzeit/FIFO
- Servergeführte Woo-Reservierungen (`wooReservations`) gegen Doppelbelegung.
- `processing`: FIFO-Reservierung je Bestellposition.
- `completed`: reservierte Ware endgültig ausbuchen.
- `cancelled` / `refunded` / `failed`: Reservierung freigeben.
- Automatische Bestandsrückmeldung an WooCommerce bei lokalen Bestandsänderungen für aktivierte Sync-SKUs.
- Signierter WooCommerce-Webhook `/api/woo/webhook` mit `WC_WEBHOOK_SECRET`.
- Sync-Protokoll (`wooSyncLog`) und Wiederholungsfunktion in der Oberfläche.
- Manuelles Abrufen der Bestellungen baut ebenfalls serverseitig FIFO-Reservierungen auf.
- Servergeführte Woo-Daten werden bei normalen Browser-Speichervorgängen gegen Überschreiben durch veraltete Browserdaten geschützt.


## 1.4.45
- Etiketten ohne SKU werden bei „noch nicht gedruckt“ zuverlässig angezeigt; SKU ist keine Voraussetzung für den Etikettendruck.
- SKU-Auswahl bei Körnerbrut, Substrat, Dübeln und Spritzen reagiert sofort auf Quellen-/Variantenwechsel und wählt die passende SKU neu vor.
- Veraltete/doppelte SKUs können im SKU-Mapping aus der automatischen Zuordnung entfernt und bei Bedarf wieder aktiviert werden.
- Bei Verkaufs- und Master-Spritzen wurde die Aktion „fertig durchwachsen“ entfernt; abgefüllte Spritzen sind sofort einsatzbereit.


## 1.4.51
- WooCommerce Auto-Sync: Beim erstmaligen Einschalten einer einzelnen SKU oder einer ganzen Gruppe wird der aktuell verfügbare interne Bestand sofort als Initialbestand an WooCommerce übertragen. Warten oder eine zusätzliche Lagerbewegung ist nicht mehr nötig.
- Das gilt einheitlich für alle Produktgruppen, inklusive Holzstämme.

## 1.4.51
- QR-Scan Körnerbrut: neue Aktion „Körnerbrut verkaufen“ mit Mengeneingabe.
- Bei mehreren Beuteln derselben SKU werden die ältesten verkaufsbereiten Körnerbrut-Beutel FIFO ausgebucht.
- Verkauf setzt die betroffenen Beutel auf „verkauft“, archiviert/protokolliert die Bewegung und löst über die bestehende Bestandslogik den WooCommerce-Auto-Sync aus.


## Version 1.4.59
- Körnerbrut-Etiketten: neue Chargen speichern Chargenstückzahl und Beutelposition.
- Etikettendruck wahlweise 1 Etikett pro Beutel (Standard) oder 1 Etikett pro Charge.
- Körnerbrut-Etikett zeigt Stückzahl bzw. Beutelposition/Chargengrösse.


## 1.4.59
- Körnerbrut und Dübel: Etikettenwahl pro Einzelgebinde oder pro Charge.
- Dübel-Etiketten zeigen Packungsgrösse und bei mehreren Packungen die Position innerhalb der Charge.
- Beim Vererben von fertig durchwachsenen Dübeln in kleinere Gebinde werden die neuen Gebinde direkt als fertig durchwachsen angelegt.


## Neu in 1.4.67 – Lungenseitling-Experimentiersets
- Körnerbrut-Produktion unterstützt neu 150 g.
- Lungenseitling 150 g wird fest `Ppul_Kör_150g` zugeordnet und ist Komponente von `Ppul_Exp_150g`.
- Lungenseitling 600 g wird fest `Ppul_Kör_600g` zugeordnet und ist Komponente von `Ppul_Exp_600g`.
- Lungenseitling 1000 g bleibt `Ppul_Kör_1000g`; die einstellbare Set-Reserve schützt den gewünschten Anteil für `Ppul_Exp_1000g`.
- Die Stücklisten mit Stroh- und Nadelholzpellets bleiben unverändert.


## Neu in 1.4.67 – Set-Reserve direkt bei Mindestbeständen
- Beim Mindestbestand `Ppul_Kör_1000g` erscheint beim Bearbeiten das Feld **Für Experimentierset reservieren**.
- Der Wert wird direkt als Set-Reserve im Produktkatalog gespeichert und schützt diese Stückzahl für `Ppul_Exp_1000g`.
- Die Tabelle der definierten Mindestbestände zeigt die Set-Reserve separat von der Produktionsreserve an.


## Neu in 1.5.4 – Körnerbrut erst im Kühlschrank verkaufsbereit

Körnerbrut wird für WooCommerce-Bestand, Set-Stücklisten und FIFO-Reservierungen nur noch berücksichtigt, wenn ihr Status exakt `im Kühlschrank` ist. Beutel mit `am durchwachsen` oder anderen Zwischenstatus bleiben physisch in der Pilzverwaltung sichtbar, erhöhen aber keinen synchronisierten bzw. reservierbaren Verkaufsbestand.


## 1.5.4
Woo-Bestand und FIFO berücksichtigen die aktive Produktionsreserve zentral. Körnerbrut zählt nur im Kühlschrank; verfügbare Menge = verkaufsbereiter Bestand minus Bestellreservierungen minus Produktionsreserve minus ggf. Set-Reserve.
## Neu in 1.5.4

- Geräteverwaltung registriert nur noch echte Browsergeräte; Healthchecks, `Go-http-client`, Woo-/API-Clients und ähnliche Serveraufrufe werden ignoriert. Alte technische Geräteeinträge werden beim Öffnen der Geräteliste bereinigt.
- Administration: Backup-Bereich ist standardmässig eingeklappt.
- Warnungen & Erinnerungen wurden auf die MHD-Warnung für Dörrpilz-Lots reduziert.
- Die früheren allgemeinen „Heute fällig / Hinweise“-Meldungen für Kulturen wurden entfernt; fällige Hinweise beziehen sich nur noch auf Dörrpilz-MHD. Aufgaben, Mindestbestände und Bestelllogik bleiben unverändert.



## 1.5.4
- Körnerbrut kann neu direkt aus aktiven Master-Spritzen hergestellt werden.
- Rückverfolgbarkeit speichert die Master-Spritze als Quelle; die automatische SKU-Zuordnung verwendet deren Strain/Master.


## 1.5.6 – Substratsack-Etiketten

- Normale Substratsäcke verwenden neu HERMA 4271 (48,3 × 16,9 mm) statt der bisherigen kleinen Vorlage.
- Pro physischem Substratsack wird ein eigenes HERMA-4271-Etikett erzeugt; bei einer Charge mit Menge 20 also 20 Etiketten.
- Zusätzlich werden pro normaler Substrat-Charge 1, 2 oder 3 Avery-L7874-Regaletiketten mit QR-Code erzeugt.
- Der QR-Code der Regaletiketten verweist auf dieselbe Substrat-Charge, damit am Regal/Tablar schnell gescannt werden kann.
- HERMA 4271 hat eigene Startposition sowie horizontale/vertikale Druckkalibrierung.
- Test- und bestellbezogene/Webshop-Substratsäcke behalten ihre bisherige Sonderlogik.


## 1.5.8 – Mindestbestand bei unbekannter Quelle

Bei Mindestbeständen und Aufgaben ist eine vorhandene SKU jetzt die führende Zuordnung. Bestände mit momentan unbekannter Quelle werden bei passender SKU vollständig mitgezählt; das spätere Nachtragen der Herkunft verändert die Bestandsmenge nicht.


## Korrektur 1.5.9 – Körnerbrut-Mindestbestand nach SKU
- Bei Körnerbrut ist die SKU für den Mindestbestandsabgleich führend.
- Bestehende Mindestbestände ohne gespeicherte SKU leiten die SKU aus Pilzart + Variante ab, sofern eindeutig verfügbar.
- Herkunft/Master schliesst manuell erfasste Körnerbrut mit derselben SKU nicht mehr aus.
- Beim Anlegen/Bearbeiten eines Körnerbrut-Mindestbestands wird die passende SKU automatisch vorausgewählt bzw. beim Speichern ergänzt.

## Änderung 1.5.10 – Aufgaben: Mindestbestand nach physischem SKU-Bestand
- Produktionsaufgaben aus Mindestbeständen berechnen die Fehlmenge jetzt als `Mindestbestand - tatsächlicher SKU-Bestand`.
- Die Produktionsreserve wird dabei nicht mehr vom Bestand abgezogen. Sie bleibt ausschließlich für WooCommerce/FIFO bzw. den verkaufsverfügbaren Bestand relevant.
- Dadurch stimmen Mindestbestand und Aufgaben wieder überein: z. B. Mindestbestand 16 bei Bestand 14 => 2 herstellen, unabhängig von einer Produktionsreserve.


## Version 1.5.12 – Gerätefreigabe aktiv
- Gerätezugriff serverseitig aktiviert: interne API-Endpunkte sind nur von freigegebenen Browser-Geräten erreichbar.
- Geräte werden über einen kryptografisch zufälligen, HttpOnly/Secure/SameSite-Geräte-Token erkannt; es wird keine MAC-Adresse benötigt oder ausgelesen.
- Das erste Gerät kann nach Eingabe des korrekten `APP_PASSWORD` als Bootstrap-Admin-Gerät freigegeben werden.
- Weitere neue Geräte registrieren sich beim ersten Aufruf, bleiben aber gesperrt, bis sie auf einem bereits freigegebenen Gerät unter Administration → Geräteverwaltung freigegeben werden.
- Entzieht man einem Gerät die Freigabe, werden weitere interne API-Zugriffe sofort mit HTTP 403 blockiert.
- WooCommerce-Webhooks und Healthcheck bleiben von der Gerätesperre ausgenommen; WooCommerce-Webhooks bleiben über `WC_WEBHOOK_SECRET` signaturgeschützt.
- `APP_PASSWORD` ist bei aktiver Gerätesperre erforderlich.

## Version 1.5.15 – Passwort + Gerätesperre + Rescue
- Der normale Zugriff auf interne Daten benötigt jetzt immer eine erfolgreiche Anmeldung mit `APP_PASSWORD`, auch wenn die Gerätesperre deaktiviert ist.
- Nach erfolgreicher Anmeldung wird ein sicherer HttpOnly/Secure/SameSite-Strict Login-Cookie gesetzt (1 Jahr). Das Passwort wird dabei nicht im Cookie gespeichert.
- Bei aktiver Gerätesperre gilt zusätzlich: Das Browser-Gerät muss freigegeben sein. Ausnahme ist nur der Rescue-Zugang.
- Optionaler Notfallzugang über die Render-Umgebungsvariable `RESCUE_PASSWORD`. Dieses Passwort setzt einen getrennten Rescue-Login und darf die Gerätefreigabe umgehen, damit eine versehentliche Aussperrung repariert werden kann.
- `RESCUE_PASSWORD` sollte sich deutlich von `APP_PASSWORD` unterscheiden und nur für Notfälle aufbewahrt werden.
- Bei deaktivierter Gerätesperre können Geräte bequem registriert werden, die Pilzverwaltung selbst bleibt aber weiterhin passwortgeschützt.

## Korrektur Wartestellung / Experimentiersets (20.10.2026)
- `on-hold` mit vollständiger Verfügbarkeit zeigt `Bestand verfügbar` statt `Versandbereit`.
- Set-Komponenten in Wartestellung zeigen die aktuell verfügbare Menge und `Nicht reserviert` statt irreführend `0/1 reserviert` und `Fehlt 1`.
- Die FIFO-Vorschau für einfache Lagerartikel berücksichtigt nun Produktionsreserve und Set-Reserve; Reservationen anderer nicht mehr aktiver Processing-Bestellungen werden nicht als Verbrauch gerechnet.
- Es werden durch die Vorschau keine Reservationen angelegt. Bestehende WooCommerce-Reservationen bleiben serverseitig verwaltet.
