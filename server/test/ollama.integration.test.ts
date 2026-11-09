// Tests de integración contra un Ollama REAL (sin dobles). Se omiten si no hay servidor disponible.
// El adaptador OpenAI-compatible se verifica contra el endpoint /v1 del propio Ollama.
import fs from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import type { ModelInfo } from '../../shared/types';
import type { AppContext } from '../src/context';
import { defaultLlmFactory } from '../src/llm';
import { OllamaClient } from '../src/llm/ollama';
import { OpenAiCompatibleClient } from '../src/llm/openai';
import { pickDefaultModel } from '../src/seed';
import { addAgent, edges, makeContext, node, runWorkflow, workflow } from './helpers';

const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434';

let models: ModelInfo[] = [];
try {
  models = await new OllamaClient(OLLAMA_URL).listModels(AbortSignal.timeout(2000));
} catch {
  /* sin Ollama: los tests se omiten */
}
const model = process.env.AGENTFORGE_TEST_MODEL ?? pickDefaultModel(models);
const toolsCapable = models.find((m) => m.id === model)?.capabilities?.includes('tools') ?? false;

const contexts: AppContext[] = [];
afterAll(async () => {
  for (const ctx of contexts) {
    await ctx.close();
    fs.rmSync(ctx.config.dataDir, { recursive: true, force: true });
  }
});

function realContext(): AppContext {
  const ctx = makeContext(defaultLlmFactory);
  ctx.store.createProvider({ name: 'Ollama', kind: 'ollama', baseUrl: OLLAMA_URL });
  contexts.push(ctx);
  return ctx;
}

describe.skipIf(!model)(`integración con Ollama real (${model ?? 'no disponible'})`, () => {
  it('chat nativo con streaming y recuento de tokens', { timeout: 180_000 }, async () => {
    const deltas: string[] = [];
    const res = await new OllamaClient(OLLAMA_URL).chat({
      model: model!,
      messages: [{ role: 'user', content: 'Responde únicamente con la palabra: pong' }],
      temperature: 0,
      think: false,
      maxTokens: 20,
      onDelta: (t) => deltas.push(t),
    });
    expect(res.content.toLowerCase()).toContain('pong');
    expect(deltas.join('')).toBe(res.content);
    expect(res.usage.promptTokens).toBeGreaterThan(0);
    expect(res.usage.completionTokens).toBeGreaterThan(0);
  });

  it('adaptador OpenAI-compatible contra /v1 de Ollama', { timeout: 180_000 }, async () => {
    const client = new OpenAiCompatibleClient(`${OLLAMA_URL}/v1`);
    expect((await client.listModels()).map((m) => m.id)).toContain(model);
    const deltas: string[] = [];
    const res = await client.chat({
      model: model!,
      messages: [{ role: 'user', content: 'Responde únicamente con la palabra: pong' }],
      temperature: 0,
      think: false,
      maxTokens: 20,
      onDelta: (t) => deltas.push(t),
    });
    expect(res.content.toLowerCase()).toContain('pong');
    expect(deltas.join('')).toBe(res.content);
    expect(res.usage.completionTokens).toBeGreaterThan(0);
  });

  it.skipIf(!toolsCapable)('un agente real usa una herramienta real y responde con su resultado', { timeout: 240_000 }, async () => {
    const ctx = realContext();
    const agent = addAgent(ctx, {
      name: 'Calculista',
      model: model!,
      temperature: 0,
      maxTokens: 300,
      tools: ['calculator'],
      systemPrompt: 'Usa siempre la herramienta calculator para operar. Responde en una frase con el número exacto.',
    });
    const run = ctx.runs.startAgentRun(agent, '¿Cuánto es 123456 * 789? Usa la calculadora.');
    await ctx.runs.waitFor(run.id);
    const done = ctx.store.getRun(run.id)!;
    expect(done.error).toBeNull();
    expect(done.status).toBe('completed');
    const events = ctx.store.listEvents(run.id);
    const call = events.find((e) => e.type === 'tool.call');
    expect(call?.data.name).toBe('calculator');
    expect(events.find((e) => e.type === 'tool.result')?.data).toMatchObject({ ok: true, result: expect.stringContaining('97406784') });
    expect(done.output!.replace(/[.,\s]/g, '')).toContain('97406784');
    expect(done.usage.llmCalls).toBeGreaterThanOrEqual(2);
  });

  it.skipIf(!toolsCapable)('el mismo agente funciona a través del adaptador OpenAI-compatible', { timeout: 240_000 }, async () => {
    const ctx = makeContext(defaultLlmFactory);
    contexts.push(ctx);
    ctx.store.createProvider({ name: 'Ollama vía /v1', kind: 'openai', baseUrl: `${OLLAMA_URL}/v1` });
    const agent = addAgent(ctx, {
      model: model!,
      temperature: 0,
      maxTokens: 600,
      tools: ['calculator'],
      systemPrompt: 'Usa siempre la herramienta calculator para operar. Responde en una frase con el número exacto.',
    });
    const run = ctx.runs.startAgentRun(agent, '¿Cuánto es 4321 * 1234? Usa la calculadora.');
    await ctx.runs.waitFor(run.id);
    const done = ctx.store.getRun(run.id)!;
    expect(done.error).toBeNull();
    expect(ctx.store.listEvents(run.id).find((e) => e.type === 'tool.result')?.data.result).toContain('5332114');
    expect(done.output!.replace(/[.,\s]/g, '')).toContain('5332114');
  });

  it('workflow real con dos agentes en paralelo y un tercero que combina sus resultados', { timeout: 300_000 }, async () => {
    const ctx = realContext();
    const agent = addAgent(ctx, { model: model!, temperature: 0, maxTokens: 120, systemPrompt: 'Responde en una sola frase corta, en español.' });
    const run = await runWorkflow(
      ctx,
      workflow(
        [
          node('tema', 'input'),
          node('pros', 'agent', { agentId: agent.id, prompt: 'Di una ventaja de: {{input}}' }),
          node('contras', 'agent', { agentId: agent.id, prompt: 'Di un inconveniente de: {{input}}' }),
          node('resumen', 'agent', { agentId: agent.id, prompt: 'Combina en una frase esta ventaja y este inconveniente:\n{{upstream}}' }),
          node('fin', 'output', { template: '{{resumen}}' }),
        ],
        edges('tema>pros', 'tema>contras', 'pros>resumen', 'contras>resumen', 'resumen>fin'),
        { maxConcurrency: 2 },
      ),
      'trabajar desde casa',
    );
    expect(run.error).toBeNull();
    expect(run.status).toBe('completed');
    expect(run.steps.every((s) => s.status === 'completed')).toBe(true);
    const [pros, contras, resumen] = ['pros', 'contras', 'resumen'].map((id) => run.steps.find((s) => s.nodeId === id)!);
    // El tercer agente recibió de verdad las salidas de los otros dos.
    expect(resumen.input).toContain(pros.output!);
    expect(resumen.input).toContain(contras.output!);
    expect(run.output!.length).toBeGreaterThan(10);
    expect(run.usage.llmCalls).toBe(3);
    // Los dos primeros se solaparon en el tiempo (ejecución paralela real).
    expect(new Date(contras.startedAt!).getTime()).toBeLessThan(new Date(pros.finishedAt!).getTime());
  });
});
