/** Error con código HTTP para la API. */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
    /** Código estable del error (por defecto se deduce del estado HTTP). */
    public code?: string,
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

/**
 * Fallo de una herramienta (argumentos inválidos, operación no permitida…). Solo se reintenta si se marca como
 * transitorio (fallo de red, tiempo de espera): repetir una llamada con argumentos inválidos no la arregla.
 */
export class ToolError extends Error {
  readonly retryable: boolean;
  constructor(message: string, opts: { retryable?: boolean } = {}) {
    super(message);
    this.name = 'ToolError';
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
