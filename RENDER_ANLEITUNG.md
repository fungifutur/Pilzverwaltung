# Version 1.5.38 – Excel-Bibliothek lokal (SEC-05)

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


# Version 1.5.24 – Wunschdatum je Bestellung

- Manuelles Versand- oder Bereitstellungsdatum je Bestellung, nur lokal gespeichert.
- Wunschdatum in der Übersicht deutlich markiert; für Sortierung vorrangig.
- Automatisch berechnetes Datum bleibt sichtbar; manuelles Datum kann entfernt werden.
- Bestehende Bemerkungen, Bestellgruppen und Reservierungen bleiben erhalten.

# Version 1.5.24 – Bemerkungen in Bestellübersicht hervorheben

- Bestellungen mit WooCommerce-Kundenbemerkung oder interner Bemerkung erhalten eine dezente gelbe Hervorhebung und den Hinweis «Bemerkung vorhanden».
- Bestellungen ohne Bemerkung bleiben unverändert.
- Bestehende Bestell-, Lager- und Reservierungslogik bleibt unverändert.

# Render Update

1. ZIP entpacken.
2. Inhalt des Ordners in GitHub hochladen/ersetzen.
3. Commit changes.
4. Render → Manual Deploy → Clear build cache & deploy.

Daten bleiben in PostgreSQL erhalten.


## Version 1.4.2
- Master-Spritzen bleiben aktiv, bis sie manuell verbraucht/kontaminiert werden.
- Master-Spritzen sind als Quelle für Flüssigmyzel auswählbar.
- Mindestbestände: Verkaufsspritzen und Master-Spritzen getrennt.
- Mindestbestände für Körnerbrut, Verkaufsspritzen und Dübel können per SKU definiert werden.
- Flüssigmyzel-Mindestbestand zählt Flaschen, ohne automatische Spritzen-SKU.
- Produkt-/Strain-Auswahl für LC/KB/Substrate/Spritzen aus Kultur-/Masterliste.
- SKU-Auswahl bei KB/Substrat/Dübel/Verkaufsspritzen mit Vererbung von Quellen-SKU.


## WooCommerce (optional, für Tests)
Unter Render → Web Service → Environment setzen:
- `WC_STORE_URL` = z.B. `https://dein-shop.ch`
- `WC_CONSUMER_KEY` = WooCommerce REST API Consumer Key
- `WC_CONSUMER_SECRET` = WooCommerce REST API Consumer Secret

Danach Service neu deployen/restarten. In der Pilzverwaltung unter **Einstellungen → WooCommerce Sync** zuerst Verbindung prüfen und eine einzelne SKU testen.


## 1.4.32 WooCommerce Variations-Sync
- Bestands-Sync erkennt variable WooCommerce-Produkte/Child-Variationen.
- Child-Bestand wird über `/products/<parent_id>/variations/<variation_id>` geschrieben.
- Nach dem Schreiben wird der Bestand nochmals gelesen und nur bei bestätigtem Wert als synchronisiert gemeldet.


## 1.5.6 – Substratsack-Etiketten

- Normale Substratsäcke verwenden neu HERMA 4271 (48,3 × 16,9 mm) statt der bisherigen kleinen Vorlage.
- Pro physischem Substratsack wird ein eigenes HERMA-4271-Etikett erzeugt; bei einer Charge mit Menge 20 also 20 Etiketten.
- Zusätzlich werden pro normaler Substrat-Charge 1, 2 oder 3 Avery-L7874-Regaletiketten mit QR-Code erzeugt.
- Der QR-Code der Regaletiketten verweist auf dieselbe Substrat-Charge, damit am Regal/Tablar schnell gescannt werden kann.
- HERMA 4271 hat eigene Startposition sowie horizontale/vertikale Druckkalibrierung.
- Test- und bestellbezogene/Webshop-Substratsäcke behalten ihre bisherige Sonderlogik.


## 1.5.8
Mindestbestand/Aufgaben: SKU-bestimmte Bestände zählen auch bei momentan unbekannter Quelle.

## Zugangsschutz ab 1.5.15
- `APP_PASSWORD`: normales Zugangspasswort; wird beim ersten Login eines Browsers verlangt und bleibt über einen sicheren Login-Cookie angemeldet.
- `RESCUE_PASSWORD`: separates Notfallpasswort. In Render als Environment Variable setzen. Es umgeht im Notfall die Gerätefreigabe und ermöglicht die Reparatur der Geräteverwaltung. Nicht identisch mit `APP_PASSWORD` wählen.
- Auch bei deaktivierter Gerätesperre bleibt `APP_PASSWORD` erforderlich.


## Version 1.5.25 – Environment-Variablen und Update
Beim ersten Start nach dem Update werden alle Benutzer einmal abgemeldet (neues Sitzungsverfahren) und müssen sich neu anmelden. Gerätefreigaben und alle Daten bleiben erhalten.

Pflicht (wie bisher): `DATABASE_URL`, `APP_PASSWORD` (neu: mindestens 16 zufällige Zeichen empfohlen), `RESCUE_PASSWORD` (anderes Passwort als `APP_PASSWORD`).
Ohne `APP_PASSWORD` bleibt die App jetzt vollständig gesperrt.

WooCommerce: `WC_STORE_URL`, `WC_CONSUMER_KEY`, `WC_CONSUMER_SECRET`, `WC_WEBHOOK_SECRET`.

Optional (neu):
- `ALERT_WEBHOOK_URL` – URL eines Slack-, Discord- oder ntfy-kompatiblen Webhooks. Die App meldet dorthin endgültig fehlgeschlagene Bestellungen, dauerhafte Sync-Fehler und viele Fehlanmeldungen.
- `AUTO_RECONCILE_HOURS` – z. B. `24`: gleicht die Bestellungen automatisch mit WooCommerce ab (Sicherheitsnetz für verpasste Webhooks). Standard: aus.
- `PGSSL_CA` – PEM-Zertifikat der Datenbank (mit `\n` für Zeilenumbrüche). Damit wird das Datenbankzertifikat geprüft (SEC-08).
- `SESSION_DAYS` – Gültigkeit der Anmeldung in Tagen (Standard 90).
- `WC_TIMEOUT_MS` – Zeitlimit für WooCommerce-Aufrufe (Standard 30000).
- `CSP_REPORT_ONLY=1` – Notschalter: Falls die neue Inhaltsrichtlinie im Browser etwas blockiert, schaltet dies sie auf reinen Testbetrieb.

Uptime-Überwachung: `https://<ihre-app>/api/health?strict=1` antwortet mit Status 503, wenn die Datenbank nicht erreichbar ist oder Bestellungen nicht verarbeitet werden konnten. Diese Adresse in einem Uptime-Dienst eintragen.

Einmalig auf dem eigenen Rechner: `npm install` ausführen und die erzeugte Datei `package-lock.json` ins Repository einchecken (OPS-04), damit jeder Build dieselben Versionen verwendet.
