// Lógica del constructor de workflows que no depende del lienzo: historial de deshacer/rehacer, orden automático
// de los nodos, destinos a los que se puede conectar un nodo y copia de nodos.
import { isBranchingNode, slugifyNodeId, topologicalOrder } from '@shared/graph';
import type { WorkflowEdge, WorkflowNode } from '@shared/types';
import { computed, ref, type ComputedRef } from 'vue';
import { NODE_LABEL } from '@/lib/format';

export interface History<T> {
  canUndo: ComputedRef<boolean>;
  canRedo: ComputedRef<boolean>;
  /** Empieza de cero con este estado (al cargar). */
  reset(state: T): void;
  /** Anota un estado nuevo. Si es igual al actual no hace nada; si es distinto, descarta lo que se podía rehacer. */
  record(state: T): void;
  /** Vuelve al estado anterior y lo devuelve (null si no hay). */
  undo(): T | null;
  redo(): T | null;
}

/** Historial lineal de estados (deshacer/rehacer) con un tope de pasos. */
export function useHistory<T>(limit = 100): History<T> {
  const past = ref<T[]>([]) as { value: T[] };
  const future = ref<T[]>([]) as { value: T[] };
  let present: T | undefined;
  return {
    canUndo: computed(() => past.value.length > 0),
    canRedo: computed(() => future.value.length > 0),
    reset(state) {
      past.value = [];
      future.value = [];
      present = state;
    },
    record(state) {
      if (present === undefined) return void (present = state);
      if (state === present) return;
      past.value = [...past.value, present].slice(-limit);
      future.value = [];
      present = state;
    },
    undo() {
      if (!past.value.length || present === undefined) return null;
      future.value = [present, ...future.value];
      present = past.value[past.value.length - 1];
      past.value = past.value.slice(0, -1);
      return present;
    },
    redo() {
      if (!future.value.length || present === undefined) return null;
      past.value = [...past.value, present];
      present = future.value[0];
      future.value = future.value.slice(1);
      return present;
    },
  };
}

export const LAYOUT = { x0: 40, y0: 40, columnWidth: 270, rowHeight: 120 };

/**
 * Coloca los nodos en columnas de izquierda a derecha: cada nodo va una columna después del más lejano de los
 * que llegan a él. Dentro de una columna se ordenan como estaban (de arriba abajo) y se centran respecto a la más alta.
 */
export function autoLayout(nodes: WorkflowNode[], edges: WorkflowEdge[]): Record<string, { x: number; y: number }> {
  const order = topologicalOrder(nodes, edges) ?? nodes.map((n) => n.id);
  const level = new Map<string, number>();
  for (const id of order) {
    const parents = edges.filter((e) => e.target === id).map((e) => level.get(e.source) ?? 0);
    level.set(id, parents.length ? Math.max(...parents) + 1 : 0);
  }
  const columns = new Map<number, WorkflowNode[]>();
  for (const node of nodes) {
    const column = level.get(node.id) ?? 0;
    columns.set(column, [...(columns.get(column) ?? []), node]);
  }
  const tallest = Math.max(1, ...[...columns.values()].map((c) => c.length));
  const out: Record<string, { x: number; y: number }> = {};
  for (const [column, members] of columns) {
    members.sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x);
    const offset = ((tallest - members.length) * LAYOUT.rowHeight) / 2;
    members.forEach((node, row) => {
      out[node.id] = { x: LAYOUT.x0 + column * LAYOUT.columnWidth, y: Math.round(LAYOUT.y0 + offset + row * LAYOUT.rowHeight) };
    });
  }
  return out;
}

export interface ConnectionOption {
  target: string;
  /** Rama de salida, si el origen tiene dos (condición o aprobación). */
  branch: 'true' | 'false' | null;
}

/**
 * Conexiones que se pueden crear desde `sourceId` sin repetir una existente ni formar un ciclo. Un nodo de salida
 * no tiene salidas y a un nodo de entrada no le llega nada.
 */
export function connectionOptions(nodes: WorkflowNode[], edges: WorkflowEdge[], sourceId: string): ConnectionOption[] {
  const source = nodes.find((n) => n.id === sourceId);
  if (!source || source.type === 'output') return [];
  const branches: Array<'true' | 'false' | null> = isBranchingNode(source) ? ['true', 'false'] : [null];
  const options: ConnectionOption[] = [];
  for (const target of nodes) {
    if (target.id === sourceId || target.type === 'input') continue;
    for (const branch of branches) {
      if (edges.some((e) => e.source === sourceId && e.target === target.id && (e.sourceHandle ?? null) === branch)) continue;
      const candidate: WorkflowEdge = { id: 'candidata', source: sourceId, target: target.id, sourceHandle: branch };
      if (topologicalOrder(nodes, [...edges, candidate]) === null) continue;
      options.push({ target: target.id, branch });
    }
  }
  return options;
}

/**
 * Copia de unos nodos para pegarlos: ids nuevos, desplazados, y con las conexiones que había ENTRE ellos.
 * `existingIds` son los ids ya usados en el lienzo.
 */
export function cloneNodes(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  existingIds: string[],
  offset = { x: 40, y: 60 },
): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } {
  const taken = [...existingIds];
  const ids = new Map<string, string>();
  const copies = nodes.map((node) => {
    const id = slugifyNodeId(node.label || node.id, taken);
    taken.push(id);
    ids.set(node.id, id);
    return {
      ...node,
      id,
      position: { x: node.position.x + offset.x, y: node.position.y + offset.y },
      config: JSON.parse(JSON.stringify(node.config ?? {})) as WorkflowNode['config'],
    };
  });
  const inner = edges
    .filter((e) => ids.has(e.source) && ids.has(e.target))
    .map((e) => ({
      id: `${ids.get(e.source)}-${e.sourceHandle ?? 'out'}-${ids.get(e.target)}`,
      source: ids.get(e.source)!,
      target: ids.get(e.target)!,
      sourceHandle: e.sourceHandle ?? null,
    }));
  return { nodes: copies, edges: inner };
}

/**
 * Nodos con los que nace un workflow nuevo. Los ids se quedan en español (`entrada`/`salida`: hay workflows y
 * pruebas que los citan); las etiquetas salen del idioma activo.
 */
export function newWorkflowNodes(): WorkflowNode[] {
  return [
    { id: 'entrada', type: 'input', label: NODE_LABEL.input, position: { x: 40, y: 160 }, config: { description: '', defaultValue: '' } },
    { id: 'salida', type: 'output', label: NODE_LABEL.output, position: { x: 640, y: 160 }, config: { template: '' } },
  ];
}
