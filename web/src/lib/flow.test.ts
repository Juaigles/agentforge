import { afterEach, describe, expect, it } from 'vitest';
import { setLocale } from '@/i18n';
import { edgeTexts, toFlowEdge } from './flow';

afterEach(() => setLocale('es', false));

describe('textos de las conexiones', () => {
  it('las ramas se rotulan «Sí»/«No» en español y «Yes»/«No» en inglés, y una conexión normal no lleva etiqueta', () => {
    const yes = { id: 'a', source: 'c', target: 'x', sourceHandle: 'true' };
    const no = { id: 'b', source: 'c', target: 'y', sourceHandle: 'false' };
    const plain = { id: 'c', source: 'x', target: 'y', sourceHandle: null };
    expect([toFlowEdge(yes).label, toFlowEdge(no).label, toFlowEdge(plain).label]).toEqual(['sí', 'no', undefined]);
    setLocale('en', false);
    expect([toFlowEdge(yes).label, toFlowEdge(no).label, toFlowEdge(plain).label]).toEqual(['yes', 'no', undefined]);
  });

  it('se recalculan al cambiar el idioma (etiqueta visible y nombre accesible)', () => {
    const branch = { source: 'cond', target: 'out', sourceHandle: 'true' };
    const es = edgeTexts(branch);
    setLocale('en', false);
    const en = edgeTexts(branch);
    expect(es.label).toBe('sí');
    expect(en.label).toBe('yes');
    expect(en.ariaLabel).not.toBe(es.ariaLabel);
    expect(en.ariaLabel).toContain('yes');
    expect(edgeTexts(branch, 'Condición', 'Salida').ariaLabel).toContain('Condición');
  });
});
