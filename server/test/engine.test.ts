// Tests del motor de orquestación. Se ejecuta el motor real (planificador, agentes, herramientas,
// persistencia SQLite en memoria); solo el proveedor LLM está guionizado.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/context';
import { LlmError } from '../src/errors';
import { evaluateCondition } from '../src/engine/workflow-engine';
import { sleep } from '../src/util';
import { addAgent, delay, edges, lastMessage, makeContext, node, runWorkflow, ScriptedLlm, stepStatus, systemText, userText, workflow } from './helpers';

let ctx: AppContext;
afterEach(async () => {
  await ctx?.close();
  if (ctx) fs.rmSync(ctx.config.dataDir, { recursive: true, force: true });
});

const echo = new ScriptedLlm((req) => ({ content: `eco(${userText(req)})` }));

describe('dependencias y paso de resultados', () => {
  it('ejecuta en secuencia y pasa la salida de cada nodo al siguiente', async () => {
    const llm = new ScriptedLlm((req) => ({ content: `[${userText(req)}]` }));
    ctx = makeContext(llm);
    const a = addAgent(ctx);
    const run = await runWorkflow(
      ctx,
      workflow(
        [
          node('in', 'input'),
          node('uno', 'agent', { agentId: a.id, prompt: 'A:{{input}}' }),
          node('dos', 'agent', { agentId: a.id, prompt: 'B:{{uno}}' }),
          node('out', 'output', { template: 'FIN {{dos}} / {{uno.output}}' }),
        ],
        edges('in>uno', 'uno>dos', 'dos>out'),
      ),
      'hola',
    );
    expect(run.status).toBe('completed');
    expect(llm.calls.map(userText)).toEqual(['A:hola', 'B:[A:hola]']);
    expect(run.output).toBe('FIN [B:[A:hola]] / [A:hola]');
    expect(run.steps.find((s) => s.nodeId === 'dos')).toMatchObject({ status: 'completed', input: 'B:[A:hola]', output: '[B:[A:hola]]', attempt: 1 });
    expect(run.usage).toEqual({ promptTokens: 20, completionTokens: 10, llmCalls: 2, toolCalls: 0 });
    expect(run.startedAt && run.finishedAt).toBeTruthy();
  });

  it('un nodo con varios padres espera a todos y recibe sus salidas con {{upstream}}', async () => {
    const order: string[] = [];
    const llm = new ScriptedLlm(async (req) => {
      const text = userText(req);
      if (text === 'lento') await delay(60);
      order.push(text.slice(0, 5));
      return { content: `R-${text}` };
    });
    ctx = makeContext(llm);
    const a = addAgent(ctx);
    const run = await runWorkflow(
      ctx,
      workflow(
        [
          node('rapido', 'agent', { agentId: a.id, prompt: 'rapido' }),
          node('lento', 'agent', { agentId: a.id, prompt: 'lento' }),
          node('union', 'agent', { agentId: a.id, prompt: 'UNION\n{{upstream}}' }),
        ],
        edges('rapido>union', 'lento>union'),
      ),
    );
    expect(order).toEqual(['rapid', 'lento', 'UNION']);
    expect(userText(llm.calls[2])).toBe('UNION\n### rapido\nR-rapido\n\n### lento\nR-lento');
    // Sin nodo de salida explícito, el resultado es el de las hojas del grafo.
    expect(run.output).toBe(`R-${userText(llm.calls[2])}`);
  });
});

describe('paralelismo', () => {
  const fanOut = (agentId: string, settings = {}) =>
    workflow(
      [
        node('in', 'input'),
        node('a', 'agent', { agentId, prompt: 'a {{input}}' }),
        node('b', 'agent', { agentId, prompt: 'b {{input}}' }),
        node('c', 'agent', { agentId, prompt: 'c {{input}}' }),
        node('out', 'output'),
      ],
      edges('in>a', 'in>b', 'in>c', 'a>out', 'b>out', 'c>out'),
      settings,
    );
  const slow = () =>
    new ScriptedLlm(async (req) => {
      await delay(80);
      return { content: userText(req) };
    });

  it('ejecuta en paralelo los nodos independientes', async () => {
    const llm = slow();
    ctx = makeContext(llm);
    const started = Date.now();
    const run = await runWorkflow(ctx, fanOut(addAgent(ctx).id, { maxConcurrency: 4 }), 'x');
    expect(run.status).toBe('completed');
    expect(llm.maxInFlight).toBe(3);
    expect(Date.now() - started).toBeLessThan(230); // 3 × 80 ms en serie serían ≥ 240 ms
    expect(run.output).toBe('### a\na x\n\n### b\nb x\n\n### c\nc x');
  });

  it('respeta el límite de concurrencia del workflow', async () => {
    const llm = slow();
    ctx = makeContext(llm);
    const run = await runWorkflow(ctx, fanOut(addAgent(ctx).id, { maxConcurrency: 1 }), 'x');
    expect(run.status).toBe('completed');
    expect(llm.maxInFlight).toBe(1);
    expect(llm.calls).toHaveLength(3);
  });

  it('respeta el límite global de ejecuciones simultáneas y encola el resto', async () => {
    const llm = slow();
    ctx = makeContext(llm);
    ctx.store.updateSettings({ maxConcurrentRuns: 1 });
    const agent = addAgent(ctx);
    const r1 = ctx.runs.startAgentRun(agent, 'uno');
    const r2 = ctx.runs.startAgentRun(agent, 'dos');
    await delay(30);
    expect(ctx.store.getRunSummary(r1.id)!.status).toBe('running');
    expect(ctx.store.getRunSummary(r2.id)!.status).toBe('queued');
    await Promise.all([ctx.runs.waitFor(r1.id), ctx.runs.waitFor(r2.id)]);
    expect(llm.maxInFlight).toBe(1);
    expect(ctx.store.getRunSummary(r2.id)).toMatchObject({ status: 'completed', output: 'dos' });
  });
});

describe('condiciones y ramas', () => {
  const branching = (agentId: string) =>
    workflow(
      [
        node('in', 'input'),
        node('cond', 'condition', { left: '{{input}}', operator: 'contains', right: 'urgente' }),
        node('si', 'agent', { agentId, prompt: 'rama-si' }),
        node('no', 'agent', { agentId, prompt: 'rama-no' }),
        node('tras_no', 'transform', { template: 'post {{no}}' }),
        node('out_si', 'output', { template: '{{si}}' }),
        node('out_no', 'output', { template: '{{tras_no}}' }),
      ],
      edges('in>cond', 'cond:true>si', 'cond:false>no', 'no>tras_no', 'si>out_si', 'tras_no>out_no'),
    );

  it('toma la rama verdadera y salta toda la rama falsa (en cadena)', async () => {
    ctx = makeContext(echo);
    const run = await runWorkflow(ctx, branching(addAgent(ctx).id), 'Esto es URGENTE');
    expect(stepStatus(run)).toEqual({
      in: 'completed',
      cond: 'completed',
      si: 'completed',
      no: 'skipped',
      tras_no: 'skipped',
      out_si: 'completed',
      out_no: 'skipped',
    });
    expect(run.status).toBe('completed');
    expect(run.output).toBe('eco(rama-si)');
  });

  it('toma la rama falsa', async () => {
    ctx = makeContext(echo);
    const run = await runWorkflow(ctx, branching(addAgent(ctx).id), 'sin prisa');
    expect(stepStatus(run)).toMatchObject({ si: 'skipped', out_si: 'skipped', no: 'completed', out_no: 'completed' });
    expect(run.output).toBe('post eco(rama-no)');
  });

  it('un nodo de unión se ejecuta si al menos una rama llega activa', async () => {
    ctx = makeContext(echo);
    const a = addAgent(ctx);
    const run = await runWorkflow(
      ctx,
      workflow(
        [
          node('in', 'input'),
          node('cond', 'condition', { left: '{{input}}', operator: 'equals', right: 'a' }),
          node('ra', 'transform', { template: 'A' }),
          node('rb', 'transform', { template: 'B' }),
          node('fin', 'output'),
        ],
        edges('in>cond', 'cond:true>ra', 'cond:false>rb', 'ra>fin', 'rb>fin'),
      ),
      'a',
    );
    expect(a).toBeTruthy();
    expect(stepStatus(run)).toMatchObject({ ra: 'completed', rb: 'skipped', fin: 'completed' });
    expect(run.output).toBe('A');
  });

  it('evalúa todos los operadores', async () => {
    expect(await evaluateCondition('Hola Mundo', 'contains', 'mundo')).toBe(true);
    expect(await evaluateCondition('Hola', 'not_contains', 'x')).toBe(true);
    expect(await evaluateCondition(' SI ', 'equals', 'si')).toBe(true);
    expect(await evaluateCondition('a', 'not_equals', 'a')).toBe(false);
    expect(await evaluateCondition('pedido 123', 'matches', '\\d{3}')).toBe(true);
    expect(await evaluateCondition('pedido', 'matches', '\\d{3}')).toBe(false);
    expect(await evaluateCondition('7,5', 'gt', '7')).toBe(true);
    expect(await evaluateCondition('3', 'lt', '2')).toBe(false);
    expect(await evaluateCondition('  ', 'is_empty', '')).toBe(true);
    expect(await evaluateCondition('x', 'not_empty', '')).toBe(true);
    await expect(evaluateCondition('abc', 'gt', '1')).rejects.toThrow(/números/);
    await expect(evaluateCondition('a', 'matches', '(')).rejects.toThrow(/regular/);
    // Números con separador de miles y decimal, en las dos convenciones; un valor vacío no vale 0.
    expect(await evaluateCondition('1.234,5', 'gt', '1234')).toBe(true);
    expect(await evaluateCondition('1,234.5', 'lt', '1235')).toBe(true);
    await expect(evaluateCondition('', 'lt', '5')).rejects.toThrow(/números/);
  });
});

describe('errores, reintentos y límites', () => {
  it('reintenta los errores transitorios y completa al segundo intento', async () => {
    const llm = new ScriptedLlm((_req, i) => {
      if (i === 0) throw new LlmError('503 saturado', { retryable: true, status: 503 });
      return { content: 'ok' };
    });
    ctx = makeContext(llm);
    const a = addAgent(ctx);
    const run = await runWorkflow(ctx, workflow([node('n', 'agent', { agentId: a.id, prompt: 'x', retries: 2 })], []));
    expect(run.status).toBe('completed');
    expect(run.steps[0]).toMatchObject({ status: 'completed', attempt: 2, output: 'ok', error: null });
    const events = ctx.store.listEvents(run.id);
    expect(events.filter((e) => e.type === 'step.retry')).toHaveLength(1);
    expect(events.find((e) => e.type === 'step.retry')!.data).toMatchObject({ attempt: 1, error: '503 saturado' });
  });

  it('agota los reintentos y falla con el último error', async () => {
    const llm = new ScriptedLlm(() => {
      throw new LlmError('sigue caído', { retryable: true });
    });
    ctx = makeContext(llm);
    const a = addAgent(ctx);
    const run = await runWorkflow(ctx, workflow([node('n', 'agent', { agentId: a.id, prompt: 'x', retries: 2 })], []));
    expect(llm.calls).toHaveLength(3);
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/"n" falló: sigue caído/);
    expect(run.steps[0]).toMatchObject({ status: 'failed', attempt: 3, error: 'sigue caído' });
  });

  it('no reintenta los errores permanentes (p. ej. modelo inexistente)', async () => {
    const llm = new ScriptedLlm(() => {
      throw new LlmError('model not found', { retryable: false, status: 404 });
    });
    ctx = makeContext(llm);
    const a = addAgent(ctx);
    const run = await runWorkflow(ctx, workflow([node('n', 'agent', { agentId: a.id, prompt: 'x', retries: 3 })], []));
    expect(llm.calls).toHaveLength(1);
    expect(run.status).toBe('failed');
  });

  it('falla con un error claro si el proveedor del agente se ha eliminado', async () => {
    ctx = makeContext(echo);
    const a = addAgent(ctx);
    const wf = ctx.store.createWorkflow(workflow([node('n', 'agent', { agentId: a.id, prompt: 'x', retries: 2 })], []));
    ctx.store.deleteProvider(a.providerId);
    const run = ctx.runs.startWorkflowRun(wf, '');
    await ctx.runs.waitFor(run.id);
    const done = ctx.store.getRun(run.id)!;
    expect(done.status).toBe('failed');
    expect(done.error).toMatch(/proveedor que ya no existe/);
    expect(done.steps[0].attempt).toBe(1);
  });

  it('política "fail": un fallo aborta las ramas en curso y salta lo que depende de él', async () => {
    const llm = new ScriptedLlm(async (req) => {
      if (userText(req) === 'falla') throw new LlmError('boom', { retryable: false });
      await sleep(5000, req.signal);
      return { content: 'tarde' };
    });
    ctx = makeContext(llm);
    const a = addAgent(ctx);
    const started = Date.now();
    const run = await runWorkflow(
      ctx,
      workflow(
        [
          node('malo', 'agent', { agentId: a.id, prompt: 'falla' }),
          node('lento', 'agent', { agentId: a.id, prompt: 'lento' }),
          node('despues', 'agent', { agentId: a.id, prompt: '{{malo}}' }),
          node('out', 'output'),
        ],
        edges('malo>despues', 'despues>out', 'lento>out'),
        { onError: 'fail' },
      ),
    );
    expect(Date.now() - started).toBeLessThan(2000);
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/"malo" falló: boom/);
    expect(stepStatus(run)).toEqual({ malo: 'failed', lento: 'cancelled', despues: 'cancelled', out: 'cancelled' });
  });

  it('política "continue": el resto del grafo sigue y la ejecución termina con lo que hay', async () => {
    const llm = new ScriptedLlm((req) => {
      if (userText(req) === 'falla') throw new LlmError('boom', { retryable: false });
      return { content: 'bien' };
    });
    ctx = makeContext(llm);
    const a = addAgent(ctx);
    const run = await runWorkflow(
      ctx,
      workflow(
        [
          node('malo', 'agent', { agentId: a.id, prompt: 'falla' }),
          node('bueno', 'agent', { agentId: a.id, prompt: 'ok' }),
          node('dep_malo', 'transform', { template: '{{malo}}' }),
          node('out_malo', 'output', { template: '{{dep_malo}}' }),
          node('out_bueno', 'output', { template: '{{bueno}}' }),
        ],
        edges('malo>dep_malo', 'dep_malo>out_malo', 'bueno>out_bueno'),
        { onError: 'continue' },
      ),
    );
    expect(stepStatus(run)).toEqual({ malo: 'failed', bueno: 'completed', dep_malo: 'skipped', out_malo: 'skipped', out_bueno: 'completed' });
    expect(run.status).toBe('completed');
    expect(run.output).toBe('bien');
  });

  it('política "continue" sin ninguna salida producida: la ejecución falla', async () => {
    const llm = new ScriptedLlm(() => {
      throw new LlmError('boom', { retryable: false });
    });
    ctx = makeContext(llm);
    const a = addAgent(ctx);
    const run = await runWorkflow(
      ctx,
      workflow([node('malo', 'agent', { agentId: a.id, prompt: 'x' }), node('out', 'output')], edges('malo>out'), { onError: 'continue' }),
    );
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/boom/);
  });

  it('corta la ejecución al superar la duración máxima', async () => {
    const llm = new ScriptedLlm(async (req) => {
      await sleep(5000, req.signal);
      return { content: 'tarde' };
    });
    ctx = makeContext(llm);
    const a = addAgent(ctx);
    const started = Date.now();
    const run = await runWorkflow(ctx, workflow([node('n', 'agent', { agentId: a.id, prompt: 'x', retries: 3 })], [], { maxDurationMs: 120 }));
    expect(Date.now() - started).toBeLessThan(1500);
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/duración máxima/);
    expect(run.steps[0].status).toBe('cancelled');
    expect(llm.calls).toHaveLength(1);
  });

  it('aplica el timeout por nodo y lo trata como error reintentable', async () => {
    const llm = new ScriptedLlm(async (req, i) => {
      if (i === 0) await sleep(5000, req.signal);
      return { content: 'a tiempo' };
    });
    ctx = makeContext(llm);
    const a = addAgent(ctx);
    const run = await runWorkflow(ctx, workflow([node('n', 'agent', { agentId: a.id, prompt: 'x', retries: 1, timeoutMs: 80 })], []));
    expect(run.status).toBe('completed');
    expect(run.steps[0]).toMatchObject({ attempt: 2, output: 'a tiempo' });
    expect(ctx.store.listEvents(run.id).find((e) => e.type === 'step.retry')!.data.error).toMatch(/tiempo máximo \(80 ms\)/);
  });

  it('corta al alcanzar el límite de llamadas al modelo y no lo reintenta', async () => {
    const llm = new ScriptedLlm(() => ({ toolCalls: [{ id: 'c', name: 'current_datetime', arguments: {} }] }));
    ctx = makeContext(llm);
    const a = addAgent(ctx, { tools: ['current_datetime'], maxIterations: 20 });
    const run = await runWorkflow(ctx, workflow([node('n', 'agent', { agentId: a.id, prompt: 'x', retries: 3 })], [], { maxLlmCalls: 4 }));
    expect(llm.calls).toHaveLength(4);
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/límite de 4 llamadas/);
    expect(run.steps[0].attempt).toBe(1);
    // El uso consumido antes del fallo no se pierde.
    expect(run.usage).toMatchObject({ llmCalls: 4, toolCalls: 4, promptTokens: 40 });
  });

  it('una respuesta vacía del modelo se trata como error reintentable', async () => {
    const llm = new ScriptedLlm((_req, i) => ({ content: i === 0 ? '   ' : 'ahora sí' }));
    ctx = makeContext(llm);
    const a = addAgent(ctx);
    const run = await runWorkflow(ctx, workflow([node('n', 'agent', { agentId: a.id, prompt: 'x', retries: 1 })], []));
    expect(run).toMatchObject({ status: 'completed', output: 'ahora sí' });
  });
});

describe('cancelación', () => {
  it('cancela una ejecución en curso abortando la llamada al modelo', async () => {
    let aborted = false;
    const llm = new ScriptedLlm(async (req) => {
      req.signal!.addEventListener('abort', () => (aborted = true));
      await sleep(10_000, req.signal);
      return { content: 'nunca' };
    });
    ctx = makeContext(llm);
    const a = addAgent(ctx);
    const wf = ctx.store.createWorkflow(workflow([node('n', 'agent', { agentId: a.id, prompt: 'x', retries: 3 }), node('out', 'output')], edges('n>out')));
    const run = ctx.runs.startWorkflowRun(wf, '');
    await delay(50);
    expect(ctx.store.getRunSummary(run.id)!.status).toBe('running');
    const started = Date.now();
    expect(ctx.runs.cancel(run.id)).toBe(true);
    await ctx.runs.waitFor(run.id);
    expect(Date.now() - started).toBeLessThan(500);
    expect(aborted).toBe(true);
    const done = ctx.store.getRun(run.id)!;
    expect(done.status).toBe('cancelled');
    expect(done.error).toMatch(/cancelada/i);
    expect(stepStatus(done)).toEqual({ n: 'cancelled', out: 'cancelled' });
    expect(llm.calls).toHaveLength(1);
    expect(ctx.runs.cancel(run.id)).toBe(false);
    expect(ctx.store.listEvents(run.id).at(-1)).toMatchObject({ type: 'run.finished', data: { status: 'cancelled' } });
  });

  it('cancela una ejecución que aún está en cola sin llegar a ejecutarla', async () => {
    const llm = new ScriptedLlm(async (req) => {
      await sleep(10_000, req.signal);
      return { content: 'x' };
    });
    ctx = makeContext(llm);
    ctx.store.updateSettings({ maxConcurrentRuns: 1 });
    const a = addAgent(ctx);
    const r1 = ctx.runs.startAgentRun(a, 'uno');
    const r2 = ctx.runs.startAgentRun(a, 'dos');
    await delay(30);
    expect(ctx.runs.cancel(r2.id)).toBe(true);
    expect(ctx.store.getRun(r2.id)).toMatchObject({ status: 'cancelled', startedAt: null });
    ctx.runs.cancel(r1.id);
    await ctx.runs.waitFor(r1.id);
    expect(llm.calls).toHaveLength(1);
  });
});

describe('agentes y herramientas', () => {
  it('ejecuta el bucle herramienta→modelo con herramientas reales y devuelve el resultado al modelo', async () => {
    const llm = new ScriptedLlm((req, i) => {
      if (i === 0) return { toolCalls: [{ id: 'c1', name: 'calculator', arguments: { expression: '6 * 7' } }] };
      return { content: `El resultado es ${JSON.parse(lastMessage(req).content).result}` };
    });
    ctx = makeContext(llm);
    const a = addAgent(ctx, {
      name: 'Mates',
      role: 'calculista',
      systemPrompt: 'Sé preciso.',
      tools: ['calculator'],
      temperature: 0.1,
      maxTokens: 99,
      thinking: true,
    });
    const run = await runWorkflow(ctx, workflow([node('n', 'agent', { agentId: a.id, prompt: '¿6 por 7?' })], []));
    expect(run).toMatchObject({ status: 'completed', output: 'El resultado es 42' });
    expect(run.usage).toMatchObject({ llmCalls: 2, toolCalls: 1 });

    // La petición al modelo lleva la configuración del agente.
    expect(llm.calls[0]).toMatchObject({ model: 'test-model', temperature: 0.1, maxTokens: 99, think: true });
    expect(systemText(llm.calls[0])).toContain('Eres «Mates», calculista.');
    expect(systemText(llm.calls[0])).toContain('Sé preciso.');
    expect(llm.calls[0].tools!.map((t) => t.name)).toEqual(['calculator']);
    // La segunda petición contiene la llamada y su resultado.
    expect(llm.calls[1].messages.slice(2)).toMatchObject([
      { role: 'assistant', toolCalls: [{ id: 'c1', name: 'calculator' }] },
      { role: 'tool', toolCallId: 'c1', name: 'calculator' },
    ]);

    const types = ctx.store.listEvents(run.id).map((e) => e.type);
    expect(types).toEqual([
      'run.started',
      'step.started',
      'llm.start',
      'llm.message',
      'tool.call',
      'tool.result',
      'llm.start',
      'llm.message',
      'step.finished',
      'run.finished',
    ]);
  });

  it('devuelve al modelo los errores de herramienta y bloquea la repetición de llamadas idénticas fallidas', async () => {
    const llm = new ScriptedLlm((req, i) => {
      if (i < 2) return { toolCalls: [{ id: `c${i}`, name: 'calculator', arguments: { expression: '1 / 0' } }] };
      if (i === 2) return { toolCalls: [{ id: 'c2', name: 'inventada', arguments: {} }] };
      return { content: lastMessage(req).content };
    });
    ctx = makeContext(llm);
    const a = addAgent(ctx, { tools: ['calculator'], maxIterations: 6 });
    const run = await runWorkflow(ctx, workflow([node('n', 'agent', { agentId: a.id, prompt: 'x' })], []));
    expect(run.status).toBe('completed');
    const results = ctx.store
      .listEvents(run.id)
      .filter((e) => e.type === 'tool.result')
      .map((e) => e.data);
    expect(results.map((r) => r.ok)).toEqual([false, false, false]);
    expect(results[0].result).toMatch(/División entre cero/);
    expect(results[1].result).toMatch(/Ya hiciste esta misma llamada/);
    expect(results[2].result).toMatch(/"inventada" no está disponible. Disponibles: calculator/);
    expect(run.output).toMatch(/no está disponible/);
  });

  it('al agotar las iteraciones fuerza una respuesta final sin herramientas', async () => {
    const llm = new ScriptedLlm((req) =>
      req.tools?.length ? { toolCalls: [{ id: 'c', name: 'current_datetime', arguments: {} }] } : { content: 'respuesta final' },
    );
    ctx = makeContext(llm);
    const a = addAgent(ctx, { tools: ['current_datetime'], maxIterations: 2 });
    const run = await runWorkflow(ctx, workflow([node('n', 'agent', { agentId: a.id, prompt: 'x' })], []));
    expect(run).toMatchObject({ status: 'completed', output: 'respuesta final' });
    expect(llm.calls).toHaveLength(3);
    expect(llm.calls[2].tools).toBeUndefined();
    expect(lastMessage(llm.calls[2]).content).toMatch(/límite de pasos/);
  });

  it('un agente delega en otro y recibe su respuesta', async () => {
    const llm = new ScriptedLlm((req, i) => {
      if (systemText(req).includes('«Jefe»')) {
        if (i === 0) return { toolCalls: [{ id: 'd1', name: 'delegate_task', arguments: { agent: 'experto', task: 'resume X' } }] };
        return { content: `Jefe dice: ${JSON.parse(lastMessage(req).content).response}` };
      }
      return { content: `informe del experto sobre "${userText(req)}"` };
    });
    ctx = makeContext(llm);
    const jefe = addAgent(ctx, { name: 'Jefe', tools: ['delegate_task'] });
    addAgent(ctx, { name: 'Experto', role: 'sabe de X' });
    const run = await runWorkflow(ctx, workflow([node('n', 'agent', { agentId: jefe.id, prompt: 'hazlo' })], []));
    expect(run.output).toBe('Jefe dice: informe del experto sobre "resume X"');
    expect(run.usage).toMatchObject({ llmCalls: 3, toolCalls: 1 });
    // El modelo ve la lista de agentes disponibles en la descripción de la herramienta.
    expect(llm.calls[0].tools![0].description).toContain('- Experto: sabe de X');
    const subEvents = ctx.store.listEvents(run.id).filter((e) => e.data.depth === 1);
    expect(subEvents.map((e) => e.type)).toEqual(['llm.start', 'llm.message']);
    expect(subEvents[0].data.agent).toBe('Experto');
  });

  it('los agentes de un workflow comparten memoria', async () => {
    const llm = new ScriptedLlm((req) => {
      const last = lastMessage(req);
      if (last.role === 'tool') return { content: last.content };
      return userText(req) === 'guarda'
        ? { toolCalls: [{ id: 'm1', name: 'memory_set', arguments: { key: 'dato', value: '42' } }] }
        : { toolCalls: [{ id: 'm2', name: 'memory_get', arguments: { key: 'dato' } }] };
    });
    ctx = makeContext(llm);
    const a = addAgent(ctx, { tools: ['memory_set', 'memory_get'] });
    const run = await runWorkflow(
      ctx,
      workflow([node('w', 'agent', { agentId: a.id, prompt: 'guarda' }), node('r', 'agent', { agentId: a.id, prompt: 'lee {{w}}' })], edges('w>r')),
    );
    expect(JSON.parse(run.output!)).toMatchObject({ found: true, value: '42' });
  });

  it('un nodo de herramienta realiza la operación real (escribir un archivo) con argumentos plantilla', async () => {
    ctx = makeContext(echo);
    const a = addAgent(ctx);
    const run = await runWorkflow(
      ctx,
      workflow(
        [
          node('in', 'input'),
          node('ag', 'agent', { agentId: a.id, prompt: '{{input}}' }),
          node('guardar', 'tool', { tool: 'file_write', args: { path: 'out/{{input}}.txt', content: 'R: {{ag}}' } }),
          node('calc', 'tool', { tool: 'calculator', args: { expression: '2 + 2' } }),
        ],
        edges('in>ag', 'ag>guardar', 'in>calc'),
      ),
      'tema',
    );
    expect(run.status).toBe('completed');
    expect(fs.readFileSync(path.join(ctx.config.workspaceDir, 'out', 'tema.txt'), 'utf8')).toBe('R: eco(tema)');
    expect(JSON.parse(run.steps.find((s) => s.nodeId === 'calc')!.output!)).toEqual({ expression: '2 + 2', result: 4 });
    expect(run.usage.toolCalls).toBe(2);
  });

  it('un nodo de herramienta que falla hace fallar la ejecución con el error de la herramienta', async () => {
    ctx = makeContext(echo);
    const run = await runWorkflow(ctx, workflow([node('t', 'tool', { tool: 'file_read', args: { path: 'no-existe.txt' } })], []));
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/El archivo no existe/);
  });
});

describe('eventos y reintentos de ejecución', () => {
  it('persiste los eventos con secuencia creciente y no guarda los deltas de streaming', async () => {
    ctx = makeContext(echo);
    const a = addAgent(ctx);
    const wf = ctx.store.createWorkflow(workflow([node('n', 'agent', { agentId: a.id, prompt: 'hola' })], []));
    const run = ctx.runs.startWorkflowRun(wf, '');
    const live: Array<{ seq: number | null; type: string }> = [];
    ctx.runs.subscribe(run.id, (ev) => live.push({ seq: ev.seq, type: ev.type }));
    await ctx.runs.waitFor(run.id);

    const stored = ctx.store.listEvents(run.id);
    expect(stored.map((e) => e.seq)).toEqual(stored.map((_e, i) => i + 1));
    expect(stored.some((e) => e.type === 'llm.delta')).toBe(false);
    // En directo sí llegan los deltas (transitorios, sin seq) y los mismos eventos persistidos.
    expect(live.find((e) => e.type === 'llm.delta')).toEqual({ seq: null, type: 'llm.delta' });
    expect(live.filter((e) => e.seq !== null)).toEqual(stored.map((e) => ({ seq: e.seq, type: e.type })));
    expect(ctx.store.listEvents(run.id, 3).map((e) => e.seq)).toEqual(stored.slice(3).map((e) => e.seq));
  });

  it('usa una instantánea: editar el agente o el workflow después no altera la ejecución', async () => {
    const llm = new ScriptedLlm(async (req) => {
      await delay(40);
      return { content: systemText(req) };
    });
    ctx = makeContext(llm);
    const a = addAgent(ctx, { name: 'Original' });
    const wf = ctx.store.createWorkflow(workflow([node('n', 'agent', { agentId: a.id, prompt: 'x' })], []));
    const run = ctx.runs.startWorkflowRun(wf, '');
    const { id: _i, createdAt: _c, updatedAt: _u, ...input } = a;
    ctx.store.updateAgent(a.id, { ...input, name: 'Editado' });
    ctx.store.deleteWorkflow(wf.id);
    await ctx.runs.waitFor(run.id);
    const done = ctx.store.getRun(run.id)!;
    expect(done.status).toBe('completed');
    expect(done.output).toContain('«Original»');
    expect(done.snapshot.agents[a.id].name).toBe('Original');
  });

  it('reintentar "desde el fallo" reutiliza los nodos completados y solo repite el resto', async () => {
    let failB = true;
    const llm = new ScriptedLlm((req) => {
      if (userText(req).startsWith('B') && failB) throw new LlmError('caída', { retryable: false });
      return { content: `ok:${userText(req)}` };
    });
    ctx = makeContext(llm);
    const a = addAgent(ctx);
    const first = await runWorkflow(
      ctx,
      workflow(
        [
          node('a', 'agent', { agentId: a.id, prompt: 'A' }),
          node('b', 'agent', { agentId: a.id, prompt: 'B {{a}}' }),
          node('out', 'output', { template: '{{b}}' }),
        ],
        edges('a>b', 'b>out'),
      ),
    );
    expect(first.status).toBe('failed');
    expect(llm.calls).toHaveLength(2);

    failB = false;
    const retry = ctx.runs.retryRun(first, 'failed');
    await ctx.runs.waitFor(retry.id);
    const done = ctx.store.getRun(retry.id)!;
    expect(done).toMatchObject({ status: 'completed', output: 'ok:B ok:A', retryOf: first.id });
    expect(llm.calls).toHaveLength(3); // solo se ha vuelto a llamar para B
    expect(ctx.store.listEvents(retry.id).some((e) => e.type === 'step.reused' && e.nodeId === 'a')).toBe(true);

    const full = ctx.runs.retryRun(first, 'all');
    await ctx.runs.waitFor(full.id);
    expect(llm.calls).toHaveLength(5); // A y B de nuevo
  });

  it('una ejecución de agente individual pasa por el mismo motor', async () => {
    ctx = makeContext(echo);
    const a = addAgent(ctx, { name: 'Solo' });
    const run = ctx.runs.startAgentRun(a, 'tarea');
    expect(run).toMatchObject({ kind: 'agent', agentId: a.id, workflowId: null, status: 'queued', name: 'Solo' });
    await ctx.runs.waitFor(run.id);
    expect(ctx.store.getRun(run.id)).toMatchObject({ status: 'completed', output: 'eco(tarea)' });
  });
});
