/** Error con código HTTP para la API. */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** Configuración incorrecta (agente sin modelo, proveedor inexistente…). Reintentar no lo arregla. */
export class ConfigError extends Error {
  readonly retryable = false;
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Se ha superado un límite de ejecución. Reintentar no lo arregla. */
export class LimitError extends Error {
  readonly retryable = false;
  constructor(message: string) {
    super(message);
    this.name = 'LimitError';
  }
}

/** Fallo al hablar con un proveedor LLM. */
export class LlmError extends Error {
  readonly retryable: boolean;
  readonly status?: number;
  constructor(message: string, opts: { retryable: boolean; status?: number; cause?: unknown }) {
    super(message, { cause: opts.cause });
    this.name = 'LlmError';
    this.retryable = opts.retryable;
    this.status = opts.status;
  }
}

/** Fallo de una herramienta (argumentos inválidos, operación no permitida…). */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

export function isRetryable(err: unknown): boolean {
  if (err && typeof err === 'object' && 'retryable' in err) return Boolean((err as { retryable: unknown }).retryable);
  return true;
}
