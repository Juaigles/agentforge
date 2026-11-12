// Conversión entre la definición de workflow de AgentForge y los nodos/aristas de Vue Flow.
import type { NodeType, StepStatus, WorkflowEdge, WorkflowNode } from '@shared/types';
import { MarkerType, type Edge, type Node } from '@vue-flow/core';
import { t, te } from '@/i18n';

export interface FlowNodeData {
  kind: NodeType;
  label: string;
  config: Record<string, any>;
  /** Solo en el monitor de ejecuciones. */
  status?: StepStatus;
  agentName?: string;
  agentColor?: string;
  /** Nombre del subworkflow tal como era al lanzar la ejecución (monitor). */
  workflowName?: string;
  /** Nº de errores de validación (constructor). */
  errors?: number;
  warnings?: number;
}

export type FlowNode = Node<FlowNodeData>;

export function toFlowNode(node: WorkflowNode, extra: Partial<FlowNodeData> = {}): FlowNode {
  return {
    id: node.id,
    type: 'af',
    position: { ...node.position },
    // Copia vía JSON: structuredClone falla con los Proxy reactivos de Vue.
    data: { kind: node.type, label: node.label, config: JSON.parse(JSON.stringify(node.config ?? {})), ...extra },
  };
}

/**
 * Textos de una conexión que dependen del idioma: la etiqueta visible de las ramas («Sí»/«No») y el nombre que
 * oye un lector de pantalla. `from` y `to` son los nombres a mostrar de los nodos (por defecto, sus ids).
 */
export function edgeTexts(
  edge: Pick<WorkflowEdge, 'source' | 'target' | 'sourceHandle'>,
  from = edge.source,
  to = edge.target,
): { label?: string; ariaLabel: string } {
  const branch = edge.sourceHandle === 'true' || edge.sourceHandle === 'false' ? edge.sourceHandle : null;
  if (!branch) return { ariaLabel: t('flow.edge.label', { from, to }) };
  const name = t(branch === 'true' ? 'flow.branch.yes' : 'flow.branch.no');
  return { label: name, ariaLabel: t('flow.edge.labelBranch', { from, to, branch: name }) };
}

export function toFlowEdge(edge: WorkflowEdge): Edge {
  const branch = edge.sourceHandle === 'true' || edge.sourceHandle === 'false' ? edge.sourceHandle : null;
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: branch,
    type: 'smoothstep',
    markerEnd: MarkerType.ArrowClosed,
    // Etiqueta visible y nombre accesible; el constructor las vuelve a calcular al cambiar de idioma.
    ...edgeTexts({ source: edge.source, target: edge.target, sourceHandle: branch }),
    class: branch ? `branch-${branch}` : undefined,
  };
}

export function fromFlow(nodes: FlowNode[], edges: Edge[]): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } {
  return {
    nodes: nodes.map((n) => ({
      id: n.id,
      type: n.data!.kind,
      label: n.data!.label,
      position: { x: Math.round(n.position.x), y: Math.round(n.position.y) },
      config: n.data!.config,
    })),
    edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle ?? null })),
  };
}

/** Textos que dependen del idioma: se leen como un objeto normal (`NODE_HINT[tipo]`) y son reactivos. */
function labels<V extends string>(prefix: string, only?: (key: string) => boolean): Record<V, string> {
  return new Proxy({} as Record<V, string>, {
    get: (_target, key) => {
      if (typeof key !== 'string') return undefined;
      const full = `${prefix}.${key}`;
      return only && !te(full) ? undefined : t(full);
    },
  });
}

export const NODE_HINT = labels<NodeType>('flow.hint');

/** Operadores de las condiciones, en el orden en que se ofrecen. */
export const OPERATOR_KEYS = ['contains', 'not_contains', 'equals', 'not_equals', 'matches', 'gt', 'lt', 'is_empty', 'not_empty'] as const;
/** Operador desconocido → `undefined`, para que quien lo lee use su texto de reserva. */
export const OPERATOR_LABEL = labels<string>('flow.operator', () => true);
