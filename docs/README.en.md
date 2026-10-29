# Blode Studio

English | [简体中文](../README.md)

Blode Studio is a modular embedded development workbench for editing, collaboration, offline builds, firmware export, serial communication and hardware debugging. The development branch includes the specific `Esp32_S3_CAM` and `STM32F103C8T6` runtime profiles.

**Current release: 0.2.3.6** · [Release notes](releases/0.2.3.6.md) · [Changelog](../CHANGELOG.md) · [GitHub Releases](https://github.com/mioolio/blode/releases)

## Internal development preview: runtime plugins

`codex/runtime-plugins-internal` is a development branch based on 0.2.3.6. It introduces runtime identity migration, API v2 package declarations, execution consent, replaceable compilers, and custom device/debug views. This update does not create a new stable release; `main` keeps the stable code. See the [internal update and acceptance checklist](internal/runtime-plugins.md) for validation status.

To try the source build:

```sh
git clone --branch codex/runtime-plugins-internal --single-branch https://github.com/mioolio/blode.git
cd blode
npm ci
npm run dev
```

For the standalone Web host, run `npm run web:build`, then `npm run web:start` in the source directory. Extension authors should start with the [runtime plugin guide](RUNTIME-PLUGINS.md). Legacy `esp32-s3` and `stm32` project identifiers and compiler pins migrate when loaded.

## Choose an edition

| Edition          | Intended use                                                                  | Requirements                                          | Release artifact                           |
| ---------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------ |
| Desktop portable | Local editing, builds and connected hardware                                  | Windows x64; Electron runtime included                | `Blode.Studio-0.2.3.6-desktop-win-x64.exe` |
| Standalone Web   | A target computer hosts projects and hardware; users connect through browsers | Node.js 24+ and npm on the host; a browser on clients | `Blode.Studio-0.2.3.6-web.zip`             |

Both editions use the same project format and host services. The desktop artifact uses the lightweight packaging mode. Install compilers through Preferences or select existing custom tool paths. Git operations use Git installed on the host. Build outputs are placed in `release/0.2.3.6/`.

## What's new in 0.2.3.6

- **Code navigation:** C/C++ definitions, declarations, references and header links. Right-click or press F12, choose among duplicate results, and use Alt+Left to return.
- **Versioned language data:** separate C99, C11, C17 and C23 JSON directories, alphabetic function catalogs, control-flow snippets, types and declarative source checks.
- **Incremental indexing:** workspace functions, macros, types and variables contribute to completion; current drafts update the editor index, while saved-source exports are cached under `.blode/index/`.
- **Project settings:** right-click the root `be` file to edit project identity, platform, entry, source list and C standard with a live JSON preview.
- **Layered build settings:** **Run → Build settings** selects debug/release mode, size optimization and installed C/C++ tools for common, STM32 and ESP32-S3 scopes.
- **Independent Git:** software-owned metadata in `.blode/git`, graphical diffs, staging, commits, branches and remotes; management can be disabled or its own history removed. Existing repository sharing is explicitly enabled.
- **Collaboration:** persistent browser identity and color, shared tabs, viewport highlights, independent edit merging, explicit conflicts and the latest build logs.
- **Stable reading and undo:** remote edits retain the reader's anchor where possible; browser undo affects the user's own changes, and closed tabs release presence.
- **External AI completion:** editable user/AI catalogs and optional version-bound inline predictions. Predictions are off by default and accepted with Tab.
- **Visible startup and installation progress:** phase timings, long-wait messages, download progress and third-party installer output.

Read the detailed [release notes](releases/0.2.3.6.md) for migration and validation information.

## Core workflows

The editor supports preview and pinned tabs, horizontal scrolling, split views and draft recovery. The home screen lists recent workspaces and supports save-and-close back to home.

Build a selected file or directory without connecting a device. Firmware operations include BIN, Intel HEX and S-record export, STM32 ELF export, Flash layout editing and prepared firmware programming without opening a project. Connect and identify the physical target for programming.

Serial communication supports UTF-8/HEX, configurable framing, flow control and line endings. The STM32/ST-Link/GDB workbench opens a separate desktop window or browser tab with registers, disassembly, stack, breakpoints, memory and local ELF inspection.

Portable project ZIP export collects supported external dependencies, rewrites archive-copy paths and includes a dependency manifest. JSON-RPC and MCP expose validated project, Git, build, firmware, debugger, language-index and UI actions.

## Installation

### Windows desktop portable

1. Place the desktop executable in a writable directory and run it.
2. Open a project folder or its `be` descriptor.
3. Install/select the toolchain in Preferences. Install host Git when using version control.
4. Set the build entry from the file tree or Advanced settings, then choose the build mode and installed tool versions in **Run → Build settings**.
5. Save and compile; connect and identify the target for hardware operations.

The application stores settings, history and managed tools in its OS application-data directory. Projects can remain outside the application folder.

### Standalone Web ZIP

Extract the ZIP on the computer that owns the projects and hardware, then run:

```sh
npm ci --omit=dev
npm start
```

Open the private launch link printed in the terminal. File pickers browse the **host computer**, and builds, Git and USB access run there.

For a trusted LAN:

```sh
npm start -- --host 0.0.0.0 --port 47821
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

Built-in data lives in `extensions/completions/C/<standard>/` and `extensions/completions/C++/arduino/`. C version directories are independent; projects can override a selected standard in `languages/C/<standard>/`.

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
```

The desktop command aliases the lightweight `package:lite` flow. The Web build checks for Electron imports. Automated coverage includes disposable Git repositories, language rules and indexes, collaboration, project ZIPs and HTTP services with fixture hardware boundaries. Physical hardware, cross-machine and sustained-session results are tracked separately.

## Documentation

- [0.2.3.6 release notes](releases/0.2.3.6.md) and [changelog](../CHANGELOG.md)
- [Language rules](LANGUAGE-RULES.md), [AI completion](AI-COMPLETIONS.md), [collaboration](COLLABORATION.md)
- [Git](GIT.md), [project and build settings](PROJECTS.md), [project packaging](PROJECT-PACKAGING.md), [tool versions](TOOL-VERSIONS.md)
- [STM32](STM32.md), [ESP32-S3](../extensions/boards/Esp32_S3_CAM/README.md), [toolchains](TOOLCHAINS.md)
- [Web host](WEB-HOST.md), [development](DEVELOPMENT.md), [architecture](ARCHITECTURE.md)
- [Platform support](PLATFORM-SUPPORT.md), [roadmap](ROADMAP.md), [feature guide](NEW-FEATURES.md)
- [Contributing](../CONTRIBUTING.md), [security policy](../SECURITY.md), [license](../LICENSE)

## Contributing and license

Use [GitHub Issues](https://github.com/mioolio/blode/issues) for bug reports and feature discussions, and Pull Requests for changes. Include the release, edition, host OS, project type and redacted logs. See the [contribution guide](../CONTRIBUTING.md).

Blode Studio is licensed under [Apache License 2.0](../LICENSE), with [third-party dependency notices](THIRD-PARTY-NOTICES.md) included in the distributions. Downloaded compilers, drivers and other third-party tools retain their own licenses.
