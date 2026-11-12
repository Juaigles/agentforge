// Adaptador para la API nativa de Ollama (/api/chat con streaming NDJSON).
import type { ModelInfo } from '../../../shared/types';
import { msg as serverMsg } from '../../../shared/server-messages';
import { LlmError } from '../errors';
import { llmFetch, normalizeBaseUrl, parseToolArguments, readLines } from './http';
import type { ChatMessage, ChatRequest, ChatResult, LlmClient, ToolCall } from './types';

function toOllamaMessage(m: ChatMessage): Record<string, unknown> {
  if (m.role === 'assistant' && m.toolCalls?.length) {
    return {
      role: 'assistant',
      content: m.content,
      tool_calls: m.toolCalls.map((tc) => ({ function: { name: tc.name, arguments: tc.arguments } })),
    };
  }
  if (m.role === 'tool') return { role: 'tool', content: m.content, tool_name: m.name };
  return { role: m.role, content: m.content };
}

export class OllamaClient implements LlmClient {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly apiKey?: string | null,
  ) {
    // Se acepta que el usuario pegue la URL con el sufijo /v1 o /api.
    this.baseUrl = normalizeBaseUrl(baseUrl).replace(/\/(v1|api)$/, '');
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
    };
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const res = await llmFetch(`${this.baseUrl}/api/tags`, { headers: this.headers(), signal }, 'Ollama');
    const json = (await res.json()) as { models?: Array<Record<string, any>> };
    return (json.models ?? []).map((m) => ({
      id: String(m.name ?? m.model),
      sizeBytes: typeof m.size === 'number' ? m.size : undefined,
      parameterSize: m.details?.parameter_size,
      contextLength: m.details?.context_length,
      capabilities: Array.isArray(m.capabilities) ? m.capabilities : undefined,
    }));
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    try {
      return await this.chatOnce(req, true);
    } catch (err) {
      // Los modelos sin razonamiento rechazan el parámetro `think`; se reintenta sin él.
      if (err instanceof LlmError && err.status === 400 && /think/i.test(err.message)) {
        return this.chatOnce(req, false);
      }
      throw err;
    }
  }

  private async chatOnce(req: ChatRequest, sendThink: boolean): Promise<ChatResult> {
    const options: Record<string, unknown> = {};
    if (req.temperature !== undefined) options.temperature = req.temperature;
    if (req.maxTokens) options.num_predict = req.maxTokens;

    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages.map(toOllamaMessage),
      stream: true,
      options,
    };
    if (sendThink && req.think !== undefined) body.think = req.think;
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }

    const res = await llmFetch(
      `${this.baseUrl}/api/chat`,
      { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal: req.signal },
      'Ollama',
    );
    if (!res.body) throw new LlmError(serverMsg('ollamaNoBody'), { retryable: true });

    const result: ChatResult = {
      content: '',
      thinking: '',
      toolCalls: [],
      usage: { promptTokens: 0, completionTokens: 0 },
      finishReason: 'stop',
    };
    let done = false;

    for await (const line of readLines(res.body)) {
      let chunk: Record<string, any>;
      try {
        chunk = JSON.parse(line);
      } catch {
        continue;
      }
      if (chunk.error) throw new LlmError(serverMsg('ollamaError', { detail: String(chunk.error) }), { retryable: false });
      const msg = chunk.message;
      if (msg?.thinking) {
        result.thinking += msg.thinking;
        req.onThinking?.(msg.thinking);
      }
      if (msg?.content) {
        result.content += msg.content;
        req.onDelta?.(msg.content);
      }
      if (Array.isArray(msg?.tool_calls)) {
        for (const tc of msg.tool_calls) {
          const call: ToolCall = {
            id: tc.id ?? `call_${result.toolCalls.length + 1}`,
            name: String(tc.function?.name ?? ''),
            arguments: parseToolArguments(tc.function?.arguments),
          };
          if (call.name) result.toolCalls.push(call);
        }
      }
      if (chunk.done) {
        done = true;
        result.usage.promptTokens = Number(chunk.prompt_eval_count ?? 0);
        result.usage.completionTokens = Number(chunk.eval_count ?? 0);
        result.finishReason = result.toolCalls.length ? 'tool_calls' : String(chunk.done_reason ?? 'stop');
      }
    }
    if (req.signal?.aborted) throw req.signal.reason;
    if (!done) throw new LlmError(serverMsg('ollamaCutOff'), { retryable: true });
    return result;
  }
}
