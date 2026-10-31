import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AppState } from '../shared/contracts';
import type { ExplorerState } from '../shared/explorer';
import { safeWorkspacePath } from './workspace';

const RELATIVE_FILE = '.blode/explorer.json';
const MAX_BYTES = 1_000_000;
const MAX_COLLAPSED = 5000;

const empty = (): ExplorerState => ({ version: 1, collapsed: [], rootCollapsed: false });
const validPath = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 1024 &&
  !value.startsWith('/') &&
  !value.startsWith('\\') &&
  !/[\\\0\r\n]/.test(value) &&
  value.split('/').every((part) => part && part !== '.' && part !== '..');

/** Per-project view state in `.blode`; corrupt or oversized files fall back to defaults. */
export class ExplorerStateStore {
  constructor(
    private readonly core: {
      workspaceSnapshot(): Promise<Pick<AppState, 'projectRoot' | 'inventory'>>;
      currentProjectRoot(): string;
    },
  ) {}

  private async directories(root: string): Promise<Set<string> | undefined> {
    const workspace = await this.core.workspaceSnapshot().catch(() => undefined);
    if (!workspace || path.resolve(workspace.projectRoot) !== path.resolve(root)) return undefined;
    if (workspace.inventory.truncated) return undefined;
    return new Set(
      workspace.inventory.entries
        .filter((entry) => entry.kind === 'directory')
        .map((entry) => entry.path.replaceAll('\\', '/')),
    );
  }

  private normalize(value: ExplorerState, known: Set<string> | undefined): ExplorerState {
    const collapsed = [
      ...new Set(value.collapsed.filter(validPath).filter((item) => !known || known.has(item))),
    ]
      .sort()
      .slice(0, MAX_COLLAPSED);
    return { version: 1, collapsed, rootCollapsed: value.rootCollapsed === true };
  }

  async state(): Promise<ExplorerState> {
    const root = this.core.currentProjectRoot();
    if (!root) return empty();
    let file: string;
    try {
      file = await safeWorkspacePath(root, RELATIVE_FILE, { internal: true });
    } catch {
      return empty();
    }
    const stat = await fs.stat(file).catch(() => null);
    if (!stat?.isFile() || stat.size > MAX_BYTES) return empty();
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
      if (!parsed || typeof parsed !== 'object') return empty();
      const value = parsed as Partial<ExplorerState>;
      if (value.version !== 1 || !Array.isArray(value.collapsed)) return empty();
      return this.normalize(
        { version: 1, collapsed: value.collapsed, rootCollapsed: value.rootCollapsed === true },
        await this.directories(root),
      );
    } catch {
      return empty();
    }
  }

  async save(expectedProjectRoot: string, state: ExplorerState): Promise<void> {
    const current = this.core.currentProjectRoot();
    if (!expectedProjectRoot || !current || path.resolve(expectedProjectRoot) !== path.resolve(current))
      throw new Error('error.collaborationProjectChanged');
    const normalized = this.normalize(state, await this.directories(current));
    const text = JSON.stringify(normalized, null, 2);
    if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('rpc.limitExceeded');
    const directory = await safeWorkspacePath(current, '.blode', { internal: true });
    await fs.mkdir(directory, { recursive: true });
    const file = await safeWorkspacePath(current, RELATIVE_FILE, { internal: true });
    const temporary = await safeWorkspacePath(current, `.blode/explorer.json.${randomUUID()}.tmp`, {
      internal: true,
    });
    try {
      await fs.writeFile(temporary, text, { flag: 'wx' });
      await fs.rename(temporary, file);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
}
