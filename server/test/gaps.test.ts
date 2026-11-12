// Huecos de pruebas del servidor que la auditoría marcó como críticos o altos y que seguían abiertos:
// migraciones de esquema con datos reales, cifrado de secretos, borrado y lectura de archivos del espacio de
// trabajo, web_fetch, canales SSE, ramas de error del motor y del ejecutor de agentes, manejador de errores de la
// API, reglas de validación de workflows y ramas del almacén.
// Todo con el motor, la API y la base de datos reales; solo el modelo (ScriptedLlm) está guionizado y los
// servidores HTTP son locales y hablan el protocolo de verdad.
import { createHash } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { validateWorkflow } from '../../shared/graph';
import {
  DEFAULT_SETTINGS,
  DEFAULT_WORKFLOW_SETTINGS,
  MAX_SUBWORKFLOW_DEPTH,
  type Run,
  type RunEvent,
  type WorkflowEdge,
  type WorkflowNode,
} from '../../shared/types';
import { VALIDATION_MESSAGES, type IssueParams, type ValidationCode } from '../../shared/validation-messages';
import { buildApp } from '../src/app';
import type { AppConfig } from '../src/config';
import { createContext, type AppContext } from '../src/context';
import { SecretBox } from '../src/crypto/secrets';
import { openDatabase, SCHEMA_VERSION } from '../src/db/database';
import { Store } from '../src/db/store';
import { ConfigError, LlmError, ToolError } from '../src/errors';
import { defaultLlmFactory } from '../src/llm';
import type { LlmFactory } from '../src/llm/types';
import { ToolRegistry } from '../src/tools/registry';
import type { ToolContext } from '../src/tools/types';
import { htmlTitle, htmlToText } from '../src/tools/net';
import {
  addAgent,
  delay,
  edges,
  lastMessage,
  node,
  runWorkflow,
  ScriptedLlm,
  startServer,
  stepStatus,
  systemText,
  tempDir,
  testConfig,
  userText,
  workflow,
} from './helpers';

let ctx: AppContext | undefined;
let app: FastifyInstance | undefined;
const dirs: string[] = [];
const cleanups: Array<() => unknown> = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0)) await Promise.resolve(fn()).catch(() => undefined);
  await app?.close().catch(() => undefined);
  await ctx?.close().catch(() => undefined);
  app = undefined;
  ctx = undefined;
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const newDir = () => {
  const dir = tempDir();
  dirs.push(dir);
  return dir;
};

const echo = () => new ScriptedLlm((req) => ({ content: `eco(${userText(req)})` }));

interface BootOptions {
  llm?: LlmFactory;
  dataDir?: string;
  inMemory?: boolean;
  config?: Partial<AppConfig>;
  retryBaseDelayMs?: number;
}

async function boot(opts: BootOptions = {}) {
  const dataDir = opts.dataDir ?? newDir();
  ctx = createContext(
    { ...testConfig(dataDir), ...opts.config },
    { llm: opts.llm ?? echo(), inMemory: opts.inMemory ?? true, retryBaseDelayMs: opts.retryBaseDelayMs ?? 5 },
  );
  app = await buildApp(ctx);
  return { ctx, app, dataDir };
}

async function shutdown() {
  await app?.close();
  await ctx?.close();
  app = undefined;
  ctx = undefined;
}

const req = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) => app!.inject({ method, url, payload: payload as object | undefined });
const get = (url: string) => req('GET', url);
const post = (url: string, payload: unknown = {}) => req('POST', url, payload);
const del = (url: string) => req('DELETE', url);

/** Espera a que se cumpla una condición (sin esperas fijas largas). */
async function until<T>(cond: () => T | undefined | false | null, what: string, ms = 10_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = cond();
    if (value) return value;
    if (Date.now() - started > ms) throw new Error(`Se agotó la espera: ${what}`);
    await delay(10);
  }
}

/** Modelo que no responde hasta que se le cancela. */
const hangUntilAborted = (signal?: AbortSignal) =>
  new Promise<never>((_resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

const sha = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// ───────────────────────────── C2 · migraciones de esquema ─────────────────────────────

// Esquemas tal como se publicaron en las versiones 1, 2 y 3 (copias congeladas del SQL de entonces): las bases
// de quien actualiza se crearon con ESTE SQL, no con el actual.
const ESQUEMA_V1 = `
  CREATE TABLE providers (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, base_url TEXT NOT NULL, api_key_enc TEXT,
    default_model TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL DEFAULT '#6366f1', provider_id TEXT NOT NULL, model TEXT NOT NULL DEFAULT '', system_prompt TEXT NOT NULL DEFAULT '',
    temperature REAL NOT NULL DEFAULT 0.7, max_tokens INTEGER, max_iterations INTEGER NOT NULL DEFAULT 8, tools TEXT NOT NULL DEFAULT '[]',
    thinking INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE custom_tools (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL DEFAULT '', parameters TEXT NOT NULL,
    config TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE workflows (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', definition TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE runs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, workflow_id TEXT, agent_id TEXT, name TEXT NOT NULL, status TEXT NOT NULL,
    input TEXT NOT NULL DEFAULT '', output TEXT, error TEXT, snapshot TEXT NOT NULL, usage TEXT NOT NULL, retry_of TEXT,
    created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT);
  CREATE INDEX idx_runs_created ON runs(created_at DESC);
  CREATE INDEX idx_runs_status ON runs(status);
  CREATE TABLE run_steps (run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, node_id TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0,
    node_type TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', agent_id TEXT, status TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0,
    input TEXT, output TEXT, error TEXT, usage TEXT NOT NULL, started_at TEXT, finished_at TEXT, PRIMARY KEY (run_id, node_id));
  CREATE TABLE run_events (run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, seq INTEGER NOT NULL, ts TEXT NOT NULL, type TEXT NOT NULL,
    node_id TEXT, data TEXT NOT NULL, PRIMARY KEY (run_id, seq));
  CREATE INDEX idx_events_type ON run_events(type);
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;
const ESQUEMA_V2 = `
  ALTER TABLE runs ADD COLUMN interrupted INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX idx_runs_finished ON runs(finished_at);
`;
const ESQUEMA_V3 = `
  CREATE TABLE schedules (workflow_id TEXT PRIMARY KEY REFERENCES workflows(id) ON DELETE CASCADE, kind TEXT NOT NULL, interval_minutes INTEGER,
    time TEXT, input TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1, next_run_at TEXT, last_run_at TEXT, last_run_id TEXT,
    last_error TEXT, updated_at TEXT NOT NULL);
  ALTER TABLE runs ADD COLUMN scheduled INTEGER NOT NULL DEFAULT 0;
`;

/** Crea el archivo de una base antigua (esquema v1, v2 o v3) y la deja abierta para poblarla. */
function baseAntigua(file: string, version: 1 | 2 | 3): DatabaseSync {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const raw = new DatabaseSync(file);
  raw.exec(ESQUEMA_V1);
  if (version >= 2) raw.exec(ESQUEMA_V2);
  if (version >= 3) raw.exec(ESQUEMA_V3);
  raw.exec(`PRAGMA user_version = ${version}`);
  return raw;
}

const T0 = '2026-01-05T10:00:00.000Z';
const T1 = '2026-01-05T10:00:03.000Z';
const usoJson = (p: number, c: number, l: number, t: number) => JSON.stringify({ promptTokens: p, completionTokens: c, llmCalls: l, toolCalls: t });

const WORKFLOW_ANTIGUO = {
  nodes: [
    { id: 'entrada', type: 'input', label: 'Entrada', position: { x: 0, y: 0 }, config: {} },
    { id: 'analiza', type: 'agent', label: 'Analiza', position: { x: 200, y: 0 }, config: { agentId: 'agt_a', prompt: '{{entrada}}' } },
    { id: 'salida', type: 'output', label: 'Salida', position: { x: 400, y: 0 }, config: { template: '{{analiza}}' } },
  ],
  edges: [
    { id: 'e1', source: 'entrada', target: 'analiza' },
    { id: 'e2', source: 'analiza', target: 'salida' },
  ],
  settings: DEFAULT_WORKFLOW_SETTINGS,
};
const SNAPSHOT_ANTIGUO = JSON.stringify({ workflow: WORKFLOW_ANTIGUO, agents: {} });

const insertRun = (
  raw: DatabaseSync,
  r: {
    id: string;
    kind: string;
    workflow: string | null;
    agent: string | null;
    name: string;
    status: string;
    input: string;
    output: string | null;
    error: string | null;
    usage: string;
    finished: boolean;
  },
) =>
  raw
    .prepare(
      'INSERT INTO runs (id, kind, workflow_id, agent_id, name, status, input, output, error, snapshot, usage, retry_of, created_at, started_at, finished_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    )
    .run(r.id, r.kind, r.workflow, r.agent, r.name, r.status, r.input, r.output, r.error, SNAPSHOT_ANTIGUO, r.usage, null, T0, T0, r.finished ? T1 : null);

/** Datos reales en TODAS las tablas del esquema v1. La API key del proveedor está cifrada con la clave del directorio. */
function poblarV1(raw: DatabaseSync, dir: string): void {
  const secrets = SecretBox.fromKeyFile(path.join(dir, 'secret.key'));
  const provider = raw.prepare('INSERT INTO providers VALUES (?,?,?,?,?,?,?,?,?)');
  provider.run('prv_a', 'Ollama local', 'ollama', 'http://127.0.0.1:11434', null, 'llama3.2', 1, T0, T0);
  provider.run('prv_b', 'Nube', 'openai', 'https://api.example.test/v1', secrets.encrypt('sk-vieja-ñandú'), 'gpt-x', 0, T0, T0);
  const agent = raw.prepare('INSERT INTO agents VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  agent.run(
    'agt_a',
    'Analista',
    'investigador',
    'Analiza datos',
    '#112233',
    'prv_a',
    'llama3.2',
    'Sé breve',
    0.2,
    512,
    5,
    '["calculator","web_fetch"]',
    1,
    T0,
    T0,
  );
  agent.run('agt_b', 'Redactor', '', '', '#6366f1', 'prv_b', 'gpt-x', '', 0.7, null, 8, '[]', 0, T0, T0);
  raw
    .prepare('INSERT INTO custom_tools VALUES (?,?,?,?,?,?,?,?)')
    .run(
      'tool_a',
      'consultar_precio',
      'Consulta un precio',
      JSON.stringify({ type: 'object', properties: { sku: { type: 'string' } }, required: ['sku'] }),
      JSON.stringify({ method: 'GET', urlTemplate: 'https://precios.example.test/{{sku}}', headers: { 'X-Version': '2' }, bodyTemplate: '' }),
      1,
      T0,
      T0,
    );
  raw.prepare('INSERT INTO workflows VALUES (?,?,?,?,?,?)').run('wfl_a', 'Informe', 'Informe de precios', JSON.stringify(WORKFLOW_ANTIGUO), T0, T0);
  insertRun(raw, {
    id: 'run_ok',
    kind: 'workflow',
    workflow: 'wfl_a',
    agent: null,
    name: 'Informe',
    status: 'completed',
    input: 'precio del café',
    output: 'resultado ñ',
    error: null,
    usage: usoJson(100, 40, 2, 1),
    finished: true,
  });
  insertRun(raw, {
    id: 'run_fail',
    kind: 'agent',
    workflow: null,
    agent: 'agt_a',
    name: 'Analista',
    status: 'failed',
    input: 'algo',
    output: null,
    error: 'boom',
    usage: usoJson(10, 5, 1, 0),
    finished: true,
  });
  insertRun(raw, {
    id: 'run_live',
    kind: 'agent',
    workflow: null,
    agent: 'agt_b',
    name: 'Redactor',
    status: 'running',
    input: 'a medias',
    output: null,
    error: null,
    usage: usoJson(0, 0, 0, 0),
    finished: false,
  });
  const step = raw.prepare('INSERT INTO run_steps VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  step.run('run_ok', 'entrada', 0, 'input', 'Entrada', null, 'completed', 1, null, 'precio del café', null, usoJson(0, 0, 0, 0), T0, T0);
  step.run('run_ok', 'analiza', 1, 'agent', 'Analiza', 'agt_a', 'completed', 1, 'precio del café', 'resultado ñ', null, usoJson(100, 40, 2, 1), T0, T1);
  step.run('run_ok', 'salida', 2, 'output', 'Salida', null, 'completed', 1, null, 'resultado ñ', null, usoJson(0, 0, 0, 0), T1, T1);
  step.run('run_fail', 'agent', 0, 'agent', 'Analista', 'agt_a', 'failed', 1, 'algo', null, 'boom', usoJson(10, 5, 1, 0), T0, T1);
  step.run('run_live', 'agent', 0, 'agent', 'Redactor', 'agt_b', 'running', 1, 'a medias', null, null, usoJson(0, 0, 0, 0), T0, null);
  const event = raw.prepare('INSERT INTO run_events VALUES (?,?,?,?,?,?)');
  event.run('run_ok', 1, T0, 'run.started', null, JSON.stringify({ name: 'Informe' }));
  event.run('run_ok', 2, T0, 'tool.call', 'analiza', JSON.stringify({ name: 'calculator', arguments: { expression: '1+1' } }));
  event.run('run_ok', 3, T0, 'tool.call', 'analiza', JSON.stringify({ name: 'calculator', arguments: { expression: '2+2' } }));
  event.run('run_ok', 4, T0, 'tool.call', 'analiza', JSON.stringify({ name: 'web_fetch', arguments: { url: 'https://example.test' } }));
  event.run('run_ok', 5, T1, 'run.finished', null, JSON.stringify({ status: 'completed' }));
  event.run('run_fail', 1, T0, 'run.started', null, JSON.stringify({ name: 'Analista' }));
  const setting = raw.prepare('INSERT INTO settings VALUES (?,?)');
  setting.run('maxConcurrentRuns', '2');
  setting.run('allowPrivateNetwork', 'true');
}

/** Las columnas que ya existían en v1, tabla por tabla: lo que una migración NUNCA debe alterar ni perder. */
const COLUMNAS_V1: Record<string, string> = {
  providers: 'id,name,kind,base_url,api_key_enc,default_model,enabled,created_at,updated_at',
  agents: 'id,name,role,description,color,provider_id,model,system_prompt,temperature,max_tokens,max_iterations,tools,thinking,created_at,updated_at',
  custom_tools: 'id,name,description,parameters,config,enabled,created_at,updated_at',
  workflows: 'id,name,description,definition,created_at,updated_at',
  runs: 'id,kind,workflow_id,agent_id,name,status,input,output,error,snapshot,usage,retry_of,created_at,started_at,finished_at',
  run_steps: 'run_id,node_id,position,node_type,label,agent_id,status,attempt,input,output,error,usage,started_at,finished_at',
  run_events: 'run_id,seq,ts,type,node_id,data',
  settings: 'key,value',
};
const volcadoV1 = (db: DatabaseSync): Record<string, unknown[]> =>
  JSON.parse(
    JSON.stringify(
      Object.fromEntries(Object.entries(COLUMNAS_V1).map(([table, cols]) => [table, db.prepare(`SELECT ${cols} FROM ${table} ORDER BY 1, 2`).all()])),
    ),
  );

const versionDe = (db: DatabaseSync) => (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
const columnasDe = (db: DatabaseSync, table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
const objetosDe = (db: DatabaseSync, type: 'table' | 'index' | 'trigger') =>
  (db.prepare('SELECT name FROM sqlite_master WHERE type = ? ORDER BY name').all(type) as Array<{ name: string }>).map((r) => r.name);
const esquemaDe = (db: DatabaseSync) => JSON.parse(JSON.stringify(db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name').all()));
const copiasEn = (dir: string) => fs.readdirSync(dir).filter((f) => f.endsWith('.bak'));

describe('migraciones de esquema', () => {
  it('una base nueva llega a la última versión y reabrirla no cambia nada ni genera copias', () => {
    const dir = newDir();
    const file = path.join(dir, 'agentforge.db');
    const first = openDatabase(file);
    expect(versionDe(first)).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(6);
    expect(first.prepare('PRAGMA auto_vacuum').get()).toEqual({ auto_vacuum: 2 }); // compactación incremental desde el principio
    expect(objetosDe(first, 'table')).toEqual(
      expect.arrayContaining([
        'agents',
        'approvals',
        'custom_tools',
        'mcp_servers',
        'providers',
        'run_events',
        'run_memory',
        'run_step_items',
        'run_steps',
        'runs',
        'runs_fts',
        'settings',
        'stats_agent',
        'stats_daily',
        'stats_tool',
        'triggers',
        'workflows',
      ]),
    );
    expect(objetosDe(first, 'table')).not.toContain('schedules'); // la v6 la sustituyó por los disparadores
    const esquema = esquemaDe(first);
    const store = new Store(first, SecretBox.ephemeral());
    const provider = store.createProvider({ name: 'Persistente', kind: 'ollama', baseUrl: 'http://127.0.0.1:1', defaultModel: '', enabled: true });
    first.close();
    expect(copiasEn(dir)).toEqual([]); // una base nueva no necesita copia

    const second = openDatabase(file);
    expect(versionDe(second)).toBe(SCHEMA_VERSION);
    expect(esquemaDe(second)).toEqual(esquema);
    expect(new Store(second, SecretBox.ephemeral()).getProvider(provider.id)).toMatchObject({ name: 'Persistente' });
    expect(second.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    second.close();
    expect(copiasEn(dir)).toEqual([]);
  });

  it('una base v1 con datos en cada tabla migra a la última versión sin perder ni alterar nada', async () => {
    const dir = newDir();
    const file = path.join(dir, 'agentforge.db');
    const raw = baseAntigua(file, 1);
    poblarV1(raw, dir);
    const antes = volcadoV1(raw);
    raw.close();
    expect(antes.providers).toHaveLength(2);
    expect(antes.agents).toHaveLength(2);
    expect(antes.custom_tools).toHaveLength(1);
    expect(antes.workflows).toHaveLength(1);
    expect(antes.runs).toHaveLength(3);
    expect(antes.run_steps).toHaveLength(5);
    expect(antes.run_events).toHaveLength(6);
    expect(antes.settings).toHaveLength(2);

    const db = openDatabase(file);
    expect(versionDe(db)).toBe(SCHEMA_VERSION);
    expect(volcadoV1(db)).toEqual(antes); // ni una fila ni un valor distinto en las columnas de siempre
    expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(
      db
        .prepare('SELECT id, interrupted, scheduled, trigger_kind, parent_run_id FROM runs ORDER BY id')
        .all()
        .map((r) => ({ ...r })),
    ).toEqual([
      { id: 'run_fail', interrupted: 0, scheduled: 0, trigger_kind: null, parent_run_id: null },
      { id: 'run_live', interrupted: 0, scheduled: 0, trigger_kind: null, parent_run_id: null },
      { id: 'run_ok', interrupted: 0, scheduled: 0, trigger_kind: null, parent_run_id: null },
    ]);
    db.close();

    // Antes de migrar se guardó una copia coherente de lo que había.
    const copia = new DatabaseSync(`${file}.v1.bak`);
    expect(versionDe(copia)).toBe(1);
    expect(volcadoV1(copia)).toEqual(antes);
    copia.close();

    // Lo que el servidor lee de esa base: todo lo de antes, con las capacidades nuevas funcionando.
    await boot({ dataDir: dir, inMemory: false });
    const providers = (await get('/api/providers')).json();
    expect(providers).toMatchObject([
      { id: 'prv_a', name: 'Ollama local', hasApiKey: false, enabled: true },
      { id: 'prv_b', name: 'Nube', hasApiKey: true, enabled: false, defaultModel: 'gpt-x' },
    ]);
    expect(JSON.stringify(providers)).not.toContain('sk-vieja');
    expect(ctx!.store.getProviderWithSecret('prv_b')!.apiKey).toBe('sk-vieja-ñandú'); // se descifra con la clave de siempre
    expect((await get('/api/agents')).json()).toMatchObject([
      {
        id: 'agt_a',
        name: 'Analista',
        tools: ['calculator', 'web_fetch'],
        thinking: true,
        maxTokens: 512,
        maxIterations: 5,
        temperature: 0.2,
        color: '#112233',
      },
      { id: 'agt_b', name: 'Redactor', tools: [], thinking: false, maxTokens: null },
    ]);
    expect((await get('/api/tools/custom/tool_a')).json()).toMatchObject({
      name: 'consultar_precio',
      method: 'GET',
      urlTemplate: 'https://precios.example.test/{{sku}}',
      headers: { 'X-Version': '2' },
    });
    expect((await get('/api/workflows/wfl_a')).json()).toMatchObject({
      name: 'Informe',
      nodes: [{ id: 'entrada' }, { id: 'analiza' }, { id: 'salida' }],
      edges: [{ id: 'e1' }, { id: 'e2' }],
    });
    expect((await get('/api/settings')).json()).toMatchObject({ maxConcurrentRuns: 2, allowPrivateNetwork: true });
    const run = (await get('/api/runs/run_ok')).json() as Run;
    expect(run).toMatchObject({
      status: 'completed',
      input: 'precio del café',
      output: 'resultado ñ',
      interrupted: false,
      scheduled: false,
      usage: { promptTokens: 100, completionTokens: 40, llmCalls: 2, toolCalls: 1 },
    });
    expect(run.steps.map((s) => [s.nodeId, s.status])).toEqual([
      ['entrada', 'completed'],
      ['analiza', 'completed'],
      ['salida', 'completed'],
    ]);
    expect(run.snapshot.workflow.nodes).toHaveLength(3);
    expect(((await get('/api/runs/run_ok/events')).json() as RunEvent[]).map((e) => e.type)).toEqual([
      'run.started',
      'tool.call',
      'tool.call',
      'tool.call',
      'run.finished',
    ]);
    // La ejecución que estaba «en curso» al apagarse queda interrumpida y reanudable (el esquema ya tiene la columna).
    expect(((await get('/api/runs/interrupted')).json() as Array<{ id: string }>).map((r) => r.id)).toEqual(['run_live']);

    // La migración v4 reconstruyó a partir de los datos: agregados del panel y búsqueda de texto.
    const stats = (await get('/api/stats')).json();
    expect(stats.runsByStatus).toMatchObject({ completed: 1, failed: 2 }); // run_fail y la interrumpida
    expect(stats.tokens).toEqual({ prompt: 110, completion: 45 });
    expect(stats.llmCalls).toBe(3);
    expect(stats.topTools).toEqual([
      { name: 'calculator', calls: 2 },
      { name: 'web_fetch', calls: 1 },
    ]);
    expect(stats.topAgents).toEqual([{ agentId: 'agt_a', name: 'Analista', steps: 2, completionTokens: 45 }]);
    expect(((await get('/api/runs?search=cafe')).json() as { items: Array<{ id: string }> }).items.map((r) => r.id)).toEqual(['run_ok']);
    expect(ctx!.db.prepare('SELECT ended_at FROM runs WHERE id = ?').get('run_ok')).toEqual({ ended_at: T1 });
    // Y se puede seguir trabajando: el almacén escribe con el esquema nuevo.
    const wf = (await get('/api/workflows/wfl_a')).json();
    expect((await post(`/api/workflows/${wf.id}/triggers`, { kind: 'interval', intervalMinutes: 5 })).statusCode).toBe(201);
  });

  it('desde v2 (el salto real de quien actualiza): scheduled vale 0 en las filas antiguas y interrupted se conserva', async () => {
    const dir = newDir();
    const file = path.join(dir, 'agentforge.db');
    const raw = baseAntigua(file, 2);
    raw.prepare('INSERT INTO providers VALUES (?,?,?,?,?,?,?,?,?)').run('prv_a', 'Local', 'ollama', 'http://127.0.0.1:11434', null, 'm', 1, T0, T0);
    raw.prepare('INSERT INTO workflows VALUES (?,?,?,?,?,?)').run('wfl_a', 'Informe', '', JSON.stringify(WORKFLOW_ANTIGUO), T0, T0);
    insertRun(raw, {
      id: 'run_ok',
      kind: 'workflow',
      workflow: 'wfl_a',
      agent: null,
      name: 'Informe',
      status: 'completed',
      input: 'x',
      output: 'y',
      error: null,
      usage: usoJson(1, 1, 1, 0),
      finished: true,
    });
    insertRun(raw, {
      id: 'run_int',
      kind: 'workflow',
      workflow: 'wfl_a',
      agent: null,
      name: 'Informe',
      status: 'failed',
      input: 'z',
      output: null,
      error: 'Ejecución interrumpida por un reinicio del servidor.',
      usage: usoJson(0, 0, 0, 0),
      finished: true,
    });
    raw.exec("UPDATE runs SET interrupted = 1 WHERE id = 'run_int'");
    raw.close();

    const db = openDatabase(file);
    expect(versionDe(db)).toBe(SCHEMA_VERSION);
    expect(
      db
        .prepare('SELECT id, interrupted, scheduled FROM runs ORDER BY id')
        .all()
        .map((r) => ({ ...r })),
    ).toEqual([
      { id: 'run_int', interrupted: 1, scheduled: 0 },
      { id: 'run_ok', interrupted: 0, scheduled: 0 },
    ]);
    expect(objetosDe(db, 'table')).not.toContain('schedules'); // v3 la creó y v6 la convirtió: sin filas, sin disparadores
    expect(db.prepare('SELECT COUNT(*) AS n FROM triggers').get()).toEqual({ n: 0 });
    db.close();
    expect(fs.existsSync(`${file}.v2.bak`)).toBe(true);

    await boot({ dataDir: dir, inMemory: false });
    expect(((await get('/api/runs/interrupted')).json() as Array<{ id: string }>).map((r) => r.id)).toEqual(['run_int']);
    expect((await get('/api/runs/run_ok')).json()).toMatchObject({ scheduled: false, interrupted: false });
    expect((await post('/api/workflows/wfl_a/triggers', { kind: 'daily', time: '07:45' })).statusCode).toBe(201);
  });

  it('desde v3: la programación única pasa a ser un disparador y las ejecuciones programadas siguen marcadas', async () => {
    const dir = newDir();
    const file = path.join(dir, 'agentforge.db');
    const raw = baseAntigua(file, 3);
    raw.prepare('INSERT INTO workflows VALUES (?,?,?,?,?,?)').run('wfl_a', 'Informe', '', JSON.stringify(WORKFLOW_ANTIGUO), T0, T0);
    insertRun(raw, {
      id: 'run_prog',
      kind: 'workflow',
      workflow: 'wfl_a',
      agent: null,
      name: 'Informe',
      status: 'completed',
      input: 'hola',
      output: 'listo',
      error: null,
      usage: usoJson(1, 1, 1, 0),
      finished: true,
    });
    raw.exec("UPDATE runs SET scheduled = 1 WHERE id = 'run_prog'");
    raw
      .prepare(
        'INSERT INTO schedules (workflow_id, kind, interval_minutes, time, input, enabled, next_run_at, last_run_at, last_run_id, last_error, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run('wfl_a', 'interval', 30, null, 'hola', 1, '2030-01-01T00:30:00.000Z', T1, 'run_prog', 'falló una vez', T0);
    raw.close();

    const db = openDatabase(file);
    expect(versionDe(db)).toBe(SCHEMA_VERSION);
    expect(objetosDe(db, 'table')).not.toContain('schedules');
    db.close();
    await boot({ dataDir: dir, inMemory: false });
    expect((await get('/api/workflows/wfl_a/triggers')).json()).toMatchObject([
      {
        kind: 'interval',
        intervalMinutes: 30,
        input: 'hola',
        enabled: true,
        nextRunAt: '2030-01-01T00:30:00.000Z',
        lastRunAt: T1,
        lastRunId: 'run_prog',
        lastError: 'falló una vez',
      },
    ]);
    expect((await get('/api/runs/run_prog')).json()).toMatchObject({ scheduled: true, status: 'completed', output: 'listo' });
  });

  it('una migración que falla a medias deja la versión, el esquema y los datos como estaban, y se puede reintentar', () => {
    const dir = newDir();
    const file = path.join(dir, 'agentforge.db');
    const raw = baseAntigua(file, 3);
    poblarV1(raw, dir);
    raw.exec('CREATE TABLE stats_daily (obstaculo TEXT)'); // la migración v4 choca con esto DESPUÉS de haber tocado runs y sus índices
    const antes = volcadoV1(raw);
    const indicesAntes = objetosDe(raw, 'index');
    const columnasAntes = columnasDe(raw, 'runs');
    raw.close();

    expect(() => openDatabase(file)).toThrow(/stats_daily/);

    const check = new DatabaseSync(file);
    expect(versionDe(check)).toBe(3);
    expect(columnasDe(check, 'runs')).toEqual(columnasAntes); // sin ended_at: el ALTER TABLE se deshizo
    expect(objetosDe(check, 'index')).toEqual(indicesAntes); // los DROP INDEX y CREATE INDEX también
    expect(objetosDe(check, 'table')).not.toContain('runs_fts');
    expect(volcadoV1(check)).toEqual(antes);
    expect(fs.existsSync(`${file}.v3.bak`)).toBe(true);
    // Se quita el obstáculo y el siguiente arranque migra con normalidad, conservando todo.
    check.exec('DROP TABLE stats_daily');
    check.close();
    const db = openDatabase(file);
    expect(versionDe(db)).toBe(SCHEMA_VERSION);
    expect(volcadoV1(db)).toEqual(antes);
    db.close();
  });

  it('si falla la última migración (la que mueve las programaciones) las anteriores se conservan y la programación sigue intacta', async () => {
    const dir = newDir();
    const file = path.join(dir, 'agentforge.db');
    const raw = baseAntigua(file, 3);
    raw.prepare('INSERT INTO workflows VALUES (?,?,?,?,?,?)').run('wfl_a', 'Informe', '', JSON.stringify(WORKFLOW_ANTIGUO), T0, T0);
    raw
      .prepare('INSERT INTO schedules (workflow_id, kind, interval_minutes, time, input, enabled, next_run_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run('wfl_a', 'daily', null, '07:45', 'boletín', 1, '2030-01-01T06:45:00.000Z', T0);
    raw.exec('CREATE TABLE mcp_servers (obstaculo TEXT)'); // lo último que crea la v6, tras mover y borrar las programaciones
    raw.close();

    expect(() => openDatabase(file)).toThrow(/mcp_servers/);

    const check = new DatabaseSync(file);
    expect(versionDe(check)).toBe(5); // v4 y v5 sí se confirmaron, cada una en su transacción; la v6 no
    expect(objetosDe(check, 'table')).toContain('schedules');
    expect(objetosDe(check, 'table')).not.toContain('triggers');
    expect(columnasDe(check, 'runs')).not.toContain('trigger_kind');
    expect(columnasDe(check, 'runs')).toContain('parent_run_id');
    expect(
      check
        .prepare('SELECT workflow_id, kind, time, input, enabled FROM schedules')
        .all()
        .map((r) => ({ ...r })),
    ).toEqual([{ workflow_id: 'wfl_a', kind: 'daily', time: '07:45', input: 'boletín', enabled: 1 }]);
    check.exec('DROP TABLE mcp_servers');
    check.close();

    const db = openDatabase(file);
    expect(versionDe(db)).toBe(SCHEMA_VERSION);
    expect(
      db
        .prepare('SELECT kind, time, input, workflow_id FROM triggers')
        .all()
        .map((r) => ({ ...r })),
    ).toEqual([{ kind: 'daily', time: '07:45', input: 'boletín', workflow_id: 'wfl_a' }]);
    db.close();
  });
});

// ───────────────────────────── A6 · cifrado de secretos ─────────────────────────────

describe('cifrado de secretos', () => {
  const caja = () => new SecretBox(Buffer.alloc(32, 7));
  const retocar = (payload: string, parte: number): string => {
    const partes = payload.split(':');
    const bytes = Buffer.from(partes[parte], 'base64');
    bytes[0] ^= 1;
    partes[parte] = bytes.toString('base64');
    return partes.join(':');
  };

  it.each(['', 'sk-simple', 'clave ñandú — 日本語 — 😀 — Ωmega', 'línea 1\nlínea 2\t"comillas"', 'x'.repeat(100_000)])('ida y vuelta de %j', (texto) => {
    expect(caja().decrypt(caja().encrypt(texto))).toBe(texto);
  });

  it('dos cifrados del mismo texto difieren (IV aleatorio) y el formato es v1:iv:etiqueta:datos', () => {
    const box = caja();
    const a = box.encrypt('mismo texto');
    const b = box.encrypt('mismo texto');
    expect(a).not.toBe(b);
    expect(box.decrypt(a)).toBe('mismo texto');
    expect(box.decrypt(b)).toBe('mismo texto');
    const [version, iv, tag, data] = a.split(':');
    expect(version).toBe('v1');
    expect(Buffer.from(iv, 'base64')).toHaveLength(12);
    expect(Buffer.from(tag, 'base64')).toHaveLength(16);
    expect(a).not.toContain('mismo texto');
    expect(Buffer.from(data, 'base64').toString('utf8')).not.toBe('mismo texto');
  });

  it('un byte manipulado en los datos, en la etiqueta o en el IV hace que descifrar lance; también otra clave', () => {
    const box = caja();
    const cifrado = box.encrypt('secreto importante');
    expect(() => box.decrypt(retocar(cifrado, 3))).toThrow(); // datos
    expect(() => box.decrypt(retocar(cifrado, 2))).toThrow(); // etiqueta de autenticación
    expect(() => box.decrypt(retocar(cifrado, 1))).toThrow(); // IV
    expect(() => new SecretBox(Buffer.alloc(32, 8)).decrypt(cifrado)).toThrow(); // clave maestra distinta
    expect(box.decrypt(cifrado)).toBe('secreto importante'); // el original sigue siendo válido
  });

  it.each(['', 'texto sin formato', 'v2:aaaa:bbbb:cccc', 'V1:aaaa:bbbb:cccc', 'v1:solo-iv', 'v1:iv:etiqueta', 'v1::tag:datos'])(
    'un formato desconocido (%j) se rechaza con un mensaje claro',
    (payload) => {
      expect(() => caja().decrypt(payload)).toThrow('Formato de secreto no reconocido.');
    },
  );

  it.each([0, 1, 16, 24, 31, 33, 64])('una clave de %i bytes se rechaza', (longitud) => {
    expect(() => new SecretBox(Buffer.alloc(longitud, 1))).toThrow('La clave maestra debe tener 32 bytes.');
  });

  it('el archivo de clave se crea una vez, es estable entre arranques y uno de longitud incorrecta no se acepta', () => {
    const dir = newDir();
    const file = path.join(dir, 'subcarpeta', 'secret.key');
    const cifrado = SecretBox.fromKeyFile(file).encrypt('persistente');
    expect(Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64')).toHaveLength(32);
    expect(SecretBox.fromKeyFile(file).decrypt(cifrado)).toBe('persistente'); // mismo archivo, misma clave
    fs.writeFileSync(file, Buffer.alloc(16, 1).toString('base64'));
    expect(() => SecretBox.fromKeyFile(file)).toThrow(/32 bytes/);
    fs.writeFileSync(file, '');
    expect(() => SecretBox.fromKeyFile(file)).toThrow(/32 bytes/);
  });

  it('con secret.key perdido la API responde con errores legibles y la clave se recupera volviéndola a escribir', async () => {
    const proveedor = await startServer((request, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'modelo-a' }, { id: 'modelo-b' }] }));
      void request;
    });
    cleanups.push(proveedor.close);
    const dataDir = newDir();
    await boot({ dataDir, inMemory: false, llm: defaultLlmFactory });
    const provider = ctx!.store.createProvider({
      name: 'Nube',
      kind: 'openai',
      baseUrl: `${proveedor.url}/v1`,
      apiKey: 'sk-vieja',
      defaultModel: 'modelo-a',
      enabled: true,
    });
    const agent = addAgent(ctx!, { providerId: provider.id });
    await shutdown();
    fs.rmSync(path.join(dataDir, 'secret.key')); // se pierde la clave maestra: el siguiente arranque genera otra
    await boot({ dataDir, inMemory: false, llm: defaultLlmFactory });

    // El listado sigue funcionando y no filtra nada.
    const list = await get('/api/providers');
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject([{ id: provider.id, name: 'Nube', hasApiKey: true }]);
    expect(JSON.stringify(list.json())).not.toContain('sk-');

    // Probar y listar modelos: 409 con el motivo y la acción, nunca un 500 genérico ni un descifrado roto.
    for (const probe of [
      await post(`/api/providers/${provider.id}/test`),
      await post('/api/providers/test', { id: provider.id, name: 'Nube', kind: 'openai', baseUrl: `${proveedor.url}/v1` }),
      await post('/api/providers/models', { id: provider.id, name: 'Nube', kind: 'openai', baseUrl: `${proveedor.url}/v1` }),
      await get(`/api/providers/${provider.id}/models`),
    ]) {
      expect(probe.statusCode).toBe(409);
      expect(probe.json()).toMatchObject({
        code: 'config_error',
        error: expect.stringMatching(/No se pudo descifrar la API key de «Nube».*Vuelve a introducirla/),
      });
      expect(probe.body).not.toMatch(/auth|decipher|Unsupported state/i); // sin detalles internos del cifrado
    }
    expect(proveedor.requests).toHaveLength(0); // y sin haber enviado nada al proveedor

    // Una ejecución que lo usa falla con ese mismo mensaje.
    const run = ctx!.runs.startAgentRun(ctx!.store.getAgent(agent.id)!, 'hola');
    await ctx!.runs.waitFor(run.id);
    expect(ctx!.store.getRunSummary(run.id)).toMatchObject({ status: 'failed', error: expect.stringContaining('No se pudo descifrar la API key de «Nube»') });

    // Editar sin tocar la clave no la «arregla»; volver a escribirla sí.
    const base = { name: 'Nube', kind: 'openai', baseUrl: `${proveedor.url}/v1`, defaultModel: 'modelo-a', enabled: true };
    expect((await req('PUT', `/api/providers/${provider.id}`, { ...base, defaultModel: 'modelo-b' })).statusCode).toBe(200);
    expect((await post(`/api/providers/${provider.id}/test`)).statusCode).toBe(409);
    expect((await req('PUT', `/api/providers/${provider.id}`, { ...base, apiKey: 'sk-nueva' })).statusCode).toBe(200);
    expect((await post(`/api/providers/${provider.id}/test`)).json()).toMatchObject({ ok: true, modelCount: 2 });
    expect(proveedor.requests.at(-1)!.headers.authorization).toBe('Bearer sk-nueva');
  });
});

// ───────────────────────────── A5 · archivos del espacio de trabajo ─────────────────────────────

describe('archivos del espacio de trabajo por la API', () => {
  async function bootEnDisco() {
    const booted = await boot({ inMemory: false });
    const workspace = booted.ctx.config.workspaceDir;
    fs.mkdirSync(path.join(workspace, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'docs', 'nota.md'), '# Nota\nñandú');
    fs.writeFileSync(path.join(workspace, 'raiz.txt'), 'en la raíz');
    // Archivos de datos que NUNCA deben poder borrarse ni leerse por esta ruta.
    const protegidos = [booted.ctx.config.dbFile, path.join(booted.dataDir, 'secret.key')];
    fs.writeFileSync(path.join(booted.dataDir, 'fuera.txt'), 'fuera del espacio de trabajo');
    protegidos.push(path.join(booted.dataDir, 'fuera.txt'));
    return { ...booted, workspace, protegidos, huellas: protegidos.map(sha) };
  }

  it('DELETE no puede salir del espacio de trabajo: 400, y los archivos de datos siguen existiendo intactos', async () => {
    const { protegidos, huellas } = await bootEnDisco();
    for (const ruta of [
      '../agentforge.db',
      '..%2Fsecret.key',
      '../fuera.txt',
      'docs/../../agentforge.db',
      '..%2F..%2Fsecret.key',
      '%2e%2e/agentforge.db',
      '..\\agentforge.db',
    ]) {
      const res = await del(`/api/workspace/file?path=${ruta}`);
      expect([400, 404], ruta).toContain(res.statusCode); // en Windows la barra invertida también separa; en otros sistemas es un nombre más
      if (!ruta.includes('\\')) expect(res.statusCode, ruta).toBe(400);
      expect(res.json().error, ruta).toBeTruthy();
    }
    const absoluta = await del(`/api/workspace/file?path=${encodeURIComponent(protegidos[0])}`);
    expect([400, 404]).toContain(absoluta.statusCode); // una ruta absoluta no sale del espacio de trabajo
    protegidos.forEach((p, i) => {
      expect(fs.existsSync(p), p).toBe(true);
      expect(sha(p), p).toBe(huellas[i]);
    });
  });

  it('DELETE con ruta vacía, sin ruta, un directorio o un archivo inexistente: 404 sin borrar nada', async () => {
    const { workspace } = await bootEnDisco();
    const casos = [
      '/api/workspace/file?path=',
      '/api/workspace/file',
      '/api/workspace/file?path=docs',
      '/api/workspace/file?path=docs/',
      '/api/workspace/file?path=.',
      '/api/workspace/file?path=no.md',
      '/api/workspace/file?path=docs/no.md',
      '/api/workspace/file?path=a%00b',
    ];
    for (const url of casos) {
      const res = await del(url);
      expect(res.statusCode, url).toBe(404);
      expect(res.json(), url).toMatchObject({ code: 'not_found', error: 'Archivo no encontrado.' });
    }
    expect(fs.existsSync(workspace)).toBe(true);
    expect(fs.existsSync(path.join(workspace, 'docs', 'nota.md'))).toBe(true);
    expect(fs.existsSync(path.join(workspace, 'raiz.txt'))).toBe(true);
  });

  it('DELETE borra de verdad un archivo (también con barra inicial) y solo ese; borrarlo otra vez da 404', async () => {
    const { workspace, protegidos } = await bootEnDisco();
    expect((await del('/api/workspace/file?path=docs/nota.md')).statusCode).toBe(204);
    expect(fs.existsSync(path.join(workspace, 'docs', 'nota.md'))).toBe(false);
    expect(fs.existsSync(path.join(workspace, 'docs'))).toBe(true); // el directorio se queda
    expect((await del('/api/workspace/file?path=docs/nota.md')).statusCode).toBe(404);
    expect((await del('/api/workspace/file?path=/raiz.txt')).statusCode).toBe(204);
    expect(fs.existsSync(path.join(workspace, 'raiz.txt'))).toBe(false);
    expect(await get('/api/workspace/files').then((r) => r.json())).toEqual([]);
    protegidos.forEach((p) => expect(fs.existsSync(p), p).toBe(true));
  });

  it('GET sin ruta o vacía da 400; un directorio o un archivo inexistente, 404; la salida del espacio de trabajo, 400 sin leer nada', async () => {
    await bootEnDisco();
    expect((await get('/api/workspace/file')).statusCode).toBe(400);
    expect((await get('/api/workspace/file')).json()).toMatchObject({ error: 'Falta el parámetro path.' });
    expect((await get('/api/workspace/file?path=')).statusCode).toBe(400);
    expect((await get('/api/workspace/file?path=docs')).statusCode).toBe(404);
    expect((await get('/api/workspace/file?path=no.md')).statusCode).toBe(404);
    for (const ruta of ['../agentforge.db', '..%2Fsecret.key', '../fuera.txt']) {
      const res = await get(`/api/workspace/file?path=${ruta}`);
      expect(res.statusCode, ruta).toBe(400);
      expect(res.body, ruta).not.toContain('fuera del espacio de trabajo"'); // el mensaje explica el motivo, no el contenido
      expect(res.body, ruta).not.toContain('SQLite format');
    }
    expect((await get('/api/workspace/file?path=docs/nota.md')).json()).toEqual({
      path: 'docs/nota.md',
      sizeBytes: Buffer.byteLength('# Nota\nñandú'),
      content: '# Nota\nñandú',
      truncated: false,
    });
  });

  it('GET trunca en el límite exacto: 500 000 bytes caben enteros y uno más se corta y se avisa', async () => {
    const { workspace } = await bootEnDisco();
    fs.writeFileSync(path.join(workspace, 'justo.txt'), 'a'.repeat(500_000));
    fs.writeFileSync(path.join(workspace, 'pasado.txt'), 'b'.repeat(500_001));
    const justo = (await get('/api/workspace/file?path=justo.txt')).json();
    expect(justo).toMatchObject({ sizeBytes: 500_000, truncated: false });
    expect(justo.content).toHaveLength(500_000);
    const pasado = (await get('/api/workspace/file?path=pasado.txt')).json();
    expect(pasado).toMatchObject({ sizeBytes: 500_001, truncated: true });
    expect(pasado.content).toHaveLength(500_000);
    expect(pasado.content).toBe('b'.repeat(500_000));
  });
});

// ───────────────────────────── A9 · web_fetch ─────────────────────────────

describe('web_fetch', () => {
  const registry = new ToolRegistry();
  const toolCtx = (allowPrivateNetwork: boolean, signal = new AbortController().signal): ToolContext => ({
    runId: 'r',
    nodeId: 'n',
    signal,
    workspaceDir: tempDir(),
    settings: { ...DEFAULT_SETTINGS, allowPrivateNetwork },
    memory: new Map(),
  });
  const fetchPage = (url: string, args: Record<string, unknown> = {}, allow = true) =>
    registry.invoke('web_fetch', { url, ...args }, toolCtx(allow)) as Promise<{ url: string; title: string | null; content: string }>;

  async function paginas() {
    const largo = Array.from({ length: 5000 }, (_, i) => `palabra${i}`).join(' ');
    const server = await startServer((request, res) => {
      const url = request.url ?? '/';
      const send = (status: number, type: string, body: string) => {
        res.writeHead(status, { 'Content-Type': type });
        res.end(body);
      };
      if (url === '/articulo') {
        return send(
          200,
          'text/html; charset=utf-8',
          '<!doctype html><html><head><title>  Mi página\n de pruebas </title><style>body{color:red}</style><script>window.secreto = "no debe salir"</script></head>' +
            '<body><!-- comentario oculto --><nav>Menú</nav><h1>Encabezado</h1><p>Primer <b>párrafo</b> con ñandú &amp; más.</p>' +
            '<script>alert("xss")</script><p>Segundo párrafo</p></body></html>',
        );
      }
      if (url === '/sin-tipo') return send(200, 'text/plain', '<!DOCTYPE html><html><head><title>Disfrazada</title></head><body><p>Hola</p></body></html>');
      if (url === '/texto') return send(200, 'text/plain; charset=utf-8', 'Línea 1\nLínea 2 con <b>etiquetas literales</b> y a < b');
      if (url === '/json') return send(200, 'application/json', '{"a":1,"html":"<p>x</p>"}');
      if (url === '/largo') return send(200, 'text/plain', largo);
      if (url === '/enorme') return send(200, 'text/plain', 'z'.repeat(2_000_000));
      if (url === '/origen') {
        res.writeHead(302, { Location: '/destino' });
        return res.end();
      }
      if (url === '/destino') return send(200, 'text/html', '<html><head><title>Destino</title></head><body>final</body></html>');
      if (url === '/roto') return send(500, 'text/plain', 'error interno');
      return send(404, 'text/html', '<html><body>No hay nada</body></html>');
    });
    cleanups.push(server.close);
    return { server, largo };
  }

  it('lee una página HTML real: título, texto legible, sin etiquetas, scripts, estilos ni comentarios', async () => {
    const { server } = await paginas();
    const page = await fetchPage(`${server.url}/articulo`);
    expect(page.url).toBe(`${server.url}/articulo`);
    expect(page.title).toBe('Mi página de pruebas');
    expect(page.content).toContain('Encabezado');
    expect(page.content).toContain('Primer párrafo con ñandú & más.');
    expect(page.content).toContain('Segundo párrafo');
    expect(page.content).not.toMatch(/[<>]/);
    expect(page.content).not.toContain('alert');
    expect(page.content).not.toContain('secreto');
    expect(page.content).not.toContain('color:red');
    expect(page.content).not.toContain('comentario oculto');
    expect(page.content.indexOf('Encabezado')).toBeLessThan(page.content.indexOf('Segundo párrafo'));
  });

  it('reconoce el HTML aunque el servidor lo anuncie como texto plano, y no toca el texto plano ni el JSON', async () => {
    const { server } = await paginas();
    const disfrazada = await fetchPage(`${server.url}/sin-tipo`);
    expect(disfrazada).toMatchObject({ title: 'Disfrazada', content: 'Hola' });
    const texto = await fetchPage(`${server.url}/texto`);
    expect(texto.title).toBeNull();
    expect(texto.content).toBe('Línea 1\nLínea 2 con <b>etiquetas literales</b> y a < b'); // es texto: no se «limpia»
    const json = await fetchPage(`${server.url}/json`);
    expect(json).toMatchObject({ title: null, content: '{"a":1,"html":"<p>x</p>"}' });
  });

  it('sigue las redirecciones y devuelve la URL final', async () => {
    const { server } = await paginas();
    const page = await fetchPage(`${server.url}/origen`);
    expect(page).toMatchObject({ url: `${server.url}/destino`, title: 'Destino', content: 'final' });
    expect(server.requests.map((r) => r.url)).toEqual(['/origen', '/destino']);
  });

  it('un 404 o un 500 son un error de herramienta con el código y el motivo, no contenido', async () => {
    const { server } = await paginas();
    await expect(fetchPage(`${server.url}/no-existe`)).rejects.toThrow('La página respondió 404 Not Found.');
    await expect(fetchPage(`${server.url}/roto`)).rejects.toThrow('La página respondió 500 Internal Server Error.');
    await expect(fetchPage(`${server.url}/no-existe`)).rejects.toBeInstanceOf(ToolError);
  });

  it('max_chars se recorta a 200–30 000: lo bajo sube a 200, lo enorme baja a 30 000, y sin valor son 6 000', async () => {
    const { server, largo } = await paginas();
    expect(largo.length).toBeGreaterThan(30_000);
    const marca = (n: number) => `…[truncado: ${n} caracteres más]`;
    const len = async (args: Record<string, unknown>) => (await fetchPage(`${server.url}/largo`, args)).content;

    const corto = await len({ max_chars: 50 });
    expect(corto).toBe(`${largo.slice(0, 200)}\n${marca(largo.length - 200)}`);
    const exacto = await len({ max_chars: 1234 });
    expect(exacto).toBe(`${largo.slice(0, 1234)}\n${marca(largo.length - 1234)}`);
    const enorme = await len({ max_chars: 10_000_000 });
    expect(enorme).toBe(`${largo.slice(0, 30_000)}\n${marca(largo.length - 30_000)}`);
    for (const defecto of [{}, { max_chars: 0 }]) {
      expect(await len(defecto)).toBe(`${largo.slice(0, 6000)}\n${marca(largo.length - 6000)}`);
    }
    await expect(fetchPage(`${server.url}/largo`, { max_chars: 'abc' })).rejects.toThrow('"max_chars" debe ser un número');
    // Un texto que ya cabe no se toca.
    expect((await fetchPage(`${server.url}/texto`, { max_chars: 200 })).content).not.toContain('truncado');
  });

  it('una respuesta enorme no cuelga ni revienta: devuelve el principio dentro del límite', async () => {
    const { server } = await paginas();
    const page = await fetchPage(`${server.url}/enorme`, { max_chars: 30_000 });
    expect(page.content.startsWith('z'.repeat(30_000))).toBe(true);
    expect(page.content.length).toBeLessThan(30_200);
  });

  it('con las redes privadas bloqueadas se rechaza sin tocar el servidor; con una URL no válida tampoco se conecta', async () => {
    const { server } = await paginas();
    await expect(fetchPage(`${server.url}/articulo`, {}, false)).rejects.toThrow(/red privada/);
    await expect(fetchPage(`${server.url}/origen`, {}, false)).rejects.toThrow(/red privada/);
    await expect(fetchPage('file:///etc/passwd')).rejects.toThrow(/Protocolo/);
    await expect(fetchPage('no es una url')).rejects.toThrow();
    await expect(registry.invoke('web_fetch', {}, toolCtx(true))).rejects.toThrow(/url/);
    expect(server.requests).toHaveLength(0);
  });

  it('cancelar la ejecución corta la descarga', async () => {
    const lento = await startServer((_request, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.write('empieza');
    });
    cleanups.push(lento.close);
    const controller = new AbortController();
    const pending = registry.invoke('web_fetch', { url: lento.url }, toolCtx(true, controller.signal));
    await until(() => lento.requests.length > 0, 'que el servidor reciba la petición');
    controller.abort(new Error('cancelada'));
    await expect(pending).rejects.toThrow();
  });

  it('el título y el texto decodifican las entidades una sola vez (&amp;lt; es el texto «&lt;», no «<»)', () => {
    expect(htmlTitle('<title>Ropa &amp; calzado</title>')).toBe('Ropa & calzado');
    expect(htmlTitle('<title>1 &lt; 2 &#8211; &quot;ok&quot;</title>')).toBe('1 < 2 – "ok"');
    expect(htmlToText('<p>&amp;lt;script&amp;gt;</p>')).toBe('&lt;script&gt;');
    expect(htmlToText('<p>a &lt; b &amp;&amp; c &gt; d</p>')).toBe('a < b && c > d');
  });
});

// ───────────────────────────── A4 · canales SSE ─────────────────────────────

interface SseMessage {
  event: string;
  id: string | null;
  data: any;
}
interface SseConnection {
  text(): string;
  messages: SseMessage[];
  close(): void;
}

/** Cliente SSE real (HTTP): lee los bloques que envía el servidor. */
function connectSse(url: string, headers: Record<string, string> = {}): Promise<SseConnection> {
  return new Promise((resolve, reject) => {
    const messages: SseMessage[] = [];
    let raw = '';
    let buffer = '';
    const request = http.get(url, { headers }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`El canal SSE respondió ${res.statusCode}`));
      }
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        raw += chunk;
        buffer += chunk;
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const event = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (event && data !== undefined) messages.push({ event, id: /^id: (.*)$/m.exec(block)?.[1] ?? null, data: JSON.parse(data) });
        }
      });
      const connection = { text: () => raw, messages, close: () => request.destroy() };
      cleanups.push(connection.close);
      resolve(connection);
    });
    request.on('error', () => undefined);
  });
}

describe('canales SSE por HTTP real', () => {
  const emitterOf = () => (ctx!.runs as unknown as { emitter: EventEmitter }).emitter;
  const listening = async () => {
    await app!.listen({ port: 0, host: '127.0.0.1' });
    return `http://127.0.0.1:${(app!.server.address() as AddressInfo).port}`;
  };
  const statusesOf = (conn: SseConnection, runId: string) => {
    const all = conn.messages.filter((m) => m.event === 'run' && m.data.id === runId).map((m) => m.data.status as string);
    return all.filter((s, i) => s !== all[i - 1]); // sin repeticiones seguidas
  };

  it('/api/stream/runs: avisa de cada cambio de una ejecución, de principio a fin, y empieza con retry: 2000', async () => {
    const llm = new ScriptedLlm(async (request) => {
      await delay(40);
      return { content: `eco(${userText(request)})` };
    });
    await boot({ llm });
    const base = await listening();
    const agent = addAgent(ctx!);
    const conn = await connectSse(`${base}/api/stream/runs`);
    expect(conn.text().startsWith('retry: 2000\n\n')).toBe(true);

    const run = (await post(`/api/agents/${agent.id}/run`, { input: 'sse' })).json() as Run;
    await until(() => conn.messages.some((m) => m.event === 'run' && m.data.id === run.id && m.data.status === 'completed'), 'el estado final');
    expect(statusesOf(conn, run.id)).toEqual(['queued', 'running', 'completed']);
    const last = conn.messages.filter((m) => m.data.id === run.id).at(-1)!;
    expect(last.data).toMatchObject({ status: 'completed', output: 'eco(sse)', kind: 'agent', name: agent.name });
    expect(last.data.snapshot).toBeUndefined(); // son resúmenes, no ejecuciones enteras
  });

  it('/api/stream/runs: también publica una ejecución cancelada y una fallida, con su error', async () => {
    const llm = new ScriptedLlm((request) => {
      if (userText(request) === 'colgar') return hangUntilAborted(request.signal);
      throw new LlmError('el modelo se rompió', { retryable: false });
    });
    await boot({ llm });
    const base = await listening();
    const agent = addAgent(ctx!);
    const conn = await connectSse(`${base}/api/stream/runs`);

    const colgada = (await post(`/api/agents/${agent.id}/run`, { input: 'colgar' })).json() as Run;
    await until(() => statusesOf(conn, colgada.id).includes('running'), 'que arranque');
    expect((await post(`/api/runs/${colgada.id}/cancel`)).statusCode).toBeLessThan(300);
    await until(() => statusesOf(conn, colgada.id).includes('cancelled'), 'la cancelación');
    expect(statusesOf(conn, colgada.id)).toEqual(['queued', 'running', 'cancelled']);

    const rota = (await post(`/api/agents/${agent.id}/run`, { input: 'romper' })).json() as Run;
    await until(() => statusesOf(conn, rota.id).includes('failed'), 'el fallo');
    expect(conn.messages.filter((m) => m.data.id === rota.id).at(-1)!.data).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('el modelo se rompió'),
    });
  });

  it('al cerrar la conexión el servidor retira la suscripción, y las siguientes ejecuciones no escriben en el socket cerrado', async () => {
    await boot();
    const base = await listening();
    const agent = addAgent(ctx!);
    const first = (await post(`/api/agents/${agent.id}/run`, { input: 'uno' })).json() as Run;
    await ctx!.runs.waitFor(first.id);
    const baselineRuns = emitterOf().listenerCount('runs');

    const general = await connectSse(`${base}/api/stream/runs`);
    const delRun = await connectSse(`${base}/api/runs/${first.id}/stream`);
    await until(
      () => emitterOf().listenerCount('runs') === baselineRuns + 1 && emitterOf().listenerCount(`run:${first.id}`) === 1,
      'que se registren las suscripciones',
    );
    general.close();
    delRun.close();
    await until(
      () => emitterOf().listenerCount('runs') === baselineRuns && emitterOf().listenerCount(`run:${first.id}`) === 0,
      'que se retiren las suscripciones',
    );

    const second = (await post(`/api/agents/${agent.id}/run`, { input: 'dos' })).json() as Run;
    await ctx!.runs.waitFor(second.id);
    expect(ctx!.store.getRunSummary(second.id)!.status).toBe('completed');
    expect(general.messages.some((m) => m.data.id === second.id)).toBe(false); // el cliente cerrado no recibió nada más
    expect((await get('/api/health')).statusCode).toBe(200);
    expect(emitterOf().listenerCount('runs')).toBe(baselineRuns);
  });

  it('/api/runs/:id/stream: 404 con un id inexistente, sin abrir ningún canal', async () => {
    await boot();
    const res = await get('/api/runs/run_no_existe/stream');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'not_found', error: 'Ejecución no encontrada.' });
    expect(res.headers['content-type']).toContain('application/json');
    expect(emitterOf().listenerCount('run:run_no_existe')).toBe(0);
  });

  it('/api/runs/:id/stream: quien se conecta a mitad de una respuesta recibe primero el texto parcial (llm.snapshot) y luego el resto', async () => {
    let soltar!: () => void;
    const puerta = new Promise<void>((resolve) => (soltar = resolve));
    const llm = new ScriptedLlm(async (request) => {
      request.onDelta?.('Hola, ');
      await puerta;
      return { content: 'mundo' };
    });
    await boot({ llm });
    const base = await listening();
    const agent = addAgent(ctx!);
    const run = (await post(`/api/agents/${agent.id}/run`, { input: 'x' })).json() as Run;
    await until(() => ctx!.runs.partials(run.id).length > 0, 'que el modelo haya escrito algo');

    const conn = await connectSse(`${base}/api/runs/${run.id}/stream`);
    const snapshot = await until(() => conn.messages.find((m) => m.data.type === 'llm.snapshot'), 'el texto parcial');
    expect(snapshot.data).toMatchObject({ seq: null, runId: run.id, nodeId: 'agent', data: { text: 'Hola, ' } });
    expect(snapshot.id).toBeNull(); // no es un evento persistido: no avanza Last-Event-ID
    expect(conn.messages.some((m) => m.data.type === 'run.finished')).toBe(false);

    soltar();
    await until(() => conn.messages.some((m) => m.data.type === 'run.finished'), 'el final de la ejecución');
    const tipos = conn.messages.map((m) => m.data.type as string);
    expect(tipos.indexOf('llm.snapshot')).toBeLessThan(tipos.indexOf('run.finished'));
    expect(conn.messages.at(-1)!.data).toMatchObject({ type: 'run.finished', data: { status: 'completed', output: 'mundo' } });
    // Lo persistido llega en orden y sin huecos.
    const seqs = conn.messages.map((m) => m.data.seq as number | null).filter((s): s is number => s !== null);
    expect(seqs).toEqual(seqs.map((_s, i) => i + 1));
  });
});

// ───────────────────────────── A8 · ramas de error del motor ─────────────────────────────

describe('motor: ramas de error', () => {
  const eventsOf = (run: Run, type: string) => ctx!.store.listEvents(run.id).filter((e) => e.type === type);

  it('un ciclo en la instantánea (se saltó la validación) falla con su mensaje, cierra la ejecución y libera la cola', async () => {
    await boot();
    ctx!.store.updateSettings({ maxConcurrentRuns: 1 });
    const run = await runWorkflow(ctx!, workflow([node('a', 'transform', { template: 'x' }), node('b', 'transform', { template: 'y' })], edges('a>b', 'b>a')));
    expect(run).toMatchObject({ status: 'failed', error: 'El workflow contiene un ciclo.' });
    expect(run.steps.map((s) => s.status)).not.toContain('running');
    expect(eventsOf(run, 'run.finished')).toHaveLength(1);
    expect(ctx!.runs.activeCount).toBe(0);
    const next = await runWorkflow(ctx!, workflow([node('t', 'transform', { template: 'ok' })], []));
    expect(next).toMatchObject({ status: 'completed', output: 'ok' }); // la cola sigue funcionando
  });

  it('un nodo cuyo agente no está en la instantánea falla sin llamar al modelo y sin reintentos, aunque se pidan', async () => {
    const llm = echo();
    await boot({ llm });
    const run = await runWorkflow(
      ctx!,
      workflow(
        [node('e', 'input'), node('a', 'agent', { agentId: 'agt_fantasma', prompt: '{{upstream}}' }), node('s', 'output', { template: '{{a}}' })],
        edges('e>a', 'a>s'),
        { defaultRetries: 3 },
      ),
    );
    expect(run.status).toBe('failed');
    expect(run.error).toBe('El nodo "a" falló: El nodo "a" no tiene un agente válido.');
    expect(run.steps.find((s) => s.nodeId === 'a')).toMatchObject({ status: 'failed', attempt: 1, error: 'El nodo "a" no tiene un agente válido.' });
    expect(eventsOf(run, 'step.retry')).toHaveLength(0);
    expect(llm.calls).toHaveLength(0);
  });

  it('un prompt que queda vacío tras renderizar falla con su mensaje; el valor por defecto de la entrada cubre una entrada vacía', async () => {
    const llm = echo();
    await boot({ llm });
    const agent = addAgent(ctx!);
    const vacio = await runWorkflow(
      ctx!,
      workflow([node('entrada', 'input'), node('a', 'agent', { agentId: agent.id, prompt: '{{entrada}}' })], edges('entrada>a')),
      '',
    );
    expect(vacio).toMatchObject({ status: 'failed', error: 'El nodo "a" falló: El nodo "a" generó un prompt vacío.' });
    expect(llm.calls).toHaveLength(0);

    const conDefecto = workflow(
      [node('entrada', 'input', { defaultValue: 'tema por defecto' }), node('a', 'agent', { agentId: agent.id, prompt: '{{entrada}}' })],
      edges('entrada>a'),
    );
    expect(await runWorkflow(ctx!, conDefecto, '')).toMatchObject({ status: 'completed', output: 'eco(tema por defecto)' });
    expect(await runWorkflow(ctx!, conDefecto, 'tema real')).toMatchObject({ status: 'completed', output: 'eco(tema real)' }); // la entrada manda
  });

  it.each([
    ['una comparación numérica con texto', { left: 'abc', operator: 'gt', right: '10' }, 'La condición numérica necesita números; se recibió "abc" y "10".'],
    ['un operador desconocido', { left: 'a', operator: 'raro', right: 'a' }, 'Operador de condición desconocido: raro'],
  ])('una condición que falla en ejecución (%s) falla el nodo y salta sus ramas por «Una dependencia ha fallado.»', async (_nombre, config, mensaje) => {
    await boot();
    const run = await runWorkflow(
      ctx!,
      workflow(
        [
          node('e', 'input'),
          node('ok', 'transform', { template: 'bien' }),
          node('fin', 'output', { template: '{{ok}}' }),
          node('c', 'condition', config),
          node('si', 'transform', { template: 'rama sí' }),
          node('no', 'transform', { template: 'rama no' }),
        ],
        edges('e>ok', 'ok>fin', 'e>c', 'c:true>si', 'c:false>no'),
        { onError: 'continue' },
      ),
    );
    expect(stepStatus(run)).toMatchObject({ c: 'failed', si: 'skipped', no: 'skipped', ok: 'completed', fin: 'completed' });
    expect(run.steps.find((s) => s.nodeId === 'c')!.error).toBe(mensaje);
    const motivos = Object.fromEntries(eventsOf(run, 'step.skipped').map((e) => [e.nodeId, e.data.reason]));
    expect(motivos).toEqual({ si: 'Una dependencia ha fallado.', no: 'Una dependencia ha fallado.' });
    expect(run).toMatchObject({ status: 'completed', output: 'bien' }); // la rama sana sigue
  });

  it('una condición que se evalúa bien salta la otra rama con el motivo «Rama no tomada.»', async () => {
    await boot();
    const run = await runWorkflow(
      ctx!,
      workflow(
        [
          node('e', 'input'),
          node('c', 'condition', { left: 'a', operator: 'equals', right: 'A' }),
          node('si', 'transform', { template: 'sí' }),
          node('no', 'transform', { template: 'no' }),
        ],
        edges('e>c', 'c:true>si', 'c:false>no'),
      ),
    );
    expect(stepStatus(run)).toMatchObject({ c: 'completed', si: 'completed', no: 'skipped' });
    expect(eventsOf(run, 'step.skipped').map((e) => [e.nodeId, e.data.reason])).toEqual([['no', 'Rama no tomada.']]);
  });

  it('«Ningún nodo de salida llegó a ejecutarse»: todas las salidas se saltaron por una condición', async () => {
    await boot();
    const def = workflow(
      [node('e', 'input'), node('c', 'condition', { left: 'a', operator: 'equals', right: 'b' }), node('s', 'output', { template: 'nunca' })],
      edges('e>c', 'c:true>s'),
    );
    for (const onError of ['fail', 'continue'] as const) {
      const run = await runWorkflow(ctx!, { ...def, settings: { ...def.settings, onError } });
      expect(run).toMatchObject({ status: 'failed', output: null, error: 'Ningún nodo de salida llegó a ejecutarse.' });
      expect(stepStatus(run)).toMatchObject({ c: 'completed', s: 'skipped' });
    }
  });

  it('cancelar durante la espera entre reintentos deja el paso CANCELADO (no fallido) y no hace otro intento', async () => {
    const llm = new ScriptedLlm(() => {
      throw new LlmError('503 saturado', { retryable: true });
    });
    await boot({ llm, retryBaseDelayMs: 30_000 });
    const agent = addAgent(ctx!);
    const wf = ctx!.store.createWorkflow(workflow([node('a', 'agent', { agentId: agent.id, prompt: '{{input}}', retries: 2 })], []));
    const run = ctx!.runs.startWorkflowRun(wf, 'x');
    const retry = await until(() => ctx!.store.listEvents(run.id).find((e) => e.type === 'step.retry'), 'el primer reintento programado');
    expect(retry.data).toMatchObject({ attempt: 1, error: '503 saturado', delayMs: 30_000 });
    const started = Date.now();
    expect(ctx!.runs.cancel(run.id)).toBe(true);
    await ctx!.runs.waitFor(run.id);
    expect(Date.now() - started).toBeLessThan(5000); // no esperó los 30 s
    const done = ctx!.store.getRun(run.id)!;
    expect(done).toMatchObject({ status: 'cancelled', error: 'Ejecución cancelada por el usuario.' });
    expect(done.steps[0]).toMatchObject({ status: 'cancelled', attempt: 1 });
    expect(llm.calls).toHaveLength(1);
    expect(
      ctx!.store
        .listEvents(run.id)
        .filter((e) => e.type === 'step.finished')
        .map((e) => e.data.status),
    ).toEqual(['cancelled']);
  });

  it('un nodo de herramienta reintenta los fallos transitorios, deja cada intento en tool.result y suma las llamadas', async () => {
    await boot();
    let intentos = 0;
    ctx!.tools.register({
      name: 'inestable',
      title: 'Inestable',
      description: 'Falla las dos primeras veces',
      category: 'Pruebas',
      parameters: { type: 'object', properties: { x: { type: 'string' } } },
      async execute(args) {
        intentos++;
        if (intentos < 3) throw new ToolError(`fallo ${intentos}`, { retryable: true });
        return { recibido: args.x };
      },
    });
    const run = await runWorkflow(ctx!, workflow([node('t', 'tool', { tool: 'inestable', args: { x: '{{input}}' }, retries: 2 })], []), 'dato');
    expect(run).toMatchObject({ status: 'completed', output: expect.stringContaining('dato') });
    expect(run.steps[0]).toMatchObject({ status: 'completed', attempt: 3, usage: { toolCalls: 3 } });
    expect(eventsOf(run, 'step.retry').map((e) => e.data.error)).toEqual(['fallo 1', 'fallo 2']);
    expect(eventsOf(run, 'tool.result').map((e) => [e.data.name, e.data.ok])).toEqual([
      ['inestable', false],
      ['inestable', false],
      ['inestable', true],
    ]);
    expect(eventsOf(run, 'tool.result')[0].data.result).toBe('Error: fallo 1');
  });

  it('un nodo de herramienta que no termina falla al vencer su tiempo máximo con el mensaje del nodo', async () => {
    await boot();
    ctx!.tools.register({
      name: 'colgada',
      title: 'Colgada',
      description: 'No termina hasta que la cancelan',
      category: 'Pruebas',
      parameters: { type: 'object', properties: {} },
      execute: (_args, tc) => hangUntilAborted(tc.signal),
    });
    const run = await runWorkflow(ctx!, workflow([node('t', 'tool', { tool: 'colgada', timeoutMs: 80 })], []));
    expect(run).toMatchObject({ status: 'failed', error: 'El nodo "t" falló: El nodo superó su tiempo máximo (80 ms).' });
    expect(run.steps[0]).toMatchObject({ status: 'failed', error: 'El nodo superó su tiempo máximo (80 ms).' });
  });

  it('las salidas de más de 200 000 caracteres se truncan y las plantillas se resuelven dentro de listas, objetos y con {{date}}', async () => {
    await boot();
    ctx!.tools.register({
      name: 'gigante',
      title: 'Gigante',
      description: 'Devuelve mucho texto',
      category: 'Pruebas',
      parameters: { type: 'object', properties: {} },
      execute: async () => 'x'.repeat(250_000),
    });
    ctx!.tools.register({
      name: 'devuelve_args',
      title: 'Devuelve args',
      description: 'Devuelve lo que recibe',
      category: 'Pruebas',
      parameters: { type: 'object', properties: {} },
      passthroughArgs: true,
      execute: async (args) => args,
    });
    const grande = await runWorkflow(ctx!, workflow([node('g', 'tool', { tool: 'gigante' })], []));
    const salida = grande.steps[0].output!;
    expect(salida.startsWith('x'.repeat(200_000))).toBe(true);
    expect(salida.endsWith('…[truncado: 50000 caracteres más]')).toBe(true);
    expect(salida.length).toBeLessThan(200_100);
    expect(eventsOf(grande, 'tool.result')[0].data.result.length).toBeLessThan(12_100); // el evento lleva menos

    const hoy = new Date().toLocaleDateString('sv-SE');
    const run = await runWorkflow(
      ctx!,
      workflow([node('d', 'tool', { tool: 'devuelve_args', args: { lista: ['{{input}}', 'fijo', { anidado: '{{date}}' }], n: 5, activo: true } })], []),
      'valor',
    );
    expect(JSON.parse(run.steps[0].output!)).toEqual({ lista: ['valor', 'fijo', { anidado: hoy }], n: 5, activo: true });
  });
});

describe('ejecutor de agentes: ramas de error', () => {
  const who = (request: Parameters<typeof systemText>[0]) => /«([^»]+)»/.exec(systemText(request))?.[1] ?? '?';
  const toolMessages = (request: Parameters<typeof systemText>[0]) => request.messages.filter((m) => m.role === 'tool').map((m) => m.content);

  it('un proveedor desactivado y un agente sin modelo fallan con un error de configuración, sin llamar al modelo ni reintentar', async () => {
    const llm = echo();
    await boot({ llm });
    const agent = addAgent(ctx!, { name: 'Sin modelo', model: '' });
    const sinModelo = ctx!.runs.startAgentRun(agent, 'hola');
    await ctx!.runs.waitFor(sinModelo.id);
    expect(ctx!.store.getRunSummary(sinModelo.id)).toMatchObject({
      status: 'failed',
      error: 'El nodo "Sin modelo" falló: El agente «Sin modelo» no tiene modelo configurado.',
    });

    const provider = ctx!.store.getProvider(agent.providerId)!;
    ctx!.store.updateProvider(provider.id, {
      name: provider.name,
      kind: provider.kind,
      baseUrl: provider.baseUrl,
      defaultModel: provider.defaultModel,
      enabled: false,
    });
    const conModelo = addAgent(ctx!, { name: 'Con modelo' });
    const desactivado = ctx!.runs.startAgentRun(conModelo, 'hola');
    await ctx!.runs.waitFor(desactivado.id);
    expect(ctx!.store.getRunSummary(desactivado.id)).toMatchObject({
      status: 'failed',
      error: expect.stringContaining(`El proveedor «${provider.name}» está desactivado.`),
    });
    expect(llm.calls).toHaveLength(0);
    expect(ctx!.store.listEvents(desactivado.id).filter((e) => e.type === 'step.retry')).toHaveLength(0);
  });

  it('la delegación tiene profundidad máxima: A→B→C funciona, pero C ya no recibe delegate_task (y D nunca se llama)', async () => {
    const herramientas: Record<string, string[]> = {};
    const llm = new ScriptedLlm((request) => {
      const nombre = who(request);
      herramientas[nombre] = (request.tools ?? []).map((t) => t.name);
      const siguiente: Record<string, string> = { A: 'B', B: 'C', C: 'D' };
      if (lastMessage(request).role === 'tool') return { content: `${nombre} ok` };
      return { toolCalls: [{ id: `d_${nombre}`, name: 'delegate_task', arguments: { agent: siguiente[nombre], task: `trabajo de ${nombre}` } }] };
    });
    await boot({ llm });
    const [a] = ['A', 'B', 'C', 'D'].map((name) => addAgent(ctx!, { name, tools: ['delegate_task'] }));
    const run = ctx!.runs.startAgentRun(a, 'empieza');
    await ctx!.runs.waitFor(run.id);
    const hecho = ctx!.store.getRun(run.id)!;
    expect(hecho).toMatchObject({ status: 'completed', output: 'A ok' });
    expect(herramientas.A).toContain('delegate_task');
    expect(herramientas.B).toContain('delegate_task');
    expect(herramientas.C).toEqual([]); // profundidad 2: ya no se ofrece
    expect(Object.keys(herramientas).sort()).toEqual(['A', 'B', 'C']); // D no llegó a ejecutarse
    // C intentó delegar igualmente: el modelo recibe el error y puede seguir, no se rompe la ejecución.
    const rechazo = ctx!.store.listEvents(run.id).find((e) => e.type === 'tool.result' && e.data.agent === 'C')!;
    expect(rechazo.data).toMatchObject({ ok: false, depth: 2, result: 'Error: La herramienta "delegate_task" no está disponible. Disponibles: ninguna.' });
  });

  it('sin otros agentes a quien delegar, delegate_task no se ofrece al modelo', async () => {
    const llm = new ScriptedLlm(() => ({ content: 'hecho' }));
    await boot({ llm });
    const solo = addAgent(ctx!, { name: 'Solo', tools: ['delegate_task', 'calculator'] });
    const run = ctx!.runs.startAgentRun(solo, 'x');
    await ctx!.runs.waitFor(run.id);
    expect(llm.calls[0].tools?.map((t) => t.name)).toEqual(['calculator']);
    const conOtro = addAgent(ctx!, { name: 'Compañero', role: 'ayuda' });
    const run2 = ctx!.runs.startAgentRun(solo, 'x');
    await ctx!.runs.waitFor(run2.id);
    const delegar = llm.calls[1].tools!.find((t) => t.name === 'delegate_task')!;
    expect(delegar.description).toContain(`- ${conOtro.name}: ayuda`); // la lista de agentes disponibles excluye al propio
    expect(delegar.description).not.toContain('- Solo:');
  });

  it('delegar en un agente inexistente o en sí mismo devuelve el error al modelo; el nombre se admite sin mayúsculas ni espacios', async () => {
    let finales: string[] = [];
    const llm = new ScriptedLlm((request) => {
      const nombre = who(request);
      if (nombre === 'Colega') return { content: 'hecho por Colega' };
      const hechas = toolMessages(request).length;
      const destino = ['Fantasma', 'Jefe', '  colega '][hechas];
      if (destino) return { toolCalls: [{ id: `d${hechas}`, name: 'delegate_task', arguments: { agent: destino, task: 'haz algo' } }] };
      finales = toolMessages(request);
      return { content: 'fin' };
    });
    await boot({ llm });
    const jefe = addAgent(ctx!, { name: 'Jefe', tools: ['delegate_task'] });
    addAgent(ctx!, { name: 'Colega' });
    const run = ctx!.runs.startAgentRun(jefe, 'x');
    await ctx!.runs.waitFor(run.id);
    expect(ctx!.store.getRunSummary(run.id)).toMatchObject({ status: 'completed', output: 'fin' });
    expect(finales).toHaveLength(3);
    expect(finales[0]).toBe('Error: No existe ningún agente llamado "Fantasma".');
    expect(finales[1]).toBe('Error: Un agente no puede delegar en sí mismo.');
    expect(finales[2]).toContain('hecho por Colega');
    expect(
      ctx!.store
        .listEvents(run.id)
        .filter((e) => e.type === 'tool.result' && e.data.depth === 0)
        .map((e) => e.data.ok),
    ).toEqual([false, false, true]);
  });

  it('un límite alcanzado DENTRO de una delegación aborta la ejecución, no se le devuelve al modelo como resultado de herramienta', async () => {
    const llm = new ScriptedLlm((request) => ({
      toolCalls: [{ id: 'd', name: 'delegate_task', arguments: { agent: 'Ayudante', task: `de ${who(request)}` } }],
    }));
    await boot({ llm });
    const jefe = addAgent(ctx!, { name: 'Jefe', tools: ['delegate_task'] });
    addAgent(ctx!, { name: 'Ayudante' });
    const run = ctx!.runs.startAgentRun(jefe, 'x', { maxLlmCalls: 1 });
    await ctx!.runs.waitFor(run.id);
    const hecho = ctx!.store.getRunSummary(run.id)!;
    expect(hecho.status).toBe('failed');
    expect(hecho.error).toContain('Se alcanzó el límite de 1 llamadas al modelo para esta ejecución.');
    expect(llm.calls).toHaveLength(1); // el ayudante no llegó a llamar al modelo
    expect(ctx!.store.listEvents(run.id).filter((e) => e.type === 'tool.result')).toHaveLength(0);
    expect(ctx!.store.listEvents(run.id).filter((e) => e.type === 'step.retry')).toHaveLength(0);
  });
});

// ───────────────────────────── M4 · manejador de errores de la API ─────────────────────────────

describe('manejador de errores de la API', () => {
  it('JSON mal formado: 400 con un mensaje y code bad_request, no un error interno', async () => {
    await boot();
    const res = await app!.inject({ method: 'POST', url: '/api/agents', headers: { 'content-type': 'application/json' }, payload: '{"name":' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'bad_request', error: expect.any(String) });
    expect(res.json().error).not.toBe('Error interno del servidor.');
  });

  it('un cuerpo de más de 2 MB: 413 con code payload_too_large', async () => {
    await boot();
    const res = await app!.inject({
      method: 'POST',
      url: '/api/agents',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'x'.repeat(3 * 1024 * 1024) }),
    });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ code: 'payload_too_large' });
    const justo = await app!.inject({
      method: 'POST',
      url: '/api/agents',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'x'.repeat(100_000) }),
    });
    expect(justo.statusCode).toBe(400); // un cuerpo grande pero admitido llega a la validación (el nombre es demasiado largo)
    expect(justo.json().code).toBe('validation');
  });

  it('validation: 400 con los problemas campo a campo (path y message) y el primero en el texto', async () => {
    await boot();
    const res = await post('/api/agents', {});
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.code).toBe('validation');
    expect(body.issues.length).toBeGreaterThan(0);
    for (const issue of body.issues) expect(issue).toEqual({ path: expect.any(String), message: expect.any(String) });
    expect(body.issues.map((i: { path: string }) => i.path)).toContain('name');
    expect(body.error).toBe(`Datos no válidos: ${body.issues[0].path}: ${body.issues[0].message}`);
  });

  it('not_found: 404 con code y mensaje cuando no existe el recurso', async () => {
    await boot();
    const agente = await get('/api/agents/agt_no_existe');
    expect(agente.statusCode).toBe(404);
    expect(agente.json()).toEqual({ error: 'Agente no encontrado.', code: 'not_found' });
  });

  // La interfaz usa el código para mostrar el error en el idioma elegido: también las rutas que no existen lo llevan.
  it('not_found: una ruta de la API que no existe también lleva code', async () => {
    await boot();
    const ruta = await get('/api/no-existe');
    expect(ruta.statusCode).toBe(404);
    expect(ruta.json()).toEqual({ error: 'Ruta no encontrada.', code: 'not_found' });
  });

  it('provider_error: un proveedor que no responde es un 502 con el motivo', async () => {
    await boot({ llm: defaultLlmFactory });
    const provider = ctx!.store.createProvider({ name: 'Caído', kind: 'ollama', baseUrl: 'http://127.0.0.1:1', defaultModel: '', enabled: true });
    const res = await get(`/api/providers/${provider.id}/models`);
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ code: 'provider_error', error: expect.stringMatching(/No se pudo conectar/) });
  });

  it('tool_error y config_error: 400 y 409 con su código y su mensaje (un ToolError y un ConfigError que llegan hasta la API)', async () => {
    await boot();
    app!.get('/api/_prueba/herramienta', async () => {
      throw new ToolError('argumentos inválidos para la herramienta');
    });
    app!.get('/api/_prueba/configuracion', async () => {
      throw new ConfigError('el proveedor está desactivado');
    });
    const herramienta = await get('/api/_prueba/herramienta');
    expect(herramienta.statusCode).toBe(400);
    expect(herramienta.json()).toEqual({ error: 'argumentos inválidos para la herramienta', code: 'tool_error' });
    const configuracion = await get('/api/_prueba/configuracion');
    expect(configuracion.statusCode).toBe(409);
    expect(configuracion.json()).toEqual({ error: 'el proveedor está desactivado', code: 'config_error' });
  });

  it('rate_limited: 429 con code y Retry-After', async () => {
    await boot({ config: { rateLimitPerMinute: 2 } });
    await get('/api/health');
    await get('/api/health');
    const res = await get('/api/health');
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ code: 'rate_limited', error: expect.stringMatching(/Demasiadas peticiones/) });
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('internal: un fallo inesperado es un 500 genérico que no revela el mensaje de SQLite ni nombres de tablas', async () => {
    await boot();
    ctx!.db.exec('DROP TABLE agents');
    const res = await get('/api/agents');
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'Error interno del servidor.', code: 'internal' });
    expect(res.body).not.toMatch(/agents|sqlite|no such table/i);
  });
});

// ───────────────────────────── M7 · reglas de validateWorkflow ─────────────────────────────

describe('validateWorkflow: una regla por código', () => {
  type Def = { nodes: WorkflowNode[]; edges: WorkflowEdge[] };
  interface Caso {
    def: Def;
    ctx?: { workflows?: Array<{ id: string; name: string; nodes: WorkflowNode[] }>; selfId?: string | null };
    level: 'error' | 'warning';
    nodeId?: string;
    params: IssueParams;
  }
  const n = (id: string, type: string, config: Record<string, any> = {}) => node(id, type as WorkflowNode['type'], config);
  const e = (id: string, source: string, target: string, sourceHandle: string | null = null): WorkflowEdge => ({ id, source, target, sourceHandle });
  const sub = (id: string, workflowId: string) => n(id, 'subworkflow', { workflowId, input: 'x' });
  const cadena = (total: number) =>
    Array.from({ length: total }, (_, i) => ({ id: `w${i + 1}`, name: `W${i + 1}`, nodes: i + 1 < total ? [sub('s', `w${i + 2}`)] : [] }));

  // `satisfies Record<ValidationCode, Caso>`: si se añade un código a la tabla de mensajes sin su caso, no compila.
  const CASOS = {
    empty: { def: { nodes: [], edges: [] }, level: 'error', params: {} },
    subworkflowUnset: { def: { nodes: [n('s', 'subworkflow', { input: 'x' })], edges: [] }, level: 'error', nodeId: 's', params: { name: 's' } },
    subworkflowSelf: { def: { nodes: [sub('s', 'wf_self')], edges: [] }, ctx: { selfId: 'wf_self' }, level: 'error', nodeId: 's', params: { name: 's' } },
    subworkflowGone: { def: { nodes: [sub('s', 'wf_x')], edges: [] }, ctx: { workflows: [] }, level: 'error', nodeId: 's', params: { name: 's' } },
    subworkflowCycleSelf: {
      def: { nodes: [sub('s', 'wf_b')], edges: [] },
      ctx: { selfId: 'wf_self', workflows: [{ id: 'wf_b', name: 'B', nodes: [sub('x', 'wf_self')] }] },
      level: 'error',
      nodeId: 's',
      params: { workflow: 'B', name: 's', max: MAX_SUBWORKFLOW_DEPTH },
    },
    subworkflowCycle: {
      def: { nodes: [sub('s', 'wf_b')], edges: [] },
      ctx: {
        workflows: [
          { id: 'wf_b', name: 'B', nodes: [sub('x', 'wf_c')] },
          { id: 'wf_c', name: 'C', nodes: [sub('y', 'wf_b')] },
        ],
      },
      level: 'error',
      nodeId: 's',
      params: { workflow: 'B', name: 's', max: MAX_SUBWORKFLOW_DEPTH },
    },
    subworkflowDepth: {
      def: { nodes: [sub('s', 'w1')], edges: [] },
      ctx: { workflows: cadena(MAX_SUBWORKFLOW_DEPTH + 2) },
      level: 'error',
      nodeId: 's',
      params: { workflow: 'W1', name: 's', max: MAX_SUBWORKFLOW_DEPTH },
    },
    nodeIdInvalid: { def: { nodes: [n('a b', 'transform', { template: 'x' })], edges: [] }, level: 'error', nodeId: 'a b', params: { id: 'a b' } },
    nodeIdReserved: { def: { nodes: [n('input', 'transform', { template: 'x' })], edges: [] }, level: 'error', nodeId: 'input', params: { id: 'input' } },
    nodeIdDuplicate: {
      def: { nodes: [n('a', 'transform', { template: 'x' }), n('a', 'transform', { template: 'y' })], edges: [] },
      level: 'error',
      nodeId: 'a',
      params: { id: 'a' },
    },
    multipleInputs: { def: { nodes: [n('i1', 'input'), n('i2', 'input')], edges: [] }, level: 'error', params: {} },
    edgeDangling: { def: { nodes: [n('a', 'transform', { template: 'x' })], edges: [e('e1', 'a', 'fantasma')] }, level: 'error', params: { id: 'e1' } },
    selfLoop: { def: { nodes: [n('a', 'transform', { template: 'x' })], edges: [e('e1', 'a', 'a')] }, level: 'error', nodeId: 'a', params: {} },
    duplicateEdges: {
      def: { nodes: [n('a', 'transform', { template: 'x' }), n('b', 'transform', { template: 'y' })], edges: [e('e1', 'a', 'b'), e('e2', 'a', 'b')] },
      level: 'warning',
      nodeId: 'a',
      params: {},
    },
    cycle: {
      def: { nodes: [n('a', 'transform', { template: 'x' }), n('b', 'transform', { template: 'y' })], edges: [e('e1', 'a', 'b'), e('e2', 'b', 'a')] },
      level: 'error',
      params: {},
    },
    inputHasIncoming: {
      def: { nodes: [n('t', 'transform', { template: 'x' }), n('i', 'input')], edges: [e('e1', 't', 'i')] },
      level: 'error',
      nodeId: 'i',
      params: { name: 'i' },
    },
    inputUnconnected: { def: { nodes: [n('i', 'input')], edges: [] }, level: 'warning', nodeId: 'i', params: { name: 'i' } },
    agentUnset: { def: { nodes: [n('a', 'agent', { prompt: 'x' })], edges: [] }, level: 'error', nodeId: 'a', params: { name: 'a' } },
    agentGone: { def: { nodes: [n('a', 'agent', { agentId: 'otro', prompt: 'x' })], edges: [] }, level: 'error', nodeId: 'a', params: { name: 'a' } },
    promptEmpty: { def: { nodes: [n('a', 'agent', { agentId: 'ag', prompt: '   ' })], edges: [] }, level: 'error', nodeId: 'a', params: { name: 'a' } },
    toolUnset: { def: { nodes: [n('t', 'tool', {})], edges: [] }, level: 'error', nodeId: 't', params: { name: 't' } },
    toolUnknown: { def: { nodes: [n('t', 'tool', { tool: 'no_existe' })], edges: [] }, level: 'error', nodeId: 't', params: { name: 't', tool: 'no_existe' } },
    conditionNoOperator: {
      def: { nodes: [n('i', 'input'), n('c', 'condition', { left: 'a', right: 'b' })], edges: [e('e1', 'i', 'c')] },
      level: 'error',
      nodeId: 'c',
      params: { name: 'c' },
    },
    conditionBadRegex: {
      def: { nodes: [n('i', 'input'), n('c', 'condition', { operator: 'matches', right: '(' })], edges: [e('e1', 'i', 'c')] },
      level: 'error',
      nodeId: 'c',
      params: { name: 'c' },
    },
    conditionEmptyRight: {
      def: { nodes: [n('i', 'input'), n('c', 'condition', { operator: 'equals', right: '' })], edges: [e('e1', 'i', 'c')] },
      level: 'warning',
      nodeId: 'c',
      params: { name: 'c' },
    },
    conditionBadBranch: {
      def: {
        nodes: [n('i', 'input'), n('c', 'condition', { operator: 'equals', right: 'a' }), n('t', 'transform', { template: 'x' })],
        edges: [e('e1', 'i', 'c'), e('e2', 'c', 't')],
      },
      level: 'error',
      nodeId: 'c',
      params: { name: 'c' },
    },
    conditionNoBranches: {
      def: { nodes: [n('i', 'input'), n('c', 'condition', { operator: 'equals', right: 'a' })], edges: [e('e1', 'i', 'c')] },
      level: 'warning',
      nodeId: 'c',
      params: { name: 'c' },
    },
    conditionNoIncoming: {
      def: { nodes: [n('c', 'condition', { operator: 'equals', right: 'a' })], edges: [] },
      level: 'error',
      nodeId: 'c',
      params: { name: 'c' },
    },
    templateEmpty: { def: { nodes: [n('t', 'transform', { template: '' })], edges: [] }, level: 'error', nodeId: 't', params: { name: 't' } },
    foreachTaskEmpty: {
      def: { nodes: [n('f', 'foreach', { agentId: 'ag', items: 'a, b', prompt: '' })], edges: [] },
      level: 'error',
      nodeId: 'f',
      params: { name: 'f' },
    },
    foreachTaskNoItem: {
      def: { nodes: [n('f', 'foreach', { agentId: 'ag', items: 'a, b', prompt: 'sin referencia' })], edges: [] },
      level: 'warning',
      nodeId: 'f',
      params: { name: 'f' },
    },
    foreachArgsNoItem: {
      def: { nodes: [n('f', 'foreach', { body: 'tool', tool: 'calculator', items: 'a, b', args: { x: '1' } })], edges: [] },
      level: 'warning',
      nodeId: 'f',
      params: { name: 'f' },
    },
    foreachBadPolicy: {
      def: { nodes: [n('f', 'foreach', { agentId: 'ag', items: 'a, b', prompt: '{{item}}', onItemError: 'raro' })], edges: [] },
      level: 'error',
      nodeId: 'f',
      params: { name: 'f' },
    },
    foreachNoList: {
      def: { nodes: [n('f', 'foreach', { agentId: 'ag', prompt: '{{item}}' })], edges: [] },
      level: 'error',
      nodeId: 'f',
      params: { name: 'f' },
    },
    foreachListUsesItem: {
      def: { nodes: [n('f', 'foreach', { agentId: 'ag', items: '{{item}}', prompt: '{{item}}' })], edges: [] },
      level: 'error',
      nodeId: 'f',
      params: { name: 'f' },
    },
    foreachConcurrencyRange: {
      def: { nodes: [n('f', 'foreach', { agentId: 'ag', items: 'a', prompt: '{{item}}', concurrency: 0 })], edges: [] },
      level: 'error',
      nodeId: 'f',
      params: { name: 'f', max: expect.any(Number) },
    },
    foreachMaxItemsRange: {
      def: { nodes: [n('f', 'foreach', { agentId: 'ag', items: 'a', prompt: '{{item}}', maxItems: 0 })], edges: [] },
      level: 'error',
      nodeId: 'f',
      params: { name: 'f', max: expect.any(Number) },
    },
    subworkflowNoInput: {
      def: { nodes: [n('s', 'subworkflow', { workflowId: 'wf_b' })], edges: [] },
      ctx: { workflows: [{ id: 'wf_b', name: 'B', nodes: [] }] },
      level: 'error',
      nodeId: 's',
      params: { name: 's' },
    },
    approvalNoMessage: { def: { nodes: [n('p', 'approval', {})], edges: [] }, level: 'error', nodeId: 'p', params: { name: 'p' } },
    approvalBadBranch: {
      def: { nodes: [n('p', 'approval', { message: '¿Seguimos?' }), n('t', 'transform', { template: 'x' })], edges: [e('e1', 'p', 't')] },
      level: 'error',
      nodeId: 'p',
      params: { name: 'p' },
    },
    approvalNoBranches: { def: { nodes: [n('p', 'approval', { message: '¿Seguimos?' })], edges: [] }, level: 'warning', nodeId: 'p', params: { name: 'p' } },
    outputHasOutgoing: {
      def: { nodes: [n('o', 'output', { template: 'x' }), n('t', 'transform', { template: 'y' })], edges: [e('e1', 'o', 't')] },
      level: 'error',
      nodeId: 'o',
      params: { name: 'o' },
    },
    outputNoIncoming: { def: { nodes: [n('o', 'output', { template: 'x' })], edges: [] }, level: 'error', nodeId: 'o', params: { name: 'o' } },
    unknownNodeType: { def: { nodes: [n('x', 'raro')], edges: [] }, level: 'error', nodeId: 'x', params: { type: 'raro' } },
    upstreamNoIncoming: {
      def: { nodes: [n('t', 'transform', { template: '{{upstream}}' })], edges: [] },
      level: 'warning',
      nodeId: 't',
      params: { name: 't' },
    },
    foreachRefOutside: {
      def: { nodes: [n('t', 'transform', { template: '{{item}}' })], edges: [] },
      level: 'error',
      nodeId: 't',
      params: { name: 't', ref: 'item' },
    },
    refMissing: {
      def: { nodes: [n('t', 'transform', { template: '{{fantasma}}' })], edges: [] },
      level: 'error',
      nodeId: 't',
      params: { name: 't', ref: 'fantasma' },
    },
    refNotAncestor: {
      def: { nodes: [n('a', 'transform', { template: 'x' }), n('b', 'transform', { template: '{{a}}' })], edges: [] },
      level: 'error',
      nodeId: 'b',
      params: { name: 'b', ref: 'a' },
    },
    refNoComment: {
      def: { nodes: [n('a', 'transform', { template: 'x' }), n('b', 'transform', { template: '{{a.comment}}' })], edges: [e('e1', 'a', 'b')] },
      level: 'error',
      nodeId: 'b',
      params: { name: 'b', ref: 'a.comment' },
    },
    noWork: { def: { nodes: [n('i', 'input'), n('o', 'output', { template: '{{input}}' })], edges: [e('e1', 'i', 'o')] }, level: 'warning', params: {} },
  } satisfies Record<ValidationCode, Caso>;

  const entries = Object.entries(CASOS) as Array<[ValidationCode, Caso]>;

  it('hay un caso para cada código de la tabla de mensajes (ni más ni menos)', () => {
    expect(Object.keys(CASOS).sort()).toEqual(Object.keys(VALIDATION_MESSAGES).sort());
  });

  it.each(entries)('%s: el workflow que lo produce lo señala con su nivel, nodo, parámetros y texto', (code, caso) => {
    const issues = validateWorkflow(caso.def, { agentIds: ['ag'], toolNames: ['calculator'], ...caso.ctx });
    const found = issues.filter((i) => i.code === code);
    expect(found.length, `ningún problema ${code} en: ${issues.map((i) => i.code).join(', ')}`).toBeGreaterThan(0);
    const issue = found[0];
    expect(issue.level).toBe(caso.level);
    expect(issue.nodeId).toBe(caso.nodeId);
    expect(issue.params).toEqual(caso.params);
    expect(issue.message).toBe(VALIDATION_MESSAGES[code](issue.params as IssueParams)); // el texto sale del código y los parámetros
    expect(issue.message.length).toBeGreaterThan(10);
  });

  it('cada problema de cualquier caso lleva code y params, y todos los códigos se han podido provocar', () => {
    const vistos = new Set<string>();
    for (const [, caso] of entries) {
      for (const issue of validateWorkflow(caso.def, { agentIds: ['ag'], toolNames: ['calculator'], ...caso.ctx })) {
        expect(issue.code, issue.message).toBeTruthy();
        expect(issue.params, issue.message).toBeTruthy();
        vistos.add(issue.code!);
      }
    }
    expect([...vistos].sort()).toEqual(Object.keys(VALIDATION_MESSAGES).sort());
  });

  it('un workflow correcto no produce ningún problema', () => {
    const ok = {
      nodes: [n('entrada', 'input'), n('a', 'agent', { agentId: 'ag', prompt: '{{upstream}}' }), n('salida', 'output', { template: '{{a}}' })],
      edges: [e('e1', 'entrada', 'a'), e('e2', 'a', 'salida')],
    };
    expect(validateWorkflow(ok, { agentIds: ['ag'], toolNames: [] })).toEqual([]);
  });
});

// ───────────────────────────── M18 · ramas del almacén ─────────────────────────────

describe('almacén: ramas sin cubrir', () => {
  it('datos corruptos en JSON no tumban la lectura: se usan valores por defecto y la API sigue respondiendo', async () => {
    await boot();
    const agent = addAgent(ctx!, { tools: ['calculator'] });
    const wf = ctx!.store.createWorkflow(workflow([node('t', 'transform', { template: 'x' })], []));
    const hecho = await runWorkflow(ctx!, workflow([node('t', 'transform', { template: 'x' })], []));
    ctx!.db.prepare("UPDATE agents SET tools = '{roto' WHERE id = ?").run(agent.id);
    ctx!.db.prepare("UPDATE workflows SET definition = 'no es json' WHERE id = ?").run(wf.id);
    ctx!.db.prepare("UPDATE runs SET snapshot = '[[' WHERE id = ?").run(hecho.id);

    expect(ctx!.store.getAgent(agent.id)!.tools).toEqual([]);
    expect(ctx!.store.getWorkflow(wf.id)).toMatchObject({ nodes: [], edges: [], settings: DEFAULT_WORKFLOW_SETTINGS });
    expect((await get(`/api/agents/${agent.id}`)).statusCode).toBe(200);
    expect((await get(`/api/workflows/${wf.id}`)).json()).toMatchObject({ nodes: [], edges: [] });
    expect((await get(`/api/runs/${hecho.id}`)).json()).toMatchObject({ status: 'completed', snapshot: { workflow: { nodes: [], edges: [] }, agents: {} } });
    // Reintentar una ejecución cuya instantánea se perdió termina con un error claro: ni se cuelga ni da un 500.
    const retry = (await post(`/api/runs/${hecho.id}/retry`, { mode: 'all' })).json() as Run;
    await ctx!.runs.waitFor(retry.id);
    expect(ctx!.store.getRunSummary(retry.id)).toMatchObject({ status: 'failed', error: 'Ningún nodo de salida llegó a ejecutarse.' });
  });

  it('clearInterrupted con ids descarta solo esas (ignorando repetidas y desconocidas); sin ids, todas', async () => {
    await boot();
    const snapshot = { workflow: { nodes: [], edges: [], settings: DEFAULT_WORKFLOW_SETTINGS }, agents: {} };
    const ids = ['uno', 'dos', 'tres'].map(
      (name) => ctx!.store.createRun({ kind: 'workflow', workflowId: null, agentId: null, name, input: '', snapshot, steps: [] }).id,
    );
    expect(ctx!.store.markInterruptedRuns()).toBe(3);
    expect(ctx!.store.listInterruptedRuns()).toHaveLength(3);
    expect(ctx!.store.clearInterrupted([])).toBe(0);
    expect(ctx!.store.clearInterrupted([ids[0], 'no_existe', ids[0]])).toBe(1);
    expect(
      ctx!.store
        .listInterruptedRuns()
        .map((r) => r.id)
        .sort(),
    ).toEqual([ids[1], ids[2]].sort());
    expect(ctx!.store.clearInterrupted()).toBe(2);
    expect(ctx!.store.listInterruptedRuns()).toEqual([]);
    expect(ctx!.store.clearInterrupted()).toBe(0);
  });

  it('una transacción que lanza deshace todo lo escrito dentro y deja la base utilizable', async () => {
    await boot();
    const antes = ctx!.store.listProviders().length;
    expect(() =>
      ctx!.store.transaction(() => {
        ctx!.store.createProvider({ name: 'A medias', kind: 'ollama', baseUrl: 'http://127.0.0.1:1', defaultModel: '', enabled: true });
        expect(ctx!.store.listProviders()).toHaveLength(antes + 1); // dentro se ve
        throw new Error('fallo a mitad');
      }),
    ).toThrow('fallo a mitad');
    expect(ctx!.store.listProviders()).toHaveLength(antes);
    expect(
      ctx!.store.transaction(
        () => ctx!.store.createProvider({ name: 'Completo', kind: 'ollama', baseUrl: 'http://127.0.0.1:1', defaultModel: '', enabled: true }).name,
      ),
    ).toBe('Completo');
    expect(ctx!.store.listProviders()).toHaveLength(antes + 1);
  });

  it('tras liberar una ejecución, los eventos nuevos continúan la secuencia guardada sin repetir números', async () => {
    await boot();
    const run = await runWorkflow(ctx!, workflow([node('t', 'transform', { template: 'x' })], []));
    const total = ctx!.store.listEvents(run.id).length;
    ctx!.store.releaseRun(run.id);
    const extra = ctx!.store.appendEvent(run.id, 'llm.message', null, { content: 'después' });
    expect(extra.seq).toBe(total + 1);
    expect(ctx!.store.appendEvent(run.id, 'llm.message', null, { content: 'otra' }).seq).toBe(total + 2);
    const seqs = ctx!.store.listEvents(run.id).map((ev) => ev.seq);
    expect(seqs).toEqual(seqs.map((_s, i) => i + 1));
  });

  it('las estadísticas separan la ventana de días del acumulado: una ejecución fuera de la ventana no sale en la serie pero sí en los totales', async () => {
    await boot();
    const run = await runWorkflow(ctx!, workflow([node('t', 'transform', { template: 'x' })], []));
    const hoy = ctx!.store.stats(14, Date.now());
    expect(hoy.daily).toHaveLength(14);
    expect(hoy.daily.at(-1)).toMatchObject({ completed: 1, failed: 0, cancelled: 0 });
    const futuro = ctx!.store.stats(14, Date.now() + 20 * 86_400_000); // 20 días después: la ejecución ya no entra en 14
    expect(futuro.daily).toHaveLength(14);
    expect(futuro.daily.every((d) => d.completed === 0 && d.failed === 0 && d.cancelled === 0)).toBe(true);
    expect(futuro.runsByStatus.completed).toBe(1);
    expect(futuro.avgDurationMs).toBe(hoy.avgDurationMs);
    expect(hoy.avgDurationMs).not.toBeNull();
    expect(ctx!.store.stats(1).daily).toHaveLength(1);
    expect(run.status).toBe('completed');
  });
});
