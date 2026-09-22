# Kartenpause

Kartenpause legt historische oder thematische Rasterkarten anhand von Referenzpunkten auf eine moderne Basiskarte. Die Anwendung sucht automatisch nach einer passenden Kartenprojektion und richtet die Vorlage aus.

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
- `src/styles.css` enthält das Layout und die Kartendarstellung.
- `tests/` enthält portable End-to-End- und Zoom-Regressionstests.

## Testen und veröffentlichen

```powershell
npm.cmd run test:ui
npm.cmd run build
```

GitHub Actions prüft jeden Push und Pull Request. Pushes auf `main` bauen die Anwendung und veröffentlichen `dist/` über GitHub Pages.

## Datenschutz der Beispieldaten

Lokale `*.georeferenzierung.json`-Dateien können eingebettete, urheberrechtlich geschützte Kartenbilder enthalten. Sie werden durch `.gitignore` nicht in das öffentliche Repository aufgenommen. Die Tests erzeugen ihre Rasterkarte stattdessen vollständig synthetisch.
