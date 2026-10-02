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
- **Speichern:** alle fertigen Objekte als GeoJSON-FeatureCollection herunterladen (WGS84, Koordinatenfolge Längengrad/Breitengrad). Bei genau einem benannten Objekt lautet der Dateivorschlag `Objektname.geojson`, sonst `kartenpause.geojson`. Ungültige Dateinamenszeichen werden ersetzt. Eine begonnene Form muss zuvor abgeschlossen oder abgebrochen werden.

GeoJSON kennt keine Kurven: Geschwungene Formen werden mit 32 Teilstücken pro Segment exportiert. Werkzeugtyp, Name und ursprüngliche Stützpunkte stehen zusätzlich in den Feature-Eigenschaften. Die Zeichnung liegt während der Bearbeitung im Arbeitsspeicher; vor dem Schließen exportieren. Die bestehende Georeferenzierungs-Projektdatei speichert weiterhin die Kartenanpassung, die Zeichnung wird separat als GeoJSON gespeichert.

## Magnetisch zwischen Ankern nachzeichnen

### GeoJSON laden und vorhandenen Linien und Flächenrändern folgen

Der Zeichenmodus ist auch ohne Pixelkarte verfügbar. Unter **GeoJSON → Datei laden** eine `.geojson`-/`.json`-Datei auswählen oder **Aus Zwischenablage** beziehungsweise **Strg+V** verwenden (außerhalb von Textfeldern). Der Import ergänzt die Zeichnung, zoomt auf die importierten Objekte und lässt sich als ein Schritt rückgängig machen. Unterstützt werden FeatureCollections, Features und Geometrien in WGS84 (Längengrad/Breitengrad). MultiPolygone bleiben einschließlich ihrer Löcher ein Objekt; MultiPoints, MultiLineStrings und GeometryCollections bleiben ebenfalls jeweils ein bearbeitbares Objekt. Getrennte Abschnitte bleiben getrennt; der Import erfindet keine Verbindungen. Namen und zusätzliche Feature-Eigenschaften bleiben erhalten; IDs werden neu vergeben. Höhenwerte werden nicht bearbeitet. Exportierte Kurven werden anhand ihrer GeoJSON-Kontur als fein aufgelöste Linien/Polygone geladen. Fehlerhafte Daten werden mit einer Meldung abgelehnt, ohne Teile zu importieren.

Im magnetischen Werkzeug **Verlauf übernehmen aus → Linien und Flächenränder** wählen. Klicks innerhalb von 16 Bildschirmpixeln rasten an der nächsten Kante ein. Zwischen Punkten an verbundenen Kanten wird der kürzeste Kantenweg vorgeschlagen, auch über umgekehrt orientierte Teilstücke einer mehrteiligen Linie hinweg. Für längere Bögen oder eine bestimmte Abzweigung Zwischenpunkte setzen. Ohne passende verbundene Kanten wird gerade verbunden. Weiterklicken übernimmt die Vorschau und setzt fort; Alt korrigiert den letzten Vorschauabschnitt. Vorhandene Zwischenstützpunkte bleiben ohne Glättung erhalten. Geschwungene Quellen verwenden dieselbe fein aufgelöste Kontur wie Anzeige und Export.

Auch bei **Randabschnitt ersetzen** lässt sich diese Quelle auswählen, bevor auf **Magnetisch** umgeschaltet wird. Hier werden andere Linien und Flächen als Quelle verwendet. Die festen Endpunkte müssen nicht auf der Vorlage liegen: Gerade Verbindungsstücke erhalten ihre exakte Position. Das Ergebnis ist eine unabhängige Kopie, keine dauerhafte topologische Verknüpfung: Spätere Bearbeitung oder Vereinfachung nur eines Objekts kann die Deckungsgleichheit wieder aufheben.

### Pixelkarte als Quelle

Für schwer erkennbare Grenzen ist **Magnetisch nachzeichnen** das bevorzugte Werkzeug:

1. Optional **Farbpipette** aktivieren und auf ein typisches Pixel der gewünschten Grenze klicken. Die Pixellupe zeigt die Originalpixel achtfach und ohne Glättung. Dieser Klick nimmt nur die Farbe auf und setzt keinen Anker. Eine kleine Farbtoleranz bevorzugt sehr ähnliche Farben, eine größere lässt stärkere Farbabweichungen zu. **Farbe löschen** schaltet zurück zur reinen Kontrastsuche.
2. Einen Startanker auf die Bildlinie setzen und ein Stück weiter den nächsten Anker anklicken. Die Suche läuft im Hintergrund auf den unverkleinerten Originalpixeln – unabhängig von Kartenzoom, Deckkraft, Basiskarte und bereits gezeichneten Objekten.
3. Den orange gestrichelten Vorschlag prüfen. Ein Klick weiter hinter dem Endanker übernimmt ihn und sucht sofort den nächsten Abschnitt. Ein Klick zurück in den bisherigen Abschnitt ersetzt den noch unbestätigten Endanker (Korrektur). Deutliches seitliches Weiterklicken am Abschnittsende erlaubt auch scharfe Richtungswechsel. **Alt+Klick** erzwingt eine Korrektur, **Umschalt+Klick** das Fortsetzen. **Abschnitt übernehmen** und **Enter** bleiben verfügbar. **Vorschau verwerfen** entfernt nur den Vorschlag. Während die Suche noch läuft, ersetzt ein weiterer Klick den Suchendpunkt; noch nicht sichtbare Ergebnisse werden nicht automatisch bestätigt.
4. Weitere Abschnitte bestätigen. **Fertig** beendet die Linie. Für eine Fläche **Polygon schließen …** wählen und anschließend die vorgeschlagene Schließkante bestätigen. Es entsteht erst dann ein fertiges Polygon.

Der **Suchraum** wird in Originalpixeln angegeben und begrenzt seitliche Umwege zwischen den Ankern. Bei Kreuzungen helfen die Farbvorgabe und ein Anker unmittelbar hinter der Kreuzung. Ein großer Suchraum erlaubt stärkere Biegungen, kann aber andere Bildlinien einschließen. Größere Abschnitte müssen durch zusätzliche Anker unterteilt werden, statt für die Suche Bilddetails durch Herunterskalieren zu verlieren.

Für eine Grenze zwischen zwei Farbflächen ohne Umrisslinie mit **Farbpipette** die erste Fläche und mit **Zweite Farbpipette** die gegenüberliegende Fläche aufnehmen. Sobald beide Farben gesetzt sind, sucht das Werkzeug nach ihrem Übergang statt nach einem abgesetzten Strich. Die Reihenfolge der Farben spielt keine Rolle. Die Farbtoleranz gilt für beide Flächen; **Zweite Farbe löschen** schaltet zurück zur Liniensuche. Nahezu identische Farben werden als ungeeignet gemeldet.

Während des Zeichnens entfernt **Rückgängig** zunächst die Vorschau, anschließend jeweils den letzten bestätigten Abschnitt beziehungsweise den Startanker. **Esc / Abbrechen** verwirft die ganze noch nicht abgeschlossene magnetische Zeichnung. Fertige Ergebnisse sind normale Linien oder Polygone mit frei bearbeitbaren Stützpunkten und lassen sich wie manuelle Objekte kopieren und exportieren.

Unter der Deckkraft steht zusätzlich **Vorlage ohne Glättung anzeigen** zur Verfügung. Damit wird die weiche Pixelinterpolation bei der Anzeige abgeschaltet: Beim Vergrößern erscheinen Pixel kantiger statt weich ineinander überzugehen. Das erzeugt keine zusätzlichen Bilddetails und verändert weder Erkennung noch Export. Die Erkennung arbeitet unabhängig davon direkt auf den Originalpixeln. Die Zuordnung zur Basiskarte berücksichtigt sowohl Projektion und Drehung als auch TPS-Korrekturen. Bei nicht eindeutig erkennbaren Grenzen bleibt die Vorschau eine Entscheidungshilfe; gleichfarbige Kreuzungen können zusätzliche Anker erfordern.

## Zauberstab und Flächenauswahl

**Zauberstab / Fläche auswählen** aktivieren und in eine Farbfläche klicken. Standardmäßig werden alle ähnlich gefärbten Originalpixel im Bild ausgewählt, auch auf getrennten Inseln. **Nur zusammenhängende Fläche** beschränkt die Auswahl auf die mit dem angeklickten Pixel über Kanten verbundene Fläche. Transparente Bildbereiche bleiben ausgeschlossen. Die Farbtoleranz verwendet den wahrnehmungsbezogenen CIELAB-Farbraum: niedrige Werte wählen sehr ähnliche Farben, höhere erlauben stärkere Farb- und Helligkeitsnuancen. Der Vergleich bleibt an die angeklickte Farbe gebunden und wandert nicht schrittweise in andere Farben weiter.

- **Auswahl ersetzen / hinzufügen / abziehen:** per Zauberstab weitere Bereiche auswählen oder entfernen.
- **Pinsel hinzufügen / entfernen:** unabhängig von Farben malen, mit einstellbarem Durchmesser in Originalpixeln. Dabei zeigt ein grüner beziehungsweise roter Umriss die Pinselgröße. Zum Verschieben der Karte zurück auf einen Zauberstab-Modus wechseln.
- Toleranz und Zusammenhängend-Option gelten nur für den **nächsten Klick**. Bestehende Auswahl und Pinselkorrekturen bleiben unverändert. Beispielsweise zunächst mit hoher Toleranz auswählen, dann mit niedriger Toleranz im Modus **hinzufügen / abziehen** nachkorrigieren.
- **Rückgängig / Wiederholen** wirkt während der Auswahl auf die einzelnen Auswahl- und Pinselaktionen. Der Verlauf ist abhängig von der Bildgröße auf höchstens zwölf Schritte begrenzt.
- **Fertig / Enter** übernimmt sämtliche Teilflächen als **ein gemeinsames Objekt** (GeoJSON-MultiPolygon bei mehreren Teilflächen, sonst Polygon). Löcher bleiben Innenringe. Jede Teilfläche und jeder Lochrand ist mit denselben Stützpunktwerkzeugen bearbeitbar; Kopieren, Löschen und Rückgängig behandeln das gesamte Objekt gemeinsam.

### Fertige Objekte weiterbearbeiten

Nach Auswahl eines Objekts stehen zwei zusätzliche Bearbeitungsmodi zur Verfügung. Das Original bleibt bis **Übernehmen** unverändert; **Verwerfen / Esc** bricht ab. Übernehmen ersetzt dasselbe Objekt mit gleichem Namen und gleicher ID und lässt sich in einem Schritt rückgängig machen. Die normalen Zeichenwerkzeuge und der Export sind währenddessen gesperrt.

- **Fläche weiterbearbeiten:** Die aktuelle Polygonform (einschließlich manueller Änderungen, Teilflächen und Löcher) wird wieder zur Zauberstab-Auswahl. Standardmäßig ist **Hinzufügen** aktiv; Abziehen und die beiden Korrekturpinsel funktionieren wie gewohnt. Die Umwandlung in Originalpixel kann kleine Konturänderungen verursachen. Eine leere Auswahl lässt sich nicht übernehmen; zum vollständigen Entfernen bitte das Objekt löschen. Flächen außerhalb der Vorlage oder ohne eindeutige Rückprojektion werden nicht stillschweigend abgeschnitten, sondern mit Hinweis abgelehnt; dafür den Randabschnitt-Modus nutzen.
- **Randabschnitt ersetzen:** Anfang **A** und Ende **B** auf demselben Außenrand, Lochrand oder derselben Linie anklicken, auch zwischen Stützpunkten. Bei geschlossenen Rändern wird automatisch der kürzere Randweg ersetzt, unabhängig von der Klickreihenfolge. Der alte Abschnitt wird rot gestrichelt angezeigt. Von A aus den Ersatz zeichnen, anschließend B anklicken oder **Mit Endpunkt B verbinden**. Der Umschalter **Manuell / Magnetisch** gilt nur innerhalb dieses Bearbeitungsmodus. Bestätigte Teilstücke bleiben bei einem Wechsel erhalten. Eine offene magnetische Vorschau muss zuerst bestätigt oder verworfen werden. **Letztes Teilstück zurück** korrigiert die Zeichnung, **A und B neu wählen** startet die Abschnittswahl neu. Die fertige Ersatzfläche wird blau hinterlegt. Nach Abschluss prüft ein Hintergrundprozess Polygonüberschneidungen und die Zuordnung der Löcher; die erste gefundene Problemstelle erhält eine rote Markierung mit Erklärung. Erst bei gültiger Geometrie ist Übernehmen möglich. Magnetische Hin-und-zurück-Sporne an Teilstückübergängen werden vor der Stützpunkterzeugung entfernt; echte Kreuzungen werden nicht stillschweigend beseitigt. Kurven werden für diesen Modus in ihre fein aufgelösten geraden Segmente umgewandelt; ihre bisherige dargestellte Kontur bleibt die Ausgangsform.

### Geometrie vereinfachen und glätten

Objekt auswählen und **Vereinfachen und glätten** nach rechts ziehen. Die Vorschau entfernt entbehrliche Stützpunkte und glättet kleine Unebenheiten; bei Linien bleiben die Endpunkte fest. Mit zunehmender Stärke werden außerdem kleine abgetrennte Teilflächen entfernt und kleine Löcher gefüllt. Die größte Teilfläche bleibt immer erhalten. Vorschau und Zähler zeigen Stützpunkte, Teilflächen und Löcher vorher/nachher. Kleine echte Inseln können genauso entfallen wie Erkennungsflecken: daher vor dem Übernehmen prüfen. Neue Überschneidungen oder ein Verlust der Zuordnung verbleibender Löcher schwächen die Konturvereinfachung nur an den beteiligten Rändern ab. Bereits vorhandene unveränderte Randkontakte blockieren nicht die Bearbeitung anderer Teilflächen.

Der Regler berechnet immer aus der unveränderten Ausgangsform: Zurückziehen schwächt die Wirkung ab, **0** stellt die Ausgangsform wieder her, einschließlich entfernter Inseln und Löcher. Die Stärke wächst nichtlinear und verwendet eine gemeinsame Größenskala für das Objekt. Bei Stärke s (0 bis 1) liegt die Flächenschwelle bei 0,1 % × s⁴ der ursprünglichen gesamten gefüllten Fläche; Konturen verwenden eine Toleranz von (0,02 × s² + 0,18 × s⁴) der gesamten Boundingbox-Diagonale vor der Geometrieprüfung. Beide Größen werden in der Kartenprojektion bestimmt. Die Prozentangabe bezeichnet die Stärke, nicht den Anteil entfernter Punkte. **Übernehmen** speichert die Änderung als einen rückgängig machbaren Schritt; **Verwerfen** bricht ab. Während der Vorschau sind Punktbearbeitung und Export gesperrt. Einzelpunkte benötigen keine Vereinfachung.

Die Vereinfachung läuft in einem Hintergrundprozess. Der Regler bleibt währenddessen bedienbar: Neue Werte brechen veraltete Aufträge ab; **Verwerfen** beendet auch laufende Berechnungen. Zauberstab, magnetische Suche und Vereinfachung zeigen während ihrer Berechnung den System-Mauszeiger mit Beschäftigungsanzeige (unter Windows Pfeil mit Ladekreis). Bei Objekten über 1.000 Stützpunkten werden nur räumlich ausgedünnte Griffe im sichtbaren Kartenausschnitt angezeigt, maximal etwa 600. Zum Bearbeiten einzelner Punkte hineinzoomen und gegebenenfalls die Karte verschieben. Die Geometrie und der Export enthalten weiterhin alle Punkte.
- **Esc / Abbrechen** verwirft die noch nicht übernommene Auswahl. Die Übernahme lässt sich anschließend als Ganzes rückgängig machen.

Auswahl und Umrissberechnung laufen im Hintergrund auf der Originalauflösung. Die Flächenauswahl unterstützt Vorlagen bis 25 Millionen Pixel; extrem kleinteilige Auswahlen werden mit einem Hinweis abgelehnt, statt Inseln oder Löcher stillschweigend wegzulassen.

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

Eine OSM-Relation als einzelnes GeoJSON-Feature mit MultiLineString oder GeometryCollection bleibt ein Objekt. Unabhängige Features werden nicht anhand gleicher Namen zusammengefasst.


### Randkorrektur ohne Neuzeichnen

Nach dem Verbinden mit B bleibt der Ersatzverlauf mit blauen Stützpunkten bearbeitbar, auch wenn die Prüfung ein Problem meldet. Punkte ziehen, mit **+** ergänzen oder auswählen und mit **Entf** beziehungsweise **Gewählten Ersatzstützpunkt löschen** entfernen. A und B bleiben fest. Nach jeder Änderung wird erneut geprüft; **Letztes Teilstück zurück** nimmt auch Punktkorrekturen zurück. Bei dichten Konturen hineinzoomen: Die Anzeige begrenzt die Zahl der Griffe, alle Koordinaten bleiben erhalten.

Die Kantennachzeichnung berechnet eingerastete Anker in Kartenkoordinaten und vermeidet dadurch Rückläufe durch Pixelrundung. Flächenlose Rückläufe werden automatisch bereinigt; es gibt keinen einzustellenden Detailgrad. Die Bereinigung verändert keine echten Schleifen anhand einer Größenheuristik. Bei Kreuzungen zeigt die Vorschau beide betroffenen Kanten und die Schnittstelle. JSTS prüft die Geometrie im Hintergrund und rekonstruiert bei Bedarf die eingeschlossenen Flächen nach der Even-odd-Füllregel. Eine dadurch entstehende Aufteilung in Teilflächen oder Löcher wird als Vorschlag angezeigt und erst nach **Bereinigte Flächenaufteilung bestätigen** zur Übernahme freigegeben. Alternativ die erhaltenen Stützpunkte korrigieren. **Verwerfen** erhält das Original; nach **Übernehmen** stellt Rückgängig das Original wieder her.
