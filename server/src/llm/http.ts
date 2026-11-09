// Utilidades HTTP comunes a los adaptadores LLM.
import { LlmError } from '../errors';

/** Itera las líneas no vacías de un cuerpo de respuesta en streaming. */
export async function* readLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line) yield line;
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) yield buffer.trim();
}

/** fetch que traduce los fallos de red y los códigos HTTP a LlmError (respetando la cancelación). */
export async function llmFetch(url: string, init: RequestInit, label: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    if (init.signal?.aborted) throw init.signal.reason ?? err;
    throw new LlmError(`No se pudo conectar con ${label} (${new URL(url).origin}). ¿Está en marcha?`, {
      retryable: true,
      cause: err,
    });
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let detail = text.slice(0, 500);
    try {
      const json = JSON.parse(text);
      detail = typeof json.error === 'string' ? json.error : (json.error?.message ?? detail);
    } catch {
      /* cuerpo no JSON: se usa el texto tal cual */
    }
    throw new LlmError(`${label} respondió ${res.status}: ${detail || res.statusText}`, {
      retryable: res.status === 408 || res.status === 429 || res.status >= 500,
      status: res.status,
    });
  }
  return res;
}

export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/** Los modelos a veces devuelven JSON de argumentos mal formado; en ese caso se pasa un objeto vacío. */
export function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
