// Adaptador para APIs compatibles con OpenAI (/chat/completions con streaming SSE).
// Funciona con OpenAI, OpenRouter, Groq, LM Studio, vLLM, llama.cpp, el endpoint /v1 de Ollama, etc.
import type { ModelInfo } from '../../../shared/types';
import { LlmError } from '../errors';
import { llmFetch, normalizeBaseUrl, parseToolArguments, readLines } from './http';
import type { ChatMessage, ChatRequest, ChatResult, LlmClient } from './types';

function toOpenAiMessage(m: ChatMessage): Record<string, unknown> {
  if (m.role === 'assistant' && m.toolCalls?.length) {
    return {
      role: 'assistant',
      content: m.content || null,
      tool_calls: m.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      })),
    };
  }
  if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
  return { role: m.role, content: m.content };
}

/** Parámetros opcionales que no todos los servidores "compatibles" aceptan. */
const OPTIONAL_PARAMS = ['stream_options', 'reasoning_effort'] as const;
type OptionalParam = (typeof OPTIONAL_PARAMS)[number];

/**
 * Parámetros opcionales rechazados, por servidor+modelo. Se recuerda entre llamadas para no
 * repetir una petición fallida cada vez (los clientes se crean por ejecución de agente).
 */
const unsupportedParams = new Map<string, Set<OptionalParam>>();

export class OpenAiCompatibleClient implements LlmClient {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly apiKey?: string | null,
  ) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
    };
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const res = await llmFetch(`${this.baseUrl}/models`, { headers: this.headers(), signal }, 'El proveedor');
    const json = (await res.json()) as { data?: Array<{ id: string }> };
    return (json.data ?? []).map((m) => ({ id: m.id })).sort((a, b) => a.id.localeCompare(b.id));
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const key = `${this.baseUrl}|${req.model}`;
    const skip = unsupportedParams.get(key) ?? new Set<OptionalParam>();
    for (;;) {
      try {
        return await this.chatOnce(req, skip);
      } catch (err) {
        // Si el servidor rechaza (400) un parámetro opcional, se reintenta sin él y se recuerda.
        const rejected =
          err instanceof LlmError && err.status === 400
            ? OPTIONAL_PARAMS.find((p) => !skip.has(p) && err.message.toLowerCase().includes(p))
            : undefined;
        if (!rejected) throw err;
        skip.add(rejected);
        unsupportedParams.set(key, skip);
      }
    }
  }

  private async chatOnce(req: ChatRequest, skip: Set<OptionalParam>): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages.map(toOpenAiMessage),
      stream: true,
    };
    if (!skip.has('stream_options')) body.stream_options = { include_usage: true };
    // Razonamiento desactivado: evita que los modelos "thinking" gasten los tokens de salida pensando.
    if (req.think === false && !skip.has('reasoning_effort')) body.reasoning_effort = 'none';
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.maxTokens) body.max_tokens = req.maxTokens;
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }

    const res = await llmFetch(
      `${this.baseUrl}/chat/completions`,
      { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal: req.signal },
      'El proveedor',
    );
    if (!res.body) throw new LlmError('El proveedor devolvió una respuesta sin cuerpo.', { retryable: true });

    const result: ChatResult = {
      content: '',
      thinking: '',
      toolCalls: [],
      usage: { promptTokens: 0, completionTokens: 0 },
      finishReason: 'stop',
    };
    // Las tool-calls llegan troceadas por índice: el nombre primero y los argumentos en fragmentos.
    const partial = new Map<number, { id: string; name: string; args: string }>();
    let sawData = false;

    for await (const line of readLines(res.body)) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') break;
      let chunk: Record<string, any>;
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue;
      }
      sawData = true;
      if (chunk.error) {
        throw new LlmError(`El proveedor devolvió un error: ${chunk.error.message ?? JSON.stringify(chunk.error)}`, {
          retryable: false,
        });
      }
      if (chunk.usage) {
        result.usage.promptTokens = Number(chunk.usage.prompt_tokens ?? 0);
        result.usage.completionTokens = Number(chunk.usage.completion_tokens ?? 0);
      }
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};
      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (typeof reasoning === 'string' && reasoning) {
        result.thinking += reasoning;
        req.onThinking?.(reasoning);
      }
      if (typeof delta.content === 'string' && delta.content) {
        result.content += delta.content;
        req.onDelta?.(delta.content);
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const index = Number(tc.index ?? 0);
          const entry = partial.get(index) ?? { id: '', name: '', args: '' };
          if (tc.id) entry.id = tc.id;
          if (tc.function?.name) entry.name += tc.function.name;
          if (typeof tc.function?.arguments === 'string') entry.args += tc.function.arguments;
          partial.set(index, entry);
        }
      }
      if (choice.finish_reason) result.finishReason = choice.finish_reason;
    }
    if (req.signal?.aborted) throw req.signal.reason;
    if (!sawData) throw new LlmError('El proveedor no devolvió ningún dato.', { retryable: true });

    for (const [index, entry] of [...partial.entries()].sort((a, b) => a[0] - b[0])) {
      if (!entry.name) continue;
      result.toolCalls.push({
        id: entry.id || `call_${index + 1}`,
        name: entry.name,
        arguments: parseToolArguments(entry.args),
      });
    }
    if (result.toolCalls.length) result.finishReason = 'tool_calls';
    return result;
  }
}
