# Migration: Abnahmebasis (M15) und Abgleichbericht (M17)

Ziel: Ein späteres neues System muss **dasselbe Ergebnis** liefern wie die heutige Pilzverwaltung. Dafür gibt es zwei Werkzeuge.

## 1. Abnahmebasis (M15) – `test/golden/`

- `fixture.json`: erfundene Lagerdaten mit allen Sonderfällen (angebrochene Ware, Menge 0, falscher Status, Test-Chargen, 1000er-Dübel, einfacher Artikel mit Set-Reserve, Produktionsreserve, ein Set aus zwei Komponenten).
- `scenario.json`: fünf Bestell-Schritte als WooCommerce-Ereignisse (bezahlt, Vorauskasse mit zwei gleichen Positionen, Set, Storno, Vorauskasse wird bezahlt).
- `expected.json`: das **dokumentierte Ist-Verhalten** nach jedem Schritt: Bestand je Artikel, Reservierungen (Bestellung, Position, SKU, Charge, Menge) und Produktionsaufträge.

Der Test «M15: Abnahmebasis» in `test/integration.test.js` spielt das ab und vergleicht. Weicht das Ergebnis ab, ist entweder ein Fehler eingebaut worden, oder das Verhalten wurde bewusst geändert.

**Bewusste Änderung übernehmen:** Test mit `GOLDEN_UPDATE=1` starten, die Änderung in `expected.json` im Git-Vergleich prüfen und mitcommitten.

**Neues System prüfen:** dieselben `fixture.json` und `scenario.json` einspielen und mit `expected.json` vergleichen. Die Datei ist bewusst unabhängig von der Technik.

Was die Abnahmebasis heute festhält (und bei der Migration entschieden werden sollte):
- Gibt eine Stornierung Ware frei, bekommen wartende Bestellungen sie erst beim nächsten Speichern oder Abgleich (Schritt 4: die Fehlmenge von Bestellung 9803 bleibt bis dahin offen).
- Produktionsreserve und Set-Reserve verringern, was Bestellungen reservieren dürfen.

**Keine echten Daten ins Repository!** Das Repository ist öffentlich. Exporte der echten Anwendung (auch anonymisierte) gehören nicht hinein.

## 2. Abgleichbericht (M17) – `scripts/migration_report.js`

Erzeugt einen Bericht mit Anzahl je Sammlung, allen IDs der Etiketten-Sammlungen (QR-Codes `/scan/<Bereich>/<ID>`), Bestand je SKU, Reservierungen und offenen Bestellungen. Der Bericht enthält keine Kunden- oder Freitextdaten.

```
node scripts/migration_report.js erstellen --url https://DEINE-APP.onrender.com --passwort RESCUE_PASSWORT --out vorher.json
# ... Migration durchführen ...
node scripts/migration_report.js erstellen --url https://NEUES-SYSTEM --passwort PASSWORT --out nachher.json
node scripts/migration_report.js vergleichen vorher.json nachher.json
```

- Das Rescue-Passwort verwenden: es umgeht die Gerätefreigabe.
- Das neue System muss `/api/export` und `/api/stock` mit demselben Aufbau anbieten (oder die Dateien über `--export` und `--stock` liefern).
- `vergleichen` endet mit Fehlercode 1, sobald etwas abweicht: Anzahl, fehlende IDs (gedruckte Etiketten würden ins Leere führen), Bestand je SKU, Reservierungen, offene Bestellungen.
- Bericht **vor** der Migration, **direkt danach** und nach einer Woche Parallelbetrieb erstellen und vergleichen.
