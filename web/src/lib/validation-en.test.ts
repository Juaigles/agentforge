import { validateWorkflow } from '@shared/graph';
import type { WorkflowEdge, WorkflowNode } from '@shared/types';
import { VALIDATION_MESSAGES, type ValidationCode } from '@shared/validation-messages';
import { describe, expect, it } from 'vitest';
import { setLocale } from '@/i18n';
import { issueText, VALIDATION_EN } from './validation-en';

const SAMPLE = { name: 'NOMBRE', id: 'IDENT', ref: 'REFER', tool: 'TOOLX', type: 'TIPOX', workflow: 'WFLOW', max: 987 };
const codes = Object.keys(VALIDATION_MESSAGES) as ValidationCode[];

describe('validación en inglés', () => {
  it('tiene los mismos códigos que la tabla en español', () => {
    expect(Object.keys(VALIDATION_EN).sort()).toEqual([...codes].sort());
  });

  it('cada mensaje usa los mismos parámetros que el español y no deja ninguno sin rellenar', () => {
    const problems: string[] = [];
    for (const code of codes) {
      const es = VALIDATION_MESSAGES[code](SAMPLE);
      const en = VALIDATION_EN[code](SAMPLE);
      if (en.includes('undefined')) problems.push(`${code}: parámetro sin rellenar`);
      for (const value of Object.values(SAMPLE).map(String)) {
        if (es.includes(value) !== en.includes(value)) problems.push(`${code}: «${value}» ${es.includes(value) ? 'falta en inglés' : 'sobra en inglés'}`);
      }
      // Las referencias literales ({{item}}, {{upstream}}…) se conservan.
      const literal = (text: string) => (text.match(/\{\{[a-z]+\}\}/g) ?? []).sort().join();
      if (literal(es) !== literal(en)) problems.push(`${code}: referencias ${literal(es)} ≠ ${literal(en)}`);
    }
    expect(problems).toEqual([]);
  });

  it('`issueText` da el texto del servidor en español y el traducido en inglés', () => {
    const nodes = [
      { id: 'entrada', type: 'input', label: 'Entrada', position: { x: 0, y: 0 }, config: {} },
      { id: 'paso', type: 'agent', label: 'Resumir', position: { x: 0, y: 0 }, config: { agentId: 'no-existe', prompt: '{{otro}}' } },
      { id: 'salida', type: 'output', label: 'Salida', position: { x: 0, y: 0 }, config: { template: '{{paso}}' } },
    ] as unknown as WorkflowNode[];
    const edges = [{ id: 'e1', source: 'entrada', target: 'paso' }] as WorkflowEdge[];
    const issues = validateWorkflow({ nodes, edges }, { agentIds: [], toolNames: [] });
    expect(issues.every((i) => i.code && i.params)).toBe(true);
    try {
      setLocale('es', false);
      expect(issues.map(issueText)).toEqual(issues.map((i) => i.message));
      expect(issues.map(issueText)).toContain('El nodo "Resumir" usa un agente que ya no existe.');
      setLocale('en', false);
      const english = issues.map(issueText);
      expect(english).toContain('Node "Resumir" uses an agent that no longer exists.');
      expect(english).toContain('"Resumir" references a node that does not exist: {{otro}}.');
      expect(english).toContain('Output node "Salida" needs an incoming connection.');
      // Un problema sin código (p. ej. de una versión anterior del servidor) se muestra tal cual.
      expect(issueText({ message: 'Texto del servidor' })).toBe('Texto del servidor');
    } finally {
      setLocale('es', false);
    }
  });
});
