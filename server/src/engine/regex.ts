// Evaluación de expresiones regulares escritas por el usuario sobre texto que no controla (salidas de modelos).
//
// Una expresión con retroceso catastrófico —`(a+)+$` contra una cadena larga— no termina en la práctica, y
// `RegExp.test` es síncrono: en el hilo principal congelaría la API, los flujos SSE, el planificador y todas las
// demás ejecuciones, sin que ni la cancelación ni el límite de duración pudieran cortarla (ambos necesitan el
// bucle de eventos). Por eso se evalúa en un hilo aparte que se puede matar desde fuera.
import { Worker } from 'node:worker_threads';
import { ConfigError } from '../errors';

const MAX_PATTERN_CHARS = 1000;
const MAX_TEXT_CHARS = 200_000;

const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
try {
  parentPort.postMessage({ ok: true, result: new RegExp(workerData.pattern, 'i').test(workerData.text) });
} catch (err) {
  parentPort.postMessage({ ok: false, error: String(err && err.message ? err.message : err) });
}
`;

/** ¿`text` casa con `pattern` (sin distinguir mayúsculas)? Se rechaza si la expresión no es válida o tarda demasiado. */
export async function regexTest(pattern: string, text: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<boolean> {
  if (pattern.length > MAX_PATTERN_CHARS) throw new ConfigError(`La expresión regular es demasiado larga (máximo ${MAX_PATTERN_CHARS} caracteres).`);
  try {
    // Compilar es barato y no ejecuta la búsqueda: sirve para dar un error claro sin lanzar el hilo.
    new RegExp(pattern, 'i');
  } catch {
    throw new ConfigError(`Expresión regular no válida: ${pattern}`);
  }
  if (opts.signal?.aborted) throw opts.signal.reason;
  const timeoutMs = opts.timeoutMs ?? 1000;

  return new Promise<boolean>((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { pattern, text: text.slice(0, MAX_TEXT_CHARS) } });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      void worker.terminate();
      fn();
    };
    const onAbort = () => finish(() => reject(opts.signal!.reason));
    const timer = setTimeout(
      () =>
        finish(() =>
          reject(
            new ConfigError(
              `La expresión regular «${pattern.slice(0, 80)}» tardó más de ${timeoutMs} ms en evaluarse y se ha detenido. Simplifícala (evita cuantificadores anidados como (a+)+).`,
            ),
          ),
        ),
      timeoutMs,
    );
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    worker.once('message', (msg: { ok: boolean; result?: boolean; error?: string }) =>
      finish(() => (msg.ok ? resolve(Boolean(msg.result)) : reject(new ConfigError(`Expresión regular no válida: ${msg.error}`)))),
    );
    worker.once('error', (err) => finish(() => reject(new ConfigError(`No se pudo evaluar la expresión regular: ${err.message}`))));
  });
}
