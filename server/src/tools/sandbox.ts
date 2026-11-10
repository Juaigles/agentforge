// Ejecución de JavaScript generado por agentes, con dos capas de aislamiento:
//
//  1. Un contexto `node:vm` vacío (sin require, process, fetch ni temporizadores), sin generación de código a
//     partir de cadenas y con límite de tiempo que cubre también las promesas.
//  2. Ese contexto vive en un PROCESO HIJO de Node lanzado con el modelo de permisos (`--permission`) y sin
//     variables de entorno: aunque el código lograra escapar del contexto, el proceso no puede leer ni escribir
//     archivos, lanzar otros programas, crear workers ni cargar módulos nativos. Tiene además límite de memoria,
//     de tiempo (se mata el proceso) y de tamaño de salida.
//
// AVISO: no es una frontera de seguridad fuerte. `node:vm` no está pensado para código hostil y el modelo de
// permisos de Node no restringe la red en todas las versiones; no hay aislamiento del sistema operativo
// (contenedor, seccomp, usuario sin privilegios). Por eso la herramienta está desactivada por defecto.
import { spawn } from 'node:child_process';
import os from 'node:os';
import { ToolError } from '../errors';

const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_CODE_CHARS = 100_000;
const MAX_CONCURRENT = 4;

/** Programa del proceso hijo: lee {code, timeoutMs} por la entrada estándar y escribe un JSON con el resultado. */
const RUNNER = `
'use strict';
const vm = require('node:vm');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  let message;
  try {
    const { code, timeoutMs } = JSON.parse(input);
    const context = vm.createContext(Object.create(null), {
      codeGeneration: { strings: false, wasm: false },
      // Las promesas pendientes se ejecutan dentro de la llamada (y de su límite de tiempo), no después.
      microtaskMode: 'afterEvaluate',
    });
    vm.runInContext(
      'globalThis.__logs = []; globalThis.console = { log: (...a) => { if (__logs.length < 200) __logs.push(a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" ").slice(0, 2000)); } };' +
      'console.info = console.warn = console.error = console.debug = console.log;',
      context,
    );
    context.__result = vm.runInContext(code, context, { timeout: timeoutMs });
    // Si el código devuelve una promesa se espera a su valor (ya resuelta gracias a microtaskMode).
    vm.runInContext(
      'globalThis.__state = "pending"; Promise.resolve(__result).then((v) => { globalThis.__value = v; __state = "ok"; }, (e) => { globalThis.__error = e; __state = "error"; });',
      context,
      { timeout: timeoutMs },
    );
    const output = vm.runInContext(
      '(() => { if (__state === "pending") return JSON.stringify({ pending: true });' +
      ' if (__state === "error") return JSON.stringify({ thrown: String(__error && __error.message ? __error.message : __error) });' +
      ' let r; try { r = JSON.stringify(__value); } catch { r = undefined; }' +
      ' return JSON.stringify({ result: r === undefined ? String(__value) : JSON.parse(r), logs: __logs }); })()',
      context,
      { timeout: 1000 },
    );
    message = { ok: true, output: String(output) };
  } catch (err) {
    let text;
    try { text = String(err && err.message ? err.message : err); } catch { text = 'error no representable'; }
    message = { ok: false, error: text.slice(0, 2000) };
  }
  process.stdout.write(JSON.stringify(message), () => process.exit(0));
});
`;

/** Argumentos de Node del proceso aislado (exportados para poder comprobar en tests lo que de verdad restringen). */
export function sandboxNodeArgs(): string[] {
  const permission = process.allowedNodeEnvironmentFlags.has('--permission') ? '--permission' : '--experimental-permission';
  return [permission, '--max-old-space-size=64', '--disallow-code-generation-from-strings', '--no-warnings'];
}

// Pocas ejecuciones a la vez: cada una es un proceso con su propia memoria.
let running = 0;
const waiting: Array<() => void> = [];
async function acquire(signal?: AbortSignal): Promise<void> {
  if (running < MAX_CONCURRENT) {
    running++;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const grant = () => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    const onAbort = () => {
      waiting.splice(waiting.indexOf(grant), 1);
      reject(signal!.reason);
    };
    waiting.push(grant);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
function release(): void {
  const next = waiting.shift();
  if (next) next();
  else running--;
}

export async function runJavaScript(
  code: string,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<{ result: unknown; logs: string[] }> {
  if (code.length > MAX_CODE_CHARS) throw new ToolError(`El código es demasiado largo (máximo ${MAX_CODE_CHARS} caracteres).`);
  if (opts.signal?.aborted) throw opts.signal.reason;
  const timeoutMs = opts.timeoutMs ?? 5000;
  await acquire(opts.signal);
  try {
    return await runInChild(code, timeoutMs, opts.signal);
  } finally {
    release();
  }
}

function runInChild(code: string, timeoutMs: number, signal?: AbortSignal): Promise<{ result: unknown; logs: string[] }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...sandboxNodeArgs(), '-e', RUNNER], {
      // Sin variables de entorno (ni claves, ni rutas) y en un directorio que no es el del proyecto.
      env: {},
      cwd: os.tmpdir(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let settled = false;
    let stdout = '';
    let stderr = '';
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (child.exitCode === null) child.kill('SIGKILL');
      fn();
    };
    const onAbort = () => finish(() => reject(signal!.reason));
    // Margen para el arranque del proceso; el límite fino lo aplica vm dentro del hijo.
    const timer = setTimeout(() => finish(() => reject(new ToolError(`El código superó el tiempo máximo (${timeoutMs} ms).`))), timeoutMs + 3000);
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.length > MAX_OUTPUT_BYTES) finish(() => reject(new ToolError('El resultado del código es demasiado grande.')));
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 4000) stderr += chunk;
    });
    child.on('error', (err) => finish(() => reject(new ToolError(`No se pudo iniciar el entorno aislado: ${err.message}`))));
    child.on('close', () =>
      finish(() => {
        let message: { ok: boolean; output?: string; error?: string };
        try {
          message = JSON.parse(stdout);
        } catch {
          const oom = /heap out of memory|Allocation failed/i.test(stderr);
          return reject(new ToolError(oom ? 'El código superó el límite de memoria (64 MB).' : 'El código terminó sin devolver resultado (¿límite de memoria?).'));
        }
        if (!message.ok) return reject(new ToolError(`Error al ejecutar el código: ${message.error}`));
        const output = JSON.parse(message.output!) as { result?: unknown; logs?: string[]; pending?: boolean; thrown?: string };
        if (output.pending) return reject(new ToolError('El código devolvió una promesa que no llega a resolverse (no hay temporizadores ni red).'));
        if (output.thrown !== undefined) return reject(new ToolError(`Error al ejecutar el código: ${output.thrown}`));
        resolve({ result: output.result, logs: output.logs ?? [] });
      }),
    );
    child.stdin.on('error', () => undefined); // el hijo pudo morir antes de leer
    child.stdin.end(JSON.stringify({ code, timeoutMs }));
  });
}
