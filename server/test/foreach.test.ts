// Nodo «para cada»: iteración sobre una lista con concurrencia limitada. Motor real; solo el LLM está guionizado.
import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { validateWorkflow } from '../../shared/graph';
import { parseList } from '../../shared/list';
import type { RunEvent } from '../../shared/types';
import type { AppContext } from '../src/context';
import { LlmError } from '../src/errors';
import { sleep } from '../src/util';
import { addAgent, delay, edges, makeContext, node, runWorkflow, ScriptedLlm, stepStatus, userText, workflow } from './helpers';

let ctx: AppContext;
afterEach(async () => {
  await ctx?.close();
  if (ctx) fs.rmSync(ctx.config.dataDir, { recursive: true, force: true });
});

const itemEvents = (runId: string) => ctx.store.listEvents(runId).filter((e) => e.type === 'foreach.item');

describe('interpretación de listas', () => {
  it('entiende arrays JSON, también dentro de una valla de código', () => {
    expect(parseList('["uno", "dos", 3, {"a": 1}, null, ""]')).toEqual(['uno', 'dos', '3', '{"a":1}']);
    expect(parseList('```json\n["a", "b"]\n```')).toEqual(['a', 'b']);
    expect(parseList('[]')).toEqual([]);
  });

  it('entiende listas con viñetas, numeradas o una por línea', () => {
    expect(parseList('- Madrid\n* Barcelona\n• Sevilla\n\n  1. Bilbao\n2) Vigo\nA Coruña')).toEqual(['Madrid', 'Barcelona', 'Sevilla', 'Bilbao', 'Vigo', 'A Coruña']);
    expect(parseList('   \n\n')).toEqual([]);
    expect(parseList('un solo elemento')).toEqual(['un solo elemento']);
    // Un texto que empieza por corchete pero no es JSON se trata por líneas, sin perder nada.
    expect(parseList('[borrador] capítulo 1\n[borrador] capítulo 2')).toEqual(['[borrador] capítulo 1', '[borrador] capítulo 2']);
    // Un guion pegado a la palabra o un número con decimales no son viñetas.
    expect(parseList('-5 grados\n3.14 es pi')).toEqual(['-5 grados', '3.14 es pi']);
  });
});

describe('nodo «para cada»', () => {
  it('ejecuta el agente una vez por elemento, respeta la concurrencia y conserva el orden de la lista', async () => {
    const llm = new ScriptedLlm(async (req) => {
      const text = userText(req);
      if (text.startsWith('lista')) return { content: '["alfa", "beta", "gamma", "delta", "épsilon"]' };
      // El primer elemento es el más lento: si el resultado dependiera del orden de llegada, saldría el último.
      await delay(text.includes('alfa') ? 80 : 20);
      return { content: `R(${text})` };
    });
    ctx = makeContext(llm);
    const a = addAgent(ctx);
    const run = await runWorkflow(
      ctx,
      workflow(
        [
          node('entrada', 'input'),
          node('lista', 'agent', { agentId: a.id, prompt: 'lista de {{input}}' }),
          node('cada', 'foreach', { agentId: a.id, items: '{{lista}}', prompt: '{{index}}/{{total}} {{item}} ({{input}})', concurrency: 2 }),
          node('salida', 'output', { template: '{{cada}}' }),
        ],
        edges('entrada>lista', 'lista>cada', 'cada>salida'),
      ),
      'letras',
    );
    expect(run.status).toBe('completed');
    expect(llm.maxInFlight).toBe(2);
    expect(llm.calls).toHaveLength(6);
    expect(run.output).toBe(
      ['alfa', 'beta', 'gamma', 'delta', 'épsilon'].map((item, i) => `### ${i + 1}. ${item}\n\nR(${i + 1}/5 ${item} (letras))`).join('\n\n'),
    );
    const step = run.steps.find((s) => s.nodeId === 'cada')!;
    expect(JSON.parse(step.input!)).toEqual(['alfa', 'beta', 'gamma', 'delta', 'épsilon']);
    expect(step.usage.llmCalls).toBe(5);
    expect(step.agentId).toBe(a.id);

    const events = itemEvents(run.id);
    expect(events.filter((e) => e.data.status === 'started').map((e) => e.data.index).sort()).toEqual([0, 1, 2, 3, 4]);
    expect(events.filter((e) => e.data.status === 'completed')).toHaveLength(5);
    expect(events[0].data).toMatchObject({ index: 0, total: 5, item: 'alfa', status: 'started' });
    // La actividad de cada elemento va anidada un nivel y etiquetada con su índice.
    const messages = ctx.store.listEvents(run.id).filter((e) => e.type === 'llm.message' && e.nodeId === 'cada');
    expect(messages.every((e) => e.data.depth === 1)).toBe(true);
    expect(messages.map((e) => e.data.item).sort()).toEqual([0, 1, 2, 3, 4]);
  });

  it('con concurrencia 1 procesa los elementos de uno en uno y en orden', async () => {
    const llm = new ScriptedLlm(async (req) => {
      await delay(5);
      return { content: userText(req).toUpperCase() };
    });
    ctx = makeContext(llm);
    const a = addAgent(ctx);
    const run = await runWorkflow(
      ctx,
      workflow([node('entrada', 'input'), node('cada', 'foreach', { agentId: a.id, items: '{{input}}', prompt: '{{item}}', concurrency: 1, format: 'json' })], edges('entrada>cada')),
      '- uno\n- dos\n- tres',
    );
    expect(llm.maxInFlight).toBe(1);
    expect(llm.calls.map(userText)).toEqual(['uno', 'dos', 'tres']);
    // Formato JSON: un array con los resultados, listo para otro nodo o herramienta.
    expect(JSON.parse(run.output!)).toEqual(['UNO', 'DOS', 'TRES']);
  });

  it('una lista vacía termina sin llamar al modelo', async () => {
    const llm = new ScriptedLlm(() => ({ content: 'no debería llamarse' }));
    ctx = makeContext(llm);
    const a = addAgent(ctx);
    const run = await runWorkflow(
      ctx,
      workflow(
        [node('entrada', 'input'), node('cada', 'foreach', { agentId: a.id, items: '[]', prompt: '{{item}}', format: 'json' }), node('salida', 'output', { template: 'Resultados: {{cada}}' })],
        edges('entrada>cada', 'cada>salida'),
      ),
    );
    expect(run).toMatchObject({ status: 'completed', output: 'Resultados: []' });
    expect(llm.calls).toHaveLength(0);
  });

  it('falla sin procesar nada si la lista supera el máximo del nodo', async () => {
    const llm = new ScriptedLlm(() => ({ content: 'x' }));
    ctx = makeContext(llm);
    const a = addAgent(ctx);
    const run = await runWorkflow(
      ctx,
      workflow([node('entrada', 'input'), node('cada', 'foreach', { agentId: a.id, items: '{{input}}', prompt: '{{item}}', maxItems: 3 })], edges('entrada>cada')),
      'a\nb\nc\nd',
    );
    expect(run.status).toBe('failed');
    expect(run.error).toContain('recibió 4 elementos y su máximo es 3');
    expect(llm.calls).toHaveLength(0);
    // La lista que llegó queda registrada para poder diagnosticar el problema.
    expect(JSON.parse(run.steps.find((s) => s.nodeId === 'cada')!.input!)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('si un elemento falla definitivamente se detienen los demás y el error dice cuál fue', async () => {
    const started: string[] = [];
    const llm = new ScriptedLlm(async (req) => {
      const text = userText(req);
      started.push(text);
      if (text === 'malo') throw new LlmError('modelo no encontrado', { retryable: false, status: 404 });
      await sleep(2000, req.signal);
      return { content: 'ok' };
    });
    ctx = makeContext(llm);
    const a = addAgent(ctx);
    const t0 = Date.now();
    const run = await runWorkflow(
      ctx,
      workflow(
        [node('entrada', 'input'), node('cada', 'foreach', { agentId: a.id, items: '{{input}}', prompt: '{{item}}', concurrency: 2 }), node('salida', 'output', { template: '{{cada}}' })],
        edges('entrada>cada', 'cada>salida'),
      ),
      'lento\nmalo\nnunca-1\nnunca-2',
    );
    expect(Date.now() - t0).toBeLessThan(1500); // el elemento lento se abortó, no se esperó a que terminara
    expect(run.status).toBe('failed');
    expect(run.error).toContain('Elemento 2 de 4 («malo»): modelo no encontrado');
    expect(stepStatus(run)).toEqual({ entrada: 'completed', cada: 'failed', salida: 'cancelled' });
    expect(started.sort()).toEqual(['lento', 'malo']);
    expect(itemEvents(run.id).filter((e) => e.data.status === 'failed').map((e) => e.data.index)).toEqual([1]);
  });

  it('reintenta por elemento los errores pasajeros, sin repetir los que ya terminaron', async () => {
    const attempts = new Map<string, number>();
    const llm = new ScriptedLlm((req) => {
      const text = userText(req);
      const n = (attempts.get(text) ?? 0) + 1;
      attempts.set(text, n);
      if (text === 'inestable' && n < 3) throw new LlmError('503 saturado', { retryable: true, status: 503 });
      return { content: `ok(${text})` };
    });
    ctx = makeContext(llm);
    const a = addAgent(ctx);
    const run = await runWorkflow(
      ctx,
      workflow([node('entrada', 'input'), node('cada', 'foreach', { agentId: a.id, items: '{{input}}', prompt: '{{item}}', concurrency: 1, retries: 2, format: 'json' })], edges('entrada>cada')),
      'estable\ninestable\nfinal',
    );
    expect(run.status).toBe('completed');
    expect(JSON.parse(run.output!)).toEqual(['ok(estable)', 'ok(inestable)', 'ok(final)']);
    expect(Object.fromEntries(attempts)).toEqual({ estable: 1, inestable: 3, final: 1 });
    const retries = itemEvents(run.id).filter((e) => e.data.status === 'retry');
    expect(retries.map((e) => [e.data.index, e.data.attempt])).toEqual([[1, 1], [1, 2]]);
  });

  it('se agotan los reintentos de un elemento: el nodo falla', async () => {
    const llm = new ScriptedLlm(() => {
      throw new LlmError('sigue caído', { retryable: true });
    });
    ctx = makeContext(llm);
    const a = addAgent(ctx);
    const run = await runWorkflow(
      ctx,
      workflow([node('entrada', 'input'), node('cada', 'foreach', { agentId: a.id, items: '{{input}}', prompt: '{{item}}', retries: 1 })], edges('entrada>cada')),
      'único',
    );
    expect(run.status).toBe('failed');
    expect(llm.calls).toHaveLength(2);
    expect(run.error).toContain('Elemento 1 de 1');
  });

  it('se puede cancelar a mitad de la iteración: no arrancan más elementos', async () => {
    const llm = new ScriptedLlm(async (req) => {
      await sleep(5000, req.signal);
      return { content: 'x' };
    });
    ctx = makeContext(llm);
    const a = addAgent(ctx);
    const wf = ctx.store.createWorkflow(
      workflow([node('entrada', 'input'), node('cada', 'foreach', { agentId: a.id, items: '{{input}}', prompt: '{{item}}', concurrency: 2 })], edges('entrada>cada')),
    );
    const run = ctx.runs.startWorkflowRun(wf, 'a\nb\nc\nd\ne');
    for (let i = 0; i < 100 && llm.calls.length < 2; i++) await delay(10);
    expect(ctx.runs.cancel(run.id)).toBe(true);
    await ctx.runs.waitFor(run.id);
    const done = ctx.store.getRun(run.id)!;
    expect(done.status).toBe('cancelled');
    expect(stepStatus(done)).toEqual({ entrada: 'completed', cada: 'cancelled' });
    expect(llm.calls).toHaveLength(2);
  });

  it('comparte con el resto del workflow el límite de llamadas al modelo', async () => {
    const llm = new ScriptedLlm(() => ({ content: 'ok' }));
    ctx = makeContext(llm);
    const a = addAgent(ctx);
    const run = await runWorkflow(
      ctx,
      workflow([node('entrada', 'input'), node('cada', 'foreach', { agentId: a.id, items: '{{input}}', prompt: '{{item}}', concurrency: 1 })], edges('entrada>cada'), { maxLlmCalls: 3 }),
      'a\nb\nc\nd\ne',
    );
    expect(run.status).toBe('failed');
    expect(llm.calls).toHaveLength(3);
    expect(run.error).toMatch(/Elemento 4 de 5/);
  });

  it('cada elemento puede usar herramientas, y sus llamadas no se mezclan entre elementos en paralelo', async () => {
    const llm = new ScriptedLlm(async (req) => {
      const last = req.messages[req.messages.length - 1];
      if (last.role === 'tool') return { content: `resultado: ${JSON.parse(last.content).result}` };
      await delay(10);
      // Todos los elementos usan el mismo id de llamada, como hace Ollama (call_1) en peticiones distintas.
      return { toolCalls: [{ id: 'call_1', name: 'calculator', arguments: { expression: `${userText(req)} * 10` } }] };
    });
    ctx = makeContext(llm);
    const a = addAgent(ctx, { tools: ['calculator'] });
    const run = await runWorkflow(
      ctx,
      workflow([node('entrada', 'input'), node('cada', 'foreach', { agentId: a.id, items: '{{input}}', prompt: '{{item}}', concurrency: 3, format: 'json' })], edges('entrada>cada')),
      '1\n2\n3',
    );
    expect(JSON.parse(run.output!)).toEqual(['resultado: 10', 'resultado: 20', 'resultado: 30']);
    const events = ctx.store.listEvents(run.id);
    const calls = events.filter((e) => e.type === 'tool.call');
    expect(calls.map((e) => e.data.id).sort()).toEqual(['0:call_1', '1:call_1', '2:call_1']);
    // Cada resultado se empareja con su propia llamada.
    const byId = (type: string) => new Map(events.filter((e: RunEvent) => e.type === type).map((e) => [e.data.id, e.data]));
    for (const [id, call] of byId('tool.call')) {
      const result = byId('tool.result').get(id)!;
      expect(JSON.parse(result.result).expression).toBe(call.arguments.expression);
    }
    expect(run.usage.toolCalls).toBe(3);
  });

  it('reintentar desde el fallo reutiliza el resultado completo de un «para cada» que terminó bien', async () => {
    let failAfter = true;
    const llm = new ScriptedLlm((req) => {
      const text = userText(req);
      if (text.startsWith('resumen') && failAfter) throw new LlmError('caída', { retryable: false });
      return { content: `(${text})` };
    });
    ctx = makeContext(llm);
    const a = addAgent(ctx);
    const def = workflow(
      [
        node('entrada', 'input'),
        node('cada', 'foreach', { agentId: a.id, items: '{{input}}', prompt: '{{item}}', format: 'json' }),
        node('resumen', 'agent', { agentId: a.id, prompt: 'resumen de {{cada}}' }),
      ],
      edges('entrada>cada', 'cada>resumen'),
    );
    const first = await runWorkflow(ctx, def, 'x\ny');
    expect(first.status).toBe('failed');
    failAfter = false;
    const before = llm.calls.length;
    const retry = ctx.runs.retryRun(first, 'failed');
    await ctx.runs.waitFor(retry.id);
    expect(ctx.store.getRun(retry.id)!.status).toBe('completed');
    expect(llm.calls.slice(before).map(userText)).toEqual([`resumen de ${JSON.stringify(['(x)', '(y)'], null, 2)}`]);
  });
});

describe('validación del nodo «para cada»', () => {
  const check = (config: Record<string, unknown>, extra: ReturnType<typeof node>[] = [], connected = true) =>
    validateWorkflow(
      { nodes: [node('entrada', 'input'), node('cada', 'foreach', config), ...extra], edges: connected ? edges('entrada>cada') : [] },
      { agentIds: ['agt'], toolNames: [] },
    ).map((i) => `${i.level}: ${i.message}`);

  it('acepta una configuración correcta', () => {
    expect(check({ agentId: 'agt', items: '{{upstream}}', prompt: 'Traduce {{item}} ({{index}} de {{total}})', concurrency: 3, maxItems: 50 })).toEqual([]);
  });

  it('exige agente y tarea, y avisa si la tarea no usa {{item}}', () => {
    expect(check({ agentId: '', items: '{{upstream}}', prompt: '' })).toEqual([
      'error: El nodo "cada" no tiene agente asignado.',
      'error: El nodo "cada" no tiene la tarea que se aplica a cada elemento.',
    ]);
    expect(check({ agentId: 'borrado', items: '{{upstream}}', prompt: 'x' })).toEqual([
      'error: El nodo "cada" usa un agente que ya no existe.',
      'warning: La tarea de "cada" no usa {{item}}: todos los elementos recibirán exactamente la misma tarea.',
    ]);
  });

  it('valida los límites, el origen de la lista y el uso de {{item}} fuera de su sitio', () => {
    expect(check({ agentId: 'agt', items: '{{upstream}}', prompt: '{{item}}', concurrency: 9, maxItems: 0 })).toEqual([
      'error: La concurrencia de "cada" debe estar entre 1 y 8.',
      'error: El máximo de elementos de "cada" debe estar entre 1 y 100.',
    ]);
    expect(check({ agentId: 'agt', items: '', prompt: '{{item}}' }, [], false)).toContain('error: El nodo "cada" no tiene de dónde sacar la lista: conéctalo o indica una plantilla.');
    expect(check({ agentId: 'agt', items: '{{item}}', prompt: '{{item}}' })).toContain(
      'error: La lista de "cada" no puede usar {{item}}, {{index}} ni {{total}}: solo existen dentro de la tarea.',
    );
    const outside = validateWorkflow(
      { nodes: [node('entrada', 'input'), node('t', 'transform', { template: 'elemento {{item}}' })], edges: edges('entrada>t') },
      { agentIds: [], toolNames: [] },
    );
    expect(outside.map((i) => i.message)).toContain('"t" usa {{item}}, que solo existe dentro de un nodo «para cada».');
  });
});
