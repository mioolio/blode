# Blode Studio

English | [简体中文](../README.md)

Blode Studio is a modular desktop workbench for microcontroller development. It chains chip detection, resource allocation, build-boundary checks, flash confirmation and read-back verification into one verifiable workflow, covering everything from opening a project to running firmware. Built on Electron, React, TypeScript and the Monaco editor; the UI, browser workbench and AI integration share the same project validation and build records.

> A real hardware verification: an STM32F103C8T6 rated at 64 KiB reported 128 KiB of Flash, and a 75,888-byte firmware image passed read-back verification after being written. See the [feature showcase and real hardware case](../SHOWCASE.md).

## Highlights

- **Automatic chip detection**: one click after selecting a serial port; the matching registered platform is selected and configured automatically. On failure, a dialog offers manual selection and log export.
- **Visual Flash layout**: allocate app, data and system partitions graphically with wheel zooming, custom names and colors, and overlap detection; manually correct chips that misreport capacity.
- **Build-boundary checks**: usage is measured against the real ELF load ranges and SRAM sections; out-of-bounds firmware raises warnings with a second confirmation before flashing.
- **Multi-platform**: ESP32-S3 (Arduino CLI build, esptool flash) and STM32 (ST-Link detection, Arm Compiler 6 build, including direct compilation of Keil `.uvprojx` projects).
- **Modern editor**: syntax highlighting, C/C++ symbol completion (recursive parsing of project headers and macros), split editors, unsaved-draft markers, and tab state preserved across reloads.
- **Project management**: inline create and rename in the file tree, the `be` project descriptor, build caching and artifact fingerprints.
- **Serial monitor**: real-time send and receive once a device is connected, with mutual exclusion against the flash flow.
- **Browser workbench**: draft sync between desktop and web, accessible over LAN with token authentication.
- **AI and automation**: an authenticated JSON-RPC system pipe and MCP bridge expose the same API the UI uses.
- **Theming**: follows the system light/dark preference; UI text ships in Chinese and English.

## Quick start

Requires Node.js 24 or later and npm:

```powershell
npm ci
npm run dev
```

1. Open a project folder or its `be` descriptor file.
2. Select a candidate device and identify the chip, or pick a platform explicitly in Preferences and set up its toolchain.
3. Save sources, run the build, confirm the target and flash.

`npm run build` produces the bundles, `npm start` runs an existing build, and `npm run package` creates a portable Windows build. See the [development guide](DEVELOPMENT.md) for environment details.

## Supported hardware

| Platform  | Build path                                    | Flashing        |
| --------- | --------------------------------------------- | --------------- |
| ESP32-S3  | Arduino CLI + Arduino-ESP32                   | esptool (UART)  |
| STM32F1   | Arm Compiler 6, or verify prebuilt firmware   | ST-Link (SWD)   |
| Auto      | No build or flash until a platform is matched | —               |

Platform details and hardware limits: [ESP32-S3](../extensions/boards/esp32-s3/README.md) · [STM32](STM32.md) · [Flashing notes](../extensions/boards/stm32/README.md)

## The `be` project descriptor

The `be` file at a project root is a JSON descriptor holding the project configuration, partition layout and build entry. Reading it restores the full project context; legacy `.blode/project.json` projects remain compatible. Format details are in the [architecture guide](ARCHITECTURE.md).

## Documentation

| Document                                                      | Contents                                     |
| ------------------------------------------------------------- | -------------------------------------------- |
| [Showcase and real hardware case](../SHOWCASE.md)             | On-device detection, flashing and read-back  |
| [STM32 guide](STM32.md)                                       | Connection, build and firmware limits        |
| [Toolchains](TOOLCHAINS.md)                                   | Tool directories and offline setup           |
| [AI pipe](AI-PIPE.md)                                         | JSON-RPC and MCP integration                 |
| [Development guide](DEVELOPMENT.md)                           | Builds, scripts and environment variables    |
| [Architecture](ARCHITECTURE.md)                               | Module layout and extension contracts        |
| [Extension conventions](../extensions/README.md)              | Platform package structure and registration  |
| [Hardware validation](HARDWARE-VALIDATION.md)                 | Historical verification data                 |

## Contributing

Contributions are welcome at the [project repository](https://github.com/mioolio/blode): platform packages, editor improvements and documentation fixes. A new platform should ship with its README, contract and boundary tests, and state its hardware validation scope. Source files stay under 1000 lines each, and UI and protocol text is maintained in both Chinese and English.

Dependencies, build artifacts, `tools/`, `.tools/`, project caches and local credentials are never committed. The project is licensed under Apache License 2.0; see [LICENSE](../LICENSE).
