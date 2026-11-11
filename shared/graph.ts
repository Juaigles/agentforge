// Utilidades de grafo para workflows: orden topológico, ancestros y validación semántica.
import type { ValidationIssue, WorkflowEdge, WorkflowNode } from './types';
import { extractRefs, FOREACH_REFS, refNodeId, RESERVED_NODE_IDS } from './template';
import { FOREACH_DEFAULTS, MAX_SUBWORKFLOW_DEPTH } from './types';

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
 * Comprueba la cadena de subworkflows que parte de `workflowId`. Devuelve un mensaje si vuelve a `selfId`
 * (ciclo) o si anida más niveles de los admitidos; null si es correcta.
 */
function subworkflowProblem(workflowId: string, ctx: ValidationContext): string | null {
  const byId = new Map((ctx.workflows ?? []).map((w) => [w.id, w]));
  const visit = (id: string, depth: number, path: string[]): string | null => {
    if (ctx.selfId && id === ctx.selfId) return 'acaba llamando a este mismo workflow (ciclo entre workflows)';
    if (path.includes(id)) return 'contiene un ciclo entre workflows';
    if (depth > MAX_SUBWORKFLOW_DEPTH) return `anida más de ${MAX_SUBWORKFLOW_DEPTH} niveles de workflows`;
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
  const err = (message: string, nodeId?: string) => issues.push({ level: 'error', message, nodeId });
  const warn = (message: string, nodeId?: string) => issues.push({ level: 'warning', message, nodeId });
  const agentIds = new Set(ctx.agentIds);
  const toolNames = new Set(ctx.toolNames);
  const { nodes, edges } = def;

  if (nodes.length === 0) {
    err('El workflow no tiene nodos.');
    return issues;
  }

  const workflowNames = new Map((ctx.workflows ?? []).map((w) => [w.id, w.name]));
  /** Valida la referencia de un nodo a otro workflow. */
  const checkSubworkflow = (n: WorkflowNode, name: string): void => {
    const id = String(n.config?.workflowId ?? '');
    if (!id) return void err(`El nodo "${name}" no tiene workflow asignado.`, n.id);
    if (ctx.selfId && id === ctx.selfId) return void err(`El nodo "${name}" no puede llamar al workflow del que forma parte.`, n.id);
    if (!ctx.workflows) return;
    if (!workflowNames.has(id)) return void err(`El nodo "${name}" usa un workflow que ya no existe.`, n.id);
    const problem = subworkflowProblem(id, ctx);
    if (problem) err(`El subworkflow «${workflowNames.get(id)}» de "${name}" ${problem}.`, n.id);
  };

  const byId = new Map<string, WorkflowNode>();
  for (const n of nodes) {
    if (!/^[A-Za-z0-9_-]+$/.test(n.id)) err(`Id de nodo no válido: "${n.id}" (solo letras, números, _ y -).`, n.id);
    else if (RESERVED_NODE_IDS.has(n.id)) err(`El id de nodo "${n.id}" está reservado: cámbialo (chocaría con la referencia {{${n.id}}}).`, n.id);
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
      case 'foreach': {
        const body = foreachBody(n);
        if (body === 'agent') {
          if (!c.agentId) err(`El nodo "${name}" no tiene agente asignado.`, n.id);
          else if (!agentIds.has(c.agentId)) err(`El nodo "${name}" usa un agente que ya no existe.`, n.id);
          const prompt = String(c.prompt ?? '');
          if (!prompt.trim()) err(`El nodo "${name}" no tiene la tarea que se aplica a cada elemento.`, n.id);
          else if (!extractRefs(prompt).includes('item')) {
            warn(`La tarea de "${name}" no usa {{item}}: todos los elementos recibirán exactamente la misma tarea.`, n.id);
          }
        } else if (body === 'tool') {
          if (!c.tool) err(`El nodo "${name}" no tiene herramienta asignada.`, n.id);
          else if (!toolNames.has(c.tool)) err(`El nodo "${name}" usa una herramienta desconocida: ${c.tool}.`, n.id);
          if (!foreachBodyTemplates(n).some((t) => extractRefs(t).includes('item'))) {
            warn(`Los argumentos de "${name}" no usan {{item}}: la herramienta recibirá lo mismo con cada elemento.`, n.id);
          }
        } else {
          checkSubworkflow(n, name);
        }
        if (c.onItemError !== undefined && c.onItemError !== 'fail' && c.onItemError !== 'continue') {
          err(`"${name}": la política ante un elemento fallido debe ser «detener» o «continuar».`, n.id);
        }
        const items = String(c.items ?? '');
        if (!items.trim() && !ins.length) err(`El nodo "${name}" no tiene de dónde sacar la lista: conéctalo o indica una plantilla.`, n.id);
        if (extractRefs(items).some((r) => FOREACH_REFS.has(r))) {
          err(`La lista de "${name}" no puede usar {{item}}, {{index}} ni {{total}}: solo existen dentro de la tarea.`, n.id);
        }
        const inRange = (value: unknown, max: number) => value === undefined || value === null || value === '' || (Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= max);
        if (!inRange(c.concurrency, FOREACH_DEFAULTS.maxConcurrency)) err(`La concurrencia de "${name}" debe estar entre 1 y ${FOREACH_DEFAULTS.maxConcurrency}.`, n.id);
        if (!inRange(c.maxItems, FOREACH_DEFAULTS.hardMaxItems)) err(`El máximo de elementos de "${name}" debe estar entre 1 y ${FOREACH_DEFAULTS.hardMaxItems}.`, n.id);
        break;
      }
      case 'subworkflow':
        checkSubworkflow(n, name);
        if (!String(c.input ?? '').trim() && !ins.length) err(`El nodo "${name}" no tiene entrada que pasar al subworkflow: conéctalo o indica una plantilla.`, n.id);
        break;
      case 'approval':
        if (!String(c.message ?? '').trim()) err(`La aprobación "${name}" no tiene el texto de lo que se pide aprobar.`, n.id);
        for (const e of outs) {
          if (e.sourceHandle !== 'true' && e.sourceHandle !== 'false') {
            err(`Las salidas de la aprobación "${name}" deben partir de "aprobado" o "rechazado".`, n.id);
          }
        }
        if (!outs.length) warn(`La aprobación "${name}" no tiene ramas conectadas.`, n.id);
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
          if (FOREACH_REFS.has(ref) && n.type !== 'foreach') {
            err(`"${name}" usa {{${ref}}}, que solo existe dentro de un nodo «para cada».`, n.id);
          }
          continue;
        }
        if (!byId.has(target)) err(`"${name}" referencia un nodo inexistente: {{${ref}}}.`, n.id);
        else if (!ancestors.has(target)) {
          err(`"${name}" referencia {{${ref}}}, que no se ejecuta antes que él (no es un nodo anterior).`, n.id);
        } else if (ref.endsWith('.comment') && byId.get(target)!.type !== 'approval') {
          err(`"${name}" usa {{${ref}}}, pero solo las aprobaciones tienen comentario.`, n.id);
        }
      }
    }
  }

  if (!nodes.some((n) => n.type === 'agent' || n.type === 'tool' || n.type === 'foreach' || n.type === 'subworkflow')) {
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
  // Un id como «input» o «total» chocaría con las referencias integradas: se le añade un sufijo.
  if (!taken.has(base) && !RESERVED_NODE_IDS.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}_${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}
