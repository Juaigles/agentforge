// Capa de persistencia: todos los accesos a SQLite pasan por aquí.
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import {
  DEFAULT_SETTINGS,
  DEFAULT_WORKFLOW_SETTINGS,
  ZERO_USAGE,
  type Agent,
  type AgentInput,
  type CustomTool,
  type CustomToolInput,
  type NodeType,
  type Provider,
  type ProviderInput,
  type Run,
  type RunEvent,
  type RunEventType,
  type RunKind,
  type RunSnapshot,
  type RunStatus,
  type RunStep,
  type RunSummary,
  type Settings,
  type StepStatus,
  type Usage,
  type Workflow,
  type WorkflowInput,
} from '../../../shared/types';
import type { SecretBox } from '../crypto/secrets';
import { newId, nowIso } from '../util';

type Row = Record<string, any>;

export interface ProviderWithSecret extends Provider {
  apiKey: string | null;
}

export interface RunFilter {
  status?: RunStatus;
  kind?: RunKind;
  workflowId?: string;
  agentId?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface RunPatch {
  status?: RunStatus;
  output?: string | null;
  error?: string | null;
  usage?: Usage;
  startedAt?: string | null;
  finishedAt?: string | null;
}

export interface StepPatch {
  status?: StepStatus;
  attempt?: number;
  input?: string | null;
  output?: string | null;
  error?: string | null;
  usage?: Usage;
  startedAt?: string | null;
  finishedAt?: string | null;
}

const RUN_COLUMNS: Record<keyof RunPatch, string> = {
  status: 'status',
  output: 'output',
  error: 'error',
  usage: 'usage',
  startedAt: 'started_at',
  finishedAt: 'finished_at',
};

const STEP_COLUMNS: Record<keyof StepPatch, string> = {
  status: 'status',
  attempt: 'attempt',
  input: 'input',
  output: 'output',
  error: 'error',
  usage: 'usage',
  startedAt: 'started_at',
  finishedAt: 'finished_at',
};

const RUN_SUMMARY_COLS =
  'id, kind, workflow_id, agent_id, name, status, input, output, error, usage, retry_of, interrupted, created_at, started_at, finished_at';

function toSql(value: unknown): SQLInputValue {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'object') return JSON.stringify(value);
  return value as SQLInputValue;
}

function parseJson<T>(text: unknown, fallback: T): T {
  if (typeof text !== 'string') return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export class Store {
  private readonly eventSeq = new Map<string, number>();

  constructor(
    readonly db: DatabaseSync,
    private readonly secrets: SecretBox,
  ) {}

  private all(sql: string, ...params: unknown[]): Row[] {
    return this.db.prepare(sql).all(...params.map(toSql)) as Row[];
  }
  private get(sql: string, ...params: unknown[]): Row | undefined {
    return this.db.prepare(sql).get(...params.map(toSql)) as Row | undefined;
  }
  private exec(sql: string, ...params: unknown[]): number {
    return Number(this.db.prepare(sql).run(...params.map(toSql)).changes);
  }

  /** Ejecuta `fn` dentro de una transacción. */
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // ---------- Proveedores ----------
  private mapProvider(r: Row): Provider {
    return {
      id: r.id,
      name: r.name,
      kind: r.kind,
      baseUrl: r.base_url,
      hasApiKey: Boolean(r.api_key_enc),
      defaultModel: r.default_model,
      enabled: Boolean(r.enabled),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  listProviders(): Provider[] {
    return this.all('SELECT * FROM providers ORDER BY created_at').map((r) => this.mapProvider(r));
  }

  getProvider(id: string): Provider | null {
    const r = this.get('SELECT * FROM providers WHERE id = ?', id);
    return r ? this.mapProvider(r) : null;
  }

  /** Solo para uso interno del motor: incluye la API key descifrada. */
  getProviderWithSecret(id: string): ProviderWithSecret | null {
    const r = this.get('SELECT * FROM providers WHERE id = ?', id);
    if (!r) return null;
    return { ...this.mapProvider(r), apiKey: r.api_key_enc ? this.secrets.decrypt(r.api_key_enc) : null };
  }

  createProvider(input: ProviderInput): Provider {
    const id = newId('prv');
    const now = nowIso();
    this.exec(
      'INSERT INTO providers (id, name, kind, base_url, api_key_enc, default_model, enabled, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
      id,
      input.name,
      input.kind,
      input.baseUrl,
      input.apiKey ? this.secrets.encrypt(input.apiKey) : null,
      input.defaultModel ?? '',
      input.enabled ?? true,
      now,
      now,
    );
    return this.getProvider(id)!;
  }

  updateProvider(id: string, input: ProviderInput): Provider | null {
    const existing = this.get('SELECT api_key_enc FROM providers WHERE id = ?', id);
    if (!existing) return null;
    const apiKeyEnc =
      input.apiKey === undefined ? existing.api_key_enc : input.apiKey ? this.secrets.encrypt(input.apiKey) : null;
    this.exec(
      'UPDATE providers SET name=?, kind=?, base_url=?, api_key_enc=?, default_model=?, enabled=?, updated_at=? WHERE id=?',
      input.name,
      input.kind,
      input.baseUrl,
      apiKeyEnc,
      input.defaultModel ?? '',
      input.enabled ?? true,
      nowIso(),
      id,
    );
    return this.getProvider(id);
  }

  deleteProvider(id: string): boolean {
    return this.exec('DELETE FROM providers WHERE id = ?', id) > 0;
  }

  // ---------- Agentes ----------
  private mapAgent(r: Row): Agent {
    return {
      id: r.id,
      name: r.name,
      role: r.role,
      description: r.description,
      color: r.color,
      providerId: r.provider_id,
      model: r.model,
      systemPrompt: r.system_prompt,
      temperature: r.temperature,
      maxTokens: r.max_tokens ?? null,
      maxIterations: r.max_iterations,
      tools: parseJson<string[]>(r.tools, []),
      thinking: Boolean(r.thinking),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  listAgents(): Agent[] {
    return this.all('SELECT * FROM agents ORDER BY created_at').map((r) => this.mapAgent(r));
  }

  getAgent(id: string): Agent | null {
    const r = this.get('SELECT * FROM agents WHERE id = ?', id);
    return r ? this.mapAgent(r) : null;
  }

  createAgent(input: AgentInput): Agent {
    const id = newId('agt');
    const now = nowIso();
    this.exec(
      `INSERT INTO agents (id, name, role, description, color, provider_id, model, system_prompt, temperature,
        max_tokens, max_iterations, tools, thinking, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      input.name,
      input.role,
      input.description,
      input.color,
      input.providerId,
      input.model,
      input.systemPrompt,
      input.temperature,
      input.maxTokens,
      input.maxIterations,
      input.tools,
      input.thinking,
      now,
      now,
    );
    return this.getAgent(id)!;
  }

  updateAgent(id: string, input: AgentInput): Agent | null {
    const changes = this.exec(
      `UPDATE agents SET name=?, role=?, description=?, color=?, provider_id=?, model=?, system_prompt=?,
        temperature=?, max_tokens=?, max_iterations=?, tools=?, thinking=?, updated_at=? WHERE id=?`,
      input.name,
      input.role,
      input.description,
      input.color,
      input.providerId,
      input.model,
      input.systemPrompt,
      input.temperature,
      input.maxTokens,
      input.maxIterations,
      input.tools,
      input.thinking,
      nowIso(),
      id,
    );
    return changes ? this.getAgent(id) : null;
  }

  deleteAgent(id: string): boolean {
    return this.exec('DELETE FROM agents WHERE id = ?', id) > 0;
  }

  countAgentsByProvider(providerId: string): number {
    return Number(this.get('SELECT COUNT(*) AS n FROM agents WHERE provider_id = ?', providerId)!.n);
  }

  // ---------- Herramientas personalizadas ----------
  private mapCustomTool(r: Row): CustomTool {
    const config = parseJson<Pick<CustomTool, 'method' | 'urlTemplate' | 'headers' | 'bodyTemplate'>>(r.config, {
      method: 'GET',
      urlTemplate: '',
      headers: {},
      bodyTemplate: '',
    });
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      parameters: parseJson(r.parameters, { type: 'object', properties: {} }),
      ...config,
      enabled: Boolean(r.enabled),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  listCustomTools(): CustomTool[] {
    return this.all('SELECT * FROM custom_tools ORDER BY name').map((r) => this.mapCustomTool(r));
  }

  getCustomTool(id: string): CustomTool | null {
    const r = this.get('SELECT * FROM custom_tools WHERE id = ?', id);
    return r ? this.mapCustomTool(r) : null;
  }

  getCustomToolByName(name: string): CustomTool | null {
    const r = this.get('SELECT * FROM custom_tools WHERE name = ?', name);
    return r ? this.mapCustomTool(r) : null;
  }

  createCustomTool(input: CustomToolInput): CustomTool {
    const id = newId('tool');
    const now = nowIso();
    const { method, urlTemplate, headers, bodyTemplate } = input;
    this.exec(
      'INSERT INTO custom_tools (id, name, description, parameters, config, enabled, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
      id,
      input.name,
      input.description,
      input.parameters,
      { method, urlTemplate, headers, bodyTemplate },
      input.enabled,
      now,
      now,
    );
    return this.getCustomTool(id)!;
  }

  updateCustomTool(id: string, input: CustomToolInput): CustomTool | null {
    const { method, urlTemplate, headers, bodyTemplate } = input;
    const changes = this.exec(
      'UPDATE custom_tools SET name=?, description=?, parameters=?, config=?, enabled=?, updated_at=? WHERE id=?',
      input.name,
      input.description,
      input.parameters,
      { method, urlTemplate, headers, bodyTemplate },
      input.enabled,
      nowIso(),
      id,
    );
    return changes ? this.getCustomTool(id) : null;
  }

  deleteCustomTool(id: string): boolean {
    return this.exec('DELETE FROM custom_tools WHERE id = ?', id) > 0;
  }

  // ---------- Workflows ----------
  private mapWorkflow(r: Row): Workflow {
    const def = parseJson<Partial<Workflow>>(r.definition, {});
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      nodes: def.nodes ?? [],
      edges: def.edges ?? [],
      settings: { ...DEFAULT_WORKFLOW_SETTINGS, ...(def.settings ?? {}) },
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  listWorkflows(): Workflow[] {
    return this.all('SELECT * FROM workflows ORDER BY created_at').map((r) => this.mapWorkflow(r));
  }

  getWorkflow(id: string): Workflow | null {
    const r = this.get('SELECT * FROM workflows WHERE id = ?', id);
    return r ? this.mapWorkflow(r) : null;
  }

  createWorkflow(input: WorkflowInput): Workflow {
    const id = newId('wf');
    const now = nowIso();
    this.exec(
      'INSERT INTO workflows (id, name, description, definition, created_at, updated_at) VALUES (?,?,?,?,?,?)',
      id,
      input.name,
      input.description,
      { nodes: input.nodes, edges: input.edges, settings: input.settings },
      now,
      now,
    );
    return this.getWorkflow(id)!;
  }

  updateWorkflow(id: string, input: WorkflowInput): Workflow | null {
    const changes = this.exec(
      'UPDATE workflows SET name=?, description=?, definition=?, updated_at=? WHERE id=?',
      input.name,
      input.description,
      { nodes: input.nodes, edges: input.edges, settings: input.settings },
      nowIso(),
      id,
    );
    return changes ? this.getWorkflow(id) : null;
  }

  deleteWorkflow(id: string): boolean {
    return this.exec('DELETE FROM workflows WHERE id = ?', id) > 0;
  }

  /** Workflows que usan un agente en alguno de sus nodos. */
  workflowsUsingAgent(agentId: string): Workflow[] {
    return this.listWorkflows().filter((w) => w.nodes.some((n) => n.type === 'agent' && n.config?.agentId === agentId));
  }

  // ---------- Ejecuciones ----------
  private mapRunSummary(r: Row): RunSummary {
    return {
      id: r.id,
      kind: r.kind,
      workflowId: r.workflow_id ?? null,
      agentId: r.agent_id ?? null,
      name: r.name,
      status: r.status,
      input: r.input,
      output: r.output ?? null,
      error: r.error ?? null,
      usage: parseJson<Usage>(r.usage, { ...ZERO_USAGE }),
      retryOf: r.retry_of ?? null,
      interrupted: Boolean(r.interrupted),
      createdAt: r.created_at,
      startedAt: r.started_at ?? null,
      finishedAt: r.finished_at ?? null,
    };
  }

  private mapStep(r: Row): RunStep {
    return {
      runId: r.run_id,
      nodeId: r.node_id,
      nodeType: r.node_type,
      label: r.label,
      agentId: r.agent_id ?? null,
      status: r.status,
      attempt: r.attempt,
      input: r.input ?? null,
      output: r.output ?? null,
      error: r.error ?? null,
      usage: parseJson<Usage>(r.usage, { ...ZERO_USAGE }),
      startedAt: r.started_at ?? null,
      finishedAt: r.finished_at ?? null,
    };
  }

  createRun(input: {
    kind: RunKind;
    workflowId: string | null;
    agentId: string | null;
    name: string;
    input: string;
    snapshot: RunSnapshot;
    retryOf?: string | null;
    steps: Array<{ nodeId: string; nodeType: NodeType; label: string; agentId: string | null }>;
  }): Run {
    const id = newId('run');
    const now = nowIso();
    this.transaction(() => {
      this.exec(
        `INSERT INTO runs (id, kind, workflow_id, agent_id, name, status, input, snapshot, usage, retry_of, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        id,
        input.kind,
        input.workflowId,
        input.agentId,
        input.name,
        'queued',
        input.input,
        input.snapshot,
        ZERO_USAGE,
        input.retryOf ?? null,
        now,
      );
      input.steps.forEach((s, i) => {
        this.exec(
          'INSERT INTO run_steps (run_id, node_id, position, node_type, label, agent_id, status, usage) VALUES (?,?,?,?,?,?,?,?)',
          id,
          s.nodeId,
          i,
          s.nodeType,
          s.label,
          s.agentId,
          'pending',
          ZERO_USAGE,
        );
      });
    });
    return this.getRun(id)!;
  }

  getRunSummary(id: string): RunSummary | null {
    const r = this.get(`SELECT ${RUN_SUMMARY_COLS} FROM runs WHERE id = ?`, id);
    return r ? this.mapRunSummary(r) : null;
  }

  getRun(id: string): Run | null {
    const r = this.get('SELECT * FROM runs WHERE id = ?', id);
    if (!r) return null;
    return {
      ...this.mapRunSummary(r),
      snapshot: parseJson<RunSnapshot>(r.snapshot, {
        workflow: { nodes: [], edges: [], settings: DEFAULT_WORKFLOW_SETTINGS },
        agents: {},
      }),
      steps: this.listSteps(id),
    };
  }

  listSteps(runId: string): RunStep[] {
    return this.all('SELECT * FROM run_steps WHERE run_id = ? ORDER BY position', runId).map((r) => this.mapStep(r));
  }

  listRuns(filter: RunFilter = {}): { items: RunSummary[]; total: number } {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.status) (where.push('status = ?'), params.push(filter.status));
    if (filter.kind) (where.push('kind = ?'), params.push(filter.kind));
    if (filter.workflowId) (where.push('workflow_id = ?'), params.push(filter.workflowId));
    if (filter.agentId) (where.push('agent_id = ?'), params.push(filter.agentId));
    if (filter.search) {
      where.push('(name LIKE ? OR input LIKE ?)');
      params.push(`%${filter.search}%`, `%${filter.search}%`);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = Number(this.get(`SELECT COUNT(*) AS n FROM runs ${clause}`, ...params)!.n);
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const offset = Math.max(filter.offset ?? 0, 0);
    const items = this.all(
      `SELECT ${RUN_SUMMARY_COLS} FROM runs ${clause} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      ...params,
      limit,
      offset,
    ).map((r) => this.mapRunSummary(r));
    return { items, total };
  }

  updateRun(id: string, patch: RunPatch): void {
    const keys = Object.keys(patch) as Array<keyof RunPatch>;
    if (!keys.length) return;
    const sets = keys.map((k) => `${RUN_COLUMNS[k]} = ?`).join(', ');
    this.exec(`UPDATE runs SET ${sets} WHERE id = ?`, ...keys.map((k) => patch[k]), id);
  }

  updateStep(runId: string, nodeId: string, patch: StepPatch): void {
    const keys = Object.keys(patch) as Array<keyof StepPatch>;
    if (!keys.length) return;
    const sets = keys.map((k) => `${STEP_COLUMNS[k]} = ?`).join(', ');
    this.exec(`UPDATE run_steps SET ${sets} WHERE run_id = ? AND node_id = ?`, ...keys.map((k) => patch[k]), runId, nodeId);
  }

  deleteRun(id: string): boolean {
    this.eventSeq.delete(id);
    return this.exec('DELETE FROM runs WHERE id = ?', id) > 0;
  }

  /** Borra todas las ejecuciones terminadas. Devuelve cuántas se han borrado. */
  deleteFinishedRuns(): number {
    return this.exec("DELETE FROM runs WHERE status IN ('completed','failed','cancelled')");
  }

  /** Al arrancar: las ejecuciones que quedaron a medias por un apagado se marcan como fallidas. */
  markInterruptedRuns(): number {
    const now = nowIso();
    const stale = this.all("SELECT id FROM runs WHERE status IN ('queued','running')");
    for (const { id } of stale) {
      this.exec(
        "UPDATE run_steps SET status='cancelled', finished_at=? WHERE run_id=? AND status IN ('pending','running')",
        now,
        id,
      );
      this.exec(
        "UPDATE runs SET status='failed', error=?, finished_at=?, interrupted=1 WHERE id=?",
        'Ejecución interrumpida por un reinicio del servidor.',
        now,
        id,
      );
      this.appendEvent(id, 'run.finished', null, {
        status: 'failed',
        error: 'Ejecución interrumpida por un reinicio del servidor.',
      });
    }
    return stale.length;
  }

  /** Ejecuciones interrumpidas por un apagado que siguen pendientes de reanudar o descartar. */
  listInterruptedRuns(): RunSummary[] {
    return this.all(`SELECT ${RUN_SUMMARY_COLS} FROM runs WHERE interrupted = 1 ORDER BY created_at DESC, id DESC`).map((r) => this.mapRunSummary(r));
  }

  /** Da por atendidas las ejecuciones interrumpidas indicadas (o todas). Devuelve cuántas. */
  clearInterrupted(ids?: string[]): number {
    if (!ids) return this.exec('UPDATE runs SET interrupted = 0 WHERE interrupted = 1');
    let changed = 0;
    for (const id of ids) changed += this.exec('UPDATE runs SET interrupted = 0 WHERE id = ? AND interrupted = 1', id);
    return changed;
  }

  /**
   * Retención del historial: borra las ejecuciones terminadas (con sus pasos y eventos) más antiguas que
   * `days` días y, si se supera `maxRuns`, las más antiguas que sobren. Las que están en curso o pendientes
   * de reanudar no se tocan. Devuelve cuántas se han borrado.
   */
  pruneRuns(policy: { days: number; maxRuns: number }, now = Date.now()): number {
    const finished = "status IN ('completed','failed','cancelled') AND interrupted = 0";
    let deleted = 0;
    if (policy.days > 0) {
      const cutoff = new Date(now - policy.days * 86_400_000).toISOString();
      deleted += this.exec(`DELETE FROM runs WHERE ${finished} AND COALESCE(finished_at, created_at) < ?`, cutoff);
    }
    if (policy.maxRuns > 0) {
      deleted += this.exec(
        `DELETE FROM runs WHERE ${finished} AND id NOT IN (
           SELECT id FROM runs WHERE ${finished} ORDER BY COALESCE(finished_at, created_at) DESC, id DESC LIMIT ?
         )`,
        policy.maxRuns,
      );
    }
    return deleted;
  }

  // ---------- Eventos ----------
  appendEvent(runId: string, type: RunEventType, nodeId: string | null, data: Record<string, any>): RunEvent {
    let last = this.eventSeq.get(runId);
    if (last === undefined) {
      last = Number(this.get('SELECT COALESCE(MAX(seq), 0) AS s FROM run_events WHERE run_id = ?', runId)!.s);
    }
    const seq = last + 1;
    this.eventSeq.set(runId, seq);
    const ts = nowIso();
    this.exec(
      'INSERT INTO run_events (run_id, seq, ts, type, node_id, data) VALUES (?,?,?,?,?,?)',
      runId,
      seq,
      ts,
      type,
      nodeId,
      data,
    );
    return { seq, runId, ts, type, nodeId, data };
  }

  listEvents(runId: string, afterSeq = 0): RunEvent[] {
    return this.all('SELECT * FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq', runId, afterSeq).map((r) => ({
      seq: r.seq,
      runId: r.run_id,
      ts: r.ts,
      type: r.type,
      nodeId: r.node_id ?? null,
      data: parseJson<Record<string, any>>(r.data, {}),
    }));
  }

  /** Libera el contador de secuencia en memoria cuando una ejecución termina. */
  releaseRun(runId: string): void {
    this.eventSeq.delete(runId);
  }

  // ---------- Ajustes ----------
  getSettings(): Settings {
    const stored: Record<string, unknown> = {};
    for (const r of this.all('SELECT key, value FROM settings')) stored[r.key] = parseJson(r.value, undefined);
    return { ...DEFAULT_SETTINGS, ...stored } as Settings;
  }

  updateSettings(patch: Partial<Settings>): Settings {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      this.exec(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        key,
        JSON.stringify(value),
      );
    }
    return this.getSettings();
  }

  // ---------- Estadísticas ----------
  stats(days = 14) {
    const count = (table: string) => Number(this.get(`SELECT COUNT(*) AS n FROM ${table}`)!.n);
    const runsByStatus: Record<RunStatus, number> = { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 };
    for (const r of this.all('SELECT status, COUNT(*) AS n FROM runs GROUP BY status')) {
      runsByStatus[r.status as RunStatus] = Number(r.n);
    }
    const totals = this.get(
      `SELECT COALESCE(SUM(json_extract(usage,'$.promptTokens')),0) AS p,
              COALESCE(SUM(json_extract(usage,'$.completionTokens')),0) AS c,
              COALESCE(SUM(json_extract(usage,'$.llmCalls')),0) AS l,
              COALESCE(SUM(json_extract(usage,'$.toolCalls')),0) AS t
       FROM runs`,
    )!;
    const avg = this.get(
      `SELECT AVG((julianday(finished_at) - julianday(started_at)) * 86400000.0) AS ms
       FROM runs WHERE status = 'completed' AND started_at IS NOT NULL AND finished_at IS NOT NULL`,
    )!;

    const since = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
    const dailyMap = new Map<string, { date: string; completed: number; failed: number; cancelled: number }>();
    for (let i = days - 1; i >= 0; i--) {
      const date = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
      dailyMap.set(date, { date, completed: 0, failed: 0, cancelled: 0 });
    }
    for (const r of this.all(
      `SELECT substr(created_at, 1, 10) AS d, status, COUNT(*) AS n FROM runs
       WHERE substr(created_at, 1, 10) >= ? AND status IN ('completed','failed','cancelled') GROUP BY d, status`,
      since,
    )) {
      const day = dailyMap.get(r.d);
      if (day) day[r.status as 'completed' | 'failed' | 'cancelled'] = Number(r.n);
    }

    const topAgents = this.all(
      `SELECT s.agent_id AS id, COALESCE(a.name, '(eliminado)') AS name, COUNT(*) AS steps,
              COALESCE(SUM(json_extract(s.usage,'$.completionTokens')),0) AS tokens
       FROM run_steps s LEFT JOIN agents a ON a.id = s.agent_id
       WHERE s.agent_id IS NOT NULL AND s.status IN ('completed','failed')
       GROUP BY s.agent_id ORDER BY steps DESC LIMIT 5`,
    ).map((r) => ({ agentId: r.id, name: r.name, steps: Number(r.steps), completionTokens: Number(r.tokens) }));

    const topTools = this.all(
      `SELECT json_extract(data,'$.name') AS name, COUNT(*) AS calls FROM run_events
       WHERE type = 'tool.call' GROUP BY name ORDER BY calls DESC LIMIT 6`,
    ).map((r) => ({ name: String(r.name), calls: Number(r.calls) }));

    const finished = runsByStatus.completed + runsByStatus.failed;
    return {
      counts: {
        agents: count('agents'),
        workflows: count('workflows'),
        providers: count('providers'),
        customTools: count('custom_tools'),
        runs: count('runs'),
      },
      runsByStatus,
      successRate: finished ? runsByStatus.completed / finished : null,
      avgDurationMs: avg.ms === null || avg.ms === undefined ? null : Math.round(Number(avg.ms)),
      tokens: { prompt: Number(totals.p), completion: Number(totals.c) },
      llmCalls: Number(totals.l),
      toolCalls: Number(totals.t),
      daily: [...dailyMap.values()],
      topAgents,
      topTools,
    };
  }
}
