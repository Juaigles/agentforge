// Utilidades de grafo para workflows: orden topológico, ancestros y validación semántica.
import type { ValidationIssue, WorkflowEdge, WorkflowNode } from './types';
import { extractRefs, FOREACH_REFS, refNodeId, RESERVED_NODE_IDS } from './template';
import { FOREACH_DEFAULTS, MAX_SUBWORKFLOW_DEPTH } from './types';
import { VALIDATION_MESSAGES, type IssueParams, type ValidationCode } from './validation-messages';

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
    case 'foreach':
      return [String(c.items ?? ''), ...foreachBodyTemplates(node)];
    case 'subworkflow':
      return [String(c.input ?? '')];
    case 'approval':
      return [String(c.message ?? '')];
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

/** Cuerpo que ejecuta un «para cada» con cada elemento. */
export function foreachBody(node: WorkflowNode): 'agent' | 'tool' | 'subworkflow' {
  const body = node.config?.body;
  return body === 'tool' || body === 'subworkflow' ? body : 'agent';
}

/** Plantillas del cuerpo de un «para cada» (las que pueden usar {{item}}, {{index}} y {{total}}). */
export function foreachBodyTemplates(node: WorkflowNode): string[] {
  const c = node.config ?? {};
  switch (foreachBody(node)) {
    case 'tool':
      return collectStrings(c.args);
    case 'subworkflow':
      return [String(c.input ?? '')];
    default:
      return [String(c.prompt ?? '')];
  }
}

/** ¿El nodo ejecuta un agente? (un nodo agente, o un «para cada» cuyo cuerpo es un agente). */
export function nodeUsesAgent(node: WorkflowNode): boolean {
  return node.type === 'agent' || (node.type === 'foreach' && foreachBody(node) === 'agent');
}

/** Id del workflow que el nodo lanza como subworkflow, si lanza alguno. */
export function nodeSubworkflowId(node: WorkflowNode): string | null {
  if (node.type === 'subworkflow' || (node.type === 'foreach' && foreachBody(node) === 'subworkflow')) {
    return node.config?.workflowId ? String(node.config.workflowId) : null;
  }
  return null;
}

/** Nodos con dos salidas («sí» / «no»): la condición y la aprobación humana. */
export const isBranchingNode = (node: Pick<WorkflowNode, 'type'>): boolean => node.type === 'condition' || node.type === 'approval';

function collectStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(collectStrings);
  return [];
}

export interface ValidationContext {
  agentIds: Iterable<string>;
  toolNames: Iterable<string>;
  /** Los demás workflows (para validar los subworkflows y detectar ciclos entre workflows). */
  workflows?: Array<{ id: string; name: string; nodes: WorkflowNode[] }>;
  /** Id del workflow que se valida (si ya está guardado), para detectar que se llame a sí mismo. */
  selfId?: string | null;
}

/**
 * Comprueba la cadena de subworkflows que parte de `workflowId`. Devuelve el código del problema si vuelve a
 * `selfId` (ciclo) o si anida más niveles de los admitidos; null si es correcta.
 */
type SubworkflowProblem = 'subworkflowCycleSelf' | 'subworkflowCycle' | 'subworkflowDepth';
function subworkflowProblem(workflowId: string, ctx: ValidationContext): SubworkflowProblem | null {
  const byId = new Map((ctx.workflows ?? []).map((w) => [w.id, w]));
  const visit = (id: string, depth: number, path: string[]): SubworkflowProblem | null => {
    if (ctx.selfId && id === ctx.selfId) return 'subworkflowCycleSelf';
    if (path.includes(id)) return 'subworkflowCycle';
    if (depth > MAX_SUBWORKFLOW_DEPTH) return 'subworkflowDepth';
    const wf = byId.get(id);
    if (!wf) return null;
    for (const node of wf.nodes) {
      const child = nodeSubworkflowId(node);
      if (!child) continue;
      const problem = visit(child, depth + 1, [...path, id]);
      if (problem) return problem;
    }
    return null;
  };
  return visit(workflowId, 1, []);
}

const UNARY_OPERATORS = new Set(['is_empty', 'not_empty']);

/** Valida un workflow. Los errores impiden ejecutarlo; los avisos no. */
export function validateWorkflow(
  def: { nodes: WorkflowNode[]; edges: WorkflowEdge[] },
  ctx: ValidationContext,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  // Cada problema lleva su código y sus parámetros (para traducirlo) además del texto en español.
  const add = (level: ValidationIssue['level'], code: ValidationCode, params: IssueParams, nodeId?: string) =>
    issues.push({ level, message: VALIDATION_MESSAGES[code](params), nodeId, code, params });
  const err = (code: ValidationCode, params: IssueParams = {}, nodeId?: string) => add('error', code, params, nodeId);
  const warn = (code: ValidationCode, params: IssueParams = {}, nodeId?: string) => add('warning', code, params, nodeId);
  const agentIds = new Set(ctx.agentIds);
  const toolNames = new Set(ctx.toolNames);
  const { nodes, edges } = def;

  if (nodes.length === 0) {
    err('empty');
    return issues;
  }

  const workflowNames = new Map((ctx.workflows ?? []).map((w) => [w.id, w.name]));
  /** Valida la referencia de un nodo a otro workflow. */
  const checkSubworkflow = (n: WorkflowNode, name: string): void => {
    const id = String(n.config?.workflowId ?? '');
    if (!id) return void err('subworkflowUnset', { name }, n.id);
    if (ctx.selfId && id === ctx.selfId) return void err('subworkflowSelf', { name }, n.id);
    if (!ctx.workflows) return;
    if (!workflowNames.has(id)) return void err('subworkflowGone', { name }, n.id);
    const problem = subworkflowProblem(id, ctx);
    if (problem) err(problem, { workflow: workflowNames.get(id) ?? id, name, max: MAX_SUBWORKFLOW_DEPTH }, n.id);
  };

  const byId = new Map<string, WorkflowNode>();
  for (const n of nodes) {
    if (!/^[A-Za-z0-9_-]+$/.test(n.id)) err('nodeIdInvalid', { id: n.id }, n.id);
    else if (RESERVED_NODE_IDS.has(n.id)) err('nodeIdReserved', { id: n.id }, n.id);
    if (byId.has(n.id)) err('nodeIdDuplicate', { id: n.id }, n.id);
    byId.set(n.id, n);
  }

  const inputs = nodes.filter((n) => n.type === 'input');
  if (inputs.length > 1) err('multipleInputs');

  const incoming = new Map<string, WorkflowEdge[]>(nodes.map((n) => [n.id, []]));
  const outgoing = new Map<string, WorkflowEdge[]>(nodes.map((n) => [n.id, []]));
  const seenPairs = new Set<string>();
  for (const e of edges) {
    if (!byId.has(e.source) || !byId.has(e.target)) {
      err('edgeDangling', { id: e.id });
      continue;
    }
    if (e.source === e.target) err('selfLoop', {}, e.source);
    const key = `${e.source}|${e.sourceHandle ?? ''}|${e.target}`;
    if (seenPairs.has(key)) warn('duplicateEdges', {}, e.source);
    seenPairs.add(key);
    incoming.get(e.target)!.push(e);
    outgoing.get(e.source)!.push(e);
  }

  if (topologicalOrder(nodes, edges.filter((e) => byId.has(e.source) && byId.has(e.target))) === null) {
    err('cycle');
  }

  for (const n of nodes) {
    const c = n.config ?? {};
    const ins = incoming.get(n.id)!;
    const outs = outgoing.get(n.id)!;
    const name = n.label || n.id;

    switch (n.type) {
      case 'input':
        if (ins.length) err('inputHasIncoming', { name }, n.id);
        if (!outs.length) warn('inputUnconnected', { name }, n.id);
        break;
      case 'agent':
        if (!c.agentId) err('agentUnset', { name }, n.id);
        else if (!agentIds.has(c.agentId)) err('agentGone', { name }, n.id);
        if (!String(c.prompt ?? '').trim()) err('promptEmpty', { name }, n.id);
        break;
      case 'tool':
        if (!c.tool) err('toolUnset', { name }, n.id);
        else if (!toolNames.has(c.tool)) err('toolUnknown', { name, tool: String(c.tool) }, n.id);
        break;
      case 'condition': {
        if (!c.operator) err('conditionNoOperator', { name }, n.id);
        if (c.operator === 'matches') {
          try {
            new RegExp(String(c.right ?? ''));
          } catch {
            err('conditionBadRegex', { name }, n.id);
          }
        }
        if (!UNARY_OPERATORS.has(c.operator) && String(c.right ?? '') === '') {
          warn('conditionEmptyRight', { name }, n.id);
        }
        for (const e of outs) {
          if (e.sourceHandle !== 'true' && e.sourceHandle !== 'false') {
            err('conditionBadBranch', { name }, n.id);
          }
        }
        if (!outs.length) warn('conditionNoBranches', { name }, n.id);
        if (!ins.length) err('conditionNoIncoming', { name }, n.id);
        break;
      }
      case 'transform':
        if (!String(c.template ?? '').trim()) err('templateEmpty', { name }, n.id);
        break;
      case 'foreach': {
        const body = foreachBody(n);
        if (body === 'agent') {
          if (!c.agentId) err('agentUnset', { name }, n.id);
          else if (!agentIds.has(c.agentId)) err('agentGone', { name }, n.id);
          const prompt = String(c.prompt ?? '');
          if (!prompt.trim()) err('foreachTaskEmpty', { name }, n.id);
          else if (!extractRefs(prompt).includes('item')) {
            warn('foreachTaskNoItem', { name }, n.id);
          }
        } else if (body === 'tool') {
          if (!c.tool) err('toolUnset', { name }, n.id);
          else if (!toolNames.has(c.tool)) err('toolUnknown', { name, tool: String(c.tool) }, n.id);
          if (!foreachBodyTemplates(n).some((t) => extractRefs(t).includes('item'))) {
            warn('foreachArgsNoItem', { name }, n.id);
          }
        } else {
          checkSubworkflow(n, name);
        }
        if (c.onItemError !== undefined && c.onItemError !== 'fail' && c.onItemError !== 'continue') {
          err('foreachBadPolicy', { name }, n.id);
        }
        const items = String(c.items ?? '');
        if (!items.trim() && !ins.length) err('foreachNoList', { name }, n.id);
        if (extractRefs(items).some((r) => FOREACH_REFS.has(r))) {
          err('foreachListUsesItem', { name }, n.id);
        }
        const inRange = (value: unknown, max: number) => value === undefined || value === null || value === '' || (Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= max);
        if (!inRange(c.concurrency, FOREACH_DEFAULTS.maxConcurrency)) err('foreachConcurrencyRange', { name, max: FOREACH_DEFAULTS.maxConcurrency }, n.id);
        if (!inRange(c.maxItems, FOREACH_DEFAULTS.hardMaxItems)) err('foreachMaxItemsRange', { name, max: FOREACH_DEFAULTS.hardMaxItems }, n.id);
        break;
      }
      case 'subworkflow':
        checkSubworkflow(n, name);
        if (!String(c.input ?? '').trim() && !ins.length) err('subworkflowNoInput', { name }, n.id);
        break;
      case 'approval':
        if (!String(c.message ?? '').trim()) err('approvalNoMessage', { name }, n.id);
        for (const e of outs) {
          if (e.sourceHandle !== 'true' && e.sourceHandle !== 'false') {
            err('approvalBadBranch', { name }, n.id);
          }
        }
        if (!outs.length) warn('approvalNoBranches', { name }, n.id);
        break;
      case 'output':
        if (outs.length) err('outputHasOutgoing', { name }, n.id);
        if (!ins.length) err('outputNoIncoming', { name }, n.id);
        break;
      default:
        err('unknownNodeType', { type: String((n as WorkflowNode).type) }, n.id);
    }

    // Las referencias {{nodo}} deben apuntar a ancestros: solo ellos han terminado seguro antes.
    const ancestors = ancestorsOf(n.id, edges);
    for (const tpl of nodeTemplates(n)) {
      for (const ref of extractRefs(tpl)) {
        const target = refNodeId(ref);
        if (target === null) {
          if (ref === 'upstream' && !ins.length) {
            warn('upstreamNoIncoming', { name }, n.id);
          }
          if (FOREACH_REFS.has(ref) && n.type !== 'foreach') {
            err('foreachRefOutside', { name, ref }, n.id);
          }
          continue;
        }
        if (!byId.has(target)) err('refMissing', { name, ref }, n.id);
        else if (!ancestors.has(target)) {
          err('refNotAncestor', { name, ref }, n.id);
        } else if (ref.endsWith('.comment') && byId.get(target)!.type !== 'approval') {
          err('refNoComment', { name, ref }, n.id);
        }
      }
    }
  }

  if (!nodes.some((n) => n.type === 'agent' || n.type === 'tool' || n.type === 'foreach' || n.type === 'subworkflow')) {
    warn('noWork');
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
  // Un id como «input» o «total» chocaría con las referencias integradas: se le añade un sufijo.
  if (!taken.has(base) && !RESERVED_NODE_IDS.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}_${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}
