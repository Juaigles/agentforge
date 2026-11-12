import type { WorkflowEdge, WorkflowNode } from '@shared/types';
import { afterEach, describe, expect, it } from 'vitest';
import { setLocale } from '@/i18n';
import { autoLayout, cloneNodes, connectionOptions, LAYOUT, newWorkflowNodes, useHistory } from './builder';

const node = (id: string, type: WorkflowNode['type'] = 'agent', x = 0, y = 0, config: Record<string, unknown> = {}): WorkflowNode => ({
  id,
  type,
  label: id,
  position: { x, y },
  config,
});
const edge = (spec: string): WorkflowEdge => {
  const [from, target] = spec.split('>');
  const [source, handle] = from.split(':');
  return { id: spec, source, target, sourceHandle: handle ?? null };
};

describe('historial de deshacer y rehacer', () => {
  it('deshace y rehace en orden, y un cambio nuevo descarta lo que se podía rehacer', () => {
    const h = useHistory<string>();
    h.reset('a');
    expect([h.canUndo.value, h.canRedo.value]).toEqual([false, false]);
    expect(h.undo()).toBeNull();
    h.record('b');
    h.record('c');
    expect(h.canUndo.value).toBe(true);
    expect(h.undo()).toBe('b');
    expect(h.undo()).toBe('a');
    expect(h.undo()).toBeNull();
    expect([h.canUndo.value, h.canRedo.value]).toEqual([false, true]);
    expect(h.redo()).toBe('b');
    h.record('d'); // rama nueva: «c» ya no se puede rehacer
    expect(h.canRedo.value).toBe(false);
    expect(h.redo()).toBeNull();
    expect(h.undo()).toBe('b');
    expect(h.redo()).toBe('d');
  });

  it('no anota un estado igual al actual y respeta el tope de pasos', () => {
    const h = useHistory<number>(3);
    h.reset(0);
    h.record(0);
    expect(h.canUndo.value).toBe(false);
    for (let i = 1; i <= 10; i++) h.record(i);
    expect([h.undo(), h.undo(), h.undo(), h.undo()]).toEqual([9, 8, 7, null]);
  });

  it('sin estado inicial, el primero que se anota es el punto de partida', () => {
    const h = useHistory<string>();
    h.record('a');
    expect(h.canUndo.value).toBe(false);
    h.record('b');
    expect(h.undo()).toBe('a');
  });
});

describe('orden automático', () => {
  it('pone cada nodo una columna después del más lejano de los que llegan a él', () => {
    const nodes = [node('entrada', 'input'), node('a'), node('b'), node('union'), node('salida', 'output')];
    const edges = ['entrada>a', 'entrada>b', 'a>union', 'b>union', 'union>salida', 'entrada>salida'].map(edge);
    const pos = autoLayout(nodes, edges);
    const column = (id: string) => (pos[id].x - LAYOUT.x0) / LAYOUT.columnWidth;
    expect(['entrada', 'a', 'b', 'union', 'salida'].map(column)).toEqual([0, 1, 1, 2, 3]);
    // «salida» también cuelga de «entrada», pero va tras «union», la más lejana.
    expect(pos.a.y).not.toBe(pos.b.y);
    expect(Math.abs(pos.a.y - pos.b.y)).toBe(LAYOUT.rowHeight);
    // Las columnas de un solo nodo quedan centradas respecto a la de dos.
    expect(pos.entrada.y).toBe((pos.a.y + pos.b.y) / 2);
    expect(pos.union.y).toBe(pos.entrada.y);
  });

  it('dentro de una columna conserva el orden vertical que tenían', () => {
    const nodes = [node('entrada', 'input'), node('abajo', 'agent', 0, 500), node('arriba', 'agent', 0, 10)];
    const pos = autoLayout(nodes, ['entrada>abajo', 'entrada>arriba'].map(edge));
    expect(pos.arriba.y).toBeLessThan(pos.abajo.y);
  });

  it('coloca también los nodos sueltos y no falla con un grafo vacío o con un ciclo', () => {
    expect(autoLayout([], [])).toEqual({});
    const loose = autoLayout([node('a'), node('b')], []);
    expect(loose.a.x).toBe(LAYOUT.x0);
    expect(loose.b.x).toBe(LAYOUT.x0);
    expect(Object.keys(autoLayout([node('a'), node('b')], ['a>b', 'b>a'].map(edge)))).toEqual(['a', 'b']);
  });
});

describe('conexiones posibles desde un nodo', () => {
  const nodes = [node('entrada', 'input'), node('a'), node('cond', 'condition'), node('b'), node('salida', 'output')];
  const edges = ['entrada>a', 'a>cond', 'cond:true>b'].map(edge);

  it('excluye el propio nodo, la entrada, las que ya existen y las que formarían un ciclo', () => {
    expect(connectionOptions(nodes, edges, 'a')).toEqual([
      // «cond» ya está conectada; «entrada» no recibe conexiones.
      { target: 'b', branch: null },
      { target: 'salida', branch: null },
    ]);
    // Desde «b» no se puede volver a «a» ni a «cond» (ciclo).
    expect(connectionOptions(nodes, edges, 'b')).toEqual([{ target: 'salida', branch: null }]);
  });

  it('una condición ofrece cada destino por sus dos ramas, menos la que ya está usada', () => {
    expect(connectionOptions(nodes, edges, 'cond')).toEqual([
      { target: 'b', branch: 'false' },
      { target: 'salida', branch: 'true' },
      { target: 'salida', branch: 'false' },
    ]);
  });

  it('un nodo de salida, o uno que no existe, no tiene conexiones que ofrecer', () => {
    expect(connectionOptions(nodes, edges, 'salida')).toEqual([]);
    expect(connectionOptions(nodes, edges, 'fantasma')).toEqual([]);
  });
});

describe('copiar nodos', () => {
  it('da ids nuevos, desplaza la copia y conserva solo las conexiones entre los copiados', () => {
    const nodes = [node('entrada', 'input'), node('resumir', 'agent', 100, 100, { agentId: 'agt_1', prompt: 'x' }), node('revisar', 'agent', 400, 100)];
    const edges = ['entrada>resumir', 'resumir>revisar'].map(edge);
    const copy = cloneNodes(
      [nodes[1], nodes[2]],
      edges,
      nodes.map((n) => n.id),
    );
    expect(copy.nodes.map((n) => n.id)).toEqual(['resumir_2', 'revisar_2']);
    expect(copy.nodes[0]).toMatchObject({ type: 'agent', label: 'resumir', position: { x: 140, y: 160 }, config: { agentId: 'agt_1', prompt: 'x' } });
    expect(copy.edges).toEqual([{ id: 'resumir_2-out-revisar_2', source: 'resumir_2', target: 'revisar_2', sourceHandle: null }]);
    // La copia no comparte la configuración con el original.
    (copy.nodes[0].config as Record<string, unknown>).prompt = 'cambiado';
    expect(nodes[1].config.prompt).toBe('x');
  });

  it('dos copias seguidas del mismo nodo no repiten id', () => {
    const original = node('paso');
    const first = cloneNodes([original], [], ['paso']);
    const second = cloneNodes([original], [], ['paso', ...first.nodes.map((n) => n.id)]);
    expect([first.nodes[0].id, second.nodes[0].id]).toEqual(['paso_2', 'paso_3']);
  });
});

describe('nodos de un workflow nuevo', () => {
  afterEach(() => setLocale('es', false));

  it('nacen con las etiquetas del idioma activo y los mismos ids en cualquier idioma', () => {
    expect(newWorkflowNodes().map((n) => [n.id, n.type, n.label])).toEqual([
      ['entrada', 'input', 'Entrada'],
      ['salida', 'output', 'Salida'],
    ]);
    setLocale('en', false);
    expect(newWorkflowNodes().map((n) => [n.id, n.type, n.label])).toEqual([
      ['entrada', 'input', 'Input'],
      ['salida', 'output', 'Output'],
    ]);
  });
});
