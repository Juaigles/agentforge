import { randomBytes } from 'node:crypto';
import type { Usage } from '../../shared/types';

export const nowIso = (): string => new Date().toISOString();

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString('hex')}`;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[truncado: ${text.length - max} caracteres más]`;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : JSON.stringify(err);
}

/** Espera `ms` milisegundos; se rechaza si la señal se aborta. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function addUsage(a: Usage, b: Partial<Usage>): Usage {
  return {
    promptTokens: a.promptTokens + (b.promptTokens ?? 0),
    completionTokens: a.completionTokens + (b.completionTokens ?? 0),
    llmCalls: a.llmCalls + (b.llmCalls ?? 0),
    toolCalls: a.toolCalls + (b.toolCalls ?? 0),
  };
}

export function stringifyResult(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
