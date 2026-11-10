import { describe, expect, it } from 'vitest';
import { describeSchedule, exportFileName, splitInterval, toMinutes } from './transfer';

describe('exportación', () => {
  it('genera nombres de archivo seguros a partir del nombre del workflow', () => {
    expect(exportFileName('Informe de investigación multiagente')).toBe('informe-de-investigacion-multiagente.agentforge.json');
    expect(exportFileName('  ¿Qué/tal?: <ñandú> ')).toBe('que-tal-nandu.agentforge.json');
    expect(exportFileName('***')).toBe('workflow.agentforge.json');
    expect(exportFileName('x'.repeat(200))).toBe(`${'x'.repeat(60)}.agentforge.json`);
  });
});

describe('programación en lenguaje natural', () => {
  it('describe intervalos con la unidad más cómoda', () => {
    const every = (intervalMinutes: number) => describeSchedule({ kind: 'interval', intervalMinutes, time: null });
    expect(every(1)).toBe('cada minuto');
    expect(every(15)).toBe('cada 15 min');
    expect(every(60)).toBe('cada hora');
    expect(every(90)).toBe('cada 90 min');
    expect(every(120)).toBe('cada 2 h');
    expect(every(1440)).toBe('cada día');
    expect(every(4320)).toBe('cada 3 días');
  });

  it('describe la programación diaria con su hora', () => {
    expect(describeSchedule({ kind: 'daily', intervalMinutes: null, time: '07:45' })).toBe('cada día a las 07:45');
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
