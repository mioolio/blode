import type { ModelProviderPreset } from '../../shared/model-service';
import { abortable } from './cancellation';

export const modelProviderPresets: ModelProviderPreset[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    documentation: 'https://api-docs.deepseek.com/',
  },
  {
    id: 'qwen',
    name: '通义千问 Qwen',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    documentation: 'https://help.aliyun.com/en/model-studio/compatibility-of-openai-with-dashscope',
  },
  {
    id: 'siliconflow',
    name: '硅基流动 SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'Qwen/Qwen3-8B',
    documentation: 'https://docs.siliconflow.cn/docs/api/chat-completions-post',
  },
  {
    id: 'custom',
    name: '自定义 / Compatible API',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: '',
    documentation: '',
  },
];
export function modelBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('error.aiBaseUrl');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('error.aiBaseUrl');
  return url.href.replace(/\/+$/, '');
}
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_call_id?: string;
  tool_calls?: ProviderToolCall[];
}
export interface ProviderToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}
export interface ProviderTool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}
export interface ProviderConfiguration {
  baseUrl: string;
  model: string;
  apiKey?: string;
  provider: string;
}
export interface CompletionResult {
  content: string;
  toolCalls: ProviderToolCall[];
  finishReason?: string;
}
interface Options {
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

async function boundedText(response: Response, limit: number, signal?: AbortSignal) {
  if (!response.body) return '';
  const reader = response.body.getReader(),
    decoder = new TextDecoder('utf-8', { fatal: true });
  let text = '',
    size = 0;
  try {
    while (true) {
      const item = await abortable(reader.read(), signal);
      if (item.done) break;
      size += item.value.byteLength;
      if (size > limit) throw new Error('error.aiResponseTooLarge');
      text += decoder.decode(item.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
function providerStatus(status: number) {
  return new Error(
    status === 401 || status === 403
      ? 'error.aiAuthentication'
      : status === 429
        ? 'error.aiRateLimited'
        : status === 404
          ? 'error.aiModelUnavailable'
          : `error.aiServiceUnavailable: ${status}`,
  );
}
function safeTransportError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    /^(?:error\.ai(?:Authentication|RateLimited|ModelUnavailable|KeyMissing|RequestCancelled|Timeout|Network|InvalidResponse|ResponseTooLarge|ModelMissing)|error\.aiServiceUnavailable: [1-5]\d\d)$/.test(
      error.message,
    )
  );
}
function responseError(value: any): void {
  if (!value?.error) return;
  const code = String(value.error.code ?? value.error.type ?? '').toLowerCase();
  throw new Error(
    /(?:authentication|invalid_api_key|unauthorized)/.test(code)
      ? 'error.aiAuthentication'
      : /(?:rate_limit|insufficient_quota)/.test(code)
        ? 'error.aiRateLimited'
        : 'error.aiInvalidResponse',
  );
}
function finishReason(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === 'length') throw new Error('error.aiResponseTooLarge');
  if (value !== 'stop' && value !== 'tool_calls') throw new Error('error.aiInvalidResponse');
  return value;
}

/** OpenAI-compatible HTTP transport; credentials stay inside the host process. */
export class ModelProviderClient {
  constructor(private readonly options: Options = {}) {}
  private async response(
    config: ProviderConfiguration,
    resource: string,
    body?: unknown,
    signal?: AbortSignal,
  ) {
    if (signal?.aborted) throw new Error('error.aiRequestCancelled');
    const base = modelBaseUrl(config.baseUrl);
    if (!config.apiKey && !(config.provider === 'custom' && new URL(base).protocol === 'http:'))
      throw new Error('error.aiKeyMissing');
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 90_000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await abortable(
        (this.options.fetcher ?? fetch)(`${base}/${resource}`, {
          method: body === undefined ? 'GET' : 'POST',
          redirect: 'error',
          headers: {
            'Content-Type': 'application/json',
            ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: combined,
        }),
        combined,
      );
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw providerStatus(response.status);
      }
      return { response, signal: combined };
    } catch (error) {
      if (signal?.aborted) throw new Error('error.aiRequestCancelled');
      if (timeout.aborted) throw new Error('error.aiTimeout');
      if (safeTransportError(error)) throw error;
      throw new Error('error.aiNetwork');
    }
  }
  async models(config: ProviderConfiguration, signal?: AbortSignal): Promise<string[]> {
    const { response, signal: readingSignal } = await this.response(config, 'models', undefined, signal);
    let result: unknown;
    try {
      result = JSON.parse(await boundedText(response, 2_000_000, readingSignal));
    } catch (error) {
      if (safeTransportError(error)) throw error;
      throw new Error('error.aiInvalidResponse');
    }
    responseError(result);
    const data = (result as { data?: unknown })?.data;
    if (!Array.isArray(data)) throw new Error('error.aiInvalidResponse');
    return [
      ...new Set(
        data
          .filter((item) => typeof item?.id === 'string' && item.id.length <= 256)
          .map((item) => item.id as string),
      ),
    ].slice(0, 2000);
  }
  async complete(
    config: ProviderConfiguration,
    messages: ChatMessage[],
    options: {
      signal?: AbortSignal;
      maxTokens?: number;
      tools?: ProviderTool[];
      json?: boolean;
      onText?: (text: string) => void;
    } = {},
  ): Promise<CompletionResult> {
    if (!config.model.trim()) throw new Error('error.aiModelMissing');
    const body = {
      model: config.model,
      messages,
      stream: !!options.onText,
      max_tokens: options.maxTokens ?? 4096,
      ...(config.provider === 'deepseek' ? { thinking: { type: 'disabled' } } : {}),
      ...(options.json ? { response_format: { type: 'json_object' } } : {}),
      ...(options.tools?.length ? { tools: options.tools, tool_choice: 'auto' } : {}),
    };
    const { response, signal: readingSignal } = await this.response(
      config,
      'chat/completions',
      body,
      options.signal,
    );
    if (!response.headers.get('content-type')?.includes('text/event-stream')) {
      let value: any;
      try {
        value = JSON.parse(await boundedText(response, 4_000_000, readingSignal));
      } catch (error) {
        if (options.signal?.aborted) throw new Error('error.aiRequestCancelled');
        if (safeTransportError(error)) throw error;
        if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name))
          throw new Error('error.aiTimeout');
        throw new Error('error.aiInvalidResponse');
      }
      responseError(value);
      const choice = value?.choices?.[0],
        message = choice?.message;
      if (!message || (typeof message.content !== 'string' && !Array.isArray(message.tool_calls)))
        throw new Error('error.aiInvalidResponse');
      const content = typeof message.content === 'string' ? message.content : '';
      const reason = finishReason(choice.finish_reason),
        toolCalls = validToolCalls(message.tool_calls);
      options.onText?.(content);
      return { content, toolCalls, finishReason: reason };
    }
    if (!response.body) throw new Error('error.aiInvalidResponse');
    const reader = response.body.getReader(),
      decoder = new TextDecoder('utf-8', { fatal: true });
    let buffer = '',
      content = '',
      bytes = 0,
      reason: string | undefined,
      done = false,
      seenChoice = false,
      eventType = '',
      data: string[] = [];
    const calls = new Map<number, ProviderToolCall>();
    const event = () => {
      const text = data.join('\n').trim(),
        type = eventType;
      data = [];
      eventType = '';
      if (!text) return;
      if (text === '[DONE]') {
        done = true;
        return;
      }
      let value: any;
      try {
        value = JSON.parse(text);
      } catch {
        throw new Error('error.aiInvalidResponse');
      }
      if (type === 'error' && !value?.error) throw new Error('error.aiInvalidResponse');
      responseError(value);
      const choice = value?.choices?.[0];
      if (!choice) return;
      seenChoice = true;
      if (choice.finish_reason !== null && choice.finish_reason !== undefined)
        reason = finishReason(choice.finish_reason);
      const delta = choice.delta;
      if (typeof delta?.content === 'string') {
        content += delta.content;
        options.onText?.(delta.content);
      }
      if (Array.isArray(delta?.tool_calls))
        for (const tool of delta.tool_calls) {
          if (!Number.isInteger(tool.index) || tool.index < 0 || tool.index > 31)
            throw new Error('error.aiInvalidResponse');
          const current = calls.get(tool.index) ?? {
            id: '',
            type: 'function',
            function: { name: '', arguments: '' },
          };
          if (typeof tool.id === 'string') current.id += tool.id;
          if (typeof tool.function?.name === 'string') current.function.name += tool.function.name;
          if (typeof tool.function?.arguments === 'string')
            current.function.arguments += tool.function.arguments;
          calls.set(tool.index, current);
        }
    };
    const parse = (line: string) => {
      if (!line) {
        event();
        return;
      }
      if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      else if (line.startsWith('event:')) eventType = line.slice(6).trim();
    };
    try {
      while (true) {
        const chunk = await abortable(reader.read(), readingSignal);
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 4_000_000) throw new Error('error.aiResponseTooLarge');
        buffer += decoder.decode(chunk.value, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          parse(buffer.slice(0, newline).replace(/\r$/, ''));
          buffer = buffer.slice(newline + 1);
          if (done) break;
        }
        if (done) break;
      }
      buffer += decoder.decode();
      if (!done) {
        if (buffer.trim()) parse(buffer.replace(/\r$/, ''));
        event();
      }
      if (!seenChoice || (!done && !reason)) throw new Error('error.aiInvalidResponse');
      return { content, toolCalls: validToolCalls([...calls.values()]), finishReason: reason };
    } catch (error) {
      if (options.signal?.aborted) throw new Error('error.aiRequestCancelled');
      if (safeTransportError(error)) throw error;
      throw new Error('error.aiNetwork');
    } finally {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}
function validToolCalls(value: unknown): ProviderToolCall[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 32) throw new Error('error.aiInvalidResponse');
  const ids = new Set<string>();
  return value.map((item) => {
    if (
      typeof item?.id !== 'string' ||
      !item.id ||
      item.id.length > 256 ||
      typeof item.function?.name !== 'string' ||
      !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(item.function.name) ||
      typeof item.function.arguments !== 'string' ||
      item.function.arguments.length > 1_000_000
    )
      throw new Error('error.aiInvalidResponse');
    if ((item.type !== undefined && item.type !== 'function') || ids.has(item.id))
      throw new Error('error.aiInvalidResponse');
    ids.add(item.id);
    return {
      id: item.id,
      type: 'function',
      function: { name: item.function.name, arguments: item.function.arguments },
    };
  });
}
