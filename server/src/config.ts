// Configuración del servidor a partir de las variables de entorno, validada al arrancar: un valor incorrecto
// detiene el arranque con un mensaje que dice qué variable es y qué se esperaba.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

export interface AppConfig {
  port: number;
  host: string;
  dataDir: string;
  dbFile: string;
  workspaceDir: string;
  webDist: string;
  /** Crea datos de ejemplo si la base de datos está vacía. */
  seed: boolean;
  ollamaUrl: string;
  /** Modelo de los agentes de ejemplo ('' = el más ligero con herramientas que tenga Ollama). */
  defaultModel: string;
  /** Nivel del registro: 'info' anota el ciclo de vida y los errores; 'debug' añade cada petición HTTP. */
  logLevel: LogLevel;
  /** Cada cuánto se comprueban las programaciones vencidas (ms). */
  schedulerTickMs: number;
  /** Nombres de host adicionales por los que se puede llegar al servidor (cabecera Host), p. ej. detrás de un proxy. */
  allowedHosts: string[];
  /** Clave de acceso a la API. Obligatoria si el servidor escucha fuera de este equipo. */
  authToken: string | null;
  /** Peticiones por minuto y cliente a la API (0 = sin límite). */
  rateLimitPerMinute: number;
  /** Tiempo máximo que el apagado espera a las ejecuciones en curso (ms). */
  shutdownGraceMs: number;
  /**
   * Hay un proxy inverso delante: la dirección del cliente y el protocolo se leen de `X-Forwarded-For` y
   * `X-Forwarded-Proto`. Sin proxy debe quedar desactivado (cualquiera podría falsear esas cabeceras).
   */
  trustProxy?: boolean;
}

/** Error de configuración: el mensaje se muestra tal cual al arrancar. */
export class ConfigurationError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Configuración no válida:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigurationError';
  }
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LOG_LEVELS: LogLevel[] = ['silent', 'error', 'warn', 'info', 'debug'];
const MIN_TOKEN_CHARS = 16;

/** ¿El servidor escucha solo en este equipo? */
export function isLoopbackHost(host: string): boolean {
  const h = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const problems: string[] = [];
  const text = (name: string) => {
    const value = env[name]?.trim();
    return value ? value : undefined;
  };
  const integer = (name: string, fallback: number, min: number, max: number): number => {
    const raw = text(name);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
      problems.push(`${name}="${raw}": debe ser un número entero entre ${min} y ${max}.`);
      return fallback;
    }
    return n;
  };
  const flag = (name: string, fallback: boolean): boolean => {
    const raw = text(name)?.toLowerCase();
    if (raw === undefined) return fallback;
    if (['1', 'true', 'yes', 'si', 'sí', 'on'].includes(raw)) return true;
    if (['0', 'false', 'no', 'off'].includes(raw)) return false;
    problems.push(`${name}="${raw}": usa 1 o 0 (también true/false).`);
    return fallback;
  };

  const host = text('HOST') ?? '127.0.0.1';
  if (/[\s/]/.test(host)) problems.push(`HOST="${host}": debe ser una dirección IP o un nombre de equipo, sin espacios ni barras.`);

  let ollamaUrl = text('OLLAMA_URL') ?? 'http://localhost:11434';
  try {
    if (!['http:', 'https:'].includes(new URL(ollamaUrl).protocol)) throw new Error('protocolo');
  } catch {
    problems.push(`OLLAMA_URL="${ollamaUrl}": debe ser una URL http(s), por ejemplo http://localhost:11434.`);
    ollamaUrl = 'http://localhost:11434';
  }

  // Nivel de registro: AGENTFORGE_LOG_LEVEL manda; AGENTFORGE_LOG (0/1) se conserva por compatibilidad.
  let logLevel: LogLevel = 'info';
  const legacyLog = text('AGENTFORGE_LOG');
  if (legacyLog !== undefined) logLevel = flag('AGENTFORGE_LOG', false) ? 'debug' : 'silent';
  const rawLevel = text('AGENTFORGE_LOG_LEVEL')?.toLowerCase();
  if (rawLevel !== undefined) {
    if (LOG_LEVELS.includes(rawLevel as LogLevel)) logLevel = rawLevel as LogLevel;
    else problems.push(`AGENTFORGE_LOG_LEVEL="${rawLevel}": valores admitidos: ${LOG_LEVELS.join(', ')}.`);
  }

  const authToken = text('AGENTFORGE_TOKEN') ?? null;
  if (authToken !== null && authToken.length < MIN_TOKEN_CHARS) {
    problems.push(`AGENTFORGE_TOKEN: la clave de acceso debe tener al menos ${MIN_TOKEN_CHARS} caracteres.`);
  }
  if (!isLoopbackHost(host) && authToken === null) {
    problems.push(
      `HOST="${host}" expone la API fuera de este equipo y AgentForge puede ejecutar agentes, leer archivos y usar tus claves. ` +
        `Define AGENTFORGE_TOKEN (al menos ${MIN_TOKEN_CHARS} caracteres) para exigir una clave de acceso, o vuelve a HOST=127.0.0.1.`,
    );
  }

  const allowedHosts = (text('AGENTFORGE_ALLOWED_HOSTS') ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  for (const h of allowedHosts) {
    if (/[\s/]/.test(h) || h.includes('://')) problems.push(`AGENTFORGE_ALLOWED_HOSTS: "${h}" debe ser solo el nombre de host (sin http:// ni rutas).`);
    // La cabecera Host se compara sin su puerto: un nombre con puerto no coincidiría nunca (403 en cada petición).
    else if (/:\d+$/.test(h) && !h.startsWith('['))
      problems.push(`AGENTFORGE_ALLOWED_HOSTS: "${h}" no debe llevar el puerto; escribe solo "${h.replace(/:\d+$/, '')}".`);
  }

  const dataDir = path.resolve(text('AGENTFORGE_DATA_DIR') ?? path.join(repoRoot, 'data'));
  const config: AppConfig = {
    port: integer('PORT', 4310, 1, 65_535),
    host,
    dataDir,
    dbFile: path.join(dataDir, 'agentforge.db'),
    workspaceDir: path.join(dataDir, 'workspace'),
    webDist: path.join(repoRoot, 'web', 'dist'),
    seed: flag('AGENTFORGE_SEED', true),
    ollamaUrl,
    defaultModel: text('AGENTFORGE_DEFAULT_MODEL') ?? '',
    logLevel,
    schedulerTickMs: integer('AGENTFORGE_SCHEDULER_TICK_MS', 5000, 250, 3_600_000),
    allowedHosts,
    authToken,
    rateLimitPerMinute: integer('AGENTFORGE_RATE_LIMIT', 1200, 0, 1_000_000),
    shutdownGraceMs: integer('AGENTFORGE_SHUTDOWN_GRACE_MS', 10_000, 0, 600_000),
    trustProxy: flag('AGENTFORGE_TRUST_PROXY', false),
  };
  if (problems.length) throw new ConfigurationError(problems);
  return config;
}
