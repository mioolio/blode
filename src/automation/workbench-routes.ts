import * as z from 'zod';
import { configSchema } from '../core/config';
import { aiParameterSchemas } from '../core/ai-schemas';
import { collaborationSchemas } from '../core/collaboration-schemas';
import { uiCommandSchema } from '../core/ui-commands';
import { hostParameterSchemas } from '../core/host-service-schemas';

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
  'debugger.state': empty,
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
  'debugger.storage': empty,
  'debugger.tools.install': z.object({ confirm }).strict(),
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
  'debugger.state': 'Read the shared hardware debugger state.',
  'debugger.open': 'Open the separate hardware debugger window.',
  'debugger.symbols.set': 'Select ARM ELF symbols using an absolute native path, without flashing.',
  'debugger.connect': 'Attach the debugger to the selected ST-Link; never downloads firmware.',
  'debugger.action': 'Continue, pause, step or disconnect the shared debugger.',
  'debugger.breakpoint': 'Add a breakpoint or remove its numeric identifier.',
  'debugger.memory': 'Read up to 4096 bytes of real target memory while paused.',
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
  'project.package.preview': 'Inspect portable ZIP files, external dependencies and unresolved paths.',
  'project.package.export':
    'Save shared drafts and produce a portable ZIP. External dependencies require confirmExternal=true; unresolved paths require allowIncomplete=true.',
  'terminal.state':
    'Read the target terminal state and ANSI output after a session cursor; does not start a shell.',
  'terminal.open':
    'Open or reuse a persistent interactive shell on the target machine; confirm=true is required.',
  'terminal.run':
    'Submit a command to the persistent target shell, preserving its directory and variables; confirm=true is required.',
  'terminal.stop': 'Send Ctrl+C to the host terminal without closing its shell.',
  'terminal.write':
    'Send raw terminal input, including interactive answers or control keys; confirm=true is required.',
  'terminal.resize': 'Set terminal columns and rows for the current session.',
  'terminal.close': 'Close the host terminal and its child processes; confirm=true is required.',
};
