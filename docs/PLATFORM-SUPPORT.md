# Platform support

Host editions, declared chip coverage and validation status for the built-in runtime packages.

## Host editions

| Host                        | Desktop edition                                                         | Standalone Web host                                                          | Current verification                                                                                       |
| --------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Windows x64                 | Primary development target; Electron desktop                            | Node.js 24+ service and browser UI                                           | Local development and lightweight automated checks; feature-specific hardware validation is still required |
| Linux x64                   | Platform paths are prepared; no verified desktop release in this change | Node.js service and architecture-specific GNU/Arduino downloads are prepared | **Not tested on Linux**; installation, desktop packaging, compilation and USB access remain unverified     |
| Linux ARM64                 | No verified desktop release                                             | Node.js service and matching GNU/Arduino archives are prepared               | **Not tested on Linux**; older ESP32 packages may not publish every required host tool                     |
| macOS / other architectures | Custom tool paths remain possible; no automatic support claim           | Runtime code is portable in principle; no verified distribution              | Unverified; the built-in automatic installer catalog does not cover these hosts                            |

The Web browser may run on a different computer from the host. Browser compatibility and responsive layout do not change the operating-system requirements of the compiler, Git executable or USB hardware attached to the host.

## Embedded platforms

| Platform      | Compilation                                                                                                 | Firmware programming                     | Debugging                                                                                                                                |
| ------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Esp32_S3_CAM  | ESP32-S3 with managed, versioned or custom Arduino-ESP32 packages; project-defined camera GPIO              | Host serial connection and esptool       | Native USB-JTAG, Xtensa GDB and Espressif OpenOCD; registers, memory, disassembly and hardware breakpoints. Physical acceptance pending. |
| STM32F103C8T6 | GNU Arm GCC or licensed Arm Compiler 6; C8/C8T6 Keil project imports; 64 KiB Flash and 20 KiB SRAM defaults | ST-Link/SWD and prepared firmware images | Separate ST-Link/GDB workbench with disassembly, registers, stack, memory, breakpoints and instruction control                           |

The hardware workbench samples a connected physical target. Plugins can declare additional chip scopes, transports and debug providers. Recommended resource capacities remain separate from explicit user allocations. See [STM32 support](STM32.md) and the [runtime plugin contract](RUNTIME-PLUGINS.md).

## Tool and driver requirements

- GNU Arm and Arduino CLI catalogs provide pinned public Windows x64, Linux x64 and Linux ARM64 archive definitions with checksum validation. See [tool versions](TOOL-VERSIONS.md).
- ESP32-S3 debug tools provide pinned GDB/OpenOCD archives for Windows x64, Linux x64 and Linux ARM64. Windows archive downloads, SHA-256 checks and version execution were verified; Linux execution and real JTAG sessions are unverified. See [hardware debugging](HARDWARE-DEBUGGING.md).
- Arm Compiler 6 must already be installed by the user under its own license.
- Linux ST-Link can use a distribution package or custom executable directory. An official x64 `.deb` release link is provided; the app does not run privileged package-manager commands or silently change udev rules.
- Linux serial and debug access requires the appropriate device permissions and runtime libraries for the distribution.
- Integrated Git management requires Git on the target machine. Existing Git credentials and SSH configuration remain on that machine.
- The Web release requires Node.js 24+ and installs serialport for the recipient's platform. It does not contain a browser engine or compiler binaries.

## Release readiness

Lightweight tests cover service boundaries, collaboration logic, project packaging, tool metadata verification and host startup with fake hardware runtimes. The following remain acceptance tasks rather than completed claims:

1. Linux x64 and ARM64 installation and real compiler builds.
2. Linux serial/ST-Link permissions, reconnect behavior and physical flashing/debugging.
3. Desktop packaging and launch checks on Linux.
4. Real multi-browser collaboration under latency and long editing sessions.
5. Toolchain download/install validation on each supported host and architecture.

See [hardware validation](HARDWARE-VALIDATION.md) and [roadmap](ROADMAP.md) for follow-up work.
