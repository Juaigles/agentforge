// El servidor también sirve el frontend compilado: fallback de la SPA, caché y archivos nuevos.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { createContext, type AppContext } from '../src/context';
import { tempDir, testConfig } from './helpers';

let app: FastifyInstance;
let ctx: AppContext;
const dir = tempDir();
const webDist = path.join(dir, 'web-dist');

beforeAll(async () => {
  fs.mkdirSync(path.join(webDist, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(webDist, 'index.html'), '<!doctype html><div id="app"></div>');
  fs.writeFileSync(path.join(webDist, 'assets', 'app-abc123.js'), 'console.log("v1")');
  ctx = createContext({ ...testConfig(dir), webDist }, { inMemory: true });
  app = await buildApp(ctx);
});
afterAll(async () => {
  await app.close();
  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const get = (url: string) => app.inject({ method: 'GET', url });

describe('frontend estático', () => {
  it('sirve index.html en la raíz y en cualquier ruta de la aplicación, sin caché', async () => {
    for (const url of ['/', '/agents', '/workflows/wf_123', '/runs/run_1?x=1']) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['content-type'], url).toContain('text/html');
      expect(res.body, url).toContain('<div id="app">');
      expect(res.headers['cache-control'], url).toBe('no-cache');
    }
  });

  it('sirve los assets con caché inmutable y el tipo correcto', async () => {
    const res = await get('/assets/app-abc123.js');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('javascript');
    expect(res.headers['cache-control']).toContain('immutable');
  });

  it('un asset inexistente es un 404, nunca el HTML de la aplicación', async () => {
    const res = await get('/assets/antiguo-000.js');
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('<div id="app">');
    expect((await get('/favicon.ico')).statusCode).toBe(404);
  });

  it('sirve los archivos generados después de arrancar (recompilar no exige reiniciar)', async () => {
    fs.writeFileSync(path.join(webDist, 'assets', 'app-def456.js'), 'console.log("v2")');
    const res = await get('/assets/app-def456.js');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('v2');
  });

  it('no permite salir del directorio del frontend ni confunde la API con la SPA', async () => {
    expect((await get('/../agentforge.db')).body).not.toContain('SQLite');
    expect((await get('/assets/..%2f..%2fagentforge.db')).statusCode).toBeGreaterThanOrEqual(400);
    const api = await get('/api/no-existe');
    expect(api.statusCode).toBe(404);
    expect(api.json()).toEqual({ error: 'Ruta no encontrada.' });
  });
});
