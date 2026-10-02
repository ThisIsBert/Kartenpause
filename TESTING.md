# Tests

## Nachträgliche Flächen- und Randbearbeitung

`node node_modules/@playwright/test/cli.js test --grep 'Weiterbearbeiten:' --timeout 150000` prüft das erneute Öffnen von MultiPolygonen mit Löchern, Pinselkorrektur, Verwerfen, Ersetzen mit unveränderter Objekt-ID, Rückgängig/Wiederholen und erneutes Öffnen. Weitere Fälle prüfen Kantenanker, manuelles Ersetzen sowie Wechsel Magnetisch → Manuell → Magnetisch innerhalb eines Ersatzverlaufs. Die Geometrietests prüfen zusätzlich die kürzere Abschnittswahl bei umgekehrter Ankerreihenfolge, magnetische Spornbereinigung und Problemmarkierungen, alle 511 nichtleeren 3×3-Pixelmasken auf unveränderte Rasterisierung, Loch-/Teilflächen-Erhalt und Kurvenauflösung. Screenshot: `output/playwright/section-replacement.png`.

## Gemeinsame Zoomanimation

`node node_modules/@playwright/test/cli.js test --grep 'Pixelkarte zoomt'` prüft die Bildschirmposition von Pixelkarte und Polygon während einzelner Animationsframes, beim Vergrößern, Verkleinern und Zoomen per Mausrad außerhalb der Kartenmitte. Nach der Animation muss die Canvas-Skalierung wieder 1 sein und das Raster in der neuen Auflösung vorliegen.

## Reaktionsfähigkeit bei großen Geometrien

`npm.cmd run test:trace` enthält einen Wiederholungstest mit 40.000 Stützpunkten, mehreren Teilflächen und einem Loch. `node node_modules/@playwright/test/cli.js test --grep 'Zauberstab:|Vereinfachung:|Stützpunkte:' --timeout 150000` prüft Hintergrundberechnung mit laufendem UI-Timer, erneutes Einstellen des Reglers, Ersetzen schneller Folgeaufträge, Beschäftigungscursor und Abbruch. Eine Zauberstab-Auswahl mit 700 Teilflächen / 2.800 Stützpunkten prüft zusätzlich die begrenzte Griffanzahl und unveränderten Export nach Abbruch. Laufzeiten sind abhängig von Geometrie und Rechner; die Tests garantieren keine feste maximale Rechendauer.

## Mehrteilige Objekte und Vereinfachung

`npm.cmd run test:trace` prüft zusätzlich MultiPolygon-Export samt Innenringen, reduzierter Punktzahl und geglätteten Linien mit festen Endpunkten. Bereinigungstests prüfen gemeinsame Größenskala, Entfernen kleiner Inseln und Löcher (einschließlich Inseln in gefüllten Löchern), Schutz größerer Strukturen, lokale Rücknahme bei Konflikten und schmale Ringe mit 7.212 Stützpunkten bei 100 %. `node node_modules/@playwright/test/cli.js test --grep 'Zauberstab:|Vereinfachung:'` prüft Toleranzänderungen nur für den folgenden Klick, Vorschauzähler für Teilflächen und Löcher, Wiederherstellen bei Reglerwert 0, Übernehmen/Verwerfen und Rückgängig/Wiederholen nach dem Entfernen von Kleinteilen. Screenshot: `output/playwright/simplification-preview.png`.

## Klickfortsetzung, Farbflächengrenzen und Zauberstab

```powershell
npm.cmd run test:trace
npm.cmd run test:ui -- --grep "Magnetisch: Weiterklicken|Magnetisch: zwei|Zauberstab:"
```

Die neuen Prüfungen unterscheiden Korrektur, Fortsetzung und Richtungswechsel, erkennen eine Grenze zweier Farben ohne Umrisslinie und prüfen Farbtoleranz sowie zusammenhängende Auswahl. Alle 512 möglichen 3×3-Pixelmasken werden auf flächentreue Umrisse geprüft, einschließlich diagonaler Kontakte. Löcher, getrennte Inseln, Pinselkorrekturen, Rückgängig/Wiederholen und GeoJSON-Innenringe werden ebenfalls geprüft. Der Browser-Test verschiebt zusätzlich einen Loch-Stützpunkt, ohne dabei den Außenring zu verändern. Eine Auswahlvorschau steht unter `output/playwright/wand-selection.png`.

## Magnetisches Nachzeichnen

```powershell
npm.cmd run test:trace
npm.cmd run test:ui -- --grep "Magnetisch:"
```

Die Tests prüfen die Wahl einer gebogenen roten Grenze gegenüber einem kreuzenden blauen Fluss, die Ablehnung leerer/zu großer Suchbereiche und die Rückrechnung in Originalpixel einschließlich echter TPS-Korrektur. Im Browser werden Pipette und unverglättete Lupe, Originalpixel-Suche bei Deckkraft null nach Zoom, Vorschauersetzung, Zwischenanker, Verwerfen/Bestätigen, Linienabschluss, separat bestätigte Polygonschließkante, Export, Rückgängig und Abbruch geprüft. Ein Screenshot der Vorschau wird unter `output/playwright/magnetic-preview.png` gespeichert.

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

- GeoJSON-Import aller Geometrietypen, Eigenschaften und Löcher; atomare Fehlerbehandlung
- Datei- und Zwischenablageimport ohne Pixelkarte, Umbenennen und Rückgängig
- exakte Übernahme vorhandener Zwischenstützpunkte beim Folgen eines Polygonrands

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

Regressionen für den erweiterten Import: MultiLineString, MultiPoint und GeometryCollection bleiben ein Objekt und werden unverändert als Geometrie exportiert. Kantentests prüfen umgekehrt orientierte Flussteilstücke, Richtungswechsel, Lücken und gerade Verbindungen ohne Vorlage.


## Robuste Randkorrektur und bearbeitbare Vorschau

`npm.cmd run test:trace` prüft zusätzlich den reproduzierten Pixelrundungsfehler mit einer Geraden und der Rhein-Datei, flächenlose Dorne, Erhalt von Löchern und Metadaten, robuste Schnittdiagnosen und die bestätigungspflichtige Even-odd-Flächenrekonstruktion bei echten Schleifen.

`node node_modules/@playwright/test/cli.js test --grep 'Randkorrektur:|Weiterbearbeiten:|GeoJSON:' --timeout 120000` prüft magnetische Übernahme, Verschieben/Einfügen/Löschen der Ersatzstützpunkte, erneute Prüfung, Rückgängig, Bestätigung einer Flächenaufteilung und Erhalt der Objekt-ID. Screenshots: `output/playwright/section-editable-points.png` und `section-editable-faces.png`.

Wenn bereits ein lokaler Server läuft, kann der Testport separat gewählt werden: `$env:TEST_PORT = '4175'`. Die Tests verwenden einen eigenen Vite-Cache, damit sie den laufenden Entwicklungsserver nicht beeinflussen. JSTS-Workerimporte werden vorab optimiert, um Neuladen beim ersten Randersatz zu vermeiden.
