import * as z from 'zod';
import { configSchema } from '../core/config-schema';
import { aiParameterSchemas } from '../core/ai-schemas';
import { collaborationSchemas } from '../core/collaboration-schemas';
import { uiCommandSchema } from '../core/ui-commands';
import { hostParameterSchemas } from '../core/host-service-schemas';
import {
  breakpointLocationsSchema,
  debuggerPatchSchema,
  debuggerAssembleSchema,
} from '../shared/debugger-edit';

const empty = z.object({}).strict();
const path = z.string().min(1).max(4096);
const file = z.string().min(1).max(1024);
const confirm = z.literal(true);
export const workbenchRouteSchemas = {
  'capabilities.get': empty,
  'file.create': z.object({ path: file }).strict(),
  'directory.create': z.object({ path: file }).strict(),
  'file.rename': z.object({ from: file, to: file }).strict(),
  'file.delete': z.object({ path: file, confirm }).strict(),
  'project.open': z.object({ path }).strict(),
  'project.close': z.object({ confirm }).strict(),
  'recent.list': empty,
  'recent.remove': z.object({ path }).strict(),
  'drivers.status': z.object({ refresh: z.boolean().optional() }).strict(),
  'drivers.install': z.object({ id: z.literal('stlink'), confirm }).strict(),
  'firmware.prepare': z.object({ path }).strict(),
  'firmware.export': z
    .object({ format: z.enum(['bin', 'hex', 'srec', 'elf']), path, confirmOverwrite: confirm.optional() })
    .strict(),
  'firmware.flash': z
    .object({
      id: z.string().min(1).max(128),
      config: configSchema,
      address: z.number().int().min(0).max(0xffffffff).optional(),
      confirm,
    })
    .strict(),
  'debugger.state': z.object({ config: configSchema.optional() }).strict(),
  'debugger.open': empty,
  'debugger.symbols.set': z.object({ path }).strict(),
  'debugger.connect': z.object({ config: configSchema }).strict(),
  'debugger.action': z
    .object({ action: z.enum(['continue', 'pause', 'step', 'next', 'finish', 'disconnect']) })
    .strict(),
  'debugger.breakpoint': z
    .object({ location: z.string().max(1024), removeId: z.string().regex(/^\d+$/).optional() })
    .strict(),
  'debugger.memory': z
    .object({ address: z.number().int().min(0).max(0xffffffff), length: z.number().int().min(1).max(4096) })
    .strict(),
  'debugger.breakpoints': z.object({ locations: breakpointLocationsSchema }).strict(),
  'debugger.patch': debuggerPatchSchema,
  'debugger.assemble': debuggerAssembleSchema,
  'debugger.storage': empty,
  'debugger.tools.install': z.object({ confirm, config: configSchema.optional() }).strict(),
  'debugger.gdb.set': z.object({ path }).strict(),
  'ui.state': empty,
  'ui.command': uiCommandSchema,
  'runtime.view.open': z
    .object({
      id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,79}$/),
      viewId: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,79}$/),
      target: z.string().min(1).max(128).optional(),
    })
    .strict(),
  'window.action': z.object({ action: z.enum(['minimize', 'maximize', 'close']), confirm }).strict(),
  'logs.latest': empty,
  'collaboration.state': collaborationSchemas.state,
  'collaboration.open': collaborationSchemas.open,
  'collaboration.presence': collaborationSchemas.presence,
  'collaboration.edit': collaborationSchemas.edit,
  'collaboration.undo': collaborationSchemas.undo,
  'collaboration.save': collaborationSchemas.save,
  'collaboration.resolve': collaborationSchemas.resolve,
  'collaboration.leave': collaborationSchemas.leave,
  ...aiParameterSchemas,
  ...hostParameterSchemas,
} as const;
export type WorkbenchRouteName = keyof typeof workbenchRouteSchemas;

export const workbenchDescriptions: Record<WorkbenchRouteName, string> = {
  'extensions.state': 'List installed general extensions, permissions, enabled state and official examples.',
  'extensions.review': 'Inspect a host extension folder or ZIP without executing its code.',
  'extensions.install': 'Install the exact reviewed package without enabling it; confirm=true is required.',
  'extensions.enable':
    'Approve the package fingerprint and enable its declared capabilities; confirm=true is required.',
  'extensions.disable': 'Disable an extension and remove its UI contributions.',
  'extensions.remove':
    'Uninstall an extension from the application-managed directory; confirm=true is required.',
  'extensions.configure': 'Update declared settings for an enabled extension.',
  'extensions.export': 'Export a self-contained extension ZIP without machine trust or host credentials.',
  'extensions.context': 'Read the enabled extension context and its settings.',
  'extensions.view': 'Read the isolated document for a declared extension view.',
  'extensions.viewUrl': 'Create an isolated document URL for an enabled extension view.',
  'extensions.openView': 'Open a declared extension window or bottom panel.',
  'model.state': 'Read model provider settings without exposing credentials.',
  'model.configure': 'Configure the host model provider and store a credential with explicit confirmation.',
  'model.test': 'Check the configured provider connection and list available models.',
  'ai.chat.start': 'Ask the configured model or request edits within an explicitly authorized scope.',
  'ai.chat.state': 'Read a private model conversation using its session token.',
  'ai.chat.cancel': 'Stop an active model conversation.',
  'tools.downloadVersion': 'Download a shareable offline tool archive without installing it.',
  'tools.exportVersion': 'Export an installed managed toolchain as an offline ZIP for another client.',
  'devices.packages':
    'List installed device modules, versions and supported chips, independently of toolchain installation.',
  'devices.review': 'Review a device module folder or ZIP without executing its code.',
  'devices.install':
    'Load the exact reviewed device module into the host registry; confirm=true is required. Execution still requires runtime trust.',
  'devices.export':
    'Export a standalone device module ZIP without machine trust or host credentials; confirm=true is required.',
  'tools.importVersion': 'Validate and install a previously downloaded offline tool archive.',
  'tools.cancelVersionTransfer': 'Cancel the current offline tool transfer.',
  'components.export': 'Export configured components and dependencies as a portable ZIP package.',
  'components.state': 'List project components and platform-provided libraries.',
  'components.search': 'Search the Arduino library catalog on explicit request.',
  'components.install':
    'Install a selected Arduino library version and dependencies into the expected project; requires confirm=true.',
  'components.import': 'Import a local host folder or ZIP into the expected project; requires confirm=true.',
  'components.remove':
    'Remove an unchanged managed component from the expected project; requires confirm=true.',
  'runtime.context': 'Read the runtime device context and declared capabilities.',
  'runtime.configure': 'Update selected runtime device values using its declared configuration constraints.',
  'runtime.device':
    'Run a declared action of the selected approved native device runtime. Pass confirm=true when required by its declaration.',
  'runtime.plugins':
    'Inspect declared third-party runtime packages and approval status without executing code.',
  'runtime.trust':
    'Approve native plugin execution after reviewing the package fingerprint. Requires confirm=true; permanent approval writes a machine-bound .uel marker.',
  'runtime.view': 'Read an approved plugin custom interface for an isolated frame.',
  'runtime.view.info': 'Read an approved extension view declaration.',
  'runtime.view.open':
    'Request a declared extension view in one workbench. Browser windows require a user click.',
  'runtime.debug': 'Invoke an approved runtime debug provider method.',
  'language.index': 'Index saved C/C++ workspace symbols and export their source locations.',
  'language.navigate':
    'Resolve source symbols and includes through actual workspace and compiler include directories.',
  'language.cancel': 'Cancel a pending source navigation request in the expected project.',
  'language.openExternal': 'Open a previously resolved external source as read-only in the expected project.',
  'capabilities.get': 'List all available automation capabilities and required confirmations.',
  'file.create': 'Create a project-relative file.',
  'directory.create': 'Create a project-relative directory.',
  'file.rename': 'Rename or move a project-relative entry while preserving shared drafts.',
  'file.delete': 'Delete a project-relative entry; confirm=true is required.',
  'project.open':
    'Save shared drafts and open a project by absolute native path. Local unsynchronized edits must be saved first with ui.command.',
  'project.close':
    'Save shared drafts and close the project without exiting the app; confirm=true is required.',
  'recent.list': 'List recently opened projects.',
  'recent.remove': 'Remove a recent-project record without deleting files.',
  'drivers.status': 'Read or explicitly refresh driver status.',
  'drivers.install': 'Install the ST-Link driver with confirm=true.',
  'firmware.prepare':
    'Prepare an immutable firmware selection from an absolute native file path; does not flash.',
  'firmware.export':
    'Export the verified build to an absolute path. Existing files require confirmOverwrite=true.',
  'firmware.flash': 'Flash a prepared selection after target validation; confirm=true is required.',
  'debugger.state':
    'Read shared debugger state and architecture capabilities; config selects a target and tools before connecting.',
  'debugger.open': 'Open the separate hardware debugger window.',
  'debugger.symbols.set':
    'Select an ELF matching the chosen target architecture, using an absolute native path without flashing.',
  'debugger.connect':
    'Attach to STM32 ST-Link or ESP32-S3 USB-JTAG using the supplied config; never downloads firmware.',
  'debugger.action': 'Continue, pause, step or disconnect the shared debugger.',
  'debugger.breakpoint': 'Add a breakpoint or remove its numeric identifier.',
  'debugger.memory': 'Read up to 4096 bytes of real target memory while paused.',
  'debugger.breakpoints':
    'Add up to 128 breakpoints while paused; return individual added/existing/failed results.',
  'debugger.patch':
    'Replace one SRAM Thumb instruction with expected-byte comparison and readback verification. Requires confirm=true. Running targets require pauseAndResume=true; failures remain paused. Flash is not rewritten.',
  'debugger.assemble':
    'Assemble one Thumb instruction at an address using the selected GNU tools and return bytes without writing hardware.',
  'debugger.storage': 'Inspect the selected local ELF file and segments.',
  'debugger.tools.install': 'Install GNU debugger tools with confirm=true.',
  'debugger.gdb.set': 'Set a trusted native GDB executable path.',
  'ui.state': 'List active desktop/browser workbench UI clients, tabs and dirty files.',
  'ui.command':
    'Apply a named UI action to one client (default desktop), with acknowledgement; no arbitrary JavaScript.',
  'window.action': 'Control the desktop window; confirm=true is required.',
  'logs.latest': 'Read only the latest bounded build/status log snapshot.',
  'collaboration.state': 'Read live collaborators and shared document revisions.',
  'collaboration.open': 'Read a versioned shared document including unsaved edits.',
  'collaboration.presence': 'Publish a collaborator viewport and editing status.',
  'collaboration.edit':
    'Apply UTF-16 offset edits at a base revision; independent changes merge and overlaps return a conflict.',
  'collaboration.undo':
    'Undo or redo one actor edit group; global scope is available only through trusted local transport.',
  'collaboration.save': 'Save exactly the reviewed shared revision to disk.',
  'collaboration.resolve':
    'Resolve a disk conflict against the exact reviewed shared revision and diskContent; does not save automatically.',
  'collaboration.leave': 'Remove an online collaborator presence.',
  'ai.state': 'Read prediction preferences and the builtin/custom completion catalog.',
  'ai.configure':
    'Update the revision-checked completion catalog or enable/disable predictions (default disabled).',
  'ai.prediction.request': 'Publish a bounded editor context for external AI prediction when enabled.',
  'ai.prediction.cancel': 'Invalidate a stale editor prediction request.',
  'ai.predictions.poll': 'Poll fresh external-AI prediction contexts after the previous cursor.',
  'ai.prediction.submit':
    'Supply plain insertion text for the exact active prediction request; stale requests are rejected.',
  'ai.prediction.read': 'Read the suggestion for an active request.',
  'git.status': 'Inspect the host project repository, changed files, branches and remotes.',
  'git.diff': 'Read a bounded staged or working tree diff of a project file.',
  'git.action':
    'Manage staging, commits, branches and remotes. Commit, pull, push and remote removal require confirm=true; host credentials are reused.',
  'tools.versions': 'List supported tool versions, publisher release links and installed versions.',
  'tools.installVersion':
    'Install a catalog tool version side by side with progress; confirm=true is required.',
  'tools.selectVersion': 'Return installed tool paths to apply with config.set; does not edit the project.',
  'host.browse': 'Browse directories on the target machine, not the browser client.',
  'vscode.open':
    'Generate workspace settings and open VS Code on the host; requires confirm=true and the expected project root.',
  'project.package.preview': 'Inspect portable ZIP files, external dependencies and unresolved paths.',
  'project.package.export':
    'Save shared drafts and produce a portable ZIP. External dependencies require confirmExternal=true; unresolved paths require allowIncomplete=true.',
  'terminal.sessions': 'List the host terminal sessions without starting a shell.',
  'terminal.state':
    'Read the target terminal state and ANSI output after a session cursor; does not start a shell.',
  'terminal.open':
    'Open the default shell, reuse terminalId, or create an independent shell with create=true; optional name labels a session. Requires confirm=true.',
  'terminal.run':
    'Run a command in terminalId (default when omitted), preserving that session’s directory and variables; confirm=true is required.',
  'terminal.stop': 'Send Ctrl+C to the host terminal without closing its shell.',
  'terminal.write':
    'Send raw terminal input, including interactive answers or control keys; confirm=true is required.',
  'terminal.resize': 'Set terminal columns and rows for the current session.',
  'terminal.close':
    'Close only the specified terminalId and its child processes; omitting terminalId closes the default session. Requires confirm=true.',
};
