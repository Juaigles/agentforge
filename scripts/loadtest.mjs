#!/usr/bin/env node
// Prueba de carga reproducible de AgentForge. Sin dependencias: solo módulos de Node.
//
//   node scripts/loadtest.mjs --runs 10000,50000 --out resultado.json
//   node scripts/loadtest.mjs --runs 10000 --scenarios stats,list --server-dir ../otra-copia
//
// Qué hace, para cada tamaño de historial:
//   1. Crea una base de datos temporal con el esquema v3 y la siembra con ejecuciones sintéticas (semilla fija).
//   2. Arranca el servidor REAL sobre esos datos (que migra el esquema si hace falta) y mide por HTTP:
//      estadísticas del panel, listados con filtros, búsqueda, paginación profunda, retención,
//      ejecuciones concurrentes contra un modelo simulado (protocolo de OpenAI en streaming) y clientes SSE.
//   3. Mientras mide, un sondeador pide /api/health cada 20 ms: su latencia máxima es el tiempo que el bucle de
//      eventos del servidor ha estado bloqueado (SQLite es síncrono), es decir, lo que se paran las demás peticiones.
//
// Nunca toca `data/`: usa un directorio temporal y un puerto libre.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce(
      (acc, arg, i, all) =>
        arg.startsWith('--') ? [...acc, [arg.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? 'true' : all[i + 1]]] : acc,
      [],
    ),
);
const SIZES = String(args.runs ?? '10000')
  .split(',')
  .map(Number);
const SCENARIOS = new Set(String(args.scenarios ?? 'stats,list,search,insert,retention,concurrency,sse').split(','));
const SERVER_DIR = path.resolve(args['server-dir'] ?? repoRoot);
const OUT = args.out ? path.resolve(args.out) : null;

// ---------- Utilidades ----------
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (n, d = 1) => Math.round(n * 10 ** d) / 10 ** d;
function percentiles(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  return { p50: round(at(50)), p95: round(at(95)), max: round(sorted[sorted.length - 1]) };
}
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}
const agent = new http.Agent({ keepAlive: true, maxSockets: Infinity });
function request(method, url, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const started = performance.now();
    const req = http.request(
      url,
      { method, agent, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          let json = null;
          try {
            json = JSON.parse(buffer.toString('utf8'));
          } catch {
            /* sin cuerpo JSON */
          }
          resolve({ status: res.statusCode, ms: performance.now() - started, bytes: buffer.length, json });
        });
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}

// ---------- Esquema v3 (congelado: es el punto de partida que el servidor migra si hace falta) ----------
const SCHEMA_V3 = `
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
ALTER TABLE runs ADD COLUMN interrupted INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_runs_finished ON runs(finished_at);
CREATE TABLE schedules (workflow_id TEXT PRIMARY KEY REFERENCES workflows(id) ON DELETE CASCADE, kind TEXT NOT NULL, interval_minutes INTEGER,
  time TEXT, input TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1, next_run_at TEXT, last_run_at TEXT, last_run_id TEXT,
  last_error TEXT, updated_at TEXT NOT NULL);
ALTER TABLE runs ADD COLUMN scheduled INTEGER NOT NULL DEFAULT 0;
PRAGMA user_version = 3;
`;

const WORDS =
  'informe ventas cliente pedido factura análisis resumen trimestre mercado riesgo plan equipo coste margen producto soporte incidencia contrato proveedor entrega'.split(
    ' ',
  );

/** Siembra `count` ejecuciones sintéticas con sus pasos y eventos. Determinista. */
function seed(dbFile, count) {
  const rand = mulberry32(42);
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const text = (bytes) => {
    let out = '';
    while (out.length < bytes) out += `${pick(WORDS)} `;
    return out.slice(0, bytes);
  };
  const db = new DatabaseSync(dbFile);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = OFF; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA_V3);
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const started = performance.now();
  db.exec('BEGIN');
  db.prepare('INSERT INTO providers (id, name, kind, base_url, default_model, created_at, updated_at) VALUES (?,?,?,?,?,?,?)').run(
    'prv_load',
    'Carga',
    'openai',
    'http://127.0.0.1:1/v1',
    'sim',
    iso(now),
    iso(now),
  );
  const agents = Array.from({ length: 5 }, (_, i) => `agt_load${i}`);
  for (const id of agents) {
    db.prepare('INSERT INTO agents (id, name, provider_id, model, system_prompt, created_at, updated_at) VALUES (?,?,?,?,?,?,?)').run(
      id,
      `Agente ${id.slice(-1)}`,
      'prv_load',
      'sim',
      text(600),
      iso(now),
      iso(now),
    );
  }
  const workflows = Array.from({ length: 20 }, (_, i) => `wf_load${i}`);
  const nodes = ['entrada', 'investigar', 'analizar', 'redactar', 'revisar', 'salida'];
  const definition = JSON.stringify({
    nodes: nodes.map((id, i) => ({
      id,
      type: i === 0 ? 'input' : i === 5 ? 'output' : 'agent',
      label: id,
      position: { x: i * 200, y: 0 },
      config: { agentId: agents[i % 5], prompt: text(200) },
    })),
    edges: [],
    settings: {},
  });
  for (const id of workflows)
    db.prepare('INSERT INTO workflows (id, name, definition, created_at, updated_at) VALUES (?,?,?,?,?)').run(
      id,
      `Flujo ${id.slice(7)}`,
      definition,
      iso(now),
      iso(now),
    );

  const insRun = db.prepare(
    'INSERT INTO runs (id, kind, workflow_id, agent_id, name, status, input, output, error, snapshot, usage, created_at, started_at, finished_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
  );
  const insStep = db.prepare(
    'INSERT INTO run_steps (run_id, node_id, position, node_type, label, agent_id, status, attempt, input, output, usage, started_at, finished_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
  );
  const insEvent = db.prepare('INSERT INTO run_events (run_id, seq, ts, type, node_id, data) VALUES (?,?,?,?,?,?)');
  const snapshot = JSON.stringify({
    workflow: JSON.parse(definition),
    agents: Object.fromEntries(agents.map((a) => [a, { id: a, name: a, systemPrompt: text(500) }])),
  });
  const tools = ['calculator', 'web_fetch', 'file_write', 'http_request', 'current_datetime'];
  const eventTypes = ['step.started', 'llm.start', 'llm.message', 'tool.call', 'tool.result', 'llm.start', 'llm.message', 'step.finished'];
  for (let i = 0; i < count; i++) {
    const id = `run_${String(i).padStart(8, '0')}`;
    const created = now - Math.floor(rand() * 30 * 86_400_000);
    const r = rand();
    const status = r < 0.9 ? 'completed' : r < 0.98 ? 'failed' : 'cancelled';
    const isAgent = rand() < 0.2;
    const usage = JSON.stringify({
      promptTokens: 400 + Math.floor(rand() * 2000),
      completionTokens: 100 + Math.floor(rand() * 900),
      llmCalls: 4,
      toolCalls: 2,
    });
    insRun.run(
      id,
      isAgent ? 'agent' : 'workflow',
      isAgent ? null : pick(workflows),
      isAgent ? pick(agents) : null,
      isAgent ? 'Agente de carga' : `Flujo ${i % 20}`,
      status,
      text(270),
      status === 'completed' ? text(2200) : null,
      status === 'failed' ? 'El nodo "redactar" falló: tiempo de espera agotado.' : null,
      snapshot,
      usage,
      iso(created),
      iso(created + 50),
      iso(created + 4000 + Math.floor(rand() * 20_000)),
    );
    nodes.forEach((node, n) =>
      insStep.run(
        id,
        node,
        n,
        n === 0 ? 'input' : n === 5 ? 'output' : 'agent',
        node,
        n > 0 && n < 5 ? agents[n % 5] : null,
        'completed',
        1,
        text(200),
        text(400),
        JSON.stringify({ promptTokens: 300, completionTokens: 120, llmCalls: 1, toolCalls: n === 2 ? 1 : 0 }),
        iso(created + n * 500),
        iso(created + n * 500 + 400),
      ),
    );
    let seq = 0;
    insEvent.run(id, ++seq, iso(created), 'run.started', null, '{"name":"carga","kind":"workflow"}');
    for (let e = 0; e < 18; e++) {
      const type = eventTypes[e % eventTypes.length];
      const data =
        type === 'tool.call'
          ? { id: `c${e}`, name: pick(tools), arguments: { q: text(40) } }
          : type === 'llm.message'
            ? { content: text(300), usage: { promptTokens: 300, completionTokens: 120 } }
            : { attempt: 1, text: text(60) };
      insEvent.run(id, ++seq, iso(created + e * 200), type, nodes[1 + (e % 4)], JSON.stringify(data));
    }
    insEvent.run(id, seq + 1, iso(created + 5000), 'run.finished', null, JSON.stringify({ status }));
  }
  db.exec('COMMIT');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
  return { seconds: round((performance.now() - started) / 1000), sizeMb: round(fs.statSync(dbFile).size / 1_048_576) };
}

// ---------- Servidor bajo prueba ----------
async function startServer(dataDir, extraEnv = {}) {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  let output = '';
  const started = performance.now();
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: path.join(SERVER_DIR, 'server'),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      AGENTFORGE_DATA_DIR: dataDir,
      AGENTFORGE_SEED: '0',
      AGENTFORGE_LOG: '0',
      AGENTFORGE_RATE_LIMIT: '0',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.stdout.on('data', (c) => (output += c));
  child.stderr.on('data', (c) => (output += c));
  for (;;) {
    if (child.exitCode !== null) throw new Error(`El servidor terminó al arrancar:\n${output}`);
    try {
      if ((await request('GET', `${url}/api/health`)).status === 200) break;
    } catch {
      /* todavía no escucha */
    }
    if (performance.now() - started > 600_000) throw new Error(`El servidor no arrancó en 10 minutos:\n${output}`);
    await sleep(100);
  }
  return {
    url,
    startupMs: round(performance.now() - started, 0),
    async stop() {
      if (child.exitCode !== null) return;
      const exited = new Promise((r) => child.once('exit', r));
      try {
        child.send('shutdown');
      } catch {
        /* versión sin apagado por mensaje */
      }
      const timer = setTimeout(() => child.kill('SIGKILL'), 4000);
      await exited;
      clearTimeout(timer);
    },
  };
}

/** Mide una operación repetida mientras un sondeador comprueba cuánto se bloquea el bucle de eventos del servidor. */
async function measure(url, label, fn, repeats = 8) {
  const probes = [];
  let probing = true;
  const prober = (async () => {
    while (probing) {
      const res = await request('GET', `${url}/api/health`).catch(() => null);
      if (res) probes.push(res.ms);
      await sleep(20);
    }
  })();
  const times = [];
  let bytes = 0;
  let status = 0;
  await fn(); // calentamiento
  for (let i = 0; i < repeats; i++) {
    const res = await fn();
    times.push(res.ms);
    bytes = res.bytes;
    status = res.status;
  }
  probing = false;
  await prober;
  const result = { label, status, ...percentiles(times), kb: round(bytes / 1024), loopBlockMaxMs: probes.length ? round(Math.max(...probes)) : null };
  console.log(
    `  ${label.padEnd(44)} p50 ${String(result.p50).padStart(8)} ms  p95 ${String(result.p95).padStart(8)} ms  ${String(result.kb).padStart(8)} KB  bloqueo máx ${result.loopBlockMaxMs} ms`,
  );
  return result;
}

// ---------- Modelo simulado (protocolo de OpenAI en streaming) ----------
function startFakeLlm({ tokens = 60, tps = 200 } = {}) {
  let inFlight = 0;
  let maxInFlight = 0;
  const server = http.createServer((req, res) => {
    if (req.url.endsWith('/models')) return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'sim' }] }));
    req.resume();
    req.on('end', () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      let sent = 0;
      const timer = setInterval(() => {
        if (sent >= tokens) {
          clearInterval(timer);
          res.write(
            `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: tokens } })}\n\n`,
          );
          res.end('data: [DONE]\n\n');
          inFlight--;
          return;
        }
        // Cada fragmento lleva la marca de tiempo en que se emitió: permite medir el retraso extremo a extremo.
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `t${Date.now()} ` } }] })}\n\n`);
        sent++;
      }, 1000 / tps);
      res.on('close', () => clearInterval(timer));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}/v1`,
        maxInFlight: () => maxInFlight,
        close: () => new Promise((r) => (server.closeAllConnections(), server.close(r))),
      }),
    ),
  );
}

async function waitRuns(url, ids, timeoutMs = 600_000) {
  const deadline = Date.now() + timeoutMs;
  const done = new Map();
  while (done.size < ids.length) {
    for (const id of ids) {
      if (done.has(id)) continue;
      const { json } = await request('GET', `${url}/api/runs/${id}`);
      if (json && !['queued', 'running'].includes(json.status)) done.set(id, json);
    }
    if (Date.now() > deadline) throw new Error('Las ejecuciones de la prueba no terminaron a tiempo.');
    await sleep(100);
  }
  return [...done.values()];
}

// ---------- Escenarios ----------
async function scenarioInsert(dataDir) {
  // Inserción de eventos con el almacén REAL del servidor (su Store y sus PRAGMA), sin HTTP.
  const script = `
    import { openDatabase } from './src/db/database';
    import { Store } from './src/db/store';
    import { SecretBox } from './src/crypto/secrets';
    const db = openDatabase(${JSON.stringify(path.join(dataDir, 'insert.db'))});
    const store = new Store(db, SecretBox.ephemeral());
    const run = store.createRun({ kind: 'agent', workflowId: null, agentId: null, name: 'carga', input: '', snapshot: { workflow: { nodes: [], edges: [], settings: {} }, agents: {} }, steps: [] });
    const data = { content: 'x'.repeat(500) };
    const n = 5000;
    const t0 = performance.now();
    for (let i = 0; i < n; i++) store.appendEvent(run.id, 'llm.message', 'a', data);
    const ms = performance.now() - t0;
    console.log(JSON.stringify({ eventsPerSecond: Math.round(n / (ms / 1000)), microsPerEvent: Math.round((ms * 1000) / n) }));
    db.close();
  `;
  const file = path.join(SERVER_DIR, 'server', `.loadtest-insert-${process.pid}.mts`);
  fs.writeFileSync(file, script);
  try {
    const out = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', file], { cwd: path.join(SERVER_DIR, 'server') });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c) => (stdout += c));
      child.stderr.on('data', (c) => (stderr += c));
      child.on('close', (code) => (code === 0 ? resolve(stdout) : reject(new Error(stderr))));
    });
    const result = JSON.parse(out.trim().split('\n').pop());
    console.log(`  inserción de eventos (500 bytes)               ${result.eventsPerSecond} eventos/s  (${result.microsPerEvent} µs por evento)`);
    return result;
  } finally {
    fs.rmSync(file, { force: true });
  }
}

async function scenarioConcurrency(url) {
  const llm = await startFakeLlm({ tokens: 60, tps: 200 });
  try {
    const provider = (await request('POST', `${url}/api/providers`, { name: 'Simulado', kind: 'openai', baseUrl: llm.url, defaultModel: 'sim' })).json;
    const ag = (
      await request('POST', `${url}/api/agents`, { name: 'Carga', providerId: provider.id, model: 'sim', systemPrompt: 'Responde.', maxIterations: 2 })
    ).json;
    const node = (id) => ({ id, type: 'agent', label: id, position: { x: 0, y: 0 }, config: { agentId: ag.id, prompt: `Paso ${id}: {{input}}`, retries: 0 } });
    const wf = (
      await request('POST', `${url}/api/workflows`, {
        name: 'Carga lineal',
        nodes: [
          { id: 'entrada', type: 'input', label: 'entrada', position: { x: 0, y: 0 }, config: {} },
          node('a'),
          node('b'),
          node('c'),
          { id: 'salida', type: 'output', label: 'salida', position: { x: 0, y: 0 }, config: {} },
        ],
        edges: [
          ['entrada', 'a'],
          ['a', 'b'],
          ['b', 'c'],
          ['c', 'salida'],
        ].map(([source, target], i) => ({ id: `e${i}`, source, target })),
      })
    ).json;
    const results = [];
    for (const concurrent of [3, 10]) {
      await request('PUT', `${url}/api/settings`, { maxConcurrentRuns: concurrent });
      const total = 40;
      const probes = [];
      let probing = true;
      const prober = (async () => {
        while (probing) {
          const res = await request('GET', `${url}/api/health`).catch(() => null);
          if (res) probes.push(res.ms);
          await sleep(20);
        }
      })();
      const t0 = performance.now();
      const ids = [];
      for (let i = 0; i < total; i++) ids.push((await request('POST', `${url}/api/workflows/${wf.id}/run`, { input: `caso ${i}` })).json.id);
      const runs = await waitRuns(url, ids);
      const seconds = (performance.now() - t0) / 1000;
      probing = false;
      await prober;
      const queueMs = runs.map((r) => Date.parse(r.startedAt) - Date.parse(r.createdAt));
      const result = {
        maxConcurrentRuns: concurrent,
        runs: total,
        completed: runs.filter((r) => r.status === 'completed').length,
        runsPerMinute: round((total / seconds) * 60, 0),
        queue: percentiles(queueMs),
        // Mínimo teórico por ejecución: 3 pasos × 60 fragmentos a 200 por segundo = 0,9 s.
        durationSeconds: percentiles(runs.map((r) => (Date.parse(r.finishedAt) - Date.parse(r.startedAt)) / 1000)),
        loopBlockMaxMs: round(Math.max(...probes)),
        llmMaxInFlight: llm.maxInFlight(),
      };
      console.log(
        `  ${total} ejecuciones, ${concurrent} a la vez: ${result.completed} completadas, ${result.runsPerMinute}/min, duración p50 ${result.durationSeconds.p50} s, cola p95 ${result.queue.p95} ms, bloqueo máx ${result.loopBlockMaxMs} ms`,
      );
      results.push(result);
    }
    return { results, agentId: ag.id };
  } finally {
    await llm.close();
  }
}

async function scenarioSse(url) {
  const llm = await startFakeLlm({ tokens: 600, tps: 100 }); // 6 s de streaming
  try {
    const provider = (await request('POST', `${url}/api/providers`, { name: 'Simulado SSE', kind: 'openai', baseUrl: llm.url, defaultModel: 'sim' })).json;
    const ag = (
      await request('POST', `${url}/api/agents`, { name: 'Carga SSE', providerId: provider.id, model: 'sim', systemPrompt: 'Responde.', maxIterations: 1 })
    ).json;
    const results = [];
    for (const clients of [10, 50, 200]) {
      const run = (await request('POST', `${url}/api/agents/${ag.id}/run`, { input: 'cuenta' })).json;
      const delays = [];
      let events = 0;
      const sockets = [];
      for (let i = 0; i < clients; i++) {
        const req = http.get(`${url}/api/runs/${run.id}/stream`, { agent: new http.Agent({ maxSockets: Infinity }) }, (res) => {
          let buffer = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            buffer += chunk;
            let idx;
            while ((idx = buffer.indexOf('\n\n')) >= 0) {
              const block = buffer.slice(0, idx);
              buffer = buffer.slice(idx + 2);
              // Un mensaje puede traer varios fragmentos agrupados: cada uno lleva su marca de tiempo.
              if (!block.includes('"llm.delta"')) continue;
              for (const match of block.matchAll(/t(\d{13}) /g)) {
                events++;
                delays.push(Date.now() - Number(match[1]));
              }
            }
          });
        });
        req.on('error', () => undefined);
        sockets.push(req);
      }
      await waitRuns(url, [run.id]);
      await sleep(300);
      for (const s of sockets) s.destroy();
      const memoryMb = (await request('GET', `${url}/api/stats`)).json?.system?.memoryMb ?? null;
      const result = { clients, deltasPerClient: round(events / clients, 0), delayMs: delays.length ? percentiles(delays) : null, serverMemoryMb: memoryMb };
      console.log(
        `  ${String(clients).padStart(3)} clientes SSE: ${result.deltasPerClient} fragmentos por cliente, retraso p50 ${result.delayMs?.p50} ms, p95 ${result.delayMs?.p95} ms, máx ${result.delayMs?.max} ms, memoria ${memoryMb} MB`,
      );
      results.push(result);
    }
    return results;
  } finally {
    await llm.close();
  }
}

// ---------- Programa principal ----------
async function runSize(count) {
  console.log(`\n=== ${count.toLocaleString('es-ES')} ejecuciones ===`);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-load-'));
  const dbFile = path.join(dataDir, 'agentforge.db');
  const result = { runs: count };
  let server;
  try {
    result.seed = seed(dbFile, count);
    console.log(
      `  siembra: ${result.seed.seconds} s, base de datos de ${result.seed.sizeMb} MB (${round((result.seed.sizeMb * 1024) / count)} KB por ejecución)`,
    );
    server = await startServer(dataDir);
    result.startupMs = server.startupMs;
    console.log(`  arranque del servidor (incluye migrar el esquema si procede): ${server.startupMs} ms`);
    const { url } = server;
    const get = (route) => () => request('GET', `${url}${route}`);

    if (SCENARIOS.has('stats')) result.stats = await measure(url, 'GET /api/stats', get('/api/stats'));
    if (SCENARIOS.has('list')) {
      result.list = [];
      for (const [label, route] of [
        ['lista, 30 filas', '/api/runs?limit=30'],
        ['lista, 200 filas', '/api/runs?limit=200'],
        ['lista, estado = completadas', '/api/runs?limit=30&status=completed'],
        ['lista, estado = fallidas', '/api/runs?limit=30&status=failed'],
        ['lista, por workflow', '/api/runs?limit=30&workflowId=wf_load3'],
        ['lista, por agente (5)', '/api/runs?limit=5&kind=agent&agentId=agt_load2'],
        [`lista, página profunda (offset ${Math.floor(count * 0.9)})`, `/api/runs?limit=30&offset=${Math.floor(count * 0.9)}`],
        ['interrumpidas', '/api/runs/interrupted'],
      ]) {
        result.list.push(await measure(url, label, get(route)));
      }
    }
    if (SCENARIOS.has('search')) {
      result.search = [
        await measure(url, 'búsqueda, término frecuente', get('/api/runs?limit=30&search=factura')),
        await measure(url, 'búsqueda, término inexistente', get('/api/runs?limit=30&search=zzzzqqqq')),
      ];
    }
    if (SCENARIOS.has('insert')) result.insert = await scenarioInsert(dataDir);
    if (SCENARIOS.has('concurrency')) result.concurrency = (await scenarioConcurrency(url)).results;
    if (SCENARIOS.has('sse')) result.sse = await scenarioSse(url);
    if (SCENARIOS.has('retention')) {
      // (a) Con un tope que no borra nada: lo que cuesta la retención cada vez que termina una ejecución.
      await request('PUT', `${url}/api/settings`, { retentionMaxRuns: 100_000, maxConcurrentRuns: 3 });
      const noop = await measure(url, 'retención sin nada que borrar (PUT ajustes)', () => request('PUT', `${url}/api/settings`, { retentionDays: 3650 }), 5);
      // (b) Borrar de golpe la mitad del historial.
      const before = fs.statSync(dbFile).size;
      const probes = [];
      let probing = true;
      const prober = (async () => {
        while (probing) {
          const res = await request('GET', `${url}/api/health`).catch(() => null);
          if (res) probes.push(res.ms);
          await sleep(20);
        }
      })();
      const t0 = performance.now();
      const res = await request('PUT', `${url}/api/settings`, { retentionMaxRuns: Math.floor(count / 2) });
      const requestMs = performance.now() - t0;
      // El borrado puede seguir en segundo plano: se espera a que el historial llegue al tope.
      let total = Infinity;
      const deadline = Date.now() + 600_000;
      while (total > Math.floor(count / 2) + 200 && Date.now() < deadline) {
        total = (await request('GET', `${url}/api/runs?limit=1`)).json.total;
        if (total > Math.floor(count / 2) + 200) await sleep(200);
      }
      const totalMs = performance.now() - t0;
      // El espacio liberado se devuelve al sistema de archivos poco a poco: se espera a que el tamaño se estabilice.
      let size = fs.statSync(dbFile).size;
      for (let stable = 0, waited = 0; stable < 4 && waited < 240; waited++) {
        await sleep(500);
        const next = fs.statSync(dbFile).size;
        stable = next === size ? stable + 1 : 0;
        size = next;
      }
      probing = false;
      await prober;
      result.retention = {
        noop,
        prune: {
          status: res.status,
          requestMs: round(requestMs, 0),
          totalMs: round(totalMs, 0),
          remaining: total,
          loopBlockMaxMs: round(Math.max(...probes)),
          dbMbBefore: round(before / 1_048_576),
          dbMbAfter: round(fs.statSync(dbFile).size / 1_048_576),
        },
      };
      const p = result.retention.prune;
      console.log(
        `  retención que borra la mitad: petición ${p.requestMs} ms, total ${p.totalMs} ms, bloqueo máx ${p.loopBlockMaxMs} ms, archivo ${p.dbMbBefore} → ${p.dbMbAfter} MB`,
      );
    }
  } finally {
    await server?.stop();
    if (args['keep-data'] !== 'true') fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  return result;
}

const report = {
  date: new Date().toISOString(),
  node: process.version,
  cpu: os.cpus()[0]?.model,
  cores: os.cpus().length,
  memoryGb: round(os.totalmem() / 1024 ** 3),
  platform: `${os.type()} ${os.release()}`,
  serverDir: SERVER_DIR,
  sizes: [],
};
for (const size of SIZES) report.sizes.push(await runSize(size));
if (OUT) {
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(`\nResultado guardado en ${OUT}`);
}
agent.destroy();
