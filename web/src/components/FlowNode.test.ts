// @vitest-environment jsdom
import type { Agent } from '@shared/types';
import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it } from 'vitest';
import type { FlowNodeData } from '@/lib/flow';
import { useCatalog } from '@/stores/catalog';
import { freshPinia } from '@/test/harness';
import FlowNode from './FlowNode.vue';

// Los puntos de conexión de Vue Flow necesitan un lienzo real; aquí se sustituyen por un marcador que
// conserva sus propiedades, para comprobar qué conexiones ofrece cada tipo de nodo.
const Handle = { props: ['id', 'type', 'position'], template: '<i class="handle" :data-type="type" :data-id="id" />' };

const agent: Agent = {
  id: 'agt_1',
  name: 'Investigador',
  role: '',
  description: '',
  color: '#0ea5e9',
  providerId: 'p',
  model: 'm',
  systemPrompt: '',
  temperature: 0.5,
  maxTokens: null,
  maxIterations: 4,
  tools: [],
  thinking: false,
  createdAt: '',
  updatedAt: '',
};

function render(data: FlowNodeData, props: { selected?: boolean; id?: string } = {}) {
  return mount(FlowNode, { props: { id: props.id ?? 'nodo', data, selected: props.selected }, global: { stubs: { Handle } } });
}
const handles = (w: ReturnType<typeof render>) =>
  w.findAll('.handle').map((h) => `${h.attributes('data-type')}${h.attributes('data-id') ? `:${h.attributes('data-id')}` : ''}`);

beforeEach(() => {
  freshPinia();
  useCatalog().agents = [agent];
});

describe('FlowNode', () => {
  it('ofrece los puntos de conexión que corresponden a cada tipo de nodo', () => {
    expect(handles(render({ kind: 'input', label: 'Entrada', config: {} }))).toEqual(['source']);
    expect(handles(render({ kind: 'agent', label: 'A', config: { agentId: 'agt_1' } }))).toEqual(['target', 'source']);
    expect(handles(render({ kind: 'output', label: 'Salida', config: {} }))).toEqual(['target']);
    expect(handles(render({ kind: 'foreach', label: 'Cada', config: { agentId: 'agt_1' } }))).toEqual(['target', 'source']);
    // La condición tiene una salida por rama.
    const cond = render({ kind: 'condition', label: '¿Ok?', config: { operator: 'contains', right: 'SI' } });
    expect(handles(cond)).toEqual(['target', 'source:true', 'source:false']);
    expect(cond.findAll('.branch').map((b) => b.text())).toEqual(['sí', 'no']);
  });

  it('resume la configuración de cada tipo en el subtítulo', () => {
    const sub = (data: FlowNodeData) => render(data).get('.sub').text();
    expect(sub({ kind: 'agent', label: 'A', config: { agentId: 'agt_1' } })).toBe('Investigador');
    expect(sub({ kind: 'agent', label: 'A', config: { agentId: '' } })).toBe('Sin agente asignado');
    expect(sub({ kind: 'agent', label: 'A', config: { agentId: 'agt_borrado' } })).toBe('Agente eliminado');
    expect(sub({ kind: 'foreach', label: 'P', config: { agentId: 'agt_1' } })).toBe('Cada elemento → Investigador');
    expect(sub({ kind: 'foreach', label: 'P', config: { agentId: '' } })).toBe('Cada elemento → Sin agente asignado');
    expect(sub({ kind: 'tool', label: 'T', config: { tool: 'file_write' } })).toBe('file_write');
    expect(sub({ kind: 'tool', label: 'T', config: { tool: '' } })).toBe('Sin herramienta asignada');
    expect(sub({ kind: 'condition', label: 'C', config: { operator: 'contains', right: 'APROBADO' } })).toBe('contiene «APROBADO»');
    expect(sub({ kind: 'condition', label: 'C', config: { operator: 'is_empty', right: '' } })).toBe('está vacío');
    expect(sub({ kind: 'input', label: 'E', config: { description: 'Tema' } })).toBe('Tema');
    expect(sub({ kind: 'transform', label: 'X', config: { template: '' } })).toBe('Plantilla vacía');
    expect(sub({ kind: 'output', label: 'S', config: {} })).toBe('Lo que llegue de los nodos anteriores');
  });

  it('usa el id como título si no hay etiqueta y el color del agente como acento', () => {
    const node = render({ kind: 'agent', label: '', config: { agentId: 'agt_1' } }, { id: 'paso_1' });
    expect(node.get('.title').text()).toBe('paso_1');
    expect(node.get('.flow-node').attributes('style')).toContain('--tint: #0ea5e9');
  });

  it('en el monitor usa el nombre y el color del agente guardados en la ejecución, aunque el agente ya no exista', () => {
    useCatalog().agents = [];
    const node = render({
      kind: 'agent',
      label: 'Paso',
      config: { agentId: 'agt_1' },
      agentName: 'Nombre histórico',
      agentColor: '#123456',
      status: 'completed',
    });
    expect(node.get('.sub').text()).toBe('Nombre histórico');
    expect(node.get('.flow-node').attributes('style')).toContain('--tint: #123456');
  });

  it('refleja selección, errores de validación y estado de ejecución', () => {
    const invalid = render({ kind: 'tool', label: 'T', config: { tool: '' }, errors: 2 });
    expect(invalid.get('.flow-node').classes()).toContain('invalid');
    expect(invalid.get('.warn').attributes('title')).toBe('2 errores de configuración');

    const selected = render({ kind: 'tool', label: 'T', config: { tool: 'x' } }, { selected: true });
    expect(selected.get('.flow-node').classes()).toContain('selected');
    expect(selected.find('.warn').exists()).toBe(false);

    const running = render({ kind: 'agent', label: 'A', config: { agentId: 'agt_1' }, status: 'running', errors: 1 });
    expect(running.get('.flow-node').classes()).toContain('st-running');
    // Con estado de ejecución se muestra la insignia de estado, no el aviso de configuración.
    expect(running.get('.badge').text()).toBe('En curso');
    expect(running.find('.warn').exists()).toBe(false);

    // «Pendiente» no añade insignia: el nodo aún no ha hecho nada.
    const pending = render({ kind: 'agent', label: 'A', config: { agentId: 'agt_1' }, status: 'pending' });
    expect(pending.find('.badge').exists()).toBe(false);
  });
});
