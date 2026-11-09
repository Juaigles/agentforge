import { describe, expect, it } from 'vitest';
import { ancestorsOf, slugifyNodeId, topologicalOrder, validateWorkflow } from '../../shared/graph';
import { extractRefs, refNodeId, renderTemplate } from '../../shared/template';
import { edges, node } from './helpers';

describe('plantillas', () => {
  it('extrae referencias sin duplicados y tolera espacios', () => {
    expect(extractRefs('Hola {{ input }} y {{a}} y {{a.output}} y {{a}}')).toEqual(['input', 'a', 'a.output']);
  });

  it('distingue referencias integradas de referencias a nodos', () => {
    expect(refNodeId('input')).toBeNull();
    expect(refNodeId('upstream')).toBeNull();
    expect(refNodeId('paso_1')).toBe('paso_1');
    expect(refNodeId('paso_1.output')).toBe('paso_1');
  });

  it('sustituye valores y deja vacías las referencias desconocidas', () => {
    const out = renderTemplate('A={{a}} B={{b}} literal={ {x} }', (ref) => (ref === 'a' ? 'uno' : undefined));
    expect(out).toBe('A=uno B= literal={ {x} }');
  });

  it('no reinterpreta llaves que aparezcan dentro de un valor sustituido', () => {
    expect(renderTemplate('{{a}}', () => '{{input}}')).toBe('{{input}}');
  });
});

describe('grafo', () => {
  const nodes = [node('a', 'input'), node('b', 'transform'), node('c', 'transform'), node('d', 'output')];

  it('ordena topológicamente respetando dependencias', () => {
    const order = topologicalOrder(nodes, edges('a>b', 'a>c', 'b>d', 'c>d'))!;
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('b'));
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('d'));
    expect(order.indexOf('c')).toBeLessThan(order.indexOf('d'));
  });

  it('detecta ciclos', () => {
    expect(topologicalOrder(nodes, edges('a>b', 'b>c', 'c>b'))).toBeNull();
  });

  it('calcula ancestros transitivos', () => {
    expect([...ancestorsOf('d', edges('a>b', 'b>d', 'c>d'))].sort()).toEqual(['a', 'b', 'c']);
    expect(ancestorsOf('a', edges('a>b')).size).toBe(0);
  });

  it('genera ids legibles y únicos', () => {
    expect(slugifyNodeId('Análisis de Riesgos!', [])).toBe('analisis_de_riesgos');
    expect(slugifyNodeId('Agente', ['agente', 'agente_2'])).toBe('agente_3');
    expect(slugifyNodeId('¿?', [])).toBe('nodo');
  });
});

describe('validación de workflows', () => {
  const ctx = { agentIds: ['agt_1'], toolNames: ['calculator'] };
  const errors = (n: Parameters<typeof validateWorkflow>[0]) =>
    validateWorkflow(n, ctx)
      .filter((i) => i.level === 'error')
      .map((i) => i.message);

  it('acepta un workflow correcto', () => {
    const wf = {
      nodes: [
        node('in', 'input'),
        node('ag', 'agent', { agentId: 'agt_1', prompt: 'Haz {{input}}' }),
        node('out', 'output', { template: '{{ag}}' }),
      ],
      edges: edges('in>ag', 'ag>out'),
    };
    expect(errors(wf)).toEqual([]);
  });

  it('rechaza ciclos', () => {
    const wf = {
      nodes: [node('a', 'transform', { template: 'x' }), node('b', 'transform', { template: 'y' })],
      edges: edges('a>b', 'b>a'),
    };
    expect(errors(wf).join(' ')).toMatch(/ciclo/);
  });

  it('rechaza agentes inexistentes y nodos sin configurar', () => {
    const wf = {
      nodes: [node('x', 'agent', { agentId: 'borrado', prompt: 'hola' }), node('y', 'agent', {}), node('t', 'tool', { tool: 'nope' })],
      edges: [],
    };
    const e = errors(wf).join('\n');
    expect(e).toMatch(/agente que ya no existe/);
    expect(e).toMatch(/no tiene agente asignado/);
    expect(e).toMatch(/herramienta desconocida/);
  });

  it('rechaza referencias a nodos que no se ejecutan antes', () => {
    const wf = {
      nodes: [
        node('a', 'agent', { agentId: 'agt_1', prompt: 'usa {{b}}' }),
        node('b', 'agent', { agentId: 'agt_1', prompt: 'usa {{fantasma}}' }),
      ],
      edges: [],
    };
    const e = errors(wf).join('\n');
    expect(e).toMatch(/no se ejecuta antes/);
    expect(e).toMatch(/nodo inexistente/);
  });

  it('exige que las ramas de una condición salgan de sí/no', () => {
    const wf = {
      nodes: [
        node('in', 'input'),
        node('c', 'condition', { left: '{{input}}', operator: 'contains', right: 'x' }),
        node('o', 'output'),
      ],
      edges: edges('in>c', 'c>o'),
    };
    expect(errors(wf).join(' ')).toMatch(/deben partir de "sí" o "no"/);
    expect(errors({ ...wf, edges: edges('in>c', 'c:true>o') })).toEqual([]);
  });

  it('rechaza aristas colgantes, ids duplicados y varias entradas', () => {
    const wf = { nodes: [node('a', 'input'), node('a', 'input')], edges: edges('a>zzz') };
    const e = errors(wf).join('\n');
    expect(e).toMatch(/duplicado/);
    expect(e).toMatch(/nodo inexistente/);
    expect(e).toMatch(/Solo puede haber un nodo de entrada/);
  });
});
