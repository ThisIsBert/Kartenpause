# UI-Test

## Einmalige Installation

```powershell
npm.cmd install
```

`npm.cmd` wird bewusst statt `npm` verwendet, weil PowerShell auf diesem Rechner die Datei `npm.ps1` durch die Ausführungsrichtlinie blockiert.

## Headless-Test

```powershell
npm.cmd run test:ui
```

Der Test verwendet den lokal installierten Microsoft Edge. Er startet seinen eigenen Server, lädt die benötigten CDN-Bibliotheken reproduzierbar aus `node_modules` und beendet den Server anschließend wieder.

Geprüft werden unter anderem:

- Entfernung der alten manuellen Projektionssteuerung
- unsichtbare Bildüberlagerung vor einer Anpassung
- Laden eines vorhandenen Projekts
- nummerierte Fadenkreuz-Markierungen einschließlich Farbkontrast
- automatische Auswahl aus allen festen Projektionskandidaten
- gezeichnete Bildüberlagerung nach erfolgreicher Anpassung
- JavaScript-Seitenfehler

Der Prüfscreenshot wird unter `output/playwright/workflow-smoke.png` gespeichert. Bei Fehlern landen Screenshot und Trace unter `output/playwright/test-results/`.

## Sichtbarer Browserlauf

```powershell
npm.cmd run test:ui:headed
```
