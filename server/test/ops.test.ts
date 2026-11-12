// Operación: comportamiento detrás de un proxy inverso (AGENTFORGE_TRUST_PROXY), cierre de la base de datos en
// versiones de Node sin `db.isOpen` y mensajes de error del arranque.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { createContext, databaseIsOpen, type AppContext } from '../src/context';
import { ScriptedLlm, tempDir, testConfig } from './helpers';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'una-clave-de-prueba-bien-larga';

let ctx: AppContext | undefined;
let app: FastifyInstance | undefined;
const dirs: string[] = [];

afterEach(async () => {
  await app?.close();
  await ctx?.close();
  app = undefined;
  ctx = undefined;
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function boot(trustProxy: boolean): Promise<FastifyInstance> {
  ctx = createContext(
    { ...testConfig(), authToken: TOKEN, rateLimitPerMinute: 1200, trustProxy },
    { llm: new ScriptedLlm(() => ({ content: 'ok' })), inMemory: true },
  );
  app = await buildApp(ctx);
  return app;
}

const login = (server: FastifyInstance, token: string, headers: Record<string, string> = {}) =>
  server.inject({ method: 'POST', url: '/api/auth/login', payload: { token }, headers });

describe('detrás de un proxy inverso', () => {
  it('con AGENTFORGE_TRUST_PROXY la cookie de sesión lleva Secure cuando el proxy termina TLS', async () => {
    const server = await boot(true);
    const viaTls = await login(server, TOKEN, { 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.7' });
    expect(viaTls.statusCode).toBe(204);
    expect(String(viaTls.headers['set-cookie'])).toMatch(/; Secure/);
    // Si el proxy habla http con el cliente, no se promete lo que no hay.
    const plain = await login(server, TOKEN, { 'x-forwarded-proto': 'http', 'x-forwarded-for': '203.0.113.7' });
    expect(String(plain.headers['set-cookie'])).not.toMatch(/; Secure/);
  });

  it('con AGENTFORGE_TRUST_PROXY el límite de intentos de acceso es por cliente real, no común a todos', async () => {
    const server = await boot(true);
    const attacker = { 'x-forwarded-for': '198.51.100.9' };
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await login(server, `clave-incorrecta-${i}`, attacker)).statusCode);
    expect(codes.slice(0, 10)).toEqual(Array(10).fill(401));
    expect(codes.slice(10)).toEqual([429, 429]);
    // Otra persona, desde otra dirección, entra sin problema mientras tanto.
    expect((await login(server, TOKEN, { 'x-forwarded-for': '203.0.113.50' })).statusCode).toBe(204);
  });

  it('sin la opción no se hace caso a las cabeceras X-Forwarded-*: nadie puede falsear su dirección ni el protocolo', async () => {
    const server = await boot(false);
    const codes: number[] = [];
    // Cambiar X-Forwarded-For en cada intento no esquiva el límite.
    for (let i = 0; i < 12; i++) codes.push((await login(server, `clave-incorrecta-${i}`, { 'x-forwarded-for': `198.51.100.${i}` })).statusCode);
    expect(codes.slice(10)).toEqual([429, 429]);
  });

  it('sin la opción, X-Forwarded-Proto no añade Secure a la cookie', async () => {
    const server = await boot(false);
    const res = await login(server, TOKEN, { 'x-forwarded-proto': 'https' });
    expect(res.statusCode).toBe(204);
    expect(String(res.headers['set-cookie'])).not.toMatch(/; Secure/);
  });

  it('la opción se lee de AGENTFORGE_TRUST_PROXY y viene desactivada', () => {
    const base = { AGENTFORGE_DATA_DIR: tempDir() };
    dirs.push(base.AGENTFORGE_DATA_DIR);
    expect(loadConfig(base).trustProxy).toBe(false);
    expect(loadConfig({ ...base, AGENTFORGE_TRUST_PROXY: '1' }).trustProxy).toBe(true);
  });
});

describe('validación de la configuración', () => {
  it('un nombre de host admitido con puerto se rechaza al arrancar, diciendo cómo escribirlo', () => {
    const dir = tempDir();
    dirs.push(dir);
    expect(() => loadConfig({ AGENTFORGE_DATA_DIR: dir, AGENTFORGE_ALLOWED_HOSTS: 'forge.local:4310' })).toThrow(
      /no debe llevar el puerto; escribe solo "forge\.local"/,
    );
    expect(loadConfig({ AGENTFORGE_DATA_DIR: dir, AGENTFORGE_ALLOWED_HOSTS: 'forge.local, 192.168.1.5' }).allowedHosts).toEqual(['forge.local', '192.168.1.5']);
  });
});

describe('cierre de la base de datos sin `db.isOpen` (Node 22.13 y 22.14)', () => {
  it('sin `isOpen` se usa la cuenta propia; con él, manda lo que diga el motor', () => {
    expect(databaseIsOpen({}, false)).toBe(true);
    expect(databaseIsOpen({}, true)).toBe(false);
    expect(databaseIsOpen({ isOpen: undefined }, true)).toBe(false);
    expect(databaseIsOpen({ isOpen: true }, true)).toBe(true);
    expect(databaseIsOpen({ isOpen: false }, false)).toBe(false);
  });

  it('cerrar el contexto cierra la base de verdad, y cerrarlo dos veces no falla', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const local = createContext(testConfig(dir), { llm: new ScriptedLlm(() => ({ content: 'ok' })) });
    local.store.createProvider({ name: 'Local', kind: 'ollama', baseUrl: 'http://127.0.0.1:1' });
    await local.close();
    // Cerrada de verdad: una consulta ya no funciona.
    expect(() => local.db.prepare('SELECT 1').get()).toThrow();
    await expect(local.close()).resolves.toBeUndefined();
    // Y el archivo se puede volver a abrir con los datos dentro (el bloqueo de instancia se ha soltado).
    const again = createContext(testConfig(dir), { llm: new ScriptedLlm(() => ({ content: 'ok' })) });
    try {
      expect(again.store.listProviders().map((p) => p.name)).toEqual(['Local']);
    } finally {
      await again.close();
    }
  });
});

/** Un puerto libre en este equipo. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

/** Arranca el servidor de verdad (como `npm start`) y devuelve lo que escribe y su código de salida. */
function runServer(env: Record<string, string>, timeoutMs = 20_000): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: serverDir,
      env: { ...process.env, AGENTFORGE_SEED: '0', AGENTFORGE_LOG_LEVEL: 'silent', HOST: '127.0.0.1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (c) => (output += c));
    child.stderr.on('data', (c) => (output += c));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

describe('mensajes de error del arranque', () => {
  it('un puerto ocupado se dice como tal, sin traza', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const busy = net.createServer();
    await new Promise<void>((r) => busy.listen(0, '127.0.0.1', r));
    try {
      const { port } = busy.address() as net.AddressInfo;
      const { code, output } = await runServer({ PORT: String(port), AGENTFORGE_DATA_DIR: dir });
      expect(code).toBe(1);
      expect(output).toContain('El puerto ya está ocupado por otro programa');
      expect(output).not.toMatch(/\n\s+at /);
    } finally {
      await new Promise<void>((r) => busy.close(() => r()));
    }
  }, 30_000);

  it('una carpeta de datos que no se puede crear no se confunde con un problema del puerto', async () => {
    const dir = tempDir();
    dirs.push(dir);
    // Un archivo donde debería ir la carpeta de datos: crearla falla (ENOTDIR/EEXIST), no es un error de `listen`.
    const blocker = path.join(dir, 'ocupado');
    fs.writeFileSync(blocker, 'x');
    const { code, output } = await runServer({ PORT: String(await freePort()), AGENTFORGE_DATA_DIR: path.join(blocker, 'datos') });
    expect(code).toBe(1);
    expect(output).not.toContain('No hay permiso para escuchar');
    expect(output).not.toContain('El puerto ya está ocupado');
    expect(output).toMatch(/No se pudo arrancar|No se puede escribir en la carpeta de datos/);
    expect(output).not.toMatch(/\n\s+at /);
  }, 30_000);

  it('otra instancia sobre la misma carpeta de datos da su mensaje, sin traza', async () => {
    const dir = tempDir();
    dirs.push(dir);
    // El bloqueo lo tiene este mismo proceso de pruebas (un proceso vivo que no es el servidor que arranca).
    fs.writeFileSync(path.join(dir, 'agentforge.lock'), String(process.pid));
    const { code, output } = await runServer({ PORT: String(await freePort()), AGENTFORGE_DATA_DIR: dir });
    expect(code).toBe(1);
    expect(output).toContain('Ya hay otro servidor de AgentForge');
    expect(output).not.toMatch(/\n\s+at /);
  }, 30_000);
});
