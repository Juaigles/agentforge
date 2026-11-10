import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_WORKFLOW_SETTINGS,
  type Agent,
  type AgentInput,
  type Run,
  type WorkflowEdge,
  type WorkflowInput,
  type WorkflowNode,
  type WorkflowSettings,
} from '../../shared/types';
import type { AppConfig } from '../src/config';
import { createContext, type AppContext } from '../src/context';
import type { ChatRequest, ChatResult, LlmClient, LlmFactory } from '../src/llm/types';

export function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-test-'));
}

export function testConfig(dataDir = tempDir()): AppConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    dataDir,
    dbFile: path.join(dataDir, 'agentforge.db'),
    workspaceDir: path.join(dataDir, 'workspace'),
    webDist: path.join(dataDir, 'no-web'),
    seed: false,
    ollamaUrl: 'http://127.0.0.1:1',
    logger: false,
    schedulerTickMs: 5000,
  };
}

export type ScriptHandler = (req: ChatRequest, callIndex: number) => Promise<Partial<ChatResult>> | Partial<ChatResult>;

/**
 * Doble de prueba del proveedor LLM (la única frontera externa del motor).
 * El guion decide la respuesta a partir de la petición real que construye el motor.
 */
export class ScriptedLlm implements LlmFactory {
  readonly calls: ChatRequest[] = [];
  inFlight = 0;
  maxInFlight = 0;

  constructor(private handler: ScriptHandler) {}

  create(): LlmClient {
    return {
      chat: async (req) => {
        const index = this.calls.push(req) - 1;
        this.inFlight++;
        this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
        try {
          const partial = await this.handler(req, index);
          if (partial.content) req.onDelta?.(partial.content);
          return {
            content: '',
            thinking: '',
            toolCalls: [],
            usage: { promptTokens: 10, completionTokens: 5 },
            finishReason: 'stop',
            ...partial,
          };
        } finally {
          this.inFlight--;
        }
      },
      listModels: async () => [{ id: 'test-model' }],
    };
  }
}

/** Texto del mensaje de usuario y de sistema de una petición. */
export const userText = (req: ChatRequest) => req.messages.find((m) => m.role === 'user')?.content ?? '';
export const systemText = (req: ChatRequest) => req.messages.find((m) => m.role === 'system')?.content ?? '';
export const lastMessage = (req: ChatRequest) => req.messages[req.messages.length - 1];

export function makeContext(llm: LlmFactory, opts: { dataDir?: string; inMemory?: boolean } = {}): AppContext {
  return createContext(testConfig(opts.dataDir), { llm, inMemory: opts.inMemory ?? true, retryBaseDelayMs: 5 });
}

export function addAgent(ctx: AppContext, overrides: Partial<AgentInput> = {}): Agent {
  const provider =
    ctx.store.listProviders()[0] ?? ctx.store.createProvider({ name: 'Test', kind: 'ollama', baseUrl: 'http://127.0.0.1:1' });
  return ctx.store.createAgent({
    name: 'Agente',
    role: '',
    description: '',
    color: '#6366f1',
    providerId: provider.id,
    model: 'test-model',
    systemPrompt: '',
    temperature: 0.5,
    maxTokens: null,
    maxIterations: 4,
    tools: [],
    thinking: false,
    ...overrides,
  });
}

export const node = (id: string, type: WorkflowNode['type'], config: Record<string, any> = {}): WorkflowNode => ({
  id,
  type,
  label: id,
  position: { x: 0, y: 0 },
  config,
});

/** 'a>b' crea una arista a→b; 'c:true>d' usa el handle indicado. */
export function edges(...specs: string[]): WorkflowEdge[] {
  return specs.map((spec, i) => {
    const [from, target] = spec.split('>');
    const [source, sourceHandle] = from.split(':');
    return { id: `e${i}`, source, target, sourceHandle: sourceHandle ?? null };
  });
}

export function workflow(nodes: WorkflowNode[], edgeList: WorkflowEdge[], settings: Partial<WorkflowSettings> = {}): WorkflowInput {
  return { name: 'wf', description: '', nodes, edges: edgeList, settings: { ...DEFAULT_WORKFLOW_SETTINGS, defaultRetries: 0, ...settings } };
}

/** Lanza un workflow y espera a que termine. */
export async function runWorkflow(ctx: AppContext, def: WorkflowInput, input = 'entrada'): Promise<Run> {
  const wf = ctx.store.createWorkflow(def);
  const run = ctx.runs.startWorkflowRun(wf, input);
  await ctx.runs.waitFor(run.id);
  return ctx.store.getRun(run.id)!;
}

export const stepStatus = (run: Run) => Object.fromEntries(run.steps.map((s) => [s.nodeId, s.status]));

/** Servidor HTTP local para probar adaptadores y herramientas con tráfico real. */
export async function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => unknown,
): Promise<{ url: string; close: () => Promise<void>; requests: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders; body: string }> }> {
  const requests: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders; body: string }> = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      void handler(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
