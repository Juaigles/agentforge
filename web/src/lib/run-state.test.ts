import type { Run, RunEvent, RunEventType } from '@shared/types';
import { describe, expect, it } from 'vitest';
import { setLocale } from '@/i18n';
import { elapsedMs, formatBytes, formatDuration, initials, plural } from './format';
import { appendActivity, applyEvent, buildActivity, emptyActivity, fromRun, prependActivity, totalUsage } from './run-state';

const usage = { promptTokens: 0, completionTokens: 0, llmCalls: 0, toolCalls: 0 };

function makeRun(): Run {
  const step = (nodeId: string, nodeType: 'input' | 'agent') => ({
    runId: 'r1',
    nodeId,
    nodeType,
    label: nodeId,
    agentId: null,
    status: 'pending' as const,
    attempt: 0,
    input: null,
    output: null,
    error: null,
    usage: { ...usage },
    startedAt: null,
    finishedAt: null,
  });
  return {
    id: 'r1',
    kind: 'workflow',
    workflowId: 'w',
    agentId: null,
    name: 'wf',
    status: 'running',
    input: 'hola',
    output: null,
    error: null,
    usage: { ...usage },
    retryOf: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    snapshot: {
      workflow: { nodes: [], edges: [], settings: { maxConcurrency: 1, maxDurationMs: 1, maxLlmCalls: 1, onError: 'fail', defaultRetries: 0 } },
      agents: {},
    },
    steps: [step('in', 'input'), step('ag', 'agent')],
    lastSeq: 0,
  };
}

let seq = 0;
const ev = (type: RunEventType, nodeId: string | null, data: Record<string, any> = {}, transient = false): RunEvent => ({
  seq: transient ? null : ++seq,
  runId: 'r1',
  ts: `2026-01-01T00:00:${String(seq).padStart(2, '0')}.000Z`,
  type,
  nodeId,
  data,
});

describe('estado en vivo de una ejecución', () => {
  it('mantiene el estado al día aplicando cada evento', () => {
    seq = 0;
    const state = fromRun(makeRun());
    const events = [
      ev('run.started', null),
      ev('step.started', 'in', { attempt: 1 }),
      ev('step.finished', 'in', { status: 'completed', output: 'hola', usage }),
      ev('step.started', 'ag', { attempt: 1 }),
      ev('llm.start', 'ag', {}),
      ev('llm.delta', 'ag', { text: 'Res' }, true),
      ev('llm.delta', 'ag', { text: 'puesta' }, true),
    ];
    events.forEach((e) => applyEvent(state, e));

    expect(state.status).toBe('running');
    expect(state.steps.in).toMatchObject({ status: 'completed', output: 'hola' });
    expect(state.steps.ag).toMatchObject({ status: 'running', attempt: 1, streamText: 'Respuesta' });
    expect(state.activity.items).toHaveLength(4); // una entrada por evento guardado con entrada propia; los deltas no dejan ninguna
    expect(state.lastSeq).toBe(5);

    applyEvent(state, ev('llm.message', 'ag', { content: 'Respuesta', toolCalls: [{ id: 'c', name: 't' }], usage: { promptTokens: 10, completionTokens: 4 } }));
    applyEvent(state, ev('tool.call', 'ag', { id: 'c', name: 't', arguments: {} }));
    expect(totalUsage(state)).toEqual({ promptTokens: 10, completionTokens: 4, llmCalls: 1, toolCalls: 1 });

    applyEvent(
      state,
      ev('step.finished', 'ag', { status: 'completed', output: 'Final', usage: { promptTokens: 30, completionTokens: 9, llmCalls: 2, toolCalls: 1 } }),
    );
    applyEvent(
      state,
      ev('run.finished', null, { status: 'completed', output: 'Final', usage: { promptTokens: 30, completionTokens: 9, llmCalls: 2, toolCalls: 1 } }),
    );
    expect(state).toMatchObject({ status: 'completed', output: 'Final', error: null });
    expect(state.steps.ag).toMatchObject({ status: 'completed', output: 'Final', streamText: '' });
    expect(totalUsage(state).promptTokens).toBe(30); // prevalece el uso definitivo del servidor
  });

  it('ignora eventos persistidos repetidos (reconexión del SSE)', () => {
    seq = 0;
    const state = fromRun(makeRun());
    const started = ev('run.started', null);
    const stepStart = ev('step.started', 'ag', { attempt: 1 });
    [started, stepStart, started, stepStart].forEach((e) => applyEvent(state, e));
    expect(state.activity.items).toHaveLength(2);
  });

  it('los eventos de sub-agentes (delegación) no pisan el texto del agente principal', () => {
    seq = 0;
    const state = fromRun(makeRun());
    applyEvent(state, ev('step.started', 'ag', { attempt: 1 }));
    applyEvent(state, ev('llm.delta', 'ag', { text: 'principal' }, true));
    applyEvent(state, ev('llm.delta', 'ag', { text: 'SUB', depth: 1 }, true));
    applyEvent(state, ev('llm.message', 'ag', { content: 'sub', depth: 1, toolCalls: [], usage: { promptTokens: 1, completionTokens: 1 } }));
    expect(state.steps.ag.streamText).toBe('principal');
    expect(state.steps.ag.usage.llmCalls).toBe(1); // pero su consumo sí cuenta
  });

  it('refleja reintentos, pasos omitidos y un texto parcial al conectarse a mitad', () => {
    seq = 0;
    const state = fromRun(makeRun());
    applyEvent(state, ev('step.started', 'ag', { attempt: 1 }));
    applyEvent(state, ev('llm.snapshot', 'ag', { text: 'ya iba por aquí' }, true));
    expect(state.steps.ag.streamText).toBe('ya iba por aquí');
    applyEvent(state, ev('step.retry', 'ag', { attempt: 1, error: 'x', delayMs: 10 }));
    applyEvent(state, ev('step.started', 'ag', { attempt: 2 }));
    expect(state.steps.ag).toMatchObject({ attempt: 2, streamText: '', status: 'running' });
    applyEvent(state, ev('step.skipped', 'in', { reason: 'Rama no tomada.' }));
    expect(state.steps.in.status).toBe('skipped');
  });

  it('una ejecución terminada se carga tal cual desde la API', () => {
    const run = { ...makeRun(), status: 'failed' as const, error: 'boom', usage: { ...usage, llmCalls: 3 } };
    const state = fromRun(run);
    expect(state).toMatchObject({ status: 'failed', error: 'boom', order: ['in', 'ag'] });
    expect(totalUsage(state).llmCalls).toBe(3);
  });

  it('una ejecución en curso parte del estado que entrega el servidor y sigue desde su último evento', () => {
    // El servidor ya ha aplicado 40 eventos: un paso terminado y otro en curso con su consumo hasta ahora.
    const run = makeRun();
    run.lastSeq = 40;
    run.startedAt = '2026-01-01T00:00:01.000Z';
    Object.assign(run.steps[0], { status: 'completed', output: 'hola', finishedAt: '2026-01-01T00:00:02.000Z' });
    Object.assign(run.steps[1], { status: 'running', attempt: 2, usage: { promptTokens: 30, completionTokens: 8, llmCalls: 2, toolCalls: 1 } });
    const state = fromRun(run);
    expect(state).toMatchObject({ status: 'running', lastSeq: 40, startedAt: '2026-01-01T00:00:01.000Z' });
    expect(state.steps.in).toMatchObject({ status: 'completed', output: 'hola' });
    expect(state.steps.ag).toMatchObject({ status: 'running', attempt: 2, streamText: '' });
    // El total en curso es la suma de los pasos, no el de la ejecución (que el servidor fija al terminar).
    expect(totalUsage(state)).toEqual({ promptTokens: 30, completionTokens: 8, llmCalls: 2, toolCalls: 1 });

    // Un evento que el estado ya recoge no se vuelve a aplicar; los posteriores, sí.
    seq = 39;
    applyEvent(state, ev('tool.call', 'ag', { id: 'viejo', name: 't', arguments: {} }));
    expect(state.steps.ag.usage.toolCalls).toBe(1);
    applyEvent(state, ev('tool.call', 'ag', { id: 'c9', name: 't', arguments: {} }));
    expect(state.steps.ag.usage.toolCalls).toBe(2);
    expect(state.lastSeq).toBe(41);
    expect(state.activity.items.map((i) => i.key)).toEqual(['e41']);
    expect(state.activity.firstSeq).toBe(41); // quedan eventos anteriores sin cargar
  });
});

describe('registro de actividad', () => {
  it('empareja cada llamada a herramienta con su resultado y filtra por nodo', () => {
    seq = 0;
    const events = [
      ev('run.started', null),
      ev('step.started', 'ag', { attempt: 1, maxAttempts: 2 }),
      ev('llm.message', 'ag', { agent: 'A', content: '', toolCalls: [{ id: 'c1' }], usage: { promptTokens: 5, completionTokens: 2 } }),
      ev('tool.call', 'ag', { id: 'c1', name: 'calculator', arguments: { expression: '1+1' } }),
      ev('tool.result', 'ag', { id: 'c1', name: 'calculator', ok: true, result: '2', durationMs: 3 }),
      ev('tool.call', 'ag', { id: 'c2', name: 'web_fetch', arguments: {} }),
      ev('step.retry', 'ag', { attempt: 1, error: 'caída', delayMs: 100 }),
      ev('step.started', 'ag', { attempt: 2, maxAttempts: 2 }),
      ev('step.finished', 'ag', { status: 'failed', error: 'sin red' }),
      ev('run.finished', null, { status: 'failed', error: 'sin red' }),
    ];
    const all = buildActivity(events);
    const tools = all.filter((i) => i.kind === 'tool');
    expect(tools).toMatchObject([
      { name: 'calculator', pending: false, ok: true, result: '2', durationMs: 3 },
      { name: 'web_fetch', pending: true },
    ]);
    expect(all.find((i) => i.kind === 'message')).toMatchObject({ agent: 'A', tokens: 7, toolCount: 1 });
    expect(all.filter((i) => i.kind === 'marker').map((i) => i.kind === 'marker' && i.text)).toEqual([
      'Ejecución iniciada',
      'Paso iniciado',
      'Error en el intento 1; se reintenta en 100 ms',
      'Intento 2 de 2',
      'Paso fallido',
      'Ejecución fallida',
    ]);
    expect(buildActivity(events, 'ag').some((i) => i.kind === 'marker' && i.text.startsWith('Ejecución'))).toBe(false);
  });
});

describe('registro de actividad incremental y por páginas', () => {
  /** 12 eventos: tres llamadas a herramientas cuyos resultados caen en páginas distintas a las de sus llamadas. */
  function history(): RunEvent[] {
    seq = 0;
    return [
      ev('run.started', null),
      ev('step.started', 'ag', { attempt: 1 }),
      ev('tool.call', 'ag', { id: 'c1', name: 'uno', arguments: {} }),
      ev('tool.call', 'ag', { id: 'c2', name: 'dos', arguments: {} }),
      ev('tool.result', 'ag', { id: 'c1', ok: true, result: 'r1', durationMs: 1 }),
      ev('llm.message', 'ag', { agent: 'A', content: 'sigo' }),
      ev('tool.result', 'ag', { id: 'c2', ok: false, result: 'r2', durationMs: 2 }),
      ev('tool.call', 'in', { id: 'c3', name: 'tres', arguments: {} }),
      ev('step.finished', 'ag', { status: 'completed' }),
      ev('tool.result', 'in', { id: 'c3', ok: true, result: 'r3', durationMs: 3 }),
      ev('tool.call', 'in', { id: 'c4', name: 'cuatro', arguments: {} }),
      ev('run.finished', null, { status: 'completed' }),
    ];
  }

  it('añadir evento a evento da el mismo registro que construirlo entero', () => {
    const events = history();
    const log = emptyActivity();
    log.firstSeq = 1;
    events.forEach((e) => appendActivity(log, e));
    expect(log.items).toEqual(buildActivity(events));
    expect(log.counts).toEqual({ ag: 5, in: 2 });
    // Solo queda abierta la llamada sin resultado.
    expect(Object.keys(log.openTools)).toEqual(['in|c4|0']);
  });

  it('cada evento nuevo solo añade su entrada: las anteriores no se vuelven a crear', () => {
    const events = history();
    const log = emptyActivity();
    events.slice(0, 6).forEach((e) => appendActivity(log, e));
    const before = [...log.items];
    events.slice(6).forEach((e) => appendActivity(log, e));
    // Mismos objetos, en el mismo sitio; el resultado tardío completó la entrada que ya estaba.
    before.forEach((item, i) => expect(log.items[i]).toBe(item));
    expect(before[3]).toMatchObject({ kind: 'tool', name: 'dos', pending: false, ok: false, result: 'r2' });
  });

  it.each([1, 2, 3, 5, 12])('cargado hacia atrás en páginas de %i eventos queda igual que entero', (size) => {
    const events = history();
    const whole = buildActivity(events);
    // Se abre con la ejecución en curso: los tres últimos eventos llegan en vivo y lo anterior, por páginas hacia atrás.
    const log = emptyActivity();
    const live = events.slice(9);
    const stored = events.slice(0, 9);
    const pages: RunEvent[][] = [];
    for (let end = stored.length; end > 0; end -= size) pages.push(stored.slice(Math.max(0, end - size), end));
    prependActivity(log, pages[0]);
    live.forEach((e) => appendActivity(log, e));
    pages.slice(1).forEach((page) => prependActivity(log, page));

    expect(log.items).toEqual(whole);
    expect(log.firstSeq).toBe(1);
    expect(log.counts).toEqual({ ag: 5, in: 2 });
    expect(Object.keys(log.openTools)).toEqual(['in|c4|0']);
    expect(log.orphanResults).toEqual({});
  });

  it('mientras falta la página de su llamada, un resultado queda a la espera y se empareja al cargarla', () => {
    const events = history();
    const log = emptyActivity();
    prependActivity(log, events.slice(6)); // empieza en el resultado de c2, cuya llamada es anterior
    expect(log.firstSeq).toBe(7);
    expect(Object.keys(log.orphanResults)).toEqual(['ag|c2|0']);
    expect(log.items.some((i) => i.kind === 'tool' && i.name === 'dos')).toBe(false);

    prependActivity(log, events.slice(2, 6));
    expect(log.items.find((i) => i.kind === 'tool' && i.name === 'dos')).toMatchObject({ pending: false, ok: false, result: 'r2' });
    expect(log.orphanResults).toEqual({});
    // Una página repetida o solapada no duplica nada.
    const count = log.items.length;
    prependActivity(log, events.slice(2, 8));
    expect(log.items).toHaveLength(count);
  });
});

describe('formato', () => {
  it('formatea duraciones, tamaños y plurales en español', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(850)).toBe('850 ms');
    expect(formatDuration(1900)).toBe('1,9 s');
    expect(formatDuration(42_000)).toBe('42 s');
    expect(formatDuration(125_000)).toBe('2 min 5 s');
    expect(formatDuration(3_780_000)).toBe('1 h 3 min');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(3_389_983_735)).toBe('3,2 GB');
    expect(plural(1, 'paso', 'pasos')).toBe('1 paso');
    expect(plural(2, 'paso', 'pasos')).toBe('2 pasos');
    expect(initials('Analista de riesgos')).toBe('AD');
    expect(initials('')).toBe('?');
    expect(elapsedMs('2026-01-01T00:00:00Z', '2026-01-01T00:00:02Z')).toBe(2000);
    expect(elapsedMs(null, null)).toBeNull();
  });
});

describe('motivo de fallo con código', () => {
  const cause = { code: 'agentNoModel', params: { name: 'Redactor' } };
  const failed = { code: 'runNodeFailed', params: { name: 'ag', cause: { ...cause, message: 'El agente «Redactor» no tiene modelo configurado.' } } };

  it('el estado conserva el texto del servidor y su referencia: la de la API al cargar y la de cada evento después', () => {
    const run = makeRun();
    const loaded = fromRun({ ...run, status: 'failed', error: 'El nodo "ag" falló: …', errorI18n: failed });
    expect(loaded).toMatchObject({ error: 'El nodo "ag" falló: …', errorI18n: failed });
    expect(fromRun(run).errorI18n).toBeNull(); // una ejecución sin referencia (anterior a la 1.0, o sin error)

    const live = fromRun(run);
    applyEvent(live, ev('step.finished', 'ag', { status: 'failed', error: 'El agente «Redactor» no tiene modelo configurado.', errorI18n: cause }));
    expect(live.steps.ag).toMatchObject({ status: 'failed', errorI18n: cause });
    applyEvent(live, ev('run.finished', null, { status: 'failed', error: 'El nodo "ag" falló: …', errorI18n: failed }));
    expect(live.errorI18n).toEqual(failed);
    // Al reintentar el paso, el error y su referencia se borran juntos.
    applyEvent(live, ev('step.started', 'ag', { attempt: 2, maxAttempts: 2 }));
    expect(live.steps.ag).toMatchObject({ error: null, errorI18n: null });
  });

  it('el registro de actividad escribe el detalle en el idioma de la interfaz (y tal cual si no trae referencia)', () => {
    const events = [
      ev('step.retry', 'ag', {
        attempt: 1,
        delayMs: 5,
        error: 'El nodo superó su tiempo máximo (40 ms).',
        errorI18n: { code: 'nodeTimeout', params: { ms: 40 } },
      }),
      ev('step.skipped', 'in', { reason: 'Rama no tomada.', reasonI18n: { code: 'skipBranchNotTaken' } }),
      ev('tool.call', 'ag', { id: 't1', name: 'calculator', arguments: {} }),
      ev('tool.result', 'ag', { id: 't1', name: 'calculator', ok: false, result: 'Error: División entre cero.', errorI18n: { code: 'calcDivisionByZero' } }),
      ev('foreach.item', 'ag', { index: 0, total: 2, item: 'a', status: 'failed', error: 'respuesta del proveedor' }),
      ev('step.finished', 'ag', { status: 'failed', error: 'El agente «Redactor» no tiene modelo configurado.', errorI18n: cause }),
    ];
    const details = () => buildActivity(events).map((item) => (item.kind === 'marker' ? item.detail : item.kind === 'tool' ? item.result : undefined));
    expect(details()).toEqual([
      'El nodo superó su tiempo máximo (40 ms).',
      'Rama no tomada.',
      'Error: División entre cero.',
      'respuesta del proveedor',
      'El agente «Redactor» no tiene modelo configurado.',
    ]);
    setLocale('en', false);
    try {
      expect(details()).toEqual([
        'The node exceeded its time limit (40 ms).',
        'Branch not taken.',
        'Error: Division by zero.',
        'respuesta del proveedor',
        'Agent "Redactor" has no model configured.',
      ]);
    } finally {
      setLocale('es', false);
    }
  });
});
