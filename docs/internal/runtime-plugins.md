# Runtime plugins — internal development update

Status: development preview based on 0.2.3.6. The display version is `0.2.3.6-internal`, with `developmentChannel: internal-runtime-plugins`; the base release/package versions remain `0.2.3.6`/`0.2.3-6`. This is not a stable release. The integration branch is `codex/runtime-plugins-internal`; `main` remains the stable source at `193cda2ea5b2705732755f25b8a621d860b52101`.

## Module and debugger follow-up — 2026-10-30

The source now includes a [project component library manager](../COMPONENT-LIBRARIES.md), preserving ESP32 Arduino recipe flags during compilation and correcting debugger startup error reporting. Actual firmware and isolated UI validation are recorded in the [component and ESP32 update](components-and-esp32-recovery.md). No application binaries were built for this update.

The latest source update reorganizes both boards into ten responsibility directories, adds module-owned language declarations, and introduces standalone JavaScript module packaging for binary hosts. ESP32-S3 USB-JTAG debugging and debug tool installation are implemented, with physical acceptance pending. Current validation and migration details are in the [module update](module-packaging.md) and [hardware debugging guide](../HARDWARE-DEBUGGING.md). No new application release was built for this follow-up.

## Earlier workbench follow-up — 2026-10-30

The branch now includes a real PowerShell/ConPTY terminal, declared plugin windows and bottom-panel views, attention-aware collaboration recovery, transactional save/discard on exit, an optional system tray, and a compact UI/copy pass. Setup, behavior and manual acceptance steps are in the [workbench interaction update](workbench-interaction.md).

| Check                                       | Result                                      | Scope                                                                                                                                                                                                                          |
| ------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm test`                                  | 430 passed; zero failures or skips          | Includes real PowerShell 7/5.1 PTYs, stream ordering, immediate interruption, encoding, clipboard fallback, attention epochs, close/commit recovery, declaration/authorization boundaries, UI models and existing regressions. |
| `npm run build`                             | Passed                                      | TypeScript, desktop main/preload/automation and renderer production assets.                                                                                                                                                    |
| `npm run web:build`                         | Passed                                      | Node host, renderer and Electron-import exclusion check.                                                                                                                                                                       |
| `node dist/web-server.cjs --help`           | Passed                                      | Displays `0.2.3.6-internal` without starting hardware services.                                                                                                                                                                |
| `npm run format:check` / `git diff --check` | Passed                                      | Repository style and whitespace checks.                                                                                                                                                                                        |
| Native PTY binary                           | Passed under Electron 45.1.0's Node runtime | Actual Chinese output and process cleanup; no GUI launched.                                                                                                                                                                    |

Vite retains its advisory for large shared/editor chunks; both builds complete successfully. Live tray interaction, browser popup/focus behavior, physical hardware and Linux acceptance remain pending. The prior browser-tool rejection described below still prevents claiming a passing interactive browser run. No stable release or installer is produced by this follow-up.

## Delivery plan

1. Migrate the built-in packages to `Esp32_S3_CAM` and `STM32F103C8T6`, retain legacy project configuration migration, and remove the deleted demonstration projects from this branch.
2. Define versioned plugin declarations for chip coverage, device configuration, capabilities, constraints, compiler ownership, debug integration, resource layout and UI fields.
3. Discover plugin metadata without running its code. Require explicit approval before native plugin execution. Bind persistent approval to the package contents and this installation through `.uel`.
4. Route device discovery, build, programming and debugging through the selected runtime; support USB and physical-device identifiers in addition to serial ports and ST-Link.
5. Improve runtime selectors and the debugger workspace, preserve offline compilation, and expose explicit compiler override controls.
6. Run migration, lifecycle, trust, compiler, debug-routing and UI regression tests, then independently review the integration.
7. Push the internal branch for user acceptance. Do not produce or publish a new stable release from this change.

## Acceptance checklist

- Open a project with a legacy `stm32` or `esp32-s3` descriptor and confirm that its files, build entry and compiler versions survive migration.
- Compile an existing project without connecting hardware. Confirm that the runtime selection names describe its supported chip range.
- Copy a plugin directory to the host's plugin folder, restart the host, and select the runtime. Cancel the execution warning and confirm that no plugin code runs.
- Approve once, exercise its device controls, then restart and confirm that approval is requested again.
- Approve permanently, restart, and verify reuse. Remove `.uel` or change the plugin code and verify that approval is requested again.
- Exercise a fixture USB or physical runtime, its declared compiler and an explicit host-compiler override. Review an invalid tool path or incompatible configuration error.
- Open the separate debugger workspace and check execution controls, disassembly, registers, stack, breakpoints and memory. Exercise an approved replacement debug provider and its custom view.
- Verify keyboard navigation, selection, scrolling and dismissal in the runtime selector on desktop and Web.

Automated evidence and remaining hardware validation are recorded below. Real hardware and Linux acceptance remain separate from fixture tests.

## Verification record — 2026-10-29

| Check                             | Result                                                        | Scope                                                                                                                                                                                                               |
| --------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test`                        | 356 passed, zero failed or skipped                            | Includes legacy migration, isolated platform copies, plugin lifecycle and authorization, compiler ownership and inputs, native debug routing, view tickets, message-bridge VM tests, and UI markup/keyboard models. |
| `npm run build`                   | Passed                                                        | TypeScript, Electron main/preload/automation bundles and renderer production assets. This does not launch the desktop UI.                                                                                           |
| `npm run web:build`               | Passed                                                        | Node host bundle and renderer; the Electron-import exclusion check passed.                                                                                                                                          |
| `node dist/web-server.cjs --help` | Passed                                                        | Displays `0.2.3.6-internal` under Node, without launching a browser.                                                                                                                                                |
| `npm run format:check`            | Passed                                                        | Repository formatting rules.                                                                                                                                                                                        |
| Native GNU Arm GCC 15.2.1         | All three mixed C/C++ sample builds passed                    | Current `STM32F103C8T6` source; Debug `-O0`: 636 B Flash; Release `-Os`: 580 B; Release `-O2`: 616 B. No physical hardware access.                                                                                  |
| Independent review                | Completed; identified issues fixed and covered by regressions | Native fallback authorization, connection ownership, approval revocation, module-cache changes, configuration patch merging, declared input freshness and independent view documents.                               |

Browser interaction, custom HTML execution in an actual embedded window, physical programming/debugging, Linux hosts and arbitrary third-party compiler combinations are not marked as passed. User acceptance is pending. No stable release artifacts were generated for this update.

## Integration and review scope

- Renamed the built-in package directories and project identifiers to `Esp32_S3_CAM` and `STM32F103C8T6`. Legacy `esp32-s3`/`stm32` descriptors and per-language compiler pins migrate when parsed by both the host and descriptor editor. Canonical entries take precedence over duplicate legacy keys without dropping unrelated language settings.
- Retained deletion of the `esp32fff` and `examples/stm32f103-128k` demonstration directories. Their source files are removed from this development branch; historical release and hardware records remain available.
- Keil automatic selection accepts C8/C8T6 for the F103C8 profile and does not silently rename CB/RB/TB devices to C8. The 64 KiB Flash recommendation does not cap explicit user allocations. ESP32-S3 camera wiring remains project-defined.
- Exercised the real Core with a temporary JavaScript USB plugin and a harmless Node compiler fixture: declaration-only discovery, opening a preselected unapproved plugin project, explicit approval, manual device identifiers, build artifacts, consent revocation, and recovery to a built-in configuration.
- Exercised debugger routing with controlled providers and native-method substitutes: builtin/extend/replace ownership, approval before native fallback, connected-provider retention, invalid result rejection, passive sampling checks, and release of the hardware lock.
- Independently reviewed package integrity, `.uel` handling, trust revocation, compiler ownership, module-cache consistency, resource cleanup, configuration patch merging, and the custom-view document boundary. Full toolchains are streamed for fingerprinting rather than buffered as one file.

The compiler fixture and substituted debugger methods do not enumerate, connect to, program, or debug physical hardware. Real GNU compilation from the stable baseline does not establish compatibility for every new third-party plugin or forced compiler combination.

## Custom-view document boundary

Custom device/debug HTML loads from a separate document, rather than `srcdoc`, so the view can use its own restrictive CSP without relaxing the main workbench's script policy. Desktop uses `blode-runtime-ui:`; Web uses a random, single-use view ticket that expires after 15 seconds and carries no host access token. The document request rechecks package approval. An opaque-origin sandbox and an explicit message bridge mediate configuration, declared device actions and debugger operations.

Service-level regression tests check the ticket and authorization boundaries. End-to-end browser execution of plugin scripts, bridge interactions, selector navigation, and the new debugger layout is still awaiting user acceptance.

## Browser acceptance not completed

The attempted computer-use browser QA was rejected by automatic approval review because the Windows test page URL could not be reliably determined. No browser clicks were performed, and the disposable QA server was closed. This is an unexecuted validation step, not a passing browser result.

Manual acceptance should confirm keyboard navigation and filtering in runtime selectors, consent-dialog cancellation and permanent approval, custom view loading, `window.blodeRuntime` configuration/device calls, and debugger controls in both desktop and Web modes. Real hardware and Linux behavior remain unverified in this internal update.
