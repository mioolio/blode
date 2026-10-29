# Product roadmap

This roadmap describes the current implementation and planned validation. It is not a promise of delivery dates. A capability can be implemented while still requiring platform or hardware acceptance testing.

## Implemented capabilities

| Area            | Available behavior                                                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspaces      | Welcome screen, recent project history, project open/close, configurable build entry and portable project ZIP export                              |
| Editors         | C/C++ definitions, declarations, headers and references; incremental source index; versioned JSON C rules; preview/pinned tabs and AI predictions |
| Hardware        | ESP32-S3 and STM32 discovery, offline compilation, prepared firmware programming, selectable export formats and serial communication              |
| Debugging       | Separate STM32/ST-Link/GDB workbench with sampled CPU, registers, memory, firmware storage, breakpoints and logs                                  |
| Teamwork        | Shared browser editing, presence colors, shared open tabs, edit conflict reporting and per-user browser undo                                      |
| Version control | Independent `.blode/git` history with disable/removal controls; explicitly enabled sharing of an existing repository                              |
| Tools           | Wide Preferences layout, installation output, pinned compiler/CLI/core version catalog and custom tool paths                                      |
| Editions        | Electron desktop and a standalone Node.js Web host that excludes Electron/Chromium from its release ZIP                                           |
| Automation      | Validated AI/workbench interfaces with explicit confirmation parameters for sensitive actions                                                     |

Details and limitations are documented in the relevant guides. The entries above describe implemented code paths; they do not imply that every combination of device, operating system and project format has passed acceptance testing.

## Completed lightweight validation

| Scope            | Evidence in this change                                                                                                                                                                                | Limits                                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Git              | Temporary repositories exercise literal-path staging, commits, branches, diffs and rename boundaries; local bare remotes exercise push and fast-forward pull                                           | No mutation or push of the user's current repository; hosted-provider authentication and team merge scenarios still need acceptance testing |
| Project ZIP      | Fixture projects verify standard ZIP records/CRC, external includes and Keil dependency collection, rewritten archive paths, unresolved dependency reporting and unsafe-path rejection                 | A second computer has not yet compiled a shared complex firmware project                                                                    |
| Node Web host    | Temporary-port HTTP tests verify loopback token requirements, empty home state, host folder selection, project open, version catalog, project ZIP download and terminal output in the target directory | Platform runtimes are replaced by fixtures; no physical probe/flash, sustained browser session or Linux host test                           |
| Web distribution | The Node bundle passes an Electron-import check and CLI help runs under Node; the review ZIP was generated and inspected with a serialport-only runtime lockfile                                       | A fresh recipient-machine dependency install and hardware session remain unverified                                                         |
| Tool versions    | Mocked downloads verify host asset names, checksum fallback/rejection, side-by-side selection and isolated pinned ESP32 package stores                                                                 | Large publisher toolchains were not downloaded or installed in this change                                                                  |

The corresponding tests are `tests/git.test.ts`, `tests/project-package.test.ts`, `tests/web-host.test.ts` and `tests/tool-versions.test.ts`. These are service-level results from the Windows development environment, not a claim of cross-machine or physical hardware validation.

## Near-term validation

| Priority | Work                                                                                        | Completion evidence                                                                               |
| -------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| High     | Validate Windows desktop startup and recovery after unexpected termination                  | Repeated launch/close/crash-recovery checks with no orphaned profile locks or blank window        |
| High     | Exercise two or more browser peers editing and undoing overlapping work                     | Recorded scenarios proving conflict reporting, peer-scoped undo and stable reading position       |
| High     | Validate complex imported STM32 projects and portable external dependencies                 | Build shared ZIPs on a clean second workspace using documented tool versions                      |
| High     | Validate firmware export, prepared image programming and GDB sessions on actual hardware    | Target-specific logs and results in the hardware validation guide                                 |
| Medium   | Verify side-by-side tool installation using actual publisher archives                       | Checksums, selected compiler versions and successful builds on each host                          |
| Medium   | Extend the passing disposable Git checks to real team usage and hosted-provider credentials | Reviewed merge/conflict and authentication scenarios against an explicitly authorized test remote |

## Planned platform work

- Perform Linux x64 and ARM64 host installation, build and USB permission testing.
- Establish Linux desktop packaging and startup checks before claiming a verified Linux release.
- Extend browser/device layout testing to smaller screens and multiple input methods.
- Review additional embedded platforms only after their adapters, compiler paths and hardware tests can remain isolated from the core services.

## Future considerations

Potential future work includes richer merge-conflict review, broader compiler-version coverage, project-specific team permissions, additional debugger targets, and more resilient session recovery. These items are exploratory and have no committed schedule.

See [platform support](PLATFORM-SUPPORT.md), [Web host deployment](WEB-HOST.md), [tool versions](TOOL-VERSIONS.md), and [hardware validation](HARDWARE-VALIDATION.md).
