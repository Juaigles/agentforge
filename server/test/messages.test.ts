// Textos del servidor con código: lo que llega a la pantalla (errores de validación, errores de la API, motivo de
// fallo de una ejecución, errores de herramientas, avisos de la importación) lleva, junto al texto en español, el
// código y los parámetros con los que la interfaz lo muestra en otro idioma.
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { flattenParams, msg, SERVER_MESSAGES, type ServerCode, type ServerMessage } from '../../shared/server-messages';
import type { ImportPlan, Run, RunEvent, Trigger } from '../../shared/types';
import { VALIDATION_MESSAGES, type IssueParams, type ValidationCode } from '../../shared/validation-messages';
import { buildApp } from '../src/app';
import type { AppContext } from '../src/context';
import { SCHEMA_VERSION } from '../src/db/database';
import { LlmError } from '../src/errors';
import { addAgent, edges, makeContext, node, ScriptedLlm, tempDir, userText, workflow, type ScriptHandler } from './helpers';

let ctx: AppContext | undefined;
let app: FastifyInstance | undefined;

async function boot(handler: ScriptHandler = (req) => ({ content: `eco(${userText(req)})` }), opts: { dataDir?: string; inMemory?: boolean } = {}) {
  ctx = makeContext(new ScriptedLlm(handler), opts);
  app = await buildApp(ctx);
  return { ctx, app };
}

afterEach(async () => {
  await app?.close();
  await ctx?.close();
  app = undefined;
  ctx = undefined;
});

const request = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) => app!.inject({ method, url, payload: payload as object });
const get = (url: string) => request('GET', url);
const post = (url: string, payload: unknown = {}) => request('POST', url, payload);

/** Texto en español de una referencia: el de la tabla del servidor o, para un problema de un workflow, el de la suya. */
function spanish(ref: ServerMessage): string {
  const params = flattenParams(ref.params, (nested) => spanish(nested));
  if (Object.hasOwn(SERVER_MESSAGES, ref.code)) return SERVER_MESSAGES[ref.code as ServerCode](params);
  if (Object.hasOwn(VALIDATION_MESSAGES, ref.code)) return VALIDATION_MESSAGES[ref.code as ValidationCode](params as IssueParams);
  throw new Error(`Código sin texto en español: ${ref.code}`);
}

/** Comprueba que el texto que acompaña a una referencia es exactamente el que sale de su código y sus parámetros. */
function expectCoded(text: unknown, ref: unknown, code?: ServerCode): void {
  expect(ref, `sin referencia para «${String(text)}»`).toMatchObject({ code: expect.any(String) });
  if (code) expect((ref as ServerMessage).code).toBe(code);
  expect(spanish(ref as ServerMessage)).toBe(text);
}

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? sources(full) : entry.name.endsWith('.ts') ? [full] : [];
  });
}

describe('tabla de textos del servidor', () => {
  it('`msg` devuelve el código, los parámetros y el texto en español; una causa anidada se escribe con su texto', () => {
    expect(msg('notFound', { kind: 'agent' })).toEqual({ code: 'notFound', params: { kind: 'agent' }, message: 'Agente no encontrado.' });
    const cause = msg('calcDivisionByZero');
    expect(msg('runNodeFailed', { name: 'Calcular', cause }).message).toBe('El nodo "Calcular" falló: División entre cero.');
    // Una lista de mensajes (los problemas de unos argumentos) se une en una sola frase.
    expect(msg('toolArgsInvalid', { problems: [msg('argMissing', { name: 'url' }), msg('argNotNumber', { name: 'n' })] }).message).toBe(
      'Argumentos no válidos: falta el parámetro obligatorio "url"; "n" debe ser un número.',
    );
  });

  it('ningún código coincide con uno de la validación de workflows (una causa puede venir de cualquiera de las dos tablas)', () => {
    expect(Object.keys(SERVER_MESSAGES).filter((code) => Object.hasOwn(VALIDATION_MESSAGES, code))).toEqual([]);
  });

  it('todo código de la tabla se usa en el servidor, y los errores de la API y del motor no se escriben con texto suelto', () => {
    const files = sources(srcDir).map((file) => ({ file: path.relative(srcDir, file).replace(/\\/g, '/'), text: fs.readFileSync(file, 'utf8') }));
    const used = new Set<string>();
    for (const { text } of files)
      for (const match of text.matchAll(/\b(?:msg|serverMsg|coded)\(\s*(?:[\w.]+\s*\?\s*)?'(\w+)'(?:\s*:\s*'(\w+)')?/g))
        used.add(match[1]).add(match[2] ?? match[1]);
    expect(Object.keys(SERVER_MESSAGES).filter((code) => !used.has(code))).toEqual([]);
    // Un error de los que llegan a la pantalla construido con un texto entre comillas no se podría traducir.
    const loose = files.flatMap(({ file, text }) =>
      [...text.matchAll(/new (?:HttpError\(\s*\d+,|ConfigError\(|LimitError\(|LlmError\(|CronError\()\s*['`"]/g)].map((match) => `${file}: ${match[0]}`),
    );
    expect(loose).toEqual([]);
    // Los errores de herramientas con texto suelto que quedan son los que solo lee el modelo (bucle del agente).
    const looseTools = files.flatMap(({ file, text }) => (/new ToolError\(\s*['`"]/.test(text) ? [file] : []));
    expect(looseTools).toEqual(['engine/agent-runner.ts']);
  });
});

describe('errores de validación de formularios', () => {
  it('cada problema lleva su campo, el texto en español y el código con sus parámetros', async () => {
    await boot();
    const res = await post('/api/agents', { name: '', color: 'rojo', providerId: '', model: 'm', temperature: 9, maxIterations: 0, tools: 'no' });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    const byPath = Object.fromEntries(body.issues.map((issue: { path: string }) => [issue.path, issue]));
    expect(byPath.name).toEqual({ path: 'name', message: 'El nombre es obligatorio', code: 'nameRequired' });
    expect(byPath.color).toEqual({ path: 'color', message: 'Color hexadecimal no válido', code: 'colorInvalid' });
    expect(byPath.providerId).toEqual({ path: 'providerId', message: 'Selecciona un proveedor', code: 'providerRequired' });
    // Lo que zod detecta sin mensaje propio del esquema también tiene código (y ya no sale en inglés).
    expect(byPath.temperature).toEqual({ path: 'temperature', message: 'Debe ser 2 como máximo', code: 'tooBig', params: { max: 2 } });
    expect(byPath.maxIterations).toEqual({ path: 'maxIterations', message: 'Debe ser 1 como mínimo', code: 'tooSmall', params: { min: 1 } });
    expect(byPath.tools).toEqual({
      path: 'tools',
      message: 'El tipo del dato no es válido (se esperaba array)',
      code: 'invalidType',
      params: { expected: 'array' },
    });
    for (const issue of body.issues) expectCoded(issue.message, issue);
    // La frase de resumen lleva el primer problema, con su propia referencia.
    expect(body.error).toBe(`Datos no válidos: ${body.issues[0].path}: ${body.issues[0].message}`);
    expectCoded(body.error, body.i18n, 'invalidDataField');
    expect(body.i18n.params.detail).toMatchObject({ code: body.issues[0].code, message: body.issues[0].message });
  });

  it('un campo que falta, un texto demasiado largo y una opción no admitida', async () => {
    await boot();
    const missing = (await post('/api/agents', {})).json().issues as Array<{ path: string; code: string; message: string }>;
    expect(missing.find((i) => i.path === 'name')).toEqual({ path: 'name', message: 'Este dato es obligatorio', code: 'required' });
    const long = (await post('/api/providers', { name: 'x'.repeat(81), kind: 'otro', baseUrl: 'ftp://x' })).json().issues;
    expect(long).toEqual([
      { path: 'name', message: 'No puede superar los 80 caracteres', code: 'tooLong', params: { max: 80 } },
      { path: 'kind', message: 'Valor no admitido (los posibles son: ollama, openai)', code: 'invalidOption', params: { options: 'ollama, openai' } },
      { path: 'baseUrl', message: 'Debe ser una URL http(s) válida', code: 'urlInvalid' },
    ]);
  });

  it('los problemas con parámetros propios: límites de un nodo, zona horaria, expresión cron y parámetros de consulta', async () => {
    await boot();
    const wf = await post('/api/workflows', {
      name: 'wf',
      nodes: [{ id: 'a', type: 'agent', position: { x: 0, y: 0 }, config: { retries: 9 } }],
      edges: [],
    });
    expect(wf.json().issues).toEqual([
      {
        path: 'nodes.0.config.retries',
        message: 'El número de reintentos debe ser un número entero entre 0 y 5',
        code: 'nodeConfigRange',
        params: { field: 'retries', min: 0, max: 5 },
      },
    ]);

    const saved = ctx!.store.createWorkflow(workflow([node('entrada', 'input'), node('salida', 'output')], edges('entrada>salida')));
    const trigger = (extra: object) => post(`/api/workflows/${saved.id}/triggers`, { kind: 'cron', ...extra });
    expect((await trigger({ cron: '0 9 * *' })).json().issues).toEqual([
      {
        path: 'cron',
        message: 'La expresión debe tener cinco campos: minuto, hora, día del mes, mes y día de la semana (por ejemplo «0 9 * * 1-5»).',
        code: 'cronFieldCount',
      },
    ]);
    expect((await trigger({ cron: '0 25 * * *' })).json().issues).toEqual([
      {
        path: 'cron',
        message: '«25» no es un valor válido para el campo hora (0-23).',
        code: 'cronFieldValue',
        params: { value: '25', field: 'hour', min: 0, max: 23 },
      },
    ]);
    expect((await trigger({ cron: '0 9 * * *', timezone: 'Marte/Olympus' })).json().issues).toEqual([
      {
        path: 'timezone',
        message: '«Marte/Olympus» no es una zona horaria conocida (ejemplo: Europe/Madrid)',
        code: 'timezoneUnknown',
        params: { timezone: 'Marte/Olympus' },
      },
    ]);

    const query = (await get('/api/runs?limit=999&status=raro')).json();
    expect(query.issues).toEqual([
      { path: 'status', message: 'estado no reconocido', code: 'statusUnknown' },
      { path: 'limit', message: 'debe ser un número entero entre 1 y 200', code: 'intBetween', params: { min: 1, max: 200 } },
    ]);
  });
});

describe('errores de la API', () => {
  it('cada error lleva en `i18n` el código y los parámetros de su texto, y `code` sigue siendo la clase de error', async () => {
    await boot();
    const agent = addAgent(ctx!, { name: 'Usado' });
    const wf = ctx!.store.createWorkflow({
      ...workflow([node('entrada', 'input'), node('paso', 'agent', { agentId: agent.id, prompt: '{{entrada}}' })], edges('entrada>paso')),
      name: 'Con agente',
    });
    const broken = ctx!.store.createWorkflow(workflow([node('paso', 'agent', { agentId: 'no-existe', prompt: 'x' })], []));
    const run = ctx!.runs.startAgentRun(agent, 'hola');
    await ctx!.runs.waitFor(run.id);

    const cases: Array<[res: Awaited<ReturnType<typeof get>>, status: number, kind: string, i18n: ServerMessage]> = [
      [await get('/api/agents/nada'), 404, 'not_found', { code: 'notFound', params: { kind: 'agent' } }],
      [await get('/api/runs/nada'), 404, 'not_found', { code: 'notFound', params: { kind: 'run' } }],
      [await get('/api/no-existe'), 404, 'not_found', { code: 'notFound', params: { kind: 'route' } }],
      [await request('DELETE', `/api/agents/${agent.id}`), 409, 'bad_request', { code: 'agentInUse', params: { names: '«Con agente»' } }],
      [await request('DELETE', `/api/providers/${agent.providerId}`), 409, 'bad_request', { code: 'providerInUse', params: { count: 1 } }],
      [await post(`/api/agents/${agent.id}/run`, { input: '  ' }), 400, 'bad_request', { code: 'taskRequired' }],
      [await post(`/api/runs/${run.id}/cancel`), 409, 'bad_request', { code: 'runAlreadyFinished' }],
      [await post('/api/import/plan', { bundle: { format: 'otro' } }), 400, 'bad_request', { code: 'notExportBundle' }],
      [await get('/api/workspace/file?path=../fuera.txt'), 400, 'bad_request', { code: 'workspaceOutside', params: { path: '../fuera.txt' } }],
      [await post('/api/approvals/nada/decide', { approved: true }), 404, 'not_found', { code: 'notFound', params: { kind: 'approval' } }],
    ];
    for (const [res, status, kind, i18n] of cases) {
      const body = res.json();
      expect(res.statusCode, body.error).toBe(status);
      expect(body.code, body.error).toBe(kind);
      expect(body.i18n, body.error).toEqual(i18n);
      expectCoded(body.error, body.i18n);
    }

    // Lanzar un workflow con errores: el detalle es un problema de validación, con el código de su propia tabla.
    const invalid = (await post(`/api/workflows/${broken.id}/run`, { input: 'x' })).json();
    expect(invalid.i18n.code).toBe('workflowHasErrors');
    expect(invalid.i18n.params.detail).toMatchObject({ code: 'agentGone', params: { name: 'paso' } });
    expectCoded(invalid.error, invalid.i18n);
    expect(wf.id).toBeTruthy();
  });

  it('lo que no es nuestro (el texto de un error de fuera) viaja tal cual como parámetro', async () => {
    await boot();
    const malformed = await app!.inject({ method: 'POST', url: '/api/agents', headers: { 'content-type': 'application/json' }, payload: '{ no es json' });
    const body = malformed.json();
    expect(malformed.statusCode).toBe(400);
    expect(body.i18n).toEqual({ code: 'requestRejected', params: { detail: body.error } });
  });

  it('probar una herramienta que falla devuelve el motivo con su código', async () => {
    await boot();
    const division = (await post('/api/tools/calculator/invoke', { args: { expression: '1/0' } })).json();
    expect(division).toMatchObject({ ok: false, error: 'División entre cero.', errorI18n: { code: 'calcDivisionByZero' } });
    const args = (await post('/api/tools/http_request/invoke', { args: { method: 'TRACE' } })).json();
    expect(args.ok).toBe(false);
    expect(args.errorI18n.code).toBe('toolArgsInvalid');
    expect(args.errorI18n.params.problems.map((p: ServerMessage) => p.code)).toEqual(['argMissing', 'argNotInEnum']);
    expectCoded(args.error, args.errorI18n);
    const blocked = (await post('/api/tools/web_fetch/invoke', { args: { url: 'http://127.0.0.1:9/' } })).json();
    expect(blocked.errorI18n).toEqual({ code: 'privateNetworkBlocked', params: { host: '127.0.0.1' } });
  });
});

describe('motivo de fallo de una ejecución y de un paso', () => {
  const eventsOf = async (runId: string) => (await get(`/api/runs/${runId}/events`)).json() as RunEvent[];

  it('un fallo de configuración: el paso lleva su código y la ejecución, el del nodo con la causa anidada', async () => {
    await boot();
    const agent = addAgent(ctx!, { name: 'Sin modelo', model: ' ' });
    const started = ctx!.runs.startAgentRun(agent, 'hola');
    await ctx!.runs.waitFor(started.id);
    const run = (await get(`/api/runs/${started.id}`)).json() as Run;
    const cause = { code: 'agentNoModel', params: { name: 'Sin modelo' } };

    expect(run.status).toBe('failed');
    expect(run.steps[0]).toMatchObject({ status: 'failed', error: 'El agente «Sin modelo» no tiene modelo configurado.', errorI18n: cause });
    expect(run.error).toBe('El nodo "Sin modelo" falló: El agente «Sin modelo» no tiene modelo configurado.');
    expect(run.errorI18n).toEqual({ code: 'runNodeFailed', params: { name: 'Sin modelo', cause: { ...cause, message: run.steps[0].error } } });
    expectCoded(run.error, run.errorI18n);
    // El resumen de las listas y los eventos guardados llevan la misma referencia.
    const listed = (await get('/api/runs')).json().items[0];
    expect(listed).toMatchObject({ id: run.id, error: run.error, errorI18n: run.errorI18n });
    const events = await eventsOf(run.id);
    expect(events.find((e) => e.type === 'step.finished')!.data).toMatchObject({ status: 'failed', error: run.steps[0].error, errorI18n: cause });
    expect(events.find((e) => e.type === 'run.finished')!.data).toMatchObject({ status: 'failed', error: run.error, errorI18n: run.errorI18n });
  });

  it('el texto de un proveedor no se traduce: va como parámetro dentro de la frase del nodo', async () => {
    await boot(() => {
      throw new LlmError('model "x" not found, try pulling it first', { retryable: false, status: 404 });
    });
    const started = ctx!.runs.startAgentRun(addAgent(ctx!, { name: 'Agente' }), 'hola');
    await ctx!.runs.waitFor(started.id);
    const run = ctx!.store.getRun(started.id)!;
    expect(run.steps[0]).toMatchObject({ error: 'model "x" not found, try pulling it first', errorI18n: null });
    expect(run.errorI18n).toEqual({ code: 'runNodeFailed', params: { name: 'Agente', cause: 'model "x" not found, try pulling it first' } });
    expectCoded(run.error, run.errorI18n);
  });

  it('una herramienta que falla en un nodo, una rama no tomada y un nodo saltado por su dependencia', async () => {
    await boot();
    const wf = ctx!.store.createWorkflow(
      workflow(
        [
          node('entrada', 'input'),
          node('calc', 'tool', { tool: 'calculator', args: { expression: '{{entrada}}' } }),
          node('cond', 'condition', { left: '{{entrada}}', operator: 'contains', right: 'nunca' }),
          node('rama', 'transform', { template: 'no se ejecuta' }),
          node('salida', 'output', { template: '{{calc}}' }),
        ],
        edges('entrada>calc', 'entrada>cond', 'cond:true>rama', 'calc>salida'),
        { onError: 'continue' },
      ),
    );
    const started = ctx!.runs.startWorkflowRun(wf, '2 / 0');
    await ctx!.runs.waitFor(started.id);
    const run = ctx!.store.getRun(started.id)!;
    const step = (id: string) => run.steps.find((s) => s.nodeId === id)!;
    expect(step('calc')).toMatchObject({ status: 'failed', error: 'División entre cero.', errorI18n: { code: 'calcDivisionByZero' } });
    expect(run.errorI18n).toMatchObject({ code: 'runNodeFailed', params: { name: 'calc', cause: { code: 'calcDivisionByZero' } } });
    expectCoded(run.error, run.errorI18n);

    const events = await eventsOf(run.id);
    const result = events.find((e) => e.type === 'tool.result')!.data;
    expect(result).toMatchObject({ ok: false, result: 'Error: División entre cero.', errorI18n: { code: 'calcDivisionByZero' } });
    const skipped = Object.fromEntries(events.filter((e) => e.type === 'step.skipped').map((e) => [e.nodeId, e.data]));
    expect(skipped.rama).toEqual({ reason: 'Rama no tomada.', reasonI18n: { code: 'skipBranchNotTaken' } });
    expect(skipped.salida).toEqual({ reason: 'Una dependencia ha fallado.', reasonI18n: { code: 'skipDependencyFailed' } });
  });

  it('cancelar, superar el tiempo de un nodo y agotar la duración máxima tienen cada uno su código', async () => {
    const slow: ScriptHandler = async (req) => {
      await new Promise<void>((resolve) => req.signal?.addEventListener('abort', () => resolve()));
      throw req.signal!.reason;
    };
    await boot(slow);
    const agent = addAgent(ctx!, { name: 'Lento' });

    const cancelled = ctx!.runs.startAgentRun(agent, 'hola');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((await post(`/api/runs/${cancelled.id}/cancel`)).statusCode).toBe(200);
    await ctx!.runs.waitFor(cancelled.id);
    expect(ctx!.store.getRun(cancelled.id)).toMatchObject({
      status: 'cancelled',
      error: 'Ejecución cancelada por el usuario.',
      errorI18n: { code: 'runCancelledByUser' },
    });

    const flow = (settings: object, config: object) =>
      ctx!.store.createWorkflow(
        workflow([node('entrada', 'input'), node('paso', 'agent', { agentId: agent.id, prompt: '{{entrada}}', ...config })], edges('entrada>paso'), settings),
      );
    const timedOut = ctx!.runs.startWorkflowRun(flow({}, { timeoutMs: 40 }), 'x');
    await ctx!.runs.waitFor(timedOut.id);
    const timedOutRun = ctx!.store.getRun(timedOut.id)!;
    expect(timedOutRun.steps.find((s) => s.nodeId === 'paso')).toMatchObject({
      error: 'El nodo superó su tiempo máximo (40 ms).',
      errorI18n: { code: 'nodeTimeout', params: { ms: 40 } },
    });
    expect(timedOutRun.errorI18n).toMatchObject({ code: 'runNodeFailed', params: { cause: { code: 'nodeTimeout' } } });

    const tooLong = ctx!.runs.startWorkflowRun(flow({ maxDurationMs: 1000 }, {}), 'x');
    await ctx!.runs.waitFor(tooLong.id);
    expect(ctx!.store.getRun(tooLong.id)).toMatchObject({
      status: 'failed',
      error: 'Se superó la duración máxima de la ejecución (1 s).',
      errorI18n: { code: 'runMaxDuration', params: { seconds: 1 } },
    });
  });

  it('un «para cada» que falla: el elemento guarda su motivo y el nodo lo cita como causa', async () => {
    await boot((req) => {
      if (userText(req).includes('malo')) throw new LlmError('respuesta del proveedor', { retryable: false });
      return { content: 'bien' };
    });
    const agent = addAgent(ctx!);
    const wf = ctx!.store.createWorkflow(
      workflow(
        [node('entrada', 'input'), node('cada', 'foreach', { body: 'agent', agentId: agent.id, prompt: '{{item}}', items: '{{entrada}}', concurrency: 1 })],
        edges('entrada>cada'),
      ),
    );
    const started = ctx!.runs.startWorkflowRun(wf, '["bueno","malo"]');
    await ctx!.runs.waitFor(started.id);
    const run = ctx!.store.getRun(started.id)!;
    const step = run.steps.find((s) => s.nodeId === 'cada')!;
    expect(step.error).toBe('Elemento 2 de 2 («malo»): respuesta del proveedor');
    expect(step.errorI18n).toEqual({ code: 'foreachItemFailed', params: { index: 2, total: 2, item: 'malo', cause: 'respuesta del proveedor' } });
    expectCoded(run.error, run.errorI18n);
    const items = (await get(`/api/runs/${run.id}/steps/cada/items`)).json();
    expect(items[1]).toMatchObject({ status: 'failed', error: 'respuesta del proveedor', errorI18n: null });
  });

  it('el apagado del servidor deja la ejecución interrumpida con su código, y el arranque siguiente también', async () => {
    const dataDir = tempDir();
    const waiting: ScriptHandler = async (req) => {
      await new Promise<void>((resolve) => req.signal?.addEventListener('abort', () => resolve()));
      throw req.signal!.reason;
    };
    await boot(waiting, { dataDir, inMemory: false });
    const started = ctx!.runs.startAgentRun(addAgent(ctx!), 'hola');
    await new Promise((resolve) => setTimeout(resolve, 30));
    await app!.close();
    await ctx!.close();
    app = undefined;

    await boot(undefined, { dataDir, inMemory: false });
    expect(ctx!.store.getRun(started.id)).toMatchObject({
      status: 'failed',
      interrupted: true,
      error: 'Ejecución interrumpida por el apagado del servidor.',
      errorI18n: { code: 'runInterruptedByShutdown' },
    });
  });
});

describe('migración: ejecuciones anteriores a los códigos', () => {
  /** Última versión del esquema sin los códigos de los errores (la v7 los añadió). */
  const V6 = 6;
  it('una base del esquema anterior conserva el texto de sus errores, sin referencia, y admite las nuevas', async () => {
    const dataDir = tempDir();
    await boot(undefined, { dataDir, inMemory: false });
    const agent = addAgent(ctx!, { name: 'Sin modelo', model: ' ' });
    const old = ctx!.runs.startAgentRun(agent, 'antes');
    await ctx!.runs.waitFor(old.id);
    const wf = ctx!.store.createWorkflow(workflow([node('entrada', 'input'), node('salida', 'output')], edges('entrada>salida')));
    const trigger = ctx!.store.createTrigger(
      wf.id,
      { kind: 'interval', name: '', intervalMinutes: 5, time: null, weekdays: [], cron: null, timezone: null, input: '', enabled: true },
      null,
    );
    await app!.close();
    await ctx!.close();
    app = undefined;

    // Se devuelve el archivo al esquema v6 (el anterior a los códigos): sin las columnas de la referencia, solo con
    // el texto, y sin lo que añadieron las versiones posteriores.
    const file = path.join(dataDir, 'agentforge.db');
    const raw = new DatabaseSync(file);
    raw.exec(`
      DROP INDEX idx_workflows_builtin; DROP INDEX idx_agents_builtin;
      ALTER TABLE workflows DROP COLUMN builtin; ALTER TABLE agents DROP COLUMN builtin;
      ALTER TABLE runs DROP COLUMN error_i18n; ALTER TABLE run_steps DROP COLUMN error_i18n;
      ALTER TABLE run_step_items DROP COLUMN error_i18n; ALTER TABLE triggers DROP COLUMN last_error_i18n;
      PRAGMA user_version = ${V6};
    `);
    raw.prepare('UPDATE triggers SET last_error = ? WHERE id = ?').run('Se omitió una ejecución.', trigger.id);
    raw.close();

    await boot(undefined, { dataDir, inMemory: false });
    expect((ctx!.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
    expect(fs.existsSync(`${file}.v${V6}.bak`)).toBe(true);
    const migrated = (await get(`/api/runs/${old.id}`)).json() as Run;
    expect(migrated).toMatchObject({
      status: 'failed',
      error: 'El nodo "Sin modelo" falló: El agente «Sin modelo» no tiene modelo configurado.',
      errorI18n: null,
    });
    expect(migrated.steps[0]).toMatchObject({ error: 'El agente «Sin modelo» no tiene modelo configurado.', errorI18n: null });
    expect(ctx!.store.getTrigger(trigger.id)).toMatchObject({ lastError: 'Se omitió una ejecución.', lastErrorI18n: null });

    // Lo que falla a partir de ahora sí lleva su referencia.
    const next = ctx!.runs.startAgentRun(ctx!.store.getAgent(agent.id)!, 'después');
    await ctx!.runs.waitFor(next.id);
    expect(ctx!.store.getRun(next.id)!.errorI18n).toMatchObject({ code: 'runNodeFailed' });
  });
});

describe('disparadores y avisos de la importación', () => {
  it('el motivo por el que un disparador no se lanzó lleva su código (y el detalle, el de la validación)', async () => {
    await boot();
    const wf = ctx!.store.createWorkflow(workflow([node('paso', 'agent', { agentId: 'no-existe', prompt: 'x' })], []));
    const trigger = ctx!.store.createTrigger(
      wf.id,
      { kind: 'webhook', name: '', intervalMinutes: null, time: null, weekdays: [], cron: null, timezone: null, input: '', enabled: true },
      null,
      'whsec_prueba',
    );
    const res = await post(`/api/triggers/${trigger.id}/run`);
    expect(res.statusCode).toBe(422);
    expect(res.json().i18n).toMatchObject({ code: 'triggerLaunchFailed', params: { detail: { code: 'agentGone' } } });
    const saved = ctx!.store.getTrigger(trigger.id) as Trigger;
    expect(saved.lastError).toBe('No se pudo lanzar: El nodo "paso" usa un agente que ya no existe.');
    expectCoded(saved.lastError, saved.lastErrorI18n, 'triggerLaunchFailed');
    // Al editarlo, el motivo anterior y su referencia se borran juntos.
    ctx!.store.updateTriggerState(trigger.id, { lastError: null });
    expect(ctx!.store.getTrigger(trigger.id)).toMatchObject({ lastError: null, lastErrorI18n: null });
  });

  it('el plan de una importación trae, en la misma posición que cada aviso y cada nota, su código y parámetros', async () => {
    await boot();
    const agent = addAgent(ctx!, { name: 'Escritor', tools: ['file_write', 'delegate_task'] });
    const wf = ctx!.store.createWorkflow(
      workflow(
        [
          node('entrada', 'input'),
          node('paso', 'agent', { agentId: agent.id, prompt: '{{entrada}}' }),
          node('guardar', 'tool', { tool: 'file_write', args: { path: 'a.txt', content: '{{paso}}' } }),
        ],
        edges('entrada>paso', 'paso>guardar'),
      ),
    );
    ctx!.store.createTrigger(
      wf.id,
      { kind: 'interval', name: '', intervalMinutes: 5, time: null, weekdays: [], cron: null, timezone: null, input: '', enabled: true },
      null,
    );
    const bundle = (await get(`/api/workflows/${wf.id}/export`)).json();
    // En otra instalación: el agente del archivo no coincide con ninguno y el proveedor no existe con ese nombre.
    ctx!.store.updateAgent(agent.id, { ...agent, name: 'Otro nombre', systemPrompt: 'cambiado' });
    const plan = (await post('/api/import/plan', { bundle })).json() as ImportPlan;

    expect(plan.warnings.length).toBeGreaterThanOrEqual(4);
    expect(plan.warningsI18n).toHaveLength(plan.warnings.length);
    plan.warnings.forEach((warning, i) => expectCoded(warning, plan.warningsI18n![i]));
    expect(plan.warningsI18n!.map((w) => w.code)).toEqual(['importWarnSensitive', 'importWarnDelegate', 'importWarnToolNode', 'importWarnTriggers']);
    expect(plan.warningsI18n![3]).toEqual({ code: 'importWarnTriggers', params: { count: 1 } });
    for (const item of plan.items) {
      expect(item.notesI18n).toHaveLength(item.notes.length);
      item.notes.forEach((note, i) => expectCoded(note, item.notesI18n![i]));
    }
    expect(plan.items.find((item) => item.kind === 'agent')!.notesI18n).toEqual([{ code: 'importAgentDiffers' }]);

    // Al aplicarla, los avisos del resultado siguen alineados con sus referencias.
    const applied = (await post('/api/import', { bundle, decisions: {} })).json();
    expect(applied.warningsI18n).toHaveLength(applied.warnings.length);
    applied.warnings.forEach((warning: string, i: number) => expectCoded(warning, applied.warningsI18n[i]));
  });
});

describe('tabla de mensajes en español', () => {
  it('cada código produce un texto completo con cualquier valor de sus parámetros (sin «undefined» ni huecos)', () => {
    // Un valor reconocible para cualquier parámetro que pida el mensaje, sea cual sea su nombre.
    const sample = new Proxy({} as Record<string, string>, { get: (_t, key) => (typeof key === 'string' ? `«${key.toUpperCase()}»` : undefined) });
    const problems: string[] = [];
    for (const code of Object.keys(SERVER_MESSAGES) as ServerCode[]) {
      const text = (SERVER_MESSAGES[code] as (p: Record<string, string>) => string)(sample);
      if (typeof text !== 'string' || !text.trim()) problems.push(`${code}: texto vacío`);
      else if (/undefined|null|\[object Object\]/.test(text)) problems.push(`${code}: ${text}`);
    }
    expect(problems).toEqual([]);
  });
});
