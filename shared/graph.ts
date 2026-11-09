// Utilidades de grafo para workflows: orden topológico, ancestros y validación semántica.
import type { ValidationIssue, WorkflowEdge, WorkflowNode } from './types';
import { extractRefs, refNodeId } from './template';

/** Orden topológico (Kahn). Devuelve null si hay un ciclo. */
export function topologicalOrder(nodes: WorkflowNode[], edges: WorkflowEdge[]): string[] | null {
  const indegree = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  const out = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const e of edges) {
    if (!indegree.has(e.source) || !indegree.has(e.target)) continue;
    indegree.set(e.target, indegree.get(e.target)! + 1);
    out.get(e.source)!.push(e.target);
  }
  const queue = nodes.filter((n) => indegree.get(n.id) === 0).map((n) => n.id);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const t of out.get(id)!) {
      indegree.set(t, indegree.get(t)! - 1);
      if (indegree.get(t) === 0) queue.push(t);
    }
  }
  return order.length === nodes.length ? order : null;
}

/** Conjunto de todos los ancestros (directos e indirectos) de un nodo. */
export function ancestorsOf(nodeId: string, edges: WorkflowEdge[]): Set<string> {
  const parents = new Map<string, string[]>();
  for (const e of edges) {
    if (!parents.has(e.target)) parents.set(e.target, []);
    parents.get(e.target)!.push(e.source);
  }
  const seen = new Set<string>();
  const stack = [...(parents.get(nodeId) ?? [])];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(parents.get(id) ?? []));
  }
  return seen;
}

/** Todas las cadenas con plantillas de la configuración de un nodo. */
export function nodeTemplates(node: WorkflowNode): string[] {
  const c = node.config ?? {};
  switch (node.type) {
    case 'agent':
      return [String(c.prompt ?? '')];
    case 'transform':
    case 'output':
      return [String(c.template ?? '')];
    case 'condition':
      return [String(c.left ?? ''), String(c.right ?? '')];
    case 'tool':
      return collectStrings(c.args);
    default:
      return [];
  }
}

function collectStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(collectStrings);
  return [];
}

export interface ValidationContext {
  agentIds: Iterable<string>;
  toolNames: Iterable<string>;
}

const UNARY_OPERATORS = new Set(['is_empty', 'not_empty']);

/** Valida un workflow. Los errores impiden ejecutarlo; los avisos no. */
export function validateWorkflow(
  def: { nodes: WorkflowNode[]; edges: WorkflowEdge[] },
  ctx: ValidationContext,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const err = (message: string, nodeId?: string) => issues.push({ level: 'error', message, nodeId });
  const warn = (message: string, nodeId?: string) => issues.push({ level: 'warning', message, nodeId });
  const agentIds = new Set(ctx.agentIds);
  const toolNames = new Set(ctx.toolNames);
  const { nodes, edges } = def;

  if (nodes.length === 0) {
    err('El workflow no tiene nodos.');
    return issues;
  }

  const byId = new Map<string, WorkflowNode>();
  for (const n of nodes) {
    if (!/^[A-Za-z0-9_-]+$/.test(n.id)) err(`Id de nodo no válido: "${n.id}" (solo letras, números, _ y -).`, n.id);
    if (byId.has(n.id)) err(`Id de nodo duplicado: "${n.id}".`, n.id);
    byId.set(n.id, n);
  }

  const inputs = nodes.filter((n) => n.type === 'input');
  if (inputs.length > 1) err('Solo puede haber un nodo de entrada.');

  const incoming = new Map<string, WorkflowEdge[]>(nodes.map((n) => [n.id, []]));
  const outgoing = new Map<string, WorkflowEdge[]>(nodes.map((n) => [n.id, []]));
  const seenPairs = new Set<string>();
  for (const e of edges) {
    if (!byId.has(e.source) || !byId.has(e.target)) {
      err(`La conexión "${e.id}" apunta a un nodo inexistente.`);
      continue;
    }
    if (e.source === e.target) err('Un nodo no puede conectarse consigo mismo.', e.source);
    const key = `${e.source}|${e.sourceHandle ?? ''}|${e.target}`;
    if (seenPairs.has(key)) warn('Hay conexiones duplicadas entre los mismos nodos.', e.source);
    seenPairs.add(key);
    incoming.get(e.target)!.push(e);
    outgoing.get(e.source)!.push(e);
  }

  if (topologicalOrder(nodes, edges.filter((e) => byId.has(e.source) && byId.has(e.target))) === null) {
    err('El workflow contiene un ciclo; debe ser un grafo acíclico.');
  }

  for (const n of nodes) {
    const c = n.config ?? {};
    const ins = incoming.get(n.id)!;
    const outs = outgoing.get(n.id)!;
    const name = n.label || n.id;

    switch (n.type) {
      case 'input':
        if (ins.length) err(`El nodo de entrada "${name}" no puede tener conexiones entrantes.`, n.id);
        if (!outs.length) warn(`El nodo de entrada "${name}" no está conectado.`, n.id);
        break;
      case 'agent':
        if (!c.agentId) err(`El nodo "${name}" no tiene agente asignado.`, n.id);
        else if (!agentIds.has(c.agentId)) err(`El nodo "${name}" usa un agente que ya no existe.`, n.id);
        if (!String(c.prompt ?? '').trim()) err(`El nodo "${name}" no tiene instrucciones (prompt).`, n.id);
        break;
      case 'tool':
        if (!c.tool) err(`El nodo "${name}" no tiene herramienta asignada.`, n.id);
        else if (!toolNames.has(c.tool)) err(`El nodo "${name}" usa una herramienta desconocida: ${c.tool}.`, n.id);
        break;
      case 'condition': {
        if (!c.operator) err(`La condición "${name}" no tiene operador.`, n.id);
        if (c.operator === 'matches') {
          try {
            new RegExp(String(c.right ?? ''));
          } catch {
            err(`La condición "${name}" tiene una expresión regular no válida.`, n.id);
          }
        }
        if (!UNARY_OPERATORS.has(c.operator) && String(c.right ?? '') === '') {
          warn(`La condición "${name}" compara con un valor vacío.`, n.id);
        }
        for (const e of outs) {
          if (e.sourceHandle !== 'true' && e.sourceHandle !== 'false') {
            err(`Las salidas de la condición "${name}" deben partir de "sí" o "no".`, n.id);
          }
        }
        if (!outs.length) warn(`La condición "${name}" no tiene ramas conectadas.`, n.id);
        if (!ins.length) err(`La condición "${name}" necesita una conexión entrante.`, n.id);
        break;
      }
      case 'transform':
        if (!String(c.template ?? '').trim()) err(`El nodo "${name}" no tiene plantilla.`, n.id);
        break;
      case 'output':
        if (outs.length) err(`El nodo de salida "${name}" no puede tener conexiones salientes.`, n.id);
        if (!ins.length) err(`El nodo de salida "${name}" necesita una conexión entrante.`, n.id);
        break;
      default:
        err(`Tipo de nodo desconocido: ${(n as WorkflowNode).type}.`, n.id);
    }

    // Las referencias {{nodo}} deben apuntar a ancestros: solo ellos han terminado seguro antes.
    const ancestors = ancestorsOf(n.id, edges);
    for (const tpl of nodeTemplates(n)) {
      for (const ref of extractRefs(tpl)) {
        const target = refNodeId(ref);
        if (target === null) {
          if (ref === 'upstream' && !ins.length) {
            warn(`"${name}" usa {{upstream}} pero no tiene conexiones entrantes.`, n.id);
          }
          continue;
        }
        if (!byId.has(target)) err(`"${name}" referencia un nodo inexistente: {{${ref}}}.`, n.id);
        else if (!ancestors.has(target)) {
          err(`"${name}" referencia {{${ref}}}, que no se ejecuta antes que él (no es un nodo anterior).`, n.id);
        }
      }
    }
  }

  if (!nodes.some((n) => n.type === 'agent' || n.type === 'tool')) {
    warn('El workflow no contiene ningún agente ni herramienta.');
  }
  return issues;
}

/** Genera un id de nodo legible y único a partir de una etiqueta. */
export function slugifyNodeId(label: string, existing: Iterable<string>): string {
  const taken = new Set(existing);
  const base =
    label
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 24) || 'nodo';
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}_${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}
