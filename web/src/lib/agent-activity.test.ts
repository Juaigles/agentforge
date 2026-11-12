import { ZERO_USAGE, type StepStatus } from '@shared/types';
import { describe, expect, it } from 'vitest';
import { hasOpenTool, stepActivity } from './agent-activity';
import { emptyActivity, type StepLive } from './run-state';

const step = (status: StepStatus, extra: Partial<StepLive> = {}): StepLive =>
  ({
    nodeId: 'n',
    status,
    attempt: 1,
    startedAt: null,
    finishedAt: null,
    output: null,
    partialOutput: null,
    error: null,
    errorI18n: null,
    usage: { ...ZERO_USAGE },
    streamText: '',
    thinkingText: '',
    ...extra,
  }) as StepLive;

describe('stepActivity', () => {
  it('sin paso, el orbe se queda quieto', () => {
    expect(stepActivity(undefined, false)).toBeUndefined();
  });

  it('en curso: herramienta antes que escritura, y escritura antes que pensar', () => {
    expect(stepActivity(step('running'), false)).toBe('thinking');
    expect(stepActivity(step('running', { thinkingText: 'hmm' }), false)).toBe('thinking');
    expect(stepActivity(step('running', { streamText: 'Hola' }), false)).toBe('writing');
    expect(stepActivity(step('running', { streamText: 'Hola' }), true)).toBe('tool');
  });

  it('estados finales y de espera', () => {
    expect(stepActivity(step('waiting'), false)).toBe('waiting');
    expect(stepActivity(step('completed'), false)).toBe('done');
    expect(stepActivity(step('failed'), false)).toBe('error');
    for (const s of ['pending', 'skipped', 'cancelled'] as const) expect(stepActivity(step(s), false)).toBeUndefined();
  });
});

describe('hasOpenTool', () => {
  it('solo cuenta las llamadas abiertas del nodo pedido', () => {
    const log = emptyActivity();
    log.openTools['otro|1|0'] = {} as never;
    expect(hasOpenTool(log, 'n')).toBe(false);
    log.openTools['n|2|1'] = {} as never;
    expect(hasOpenTool(log, 'n')).toBe(true);
  });
});
