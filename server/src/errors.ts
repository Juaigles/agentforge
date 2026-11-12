import { msg, refOf, type CodedMessage, type MessageParam, type ServerMessage } from '../../shared/server-messages';
import type { ValidationIssue } from '../../shared/types';

/**
 * Texto de un error: un mensaje con código (shared/server-messages.ts), que la interfaz puede mostrar en otro
 * idioma, o un texto suelto (lo que viene de fuera o de un test), que se muestra tal cual.
 */
export type ErrorText = string | CodedMessage;

const textOf = (text: ErrorText): string => (typeof text === 'string' ? text : text.message);
const i18nOf = (text: ErrorText): ServerMessage | undefined => (typeof text === 'string' ? undefined : refOf(text));

/** Código y parámetros del texto de un error, si los tiene. */
export function errorI18n(err: unknown): ServerMessage | undefined {
  return errorI18n_(err);
}
function errorI18n_(err: unknown): ServerMessage | undefined {
  const i18n = err && typeof err === 'object' && 'i18n' in err ? (err as { i18n?: ServerMessage }).i18n : undefined;
  return i18n && typeof i18n.code === 'string' ? i18n : undefined;
}

/**
 * Un error como parámetro de otro mensaje (la causa de un fallo): con su código si lo tiene, para que se
 * traduzca también, o como texto suelto.
 */
export function errorParam(err: unknown): MessageParam {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : JSON.stringify(err);
  const i18n = errorI18n(err);
  return i18n ? { ...i18n, message } : message;
}

/** Un problema de validación de un workflow como parámetro de otro mensaje (tiene su propia tabla de códigos). */
export function issueParam(issue: Pick<ValidationIssue, 'message' | 'code' | 'params'>): MessageParam {
  return issue.code ? { code: issue.code, params: issue.params, message: issue.message } : issue.message;
}

/** Un texto ya guardado (con su referencia, si la tiene) como parámetro de otro mensaje. */
export function textParam(message: string, i18n?: ServerMessage | null): MessageParam {
  return i18n ? { ...i18n, message } : message;
}

/** Un texto ya guardado como texto de un error nuevo, con su código si lo tenía. */
export function storedText(message: string, i18n?: ServerMessage | null): ErrorText {
  return i18n ? { code: i18n.code as CodedMessage['code'], params: i18n.params ?? {}, message } : message;
}

/** Motivo de un fallo tal como se guarda y se envía: el texto y, si lo tiene, su referencia para traducirlo. */
export interface Failure {
  error: string;
  errorI18n?: ServerMessage;
}

/** El motivo de fallo que corresponde a un mensaje con código. */
export function failure(text: CodedMessage): Failure {
  return { error: text.message, errorI18n: refOf(text) };
}

/** El motivo de fallo que corresponde a un error cualquiera. */
export function failureOf(err: unknown): Failure {
  const error = err instanceof Error ? err.message : typeof err === 'string' ? err : JSON.stringify(err);
  const errorI18n = errorI18n_(err);
  return errorI18n ? { error, errorI18n } : { error };
}

/** El mensaje con código de un error cualquiera: el suyo, o `unexpected` con su texto tal cual. */
export function codedOf(err: unknown): CodedMessage {
  const param = errorParam(err);
  if (typeof param === 'object' && !Array.isArray(param))
    return { code: param.code as CodedMessage['code'], params: param.params ?? {}, message: param.message ?? '' };
  return msg('unexpected', { detail: param });
}

/** Error con código HTTP para la API. Su texto siempre tiene código, para poder mostrarlo en otro idioma. */
export class HttpError extends Error {
  readonly i18n: ServerMessage;
  constructor(
    public status: number,
    text: CodedMessage,
    public details?: unknown,
    /** Código estable de la clase de error (por defecto se deduce del estado HTTP). */
    public code?: string,
  ) {
    super(text.message);
    this.name = 'HttpError';
    this.i18n = refOf(text);
  }
}

/** Configuración incorrecta (agente sin modelo, proveedor inexistente…). Reintentar no lo arregla. */
export class ConfigError extends Error {
  readonly retryable = false;
  readonly i18n?: ServerMessage;
  constructor(text: ErrorText) {
    super(textOf(text));
    this.name = 'ConfigError';
    this.i18n = i18nOf(text);
  }
}

/** Se ha superado un límite de ejecución. Reintentar no lo arregla. */
export class LimitError extends Error {
  readonly retryable = false;
  readonly i18n?: ServerMessage;
  constructor(text: ErrorText) {
    super(textOf(text));
    this.name = 'LimitError';
    this.i18n = i18nOf(text);
  }
}

/** Fallo al hablar con un proveedor LLM. */
export class LlmError extends Error {
  readonly retryable: boolean;
  readonly status?: number;
  readonly i18n?: ServerMessage;
  constructor(text: ErrorText, opts: { retryable: boolean; status?: number; cause?: unknown }) {
    super(textOf(text), { cause: opts.cause });
    this.name = 'LlmError';
    this.i18n = i18nOf(text);
    this.retryable = opts.retryable;
    this.status = opts.status;
  }
}

/**
 * Fallo de una herramienta (argumentos inválidos, operación no permitida…). Solo se reintenta si se marca como
 * transitorio (fallo de red, tiempo de espera): repetir una llamada con argumentos inválidos no la arregla.
 */
export class ToolError extends Error {
  readonly retryable: boolean;
  readonly i18n?: ServerMessage;
  constructor(text: ErrorText, opts: { retryable?: boolean } = {}) {
    super(textOf(text));
    this.name = 'ToolError';
    this.i18n = i18nOf(text);
    this.retryable = opts.retryable ?? false;
  }
}

/** Motivo con el que se abortan las ejecuciones cuando el servidor se apaga (distinto de una cancelación manual). */
export class ShutdownSignal extends Error {
  constructor() {
    super('Servidor detenido.');
    this.name = 'ShutdownSignal';
  }
}

/**
 * ¿Merece la pena reintentar? Solo los errores marcados expresamente como transitorios: un error sin marca
 * (un fallo de programación, una herramienta con argumentos inválidos) no se repite, porque reintentar un nodo
 * vuelve a ejecutar las herramientas con efectos que ya se habían ejecutado.
 */
export function isRetryable(err: unknown): boolean {
  if (err && typeof err === 'object' && 'retryable' in err) return Boolean((err as { retryable: unknown }).retryable);
  return false;
}
