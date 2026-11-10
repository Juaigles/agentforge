// API REST + SSE de AgentForge.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import { validateWorkflow } from '../../../shared/graph';
import type {
  DashboardStats,
  ProviderHealth,
  ProviderTestResult,
  RunEvent,
  RunKind,
  RunStatus,
  Workflow,
} from '../../../shared/types';
import type { AppContext } from '../context';
import { HttpError } from '../errors';
import type { LlmProviderConfig } from '../llm/types';
import { listWorkspaceFiles, resolveInWorkspace } from '../tools/builtin';
import { errorMessage, stringifyResult } from '../util';
import {
  agentSchema,
  customToolSchema,
  invokeToolSchema,
  providerSchema,
  retrySchema,
  runInputSchema,
  settingsSchema,
  workflowSchema,
} from './schemas';

export const APP_VERSION = '0.1.0';
const HEALTH_TTL_MS = 10_000;

const idOf = (req: FastifyRequest): string => (req.params as { id: string }).id;

function notFound(what: string): never {
  throw new HttpError(404, `${what} no encontrado.`);
}

/** Abre una respuesta SSE y devuelve funciones para enviar eventos y registrar la limpieza. */
function openSse(req: FastifyRequest, reply: FastifyReply) {
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  raw.write('retry: 2000\n\n');
  const heartbeat = setInterval(() => raw.write(': ping\n\n'), 15_000);
  const cleanups: Array<() => void> = [() => clearInterval(heartbeat)];
  req.raw.on('close', () => cleanups.forEach((fn) => fn()));
  return {
    send(event: string, data: unknown, id?: number | null) {
      raw.write(`${id != null ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    onClose(fn: () => void) {
      cleanups.push(fn);
    },
  };
}

export function registerApi(app: FastifyInstance, ctx: AppContext): void {
  const { store, tools, runs } = ctx;
  let healthCache: { at: number; data: ProviderHealth[] } | null = null;

  async function testProvider(provider: LlmProviderConfig): Promise<ProviderTestResult> {
    const started = Date.now();
    try {
      const models = await ctx.llm.create(provider).listModels(AbortSignal.timeout(8000));
      return { ok: true, latencyMs: Date.now() - started, modelCount: models.length };
    } catch (err) {
      const timedOut = err instanceof Error && err.name === 'TimeoutError';
      return {
        ok: false,
        latencyMs: Date.now() - started,
        error: timedOut ? 'El proveedor no respondió en 8 segundos.' : errorMessage(err),
      };
    }
  }

  function workflowIssues(wf: Pick<Workflow, 'nodes' | 'edges'>) {
    return validateWorkflow(wf, { agentIds: store.listAgents().map((a) => a.id), toolNames: tools.names() });
  }

  function assertAgentRefs(input: { providerId: string; tools: string[] }): void {
    if (!store.getProvider(input.providerId)) throw new HttpError(400, 'El proveedor seleccionado no existe.');
    const known = new Set(tools.list().map((t) => t.name));
    const unknown = input.tools.filter((t) => !known.has(t));
    if (unknown.length) throw new HttpError(400, `Herramientas desconocidas: ${unknown.join(', ')}.`);
  }

  // ---------- Sistema ----------
  app.get('/api/health', async () => ({ ok: true, version: APP_VERSION, uptimeSec: Math.round((Date.now() - ctx.startedAt) / 1000) }));

  app.get('/api/stats', async (): Promise<DashboardStats> => {
    const s = store.stats();
    let dbSizeBytes = 0;
    for (const suffix of ['', '-wal']) {
      try {
        dbSizeBytes += fs.statSync(ctx.config.dbFile + suffix).size;
      } catch {
        /* en memoria o aún sin crear */
      }
    }
    return {
      counts: {
        agents: s.counts.agents,
        workflows: s.counts.workflows,
        providers: s.counts.providers,
        tools: tools.list().filter((t) => t.enabled).length,
        runs: s.counts.runs,
      },
      runsByStatus: s.runsByStatus,
      activeRuns: runs.activeCount,
      queuedRuns: runs.queuedCount,
      successRate: s.successRate,
      avgDurationMs: s.avgDurationMs,
      tokens: s.tokens,
      llmCalls: s.llmCalls,
      toolCalls: s.toolCalls,
      daily: s.daily,
      topAgents: s.topAgents,
      topTools: s.topTools,
      recentRuns: store.listRuns({ limit: 8 }).items,
      system: {
        version: APP_VERSION,
        nodeVersion: process.version,
        platform: `${os.type()} ${os.release()} (${os.arch()})`,
        uptimeSec: Math.round((Date.now() - ctx.startedAt) / 1000),
        memoryMb: Math.round(process.memoryUsage().rss / 1_048_576),
        dbSizeBytes,
        dataDir: ctx.config.dataDir,
      },
    };
  });

  app.get('/api/settings', async () => store.getSettings());
  app.put('/api/settings', async (req) => store.updateSettings(settingsSchema.parse(req.body)));

  // ---------- Proveedores ----------
  app.get('/api/providers', async () => store.listProviders());

  app.get('/api/providers/health', async (req): Promise<ProviderHealth[]> => {
    const force = (req.query as { force?: string }).force === '1';
    if (!force && healthCache && Date.now() - healthCache.at < HEALTH_TTL_MS) return healthCache.data;
    const data = await Promise.all(
      store
        .listProviders()
        .filter((p) => p.enabled)
        .map(async (p) => {
          const r = await testProvider(store.getProviderWithSecret(p.id)!);
          return { providerId: p.id, name: p.name, kind: p.kind, ok: r.ok, latencyMs: r.latencyMs, modelCount: r.modelCount ?? 0, error: r.error };
        }),
    );
    healthCache = { at: Date.now(), data };
    return data;
  });

  app.post('/api/providers', async (req, reply) => {
    healthCache = null;
    return reply.status(201).send(store.createProvider(providerSchema.parse(req.body)));
  });

  /** Prueba una configuración sin guardarla (para el formulario de alta/edición). */
  app.post('/api/providers/test', async (req) => {
    const body = req.body as { id?: string };
    const input = providerSchema.parse(req.body);
    // Al editar, si no se envía una clave nueva se prueba con la guardada.
    const saved = body.id ? store.getProviderWithSecret(body.id) : null;
    return testProvider({ kind: input.kind, baseUrl: input.baseUrl, apiKey: input.apiKey === undefined ? saved?.apiKey : input.apiKey });
  });

  /** Lista los modelos de una configuración sin guardarla (para elegir el modelo por defecto al dar de alta). */
  app.post('/api/providers/models', async (req) => {
    const body = req.body as { id?: string };
    const input = providerSchema.parse(req.body);
    const saved = body.id ? store.getProviderWithSecret(body.id) : null;
    return ctx.llm
      .create({ kind: input.kind, baseUrl: input.baseUrl, apiKey: input.apiKey === undefined ? saved?.apiKey : input.apiKey })
      .listModels(AbortSignal.timeout(8000));
  });

  app.put('/api/providers/:id', async (req) => {
    healthCache = null;
    return store.updateProvider(idOf(req), providerSchema.parse(req.body)) ?? notFound('Proveedor');
  });

  app.delete('/api/providers/:id', async (req, reply) => {
    const id = idOf(req);
    const used = store.countAgentsByProvider(id);
    if (used) throw new HttpError(409, `No se puede eliminar: ${used} agente(s) usan este proveedor.`);
    if (!store.deleteProvider(id)) notFound('Proveedor');
    healthCache = null;
    return reply.status(204).send();
  });

  app.post('/api/providers/:id/test', async (req) => {
    const provider = store.getProviderWithSecret(idOf(req)) ?? notFound('Proveedor');
    return testProvider(provider);
  });

  app.get('/api/providers/:id/models', async (req) => {
    const provider = store.getProviderWithSecret(idOf(req)) ?? notFound('Proveedor');
    return ctx.llm.create(provider).listModels(AbortSignal.timeout(8000));
  });

  // ---------- Agentes ----------
  app.get('/api/agents', async () => store.listAgents());
  app.get('/api/agents/:id', async (req) => store.getAgent(idOf(req)) ?? notFound('Agente'));

  app.post('/api/agents', async (req, reply) => {
    const input = agentSchema.parse(req.body);
    assertAgentRefs(input);
    return reply.status(201).send(store.createAgent(input));
  });

  app.put('/api/agents/:id', async (req) => {
    const input = agentSchema.parse(req.body);
    assertAgentRefs(input);
    return store.updateAgent(idOf(req), input) ?? notFound('Agente');
  });

  app.post('/api/agents/:id/duplicate', async (req, reply) => {
    const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = store.getAgent(idOf(req)) ?? notFound('Agente');
    return reply.status(201).send(store.createAgent({ ...rest, name: `${rest.name} (copia)` }));
  });

  app.delete('/api/agents/:id', async (req, reply) => {
    const id = idOf(req);
    const used = store.workflowsUsingAgent(id);
    if (used.length) {
      throw new HttpError(409, `No se puede eliminar: lo usan los workflows ${used.map((w) => `«${w.name}»`).join(', ')}.`);
    }
    if (!store.deleteAgent(id)) notFound('Agente');
    return reply.status(204).send();
  });

  app.post('/api/agents/:id/run', async (req, reply) => {
    const agent = store.getAgent(idOf(req)) ?? notFound('Agente');
    const { input } = runInputSchema.parse(req.body);
    if (!input.trim()) throw new HttpError(400, 'Escribe una tarea para el agente.');
    return reply.status(202).send(runs.startAgentRun(agent, input));
  });

  // ---------- Herramientas ----------
  app.get('/api/tools', async () => tools.list());
  app.get('/api/tools/custom', async () => store.listCustomTools());
  app.get('/api/tools/custom/:id', async (req) => store.getCustomTool(idOf(req)) ?? notFound('Herramienta'));

  function assertToolName(name: string, selfId?: string): void {
    if (tools.isBuiltin(name)) throw new HttpError(409, `"${name}" es el nombre de una herramienta integrada.`);
    const other = store.getCustomToolByName(name);
    if (other && other.id !== selfId) throw new HttpError(409, `Ya existe una herramienta llamada "${name}".`);
  }

  app.post('/api/tools/custom', async (req, reply) => {
    const input = customToolSchema.parse(req.body);
    assertToolName(input.name);
    return reply.status(201).send(store.createCustomTool(input));
  });

  app.put('/api/tools/custom/:id', async (req) => {
    const input = customToolSchema.parse(req.body);
    assertToolName(input.name, idOf(req));
    return store.updateCustomTool(idOf(req), input) ?? notFound('Herramienta');
  });

  app.delete('/api/tools/custom/:id', async (req, reply) => {
    if (!store.deleteCustomTool(idOf(req))) notFound('Herramienta');
    return reply.status(204).send();
  });

  /** Ejecuta una herramienta manualmente (banco de pruebas de la interfaz). */
  app.post('/api/tools/:name/invoke', async (req) => {
    const name = (req.params as { name: string }).name;
    if (!tools.get(name)) notFound('Herramienta');
    const { args } = invokeToolSchema.parse(req.body);
    const started = Date.now();
    try {
      const result = await tools.invoke(name, args, {
        runId: 'manual',
        nodeId: 'manual',
        signal: AbortSignal.timeout(30_000),
        workspaceDir: ctx.config.workspaceDir,
        settings: store.getSettings(),
        memory: new Map(),
      });
      return { ok: true, durationMs: Date.now() - started, result: stringifyResult(result) };
    } catch (err) {
      return { ok: false, durationMs: Date.now() - started, error: errorMessage(err) };
    }
  });

  // ---------- Espacio de trabajo ----------
  app.get('/api/workspace/files', async () => listWorkspaceFiles(ctx.config.workspaceDir));

  app.get('/api/workspace/file', async (req) => {
    const rel = String((req.query as { path?: string }).path ?? '');
    if (!rel) throw new HttpError(400, 'Falta el parámetro path.');
    let target: string;
    try {
      target = resolveInWorkspace(ctx.config.workspaceDir, rel);
    } catch (err) {
      throw new HttpError(400, errorMessage(err));
    }
    const stat = await fsp.stat(target).catch(() => null);
    if (!stat?.isFile()) notFound('Archivo');
    const content = await fsp.readFile(target, 'utf8');
    return { path: rel, sizeBytes: stat!.size, content: content.slice(0, 500_000), truncated: content.length > 500_000 };
  });

  app.delete('/api/workspace/file', async (req, reply) => {
    const rel = String((req.query as { path?: string }).path ?? '');
    let target: string;
    try {
      target = resolveInWorkspace(ctx.config.workspaceDir, rel);
    } catch (err) {
      throw new HttpError(400, errorMessage(err));
    }
    const stat = await fsp.stat(target).catch(() => null);
    if (!rel || !stat?.isFile()) notFound('Archivo');
    await fsp.unlink(target);
    return reply.status(204).send();
  });

  // ---------- Workflows ----------
  app.get('/api/workflows', async () => store.listWorkflows());
  app.get('/api/workflows/:id', async (req) => store.getWorkflow(idOf(req)) ?? notFound('Workflow'));

  app.post('/api/workflows', async (req, reply) => reply.status(201).send(store.createWorkflow(workflowSchema.parse(req.body))));

  app.put('/api/workflows/:id', async (req) => store.updateWorkflow(idOf(req), workflowSchema.parse(req.body)) ?? notFound('Workflow'));

  app.post('/api/workflows/validate', async (req) => {
    const wf = workflowSchema.parse(req.body);
    return { issues: workflowIssues(wf) };
  });

  app.post('/api/workflows/:id/duplicate', async (req, reply) => {
    const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = store.getWorkflow(idOf(req)) ?? notFound('Workflow');
    return reply.status(201).send(store.createWorkflow({ ...rest, name: `${rest.name} (copia)` }));
  });

  app.delete('/api/workflows/:id', async (req, reply) => {
    if (!store.deleteWorkflow(idOf(req))) notFound('Workflow');
    return reply.status(204).send();
  });

  app.post('/api/workflows/:id/run', async (req, reply) => {
    const workflow = store.getWorkflow(idOf(req)) ?? notFound('Workflow');
    const { input } = runInputSchema.parse(req.body);
    const issues = workflowIssues(workflow);
    const errors = issues.filter((i) => i.level === 'error');
    if (errors.length) throw new HttpError(422, `El workflow tiene errores: ${errors[0].message}`, { issues });
    return reply.status(202).send(runs.startWorkflowRun(workflow, input));
  });

  // ---------- Ejecuciones ----------
  app.get('/api/runs', async (req) => {
    const q = req.query as Record<string, string | undefined>;
    return store.listRuns({
      status: q.status as RunStatus | undefined,
      kind: q.kind as RunKind | undefined,
      workflowId: q.workflowId,
      agentId: q.agentId,
      search: q.search,
      limit: q.limit ? Number(q.limit) : undefined,
      offset: q.offset ? Number(q.offset) : undefined,
    });
  });

  app.get('/api/runs/:id', async (req) => store.getRun(idOf(req)) ?? notFound('Ejecución'));

  app.get('/api/runs/:id/events', async (req) => {
    if (!store.getRunSummary(idOf(req))) notFound('Ejecución');
    return store.listEvents(idOf(req), Number((req.query as { after?: string }).after ?? 0) || 0);
  });

  app.post('/api/runs/:id/cancel', async (req) => {
    const run = store.getRunSummary(idOf(req)) ?? notFound('Ejecución');
    if (!runs.cancel(run.id)) throw new HttpError(409, 'La ejecución ya había terminado.');
    return { ok: true };
  });

  app.post('/api/runs/:id/retry', async (req, reply) => {
    const run = store.getRun(idOf(req)) ?? notFound('Ejecución');
    if (runs.isActive(run.id)) throw new HttpError(409, 'La ejecución todavía está en curso.');
    const { mode } = retrySchema.parse(req.body ?? {});
    return reply.status(202).send(runs.retryRun(run, mode));
  });

  app.delete('/api/runs/:id', async (req, reply) => {
    const id = idOf(req);
    if (runs.isActive(id)) throw new HttpError(409, 'Cancela la ejecución antes de eliminarla.');
    if (!store.deleteRun(id)) notFound('Ejecución');
    return reply.status(204).send();
  });

  app.delete('/api/runs', async () => ({ deleted: store.deleteFinishedRuns() }));

  /** Eventos de una ejecución en tiempo real. Reproduce primero el historial (desde Last-Event-ID). */
  app.get('/api/runs/:id/stream', async (req, reply) => {
    const runId = idOf(req);
    if (!store.getRunSummary(runId)) notFound('Ejecución');
    const after = Number(req.headers['last-event-id'] ?? (req.query as { after?: string }).after ?? 0) || 0;
    const sse = openSse(req, reply);
    const send = (ev: RunEvent) => sse.send('run-event', ev, ev.seq);
    // Historial + suscripción ocurren en el mismo tick (SQLite es síncrono): no se pierde ni duplica nada.
    for (const ev of store.listEvents(runId, after)) send(ev);
    for (const p of runs.partials(runId)) {
      send({ seq: null, runId, ts: new Date().toISOString(), type: 'llm.snapshot', nodeId: p.nodeId, data: { text: p.text } });
    }
    sse.onClose(runs.subscribe(runId, send));
  });

  /** Cambios de estado de todas las ejecuciones (listas y dashboard en vivo). */
  app.get('/api/stream/runs', async (req, reply) => {
    const sse = openSse(req, reply);
    sse.onClose(runs.subscribeRuns((run) => sse.send('run', run)));
  });
}
