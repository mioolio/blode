# Blode Studio

[简体中文](../README.md) · [繁體中文](README.zh-TW.md) · [English](README.en.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · **Italiano** · [Русский](README.ru.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md)

Blode Studio è un ambiente modulare per lo sviluppo embedded: modifica del codice, compilazione e programmazione del firmware, comunicazione seriale, debug hardware, Git e collaborazione. È disponibile come applicazione Electron o tramite browser, con un host Node.js sul computer che contiene progetti e dispositivi.

[GitHub Releases](https://github.com/mioolio/blode/releases) · [CHANGELOG](../CHANGELOG.md) · [Issues](https://github.com/mioolio/blode/issues)

## Funzionalità disponibili

- Completamento C/C++, definizioni, riferimenti, diagnostica e formattazione con clangd, con indice dell’area di lavoro come alternativa; schede di anteprima, viste divise e recupero delle bozze.
- Compilazione senza dispositivo collegato: punti di ingresso nominati, Debug/Release, ottimizzazione delle dimensioni e strumenti distinti per C e C++.
- Esportazione BIN, HEX, S-record ed ELF, programmazione di firmware preparato e condivisione dei progetti con le dipendenze sorgenti esterne.
- Ricerca di librerie Arduino, importazione di cartelle o ZIP di componenti ed esportazione di moduli e toolchain per l’uso offline.
- Registri, disassemblato, stack e memoria; esecuzione passo passo e aggiunta di breakpoint in gruppo.
- Schede, aree di modifica e log recenti condivisi; unione delle modifiche indipendenti e conservazione dei conflitti. Nel browser, Annulla riguarda le proprie modifiche.
- Gestione grafica di cronologia Git, differenze, staging, commit, rami e remoti; più terminali nativi e collegamento a VS Code.
- Anteprima immagini e riproduzione audio/video; completamento IA facoltativo e modifiche limitate all’ambito scelto. Moduli ed estensioni gestiscono risorse e lingue proprie.

## Scegliere una distribuzione

| Edizione          | Ambiente                     | File                                        |
| ----------------- | ---------------------------- | ------------------------------------------- |
| Desktop portatile | Windows x64; avvio diretto   | `Blode.Studio-0.3.5.9-desktop-win-x64.exe`  |
| Web autonomo      | Windows x64; Node.js incluso | `Blode.Studio-0.3.5.9-web-win-x64.exe`      |
| Web con Node.js   | Windows x64; Node.js 24+ x64 | `Blode.Studio-0.3.5.9-web-node-win-x64.zip` |

Le tre edizioni condividono formato dei progetti e servizi. Estrarre lo ZIP Node.js e avviare `start-web.cmd`; le dipendenze sono incluse. Il codice di `main` può essere più recente dei pacchetti: consultare le note della versione scaricata.

[0.3.5.9](releases/0.3.5.9.md) · [SHA-256 / OBE](PACKAGE-SIGNING.md)

## Hardware e sistemi host

| Modulo dispositivo               | Compilazione                     | Collegamento        |
| -------------------------------- | -------------------------------- | ------------------- |
| Esp32_S3_CAM · ESP32-S3          | Arduino CLI + Arduino-ESP32      | UART / USB-JTAG     |
| STM32F103C8T6 · STM32F103C8/C8T6 | GNU Arm GCC / Arm Compiler 5 / 6 | ST-Link / SWD / GDB |

I profili attuali coprono ESP32-S3 e STM32F103C8/C8T6. I pin della fotocamera sono configurati dal progetto. UART GDB su ESP32-S3 è stato provato su una configurazione Windows di riferimento; continua la verifica di USB-JTAG nativo. Windows x64 è la distribuzione principale. Gli adattamenti Linux x64/ARM64 e i percorsi personalizzati macOS non hanno ancora completato la validazione su macchine reali.

## Avvio rapido

Per lo sviluppo dai sorgenti servono Node.js 24+, npm e Git.

```sh
git clone --single-branch https://github.com/mioolio/blode.git
cd blode
npm ci
npm run dev
```

Per usare il browser, eseguire questi comandi sul computer con progetto e hardware e aprire il collegamento visualizzato. Cartelle, compilazione, USB, porte seriali e terminali appartengono a quel computer host.

```sh
npm run web:build
npm run web:start
```

## Moduli e host binari

I moduli separano dieci responsabilità: `support`, `device`, `runtime`, `constraints`, `ui`, `compiler`, `debugger`, `layout`, `languages` e `tools`. `be` registra gli input di compilazione; `blode.components.json`, le librerie. `package:runtime` produce JavaScript, manifesti e risorse autonomi, caricabili da host binari o Web compatibili senza i sorgenti TypeScript dell’applicazione. Le estensioni generali possono aggiungere aspetto, menu, finestre e pannelli senza implementare un compilatore.

```sh
npm run package:runtime -- extensions/boards/Esp32_S3_CAM --output ./release/modules --zip
```

## Firme dei pacchetti

- `obe` è un manifesto JSON firmato con Ed25519: identifica editore, ID/versione e percorso, dimensione e SHA-256 di ogni file. Il contenuto effettivo viene ricontrollato prima dell’installazione.
- L’identità ufficiale dipende dal registro di chiavi pubbliche dell’host. Firme mancanti o sconosciute, firme danneggiate e contenuti modificati sono distinti. L’esportazione conserva la firma senza attribuire identità ufficiale ai pacchetti di terzi.
- Le chiavi private rimangono in `.signing/`, fuori da Git e dalle distribuzioni. Windows Authenticode è un livello separato; il certificato attuale è autofirmato, non emesso da una CA pubblica. I contenuti modificati richiedono una nuova firma.

[OBE / Authenticode](PACKAGE-SIGNING.md) · [Moduli e host binari](ENGINEERING.md)

## Lavori in corso

- Più hardware, collaborazione prolungata e migrazione dei progetti fra computer.
- Qualità dei suggerimenti IA, metodi di input e revisione della terminologia multilingue.
- Validazione reale di installazione, toolchain e USB su Linux/macOS.

## Documentazione

- [Moduli e host binari](ENGINEERING.md) · [Runtime plugins](RUNTIME-PLUGINS.md) · [General extensions](GENERAL-EXTENSIONS.md)
- [Projects](PROJECTS.md) · [Component libraries](COMPONENT-LIBRARIES.md) · [Offline delivery](OFFLINE-DELIVERY.md)
- [Firme dei pacchetti](PACKAGE-SIGNING.md) · [Build / Release](RELEASING.md) · [Localization](LOCALIZATION.md)
- [Hardware debugging](HARDWARE-DEBUGGING.md) · [Platforms](PLATFORM-SUPPORT.md) · [Roadmap](ROADMAP.md)
- [Contributing](../CONTRIBUTING.md) · [Security](../SECURITY.md)

## Licenza e contributi

I sorgenti sono pubblicati con Apache License 2.0. Compilatori, driver e servizi esterni mantengono le proprie condizioni. Problemi e contributi possono essere inviati tramite GitHub Issues e Pull Requests.

[Apache License 2.0](../LICENSE) · [Third-party notices](THIRD-PARTY-NOTICES.md)
