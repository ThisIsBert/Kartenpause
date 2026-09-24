# Tests

## Magnetisches Nachzeichnen

```powershell
npm.cmd run test:trace
npm.cmd run test:ui -- --grep "Magnetisch:"
```

Die Tests prüfen die Wahl einer gebogenen roten Grenze gegenüber einem kreuzenden blauen Fluss, die Ablehnung leerer/zu großer Suchbereiche und die Rückrechnung in Originalpixel einschließlich echter TPS-Korrektur. Im Browser werden Pipette und unverglättete Lupe, Originalpixel-Suche bei Deckkraft null nach Zoom, Vorschauersetzung, Zwischenanker, Verwerfen/Bestätigen, Linienabschluss, separat bestätigte Polygonschließkante, Export, Rückgängig und Abbruch geprüft. Ein Screenshot der Vorschau wird unter `output/playwright/magnetic-preview.png` gespeichert.

## Pinsel und Stützpunkte

```powershell
npm.cmd run test:trace
npm.cmd run test:ui -- --grep "Stützpunkte:|Pinsel erkennt"
```

Die isolierten Erkennungstests prüfen eine gegenüber der Pinselspur versetzte Bildlinie, eine farbige geschlossene Kontur sowie die Zurückweisung leerer Bereiche und außerhalb der Spur liegender Linien. Die Browser-Tests prüfen zusätzlich die kleinen quadratischen Stützpunkte, den Auswahlcursor, direktes Herausziehen eines Pluspunkts, Linien- und Polygonerkennung bei Deckkraft null, GeoJSON-Kopieren, Rückgängig/Wiederholen und Abbrechen mit Esc.

## Lokal ausprobieren

`Start-Kartenpause.cmd` per Doppelklick starten. Alternativ `npm.cmd run dev -- --host 127.0.0.1 --open` ausführen. Zum schnellen Test eines bereits angepassten Bilds über **Laden** eine Datei aus `examples/` öffnen und anschließend **Nachzeichnen →** wählen.

Das neue Zeichnen gezielt automatisiert prüfen:

```powershell
npm.cmd run test:ui -- --grep Zeichenmodus
```

Der Test zeichnet alle fünf Objekttypen, ergänzt einen Stützpunkt auf der schließenden Kurve, verschiebt Punkte, benennt ein Objekt um, prüft Button und Strg+C über die tatsächliche Browser-Zwischenablage, löscht Punkte und Objekte, prüft Rückgängig/Wiederholen und liest den heruntergeladenen GeoJSON-Export. Zusätzlich werden Moduswechsel, Erhalt der Zeichnung, Abbrechen sowie Mindestpunktzahlen geprüft. Ein Screenshot entsteht unter `output/playwright/drawing-mode.png`.

## Einmalige Installation

```powershell
npm.cmd install
```

`npm.cmd` wird unter Windows verwendet, falls die PowerShell-Ausführungsrichtlinie `npm.ps1` blockiert.

## Headless-Test

```powershell
npm.cmd run test:ui
```

Playwright startet einen Vite-Entwicklungsserver. Lokal läuft der Test mit Microsoft Edge, in GitHub Actions mit Chromium. Die Testkarte und ihre fünf Referenzpunkte werden zur Laufzeit erzeugt; private lokale Projektdateien und CDN-Abhängigkeiten sind nicht erforderlich.

Geprüft werden unter anderem:

- Entfernung der alten manuellen Projektionssteuerung
- unsichtbare Bildüberlagerung vor einer Anpassung
- Laden und Darstellen eines Projekts
- nummerierte Fadenkreuz-Markierungen einschließlich Farbkontrast
- gemeinsame automatische Suche über feste und parametrisierte Projektionsmodelle
- automatische TPS-Eskalation bei lokalen Verzerrungen
- Speichern und erneutes Laden einer TPS-korrigierten Projektdatei
- gezeichnete Bildüberlagerung nach erfolgreicher Anpassung
- stabiles Zoomen des Originalbilds ohne seitliches Springen
- JavaScript-Seitenfehler

Der Prüfscreenshot wird unter `output/playwright/workflow-smoke.png` gespeichert. Bei Fehlern landen Screenshot und Trace unter `output/playwright/test-results/`.

## Sichtbarer Browserlauf

```powershell
npm.cmd run test:ui:headed
```
