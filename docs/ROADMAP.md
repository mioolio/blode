# Product roadmap

Reviewed on 2026-11-01 against the current `main` implementation. [Implementation status](STATUS.md) separates source features, existing binaries and validation evidence. Historical internal notes describe their original stage; they are not the current release matrix.

## Implemented

| Area            | Available behavior                                                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Editing         | clangd with workspace-index fallback, navigation and external headers, preview tabs, drafts, image/audio/video previews                           |
| Builds          | Offline compilation, named subprojects, one current-entry form, per-language tool selections, Debug/Release and size optimization                 |
| Targets         | ESP32-S3 Arduino/esptool and STM32F103C8/C8T6 GNU Arm/AC5/AC6 with ST-Link                                                                        |
| Debugger        | Separate desktop/window or browser tab; registers, disassembly, stack, memory, stepping, batch breakpoints; STM32 SRAM instruction-edit interface |
| Delivery        | Portable projects with external dependencies; component/device/tool ZIP export and offline installation; fresh export manifests and hashes        |
| ST-Link tools   | Windows install/download, managed/versioned/custom/PATH discovery, paired version checks and debugger server lookup                               |
| Collaboration   | Shared file/tool tabs, all-client close transactions, own-edit browser undo, conflict reporting, attention/presence and recent-log replay         |
| Host tools      | Project-scoped Git management, native multi-session terminals, VS Code disk synchronization                                                       |
| Extensions      | Ten-directory device modules, standalone JavaScript packages, general extensions, windows/panels and OBE review                                   |
| Desktop         | Default close-to-tray, restore and explicit exit with unsaved-change handling                                                                     |
| Language and AI | 13 interface languages and README editions, model-provider or external-AI completion, scoped questions and edits                                  |
| Distribution    | Three Windows x64 builds: desktop EXE, self-contained Web EXE and compact Web ZIP requiring Node.js 24+ x64                                       |

Existing 0.3.5.9 binaries predate the multilingual and latest ST-Link source changes. A source push does not rebuild or replace release attachments.

## Recorded validation

| Scope             | Evidence                                                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| ST-Link           | 55 related tests, type checking and standalone module build; real ZIP export/import followed by STM32F1 discovery in an isolated tool root |
| ESP32-S3 UART GDB | Windows/CH340 counter firmware: registers, memory, breakpoints, stepping, pause/continue and disconnect/reconnect                          |
| Compilers         | Windows reference GNU Arm, AC5 and AC6 builds; compiler-specific details remain in the platform guides                                     |
| Portable project  | Real GNU build, external dependency migration, original dependency removal and binary comparison after rebuilding                          |
| Collaboration     | Two-client service/UI scenarios, tab lifecycle, own-user undo, conflict and reconnect coverage; longer cross-machine use remains pending   |
| Distributions     | Local 0.3.5.9 artifacts, hashes/signatures and documented Windows startup checks; no new packages in this documentation update             |

Test counts refer to their recorded groups, not a current full-suite run. [Hardware records](HARDWARE-VALIDATION.md), [debugger validation](HARDWARE-DEBUGGING.md#验证状态), [AI acceptance](AI-INTEGRATION-VALIDATION.md) and [collaboration](COLLABORATION.md) retain the specific environments and limits.

## Current acceptance work

| Priority | Work                                                            | Acceptance evidence                                                                              |
| -------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| High     | ESP32-S3 native USB-JTAG and camera firmware UART GDB migration | A real target session and matching ELF, with board/firmware/tool versions recorded               |
| High     | STM32 SRAM instruction edits and run-time patches               | Byte readback, execution behavior and stop/resume outcomes on a dedicated test firmware          |
| High     | Desktop/Web concurrent debug ownership                          | Reconnect, cancellation and hardware-lock scenarios across real clients                          |
| High     | Complex project/component/tool transfer to a second computer    | Clean receiver install and successful firmware rebuild without source-machine paths              |
| High     | Long-running, high-latency collaboration                        | Stable reading anchors, own-user undo, close/cancel/reopen and eventual state convergence        |
| Medium   | Language terminology and input methods                          | Native-language review and manual editor/menu/IME checks                                         |
| Medium   | AI predictions and large-project responsiveness                 | Provider-specific error handling, latency and suggestion-quality records                         |
| Medium   | Tool installation per architecture                              | Actual publisher archives, version execution, successful builds and hardware access on that host |

## Planned platform and architecture work

- Linux x64/ARM64 installation, native dependencies, USB permissions, compilers and desktop packaging.
- macOS end-to-end host and hardware verification.
- Additional device families through independently scoped modules and hardware records.
- Native-extension process isolation, extension upgrades and larger background indexes.
- Richer conflict review, project/team permissions and more debugger backends.

Dates and additional device support are not yet scheduled. See [platform support](PLATFORM-SUPPORT.md), [module development](RUNTIME-PLUGINS.md) and [release workflow](RELEASING.md).
