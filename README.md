# Kartenpause

Kartenpause legt historische oder thematische Rasterkarten anhand von Referenzpunkten auf eine moderne Basiskarte. Eine gemeinsame Automatik sucht nach einer passenden Kartenprojektion, optimiert bei Bedarf deren Parameter und ergänzt bei hartnäckigen lokalen Verzerrungen eine Thin-Plate-Spline-Korrektur (TPS).

## Lokal starten

Voraussetzung ist Node.js 24 oder neuer.

```powershell
npm.cmd install
npm.cmd run dev
```

Vite zeigt anschließend die lokale Adresse an. Ein Produktions-Build entsteht mit `npm.cmd run build` im Verzeichnis `dist/`.

## Struktur

- `index.html` enthält die semantische Oberfläche.
- `src/main.js` verbindet Oberfläche, Karten und Projektdateien.
- `src/geo/geo-fit.js` bewertet die Anpassung fester Projektionen.
- `src/geo/projection-search.js` optimiert freie Projektionsparameter.
- `src/geo/thin-plate-spline.js` korrigiert lokale Restabweichungen auf Grundlage des besten Projektionsmodells.
- `src/styles.css` enthält das Layout und die Kartendarstellung.
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

## Datenschutz der Beispieldaten

Lokale `*.georeferenzierung.json`-Dateien können eingebettete, urheberrechtlich geschützte Kartenbilder enthalten. Sie werden durch `.gitignore` nicht in das öffentliche Repository aufgenommen. Die Tests erzeugen ihre Rasterkarte stattdessen vollständig synthetisch.
