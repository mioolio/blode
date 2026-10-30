export type ModelProviderId = 'deepseek' | 'qwen' | 'siliconflow' | 'custom';
export interface ModelProviderPreset {
  id: ModelProviderId;
  name: string;
  baseUrl: string;
  model: string;
  documentation: string;
}
export interface ModelServiceState {
  revision: number;
  provider: ModelProviderId;
  baseUrl: string;
  model: string;
  predictionModel: string;
  predictionSource: 'external' | 'provider';
  hasKey: boolean;
  presets: ModelProviderPreset[];
}
export interface ModelServiceConfiguration {
  revision: number;
  provider: ModelProviderId;
  baseUrl: string;
  model: string;
  predictionModel: string;
  predictionSource: 'external' | 'provider';
  apiKey?: string;
  removeKey?: boolean;
  confirm: true;
}
export type AiEditScope = 'selection' | 'file' | 'project' | 'computer';
export interface AiSourceContext {
  path: string;
  content: string;
  selection?: { start: number; end: number };
}
export interface AiChatRequest {
  projectRoot: string;
  scope: AiEditScope;
  intent: 'ask' | 'edit';
  prompt: string;
  source?: AiSourceContext;
  sessionId?: string;
  sessionToken?: string;
  confirm?: true;
  actor?: { peerId: string; actorToken: string };
  localOnly?: boolean;
}
export interface AiChatMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  time: string;
}
export interface AiChatSession {
  id: string;
  token: string;
  projectRoot: string;
  scope: AiEditScope;
  status: 'idle' | 'running' | 'completed' | 'cancelled' | 'failed';
  messages: AiChatMessage[];
  error?: string;
  changedFiles: string[];
  contextPath?: string;
  pendingEdit?: { id: string; path: string; start: number; end: number; text: string };
  pendingEdits?: { id: string; path: string; originalContent: string; text: string }[];
}
export interface ModelServiceApi {
  modelServiceState(): Promise<ModelServiceState>;
  modelServiceConfigure(request: ModelServiceConfiguration): Promise<ModelServiceState>;
  modelServiceTest(): Promise<{ models: string[] }>;
  aiChatStart(request: AiChatRequest): Promise<AiChatSession>;
  aiChatState(request: { sessionId: string; sessionToken: string }): Promise<AiChatSession>;
  aiChatCancel(request: { sessionId: string; sessionToken: string }): Promise<AiChatSession>;
}
