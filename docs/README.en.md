# Blode Studio

English | [简体中文](../README.md)

Blode Studio is a modular embedded development workbench for editing, collaboration, offline builds, firmware export, serial communication and hardware debugging. The current source on `main` includes the specific `Esp32_S3_CAM` and `STM32F103C8T6` runtime profiles.

**Current release: 0.3.5.2** · [Release notes](releases/0.3.5.2.md) · [Changelog](../CHANGELOG.md) · [GitHub Releases](https://github.com/mioolio/blode/releases)

## Internal development preview: runtime plugins

The development preview from `codex/runtime-plugins-internal` has been merged into `main`. It introduces runtime identity migration, API v2 package declarations, execution consent, replaceable compilers, and custom device/debug views. The runtime-plugin preview remains part of `main`; release binaries for this source line are listed below. See the [internal update and acceptance checklist](internal/runtime-plugins.md) for validation status.

The latest internal update adds an interactive PowerShell terminal, extension windows and bottom-panel views, save-on-exit decisions and an optional system tray. Collaboration follows foreground attention and refreshes on return. Hardware debugging, Preferences and device controls share more compact wording and controls. See the [workbench interaction update](internal/workbench-interaction.md) for setup and validation details.

The debugger now groups connection and tool settings in a top menu, offers batch breakpoints, and previews single Cortex-M3 instructions from assembly or hex bytes. SRAM instructions can be patched while stopped, or with an explicit pause/write/verify/resume transaction while running. Flash editing still requires rebuilding and flashing firmware. Normal development-window exits no longer trigger a sandbox restart. See the [debugger update](internal/debugger-editing.md) for usage and verification boundaries.

The latest internal update also adds ESP32-S3 native USB-JTAG debugging with Xtensa GDB and Espressif OpenOCD. Windows tool downloads, hashes and version execution were verified; physical JTAG acceptance and Linux testing remain pending. Xtensa instruction editing is not enabled. See [hardware debugging](HARDWARE-DEBUGGING.md).

Both standard modules now use ten responsibility directories: support, device, runtime, constraints, UI, compiler, debugger, layout, languages and tools. Modules own their language declarations and JSON data. `package:runtime` produces standalone JavaScript packages for compatible binary hosts; users install them under the host data directory's `plugins/<id>/`, without host source code or TypeScript. New manifest fields require a host containing this internal update; this change does not produce a new release binary. See the [module guide](RUNTIME-PLUGINS.md) and [module language contract](MODULE-LANGUAGES.md).

**Run → Component libraries** now separates project dependencies from platform-provided libraries. Search the official Arduino library index, select a version and install its dependencies, or import a folder or ZIP from the host computer. Managed sources live in `libraries/` or `components/`, alongside a portable `blode.components.json` manifest. Removal refuses modified libraries or libraries still required by another component. ESP32 uses Arduino libraries and native components; STM32 native builds accept native C/C++ components, not Arduino framework libraries. See the [component library guide](COMPONENT-LIBRARIES.md).

This update also fixes ESP32-S3 debug connections with an empty USB serial selection and preserves platform compiler flags, including `-c`, when appending project `extra_flags`. Physical USB-JTAG acceptance remains pending; no new release binaries are produced by this source update.

To try the source build:

```sh
git clone --branch main --single-branch https://github.com/mioolio/blode.git
cd blode
npm ci
npm run dev
```

For the standalone Web host, run `npm run web:build`, then `npm run web:start` in the source directory, or use the packaged single-file Web executable. Extension authors should start with the [runtime plugin guide](RUNTIME-PLUGINS.md). Legacy `esp32-s3` and `stm32` project identifiers and compiler pins migrate when loaded.

## Choose an edition

| Edition          | Intended use                                                                  | Requirements                                         | Release artifact                            |
| ---------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------- |
| Desktop portable | Local editing, builds and connected hardware                                  | Windows x64; Electron runtime included               | `Blode.Studio-0.3.5.2-desktop-win-x64.exe`  |
| Standalone Web   | A target computer hosts projects and hardware; users connect through browsers | Windows x64; no Node.js needed; a browser on clients | `Blode.Studio-0.3.5.2-web-win-x64.exe`      |
| Web with Node.js | Smaller ZIP for hosts that already have Node.js                               | Windows x64; Node.js 24+ x64 required                | `Blode.Studio-0.3.5.2-web-node-win-x64.zip` |

All three editions use the same project format and host services. The desktop artifact uses the lightweight packaging mode. The Web executable includes Node.js; the smaller Web ZIP uses Node.js 24+ x64 installed on the host. Both Web editions include native dependencies and require no npm installation. Install compilers through Preferences or select existing custom tool paths. Git operations use Git installed on the host. Web build outputs are placed in `release/0.3.5.2/`.

## What's new in 0.3.5.2

- **Device module library:** search, paginate, load a ZIP or folder, select a module for the current project, and export standalone device modules. Newly loaded modules register immediately.
- **Separate toolchain management:** Preferences distinguishes downloadable versions from tools installed on the host; build settings show the platforms and tools used by the project.
- **Portable toolchain ZIPs:** export and import GNU Arm, Arm Compiler, Arduino CLI, Arduino-ESP32, ST-Link and clangd, including their required dependencies.
- **Fresh exports:** each export rescans source files and regenerates hashes and the manifest. Logs show directories, file counts, sizes, compression progress, archive SHA-256 and duration.
- **Bundled archiving:** Windows x64 builds include 7-Zip 26.05 with its license and matching source, plus the built-in ZIP fallback. Desktop and Web releases both include standalone device modules.

Read the detailed [release notes](releases/0.3.5.2.md) for migration and validation information.

## Core workflows

The editor supports preview and pinned tabs, horizontal scrolling, split views and draft recovery. The home screen lists recent workspaces and supports save-and-close back to home.

Build a selected file or directory without connecting a device. Firmware operations include BIN, Intel HEX and S-record export, STM32 ELF export, Flash layout editing and prepared firmware programming without opening a project. Connect and identify the physical target for programming.

Serial communication supports UTF-8/HEX, configurable framing, flow control and line endings. The debugger opens a separate desktop window or browser tab for STM32/ST-Link or ESP32-S3 USB-JTAG, with registers, disassembly, stack, breakpoints, memory and local ELF inspection.

Portable project ZIP export collects supported external dependencies, rewrites archive-copy paths and includes a dependency manifest. JSON-RPC and MCP expose validated project, Git, build, firmware, debugger, language-index and UI actions.

Component library APIs add explicit search, installation, host-folder/ZIP import and guarded removal. Every mutation requires `expectedProjectRoot` and `confirm: true`. Build inputs are derived by the host from the component manifest; `build.components` is not a `be` configuration field.

## Installation

### Windows desktop portable

1. Place the desktop executable in a writable directory and run it.
2. Open a project folder or its `be` descriptor.
3. Install/select the toolchain in Preferences. Install host Git when using version control.
4. Set the build entry from the file tree or Advanced settings, then choose the build mode and installed tool versions in **Run → Build settings**.
5. Save and compile; connect and identify the target for hardware operations.

The application stores settings, history and managed tools in its OS application-data directory. Projects can remain outside the application folder.

### Standalone Web executable

Run `Blode.Studio-0.3.5.2-web-win-x64.exe` on the computer that owns the projects and hardware. The first start extracts its runtime into the host data directory and opens the private launch link in the default browser; no Node.js or npm installation is required.

```sh
Blode.Studio-0.3.5.2-web-win-x64.exe --no-open --port 47821
```

Open the printed link manually if the browser did not start. File pickers browse the **host computer**, and builds, Git and USB access run there.

For a trusted LAN:

```sh
Blode.Studio-0.3.5.2-web-win-x64.exe --host 0.0.0.0 --port 47821
```

Treat the launch token as a workspace credential. Stop the service with Ctrl+C. See the [Web host guide](WEB-HOST.md).

### From source

Use Node.js 24+, npm and Git for Git workflows and their tests:

```sh
npm ci
npm run dev
```

For the standalone host:

```sh
npm run web:build
npm run web:start
```

Restart after changing main-process, preload or platform code. Renderer development supports hot updates. See [development](DEVELOPMENT.md) for startup diagnostics, permission repair and log paths.

## Language and project configuration

Standard board modules declare their own data under `extensions/boards/<id>/languages/`, with separate C99/C11/C17/C23 catalogs and C++ contributions. Host defaults in `extensions/completions/` remain available for legacy modules without a language declaration. Projects can add selected-standard rules in `languages/C/<standard>/`; workspace symbols and user AI entries remain available.

Right-click `be` → **Advanced settings** to change the build entry, source list and `build.cStandard`. C17 is the default. Compiler support for a selected standard depends on the installed tool version. Legacy `blode.completions.json` and `.blode/project.json` inputs remain compatible.

`be.build.settings` resolves common, platform and C/C++ selections in that order. Inherit follows the parent configuration, auto discovers compatible host tools, and explicit versions use installed tools. Downloads are managed separately in Preferences. A STM32 build uses one compiler family; an ESP32-S3 build uses a consistent Arduino CLI/core environment. See [project and build settings](PROJECTS.md) for mode flags, JSON examples and portable packaging.

JSON structure/version errors produce file and line diagnostics. Source rules can be warnings or build-stopping errors. The current engine provides lexical navigation and declarative checks; the compiler performs full preprocessing and type analysis. See [language rules](LANGUAGE-RULES.md) and [architecture](ARCHITECTURE.md).

## Platforms

| Embedded platform | Build path                                                        | Hardware operations                            |
| ----------------- | ----------------------------------------------------------------- | ---------------------------------------------- |
| Esp32_S3_CAM      | Arduino CLI + Arduino-ESP32                                       | esptool UART flashing and serial communication |
| STM32F103C8T6     | GNU Arm GCC or licensed Arm Compiler 6; supported project imports | ST-Link/SWD flashing and ST-Link/GDB debugging |
| Automatic         | Infer a supported project platform or select it manually          | Identify a connected target                    |

Windows x64 is the current desktop distribution and main development environment. Linux x64/ARM64 Node paths and selected GNU/Arduino downloads are implemented, but **Linux installation, compilation, USB access and desktop packaging have not been verified on real Linux machines**. macOS custom tool paths also remain unverified. See the [support matrix](PLATFORM-SUPPORT.md) and [hardware records](HARDWARE-VALIDATION.md).

The hardware workbench displays connected-target samples. Its CPU diagram combines paused register and instruction data; cycle-accurate chip emulation is outside this release.

## Build and validation

```sh
npm run typecheck
npm test
npm run build
npm run package:desktop
npm run package:web
npm run package:web:node
```

The desktop command aliases the lightweight `package:lite` flow. `package:web` builds one self-contained Web executable from the local Windows x64 Node runtime (payload hash verification, `.sha256` sidecar). The Web build still checks for Electron imports. Automated coverage includes disposable Git repositories, language rules and indexes, collaboration, project ZIPs and HTTP services with fixture hardware boundaries. Physical hardware, cross-machine and sustained-session results are tracked separately.

## Documentation

- [0.3.5.2 release notes](releases/0.3.5.2.md) and [changelog](../CHANGELOG.md)
- [Language rules](LANGUAGE-RULES.md), [AI completion](AI-COMPLETIONS.md), [collaboration](COLLABORATION.md)
- [Git](GIT.md), [project and build settings](PROJECTS.md), [component libraries](COMPONENT-LIBRARIES.md), [project packaging](PROJECT-PACKAGING.md), [tool versions](TOOL-VERSIONS.md)
- [STM32](STM32.md), [ESP32-S3](../extensions/boards/Esp32_S3_CAM/README.md), [toolchains](TOOLCHAINS.md)
- [Web host](WEB-HOST.md), [development](DEVELOPMENT.md), [architecture](ARCHITECTURE.md)
- [Platform support](PLATFORM-SUPPORT.md), [roadmap](ROADMAP.md), [feature guide](NEW-FEATURES.md)
- [Contributing](../CONTRIBUTING.md), [security policy](../SECURITY.md), [license](../LICENSE)

## Contributing and license

Use [GitHub Issues](https://github.com/mioolio/blode/issues) for bug reports and feature discussions, and Pull Requests for changes. Include the release, edition, host OS, project type and redacted logs. See the [contribution guide](../CONTRIBUTING.md).

Blode Studio is licensed under [Apache License 2.0](../LICENSE), with [third-party dependency notices](THIRD-PARTY-NOTICES.md) included in the distributions. Downloaded compilers, drivers and other third-party tools retain their own licenses.
