// API REST + SSE de AgentForge.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import { validateWorkflow } from '../../../shared/graph';
import {
  AGENT_EXPORT_FORMAT,
  WORKFLOW_EXPORT_FORMAT,
  type AgentExport,
  type ExportBundle,
  type ImportPlan,
  type ImportResult,
  type DashboardStats,
  type ProviderHealth,
  type ProviderTestResult,
  type BackupState,
  type RunEvent,
  type Trigger,
  type TriggerInput,
  type TriggerPreview,
  type TriggerWithSecret,
  MAX_TRIGGERS_PER_WORKFLOW,
  type Workflow,
  type WorkflowExport,
  type WorkflowImportResult,
} from '../../../shared/types';
import { backupFile, cancelRestore, createBackup, deleteBackup, lastRestore, listBackups, pendingRestore, prepareRestore, receiveBackup } from '../backup';
import type { AppContext } from '../context';
import { SCHEMA_VERSION } from '../db/database';
import { systemTimeZone } from '../engine/cron';
import { nextOccurrence, upcomingOccurrences } from '../engine/scheduler';
import { HttpError } from '../errors';
import { HttpCounters, renderMetrics } from '../metrics';
import { buildOpenApi } from '../openapi';
import { APP_VERSION } from '../version';
import type { LlmProviderConfig } from '../llm/types';
import { applyImport, exportAgent, exportWorkflow, planImport } from '../portability';
import { listWorkspaceFiles, resolveInWorkspace } from '../tools/builtin';
import { sandboxStatus } from '../tools/sandbox';
import { errorMessage, stringifyResult } from '../util';
import {
  agentImportSchema,
  agentSchema,
  approvalDecisionSchema,
  importDecisionsSchema,
  customToolSchema,
  eventsQuerySchema,
  invokeToolSchema,
  providerProbeSchema,
  providerSchema,
  retrySchema,
  runIdsSchema,
  runsQuerySchema,
  mcpServerSchema,
  triggerSchema,
  workflowImportSchema,
  runInputSchema,
  settingsSchema,
  workflowSchema,
} from './schemas';

export { APP_VERSION };
const HEALTH_TTL_MS = 10_000;
/** Bytes pendientes de enviar a partir de los cuales se corta a un cliente SSE que no lee. */
const MAX_SSE_BUFFER_BYTES = 8 * 1024 * 1024;
/** Eventos del historial que se envían por tanda al conectar (entre tandas se cede el control). */
const SSE_REPLAY_BATCH = 500;

const idOf = (req: FastifyRequest): string => (req.params as { id: string }).id;

/** Sustantivos femeninos entre lo que se puede no encontrar (concordancia del mensaje). */
const FEMININE = new Set(['Ejecución', 'Herramienta']);
function notFound(what: string): never {
  throw new HttpError(404, `${what} no ${FEMININE.has(what) ? 'encontrada' : 'encontrado'}.`);
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
  let closed = false;
  req.raw.on('close', () => {
    closed = true;
    cleanups.forEach((fn) => fn());
  });
  return {
    get closed() {
      return closed;
    },
    send(event: string, data: unknown, id?: number | null) {
      if (closed) return;
      // Contrapresión: a un cliente que no lee (pestaña dormida, red lenta) no se le acumula memoria sin límite.
      // Se le corta; EventSource reconecta solo y retoma desde el último evento que recibió (Last-Event-ID).
      if (raw.writableLength > MAX_SSE_BUFFER_BYTES) {
        raw.destroy();
        return;
      }
      raw.write(`${id != null ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    onClose(fn: () => void) {
      if (closed) fn();
      else cleanups.push(fn);
    },
  };
}

export function registerApi(app: FastifyInstance, ctx: AppContext, http: HttpCounters = new HttpCounters()): void {
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

  const originOf = (url: string): string | null => {
    try {
      return new URL(url).origin;
    } catch {
      return null;
    }
  };

  /**
   * Clave con la que probar una configuración sin guardar. La clave guardada de un proveedor solo se reutiliza
   * si la URL sigue apuntando al MISMO origen: de lo contrario, cualquiera que pudiera llamar a la API podría
   * hacer que el servidor enviase la clave a una URL de su elección.
   */
  function probeKey(input: { id?: string; baseUrl: string; apiKey?: string | null }): string | null | undefined {
    if (input.apiKey !== undefined) return input.apiKey;
    const saved = input.id ? store.getProviderWithSecret(input.id) : null;
    if (!saved?.apiKey) return undefined;
    if (originOf(saved.baseUrl) !== originOf(input.baseUrl)) {
      throw new HttpError(
        400,
        'Has cambiado la dirección del proveedor: vuelve a escribir la API key para probarla con la nueva dirección.',
        undefined,
        'api_key_required',
      );
    }
    return saved.apiKey;
  }

  /** Valida un workflow contra los agentes, las herramientas y los demás workflows (subworkflows y ciclos). */
  function workflowIssues(wf: Pick<Workflow, 'nodes' | 'edges'>, selfId: string | null = null) {
    return validateWorkflow(wf, {
      agentIds: store.listAgents().map((a) => a.id),
      toolNames: tools.names(),
      workflows: store.listWorkflows(),
      selfId,
    });
  }

  function assertAgentRefs(input: { providerId: string; tools: string[] }): void {
    if (!store.getProvider(input.providerId)) throw new HttpError(400, 'El proveedor seleccionado no existe.');
    const known = new Set(tools.list().map((t) => t.name));
    const unknown = input.tools.filter((t) => !known.has(t));
    if (unknown.length) throw new HttpError(400, `Herramientas desconocidas: ${unknown.join(', ')}.`);
  }

  // ---------- Sistema ----------
  const uptimeSec = () => Math.round((Date.now() - ctx.startedAt) / 1000);
  app.get('/api/health', async () => ({ ok: true, version: APP_VERSION, uptimeSec: uptimeSec() }));

  /** Sonda de vida: el proceso atiende peticiones. No toca la base de datos ni exige clave de acceso. */
  app.get('/api/health/live', async () => ({ ok: true, version: APP_VERSION, uptimeSec: uptimeSec() }));

  /** Sonda de disponibilidad: comprueba de verdad la base de datos, la carpeta de datos y el planificador. */
  app.get('/api/health/ready', async (_req, reply) => {
    const checks: Record<string, { ok: boolean; detail?: string }> = {};
    try {
      const version = Number((ctx.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
      checks.database =
        version === SCHEMA_VERSION ? { ok: true, detail: `esquema v${version}` } : { ok: false, detail: `esquema v${version}, se esperaba v${SCHEMA_VERSION}` };
    } catch (err) {
      checks.database = { ok: false, detail: errorMessage(err) };
    }
    try {
      await fsp.access(ctx.config.workspaceDir, fs.constants.W_OK);
      checks.dataDir = { ok: true };
    } catch (err) {
      checks.dataDir = { ok: false, detail: errorMessage(err) };
    }
    checks.scheduler = ctx.scheduler.running ? { ok: true } : { ok: false, detail: 'el temporizador de programaciones no está en marcha' };
    const ok = Object.values(checks).every((c) => c.ok);
    return reply
      .status(ok ? 200 : 503)
      .send({ ok, version: APP_VERSION, uptimeSec: uptimeSec(), activeRuns: runs.activeCount, queuedRuns: runs.queuedCount, checks });
  });

  /** Tamaño en disco de la base de datos y de su diario (0 si está en memoria). */
  const dbSize = (): number => {
    let bytes = 0;
    for (const suffix of ['', '-wal']) {
      try {
        bytes += fs.statSync(ctx.config.dbFile + suffix).size;
      } catch {
        /* en memoria o aún sin crear */
      }
    }
    return bytes;
  };

  /** Especificación OpenAPI 3.1 de esta API (la referencia legible está en docs/api.md). */
  const openApi = buildOpenApi(APP_VERSION);
  app.get('/api/openapi.json', async () => openApi);

  /** Métricas en el formato de texto de Prometheus. Exige la clave de acceso, como el resto de la API. */
  app.get('/api/metrics', async (_req, reply) => {
    const s = store.stats();
    return reply.type('text/plain; version=0.0.4; charset=utf-8').send(
      renderMetrics({
        version: APP_VERSION,
        nodeVersion: process.version,
        uptimeSec: uptimeSec(),
        schemaVersion: SCHEMA_VERSION,
        counts: { ...s.counts, tools: tools.list().filter((t) => t.enabled).length },
        runsByStatus: s.runsByStatus,
        activeRuns: runs.activeCount,
        queuedRuns: runs.queuedCount,
        llmCalls: s.llmCalls,
        toolCalls: s.toolCalls,
        tokens: s.tokens,
        memoryBytes: process.memoryUsage().rss,
        dbSizeBytes: dbSize(),
        schedulerRunning: ctx.scheduler.running,
        http: http.snapshot(),
      }),
    );
  });

  app.get('/api/stats', async (): Promise<DashboardStats> => {
    const s = store.stats();
    const dbSizeBytes = dbSize();
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

  /** Estado real de los aislamientos de run_javascript: red del proceso (comprobada) y motor de contenedores. */
  app.get('/api/sandbox/status', async (req) => sandboxStatus((req.query as { force?: string }).force === '1'));
  app.put('/api/settings', async (req) => {
    const patch = settingsSchema.parse(req.body);
    if (patch.codeSandbox === 'container') {
      const status = await sandboxStatus(true);
      if (!status.container.available) throw new HttpError(409, `No se puede usar el contenedor: ${status.container.error}`);
    }
    const settings = store.updateSettings(patch);
    // Un cambio en la retención se aplica en el momento, sin esperar a la siguiente pasada.
    ctx.applyRetention();
    return settings;
  });

  // ---------- Copias de seguridad ----------
  // Una copia subida llega como flujo de bytes: no se analiza ni se guarda en memoria.
  app.addContentTypeParser('application/octet-stream', (_req, _payload, done) => done(null));

  app.get('/api/backups', async (): Promise<BackupState> => ({
    backups: await listBackups(ctx.config),
    pending: pendingRestore(ctx.config),
    lastRestore: lastRestore(ctx.config),
  }));

  /** Crea una copia completa (base de datos, clave maestra y espacio de trabajo). No hace falta parar nada. */
  app.post('/api/backups', async (_req, reply) => {
    const backup = await createBackup(ctx.config, ctx.db, APP_VERSION);
    ctx.log.info({ backup: backup.name, bytes: backup.sizeBytes }, 'Copia de seguridad creada');
    return reply.status(201).send(backup);
  });

  app.post('/api/backups/upload', { bodyLimit: Number.MAX_SAFE_INTEGER }, async (req, reply) => {
    if (!String(req.headers['content-type'] ?? '').startsWith('application/octet-stream')) {
      throw new HttpError(415, 'Envía el archivo de la copia como application/octet-stream.');
    }
    return reply.status(201).send(await receiveBackup(ctx.config, req.raw));
  });

  app.get('/api/backups/:name/download', async (req, reply) => {
    const name = (req.params as { name: string }).name;
    const file = backupFile(ctx.config, name);
    return reply
      .header('Content-Type', 'application/octet-stream')
      .header('Content-Disposition', `attachment; filename="${name}"`)
      .header('Content-Length', fs.statSync(file).size)
      .send(fs.createReadStream(file));
  });

  app.delete('/api/backups/:name', async (req, reply) => {
    await deleteBackup(ctx.config, (req.params as { name: string }).name);
    return reply.status(204).send();
  });

  /** Valida la copia y la deja preparada: los datos se sustituyen en el próximo arranque del servidor. */
  app.post('/api/backups/:name/restore', async (req, reply) => {
    const pending = await prepareRestore(ctx.config, (req.params as { name: string }).name);
    ctx.log.warn({ backup: pending.name }, 'Restauración preparada: se aplicará al reiniciar el servidor');
    return reply.status(202).send(pending);
  });

  app.delete('/api/backups/restore/pending', async () => ({ cancelled: await cancelRestore(ctx.config) }));

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
          let r: ProviderTestResult;
          try {
            r = await testProvider(store.getProviderWithSecret(p.id)!);
          } catch (err) {
            // P. ej. una API key que ya no se puede descifrar: es el estado de ESE proveedor, no un error de la ruta.
            r = { ok: false, latencyMs: 0, error: errorMessage(err) };
          }
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
    const input = providerProbeSchema.parse(req.body);
    // Al editar, si no se envía una clave nueva se prueba con la guardada (solo hacia el mismo origen).
    return testProvider({ kind: input.kind, baseUrl: input.baseUrl, apiKey: probeKey(input) });
  });

  /** Lista los modelos de una configuración sin guardarla (para elegir el modelo por defecto al dar de alta). */
  app.post('/api/providers/models', async (req) => {
    const input = providerProbeSchema.parse(req.body);
    return ctx.llm.create({ kind: input.kind, baseUrl: input.baseUrl, apiKey: probeKey(input) }).listModels(AbortSignal.timeout(8000));
  });

  app.put('/api/providers/:id', async (req) => {
    healthCache = null;
    const input = providerSchema.parse(req.body);
    const current = store.getProvider(idOf(req)) ?? notFound('Proveedor');
    // La clave guardada no se «muda» a otra dirección: si cambia el origen hay que escribirla de nuevo (o quitarla).
    if (current.hasApiKey && input.apiKey === undefined && originOf(current.baseUrl) !== originOf(input.baseUrl)) {
      throw new HttpError(
        400,
        'Has cambiado la dirección del proveedor: vuelve a escribir la API key (o quítala) antes de guardar.',
        undefined,
        'api_key_required',
      );
    }
    return store.updateProvider(current.id, input) ?? notFound('Proveedor');
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

  // ---------- Servidores MCP ----------
  function assertMcpName(name: string, selfId?: string): void {
    if (store.listMcpServers().some((s) => s.name === name && s.id !== selfId)) throw new HttpError(409, `Ya existe un servidor MCP llamado «${name}».`);
  }

  app.get('/api/mcp/servers', async () => ctx.mcp.list());

  // Crear o editar espera al intento de conexión (acotado), para devolver ya si funciona y qué herramientas ofrece.
  app.post('/api/mcp/servers', async (req, reply) => {
    const input = mcpServerSchema.parse(req.body);
    assertMcpName(input.name);
    const server = store.createMcpServer(input);
    return reply.status(201).send(await ctx.mcp.sync(server.id));
  });

  app.put('/api/mcp/servers/:id', async (req) => {
    const input = mcpServerSchema.parse(req.body);
    assertMcpName(input.name, idOf(req));
    if (!store.updateMcpServer(idOf(req), input)) notFound('Servidor MCP');
    return ctx.mcp.sync(idOf(req));
  });

  app.delete('/api/mcp/servers/:id', async (req, reply) => {
    if (!store.deleteMcpServer(idOf(req))) notFound('Servidor MCP');
    await ctx.mcp.sync(idOf(req));
    return reply.status(204).send();
  });

  app.post('/api/mcp/servers/:id/reconnect', async (req) => (await ctx.mcp.reconnect(idOf(req))) ?? notFound('Servidor MCP'));

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
    // Se lee como mucho el tramo que se va a mostrar: un archivo enorme no se carga entero en memoria.
    const maxBytes = 500_000;
    const handle = await fsp.open(target, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(stat!.size, maxBytes));
      await handle.read(buffer, 0, buffer.length, 0);
      return { path: rel, sizeBytes: stat!.size, content: buffer.toString('utf8'), truncated: stat!.size > maxBytes };
    } finally {
      await handle.close();
    }
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
    // `id` (opcional): el workflow que se está editando, para detectar que se llame a sí mismo.
    const selfId = (req.body as { id?: unknown } | null)?.id;
    return { issues: workflowIssues(wf, typeof selfId === 'string' ? selfId : null) };
  });

  app.post('/api/workflows/:id/duplicate', async (req, reply) => {
    const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = store.getWorkflow(idOf(req)) ?? notFound('Workflow');
    return reply.status(201).send(store.createWorkflow({ ...rest, name: `${rest.name} (copia)` }));
  });

  app.delete('/api/workflows/:id', async (req, reply) => {
    const used = store.workflowsUsingWorkflow(idOf(req));
    if (used.length) {
      throw new HttpError(409, `No se puede eliminar: lo usan como subworkflow ${used.map((w) => `«${w.name}»`).join(', ')}.`);
    }
    if (!store.deleteWorkflow(idOf(req))) notFound('Workflow');
    return reply.status(204).send();
  });

  // ---------- Exportación e importación ----------
  /** Workflow como archivo portable: su definición más los agentes que usa (sin proveedor ni claves). */
  // ---------- Exportar e importar ----------
  app.get('/api/workflows/:id/export', async (req): Promise<WorkflowExport> => exportWorkflow(store, store.getWorkflow(idOf(req)) ?? notFound('Workflow')));
  app.get('/api/agents/:id/export', async (req): Promise<AgentExport> => exportAgent(store, store.getAgent(idOf(req)) ?? notFound('Agente')));

  /** Valida un archivo exportado, sea de workflow o de agentes. */
  function parseBundle(raw: unknown): ExportBundle {
    const format = (raw as { format?: unknown } | null)?.format;
    if (format === WORKFLOW_EXPORT_FORMAT) return workflowImportSchema.parse(raw) as ExportBundle;
    if (format === AGENT_EXPORT_FORMAT) return agentImportSchema.parse(raw) as ExportBundle;
    throw new HttpError(400, 'El archivo no es un workflow ni un agente exportado de AgentForge.');
  }
  const importDeps = { store, tools };

  /** Primer paso de una importación: qué trae el archivo y cómo encaja con lo que ya hay. No cambia nada. */
  app.post('/api/import/plan', async (req): Promise<ImportPlan> => planImport(importDeps, parseBundle((req.body as { bundle?: unknown } | null)?.bundle)));

  /** Segundo paso: aplica la importación con las decisiones tomadas (las que falten, las recomendadas). Es atómica. */
  app.post('/api/import', async (req, reply): Promise<ImportResult> => {
    const body = (req.body ?? {}) as { bundle?: unknown; decisions?: unknown };
    const result = applyImport(importDeps, parseBundle(body.bundle), importDecisionsSchema.parse(body.decisions));
    return reply.status(201).send(result);
  });

  /** Importa un workflow exportado con las acciones recomendadas, sin revisión previa (compatibilidad y automatización). */
  app.post('/api/workflows/import', async (req, reply): Promise<WorkflowImportResult> => {
    const result = applyImport(importDeps, workflowImportSchema.parse(req.body) as ExportBundle);
    return reply.status(201).send(result as WorkflowImportResult);
  });

  // ---------- Disparadores ----------
  const newWebhookSecret = (): string => `whsec_${randomBytes(24).toString('base64url')}`;
  /** Siguiente ocasión de un disparador recién guardado: se cuenta desde ahora; desactivado o webhook, ninguna. */
  const firstOccurrence = (input: TriggerInput): string | null => (input.enabled ? (nextOccurrence(input, new Date())?.toISOString() ?? null) : null);

  app.get('/api/triggers', async () => store.listTriggers());

  app.get('/api/workflows/:id/triggers', async (req) => {
    if (!store.getWorkflow(idOf(req))) notFound('Workflow');
    return store.listTriggers(idOf(req));
  });

  /** Próximas ocasiones de un horario sin guardarlo (para enseñarlas en el formulario). */
  app.post('/api/triggers/preview', async (req): Promise<TriggerPreview> => {
    const input = triggerSchema.parse(req.body);
    return { timezone: input.timezone ?? systemTimeZone(), next: upcomingOccurrences(input, new Date(), 5).map((d) => d.toISOString()) };
  });

  app.post('/api/workflows/:id/triggers', async (req, reply) => {
    const workflow = store.getWorkflow(idOf(req)) ?? notFound('Workflow');
    const input = triggerSchema.parse(req.body);
    if (store.listTriggers(workflow.id).length >= MAX_TRIGGERS_PER_WORKFLOW) {
      throw new HttpError(409, `Un workflow admite como máximo ${MAX_TRIGGERS_PER_WORKFLOW} disparadores.`);
    }
    // El secreto de un webhook se genera aquí y solo se devuelve en esta respuesta.
    const secret = input.kind === 'webhook' ? newWebhookSecret() : undefined;
    const trigger: TriggerWithSecret = store.createTrigger(workflow.id, input, firstOccurrence(input), secret);
    return reply.status(201).send(secret ? { ...trigger, secret } : trigger);
  });

  app.put('/api/triggers/:id', async (req) => {
    const existing = store.getTrigger(idOf(req)) ?? notFound('Disparador');
    const input = triggerSchema.parse(req.body);
    if ((existing.kind === 'webhook') !== (input.kind === 'webhook')) {
      throw new HttpError(400, 'Un webhook no se puede convertir en un disparador con horario, ni al revés. Crea uno nuevo.');
    }
    return store.updateTrigger(existing.id, input, firstOccurrence(input));
  });

  app.delete('/api/triggers/:id', async (req, reply) => {
    if (!store.deleteTrigger(idOf(req))) notFound('Disparador');
    return reply.status(204).send();
  });

  /** Lanza ahora el disparador, con su entrada guardada (para probarlo sin esperar a la hora). */
  app.post('/api/triggers/:id/run', async (req, reply) => {
    const trigger = store.getTrigger(idOf(req)) ?? notFound('Disparador');
    try {
      return reply.status(202).send(ctx.scheduler.fire(trigger));
    } catch (err) {
      throw new HttpError(422, errorMessage(err));
    }
  });

  /** Cambia el secreto de un webhook: el anterior deja de valer y el nuevo solo se devuelve aquí. */
  app.post('/api/triggers/:id/secret', async (req): Promise<TriggerWithSecret> => {
    const trigger = store.getTrigger(idOf(req)) ?? notFound('Disparador');
    if (trigger.kind !== 'webhook') throw new HttpError(400, 'Solo los webhooks tienen secreto.');
    const secret = newWebhookSecret();
    store.setTriggerSecret(trigger.id, secret);
    return { ...store.getTrigger(trigger.id)!, secret };
  });

  // Receptor de webhooks. No exige la clave de acceso de la interfaz (quien llama es otro programa): se
  // autentica con el secreto del disparador, enviado tal cual o como firma HMAC del cuerpo. El cuerpo se lee
  // en bruto, sea del tipo que sea, porque la firma se calcula sobre los bytes exactos.
  void app.register(async (hooks) => {
    hooks.removeAllContentTypeParsers();
    hooks.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: 1024 * 1024 }, (_req, body, done) => done(null, body));
    const digest = (value: string | Buffer): Buffer => createHash('sha256').update(value).digest();
    const same = (a: string, b: string): boolean => timingSafeEqual(digest(a), digest(b));

    hooks.post('/api/hooks/:id', async (req, reply) => {
      const trigger: Trigger | null = store.getTrigger(idOf(req));
      const secret = trigger?.kind === 'webhook' ? store.getTriggerSecret(trigger.id) : null;
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const header = (name: string): string => {
        const value = req.headers[name];
        return typeof value === 'string' ? value.trim() : '';
      };
      const signature = header('x-agentforge-signature')
        .replace(/^sha256=/i, '')
        .toLowerCase();
      const plain = header('x-agentforge-secret') || header('authorization').replace(/^Bearer\s+/i, '');
      // Se comprueba siempre contra algo (aunque el webhook no exista) para no revelar cuáles existen por el tiempo de respuesta.
      const expected = secret ?? newWebhookSecret();
      const authorized = signature ? same(signature, createHmac('sha256', expected).update(body).digest('hex')) : same(plain, expected);
      if (!trigger || !secret || !authorized) {
        app.log.warn({ ip: req.ip, triggerId: idOf(req) }, 'Llamada a un webhook rechazada');
        throw new HttpError(401, 'Webhook desconocido o secreto incorrecto.');
      }
      if (!trigger.enabled) throw new HttpError(409, 'Este webhook está desactivado.');
      // Entrada: el campo «input» de un cuerpo JSON si lo hay; si no, el cuerpo como texto.
      let text = body.toString('utf8');
      try {
        const parsed = JSON.parse(text) as { input?: unknown } | null;
        if (parsed && typeof parsed === 'object' && typeof parsed.input === 'string') text = parsed.input;
      } catch {
        /* no es JSON: se usa el texto tal cual */
      }
      if (text.length > 100_000) throw new HttpError(413, 'El cuerpo es demasiado grande (máximo 100 000 caracteres).');
      const input = trigger.input.trim() ? trigger.input.replace(/\{\{\s*body\s*\}\}/g, () => text) : text;
      try {
        const run = ctx.scheduler.fire(trigger, input);
        return reply.status(202).send({ runId: run.id, status: run.status });
      } catch (err) {
        throw new HttpError(422, errorMessage(err));
      }
    });
  });

  app.post('/api/workflows/:id/run', async (req, reply) => {
    const workflow = store.getWorkflow(idOf(req)) ?? notFound('Workflow');
    const { input } = runInputSchema.parse(req.body);
    const issues = workflowIssues(workflow, workflow.id);
    const errors = issues.filter((i) => i.level === 'error');
    if (errors.length) throw new HttpError(422, `El workflow tiene errores: ${errors[0].message}`, { issues });
    return reply.status(202).send(runs.startWorkflowRun(workflow, input));
  });

  // ---------- Ejecuciones ----------
  app.get('/api/runs', async (req) => store.listRuns(runsQuerySchema.parse(req.query)));

  // Ejecuciones que un apagado dejó a medias: la interfaz ofrece reanudarlas o descartarlas al arrancar.
  app.get('/api/runs/interrupted', async () => store.listInterruptedRuns());

  /** Reanuda las ejecuciones interrumpidas indicadas (o todas) reutilizando los pasos que ya habían terminado. */
  app.post('/api/runs/interrupted/resume', async (req, reply) => {
    const { ids } = runIdsSchema.parse(req.body ?? {});
    const pending = store.listInterruptedRuns().filter((r) => !ids || ids.includes(r.id));
    const resumed = pending.map((summary) => runs.retryRun(store.getRun(summary.id)!, 'failed'));
    return reply.status(202).send(resumed);
  });

  /** Descarta el aviso de reanudación: las ejecuciones quedan como fallidas en el historial. */
  app.post('/api/runs/interrupted/dismiss', async (req) => {
    const { ids } = runIdsSchema.parse(req.body ?? {});
    return { dismissed: store.clearInterrupted(ids) };
  });

  app.get('/api/runs/:id', async (req) => store.getRun(idOf(req)) ?? notFound('Ejecución'));

  app.get('/api/runs/:id/events', async (req) => {
    if (!store.getRunSummary(idOf(req))) notFound('Ejecución');
    return store.listEvents(idOf(req), eventsQuerySchema.parse(req.query).after ?? 0);
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

  /** Subejecuciones que lanzó una ejecución (subworkflows), de la más antigua a la más reciente. */
  app.get('/api/runs/:id/children', async (req) => {
    if (!store.getRunSummary(idOf(req))) notFound('Ejecución');
    return store.listChildRuns(idOf(req));
  });

  /** Resultado de cada elemento de un nodo «para cada». */
  app.get('/api/runs/:id/steps/:nodeId/items', async (req) => {
    const { id, nodeId } = req.params as { id: string; nodeId: string };
    if (!store.getRunSummary(id)) notFound('Ejecución');
    return store.listStepItems(id, nodeId);
  });

  // ---------- Aprobaciones humanas ----------
  /** Aprobaciones pendientes (todas) o las de una ejecución (`?runId=`), con su decisión. */
  app.get('/api/approvals', async (req) => {
    const runId = (req.query as { runId?: string }).runId;
    return store.listApprovals(runId ? { runId } : { pendingOnly: true });
  });

  app.post('/api/approvals/:id/decide', async (req) => {
    const { approved, comment } = approvalDecisionSchema.parse(req.body);
    return runs.decideApproval(idOf(req), approved, comment);
  });

  /** Avisa cada vez que cambia el conjunto de aprobaciones pendientes. */
  app.get('/api/stream/approvals', async (req, reply) => {
    const sse = openSse(req, reply);
    const push = () => sse.send('approvals', store.listApprovals({ pendingOnly: true }));
    push();
    sse.onClose(runs.subscribeApprovals(push));
  });

  /** Eventos de una ejecución en tiempo real. Reproduce primero el historial (desde Last-Event-ID). */
  app.get('/api/runs/:id/stream', async (req, reply) => {
    const runId = idOf(req);
    if (!store.getRunSummary(runId)) notFound('Ejecución');
    const after = Number(req.headers['last-event-id'] ?? (req.query as { after?: string }).after ?? 0) || 0;
    const sse = openSse(req, reply);
    const send = (ev: RunEvent) => sse.send('run-event', ev, ev.seq);
    // El historial se reproduce por tandas, cediendo el control entre ellas: conectar a una ejecución con miles
    // de eventos no congela el servidor. La suscripción se abre ANTES y lo que llega mientras tanto se guarda,
    // para no perder nada; al terminar se entrega lo que no estuviera ya en el historial enviado.
    let replaying = true;
    const buffered: RunEvent[] = [];
    sse.onClose(runs.subscribe(runId, (ev) => (replaying ? buffered.push(ev) : send(ev))));
    let last = after;
    for (;;) {
      const batch = store.listEvents(runId, last, SSE_REPLAY_BATCH);
      for (const ev of batch) send(ev);
      if (batch.length) last = batch[batch.length - 1].seq!;
      if (batch.length < SSE_REPLAY_BATCH || sse.closed) break;
      await new Promise((resolve) => setImmediate(resolve));
    }
    for (const p of runs.partials(runId)) {
      send({ seq: null, runId, ts: new Date().toISOString(), type: 'llm.snapshot', nodeId: p.nodeId, data: { text: p.text } });
    }
    for (const ev of buffered) if (ev.seq === null || ev.seq > last) send(ev);
    replaying = false;
  });

  /** Cambios de estado de todas las ejecuciones (listas y dashboard en vivo). */
  app.get('/api/stream/runs', async (req, reply) => {
    const sse = openSse(req, reply);
    sse.onClose(runs.subscribeRuns((run) => sse.send('run', run)));
  });
}
