# Headless-Interface

Lokales Node.js-CLI (Node 24+), ohne Browser und ohne eingebauten KI-Dienst.
Ein KI-Agent liest die Karte, benennt Landmarken und gewünschte Objekte und
nutzt das CLI für Messung, Kandidatenprüfung, Georeferenzierung und GeoJSON.
Ein MCP-Server gehört erst zum nächsten Entwicklungsschritt.

```powershell
npm.cmd install
node scripts/headless.mjs --help
node scripts/headless.mjs inspect --image Karten/inkareich.png --out output/inka-grid.png
node scripts/headless.mjs fit --image Karten/inkareich.png --request passpunkte.json --out output/inka.json --report output/fit.json
node scripts/headless.mjs vectorize --project output/inka.json --request objekte.json --out output/inka.geojson
```

Direkte Node-Aufrufe liefern JSON auf stdout; Fortschritt und Fehler stehen auf
stderr. Fehler ergeben Exitcode 1. `--out` speichert Ergebnisse. `npm.cmd run
headless -- ...` ist ebenfalls möglich, ergänzt jedoch npm-Ausgaben auf stdout.

## Originalpixel und Bildausschnitte

`pixel:[x,y]` zählt Originalpixel vom linken oberen Rand, x nach rechts, y nach
unten. Alternativ: `source:{u:x/Bildbreite,v:y/Bildhöhe}`. Keine automatische
EXIF-Drehung oder Umstellung auf Vorschaukoordinaten. `inspect` nennt Bildmaße,
SHA-256, Ausschnitt und Vorschau-Skalierung. Das Gitter zeigt Originalpixel.
Ein optionales `--request crop.json` enthält beispielsweise:

```json
{"left":100,"top":50,"width":250,"height":300,"scale":4,"grid":50}
```

`scale` darf bis 16 reichen, `maxSize` bis 8000; `grid` muss mindestens 10 sein.
Vorschaumarker und Linien verwenden Originalkoordinaten:
`{"markers":[{"id":1,"pixel":[104,74]}],"paths":[[[104,74],[131,196]]]}`.

## Landmarken finden und zuweisen

Die wiederverwendbare Folge lautet: Karte lesen, mögliche Symbole messen,
geografische Kandidaten suchen, gemeinsam zuweisen, fitten und an zusätzlichen
Punkten prüfen. Keine dieser Stufen benötigt Ground Truth.

```powershell
node scripts/headless.mjs symbols --image karte.png --request regionen.json --out symbole.json
node scripts/headless.mjs lookup --reference cities500.txt --request ortsnamen.json --out orte.json
node scripts/headless.mjs assign --image karte.png --request landmarken.json --out zuweisung.json
node scripts/headless.mjs fit --image karte.png --request zuweisung.json --out projekt.json --report fit.json
```

`symbols` sucht kompakte verbundene dunkle oder farbige Tinte in Bildregionen:

```json
{
  "regions":[{"id":"mainz","label":"Mogontiacum","left":200,"top":330,"width":45,"height":45}],
  "threshold":110,"minDiameter":2,"maxDiameter":14,"limit":20
}
```

Optional ersetzen `color:[r,g,b]` und `colorTolerance:60` den Dunkelheitstest.
Eine Region darf höchstens zwei Millionen Pixel haben. Randkomponenten werden
verworfen; Ausschnitte großzügig wählen. Vorschläge enthalten Schwerpunkt,
Bounding Box, Fläche, Bildbeleg und eine `previewRequest` für `inspect`.
Das ist **keine semantische Erkennung**: Ein Buchstabe kann ein kompaktes Symbol
sein. `shapeScore` sortiert Formen, ist keine Wahrscheinlichkeit. Bei Küsten,
Grenzschnittpunkten und verbundenen Symbolen liefert der Agent direkt begründete
Pixelbeobachtungen statt unpassende Symbolvorschläge zu erzwingen.

`lookup` liest GeoNames-TSV (`.txt`/`.tsv`) zeilenweise oder eine JSON-Liste:

```json
[{"id":"mainz","name":"Mainz","aliases":["Mogontiacum"],"target":{"lon":8.28008,"lat":49.98185},"source":"https://www.geonames.org/2874225/","country":"DE"}]
```

Suchauftrag: `{"queries":["Mogontiacum","Paris"],"countries":["DE","FR"],
"bounds":[-10,40,20,60],"limit":10}`. Namen/Aliase werden exakt nach
Normalisierung von Großschreibung, Diakritika und Satzzeichen verglichen.
Länder- und Bereichsfilter sind optional; ein Datumswechselbereich hat west >
east. Bevölkerungszahl sortiert Treffer, bestätigt aber keine Identität.
`matchingCount` und `truncated` zeigen abgeschnittene Alternativen.

Der Agent verbindet Beobachtungen und Ortskandidaten im `assign`-Auftrag:

```json
{
  "landmarks":[
    {
      "id":"mainz","role":"fit",
      "observations":[
        {"id":"marker","pixel":[222,355],"evidence":"Dunkles Ortssymbol links neben Mogontiacum im Originalausschnitt."},
        {"id":"alternative","pixel":[230,360],"evidence":"Zweite mögliche Markierung; visuell noch unsicher."}
      ],
      "candidates":[{"id":"geonames:2874225","target":{"lon":8.28008,"lat":49.98185},"source":"https://www.geonames.org/2874225/"}]
    }
  ],
  "options":{"trials":384,"maxErrorPixels":6,"minimumCoverage":0.1}
}
```

Mindestens vier Fit-Landmarken sind nötig; das gekürzte Beispiel zeigt einen
Eintrag. Beobachtungs-IDs sind innerhalb einer Landmarke, Landmarken-IDs
insgesamt eindeutig. Kandidaten-IDs bezeichnen denselben geografischen Ort auch
über mehrere Landmarken hinweg und müssen dann identische Koordinaten haben.
Visueller Beleg und Koordinatenquelle sind Pflicht. Optional bindet
`image:{sha256:"..."}` Eingaben an das Originalbild.

Reproduzierbare Dreipunkt-Hypothesen bilden den Anfang. Die globale Zuordnung
maximiert zuerst die Zahl konsistenter Landmarken und minimiert dann deren
Pixelfehler. Ein Ziel kann nicht zwei Landmarken gleichzeitig zugewiesen werden.
Mehrere Hypothesen bleiben erhalten. Anschließend werden Projektionsparameter
aus den jeweiligen Fit-Ankern neu geschätzt und **alle ursprünglichen
Alternativen erneut geprüft**. Ein vom groben Modell abgelehnter Anker kann
dadurch wieder in die gemeinsame Lösung kommen.

Gleich plausible konkurrierende Zuordnungen bleiben offen. `status` ist
`assigned` oder `needs-review`; `unresolved` nennt Ausreißer und Mehrdeutigkeiten.
Auch `assigned` kann einzelne Ausreißer enthalten: Der Agent muss die Liste
lesen. Unter einer konvexen Hüllfläche von standardmäßig 10 % des Bilds verlangt
das Ergebnis ebenfalls Prüfung. Diese minimale Verteilungsprüfung bestätigt
keine Genauigkeit außerhalb der Anker.

`options.codes` beschränkt grobe feste Projektionen, `options.families` die
anschließende Parametersuche (z. B. `["eqc","lcc"]`). Ohne Vorgaben werden
regionale azimutale und feste grobe Modelle sowie alle Projektionsfamilien
geprüft. Explizite `codes` deaktivieren die Familienverfeinerung, sofern
`families` nicht zusätzlich angegeben ist. `families:[]` erlaubt den Vergleich
mit reiner grober Zuordnung. `seed` legt den Zufallsstart fest;
`ambiguityCostGap` die Nähe konkurrierender Zuordnungskosten.

Kontrolllandmarken tragen `role:"control"` und genau eine unabhängig bestimmte
Beobachtung plus ein Ziel. Sie beeinflussen weder Hypothesen noch Zuordnung
oder Projektionsverfeinerung. Die Ausgabe enthält sie als `fit:false`.
`assign` liefert bei einer gültigen ungelösten Anfrage Exitcode 0 mit
`needs-review`; `fit` verweigert solche Ergebnisse und Bild-Prüfsummenfehler.

## Georeferenzierung und Modellwahl

Bei einem beschrifteten Koordinatengitter kann `graticule` Ortsmarker ersetzen:

```powershell
node scripts/headless.mjs graticule --image karte.png --request gitter.json --out gitterpunkte.json
node scripts/headless.mjs fit --image karte.png --request gitterpunkte.json --out projekt.json --report fit.json
node scripts/benchmark-graticule.mjs --case benchmarks/observations/westfront-graticule-case.json --out output/headless/westfront-graticule-grouped
```

Ein Linieneintrag hat die Form
`{"id":"lon3","axis":"longitude","value":3,"from":[137,146],"to":[130,748],"evidence":"Gradwert 3 am Kartenrahmen gelesen."}`.
`axis` ist `longitude` oder `latitude`, `value` der vom Agenten gelesene Gradwert.
`from`/`to` begrenzen einen groben Bildkorridor, keine fertige Messung. Das CLI
sucht darin kompakte dunkle Striche und passt robust Geraden oder quadratische
Kurven an. Aus den gemessenen Kreuzungen entstehen die Passpunkte. Fehlende
Tinte, zu geringe Unterstützung oder zu kurze Abdeckung ergeben `needs-review`.
Die Ausgabe lässt sich mit `previewRequest` in `inspect` visuell überprüfen.

Der Auftrag enthält `lines:[...]`, optional `image:{sha256:"..."}`,
`options:{radius:12,threshold:140,maxWidth:4,trials:192,maxResidual:1.25,
minSupport:0.55,degree:"auto",seed:20261016}` und `fitOptions` für den nächsten
Fit. `degree` darf `1`, `2` oder `auto` sein. Mindestens vier Linien sind nötig;
für die normale Gruppen-Kreuzvalidierung mindestens drei Fit-Meridiane und drei
Fit-Breitenkreise verwenden. Zusätzlich eine vollständige Linie mit
`role:"control"` zurückhalten. Deren Kreuzungen werden `fit:false`.

Gradwerte, Nullmeridian und historisches Datum muss der Agent prüfen; das CLI
liest keine Beschriftungen. Stark gekrümmte, unterbrochene oder farbige Gitter
können außerhalb dieses Dunkelstrich-Verfahrens liegen. Gemeinsame Schnittpunkte
teilen Messfehler derselben Linie. `fit` erkennt deshalb `gridLines`-Metadaten
und hält bei der Modellwahl automatisch ganze Linien zurück
(`leave-one-grid-line-out`). `options.validation:"point"` erzwingt die frühere
Punktprüfung, `"grid-line"` verlangt vollständige Gruppenmetadaten. Eine weitere,
vollständig vom Fit ausgeschlossene Linie bleibt für den abschließenden Vergleich
erforderlich. Die Herkunftswarnung wird in Projekt und Fit-Bericht gespeichert.

`fit` akzeptiert erfolgreiche Zuweisungen oder eine direkte Liste:

```json
{
  "points":[
    {"name":"Ort A","pixel":[100,100],"target":{"lon":10,"lat":50}},
    {"name":"Ort B","pixel":[300,100],"target":{"lon":12,"lat":50}},
    {"name":"Ort C","pixel":[100,300],"target":{"lon":10,"lat":48}},
    {"name":"Ort D","pixel":[300,300],"target":{"lon":12,"lat":48}},
    {"name":"Prüfort","pixel":[200,200],"target":{"lon":11,"lat":49},"fit":false}
  ],
  "options":{"tps":"auto"}
}
```

Ab vier Fit-Punkten ist Leave-one-out-Kreuzvalidierung der Standard: Für jeden
ausgelassenen Punkt werden Ausrichtung, **alle gesuchten Projektionsparameter**
und gegebenenfalls TPS aus den übrigen Punkten neu geschätzt. Kontrollpunkte
bleiben ausgeschlossen. Nicht vollständig validierbare Modelle sind nicht
auswählbar. Die Parametersuche benötigt vier Trainingspunkte pro Falte, also
mindestens fünf für vollständige Kreuzvalidierung.

`options.codes`/`families` beschränken Fit-Kandidaten; leere Listen lassen die
jeweilige Suche aus. `alignment:"auto"` prüft bei festen Projektionen sowohl
gemeinsamen Maßstab/Drehung als auch eine affine Rasteranpassung mit unabhängigen
Maßstäben und Scherung. Nur Kreuzvalidierung entscheidet zwischen ihnen.
`"similarity"` beschränkt auf das frühere Modell. `"affine"` verlangt eine feste
Projektion und `families:[]`; gemeinsame affine Parametersuche für eine variable
Projektionsfamilie ist noch nicht implementiert. Spiegelungen und singuläre
Matrizen werden abgewiesen. Bei nur drei Ankern wird affine Anpassung lediglich
auf ausdrücklichen Wunsch versucht, weil keine unabhängige Auswahl möglich ist.

`tps` ist `auto`, `never` oder `always`. Automatische TPS
wird mit `1e-8`, `0.001`, `0.01`, `0.1` gegen
die Basisprojektion validiert. Eine explizite `regularization` beschränkt diese
Auswahl. Jede Trainingsfalte muss mindestens sechs Anker behalten; bei gewöhnlicher
Punktprüfung sind deshalb mindestens sieben nötig. Erzwingt der Aufrufer TPS mit
zu wenigen Ankern pro Falte, beschreibt die Validierung nur das Basismodell und
warnt ausdrücklich. TPS selbst benötigt mindestens sechs Trainingsanker.

`selection:"training"` aktiviert die frühere Wahl nach Fit-RMS. Dort versucht
`tps:"auto"` ab sechs Punkten und mehr als zwei Pixeln Basis-RMS eine TPS. Mit
nur drei Punkten ist Trainingswahl der Standard. `validation` und
`validationRankings` dokumentieren die vollständige neue Prüfung. Die ältere
`conditionalLeaveOneOut` hält Projektionsparameter fest und prüft keine TPS;
sie ist nur eine zusätzliche Empfindlichkeitsdiagnose.

Auch vollständige Kreuzvalidierung dient hier der **Modellwahl** und ersetzt
keine unbenutzten Prüfpunkte. Nahezu null TPS-Trainingsfehler bestätigt keine
Genauigkeit. Die Modellwahl kann trotz Kreuzvalidierung schlechter als die
Referenz ausfallen; der aktuelle Vergleich zeigt solche Fälle.

`fit` nutzt die gemeinsamen Projektionen und bestehenden Geometrieverfahren
der Oberfläche. Projekte enthalten das Originalbild und lassen sich im CLI und
in Kartenpause wieder laden. Normale Modelle bleiben Version 3; affine Modelle
verwenden Version 4 mit `alignment.affine:[a,b,c,d]`. Diese Matrix bildet
`[u-0.5,0.5-v]` auf CRS-Koordinaten relativ zum gespeicherten Mittelpunkt ab.
Ältere Programmversionen lehnen Version 4 ab, statt die Scherung zu ignorieren.
Die Oberfläche lädt, zeichnet und speichert affine Modelle, ihre eigene
automatische Neuanpassung verwendet weiterhin den bisherigen Projektions-Fit.

## Vektorisierung und Überlagerung

`vectorize` erwartet Pixelgeometrien und exportiert WGS84-Längengrad/Breitengrad:

```json
{
  "objects":[
    {"name":"Fundort","geometry":{"type":"Point","coordinates":[104,74]}},
    {"name":"Route","geometry":{"type":"LineString","coordinates":[[104,74],[131,196],[221,236]]}},
    {"name":"Gebiet","geometry":{"type":"Polygon","coordinates":[[[110,160],[140,180],[130,210]]]}},
    {"name":"Farbfläche","mode":"region","seeds":[[110,180]],"algorithm":"intelligent","tolerance":18},
    {"name":"Grenzlinie","mode":"magnetic","anchors":[[110,160],[140,180]],"radius":24,"color":[20,20,20],"tolerance":50}
  ]
}
```

Point, MultiPoint, LineString, MultiLineString, Polygon und MultiPolygon mit
Löchern werden unterstützt. Linien und Konturen werden vor der Transformation
auf höchstens vier Pixel Abstand verdichtet. Regionen nutzen klassischen oder
intelligenten Zauberstab; mehrere Seeds ergänzen die Auswahl. `contiguous:false`
wählt klassisch auch getrennte gleichfarbige Inseln. Magnetische Linien nutzen
die Pfadsuche der Oberfläche; `color2` aktiviert den Übergang zwischen zwei
Farben. Lange Abschnitte benötigen Zwischenanker.

Optional beschränkt `crop` den Rasterarbeitsspeicher:
`{"crop":{"left":100,"top":100,"width":400,"height":400},"objects":[...]}`.
Seeds/Anker bleiben in Originalpixeln; Regionen am Ausschnittrand sind dort
abgeschnitten. Direkte Geometrien benötigen keine Rasterdekodierung.

`overlay --project ... --reference grenzen.geojson --out vorschau.png` bildet
geografische Referenzen zurück auf Originalpixel ab, einschließlich TPS.
`--request` akzeptiert die Vorschauoptionen von `inspect`. Nicht abbildbare
Abschnitte werden getrennt und nicht irreführend verbunden.

## Genauigkeit prüfen und reproduzieren

`transform` erwartet `{"pixels":[[100,100]]}`. `evaluate` erwartet Punkte wie
`fit` und liefert RMS, Mittelwert, Maximum und Einzelabweichungen in Metern.
Gespeicherte Projekte werden rekonstruiert, nicht neu angepasst.

```powershell
node scripts/headless.mjs compare --project output/inka.json --reference "Karten/Ground truth/inkareich.georeferenzierung.json" --request pruefpunkte.json --out output/vergleich.json
npm.cmd run test:headless
node scripts/benchmark-headless.mjs --out output/headless/benchmark-cv
node scripts/benchmark-headless.mjs --assign --out output/headless/benchmark-assignment
node scripts/benchmark-landmarks.mjs --case benchmarks/holdout/australia-case.json --out output/headless/australia-reproducible
```

`compare` verlangt identische Originalbilder und wertet beide Transformationen
an derselben Prüfliste aus. `atLeastAsGood` vergleicht RMS; die Aussage gilt nur
für unabhängig identifizierte, nicht zur Auswahl oder Anpassung verwendete
Prüfpunkte. Der Gesamtvergleich verlangt alle sechs Karten und für jede einen
RMS höchstens auf Referenzniveau; sonst Exitcode 1.

Die bisherigen Entwicklungsfälle sind per Prüfsumme in
`benchmarks/protocol/headless-development-lock.json` eingefroren. Das Skript
prüft sie vor jedem Lauf. Eine beabsichtigte Datenrevision muss protokolliert
werden. Bestandene Entwicklungskarten sind kein verdeckter KI-Benchmark.

`--assign` führt vor dem Fit die neue gemeinsame Zuordnung auf den unveränderten
Fit-Beobachtungen aus. Pixelpositionen und Zielkoordinaten werden dabei nicht
neu gemessen; die Stufe kann nur inkonsistente Paare verwerfen oder die Abdeckung
als unzureichend kennzeichnen. Bei `needs-review` wird kein neuer Fit erzeugt;
der Gesamtvergleich bleibt fehlgeschlagen. Aufträge, Zuordnungsberichte und
Fit-Eingaben werden für jeden Fall gespeichert. Zusätzliche Ortsalternativen
und Symbolvorschläge kann ein Agent separat über die beschriebenen APIs liefern.

Australien wurde zuerst mit eingefrorenem Algorithmus und Beobachtungen geprüft.
Dieser erste Versuch scheiterte. Das Wiederholungsskript verwendet dieselben
Beobachtungen und bezeichnet veränderte Algorithmen ausdrücklich als weitere
Entwicklung statt als neue verdeckte Validierung. Es liest vor der Anpassung
nur das Raster aus dem Beispielprojekt; die Referenzausrichtung wird erst nach
dem Fit zum Vergleich geladen. Ergebnisse: [headless-progress.md](headless-progress.md).

Koordinatenquellen: [GeoNames](https://download.geonames.org/export/dump/)
(CC BY 4.0), Quellenlinks in den Punktdateien; Grenzen aus
[geoBoundaries](https://www.geoboundaries.org/) mit jeweiliger Lizenz.
Australiens [Extrempunkte](https://www.ga.gov.au/scientific-topics/national-location-information/dimensions/continental-extremities)
und [Grenzecken](https://www.ga.gov.au/scientific-topics/national-location-information/dimensions/border-lengths)
stammen von Geoscience Australia. Downloads unter `output/` sind für die
gespeicherten Punktvergleiche nicht erforderlich.
