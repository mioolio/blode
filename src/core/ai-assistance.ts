import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { listLanguageCompletions } from '../../extensions/completions';
import type { LogEvent } from '../shared/contracts';
import type {
  AiAssistanceApi,
  AiAssistanceConfiguration,
  AiAssistanceState,
  AiPredictionContext,
  AiPredictionRequest,
  AiPredictionSuggestion,
} from '../shared/ai';
import { aiParameterSchemas } from './ai-schemas';

interface Options {
  dataRoot: string;
  projectRoot: () => string | Promise<string>;
  emit?: (event: LogEvent) => void;
  now?: () => number;
}
type StoredState = Omit<AiAssistanceState, 'builtins'>;
const initial = (): StoredState => ({
  revision: 0,
  predictionEnabled: false,
  useBuiltins: true,
  entries: [],
});
const MAX_ACTIVE = 32;
const TTL = 60_000;

/** External AI supplies predictions; this service never connects to a model or stores credentials. */
export class AiAssistance implements AiAssistanceApi {
  private config = initial();
  private readonly configFile: string;
  private readonly ready: Promise<void>;
  private mutation: Promise<unknown> = Promise.resolve();
  private sequence = 0;
  private requests = new Map<string, AiPredictionRequest>();
  private suggestions = new Map<string, AiPredictionSuggestion>();
  private readonly now: () => number;

  constructor(private readonly options: Options) {
    this.configFile = path.join(options.dataRoot, 'ai-assistance.json');
    this.now = options.now ?? Date.now;
    this.ready = this.restore();
  }
  private async restore() {
    try {
      const text = await fs.readFile(this.configFile, 'utf8');
      if (text.length > 1_000_000) return;
      const parsed = aiParameterSchemas['ai.configure'].parse(JSON.parse(text));
      this.config = { ...initial(), ...parsed };
    } catch {
      /* Missing or invalid preferences retain safe disabled defaults. */
    }
  }
  private emit(message: string) {
    this.options.emit?.({
      kind: 'status',
      level: 'info',
      message,
      time: new Date(this.now()).toISOString(),
      progressOnly: true,
    });
  }
  async aiAssistanceState(): Promise<AiAssistanceState> {
    await this.ready;
    return structuredClone({ ...this.config, builtins: [...listLanguageCompletions()] });
  }
  async aiAssistanceConfigure(input: AiAssistanceConfiguration): Promise<AiAssistanceState> {
    const request = aiParameterSchemas['ai.configure'].parse(input);
    const update = this.mutation.then(async () => {
      await this.ready;
      if (request.revision !== this.config.revision) throw new Error('error.aiRevisionConflict');
      const next: StoredState = {
        revision: this.config.revision + 1,
        predictionEnabled: request.predictionEnabled ?? this.config.predictionEnabled,
        useBuiltins: request.resetCatalog ? true : (request.useBuiltins ?? this.config.useBuiltins),
        entries: request.resetCatalog ? [] : (request.entries ?? this.config.entries),
      };
      const seen = new Set<string>();
      for (const item of next.entries) {
        const key = `${item.language}\0${item.owner ?? ''}\0${item.name}`;
        if (seen.has(key)) throw new Error('error.aiDuplicateEntry');
        seen.add(key);
      }
      const text = JSON.stringify(next, null, 2);
      if (Buffer.byteLength(text) > 1_000_000) throw new Error('rpc.limitExceeded');
      await fs.mkdir(this.options.dataRoot, { recursive: true });
      const temporary = `${this.configFile}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, text, { flag: 'wx' });
        await fs.rename(temporary, this.configFile);
      } finally {
        await fs.rm(temporary, { force: true });
      }
      this.config = next;
      if (!next.predictionEnabled) {
        this.requests.clear();
        this.suggestions.clear();
      }
      this.emit('status.aiAssistanceChanged');
      return this.aiAssistanceState();
    });
    this.mutation = update.catch(() => {});
    return update;
  }
  private prune() {
    for (const [id, request] of this.requests) {
      if (Date.parse(request.expiresAt) <= this.now()) {
        this.requests.delete(id);
        this.suggestions.delete(id);
      }
    }
  }
  private async current(id: string): Promise<AiPredictionRequest> {
    await this.ready;
    this.prune();
    const request = this.requests.get(id);
    const root = await this.options.projectRoot();
    if (
      !this.config.predictionEnabled ||
      !request ||
      this.requests.get(id) !== request ||
      request.projectRoot !== root
    )
      throw new Error('error.aiPredictionStale');
    return request;
  }
  async aiPredictionRequest(input: AiPredictionContext): Promise<AiPredictionRequest | null> {
    const context = aiParameterSchemas['ai.prediction.request'].parse(input);
    await this.ready;
    if (!this.config.predictionEnabled) return null;
    if (context.projectRoot !== (await this.options.projectRoot()))
      throw new Error('error.aiPredictionStale');
    if (!this.config.predictionEnabled) return null;
    this.prune();
    for (const [id, request] of this.requests)
      if (request.editorId === context.editorId) {
        this.requests.delete(id);
        this.suggestions.delete(id);
      }
    if (this.requests.size >= MAX_ACTIVE) {
      const oldest = this.requests.keys().next().value!;
      this.requests.delete(oldest);
      this.suggestions.delete(oldest);
    }
    const request: AiPredictionRequest = {
      ...context,
      id: randomUUID(),
      sequence: ++this.sequence,
      createdAt: new Date(this.now()).toISOString(),
      expiresAt: new Date(this.now() + TTL).toISOString(),
    };
    this.requests.set(request.id, request);
    this.emit(`status.aiPredictionRequested ${request.id}`);
    return structuredClone(request);
  }
  async aiPredictionCancel(input: { editorId: string; requestId?: string }): Promise<void> {
    const request = aiParameterSchemas['ai.prediction.cancel'].parse(input);
    for (const [id, current] of this.requests)
      if (current.editorId === request.editorId && (!request.requestId || id === request.requestId)) {
        this.requests.delete(id);
        this.suggestions.delete(id);
      }
  }
  async aiPredictionPoll(input: { after?: number } = {}) {
    const { after = 0 } = aiParameterSchemas['ai.predictions.poll'].parse(input);
    await this.ready;
    this.prune();
    const root = await this.options.projectRoot();
    return {
      cursor: this.sequence,
      requests: this.config.predictionEnabled
        ? structuredClone(
            [...this.requests.values()].filter(
              (item) => item.sequence > after && item.projectRoot === root && !this.suggestions.has(item.id),
            ),
          )
        : [],
    };
  }
  async aiPredictionSubmit(input: { requestId: string; text: string }): Promise<AiPredictionSuggestion> {
    const submission = aiParameterSchemas['ai.prediction.submit'].parse(input);
    await this.current(submission.requestId);
    if (!this.config.predictionEnabled || !this.requests.has(submission.requestId))
      throw new Error('error.aiPredictionStale');
    const previous = this.suggestions.get(submission.requestId);
    if (previous && previous.text !== submission.text) throw new Error('error.aiPredictionStale');
    const suggestion = previous ?? { ...submission, createdAt: new Date(this.now()).toISOString() };
    this.suggestions.set(submission.requestId, suggestion);
    this.emit(`status.aiPredictionReady ${submission.requestId}`);
    return structuredClone(suggestion);
  }
  async aiPredictionRead(input: { requestId: string }): Promise<AiPredictionSuggestion | null> {
    const { requestId } = aiParameterSchemas['ai.prediction.read'].parse(input);
    try {
      await this.current(requestId);
    } catch {
      return null;
    }
    return structuredClone(this.suggestions.get(requestId) ?? null);
  }
}
