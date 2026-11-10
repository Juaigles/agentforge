// Ejecución programada y exportación/importación de workflows. Motor y API reales; solo el LLM está guionizado.
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { Agent, Provider, Run, Schedule, Workflow, WorkflowExport, WorkflowImportResult } from '../../shared/types';
import { buildApp } from '../src/app';
import type { AppContext } from '../src/context';
import { nextOccurrence } from '../src/engine/scheduler';
import { sleep } from '../src/util';
import { delay, makeContext, ScriptedLlm, tempDir, userText } from './helpers';

let ctx: AppContext;
let app: FastifyInstance;
const dirs: string[] = [];

async function boot(llm = new ScriptedLlm((req) => ({ content: `eco(${userText(req)})` })), dataDir = tempDir()) {
  if (!dirs.includes(dataDir)) dirs.push(dataDir);
  ctx = makeContext(llm, { dataDir, inMemory: false });
  app = await buildApp(ctx);
  return { dataDir, llm };
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

async function seed(agentExtra: Record<string, unknown> = {}): Promise<{ provider: Provider; agent: Agent; wf: Workflow }> {
  const provider = (await post('/api/providers', { name: 'Local', kind: 'ollama', baseUrl: 'http://localhost:11434', defaultModel: 'modelo-local' })).json() as Provider;
  const agent = (await post('/api/agents', { name: 'Redactor', role: 'escribe', providerId: provider.id, model: 'test-model', ...agentExtra })).json() as Agent;
  const wf = (
    await post('/api/workflows', {
      name: 'Boletín',
      description: 'Resumen periódico',
      nodes: [
        { id: 'entrada', type: 'input', position: { x: 0, y: 0 }, config: { defaultValue: 'tema' } },
        { id: 'redactar', type: 'agent', label: 'Redactar', position: { x: 200, y: 0 }, config: { agentId: agent.id, prompt: 'escribe sobre {{input}}' } },
        { id: 'cada', type: 'foreach', position: { x: 400, y: 0 }, config: { agentId: agent.id, items: '{{redactar}}', prompt: 'revisa {{item}}' } },
        { id: 'salida', type: 'output', position: { x: 600, y: 0 }, config: { template: '{{cada}}' } },
      ],
      edges: [
        { id: 'e1', source: 'entrada', target: 'redactar' },
        { id: 'e2', source: 'redactar', target: 'cada' },
        { id: 'e3', source: 'cada', target: 'salida' },
      ],
    })
  ).json() as Workflow;
  return { provider, agent, wf };
}

const MIN = 60_000;

describe('cálculo de la siguiente cita', () => {
  it('por intervalo suma los minutos indicados', () => {
    const from = new Date('2026-03-10T10:00:00.000Z');
    expect(nextOccurrence({ kind: 'interval', intervalMinutes: 30, time: null }, from).toISOString()).toBe('2026-03-10T10:30:00.000Z');
    expect(nextOccurrence({ kind: 'interval', intervalMinutes: 1440, time: null }, from).toISOString()).toBe('2026-03-11T10:00:00.000Z');
  });

  it('diaria: hoy si la hora aún no ha pasado, mañana si ya pasó o es justo ahora', () => {
    const at = (h: number, m: number) => new Date(2026, 2, 10, h, m, 0, 0); // hora local
    const daily = (time: string, from: Date) => nextOccurrence({ kind: 'daily', intervalMinutes: null, time }, from);
    expect(daily('09:30', at(8, 0))).toEqual(at(9, 30));
    expect(daily('09:30', at(9, 30))).toEqual(new Date(2026, 2, 11, 9, 30));
    expect(daily('09:30', at(23, 59))).toEqual(new Date(2026, 2, 11, 9, 30));
    expect(daily('00:00', at(12, 0))).toEqual(new Date(2026, 2, 11, 0, 0));
    // Cambio de mes.
    expect(daily('07:15', new Date(2026, 0, 31, 8, 0))).toEqual(new Date(2026, 1, 1, 7, 15));
  });
});

describe('programación de workflows', () => {
  it('guarda, valida, consulta y borra la programación de un workflow', async () => {
    await boot();
    const { wf } = await seed();
    expect((await get(`/api/workflows/${wf.id}/schedule`)).json()).toBeNull();
    expect((await get('/api/workflows/wf_no_existe/schedule')).statusCode).toBe(404);

    for (const bad of [
      { kind: 'interval' },
      { kind: 'interval', intervalMinutes: 0 },
      { kind: 'interval', intervalMinutes: 1.5 },
      { kind: 'daily' },
      { kind: 'daily', time: '25:00' },
      { kind: 'daily', time: '9:5' },
      { kind: 'cron', intervalMinutes: 5 },
    ]) {
      expect((await put(`/api/workflows/${wf.id}/schedule`, bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }

    const before = Date.now();
    const saved = (await put(`/api/workflows/${wf.id}/schedule`, { kind: 'interval', intervalMinutes: 15, input: 'noticias', time: '08:00' })).json() as Schedule;
    expect(saved).toMatchObject({ workflowId: wf.id, kind: 'interval', intervalMinutes: 15, time: null, input: 'noticias', enabled: true, lastRunId: null, lastError: null });
    expect(Date.parse(saved.nextRunAt!) - before).toBeGreaterThanOrEqual(15 * MIN - 50);
    expect(Date.parse(saved.nextRunAt!) - before).toBeLessThan(15 * MIN + 5000);
    expect((await get('/api/schedules')).json()).toEqual([saved]);

    // Cambiar a diaria sustituye la anterior; desactivada no tiene siguiente cita.
    const daily = (await put(`/api/workflows/${wf.id}/schedule`, { kind: 'daily', time: '07:45', enabled: false })).json() as Schedule;
    expect(daily).toMatchObject({ kind: 'daily', time: '07:45', intervalMinutes: null, enabled: false, nextRunAt: null });
    expect((await get('/api/schedules')).json()).toHaveLength(1);

    expect((await del(`/api/workflows/${wf.id}/schedule`)).statusCode).toBe(204);
    expect((await del(`/api/workflows/${wf.id}/schedule`)).statusCode).toBe(404);
    expect((await get('/api/schedules')).json()).toEqual([]);
  });

  it('lanza el workflow cuando vence la cita, con su entrada, lo marca como programado y fija la siguiente', async () => {
    const { llm } = await boot(new ScriptedLlm((req) => ({ content: userText(req).startsWith('escribe') ? '- a\n- b' : `ok(${userText(req)})` })));
    const { wf } = await seed();
    const schedule = (await put(`/api/workflows/${wf.id}/schedule`, { kind: 'interval', intervalMinutes: 10, input: 'economía' })).json() as Schedule;
    const due = Date.parse(schedule.nextRunAt!);

    // Antes de la hora no pasa nada.
    expect(ctx.scheduler.tick(due - 1000)).toEqual([]);
    expect(llm.calls).toHaveLength(0);

    const [runId] = ctx.scheduler.tick(due + 500);
    await ctx.runs.waitFor(runId);
    const run = (await get(`/api/runs/${runId}`)).json() as Run;
    expect(run).toMatchObject({ status: 'completed', kind: 'workflow', workflowId: wf.id, input: 'economía', scheduled: true });
    expect(run.output).toContain('ok(revisa a)');
    expect(llm.calls.map(userText)[0]).toBe('escribe sobre economía');

    const after = (await get(`/api/workflows/${wf.id}/schedule`)).json() as Schedule;
    expect(after).toMatchObject({ lastRunId: runId, lastError: null });
    expect(Date.parse(after.nextRunAt!)).toBe(due + 500 + 10 * MIN);
    expect(after.lastRunAt).toBe(new Date(due + 500).toISOString());
    // La misma pasada repetida no vuelve a lanzar: la cita ya se movió.
    expect(ctx.scheduler.tick(due + 600)).toEqual([]);
    // Una ejecución manual no lleva la marca.
    const manual = (await post(`/api/workflows/${wf.id}/run`, { input: 'x' })).json() as Run;
    expect(manual.scheduled).toBe(false);
    await ctx.runs.waitFor(manual.id);
    expect((await get('/api/runs')).json().items.map((r: Run) => r.scheduled).sort()).toEqual([false, true]);
  });

  it('tras un apagado largo ejecuta una sola vez la cita vencida, no todas las perdidas', async () => {
    await boot();
    const { wf } = await seed();
    const schedule = (await put(`/api/workflows/${wf.id}/schedule`, { kind: 'interval', intervalMinutes: 5 })).json() as Schedule;
    const due = Date.parse(schedule.nextRunAt!);
    const late = due + 3 * 60 * MIN; // el servidor «vuelve» tres horas después
    const started = ctx.scheduler.tick(late);
    expect(started).toHaveLength(1);
    await ctx.runs.waitFor(started[0]);
    expect(ctx.scheduler.tick(late + 1000)).toEqual([]);
    expect(Date.parse(ctx.store.getSchedule(wf.id)!.nextRunAt!)).toBe(late + 5 * MIN);
  });

  it('no solapa ejecuciones: si la anterior sigue en curso, la cita se omite y queda anotado', async () => {
    const llm = new ScriptedLlm(async (req) => {
      await sleep(5000, req.signal);
      return { content: 'x' };
    });
    await boot(llm);
    const { wf } = await seed();
    const schedule = (await put(`/api/workflows/${wf.id}/schedule`, { kind: 'interval', intervalMinutes: 1 })).json() as Schedule;
    const due = Date.parse(schedule.nextRunAt!);
    const [first] = ctx.scheduler.tick(due);
    for (let i = 0; i < 100 && llm.calls.length < 1; i++) await delay(10);

    expect(ctx.scheduler.tick(due + MIN)).toEqual([]);
    const skipped = ctx.store.getSchedule(wf.id)!;
    expect(skipped.lastError).toMatch(/anterior seguía en curso/);
    expect(skipped.lastRunId).toBe(first);
    expect(Date.parse(skipped.nextRunAt!)).toBe(due + 2 * MIN);
    expect((await get('/api/runs')).json().total).toBe(1);

    ctx.runs.cancel(first);
    await ctx.runs.waitFor(first);
    expect(ctx.scheduler.tick(due + 2 * MIN)).toHaveLength(1);
    expect(ctx.store.getSchedule(wf.id)!.lastError).toBeNull();
    await shutdown(); // corta la segunda ejecución
  });

  it('no lanza un workflow con errores ni una programación desactivada, y lo explica', async () => {
    const { llm } = await boot();
    const { wf, agent } = await seed();
    const schedule = (await put(`/api/workflows/${wf.id}/schedule`, { kind: 'interval', intervalMinutes: 1 })).json() as Schedule;
    const due = Date.parse(schedule.nextRunAt!);

    // Se rompe el workflow: el nodo apunta a un agente que ya no existe.
    const broken = { ...wf, nodes: wf.nodes.map((n) => (n.id === 'redactar' ? { ...n, config: { ...n.config, agentId: 'agt_borrado' } } : n)) };
    expect((await put(`/api/workflows/${wf.id}`, broken)).statusCode).toBe(200);
    expect(ctx.scheduler.tick(due)).toEqual([]);
    expect(ctx.store.getSchedule(wf.id)).toMatchObject({ lastRunId: null, lastError: expect.stringMatching(/No se pudo lanzar: .*agente que ya no existe/) });
    expect((await post(`/api/workflows/${wf.id}/schedule/run`)).statusCode).toBe(422);
    expect(llm.calls).toHaveLength(0);

    // Arreglado y desactivado: tampoco se lanza, aunque la hora haya pasado.
    await put(`/api/workflows/${wf.id}`, wf);
    await put(`/api/workflows/${wf.id}/schedule`, { kind: 'interval', intervalMinutes: 1, enabled: false });
    expect(ctx.scheduler.tick(due + 60 * MIN)).toEqual([]);
    expect(agent.id).toBeTruthy();
  });

  it('«ejecutar ahora» lanza con la entrada programada sin mover la siguiente cita', async () => {
    await boot();
    const { wf } = await seed();
    expect((await post(`/api/workflows/${wf.id}/schedule/run`)).statusCode).toBe(404); // aún no hay programación
    const schedule = (await put(`/api/workflows/${wf.id}/schedule`, { kind: 'daily', time: '06:00', input: 'diario' })).json() as Schedule;
    const res = await post(`/api/workflows/${wf.id}/schedule/run`);
    expect(res.statusCode).toBe(202);
    const run = res.json() as Run;
    await ctx.runs.waitFor(run.id);
    expect((await get(`/api/runs/${run.id}`)).json()).toMatchObject({ scheduled: true, input: 'diario', status: 'completed' });
    expect(ctx.store.getSchedule(wf.id)).toMatchObject({ nextRunAt: schedule.nextRunAt, lastRunId: run.id });
  });

  it('la programación sobrevive a un reinicio y desaparece al borrar el workflow', async () => {
    const { dataDir } = await boot();
    const { wf } = await seed();
    const saved = (await put(`/api/workflows/${wf.id}/schedule`, { kind: 'daily', time: '21:30', input: 'noche' })).json() as Schedule;
    await shutdown();

    await boot(undefined, dataDir);
    expect((await get('/api/schedules')).json()).toEqual([saved]);
    const [runId] = ctx.scheduler.tick(Date.parse(saved.nextRunAt!) + 1);
    await ctx.runs.waitFor(runId);
    expect(ctx.store.getRun(runId)!.status).toBe('completed');

    expect((await del(`/api/workflows/${wf.id}`)).statusCode).toBe(204);
    expect((await get('/api/schedules')).json()).toEqual([]);
    expect(ctx.scheduler.tick(Date.now() + 48 * 60 * MIN)).toEqual([]);
  });

  it('el temporizador real dispara la cita sin intervención', async () => {
    await boot();
    const { wf } = await seed();
    await put(`/api/workflows/${wf.id}/schedule`, { kind: 'interval', intervalMinutes: 1 });
    // Se adelanta la cita guardada en lugar de esperar un minuto; el disparo lo hace el temporizador.
    ctx.store.updateScheduleState(wf.id, { nextRunAt: new Date(Date.now() + 150).toISOString() });
    ctx.scheduler.start(50);
    let runId: string | null = null;
    for (let i = 0; i < 100 && !runId; i++) {
      await delay(20);
      runId = ctx.store.getSchedule(wf.id)!.lastRunId;
    }
    expect(runId).toBeTruthy();
    await ctx.runs.waitFor(runId!);
    expect(ctx.store.getRun(runId!)).toMatchObject({ status: 'completed', scheduled: true });
    ctx.scheduler.stop();
  });
});

describe('exportar e importar workflows', () => {
  it('exporta la definición y los agentes que usa, sin proveedor ni datos internos', async () => {
    await boot();
    const { wf, agent, provider } = await seed({ systemPrompt: 'Sé breve.', tools: ['calculator'], temperature: 0.3 });
    await post('/api/agents', { name: 'No usado', providerId: provider.id, model: 'm' });
    const res = await get(`/api/workflows/${wf.id}/export`);
    expect(res.statusCode).toBe(200);
    const bundle = res.json() as WorkflowExport;
    expect(bundle).toMatchObject({ format: 'agentforge.workflow', version: 1 });
    expect(Date.parse(bundle.exportedAt)).not.toBeNaN();
    expect(bundle.workflow).toEqual({ name: wf.name, description: wf.description, nodes: wf.nodes, edges: wf.edges, settings: wf.settings });
    // Un solo agente aunque lo usen dos nodos; el que no participa no viaja.
    expect(bundle.agents).toEqual([
      { id: agent.id, name: 'Redactor', role: 'escribe', description: '', color: agent.color, model: 'test-model', systemPrompt: 'Sé breve.', temperature: 0.3, maxTokens: null, maxIterations: agent.maxIterations, tools: ['calculator'], thinking: false },
    ]);
    expect(res.body).not.toContain(provider.id);
    expect((await get('/api/workflows/wf_no_existe/export')).statusCode).toBe(404);
  });

  it('importa en una instalación vacía creando los agentes y deja el workflow listo para ejecutar', async () => {
    await boot();
    const { wf } = await seed({ systemPrompt: 'Sé breve.', tools: ['calculator'] });
    const bundle = (await get(`/api/workflows/${wf.id}/export`)).json() as WorkflowExport;
    await shutdown();

    // Otra instalación, con otro proveedor y sin agentes.
    const { llm } = await boot(new ScriptedLlm((req) => ({ content: userText(req).startsWith('escribe') ? '["x"]' : `ok(${userText(req)})` })));
    const provider = (await post('/api/providers', { name: 'Otro', kind: 'ollama', baseUrl: 'http://localhost:11434', defaultModel: 'modelo-destino' })).json() as Provider;
    const res = await post('/api/workflows/import', bundle);
    expect(res.statusCode).toBe(201);
    const result = res.json() as WorkflowImportResult;
    expect(result.warnings).toEqual([]);
    expect(result.issues).toEqual([]);
    expect(result.reusedAgents).toEqual([]);
    expect(result.createdAgents).toHaveLength(1);
    const created = result.createdAgents[0];
    expect(created).toMatchObject({ name: 'Redactor', providerId: provider.id, model: 'test-model', systemPrompt: 'Sé breve.', tools: ['calculator'] });
    expect(created.id).not.toBe(bundle.agents[0].id);
    // Los dos nodos que usaban el agente apuntan ahora al agente local.
    expect(result.workflow.nodes.filter((n) => n.config.agentId).map((n) => n.config.agentId)).toEqual([created.id, created.id]);
    expect(result.workflow).toMatchObject({ name: 'Boletín', description: 'Resumen periódico', edges: bundle.workflow.edges, settings: bundle.workflow.settings });

    const run = (await post(`/api/workflows/${result.workflow.id}/run`, { input: 'deporte' })).json() as Run;
    await ctx.runs.waitFor(run.id);
    expect(ctx.store.getRun(run.id)).toMatchObject({ status: 'completed' });
    expect(llm.calls.map(userText)).toEqual(['escribe sobre deporte', 'revisa x']);
  });

  it('reutiliza los agentes existentes (por id o por nombre) y no duplica nombres de workflow', async () => {
    await boot();
    const { wf, agent, provider } = await seed();
    const bundle = (await get(`/api/workflows/${wf.id}/export`)).json() as WorkflowExport;

    const same = (await post('/api/workflows/import', bundle)).json() as WorkflowImportResult;
    expect(same.createdAgents).toEqual([]);
    expect(same.reusedAgents.map((a) => a.id)).toEqual([agent.id]);
    expect(same.workflow.name).toBe('Boletín (importado)');
    expect((await post('/api/workflows/import', bundle)).json().workflow.name).toBe('Boletín (importado 2)');

    // Mismo nombre con otro id (archivo de otra instalación): se enlaza por nombre.
    const foreign = { ...bundle, agents: [{ ...bundle.agents[0], id: 'agt_de_otra_maquina' }], workflow: { ...bundle.workflow, nodes: bundle.workflow.nodes.map((n) => (n.config.agentId ? { ...n, config: { ...n.config, agentId: 'agt_de_otra_maquina' } } : n)) } };
    const byName = (await post('/api/workflows/import', foreign)).json() as WorkflowImportResult;
    expect(byName.createdAgents).toEqual([]);
    expect(byName.workflow.nodes.find((n) => n.id === 'redactar')!.config.agentId).toBe(agent.id);
    expect((await get('/api/agents')).json()).toHaveLength(1);
    expect(provider.id).toBeTruthy();
  });

  it('avisa de lo que no puede trasladar: herramientas inexistentes, falta de proveedor y agentes ausentes', async () => {
    await boot();
    const bundle: WorkflowExport = {
      format: 'agentforge.workflow',
      version: 1,
      exportedAt: new Date().toISOString(),
      workflow: {
        name: 'Ajeno',
        description: '',
        nodes: [
          { id: 'entrada', type: 'input', label: '', position: { x: 0, y: 0 }, config: {} },
          { id: 'a', type: 'agent', label: 'A', position: { x: 1, y: 0 }, config: { agentId: 'agt_x', prompt: '{{input}}' } },
          { id: 'b', type: 'agent', label: 'B', position: { x: 2, y: 0 }, config: { agentId: 'agt_que_no_viaja', prompt: '{{a}}' } },
        ],
        edges: [
          { id: 'e1', source: 'entrada', target: 'a' },
          { id: 'e2', source: 'a', target: 'b' },
        ],
        settings: { maxConcurrency: 2, maxDurationMs: 60_000, maxLlmCalls: 10, onError: 'fail', defaultRetries: 0 },
      },
      agents: [{ id: 'agt_x', name: 'Con herramienta propia', role: '', description: '', color: '#112233', model: '', systemPrompt: '', temperature: 0.5, maxTokens: null, maxIterations: 4, tools: ['calculator', 'mi_api_interna'], thinking: false }],
    };

    // Sin proveedor no se puede crear el agente: se importa como borrador con errores.
    const noProvider = (await post('/api/workflows/import', bundle)).json() as WorkflowImportResult;
    expect(noProvider.createdAgents).toEqual([]);
    expect(noProvider.warnings).toEqual(['No se pudo crear el agente «Con herramienta propia»: no hay ningún proveedor configurado.']);
    expect(noProvider.issues.filter((i) => i.level === 'error').map((i) => i.nodeId).sort()).toEqual(['a', 'b']);

    // Con proveedor: el agente se crea con su modelo por defecto y sin la herramienta desconocida.
    await post('/api/providers', { name: 'P', kind: 'ollama', baseUrl: 'http://localhost:11434', defaultModel: 'modelo-por-defecto' });
    const result = (await post('/api/workflows/import', bundle)).json() as WorkflowImportResult;
    expect(result.createdAgents[0]).toMatchObject({ name: 'Con herramienta propia', model: 'modelo-por-defecto', tools: ['calculator'], color: '#112233' });
    expect(result.warnings).toEqual(['El agente «Con herramienta propia» usaba herramientas que no existen aquí: mi_api_interna.']);
    // El nodo cuyo agente no venía en el archivo sigue señalado.
    expect(result.issues.filter((i) => i.level === 'error').map((i) => i.nodeId)).toEqual(['b']);
    expect((await post(`/api/workflows/${result.workflow.id}/run`, { input: 'x' })).statusCode).toBe(422);
  });

  it('rechaza archivos que no son un workflow exportado', async () => {
    await boot();
    const { wf } = await seed();
    const bundle = (await get(`/api/workflows/${wf.id}/export`)).json() as WorkflowExport;
    const before = (await get('/api/workflows')).json().length;
    const rejected = async (body: unknown) => {
      const res = await post('/api/workflows/import', body);
      expect(res.statusCode).toBe(400);
      return res.json().error as string;
    };
    expect(await rejected({ hola: 'mundo' })).toMatch(/no es un workflow exportado de AgentForge/);
    expect(await rejected({ ...bundle, format: 'otra.cosa' })).toMatch(/no es un workflow exportado de AgentForge/);
    expect(await rejected({ ...bundle, version: 2 })).toMatch(/Versión de archivo no admitida/);
    expect(await rejected({ ...bundle, workflow: { ...bundle.workflow, name: '' } })).toMatch(/nombre/i);
    expect(await rejected({ ...bundle, workflow: { ...bundle.workflow, nodes: [{ id: 'x', type: 'inventado', position: { x: 0, y: 0 } }] } })).toMatch(/Datos no válidos/);
    expect((await get('/api/workflows')).json()).toHaveLength(before);
    expect((await get('/api/agents')).json()).toHaveLength(1);
  });
});
