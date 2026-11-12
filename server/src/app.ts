import fastifyStatic from '@fastify/static';
import Fastify, { LogController, type FastifyInstance } from 'fastify';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { ZodError } from 'zod';
import type { AppContext } from './context';
import { ConfigError, HttpError, LlmError, ToolError } from './errors';
import { registerApi } from './routes/api';
import {
  RateLimiter,
  SECURITY_HEADERS,
  buildAllowedHosts,
  buildCsp,
  hostName,
  isAuthenticated,
  isCostlyRoute,
  isCrossSiteRequest,
  sessionCookieHeader,
  tokenMatches,
} from './security';
import { protectLocalPort } from './tools/net';

/** Rutas de la API que no exigen clave de acceso: iniciar sesión y la sonda de vida (para un orquestador). */
const PUBLIC_API = new Set(['/api/auth/status', '/api/auth/login', '/api/auth/logout', '/api/health/live']);

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const { config } = ctx;
  // forceCloseConnections: al apagar se cortan también las conexiones SSE abiertas (si no, close() no termina nunca).
  const app = Fastify({
    logger:
      config.logLevel === 'silent'
        ? false
        : {
            level: config.logLevel,
            // Por si algún día se registran cabeceras o cuerpos: las credenciales nunca llegan al registro.
            redact: ['req.headers.authorization', 'req.headers.cookie', '*.apiKey', '*.token', '*.headers.authorization', '*.headers.Authorization'],
          },
    // Una línea por petición solo en modo depuración; en 'info' se anota el ciclo de vida y los errores.
    logController: new LogController({ disableRequestLogging: config.logLevel !== 'debug' }),
    bodyLimit: 2 * 1024 * 1024,
    forceCloseConnections: true,
  });
  ctx.log = app.log;

  const allowedHosts = buildAllowedHosts(config);
  const limiter = new RateLimiter();
  const costlyLimit = config.rateLimitPerMinute > 0 ? Math.max(30, Math.round(config.rateLimitPerMinute / 10)) : 0;
  const loginLimit = 10;

  app.addHook('onRequest', async (req, reply) => {
    // 1) Host: solo se aceptan peticiones dirigidas a un nombre conocido (protección frente a DNS rebinding).
    if (!allowedHosts.has(hostName(req.headers.host))) {
      return reply.status(403).send({ error: 'Host no permitido.' });
    }
    const urlPath = req.url.split('?')[0];
    if (!urlPath.startsWith('/api/')) return;

    // 2) Origen: otra web no puede usar la API desde el navegador del usuario (CSRF), ni siquiera para leer.
    if (isCrossSiteRequest(req.headers as Record<string, string | undefined>)) {
      return reply.status(403).send({ error: 'Petición rechazada: procede de otro sitio web.' });
    }

    // 3) Límite de tasa por cliente; más estricto en lo que lanza trabajo caro y en el inicio de sesión.
    const client = req.ip;
    const wait =
      urlPath === '/api/auth/login'
        ? limiter.hit(`login:${client}`, loginLimit)
        : limiter.hit(`api:${client}`, config.rateLimitPerMinute) || (isCostlyRoute(req.method, urlPath) ? limiter.hit(`costly:${client}`, costlyLimit) : 0);
    if (wait) {
      return reply
        .status(429)
        .header('Retry-After', String(wait))
        .send({ error: `Demasiadas peticiones. Vuelve a intentarlo dentro de ${wait} s.`, code: 'rate_limited' });
    }

    // 4) Clave de acceso, si está configurada (obligatoria cuando el servidor escucha fuera de este equipo).
    // Los webhooks los llama otro programa: se autentican con el secreto de su disparador, no con la clave de la interfaz.
    const isWebhook = req.method === 'POST' && urlPath.startsWith('/api/hooks/');
    if (config.authToken && !PUBLIC_API.has(urlPath) && !isWebhook && !isAuthenticated(config.authToken, req.headers)) {
      return reply.status(401).send({ error: 'Hace falta la clave de acceso.', code: 'auth_required' });
    }
  });

  // Cabeceras de seguridad en todas las respuestas; la política de contenido se recalcula si se recompila la interfaz.
  let csp: { mtimeMs: number; value: string } | null = null;
  const currentCsp = (): string => {
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(path.join(config.webDist, 'index.html')).mtimeMs;
    } catch {
      /* sin interfaz compilada */
    }
    if (!csp || csp.mtimeMs !== mtimeMs) csp = { mtimeMs, value: buildCsp(config.webDist) };
    return csp.value;
  };
  app.addHook('onSend', async (_req, reply, payload) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) reply.header(name, value);
    reply.header('Content-Security-Policy', currentCsp());
    return payload;
  });

  // Las herramientas de red no pueden llamar a esta misma API, ni con «redes privadas» permitidas.
  let unprotect: (() => void) | null = null;
  app.addHook('onListen', async () => {
    const address = app.server.address() as AddressInfo | null;
    if (address?.port) unprotect = protectLocalPort(address.port);
  });
  app.addHook('onClose', async () => unprotect?.());

  // Además del texto en español, cada error lleva un `code` estable: la interfaz lo usa para mostrar los errores
  // genéricos en el idioma del usuario (los textos concretos de validación y de proveedores van en español).
  const codeFor = (status: number): string =>
    status === 401 ? 'auth_required' : status === 404 ? 'not_found' : status === 413 ? 'payload_too_large' : status === 429 ? 'rate_limited' : status >= 500 ? 'internal' : 'bad_request';
  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof ZodError) {
      const issues = err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
      const first = issues[0];
      return reply.status(400).send({
        error: `Datos no válidos${first ? `: ${first.path ? `${first.path}: ` : ''}${first.message}` : ''}`,
        code: 'validation',
        issues,
      });
    }
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message, code: err.code ?? codeFor(err.status), details: err.details });
    if (err instanceof LlmError) return reply.status(502).send({ error: err.message, code: 'provider_error' });
    if (err instanceof ToolError) return reply.status(400).send({ error: err.message, code: 'tool_error' });
    // Configuración que el usuario puede arreglar (clave que no se descifra, proveedor desactivado…).
    if (err instanceof ConfigError) return reply.status(409).send({ error: err.message, code: 'config_error' });
    const e = err as { statusCode?: number; message?: string };
    const status = e.statusCode && e.statusCode >= 400 && e.statusCode < 600 ? e.statusCode : 500;
    if (status >= 500) app.log.error({ err, method: req.method, url: req.url }, 'Error interno al atender una petición');
    return reply.status(status).send({ error: status >= 500 ? 'Error interno del servidor.' : (e.message ?? 'Petición no válida.'), code: codeFor(status) });
  });

  // ---------- Sesión ----------
  app.get('/api/auth/status', async (req) => ({
    required: Boolean(config.authToken),
    authenticated: !config.authToken || isAuthenticated(config.authToken, req.headers),
  }));

  app.post('/api/auth/login', async (req, reply) => {
    if (!config.authToken) return reply.status(204).send();
    const given = (req.body as { token?: unknown } | null)?.token;
    if (!tokenMatches(config.authToken, given)) {
      app.log.warn({ ip: req.ip }, 'Intento de acceso con una clave incorrecta');
      throw new HttpError(401, 'La clave de acceso no es correcta.');
    }
    return reply.header('Set-Cookie', sessionCookieHeader(config.authToken, req.protocol === 'https')).status(204).send();
  });

  app.post('/api/auth/logout', async (req, reply) =>
    reply.header('Set-Cookie', sessionCookieHeader(null, req.protocol === 'https')).status(204).send(),
  );

  registerApi(app, ctx);

  // En producción el servidor también sirve el frontend compilado (web/dist).
  const hasWeb = fs.existsSync(config.webDist);
  if (hasWeb) {
    // Los archivos se resuelven en cada petición (no solo los que existían al arrancar), para que
    // recompilar el frontend no exija reiniciar el servidor.
    await app.register(fastifyStatic, {
      root: config.webDist,
      cacheControl: false,
      setHeaders(res, filePath) {
        // Los assets llevan hash en el nombre y son inmutables; index.html debe revalidarse siempre.
        const immutable = /[\\/]assets[\\/]/.test(filePath);
        res.header('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
  }
  app.setNotFoundHandler((req, reply) => {
    const urlPath = req.url.split('?')[0];
    // Rutas de la SPA: cualquier GET que no sea de la API ni un archivo estático devuelve index.html.
    const isAppRoute = req.method === 'GET' && !urlPath.startsWith('/api/') && !urlPath.startsWith('/assets/') && !/\.[a-z0-9]+$/i.test(urlPath);
    if (hasWeb && isAppRoute) return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
    if (!hasWeb && isAppRoute) {
      return reply
        .status(503)
        .type('text/plain; charset=utf-8')
        .send('La interfaz no está compilada. Ejecuta "npm run build" y recarga esta página. La API sí está disponible en /api.');
    }
    return reply.status(404).send({ error: 'Ruta no encontrada.' });
  });

  return app;
}
