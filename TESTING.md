# Tests

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
- automatische Auswahl aus allen festen Projektionskandidaten
- gezeichnete Bildüberlagerung nach erfolgreicher Anpassung
- stabiles Zoomen des Originalbilds ohne seitliches Springen
- JavaScript-Seitenfehler

Der Prüfscreenshot wird unter `output/playwright/workflow-smoke.png` gespeichert. Bei Fehlern landen Screenshot und Trace unter `output/playwright/test-results/`.

## Sichtbarer Browserlauf

```powershell
npm.cmd run test:ui:headed
```
