// Exportación/importación de workflows (los disparadores están en triggers.test.ts). Motor y API reales; solo el LLM está guionizado.
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { Agent, Provider, Run, Workflow, WorkflowExport, WorkflowImportResult } from '../../shared/types';
import { buildApp } from '../src/app';
import type { AppContext } from '../src/context';
import { makeContext, ScriptedLlm, tempDir, userText } from './helpers';

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
const get = (url: string) => app.inject({ method: 'GET', url });

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
