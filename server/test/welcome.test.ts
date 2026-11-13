// Workflow de bienvenida: es válido, se ejecuta de principio a fin por las dos ramas de la condición y de la
// aprobación, y el servidor lo reconoce (y lo recrea) aunque el usuario lo renombre o lo borre.
import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { validateWorkflow } from '../../shared/graph';
import type { Agent, Approval, OnboardingState, Provider, Run, Workflow } from '../../shared/types';
import { buildApp } from '../src/app';
import type { AppContext } from '../src/context';
import { ensureWelcomeWorkflow } from '../src/seed';
import { WELCOME_PIECES, welcomeWorkflowId } from '../src/welcome';
import { delay, makeContext, ScriptedLlm, stepStatus, userText } from './helpers';

let ctx: AppContext | undefined;
let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  await ctx?.close();
  if (ctx) fs.rmSync(ctx.config.dataDir, { recursive: true, force: true });
  app = ctx = undefined;
});

/** LLM falso: el saludo y cada pieza del «para cada» reciben una respuesta reconocible. */
const guideLlm = () =>
  new ScriptedLlm((req) => {
    const text = userText(req);
    if (text.startsWith('Saluda a'))
      return { content: `Hola, ${/Saluda a (.+?) en una sola frase/.exec(text)?.[1]}. Prueba un workflow que resuma tu correo.` };
    const piece = WELCOME_PIECES.find((p) => text.includes(p));
    return { content: piece ? `Frase sobre ${piece.split(':')[0]}.` : `inesperado: ${text}` };
  });

async function boot(llm = guideLlm()) {
  ctx = makeContext(llm);
  app = await buildApp(ctx);
  return { ctx, app, llm };
}

const get = (url: string) => app!.inject({ method: 'GET', url });
const post = (url: string, payload: unknown = {}) => app!.inject({ method: 'POST', url, payload: payload as object });

async function waitApproval(runId: string): Promise<Approval> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const pending = ctx!.store.listApprovals({ runId, pendingOnly: true });
    if (pending.length) return pending[0];
    if (Date.now() > deadline) throw new Error(`La ejecución ${runId} no llegó a pedir la aprobación: ${ctx!.store.getRun(runId)?.status}`);
    await delay(15);
  }
}

/** Lanza la bienvenida con `input`, responde a la aprobación y espera a que termine. */
async function runWelcome(input: string, decision: { approved: boolean; comment?: string }): Promise<{ run: Run; approval: Approval }> {
  const id = (await post('/api/onboarding/welcome')).json().workflowId as string;
  const runId = (await post(`/api/workflows/${id}/run`, { input })).json().id as string;
  const approval = await waitApproval(runId);
  expect((await post(`/api/approvals/${approval.id}/decide`, decision)).statusCode).toBe(200);
  await ctx!.runs.waitFor(runId);
  return { run: ctx!.store.getRun(runId)!, approval };
}

describe('workflow de bienvenida', () => {
  it('pasa la validación del proyecto sin errores ni avisos y recorre casi todos los tipos de paso', async () => {
    const { ctx } = await boot();
    const wf = ctx.store.getWorkflow(await ensureWelcomeWorkflow(ctx))!;
    const issues = validateWorkflow(wf, {
      agentIds: ctx.store.listAgents().map((a) => a.id),
      toolNames: ctx.tools.names(),
      workflows: ctx.store.listWorkflows(),
      selfId: wf.id,
    });
    expect(issues).toEqual([]);
    expect(new Set(wf.nodes.map((n) => n.type))).toEqual(new Set(['input', 'agent', 'tool', 'condition', 'transform', 'foreach', 'approval', 'output']));
    // Las columnas avanzan de izquierda a derecha siguiendo las aristas.
    const x = new Map(wf.nodes.map((n) => [n.id, n.position.x]));
    for (const e of wf.edges) expect(x.get(e.target)!, `${e.source}→${e.target}`).toBeGreaterThan(x.get(e.source)!);
  });

  it('con un nombre toma la rama personal y, aprobada, publica la bienvenida con el comentario', async () => {
    const { llm } = await boot();
    const { run, approval } = await runWelcome('Ana', { approved: true, comment: '¡Me encanta!' });
    expect(run.status).toBe('completed');
    expect(stepStatus(run)).toEqual({
      nombre: 'completed',
      saludo: 'completed',
      calculo: 'completed',
      tiene_nombre: 'completed',
      mensaje_personal: 'completed',
      mensaje_invitado: 'skipped',
      piezas: 'completed',
      aprobacion: 'completed',
      bienvenida: 'completed',
      rechazada: 'skipped',
    });
    // Cuatro llamadas al modelo: el saludo y una por cada pieza.
    expect(llm.calls).toHaveLength(1 + WELCOME_PIECES.length);
    // La aprobación explica qué se aprueba y enseña el mensaje compuesto.
    expect(approval.message).toMatch(/^Revisa la bienvenida/);
    expect(approval.message).toContain('## ¡Hola, Ana!');
    expect(run.output).toContain('# Te damos la bienvenida a AgentForge');
    expect(run.output).toContain('Hola, Ana. Prueba un workflow');
    expect(run.output).toContain('la rama **sí**');
    expect(run.output).not.toContain('rama **no**');
    for (const name of ['Agentes', 'Herramientas', 'Workflows']) expect(run.output).toContain(`Frase sobre ${name}.`);
    expect(run.output).toContain('"result": 55'); // 15 min × 220 días / 60, con la calculadora
    expect(run.output).toContain('¡Me encanta!');
  });

  it('sin nombre (se queda «Invitado») toma la rama de invitado y, rechazada, sale por la otra salida', async () => {
    await boot();
    const { run } = await runWelcome('', { approved: false, comment: 'Prefiero verlo otra vez' });
    expect(run.status).toBe('completed');
    expect(stepStatus(run)).toMatchObject({
      tiene_nombre: 'completed',
      mensaje_personal: 'skipped',
      mensaje_invitado: 'completed',
      piezas: 'completed',
      bienvenida: 'skipped',
      rechazada: 'completed',
    });
    expect(run.steps.find((s) => s.nodeId === 'nombre')!.output).toBe('Invitado');
    expect(run.steps.find((s) => s.nodeId === 'mensaje_invitado')!.output).toContain('Hola, Invitado.');
    expect(run.output).toMatch(/^# Bienvenida sin publicar/);
    expect(run.output).toContain('Prefiero verlo otra vez');
  });
});

describe('POST /api/onboarding/welcome', () => {
  it('sin proveedores crea el Ollama local, y es idempotente aunque se renombre el workflow', async () => {
    const { ctx } = await boot();
    expect(((await get('/api/onboarding')).json() as OnboardingState).welcomeWorkflowId).toBeNull();

    const first = await post('/api/onboarding/welcome');
    expect(first.statusCode).toBe(200);
    const { workflowId } = first.json() as { workflowId: string };
    expect(Object.keys(first.json())).toEqual(['workflowId']);
    const providers = (await get('/api/providers')).json() as Provider[];
    expect(providers).toMatchObject([{ name: 'Ollama local', kind: 'ollama', defaultModel: 'test-model' }]);
    const agents = (await get('/api/agents')).json() as Agent[];
    expect(agents).toMatchObject([{ name: 'Guía', providerId: providers[0].id, model: 'test-model', tools: [] }]);

    // Repetir no crea nada nuevo.
    expect((await post('/api/onboarding/welcome')).json()).toEqual({ workflowId });
    expect((await get('/api/workflows')).json()).toHaveLength(1);
    expect((await get('/api/agents')).json()).toHaveLength(1);
    expect((await get('/api/providers')).json()).toHaveLength(1);

    // Renombrado y editado, sigue siendo la bienvenida.
    const wf = (await get(`/api/workflows/${workflowId}`)).json() as Workflow;
    const renamed = await app!.inject({ method: 'PUT', url: `/api/workflows/${workflowId}`, payload: { ...wf, name: 'Mi primer workflow' } });
    expect(renamed.statusCode).toBe(200);
    expect((await get('/api/onboarding')).json()).toEqual({ agentRun: false, workflowCompleted: false, welcomeWorkflowId: workflowId });
    expect((await post('/api/onboarding/welcome')).json()).toEqual({ workflowId });
    expect(ctx.store.getWorkflow(workflowId)!.name).toBe('Mi primer workflow');

    // Un duplicado no hereda la marca.
    const copy = (await post(`/api/workflows/${workflowId}/duplicate`)).json() as Workflow;
    expect(copy.id).not.toBe(workflowId);
    expect(welcomeWorkflowId(ctx.store)).toBe(workflowId);
  });

  it('si se borró, la vuelve a crear reutilizando su agente y el proveedor que ya hay', async () => {
    const { ctx } = await boot();
    const own = ctx.store.createProvider({ name: 'Mi Ollama', kind: 'ollama', baseUrl: 'http://127.0.0.1:1', defaultModel: 'mi-modelo' });
    const { workflowId } = (await post('/api/onboarding/welcome')).json();
    const guide = ctx.store.listAgents();
    expect(guide).toMatchObject([{ name: 'Guía', providerId: own.id, model: 'mi-modelo' }]);

    expect((await app!.inject({ method: 'DELETE', url: `/api/workflows/${workflowId}` })).statusCode).toBe(204);
    expect(((await get('/api/onboarding')).json() as OnboardingState).welcomeWorkflowId).toBeNull();

    const again = (await post('/api/onboarding/welcome')).json() as { workflowId: string };
    expect(again.workflowId).not.toBe(workflowId);
    expect(((await get('/api/onboarding')).json() as OnboardingState).welcomeWorkflowId).toBe(again.workflowId);
    expect(ctx.store.listAgents().map((a) => a.id)).toEqual([guide[0].id]);
    expect(ctx.store.listProviders()).toHaveLength(1);
    expect(ctx.store.getWorkflow(again.workflowId)!.nodes.find((n) => n.id === 'saludo')!.config.agentId).toBe(guide[0].id);
  });

  it('peticiones simultáneas sin proveedor crean una sola bienvenida', async () => {
    const { ctx } = await boot();
    const ids = await Promise.all([1, 2, 3].map(async () => (await post('/api/onboarding/welcome')).json().workflowId));
    expect(new Set(ids).size).toBe(1);
    expect(ctx.store.listWorkflows()).toHaveLength(1);
    expect(ctx.store.listAgents()).toHaveLength(1);
    expect(ctx.store.listProviders()).toHaveLength(1);
  });
});
