import type { Run, RunEvent, RunEventType } from '@shared/types';
import { describe, expect, it } from 'vitest';
import { elapsedMs, formatBytes, formatDuration, initials, plural } from './format';
import { applyEvent, blankFromRun, buildActivity, fromRun, totalUsage } from './run-state';

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
  it('reconstruye el estado completo a partir de los eventos', () => {
    seq = 0;
    const state = blankFromRun(makeRun());
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
    expect(state.events).toHaveLength(5); // los deltas transitorios no se guardan
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
    const state = blankFromRun(makeRun());
    const started = ev('run.started', null);
    const stepStart = ev('step.started', 'ag', { attempt: 1 });
    [started, stepStart, started, stepStart].forEach((e) => applyEvent(state, e));
    expect(state.events).toHaveLength(2);
  });

  it('los eventos de sub-agentes (delegación) no pisan el texto del agente principal', () => {
    seq = 0;
    const state = blankFromRun(makeRun());
    applyEvent(state, ev('step.started', 'ag', { attempt: 1 }));
    applyEvent(state, ev('llm.delta', 'ag', { text: 'principal' }, true));
    applyEvent(state, ev('llm.delta', 'ag', { text: 'SUB', depth: 1 }, true));
    applyEvent(state, ev('llm.message', 'ag', { content: 'sub', depth: 1, toolCalls: [], usage: { promptTokens: 1, completionTokens: 1 } }));
    expect(state.steps.ag.streamText).toBe('principal');
    expect(state.steps.ag.usage.llmCalls).toBe(1); // pero su consumo sí cuenta
  });

  it('refleja reintentos, pasos omitidos y un texto parcial al conectarse a mitad', () => {
    seq = 0;
    const state = blankFromRun(makeRun());
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
    const state = fromRun(run, []);
    expect(state).toMatchObject({ status: 'failed', error: 'boom', order: ['in', 'ag'] });
    expect(totalUsage(state).llmCalls).toBe(3);
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
