// La especificación OpenAPI no puede quedarse atrás: se compara con las rutas realmente registradas, se
// comprueba que es un documento OpenAPI 3.1 coherente y que las respuestas reales cumplen sus esquemas.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import type { AppContext } from '../src/context';
import { buildOpenApi } from '../src/openapi';
import { renderApiMarkdown } from '../src/openapi-markdown';
import { APP_VERSION } from '../src/routes/api';
import { edges, makeContext, node, ScriptedLlm, workflow } from './helpers';

type Json = Record<string, unknown>;
const VERSION = '9.9.9-test';
const METHODS = ['get', 'post', 'put', 'delete', 'patch'] as const;
const doc = buildOpenApi(VERSION) as Json;
const paths = doc.paths as Record<string, Record<string, Json>>;
const schemas = (doc.components as Json).schemas as Record<string, Json>;

let ctx: AppContext;
let app: FastifyInstance;

beforeAll(async () => {
  ctx = makeContext(new ScriptedLlm(() => ({ content: 'hola' })));
  app = await buildApp(ctx);
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await ctx?.close();
});

// ---------- Rutas registradas ----------
interface Registered {
  method: string;
  /** Ruta tal como la registra Fastify (`/api/agents/:id`). */
  fastifyPath: string;
}

/**
 * Rutas registradas, leídas de `printRoutes`. Es un árbol: cada línea añade un fragmento al de su padre
 * (también a mitad de segmento: `/api/workspace/file` + `s`). `HEAD` lo añade Fastify solo a cada `GET`.
 */
function registeredRoutes(instance: FastifyInstance): Registered[] {
  const stack: string[] = [];
  const found: Registered[] = [];
  for (const line of instance.printRoutes({ commonPrefix: false }).split('\n')) {
    const match = /^((?:│ {3}| {4})*)(?:├── |└── )(.*?)(?: \(([A-Z, ]+)\))?$/.exec(line);
    if (!match) continue;
    const depth = match[1].length / 4;
    stack.length = depth;
    stack[depth] = match[2];
    for (const method of (match[3] ?? '').split(', ').filter(Boolean)) {
      if (method === 'HEAD' || method === 'OPTIONS') continue;
      found.push({ method, fastifyPath: stack.join('') });
    }
  }
  return found;
}

const toOpenApiPath = (path: string): string => path.replace(/:(\w+)/g, '{$1}');
const key = (method: string, path: string): string => `${method.toUpperCase()} ${path}`;

function documentedRoutes(): string[] {
  return Object.entries(paths).flatMap(([path, item]) => METHODS.filter((m) => item[m]).map((m) => key(m, path)));
}

/** La especificación se describe a sí misma, pero esa ruta solo existe cuando el autor conecta el módulo. */
const SELF_ROUTE = key('get', '/api/openapi.json');

describe('rutas registradas frente a rutas documentadas', () => {
  it('el análisis de las rutas es fiable: cada una existe de verdad en Fastify', () => {
    const routes = registeredRoutes(app);
    expect(routes.length).toBeGreaterThan(70);
    for (const { method, fastifyPath } of routes) {
      expect(app.hasRoute({ method: method as 'GET', url: fastifyPath }), key(method, fastifyPath)).toBe(true);
    }
  });

  it('toda ruta registrada bajo /api/ está documentada', () => {
    const documented = new Set(documentedRoutes());
    const missing = registeredRoutes(app)
      .filter((r) => r.fastifyPath.startsWith('/api/'))
      .map((r) => key(r.method, toOpenApiPath(r.fastifyPath)))
      .filter((k) => !documented.has(k));
    expect(missing, 'rutas sin documentar en server/src/openapi.ts').toEqual([]);
  });

  it('no hay ninguna ruta documentada que no exista', () => {
    const registered = new Set(registeredRoutes(app).map((r) => key(r.method, toOpenApiPath(r.fastifyPath))));
    const ghosts = documentedRoutes().filter((k) => !registered.has(k) && k !== SELF_ROUTE);
    expect(ghosts, 'rutas documentadas que el servidor no registra').toEqual([]);
  });

  it('sirve, de verdad, cada ruta documentada (no solo la registra)', () => {
    for (const k of documentedRoutes().filter((r) => r !== SELF_ROUTE)) {
      const [method, path] = k.split(' ');
      expect(app.hasRoute({ method: method as 'GET', url: path.replace(/\{(\w+)\}/g, ':$1') }), k).toBe(true);
    }
  });
});

// ---------- Estructura del documento ----------
/** Todas las `$ref` del documento, con el sitio donde están. */
function collectRefs(value: unknown, where: string, out: Array<{ ref: string; where: string }> = []): Array<{ ref: string; where: string }> {
  if (Array.isArray(value)) value.forEach((item, i) => collectRefs(item, `${where}[${i}]`, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === '$ref' && typeof v === 'string') out.push({ ref: v, where });
      else collectRefs(v, `${where}.${k}`, out);
    }
  }
  return out;
}

function operations(): Array<{ id: string; path: string; method: string; op: Json }> {
  return Object.entries(paths).flatMap(([path, item]) =>
    METHODS.filter((m) => item[m]).map((method) => ({ id: key(method, path), path, method, op: item[method] })),
  );
}

describe('estructura OpenAPI 3.1', () => {
  it('declara la versión, la información y el servidor', () => {
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info).toMatchObject({ title: expect.any(String), version: VERSION, description: expect.stringContaining('Bearer') });
    expect(doc.servers).toEqual([expect.objectContaining({ url: 'http://127.0.0.1:4310' })]);
  });

  it('el documento es JSON puro (sin undefined ni funciones) y no cambia entre llamadas', () => {
    expect(JSON.parse(JSON.stringify(doc))).toEqual(doc);
    expect(buildOpenApi(VERSION)).toEqual(doc);
  });

  it('toda $ref apunta a un componente que existe', () => {
    const refs = collectRefs(doc, '#');
    expect(refs.length).toBeGreaterThan(100);
    const broken = refs.filter(({ ref }) => {
      const match = /^#\/components\/(schemas|securitySchemes)\/([\w.-]+)$/.exec(ref);
      return !match || !((doc.components as Json)[match[1]] as Json)[match[2]];
    });
    expect(broken).toEqual([]);
  });

  it('todo esquema declarado se usa en alguna parte', () => {
    const used = new Set(collectRefs(doc, '#').map(({ ref }) => ref.split('/').pop()));
    const orphans = Object.keys(schemas).filter((name) => !used.has(name));
    expect(orphans).toEqual([]);
  });

  it('en cada esquema de objeto, los campos obligatorios están entre sus propiedades', () => {
    const problems: string[] = [];
    const walk = (value: unknown, where: string): void => {
      if (Array.isArray(value)) return value.forEach((v, i) => walk(v, `${where}[${i}]`));
      if (!value || typeof value !== 'object') return;
      const schema = value as Json;
      if (Array.isArray(schema.required) && schema.properties && typeof schema.properties === 'object') {
        for (const name of schema.required as string[])
          if (!(name in (schema.properties as Json))) problems.push(`${where}: «${name}» es obligatorio pero no está en properties`);
      }
      for (const [k, v] of Object.entries(schema)) walk(v, `${where}.${k}`);
    };
    walk(schemas, 'components.schemas');
    expect(problems).toEqual([]);
  });

  it('las etiquetas son únicas y están descritas', () => {
    const tags = doc.tags as Array<{ name: string; description?: string }>;
    expect(new Set(tags.map((t) => t.name)).size).toBe(tags.length);
    for (const tag of tags) expect(tag.description, tag.name).toBeTruthy();
  });

  it('cada operación tiene resumen, etiqueta declarada, operationId único y una respuesta de éxito', () => {
    const declared = new Set((doc.tags as Array<{ name: string }>).map((t) => t.name));
    const ids = new Set<string>();
    for (const { id, op } of operations()) {
      expect(typeof op.summary === 'string' && op.summary.length > 0, `${id}: falta el resumen`).toBe(true);
      expect(String(op.summary).includes('\n'), `${id}: el resumen debe ser de una línea`).toBe(false);
      const tags = op.tags as string[];
      expect(tags.length, `${id}: falta la etiqueta`).toBeGreaterThan(0);
      for (const tag of tags) expect(declared.has(tag), `${id}: etiqueta «${tag}» sin declarar`).toBe(true);
      expect(typeof op.operationId === 'string', `${id}: falta operationId`).toBe(true);
      expect(ids.has(op.operationId as string), `${id}: operationId repetido`).toBe(false);
      ids.add(op.operationId as string);
      const codes = Object.keys(op.responses as Json);
      expect(
        codes.some((c) => /^2\d\d$/.test(c)),
        `${id}: sin respuesta 2xx`,
      ).toBe(true);
    }
  });

  it('las respuestas de error usan el esquema Error', () => {
    for (const { id, op } of operations()) {
      for (const [code, response] of Object.entries(op.responses as Record<string, Json>)) {
        if (/^2\d\d$/.test(code) || code === '503') continue;
        const content = (response.content as Json | undefined)?.['application/json'] as Json | undefined;
        expect(content?.schema, `${id} ${code}`).toEqual({ $ref: '#/components/schemas/Error' });
      }
    }
  });

  it('los parámetros {x} de cada ruta están declarados como in: path, required: true (y no sobra ninguno)', () => {
    for (const { id, path, op } of operations()) {
      const inPath = [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      const declared = ((op.parameters ?? []) as Array<{ name: string; in: string; required?: boolean; schema?: unknown }>).filter((p) => p.in === 'path');
      for (const name of inPath) {
        const param = declared.find((p) => p.name === name);
        expect(param, `${id}: falta el parámetro de ruta «${name}»`).toBeDefined();
        expect(param?.required, `${id}: «${name}» debe ser required: true`).toBe(true);
        expect(param?.schema, `${id}: «${name}» sin esquema`).toBeDefined();
      }
      expect(declared.map((p) => p.name).sort(), id).toEqual([...inPath].sort());
    }
  });

  it('las operaciones con cuerpo lo declaran y las de lectura no', () => {
    for (const { id, method, op } of operations()) {
      if (method === 'get') expect(op.requestBody, `${id}: un GET no lleva cuerpo`).toBeUndefined();
      if (op.requestBody) expect(Object.keys((op.requestBody as Json).content as Json).length, id).toBeGreaterThan(0);
    }
  });

  it('los esquemas de seguridad que usan las operaciones existen', () => {
    const schemes = (doc.components as Json).securitySchemes as Json;
    const used = [doc.security, ...operations().map(({ op }) => op.security)].flatMap((s) => (s ?? []) as Array<Json>).flatMap((req) => Object.keys(req));
    expect(used.length).toBeGreaterThan(0);
    for (const name of used) expect(schemes[name], name).toBeDefined();
    expect(Object.keys(schemes)).toEqual(expect.arrayContaining(['bearerAuth', 'sessionCookie']));
  });

  it('los flujos SSE se documentan como text/event-stream', () => {
    for (const path of ['/api/stream/runs', '/api/stream/approvals', '/api/runs/{id}/stream']) {
      const ok = (paths[path].get.responses as Record<string, Json>)['200'];
      expect(Object.keys(ok.content as Json), path).toEqual(['text/event-stream']);
    }
    expect(paths['/api/runs/{id}/stream'].get.description).toEqual(expect.stringContaining('Last-Event-ID'));
    expect(paths['/api/runs/{id}/stream'].get.description).toEqual(expect.stringContaining('?after='));
  });
});

// ---------- Contrato con el servidor real ----------
/** Resuelve una `$ref` interna. */
function resolve(schema: Json): Json {
  const ref = schema.$ref;
  if (typeof ref !== 'string') return schema;
  const target = schemas[ref.replace('#/components/schemas/', '')];
  if (!target) throw new Error(`$ref sin resolver: ${ref}`);
  return resolve(target);
}

const typeOf = (value: unknown): string => (value === null ? 'null' : Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value);

/**
 * Validador mínimo: tipos básicos, propiedades obligatorias, enumeraciones, elementos de listas, `allOf`,
 * `anyOf` y `oneOf`. No comprueba límites ni formatos. Devuelve los problemas encontrados.
 */
function check(value: unknown, schema: Json, where = '$'): string[] {
  const s = resolve(schema);
  if (Array.isArray(s.allOf)) return (s.allOf as Json[]).flatMap((part) => check(value, part, where));
  for (const alt of ['anyOf', 'oneOf'] as const) {
    if (Array.isArray(s[alt])) {
      const attempts = (s[alt] as Json[]).map((part) => check(value, part, where));
      return attempts.some((a) => a.length === 0) ? [] : [`${where}: no cumple ninguna alternativa (${attempts.map((a) => a[0]).join(' | ')})`];
    }
  }
  const problems: string[] = [];
  const types = s.type === undefined ? [] : ((Array.isArray(s.type) ? s.type : [s.type]) as string[]);
  const actual = typeOf(value);
  if (types.length && !types.some((t) => t === actual || (t === 'number' && actual === 'integer'))) {
    return [`${where}: se esperaba ${types.join('|')} y es ${actual}`];
  }
  if (Array.isArray(s.enum) && !s.enum.includes(value)) problems.push(`${where}: ${JSON.stringify(value)} no está en ${JSON.stringify(s.enum)}`);
  if (actual === 'object') {
    const record = value as Json;
    for (const name of (s.required ?? []) as string[]) if (!(name in record)) problems.push(`${where}: falta la propiedad obligatoria «${name}»`);
    for (const [name, sub] of Object.entries((s.properties ?? {}) as Record<string, Json>)) {
      if (name in record) problems.push(...check(record[name], sub, `${where}.${name}`));
    }
  }
  if (actual === 'array' && s.items) (value as unknown[]).forEach((item, i) => problems.push(...check(item, s.items as Json, `${where}[${i}]`)));
  return problems;
}

/** Esquema de la respuesta JSON de una operación documentada. */
function responseSchema(path: string, method: string, status: number): Json {
  const response = (paths[path][method].responses as Record<string, Json>)[String(status)];
  expect(response, `${key(method, path)} no documenta la respuesta ${status}`).toBeDefined();
  const schema = ((response.content as Json | undefined)?.['application/json'] as Json | undefined)?.schema as Json | undefined;
  expect(schema, `${key(method, path)} ${status} no tiene esquema JSON`).toBeDefined();
  return schema!;
}

describe('el comprobador de esquemas del test', () => {
  it('detecta lo que debe detectar (para que el contrato no pase en vacío)', () => {
    const schema = { type: 'object', required: ['a', 'b'], properties: { a: { type: 'string' }, b: { type: 'array', items: { type: 'integer' } } } };
    expect(check({ a: 'x', b: [1, 2] }, schema)).toEqual([]);
    expect(check({ a: 'x' }, schema)).toEqual(['$: falta la propiedad obligatoria «b»']);
    expect(check({ a: 1, b: [] }, schema)).toEqual(['$.a: se esperaba string y es integer']);
    expect(check({ a: 'x', b: [1.5] }, schema)).toHaveLength(1);
    expect(check(null, { anyOf: [{ type: 'string' }, { type: 'null' }] })).toEqual([]);
  });
});

describe('contrato con respuestas reales', () => {
  let agentId: string;
  let workflowId: string;
  let runId: string;

  beforeAll(async () => {
    const provider = ctx.store.createProvider({ name: 'Prueba', kind: 'ollama', baseUrl: 'http://127.0.0.1:1' });
    const created = await app.inject({
      method: 'POST',
      url: '/api/agents',
      payload: { name: 'Contrato', providerId: provider.id, model: 'test-model', tools: ['calculator'] },
    });
    agentId = created.json().id;
    const wf = ctx.store.createWorkflow(
      workflow(
        [node('in', 'input'), node('a', 'agent', { agentId, prompt: '{{input}}' }), node('out', 'output', { template: '{{a}}' })],
        edges('in>a', 'a>out'),
      ),
    );
    workflowId = wf.id;
    const run = ctx.runs.startWorkflowRun(wf, 'entrada');
    runId = run.id;
    await ctx.runs.waitFor(run.id);
    ctx.store.createTrigger(
      wf.id,
      { kind: 'interval', name: 'cada hora', intervalMinutes: 60, time: null, weekdays: [], cron: null, timezone: null, input: '', enabled: true },
      null,
    );
  });

  interface Sample {
    name: string;
    method: 'GET' | 'POST' | 'PUT' | 'DELETE';
    url: () => string;
    /** Ruta tal como está en la especificación. */
    spec: string;
    status: number;
    payload?: () => unknown;
  }

  const samples: Sample[] = [
    {
      name: 'crear un agente',
      method: 'POST',
      url: () => '/api/agents',
      spec: '/api/agents',
      status: 201,
      payload: () => ({ name: 'Otro', providerId: ctx.store.listProviders()[0].id, model: 'm' }),
    },
    { name: 'obtener un agente', method: 'GET', url: () => `/api/agents/${agentId}`, spec: '/api/agents/{id}', status: 200 },
    { name: 'listar agentes', method: 'GET', url: () => '/api/agents', spec: '/api/agents', status: 200 },
    { name: 'obtener un workflow', method: 'GET', url: () => `/api/workflows/${workflowId}`, spec: '/api/workflows/{id}', status: 200 },
    { name: 'listar ejecuciones', method: 'GET', url: () => '/api/runs?limit=5', spec: '/api/runs', status: 200 },
    { name: 'obtener una ejecución', method: 'GET', url: () => `/api/runs/${runId}`, spec: '/api/runs/{id}', status: 200 },
    { name: 'eventos de una ejecución', method: 'GET', url: () => `/api/runs/${runId}/events`, spec: '/api/runs/{id}/events', status: 200 },
    {
      name: 'lanzar un workflow',
      method: 'POST',
      url: () => `/api/workflows/${workflowId}/run`,
      spec: '/api/workflows/{id}/run',
      status: 202,
      payload: () => ({ input: 'hola' }),
    },
    {
      name: 'validar un workflow',
      method: 'POST',
      url: () => '/api/workflows/validate',
      spec: '/api/workflows/validate',
      status: 200,
      payload: () => ({ name: 'v', nodes: [], edges: [] }),
    },
    { name: 'listar disparadores', method: 'GET', url: () => '/api/triggers', spec: '/api/triggers', status: 200 },
    { name: 'listar herramientas', method: 'GET', url: () => '/api/tools', spec: '/api/tools', status: 200 },
    {
      name: 'invocar una herramienta',
      method: 'POST',
      url: () => '/api/tools/calculator/invoke',
      spec: '/api/tools/{name}/invoke',
      status: 200,
      payload: () => ({ args: { expression: '2+2' } }),
    },
    { name: 'ajustes', method: 'GET', url: () => '/api/settings', spec: '/api/settings', status: 200 },
    { name: 'estadísticas', method: 'GET', url: () => '/api/stats', spec: '/api/stats', status: 200 },
    { name: 'crear la bienvenida', method: 'POST', url: () => '/api/onboarding/welcome', spec: '/api/onboarding/welcome', status: 200 },
    { name: 'primeros pasos (con la bienvenida)', method: 'GET', url: () => '/api/onboarding', spec: '/api/onboarding', status: 200 },
    {
      name: 'sonda de disponibilidad (503: en el test no corre el planificador)',
      method: 'GET',
      url: () => '/api/health/ready',
      spec: '/api/health/ready',
      status: 503,
    },
    { name: 'estado de la sesión', method: 'GET', url: () => '/api/auth/status', spec: '/api/auth/status', status: 200 },
    { name: 'copias de seguridad', method: 'GET', url: () => '/api/backups', spec: '/api/backups', status: 200 },
    { name: 'aprobaciones pendientes', method: 'GET', url: () => '/api/approvals', spec: '/api/approvals', status: 200 },
    { name: 'exportar un workflow', method: 'GET', url: () => `/api/workflows/${workflowId}/export`, spec: '/api/workflows/{id}/export', status: 200 },
    { name: 'error 404', method: 'GET', url: () => '/api/agents/no-existe', spec: '/api/agents/{id}', status: 404 },
    { name: 'error 404 en una ejecución', method: 'GET', url: () => '/api/runs/no-existe', spec: '/api/runs/{id}', status: 404 },
    { name: 'error de validación', method: 'POST', url: () => '/api/agents', spec: '/api/agents', status: 400, payload: () => ({}) },
    { name: 'error de validación en la consulta', method: 'GET', url: () => '/api/runs?limit=0', spec: '/api/runs', status: 400 },
    {
      name: 'historial filtrado por workflow, fechas y sin terminar',
      method: 'GET',
      url: () => `/api/runs?workflowId=${workflowId}&from=2020-01-01T00:00:00Z&to=2100-01-01T00:00:00%2B01:00&status=active`,
      spec: '/api/runs',
      status: 200,
    },
    { name: 'fecha no válida en el historial', method: 'GET', url: () => '/api/runs?from=ayer', spec: '/api/runs', status: 400 },
    {
      name: 'una página de eventos',
      method: 'GET',
      url: () => `/api/runs/${runId}/events?before=4&limit=2`,
      spec: '/api/runs/{id}/events',
      status: 200,
    },
    { name: 'límite de eventos no válido', method: 'GET', url: () => `/api/runs/${runId}/events?limit=0`, spec: '/api/runs/{id}/events', status: 400 },
    { name: 'cursor no válido en el flujo en vivo', method: 'GET', url: () => `/api/runs/${runId}/stream?after=x`, spec: '/api/runs/{id}/stream', status: 400 },
    { name: 'conflicto al eliminar un agente en uso', method: 'DELETE', url: () => `/api/agents/${agentId}`, spec: '/api/agents/{id}', status: 409 },
  ];

  it.each(samples)('$name: la respuesta cumple el esquema documentado', async (sample) => {
    const res = await app.inject({ method: sample.method, url: sample.url(), payload: sample.payload?.() as object | undefined });
    expect(res.statusCode, res.body).toBe(sample.status);
    const schema = responseSchema(sample.spec, sample.method.toLowerCase(), sample.status);
    expect(check(res.json(), schema)).toEqual([]);
  });

  it('un error de validación trae issues con los campos obligatorios que la especificación declara', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/agents', payload: {} });
    const body = res.json() as { code: string; issues: Array<{ path: string }> };
    expect(body.code).toBe('validation');
    expect((schemas.Error.properties as Json).code).toMatchObject({ enum: expect.arrayContaining([body.code]) });
    const requiredByTheSpec = [...((schemas.AgentInput.required ?? []) as string[])].sort();
    expect(requiredByTheSpec).toEqual(['model', 'name', 'providerId']);
    expect(body.issues.map((i) => i.path).sort()).toEqual(requiredByTheSpec);
  });

  it('los códigos de error que devuelve el servidor están en el enum de la especificación', async () => {
    const codes = (schemas.Error.properties as Record<string, Json>).code.enum as string[];
    for (const url of ['/api/agents/no-existe', '/api/runs?limit=0']) {
      const res = await app.inject({ method: 'GET', url });
      expect(codes).toContain(res.json().code);
    }
  });
});

describe('referencia legible', () => {
  it('docs/api.md está al día con la especificación (si falla: npm run docs:api)', () => {
    const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'api.md');
    const written = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    expect(written).toBe(renderApiMarkdown(buildOpenApi(APP_VERSION) as Record<string, unknown>));
  });
});

describe('ruta de la especificación', () => {
  it('GET /api/openapi.json devuelve el documento de buildOpenApi', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/openapi.json' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.json()).toEqual(JSON.parse(JSON.stringify(buildOpenApi(APP_VERSION))));
  });
});
