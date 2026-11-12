// Ejecución de JavaScript generado por agentes. Hay dos formas de aislarlo, a elegir en Ajustes:
//
//  A) PROCESO (por defecto). Tres capas:
//     1. Un contexto `node:vm` vacío (sin require, process, fetch ni temporizadores), sin generación de código a
//        partir de cadenas y con límite de tiempo que cubre también las promesas.
//     2. Ese contexto vive en un PROCESO HIJO de Node lanzado con el modelo de permisos (`--permission`) y sin
//        variables de entorno: aunque el código escapara del contexto, el proceso no puede leer ni escribir
//        archivos, lanzar otros programas, crear workers ni cargar módulos nativos. Tiene además límite de
//        memoria, de tiempo (se mata el proceso) y de tamaño de salida.
//     3. RED. Donde Node ofrece permiso de red (`--allow-net`, a partir de Node 25) el propio `--permission` la
//        deniega. En Node 22–24 ese permiso no existe, así que antes de ejecutar nada el proceso hijo inutiliza
//        sus propias API de red (sockets TCP y UDP, DNS, fetch, WebSocket, `process.binding`). No es una
//        frontera del sistema operativo, pero deja sin red a un código que lograra escapar del contexto.
//
//  B) CONTENEDOR (Docker o Podman). El mismo programa corre en un contenedor sin red (`--network none`), de solo
//     lectura, sin privilegios ni capacidades y con límites de memoria, CPU y procesos. Aquí el aislamiento sí
//     lo impone el sistema operativo.
//
// AVISO: la opción A no es una frontera de seguridad fuerte (`node:vm` no está pensado para código hostil). Por eso
// la herramienta está desactivada por defecto y, para código no confiable, se recomienda la opción B.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import type { Settings } from '../../../shared/types';
import { msg, refOf, type CodedMessage, type ServerMessage } from '../../../shared/server-messages';
import { ToolError } from '../errors';

const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_CODE_CHARS = 100_000;
const MAX_CONCURRENT = 4;
/** Imagen del contenedor: solo hace falta que traiga Node. No se descarga sola (ver `--pull=never`). */
export const SANDBOX_IMAGE = 'node:24-alpine';

/**
 * Preludio del proceso hijo: inutiliza las API de red de Node antes de ejecutar nada. Se exporta para poder
 * comprobar en tests, con sockets reales, lo que de verdad impide.
 */
export const SANDBOX_NETWORK_LOCKDOWN = `
(() => {
  const deny = function () {
    const err = new Error('La red está desactivada en el entorno aislado.');
    err.code = 'ERR_ACCESS_DENIED';
    throw err;
  };
  const lock = (target, names) => {
    for (const name of names) {
      try { Object.defineProperty(target, name, { value: deny, writable: false, configurable: false }); } catch {}
    }
  };
  const functionsOf = (obj) => Object.getOwnPropertyNames(obj).filter((k) => k !== 'constructor' && typeof Object.getOwnPropertyDescriptor(obj, k).value === 'function');
  const net = require('node:net');
  lock(net.Socket.prototype, ['connect']);
  lock(net.Server.prototype, ['listen']);
  lock(net, ['connect', 'createConnection']);
  const dgram = require('node:dgram');
  lock(dgram.Socket.prototype, ['bind', 'connect', 'send']);
  const dns = require('node:dns');
  lock(dns, functionsOf(dns).filter((k) => /^(lookup|resolve|reverse)/.test(k)));
  lock(dns.promises, functionsOf(dns.promises).filter((k) => /^(lookup|resolve|reverse)/.test(k)));
  lock(dns.Resolver.prototype, functionsOf(dns.Resolver.prototype));
  lock(dns.promises.Resolver.prototype, functionsOf(dns.promises.Resolver.prototype));
  lock(process, ['binding', '_linkedBinding']);
  for (const name of ['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest']) {
    try { Object.defineProperty(globalThis, name, { value: deny, writable: false, configurable: false }); } catch {}
  }
})();
`;

/** Programa del proceso hijo: lee {code, timeoutMs} por la entrada estándar y escribe un JSON con el resultado. */
const RUNNER = `
'use strict';
${SANDBOX_NETWORK_LOCKDOWN}
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
      'console.info = console.warn = console.error = console.debug = console.log;' +
      // Error que se entrega a quien use import(): creado DENTRO del contexto, para no filtrar objetos del anfitrión.
      'globalThis.__noImport = () => { throw new Error("import() no está disponible en el entorno aislado."); };',
      context,
    );
    const noImport = context.__noImport;
    const run = (source, ms) => new vm.Script(source, { importModuleDynamically: () => noImport() }).runInContext(context, { timeout: ms });
    context.__result = run(code, timeoutMs);
    // Si el código devuelve una promesa se espera a su valor (ya resuelta gracias a microtaskMode).
    run(
      'globalThis.__state = "pending"; Promise.resolve(__result).then((v) => { globalThis.__value = v; __state = "ok"; }, (e) => { globalThis.__error = e; __state = "error"; });',
      timeoutMs,
    );
    const output = run(
      '(() => { if (__state === "pending") return JSON.stringify({ pending: true });' +
      ' if (__state === "error") return JSON.stringify({ thrown: String(__error && __error.message ? __error.message : __error) });' +
      ' let r; try { r = JSON.stringify(__value); } catch { r = undefined; }' +
      ' return JSON.stringify({ result: r === undefined ? String(__value) : JSON.parse(r), logs: __logs }); })()',
      1000,
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

/** ¿Esta versión de Node tiene permiso de red? Si lo tiene, `--permission` la deniega por sí solo. */
export function hasNetPermission(): boolean {
  return process.allowedNodeEnvironmentFlags.has('--allow-net');
}

/** Argumentos de Node del proceso aislado (exportados para poder comprobar en tests lo que de verdad restringen). */
export function sandboxNodeArgs(): string[] {
  const permission = process.allowedNodeEnvironmentFlags.has('--permission') ? '--permission' : '--experimental-permission';
  // --experimental-vm-modules: sin él, import() dentro del contexto falla al instante con un error creado en el
  // proceso anfitrión (un objeto de fuera al alcance del código). Con él, la petición pasa por nuestra función,
  // que la rechaza; la promesa no se resuelve dentro del tiempo del código y no se entrega ningún objeto ajeno.
  return [permission, '--max-old-space-size=64', '--disallow-code-generation-from-strings', '--experimental-vm-modules', '--no-warnings'];
}

// Pocas ejecuciones a la vez: cada una es un proceso (o un contenedor) con su propia memoria.
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

export interface SandboxResult {
  result: unknown;
  logs: string[];
}

export async function runJavaScript(
  code: string,
  opts: { timeoutMs?: number; signal?: AbortSignal; backend?: Settings['codeSandbox'] } = {},
): Promise<SandboxResult> {
  if (code.length > MAX_CODE_CHARS) throw new ToolError(msg('codeTooLong', { max: MAX_CODE_CHARS }));
  if (opts.signal?.aborted) throw opts.signal.reason;
  const timeoutMs = opts.timeoutMs ?? 5000;
  await acquire(opts.signal);
  try {
    return opts.backend === 'container' ? await runInContainer(code, timeoutMs, opts.signal) : await runInChild(code, timeoutMs, opts.signal);
  } finally {
    release();
  }
}

/** Recoge la salida del proceso aislado, aplica los límites y traduce el resultado. */
function collect(
  child: ChildProcessWithoutNullStreams,
  input: { code: string; timeoutMs: number },
  opts: { graceMs: number; signal?: AbortSignal; memoryMb: number; onKill?: () => void; startError: (stderr: string) => CodedMessage | null },
): Promise<SandboxResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (child.exitCode === null) {
        child.kill('SIGKILL');
        opts.onKill?.();
      }
      fn();
    };
    const onAbort = () => finish(() => reject(opts.signal!.reason));
    // Margen para el arranque; el límite fino lo aplica vm dentro del proceso aislado.
    const timer = setTimeout(() => finish(() => reject(new ToolError(msg('codeTimeout', { ms: input.timeoutMs })))), input.timeoutMs + opts.graceMs);
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.length > MAX_OUTPUT_BYTES) finish(() => reject(new ToolError(msg('codeOutputTooLarge'))));
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 4000) stderr += chunk;
    });
    child.on('error', (err) => finish(() => reject(new ToolError(msg('sandboxStartFailed', { detail: err.message })))));
    child.on('close', () =>
      finish(() => {
        let message: { ok: boolean; output?: string; error?: string };
        try {
          message = JSON.parse(stdout);
        } catch {
          const startProblem = opts.startError(stderr);
          if (startProblem) return reject(new ToolError(startProblem));
          const oom = /heap out of memory|Allocation failed/i.test(stderr);
          return reject(new ToolError(oom ? msg('codeOutOfMemory', { mb: opts.memoryMb }) : msg('codeNoResult')));
        }
        if (!message.ok) return reject(new ToolError(msg('codeError', { detail: String(message.error) })));
        const output = JSON.parse(message.output!) as { result?: unknown; logs?: string[]; pending?: boolean; thrown?: string };
        if (output.pending) return reject(new ToolError(msg('codePendingPromise')));
        if (output.thrown !== undefined) return reject(new ToolError(msg('codeError', { detail: String(output.thrown) })));
        resolve({ result: output.result, logs: output.logs ?? [] });
      }),
    );
    child.stdin.on('error', () => undefined); // el proceso pudo morir antes de leer
    child.stdin.end(JSON.stringify(input));
  });
}

function runInChild(code: string, timeoutMs: number, signal?: AbortSignal): Promise<SandboxResult> {
  const child = spawn(process.execPath, [...sandboxNodeArgs(), '-e', RUNNER], {
    // Sin variables de entorno (ni claves, ni rutas) y en un directorio que no es el del proyecto.
    env: {},
    cwd: os.tmpdir(),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  return collect(child, { code, timeoutMs }, { graceMs: 3000, signal, memoryMb: 64, startError: () => null });
}

// ---------- Contenedor ----------
export interface ContainerEngine {
  engine: 'docker' | 'podman';
  version: string;
}

function exec(command: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      return resolve({ code: null, stdout, stderr: (err as Error).message });
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end();
  });
}

let engineCache: { at: number; value: ContainerEngine | null; error: CodedMessage | null } | null = null;

/** Busca un motor de contenedores en marcha (Docker o Podman). El resultado se recuerda 30 s. */
export async function detectContainerEngine(force = false): Promise<{ value: ContainerEngine | null; error: CodedMessage | null }> {
  if (!force && engineCache && Date.now() - engineCache.at < 30_000) return engineCache;
  let error: CodedMessage | null = null;
  let value: ContainerEngine | null = null;
  for (const engine of ['docker', 'podman'] as const) {
    const res = await exec(engine, ['version', '--format', engine === 'docker' ? '{{.Server.Version}}' : '{{.Version}}'], 6000);
    if (res.code === 0 && res.stdout.trim()) {
      value = { engine, version: res.stdout.trim() };
      error = null;
      break;
    }
    if (res.code !== null) error ??= msg('containerEngineDown', { engine: engine === 'docker' ? 'Docker' : 'Podman' });
  }
  if (!value) error ??= msg('containerEngineMissing');
  engineCache = { at: Date.now(), value, error };
  return engineCache;
}

/** ¿Está descargada la imagen del entorno aislado? (No se descarga sola: AgentForge no baja nada sin que lo pidas.) */
export async function containerImagePresent(engine: ContainerEngine['engine'], image = SANDBOX_IMAGE): Promise<boolean> {
  return (await exec(engine, ['image', 'inspect', image, '--format', '{{.Id}}'], 6000)).code === 0;
}

/** Argumentos de `docker run` / `podman run` del entorno aislado (exportados para comprobar lo que restringen). */
export function containerRunArgs(name: string, image = SANDBOX_IMAGE): string[] {
  return [
    'run',
    '--rm',
    '-i',
    '--name',
    name,
    '--pull=never',
    '--network',
    'none',
    '--read-only',
    '--tmpfs',
    '/tmp:rw,size=16m',
    '--memory',
    '160m',
    '--memory-swap',
    '160m',
    '--cpus',
    '1',
    '--pids-limit',
    '64',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--user',
    '65534:65534',
    image,
    'node',
    '--max-old-space-size=64',
    '--disallow-code-generation-from-strings',
    '--experimental-vm-modules',
    '--no-warnings',
    '-e',
    RUNNER,
  ];
}

async function runInContainer(code: string, timeoutMs: number, signal?: AbortSignal): Promise<SandboxResult> {
  const { value: found, error } = await detectContainerEngine();
  if (!found) throw new ToolError(msg('containerSandboxUnavailable', { detail: error ?? '' }));
  const name = `agentforge-sbx-${randomBytes(6).toString('hex')}`;
  const child = spawn(found.engine, containerRunArgs(name), { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  return collect(
    child,
    { code, timeoutMs },
    {
      // Arrancar un contenedor tarda bastante más que un proceso.
      graceMs: 20_000,
      signal,
      memoryMb: 64,
      // Matar el cliente no detiene el contenedor: hay que pedírselo al motor.
      onKill: () => void exec(found.engine, ['kill', name], 10_000),
      startError: (stderr) =>
        /No such image|image not known|pull access denied|not found locally|Unable to find image/i.test(stderr)
          ? msg('sandboxImageMissing', { image: SANDBOX_IMAGE, engine: found.engine })
          : stderr.trim() && !/heap out of memory|Allocation failed/i.test(stderr)
            ? msg('containerStartFailed', { detail: stderr.trim().slice(0, 400) })
            : null,
    },
  );
}

// ---------- Comprobación real del corte de red ----------
/**
 * Comprueba de verdad si el proceso aislado puede abrir una conexión: lanza un proceso con los mismos argumentos
 * y el mismo preludio y le pide conectarse a un servidor local que solo existe para esta prueba.
 * Devuelve true si la conexión NO llegó.
 */
export function probeProcessNetworkBlocked(): Promise<boolean> {
  return new Promise((resolve) => {
    let reached = false;
    const server = net.createServer((socket) => {
      reached = true;
      socket.destroy();
    });
    server.on('error', () => resolve(false));
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      const attack = `
        ${SANDBOX_NETWORK_LOCKDOWN}
        const finish = () => setTimeout(() => process.exit(0), 150);
        try {
          const socket = new (require('node:net').Socket)();
          socket.on('error', finish);
          socket.connect(${port}, '127.0.0.1', finish);
        } catch { finish(); }
      `;
      const child = spawn(process.execPath, [...sandboxNodeArgs(), '-e', attack], { env: {}, cwd: os.tmpdir(), stdio: 'ignore', windowsHide: true });
      const done = () => {
        clearTimeout(timer);
        // Un instante para que una conexión ya aceptada por el sistema llegue al manejador.
        setTimeout(() => server.close(() => resolve(!reached)), 100);
      };
      const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
      child.on('error', done);
      child.on('close', done);
    });
  });
}

export interface SandboxStatus {
  process: {
    /** ¿El proceso aislado se queda sin red? Comprobado con una conexión real al arrancar. */
    networkBlocked: boolean;
    /** 'permission' = lo impide el modelo de permisos de Node; 'lockdown' = lo impide el preludio del proceso. */
    method: 'permission' | 'lockdown';
    nodeVersion: string;
  };
  container: {
    available: boolean;
    engine: ContainerEngine['engine'] | null;
    version: string | null;
    image: string;
    imagePresent: boolean;
    /** Por qué no está disponible, si no lo está (y el código de ese texto, para mostrarlo en otro idioma). */
    error: string | null;
    errorI18n?: ServerMessage | null;
  };
}

let processProbe: Promise<boolean> | null = null;

/** Estado real de los dos aislamientos (para Ajustes). La prueba de red del proceso se hace una sola vez. */
export async function sandboxStatus(force = false): Promise<SandboxStatus> {
  processProbe ??= probeProcessNetworkBlocked();
  const [networkBlocked, found] = await Promise.all([processProbe, detectContainerEngine(force)]);
  const imagePresent = found.value ? await containerImagePresent(found.value.engine) : false;
  const problem = found.value ? (imagePresent ? null : msg('containerImageMissing', { image: SANDBOX_IMAGE, engine: found.value.engine })) : found.error;
  return {
    process: { networkBlocked, method: hasNetPermission() ? 'permission' : 'lockdown', nodeVersion: process.version },
    container: {
      available: Boolean(found.value) && imagePresent,
      engine: found.value?.engine ?? null,
      version: found.value?.version ?? null,
      image: SANDBOX_IMAGE,
      imagePresent,
      error: problem?.message ?? null,
      errorI18n: problem ? refOf(problem) : null,
    },
  };
}
