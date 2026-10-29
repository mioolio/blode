# Blode Studio

English | [简体中文](../README.md)

Blode Studio is a modular desktop workbench for microcontroller development. It chains chip detection, resource allocation, build-boundary checks, flash confirmation and read-back verification into one verifiable workflow, covering everything from opening a project to running firmware. Built on Electron, React, TypeScript and the Monaco editor; the UI, browser workbench and AI integration share the same project validation and build records.

> A real hardware verification: an STM32F103C8T6 rated at 64 KiB reported 128 KiB of Flash, and a 75,888-byte firmware image passed read-back verification after being written. See the [feature showcase and real hardware case](../SHOWCASE.md).

## Highlights

- **Automatic chip detection**: one click after selecting a serial port; the matching registered platform is selected and configured automatically. On failure, a dialog offers manual selection and log export.
- **Visual Flash layout**: allocate app, data and system partitions graphically with wheel zooming, custom names and colors, and overlap detection; manually correct chips that misreport capacity.
- **Build-boundary checks**: usage is measured against the real ELF load ranges and SRAM sections; out-of-bounds firmware raises warnings with a second confirmation before flashing.
- **Multi-platform**: ESP32-S3 (Arduino CLI build, esptool flash) and STM32 (ST-Link detection, Arm Compiler 6 or GNU Arm GCC, including supported Keil `.uvprojx` projects). Compilation works without connected hardware.
- **Modern editor**: syntax highlighting, C/C++ symbol completion (recursive parsing of project headers and macros), split editors, unsaved-draft markers, and tab state preserved across reloads.
- **Project management**: inline create and rename in the file tree, the `be` project descriptor, build caching and artifact fingerprints.
- **Serial monitor**: real-time send and receive once a device is connected, with mutual exclusion against the flash flow.
- **Browser workbench**: draft sync between desktop and web, accessible over LAN with token authentication.
- **AI and automation**: an authenticated JSON-RPC system pipe and MCP bridge expose the same API the UI uses.
- **Theming**: follows the system light/dark preference; UI text ships in Chinese and English.

## New desktop features

- A home screen with recent projects, history removal, and save-and-close back to home.
- Replaceable preview tabs; editing or pressing `Ctrl+S` pins a tab. Horizontal scrolling keeps additional tabs accessible.
- BIN, Intel HEX and S-record export, plus STM32 ELF export. Prebuilt BIN/HEX/S-record files can be flashed without opening a project after checking the connected target and addresses.
- UTF-8/HEX serial communication with custom baud rates, framing, flow control and line endings.
- **View → Hardware simulation** opens a separate STM32/ST-Link debugger window with paused register samples, disassembly, stack, memory reads and local ELF inspection. The CPU diagram is schematic, and running views retain the last paused sample.
- Preferences show download bytes, percentages, installation stages and third-party installer output. Unknown download sizes and non-download stages use an indeterminate indicator.
- Device discovery initializes once; manual refresh and Windows device-change notifications update the cache. The target device panel can be closed and restored through View.

See the [desktop feature guide (Chinese)](NEW-FEATURES.md) for workflows and limits. These additions passed type checking; full desktop, download and hardware validation remain pending.

## Quick start

Requires Node.js 24 or later and npm:

```powershell
npm ci
npm run dev
```

1. Open a project folder or its `be` descriptor file.
2. Set the compile platform and toolchain, then set the build entry in the file tree. Supported STM32 Keil projects can supply the platform information automatically.
3. Save and build offline. Connect and identify the physical target before flashing.

`npm run build` produces the bundles, `npm start` runs an existing build, and `npm run package` creates a portable Windows build. See the [development guide](DEVELOPMENT.md) for environment details.

## Supported hardware

| Platform | Build path                                                             | Flashing       |
| -------- | ---------------------------------------------------------------------- | -------------- |
| ESP32-S3 | Arduino CLI + Arduino-ESP32                                            | esptool (UART) |
| STM32F1  | Arm Compiler 6 / GNU Arm GCC, or verify firmware                       | ST-Link (SWD)  |
| Auto     | Infer compile platform from supported project data, or select manually | —              |

Platform details and hardware limits: [ESP32-S3](../extensions/boards/esp32-s3/README.md) · [STM32](STM32.md) · [Flashing notes](../extensions/boards/stm32/README.md)

## The `be` project descriptor

The `be` file at a project root is a JSON descriptor holding the project configuration, partition layout and build entry. Reading it restores the full project context; legacy `.blode/project.json` projects remain compatible. Format details are in the [architecture guide](ARCHITECTURE.md).

## Documentation

| Document                                          | Contents                                    |
| ------------------------------------------------- | ------------------------------------------- |
| [Showcase and real hardware case](../SHOWCASE.md) | On-device detection, flashing and read-back |
| [STM32 guide](STM32.md)                           | Connection, build and firmware limits       |
| [Toolchains](TOOLCHAINS.md)                       | Tool directories and offline setup          |
| [AI pipe](AI-PIPE.md)                             | JSON-RPC and MCP integration                |
| [Development guide](DEVELOPMENT.md)               | Builds, scripts and environment variables   |
| [Architecture](ARCHITECTURE.md)                   | Module layout and extension contracts       |
| [Extension conventions](../extensions/README.md)  | Platform package structure and registration |
| [Hardware validation](HARDWARE-VALIDATION.md)     | Historical verification data                |

## Contributing

Contributions are welcome at the [project repository](https://github.com/mioolio/blode): platform packages, editor improvements and documentation fixes. A new platform should ship with its README, contract and boundary tests, and state its hardware validation scope. Source files stay under 1000 lines each, and UI and protocol text is maintained in both Chinese and English.

Dependencies, build artifacts, `tools/`, `.tools/`, project caches and local credentials are never committed. The project is licensed under Apache License 2.0; see [LICENSE](../LICENSE).
