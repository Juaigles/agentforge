// Métricas (GET /api/metrics), versión única de la aplicación y códigos de error añadidos en la fase 9.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import type { AppContext } from '../src/context';
import { HttpCounters, renderMetrics, type MetricsInput } from '../src/metrics';
import { APP_VERSION } from '../src/version';
import { addAgent, makeContext, ScriptedLlm } from './helpers';

let ctx: AppContext | undefined;
let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  await ctx?.close();
  app = undefined;
  ctx = undefined;
});

async function boot(): Promise<{ app: FastifyInstance; ctx: AppContext }> {
  ctx = makeContext(new ScriptedLlm(() => ({ content: 'hecho' })));
  app = await buildApp(ctx);
  return { app, ctx };
}

/** Lee el texto de Prometheus: `nombre{etiquetas} valor` → mapa, y comprueba que cada línea tiene la forma debida. */
function parse(text: string): { samples: Map<string, number>; help: Set<string>; type: Map<string, string> } {
  const samples = new Map<string, number>();
  const help = new Set<string>();
  const type = new Map<string, string>();
  for (const line of text.split('\n')) {
    if (!line) continue;
    const meta = /^# (HELP|TYPE) ([a-z_][a-z0-9_]*) (.+)$/.exec(line);
    if (meta) {
      if (meta[1] === 'HELP') help.add(meta[2]);
      else type.set(meta[2], meta[3]);
      continue;
    }
    const sample = /^([a-z_][a-z0-9_]*)(\{(?:[a-z_]+="(?:[^"\\]|\\.)*",?)+\})? (-?\d+(?:\.\d+)?)$/.exec(line);
    if (!sample) throw new Error(`Línea de métricas con formato no válido: ${line}`);
    samples.set(sample[1] + (sample[2] ?? ''), Number(sample[3]));
  }
  return { samples, help, type };
}

const BASE: MetricsInput = {
  version: '1.2.3',
  nodeVersion: 'v24.0.0',
  uptimeSec: 12,
  schemaVersion: 6,
  counts: { agents: 2, workflows: 1, providers: 1, tools: 9, runs: 5 },
  runsByStatus: { completed: 3, failed: 1, cancelled: 1 },
  activeRuns: 1,
  queuedRuns: 2,
  llmCalls: 7,
  toolCalls: 4,
  tokens: { prompt: 100, completion: 40 },
  memoryBytes: 123456,
  dbSizeBytes: 4096,
  schedulerRunning: true,
  http: [
    ['2xx', 10],
    ['4xx', 2],
  ],
};

describe('formato de las métricas', () => {
  it('cada métrica lleva HELP y TYPE, y cada línea es válida en el formato de texto de Prometheus', () => {
    const { samples, help, type } = parse(renderMetrics(BASE));
    const names = new Set([...samples.keys()].map((k) => k.replace(/\{.*$/, '')));
    for (const name of names) {
      expect(help.has(name), `falta HELP de ${name}`).toBe(true);
      expect(['gauge', 'counter']).toContain(type.get(name));
    }
    // Los acumulados son contadores y terminan en `_total`; los demás, medidores.
    for (const [name, kind] of type) expect(name.endsWith('_total')).toBe(kind === 'counter');
    expect(samples.get('agentforge_info{version="1.2.3",node="v24.0.0",schema="6"}')).toBe(1);
    expect(samples.get('agentforge_runs{status="completed"}')).toBe(3);
    expect(samples.get('agentforge_runs_active')).toBe(1);
    expect(samples.get('agentforge_runs_queued')).toBe(2);
    expect(samples.get('agentforge_tokens_total{kind="prompt"}')).toBe(100);
    expect(samples.get('agentforge_tokens_total{kind="completion"}')).toBe(40);
    expect(samples.get('agentforge_http_responses_total{class="4xx"}')).toBe(2);
    expect(samples.get('agentforge_scheduler_running')).toBe(1);
  });

  it('escapa comillas, barras invertidas y saltos de línea en las etiquetas, y no escribe valores no numéricos', () => {
    const text = renderMetrics({ ...BASE, version: 'a"b\\c\nd', uptimeSec: Number.NaN, http: [] });
    const { samples } = parse(text);
    expect(text).toContain('version="a\\"b\\\\c\\nd"');
    expect(samples.get('agentforge_uptime_seconds')).toBe(0);
    // Sin respuestas todavía: la métrica existe con su cabecera y sin muestras.
    expect(text).toContain('# TYPE agentforge_http_responses_total counter');
  });

  it('el recuento de respuestas HTTP agrupa por clase de estado', () => {
    const http = new HttpCounters();
    for (const status of [200, 201, 204, 404, 400, 500]) http.record(status);
    expect(http.snapshot()).toEqual([
      ['2xx', 3],
      ['4xx', 2],
      ['5xx', 1],
    ]);
  });
});

describe('GET /api/metrics', () => {
  it('refleja lo que ha pasado de verdad: una ejecución, sus llamadas, sus tokens y las respuestas servidas', async () => {
    const { app, ctx } = await boot();
    const before = parse((await app.inject({ method: 'GET', url: '/api/metrics' })).body).samples;
    expect(before.get('agentforge_llm_calls_total')).toBe(0);
    expect(before.get('agentforge_agents')).toBe(0);

    const agent = addAgent(ctx);
    const started = await app.inject({ method: 'POST', url: `/api/agents/${agent.id}/run`, payload: { input: 'hola' } });
    expect(started.statusCode).toBe(202);
    await ctx.runs.waitFor(started.json().id);
    await app.inject({ method: 'GET', url: '/api/agents/agt_no_existe' }); // un 404

    const res = await app.inject({ method: 'GET', url: '/api/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    const { samples } = parse(res.body);
    expect(samples.get('agentforge_agents')).toBe(1);
    expect(samples.get('agentforge_runs{status="completed"}')).toBe(1);
    expect(samples.get('agentforge_runs_active')).toBe(0);
    expect(samples.get('agentforge_llm_calls_total')).toBe(1);
    // El proveedor de guion declara 10 tokens de entrada y 5 de salida por llamada.
    expect(samples.get('agentforge_tokens_total{kind="prompt"}')).toBe(10);
    expect(samples.get('agentforge_tokens_total{kind="completion"}')).toBe(5);
    expect(samples.get('agentforge_tools_enabled')).toBeGreaterThan(5);
    expect(samples.get('agentforge_process_resident_memory_bytes')).toBeGreaterThan(1_000_000);
    expect(
      samples.get(`agentforge_info{version="${APP_VERSION}",node="${process.version}",schema="${ctx.db.prepare('PRAGMA user_version').get()!.user_version}"}`),
    ).toBe(1);
    // Respuestas servidas hasta ahora: la primera lectura de métricas y el 202 (2xx) y el 404 (4xx).
    expect(samples.get('agentforge_http_responses_total{class="2xx"}')).toBe(2);
    expect(samples.get('agentforge_http_responses_total{class="4xx"}')).toBe(1);
  });

  it('con clave de acceso configurada exige la clave, como el resto de la API', async () => {
    const { app, ctx } = await boot();
    (ctx.config as { authToken: string | null }).authToken = 'una-clave-de-prueba-larga';
    const denied = await app.inject({ method: 'GET', url: '/api/metrics' });
    expect(denied.statusCode).toBe(401);
    expect(denied.json()).toMatchObject({ code: 'auth_required' });
    const allowed = await app.inject({ method: 'GET', url: '/api/metrics', headers: { authorization: 'Bearer una-clave-de-prueba-larga' } });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.body).toContain('agentforge_uptime_seconds');
  });
});

describe('versión de la aplicación', () => {
  it('sale de un solo sitio: el package.json de la raíz, y es la que anuncian la API y los paquetes', async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
    const read = (file: string): string => (JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')) as { version: string }).version;
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(APP_VERSION).toBe(read('package.json'));
    expect(read('server/package.json')).toBe(APP_VERSION);
    expect(read('web/package.json')).toBe(APP_VERSION);
    const { app } = await boot();
    expect((await app.inject({ method: 'GET', url: '/api/health/live' })).json().version).toBe(APP_VERSION);
    expect((await app.inject({ method: 'GET', url: '/api/stats' })).json().system.version).toBe(APP_VERSION);
    expect((await app.inject({ method: 'GET', url: '/api/openapi.json' })).json().info.version).toBe(APP_VERSION);
  });
});

describe('códigos de error', () => {
  it('una clave incorrecta al entrar es `invalid_token`; una petición sin clave, `auth_required`', async () => {
    const { app, ctx } = await boot();
    (ctx.config as { authToken: string | null }).authToken = 'una-clave-de-prueba-larga';
    const wrong = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { token: 'otra-clave' } });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toMatchObject({ code: 'invalid_token', error: 'La clave de acceso no es correcta.' });
    expect((await app.inject({ method: 'GET', url: '/api/agents' })).json()).toMatchObject({ code: 'auth_required' });
  });

  it('un Host ajeno y una petición de otra web llevan su propio código', async () => {
    const { app } = await boot();
    const host = await app.inject({ method: 'GET', url: '/api/agents', headers: { host: 'malo.example' } });
    expect(host.statusCode).toBe(403);
    expect(host.json()).toEqual({ error: 'Host no permitido.', code: 'forbidden_host', i18n: { code: 'forbiddenHost' } });
    const cross = await app.inject({ method: 'GET', url: '/api/agents', headers: { 'sec-fetch-site': 'cross-site' } });
    expect(cross.statusCode).toBe(403);
    expect(cross.json()).toMatchObject({ code: 'cross_site' });
  });
});
