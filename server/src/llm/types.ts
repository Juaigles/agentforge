import type { JsonSchema, ModelInfo } from '../../../shared/types';

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Solo en mensajes del asistente que piden herramientas. */
  toolCalls?: ToolCall[];
  /** Solo en mensajes 'tool': a qué llamada responden. */
  toolCallId?: string;
  name?: string;
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSchema[];
  temperature?: number;
  maxTokens?: number | null;
  think?: boolean;
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
  onThinking?: (text: string) => void;
}

export interface ChatResult {
  content: string;
  thinking: string;
  toolCalls: ToolCall[];
  usage: { promptTokens: number; completionTokens: number };
  finishReason: string;
}

export interface LlmClient {
  chat(req: ChatRequest): Promise<ChatResult>;
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>;
}

export interface LlmProviderConfig {
  kind: 'ollama' | 'openai';
  baseUrl: string;
  apiKey?: string | null;
}

/** Fábrica de clientes; el motor depende de esta interfaz para poder sustituirla en tests. */
export interface LlmFactory {
  create(provider: LlmProviderConfig): LlmClient;
}
