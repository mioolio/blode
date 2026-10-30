# Blode Studio Web host

The Web edition runs a Node.js service on the computer that owns the projects and connected hardware. Users edit through a browser. It contains no Electron or Chromium runtime; the same workspace, collaboration, compiler, Git and debugger services support both editions.

## Requirements

| Requirement                               | Purpose                                                                          |
| ----------------------------------------- | -------------------------------------------------------------------------------- |
| Node.js 24 or newer, with npm             | Run the host and install serialport and node-pty runtime dependencies            |
| A current browser                         | Render the editor and collaboration interface                                    |
| Git on the host's PATH                    | Use the integrated Git interface; existing host credentials handle remote access |
| A suitable installed/downloaded toolchain | Compile the selected platform; a physical device is unnecessary for compilation  |
| Host USB drivers and permissions          | Use serial ports, flash firmware or attach a hardware debugger                   |

Windows is the current development environment. Linux downloads and platform paths are prepared, but actual Linux installation, compilation, packaging and hardware access have **not been verified**. See [platform support](PLATFORM-SUPPORT.md).

The current source on `main` includes an interactive terminal. Linux installation requires Python 3, make and a C/C++ compiler to build `node-pty`; Windows uses its ConPTY runtime. See the [workbench interaction update](internal/workbench-interaction.md).

## Start a Web ZIP release

1. Extract `Blode-Studio-Web-<version>.zip` into a writable directory on the target computer.
2. Install the Node runtime dependencies in that directory:

   ```sh
   npm ci --omit=dev
   ```

3. Start the service:

   ```sh
   npm start
   ```

4. Open the private launch link printed once in the terminal. Keep that link private: its token authorizes access to this host's workspace and hardware functions.

The release contains the bundled Node server, browser assets, a small runtime package manifest and lockfile, and documentation. Compiler binaries, Electron, Chromium, project source, Git credentials and application credentials are excluded. Native runtime dependencies are installed for the recipient's operating system by `npm ci`.

## Start from source

After installing this repository's development dependencies:

```sh
npm run web:build
npm run web:start
```

`web:build` builds the renderer and the standalone host. Its bundle metadata is checked for Electron imports and desktop entry points. The source runner `npm run web:dev` starts the TypeScript host using the already-built renderer; rebuild the renderer after changing its UI.

## Command options

```sh
npm run web:start -- --host 127.0.0.1 --port 47821 --project "/path/to/project" --data-root "/path/to/host-data"
```

For an extracted release, use `npm start --` with the same options.

| Option        | Default                | Behavior                                                             |
| ------------- | ---------------------- | -------------------------------------------------------------------- |
| `--host`      | `127.0.0.1`            | Accepts `127.0.0.1` or `0.0.0.0`; the latter permits LAN access      |
| `--port`      | `47821`                | HTTP port; `0` requests an available port                            |
| `--project`   | No open project        | Open a directory on the service computer                             |
| `--data-root` | OS user data directory | Store history, settings, connection credentials and downloaded tools |
| `--help`      | —                      | Show usage without starting a server                                 |

To allow a trusted LAN:

```sh
npm run web:start -- --host 0.0.0.0 --port 47821
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

The command builds the Web edition, creates a serialport-only runtime lockfile in a temporary staging directory without running install scripts, and writes a standard ZIP under `release/`. It does not package the current working project. An existing ZIP is never overwritten; choose a new destination if necessary:

```sh
npm run package:web -- --output "release/Blode-Web-review.zip"
```

`--skip-build` packages an already-built Web edition. It is intended for release tooling that has just completed `web:build`.

## Validation and limits

The implementation provides a standalone bundle check, CLI argument tests, and a temporary-port HTTP integration test with hardware runtimes replaced by fixtures. These checks do not prove physical flashing, device drivers, large toolchain downloads, real Git remotes or Linux behavior. GUI and hardware acceptance testing remains necessary before distributing a production release.

See [development](DEVELOPMENT.md), [collaboration](COLLABORATION.md), [Git](GIT.md), and [roadmap](ROADMAP.md).
