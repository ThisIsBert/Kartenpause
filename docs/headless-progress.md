# Entwicklungsstand des Headless-Ziels

Stand: 16. Oktober 2026. Das Ziel ist **nicht erreicht**. Das CLI muss für alle
sechs Karten mindestens Referenzniveau unabhängig nachweisen. Übertragbarkeit
auf weitere Karten ist ebenfalls noch nicht bewiesen. Der spätere MCP-Server
ist nicht Gegenstand dieses Schritts.

## Implementiert

- Vorschauen, Ausschnitte, Symbolvorschläge, Ortsnamensuche, gemeinsame
  Landmarkenzuweisung, Fit, Transformation, Vektorisierung, Vergleich, Overlay.
- Globale eindeutige Ortszuordnung, Ausreißer, konkurrierende Hypothesen und
  räumliche Abdeckung. Bild-Prüfsummen binden Beobachtungen an das Original.
- Gemeinsame Projektionssuche und Zuweisung: Nach der groben Hypothese werden
  Parameter geschätzt und sämtliche ursprünglichen Alternativen erneut geprüft.
  Vorher ausgeschlossene Anker können zurückkehren.
- Vollständige Leave-one-out-Modellwahl mit pro Falte neu geschätzten
  Projektionsparametern/TPS. Kontrollpunkte bleiben ausgeschlossen.
- Gemeinsame feste Projektionen mit der Oberfläche; CLI-Projekte samt TPS sind
  dort ladbar. GeoJSON für Punkte, Linien, Flächen, Löcher, Mehrfachgeometrien,
  Rasterregionen und magnetische Linien.
- Affine Rasteranpassung für feste Projektionen mit unabhängigen Maßstäben und
  Scherung. Auswahl per Kreuzvalidierung, Version-4-Projekte samt UI-Rundlauf.
- Robuste Gitterlinienmessung mit Geraden/quadratischen Kurven; Gradwerte werden
  vom Agenten gelesen. Modellwahl hält vollständige Gitterlinien zurück.

Der Agent muss die Karte weiterhin semantisch lesen. Kompakte Tintenteile sind
nicht automatisch Ortsmarker; geometrische Konsistenz bestätigt keine Ortsnamen.

## Vergleich mit eingefrorenen Entwicklungsdaten

Alle sechs Eingaben unter `benchmarks/headless` sind seit dem Wechsel zur
allgemeinen Zuweisungstechnik unverändert. Die Prüfsummen stehen in
`benchmarks/protocol/headless-development-lock.json`. Der vollständige neue Lauf
liegt unter `output/headless/benchmark-cv`; Zahlen sind auch in
`benchmarks/results/2026-10-16-first-cv.json` erhalten.

| Karte | Fit / Prüf | CLI RMS (m) | Referenz RMS (m) | Ergebnis |
| --- | --- | ---: | ---: | --- |
| Germania | 6 / 4 | 14497 | 11589 | schlechter |
| El Dorado | 8 / 3 | 95302 | 197698 | besser |
| Belize | 6 / 3 | 9034 | 9986 | besser |
| US Civil War | 9 / 6 | 13480 | 10596 | schlechter |
| Inkareich | 7 / 3 | 33630 | 27989 | schlechter |
| Westfront | 9 / 6 | 13168 | 12340 | schlechter |

Der erneute vollständige Lauf mit affinen Kandidaten steht unter
`output/headless/benchmark-affine`; die Modellwahl und Prüfwerte sind identisch.
Exitcode 1 ist korrekt: **zwei von sechs** erreichen Referenzniveau.
Kreuzvalidierung garantiert keinen besseren Fehler an anderen Bildstellen.
Die wenigen, teils unsicheren visuellen Prüfpunkte bestätigen nicht die ganze
Karte. Frühere Zahlen mit anderen Beobachtungen sind nicht direkt als Vergleich
der Verfahren interpretierbar.

## Zusätzliche reale Karte: Australien

Aus einem vorhandenen Beispielprojekt wurde ausschließlich das Raster entnommen.
Vor dem ersten Fit wurden fünf Fit-Beobachtungen, fünf separate Prüfpunkte,
Koordinatenquellen und Algorithmus-Prüfsummen festgeschrieben:
`benchmarks/holdout/australia-{landmarks,gazetteer,protocol}.json`.
Die Karte hat keine benannten Ortsmarker. Grenzschnittpunkte und Küstenextrempunkte
wurden visuell identifiziert; diese Beobachtungen sind seither unverändert.

Der erste eingefrorene Versuch verwarf den südlichen Anker, behielt vier Anker
vor allem im Norden und erreichte 85730 m Prüf-RMS gegenüber 59638 m der Referenz.
Das ist ein **fehlgeschlagener** Versuch auf einer zusätzlichen Karte.

Mit der allgemeinen Projektionsverfeinerung innerhalb der Zuweisung bleiben alle
fünf Fit-Anker erhalten. Prüf-RMS: 71119 m, weiterhin über der Referenz. Das ist
Entwicklung auf einer nun bekannten Karte, kein neuer verdeckter Nachweis.
Niedrige Auflösung und unsichere semantische Identifikation der Küstenpunkte
begrenzen zusätzlich die Aussagekraft. Unveränderte Punkte allein garantieren
keine korrekten Beobachtungen.

Wiederholung: `scripts/benchmark-landmarks.mjs` mit
`benchmarks/holdout/australia-case.json`. Das Skript prüft Raster/Beobachtungen,
weist Algorithmusänderungen aus und lädt die Referenzausrichtung nach dem Fit.
Aktueller Lauf: `output/headless/australia-reproducible`.

## Verifikation und offene Arbeit

Eine weitere Zuweisungstechnik wurde an der Westfrontkarte geprüft: Die
beschrifteten Gitterlinien werden im Raster gemessen, statt einzelne Ortsmarker
nachzujustieren. Neun Linien liefern 15 Fit-Kreuzungen und fünf Kreuzungen einer
vollständig zurückgehaltenen Breitenlinie. Die Modellwahl lässt zusätzlich
jeweils eine vollständige Fit-Gitterlinie aus. Eingaben:
`benchmarks/observations/westfront-graticule.json`; reproduzierbarer Lauf:
`node scripts/benchmark-graticule.mjs --case benchmarks/observations/westfront-graticule-case.json --out output/headless/westfront-graticule-grouped`.

An der unbenutzten Linie erreicht das CLI **321 m**, die menschliche Referenz
**950 m** RMS. An den unveränderten sechs Ortsprüfpunkten sind es dagegen
**12632 m** gegenüber **12340 m**. Der Paris-Prüfpunkt allein hat rund 30 km
Abweichung. Er bleibt unverändert; beide Vergleiche stehen im Bericht und der
Runner gibt deshalb weiterhin Exitcode 1 zurück. Dieser Gitterversuch bestätigt
eine bessere Anpassung an die zurückgehaltene Linie, nicht automatisch die ganze
Karte oder die Richtigkeit aller bisherigen Ortsbeobachtungen. Die historische
Gitterbezugsfläche ist nicht identifiziert und wird hier als WGS84 interpretiert.

`npm.cmd run test:headless` besteht mit 31 Tests, darunter falsche Symbol-/Orts-
alternativen, geografische Mehrdeutigkeit, globale Ziel-Eindeutigkeit und
Projektionsverfeinerung mit Wiederaufnahme eines entfernten Ankers. Ein echter
CLI-Ablauf prüft `symbols → lookup → assign → fit → transform`, einschließlich
Bildbindung und Sperre ungeklärter Zuweisungen. Kontrollpunkte beeinflussen
keine Zuordnungsentscheidungen. Neu geschätzte Projektionsparameter und
TPS-Überanpassung werden zusätzlich zu Exporten, Ausschnitten und Overlay geprüft.

Der vollständige Unit-Testsatz besteht mit 132 Tests. Der Produktions-Build und
alle drei UI-Prüfungen bestehen: Die sechs veröffentlichten Karten laden, TPS
wird gezeichnet, und affine Geometrie bleibt beim Laden/Speichern erhalten und
wird beim Wechsel auf ein altes Projekt zurückgesetzt. Zahlen und Verifikation
stehen auch in `benchmarks/results/2026-10-16-affine-and-graticule.json`.
Der Build meldet weiterhin die bekannten `numeric`-eval-Hinweise. Ein erneuter
realer Inka-Export mit dem neuen Projekt erzeugt Punkt, Fläche und magnetische
Linie unter `output/headless/inkareich-cv-demo.geojson`; das bestätigt den Export,
nicht eine ausreichende Genauigkeit der zugrunde liegenden Georeferenzierung.

Offen bleiben die verlässliche semantische Identifikation realer Kartensymbole
und ausreichend verteilte Anker. Germania ist überwiegend im Westen/Südwesten
abgestützt; frühe US-Beobachtungen trafen teilweise Beschriftungen. Verbesserungen
müssen durch ein reproduzierbares Mess-/Zuweisungsverfahren entstehen und gegen
unveränderte Prüfdaten bewertet werden. Weitere manuelle Nachjustierung der
sechs Fall-Dateien ist derzeit ausgesetzt.

Vor Abschluss sind alle sechs Georeferenzierungen auf Referenzniveau, breitere
unabhängige Prüfungen, visuelle Überlagerungen und reale Objekt-Exporte
nachzuweisen. Originale unter `Karten/` und `Karten/Ground truth/` bleiben
unverändert. Anleitung: [headless.md](headless.md).
