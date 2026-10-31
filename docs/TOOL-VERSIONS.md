# Compiler and tool versions

Verified against source on 2026-11-01. Current implementation and test boundaries are summarized in [implementation status](STATUS.md).

## Where to work

| Location                                       | Purpose                                                                                                      |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Preferences → Compile and toolchains**       | Download catalog, online installation, offline ZIP import and path configuration                             |
| **Preferences → Toolchains and export**        | Tools detected on the host, their versions, directories and fresh ZIP export                                 |
| **Build → Build settings**                     | Compiler family/version, Debug/Release, firmware size optimization and C/C++ overrides for the current entry |
| **Build → Component library → Device modules** | Device module search, loading, verification, directory access and ZIP export                                 |

The build dialog uses one form for the current entry. It has no component-library shortcut or sidebar enumerating every installed device module. The saved configuration still supports common, platform and language inheritance; see [projects](PROJECTS.md).

## Catalog and local inventory

| Tool               | Catalog versions                   | Distribution behavior                                                                               |
| ------------------ | ---------------------------------- | --------------------------------------------------------------------------------------------------- |
| GNU Arm GCC        | 15.2.1-1.1, 14.2.1-1.1, 13.3.1-1.1 | Pinned xPack Windows x64 / Linux x64 / Linux ARM64 archives                                         |
| Arduino CLI        | 1.3.1, 1.2.2                       | Official host-specific archives                                                                     |
| Arduino-ESP32      | 3.0.7, 2.0.17                      | Arduino CLI installation into isolated core stores                                                  |
| ST-Link            | 1.9.0                              | Official Windows x64 ZIP: download, install and offline import; Linux x64 release link              |
| clangd             | 23.1.0                             | Separate language-server archive, independent of the firmware compiler                              |
| Arm Compiler 5 / 6 | Detected local installations       | Choose existing tools; export/import eligible installed files; no built-in AC5/AC6 download catalog |

These are the versions declared in the repository, not a latest-release feed. Availability is detected separately from catalog definitions. AC5 and AC6 can appear in the local inventory without a download row.

Download-only creates a shareable offline ZIP. Installation adds host tools; **Build settings** chooses the compiler actually used by the project. Installing a new version leaves other versions in place. Compiler changes do not rewrite source or update its libraries.

## ST-Link discovery and status

Chip discovery, local-tool inventory and debugger server discovery use the STM32 module's shared path rules:

1. An explicit `toolchain.stlinkDirectory` accepts a package root or its `bin/` directory. Hardware operations keep that choice; an invalid explicit path is not silently replaced.
2. Automatic discovery checks `<toolchain-root>/stlink/`, then `<toolchain-root>/versions/stlink/<version>/`, then absolute PATH directories.
3. Tool availability checks both `st-info --version` and `st-flash --version`: successful exit codes and matching versions are required. The debugger separately locates `st-util`.

Driver readiness is reported by **Preferences → Debugger drivers**. It describes Windows PnP/driver state; the tool catalog describes the command-line installation. See [driver setup](DRIVERS.md).

The current Windows catalog exposes **Install** and **Download only** for ST-Link. The earlier hardcoded “not installed” result and missing Windows actions were corrected on `main` after the existing 0.3.5.9 binaries were built.

## Storage

All paths below are relative to the selected toolchain root:

```text
stlink/bin/                         # managed installation
armgcc/bin/                        # managed GNU installation
armclang/bin/                      # local AC6 installation
versions/
  gnu-arm/<version>/bin/
  armcc/<version>/bin/
  armclang/<version>/bin/
  arduino-cli/<version>/bin/
  arduino-esp32/<version>/
    arduino-data/
    libraries/
    arduino-cli.yaml
    installed.json
  stlink/<version>/bin/
                 /share/stlink/chips/
  clangd/<version>/bin/
```

The development desktop uses repository `tools/`; the standard portable desktop and Web host use their host data directory when no bundled or explicit root is supplied. `BLODE_TOOLCHAIN_ROOT` overrides the root. See [toolchain layout](TOOLCHAINS.md) for mode-specific details.

New installations and offline imports are detected again. Export rescans the installed directory and computes a new manifest, hashes and ZIP for each request. ST-Link exports retain required DLLs and chip definitions. See [offline delivery](OFFLINE-DELIVERY.md).

## Integrity and installation

GNU, Arduino CLI and ST-Link downloads must match their declared release and asset URL. SHA-256 comes from publisher release metadata; older GNU/CLI releases can use their publisher checksum files. ST-Link requires the digest in the official release metadata. Archive size, paths and extraction boundaries are checked before running installed tools.

Arduino-ESP32 uses explicit core versions and the Espressif/Arduino indexes. clangd has a dedicated archive manifest and installer. Installation progress records downloading, verification, extraction, installation and the final result; export uses its own collection/compression stages under **Tool task output**.

Package installation also checks the OBE publisher signature and actual payload where the package carries a signature. Unsigned/unknown publishers require review; damaged signatures or changed contents are displayed separately. File hashes and publisher trust are described in [package signing](PACKAGE-SIGNING.md).

## Validation

The latest Windows ST-Link change passed 55 related tests and type checking. Real ST-Link 1.9.0 tools were exported, imported into an isolated version directory and used to identify one STM32F1 target; the imported `st-util` path was also found. This round did not flash firmware or attach a GDB session. The exact test command is in [implementation status](STATUS.md).

Windows has recorded real GNU/AC5/AC6 reference builds and ESP32 UART debugging. Linux x64/ARM64 asset/path support is implemented but has not completed real-host installation, USB access, builds or packaging. See [platform support](PLATFORM-SUPPORT.md) and [hardware records](HARDWARE-VALIDATION.md).

## API

- `toolVersionsState()`: catalog entries, installed build tools, exportable local tools and retained download records.
- `toolVersionInstall({ id, confirm: true })`: install a supported catalog entry.
- `toolVersionSelect({ id })`: return a configuration patch for an installed catalog/build tool.
- `toolVersionDownload({ id, confirm: true })`: create an offline download package.
- `toolVersionExport({ id, confirm: true })`: rescan and export installed tools.
- `toolVersionImport({ path, confirm: true, approval? })`: install a host-local ZIP after review.
- `toolVersionCancel()`: cancel the current transfer.

Desktop, Web and automation share these services. File selection and installation operate on the service computer. More examples: [AI interface](AI-PIPE.md), [offline delivery](OFFLINE-DELIVERY.md).
