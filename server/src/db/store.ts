// Capa de persistencia: todos los accesos a SQLite pasan por aquí.
import type { DatabaseSync, SQLInputValue, StatementSync } from 'node:sqlite';
import {
  DEFAULT_SETTINGS,
  DEFAULT_WORKFLOW_SETTINGS,
  ZERO_USAGE,
  type Agent,
  type AgentInput,
  type Approval,
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
  type RunStepItem,
  type RunSummary,
  type McpServerInput,
  type McpTransport,
  type Trigger,
  type TriggerInput,
  type TriggerKind,
  type Settings,
  type StepStatus,
  type Usage,
  type Workflow,
  type WorkflowInput,
} from '../../../shared/types';
import { nodeSubworkflowId, nodeUsesAgent } from '../../../shared/graph';
import { isSecretHeaderName } from '../../../shared/types';
import type { SecretBox } from '../crypto/secrets';
import { ConfigError } from '../errors';
import { localDate, newId, nowIso } from '../util';

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
  partialOutput?: string | null;
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
  partialOutput: 'partial_output',
};

/** Caracteres de la entrada y del resultado que viajan en un resumen (las listas solo pintan una línea). */
export const SUMMARY_PREVIEW_CHARS = 300;

// Los resúmenes llevan solo el principio de la entrada, el resultado y el error: una lista de 200 ejecuciones
// con salidas grandes no debe transportar megabytes que nadie va a leer. El texto completo está en getRun().
const RUN_SUMMARY_COLS = `id, kind, workflow_id, agent_id, name, status, substr(input, 1, ${SUMMARY_PREVIEW_CHARS}) AS input,
  substr(output, 1, ${SUMMARY_PREVIEW_CHARS}) AS output, substr(error, 1, 1000) AS error, usage, retry_of, interrupted, scheduled, trigger_kind,
  parent_run_id, parent_node_id, created_at, started_at, finished_at`;

/** Valores de `runs.interrupted`: pendiente de que el usuario decida, o que se reanuda sola al arrancar. */
export const INTERRUPTED = { no: 0, pending: 1, autoResume: 2 } as const;

/** Coincidencias más recientes que examina una búsqueda de texto (ver listRuns). */
export const SEARCH_WINDOW = 2000;

/** Campos que ya están guardados en otra tabla y no se repiten en el evento persistido (ver appendEvent). */
const EVENT_FIELDS_NOT_PERSISTED: Partial<Record<RunEventType, string[]>> = {
  'step.finished': ['output'],
  'step.reused': ['output'],
  'run.finished': ['output'],
};

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

/** Configuración de una herramienta HTTP tal como se guarda: las cabeceras secretas, cifradas y aparte. */
interface StoredToolConfig {
  method: CustomTool['method'];
  urlTemplate: string;
  headers: Record<string, string>;
  secretHeaders?: Record<string, string>;
  bodyTemplate: string;
}

/** Servidor MCP tal como se guarda: con los valores secretos (variables y cabeceras) descifrados. */
export interface StoredMcpServer {
  id: string;
  name: string;
  transport: McpTransport;
  command: string;
  args: string[];
  env: Record<string, string>;
  url: string;
  headers: Record<string, string>;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export class Store {
  private readonly eventSeq = new Map<string, number>();
  /** Sentencias ya preparadas, por su texto: el almacén repite siempre las mismas pocas consultas. */
  private readonly statements = new Map<string, StatementSync>();

  constructor(
    readonly db: DatabaseSync,
    private readonly secrets: SecretBox,
  ) {}

  private prepare(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      // Las consultas con columnas variables (UPDATE parciales) son pocas, pero se acota por si acaso.
      if (this.statements.size < 500) this.statements.set(sql, statement);
    }
    return statement;
  }
  private all(sql: string, ...params: unknown[]): Row[] {
    return this.prepare(sql).all(...params.map(toSql)) as Row[];
  }
  private get(sql: string, ...params: unknown[]): Row | undefined {
    return this.prepare(sql).get(...params.map(toSql)) as Row | undefined;
  }
  private exec(sql: string, ...params: unknown[]): number {
    return Number(this.prepare(sql).run(...params.map(toSql)).changes);
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
    let apiKey: string | null = null;
    if (r.api_key_enc) {
      try {
        apiKey = this.secrets.decrypt(r.api_key_enc);
      } catch {
        // La clave maestra (secret.key) no es la que cifró este secreto: se perdió, se cambió o se restauró otra.
        throw new ConfigError(`No se pudo descifrar la API key de «${r.name}». Vuelve a introducirla en Ajustes → Proveedores.`);
      }
    }
    return { ...this.mapProvider(r), apiKey };
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
  /**
   * `reveal` devuelve también el valor de las cabeceras secretas (solo para ejecutar la herramienta); sin él
   * llegan vacías. Una fila antigua con credenciales en claro se trata igual: sus valores tampoco se devuelven.
   */
  private mapCustomTool(r: Row, reveal = false): CustomTool {
    const config = parseJson<StoredToolConfig>(r.config, { method: 'GET', urlTemplate: '', headers: {}, bodyTemplate: '' });
    const headers: Record<string, string> = {};
    const secretHeaders: string[] = [];
    for (const [name, value] of Object.entries(config.headers ?? {})) {
      if (isSecretHeaderName(name) && value) {
        secretHeaders.push(name);
        headers[name] = reveal ? value : '';
      } else headers[name] = value;
    }
    for (const [name, encrypted] of Object.entries(config.secretHeaders ?? {})) {
      secretHeaders.push(name);
      let value = '';
      if (reveal) {
        try {
          value = this.secrets.decrypt(encrypted);
        } catch {
          // Clave maestra distinta de la que cifró el valor: la herramienta se ejecuta sin esa cabecera.
          value = '';
        }
      }
      headers[name] = value;
    }
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      parameters: parseJson(r.parameters, { type: 'object', properties: {} }),
      method: config.method,
      urlTemplate: config.urlTemplate,
      headers,
      secretHeaders,
      bodyTemplate: config.bodyTemplate,
      enabled: Boolean(r.enabled),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  /** Separa las cabeceras en claras y secretas (cifradas). Una secreta vacía conserva la que ya había guardada. */
  private toolConfig(input: CustomToolInput, previous?: StoredToolConfig): StoredToolConfig {
    const headers: Record<string, string> = {};
    const secretHeaders: Record<string, string> = {};
    for (const [name, value] of Object.entries(input.headers ?? {})) {
      if (!isSecretHeaderName(name)) headers[name] = value;
      else if (value) secretHeaders[name] = this.secrets.encrypt(value);
      else if (previous?.secretHeaders?.[name]) secretHeaders[name] = previous.secretHeaders[name];
      else if (previous?.headers?.[name]) secretHeaders[name] = this.secrets.encrypt(previous.headers[name]);
      else headers[name] = '';
    }
    return { method: input.method, urlTemplate: input.urlTemplate, headers, secretHeaders, bodyTemplate: input.bodyTemplate };
  }

  /** Cifra las credenciales que una versión anterior guardó en claro en las cabeceras. Devuelve cuántas herramientas toca. */
  encryptLegacyToolHeaders(): number {
    let changed = 0;
    for (const r of this.all('SELECT id, config FROM custom_tools')) {
      const config = parseJson<StoredToolConfig>(r.config, { method: 'GET', urlTemplate: '', headers: {}, bodyTemplate: '' });
      const legacy = Object.entries(config.headers ?? {}).filter(([name, value]) => isSecretHeaderName(name) && value);
      if (!legacy.length) continue;
      const secretHeaders = { ...(config.secretHeaders ?? {}) };
      const headers = { ...config.headers };
      for (const [name, value] of legacy) {
        secretHeaders[name] = this.secrets.encrypt(value);
        delete headers[name];
      }
      this.exec('UPDATE custom_tools SET config = ? WHERE id = ?', { ...config, headers, secretHeaders }, r.id);
      changed++;
    }
    return changed;
  }

  listCustomTools(): CustomTool[] {
    return this.all('SELECT * FROM custom_tools ORDER BY name').map((r) => this.mapCustomTool(r));
  }

  getCustomTool(id: string): CustomTool | null {
    const r = this.get('SELECT * FROM custom_tools WHERE id = ?', id);
    return r ? this.mapCustomTool(r) : null;
  }

  /** `reveal`: con el valor de las cabeceras secretas (para ejecutarla). */
  getCustomToolByName(name: string, reveal = false): CustomTool | null {
    const r = this.get('SELECT * FROM custom_tools WHERE name = ?', name);
    return r ? this.mapCustomTool(r, reveal) : null;
  }

  createCustomTool(input: CustomToolInput): CustomTool {
    const id = newId('tool');
    const now = nowIso();
    this.exec(
      'INSERT INTO custom_tools (id, name, description, parameters, config, enabled, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
      id,
      input.name,
      input.description,
      input.parameters,
      this.toolConfig(input),
      input.enabled,
      now,
      now,
    );
    return this.getCustomTool(id)!;
  }

  updateCustomTool(id: string, input: CustomToolInput): CustomTool | null {
    const previous = parseJson<StoredToolConfig | undefined>(this.get('SELECT config FROM custom_tools WHERE id = ?', id)?.config, undefined);
    const changes = this.exec(
      'UPDATE custom_tools SET name=?, description=?, parameters=?, config=?, enabled=?, updated_at=? WHERE id=?',
      input.name,
      input.description,
      input.parameters,
      this.toolConfig(input, previous),
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
    return this.listWorkflows().filter((w) => w.nodes.some((n) => nodeUsesAgent(n) && n.config?.agentId === agentId));
  }

  /** Workflows que lanzan otro como subworkflow. */
  workflowsUsingWorkflow(workflowId: string): Workflow[] {
    return this.listWorkflows().filter((w) => w.id !== workflowId && w.nodes.some((n) => nodeSubworkflowId(n) === workflowId));
  }

  // ---------- Disparadores ----------
  private mapTrigger(r: Row): Trigger {
    return {
      id: r.id,
      workflowId: r.workflow_id,
      kind: r.kind,
      name: r.name ?? '',
      intervalMinutes: r.interval_minutes ?? null,
      time: r.time ?? null,
      weekdays: parseJson<number[]>(r.weekdays, []),
      cron: r.cron ?? null,
      timezone: r.timezone ?? null,
      input: r.input,
      enabled: Boolean(r.enabled),
      nextRunAt: r.next_run_at ?? null,
      lastRunAt: r.last_run_at ?? null,
      lastRunId: r.last_run_id ?? null,
      lastError: r.last_error ?? null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  /** Todos los disparadores, o los de un workflow, del más antiguo al más reciente. */
  listTriggers(workflowId?: string): Trigger[] {
    const rows = workflowId
      ? this.all('SELECT * FROM triggers WHERE workflow_id = ? ORDER BY created_at, id', workflowId)
      : this.all('SELECT * FROM triggers ORDER BY workflow_id, created_at, id');
    return rows.map((r) => this.mapTrigger(r));
  }

  getTrigger(id: string): Trigger | null {
    const r = this.get('SELECT * FROM triggers WHERE id = ?', id);
    return r ? this.mapTrigger(r) : null;
  }

  private triggerColumns(input: TriggerInput): unknown[] {
    const timed = input.kind === 'daily' || input.kind === 'cron';
    return [
      input.kind,
      input.name,
      input.kind === 'interval' ? input.intervalMinutes : null,
      input.kind === 'daily' ? input.time : null,
      input.kind === 'daily' ? [...new Set(input.weekdays)].sort((a, b) => a - b) : [],
      input.kind === 'cron' ? input.cron : null,
      timed ? input.timezone : null,
      input.input,
      input.enabled,
    ];
  }

  /** `secret` solo tiene sentido en un webhook; se guarda cifrado. */
  createTrigger(workflowId: string, input: TriggerInput, nextRunAt: string | null, secret?: string): Trigger {
    const id = newId('trg');
    const now = nowIso();
    this.exec(
      `INSERT INTO triggers (id, workflow_id, kind, name, interval_minutes, time, weekdays, cron, timezone, input, enabled, next_run_at, secret_enc, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      workflowId,
      ...this.triggerColumns(input),
      nextRunAt,
      secret ? this.secrets.encrypt(secret) : null,
      now,
      now,
    );
    return this.getTrigger(id)!;
  }

  updateTrigger(id: string, input: TriggerInput, nextRunAt: string | null): Trigger | null {
    const changes = this.exec(
      `UPDATE triggers SET kind=?, name=?, interval_minutes=?, time=?, weekdays=?, cron=?, timezone=?, input=?, enabled=?, next_run_at=?, last_error=NULL, updated_at=?
       WHERE id=?`,
      ...this.triggerColumns(input),
      nextRunAt,
      nowIso(),
      id,
    );
    return changes ? this.getTrigger(id) : null;
  }

  updateTriggerState(id: string, patch: Partial<Pick<Trigger, 'nextRunAt' | 'lastRunAt' | 'lastRunId' | 'lastError'>>): void {
    const columns = { nextRunAt: 'next_run_at', lastRunAt: 'last_run_at', lastRunId: 'last_run_id', lastError: 'last_error' } as const;
    const keys = Object.keys(patch) as Array<keyof typeof columns>;
    if (!keys.length) return;
    this.exec(`UPDATE triggers SET ${keys.map((k) => `${columns[k]} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => patch[k]), id);
  }

  /** Secreto de un webhook (null si no tiene o no se puede descifrar con la clave actual). */
  getTriggerSecret(id: string): string | null {
    const r = this.get('SELECT secret_enc FROM triggers WHERE id = ?', id);
    if (!r?.secret_enc) return null;
    try {
      return this.secrets.decrypt(r.secret_enc);
    } catch {
      return null;
    }
  }

  setTriggerSecret(id: string, secret: string): void {
    this.exec('UPDATE triggers SET secret_enc = ?, updated_at = ? WHERE id = ?', this.secrets.encrypt(secret), nowIso(), id);
  }

  deleteTrigger(id: string): boolean {
    return this.exec('DELETE FROM triggers WHERE id = ?', id) > 0;
  }

  // ---------- Servidores MCP ----------
  private decryptMap(payload: string | null | undefined): Record<string, string> {
    if (!payload) return {};
    try {
      return parseJson<Record<string, string>>(this.secrets.decrypt(payload), {});
    } catch {
      return {};
    }
  }

  private mapMcpServer(r: Row): StoredMcpServer {
    return {
      id: r.id,
      name: r.name,
      transport: r.transport as McpTransport,
      command: r.command,
      args: parseJson<string[]>(r.args, []),
      env: this.decryptMap(r.env_enc),
      url: r.url,
      headers: this.decryptMap(r.headers_enc),
      enabled: Boolean(r.enabled),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  listMcpServers(): StoredMcpServer[] {
    return this.all('SELECT * FROM mcp_servers ORDER BY name').map((r) => this.mapMcpServer(r));
  }

  getMcpServer(id: string): StoredMcpServer | null {
    const r = this.get('SELECT * FROM mcp_servers WHERE id = ?', id);
    return r ? this.mapMcpServer(r) : null;
  }

  createMcpServer(input: McpServerInput): StoredMcpServer {
    const id = newId('mcp');
    const now = nowIso();
    this.exec(
      'INSERT INTO mcp_servers (id, name, transport, command, args, env_enc, url, headers_enc, enabled, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      id,
      input.name,
      input.transport,
      input.command,
      input.args,
      this.secrets.encrypt(JSON.stringify(input.env ?? {})),
      input.url,
      this.secrets.encrypt(JSON.stringify(input.headers ?? {})),
      input.enabled,
      now,
      now,
    );
    return this.getMcpServer(id)!;
  }

  /** `env` y `headers` omitidos conservan los valores guardados. */
  updateMcpServer(id: string, input: McpServerInput): StoredMcpServer | null {
    const existing = this.getMcpServer(id);
    if (!existing) return null;
    this.exec(
      'UPDATE mcp_servers SET name=?, transport=?, command=?, args=?, env_enc=?, url=?, headers_enc=?, enabled=?, updated_at=? WHERE id=?',
      input.name,
      input.transport,
      input.command,
      input.args,
      this.secrets.encrypt(JSON.stringify(input.env ?? existing.env)),
      input.url,
      this.secrets.encrypt(JSON.stringify(input.headers ?? existing.headers)),
      input.enabled,
      nowIso(),
      id,
    );
    return this.getMcpServer(id);
  }

  /** Última lista de herramientas conocida de un servidor MCP. */
  getMcpTools<T>(id: string): T[] {
    return parseJson<T[]>(this.get('SELECT tools_cache FROM mcp_servers WHERE id = ?', id)?.tools_cache, []);
  }

  setMcpTools(id: string, tools: unknown[]): void {
    this.exec('UPDATE mcp_servers SET tools_cache = ? WHERE id = ?', tools, id);
  }

  deleteMcpServer(id: string): boolean {
    return this.exec('DELETE FROM mcp_servers WHERE id = ?', id) > 0;
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
      scheduled: Boolean(r.scheduled),
      triggerKind: r.trigger_kind ?? null,
      parentRunId: r.parent_run_id ?? null,
      parentNodeId: r.parent_node_id ?? null,
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
      partialOutput: r.partial_output ?? null,
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
    scheduled?: boolean;
    triggerKind?: TriggerKind | null;
    /** Ejecución y nodo que la lanzan, si es un subworkflow. */
    parentRunId?: string | null;
    parentNodeId?: string | null;
    steps: Array<{ nodeId: string; nodeType: NodeType; label: string; agentId: string | null }>;
  }): Run {
    const id = newId('run');
    const now = nowIso();
    this.transaction(() => {
      this.exec(
        `INSERT INTO runs (id, kind, workflow_id, agent_id, name, status, input, snapshot, usage, retry_of, scheduled, trigger_kind, parent_run_id, parent_node_id, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
        Boolean(input.scheduled),
        input.triggerKind ?? null,
        input.parentRunId ?? null,
        input.parentNodeId ?? null,
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

  /**
   * Lista de ejecuciones, de la más reciente a la más antigua.
   *
   * Sin búsqueda, la página se localiza recorriendo solo un índice (estado, workflow, agente o fecha) y después
   * se leen las filas de esa página: una página profunda no obliga a leer todas las anteriores.
   *
   * Con búsqueda se consultan como mucho las SEARCH_WINDOW coincidencias más recientes del índice de texto
   * completo; si hay más, `capped` es true y `total` es el número de las que se han examinado.
   */
  listRuns(filter: RunFilter = {}): { items: RunSummary[]; total: number; capped?: boolean } {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.status) (where.push('status = ?'), params.push(filter.status));
    if (filter.kind) (where.push('kind = ?'), params.push(filter.kind));
    if (filter.workflowId) (where.push('workflow_id = ?'), params.push(filter.workflowId));
    if (filter.agentId) (where.push('agent_id = ?'), params.push(filter.agentId));
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const offset = Math.max(filter.offset ?? 0, 0);
    const search = filter.search?.trim();
    let capped = false;

    if (search && [...search].length >= 3) {
      // Índice de texto completo por trigramas: encuentra subcadenas en el nombre, la entrada y el resultado
      // (o el error), sin distinguir mayúsculas ni tildes. Las coincidencias salen de más reciente a más antigua
      // (el identificador interno crece con el orden de creación), así que basta con leer las primeras.
      const matches = this.all(
        'SELECT rowid FROM runs_fts WHERE runs_fts MATCH ? ORDER BY rowid DESC LIMIT ?',
        `"${search.replace(/"/g, '""')}"`,
        SEARCH_WINDOW + 1,
      ).map((r) => Number(r.rowid));
      capped = matches.length > SEARCH_WINDOW;
      if (capped) matches.length = SEARCH_WINDOW;
      if (!matches.length) return { items: [], total: 0 };
      // Los identificadores son números enteros que acaba de devolver la propia base: se insertan tal cual.
      where.push(`rowid IN (${matches.join(',')})`);
    } else if (search) {
      // Con menos de tres caracteres no hay trigramas: se busca solo en el nombre.
      where.push("name LIKE ? ESCAPE '\\'");
      params.push(`%${search.replace(/[\\%_]/g, '\\$&')}%`);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = Number(this.get(`SELECT COUNT(*) AS n FROM runs ${clause}`, ...params)!.n);
    const items = this.all(
      `SELECT ${RUN_SUMMARY_COLS} FROM runs
       WHERE id IN (SELECT id FROM runs ${clause} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?)
       ORDER BY created_at DESC, id DESC`,
      ...params,
      limit,
      offset,
    ).map((r) => this.mapRunSummary(r));
    return capped ? { items, total, capped } : { items, total };
  }

  /** Subejecuciones lanzadas por una ejecución (sus subworkflows). */
  listChildRuns(parentRunId: string): RunSummary[] {
    return this.all(`SELECT ${RUN_SUMMARY_COLS} FROM runs WHERE parent_run_id = ? ORDER BY created_at, id LIMIT 500`, parentRunId).map((r) => this.mapRunSummary(r));
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
    // Uso acumulado por agente (panel): cada paso de agente que termina, bien o mal, cuenta una vez.
    if (patch.status === 'completed' || patch.status === 'failed') {
      this.exec(
        `INSERT INTO stats_agent (agent_id, steps, completion_tokens)
           SELECT agent_id, 1, ? FROM run_steps WHERE run_id = ? AND node_id = ? AND agent_id IS NOT NULL
         ON CONFLICT(agent_id) DO UPDATE SET steps = steps + 1, completion_tokens = completion_tokens + excluded.completion_tokens`,
        patch.usage?.completionTokens ?? 0,
        runId,
        nodeId,
      );
    }
  }

  deleteRun(id: string): boolean {
    this.eventSeq.delete(id);
    return this.exec('DELETE FROM runs WHERE id = ?', id) > 0;
  }

  /** Borra todas las ejecuciones terminadas (no las interrumpidas que siguen pendientes de reanudar). Devuelve cuántas. */
  deleteFinishedRuns(): number {
    return this.exec('DELETE FROM runs WHERE ended_at IS NOT NULL AND interrupted = 0');
  }

  /**
   * Las ejecuciones que quedaron a medias se marcan como fallidas e interrumpidas (reanudables). Se llama al
   * arrancar (por si el proceso murió de golpe) y al apagar ordenadamente.
   */
  markInterruptedRuns(message = 'Ejecución interrumpida por un reinicio del servidor.'): number {
    const now = nowIso();
    const stale = this.all("SELECT id, status, parent_run_id FROM runs WHERE status IN ('queued','running','waiting')");
    for (const { id, status, parent_run_id } of stale) {
      this.exec(
        "UPDATE run_steps SET status='cancelled', finished_at=? WHERE run_id=? AND status IN ('pending','running','waiting')",
        now,
        id,
      );
      this.exec("UPDATE approvals SET status='cancelled', decided_at=? WHERE run_id=? AND status='pending'", now, id);
      // Una subejecución no se reanuda por separado: lo hace la ejecución que la lanzó, que repite ese nodo.
      // Una ejecución que solo esperaba una aprobación no tenía trabajo a medias: se reanuda sola al arrancar.
      const interrupted = parent_run_id ? INTERRUPTED.no : status === 'waiting' ? INTERRUPTED.autoResume : INTERRUPTED.pending;
      this.finishRun(id, { status: 'failed', error: message, finishedAt: now, interrupted });
      this.appendEvent(id, 'run.finished', null, { status: 'failed', error: message });
      this.eventSeq.delete(id);
    }
    return stale.length;
  }

  /** Ejecuciones interrumpidas por un apagado que siguen pendientes de reanudar o descartar. */
  listInterruptedRuns(): RunSummary[] {
    return this.all(`SELECT ${RUN_SUMMARY_COLS} FROM runs WHERE interrupted = 1 ORDER BY created_at DESC, id DESC`).map((r) => this.mapRunSummary(r));
  }

  /**
   * Ejecuciones interrumpidas que se reanudan sin preguntar al arrancar: siempre las que solo esperaban una
   * aprobación y, si `all` (ajuste «reanudar automáticamente»), también el resto.
   */
  listAutoResumableRuns(all: boolean): string[] {
    return this.all(`SELECT id FROM runs WHERE interrupted ${all ? '> 0' : '= 2'} ORDER BY created_at, id`).map((r) => String(r.id));
  }

  /** Da por atendidas las ejecuciones interrumpidas indicadas (o todas). Devuelve cuántas. */
  clearInterrupted(ids?: string[]): number {
    if (!ids) return this.exec('UPDATE runs SET interrupted = 0 WHERE interrupted > 0');
    let changed = 0;
    for (const id of ids) changed += this.exec('UPDATE runs SET interrupted = 0 WHERE id = ? AND interrupted > 0', id);
    return changed;
  }

  /**
   * Cierra una ejecución: guarda su estado final y la suma a las estadísticas acumuladas (una sola vez).
   * Todo lo que termina una ejecución pasa por aquí: fin normal, cancelación en cola y apagado del servidor.
   */
  finishRun(
    id: string,
    final: { status: 'completed' | 'failed' | 'cancelled'; output?: string | null; error?: string | null; usage?: Usage; finishedAt?: string; interrupted?: number },
  ): void {
    this.transaction(() => {
      const row = this.get('SELECT created_at, started_at, ended_at, usage FROM runs WHERE id = ?', id);
      if (!row) return;
      const finishedAt = final.finishedAt ?? nowIso();
      const usage = final.usage ?? parseJson<Usage>(row.usage, { ...ZERO_USAGE });
      this.exec(
        `UPDATE runs SET status = ?, error = ?, usage = ?, finished_at = ?, ended_at = ?, interrupted = ?
           ${final.output !== undefined ? ', output = ?' : ''} WHERE id = ?`,
        ...[final.status, final.error ?? null, usage, finishedAt, finishedAt, final.interrupted ?? 0],
        ...(final.output !== undefined ? [final.output] : []),
        id,
      );
      if (row.ended_at) return; // ya estaba cerrada: no se cuenta dos veces
      const durationMs = row.started_at ? Math.max(0, Date.parse(finishedAt) - Date.parse(row.started_at)) : 0;
      this.exec(
        `INSERT INTO stats_daily (date, status, runs, prompt_tokens, completion_tokens, llm_calls, tool_calls, duration_ms)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?)
         ON CONFLICT(date, status) DO UPDATE SET runs = runs + 1, prompt_tokens = prompt_tokens + excluded.prompt_tokens,
           completion_tokens = completion_tokens + excluded.completion_tokens, llm_calls = llm_calls + excluded.llm_calls,
           tool_calls = tool_calls + excluded.tool_calls, duration_ms = duration_ms + excluded.duration_ms`,
        // Por día LOCAL de creación, igual que el gráfico del panel.
        localDate(new Date(row.created_at)),
        final.status,
        usage.promptTokens,
        usage.completionTokens,
        usage.llmCalls,
        usage.toolCalls,
        durationMs,
      );
    });
  }

  /**
   * Retención del historial: borra las ejecuciones terminadas (con sus pasos y eventos) más antiguas que
   * `days` días y, si se supera `maxRuns`, las más antiguas que sobren. Las que están en curso o pendientes
   * de reanudar no se tocan. Devuelve cuántas se han borrado.
   *
   * Con `batch` borra como mucho ese número por criterio y pasada: quien llama repite hasta que devuelva menos,
   * cediendo el control entre pasadas, para que un historial grande no congele el servidor.
   */
  pruneRuns(policy: { days: number; maxRuns: number }, now = Date.now(), batch = Number.MAX_SAFE_INTEGER): number {
    // Las dos consultas recorren el índice parcial idx_runs_ended (ended_at, id), de más antigua a más reciente.
    const finished = 'ended_at IS NOT NULL AND interrupted = 0';
    let deleted = 0;
    if (policy.days > 0) {
      const cutoff = new Date(now - policy.days * 86_400_000).toISOString();
      deleted += this.exec(
        `DELETE FROM runs WHERE id IN (SELECT id FROM runs WHERE ${finished} AND ended_at < ? ORDER BY ended_at, id LIMIT ?)`,
        cutoff,
        batch,
      );
    }
    if (policy.maxRuns > 0) {
      // La ejecución número maxRuns+1 (de la más reciente a la más antigua) y todas las anteriores sobran.
      const first = this.get(`SELECT ended_at, id FROM runs WHERE ${finished} ORDER BY ended_at DESC, id DESC LIMIT 1 OFFSET ?`, policy.maxRuns);
      if (first) {
        deleted += this.exec(
          `DELETE FROM runs WHERE id IN (
             SELECT id FROM runs WHERE ${finished} AND (ended_at, id) <= (?, ?) ORDER BY ended_at, id LIMIT ?
           )`,
          first.ended_at,
          first.id,
          batch,
        );
      }
    }
    return deleted;
  }

  /**
   * Devuelve al sistema de archivos hasta `pages` páginas libres (compactación incremental) y, si ya no quedan,
   * recorta el diario. Devuelve las páginas libres que quedan por devolver.
   */
  compact(pages = 2000): number {
    this.db.exec(`PRAGMA incremental_vacuum(${Math.max(1, Math.floor(pages))})`);
    const free = Number((this.db.prepare('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count);
    if (free === 0) this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    return free;
  }

  // ---------- Elementos de un «para cada» ----------
  listStepItems(runId: string, nodeId: string): RunStepItem[] {
    return this.all('SELECT idx, item, status, output, error FROM run_step_items WHERE run_id = ? AND node_id = ? ORDER BY idx', runId, nodeId).map((r) => ({
      index: Number(r.idx),
      item: r.item,
      status: r.status,
      output: r.output ?? null,
      error: r.error ?? null,
    }));
  }

  saveStepItem(runId: string, nodeId: string, item: RunStepItem): void {
    this.exec(
      `INSERT INTO run_step_items (run_id, node_id, idx, item, status, output, error) VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(run_id, node_id, idx) DO UPDATE SET item = excluded.item, status = excluded.status, output = excluded.output, error = excluded.error`,
      runId,
      nodeId,
      item.index,
      item.item,
      item.status,
      item.output,
      item.error,
    );
  }

  /** Copia a otra ejecución los elementos ya completados (reintentar desde el fallo): no se repiten. */
  copyCompletedStepItems(fromRunId: string, toRunId: string): void {
    this.exec(
      `INSERT OR REPLACE INTO run_step_items (run_id, node_id, idx, item, status, output, error)
         SELECT ?, node_id, idx, item, status, output, error FROM run_step_items WHERE run_id = ? AND status = 'completed'`,
      toRunId,
      fromRunId,
    );
  }

  // ---------- Aprobaciones humanas ----------
  private mapApproval(r: Row): Approval {
    return {
      id: r.id,
      runId: r.run_id,
      nodeId: r.node_id,
      runName: r.run_name ?? '',
      nodeLabel: r.node_label ?? r.node_id,
      message: r.message,
      status: r.status,
      comment: r.comment ?? '',
      createdAt: r.created_at,
      decidedAt: r.decided_at ?? null,
    };
  }

  private static readonly APPROVAL_SELECT = `SELECT a.*, r.name AS run_name, s.label AS node_label FROM approvals a
    LEFT JOIN runs r ON r.id = a.run_id LEFT JOIN run_steps s ON s.run_id = a.run_id AND s.node_id = a.node_id`;

  createApproval(runId: string, nodeId: string, message: string): Approval {
    const id = newId('apr');
    this.exec('INSERT INTO approvals (id, run_id, node_id, message, created_at) VALUES (?,?,?,?,?)', id, runId, nodeId, message, nowIso());
    return this.getApproval(id)!;
  }

  getApproval(id: string): Approval | null {
    const r = this.get(`${Store.APPROVAL_SELECT} WHERE a.id = ?`, id);
    return r ? this.mapApproval(r) : null;
  }

  /** Aprobaciones de una ejecución, o todas las pendientes (de la más antigua a la más reciente). */
  listApprovals(filter: { runId?: string; pendingOnly?: boolean } = {}): Approval[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.runId) (where.push('a.run_id = ?'), params.push(filter.runId));
    if (filter.pendingOnly) where.push("a.status = 'pending'");
    return this.all(`${Store.APPROVAL_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY a.created_at, a.id LIMIT 500`, ...params).map((r) => this.mapApproval(r));
  }

  /** Cierra una aprobación pendiente. Devuelve false si ya estaba decidida o cancelada. */
  closeApproval(id: string, status: 'approved' | 'rejected' | 'cancelled', comment = ''): boolean {
    return this.exec("UPDATE approvals SET status = ?, comment = ?, decided_at = ? WHERE id = ? AND status = 'pending'", status, comment, nowIso(), id) > 0;
  }

  // ---------- Memoria compartida de una ejecución ----------
  listMemory(runId: string): Array<[string, string]> {
    return this.all('SELECT key, value FROM run_memory WHERE run_id = ? ORDER BY key', runId).map((r) => [r.key, r.value]);
  }

  saveMemory(runId: string, key: string, value: string): void {
    this.exec('INSERT INTO run_memory (run_id, key, value) VALUES (?, ?, ?) ON CONFLICT(run_id, key) DO UPDATE SET value = excluded.value', runId, key, value);
  }

  deleteMemory(runId: string, key?: string): void {
    if (key === undefined) this.exec('DELETE FROM run_memory WHERE run_id = ?', runId);
    else this.exec('DELETE FROM run_memory WHERE run_id = ? AND key = ?', runId, key);
  }

  /** Copia la memoria de una ejecución a otra (reintentar desde el fallo, reanudar). */
  copyMemory(fromRunId: string, toRunId: string): void {
    this.exec('INSERT OR REPLACE INTO run_memory (run_id, key, value) SELECT ?, key, value FROM run_memory WHERE run_id = ?', toRunId, fromRunId);
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
    // La salida de un paso o de la ejecución ya está en run_steps / runs: en el evento guardado no se repite
    // (el evento que se emite en directo sí la lleva). Así la misma salida no se almacena tres veces.
    const omit = EVENT_FIELDS_NOT_PERSISTED[type];
    const stored = omit && omit.some((field) => field in data) ? Object.fromEntries(Object.entries(data).filter(([k]) => !omit.includes(k))) : data;
    this.exec(
      'INSERT INTO run_events (run_id, seq, ts, type, node_id, data) VALUES (?,?,?,?,?,?)',
      runId,
      seq,
      ts,
      type,
      nodeId,
      stored,
    );
    if (type === 'tool.call' && typeof data.name === 'string' && data.name) {
      this.exec('INSERT INTO stats_tool (name, calls) VALUES (?, 1) ON CONFLICT(name) DO UPDATE SET calls = calls + 1', data.name);
    }
    return { seq, runId, ts, type, nodeId, data };
  }

  /** Eventos persistidos de una ejecución a partir de `afterSeq`; con `limit`, como mucho ese número. */
  listEvents(runId: string, afterSeq = 0, limit = -1): RunEvent[] {
    return this.all('SELECT * FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?', runId, afterSeq, limit).map((r) => ({
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
  /**
   * Cifras del panel. Los recuentos por estado salen de un índice; los totales, la serie diaria, la duración
   * media y los rankings salen de tablas de agregados que se actualizan al terminar cada ejecución, cada paso
   * y cada llamada a herramienta, así que el coste no depende del tamaño del historial.
   * Los agregados son acumulados: no bajan al borrar ejecuciones.
   */
  stats(days = 14, now = Date.now()) {
    const count = (table: string) => Number(this.get(`SELECT COUNT(*) AS n FROM ${table}`)!.n);
    const runsByStatus: Record<RunStatus, number> = { queued: 0, running: 0, waiting: 0, completed: 0, failed: 0, cancelled: 0 };
    for (const r of this.all('SELECT status, COUNT(*) AS n FROM runs GROUP BY status')) {
      runsByStatus[r.status as RunStatus] = Number(r.n);
    }
    const totals = this.get(
      `SELECT COALESCE(SUM(prompt_tokens),0) AS p, COALESCE(SUM(completion_tokens),0) AS c,
              COALESCE(SUM(llm_calls),0) AS l, COALESCE(SUM(tool_calls),0) AS t FROM stats_daily`,
    )!;
    const completed = this.get("SELECT COALESCE(SUM(runs),0) AS n, COALESCE(SUM(duration_ms),0) AS ms FROM stats_daily WHERE status = 'completed'")!;

    // Serie de los últimos `days` días, por fecha LOCAL (el día cambia a medianoche del servidor, no en UTC).
    const dailyMap = new Map<string, { date: string; completed: number; failed: number; cancelled: number }>();
    for (let i = days - 1; i >= 0; i--) {
      const date = localDate(new Date(now - i * 86_400_000));
      dailyMap.set(date, { date, completed: 0, failed: 0, cancelled: 0 });
    }
    const since = localDate(new Date(now - (days - 1) * 86_400_000));
    for (const r of this.all('SELECT date, status, runs FROM stats_daily WHERE date >= ?', since)) {
      const day = dailyMap.get(r.date);
      if (day && r.status in day) day[r.status as 'completed' | 'failed' | 'cancelled'] = Number(r.runs);
    }

    const topAgents = this.all(
      `SELECT s.agent_id AS id, COALESCE(a.name, '(eliminado)') AS name, s.steps AS steps, s.completion_tokens AS tokens
       FROM stats_agent s LEFT JOIN agents a ON a.id = s.agent_id ORDER BY s.steps DESC, s.agent_id LIMIT 5`,
    ).map((r) => ({ agentId: r.id, name: r.name, steps: Number(r.steps), completionTokens: Number(r.tokens) }));

    const topTools = this.all('SELECT name, calls FROM stats_tool ORDER BY calls DESC, name LIMIT 6').map((r) => ({ name: String(r.name), calls: Number(r.calls) }));

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
      avgDurationMs: Number(completed.n) ? Math.round(Number(completed.ms) / Number(completed.n)) : null,
      tokens: { prompt: Number(totals.p), completion: Number(totals.c) },
      llmCalls: Number(totals.l),
      toolCalls: Number(totals.t),
      daily: [...dailyMap.values()],
      topAgents,
      topTools,
    };
  }
}
