import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppState, ProjectConfig } from '../../shared/contracts';
import type { ClangdState } from '../../shared/clangd';
import type {
  LspCodeAction,
  LspCommand,
  LspTextEdit,
  LspWorkspaceFileEdit,
  LspWorkspaceSymbol,
} from '../../shared/lsp';
import {
  lspDidChangeParamsSchema,
  lspDidCloseParamsSchema,
  lspDidOpenParamsSchema,
  lspCompletionParamsSchema,
  lspHoverParamsSchema,
} from '../lsp-schemas';
import { workspacePathFromLspUri } from '../../shared/lsp';
import type { BuildEvidenceStatus } from '../build-dependencies';
import { findClangd, type ClangdInstallation } from './discovery';
import { CLANGD_VERSION, clangdHostSupported } from './manifest';
import { prepareClangdProject } from './compile-commands';
import { ClangdSession } from './session';
import { ClangdTransport } from './transport';
import {
  clangdCodeActionParamsSchema,
  clangdDocumentSymbolParamsSchema,
  clangdExecuteCommandParamsSchema,
  clangdFormattingParamsSchema,
  clangdRangeFormattingParamsSchema,
  clangdWorkspaceSymbolParamsSchema,
  type ClangdRequestInput,
  type ClangdNotifyInput,
  type ClangdDiagnosticsInput,
} from './schemas';

export interface ClangdCore {
  workspaceSnapshot(): Promise<Pick<AppState, 'projectRoot' | 'files'>>;
  currentProjectRoot(): string;
  currentConfig(): ProjectConfig;
  buildEvidenceState?(): Promise<BuildEvidenceStatus>;
}

export class ClangdService {
  private stateCache?: { expires: number; value: ClangdState };
  private session?: { root: string; promise: Promise<ClangdSession> };
  private generation = 0;
  private readonly now: () => number;

  constructor(
    private readonly options: {
      core: ClangdCore;
      dataRoot: string;
      toolchainRoot: string;
      env?: NodeJS.ProcessEnv;
      platform?: NodeJS.Platform;
      arch?: string;
      now?: () => number;
      onLog?: (line: string) => void;
    },
  ) {
    this.now = options.now ?? Date.now;
  }

  private get platform(): NodeJS.Platform {
    return this.options.platform ?? process.platform;
  }
  private get arch(): string {
    return this.options.arch ?? process.arch;
  }

  private async installation(): Promise<ClangdInstallation | undefined> {
    return findClangd({
      toolchainRoot: this.options.toolchainRoot,
      configuredPath: this.options.env?.BLODE_CLANGD_PATH,
      env: this.options.env,
      platform: this.platform,
      arch: this.arch,
    });
  }

  async state(): Promise<ClangdState> {
    if (this.stateCache && this.stateCache.expires > this.now()) return this.stateCache.value;
    const installation = await this.installation().catch(() => undefined);
    const supported = clangdHostSupported(this.platform, this.arch);
    const value: ClangdState = {
      available: !!installation,
      source: installation?.source ?? null,
      path: installation?.path,
      version: installation?.version,
      expectedVersion: CLANGD_VERSION,
      installable: supported,
      hostSupported: supported,
    };
    this.stateCache = { expires: this.now() + 30_000, value };
    return value;
  }

  /** Called after a tool install so availability is visible immediately. */
  invalidate(): void {
    this.stateCache = undefined;
  }

  private requireRoot(expected: string): string {
    const current = this.options.core.currentProjectRoot();
    if (!expected || !current || path.resolve(expected) !== path.resolve(current))
      throw new Error('error.collaborationProjectChanged');
    return current;
  }

  private async createSession(root: string, generation: number): Promise<ClangdSession> {
    const installation = await this.installation();
    if (!installation) throw new Error('error.clangdUnavailable');
    const workspace = await this.options.core.workspaceSnapshot();
    if (path.resolve(workspace.projectRoot) !== path.resolve(root))
      throw new Error('error.collaborationProjectChanged');
    const config = this.options.core.currentConfig();
    const project = await prepareClangdProject({
      root,
      files: workspace.files,
      config,
      toolchainRoot: this.options.toolchainRoot,
      dataRoot: this.options.dataRoot,
      env: this.options.env,
      buildEvidence: await this.options.core.buildEvidenceState?.().catch(() => undefined),
    });
    const transport = ClangdTransport.start({
      executable: installation.path,
      args: [
        `--compile-commands-dir=${project.directory}`,
        '--background-index',
        '--clang-tidy=false',
        '--header-insertion=never',
        '--log=error',
        '--pch-storage=memory',
        '--limit-results=200',
      ],
      cwd: root,
      env: this.options.env,
      onStderr: (line) => this.options.onLog?.(line),
      onExit: () => {
        if (this.session?.root === root) this.session = undefined;
      },
    });
    const session = new ClangdSession({
      transport,
      root,
      fallbackFlags: project.fallbackFlags,
      now: this.now,
    });
    try {
      await session.initialize();
      if (generation !== this.generation) {
        transport.dispose();
        throw new Error('error.clangdUnavailable');
      }
      return session;
    } catch (error) {
      transport.dispose();
      throw error;
    }
  }

  private async ensureSession(root: string): Promise<ClangdSession> {
    if (this.session?.root !== root) {
      await this.closeSession();
      const generation = this.generation;
      const holder = { root, promise: undefined as unknown as Promise<ClangdSession> };
      holder.promise = this.createSession(root, generation).catch((error) => {
        if (this.session === holder) this.session = undefined;
        throw error;
      });
      this.session = holder;
    }
    return this.session.promise;
  }

  private async closeSession(): Promise<void> {
    const current = this.session;
    this.session = undefined;
    this.generation++;
    if (!current) return;
    // A clangd that is still starting may take its full initialize timeout;
    // closing the workspace must not block the UI for that long.
    await Promise.race([
      current.promise.then((session) => session.dispose()).catch(() => undefined),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 3_000);
        timer.unref?.();
      }),
    ]);
  }

  private documentPath(uri: string): string {
    const relative = workspacePathFromLspUri(uri);
    if (!relative) throw new Error('rpc.invalidParams');
    return relative;
  }

  async request(input: ClangdRequestInput): Promise<unknown> {
    const root = this.requireRoot(input.expectedProjectRoot);
    const session = await this.ensureSession(root);
    switch (input.method) {
      case 'textDocument/completion': {
        const parsed = lspCompletionParamsSchema.safeParse(input.params);
        if (!parsed.success) throw new Error('rpc.invalidParams');
        return session.completion(this.documentPath(parsed.data.textDocument.uri), parsed.data.position);
      }
      case 'textDocument/hover': {
        const parsed = lspHoverParamsSchema.safeParse(input.params);
        if (!parsed.success) throw new Error('rpc.invalidParams');
        return session.hover(this.documentPath(parsed.data.textDocument.uri), parsed.data.position);
      }
      case 'textDocument/definition':
      case 'textDocument/references': {
        const parsed = lspHoverParamsSchema.safeParse(input.params);
        if (!parsed.success) throw new Error('rpc.invalidParams');
        const relative = this.documentPath(parsed.data.textDocument.uri);
        return input.method === 'textDocument/definition'
          ? session.definition(relative, parsed.data.position)
          : session.references(relative, parsed.data.position);
      }
      case 'textDocument/formatting': {
        const parsed = clangdFormattingParamsSchema.safeParse(input.params);
        if (!parsed.success) throw new Error('rpc.invalidParams');
        return session.formatting(this.documentPath(parsed.data.textDocument.uri), parsed.data.options);
      }
      case 'textDocument/rangeFormatting': {
        const parsed = clangdRangeFormattingParamsSchema.safeParse(input.params);
        if (!parsed.success) throw new Error('rpc.invalidParams');
        return session.rangeFormatting(
          this.documentPath(parsed.data.textDocument.uri),
          parsed.data.range,
          parsed.data.options,
        );
      }
      case 'textDocument/codeAction': {
        const parsed = clangdCodeActionParamsSchema.safeParse(input.params);
        if (!parsed.success) throw new Error('rpc.invalidParams');
        return this.codeActions(
          root,
          session,
          this.documentPath(parsed.data.textDocument.uri),
          parsed.data.range,
          parsed.data.context,
        );
      }
      case 'workspace/executeCommand': {
        const parsed = clangdExecuteCommandParamsSchema.safeParse(input.params);
        if (!parsed.success) throw new Error('rpc.invalidParams');
        const results = await session.executeCommand(parsed.data.command, parsed.data.arguments);
        return results.flatMap((result) => this.workspaceEdits(result, root));
      }
      case 'workspace/symbol': {
        const parsed = clangdWorkspaceSymbolParamsSchema.safeParse(input.params);
        if (!parsed.success) throw new Error('rpc.invalidParams');
        return this.workspaceSymbols(await session.workspaceSymbols(parsed.data.query), root);
      }
      case 'textDocument/documentSymbol': {
        const parsed = clangdDocumentSymbolParamsSchema.safeParse(input.params);
        if (!parsed.success) throw new Error('rpc.invalidParams');
        return session.documentSymbols(this.documentPath(parsed.data.textDocument.uri));
      }
      default:
        throw new Error('rpc.methodNotFound');
    }
  }

  private relativeUri(uri: unknown, root: string): string | undefined {
    if (typeof uri !== 'string') return undefined;
    let file: string;
    try {
      file = fileURLToPath(uri);
    } catch {
      return undefined;
    }
    const relative = path.relative(root, file);
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))
      return undefined;
    return relative.split(path.sep).join('/');
  }

  private workspaceEdits(result: unknown, root: string): LspWorkspaceFileEdit[] {
    const edit = result as
      | {
          changes?: Record<string, unknown>;
          documentChanges?: unknown[];
        }
      | null
      | undefined;
    const files = new Map<string, LspTextEdit[]>();
    const add = (uri: unknown, edits: unknown) => {
      if (!Array.isArray(edits)) return;
      const relative = this.relativeUri(uri, root);
      if (!relative) return;
      const target = files.get(relative) ?? [];
      for (const item of edits.slice(0, 2_000)) {
        const value = item as { range?: LspTextEdit['range']; newText?: string };
        if (!value?.range?.start || !value.range.end || typeof value.newText !== 'string') continue;
        target.push({ range: value.range, newText: value.newText });
      }
      if (target.length) files.set(relative, target);
    };
    if (edit?.changes && typeof edit.changes === 'object')
      for (const [uri, edits] of Object.entries(edit.changes)) add(uri, edits);
    for (const change of Array.isArray(edit?.documentChanges) ? edit.documentChanges.slice(0, 64) : []) {
      const value = change as { textDocument?: { uri?: unknown }; edits?: unknown };
      if (value?.textDocument?.uri) add(value.textDocument.uri, value.edits);
    }
    return [...files].map(([pathValue, edits]) => ({ path: pathValue, edits }));
  }

  private workspaceSymbols(result: unknown, root: string): LspWorkspaceSymbol[] {
    const items = (Array.isArray(result) ? result : []) as {
      name?: unknown;
      kind?: unknown;
      containerName?: unknown;
      location?: {
        uri?: unknown;
        range?: { start?: { line: number; character: number }; end?: { line: number; character: number } };
      };
    }[];
    const symbols: LspWorkspaceSymbol[] = [];
    for (const item of items.slice(0, 500)) {
      const location = item?.location;
      const relative = this.relativeUri(location?.uri, root);
      const range = location?.range;
      if (typeof item?.name !== 'string' || !relative || !range?.start || !range?.end) continue;
      symbols.push({
        name: item.name,
        kind: typeof item.kind === 'number' ? item.kind : undefined,
        containerName: typeof item.containerName === 'string' ? item.containerName : undefined,
        path: relative,
        line: range.start.line + 1,
        column: range.start.character + 1,
        endLine: range.end.line + 1,
        endColumn: range.end.character + 1,
      });
    }
    return symbols;
  }

  private async codeActions(
    root: string,
    session: ClangdSession,
    relative: string,
    range: unknown,
    context: unknown,
  ): Promise<LspCodeAction[]> {
    const result = await session.codeActions(relative, range, context);
    const items = (Array.isArray(result) ? result.slice(0, 100) : []) as {
      title?: unknown;
      kind?: unknown;
      isPreferred?: unknown;
      diagnostics?: unknown;
      edit?: unknown;
      command?: unknown;
      arguments?: unknown;
      data?: unknown;
    }[];
    const actions: LspCodeAction[] = [];
    for (const item of items) {
      let action = item;
      if (!action.edit && !action.command && action.data) {
        const resolved = (await session.resolveCodeAction(item).catch(() => undefined)) as
          typeof item | undefined;
        if (resolved) action = resolved;
      }
      let command: LspCommand | undefined;
      if (action.command && typeof action.command === 'object') {
        const value = action.command as { title?: unknown; command?: unknown; arguments?: unknown };
        if (typeof value.command === 'string')
          command = {
            title: typeof value.title === 'string' ? value.title : String(action.title),
            command: value.command,
            arguments: Array.isArray(value.arguments) ? (value.arguments as unknown[]) : undefined,
          };
      } else if (typeof action.command === 'string') {
        // clangd quick fixes and tweaks are plain LSP Commands (clangd.applyFix).
        command = {
          title: typeof action.title === 'string' ? action.title : action.command,
          command: action.command,
          arguments: Array.isArray(action.arguments) ? (action.arguments as unknown[]) : undefined,
        };
      }
      const edit = action.edit ? this.workspaceEdits(action.edit, root) : [];
      if (!edit.length && !command) continue;
      actions.push({
        title: typeof action.title === 'string' ? action.title : 'Code action',
        kind: typeof action.kind === 'string' ? action.kind : undefined,
        isPreferred: action.isPreferred === true,
        diagnostics: Array.isArray(action.diagnostics)
          ? (action.diagnostics as LspCodeAction['diagnostics'])
          : undefined,
        ...(edit.length ? { edit } : {}),
        ...(command ? { command } : {}),
      });
    }
    return actions;
  }

  async notify(input: ClangdNotifyInput): Promise<void> {
    const root = this.requireRoot(input.expectedProjectRoot);
    if (!(await this.state()).available) return;
    const session = await this.ensureSession(root);
    for (const message of input.messages) {
      if (message.method === 'textDocument/didOpen') {
        const parsed = lspDidOpenParamsSchema.safeParse(message.params);
        if (!parsed.success) throw new Error('rpc.invalidParams');
        session.didOpen(
          this.documentPath(parsed.data.textDocument.uri),
          parsed.data.textDocument.text,
          parsed.data.textDocument.version,
        );
      } else if (message.method === 'textDocument/didChange') {
        const parsed = lspDidChangeParamsSchema.safeParse(message.params);
        if (!parsed.success) throw new Error('rpc.invalidParams');
        session.didChange(
          this.documentPath(parsed.data.textDocument.uri),
          parsed.data.contentChanges[parsed.data.contentChanges.length - 1]?.text ?? '',
          parsed.data.textDocument.version,
        );
      } else {
        const parsed = lspDidCloseParamsSchema.safeParse(message.params);
        if (!parsed.success) throw new Error('rpc.invalidParams');
        session.didClose(this.documentPath(parsed.data.textDocument.uri));
      }
    }
  }

  async diagnostics(input: ClangdDiagnosticsInput): Promise<{
    items: import('../../shared/lsp').LspDiagnostic[];
    version?: number;
  }> {
    const root = this.requireRoot(input.expectedProjectRoot);
    if (this.session?.root !== root) return { items: [] };
    const session = await this.session.promise.catch(() => undefined);
    return session?.diagnosticsFor(input.path) ?? { items: [] };
  }

  async dispose(): Promise<void> {
    this.stateCache = undefined;
    await this.closeSession();
  }
}
