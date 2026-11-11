// Seguridad de la capa HTTP y de las herramientas: claves ligadas a su origen, Host, clave de acceso, origen de
// las peticiones, límite de tasa, cabeceras, acceso a la propia API, redirecciones, plantillas, cuotas,
// aislamiento de red de run_javascript y fijación de DNS contra un servidor DNS real.
import { spawn } from 'node:child_process';
import { promises as dnsPromises } from 'node:dns';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../src/config';
import { buildApp } from '../src/app';
import { createContext, type AppContext } from '../src/context';
import { defaultLlmFactory, type LlmFactory } from '../src/llm';
import { buildAllowedHosts, buildCsp, isCrossSiteRequest, RateLimiter } from '../src/security';
import { MAX_FILE_BYTES } from '../src/tools/builtin';
import { isPrivateAddress, safeFetch } from '../src/tools/net';
import { renderBodyTemplate } from '../src/tools/registry';
import {
  containerRunArgs,
  detectContainerEngine,
  hasNetPermission,
  probeProcessNetworkBlocked,
  runJavaScript,
  SANDBOX_NETWORK_LOCKDOWN,
  sandboxNodeArgs,
  sandboxStatus,
} from '../src/tools/sandbox';
import { startDnsServer } from './dns-server';
import { addAgent, edges, node, runWorkflow, ScriptedLlm, startServer, tempDir, testConfig, workflow } from './helpers';

let ctx: AppContext | undefined;
let app: FastifyInstance | undefined;
const dirs: string[] = [];
const cleanups: Array<() => unknown> = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
  await app?.close();
  await ctx?.close();
  app = undefined;
  ctx = undefined;
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function boot(overrides: Partial<AppConfig> = {}, llm: LlmFactory = new ScriptedLlm(() => ({ content: 'ok' }))) {
  const dir = tempDir();
  dirs.push(dir);
  ctx = createContext({ ...testConfig(dir), ...overrides }, { llm, inMemory: true, retryBaseDelayMs: 5 });
  app = await buildApp(ctx);
  return { ctx, app };
}

const signal = () => new AbortController().signal;

describe('las API keys guardadas no salen hacia otra dirección', () => {
  it('probar o listar modelos con otra URL exige volver a escribir la clave; con la misma, usa la guardada', async () => {
    // Con los adaptadores reales: lo que se comprueba es qué cabecera llega de verdad a cada servidor.
    const { app, ctx } = await boot({}, defaultLlmFactory);
    const legit = await startServer((_req, res) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'm1' }] })));
    const attacker = await startServer((_req, res) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [] })));
    cleanups.push(legit.close, attacker.close);
    const provider = ctx.store.createProvider({ name: 'Remoto', kind: 'openai', baseUrl: `${legit.url}/v1`, apiKey: 'sk-muy-secreta' });
    const body = (baseUrl: string, extra: object = {}) => ({ id: provider.id, name: 'Remoto', kind: 'openai', baseUrl, ...extra });

    for (const url of ['/api/providers/test', '/api/providers/models']) {
      const res = await app.inject({ method: 'POST', url, payload: body(`${attacker.url}/v1`) });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: expect.stringContaining('vuelve a escribir la API key'), details: { code: 'api_key_required' } });
    }
    expect(attacker.requests).toEqual([]);

    // Misma dirección (aunque cambie la ruta): se prueba con la clave guardada.
    const same = await app.inject({ method: 'POST', url: '/api/providers/test', payload: body(`${legit.url}/v1`) });
    expect(same.json()).toMatchObject({ ok: true, modelCount: 1 });
    expect(legit.requests.at(-1)!.headers.authorization).toBe('Bearer sk-muy-secreta');

    // Otra dirección con una clave escrita a propósito: se usa esa, no la guardada.
    const explicit = await app.inject({ method: 'POST', url: '/api/providers/test', payload: body(`${attacker.url}/v1`, { apiKey: 'otra-clave' }) });
    expect(explicit.json().ok).toBe(true);
    expect(attacker.requests.map((r) => r.headers.authorization)).toEqual(['Bearer otra-clave']);
  });

  it('guardar un proveedor con otra dirección no arrastra la clave: hay que escribirla o quitarla', async () => {
    const { app, ctx } = await boot();
    const provider = ctx.store.createProvider({ name: 'Remoto', kind: 'openai', baseUrl: 'https://api.legitima.example/v1', apiKey: 'sk-muy-secreta' });
    const put = (payload: object) => app.inject({ method: 'PUT', url: `/api/providers/${provider.id}`, payload });
    const base = { name: 'Remoto', kind: 'openai' };

    const moved = await put({ ...base, baseUrl: 'https://atacante.example/v1' });
    expect(moved.statusCode).toBe(400);
    expect(ctx.store.getProviderWithSecret(provider.id)).toMatchObject({ baseUrl: 'https://api.legitima.example/v1', apiKey: 'sk-muy-secreta' });

    // Cambiar solo la ruta, dentro del mismo origen, conserva la clave.
    expect((await put({ ...base, baseUrl: 'https://api.legitima.example/v2' })).statusCode).toBe(200);
    expect(ctx.store.getProviderWithSecret(provider.id)!.apiKey).toBe('sk-muy-secreta');
    // Cambiar de dirección escribiendo la clave nueva, o quitándola, sí se admite.
    expect((await put({ ...base, baseUrl: 'https://nuevo.example/v1', apiKey: 'sk-nueva' })).statusCode).toBe(200);
    expect(ctx.store.getProviderWithSecret(provider.id)).toMatchObject({ baseUrl: 'https://nuevo.example/v1', apiKey: 'sk-nueva' });
    expect((await put({ ...base, baseUrl: 'https://tercero.example/v1', apiKey: null })).statusCode).toBe(200);
    expect(ctx.store.getProviderWithSecret(provider.id)!.apiKey).toBeNull();
  });
});

describe('cabecera Host', () => {
  it('al escuchar en todas las interfaces la comprobación sigue activa', async () => {
    const { app } = await boot({ host: '0.0.0.0', authToken: 'una-clave-bien-larga', allowedHosts: ['forge.midominio.test'] });
    const status = async (host: string) => (await app.inject({ method: 'GET', url: '/api/health/live', headers: { host } })).statusCode;
    expect(await status('evil.example.com')).toBe(403);
    expect(await status('rebind.atacante.test:4310')).toBe(403);
    expect(await status('localhost:4310')).toBe(200);
    expect(await status('127.0.0.1')).toBe(200);
    expect(await status('forge.midominio.test')).toBe(200);
    expect(await status(`${os.hostname()}:4310`)).toBe(200);
    // Las direcciones de las interfaces del propio equipo también valen.
    const ownIp = Object.values(os.networkInterfaces())
      .flat()
      .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
    if (ownIp) expect(await status(`${ownIp}:4310`)).toBe(200);
  });

  it('los hosts admitidos se calculan a partir de la configuración', () => {
    expect([...buildAllowedHosts({ host: '127.0.0.1', allowedHosts: [] })].sort()).toEqual(['127.0.0.1', '[::1]', 'localhost']);
    expect(buildAllowedHosts({ host: '192.168.1.20', allowedHosts: ['Mi.Proxy.Test'] })).toEqual(new Set(['localhost', '127.0.0.1', '[::1]', 'mi.proxy.test', '192.168.1.20']));
    expect(buildAllowedHosts({ host: '::', allowedHosts: [] }).has(os.hostname().toLowerCase())).toBe(true);
    expect(buildAllowedHosts({ host: '0.0.0.0', allowedHosts: [] }).has('cualquier.cosa')).toBe(false);
  });
});

describe('clave de acceso', () => {
  const token = 'clave-de-acceso-de-prueba';

  it('sin clave configurada la API es de libre acceso en este equipo', async () => {
    const { app } = await boot();
    expect((await app.inject({ method: 'GET', url: '/api/auth/status' })).json()).toEqual({ required: false, authenticated: true });
    expect((await app.inject({ method: 'GET', url: '/api/agents' })).statusCode).toBe(200);
  });

  it('con clave, todo exige sesión o cabecera Authorization, salvo el inicio de sesión y la sonda de vida', async () => {
    const { app } = await boot({ authToken: token });
    expect((await app.inject({ method: 'GET', url: '/api/agents' })).json()).toMatchObject({ code: 'auth_required' });
    for (const url of ['/api/agents', '/api/settings', '/api/stats', '/api/stream/runs', '/api/health/ready', '/api/workspace/files']) {
      expect((await app.inject({ method: 'GET', url })).statusCode, url).toBe(401);
    }
    expect((await app.inject({ method: 'PUT', url: '/api/settings', payload: { allowCodeExecution: true } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/health/live' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/auth/status' })).json()).toEqual({ required: true, authenticated: false });

    // Cabecera Authorization (clientes de API).
    expect((await app.inject({ method: 'GET', url: '/api/agents', headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/agents', headers: { authorization: 'Bearer otra-cosa-distinta-larga' } })).statusCode).toBe(401);

    // Inicio de sesión (navegador): clave incorrecta, clave correcta y cookie.
    expect((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { token: 'no-es-esta' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/auth/login', payload: {} })).statusCode).toBe(401);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { token } });
    expect(login.statusCode).toBe(204);
    const setCookie = String(login.headers['set-cookie']);
    expect(setCookie).toMatch(/^af_session=[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+$/);
    // La cookie no es la clave ni la contiene.
    expect(setCookie).not.toContain(token);
    const cookie = setCookie.split(';')[0];
    expect((await app.inject({ method: 'GET', url: '/api/agents', headers: { cookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/auth/status', headers: { cookie } })).json()).toEqual({ required: true, authenticated: true });
    expect((await app.inject({ method: 'GET', url: '/api/agents', headers: { cookie: 'af_session=0000' } })).statusCode).toBe(401);

    const logout = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
    expect(String(logout.headers['set-cookie'])).toMatch(/af_session=; .*Max-Age=0/);
  });

  it('el inicio de sesión tiene su propio límite de intentos', async () => {
    const { app } = await boot({ authToken: token, rateLimitPerMinute: 1000 });
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { token: `intento-${i}` } })).statusCode);
    expect(codes.slice(0, 10)).toEqual(Array(10).fill(401));
    expect(codes.slice(10)).toEqual([429, 429]);
    // Ni siquiera con la clave correcta mientras dure el bloqueo.
    expect((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { token } })).statusCode).toBe(429);
  });
});

describe('peticiones desde otra web (CSRF)', () => {
  it('rechaza las que el navegador marca como de otro sitio o cuyo Origin no coincide', async () => {
    const { app, ctx } = await boot();
    const agent = addAgent(ctx);
    const wf = ctx.store.createWorkflow(workflow([node('a', 'agent', { agentId: agent.id, prompt: 'x' })], []));
    const host = 'localhost:4310';
    const send = (headers: Record<string, string>, method: 'GET' | 'POST' = 'POST', url = '/api/runs/interrupted/resume') => app.inject({ method, url, headers: { host, ...headers } });

    // Un POST sin cuerpo desde otra web (la petición «simple» que no pasa por preflight).
    expect((await send({ origin: 'https://atacante.example', 'sec-fetch-site': 'cross-site' })).statusCode).toBe(403);
    expect((await send({ origin: 'https://atacante.example' })).statusCode).toBe(403);
    expect((await send({ 'sec-fetch-site': 'cross-site' })).statusCode).toBe(403);
    // Otra aplicación del mismo equipo en otro puerto es otro origen.
    expect((await send({ origin: 'http://localhost:3000', 'sec-fetch-site': 'same-site' })).statusCode).toBe(403);
    expect((await send({ origin: 'null' })).statusCode).toBe(403);
    // Tampoco lecturas disparadas desde otra web (p. ej. una imagen que fuerce comprobaciones de proveedores).
    expect((await send({ 'sec-fetch-site': 'cross-site' }, 'GET', '/api/providers/health?force=1')).statusCode).toBe(403);
    expect((await send({ origin: 'https://atacante.example' }, 'POST', `/api/workflows/${wf.id}/run`)).statusCode).toBe(403);
    expect(ctx.store.listRuns().total).toBe(0);

    // La propia interfaz (mismo origen), una pestaña que el usuario abre a mano y los clientes sin navegador pasan.
    expect((await send({ origin: 'http://localhost:4310', 'sec-fetch-site': 'same-origin' })).statusCode).toBe(202);
    expect((await send({ 'sec-fetch-site': 'none' }, 'GET', '/api/agents')).statusCode).toBe(200);
    expect((await send({})).statusCode).toBe(202);
  });

  it('isCrossSiteRequest distingue los casos', () => {
    expect(isCrossSiteRequest({ host: 'a.test' })).toBe(false);
    expect(isCrossSiteRequest({ host: 'a.test', origin: 'http://a.test' })).toBe(false);
    expect(isCrossSiteRequest({ host: 'a.test:4310', origin: 'http://A.test:4310' })).toBe(false);
    expect(isCrossSiteRequest({ host: 'a.test', origin: 'http://b.test' })).toBe(true);
    expect(isCrossSiteRequest({ host: 'a.test', origin: 'no es una url' })).toBe(true);
    expect(isCrossSiteRequest({ host: 'a.test', 'sec-fetch-site': 'same-origin' })).toBe(false);
    expect(isCrossSiteRequest({ host: 'a.test', 'sec-fetch-site': 'same-site' })).toBe(true);
  });
});

describe('límite de tasa', () => {
  it('corta al superar el límite por minuto y dice cuándo reintentar', async () => {
    const { app } = await boot({ rateLimitPerMinute: 5 });
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await app.inject({ method: 'GET', url: '/api/agents' })).statusCode);
    expect(codes).toEqual([200, 200, 200, 200, 200, 429, 429]);
    const blocked = await app.inject({ method: 'GET', url: '/api/agents' });
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(blocked.json().error).toMatch(/Demasiadas peticiones/);
    // La interfaz (archivos estáticos) no cuenta para el límite de la API.
    expect((await app.inject({ method: 'GET', url: '/' })).statusCode).not.toBe(429);
  });

  it('lo que lanza trabajo caro tiene un límite más estricto que el resto', async () => {
    const { app, ctx } = await boot({ rateLimitPerMinute: 400 }); // 40 por minuto para lo caro
    const agent = addAgent(ctx);
    const codes: number[] = [];
    for (let i = 0; i < 42; i++) codes.push((await app.inject({ method: 'POST', url: `/api/agents/${agent.id}/run`, payload: { input: 'x' } })).statusCode);
    expect(codes.filter((c) => c === 202)).toHaveLength(40);
    expect(codes.slice(40)).toEqual([429, 429]);
    expect((await app.inject({ method: 'GET', url: '/api/agents' })).statusCode).toBe(200);
  });

  it('la ventana se renueva y cada cliente tiene la suya', () => {
    const limiter = new RateLimiter(1000);
    expect([limiter.hit('a', 2, 0), limiter.hit('a', 2, 10), limiter.hit('a', 2, 20)]).toEqual([0, 0, 1]);
    expect(limiter.hit('b', 2, 20)).toBe(0);
    expect(limiter.hit('a', 2, 1001)).toBe(0);
    expect(limiter.hit('a', 0, 1002)).toBe(0); // 0 = sin límite
  });
});

describe('cabeceras de seguridad', () => {
  it('todas las respuestas llevan política de contenido, anti-encuadre y nosniff', async () => {
    const { app } = await boot();
    for (const url of ['/api/health', '/api/no-existe', '/']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.headers['x-frame-options'], url).toBe('DENY');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      const csp = String(res.headers['content-security-policy']);
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("object-src 'none'");
      expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    }
  });

  it('la política admite por su hash los scripts en línea de index.html, y solo esos', () => {
    const dir = tempDir();
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'index.html'), '<html><head><script>var t = 1;</script><script type="module" src="/a.js"></script></head></html>');
    const csp = buildCsp(dir);
    // sha256 de «var t = 1;» en base64.
    expect(csp).toMatch(/script-src 'self' 'sha256-[A-Za-z0-9+/]{43}='/);
    expect(csp.match(/sha256-/g)).toHaveLength(1);
    expect(buildCsp(path.join(dir, 'no-existe'))).toContain("script-src 'self';");
  });
});

describe('las herramientas no pueden llamar a la propia API', () => {
  it('ni con «redes privadas» permitidas; el resto de la red local sí', async () => {
    const { app, ctx } = await boot();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as AddressInfo).port;
    ctx.store.updateSettings({ allowPrivateNetwork: true });
    const other = await startServer((_req, res) => res.writeHead(200, { 'Content-Type': 'text/plain' }).end('vecino'));
    cleanups.push(other.close);
    const invoke = async (url: string, method = 'GET', body?: string) =>
      (await app.inject({ method: 'POST', url: '/api/tools/http_request/invoke', payload: { args: { url, method, ...(body ? { body } : {}) } } })).json();

    for (const target of [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`, `http://[::ffff:127.0.0.1]:${port}`, `http://0.0.0.0:${port}`]) {
      const res = await invoke(`${target}/api/settings`, 'PUT', JSON.stringify({ allowCodeExecution: true }));
      expect(res, target).toMatchObject({ ok: false, error: expect.stringContaining('propia API de AgentForge') });
    }
    expect(ctx.store.getSettings().allowCodeExecution).toBe(false);
    expect(await invoke(`${other.url}/dato`)).toMatchObject({ ok: true });
    expect(other.requests).toHaveLength(1);

    // Al cerrar el servidor el puerto deja de estar protegido (otro programa podría reutilizarlo).
    await app.close();
    await expect(safeFetch(`http://127.0.0.1:${port}/`, { signal: signal(), allowPrivate: true, timeoutMs: 1000 })).rejects.toThrow(/Fallo de red/);
  });
});

describe('redirecciones', () => {
  it('las credenciales de la herramienta no viajan a otro origen, pero sí dentro del mismo', async () => {
    const elsewhere = await startServer((_req, res) => res.writeHead(200).end('otro sitio'));
    const origin = await startServer((req, res) => {
      if (req.url === '/fuera') return res.writeHead(302, { Location: `${elsewhere.url}/robo` }).end();
      if (req.url === '/dentro') return res.writeHead(302, { Location: '/destino' }).end();
      return res.writeHead(200).end('mismo sitio');
    });
    cleanups.push(origin.close, elsewhere.close);
    const headers = { Authorization: 'Bearer secreto', 'X-Api-Key': 'k-123', Cookie: 'sesion=1' };

    const out = await safeFetch(`${origin.url}/fuera`, { signal: signal(), allowPrivate: true, headers });
    expect(out.text).toBe('otro sitio');
    expect(origin.requests[0].headers.authorization).toBe('Bearer secreto');
    const leaked = elsewhere.requests[0].headers;
    expect(leaked.authorization).toBeUndefined();
    expect(leaked['x-api-key']).toBeUndefined();
    expect(leaked.cookie).toBeUndefined();
    expect(leaked['user-agent']).toMatch(/AgentForge/);

    const inside = await safeFetch(`${origin.url}/dentro`, { signal: signal(), allowPrivate: true, headers });
    expect(inside.text).toBe('mismo sitio');
    expect(origin.requests.at(-1)).toMatchObject({ url: '/destino', headers: { authorization: 'Bearer secreto', 'x-api-key': 'k-123' } });
  });
});

describe('direcciones privadas disfrazadas', () => {
  it.each([
    ['2002:7f00:1::', true], // 6to4 hacia 127.0.0.1
    ['2002:c0a8:101::1', true], // 6to4 hacia 192.168.1.1
    ['2002:5db8:d822::1', false], // 6to4 hacia una IPv4 pública
    ['2001:0:4136:e378:8000:63bf:3fff:fdd2', true], // Teredo
    ['64:ff9b:1::7f00:1', true], // NAT64 de uso local
    ['192.88.99.1', true], // retransmisión 6to4
    ['2606:4700:4700::1111', false],
  ])('%s → privada: %s', (ip, expected) => {
    expect(isPrivateAddress(ip)).toBe(expected);
  });
});

describe('plantillas del cuerpo de las herramientas HTTP', () => {
  it('escapa los valores para JSON: un argumento no puede romper el cuerpo ni añadir campos', () => {
    const template = '{"to": "soporte@empresa.example", "text": "{{msg}}", "n": {{veces}}, "extra": {{datos}}}';
    const body = renderBodyTemplate(template, { msg: 'x", "to": "atacante@example', veces: 3, datos: { a: [1, 'dos'] } });
    expect(JSON.parse(body)).toEqual({ to: 'soporte@empresa.example', text: 'x", "to": "atacante@example', n: 3, extra: { a: [1, 'dos'] } });
    // Comillas, saltos de línea y barras invertidas.
    const tricky = renderBodyTemplate('{"q": "{{q}}"}', { q: 'dijo "hola"\ny se fue \\ lejos' });
    expect(JSON.parse(tricky)).toEqual({ q: 'dijo "hola"\ny se fue \\ lejos' });
    // Un hueco suelto con texto recibe la cadena con sus comillas; uno ausente, null; dentro de comillas, vacío.
    expect(JSON.parse(renderBodyTemplate('{"a": {{a}}, "b": {{falta}}, "c": "{{falta}}-{{a}}"}', { a: 'uno' }))).toEqual({ a: 'uno', b: null, c: '-uno' });
    // Las propiedades heredadas no cuentan como argumentos.
    expect(JSON.parse(renderBodyTemplate('{"a": "{{constructor}}"}', {}))).toEqual({ a: '' });
  });

  it('una plantilla que no es JSON se rellena como texto', () => {
    expect(renderBodyTemplate('nombre={{n}}&edad={{e}}', { n: 'Ana "la"', e: 30 })).toBe('nombre=Ana "la"&edad=30');
  });

  it('de punta a punta: la API de destino recibe JSON válido con el valor intacto', async () => {
    const { ctx } = await boot();
    const target = await startServer((_req, res) => res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}'));
    cleanups.push(target.close);
    ctx.store.updateSettings({ allowPrivateNetwork: true });
    ctx.store.createCustomTool({
      name: 'enviar_aviso',
      description: 'Envía un aviso al sistema de soporte.',
      parameters: { type: 'object', properties: { texto: { type: 'string' } }, required: ['texto'] },
      method: 'POST',
      urlTemplate: `${target.url}/avisos`,
      headers: { 'X-Origen': 'agente {{texto}}' },
      bodyTemplate: '{"canal": "soporte", "texto": "{{texto}}"}',
      enabled: true,
    });
    const run = await runWorkflow(ctx, workflow([node('t', 'tool', { tool: 'enviar_aviso', args: { texto: 'hola", "canal": "direccion\r\nX-Inyectada: 1' } })], []));
    expect(run.status).toBe('completed');
    expect(JSON.parse(target.requests[0].body)).toEqual({ canal: 'soporte', texto: 'hola", "canal": "direccion\r\nX-Inyectada: 1' });
    expect(target.requests[0].headers['x-inyectada']).toBeUndefined();
  });
});

describe('cuota del espacio de trabajo', () => {
  it('un archivo no puede crecer sin límite añadiendo contenido', async () => {
    const { ctx } = await boot();
    const write = (content: string, append = true) =>
      ctx.tools.invoke('file_write', { path: 'registro.txt', content, append }, { runId: 'r', nodeId: 'n', signal: signal(), workspaceDir: ctx.config.workspaceDir, settings: ctx.store.getSettings(), memory: new Map() });
    const chunk = 'x'.repeat(1_000_000);
    for (let i = 0; i < MAX_FILE_BYTES / 1_000_000; i++) await write(chunk);
    await expect(write('y')).rejects.toThrow(/límite de 5 MB por archivo/);
    expect(fs.statSync(path.join(ctx.config.workspaceDir, 'registro.txt')).size).toBe(MAX_FILE_BYTES);
    // Sobrescribir con algo pequeño sigue siendo posible.
    await expect(write('nuevo', false)).resolves.toMatchObject({ sizeBytes: 5 });
  });

  it('la API no carga en memoria un archivo grande para mostrarlo', async () => {
    const { app, ctx } = await boot();
    fs.writeFileSync(path.join(ctx.config.workspaceDir, 'grande.txt'), 'a'.repeat(1_200_000));
    const res = (await app.inject({ method: 'GET', url: '/api/workspace/file?path=grande.txt' })).json();
    expect(res).toMatchObject({ sizeBytes: 1_200_000, truncated: true });
    expect(res.content).toHaveLength(500_000);
  });
});

describe('consultas con parámetros no válidos', () => {
  it('devuelven 400 con un mensaje, no un error interno', async () => {
    const { app } = await boot();
    for (const query of ['limit=abc', 'limit=1.5', 'limit=0', 'limit=500', 'offset=-1', 'offset=x', 'status=raro', 'kind=otro']) {
      const res = await app.inject({ method: 'GET', url: `/api/runs?${query}` });
      expect(res.statusCode, query).toBe(400);
      expect(res.json().error).toMatch(/Datos no válidos/);
      // El mensaje está en el idioma de la aplicación, no es el texto interno de la biblioteca de validación.
      expect(res.json().error).not.toMatch(/Invalid|expected/);
    }
    expect((await app.inject({ method: 'GET', url: '/api/runs?limit=abc' })).json().error).toBe('Datos no válidos: limit: debe ser un número entero entre 1 y 200');
    expect((await app.inject({ method: 'GET', url: '/api/runs?limit=10&offset=0&status=completed&kind=workflow&search=x' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/runs' })).json()).toEqual({ items: [], total: 0 });
  });
});

describe('sondas de salud', () => {
  it('la de disponibilidad comprueba de verdad la base de datos, la carpeta de datos y el planificador', async () => {
    const { app, ctx } = await boot();
    const stopped = await app.inject({ method: 'GET', url: '/api/health/ready' });
    expect(stopped.statusCode).toBe(503);
    expect(stopped.json()).toMatchObject({ ok: false, checks: { database: { ok: true }, dataDir: { ok: true }, scheduler: { ok: false } } });

    ctx.scheduler.start(60_000);
    const ready = await app.inject({ method: 'GET', url: '/api/health/ready' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({ ok: true, activeRuns: 0, queuedRuns: 0, checks: { database: { ok: true, detail: expect.stringMatching(/^esquema v\d+$/) } } });

    fs.rmSync(ctx.config.workspaceDir, { recursive: true, force: true });
    const broken = await app.inject({ method: 'GET', url: '/api/health/ready' });
    expect(broken.statusCode).toBe(503);
    expect(broken.json().checks.dataDir.ok).toBe(false);
    expect((await app.inject({ method: 'GET', url: '/api/health/live' })).statusCode).toBe(200);
  });
});

describe('run_javascript sin red', () => {
  /** Lanza el proceso aislado con sus argumentos y su preludio reales y, dentro, un intento de usar la red. */
  function attack(script: string): Promise<{ stdout: string }> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [...sandboxNodeArgs(), '-e', `${SANDBOX_NETWORK_LOCKDOWN}\n${script}`], { env: {}, cwd: os.tmpdir(), windowsHide: true });
      let stdout = '';
      child.stdout.on('data', (c) => (stdout += c));
      const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
      child.on('close', () => {
        clearTimeout(timer);
        resolve({ stdout });
      });
    });
  }

  it('aunque el código escapara del contexto, el proceso no puede abrir conexiones, resolver nombres ni usar fetch', async () => {
    const target = await startServer((_req, res) => res.writeHead(200).end('alcanzado'));
    cleanups.push(target.close);
    const port = new URL(target.url).port;
    const { stdout } = await attack(`
      const out = {};
      const attempt = (name, fn) => { try { const r = fn(); out[name] = r && typeof r.then === 'function' ? 'promesa' : 'sin error'; if (r && r.catch) r.catch(() => {}); } catch (e) { out[name] = e.code || e.message; } };
      attempt('net.connect', () => require('node:net').connect(${port}, '127.0.0.1'));
      attempt('Socket.connect', () => new (require('node:net').Socket)().connect(${port}, '127.0.0.1'));
      attempt('http.get', () => require('node:http').get('http://127.0.0.1:${port}/').on('error', () => {}));
      attempt('fetch', () => fetch('http://127.0.0.1:${port}/'));
      attempt('tls.connect', () => require('node:tls').connect(${port}, '127.0.0.1'));
      attempt('dgram.send', () => require('node:dgram').createSocket('udp4').send('x', ${port}, '127.0.0.1'));
      attempt('dns.lookup', () => require('node:dns').lookup('example.com', () => {}));
      attempt('dns.resolve4', () => require('node:dns').promises.resolve4('example.com'));
      attempt('Resolver', () => new (require('node:dns').Resolver)().resolve4('example.com', () => {}));
      attempt('listen', () => require('node:net').createServer().listen(0));
      attempt('binding', () => process.binding('tcp_wrap'));
      try { require('node:net').Socket.prototype.connect = function original() {}; } catch {}
      try { delete require('node:net').Socket.prototype.connect; } catch {}
      attempt('trasRestaurar', () => new (require('node:net').Socket)().connect(${port}, '127.0.0.1'));
      setTimeout(() => { process.stdout.write(JSON.stringify(out)); }, 300);
    `);
    const out = JSON.parse(stdout) as Record<string, string>;
    for (const name of ['net.connect', 'Socket.connect', 'fetch', 'tls.connect', 'dgram.send', 'dns.lookup', 'dns.resolve4', 'Resolver', 'listen', 'binding']) {
      expect(out[name], name).toBe('ERR_ACCESS_DENIED');
    }
    // http.get lanza al conectar el socket, de forma síncrona o como evento de error; en ningún caso llega.
    expect(['ERR_ACCESS_DENIED', 'sin error']).toContain(out['http.get']);
    // El bloqueo no se puede deshacer reasignando ni borrando el método.
    expect(out.trasRestaurar).toBe('ERR_ACCESS_DENIED');
    expect(target.requests).toEqual([]);
  });

  it('la comprobación de arranque confirma con una conexión real que el proceso aislado no tiene red', async () => {
    expect(await probeProcessNetworkBlocked()).toBe(true);
    const status = await sandboxStatus();
    expect(status.process).toEqual({ networkBlocked: true, method: hasNetPermission() ? 'permission' : 'lockdown', nodeVersion: process.version });
  });

  it('sin el preludio y sin permiso de red, el mismo proceso SÍ conecta (el corte no es un efecto de la prueba)', async () => {
    if (hasNetPermission()) return; // con permiso de red de Node, la denegación ya la hace --permission
    const target = await startServer((_req, res) => res.writeHead(200).end('alcanzado'));
    cleanups.push(target.close);
    await new Promise<void>((resolve) => {
      const child = spawn(
        process.execPath,
        [...sandboxNodeArgs(), '-e', `require('node:http').get('${target.url}/', (res) => { res.resume(); res.on('end', () => process.exit(0)); }).on('error', () => process.exit(1));`],
        { env: {}, cwd: os.tmpdir(), stdio: 'ignore', windowsHide: true },
      );
      child.on('close', () => resolve());
    });
    expect(target.requests).toHaveLength(1);
  });

  it('import() dentro del código no entrega nada: ni el módulo ni un error del proceso anfitrión', async () => {
    // Antes, el error de import() llegaba creado en el proceso anfitrión (su constructor era el Function de fuera).
    // Ahora la promesa nunca se resuelve dentro del tiempo del código, así que no hay objeto ajeno que explorar.
    const probe = `import('node:fs').then(() => 'importado', (e) => 'error: ' + (e instanceof Error) + ' ' + typeof e.constructor.constructor)`;
    await expect(runJavaScript(probe)).rejects.toThrow(/promesa que no llega a resolverse/);
    // Y el resto del código no se ve afectado por haberlo intentado.
    expect((await runJavaScript(`import('node:fs').catch(() => {}); 21 * 2`)).result).toBe(42);
  });

  it('el código normal sigue funcionando con el preludio de red activo', async () => {
    expect(await runJavaScript('const xs = [3, 1, 2]; console.log("orden"); xs.sort().join("-")')).toEqual({ result: '1-2-3', logs: ['orden'] });
    expect((await runJavaScript('(async () => 6 * 7)()')).result).toBe(42);
  });
});

describe('run_javascript en contenedor', () => {
  it('los argumentos del contenedor quitan la red, los privilegios y la escritura', () => {
    const args = containerRunArgs('agentforge-sbx-prueba');
    const pairs = (flag: string) => args[args.indexOf(flag) + 1];
    expect(pairs('--network')).toBe('none');
    expect(pairs('--cap-drop')).toBe('ALL');
    expect(pairs('--security-opt')).toBe('no-new-privileges');
    expect(pairs('--user')).toBe('65534:65534');
    expect(pairs('--pids-limit')).toBe('64');
    expect(pairs('--memory')).toBe('160m');
    expect(args).toEqual(expect.arrayContaining(['--rm', '--read-only', '--pull=never']));
  });

  it('sin motor de contenedores, elegirlo en Ajustes se rechaza con el motivo y la herramienta lo explica', async () => {
    const found = await detectContainerEngine(true);
    if (found.value && (await sandboxStatus(true)).container.available) return; // con contenedor disponible se prueba en el test siguiente
    const { app, ctx } = await boot();
    const res = await app.inject({ method: 'PUT', url: '/api/settings', payload: { codeSandbox: 'container' } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/No se puede usar el contenedor/);
    expect(ctx.store.getSettings().codeSandbox).toBe('process');
    const status = (await app.inject({ method: 'GET', url: '/api/sandbox/status' })).json();
    expect(status.container).toMatchObject({ available: false, image: 'node:24-alpine', error: expect.any(String) });
    if (!found.value) await expect(runJavaScript('1 + 1', { backend: 'container' })).rejects.toThrow(/contenedor no está disponible/);
  });

  it('con Docker o Podman en marcha: ejecuta el código y de verdad no hay red', async (t) => {
    const status = await sandboxStatus(true);
    if (!status.container.available) return t.skip();
    expect(await runJavaScript('[1, 2, 3].reduce((a, b) => a + b, 0)', { backend: 'container', timeoutMs: 5000 })).toEqual({ result: 6, logs: [] });
    await expect(runJavaScript('while (true) {}', { backend: 'container', timeoutMs: 1000 })).rejects.toThrow(/tiempo máximo|Script execution timed out/);
  }, 90_000);
});

describe('fijación de DNS contra un servidor DNS real', () => {
  it('el nombre se resuelve una sola vez por petición y la conexión va a la IP validada, aunque el DNS cambie de respuesta', async () => {
    const listen = (address: string, port: number, name: string) =>
      new Promise<{ port: number; close: () => Promise<void> }>((resolve, reject) => {
        const server = http.createServer((_req, res) => res.writeHead(200, { 'Content-Type': 'text/plain' }).end(name));
        server.once('error', reject);
        server.listen(port, address, () =>
          resolve({
            port: (server.address() as AddressInfo).port,
            close: () =>
              new Promise((done) => {
                server.closeAllConnections();
                server.close(() => done());
              }),
          }),
        );
      });
    const validated = await listen('127.0.0.1', 0, 'validado');
    cleanups.push(validated.close);
    const rebound = await listen('127.0.0.2', validated.port, 'rebind');
    cleanups.push(rebound.close);

    // DNS de verdad (UDP, RFC 1035): primera consulta → 127.0.0.1; las siguientes → 127.0.0.2 (el «rebind»).
    const dns = await startDnsServer((name, nth) => (name === 'rebind.test' ? [nth === 1 ? '127.0.0.1' : '127.0.0.2'] : name === 'mixto.test' ? ['93.184.216.34', '10.0.0.5'] : []));
    cleanups.push(dns.close);
    const resolver = new dnsPromises.Resolver({ timeout: 2000, tries: 1 });
    resolver.setServers([`127.0.0.1:${dns.port}`]);
    const lookup = (host: string) => resolver.resolve4(host);
    const url = `http://rebind.test:${validated.port}/dato`;

    const first = await safeFetch(url, { signal: signal(), allowPrivate: true, lookup });
    expect(first.text).toBe('validado');
    expect(dns.queries).toEqual(['rebind.test']); // una sola consulta: no se vuelve a preguntar al conectar

    // Una petición nueva vuelve a resolver y a validar, y conecta con lo que el DNS responda entonces.
    const second = await safeFetch(url, { signal: signal(), allowPrivate: true, lookup });
    expect(second.text).toBe('rebind');
    expect(dns.queries).toEqual(['rebind.test', 'rebind.test']);

    // Con el filtro activo, la respuesta privada del DNS real se rechaza sin llegar a conectar.
    await expect(safeFetch(url, { signal: signal(), allowPrivate: false, lookup })).rejects.toThrow(/red privada/);
    // Basta una dirección privada entre varias respuestas para rechazar el nombre.
    await expect(safeFetch('http://mixto.test/', { signal: signal(), allowPrivate: false, lookup })).rejects.toThrow(/red privada/);
    // Un nombre que el DNS no conoce.
    await expect(safeFetch('http://no-existe.test/', { signal: signal(), allowPrivate: false, lookup })).rejects.toThrow(/No se pudo resolver/);
  });
});

describe('delegación y flujo', () => {
  it('una condición con edges sigue funcionando tras el cambio a evaluación asíncrona', async () => {
    const { ctx } = await boot();
    const run = await runWorkflow(
      ctx,
      workflow(
        [node('entrada', 'input'), node('cond', 'condition', { left: '{{input}}', operator: 'matches', right: '^urgente' }), node('si', 'transform', { template: 'prioridad alta' }), node('no', 'transform', { template: 'normal' })],
        edges('entrada>cond', 'cond:true>si', 'cond:false>no'),
      ),
      'Urgente: se ha caído el servidor',
    );
    expect(run.status).toBe('completed');
    expect(run.output).toBe('prioridad alta');
  });
});
