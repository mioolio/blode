# Blode Studio

[简体中文](../README.md) · [繁體中文](README.zh-TW.md) · [English](README.en.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · **Deutsch** · [Français](README.fr.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Italiano](README.it.md) · [Русский](README.ru.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md)

Blode Studio ist eine modulare Entwicklungsumgebung für eingebettete Systeme: Quelltext bearbeiten, Firmware kompilieren und flashen, serielle Kommunikation, Hardware-Debugging, Git und Zusammenarbeit im Team. Die Oberfläche läuft als Electron-Desktopanwendung oder im Browser; der Node.js-Host arbeitet auf dem Rechner mit den Projekten und Geräten.

[GitHub Releases](https://github.com/mioolio/blode/releases) · [CHANGELOG](../CHANGELOG.md) · [Issues](https://github.com/mioolio/blode/issues)

## Verfügbare Funktionen

- C/C++-Vervollständigung, Definitionen, Referenzen, Diagnosen und Formatierung mit clangd; alternativ ein Arbeitsbereichsindex. Vorschau-Tabs, geteilte Ansichten und Entwurfswiederherstellung.
- Kompilieren ohne angeschlossenes Gerät: benannte Build-Einstiegspunkte, Debug/Release, Größenoptimierung und getrennte Toolchain-Auswahl für C und C++.
- Firmware als BIN, HEX, S-record und ELF exportieren, vorbereitete Firmware flashen und Projekte mit externen Quelltextabhängigkeiten teilen.
- Arduino-Bibliotheken durchsuchen, Komponentenordner oder ZIPs importieren sowie Gerätemodule und Toolchains für den Offlineeinsatz exportieren.
- Register, Disassemblierung, Aufrufstapel und Speicher untersuchen; Einzelschritte und mehrere Haltepunkte am angeschlossenen Ziel verwenden.
- Tabs, Bearbeitungsbereiche und aktuelle Protokolle teilen; unabhängige Änderungen zusammenführen und Konflikte erhalten. Rückgängig im Browser betrifft die eigenen Änderungen.
- Git-Verlauf, Unterschiede, Staging, Commits, Branches und Remotes grafisch verwalten; mehrere native Terminals und VS Code anbinden.
- Bilder, Audio und Video anzeigen; optionale KI-Vervollständigung und auf definierte Bereiche begrenzte KI-Bearbeitung. Module und Erweiterungen besitzen eigene Ressourcen und Sprachkataloge.

## Distribution auswählen

| Ausgabe                   | Laufzeitumgebung               | Datei                                       |
| ------------------------- | ------------------------------ | ------------------------------------------- |
| Desktop portabel          | Windows x64; direkt starten    | `Blode.Studio-0.3.5.9-desktop-win-x64.exe`  |
| Eigenständige Web-Ausgabe | Windows x64; Node.js enthalten | `Blode.Studio-0.3.5.9-web-win-x64.exe`      |
| Web mit Node.js           | Windows x64; Node.js 24+ x64   | `Blode.Studio-0.3.5.9-web-node-win-x64.zip` |

Alle Ausgaben verwenden dasselbe Projektformat und dieselben Hostdienste. Das Node.js-ZIP entpacken und `start-web.cmd` starten; die Abhängigkeiten sind enthalten. Der Quelltext auf `main` kann neuer als die Downloads sein. Maßgeblich für Pakete sind die Versionshinweise.

[0.3.5.9](releases/0.3.5.9.md) · [SHA-256 / OBE](PACKAGE-SIGNING.md)

## Hardware und Hostsysteme

| Gerätemodul                      | Build-Werkzeuge                  | Geräteanschluss     |
| -------------------------------- | -------------------------------- | ------------------- |
| Esp32_S3_CAM · ESP32-S3          | Arduino CLI + Arduino-ESP32      | UART / USB-JTAG     |
| STM32F103C8T6 · STM32F103C8/C8T6 | GNU Arm GCC / Arm Compiler 5 / 6 | ST-Link / SWD / GDB |

Die aktuellen Profile decken ESP32-S3 und STM32F103C8/C8T6 ab. Kamerapins werden im Projekt konfiguriert. ESP32-S3 UART GDB wurde mit einem Windows-Referenzaufbau geprüft; die Validierung von nativem USB-JTAG läuft weiter. Windows x64 ist die Hauptdistribution. Linux x64/ARM64 und benutzerdefinierte macOS-Werkzeugpfade sind noch nicht vollständig auf realen Systemen validiert.

## Schnellstart

Für die Entwicklung aus dem Quelltext werden Node.js 24+, npm und Git benötigt.

```sh
git clone --single-branch https://github.com/mioolio/blode.git
cd blode
npm ci
npm run dev
```

Für die Browseroberfläche die folgenden Befehle auf dem Rechner mit Projekt und Hardware ausführen. Den ausgegebenen Link öffnen. Ordnerauswahl, Kompilierung, USB, serielle Schnittstellen und Terminals werden auf diesem Host ausgeführt.

```sh
npm run web:build
npm run web:start
```

## Module und binäre Hosts

Gerätemodule trennen zehn Verantwortlichkeiten: `support`, `device`, `runtime`, `constraints`, `ui`, `compiler`, `debugger`, `layout`, `languages` und `tools`. `be` speichert die Build-Eingaben, `blode.components.json` die Projektbibliotheken. `package:runtime` erzeugt eigenständiges JavaScript, Manifeste und Ressourcen. Kompatible Desktop-Binärdateien und Web-Hosts laden diese Pakete ohne den TypeScript-Quelltext des Hosts. Allgemeine Erweiterungen können Darstellung, Menüs, Fenster und untere Panels ergänzen, ohne einen Compiler bereitzustellen.

```sh
npm run package:runtime -- extensions/boards/Esp32_S3_CAM --output ./release/modules --zip
```

## Paketsignaturen

- `obe` ist ein mit Ed25519 signiertes JSON-Manifest. Es bindet Herausgeber, Paket-ID und Version sowie Pfad, Größe und SHA-256 jeder Datei. Vor der Installation wird der tatsächliche Inhalt erneut geprüft.
- Offizielles Vertrauen stammt aus dem öffentlichen Schlüsselregister des Hosts. Fehlende oder unbekannte Signaturen, beschädigte Signaturen und geänderte Inhalte werden unterschieden. Ein Export erhält die vorhandene Signatur, verleiht fremden Paketen aber keine offizielle Identität.
- Private Signaturschlüssel bleiben in `.signing/`, außerhalb von Git und Distributionspaketen. Windows Authenticode ist eine eigene Ebene; das aktuelle Zertifikat ist selbstsigniert und kein öffentliches CA-Zertifikat. Geänderte signierte Inhalte müssen neu signiert werden.

[OBE / Authenticode](PACKAGE-SIGNING.md) · [Module und binäre Hosts](ENGINEERING.md)

## Laufende Arbeiten

- Weitere Hardware, lange Zusammenarbeitssitzungen und Projektmigration zwischen Rechnern.
- Qualität der KI-Vorschläge, Eingabemethoden und sprachübergreifende Terminologie.
- Installation, Toolchains und USB unter Linux/macOS auf realen Rechnern prüfen.

## Dokumentation

- [Module und binäre Hosts](ENGINEERING.md) · [Runtime plugins](RUNTIME-PLUGINS.md) · [General extensions](GENERAL-EXTENSIONS.md)
- [Projects](PROJECTS.md) · [Component libraries](COMPONENT-LIBRARIES.md) · [Offline delivery](OFFLINE-DELIVERY.md)
- [Paketsignaturen](PACKAGE-SIGNING.md) · [Build / Release](RELEASING.md) · [Localization](LOCALIZATION.md)
- [Hardware debugging](HARDWARE-DEBUGGING.md) · [Platforms](PLATFORM-SUPPORT.md) · [Roadmap](ROADMAP.md)
- [Contributing](../CONTRIBUTING.md) · [Security](../SECURITY.md)

## Lizenz und Beiträge

Der Quelltext steht unter Apache License 2.0. Für Compiler, Treiber und Dienste anderer Anbieter gelten deren Bedingungen. Fehlerberichte und Verbesserungsvorschläge sind über GitHub Issues und Pull Requests willkommen.

[Apache License 2.0](../LICENSE) · [Third-party notices](THIRD-PARTY-NOTICES.md)
