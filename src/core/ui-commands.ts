import { randomUUID } from 'node:crypto';
import * as z from 'zod';
import type { UiCommand, UiCommandReply, UiRequest, UiState } from '../shared/workbench';

export const uiCommandSchema = z
  .object({
    action: z.enum([
      'home',
      'project',
      'view',
      'openFile',
      'closeFile',
      'pinFile',
      'preferences',
      'save',
      'console',
      'consolePanel',
      'devicePanel',
      'editor',
      'splitEditor',
      'language',
      'syncDrafts',
      'clearLogs',
    ]),
    target: z.string().min(1).max(128).optional(),
    path: z.string().min(1).max(1024).optional(),
    view: z.enum(['code', 'layout', 'ai']).optional(),
    tab: z.enum(['output', 'serial', 'problems', 'warnings', 'terminal']).optional(),
    visible: z.boolean().optional(),
    language: z.enum(['zh-CN', 'en']).optional(),
    command: z.enum(['undo', 'redo', 'find', 'format', 'gotoLine', 'selectAll']).optional(),
  })
  .strict();
export const uiStateSchema = z
  .object({
    clientId: z.string().min(1).max(128),
    browser: z.boolean(),
    projectRoot: z.string().max(4096),
    activePath: z.string().max(1024),
    openFiles: z.array(z.string().max(1024)).max(256),
    view: z.string().max(32),
    home: z.boolean(),
    dirtyFiles: z.array(z.string().max(1024)).max(256),
    busy: z.string().max(128),
    consolePanelVisible: z.boolean(),
    devicePanelVisible: z.boolean(),
  })
  .strict();
export const uiReplySchema = z
  .object({
    id: z.string().uuid(),
    clientId: z.string().min(1).max(128),
    error: z.string().max(4096).optional(),
  })
  .strict();

/** Acknowledged UI actions, targeted to one renderer rather than broadcast execution. */
export class UiCommands {
  private clients = new Map<string, { state: UiState; seenAt: number }>();
  private pending = new Map<
    string,
    {
      target: string;
      resolve: () => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(private readonly publish: (request: UiRequest) => void) {}
  publishState(input: UiState) {
    const state = uiStateSchema.parse(input);
    this.clients.set(state.clientId, { state, seenAt: Date.now() });
    for (const [id, entry] of this.clients) if (Date.now() - entry.seenAt > 60_000) this.clients.delete(id);
    while (this.clients.size > 128) this.clients.delete(this.clients.keys().next().value!);
  }
  state() {
    return [...this.clients.values()]
      .filter((entry) => Date.now() - entry.seenAt <= 60_000)
      .map((entry) => structuredClone(entry.state));
  }
  async command(input: UiCommand) {
    if (this.pending.size >= 32) throw new Error('error.busy');
    const command = uiCommandSchema.parse(input);
    const available = this.state();
    const target =
      command.target ??
      available.find((state) => !state.browser)?.clientId ??
      available[0]?.clientId ??
      'desktop';
    if (!this.state().some((state) => state.clientId === target)) throw new Error('error.uiUnavailable');
    const id = randomUUID();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('error.uiTimeout'));
      }, 15_000);
      timer.unref();
      this.pending.set(id, { target, resolve, reject, timer });
      this.publish({ ...command, id, target });
    });
    return { applied: true, target };
  }
  reply(input: UiCommandReply) {
    const reply = uiReplySchema.parse(input);
    const pending = this.pending.get(reply.id);
    if (!pending || pending.target !== reply.clientId) return;
    clearTimeout(pending.timer);
    this.pending.delete(reply.id);
    if (reply.error) pending.reject(new Error(reply.error));
    else pending.resolve();
  }
  dispose() {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('error.operationCancelled'));
    }
    this.pending.clear();
    this.clients.clear();
  }
}
