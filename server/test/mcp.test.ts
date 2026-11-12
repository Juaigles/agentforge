// Cliente MCP contra servidores MCP reales (SDK oficial): uno arrancado como proceso hijo (stdio) y otro por HTTP.
// El único doble es el proveedor LLM.
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Agent, McpServer, Provider, Run, ToolInfo } from '../../shared/types';
import { buildApp } from '../src/app';
import type { AppContext } from '../src/context';
import { localToolName, mcpResultText } from '../src/tools/mcp';
import { delay, edges, lastMessage, makeContext, node, runWorkflow, ScriptedLlm, tempDir, workflow } from './helpers';
// @ts-expect-error: módulo de pruebas en JavaScript, sin tipos.
import { buildServer } from './fixtures/mcp-server.mjs';

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'mcp-server.mjs');
const stdio = (extra: Record<string, unknown> = {}) => ({ name: 'eco', transport: 'stdio', command: process.execPath, args: [FIXTURE], ...extra });

let ctx: AppContext;
let app: FastifyInstance;
const dirs: string[] = [];
const servers: http.Server[] = [];

async function boot(llm = new ScriptedLlm(() => ({ content: 'ok' })), dataDir = tempDir()) {
  if (!dirs.includes(dataDir)) dirs.push(dataDir);
  ctx = makeContext(llm, { dataDir, inMemory: false });
  app = await buildApp(ctx);
  return { dataDir, llm };
}
async function shutdown() {
  await app?.close();
  await ctx?.close();
}
afterEach(async () => {
  await shutdown();
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const post = (url: string, payload?: unknown) => app.inject({ method: 'POST', url, payload: payload ?? {} });
const put = (url: string, payload: unknown) => app.inject({ method: 'PUT', url, payload: payload as object });
const get = (url: string) => app.inject({ method: 'GET', url });
const del = (url: string) => app.inject({ method: 'DELETE', url });
const invoke = async (name: string, args: Record<string, unknown> = {}) =>
  (await post(`/api/tools/${name}/invoke`, { args })).json() as { ok: boolean; result?: string; error?: string };
const mcpTools = async () => ((await get('/api/tools')).json() as ToolInfo[]).filter((t) => t.source === 'mcp');

/** Servidor MCP por HTTP (sin estado: un servidor y un transporte por petición), protegido con una cabecera. */
async function httpMcpServer(token: string): Promise<string> {
  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) return void res.writeHead(401, { 'Content-Type': 'text/plain' }).end('sin permiso');
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await buildServer().connect(transport);
    await transport.handleRequest(req, res);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
}

describe('nombres y resultados', () => {
  it('convierte el nombre remoto en uno válido, con el prefijo del servidor y sin repetir', () => {
    const taken = new Set<string>();
    expect(localToolName('eco', 'sumar', taken)).toBe('eco__sumar');
    expect(localToolName('eco', 'getEnv-Value', taken)).toBe('eco__get_env_value');
    expect(localToolName('eco', 'get_env.value', taken)).toBe('eco__get_env_value_2');
    expect(localToolName('eco', '¡¡!!', taken)).toBe('eco__tool');
    const long = localToolName('servidor_largo_de_mas', 'una_herramienta_con_un_nombre_larguisimo_de_verdad', taken);
    expect(long).toHaveLength(49);
    expect(long).toMatch(/^[a-z][a-z0-9_]{1,48}$/);
    const again = localToolName('servidor_largo_de_mas', 'una_herramienta_con_un_nombre_larguisimo_de_verdad', taken);
    expect(again).toHaveLength(49);
    expect(again).not.toBe(long);
    expect(again.endsWith('_2')).toBe(true);
  });

  it('convierte los bloques de contenido en texto para el modelo', () => {
    expect(
      mcpResultText({
        content: [
          { type: 'text', text: 'uno' },
          { type: 'text', text: 'dos' },
        ],
      }),
    ).toBe('uno\ndos');
    expect(mcpResultText({ content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] })).toBe('[image image/png: contenido no textual omitido]');
    expect(mcpResultText({ content: [{ type: 'resource', resource: { uri: 'file:///a', text: 'contenido' } }] })).toBe('contenido');
    expect(mcpResultText({ content: [{ type: 'resource_link', uri: 'file:///b' }] })).toBe('[recurso: file:///b]');
    expect(mcpResultText({ content: [], structuredContent: { total: 3 } })).toBe('{"total":3}');
    expect(mcpResultText({})).toBe('');
    expect(mcpResultText({ content: [{ type: 'text', text: 'x'.repeat(60_000) }] }).length).toBeLessThan(51_000);
  });
});

describe('servidor MCP por stdio', () => {
  it('arranca el programa, lee sus herramientas y las ofrece junto a las demás', async () => {
    await boot();
    const res = await post('/api/mcp/servers', stdio({ env: { CLAVE_SECRETA: 'valor-muy-secreto' } }));
    expect(res.statusCode).toBe(201);
    const server = res.json() as McpServer;
    expect(server).toMatchObject({
      name: 'eco',
      transport: 'stdio',
      enabled: true,
      status: 'connected',
      error: null,
      envKeys: ['CLAVE_SECRETA'],
      headerKeys: [],
    });
    expect(server.tools.map((t) => t.name)).toEqual([
      'eco__sumar',
      'eco__get_env_value',
      'eco__buscar',
      'eco__fallar',
      'eco__lenta',
      'eco__ampliar',
      'eco__salir',
    ]);
    // Los valores secretos no salen por la API y en la base de datos están cifrados.
    expect(res.body).not.toContain('valor-muy-secreto');
    expect((await get('/api/mcp/servers')).body).not.toContain('valor-muy-secreto');
    const row = ctx.db.prepare('SELECT env_enc FROM mcp_servers WHERE id = ?').get(server.id) as { env_enc: string };
    expect(row.env_enc).toMatch(/^v1:/);
    expect(row.env_enc).not.toContain('valor-muy-secreto');

    const listed = await mcpTools();
    expect(listed).toHaveLength(7);
    const sumar = listed.find((t) => t.name === 'eco__sumar')!;
    expect(sumar).toMatchObject({
      title: 'sumar',
      description: 'Suma dos números.',
      category: 'MCP · eco',
      source: 'mcp',
      enabled: true,
      mcpServerId: server.id,
      mcpServerName: 'eco',
    });
    expect(sumar.parameters).toMatchObject({ type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] });

    expect(await invoke('eco__sumar', { a: 2, b: 40 })).toMatchObject({ ok: true, result: '42' });
    // La variable de entorno configurada llega al programa (y solo ahí).
    expect(await invoke('eco__get_env_value', { name: 'CLAVE_SECRETA' })).toMatchObject({ ok: true, result: 'valor-muy-secreto' });
    // Esquemas anidados: los argumentos llegan intactos; el contenido no textual se resume.
    expect(await invoke('eco__buscar', { filtro: { categoria: 'libros', precio: { max: 20 } }, etiquetas: ['oferta', 'nuevo'] })).toMatchObject({
      ok: true,
      result: 'categoria=libros max=20 etiquetas=oferta+nuevo\n[image image/png: contenido no textual omitido]',
    });
  });

  it('los errores de la herramienta y los argumentos no válidos llegan como mensajes legibles', async () => {
    await boot();
    await post('/api/mcp/servers', stdio());
    expect(await invoke('eco__fallar')).toEqual(expect.objectContaining({ ok: false, error: 'no hay stock de ese producto' }));
    const bad = await invoke('eco__sumar', { a: 'dos', b: 1 });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/a|number|inv/i);
    expect((await post('/api/tools/eco__no_existe/invoke', { args: {} })).statusCode).toBe(404);
  });

  it('un agente usa una herramienta MCP: el modelo recibe su esquema completo y el resultado', async () => {
    const llm = new ScriptedLlm((req, i) => {
      if (i === 0) return { toolCalls: [{ id: 'c1', name: 'eco__sumar', arguments: { a: 19, b: 23 } }] };
      return { content: `El resultado es ${lastMessage(req).content}` };
    });
    await boot(llm);
    await post('/api/mcp/servers', stdio());
    const provider = (await post('/api/providers', { name: 'Local', kind: 'ollama', baseUrl: 'http://localhost:11434' })).json() as Provider;
    const agent = (await post('/api/agents', { name: 'Contable', providerId: provider.id, model: 'm', tools: ['eco__sumar', 'calculator'] })).json() as Agent;
    expect(agent.tools).toEqual(['eco__sumar', 'calculator']);

    const run = (await post(`/api/agents/${agent.id}/run`, { input: '¿cuánto es 19 + 23?' })).json() as Run;
    await ctx.runs.waitFor(run.id);
    expect(ctx.store.getRun(run.id)).toMatchObject({ status: 'completed', output: 'El resultado es 42' });
    const offered = llm.calls[0].tools!.find((t) => t.name === 'eco__sumar')!;
    expect(offered.description).toBe('Suma dos números.');
    expect(offered.parameters).toMatchObject({ type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] });
    expect(ctx.store.getRun(run.id)!.usage).toMatchObject({ llmCalls: 2, toolCalls: 1 });
  });

  it('un nodo de herramienta de un workflow puede ser una herramienta MCP', async () => {
    await boot();
    await post('/api/mcp/servers', stdio());
    const run = await runWorkflow(
      ctx,
      workflow(
        [
          node('entrada', 'input'),
          node('suma', 'tool', { tool: 'eco__sumar', args: { a: 5, b: 6 } }),
          node('salida', 'output', { template: 'total: {{suma}}' }),
        ],
        edges('entrada>suma', 'suma>salida'),
      ),
    );
    expect(run).toMatchObject({ status: 'completed', output: 'total: 11' });
    // Y la validación conoce la herramienta: un workflow que la usa no tiene errores.
    const wf = (
      await post(
        '/api/workflows',
        workflow([node('entrada', 'input'), node('suma', 'tool', { tool: 'eco__sumar', args: { a: 1, b: 2 } })], edges('entrada>suma')),
      )
    ).json();
    expect(((await post('/api/workflows/validate', wf)).json().issues as Array<{ level: string }>).filter((i) => i.level === 'error')).toEqual([]);
  });

  it('si el programa se cae, la siguiente llamada lo vuelve a arrancar sola', async () => {
    await boot();
    const server = (await post('/api/mcp/servers', stdio())).json() as McpServer;
    expect(await invoke('eco__salir')).toMatchObject({ ok: true, result: 'adiós' });
    for (let i = 0; i < 100 && ctx.mcp.get(server.id)!.status === 'connected'; i++) await delay(20);
    const down = ctx.mcp.get(server.id)!;
    expect(down.status).toBe('error');
    expect(down.error).toMatch(/Se perdió la conexión/);
    // Las herramientas siguen existiendo (los agentes que las usan no se rompen)…
    expect(down.tools).toHaveLength(7);
    // …y al usar una se reconecta.
    expect(await invoke('eco__sumar', { a: 1, b: 1 })).toMatchObject({ ok: true, result: '2' });
    expect(ctx.mcp.get(server.id)).toMatchObject({ status: 'connected', error: null });
  });

  it('explica por qué no arranca un programa que no existe o que termina con un error', async () => {
    await boot();
    const missing = (await post('/api/mcp/servers', { name: 'fantasma', transport: 'stdio', command: 'programa-que-no-existe-af' })).json() as McpServer;
    expect(missing).toMatchObject({ status: 'error', tools: [] });
    expect(missing.error).toBeTruthy();
    const broken = (await post('/api/mcp/servers', stdio({ name: 'roto', args: [FIXTURE, '--romper'] }))).json() as McpServer;
    expect(broken.status).toBe('error');
    expect(broken.error).toContain('configuración incompleta: falta la clave');
    expect(await mcpTools()).toEqual([]);
    // Corregido el argumento, conecta.
    const fixed = (await put(`/api/mcp/servers/${broken.id}`, stdio({ name: 'roto' }))).json() as McpServer;
    expect(fixed).toMatchObject({ status: 'connected', error: null });
    expect(fixed.tools).toHaveLength(7);
    // «Reconectar» lo vuelve a intentar a mano.
    expect((await post(`/api/mcp/servers/${missing.id}/reconnect`)).json()).toMatchObject({ status: 'error' });
    expect((await post('/api/mcp/servers/mcp_no_existe/reconnect')).statusCode).toBe(404);
  });

  it('una llamada se puede cancelar y tiene tiempo máximo', async () => {
    await boot();
    await post('/api/mcp/servers', stdio());
    const controller = new AbortController();
    const toolCtx = {
      runId: 'r',
      nodeId: 'n',
      signal: controller.signal,
      workspaceDir: ctx.config.workspaceDir,
      settings: ctx.store.getSettings(),
      memory: new Map<string, string>(),
    };
    const started = Date.now();
    const pending = ctx.tools.invoke('eco__lenta', { ms: 20_000 }, toolCtx);
    setTimeout(() => controller.abort(new Error('cancelada por el usuario')), 100);
    await expect(pending).rejects.toThrow('cancelada por el usuario');
    expect(Date.now() - started).toBeLessThan(5000);
    // El servidor sigue sirviendo después.
    expect(await invoke('eco__sumar', { a: 3, b: 4 })).toMatchObject({ ok: true, result: '7' });
  });

  it('se entera de que el servidor ha añadido una herramienta', async () => {
    await boot();
    const server = (await post('/api/mcp/servers', stdio())).json() as McpServer;
    expect(await invoke('eco__ampliar')).toMatchObject({ ok: true, result: 'ampliado' });
    for (let i = 0; i < 150 && ctx.mcp.get(server.id)!.tools.length < 8; i++) await delay(20);
    expect(ctx.mcp.get(server.id)!.tools.map((t) => t.name)).toContain('eco__extra');
    expect(await invoke('eco__extra')).toMatchObject({ ok: true, result: 'soy nueva' });
  });

  it('desactivar, renombrar y borrar un servidor cambia las herramientas disponibles', async () => {
    await boot();
    const server = (await post('/api/mcp/servers', stdio())).json() as McpServer;
    expect(await mcpTools()).toHaveLength(7);

    const off = (await put(`/api/mcp/servers/${server.id}`, stdio({ enabled: false }))).json() as McpServer;
    expect(off).toMatchObject({ enabled: false, status: 'disabled' });
    expect(await mcpTools()).toEqual([]);
    expect((await post('/api/tools/eco__sumar/invoke', { args: { a: 1, b: 1 } })).statusCode).toBe(404);

    const renamed = (await put(`/api/mcp/servers/${server.id}`, stdio({ name: 'calc' }))).json() as McpServer;
    expect(renamed).toMatchObject({ name: 'calc', status: 'connected' });
    expect((await mcpTools()).map((t) => t.name)).toContain('calc__sumar');
    expect(await invoke('calc__sumar', { a: 1, b: 1 })).toMatchObject({ ok: true, result: '2' });

    expect((await del(`/api/mcp/servers/${server.id}`)).statusCode).toBe(204);
    expect((await del(`/api/mcp/servers/${server.id}`)).statusCode).toBe(404);
    expect((await get('/api/mcp/servers')).json()).toEqual([]);
    expect(await mcpTools()).toEqual([]);
  });

  it('valida la configuración y no admite dos servidores con el mismo nombre', async () => {
    await boot();
    for (const [bad, field] of [
      [{ name: 'Eco', transport: 'stdio', command: 'x' }, 'name'],
      [{ name: 'e', transport: 'stdio', command: 'x' }, 'name'],
      [{ name: 'un_nombre_demasiado_largo', transport: 'stdio', command: 'x' }, 'name'],
      [{ name: 'eco', transport: 'stdio' }, 'command'],
      [{ name: 'eco', transport: 'http', url: 'ftp://x' }, 'url'],
      [{ name: 'eco', transport: 'http' }, 'url'],
      [{ name: 'eco', transport: 'stdio', command: 'x', env: { 'MI CLAVE': '1' } }, 'env'],
      [{ name: 'eco', transport: 'http', url: 'http://x', headers: { 'X-A': 'a\nb' } }, 'headers'],
      [{ name: 'eco', transport: 'websocket', url: 'http://x' }, 'transport'],
    ] as Array<[Record<string, unknown>, string]>) {
      const res = await post('/api/mcp/servers', bad);
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
      expect(res.json().issues[0].path, JSON.stringify(bad)).toBe(field);
    }
    expect((await post('/api/mcp/servers', stdio({ enabled: false }))).statusCode).toBe(201);
    expect((await post('/api/mcp/servers', stdio({ enabled: false }))).statusCode).toBe(409);
    expect((await put('/api/mcp/servers/mcp_no_existe', stdio({ name: 'otro' }))).statusCode).toBe(404);
  });

  it('tras un reinicio las herramientas se conocen desde el primer momento y el servidor vuelve a conectarse', async () => {
    const { dataDir } = await boot();
    const server = (await post('/api/mcp/servers', stdio({ env: { CLAVE_SECRETA: 'persistente' } }))).json() as McpServer;
    await shutdown();

    await boot(undefined, dataDir);
    // Antes de que termine la conexión ya se sabe qué herramientas ofrece (lista guardada).
    expect(ctx.mcp.get(server.id)!.tools).toHaveLength(7);
    expect(ctx.tools.names()).toContain('eco__sumar');
    await ctx.mcp.start();
    expect(ctx.mcp.get(server.id)).toMatchObject({ status: 'connected', envKeys: ['CLAVE_SECRETA'] });
    expect(await invoke('eco__get_env_value', { name: 'CLAVE_SECRETA' })).toMatchObject({ ok: true, result: 'persistente' });
    // Editar sin enviar las variables conserva las guardadas.
    await put(`/api/mcp/servers/${server.id}`, stdio());
    expect(await invoke('eco__get_env_value', { name: 'CLAVE_SECRETA' })).toMatchObject({ ok: true, result: 'persistente' });
    // Enviarlas vacías las borra.
    await put(`/api/mcp/servers/${server.id}`, stdio({ env: {} }));
    expect(await invoke('eco__get_env_value', { name: 'CLAVE_SECRETA' })).toMatchObject({ ok: true, result: '(sin definir)' });
  });
});

describe('servidor MCP por HTTP', () => {
  it('conecta con las cabeceras configuradas y usa sus herramientas', async () => {
    await boot();
    const url = await httpMcpServer('s3creto-http');
    const denied = (await post('/api/mcp/servers', { name: 'remoto', transport: 'http', url })).json() as McpServer;
    expect(denied.status).toBe('error');
    expect(denied.error).toBeTruthy();
    expect(denied.tools).toEqual([]);

    const res = await put(`/api/mcp/servers/${denied.id}`, { name: 'remoto', transport: 'http', url, headers: { Authorization: 'Bearer s3creto-http' } });
    const server = res.json() as McpServer;
    expect(server).toMatchObject({ transport: 'http', url, status: 'connected', error: null, headerKeys: ['Authorization'] });
    expect(res.body).not.toContain('s3creto-http');
    expect(server.tools.map((t) => t.name)).toContain('remoto__sumar');
    expect(await invoke('remoto__sumar', { a: 20, b: 22 })).toMatchObject({ ok: true, result: '42' });
    expect(await invoke('remoto__fallar')).toMatchObject({ ok: false, error: 'no hay stock de ese producto' });
    const row = ctx.db.prepare('SELECT headers_enc FROM mcp_servers WHERE id = ?').get(server.id) as { headers_enc: string };
    expect(row.headers_enc).not.toContain('s3creto-http');
  });

  it('convive con un servidor stdio: cada herramienta va al suyo', async () => {
    await boot();
    const url = await httpMcpServer('t');
    await post('/api/mcp/servers', stdio());
    await post('/api/mcp/servers', { name: 'remoto', transport: 'http', url, headers: { Authorization: 'Bearer t' } });
    expect((await get('/api/mcp/servers')).json().map((s: McpServer) => [s.name, s.status])).toEqual([
      ['eco', 'connected'],
      ['remoto', 'connected'],
    ]);
    expect(await mcpTools()).toHaveLength(14);
    expect(await invoke('eco__sumar', { a: 1, b: 2 })).toMatchObject({ result: '3' });
    expect(await invoke('remoto__sumar', { a: 10, b: 20 })).toMatchObject({ result: '30' });
  });
});
