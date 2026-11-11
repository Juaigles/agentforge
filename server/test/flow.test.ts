// Motor ampliado: subworkflows, «para cada» con herramienta o subworkflow y política por elemento, aprobación
// humana, reanudación automática, texto parcial, listas tolerantes y respuestas cortadas del proveedor.
import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { slugifyNodeId, validateWorkflow } from '../../shared/graph';
import { parseList } from '../../shared/list';
import type { Approval, Run, RunEvent, RunSummary, Workflow } from '../../shared/types';
import { buildApp } from '../src/app';
import type { AppContext } from '../src/context';
import { LlmError } from '../src/errors';
import { OpenAiCompatibleClient } from '../src/llm/openai';
import { addAgent, delay, edges, makeContext, node, ScriptedLlm, startServer, stepStatus, tempDir, userText, workflow } from './helpers';

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
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const echo = () => new ScriptedLlm((req) => ({ content: `eco(${userText(req)})` }));

async function boot(llm = echo(), opts: { dataDir?: string } = {}) {
  const dataDir = opts.dataDir ?? tempDir();
  if (!dirs.includes(dataDir)) dirs.push(dataDir);
  ctx = makeContext(llm, { dataDir, inMemory: !opts.dataDir });
  app = await buildApp(ctx);
  return { ctx, app, llm, dataDir };
}

const api = {
  get: (url: string) => app!.inject({ method: 'GET', url }),
  post: (url: string, payload: unknown = {}) => app!.inject({ method: 'POST', url, payload: payload as object }),
  del: (url: string) => app!.inject({ method: 'DELETE', url }),
};

async function until<T>(read: () => T | Promise<T>, ok: (value: T) => boolean, what: string, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() > deadline) throw new Error(`No se cumplió a tiempo: ${what} (último valor: ${JSON.stringify(value)?.slice(0, 300)})`);
    await delay(15);
  }
}

const pendingApprovals = () => ctx!.store.listApprovals({ pendingOnly: true });
const waitApproval = (runId?: string) => until(() => pendingApprovals().filter((a) => !runId || a.runId === runId), (list) => list.length > 0, 'una aprobación pendiente').then((l) => l[0]);
const finished = async (runId: string): Promise<Run> => {
  await ctx!.runs.waitFor(runId);
  return ctx!.store.getRun(runId)!;
};

describe('listas en texto libre', () => {
  it.each([
    ['["a", "b", "c"]', ['a', 'b', 'c']],
    ['Aquí tienes la lista:\n["Mango", "Piña"]', ['Mango', 'Piña']],
    ['Claro, aquí va:\n```json\n["uno", "dos"]\n```\nEspero que sirva.', ['uno', 'dos']],
    ['```\n- alfa\n- beta\n```', ['alfa', 'beta']],
    ['["a", "b",]', ['a', 'b']],
    ['{"items": ["x", "y"]}', ['x', 'y']],
    ['La respuesta es {"frutas": ["kiwi"], "total": 1}', ['La respuesta es {"frutas": ["kiwi"], "total": 1}']],
    ['[{"id": 1}, 2, null, "tres"]', ['{"id":1}', '2', 'tres']],
    ['1. Primero\n2) Segundo\n- Tercero\n• Cuarto', ['Primero', 'Segundo', 'Tercero', 'Cuarto']],
    ['2024. Informe anual\n2025. Previsión', ['2024. Informe anual', '2025. Previsión']],
    ['Texto con [corchetes] sueltos\nOtra línea', ['Texto con [corchetes] sueltos', 'Otra línea']],
    ['["con \\"comillas\\" y ] dentro", "b"]', ['con "comillas" y ] dentro', 'b']],
    ['', []],
    ['   \n  ', []],
  ])('%j', (text, expected) => {
    expect(parseList(text)).toEqual(expected);
  });
});

describe('subworkflows', () => {
  /** Workflow hijo «resumir» y padre que lo usa entre dos agentes. */
  function family(c: AppContext) {
    const agent = addAgent(c, { name: 'Trabajador' });
    const child = c.store.createWorkflow({
      ...workflow([node('entrada', 'input'), node('resumen', 'agent', { agentId: agent.id, prompt: 'resume {{input}}' }), node('salida', 'output', { template: 'R[{{resumen}}]' })], edges('entrada>resumen', 'resumen>salida')),
      name: 'Resumir',
    });
    const parent = c.store.createWorkflow({
      ...workflow(
        [node('entrada', 'input'), node('previo', 'agent', { agentId: agent.id, prompt: 'prepara {{input}}' }), node('sub', 'subworkflow', { workflowId: child.id, input: '{{previo}}' }), node('fin', 'output', { template: 'FIN {{sub}}' })],
        edges('entrada>previo', 'previo>sub', 'sub>fin'),
      ),
      name: 'Padre',
    });
    return { agent, child, parent };
  }

  it('un workflow lanza otro como un paso, recibe su resultado y la subejecución queda enlazada en el historial', async () => {
    const { ctx, llm } = await boot();
    const { child, parent } = family(ctx);
    const run = await finished(ctx.runs.startWorkflowRun(parent, 'dato').id);

    expect(run.status).toBe('completed');
    expect(run.output).toBe('FIN R[eco(resume eco(prepara dato))]');
    expect(stepStatus(run)).toEqual({ entrada: 'completed', previo: 'completed', sub: 'completed', fin: 'completed' });
    // El uso del subworkflow cuenta en el paso que lo lanza y en la ejecución.
    expect(run.steps.find((s) => s.nodeId === 'sub')!.usage.llmCalls).toBe(1);
    expect(run.usage.llmCalls).toBe(2);
    expect(llm.calls.map(userText)).toEqual(['prepara dato', 'resume eco(prepara dato)']);

    const children = (await api.get(`/api/runs/${run.id}/children`)).json() as RunSummary[];
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({ name: 'Resumir', status: 'completed', parentRunId: run.id, parentNodeId: 'sub', workflowId: child.id, input: 'eco(prepara dato)' });
    expect(ctx.store.listEvents(run.id).find((e) => e.type === 'subrun.started')!.data).toEqual({ runId: children[0].id, name: 'Resumir' });
    // La instantánea de la ejecución incluye el subworkflow tal como era al lanzarla.
    expect(Object.keys(run.snapshot.subworkflows ?? {})).toEqual([child.id]);
  });

  it('editar o borrar el subworkflow después de lanzar no cambia una ejecución ya en marcha ni su reintento', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const llm = new ScriptedLlm(async (req) => {
      if (userText(req).startsWith('prepara')) await gate;
      return { content: `eco(${userText(req)})` };
    });
    const { ctx } = await boot(llm);
    const { child, parent, agent } = family(ctx);
    const started = ctx.runs.startWorkflowRun(parent, 'dato');
    await until(() => llm.calls.length, (n) => n === 1, 'el primer agente en marcha');
    // Con la ejecución a medias se cambia la definición del hijo.
    ctx.store.updateWorkflow(child.id, { ...child, nodes: [node('entrada', 'input'), node('otro', 'agent', { agentId: agent.id, prompt: 'CAMBIADO {{input}}' })], edges: edges('entrada>otro') });
    release();
    const run = await finished(started.id);
    expect(run.output).toBe('FIN R[eco(resume eco(prepara dato))]');
    const retry = await finished(ctx.runs.retryRun(run, 'all').id);
    expect(retry.output).toBe('FIN R[eco(resume eco(prepara dato))]');
  });

  it('si el subworkflow falla, falla el nodo que lo lanza con su motivo; reintentar desde el fallo solo repite ese nodo', async () => {
    let failing = true;
    const llm = new ScriptedLlm((req) => {
      if (userText(req).startsWith('resume') && failing) throw new LlmError('modelo no disponible', { retryable: false });
      return { content: `eco(${userText(req)})` };
    });
    const { ctx } = await boot(llm);
    const { parent } = family(ctx);
    const run = await finished(ctx.runs.startWorkflowRun(parent, 'dato').id);
    expect(run.status).toBe('failed');
    expect(stepStatus(run)).toMatchObject({ previo: 'completed', sub: 'failed' });
    expect(stepStatus(run).fin).not.toBe('completed');
    expect(run.steps.find((s) => s.nodeId === 'sub')!.error).toMatch(/El nodo "resumen" falló: modelo no disponible/);
    expect(ctx.store.listChildRuns(run.id).map((c) => c.status)).toEqual(['failed']);

    failing = false;
    const before = llm.calls.length;
    const retry = await finished(ctx.runs.retryRun(run, 'failed').id);
    expect(retry.status).toBe('completed');
    expect(llm.calls.slice(before).map(userText)).toEqual(['resume eco(prepara dato)']);
  });

  it('cancelar la ejecución cancela también la subejecución en curso', async () => {
    const llm = new ScriptedLlm(
      (req) =>
        new Promise((resolve, reject) => {
          if (!userText(req).startsWith('resume')) return resolve({ content: 'ok' });
          req.signal?.addEventListener('abort', () => reject(req.signal!.reason), { once: true });
        }),
    );
    const { ctx } = await boot(llm);
    const { parent } = family(ctx);
    const started = ctx.runs.startWorkflowRun(parent, 'dato');
    const [child] = await until(() => ctx.store.listChildRuns(started.id), (list) => list.length === 1 && list[0].status === 'running', 'la subejecución en marcha');
    expect(ctx.runs.isActive(child.id)).toBe(true);
    ctx.runs.cancel(started.id);
    const run = await finished(started.id);
    expect(run.status).toBe('cancelled');
    expect(ctx.store.getRunSummary(child.id)!.status).toBe('cancelled');
    expect(ctx.runs.isActive(child.id)).toBe(false);
  });

  it('se anidan varios niveles, y la validación impide los ciclos entre workflows y las referencias rotas', async () => {
    const { ctx } = await boot();
    const agent = addAgent(ctx);
    const leaf = ctx.store.createWorkflow({ ...workflow([node('a', 'agent', { agentId: agent.id, prompt: 'hoja {{input}}' })], []), name: 'Hoja' });
    const middle = ctx.store.createWorkflow({ ...workflow([node('s', 'subworkflow', { workflowId: leaf.id, input: 'medio {{input}}' })], []), name: 'Medio' });
    const top = ctx.store.createWorkflow({ ...workflow([node('s', 'subworkflow', { workflowId: middle.id, input: 'arriba {{input}}' })], []), name: 'Arriba' });
    const run = await finished(ctx.runs.startWorkflowRun(top, 'x').id);
    expect(run.output).toBe('eco(hoja medio arriba x)');
    const [mid] = ctx.store.listChildRuns(run.id);
    expect(ctx.store.listChildRuns(mid.id).map((r) => r.name)).toEqual(['Hoja']);

    const issues = (def: Pick<Workflow, 'nodes' | 'edges'>, selfId: string | null) =>
      validateWorkflow(def, { agentIds: [agent.id], toolNames: ctx.tools.names(), workflows: ctx.store.listWorkflows(), selfId })
        .filter((i) => i.level === 'error')
        .map((i) => i.message);
    // La hoja no puede llamar a «Arriba»: cerraría el ciclo Arriba → Medio → Hoja → Arriba.
    const cyclic = { nodes: [node('s', 'subworkflow', { workflowId: top.id, input: '{{input}}' })], edges: [] };
    expect(issues(cyclic, leaf.id)[0]).toMatch(/subworkflow «Arriba».*acaba llamando a este mismo workflow/);
    expect(issues({ nodes: [node('s', 'subworkflow', { workflowId: leaf.id, input: '{{input}}' })], edges: [] }, leaf.id)[0]).toMatch(/no puede llamar al workflow del que forma parte/);
    expect(issues({ nodes: [node('s', 'subworkflow', { workflowId: 'wf_no_existe', input: 'x' })], edges: [] }, null)[0]).toMatch(/usa un workflow que ya no existe/);
    expect(issues({ nodes: [node('s', 'subworkflow', { input: 'x' })], edges: [] }, null)[0]).toMatch(/no tiene workflow asignado/);
    expect(issues({ nodes: [node('s', 'subworkflow', { workflowId: leaf.id })], edges: [] }, null)[0]).toMatch(/no tiene entrada que pasar/);

    // La API aplica la misma validación y no deja borrar un workflow que otro usa.
    const res = await api.post(`/api/workflows/validate`, { ...cyclic, name: 'x', id: leaf.id });
    expect(res.json().issues[0].message).toMatch(/ciclo entre workflows/);
    const blocked = await api.del(`/api/workflows/${leaf.id}`);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toBe('No se puede eliminar: lo usan como subworkflow «Medio».');
    expect((await api.del(`/api/workflows/${top.id}`)).statusCode).toBe(204);
  });
});

describe('«para cada» con herramienta, subworkflow y política por elemento', () => {
  it('cuerpo de herramienta: la ejecuta con cada elemento, sin modelo', async () => {
    const { ctx, llm } = await boot();
    const wf = workflow(
      [node('lista', 'transform', { template: '["2+2", "10/4", "3*3"]' }), node('calc', 'foreach', { body: 'tool', tool: 'calculator', args: { expression: '{{item}}' }, format: 'json', concurrency: 3 })],
      edges('lista>calc'),
    );
    const run = await finished(ctx.runs.startWorkflowRun(ctx.store.createWorkflow(wf), '').id);
    expect(run.status).toBe('completed');
    expect((JSON.parse(run.output!) as string[]).map((r) => JSON.parse(r).result)).toEqual([4, 2.5, 9]);
    expect(llm.calls).toHaveLength(0);
    expect(run.usage.toolCalls).toBe(3);
    const calls = ctx.store.listEvents(run.id).filter((e) => e.type === 'tool.call');
    expect(calls.map((e) => [e.data.item, e.data.arguments.expression])).toEqual(expect.arrayContaining([[0, '2+2'], [1, '10/4'], [2, '3*3']]));
    expect((await api.get(`/api/runs/${run.id}/steps/calc/items`)).json()).toMatchObject([{ index: 0, item: '2+2', status: 'completed' }, { index: 1 }, { index: 2 }]);
  });

  it('cuerpo de subworkflow: un flujo de varios nodos por elemento', async () => {
    const { ctx } = await boot();
    const agent = addAgent(ctx);
    const child = ctx.store.createWorkflow({
      ...workflow(
        [node('entrada', 'input'), node('uno', 'agent', { agentId: agent.id, prompt: 'analiza {{input}}' }), node('dos', 'agent', { agentId: agent.id, prompt: 'redacta {{uno}}' }), node('salida', 'output')],
        edges('entrada>uno', 'uno>dos', 'dos>salida'),
      ),
      name: 'Dos pasos',
    });
    const wf = ctx.store.createWorkflow(workflow([node('entrada', 'input'), node('cada', 'foreach', { body: 'subworkflow', workflowId: child.id, input: 'ficha de {{item}}', format: 'json' })], edges('entrada>cada')));
    const run = await finished(ctx.runs.startWorkflowRun(wf, 'Ana\nLuis').id);
    expect(run.status).toBe('completed');
    expect(JSON.parse(run.output!)).toEqual(['eco(redacta eco(analiza ficha de Ana))', 'eco(redacta eco(analiza ficha de Luis))']);
    expect(ctx.store.listChildRuns(run.id).map((c) => [c.name, c.status, c.parentNodeId])).toEqual([['Dos pasos', 'completed', 'cada'], ['Dos pasos', 'completed', 'cada']]);
    expect(run.usage.llmCalls).toBe(4);
  });

  it('con la política «continuar», un elemento fallido no detiene a los demás y queda señalado en el resultado', async () => {
    const llm = new ScriptedLlm((req) => {
      if (userText(req).includes('malo')) throw new LlmError('no puedo con este', { retryable: false });
      return { content: `ok(${userText(req)})` };
    });
    const { ctx } = await boot(llm);
    const agent = addAgent(ctx);
    const base = { agentId: agent.id, prompt: '{{item}}', concurrency: 1 };
    const keep = ctx.store.createWorkflow(workflow([node('entrada', 'input'), node('cada', 'foreach', { ...base, onItemError: 'continue' }), node('salida', 'output')], edges('entrada>cada', 'cada>salida')));
    const run = await finished(ctx.runs.startWorkflowRun(keep, 'bueno\nmalo\notro').id);
    expect(run.status).toBe('completed');
    expect(run.output).toContain('### 1. bueno\n\nok(bueno)');
    expect(run.output).toContain('### 2. malo\n\n⚠ No se pudo completar: no puedo con este');
    expect(run.output).toContain('### 3. otro\n\nok(otro)');
    expect(run.output).toContain('_1 de 3 elementos no se pudieron completar._');
    expect(ctx.store.listStepItems(run.id, 'cada').map((i) => i.status)).toEqual(['completed', 'failed', 'completed']);

    // En formato JSON el elemento fallido lleva su error en su posición.
    const asJson = ctx.store.createWorkflow(workflow([node('entrada', 'input'), node('cada', 'foreach', { ...base, onItemError: 'continue', format: 'json' })], edges('entrada>cada')));
    expect(JSON.parse((await finished(ctx.runs.startWorkflowRun(asJson, 'bueno\nmalo').id)).output!)).toEqual(['ok(bueno)', { error: 'no puedo con este' }]);
    // Si fallan todos, el nodo falla.
    const all = await finished(ctx.runs.startWorkflowRun(keep, 'malo 1\nmalo 2').id);
    expect(all.status).toBe('failed');
    expect(all.error).toMatch(/Han fallado los 2 elementos/);
    // Con la política por defecto («detener») falla al primer elemento que no se puede completar.
    const stop = ctx.store.createWorkflow(workflow([node('entrada', 'input'), node('cada', 'foreach', base)], edges('entrada>cada')));
    const stopped = await finished(ctx.runs.startWorkflowRun(stop, 'bueno\nmalo\notro').id);
    expect(stopped.status).toBe('failed');
    // «otro» solo se pidió en la primera ejecución (la de «continuar»): aquí el nodo se detuvo antes de llegar.
    expect(llm.calls.filter((c) => userText(c) === 'otro')).toHaveLength(1);
  });

  it('al reintentar desde el fallo se reutilizan los elementos ya completados y solo se repiten los que faltan', async () => {
    let failing = true;
    const llm = new ScriptedLlm((req) => {
      if (userText(req) === 'tres' && failing) throw new LlmError('caído', { retryable: false });
      return { content: `ok(${userText(req)})` };
    });
    const { ctx } = await boot(llm);
    const agent = addAgent(ctx);
    const wf = ctx.store.createWorkflow(workflow([node('entrada', 'input'), node('cada', 'foreach', { agentId: agent.id, prompt: '{{item}}', concurrency: 1, format: 'json' })], edges('entrada>cada')));
    const first = await finished(ctx.runs.startWorkflowRun(wf, 'uno\ndos\ntres\ncuatro').id);
    expect(first.status).toBe('failed');
    expect(llm.calls.map(userText)).toEqual(['uno', 'dos', 'tres']);

    failing = false;
    const before = llm.calls.length;
    const retry = await finished(ctx.runs.retryRun(first, 'failed').id);
    expect(retry.status).toBe('completed');
    expect(JSON.parse(retry.output!)).toEqual(['ok(uno)', 'ok(dos)', 'ok(tres)', 'ok(cuatro)']);
    // «uno» y «dos» no se vuelven a pedir al modelo.
    expect(llm.calls.slice(before).map(userText)).toEqual(['tres', 'cuatro']);
    const reused = ctx.store.listEvents(retry.id).filter((e) => e.type === 'foreach.item' && e.data.status === 'reused');
    expect(reused.map((e) => e.data.index)).toEqual([0, 1]);
    // Repetir TODO desde cero no reutiliza nada.
    const fresh = await finished(ctx.runs.retryRun(first, 'all').id);
    expect(fresh.status).toBe('completed');
    expect(llm.calls.slice(before + 2).map(userText)).toEqual(['uno', 'dos', 'tres', 'cuatro']);
  });

  it('valida el cuerpo elegido', async () => {
    const { ctx } = await boot();
    const errors = (config: Record<string, unknown>) =>
      validateWorkflow({ nodes: [node('e', 'input'), node('f', 'foreach', config)], edges: edges('e>f') }, { agentIds: [], toolNames: ['calculator'], workflows: [] })
        .filter((i) => i.level === 'error')
        .map((i) => i.message);
    expect(errors({ body: 'tool' })).toEqual(['El nodo "f" no tiene herramienta asignada.']);
    expect(errors({ body: 'tool', tool: 'no_existe', args: { x: '{{item}}' } })).toEqual(['El nodo "f" usa una herramienta desconocida: no_existe.']);
    expect(errors({ body: 'tool', tool: 'calculator', args: { expression: '{{item}}' } })).toEqual([]);
    expect(errors({ body: 'subworkflow' })).toEqual(['El nodo "f" no tiene workflow asignado.']);
    expect(errors({ body: 'tool', tool: 'calculator', args: { expression: '{{item}}' }, onItemError: 'ignorar' })[0]).toMatch(/política ante un elemento fallido/);
    expect(ctx.tools.names()).toContain('calculator');
  });
});

describe('aprobación humana', () => {
  /** entrada → borrador (agente) → aprobación → sí: publicar / no: corregir con el comentario. */
  function reviewFlow(c: AppContext, settings: Record<string, unknown> = {}, approval: Record<string, unknown> = {}) {
    const agent = addAgent(c);
    return c.store.createWorkflow({
      ...workflow(
        [
          node('entrada', 'input'),
          node('borrador', 'agent', { agentId: agent.id, prompt: 'borrador de {{input}}' }),
          node('revisar', 'approval', { message: '¿Publicamos esto?\n\n{{borrador}}', ...approval }),
          node('publicar', 'transform', { template: 'PUBLICADO: {{borrador}}' }),
          node('corregir', 'agent', { agentId: agent.id, prompt: 'corrige {{borrador}} según: {{revisar.comment}}' }),
        ],
        edges('entrada>borrador', 'borrador>revisar', 'revisar:true>publicar', 'revisar:false>corregir'),
        settings,
      ),
      name: 'Con revisión',
    });
  }

  it('la ejecución se detiene «en espera», la decisión llega por la API y sigue por la rama aprobada', async () => {
    const { ctx } = await boot();
    const run = ctx.runs.startWorkflowRun(reviewFlow(ctx), 'nota de prensa');
    const approval = await waitApproval(run.id);
    expect(approval).toMatchObject({ runName: 'Con revisión', nodeLabel: 'revisar', status: 'pending', message: '¿Publicamos esto?\n\neco(borrador de nota de prensa)' });
    expect(ctx.store.getRun(run.id)).toMatchObject({ status: 'waiting', steps: expect.arrayContaining([expect.objectContaining({ nodeId: 'revisar', status: 'waiting' })]) });
    expect((await api.get('/api/runs?status=waiting')).json().total).toBe(1);
    expect(((await api.get('/api/approvals')).json() as Approval[]).map((a) => a.id)).toEqual([approval.id]);

    const decided = await api.post(`/api/approvals/${approval.id}/decide`, { approved: true, comment: 'Adelante' });
    expect(decided.json()).toMatchObject({ status: 'approved', comment: 'Adelante', decidedAt: expect.any(String) });
    const done = await finished(run.id);
    expect(done.status).toBe('completed');
    expect(done.output).toBe('PUBLICADO: eco(borrador de nota de prensa)');
    expect(stepStatus(done)).toMatchObject({ revisar: 'completed', publicar: 'completed', corregir: 'skipped' });
    expect(ctx.store.listEvents(run.id).filter((e) => e.type.startsWith('approval.')).map((e) => [e.type, e.data.approved])).toEqual([['approval.requested', undefined], ['approval.decided', true]]);
    // Ya no está pendiente, y no se puede decidir dos veces.
    expect((await api.get('/api/approvals')).json()).toEqual([]);
    expect((await api.post(`/api/approvals/${approval.id}/decide`, { approved: false })).statusCode).toBe(409);
    expect((await api.get(`/api/approvals?runId=${run.id}`)).json()).toMatchObject([{ status: 'approved' }]);
  });

  it('rechazar sigue por la otra rama y el comentario está disponible para los nodos siguientes', async () => {
    const { ctx } = await boot();
    const run = ctx.runs.startWorkflowRun(reviewFlow(ctx), 'nota');
    const approval = await waitApproval(run.id);
    expect((await api.post(`/api/approvals/${approval.id}/decide`, { approved: false, comment: 'Más corto, por favor' })).statusCode).toBe(200);
    const done = await finished(run.id);
    expect(done.output).toBe('eco(corrige eco(borrador de nota) según: Más corto, por favor)');
    expect(stepStatus(done)).toMatchObject({ publicar: 'skipped', corregir: 'completed' });
    expect((await api.post('/api/approvals/apr_no_existe/decide', { approved: true })).statusCode).toBe(404);
    expect((await api.post(`/api/approvals/${approval.id}/decide`, { comment: 'sin decisión' })).statusCode).toBe(400);
  });

  it('mientras espera no ocupa un hueco de ejecución ni consume la duración máxima', async () => {
    const { ctx, llm } = await boot();
    ctx.store.updateSettings({ maxConcurrentRuns: 1 });
    // Duración máxima de 400 ms: la espera a la persona va a durar más.
    const waiting = ctx.runs.startWorkflowRun(reviewFlow(ctx, { maxDurationMs: 400 }), 'lenta');
    const approval = await waitApproval(waiting.id);
    // Con una sola ejecución simultánea permitida, otra arranca y termina mientras la primera espera.
    const other = await finished(ctx.runs.startAgentRun(ctx.store.listAgents()[0], 'otra tarea').id);
    expect(other.status).toBe('completed');
    await delay(600);
    expect(ctx.store.getRunSummary(waiting.id)!.status).toBe('waiting');
    ctx.runs.decideApproval(approval.id, true);
    const done = await finished(waiting.id);
    expect(done.status).toBe('completed');
    expect(llm.calls).toHaveLength(2);
  });

  it('cancelar una ejecución en espera cancela la petición; un tiempo máximo en el nodo la hace fallar', async () => {
    const { ctx } = await boot();
    const run = ctx.runs.startWorkflowRun(reviewFlow(ctx), 'x');
    const approval = await waitApproval(run.id);
    expect(ctx.runs.cancel(run.id)).toBe(true);
    expect((await finished(run.id)).status).toBe('cancelled');
    expect(ctx.store.getApproval(approval.id)!.status).toBe('cancelled');
    expect(pendingApprovals()).toEqual([]);
    expect(() => ctx.runs.decideApproval(approval.id, true)).toThrow(/ya no está pendiente/);

    const timed = await finished(ctx.runs.startWorkflowRun(reviewFlow(ctx, {}, { timeoutMs: 150 }), 'y').id);
    expect(timed.status).toBe('failed');
    expect(timed.steps.find((s) => s.nodeId === 'revisar')!.error).toMatch(/superó su tiempo máximo \(150 ms\)/);
    expect(pendingApprovals()).toEqual([]);
  });

  it('sobrevive a un reinicio: al arrancar la ejecución vuelve sola a esperar la aprobación, sin repetir lo ya hecho', async () => {
    const dataDir = tempDir();
    const first = await boot(echo(), { dataDir });
    const run = first.ctx.runs.startWorkflowRun(reviewFlow(first.ctx), 'informe');
    await waitApproval(run.id);
    // Apagado ordenado con la ejecución en espera.
    await first.app.close();
    await first.ctx.close();

    const second = await boot(echo(), { dataDir });
    expect(second.ctx.store.getRunSummary(run.id)).toMatchObject({ status: 'failed', interrupted: true });
    // No se ofrece al usuario como «interrumpida» pendiente de decidir: se reanuda sola.
    expect(second.ctx.store.listInterruptedRuns()).toEqual([]);
    const [resumed] = second.ctx.runs.autoResume();
    expect(resumed.retryOf).toBe(run.id);
    const approval = await waitApproval(resumed.id);
    expect(approval.message).toBe('¿Publicamos esto?\n\neco(borrador de informe)');
    // El borrador se reutilizó: el modelo no se ha vuelto a llamar en este arranque.
    expect(second.llm.calls).toHaveLength(0);
    expect(second.ctx.store.getApproval(approval.id)!.runId).toBe(resumed.id);
    second.ctx.runs.decideApproval(approval.id, true, 'ok');
    expect((await finished(resumed.id)).output).toBe('PUBLICADO: eco(borrador de informe)');
    // Un segundo arranque ya no tiene nada que reanudar.
    expect(second.ctx.runs.autoResume()).toEqual([]);
  });

  it('valida la aprobación y sus referencias', async () => {
    const errors = (nodes: ReturnType<typeof node>[], es: string[]) =>
      validateWorkflow({ nodes, edges: edges(...es) }, { agentIds: [], toolNames: [] })
        .filter((i) => i.level === 'error')
        .map((i) => i.message);
    expect(errors([node('e', 'input'), node('a', 'approval', { message: '' })], ['e>a'])).toEqual(['La aprobación "a" no tiene el texto de lo que se pide aprobar.']);
    expect(errors([node('e', 'input'), node('a', 'approval', { message: '¿ok?' }), node('t', 'transform', { template: 'x' })], ['e>a', 'a>t'])[0]).toMatch(/deben partir de "aprobado" o "rechazado"/);
    expect(errors([node('e', 'input'), node('t', 'transform', { template: '{{e.comment}}' })], ['e>t'])).toEqual(['"t" usa {{e.comment}}, pero solo las aprobaciones tienen comentario.']);
    expect(errors([node('e', 'input'), node('a', 'approval', { message: '¿ok?' }), node('t', 'transform', { template: '{{a.comment}}' })], ['e>a', 'a:false>t'])).toEqual([]);
  });
});

describe('reanudación automática', () => {
  it('con el ajuste activado, las ejecuciones interrumpidas siguen solas al arrancar; sin él, esperan al usuario', async () => {
    const dataDir = tempDir();
    const hang = () =>
      new ScriptedLlm((req) => {
        if (!userText(req).startsWith('lento')) return { content: `eco(${userText(req)})` };
        return new Promise((_r, reject) => req.signal?.addEventListener('abort', () => reject(req.signal!.reason), { once: true }));
      });
    const first = await boot(hang(), { dataDir });
    const agent = addAgent(first.ctx);
    const wf = first.ctx.store.createWorkflow(workflow([node('a', 'agent', { agentId: agent.id, prompt: 'rápido' }), node('b', 'agent', { agentId: agent.id, prompt: 'lento {{a}}' })], edges('a>b')));
    const run = first.ctx.runs.startWorkflowRun(wf, '');
    await until(() => first.llm.calls.length, (n) => n === 2, 'el paso lento en marcha');
    await first.app.close();
    await first.ctx.close();

    // Sin el ajuste: queda pendiente de que el usuario decida.
    const second = await boot(echo(), { dataDir });
    expect(second.ctx.runs.autoResume()).toEqual([]);
    expect(second.ctx.store.listInterruptedRuns().map((r) => r.id)).toEqual([run.id]);
    second.ctx.store.updateSettings({ autoResume: true });
    await second.app.close();
    await second.ctx.close();

    // Con el ajuste: al arrancar se reanuda sola y solo repite el paso que no terminó.
    const third = await boot(echo(), { dataDir });
    const [resumed] = third.ctx.runs.autoResume();
    const done = await finished(resumed.id);
    expect(done).toMatchObject({ status: 'completed', retryOf: run.id, output: 'eco(lento eco(rápido))' });
    expect(third.llm.calls.map(userText)).toEqual(['lento eco(rápido)']);
    expect(third.ctx.store.listInterruptedRuns()).toEqual([]);
    expect((await api.get('/api/settings')).json().autoResume).toBe(true);
  });
});

describe('texto parcial de un paso que no termina', () => {
  it('un paso que termina bien no guarda texto parcial', async () => {
    const { ctx } = await boot();
    const done = await finished(ctx.runs.startAgentRun(addAgent(ctx), 'x').id);
    expect(done.steps[0]).toMatchObject({ status: 'completed', output: 'eco(x)', partialOutput: null });
  });

  it('lo que el modelo llevaba escrito al cancelar se guarda con el paso y llega en el evento', async () => {
    const llm = new ScriptedLlm(
      (req) =>
        new Promise((_resolve, reject) => {
          req.onDelta?.('Primera parte del informe. ');
          req.onDelta?.('Segunda parte a medias');
          req.signal?.addEventListener('abort', () => reject(req.signal!.reason), { once: true });
        }),
    );
    const { ctx } = await boot(llm);
    const run = ctx.runs.startAgentRun(addAgent(ctx), 'escribe');
    const events: RunEvent[] = [];
    ctx.runs.subscribe(run.id, (ev) => events.push(ev));
    await until(() => ctx.runs.partials(run.id), (p) => p.length === 1, 'texto parcial en vivo');
    ctx.runs.cancel(run.id);
    const done = await finished(run.id);
    expect(done.status).toBe('cancelled');
    expect(done.steps[0]).toMatchObject({ status: 'cancelled', output: null, partialOutput: 'Primera parte del informe. Segunda parte a medias' });
    expect(events.find((e) => e.type === 'step.finished')!.data.partialOutput).toBe('Primera parte del informe. Segunda parte a medias');
    // Por la API también llega, junto al paso.
    expect((await api.get(`/api/runs/${run.id}`)).json().steps[0].partialOutput).toBe('Primera parte del informe. Segunda parte a medias');
  });
});

describe('respuestas cortadas del proveedor (protocolo de OpenAI)', () => {
  const sse = (...chunks: unknown[]) => chunks.map((c) => `data: ${typeof c === 'string' ? c : JSON.stringify(c)}\n\n`).join('');
  const req = { model: 'm', messages: [{ role: 'user' as const, content: 'x' }] };

  it('una respuesta que se corta sin fin de mensaje es un error reintentable, no una respuesta', async () => {
    const server = await startServer((_r, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(sse({ choices: [{ delta: { content: 'El informe empieza así y' } }] }));
    });
    cleanups.push(server.close);
    await expect(new OpenAiCompatibleClient(server.url).chat(req)).rejects.toMatchObject({ name: 'LlmError', retryable: true, message: 'La respuesta del proveedor se cortó antes de terminar.' });
  });

  it('con motivo de fin o con [DONE] la respuesta es válida', async () => {
    let mode = 'finish';
    const server = await startServer((_r, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (mode === 'finish') res.end(sse({ choices: [{ delta: { content: 'hola' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }));
      else res.end(sse({ choices: [{ delta: { content: 'hola' } }] }, '[DONE]'));
    });
    cleanups.push(server.close);
    expect((await new OpenAiCompatibleClient(server.url).chat(req)).content).toBe('hola');
    mode = 'done';
    expect((await new OpenAiCompatibleClient(server.url).chat(req)).content).toBe('hola');
  });

  it('una llamada a herramienta con argumentos cortados no se ejecuta: el modelo recibe el motivo y puede repetirla', async () => {
    let turn = 0;
    const server = await startServer((_r, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      turn++;
      if (turn === 1) {
        // Argumentos a medias y fin por límite de tokens.
        res.end(sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'file_write', arguments: '{"path": "informe.md", "content": "Empie' } }] } }] }, { choices: [{ delta: {}, finish_reason: 'length' }] }));
      } else {
        res.end(sse({ choices: [{ delta: { content: 'No pude guardar el archivo.' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }));
      }
    });
    cleanups.push(server.close);
    const { ctx } = await boot(undefined);
    // Proveedor real (adaptador de producción) contra el servidor local.
    const real = makeContext((await import('../src/llm')).defaultLlmFactory);
    cleanups.push(() => real.close());
    const provider = real.store.createProvider({ name: 'Local', kind: 'openai', baseUrl: server.url });
    const agent = addAgent(real, { providerId: provider.id, tools: ['file_write'] });
    const run = real.runs.startAgentRun(agent, 'guarda el informe');
    await real.runs.waitFor(run.id);
    const done = real.store.getRun(run.id)!;
    expect(done.status).toBe('completed');
    expect(done.output).toBe('No pude guardar el archivo.');
    const events = real.store.listEvents(run.id);
    expect(events.find((e) => e.type === 'llm.message')!.data.truncated).toBe(true);
    const result = events.find((e) => e.type === 'tool.result')!.data;
    expect(result.ok).toBe(false);
    expect(result.result).toMatch(/no son JSON válido \(la respuesta se cortó por el límite de tokens\)/);
    // El archivo NO se ha escrito con contenido a medias.
    expect(fs.existsSync(`${real.config.workspaceDir}/informe.md`)).toBe(false);
    expect(ctx.store.listRuns().total).toBe(0);
  });
});

describe('ids de nodo reservados', () => {
  it('un nodo no puede llamarse como una referencia integrada, y los ids generados lo evitan', () => {
    const issue = (id: string) =>
      validateWorkflow({ nodes: [{ ...node(id, 'transform', { template: 'x' }) }], edges: [] }, { agentIds: [], toolNames: [] })
        .filter((i) => i.level === 'error')
        .map((i) => i.message);
    for (const id of ['input', 'upstream', 'date', 'item', 'index', 'total', 'constructor']) expect(issue(id)[0], id).toMatch(/está reservado/);
    expect(issue('entrada')).toEqual([]);
    expect(slugifyNodeId('Input', [])).toBe('input_2');
    expect(slugifyNodeId('Total', ['total_2'])).toBe('total_3');
    expect(slugifyNodeId('Resumen', [])).toBe('resumen');
  });
});
