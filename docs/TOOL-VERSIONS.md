# Compiler and tool versions

This page describes the version catalog available in **Preferences → Toolchain**. The catalog contains download definitions, not preinstalled compiler binaries. A version is downloaded only after the user chooses **Download and install this version**.

## Available versions

| Component      | Catalog versions                   | Purpose and source                                                                                                                                                                              |
| -------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GNU Arm GCC    | 15.2.1-1.1, 14.2.1-1.1, 13.3.1-1.1 | STM32 cross-compilation; publisher archives from [xPack releases](https://github.com/xpack-dev-tools/arm-none-eabi-gcc-xpack/releases)                                                          |
| Arduino CLI    | 1.3.1, 1.2.2                       | Arduino project builds; [official Arduino CLI releases](https://github.com/arduino/arduino-cli/releases)                                                                                        |
| Arduino-ESP32  | 3.0.7, 2.0.17                      | Separate ESP32 package stores; [3.0.7 release](https://github.com/espressif/arduino-esp32/releases/tag/3.0.7), [2.0.17 release](https://github.com/espressif/arduino-esp32/releases/tag/2.0.17) |
| ST-Link        | 1.9.0 reference link               | Existing managed tools, custom directory or Linux system package; [official release](https://github.com/stlink-org/stlink/releases/tag/v1.9.0)                                                  |
| clangd         | 23.1.0                             | C/C++ language service; standalone archives from [clangd releases](https://github.com/clangd/clangd/releases/tag/23.1.0)                                                                        |
| Arm Compiler 5 | Existing local installations       | C99/C++03, versioned selection and offline snapshots; see [AC5 integration](ARM-COMPILER-5.md)                                                                                                  |
| Arm Compiler 6 | User-installed versions            | Specify an existing licensed installation; the app does not download or authorize redistribution of AC6                                                                                         |

These entries are compatibility choices rather than a claim that a particular release is the newest. Download assets and release metadata were checked against the publishers on 2026-10-29. The [xPack installation guide](https://xpack-dev-tools.github.io/arm-none-eabi-gcc-xpack/docs/install/) documents the Windows and Linux archive naming.

## Select a version

**Run → Build settings** lists tools actually installed on the host and saves common, platform and C/C++ selections in `be.build.settings`. **Preferences → Toolchain** separately lists downloadable versions and installation progress. Installed state describes tool availability; the project's selection describes which tool a build uses. See [project and build settings](PROJECTS.md) for inheritance, modes and portable configuration.

1. Open Preferences and choose **Toolchain** in the left navigation.
2. Select the desired tool/version. The host platform and architecture are shown with links to the release and download.
3. Install it if necessary. Progress appears under **Tool installation output**.
4. Choose **Use for this project**, then **Apply**. Starting the next build also saves the selected project tool configuration.

Version changes do not rewrite source syntax or update libraries automatically. Projects using an older Arduino-ESP32 API may need the corresponding older core and compatible libraries. Keep a known working combination recorded in the project's `be` configuration and sharing manifest.

## Storage and compiler resolution

Versions install beside each other beneath the selected toolchain root:

```text
versions/
  gnu-arm/<version>/bin/
  arduino-cli/<version>/bin/
  arduino-esp32/<version>/
    arduino-data/
    downloads/
    libraries/
    arduino-cli.yaml
    installed.json
  clangd/<version>/bin/clangd(.exe)
                /lib/clang/<version>/include/
```

Selecting GNU sets `toolchain.armCompilerDirectory` to that version's `bin` directory. Selecting Arduino CLI sets `toolchain.mode` to `custom` and records its executable path. Selecting Arduino-ESP32 sets `toolchain.packageDirectory`; builds and bundled esptool discovery use that isolated store. Its `installed.json` pins subsequent core installation to the selected version rather than silently upgrading the same store.

Other installed versions remain available. A successful existing installation is not replaced when its install button is invoked again. A failed or partial installation may be retried in the same version directory. Custom compiler, CLI, Python and ST-Link paths remain available alongside the catalog.

For portable sharing, do not copy machine-specific compiler binaries into a source ZIP. A version path contains a stable tool ID such as `gnu-arm:14.2.1-1.1` or `arduino-esp32:2.0.17`; the sharing manifest can record this requirement and the recipient can install/select the corresponding host version.

## Download verification

GNU and Arduino CLI archives are matched against a pinned release tag and expected asset URL. SHA-256 is taken from GitHub's publisher asset metadata when present. Older releases without that field use the publisher's adjacent `.sha` file (GNU) or release checksum manifest (Arduino CLI). Missing or mismatching checksums, oversized archives and unsafe archive paths stop installation. Download bytes, verification, extraction and installation stages are reported to the shared installation output.

clangd uses its own pinned standalone archive and digest. Linux and macOS archives are ZIP files, so the installer uses the shared bounded ZIP reader rather than `tar`; only stored and deflated entries are accepted, the release folder is stripped, and the executable is marked runnable on POSIX. The installed layout is checked before the version directory replaces any previous copy. Full packages can instead ship `tools/clangd/`; see [toolchains](TOOLCHAINS.md#clangd).

Arduino-ESP32 is installed by Arduino CLI with an explicit `esp32:esp32@<version>` target and the official Espressif package index. The CLI validates the package downloads; the app verifies the reported installed core version before recording the installation.

## Platform support and verification

| Host        | GNU archives           | Arduino CLI archives   | ST-Link setup                                                               | Verification status                                                                               |
| ----------- | ---------------------- | ---------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Windows x64 | Prepared               | Prepared               | Managed existing tools / custom path / bundled driver flow                  | Catalog and installer logic covered by lightweight mocked tests; no full downloads in this change |
| Linux x64   | Prepared               | Prepared               | Official `.deb` link or distribution package manager, then PATH/custom path | **Not tested on Linux**                                                                           |
| Linux ARM64 | Prepared               | Prepared               | Distribution-provided ST-Link / custom path                                 | **Not tested on Linux**; old ESP32 cores may lack some host tool assets                           |
| Other hosts | Custom installed paths | Custom installed paths | Custom installed paths                                                      | No automatic catalog installer claim                                                              |

Linux users also need the shared libraries and device permissions required by their distribution and ST-Link/serial hardware. The app does not run a privileged package manager or silently modify udev rules. Download URL handling and platform-specific command names are prepared, but actual Linux installation, compilation, hardware access and packaging remain unverified.

Lightweight tests cover architecture asset selection, side-by-side compiler selection, checksum fallback/rejection and isolated ESP32 core storage. They use small fixture responses and temporary folders; they do not download the large toolchains or claim real-hardware validation.

## API integration

- `toolVersionsState()` returns the host platform/architecture, download catalog entries with installed state, and the separate `installedTools` build-selection inventory.
- `toolVersionInstall({id, confirm: true})` installs one allowed catalog entry.
- `toolVersionSelect({id})` returns the project toolchain configuration patch; the caller applies it to the existing configuration and saves it.

The native and web host integrations use the same validated service. Downloads run on the target host, not on the browser user's machine. See [toolchains](TOOLCHAINS.md), [development](DEVELOPMENT.md), and [AI integration](AI-PIPE.md) for the surrounding workflows.
