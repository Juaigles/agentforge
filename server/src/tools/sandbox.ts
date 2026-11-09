// Ejecución de JavaScript generado por agentes en un Worker aislado, con límites de tiempo y memoria.
// AVISO: node:vm no es una frontera de seguridad fuerte; por eso la herramienta está desactivada por defecto.
import { Worker } from 'node:worker_threads';
import { ToolError } from '../errors';

const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const vm = require('node:vm');
const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
vm.runInContext(
  'globalThis.__logs = []; globalThis.console = { log: (...a) => { __logs.push(a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" ")); } };' +
  'console.info = console.warn = console.error = console.log;',
  context,
);
try {
  context.__result = vm.runInContext(workerData.code, context, { timeout: workerData.timeoutMs });
  const output = vm.runInContext(
    '(() => { let r; try { r = JSON.stringify(__result); } catch { r = undefined; } return JSON.stringify({ result: r === undefined ? String(__result) : JSON.parse(r), logs: __logs }); })()',
    context,
    { timeout: 1000 },
  );
  parentPort.postMessage({ ok: true, output });
} catch (err) {
  parentPort.postMessage({ ok: false, error: String(err && err.message ? err.message : err) });
}
`;

export function runJavaScript(
  code: string,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<{ result: unknown; logs: string[] }> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { code, timeoutMs },
      resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 2 },
      env: {},
    });
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
      () => finish(() => reject(new ToolError(`El código superó el tiempo máximo (${timeoutMs} ms).`))),
      timeoutMs + 1000,
    );
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    worker.on('message', (msg: { ok: boolean; output?: string; error?: string }) => {
      if (msg.ok) finish(() => resolve(JSON.parse(msg.output!)));
      else finish(() => reject(new ToolError(`Error al ejecutar el código: ${msg.error}`)));
    });
    worker.on('error', (err) => finish(() => reject(new ToolError(`Error al ejecutar el código: ${err.message}`))));
    worker.on('exit', () => finish(() => reject(new ToolError('El código terminó sin devolver resultado (¿límite de memoria?).'))));
  });
}
