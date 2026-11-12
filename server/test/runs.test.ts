// Ejecuciones largas y filtros del historial: eventos por páginas, estado de los pasos ya calculado para quien
// abre una ejecución a medias, validación del flujo en vivo y filtros por workflow, agente, fecha y «en curso».
import type { FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { Run, RunEvent, RunSummary } from '../../shared/types';
import { buildApp } from '../src/app';
import type { AppContext } from '../src/context';
import { addAgent, delay, edges, makeContext, node, ScriptedLlm, userText, workflow, type ScriptHandler } from './helpers';

let ctx: AppContext;
let app: FastifyInstance;
/** Suelta a los modelos que esperan (los que reciben «lento»). */
let release: () => void = () => {};

async function boot(handler: ScriptHandler = (req) => ({ content: `eco(${userText(req)})` })) {
  const gate = new Promise<void>((resolve) => (release = resolve));
  const llm = new ScriptedLlm(async (req, index) => {
    // Con herramientas, la espera es en la llamada que ya trae su resultado; sin ellas, en la única que hay.
    if (userText(req).includes('lento') && (!req.tools?.length || req.messages.at(-1)?.role === 'tool')) {
      await Promise.race([gate, new Promise<void>((resolve) => req.signal?.addEventListener('abort', () => resolve()))]);
      if (req.signal?.aborted) throw req.signal.reason;
    }
    return handler(req, index);
  });
  ctx = makeContext(llm);
  app = await buildApp(ctx);
}

afterEach(async () => {
  release();
  await app?.close();
  await ctx?.close();
});

const get = (url: string, headers: Record<string, string> = {}) => app.inject({ method: 'GET', url, headers });
const until = async (check: () => boolean, what: string) => {
  for (let i = 0; i < 300 && !check(); i++) await delay(10);
  if (!check()) throw new Error(`No ocurrió a tiempo: ${what}`);
};

/** Ejecución terminada a la que se le añaden eventos hasta tener `total` (por la misma vía que el motor: el almacén). */
async function longRun(total: number): Promise<Run> {
  const run = ctx.runs.startAgentRun(addAgent(ctx), 'hola');
  await ctx.runs.waitFor(run.id);
  for (let seq = ctx.store.lastEventSeq(run.id) + 1; seq <= total; seq++) {
    ctx.store.appendEvent(run.id, seq % 2 ? 'tool.call' : 'tool.result', 'agent', { id: `c${Math.ceil(seq / 2)}`, name: 'calculator', ok: true });
  }
  return ctx.store.getRun(run.id)!;
}

describe('GET /api/runs/:id/events: páginas', () => {
  it('entrega la página pedida con `limit` y los cursores `after` y `before`, siempre por orden', async () => {
    await boot();
    const run = await longRun(950);
    const seqs = async (query: string) => ((await get(`/api/runs/${run.id}/events${query}`)).json() as RunEvent[]).map((e) => e.seq);
    const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_v, i) => from + i);

    expect(run.lastSeq).toBe(950);
    // Sin límite, todo (compatibilidad); con límite, las primeras a partir del cursor.
    expect(await seqs('')).toEqual(range(1, 950));
    expect(await seqs('?limit=200')).toEqual(range(1, 200));
    expect(await seqs('?after=200&limit=200')).toEqual(range(201, 400));
    // Hacia atrás: la página más reciente y la inmediatamente anterior, las dos en orden ascendente.
    expect(await seqs(`?before=${run.lastSeq + 1}&limit=200`)).toEqual(range(751, 950));
    expect(await seqs('?before=751&limit=200')).toEqual(range(551, 750));
    // La primera página viene incompleta: no hay nada antes.
    expect(await seqs('?before=151&limit=200')).toEqual(range(1, 150));
    expect(await seqs('?before=1&limit=200')).toEqual([]);
    // Los dos cursores acotan un tramo.
    expect(await seqs('?after=10&before=15')).toEqual([11, 12, 13, 14]);
    expect(await seqs('?after=10&before=500&limit=3')).toEqual([497, 498, 499]);
    expect(await seqs('?limit=1000')).toHaveLength(950);
  });

  it('rechaza con 400 un límite o un cursor no válidos', async () => {
    await boot();
    const run = await longRun(10);
    for (const query of ['limit=0', 'limit=1001', 'limit=abc', 'limit=1.5', 'before=-1', 'before=x', 'after=-3', 'after=1.5']) {
      const res = await get(`/api/runs/${run.id}/events?${query}`);
      expect(res.statusCode, query).toBe(400);
      expect(res.json(), query).toMatchObject({ code: 'validation', issues: [{ path: query.split('=')[0] }] });
    }
    expect((await get('/api/runs/run_no_existe/events?limit=5')).statusCode).toBe(404);
  });
});

describe('GET /api/runs/:id: estado ya calculado', () => {
  it('una ejecución a medias llega con sus pasos al día, el consumo del paso en curso y `lastSeq`', async () => {
    await boot((req) =>
      req.messages.at(-1)?.role === 'tool' ? { content: 'son 2' } : { toolCalls: [{ id: 'c1', name: 'calculator', arguments: { expression: '1+1' } }] },
    );
    const agent = addAgent(ctx, { tools: ['calculator'] });
    const wf = ctx.store.createWorkflow(
      workflow([node('in', 'input'), node('a', 'agent', { agentId: agent.id, prompt: 'lento {{input}}' }), node('out', 'output')], edges('in>a', 'a>out')),
    );
    const started = ctx.runs.startWorkflowRun(wf, 'suma');
    // El agente ha pedido la calculadora, ha recibido el resultado y espera la segunda respuesta del modelo.
    await until(() => ctx.store.listEvents(started.id).some((e) => e.type === 'tool.result'), 'el resultado de la herramienta');

    const events = ctx.store.listEvents(started.id);
    const run = (await get(`/api/runs/${started.id}`)).json() as Run;
    expect(run.status).toBe('running');
    expect(run.lastSeq).toBe(events.at(-1)!.seq);
    expect(Object.fromEntries(run.steps.map((s) => [s.nodeId, s.status]))).toEqual({ in: 'completed', a: 'running', out: 'pending' });
    expect(run.steps[1]).toMatchObject({ attempt: 1, input: 'lento suma', finishedAt: null });
    // El consumo del paso en curso aún no está guardado (se guarda al terminar), pero la respuesta ya lo trae.
    expect(ctx.store.getRun(started.id)!.steps[1].usage).toEqual({ promptTokens: 0, completionTokens: 0, llmCalls: 0, toolCalls: 0 });
    expect(run.steps[1].usage).toEqual({ promptTokens: 10, completionTokens: 5, llmCalls: 1, toolCalls: 1 });

    release();
    await ctx.runs.waitFor(started.id);
    const finished = (await get(`/api/runs/${started.id}`)).json() as Run;
    expect(finished).toMatchObject({ status: 'completed', output: 'son 2' });
    expect(finished.steps[1].usage).toEqual({ promptTokens: 20, completionTokens: 10, llmCalls: 2, toolCalls: 1 });
    expect(finished.lastSeq).toBe(ctx.store.listEvents(started.id).at(-1)!.seq);
  });

  it('una ejecución recién creada y una terminada traen su `lastSeq`', async () => {
    await boot();
    const run = ctx.runs.startAgentRun(addAgent(ctx), 'lento');
    expect(run.lastSeq).toBe(0);
    release();
    await ctx.runs.waitFor(run.id);
    const count = ctx.db.prepare('SELECT COUNT(*) AS n FROM run_events WHERE run_id = ?').get(run.id) as { n: number };
    expect(((await get(`/api/runs/${run.id}`)).json() as Run).lastSeq).toBe(count.n);
  });
});

describe('GET /api/runs/:id/stream: validación', () => {
  it('rechaza con 400 un `after` o un `Last-Event-ID` no válidos, sin abrir el canal', async () => {
    await boot();
    const run = await longRun(6);
    for (const bad of ['abc', '-1', '1.5']) {
      const byQuery = await get(`/api/runs/${run.id}/stream?after=${bad}`);
      expect(byQuery.statusCode, bad).toBe(400);
      expect(byQuery.headers['content-type'], bad).toContain('application/json');
      expect(byQuery.json(), bad).toMatchObject({ code: 'validation', issues: [{ path: 'after' }] });
      const byHeader = await get(`/api/runs/${run.id}/stream`, { 'last-event-id': bad });
      expect(byHeader.statusCode, bad).toBe(400);
      expect(byHeader.json(), bad).toMatchObject({ code: 'validation', issues: [{ path: 'last-event-id' }] });
    }
  });

  it('con un `after` válido reproduce solo lo posterior; la cabecera tiene prioridad', async () => {
    await boot();
    const run = await longRun(6);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const ids = async (url: string, headers: Record<string, string> = {}) => {
      const res = await fetch(url, { headers });
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      let text = '';
      const wanted = /id: 6\n/;
      while (!wanted.test(text)) text += new TextDecoder().decode((await reader.read()).value);
      await reader.cancel();
      return [...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    };
    expect(await ids(`${base}/api/runs/${run.id}/stream?after=4`)).toEqual([5, 6]);
    expect(await ids(`${base}/api/runs/${run.id}/stream?after=0`, { 'Last-Event-ID': '3' })).toEqual([4, 5, 6]);
  });
});

describe('GET /api/runs: filtros del historial', () => {
  const ids = async (query: string) => ((await get(`/api/runs?${query}`)).json() as { items: RunSummary[] }).items.map((r) => r.id);
  /** Fija la fecha de creación de una ejecución (el historial se filtra por ella). */
  const dated = (run: Run, createdAt: string): Run => {
    ctx.db.prepare('UPDATE runs SET created_at = ? WHERE id = ?').run(createdAt, run.id);
    return run;
  };

  it('«active» reúne las que no han terminado: en curso y también en cola', async () => {
    await boot();
    ctx.store.updateSettings({ maxConcurrentRuns: 1 });
    const agent = addAgent(ctx);
    const done = ctx.runs.startAgentRun(agent, 'rápido');
    await ctx.runs.waitFor(done.id);
    const running = ctx.runs.startAgentRun(agent, 'lento uno');
    const queued = ctx.runs.startAgentRun(agent, 'lento dos');
    await until(() => ctx.store.getRunSummary(running.id)!.status === 'running', 'que arranque la primera');
    expect(ctx.store.getRunSummary(queued.id)!.status).toBe('queued');

    expect(await ids('status=running')).toEqual([running.id]);
    expect(await ids('status=queued')).toEqual([queued.id]);
    expect((await ids('status=active')).sort()).toEqual([running.id, queued.id].sort());
    expect(((await get('/api/runs?status=active')).json() as { total: number }).total).toBe(2);
    expect(await ids('status=completed')).toEqual([done.id]);
    expect((await get('/api/runs?status=activa')).statusCode).toBe(400);
  });

  it('filtra por workflow, por agente y por intervalo de fechas, solos y combinados', async () => {
    await boot();
    const agentA = addAgent(ctx, { name: 'A' });
    const agentB = addAgent(ctx, { name: 'B' });
    const def = workflow([node('in', 'input'), node('out', 'output')], edges('in>out'));
    const wf1 = ctx.store.createWorkflow({ ...def, name: 'Uno' });
    const wf2 = ctx.store.createWorkflow({ ...def, name: 'Dos' });
    const finish = async (run: Run, createdAt: string) => {
      await ctx.runs.waitFor(run.id);
      return dated(run, createdAt);
    };
    const w1Old = await finish(ctx.runs.startWorkflowRun(wf1, 'x'), '2026-03-01T10:00:00.000Z');
    const w1New = await finish(ctx.runs.startWorkflowRun(wf1, 'x'), '2026-03-10T10:00:00.000Z');
    const w2 = await finish(ctx.runs.startWorkflowRun(wf2, 'x'), '2026-03-05T10:00:00.000Z');
    const aOld = await finish(ctx.runs.startAgentRun(agentA, 'x'), '2026-03-02T23:30:00.000Z');
    const aNew = await finish(ctx.runs.startAgentRun(agentA, 'x'), '2026-03-09T10:00:00.000Z');
    const b = await finish(ctx.runs.startAgentRun(agentB, 'x'), '2026-03-05T12:00:00.000Z');

    expect(await ids(`workflowId=${wf1.id}`)).toEqual([w1New.id, w1Old.id]);
    expect(await ids(`agentId=${agentA.id}`)).toEqual([aNew.id, aOld.id]);
    expect(await ids(`agentId=${agentB.id}&kind=agent&status=completed`)).toEqual([b.id]);
    // Intervalo con los dos extremos incluidos, de más reciente a más antigua.
    expect(await ids('from=2026-03-05T10:00:00.000Z&to=2026-03-09T10:00:00.000Z')).toEqual([aNew.id, b.id, w2.id]);
    expect(await ids('from=2026-03-09T10:00:00.001Z')).toEqual([w1New.id]);
    expect(await ids('to=2026-03-02T00:00:00Z')).toEqual([w1Old.id]);
    // Un instante con desplazamiento horario se compara en UTC: las 00:30 del día 3 en +01:00 son las 23:30 del día 2.
    expect(await ids(`from=${encodeURIComponent('2026-03-03T00:30:00+01:00')}&to=${encodeURIComponent('2026-03-03T00:30:00+01:00')}`)).toEqual([aOld.id]);
    // Combinados con el origen y con el estado.
    expect(await ids(`workflowId=${wf1.id}&from=2026-03-05T00:00:00Z`)).toEqual([w1New.id]);
    expect(await ids(`agentId=${agentA.id}&to=2026-03-05T00:00:00Z&status=completed`)).toEqual([aOld.id]);
    expect(await ids('from=2026-04-01T00:00:00Z')).toEqual([]);
    const page = (await get(`/api/runs?from=2026-03-01T00:00:00Z&to=2026-03-31T00:00:00Z&limit=2&offset=2`)).json() as { items: RunSummary[]; total: number };
    expect(page.total).toBe(6);
    expect(page.items.map((r) => r.id)).toEqual([b.id, w2.id]);
    // Y con la búsqueda de texto.
    expect(await ids(`search=Uno&to=2026-03-05T00:00:00Z`)).toEqual([w1Old.id]);
  });

  it('rechaza con 400 una fecha que no es un instante ISO 8601 con zona', async () => {
    await boot();
    for (const [param, value] of [
      ['from', '2026-03-05'],
      ['from', 'ayer'],
      ['to', '2026-03-05T10:00:00'],
      ['to', '05/03/2026'],
    ]) {
      const res = await get(`/api/runs?${param}=${encodeURIComponent(value)}`);
      expect(res.statusCode, value).toBe(400);
      expect(res.json(), value).toMatchObject({ code: 'validation', issues: [{ path: param }] });
    }
  });

  it('el intervalo de fechas se resuelve con los índices que ya existen (general, por workflow, por agente y por estado)', async () => {
    await boot();
    const plan = (where: string) =>
      (ctx.db.prepare(`EXPLAIN QUERY PLAN SELECT id FROM runs WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT 30`).all() as Array<{ detail: string }>)
        .map((row) => row.detail)
        .join(' | ');
    const between = "created_at >= '2026-03-01T00:00:00.000Z' AND created_at <= '2026-03-31T00:00:00.000Z'";
    expect(plan(between)).toMatch(/SEARCH runs USING COVERING INDEX idx_runs_created \(created_at>\? AND created_at<\?\)/);
    expect(plan(`workflow_id = 'w' AND ${between}`)).toMatch(
      /USING COVERING INDEX idx_runs_workflow_created \(workflow_id=\? AND created_at>\? AND created_at<\?\)/,
    );
    expect(plan(`agent_id = 'a' AND ${between}`)).toMatch(/USING COVERING INDEX idx_runs_agent_created \(agent_id=\? AND created_at>\? AND created_at<\?\)/);
    expect(plan(`status = 'failed' AND ${between}`)).toMatch(/USING COVERING INDEX idx_runs_status_created \(status=\? AND created_at>\? AND created_at<\?\)/);
    // Ninguno necesita ordenar aparte: el índice ya entrega el orden del historial.
    for (const where of [between, `workflow_id = 'w' AND ${between}`, `agent_id = 'a' AND ${between}`]) expect(plan(where)).not.toContain('TEMP B-TREE');
  });
});
