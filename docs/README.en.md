# Blode Studio

[简体中文](../README.md) · [繁體中文](README.zh-TW.md) · **English** · [日本語](README.ja.md) · [한국어](README.ko.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Italiano](README.it.md) · [Русский](README.ru.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md)

Blode Studio is a modular embedded development workbench for source editing, firmware builds and flashing, serial communication, hardware debugging, Git and team collaboration. Use the Electron desktop application, or run a Node.js host on the computer that owns the projects and hardware and access it through a browser.

[GitHub Releases](https://github.com/mioolio/blode/releases) · [CHANGELOG](../CHANGELOG.md) · [Issues](https://github.com/mioolio/blode/issues)

## Available features

- C/C++ completion, definitions, references, diagnostics and formatting through clangd, with a workspace index fallback; preview tabs, split editing and draft recovery.
- Compile without connecting a device. Use named build entries, Debug/Release modes, size optimization and separate C/C++ toolchain selections.
- Export BIN, HEX, S-record and ELF firmware; flash prepared firmware and share projects with their external source dependencies.
- Browse Arduino libraries, import component folders or ZIPs, and export device modules and toolchains for offline use.
- Inspect registers, disassembly, call stacks and memory; use stepping and batch breakpoints with a connected target.
- Share tabs, editing ranges and recent logs; merge independent changes and preserve conflicts. Browser undo applies to the current user’s changes.
- Manage project Git history, diffs, staging, commits, branches and remotes; open multiple native terminal sessions and connect VS Code.
- Preview images, audio and video; configure optional AI completion and scoped chat/edit actions. Device modules and general extensions manage their own resources and language catalogs.

## Choose a distribution

| Edition          | Run on                        | Artifact                                    |
| ---------------- | ----------------------------- | ------------------------------------------- |
| Desktop portable | Windows x64; run directly     | `Blode.Studio-0.3.5.9-desktop-win-x64.exe`  |
| Standalone Web   | Windows x64; includes Node.js | `Blode.Studio-0.3.5.9-web-win-x64.exe`      |
| Web with Node.js | Windows x64; Node.js 24+ x64  | `Blode.Studio-0.3.5.9-web-node-win-x64.zip` |

All three editions share the project format and host services. Extract the Node.js ZIP and run `start-web.cmd`; its dependencies are included. Source on `main` may be newer than release packages; see the release notes for packaged features.

[0.3.5.9](releases/0.3.5.9.md) · [SHA-256 / OBE](PACKAGE-SIGNING.md)

## Supported hardware and hosts

| Device module                    | Build tools                      | Hardware connection |
| -------------------------------- | -------------------------------- | ------------------- |
| Esp32_S3_CAM · ESP32-S3          | Arduino CLI + Arduino-ESP32      | UART / USB-JTAG     |
| STM32F103C8T6 · STM32F103C8/C8T6 | GNU Arm GCC / Arm Compiler 5 / 6 | ST-Link / SWD / GDB |

The current device profiles cover ESP32-S3 and STM32F103C8/C8T6. Camera pins belong to the project configuration. ESP32-S3 UART GDB has been exercised on a Windows reference setup; native USB-JTAG validation continues. Windows x64 is the main distribution. Linux x64/ARM64 adaptations and macOS custom-tool paths have not completed real-machine validation.

## Quick start

Source development requires Node.js 24+, npm and Git.

```sh
git clone --single-branch https://github.com/mioolio/blode.git
cd blode
npm ci
npm run dev
```

For a browser workbench, run the following on the project/hardware computer. Open the link printed by the service. Folder selection, compilation, USB, serial ports and terminals belong to that host computer.

```sh
npm run web:build
npm run web:start
```

## Module structure and binary hosts

Device modules separate ten responsibilities: `support`, `device`, `runtime`, `constraints`, `ui`, `compiler`, `debugger`, `layout`, `languages` and `tools`. The `be` project file records build inputs; `blode.components.json` records project libraries. `package:runtime` produces standalone JavaScript, manifests and resources. Compatible desktop binaries and Web hosts load these packages without the host TypeScript source. General extensions can contribute appearance, menus, windows and bottom panels without implementing a compiler.

```sh
npm run package:runtime -- extensions/boards/Esp32_S3_CAM --output ./release/modules --zip
```

## Package signatures

- `obe` is an Ed25519-signed JSON manifest binding publisher identity, package ID/version and each file’s path, size and SHA-256. Installation checks the actual payload again before writing it.
- Official trust comes from the host’s public-key registry. Missing or unknown signatures, damaged signatures and changed file contents are distinguished. Export preserves an existing signature; it does not confer official identity on a third-party package.
- Maintainer private keys stay in `.signing/`, outside Git and distribution payloads. Windows Authenticode is a separate layer; the current maintainer certificate is self-signed, rather than a public CA certificate. Editing signed content requires signing it again.

[OBE / Authenticode](PACKAGE-SIGNING.md) · [Module structure and binary hosts](ENGINEERING.md)

## Work in progress

- Broader hardware coverage, long-running collaboration and cross-machine project migration.
- AI suggestion quality, input-method behavior and terminology review across languages.
- Real-machine Linux/macOS installation, toolchain and USB validation.

## Documentation

- [Module structure and binary hosts](ENGINEERING.md) · [Runtime plugins](RUNTIME-PLUGINS.md) · [General extensions](GENERAL-EXTENSIONS.md)
- [Projects](PROJECTS.md) · [Component libraries](COMPONENT-LIBRARIES.md) · [Offline delivery](OFFLINE-DELIVERY.md)
- [Package signatures](PACKAGE-SIGNING.md) · [Build / Release](RELEASING.md) · [Localization](LOCALIZATION.md)
- [Hardware debugging](HARDWARE-DEBUGGING.md) · [Platforms](PLATFORM-SUPPORT.md) · [Roadmap](ROADMAP.md)
- [Contributing](../CONTRIBUTING.md) · [Security](../SECURITY.md)

## License and contributions

Source code is published under Apache License 2.0. Third-party compilers, drivers and services retain their own terms. Report issues and propose improvements through GitHub Issues and Pull Requests.

[Apache License 2.0](../LICENSE) · [Third-party notices](THIRD-PARTY-NOTICES.md)
