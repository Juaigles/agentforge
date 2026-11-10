// Fixtures de Playwright: un servidor AgentForge real por worker, con datos temporales y el modelo simulado.
import { test as base, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAKE_MODEL, startFakeOllama, type FakeOllama } from './fake-ollama';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface AgentSpec {
  name: string;
  systemPrompt?: string;
  tools?: string[];
  role?: string;
  thinking?: boolean;
}

export interface NodeSpec {
  id: string;
  type: 'input' | 'agent' | 'tool' | 'condition' | 'transform' | 'output' | 'foreach';
  label?: string;
  config?: Record<string, unknown>;
}

export interface AppHandle {
  url: string;
  dataDir: string;
  fake: FakeOllama;
  /** Mata el proceso del servidor (sin apagado ordenado) y lo vuelve a arrancar sobre los mismos datos. */
  restart(): Promise<void>;
  stop(): Promise<void>;
  start(): Promise<void>;
  /** Salida estándar y de error del servidor (para diagnosticar fallos). */
  logs(): string;
  api<T = any>(method: string, route: string, body?: unknown): Promise<T>;
  providerId(): Promise<string>;
  createAgent(spec: AgentSpec): Promise<{ id: string; name: string }>;
  /** Crea un workflow; `edges` con la forma 'a>b' o 'cond:true>b'. */
  createWorkflow(name: string, nodes: NodeSpec[], edges: string[], settings?: Record<string, unknown>): Promise<{ id: string; name: string }>;
  /** Lanza una ejecución por API y espera a que termine. */
  runToEnd(kind: 'workflows' | 'agents', id: string, input: string): Promise<any>;
  waitForRun(id: string, timeoutMs?: number): Promise<any>;
}

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function startApp(): Promise<AppHandle> {
  const fake = await startFakeOllama();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-e2e-'));
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  let child: ChildProcess | null = null;
  let output = '';

  async function start(): Promise<void> {
    // Un único proceso de Node (tsx como cargador): matarlo equivale a un corte de corriente real.
    child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: path.join(repoRoot, 'server'),
      env: {
        ...process.env,
        PORT: String(port),
        HOST: '127.0.0.1',
        AGENTFORGE_DATA_DIR: dataDir,
        OLLAMA_URL: fake.url,
        AGENTFORGE_SEED: '1',
        AGENTFORGE_DEFAULT_MODEL: '',
        AGENTFORGE_LOG: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (c) => (output += c));
    child.stderr?.on('data', (c) => (output += c));
    const started = child;
    const deadline = Date.now() + 30_000;
    for (;;) {
      if (started.exitCode !== null) throw new Error(`El servidor de AgentForge terminó al arrancar (código ${started.exitCode}).\n${output}`);
      try {
        const res = await fetch(`${url}/api/health`);
        if (res.ok) return;
      } catch {
        /* todavía no escucha */
      }
      if (Date.now() > deadline) throw new Error(`El servidor de AgentForge no respondió en 30 s.\n${output}`);
      await sleep(100);
    }
  }

  async function stop(): Promise<void> {
    const proc = child;
    child = null;
    if (!proc || proc.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      proc.once('exit', () => resolve());
      proc.kill('SIGKILL');
    });
  }

  async function api<T>(method: string, route: string, body?: unknown): Promise<T> {
    const res = await fetch(`${url}${route}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${route} → ${res.status}: ${text}`);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async function providerId(): Promise<string> {
    const providers = await api<Array<{ id: string; kind: string; baseUrl: string }>>('GET', '/api/providers');
    const own = providers.find((p) => p.kind === 'ollama' && p.baseUrl === fake.url);
    if (!own) throw new Error('No se encontró el proveedor de ejemplo que apunta al modelo simulado.');
    return own.id;
  }

  async function waitForRun(id: string, timeoutMs = 30_000): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const run = await api<any>('GET', `/api/runs/${id}`);
      if (!['queued', 'running'].includes(run.status)) return run;
      if (Date.now() > deadline) throw new Error(`La ejecución ${id} sigue «${run.status}» tras ${timeoutMs} ms.`);
      await sleep(50);
    }
  }

  const handle: AppHandle = {
    url,
    dataDir,
    fake,
    start,
    stop,
    async restart() {
      await stop();
      await start();
    },
    logs: () => output,
    api,
    providerId,
    async createAgent(spec) {
      return api('POST', '/api/agents', {
        name: spec.name,
        role: spec.role ?? '',
        description: '',
        color: '#6366f1',
        providerId: await providerId(),
        model: FAKE_MODEL,
        systemPrompt: spec.systemPrompt ?? '',
        temperature: 0.2,
        maxTokens: null,
        maxIterations: 4,
        tools: spec.tools ?? [],
        thinking: spec.thinking ?? false,
      });
    },
    async createWorkflow(name, nodes, edges, settings = {}) {
      return api('POST', '/api/workflows', {
        name,
        description: '',
        nodes: nodes.map((n, i) => ({ id: n.id, type: n.type, label: n.label ?? n.id, position: { x: i * 260, y: 100 }, config: n.config ?? {} })),
        edges: edges.map((spec, i) => {
          const [from, target] = spec.split('>');
          const [source, sourceHandle] = from.split(':');
          return { id: `e${i}`, source, target, sourceHandle: sourceHandle ?? null };
        }),
        settings: { maxConcurrency: 4, maxDurationMs: 600_000, maxLlmCalls: 40, onError: 'fail', defaultRetries: 0, ...settings },
      });
    },
    async runToEnd(kind, id, input) {
      const run = await api<{ id: string }>('POST', `/api/${kind}/${id}/run`, { input });
      return waitForRun(run.id);
    },
    waitForRun,
  };

  await start();
  return handle;
}

export const test = base.extend<{ app: AppHandle }, { workerApp: AppHandle }>({
  workerApp: [
    async ({}, use) => {
      if (!fs.existsSync(path.join(repoRoot, 'web', 'dist', 'index.html'))) {
        throw new Error('Falta web/dist: ejecuta «npm run build» (o «npm run test:e2e», que compila antes).');
      }
      const app = await startApp();
      await use(app);
      await app.stop();
      await app.fake.close();
      fs.rmSync(app.dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
    { scope: 'worker' },
  ],
  // Cada test parte con el modelo simulado «limpio» (sin fallos programados ni clave exigida).
  app: async ({ workerApp }, use, testInfo) => {
    workerApp.fake.reset();
    await use(workerApp);
    if (testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach('servidor.log', { body: workerApp.logs().slice(-20_000), contentType: 'text/plain' });
    }
  },
  baseURL: async ({ workerApp }, use) => {
    await use(workerApp.url);
  },
  // Cualquier error de JavaScript o de consola en la página hace fallar el test.
  page: async ({ page }, use) => {
    const problems: string[] = [];
    page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const text = msg.text();
      // Ruido esperado: peticiones que el propio test provoca que fallen (4xx/5xx o servidor reiniciándose).
      if (/Failed to load resource|net::ERR_/.test(text)) return;
      problems.push(`console.error: ${text}`);
    });
    await use(page);
    expect(problems, 'La página no debe producir errores de JavaScript').toEqual([]);
  },
});

export { expect };

/** Nombre único por test, para que los tests no dependan del orden ni de datos de otros. */
export const unique = (prefix: string) => `${prefix} ${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;

/** Aviso (toast) con el texto indicado. */
export const toast = (page: Page, text: string | RegExp) => page.locator('.toast').filter({ hasText: text });

/** Comprueba que la página no se desborda en horizontal (ni el documento ni el área principal). */
export async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    const main = document.querySelector('main');
    return {
      doc: doc.scrollWidth - doc.clientWidth,
      main: main ? main.scrollWidth - main.clientWidth : 0,
    };
  });
  expect(overflow, `Desbordamiento horizontal en ${page.url()}`).toEqual({ doc: 0, main: 0 });
}
