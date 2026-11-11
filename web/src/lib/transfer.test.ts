import { describe, expect, it } from 'vitest';
import type { Trigger } from '@shared/types';
import { describeTrigger, describeWeekdays, exportFileName, splitInterval, summarizeTriggers, toMinutes } from './transfer';

const trigger = (patch: Partial<Trigger>): Trigger => ({
  id: 'trg_1',
  workflowId: 'wf_1',
  kind: 'interval',
  name: '',
  intervalMinutes: null,
  time: null,
  weekdays: [],
  cron: null,
  timezone: null,
  input: '',
  enabled: true,
  nextRunAt: null,
  lastRunAt: null,
  lastRunId: null,
  lastError: null,
  createdAt: '',
  updatedAt: '',
  ...patch,
});

describe('exportación', () => {
  it('genera nombres de archivo seguros a partir del nombre del workflow', () => {
    expect(exportFileName('Informe de investigación multiagente')).toBe('informe-de-investigacion-multiagente.agentforge.json');
    expect(exportFileName('  ¿Qué/tal?: <ñandú> ')).toBe('que-tal-nandu.agentforge.json');
    expect(exportFileName('***')).toBe('workflow.agentforge.json');
    expect(exportFileName('x'.repeat(200))).toBe(`${'x'.repeat(60)}.agentforge.json`);
  });
});

describe('disparadores en lenguaje natural', () => {
  it('describe intervalos con la unidad más cómoda', () => {
    const every = (intervalMinutes: number) => describeTrigger(trigger({ kind: 'interval', intervalMinutes }));
    expect(every(1)).toBe('cada minuto');
    expect(every(15)).toBe('cada 15 min');
    expect(every(60)).toBe('cada hora');
    expect(every(90)).toBe('cada 90 min');
    expect(every(120)).toBe('cada 2 h');
    expect(every(1440)).toBe('cada día');
    expect(every(4320)).toBe('cada 3 días');
  });

  it('describe los días y la hora, con la zona si la tiene', () => {
    expect(describeTrigger(trigger({ kind: 'daily', time: '07:45' }))).toBe('cada día a las 07:45');
    expect(describeTrigger(trigger({ kind: 'daily', time: '07:45', weekdays: [1, 2, 3, 4, 5] }))).toBe('de lunes a viernes a las 07:45');
    expect(describeTrigger(trigger({ kind: 'daily', time: '10:00', weekdays: [0, 6], timezone: 'Europe/Madrid' }))).toBe('los fines de semana a las 10:00 (Europe/Madrid)');
    expect(describeWeekdays([5, 1, 3])).toBe('lun, mié y vie');
    expect(describeWeekdays([0])).toBe('los domingo');
    expect(describeWeekdays([0, 1, 2, 3, 4, 5, 6])).toBe('cada día');
  });

  it('describe el cron y el webhook', () => {
    expect(describeTrigger(trigger({ kind: 'cron', cron: '0 */6 * * *', timezone: 'UTC' }))).toBe('según el cron «0 */6 * * *» (UTC)');
    expect(describeTrigger(trigger({ kind: 'webhook' }))).toBe('al recibir un webhook');
  });

  it('resume los disparadores de un workflow en una etiqueta', () => {
    expect(summarizeTriggers([])).toBeNull();
    expect(summarizeTriggers([trigger({ intervalMinutes: 120 })])).toEqual({ text: 'cada 2 h', active: true });
    expect(summarizeTriggers([trigger({ intervalMinutes: 120 }), trigger({ kind: 'webhook' }), trigger({ kind: 'webhook', enabled: false })])).toEqual({ text: '2 disparadores', active: true });
    expect(summarizeTriggers([trigger({ intervalMinutes: 120 }), trigger({ kind: 'webhook', enabled: false })])).toEqual({ text: 'cada 2 h', active: true });
    expect(summarizeTriggers([trigger({ enabled: false })])).toEqual({ text: 'disparador en pausa', active: false });
    expect(summarizeTriggers([trigger({ enabled: false }), trigger({ enabled: false })])).toEqual({ text: 'disparadores en pausa', active: false });
  });

  it('convierte entre minutos y valor + unidad sin perder información', () => {
    expect(splitInterval(45)).toEqual({ value: 45, unit: 'minutes' });
    expect(splitInterval(180)).toEqual({ value: 3, unit: 'hours' });
    expect(splitInterval(90)).toEqual({ value: 90, unit: 'minutes' });
    expect(splitInterval(2880)).toEqual({ value: 2, unit: 'days' });
    for (const minutes of [1, 45, 60, 90, 180, 1440, 2880, 43_200]) {
      const { value, unit } = splitInterval(minutes);
      expect(toMinutes(value, unit)).toBe(minutes);
    }
  });
});
