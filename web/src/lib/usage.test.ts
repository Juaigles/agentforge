import type { Workflow } from '@shared/types';
import { describe, expect, it } from 'vitest';
import { agentDeleteMessage, workflowsUsingAgent } from './usage';

const workflow = (name: string, nodes: Array<{ type: string; agentId?: string }>): Workflow =>
  ({ id: `wf_${name}`, name, nodes: nodes.map((n, i) => ({ id: `n${i}`, type: n.type, label: '', position: { x: 0, y: 0 }, config: { agentId: n.agentId } })), edges: [] }) as unknown as Workflow;

describe('workflowsUsingAgent', () => {
  it('cuenta los nodos de agente y los «para cada», y nada más', () => {
    const list = [
      workflow('A', [{ type: 'agent', agentId: 'x' }]),
      workflow('B', [{ type: 'foreach', agentId: 'x' }]),
      workflow('C', [{ type: 'agent', agentId: 'otro' }]),
      workflow('D', [{ type: 'tool', agentId: 'x' }]),
    ];
    expect(workflowsUsingAgent(list, 'x').map((w) => w.name)).toEqual(['A', 'B']);
  });
});

describe('agentDeleteMessage', () => {
  it('dice que nadie lo usa cuando es así', () => {
    expect(agentDeleteMessage('Solo', [])).toBe('Se eliminará «Solo». Ningún workflow lo usa. Las ejecuciones anteriores se conservan en el historial.');
  });
  it('concuerda en singular', () => {
    expect(agentDeleteMessage('Uno', [workflow('Informe', [])])).toBe(
      'Se eliminará «Uno». Lo usa 1 workflow («Informe»), que dejará de poder ejecutarse hasta que le asignes otro agente. Las ejecuciones anteriores se conservan en el historial.',
    );
  });
  it('concuerda en plural y resume a partir de cinco', () => {
    const many = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((n) => workflow(n, []));
    const text = agentDeleteMessage('Varios', many);
    expect(text).toContain('Lo usan 7 workflows («a», «b», «c», «d», «e» y 2 más), que dejarán de poder ejecutarse hasta que les asignes otro agente.');
  });
});
