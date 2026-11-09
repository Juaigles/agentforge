import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import fs from 'node:fs';
import { ZodError } from 'zod';
import type { AppContext } from './context';
import { HttpError, LlmError, ToolError } from './errors';
import { registerApi } from './routes/api';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  // forceCloseConnections: al apagar se cortan también las conexiones SSE abiertas (si no, close() no termina nunca).
  const app = Fastify({ logger: ctx.config.logger, bodyLimit: 2 * 1024 * 1024, forceCloseConnections: true });

  // Protección frente a DNS rebinding: solo se aceptan peticiones dirigidas a un host local conocido.
  const allowedHosts = new Set([...LOCAL_HOSTS, ctx.config.host]);
  app.addHook('onRequest', async (req, reply) => {
    const host = (req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
    if (!allowedHosts.has(host) && ctx.config.host !== '0.0.0.0') {
      return reply.status(403).send({ error: 'Host no permitido.' });
    }
  });

  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof ZodError) {
      const issues = err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
      const first = issues[0];
      return reply.status(400).send({
        error: `Datos no válidos${first ? `: ${first.path ? `${first.path}: ` : ''}${first.message}` : ''}`,
        issues,
      });
    }
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message, details: err.details });
    if (err instanceof LlmError) return reply.status(502).send({ error: err.message });
    if (err instanceof ToolError) return reply.status(400).send({ error: err.message });
    const e = err as { statusCode?: number; message?: string };
    const status = e.statusCode && e.statusCode >= 400 && e.statusCode < 600 ? e.statusCode : 500;
    if (status >= 500) app.log.error(err);
    return reply.status(status).send({ error: status >= 500 ? 'Error interno del servidor.' : (e.message ?? 'Petición no válida.') });
  });

  registerApi(app, ctx);

  // En producción el servidor también sirve el frontend compilado (web/dist).
  const hasWeb = fs.existsSync(ctx.config.webDist);
  if (hasWeb) {
    // Los archivos se resuelven en cada petición (no solo los que existían al arrancar), para que
    // recompilar el frontend no exija reiniciar el servidor.
    await app.register(fastifyStatic, {
      root: ctx.config.webDist,
      cacheControl: false,
      setHeaders(res, filePath) {
        // Los assets llevan hash en el nombre y son inmutables; index.html debe revalidarse siempre.
        const immutable = /[\\/]assets[\\/]/.test(filePath);
        res.header('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
  }
  app.setNotFoundHandler((req, reply) => {
    const path = req.url.split('?')[0];
    // Rutas de la SPA: cualquier GET que no sea de la API ni un archivo estático devuelve index.html.
    const isAppRoute = req.method === 'GET' && !path.startsWith('/api/') && !path.startsWith('/assets/') && !/\.[a-z0-9]+$/i.test(path);
    if (hasWeb && isAppRoute) return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
    return reply.status(404).send({ error: 'Ruta no encontrada.' });
  });

  return app;
}
