// Fiabilidad del ciclo de vida: apagado reanudable, respuestas cortadas, configuración fuera de rango,
// migraciones, bloqueo de instancia única y validación de la configuración del servidor.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import zlib from 'node:zlib';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { Run } from '../../shared/types';
import { buildApp } from '../src/app';
import { ConfigurationError, loadConfig } from '../src/config';
import { createContext, type AppContext } from '../src/context';
import { openDatabase, SCHEMA_VERSION } from '../src/db/database';
import { regexTest } from '../src/engine/regex';
import { LlmError, ToolError } from '../src/errors';
import { safeFetch } from '../src/tools/net';
import { raceAbort } from '../src/util';
import { addAgent, delay, edges, makeContext, node, runWorkflow, ScriptedLlm, stepStatus, tempDir, testConfig, userText, workflow } from './helpers';

let ctx: AppContext | undefined;
let app: FastifyInstance | undefined;
const dirs: string[] = [];
const cleanups: Array<() => unknown> = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
  await app?.close();
  await ctx?.close();
  app = undefined;
  ctx = undefined;
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const newDir = () => {
  const dir = tempDir();
  dirs.push(dir);
  return dir;
};

/** Modelo que no responde hasta que se le cancela (como una llamada real en curso). */
const hangUntilAborted = (signal?: AbortSignal) =>
  new Promise<never>((_resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

describe('apagado ordenado', () => {
  it('deja las ejecuciones en curso y en cola INTERRUMPIDAS y reanudables, no canceladas por el usuario', async () => {
    const dataDir = newDir();
    const llm = new ScriptedLlm(async (req) => {
      if (userText(req).includes('lento')) return hangUntilAborted(req.signal);
      return { content: `hecho(${userText(req)})` };
    });
    ctx = makeContext(llm, { dataDir, inMemory: false });
    app = await buildApp(ctx);
    ctx.store.updateSettings({ maxConcurrentRuns: 1 });
    const agent = addAgent(ctx);
    const wf = ctx.store.createWorkflow(
      workflow(
        [node('entrada', 'input'), node('rapido', 'agent', { agentId: agent.id, prompt: 'rapido {{input}}' }), node('lento', 'agent', { agentId: agent.id, prompt: 'lento {{rapido}}' }), node('salida', 'output')],
        edges('entrada>rapido', 'rapido>lento', 'lento>salida'),
      ),
    );
    const active = ctx.runs.startWorkflowRun(wf, 'uno');
    const queued = ctx.runs.startWorkflowRun(wf, 'dos');
    // Se espera a que la primera esté atascada en el paso lento (el rápido ya ha terminado).
    for (let i = 0; i < 200 && llm.calls.length < 2; i++) await delay(10);
    expect(ctx.store.getRunSummary(active.id)!.status).toBe('running');
    expect(ctx.store.getRunSummary(queued.id)!.status).toBe('queued');

    expect(await ctx.stopRuns()).toBe(2);

    for (const id of [active.id, queued.id]) {
      const run = ctx.store.getRun(id)!;
      expect(run).toMatchObject({ status: 'failed', interrupted: true, error: 'Ejecución interrumpida por el apagado del servidor.' });
      expect(run.steps.some((s) => s.status === 'running' || s.status === 'pending')).toBe(false);
    }
    expect(stepStatus(ctx.store.getRun(active.id)!)).toMatchObject({ entrada: 'completed', rapido: 'completed', lento: 'cancelled' });

    // Tras «reiniciar» (mismo directorio de datos), la API ofrece reanudarlas y la reanudación reutiliza lo ya hecho.
    await app.close();
    await ctx.close();
    const llm2 = new ScriptedLlm((req) => ({ content: `hecho(${userText(req)})` }));
    ctx = makeContext(llm2, { dataDir, inMemory: false });
    app = await buildApp(ctx);
    expect(ctx.interruptedRuns).toBe(0); // ya estaban marcadas: no quedó nada «en curso» que marcar al arrancar
    const pending = (await app.inject({ method: 'GET', url: '/api/runs/interrupted' })).json() as Run[];
    expect(pending.map((r) => r.id).sort()).toEqual([active.id, queued.id].sort());

    const resumed = (await app.inject({ method: 'POST', url: '/api/runs/interrupted/resume', payload: { ids: [active.id] } })).json() as Run[];
    await ctx.runs.waitFor(resumed[0].id);
    expect(ctx.store.getRun(resumed[0].id)).toMatchObject({ status: 'completed', retryOf: active.id });
    // Solo se vuelve a llamar al modelo para el paso que no terminó.
    expect(llm2.calls.map(userText)).toEqual(['lento hecho(rapido uno)']);
  });

  it('no espera para siempre a una ejecución que no reacciona: vence el plazo y queda interrumpida', async () => {
    const llm = new ScriptedLlm(() => new Promise(() => undefined)); // ignora la cancelación por completo
    ctx = createContext({ ...testConfig(newDir()), shutdownGraceMs: 200 }, { llm, retryBaseDelayMs: 5 });
    const agent = addAgent(ctx);
    const wf = ctx.store.createWorkflow(workflow([node('a', 'agent', { agentId: agent.id, prompt: 'x' })], []));
    const run = ctx.runs.startWorkflowRun(wf, '');
    for (let i = 0; i < 100 && !llm.calls.length; i++) await delay(10);
    const started = Date.now();
    await ctx.stopRuns();
    expect(Date.now() - started).toBeLessThan(3000);
    expect(ctx.store.getRunSummary(run.id)).toMatchObject({ status: 'failed', interrupted: true });
  });

  it('«eliminar terminadas» conserva las interrumpidas que siguen pendientes de reanudar', async () => {
    const llm = new ScriptedLlm(async (req) => (userText(req) === 'colgada' ? hangUntilAborted(req.signal) : { content: 'ok' }));
    ctx = makeContext(llm, { dataDir: newDir(), inMemory: false });
    const agent = addAgent(ctx);
    const wf = ctx.store.createWorkflow(workflow([node('a', 'agent', { agentId: agent.id, prompt: '{{input}}' })], []));
    const done = ctx.runs.startWorkflowRun(wf, 'normal');
    await ctx.runs.waitFor(done.id);
    const stuck = ctx.runs.startWorkflowRun(wf, 'colgada');
    for (let i = 0; i < 100 && llm.calls.length < 2; i++) await delay(10);
    await ctx.stopRuns();
    expect(ctx.store.deleteFinishedRuns()).toBe(1);
    expect(ctx.store.listInterruptedRuns().map((r) => r.id)).toEqual([stuck.id]);
  });
});

describe('respuestas HTTP cortadas', () => {
  /** Servidor que anuncia gzip, envía el principio del cuerpo y luego se comporta según `mode`. */
  async function brokenGzipServer(mode: 'stall' | 'cut') {
    const sockets = new Set<import('node:net').Socket>();
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Encoding': 'gzip' });
      res.write(zlib.gzipSync('x'.repeat(50_000)).subarray(0, 20));
      if (mode === 'cut') setTimeout(() => res.socket?.destroy(), 30);
    });
    server.on('connection', (s) => {
      sockets.add(s);
      s.on('close', () => sockets.delete(s));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          for (const s of sockets) s.destroy();
          server.close(() => resolve());
        }),
    );
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  }

  it('una respuesta comprimida que se queda a medias termina con error al vencer el tiempo, no cuelga', async () => {
    const url = await brokenGzipServer('stall');
    const started = Date.now();
    await expect(safeFetch(url, { signal: new AbortController().signal, allowPrivate: true, timeoutMs: 400 })).rejects.toThrow(/tiempo de espera|Fallo de red/);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('una respuesta comprimida cuya conexión se corta termina con un error de red reintentable', async () => {
    const url = await brokenGzipServer('cut');
    const err = await safeFetch(url, { signal: new AbortController().signal, allowPrivate: true, timeoutMs: 5000 }).catch((e) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).retryable).toBe(true);
  });

  it('cancelar mientras se lee el cuerpo comprimido devuelve el control de inmediato', async () => {
    const url = await brokenGzipServer('stall');
    const controller = new AbortController();
    const pending = safeFetch(url, { signal: controller.signal, allowPrivate: true, timeoutMs: 10_000 });
    await delay(150);
    controller.abort(new Error('cancelado'));
    await expect(pending).rejects.toThrow('cancelado');
  });

  it('una herramienta que ignora la cancelación no retiene la ejecución ni el límite de duración', async () => {
    ctx = makeContext(new ScriptedLlm(() => ({ content: 'ok' })));
    ctx.tools.register({
      name: 'sorda',
      title: 'Sorda',
      description: 'No termina nunca ni atiende a la señal.',
      category: 'Pruebas',
      parameters: { type: 'object', properties: {} },
      execute: () => new Promise(() => undefined),
    });
    const started = Date.now();
    const run = await runWorkflow(ctx, workflow([node('t', 'tool', { tool: 'sorda', args: {} })], [], { maxDurationMs: 1000 }));
    expect(Date.now() - started).toBeLessThan(4000);
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/duración máxima/);
    expect(stepStatus(run)).toEqual({ t: 'cancelled' });
  });

  it('raceAbort se rechaza al abortar aunque la promesa no reaccione, y no deja rechazos sin dueño', async () => {
    const controller = new AbortController();
    const raced = raceAbort(new Promise(() => undefined), controller.signal);
    controller.abort(new Error('fuera'));
    await expect(raced).rejects.toThrow('fuera');
    await expect(raceAbort(Promise.reject(new Error('tarde')), controller.signal)).rejects.toThrow('fuera');
    await expect(raceAbort(Promise.resolve(7), new AbortController().signal)).resolves.toBe(7);
  });
});

describe('configuración de nodos fuera de rango', () => {
  it('la API rechaza tiempos máximos, reintentos y límites absurdos al guardar y al importar', async () => {
    ctx = makeContext(new ScriptedLlm(() => ({ content: 'ok' })));
    app = await buildApp(ctx);
    const agent = addAgent(ctx);
    const base = workflow([node('a', 'agent', { agentId: agent.id, prompt: 'x', timeoutMs: 5e9 })], []);
    const res = await app.inject({ method: 'POST', url: '/api/workflows', payload: base });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/tiempo máximo/i);
    for (const config of [{ retries: 9 }, { timeoutMs: 1.5 }, { concurrency: 50 }, { maxItems: 0 }, { timeoutMs: '1000' }]) {
      const bad = workflow([node('a', 'agent', { agentId: agent.id, prompt: 'x', ...config })], []);
      expect((await app.inject({ method: 'POST', url: '/api/workflows', payload: bad })).statusCode).toBe(400);
    }
    const imported = await app.inject({
      method: 'POST',
      url: '/api/workflows/import',
      payload: { format: 'agentforge.workflow', version: 1, workflow: base, agents: [] },
    });
    expect(imported.statusCode).toBe(400);
    const ok = workflow([node('a', 'agent', { agentId: agent.id, prompt: 'x', timeoutMs: 60_000, retries: 2 })], []);
    expect((await app.inject({ method: 'POST', url: '/api/workflows', payload: ok })).statusCode).toBe(201);
  });

  it('si un valor fuera de rango llega al motor (datos antiguos), la ejecución no deja pasos «en curso» ni nodos huérfanos', async () => {
    const llm = new ScriptedLlm(async (req) => {
      await delay(40);
      return { content: `eco(${userText(req)})` };
    });
    ctx = makeContext(llm);
    const agent = addAgent(ctx);
    // Se escribe directamente en el almacén, saltándose la validación de la API.
    const run = await runWorkflow(
      ctx,
      workflow(
        [node('a', 'agent', { agentId: agent.id, prompt: 'a', timeoutMs: 5e9 }), node('b', 'agent', { agentId: agent.id, prompt: 'b', timeoutMs: 2 ** 31 + 5 })],
        [],
        { onError: 'continue' },
      ),
    );
    // El tiempo máximo se recorta al tope admitido en lugar de lanzar o de vencer al instante.
    expect(run.status).toBe('completed');
    expect(stepStatus(run)).toEqual({ a: 'completed', b: 'completed' });
  });
});

describe('reintentos', () => {
  it('un error sin marca de transitorio no se reintenta; uno de red sí', async () => {
    ctx = makeContext(new ScriptedLlm(() => ({ content: 'ok' })));
    let calls = 0;
    ctx.tools.register({
      name: 'fragil',
      title: 'Frágil',
      description: 'Falla según el modo.',
      category: 'Pruebas',
      parameters: { type: 'object', properties: { modo: { type: 'string' } } },
      async execute({ modo }) {
        calls++;
        if (modo === 'argumentos') throw new ToolError('Argumento no válido.');
        if (modo === 'bug') throw new TypeError('x is not a function');
        if (modo === 'red' && calls < 3) throw new ToolError('Fallo de red.', { retryable: true });
        return 'listo';
      },
    });
    const once = async (modo: string) => {
      calls = 0;
      const run = await runWorkflow(ctx!, workflow([node('t', 'tool', { tool: 'fragil', args: { modo }, retries: 3 })], []));
      return { status: run.status, calls, attempt: run.steps[0].attempt };
    };
    expect(await once('argumentos')).toEqual({ status: 'failed', calls: 1, attempt: 1 });
    expect(await once('bug')).toEqual({ status: 'failed', calls: 1, attempt: 1 });
    expect(await once('red')).toEqual({ status: 'completed', calls: 3, attempt: 3 });
  });

  it('un agente que ya ejecutó una herramienta y falla por un error no transitorio no repite la herramienta', async () => {
    let toolCalls = 0;
    const llm = new ScriptedLlm((_req, i) => {
      if (i === 0) return { toolCalls: [{ id: 'c1', name: 'apunta', arguments: {} }] };
      throw new LlmError('modelo descargado', { retryable: false, status: 404 });
    });
    ctx = makeContext(llm);
    ctx.tools.register({
      name: 'apunta',
      title: 'Apunta',
      description: 'Tiene un efecto que no debe duplicarse.',
      category: 'Pruebas',
      parameters: { type: 'object', properties: {} },
      async execute() {
        return `apunte ${++toolCalls}`;
      },
    });
    const agent = addAgent(ctx, { tools: ['apunta'] });
    const run = await runWorkflow(ctx, workflow([node('a', 'agent', { agentId: agent.id, prompt: 'x', retries: 3 })], []));
    expect(run.status).toBe('failed');
    expect(toolCalls).toBe(1);
  });
});

describe('expresiones regulares en condiciones', () => {
  it('una expresión con retroceso catastrófico se corta y no congela el servidor', async () => {
    // Mientras se evalúa, el bucle de eventos debe seguir atendiendo: se cuenta cuántas veces corre un temporizador.
    let ticks = 0;
    const timer = setInterval(() => ticks++, 20);
    const started = Date.now();
    try {
      await expect(regexTest('(a+)+$', `${'a'.repeat(40)}!`, { timeoutMs: 500 })).rejects.toThrow(/tardó más de 500 ms/);
    } finally {
      clearInterval(timer);
    }
    expect(Date.now() - started).toBeLessThan(3000);
    expect(ticks).toBeGreaterThan(10);
  });

  it('en un workflow, la condición «coincide con» maliciosa falla el nodo con un mensaje claro', async () => {
    ctx = makeContext(new ScriptedLlm(() => ({ content: 'ok' })));
    const run = await runWorkflow(
      ctx,
      workflow(
        [node('entrada', 'input'), node('cond', 'condition', { left: '{{input}}', operator: 'matches', right: '(a+)+$' }), node('si', 'transform', { template: 'sí' })],
        edges('entrada>cond', 'cond:true>si'),
      ),
      `${'a'.repeat(40)}!`,
    );
    expect(run.status).toBe('failed');
    expect(run.steps.find((s) => s.nodeId === 'cond')!.error).toMatch(/tardó más de/);
  });

  it('las expresiones normales siguen funcionando y se pueden cancelar', async () => {
    expect(await regexTest('^pedido \\d+$', 'Pedido 42')).toBe(true);
    expect(await regexTest('^pedido \\d+$', 'otra cosa')).toBe(false);
    await expect(regexTest('(', 'x')).rejects.toThrow(/no válida/);
    const controller = new AbortController();
    const pending = regexTest('(a+)+$', `${'a'.repeat(40)}!`, { timeoutMs: 10_000, signal: controller.signal });
    controller.abort(new Error('cancelada'));
    await expect(pending).rejects.toThrow('cancelada');
  });
});

describe('base de datos', () => {
  it('rechaza abrir una base de una versión más reciente que el código', () => {
    const file = path.join(newDir(), 'agentforge.db');
    openDatabase(file).close();
    const raw = new DatabaseSync(file);
    raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    raw.close();
    expect(() => openDatabase(file)).toThrow(/más reciente/);
    // El archivo no se toca: sigue en la versión que tenía.
    const check = new DatabaseSync(file);
    expect((check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION + 1);
    check.close();
  });

  it('antes de migrar una base con datos guarda una copia coherente de la versión anterior', () => {
    const dir = newDir();
    const file = path.join(dir, 'agentforge.db');
    const v1 = ['CREATE TABLE notas (id INTEGER PRIMARY KEY, texto TEXT NOT NULL);'];
    const db1 = openDatabase(file, v1);
    db1.prepare('INSERT INTO notas (texto) VALUES (?)').run('antes de migrar');
    db1.close();
    expect(fs.existsSync(`${file}.v1.bak`)).toBe(false); // una base nueva no necesita copia

    const db2 = openDatabase(file, [...v1, 'ALTER TABLE notas ADD COLUMN extra TEXT;']);
    expect((db2.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(2);
    db2.close();

    const backup = new DatabaseSync(`${file}.v1.bak`);
    expect((backup.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(1);
    expect(backup.prepare('SELECT texto FROM notas').all()).toEqual([{ texto: 'antes de migrar' }]);
    // La copia es la versión anterior: no tiene la columna nueva.
    expect((backup.prepare('PRAGMA table_info(notas)').all() as Array<{ name: string }>).map((c) => c.name)).toEqual(['id', 'texto']);
    backup.close();
  });

  it('si una migración falla, la base queda en la versión anterior y con sus datos', () => {
    const file = path.join(newDir(), 'agentforge.db');
    const v1 = ['CREATE TABLE notas (id INTEGER PRIMARY KEY, texto TEXT NOT NULL);'];
    const db1 = openDatabase(file, v1);
    db1.prepare('INSERT INTO notas (texto) VALUES (?)').run('intacta');
    db1.close();
    expect(() => openDatabase(file, [...v1, 'ALTER TABLE notas ADD COLUMN extra TEXT; CREATE TABLE notas (x);'])).toThrow();
    const check = new DatabaseSync(file);
    expect((check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(1);
    expect((check.prepare('PRAGMA table_info(notas)').all() as Array<{ name: string }>).map((c) => c.name)).toEqual(['id', 'texto']);
    expect(check.prepare('SELECT texto FROM notas').all()).toEqual([{ texto: 'intacta' }]);
    check.close();
  });

  it('una API key que ya no se puede descifrar da un mensaje accionable, no un error interno', async () => {
    const dataDir = newDir();
    ctx = makeContext(new ScriptedLlm(() => ({ content: 'ok' })), { dataDir, inMemory: false });
    const provider = ctx.store.createProvider({ name: 'Con clave', kind: 'openai', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'sk-secreta' });
    const agent = addAgent(ctx, { providerId: provider.id });
    await ctx.close();
    // Se pierde la clave maestra: al volver a arrancar se genera otra distinta.
    fs.rmSync(path.join(dataDir, 'secret.key'));
    ctx = makeContext(new ScriptedLlm(() => ({ content: 'ok' })), { dataDir, inMemory: false });
    app = await buildApp(ctx);

    const health = await app.inject({ method: 'GET', url: '/api/providers/health?force=1' });
    expect(health.statusCode).toBe(200);
    expect(health.json()[0]).toMatchObject({ ok: false, error: expect.stringContaining('Vuelve a introducirla') });
    const models = await app.inject({ method: 'GET', url: `/api/providers/${provider.id}/models` });
    expect(models.statusCode).toBe(409);
    expect(models.json().error).toMatch(/No se pudo descifrar la API key de «Con clave»/);

    const run = ctx.runs.startAgentRun(ctx.store.getAgent(agent.id)!, 'hola');
    await ctx.runs.waitFor(run.id);
    expect(ctx.store.getRunSummary(run.id)!.error).toMatch(/No se pudo descifrar la API key/);
  });
});

describe('instancia única por carpeta de datos', () => {
  it('no arranca si otro proceso vivo ya usa la carpeta, y sí si el bloqueo es de un proceso que ya no existe', async () => {
    const dataDir = newDir();
    const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    cleanups.push(() => other.kill());
    await new Promise((r) => other.once('spawn', r));
    fs.writeFileSync(path.join(dataDir, 'agentforge.lock'), String(other.pid));
    const llm = new ScriptedLlm(() => ({ content: 'ok' }));
    expect(() => makeContext(llm, { dataDir, inMemory: false })).toThrow(/Ya hay otro servidor de AgentForge/);

    const exited = new Promise((r) => other.once('exit', r));
    other.kill();
    await exited;
    ctx = makeContext(llm, { dataDir, inMemory: false });
    expect(fs.readFileSync(path.join(dataDir, 'agentforge.lock'), 'utf8')).toBe(String(process.pid));
    await ctx.close();
    ctx = undefined;
    expect(fs.existsSync(path.join(dataDir, 'agentforge.lock'))).toBe(false);
  });
});

describe('validación de la configuración', () => {
  const load = (env: Record<string, string>) => loadConfig(env as NodeJS.ProcessEnv);

  it('acepta los valores por defecto y los valores válidos', () => {
    expect(load({})).toMatchObject({ port: 4310, host: '127.0.0.1', seed: true, logLevel: 'info', authToken: null, allowedHosts: [], rateLimitPerMinute: 1200 });
    expect(load({ PORT: '8080', AGENTFORGE_SEED: 'false', AGENTFORGE_LOG_LEVEL: 'DEBUG', AGENTFORGE_ALLOWED_HOSTS: 'Forge.Example, otro.test' })).toMatchObject({
      port: 8080,
      seed: false,
      logLevel: 'debug',
      allowedHosts: ['forge.example', 'otro.test'],
    });
    // Compatibilidad con la variable antigua.
    expect(load({ AGENTFORGE_LOG: '0' }).logLevel).toBe('silent');
    expect(load({ AGENTFORGE_LOG: '1' }).logLevel).toBe('debug');
  });

  it.each([
    [{ PORT: 'abc' }, /PORT="abc"/],
    [{ PORT: '0' }, /PORT="0"/],
    [{ PORT: '70000' }, /PORT/],
    [{ OLLAMA_URL: 'ollama:11434' }, /OLLAMA_URL/],
    [{ AGENTFORGE_SEED: 'quizá' }, /AGENTFORGE_SEED/],
    [{ AGENTFORGE_LOG_LEVEL: 'verbose' }, /AGENTFORGE_LOG_LEVEL/],
    [{ AGENTFORGE_SCHEDULER_TICK_MS: '10' }, /AGENTFORGE_SCHEDULER_TICK_MS/],
    [{ AGENTFORGE_ALLOWED_HOSTS: 'http://forge.example/' }, /AGENTFORGE_ALLOWED_HOSTS/],
    [{ AGENTFORGE_TOKEN: 'corta' }, /al menos 16 caracteres/],
  ])('rechaza %j con un mensaje que nombra la variable', (env, pattern) => {
    expect(() => load(env as Record<string, string>)).toThrow(ConfigurationError);
    expect(() => load(env as Record<string, string>)).toThrow(pattern);
  });

  it('se niega a escuchar fuera de este equipo sin clave de acceso', () => {
    expect(() => load({ HOST: '0.0.0.0' })).toThrow(/AGENTFORGE_TOKEN/);
    expect(() => load({ HOST: '192.168.1.20' })).toThrow(/AGENTFORGE_TOKEN/);
    expect(load({ HOST: '0.0.0.0', AGENTFORGE_TOKEN: 'una-clave-bien-larga' })).toMatchObject({ host: '0.0.0.0', authToken: 'una-clave-bien-larga' });
    expect(load({ HOST: 'localhost' }).authToken).toBeNull();
    expect(load({ HOST: '::1' }).authToken).toBeNull();
  });

  it('informa de todos los problemas a la vez', () => {
    const err = (() => {
      try {
        load({ PORT: 'x', AGENTFORGE_SEED: 'y' });
      } catch (e) {
        return e as ConfigurationError;
      }
    })();
    expect(err?.problems).toHaveLength(2);
  });
});
