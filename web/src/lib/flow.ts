// Conversión entre la definición de workflow de AgentForge y los nodos/aristas de Vue Flow.
import type { NodeType, StepStatus, WorkflowEdge, WorkflowNode } from '@shared/types';
import { MarkerType, type Edge, type Node } from '@vue-flow/core';

export interface FlowNodeData {
  kind: NodeType;
  label: string;
  config: Record<string, any>;
  /** Solo en el monitor de ejecuciones. */
  status?: StepStatus;
  agentName?: string;
  agentColor?: string;
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

export function toFlowEdge(edge: WorkflowEdge): Edge {
  const branch = edge.sourceHandle === 'true' || edge.sourceHandle === 'false' ? edge.sourceHandle : null;
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: branch,
    type: 'smoothstep',
    markerEnd: MarkerType.ArrowClosed,
    label: branch === 'true' ? 'sí' : branch === 'false' ? 'no' : undefined,
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

export const NODE_HINT: Record<NodeType, string> = {
  input: 'El texto con el que se lanza el workflow',
  agent: 'Un agente realiza una tarea',
  tool: 'Ejecuta una herramienta sin pasar por un modelo',
  condition: 'Elige una rama según el resultado anterior',
  transform: 'Combina resultados con una plantilla',
  output: 'El resultado final del workflow',
};

export const OPERATOR_LABEL: Record<string, string> = {
  contains: 'contiene',
  not_contains: 'no contiene',
  equals: 'es igual a',
  not_equals: 'es distinto de',
  matches: 'cumple la expresión regular',
  gt: 'es mayor que',
  lt: 'es menor que',
  is_empty: 'está vacío',
  not_empty: 'no está vacío',
};
