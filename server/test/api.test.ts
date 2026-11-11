// Tests de la API HTTP y de la persistencia (base de datos SQLite real en disco).
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validateWorkflow } from '../../shared/graph';
import type { Agent, Provider, Run, RunEvent, Workflow } from '../../shared/types';
import { buildApp } from '../src/app';
import type { AppContext } from '../src/context';
import { pickDefaultModel, seedIfEmpty } from '../src/seed';
import { sleep } from '../src/util';
import { delay, makeContext, ScriptedLlm, startServer, tempDir, userText } from './helpers';

let ctx: AppContext;
let app: FastifyInstance;
const dirs: string[] = [];

async function boot(llm = new ScriptedLlm((req) => ({ content: `eco(${userText(req)})` })), dataDir = tempDir()) {
  if (!dirs.includes(dataDir)) dirs.push(dataDir);
  ctx = makeContext(llm, { dataDir, inMemory: false });
  app = await buildApp(ctx);
  return { ctx, app, dataDir, llm };
}

async function shutdown() {
  await app?.close();
  await ctx?.close();
}

afterEach(async () => {
  await shutdown();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const post = (url: string, payload?: unknown) => app.inject({ method: 'POST', url, payload: payload ?? {} });
const put = (url: string, payload: unknown) => app.inject({ method: 'PUT', url, payload: payload as object });
const get = (url: string) => app.inject({ method: 'GET', url });
const del = (url: string) => app.inject({ method: 'DELETE', url });

const providerBody = { name: 'Local', kind: 'ollama', baseUrl: 'http://localhost:11434' };
const agentBody = (providerId: string, extra: Record<string, unknown> = {}) => ({
  name: 'Ayudante',
  providerId,
  model: 'test-model',
  ...extra,
});

async function createAgent(extra: Record<string, unknown> = {}): Promise<Agent> {
  const provider = (await post('/api/providers', providerBody)).json() as Provider;
  const res = await post('/api/agents', agentBody(provider.id, extra));
  expect(res.statusCode).toBe(201);
  return res.json();
}

async function waitRun(id: string): Promise<Run> {
  await ctx.runs.waitFor(id);
  return (await get(`/api/runs/${id}`)).json();
}

describe('proveedores', () => {
  it('nunca devuelve la API key y la guarda cifrada en disco', async () => {
    const { dataDir } = await boot();
    const secret = 'sk-super-secreta-123456';
    const created = await post('/api/providers', { name: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: secret });
    expect(created.statusCode).toBe(201);
    expect(created.body).not.toContain(secret);
    const provider = created.json() as Provider;
    expect(provider).toMatchObject({ hasApiKey: true, kind: 'openai', enabled: true });
    expect((await get('/api/providers')).body).not.toContain(secret);

    // Internamente el motor sí puede recuperarla…
    expect(ctx.store.getProviderWithSecret(provider.id)!.apiKey).toBe(secret);
    // …pero en la base de datos no aparece en claro.
    const row = ctx.db.prepare('SELECT api_key_enc FROM providers WHERE id = ?').get(provider.id) as { api_key_enc: string };
    expect(row.api_key_enc).toMatch(/^v1:/);
    expect(row.api_key_enc).not.toContain(secret);
    await shutdown();
    for (const file of fs.readdirSync(dataDir).filter((f) => f.startsWith('agentforge.db'))) {
      expect(fs.readFileSync(path.join(dataDir, file)).includes(secret)).toBe(false);
    }
  });

  it('al editar conserva la clave si no se envía, y la borra si se envía vacía', async () => {
    await boot();
    const p = (await post('/api/providers', { ...providerBody, apiKey: 'clave-1' })).json() as Provider;
    await put(`/api/providers/${p.id}`, { ...providerBody, name: 'Renombrado' });
    expect(ctx.store.getProviderWithSecret(p.id)).toMatchObject({ name: 'Renombrado', apiKey: 'clave-1' });
    const cleared = (await put(`/api/providers/${p.id}`, { ...providerBody, apiKey: '' })).json() as Provider;
    expect(cleared.hasApiKey).toBe(false);
    expect(ctx.store.getProviderWithSecret(p.id)!.apiKey).toBeNull();
  });

  it('valida los datos y protege los proveedores en uso', async () => {
    await boot();
    const bad = await post('/api/providers', { name: '', kind: 'otro', baseUrl: 'ftp://x' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().issues.map((i: { path: string }) => i.path).sort()).toEqual(['baseUrl', 'kind', 'name']);

    const agent = await createAgent();
    const inUse = await del(`/api/providers/${agent.providerId}`);
    expect(inUse.statusCode).toBe(409);
    expect(inUse.json().error).toMatch(/1 agente/);
    expect((await del(`/api/agents/${agent.id}`)).statusCode).toBe(204);
    expect((await del(`/api/providers/${agent.providerId}`)).statusCode).toBe(204);
    expect((await del(`/api/providers/${agent.providerId}`)).statusCode).toBe(404);
  });

  it('prueba la conexión contra un servidor real y lista sus modelos', async () => {
    const { defaultLlmFactory } = await import('../src/llm');
    const fake = await startServer((req, res) => {
      if (req.url === '/api/tags') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ models: [{ name: 'modelo-a', size: 5 }, { name: 'modelo-b', size: 9 }] }));
      }
      res.writeHead(404);
      res.end();
    });
    try {
      await boot(defaultLlmFactory as never);
      const ok = (await post('/api/providers', { ...providerBody, baseUrl: fake.url })).json() as Provider;
      expect((await post(`/api/providers/${ok.id}/test`)).json()).toMatchObject({ ok: true, modelCount: 2 });
      expect((await get(`/api/providers/${ok.id}/models`)).json().map((m: { id: string }) => m.id)).toEqual(['modelo-a', 'modelo-b']);
      expect((await get('/api/providers/health')).json()).toMatchObject([{ providerId: ok.id, ok: true, modelCount: 2 }]);

      const down = await post('/api/providers/test', { ...providerBody, baseUrl: 'http://127.0.0.1:9' });
      expect(down.json()).toMatchObject({ ok: false, error: expect.stringMatching(/No se pudo conectar/) });
      const dead = (await post('/api/providers', { ...providerBody, baseUrl: 'http://127.0.0.1:9' })).json() as Provider;
      expect((await get(`/api/providers/${dead.id}/models`)).statusCode).toBe(502);
    } finally {
      await fake.close();
    }
  });

  it('lista los modelos de una configuración sin guardar, usando la clave guardada solo si no se envía otra', async () => {
    const { defaultLlmFactory } = await import('../src/llm');
    const fake = await startServer((req, res) => {
      if (req.headers.authorization !== 'Bearer clave-buena') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'clave incorrecta' } }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'gpt-a' }, { id: 'gpt-b' }] }));
    });
    try {
      await boot(defaultLlmFactory as never);
      const config = { name: 'Remoto', kind: 'openai', baseUrl: `${fake.url}/v1` };

      // Alta: todavía no hay nada guardado y se listan los modelos con la clave del formulario.
      const unsaved = await post('/api/providers/models', { ...config, apiKey: 'clave-buena' });
      expect(unsaved.statusCode).toBe(200);
      expect(unsaved.json().map((m: { id: string }) => m.id)).toEqual(['gpt-a', 'gpt-b']);
      expect((await get('/api/providers')).json()).toEqual([]); // no guarda nada
      expect((await post('/api/providers/models', { ...config, apiKey: 'otra' })).statusCode).toBe(502);
      expect((await post('/api/providers/models', config)).statusCode).toBe(502); // sin clave

      // Edición: sin clave nueva se usa la guardada; una clave explícita (o null, «quitar clave») tiene prioridad.
      const saved = (await post('/api/providers', { ...config, apiKey: 'clave-buena' })).json() as Provider;
      expect((await post('/api/providers/models', { ...config, id: saved.id })).statusCode).toBe(200);
      expect((await post('/api/providers/models', { ...config, id: saved.id, apiKey: 'otra' })).statusCode).toBe(502);
      expect((await post('/api/providers/models', { ...config, id: saved.id, apiKey: null })).statusCode).toBe(502);
      expect(fake.requests.at(-1)!.headers.authorization).toBeUndefined();

      // Valida el cuerpo igual que el alta.
      expect((await post('/api/providers/models', { ...config, baseUrl: 'no-es-url' })).statusCode).toBe(400);
      // La respuesta nunca contiene la clave.
      expect(unsaved.body).not.toContain('clave-buena');
    } finally {
      await fake.close();
    }
  });
});

describe('agentes', () => {
  it('crea con valores por defecto, edita, duplica y elimina', async () => {
    await boot();
    const agent = await createAgent({ tools: ['calculator'], role: 'ayuda' });
    expect(agent).toMatchObject({ name: 'Ayudante', temperature: 0.7, maxIterations: 8, maxTokens: null, thinking: false, tools: ['calculator'] });

    const { id, createdAt, updatedAt, ...rest } = agent;
    const updated = (await put(`/api/agents/${id}`, { ...rest, name: 'Editado', temperature: 0.2 })).json() as Agent;
    expect(updated).toMatchObject({ id, name: 'Editado', temperature: 0.2, createdAt });
    expect(updatedAt).toBeTruthy();

    const copy = (await post(`/api/agents/${id}/duplicate`)).json() as Agent;
    expect(copy).toMatchObject({ name: 'Editado (copia)', tools: ['calculator'] });
    expect(copy.id).not.toBe(id);
    expect((await get('/api/agents')).json()).toHaveLength(2);
    expect((await del(`/api/agents/${copy.id}`)).statusCode).toBe(204);
    expect((await get(`/api/agents/${copy.id}`)).statusCode).toBe(404);
  });

  it('rechaza datos inválidos, proveedores inexistentes y herramientas desconocidas', async () => {
    await boot();
    const agent = await createAgent();
    expect((await post('/api/agents', agentBody('prv_no_existe'))).json().error).toMatch(/proveedor seleccionado no existe/);
    expect((await post('/api/agents', agentBody(agent.providerId, { tools: ['volar'] }))).json().error).toMatch(/Herramientas desconocidas: volar/);
    const invalid = await post('/api/agents', agentBody(agent.providerId, { name: ' ', temperature: 9, model: '' }));
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().issues.map((i: { path: string }) => i.path).sort()).toEqual(['model', 'name', 'temperature']);
  });

  it('ejecuta una tarea y deja el resultado y los eventos consultables', async () => {
    await boot();
    const agent = await createAgent();
    expect((await post(`/api/agents/${agent.id}/run`, { input: '  ' })).statusCode).toBe(400);
    const started = await post(`/api/agents/${agent.id}/run`, { input: 'hola' });
    expect(started.statusCode).toBe(202);
    expect(started.json()).toMatchObject({ kind: 'agent', status: 'queued', input: 'hola' });

    const run = await waitRun(started.json().id);
    expect(run).toMatchObject({ status: 'completed', output: 'eco(hola)', agentId: agent.id });
    expect(run.steps).toHaveLength(1);
    const events = (await get(`/api/runs/${run.id}/events`)).json() as RunEvent[];
    expect(events[0].type).toBe('run.started');
    expect(events.at(-1)!.type).toBe('run.finished');
    expect((await get(`/api/runs/${run.id}/events?after=${events.length - 1}`)).json()).toHaveLength(1);

    const list = (await get(`/api/runs?kind=agent&status=completed&agentId=${agent.id}`)).json();
    expect(list).toMatchObject({ total: 1, items: [{ id: run.id }] });
    expect(list.items[0].snapshot).toBeUndefined(); // el listado no arrastra la instantánea
    expect((await get('/api/runs?status=failed')).json().total).toBe(0);
  });
});

describe('workflows', () => {
  async function createWorkflow(agent: Agent, extra: Partial<Workflow> = {}): Promise<Workflow> {
    const res = await post('/api/workflows', {
      name: 'Dos pasos',
      nodes: [
        { id: 'in', type: 'input', label: 'Entrada', position: { x: 0, y: 0 }, config: {} },
        { id: 'ag', type: 'agent', label: 'Agente', position: { x: 200, y: 0 }, config: { agentId: agent.id, prompt: 'Procesa: {{input}}' } },
        { id: 'out', type: 'output', label: 'Salida', position: { x: 400, y: 0 }, config: {} },
      ],
      edges: [
        { id: 'e1', source: 'in', target: 'ag' },
        { id: 'e2', source: 'ag', target: 'out' },
      ],
      ...extra,
    });
    expect(res.statusCode).toBe(201);
    return res.json();
  }

  it('guarda, ejecuta y registra cada paso', async () => {
    await boot();
    const agent = await createAgent();
    const wf = await createWorkflow(agent);
    expect(wf.settings).toMatchObject({ maxConcurrency: 4, onError: 'fail' });
    const run = await waitRun((await post(`/api/workflows/${wf.id}/run`, { input: 'datos' })).json().id);
    expect(run).toMatchObject({ kind: 'workflow', workflowId: wf.id, status: 'completed', output: 'eco(Procesa: datos)' });
    expect(run.steps.map((s) => [s.nodeId, s.status])).toEqual([
      ['in', 'completed'],
      ['ag', 'completed'],
      ['out', 'completed'],
    ]);
    expect((await get(`/api/runs?workflowId=${wf.id}`)).json().total).toBe(1);
  });

  it('permite guardar borradores inválidos pero se niega a ejecutarlos', async () => {
    await boot();
    const agent = await createAgent();
    const wf = await createWorkflow(agent, {
      edges: [
        { id: 'e1', source: 'in', target: 'ag' },
        { id: 'e2', source: 'ag', target: 'out' },
        { id: 'e3', source: 'out', target: 'ag' },
      ],
    });
    const res = await post(`/api/workflows/${wf.id}/run`, { input: 'x' });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatch(/errores/);
    expect(res.json().details.issues.some((i: { message: string }) => /ciclo/.test(i.message))).toBe(true);
    expect((await get('/api/runs')).json().total).toBe(0);

    const validation = (await post('/api/workflows/validate', { ...wf, edges: wf.edges.slice(0, 2) })).json();
    expect(validation.issues.filter((i: { level: string }) => i.level === 'error')).toEqual([]);
  });

  it('impide eliminar un agente usado por un workflow', async () => {
    await boot();
    const agent = await createAgent();
    const wf = await createWorkflow(agent);
    const res = await del(`/api/agents/${agent.id}`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('«Dos pasos»');
    await del(`/api/workflows/${wf.id}`);
    expect((await del(`/api/agents/${agent.id}`)).statusCode).toBe(204);
  });
});

describe('control de ejecuciones', () => {
  const slowLlm = () =>
    new ScriptedLlm(async (req) => {
      await sleep(10_000, req.signal);
      return { content: 'x' };
    });

  it('cancela por API, impide borrar ejecuciones activas y permite reintentar', async () => {
    await boot(slowLlm());
    const agent = await createAgent();
    const run = (await post(`/api/agents/${agent.id}/run`, { input: 'lento' })).json() as Run;
    await delay(40);
    expect((await del(`/api/runs/${run.id}`)).statusCode).toBe(409);
    expect((await post(`/api/runs/${run.id}/retry`)).statusCode).toBe(409);
    expect((await post(`/api/runs/${run.id}/cancel`)).json()).toEqual({ ok: true });
    const cancelled = await waitRun(run.id);
    expect(cancelled.status).toBe('cancelled');
    expect((await post(`/api/runs/${run.id}/cancel`)).statusCode).toBe(409);

    const retry = await post(`/api/runs/${run.id}/retry`, { mode: 'all' });
    expect(retry.statusCode).toBe(202);
    expect(retry.json()).toMatchObject({ retryOf: run.id, input: 'lento' });
    await post(`/api/runs/${retry.json().id}/cancel`);
    await ctx.runs.waitFor(retry.json().id);

    expect((await del(`/api/runs/${run.id}`)).statusCode).toBe(204);
    expect((await get(`/api/runs/${run.id}`)).statusCode).toBe(404);
    // Los eventos se eliminan en cascada.
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM run_events WHERE run_id = ?').get(run.id)).toEqual({ n: 0 });
    expect((await del('/api/runs')).json()).toEqual({ deleted: 1 });
  });

  it('transmite los eventos por SSE: reproduce el historial y sigue en directo hasta el final', async () => {
    const llm = new ScriptedLlm(async (req) => {
      await delay(60);
      return { content: `eco(${userText(req)})` };
    });
    await boot(llm);
    const agent = await createAgent();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

    const run = (await post(`/api/agents/${agent.id}/run`, { input: 'sse' })).json() as Run;
    const res = await fetch(`${base}/api/runs/${run.id}/stream`);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const received: RunEvent[] = [];
    const decoder = new TextDecoder();
    let buffer = '';
    const reader = res.body!.getReader();
    while (!received.some((e) => e.type === 'run.finished')) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const data = block.split('\n').find((l) => l.startsWith('data: '));
        if (data) received.push(JSON.parse(data.slice(6)));
      }
    }
    await reader.cancel();

    const persisted = received.filter((e) => e.seq !== null);
    expect(persisted.map((e) => e.seq)).toEqual(persisted.map((_e, i) => i + 1));
    expect(received.find((e) => e.type === 'llm.delta')?.data.text).toBe('eco(sse)');
    expect(received.at(-1)).toMatchObject({ type: 'run.finished', data: { status: 'completed', output: 'eco(sse)' } });

    // Reconexión con Last-Event-ID: solo llegan los eventos posteriores.
    const resumed = await fetch(`${base}/api/runs/${run.id}/stream`, { headers: { 'Last-Event-ID': String(persisted.length - 2) } });
    const chunk = decoder.decode((await resumed.body!.getReader().read()).value);
    const ids = [...chunk.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    expect(ids).toEqual([persisted.length - 1, persisted.length]);
    await resumed.body!.cancel().catch(() => {});
  });
});

describe('herramientas, ajustes y espacio de trabajo', () => {
  it('lista las integradas y gestiona herramientas HTTP personalizadas', async () => {
    await boot();
    const builtin = (await get('/api/tools')).json() as Array<{ name: string; source: string }>;
    expect(builtin.map((t) => t.name)).toEqual(
      expect.arrayContaining(['calculator', 'current_datetime', 'web_fetch', 'http_request', 'file_write', 'file_read', 'file_list', 'memory_set', 'memory_get', 'delegate_task', 'run_javascript']),
    );
    const body = {
      name: 'clima',
      description: 'Consulta el clima de una ciudad',
      parameters: { type: 'object', properties: { ciudad: { type: 'string' } }, required: ['ciudad'] },
      urlTemplate: 'https://example.com/clima?c={{ciudad}}',
    };
    const created = await post('/api/tools/custom', body);
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ name: 'clima', method: 'GET', enabled: true });
    expect((await post('/api/tools/custom', body)).statusCode).toBe(409);
    expect((await post('/api/tools/custom', { ...body, name: 'calculator' })).json().error).toMatch(/integrada/);
    expect((await post('/api/tools/custom', { ...body, name: 'Mal Nombre' })).statusCode).toBe(400);

    const all = (await get('/api/tools')).json() as Array<{ name: string; source: string }>;
    expect(all.find((t) => t.name === 'clima')).toMatchObject({ source: 'custom', category: 'Personalizadas' });
    // Un agente ya puede usarla…
    const agent = await createAgent({ tools: ['clima'] });
    expect(agent.tools).toEqual(['clima']);
    // …y al desactivarla deja de estar disponible para el motor.
    await put(`/api/tools/custom/${created.json().id}`, { ...body, enabled: false });
    expect(ctx.tools.get('clima')).toBeUndefined();
    expect((await del(`/api/tools/custom/${created.json().id}`)).statusCode).toBe(204);
  });

  it('valida los valores permitidos y el valor por defecto de los parámetros, y los aplica al ejecutar', async () => {
    const { defaultLlmFactory } = await import('../src/llm');
    const api = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ recibido: req.url }));
    });
    try {
      await boot(defaultLlmFactory as never);
      const tool = (props: Record<string, unknown>) => ({
        name: 'traducir',
        description: 'Traduce un texto a otro idioma',
        parameters: { type: 'object', properties: props, required: ['texto'] },
        urlTemplate: `${api.url}/t?q={{texto}}&lang={{idioma}}&n={{veces}}`,
      });
      const bad = async (props: Record<string, unknown>) => {
        const res = await post('/api/tools/custom', tool({ texto: { type: 'string' }, ...props }));
        expect(res.statusCode).toBe(400);
        return res.json().error as string;
      };
      expect(await bad({ idioma: { type: 'string', enum: ['es', 3] } })).toMatch(/valores permitidos deben ser del tipo/);
      expect(await bad({ idioma: { type: 'boolean', enum: ['si'] } })).toMatch(/Solo los parámetros de texto o numéricos/);
      expect(await bad({ idioma: { type: 'string', enum: [] } })).toMatch(/Datos no válidos/);
      expect(await bad({ idioma: { type: 'string', enum: ['es', 'en'], default: 'fr' } })).toMatch(/uno de los valores permitidos/);
      expect(await bad({ veces: { type: 'integer', default: 1.5 } })).toMatch(/valor por defecto debe ser del tipo/);

      const created = await post(
        '/api/tools/custom',
        tool({ texto: { type: 'string' }, idioma: { type: 'string', enum: ['es', 'en'], default: 'en' }, veces: { type: 'integer', default: 2 } }),
      );
      expect(created.statusCode).toBe(201);
      expect(created.json().parameters.properties.idioma).toEqual({ type: 'string', enum: ['es', 'en'], default: 'en' });

      await put('/api/settings', { allowPrivateNetwork: true });
      // Sin los parámetros opcionales se aplican los valores por defecto…
      const defaults = (await post('/api/tools/traducir/invoke', { args: { texto: 'hola mundo' } })).json();
      expect(defaults.ok).toBe(true);
      expect(api.requests.at(-1)!.url).toBe('/t?q=hola%20mundo&lang=en&n=2');
      // …un valor permitido se respeta y uno que no lo es se rechaza sin llegar a la API.
      await post('/api/tools/traducir/invoke', { args: { texto: 'x', idioma: 'es', veces: '5' } });
      expect(api.requests.at(-1)!.url).toBe('/t?q=x&lang=es&n=5');
      const before = api.requests.length;
      const rejected = (await post('/api/tools/traducir/invoke', { args: { texto: 'x', idioma: 'fr' } })).json();
      expect(rejected).toMatchObject({ ok: false, error: expect.stringContaining('"idioma" debe ser uno de: es, en') });
      expect(api.requests.length).toBe(before);
    } finally {
      await api.close();
    }
  });

  it('ejecuta herramientas desde el banco de pruebas y devuelve los errores sin romper', async () => {
    await boot();
    expect((await post('/api/tools/calculator/invoke', { args: { expression: '3 * (4 + 5)' } })).json()).toMatchObject({ ok: true, result: expect.stringContaining('27') });
    expect((await post('/api/tools/calculator/invoke', { args: {} })).json()).toMatchObject({ ok: false, error: expect.stringMatching(/expression/) });
    expect((await post('/api/tools/nada/invoke', { args: {} })).statusCode).toBe(404);
    // Los ajustes de seguridad se aplican de inmediato.
    expect((await post('/api/tools/run_javascript/invoke', { args: { code: '2 ** 8' } })).json().ok).toBe(false);
    expect((await put('/api/settings', { allowCodeExecution: true })).json()).toMatchObject({ allowCodeExecution: true, allowPrivateNetwork: false, maxConcurrentRuns: 3 });
    expect((await post('/api/tools/run_javascript/invoke', { args: { code: '2 ** 8' } })).json()).toMatchObject({ ok: true, result: expect.stringContaining('256') });
    expect((await put('/api/settings', { maxConcurrentRuns: 0 })).statusCode).toBe(400);
  });

  it('expone los archivos del espacio de trabajo sin permitir salir de él', async () => {
    await boot();
    await post('/api/tools/file_write/invoke', { args: { path: 'docs/nota.md', content: '# Hola' } });
    expect((await get('/api/workspace/files')).json()).toMatchObject([{ path: 'docs/nota.md', sizeBytes: 6 }]);
    expect((await get('/api/workspace/file?path=docs/nota.md')).json()).toMatchObject({ content: '# Hola' });
    expect((await get('/api/workspace/file?path=../agentforge.db')).statusCode).toBe(400);
    expect((await get('/api/workspace/file?path=..%2F..%2Fsecret.key')).statusCode).toBe(400);
    expect((await get('/api/workspace/file?path=no.md')).statusCode).toBe(404);
    expect((await del('/api/workspace/file?path=docs/nota.md')).statusCode).toBe(204);
    expect((await get('/api/workspace/files')).json()).toEqual([]);
  });
});

describe('seguridad y sistema', () => {
  it('rechaza peticiones con un Host ajeno (DNS rebinding)', async () => {
    await boot();
    expect((await app.inject({ method: 'GET', url: '/api/health', headers: { host: 'evil.example.com' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/health', headers: { host: '127.0.0.1:4310' } })).statusCode).toBe(200);
    expect((await get('/api/no-existe')).statusCode).toBe(404);
  });

  it('las estadísticas reflejan los datos reales', async () => {
    const llm = new ScriptedLlm((req) => {
      if (userText(req) === 'falla') throw new Error('boom');
      return { content: 'ok' };
    });
    await boot(llm);
    const empty = (await get('/api/stats')).json();
    expect(empty).toMatchObject({ counts: { agents: 0, workflows: 0, runs: 0, providers: 0 }, successRate: null, avgDurationMs: null, activeRuns: 0 });
    expect(empty.daily).toHaveLength(14);

    const agent = await createAgent({ tools: ['calculator'] });
    for (const input of ['a', 'b', 'falla']) await waitRun((await post(`/api/agents/${agent.id}/run`, { input })).json().id);
    const stats = (await get('/api/stats')).json();
    expect(stats.counts).toMatchObject({ agents: 1, providers: 1, runs: 3, tools: 11 });
    expect(stats.runsByStatus).toMatchObject({ completed: 2, failed: 1 });
    expect(stats.successRate).toBeCloseTo(2 / 3);
    expect(stats.tokens).toEqual({ prompt: 20, completion: 10 });
    expect(stats.llmCalls).toBe(2);
    expect(stats.daily.at(-1)).toMatchObject({ completed: 2, failed: 1 });
    expect(stats.topAgents).toMatchObject([{ agentId: agent.id, name: 'Ayudante', steps: 3 }]);
    expect(stats.recentRuns).toHaveLength(3);
    expect(stats.system.dbSizeBytes).toBeGreaterThan(0);
  });
});

describe('persistencia entre reinicios', () => {
  it('conserva proveedores (con su clave), agentes, workflows, ejecuciones, eventos y ajustes', async () => {
    const { dataDir } = await boot();
    const provider = (await post('/api/providers', { ...providerBody, apiKey: 'clave-persistente' })).json() as Provider;
    const agent = (await post('/api/agents', agentBody(provider.id, { tools: ['calculator'], systemPrompt: 'Sé breve.' }))).json() as Agent;
    const wf = (
      await post('/api/workflows', {
        name: 'Persistente',
        description: 'd',
        nodes: [{ id: 'ag', type: 'agent', label: 'A', position: { x: 12, y: 34 }, config: { agentId: agent.id, prompt: '{{input}}' } }],
        edges: [],
        settings: { maxConcurrency: 2, maxDurationMs: 60000, maxLlmCalls: 7, onError: 'continue', defaultRetries: 2 },
      })
    ).json() as Workflow;
    const run = await waitRun((await post(`/api/workflows/${wf.id}/run`, { input: 'recuerda esto' })).json().id);
    const events = (await get(`/api/runs/${run.id}/events`)).json();
    await put('/api/settings', { allowPrivateNetwork: true, maxConcurrentRuns: 5 });
    await post('/api/tools/custom', { name: 'mi_api', description: 'Mi API de pruebas', parameters: { type: 'object', properties: {} }, urlTemplate: 'https://example.com' });

    // "Reinicio": se cierra todo y se vuelve a abrir sobre el mismo directorio de datos.
    await shutdown();
    await boot(undefined, dataDir);

    expect((await get('/api/providers')).json()).toMatchObject([{ id: provider.id, name: 'Local', hasApiKey: true }]);
    expect(ctx.store.getProviderWithSecret(provider.id)!.apiKey).toBe('clave-persistente');
    expect((await get(`/api/agents/${agent.id}`)).json()).toEqual(agent);
    expect((await get(`/api/workflows/${wf.id}`)).json()).toEqual(wf);
    expect((await get(`/api/runs/${run.id}`)).json()).toEqual(run);
    expect((await get(`/api/runs/${run.id}/events`)).json()).toEqual(events);
    expect((await get('/api/settings')).json()).toEqual({ allowPrivateNetwork: true, allowCodeExecution: false, codeSandbox: 'process', autoResume: false, maxConcurrentRuns: 5, retentionDays: 0, retentionMaxRuns: 0 });
    expect((await get('/api/tools')).json().some((t: { name: string }) => t.name === 'mi_api')).toBe(true);

    // Y sigue funcionando: se puede ejecutar de nuevo y la numeración de eventos no choca.
    const again = await waitRun((await post(`/api/workflows/${wf.id}/run`, { input: 'otra vez' })).json().id);
    expect(again).toMatchObject({ status: 'completed', output: 'eco(otra vez)' });
    expect((await get('/api/runs')).json().total).toBe(2);
  });

  it('marca como interrumpidas las ejecuciones que quedaron a medias al apagarse', async () => {
    const llm = new ScriptedLlm(async (req) => {
      await sleep(10_000, req.signal);
      return { content: 'x' };
    });
    const { dataDir } = await boot(llm);
    const agent = await createAgent();
    const run = (await post(`/api/agents/${agent.id}/run`, { input: 'a medias' })).json() as Run;
    await delay(40);
    expect(ctx.store.getRunSummary(run.id)!.status).toBe('running');
    // Apagado brusco: se cierra la base de datos sin dejar terminar al motor.
    ctx.db.close();
    await app.close();

    await boot(undefined, dataDir);
    expect(ctx.interruptedRuns).toBe(1);
    const after = (await get(`/api/runs/${run.id}`)).json() as Run;
    expect(after.status).toBe('failed');
    expect(after.error).toMatch(/interrumpida por un reinicio/);
    expect(after.steps[0].status).toBe('cancelled');
    expect((await get(`/api/runs/${run.id}/events`)).json().at(-1)).toMatchObject({ type: 'run.finished', data: { status: 'failed' } });
    // Se puede reintentar tras el reinicio.
    const retry = await waitRun((await post(`/api/runs/${run.id}/retry`)).json().id);
    expect(retry).toMatchObject({ status: 'completed', output: 'eco(a medias)' });
  });

  it('ofrece reanudar las ejecuciones interrumpidas reutilizando los pasos que ya habían terminado', async () => {
    let slow = true;
    const script = () =>
      new ScriptedLlm(async (req) => {
        const text = userText(req);
        if (text.startsWith('lento') && slow) await sleep(10_000, req.signal);
        return { content: `hecho(${text})` };
      });
    const { dataDir, llm: firstLlm } = await boot(script());
    const agent = await createAgent();
    const wf = (
      await post('/api/workflows', {
        name: 'Dos pasos',
        nodes: [
          { id: 'entrada', type: 'input', position: { x: 0, y: 0 } },
          { id: 'rapido', type: 'agent', position: { x: 1, y: 0 }, config: { agentId: agent.id, prompt: 'rapido {{input}}' } },
          { id: 'lento', type: 'agent', position: { x: 2, y: 0 }, config: { agentId: agent.id, prompt: 'lento {{rapido}}' } },
          { id: 'salida', type: 'output', position: { x: 3, y: 0 }, config: { template: '{{lento}}' } },
        ],
        edges: [
          { id: 'e1', source: 'entrada', target: 'rapido' },
          { id: 'e2', source: 'rapido', target: 'lento' },
          { id: 'e3', source: 'lento', target: 'salida' },
        ],
      })
    ).json() as Workflow;
    const run = (await post(`/api/workflows/${wf.id}/run`, { input: 'dato' })).json() as Run;
    const other = (await post(`/api/agents/${agent.id}/run`, { input: 'lento agente suelto' })).json() as Run;
    for (let i = 0; i < 100 && firstLlm.calls.length < 3; i++) await delay(10);
    expect((await get('/api/runs/interrupted')).json()).toEqual([]);
    ctx.db.close();
    await app.close();

    // Arranque tras el corte: las dos ejecuciones quedan fallidas y pendientes de decisión.
    slow = false;
    const { llm } = await boot(script(), dataDir);
    const pending = (await get('/api/runs/interrupted')).json() as Run[];
    expect(pending.map((r) => r.id).sort()).toEqual([run.id, other.id].sort());
    expect(pending.every((r) => r.status === 'failed' && r.interrupted === true)).toBe(true);
    expect((await get(`/api/runs/${run.id}`)).json().interrupted).toBe(true);

    // Reanudar una: solo se vuelve a llamar al modelo para el paso que no había terminado.
    const resumed = (await post('/api/runs/interrupted/resume', { ids: [run.id] })).json() as Run[];
    expect(resumed).toHaveLength(1);
    expect(resumed[0]).toMatchObject({ retryOf: run.id, kind: 'workflow' });
    const finished = await waitRun(resumed[0].id);
    expect(finished).toMatchObject({ status: 'completed', output: 'hecho(lento hecho(rapido dato))' });
    expect(llm.calls.map((c) => userText(c))).toEqual(['lento hecho(rapido dato)']);
    expect((await get(`/api/runs/${resumed[0].id}/events`)).json().some((e: RunEvent) => e.type === 'step.reused' && e.nodeId === 'rapido')).toBe(true);
    // La reanudada deja de ofrecerse; la otra sigue pendiente.
    expect(((await get('/api/runs/interrupted')).json() as Run[]).map((r) => r.id)).toEqual([other.id]);
    // Reanudar de nuevo la misma no crea duplicados.
    expect((await post('/api/runs/interrupted/resume', { ids: [run.id] })).json()).toEqual([]);

    // Descartar: queda en el historial como fallida, sin aviso.
    expect((await post('/api/runs/interrupted/dismiss', {})).json()).toEqual({ dismissed: 1 });
    expect((await get('/api/runs/interrupted')).json()).toEqual([]);
    expect((await get(`/api/runs/${other.id}`)).json()).toMatchObject({ status: 'failed', interrupted: false });

    // Un segundo reinicio no resucita avisos ya atendidos.
    ctx.db.close();
    await app.close();
    await boot(script(), dataDir);
    expect(ctx.interruptedRuns).toBe(0);
    expect((await get('/api/runs/interrupted')).json()).toEqual([]);
  });

  it('migra una base de datos de la versión anterior sin perder ejecuciones', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const { dataDir } = await boot();
    const agent = await createAgent();
    const run = await waitRun((await post(`/api/agents/${agent.id}/run`, { input: 'antes de migrar' })).json().id);
    await shutdown();

    // Se devuelve el archivo al esquema v1: se deshace, de la más reciente a la más antigua, cada migración.
    const raw = new DatabaseSync(path.join(dataDir, 'agentforge.db'));
    raw.exec(`
      -- v5
      DROP TABLE approvals; DROP TABLE run_step_items; DROP INDEX idx_runs_parent;
      ALTER TABLE runs DROP COLUMN parent_run_id; ALTER TABLE runs DROP COLUMN parent_node_id;
      ALTER TABLE run_steps DROP COLUMN partial_output;
      -- v4
      DROP TRIGGER runs_fts_insert; DROP TRIGGER runs_fts_update; DROP TRIGGER runs_fts_delete;
      DROP TABLE runs_fts; DROP TABLE stats_daily; DROP TABLE stats_agent; DROP TABLE stats_tool; DROP TABLE run_memory;
      DROP INDEX idx_runs_status_created; DROP INDEX idx_runs_workflow_created; DROP INDEX idx_runs_agent_created;
      DROP INDEX idx_runs_interrupted; DROP INDEX idx_runs_ended;
      ALTER TABLE runs DROP COLUMN ended_at;
      CREATE INDEX idx_runs_status ON runs(status);
      CREATE INDEX idx_events_type ON run_events(type);
      -- v3
      DROP TABLE schedules; ALTER TABLE runs DROP COLUMN scheduled;
      -- v2
      ALTER TABLE runs DROP COLUMN interrupted;
      PRAGMA user_version = 1;
    `);
    raw.close();

    await boot(undefined, dataDir);
    expect((ctx.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(5);
    expect((await get(`/api/runs/${run.id}`)).json()).toMatchObject({ status: 'completed', output: 'eco(antes de migrar)', interrupted: false });
    expect((await get('/api/runs/interrupted')).json()).toEqual([]);
    // Antes de migrar se guardó una copia de la versión anterior.
    expect(fs.existsSync(path.join(dataDir, 'agentforge.db.v1.bak'))).toBe(true);

    // La migración v4 reconstruye a partir de los datos existentes lo que antes se calculaba al vuelo:
    // el instante de fin (retención), los agregados del panel y el índice de búsqueda.
    expect(ctx.db.prepare('SELECT ended_at IS NOT NULL AS ended FROM runs WHERE id = ?').get(run.id)).toEqual({ ended: 1 });
    const stats = (await get('/api/stats')).json();
    expect(stats.runsByStatus.completed).toBe(1);
    expect(stats.llmCalls).toBe(1);
    expect(stats.tokens).toEqual({ prompt: 10, completion: 5 });
    expect(stats.daily.reduce((n: number, d: { completed: number }) => n + d.completed, 0)).toBe(1);
    expect(stats.topAgents).toEqual([{ agentId: agent.id, name: agent.name, steps: 1, completionTokens: 5 }]);
    expect((await get('/api/runs?search=antes de migrar')).json().total).toBe(1);
    expect((await get('/api/runs?search=eco(antes')).json().total).toBe(1);
    expect((await get('/api/runs?search=no-aparece')).json().total).toBe(0);
    // Y la base migrada sigue funcionando: una ejecución nueva se suma a lo reconstruido.
    await waitRun((await post(`/api/agents/${agent.id}/run`, { input: 'después de migrar' })).json().id);
    expect((await get('/api/stats')).json()).toMatchObject({ llmCalls: 2, runsByStatus: { completed: 2 } });
    expect((ctx.db.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum: number }).auto_vacuum).toBe(2);
  });
});

describe('retención configurable desde la API', () => {
  it('valida los ajustes y aplica la retención en cuanto se guarda', async () => {
    await boot();
    const agent = await createAgent();
    const ids: string[] = [];
    for (const input of ['uno', 'dos', 'tres']) ids.push((await waitRun((await post(`/api/agents/${agent.id}/run`, { input })).json().id)).id);
    // La primera «terminó» hace 10 días.
    const old = new Date(Date.now() - 10 * 86_400_000).toISOString();
    ctx.db.prepare('UPDATE runs SET created_at = ?, finished_at = ?, ended_at = ? WHERE id = ?').run(old, old, old, ids[0]);

    expect((await put('/api/settings', { retentionDays: -1 })).statusCode).toBe(400);
    expect((await put('/api/settings', { retentionMaxRuns: 1.5 })).statusCode).toBe(400);
    expect((await get('/api/runs')).json().total).toBe(3);

    expect((await put('/api/settings', { retentionDays: 7 })).json()).toMatchObject({ retentionDays: 7, retentionMaxRuns: 0 });
    expect(((await get('/api/runs')).json().items as Run[]).map((r) => r.input).sort()).toEqual(['dos', 'tres']);

    expect((await put('/api/settings', { retentionMaxRuns: 1 })).json()).toMatchObject({ retentionDays: 7, retentionMaxRuns: 1 });
    expect((await get('/api/runs')).json().total).toBe(1);

    // Volver a «sin límite» deja de borrar.
    await put('/api/settings', { retentionDays: 0, retentionMaxRuns: 0 });
    await waitRun((await post(`/api/agents/${agent.id}/run`, { input: 'cuatro' })).json().id);
    expect((await get('/api/runs')).json().total).toBe(2);
  });
});

describe('datos de ejemplo', () => {
  it('elige el modelo más ligero con soporte de herramientas', () => {
    expect(
      pickDefaultModel([
        { id: 'embed', sizeBytes: 1, capabilities: ['embedding'] },
        { id: 'grande', sizeBytes: 900, capabilities: ['completion', 'tools'] },
        { id: 'pequeño', sizeBytes: 300, capabilities: ['completion', 'tools'] },
        { id: 'sin-tools', sizeBytes: 100, capabilities: ['completion'] },
      ]),
    ).toBe('pequeño');
    expect(pickDefaultModel([{ id: 'x', sizeBytes: 5, capabilities: ['completion'] }])).toBe('x');
    expect(pickDefaultModel([])).toBeNull();
  });

  it('crea un ejemplo válido la primera vez (y solo la primera) que se puede ejecutar de principio a fin', async () => {
    const llm = new ScriptedLlm((req) => {
      const text = userText(req);
      if (text.startsWith('Revisa')) return { content: 'REVISAR\n- Falta una conclusión.' };
      return { content: `salida de: ${text.slice(0, 30)}` };
    });
    await boot(llm);
    expect(await seedIfEmpty(ctx)).toBe(true);
    expect(await seedIfEmpty(ctx)).toBe(false);
    const agents = (await get('/api/agents')).json() as Agent[];
    const workflows = (await get('/api/workflows')).json() as Workflow[];
    expect(agents.map((a) => a.name)).toEqual(['Investigador', 'Analista', 'Redactor', 'Revisor', 'Calculista']);
    expect(agents.every((a) => a.model === 'test-model')).toBe(true);
    for (const wf of workflows) {
      const issues = validateWorkflow(wf, { agentIds: agents.map((a) => a.id), toolNames: ctx.tools.names() });
      expect(issues, wf.name).toEqual([]);
    }

    const main = workflows.find((w) => w.name.includes('multiagente'))!;
    const run = await waitRun((await post(`/api/workflows/${main.id}/run`, { input: 'IA en pymes' })).json().id);
    expect(run.status).toBe('completed');
    // El revisor pidió cambios: se toma la rama de corrección y se salta la de aprobado.
    const status = Object.fromEntries(run.steps.map((s) => [s.nodeId, s.status]));
    expect(status).toMatchObject({ investigar: 'completed', analizar: 'completed', redactar: 'completed', corregir: 'completed', informe_corregido: 'completed', informe_aprobado: 'skipped' });
    expect(run.output).toMatch(/^salida de: Reescribe el siguiente/);
    expect(llm.maxInFlight).toBe(2);
  });
});
