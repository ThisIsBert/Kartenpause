# Kartenpause

Kartenpause legt historische oder thematische Rasterkarten anhand von Referenzpunkten auf eine moderne Basiskarte. Eine gemeinsame Automatik sucht nach einer passenden Kartenprojektion, optimiert bei Bedarf deren Parameter und ergänzt bei hartnäckigen lokalen Verzerrungen eine Thin-Plate-Spline-Korrektur (TPS).

## Lokal starten

Unter Windows genügt ein Doppelklick auf `Start-Kartenpause.cmd`. Das Skript installiert bei Bedarf die Abhängigkeiten und öffnet die Anwendung im Browser. Das Konsolenfenster während der Nutzung offen lassen; Strg+C beendet den Server.

Voraussetzung ist Node.js 24 oder neuer.

```powershell
npm.cmd install
npm.cmd run dev
```

Vite zeigt anschließend die lokale Adresse an. Ein Produktions-Build entsteht mit `npm.cmd run build` im Verzeichnis `dist/`.

## Manuell nachzeichnen

Nach dem Laden eines angepassten Projekts oder einer erfolgreichen Anpassung auf **Nachzeichnen →** klicken. Die linke Spalte und das Originalbild gleiten aus der Ansicht; die georeferenzierte Pixelkarte bleibt auf der Basiskarte liegen. Rechts erscheinen die Zeichenwerkzeuge. Über **← Karte einpassen** lässt sich jederzeit zurückwechseln; fertige Zeichnungen bleiben erhalten und behalten ihre geografischen Koordinaten auch bei einer erneuten Anpassung der Vorlage.

- **Punkt:** einmal auf die Karte klicken.
- **Linie / Polygon / geschwungene Formen:** Stützpunkte durch einzelne Klicks setzen, mit **Enter** oder **Fertig** abschließen. Polygone schließen sich automatisch. **Esc** verwirft die begonnene Form.
- **Bearbeiten:** Objekt auf der Karte oder in der Objektliste auswählen. Die kleinen quadratischen Stützpunkte lassen sich direkt ziehen; auch eine **+**-Markierung kann in einem Zug gedrückt und an die gewünschte Position gezogen werden. Ein einfacher Klick auf **+** fügt einen Punkt an Ort und Stelle hinzu, auch auf der schließenden Polygonkante. Die unsichtbare Trefferfläche ist größer als das sichtbare Symbol. Nicht ausgewählte Stützpunkte zeigen den normalen Pfeil, ausgewählte die Verschiebehand. Kurven verlaufen glatt durch ihre Stützpunkte.
- **Löschen:** Stützpunkt auswählen und **Entf** drücken oder den entsprechenden Button nutzen. Ohne ausgewählten Stützpunkt löscht Entf das ausgewählte Objekt. Die Mindestanzahl von Punkten bleibt erhalten.
- **Rückgängig / Wiederholen:** Buttons oder **Strg+Z / Strg+Umschalt+Z** (auch Strg+Y). Während des Zeichnens entfernt Rückgängig den letzten Punkt.
- **Kopieren:** ausgewähltes Objekt über den Kopierenbutton oder **Strg+C** als einzelnes GeoJSON-Feature in die Zwischenablage übernehmen. In Textfeldern bleibt das normale Kopieren erhalten.
- **Speichern:** alle fertigen Objekte als `kartenpause.geojson` herunterladen (GeoJSON-FeatureCollection, WGS84, Koordinatenfolge Längengrad/Breitengrad). Eine begonnene Form muss zuvor abgeschlossen oder abgebrochen werden.

GeoJSON kennt keine Kurven: Geschwungene Formen werden mit 32 Teilstücken pro Segment exportiert. Werkzeugtyp, Name und ursprüngliche Stützpunkte stehen zusätzlich in den Feature-Eigenschaften. Die Zeichnung liegt während der Bearbeitung im Arbeitsspeicher; vor dem Schließen exportieren. Die bestehende Georeferenzierungs-Projektdatei speichert weiterhin die Kartenanpassung, die Zeichnung wird separat als GeoJSON gespeichert.

## Magnetisch zwischen Ankern nachzeichnen

Für schwer erkennbare Grenzen ist **Magnetisch nachzeichnen** das bevorzugte Werkzeug:

1. Optional **Farbpipette** aktivieren und auf ein typisches Pixel der gewünschten Grenze klicken. Die Pixellupe zeigt die Originalpixel achtfach und ohne Glättung. Dieser Klick nimmt nur die Farbe auf und setzt keinen Anker. Eine kleine Farbtoleranz bevorzugt sehr ähnliche Farben, eine größere lässt stärkere Farbabweichungen zu. **Farbe löschen** schaltet zurück zur reinen Kontrastsuche.
2. Einen Startanker auf die Bildlinie setzen und ein Stück weiter den nächsten Anker anklicken. Die Suche läuft im Hintergrund auf den unverkleinerten Originalpixeln – unabhängig von Kartenzoom, Deckkraft, Basiskarte und bereits gezeichneten Objekten.
3. Den orange gestrichelten Vorschlag prüfen. **Abschnitt übernehmen** oder **Enter** bestätigt ihn. Stimmt er nicht, einen näheren Zwischenanker anklicken; dieser ersetzt den noch unbestätigten Endanker. **Vorschau verwerfen** entfernt nur den Vorschlag.
4. Weitere Abschnitte bestätigen. **Fertig** beendet die Linie. Für eine Fläche **Polygon schließen …** wählen und anschließend die vorgeschlagene Schließkante bestätigen. Es entsteht erst dann ein fertiges Polygon.

Der **Suchraum** wird in Originalpixeln angegeben und begrenzt seitliche Umwege zwischen den Ankern. Bei Kreuzungen helfen die Farbvorgabe und ein Anker unmittelbar hinter der Kreuzung. Ein großer Suchraum erlaubt stärkere Biegungen, kann aber andere Bildlinien einschließen. Größere Abschnitte müssen durch zusätzliche Anker unterteilt werden, statt für die Suche Bilddetails durch Herunterskalieren zu verlieren.

Während des Zeichnens entfernt **Rückgängig** zunächst die Vorschau, anschließend jeweils den letzten bestätigten Abschnitt beziehungsweise den Startanker. **Esc / Abbrechen** verwirft die ganze noch nicht abgeschlossene magnetische Zeichnung. Fertige Ergebnisse sind normale Linien oder Polygone mit frei bearbeitbaren Stützpunkten und lassen sich wie manuelle Objekte kopieren und exportieren.

Unter der Deckkraft steht zusätzlich **Vorlage ohne Glättung anzeigen** zur Verfügung. Die neue Erkennung arbeitet auch ohne diese Anzeigeoption direkt auf den Originalpixeln. Die Zuordnung zur Basiskarte berücksichtigt sowohl Projektion und Drehung als auch TPS-Korrekturen. Bei nicht eindeutig erkennbaren Grenzen bleibt die Vorschau eine Entscheidungshilfe; gleichfarbige Kreuzungen können zusätzliche Anker erfordern.

## Pinsel als ergänzendes Werkzeug

Im Zeichenmodus **Linie mit Pinsel erkennen** wählen und die Pinselbreite einstellen (12–120 Bildschirmpixel). Mit gedrückter linker Maustaste eine Linie auf der Pixelkarte abfahren. Der Suchbereich erscheint als transparente Pinselspur. Beim Loslassen sucht die Anwendung innerhalb dieser Spur nach einer kontinuierlichen, kontrastreichen Bildlinie. Die Pinselmitte muss die Linie nicht genau treffen. Mit **Esc** lässt sich die Spur abbrechen. Zum Verschieben der Karte wieder **Auswählen / Bearbeiten** aktivieren.

Kehrt eine ausreichend lange Spur bis auf einen halben Pinseldurchmesser zum Anfang zurück, entsteht ein Polygon, andernfalls eine Linie. Die Erkennung verwendet nur das georeferenzierte Rasterbild, unabhängig von dessen eingestellter Deckkraft; Basiskarte, Referenzpunkte und vorhandene Vektoren fließen nicht ein. Auch farbige oder helle Linien können erkannt werden, wenn sie sich von beiden Seiten des Hintergrunds abheben. Leere oder unzureichend erkennbare Bereiche erzeugen kein Objekt.

Die Ergebnisse sind normale, vereinfachte Linien beziehungsweise Polygone mit editierbaren Stützpunkten. Auf automatische Kurvenglättung wird verzichtet, damit sie nicht über die erkannte Kontur hinausschwingt. An Kreuzungen, Beschriftungen, breiten Flächenrändern oder schwachen Kontrasten ist Nachbearbeitung nötig. Ein engerer Pinsel und stärkeres Hineinzoomen helfen, die gesuchte Linie einzugrenzen. Rückgängig entfernt eine Erkennung einschließlich aller ihrer Stützpunkte in einem Schritt.

## Struktur

- `index.html` enthält die semantische Oberfläche.
- `src/main.js` verbindet Oberfläche, Karten und Projektdateien.
- `src/geo/geo-fit.js` bewertet die Anpassung fester Projektionen.
- `src/geo/projection-search.js` optimiert freie Projektionsparameter.
- `src/geo/thin-plate-spline.js` korrigiert lokale Restabweichungen auf Grundlage des besten Projektionsmodells.
- `src/styles.css` enthält das Layout und die Kartendarstellung.
- `src/drawing/` enthält Zeichenwerkzeuge, Stützpunktbearbeitung und GeoJSON-Geometrien.
- `tests/` enthält portable End-to-End- und Zoom-Regressionstests.

## Testen und veröffentlichen

```powershell
npm.cmd run test:ui
npm.cmd run build
```

GitHub Actions prüft jeden Push und Pull Request. Pushes auf `main` bauen die Anwendung und veröffentlichen `dist/` über GitHub Pages.

## Automatische Anpassung

Der einzige Anpassungsbutton arbeitet in bis zu drei Stufen:

1. feste Projektionsmodelle vergleichen;
2. ab vier Fit-Punkten freie Projektionsparameter optimieren;
3. ab sechs gut verteilten Fit-Punkten TPS ergänzen, falls der verbleibende Fehler für die Bildgröße zu groß ist.

TPS korrigiert nur die Restabweichung des besten Projektionsmodells. So bleibt die Extrapolation außerhalb der Referenzpunkte stabiler als bei einer rein geometrischen TPS-Transformation. Projektdateien der Versionen 1 und 2 bleiben ladbar; neue Projekte verwenden Version 3 und speichern die gewählte Transformationsstufe.

## Testkarten

Die vorhandenen manuellen Testprojekte liegen unter [`examples/`](examples/). Jede Projektdatei enthält das Rasterbild und die Referenzpunkte, kann also direkt über „Laden“ geöffnet werden. Neue `*.georeferenzierung.json`-Dateien im Projektstamm bleiben standardmäßig ignoriert und werden nicht versehentlich veröffentlicht.

Die automatisierten Tests erzeugen zusätzlich eine vollständig synthetische Rasterkarte. Vor einer Weiterverwendung der eingebetteten Kartenbilder sind die jeweiligen Nutzungsrechte und Quellenhinweise zu prüfen.
