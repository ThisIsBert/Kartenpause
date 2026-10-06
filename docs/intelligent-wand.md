# Intelligenter Zauberstab – Prototyp

## Bestand und Integrationsentscheidung

`wand.js` verwaltet die Auswahl und ihre Historie. `selection-worker.js` berechnet auf dem Originalraster eine `Uint8Array`-Maske. `selection.js` enthält den klassischen Lab-Flood-Fill, die Pinseloperationen und die kantenbasierte Polygonisierung mit Lochzuordnung und getrennten Inseln. Der neue Modus ersetzt nur die Erzeugung der Kandidatenmaske. Ersetzen, Hinzufügen, Abziehen, Pinsel, Wiederöffnen vorhandener Geometrien, Verlauf und GeoJSON verwenden weiterhin die bestehenden Pfade.

`magnetic-path.js` sucht per A* zwischen festen Ankern in einem schmalen Korridor. Seine Zweifarbensuche belohnt Kontrast nur zusammen mit passenden Farben beiderseits der Kante. Eine Flächenauswahl hat jedoch weder diese Anker noch eine vorgegebene Außenfarbe. Deshalb übernimmt sie dieses Prinzip, nicht den Pfadsucher. `image-features.js` stellt jetzt die unveränderte klassische Lab-Konversion sowie Farb-/Pixelkontrast und robuste Farbstatistik gemeinsam bereit. Die bisherige RGB-Metrik des magnetischen Werkzeugs bleibt erhalten.

Für Stufe 1 wurde eine begrenzt reduzierte Darstellung mit Blockmedian und kleinem Boxfilter gewählt. Ein reiner Gaußfilter würde Schrift ebenfalls abschwächen, verschiebt aber abhängig vom Radius Grenzfarben. Der kleine Boxfilter ist hier einfach kontrollierbar; sein Saum wird beim Überbrücken berücksichtigt. Ein bilateraler Filter erhält gerade die starken Schriftkanten, die unterdrückt werden sollen, und wäre aufwendiger. Ein globaler Graph Cut oder Random Walker bräuchte zusätzliche Speicherstrukturen bzw. einen Löser. Lokale Randprofile passen besser zum vorhandenen Maskenworkflow und sind im Debugger nachvollziehbar. Es gibt keinen globalen Optimalitätsanspruch.

## Stufe 1

### Weitere Klicks im Modus „hinzufügen“

Der erste intelligente Klick legt eine Farbreferenz fest. Weitere intelligente **Hinzufügen**-Klicks erweitern diese Farbfamilie, statt aus der Umgebung jedes Klicks eine neue dominante Farbe abzuleiten. Die ursprüngliche Referenz bleibt unverändert als Anker erhalten; höchstens sieben zusätzliche, unterschiedliche Farbnuancen werden gespeichert. Die erlaubte Abweichung einer neuen Nuance vom Anker beträgt je nach Empfindlichkeit 12–24 gewichtete Lab-Einheiten. Ein schrittweises Wandern über immer neue Referenzmittelwerte in fremde Farben ist damit ausgeschlossen.

Der genaue angeklickte Originalpixel muss zur bisherigen Farbfamilie passen und darf nicht eindeutig zu einer geschützten Gegenfarbe gehören. Eine kleine Probe mit Radius zwei Originalpixeln berücksichtigt nur kompatible Farben nahe der Klickfarbe. Mindestens drei Proben müssen diese Struktur stützen. Ein unpassender oder isolierter Klick wird mit einer Meldung abgelehnt; der Startpunkt wird dabei nicht in eine benachbarte größere Fläche verschoben.

Diese Ergänzung wächst direkt auf Originalpixeln und verwendet die bisherige Referenz plus die gelernten Nuancen. So kann sie ein bis drei Pixel breite Seitenarme erfassen, die beim ersten Durchlauf in der reduzierten Darstellung fehlen. Die bereits ausgewählte Fläche begrenzt das Wachstum: Ihr Inneres wird nicht erneut durchlaufen. Bisherige Pinselkorrekturen im Inneren werden dadurch nicht beim Hinzufügen eines Seitenarms neu berechnet. Transparenz, geschützte Gegenfarben und die Bestätigung hinter überbrückten Linien bleiben wirksam. Die anschließende Randverfeinerung verwendet denselben Korridor-/Topologieschutz wie die erste Auswahl.

Das Modell ist Teil jedes Auswahl-Snapshots. **Rückgängig/Wiederholen** stellt Maske und Farbmodell gemeinsam wieder her; Fehler übernehmen weder Maske noch gelernte Nuancen. Pinsel und intelligentes **Abziehen** verändern die Farbreferenz nicht. Eine vollständig geleerte Auswahl, Abbruch, Abschluss, Laden vorhandener Geometrie oder eine tatsächlich ausgeführte klassische Farbauswahl entfernt die Referenz. Reines Umschalten des Algorithmus verändert sie nicht. **Auswahl ersetzen** definiert eine neue Referenz. Besteht noch kein Modell, legt auch der erste intelligente Hinzufügen-Klick eines an. Farbreferenzen werden nicht in GeoJSON gespeichert.

`selection-operation.js` hält nur vorbereitete Bildfeatures im Cache; das Farbmodell wird als explizites `referenceModel` mit dem Auftrag übergeben und zurückgeliefert. Deshalb beeinflussen alte Worker-Aufträge oder zurückgenommene Klicks nicht unbemerkt den nächsten Auftrag.

### Erste Auswahl und „Auswahl ersetzen“

Die Originalpixel-Ergänzung verwendet acht Nachbarn, damit auch ein Pixel breite diagonale Verläufe verfolgt werden. Überbrückungsweiten berücksichtigen dabei die diagonale Schrittlänge. Reine Eckkontakte bleiben bei der bestehenden Polygonisierung als getrennte Teilflächen darstellbar. Die folgende grobe Erstauswahl verwendet weiterhin vier Nachbarn.

1. Reduktion auf ungefähr höchstens 450.000 Zellen (aufgerundete Randzellen können geringfügig darüber liegen). Pro Block dienen neun räumlich verteilte RGB-Proben als Median; anschließend folgt ein 3×3-Boxfilter und Lab-Konversion. Bei Originalauflösung entspricht der Blockmedian dem Originalpixel. Transparenz wird separat konservativ erfasst: eine transparente Stelle sperrt die gesamte grobe Zelle.
2. Eine kreisförmige Probe um den Klick liefert einen komponentenweisen Lab-Median, Medianabweichung und einen nach Ausreißerentfernung erneuerten Median. Die Streuung erhöht die Empfindlichkeit höchstens um vier Lab-Einheiten. Bei einem Klick auf Schrift beginnt die Suche am nächsten passend gefärbten Zellzentrum innerhalb der Probe.
3. Vierfach verbundenes Region Growing mit fester robuster Referenz. Knapp außerhalb der Toleranz liegende Zellen benötigen mehrere passende Nachbarn. Überlagerungen dürfen in vier Richtungen übersprungen werden, wenn dahinter mehrere stark passende Zellen folgen. Der übersprungene Streifen wird ebenfalls ausgewählt. Transparenz darf dabei niemals übersprungen werden.
4. Nur kleine, vollständig eingeschlossene Löcher werden gefüllt. Es gibt weder flächige Erosion noch eine pauschale Entfernung kleiner Auswahlkomponenten. Der zusammenhängende Start vermeidet unverbundene Farbsprengsel. Danach wird die Maske auf Originalauflösung gehoben.

### Schutz echter schmaler Flächen und Reliefschatten

Das Fluss-/Reliefbeispiel aus `examples` zeigte eine Schwäche der reinen Überbrückungsbreite: Schmale graue Landzungen zwischen blauen Flussarmen wurden wie aufgedruckte Linien behandelt. Eine bloße Erhöhung der Empfindlichkeit konnte zugleich weitere Gewässerpixel und unerwünschtes Land aufnehmen.

Die vorberechnete Darstellung enthält deshalb zusätzlich unverwischte Blockfarben und bis zu sechs dominante Flächenfarben. Ein Lab-Farbhistogramm liefert Kandidaten; nur Farben mit mindestens 8 % Bildanteil und mindestens 1,5 % räumlich breiten, farblich passenden Kernbereichen gelten als Flächenfarben. Die Suche betrachtet höchstens 64 Histogrammzentren. Lange dünne Linien allein erzeugen so kein Flächenmodell.

Für jeden Klick werden ausreichend unterschiedliche Flächenfarben als Gegenkandidaten zur Zielregion verwendet. Wo eine solche Farbe deutlich besser passt, sind sowohl Überbrückung als auch kleine Lochfüllung gesperrt. Damit bleiben auch schmale Ausläufer und Inseln einer im Bild größeren Landfläche geschützt. Isolierte Farbmarkierungen bis höchstens zwölf Originalpixel Fläche sind davon ausgenommen, damit JPEG-Punkte nicht zu geschützten Löchern werden. Transparenz bleibt unabhängig davon immer gesperrt.

Bei farbigen Zielregionen wird die Lab-Helligkeitsdifferenz mit Faktor 0,55 gewichtet, die beiden Farbkomponenten unverändert. Das toleriert Reliefschatten besser. Achromatische Referenzen verwenden weiterhin die volle Helligkeitsdifferenz. Diese Anpassungen gelten ausschließlich im intelligenten Modus.

## Stufe 2

Die grobe Maske liefert interne Randpunkte und lokal gemittelte Normalen. Für jeden Randpunkt werden mögliche Verschiebungen innerhalb des Korridors geprüft. Auf unveränderten Originalpixeln bilden fünf tangential verteilte Lab-Proben robuste Seitenfarben. Proben in zwei Außentiefen prüfen die Persistenz des Farbwechsels. Die Kosten berücksichtigen Innenpassung, Außenabweichung, Farbkontrast direkt an der Kante, die Balance der Übergangsfarben und einen kleinen Abstandspreis. Ein Gradient bekommt nur bei unterschiedlichen, persistenten Grundfarben Gewicht. Kurze Normalprofile werden wiederverwendet, statt das ganze Originalbild in Lab zu cachen.

Benachbarte Verschiebungen mit ähnlicher Normalenrichtung werden moderat per Median stabilisiert. Ein begrenzter Manhattan-Abstandsbereich überträgt sie zurück in die Maske. Außerhalb dieses Korridors sind Änderungen ausgeschlossen. Ohne passende Kantenbelege bleibt die grobe Grenze stehen. Ein lokaler digitaler Topologietest erlaubt nur Pixeländerungen, die weder eine Landbrücke trennen noch Auswahlkomponenten vereinigen oder ein Loch schließen/erzeugen. Dieser Schutz betrifft die Verfeinerung; die bewussten Überbrückungen und kleinen Lochfüllungen finden zuvor in Stufe 1 statt.

Im Korridor ergänzen eindeutige Originalpixelfarben den Normalenansatz: Passt ein Pixel mit mindestens zwei unterstützenden Nachbarn klar besser zur Ziel- oder Gegenfarbe, erhält diese Klassifikation Vorrang. Kleine Uferbiegungen und Seitenarme müssen damit nicht allein aus verschobenen Normalen rekonstruiert werden. Unerklärte Farben, insbesondere Schrift und Linien, bleiben bei der geometrischen Randentscheidung. Auch diese Korrekturen unterliegen dem Topologieschutz.

## Parameter und Laufzeit

Alle Größen werden zentral durch `intelligentSettings()` festgelegt und können bei `prepareIntelligent(raster, overrides)` überschrieben werden:

| Parameter | Standard in Originalpixeln |
| --- | --- |
| lokale Probe | Radius 9–18 |
| Überbrückungsbreite | 12–24, zuzüglich Filter-Saum in der reduzierten Darstellung |
| bestätigende Strecke dahinter | 4–8, mindestens zwei grobe Zellen |
| Randkorridor | ±7–14 |
| maximale kleine Lochfläche | 64–256 Pixel² |

Die automatische Skalierung steigt zwischen 1.800 und 3.600 Pixeln längster Bildkante von Faktor 1 auf 2. Die Oberfläche zeigt zunächst nur die Empfindlichkeit. Der intelligente Modus ist immer zusammenhängend; die klassische Zusammenhängigkeitsoption wird beim Umschalten verborgen, ihr Wert bleibt erhalten.

Die reduzierte Darstellung wird im bestehenden Auswahl-Worker beim ersten intelligenten Klick vorbereitet und für weitere Klicks wiederverwendet. Der bisherige Worker-Lebenszyklus bleibt erhalten: Abbruch, Abschluss oder Werkzeugwechsel können diesen Cache freigeben. Abbrechen beendet auch laufende Berechnungen. Es gibt keine Berechnung pro UI-Frame. Die Hauptoberfläche bleibt während der synchronen Worker-Berechnung bedienbar.

Die Anwendung behält ihre Obergrenze von 25 Millionen Originalpixeln. Zusätzliche Vollbilddaten der Verfeinerung sind Masken, ein 4-Byte-Randzuordnungsfeld und ein 1-Byte-Abstandsfeld; die Warteschlange wächst in Blöcken nur für den Korridor. Sehr zerklüftete Masken benötigen entsprechend mehr Zeit und Speicher. Ein großer erster Klick kann mehrere Sekunden dauern; kleine synthetische Beispiele sind kein Beleg für die Geschwindigkeit auf komplexen historischen Scans.

Das zusätzliche Flächenmodell wird ebenfalls pro Worker/Bild vorbereitet und bei weiteren Klicks wiederverwendet. Bei der ersten Auswahl werden Originalpixel für die Randverfeinerung nur im Korridor ausgewertet. Beim Hinzufügen werden zusätzlich die erreichten Originalpixel des fehlenden Bereichs und kurze Überbrückungsproben ausgewertet, nicht nochmals alle Pixel der vorhandenen Auswahl. Die zweite vorberechnete Feature-Darstellung liegt ausschließlich auf der begrenzten groben Auflösung vor.

## Debugansichten

In der Browserkonsole vor dem nächsten intelligenten Klick aktivieren:

```js
window.kartenpauseWandDebugEnabled = true;
```

Nach der Berechnung:

```js
await window.kartenpauseShowWandDebug();
```

Der schließbare Dialog zeigt vereinfachtes Bild, grobe Maske, orange markierten Randkorridor und endgültige Kandidatenmaske. Die Anzeige wird auf höchstens 800×600 Pixel je Ansicht reduziert; Originaldaten bleiben unter `window.kartenpauseWandDebug` verfügbar. `corridor[i] === 255` bezeichnet einen Pixel außerhalb des Korridors. Die anderen Werte sind Abstände zum groben Rand. `reference`, `settings` und `scale` erlauben die Inspektion der Parameter. Die endgültige Debugmaske ist das Ergebnis des letzten intelligenten Klicks vor Hinzufügen/Abziehen und späteren Pinselkorrekturen. Bei Abbruch/Abschluss werden die Debugdaten freigegeben. Mit `window.kartenpauseWandDebugEnabled = false` werden für folgende Klicks keine neuen Debugdaten übertragen.

## Prüfungen und Grenzen

Regressionen für das Farbgedächtnis prüfen 1-, 2- und 3-Pixel-Seitenarme trotz reduzierter Darstellung, leicht abweichende Farben, nicht übernommenes Land/Rot, transparente und isolierte Klicks, erhaltene Pinselkorrekturen, unveränderliche Referenzen, Verlauf und Neustart nach Leeren/Ersetzen. Ein zweiter Klick auf einen im ersten Durchlauf fehlenden Seitenarm des echten Flusskartenausschnitts erfasst zusätzlich mehrere Hundert Pixel, ohne die eindeutig grauen Innenpixel zu übernehmen. Der Browser prüft diese Modellzustände auch nach tatsächlichem Rückgängig/Wiederholen und nach einem abgelehnten Klick.

Im Debugobjekt zeigt `continued`, ob die Originalpixel-Ergänzung mit gespeicherter Referenz verwendet wurde; `reference.variants` enthält deren gelernte Nuancen. `coarse` bezeichnet dabei allgemein die Kandidatenmaske vor der Randkorrektur, bei einer Ergänzung also bereits die auf Originalpixeln gewachsene Region.

Zum Vergleich mit der verbesserten Fassung die Seite neu laden und mit **Auswahl ersetzen** neu auswählen. Bereits hinzugefügte Fehlbereiche verschwinden bei **hinzufügen** nicht. Für die Flusskarte zunächst Empfindlichkeit 12 ausprobieren, anschließend bei fehlenden blauen Bereichen schrittweise erhöhen. Die erkannten Gegenfarben sind auch als `rivals` in den Debugdaten verfügbar.

Weitere Regressionen prüfen schmale echte Inseln/Halbinseln, seltene Überlagerungen trotz geschützter Gegenfarbe, einzelne Scanpunkte und Helligkeitsverläufe innerhalb einer farbigen Fläche. `tests/fixtures/river-relief.json` enthält einen 384×192-Pixel-Ausschnitt der bereitgestellten Originalkarte als verlustfrei komprimierte RGBA-Testdaten; das ursprüngliche JPEG wird für den Test nicht benötigt. Auf diesem Ausschnitt werden bei Empfindlichkeit 5, 12 und 18 eindeutig blaue bzw. neutrale Innenpixel geprüft. Übergangs-/JPEG-Mischpixel sind bewusst nicht als exakte Referenzkontur gelabelt. Die Prüfung ist eine Regression für dieses Beispiel und keine umfassende Genauigkeitsmessung.

```powershell
npm.cmd run test:trace
npm.cmd run test:wand
npm.cmd run test:ui
npm.cmd run build
```

`tests/intelligent-selection.unit.mjs` erzeugt deterministische Raster für alle acht gewünschten Szenarien, mehrere Flussbreiten/Reduktionsstufen, Transparenz, Cache-Wiederverwendung, unveränderte Originaldaten, Korridorbindung, Loch-/Insel-Roundtrips und eine schmale Landbrücke. Der Browserworkflow prüft Worker, Moduswechsel, Debugdialog, Hinzufügen/Abziehen, Verlauf, beide Pinsel und MultiPolygon-Export. Die klassischen Tests bleiben bestehen.

Der Prototyp erkennt kartografische Grundfarben, keine semantischen Gebietsidentitäten. Ein kleines andersfarbiges Gebiet unterhalb der Überbrückungsbreite kann wie Schrift behandelt werden; dichte breite Schraffur kann umgekehrt als Fläche erscheinen. Gleichfarbige Nachbargebiete mit nur einer dünnen Trennlinie werden möglicherweise vereinigt. Extreme Unschärfe, eine mehrheitlich verdeckte Klickprobe sowie Details unterhalb der groben Rasterauflösung bleiben schwierig. Stufe 2 kann eine in Stufe 1 falsche Gebietsentscheidung bewusst nicht außerhalb des Korridors korrigieren. Eine visuelle Bewertung auf repräsentativen historischen Karten ist daher weiterhin nötig.
