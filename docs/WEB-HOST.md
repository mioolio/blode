# Blode Studio Web host

The Web edition runs a Node.js service on the computer that owns the projects and connected hardware. Users edit through a browser. It contains no Electron or Chromium runtime; the same workspace, collaboration, compiler, Git and debugger services support both editions.

## Requirements

| Requirement                               | Purpose                                                                          |
| ----------------------------------------- | -------------------------------------------------------------------------------- |
| Windows x64 (packaged EXE)                | The executable already contains the Node host and native device runtimes         |
| Node.js 24 or newer, with npm (source)    | Only for running the host from a checkout or building a release                  |
| A current browser                         | Render the editor and collaboration interface                                    |
| Git on the host's PATH                    | Use the integrated Git interface; existing host credentials handle remote access |
| A suitable installed/downloaded toolchain | Compile the selected platform; a physical device is unnecessary for compilation  |
| Host USB drivers and permissions          | Use serial ports, flash firmware or attach a hardware debugger                   |

Windows is the current development environment. Linux downloads and platform paths are prepared, but actual Linux installation, compilation, packaging and hardware access have **not been verified**. See [platform support](PLATFORM-SUPPORT.md).

The current source on `main` includes an interactive terminal. Linux installation requires Python 3, make and a C/C++ compiler to build `node-pty`; Windows uses its ConPTY runtime. See the [workbench interaction update](internal/workbench-interaction.md).

## Start the packaged Web executable

The Web edition is shipped as one Windows x64 executable, `Blode.Studio-<release>-web-win-x64.exe`. It contains the browser assets, the Node host and the SerialPort/PTY runtimes. Electron, Chromium, compilers and project files are excluded, and the target computer does not need Node.js or npm.

1. Copy the executable to a writable folder and run it.
2. On first start it extracts its runtime once into the host data directory (`%LOCALAPPDATA%\Blode Studio Web\runtime\bundle-<hash>`), then prints the private launch link.
3. The default browser opens that link automatically. Add `--no-open` to keep the link terminal-only.
4. Keep the link private: its token authorizes access to this host's workspace and hardware functions.

If the executable exits immediately, double-clicking keeps the console open and prints the reason; a missing write permission for the data directory is the usual cause. Pass `--data-root` with a writable folder or check the folder permissions.

The executable is about 96 MiB and starts the same host as `npm start` in a source checkout. The extracted runtime is keyed by the payload hash, so a newer release never mixes with an older cache; a matching `.sha256` file accompanies every build. Compiler toolchains, the ST-Link archive and `tools/` are still installed or selected on the host after the first launch.

## Start from source

After installing this repository's development dependencies:

```sh
npm run web:build
npm run web:start
```

`web:build` builds the renderer and the standalone host. Its bundle metadata is checked for Electron imports and desktop entry points. The source runner `npm run web:dev` starts the TypeScript host using the already-built renderer; rebuild the renderer after changing its UI.

## Command options

```sh
Blode.Studio-0.3.4.5-web-win-x64.exe --host 127.0.0.1 --port 47821 --project "D:\firmware\my-device" --data-root "D:\blode-data"
```

The source runner accepts the same options with `npm run web:start --`.

| Option        | Default                | Behavior                                                             |
| ------------- | ---------------------- | -------------------------------------------------------------------- |
| `--host`      | `127.0.0.1`            | Accepts `127.0.0.1` or `0.0.0.0`; the latter permits LAN access      |
| `--port`      | `47821`                | HTTP port; `0` requests an available port                            |
| `--project`   | No open project        | Open a directory on the service computer                             |
| `--data-root` | OS user data directory | Store history, settings, connection credentials and downloaded tools |
| `--no-open`   | Browser opens          | Packaged executable only: print the link without opening a browser   |
| `--version`   | —                      | Packaged executable only: print the release version and exit         |
| `--help`      | —                      | Show usage without starting a server                                 |

To allow a trusted LAN:

```sh
Blode.Studio-0.3.4.5-web-win-x64.exe --host 0.0.0.0 --port 47821
```

Use the LAN address printed in the launch link. All browser API requests require the generated token, including connections from the host itself. Access uses an IP address or localhost; custom Host domains are rejected. The default HTTP service is intended for local or trusted LAN use. Public deployment, TLS termination and a configurable reverse-proxy domain allowlist require additional implementation and validation.

Press **Ctrl+C** to stop the service and release its HTTP connections, automation socket, terminal processes and hardware debugger session. Each host data directory owns a separate automation endpoint. Run multiple instances with separate data directories and ports.

When the desktop development session enables `web.allowExternal`, browser clients use the service port and the built renderer at the same origin. The desktop editor continues to use Vite. Rebuild the renderer after UI changes with `npm run build`.

On Windows, run `scripts/enable-lan-access.ps1` in an administrator PowerShell to allow the service through the firewall. It detects the listening program and grants TCP access to `LocalSubnet` across network profiles. The default port is `47821`; use `-Port` to select another listening port. The rule applies to the current subnet without listing individual client IP addresses.

## Host files and hardware

The **Open folder** picker browses the service computer's directories. It does not ask the browser user to upload their own computer's folder. Recent projects also refer to the service computer. Users sharing one host work in its current project; changing or closing that project affects the shared workspace.

Compilation runs on the host and works without connecting a device. Flashing and hardware debugging use devices physically accessible to the host. Firmware files, export destinations, ELF symbols and custom GDB executables are selected on the host. The hardware debugger opens a separate browser tab, using the same service and hardware lock.

Device detection initializes once. Use the device **Refresh** action after changing hardware on the standalone host. The browser refresh shortcut reloads the interface and retained state; it does not intentionally trigger repeated hardware discovery.

Tool installation output is streamed to Preferences. Selecting a compiler or Arduino core version updates the host project's tool configuration. See [compiler and tool versions](TOOL-VERSIONS.md).

## Collaboration and automation

Browser peers receive their own identity and color. Presence, open tabs, shared edits and the newest compiler output are delivered through the common service. Browser undo is restricted to the peer's own changes; trusted local automation is a separate channel. Conflicting edits are reported for explicit resolution.

The local authenticated automation pipe is available to external AI integrations. The Web host reuses the same validated workbench actions and confirmation parameters. Window minimize/maximize/close operations are desktop-only. Prediction suggestions are supplied by a connected external AI and remain disabled until enabled in Preferences.

## Build a Web release

```sh
npm run package:web
```

The command builds the renderer and host, then embeds both plus the SerialPort/node-pty runtime into one executable under `release/<releaseVersion>/` and writes a matching `.sha256`. The build needs Windows x64, Node.js 24 and the installed `npm ci` dependencies (the single-executable injection uses `postject`). It does not package the current working project. An existing executable is never overwritten; choose a new destination if necessary:

```sh
npm run package:web -- --output "release/Blode-Web-review.exe"
```

`--skip-build` packages an already-built `dist/`. The executable embeds the Node runtime that ran the packaging command, so release builds must use the official Windows x64 `node.exe`; other platforms need their own runtime and are rejected with a clear error.

The payload is a single deflated archive: the browser build, the host bundle, the built-in extension examples and the pruned native runtime (Windows x64 prebuilds only). It is not a source archive and contains no `package.json` install step. After extraction the payload is verified by content hash before the host starts; a damaged or partial extraction is reported as `error.webBundleRead`, `error.webBundleWrite` or `error.webBundleInstall`, and the temporary directory is never reused as a finished runtime.

## Validation and limits

The implementation provides a standalone bundle check, CLI argument tests, and a temporary-port HTTP integration test with hardware runtimes replaced by fixtures. The packaged executable was additionally checked with `--help`, `--version`, five clean first starts, a cached restart and an end-to-end page/RPC/terminal session. These checks do not prove physical flashing, device drivers, large toolchain downloads, real Git remotes or Linux behavior. GUI and hardware acceptance testing remains necessary before distributing a production release.

See [development](DEVELOPMENT.md), [collaboration](COLLABORATION.md), [Git](GIT.md), and [roadmap](ROADMAP.md).
