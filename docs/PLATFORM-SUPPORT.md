# Platform support

Reviewed on 2026-11-01. The current source, packaged feature baseline and validation boundaries are summarized in [implementation status](STATUS.md).

## Host editions

| Edition            | Target environment                                                         | Runtime requirements                                                         | Recorded state                                                  |
| ------------------ | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Desktop portable   | Windows x64                                                                | Embedded Electron; Git and firmware tools are installed/selected on the host | Primary development platform; local 0.3.5.9 EXE built           |
| Standalone Web EXE | Windows x64                                                                | Embedded Node host and native dependencies; an external browser              | Local 0.3.5.9 EXE built; recipient does not install Node.js/npm |
| Compact Web ZIP    | Windows x64                                                                | Node.js 24+ x64; application/native dependencies are included                | Local 0.3.5.9 ZIP built; extract and run `start-web.cmd`        |
| Web from source    | Node.js 24+ and source dependencies                                        | `npm ci`, host build, browser; platform-specific native dependencies         | Windows development verified; Linux/macOS acceptance pending    |
| Linux x64/ARM64    | Source host and prepared platform paths/downloads                          | Distribution toolchain, native libraries and USB permissions                 | No real-host end-to-end validation or verified release packages |
| macOS/other hosts  | Custom tool paths; some language-service downloads have platform manifests | Host-specific native dependencies and tools                                  | No complete host/hardware validation or release package         |

The browser can run on another computer. Files, compiler processes, Git, serial ports and debugger sessions belong to the computer running the host. The Web editions do not embed Chromium or another browser engine.

## Device modules

| Module          | Declared scope                                       | Build/programming                            | Debugger and validation                                                                                                                          |
| --------------- | ---------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Esp32_S3_CAM`  | ESP32-S3; camera GPIO selected by the project        | Arduino CLI + Arduino-ESP32; serial/esptool  | UART GDB on Windows/CH340 reference firmware verified; native USB-JTAG and camera migration pending                                              |
| `STM32F103C8T6` | STM32F103C8/C8T6; default 64 KiB Flash / 20 KiB SRAM | GNU Arm GCC or Arm Compiler 5/6; ST-Link/SWD | GDB workbench implemented; latest real ST-Link identification and ZIP tool transfer verified; SRAM instruction edits pending hardware acceptance |

These two profiles are the official device modules. `auto` performs detection; it is not a claim of support for every ESP32 or STM32 series. Legacy `esp32-s3` and `stm32` project IDs migrate on read. Third-party modules declare their own chip ranges, transports and capabilities.

## Tools and drivers

- GNU Arm and Arduino CLI have pinned Windows x64/Linux x64/Linux ARM64 archive definitions; ESP32 core installation depends on the assets available for the chosen host/core combination.
- Windows x64 ST-Link 1.9.0 supports download, online installation and offline ZIP installation. Tools are discovered in managed/version directories, configured package/bin paths and PATH. Driver state is checked independently.
- Linux ST-Link uses a system installation or custom path; the catalog includes an x64 release link. No privileged Linux package-manager or udev installation is implemented.
- ESP32 GDB/OpenOCD manifests cover Windows x64/Linux x64/Linux ARM64. Actual Windows archive checks and UART GDB sessions are recorded; Linux execution and native USB-JTAG acceptance remain pending.
- AC5/AC6 use existing licensed installations; no automatic vendor compiler download catalog is provided. AC5 supports C99/C++03. Application signing and OBE do not replace compiler licensing.
- clangd is a separate language service; its archive manifests do not imply firmware toolchain or hardware support on that host.
- Git and remote credentials are supplied by the host. Browser clients use that same Git environment.

## Validation boundaries

Real Windows results include ESP32-S3 firmware build/flash/heartbeat, UART GDB reference sessions, GNU/AC5/AC6 reference compilation and the latest STM32 ST-Link recognition after tool export/import. Detailed records identify the tool versions, firmware and operations actually performed.

Pending work includes Linux/macOS end-to-end testing, ESP32 native USB-JTAG, STM32 SRAM patch execution, second-machine complex project migration and sustained high-latency collaboration. The latest ST-Link group passed 55 related tests; it is not a new full-suite or all-platform certification.

See [hardware records](HARDWARE-VALIDATION.md), [debugging](HARDWARE-DEBUGGING.md), [tool versions](TOOL-VERSIONS.md), [Web deployment](WEB-HOST.md) and [roadmap](ROADMAP.md).
