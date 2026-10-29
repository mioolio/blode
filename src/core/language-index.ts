import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { WorkspaceLanguageIndex } from '../shared/language-index';
import type { LanguageIndexSnapshot } from '../shared/language';
import type { CoreService } from './service';
import { safeWorkspacePath } from './workspace';

/** Saved-source index; editor drafts are indexed independently in each window. */
export class LanguageIndexService {
  private index = new WorkspaceLanguageIndex();
  private root = '';
  private pending: Promise<LanguageIndexSnapshot> | undefined;
  private fingerprint = '';
  constructor(private readonly core: Pick<CoreService, 'workspaceSnapshot'>) {}
  async snapshot(): Promise<LanguageIndexSnapshot> {
    if (this.pending) return this.pending;
    const pending = this.load();
    this.pending = pending;
    try {
      return await pending;
    } finally {
      if (this.pending === pending) this.pending = undefined;
    }
  }
  private async load(): Promise<LanguageIndexSnapshot> {
    const workspace = await this.core.workspaceSnapshot();
    if (workspace.projectRoot !== this.root) {
      this.root = workspace.projectRoot;
      this.fingerprint = '';
      this.index = new WorkspaceLanguageIndex();
    }
    this.index.update(workspace.files);
    const snapshot = this.index.snapshot(this.root);
    if (!this.root) return snapshot;
    const fingerprint = createHash('sha256');
    for (const file of workspace.files)
      fingerprint.update(file.path).update('\0').update(file.content).update('\0');
    const hash = fingerprint.digest('hex');
    if (hash !== this.fingerprint) {
      const directory = await safeWorkspacePath(this.root, '.blode/index', { internal: true });
      await fs.mkdir(directory, { recursive: true });
      const file = await safeWorkspacePath(this.root, '.blode/index/symbols-v1.json', { internal: true });
      // The cache is a derived export. Never load it to choose compiler inputs.
      await fs.writeFile(file, JSON.stringify({ ...snapshot, fingerprint: hash }));
      this.fingerprint = hash;
    }
    return snapshot;
  }
}
