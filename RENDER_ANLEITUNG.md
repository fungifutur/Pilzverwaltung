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
