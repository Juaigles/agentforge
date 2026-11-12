// Clave de acceso: un servidor arrancado con AGENTFORGE_TOKEN no muestra ni sirve nada sin ella.
// Este archivo lanza su propio servidor (el compartido de la suite no lleva clave).
import { expect, test } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOKEN = 'clave-e2e-suficientemente-larga';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

let child: ChildProcess;
let url: string;
let dataDir: string;
let output = '';

test.beforeAll(async () => {
  const port = await freePort();
  url = `http://127.0.0.1:${port}`;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-e2e-token-'));
  child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: path.join(repoRoot, 'server'),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      AGENTFORGE_DATA_DIR: dataDir,
      AGENTFORGE_SEED: '0',
      AGENTFORGE_LOG: '0',
      AGENTFORGE_TOKEN: TOKEN,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (c) => (output += c));
  child.stderr?.on('data', (c) => (output += c));
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`El servidor terminó al arrancar.\n${output}`);
    try {
      // La sonda de vida es pública: sirve para saber que el servidor escucha sin tener la clave.
      if ((await fetch(`${url}/api/health/live`)).ok) break;
    } catch {
      /* todavía no escucha */
    }
    if (Date.now() > deadline) throw new Error(`El servidor no respondió en 30 s.\n${output}`);
    await new Promise((r) => setTimeout(r, 100));
  }
});

test.afterAll(async () => {
  if (child && child.exitCode === null) {
    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      child.kill('SIGKILL');
    });
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test.describe('Clave de acceso', () => {
  test('sin la clave la API no entrega nada; con ella se entra y la sesión se conserva', async ({ page, browserName }) => {
    // Los 401 esperados aparecen en la consola del navegador como «Failed to load resource»: no son errores de la página.
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    // Por API: nada sin clave, todo con ella.
    expect((await fetch(`${url}/api/agents`)).status).toBe(401);
    expect(
      (await fetch(`${url}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"allowCodeExecution":true}' })).status,
    ).toBe(401);
    expect((await fetch(`${url}/api/agents`, { headers: { Authorization: `Bearer ${TOKEN}` } })).status).toBe(200);

    await page.goto(`${url}/agents`);
    // Solo se ve la pantalla de entrada: ni la navegación ni los datos.
    await expect(page.getByRole('heading', { name: 'AgentForge' })).toBeVisible();
    const field = page.getByLabel('Clave de acceso');
    await expect(field).toBeFocused();
    await expect(page.getByRole('navigation')).toHaveCount(0);

    await page.getByRole('button', { name: 'Entrar' }).click();
    await expect(page.getByRole('alert')).toHaveText('Escribe la clave de acceso.');

    await field.fill('no-es-esta-clave');
    await page.getByRole('button', { name: 'Entrar' }).click();
    await expect(page.getByRole('alert')).toHaveText('La clave de acceso no es correcta.');
    await expect(field).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByRole('navigation')).toHaveCount(0);

    await field.fill(TOKEN);
    await field.press('Enter');
    // Tras entrar se carga la aplicación en la ruta que se había pedido.
    await expect(page.getByRole('navigation', { name: 'Principal' })).toBeVisible();
    await expect(page).toHaveURL(/\/agents$/);
    await expect(page.getByRole('heading', { name: 'Agentes', level: 1 })).toBeVisible();

    // La cookie de sesión no es legible desde la página y no contiene la clave.
    const cookies = await page.context().cookies(url);
    const session = cookies.find((c) => c.name === 'af_session');
    expect(session).toMatchObject({ httpOnly: true });
    // WebKit en Windows no conserva el atributo SameSite en su almacén de cookies: lo que envía el servidor se
    // comprueba además en la cabecera de la respuesta, igual para los tres motores.
    if (browserName !== 'webkit') expect(session).toMatchObject({ sameSite: 'Strict' });
    const login = await fetch(`${url}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: TOKEN }),
    });
    expect(login.headers.get('set-cookie')).toMatch(/af_session=[^;]+;.*HttpOnly.*SameSite=Strict/i);
    expect(session!.value).not.toContain(TOKEN);
    expect(await page.evaluate(() => document.cookie)).not.toContain('af_session');

    // La sesión sobrevive a una recarga y sirve también para los flujos en vivo (EventSource no envía cabeceras propias).
    await page.reload();
    await expect(page.getByRole('navigation', { name: 'Principal' })).toBeVisible();
    const streamStatus = await page.evaluate(
      () =>
        new Promise<string>((resolve) => {
          const es = new EventSource('/api/stream/runs');
          es.onopen = () => {
            es.close();
            resolve('abierto');
          };
          es.onerror = () => {
            es.close();
            resolve('error');
          };
        }),
    );
    expect(streamStatus).toBe('abierto');

    // En otro navegador (sin la cookie) vuelve a pedirse la clave.
    const other = await page.context().browser()!.newContext();
    const otherPage = await other.newPage();
    await otherPage.goto(url);
    await expect(otherPage.getByLabel('Clave de acceso')).toBeVisible();
    await other.close();

    expect(pageErrors).toEqual([]);
  });
});
