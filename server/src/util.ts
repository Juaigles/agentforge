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

/**
 * Espera a `promise`, pero se rechaza en cuanto la señal se aborta aunque la promesa no reaccione. Evita que
 * una operación que ignora la cancelación (una herramienta colgada) retenga a quien la espera.
 */
export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => undefined);
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

/** Fecha local (AAAA-MM-DD) del servidor o de la zona horaria indicada. */
export function localDate(date = new Date(), timeZone?: string): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

/** Registro mínimo que usan el motor y los servicios; en el servidor real es el de Fastify (pino). */
export interface Logger {
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
