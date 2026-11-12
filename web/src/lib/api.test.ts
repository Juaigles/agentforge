// @vitest-environment jsdom
// Cliente de la API contra la API real (startApi) y, para lo que la API real no responde (proxy caído con HTML,
// un 204 a medida…), contra servidores HTTP locales reales creados con node:http.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_WORKFLOW_SETTINGS } from '@shared/types';
import { locale, setLocale } from '@/i18n';
import { startApi, type TestApi } from '@/test/harness';
import { api, ApiError, authRequired } from './api';

let testApi: TestApi;
const servers: Server[] = [];

beforeEach(async () => {
  authRequired.value = false;
  testApi = await startApi();
});
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  await testApi.close();
});

/** Servidor HTTP local real; `fetch('/api/…')` pasa a llegar a él mientras dura el test. */
async function localServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const real = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    real(typeof input === 'string' && input.startsWith('/') ? `${url}${input}` : input, init)) as typeof fetch;
  // testApi.close() restaura el fetch original.
  return url;
}

/** Espera a que la promesa falle y devuelve el ApiError. */
async function failure(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    return err as ApiError;
  }
  throw new Error('Se esperaba que la petición fallara.');
}

describe('cliente de la API: errores de la API real', () => {
  it('una validación fallida da ApiError 400 con código, incidencias y mensaje por campo', async () => {
    const err = await failure(
      api.tools.createCustom({
        name: 'X',
        description: 'abc',
        parameters: { type: 'object', properties: {} },
        method: 'GET',
        urlTemplate: 'https://example.com',
        headers: {},
        bodyTemplate: '',
        enabled: true,
      }),
    );
    expect(err.name).toBe('ApiError');
    expect(err.status).toBe(400);
    expect(err.code).toBe('validation');
    expect(err.issues.map((i) => i.path).sort()).toEqual(['description', 'name']);
    expect(err.field('name')).toContain('minúsculas');
    expect(err.field('description')).toContain('Describe qué hace');
    expect(err.field('urlTemplate')).toBeUndefined();
    expect(err.message).toMatch(/^Datos no válidos: /);
    // No se ha guardado nada.
    expect(testApi.ctx.store.listCustomTools()).toHaveLength(0);
  });

  it('un recurso que no existe da 404 con el código not_found', async () => {
    const err = await failure(api.tools.getCustom('tool_que_no_existe'));
    expect(err.status).toBe(404);
    expect(err.code).toBe('not_found');
    expect(err.issues).toEqual([]);
    expect(err.message).toContain('Herramienta');
  });

  it('un conflicto (nombre repetido) llega con su estado 409 y el mensaje del servidor', async () => {
    const input = {
      name: 'consulta',
      description: 'Consulta algo',
      parameters: { type: 'object' as const, properties: {} },
      method: 'GET' as const,
      urlTemplate: 'https://example.com',
      headers: {},
      bodyTemplate: '',
      enabled: true,
    };
    await api.tools.createCustom(input);
    const err = await failure(api.tools.createCustom(input));
    expect(err.status).toBe(409);
    expect(err.message).toContain('Ya existe una herramienta llamada "consulta"');
  });

  it('ejecutar un workflow con errores da 422 y deja las incidencias en details.issues', async () => {
    const wf = testApi.ctx.store.createWorkflow({
      name: 'sin nodos',
      description: '',
      nodes: [],
      edges: [],
      settings: DEFAULT_WORKFLOW_SETTINGS,
    });
    const err = await failure(api.workflows.run(wf.id, 'hola'));
    expect(err.status).toBe(422);
    expect(err.message).toContain('El workflow tiene errores');
    const issues = err.details?.issues ?? [];
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((i) => i.level === 'error')).toBe(true);
    for (const i of issues) expect(typeof i.message).toBe('string');
    // La ejecución no llegó a crearse.
    expect(testApi.ctx.store.listRuns().total).toBe(0);
  });

  it('borrar devuelve undefined (204) y el elemento desaparece', async () => {
    const tool = await api.tools.createCustom({
      name: 'borrame',
      description: 'Se borrará',
      parameters: { type: 'object', properties: {} },
      method: 'GET',
      urlTemplate: 'https://example.com',
      headers: {},
      bodyTemplate: '',
      enabled: true,
    });
    const result = await api.tools.removeCustom(tool.id);
    expect(result).toBeUndefined();
    expect(testApi.ctx.store.getCustomTool(tool.id)).toBeNull();
    expect((await failure(api.tools.removeCustom(tool.id))).status).toBe(404);
  });

  it('con clave de acceso activa, un 401 auth_required activa authRequired; con la clave correcta se entra', async () => {
    (testApi.ctx.config as { authToken: string | null }).authToken = 'clave-de-prueba';
    expect(authRequired.value).toBe(false);
    const err = await failure(api.agents.list());
    expect(err.status).toBe(401);
    expect(err.code).toBe('auth_required');
    expect(authRequired.value).toBe(true);
  });

  it('una clave incorrecta al entrar da 401 con el mensaje del servidor y sigue pidiendo la clave', async () => {
    (testApi.ctx.config as { authToken: string | null }).authToken = 'clave-de-prueba';
    // La interfaz ya está en la pantalla de entrada (una petición anterior fue rechazada por falta de clave).
    await failure(api.agents.list());
    expect(authRequired.value).toBe(true);
    const err = await failure(api.auth.login('equivocada'));
    expect(err.status).toBe(401);
    // Código propio: una clave incorrecta no es lo mismo que una clave ausente.
    expect(err.code).toBe('invalid_token');
    expect(err.message).toBe('La clave de acceso no es correcta.');
    expect(authRequired.value).toBe(true);
  });
});

describe('cliente de la API: fallos de conexión y respuestas que no son JSON', () => {
  it('con el servidor parado da status 0, código network y el mensaje de conexión', async () => {
    const server = createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    await new Promise<void>((r) => server.close(() => r()));
    const real = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      real(typeof input === 'string' && input.startsWith('/') ? `http://127.0.0.1:${port}${input}` : input, init)) as typeof fetch;
    const err = await failure(api.health());
    expect(err.status).toBe(0);
    expect(err.code).toBe('network');
    expect(err.message).toBe('No se pudo conectar con el servidor de AgentForge. ¿Está en marcha?');
    expect(err.issues).toEqual([]);
  });

  it('una respuesta HTML con 502 (proxy con la API caída) dice que el servidor no responde', async () => {
    await localServer((_req, res) => {
      res.writeHead(502, { 'Content-Type': 'text/html' });
      res.end('<html><body><h1>502 Bad Gateway</h1></body></html>');
    });
    const err = await failure(api.stats());
    expect(err.status).toBe(502);
    expect(err.message).toBe('El servidor de AgentForge no responde.');
    expect(err.code).toBeUndefined();
    expect(err.issues).toEqual([]);
  });

  it('una respuesta vacía con 500 también dice que el servidor no responde', async () => {
    await localServer((_req, res) => {
      res.writeHead(500);
      res.end();
    });
    expect((await failure(api.stats())).message).toBe('El servidor de AgentForge no responde.');
  });

  it('una respuesta no JSON con 4xx da «Error <código>»', async () => {
    await localServer((_req, res) => {
      res.writeHead(418, { 'Content-Type': 'text/plain' });
      res.end('soy una tetera');
    });
    const err = await failure(api.stats());
    expect(err.status).toBe(418);
    expect(err.message).toBe('Error 418');
  });

  it('un 4xx con JSON sin campo de error también cae al «Error <código>»', async () => {
    await localServer((_req, res) => {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end('{"otra":"cosa"}');
    });
    expect((await failure(api.stats())).message).toBe('Error 403');
  });

  it('un 204 devuelve undefined sin intentar leer JSON', async () => {
    await localServer((_req, res) => {
      res.writeHead(204);
      res.end();
    });
    expect(await api.providers.remove('cualquiera')).toBeUndefined();
  });

  it('un 200 con JSON válido devuelve el objeto', async () => {
    await localServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true,"version":"9.9.9","uptimeSec":1}');
    });
    expect(await api.health()).toEqual({ ok: true, version: '9.9.9', uptimeSec: 1 });
  });

  it('un 401 que no es auth_required (p. ej. un proxy) no activa la pantalla de entrada', async () => {
    await localServer((_req, res) => {
      res.writeHead(401, { 'Content-Type': 'text/html' });
      res.end('<h1>Unauthorized</h1>');
    });
    const err = await failure(api.stats());
    expect(err.status).toBe(401);
    expect(err.message).toBe('Error 401');
    expect(authRequired.value).toBe(false);
  });
});

describe('cliente de la API: runs.list', () => {
  /** Peticiones que recibe un servidor local real (método y URL tal cual llegan). */
  async function recordingServer(): Promise<string[]> {
    const urls: string[] = [];
    await localServer((req, res) => {
      urls.push(`${req.method} ${req.url}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"items":[],"total":0}');
    });
    return urls;
  }

  it('omite los filtros vacíos o sin definir de la URL', async () => {
    const urls = await recordingServer();
    await api.runs.list({ status: '', kind: '', workflowId: undefined, agentId: '', search: '' });
    await api.runs.list();
    expect(urls).toEqual(['GET /api/runs?', 'GET /api/runs?']);
  });

  it('envía los filtros con valor, codificados, y conserva el 0 de offset', async () => {
    const urls = await recordingServer();
    await api.runs.list({ status: 'failed', kind: '', search: 'a b&c=ñ', limit: 25, offset: 0 });
    const url = new URL(urls[0].replace('GET ', 'http://x'));
    expect(url.pathname).toBe('/api/runs');
    expect(Object.fromEntries(url.searchParams)).toEqual({ status: 'failed', search: 'a b&c=ñ', limit: '25', offset: '0' });
    expect(urls[0]).not.toContain('kind=');
    expect(urls[0]).toContain('search=a+b%26c%3D%C3%B1');
  });

  it('contra la API real filtra de verdad: un estado sin ejecuciones da una lista vacía', async () => {
    const result = await api.runs.list({ status: 'failed', kind: '' });
    expect(result.total).toBe(0);
    expect(result.items).toEqual([]);
  });
});

describe('cliente de la API: mensajes en inglés', () => {
  async function inEnglish<T>(body: () => Promise<T>): Promise<T> {
    setLocale('en', false);
    try {
      expect(locale.value).toBe('en');
      return await body();
    } finally {
      setLocale('es', false);
    }
  }

  it('un 404 se muestra traducido a partir de su código, no con el texto del servidor en español', async () => {
    const err = await inEnglish(() => failure(api.tools.getCustom('nada')));
    expect(err.code).toBe('not_found');
    expect(err.message).toBe('Tool not found.');
    // De vuelta en español, el mismo error usa el texto del servidor.
    expect((await failure(api.tools.getCustom('nada'))).message).toBe('Herramienta no encontrada.');
  });

  it('una validación sale en inglés: la frase de resumen y el problema de cada campo', async () => {
    const invalid = () =>
      failure(
        api.tools.createCustom({
          name: 'X',
          description: 'abc',
          parameters: { type: 'object', properties: {} },
          method: 'GET',
          urlTemplate: 'https://example.com',
          headers: {},
          bodyTemplate: '',
          enabled: true,
        }),
      );
    const err = await inEnglish(invalid);
    expect(err.code).toBe('validation');
    expect(err.message).toBe('Invalid data: name: Use lowercase letters, numbers and underscores (2-49 characters, starting with a letter)');
    expect(err.field('name')).toBe('Use lowercase letters, numbers and underscores (2-49 characters, starting with a letter)');
    expect(err.field('description')).toBe('Describe what the tool does (the model uses it to decide)');
    // En español, el texto del servidor.
    const spanish = await invalid();
    expect(spanish.message).toBe('Datos no válidos: name: Usa minúsculas, números y guiones bajos (2-49 caracteres, empieza por letra)');
    expect(spanish.field('description')).toBe('Describe qué hace la herramienta (el modelo lo usa para decidir)');
  });

  it('un problema que detecta zod sin mensaje propio (un texto demasiado largo) también tiene código y sale en los dos idiomas', async () => {
    const tooLong = () =>
      failure(api.providers.create({ name: 'x'.repeat(81), kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', defaultModel: '', enabled: true }));
    expect((await inEnglish(tooLong)).field('name')).toBe('Cannot be longer than 80 characters');
    expect((await tooLong()).field('name')).toBe('No puede superar los 80 caracteres');
  });

  it('una respuesta sin `i18n` (un proxy, un servidor anterior) usa el texto genérico de su clase de error o, si no hay, el original', async () => {
    await localServer((req, res) => {
      res.writeHead(req.url === '/api/stats' ? 404 : 409, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify(req.url === '/api/stats' ? { error: 'No encontrado.', code: 'not_found' } : { error: 'Texto del servidor.', code: 'bad_request' }),
      );
    });
    expect((await inEnglish(() => failure(api.stats()))).message).toBe('What you asked for was not found. It may have been deleted.');
    expect((await inEnglish(() => failure(api.health()))).message).toBe('Texto del servidor.');
  });

  it('un conflicto (nombre repetido) se traduce con sus parámetros', async () => {
    const input = {
      name: 'repetida',
      description: 'Una herramienta',
      parameters: { type: 'object' as const, properties: {} },
      method: 'GET' as const,
      urlTemplate: 'https://example.com',
      headers: {},
      bodyTemplate: '',
      enabled: true,
    };
    await api.tools.createCustom(input);
    const err = await inEnglish(() => failure(api.tools.createCustom(input)));
    expect(err.status).toBe(409);
    expect(err.message).toBe('A tool named "repetida" already exists.');
  });

  it('el mensaje de conexión y el de «servidor no responde» salen en inglés', async () => {
    await localServer((_req, res) => {
      res.writeHead(502, { 'Content-Type': 'text/html' });
      res.end('<h1>Bad Gateway</h1>');
    });
    const err = await inEnglish(() => failure(api.stats()));
    expect(err.message).toBe('The AgentForge server is not responding.');

    const server = createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    await new Promise<void>((r) => server.close(() => r()));
    const real = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      real(typeof input === 'string' && input.startsWith('/') ? `http://127.0.0.1:${port}${input}` : input, init)) as typeof fetch;
    const down = await inEnglish(() => failure(api.health()));
    expect(down.message).toBe('Could not reach the AgentForge server. Is it running?');
  });

  it('un 401 con auth_required se muestra en inglés y activa authRequired', async () => {
    (testApi.ctx.config as { authToken: string | null }).authToken = 'clave-de-prueba';
    const err = await inEnglish(() => failure(api.agents.list()));
    expect(err.message).toBe('The access key is required.');
    expect(authRequired.value).toBe(true);
  });
});
