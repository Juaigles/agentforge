// Exportación e importación de workflows y agentes entre instalaciones.
//
// Un archivo exportado lleva lo necesario para que funcione en otro sitio: el workflow, sus subworkflows, los
// agentes, las herramientas HTTP personalizadas, los proveedores (sin claves) y los disparadores. Nunca lleva
// secretos: ni claves de API, ni valores de cabeceras con credenciales, ni secretos de webhooks.
//
// La importación tiene dos pasos: `planImport` dice cómo encaja cada elemento del archivo con lo que ya hay
// (coincide, coincide pero es distinto, no existe) y qué se puede hacer con él; `applyImport` aplica las
// decisiones dentro de una transacción, de modo que un fallo a medias no deja nada creado.
import { randomBytes } from 'node:crypto';
import { nodeSubworkflowId, nodeUsesAgent, validateWorkflow } from '../../shared/graph';
import {
  AGENT_EXPORT_FORMAT,
  EXPORT_VERSION,
  WORKFLOW_EXPORT_FORMAT,
  type Agent,
  type AgentExport,
  type CustomTool,
  type ExportBundle,
  type ExportedAgent,
  type ExportedProvider,
  type ExportedTool,
  type ExportedWorkflow,
  type ImportAction,
  type ImportDecision,
  type ImportItem,
  type ImportPlan,
  type ImportResult,
  type Provider,
  type Workflow,
  type WorkflowExport,
  type WorkflowInput,
  type WorkflowNode,
} from '../../shared/types';
import type { Store } from './db/store';
import { nextOccurrence } from './engine/scheduler';
import { HttpError } from './errors';
import type { ToolRegistry } from './tools/registry';
import { errorMessage } from './util';

/** Herramientas integradas que actúan fuera de la conversación: se avisa al importar un archivo que las reparte. */
const SENSITIVE_TOOLS = ['http_request', 'file_write', 'run_javascript'];

const agentKey = (id: string): string => `agent:${id}`;
const toolKey = (name: string): string => `tool:${name}`;
const providerKey = (name: string): string => `provider:${name}`;
const workflowKey = (id: string): string => `workflow:${id}`;

const sameUrl = (a: string, b: string): boolean => a.trim().replace(/\/+$/, '').toLowerCase() === b.trim().replace(/\/+$/, '').toLowerCase();
const stable = (value: unknown): string => JSON.stringify(value, (_key, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v));

function toolNodeName(node: WorkflowNode): string | null {
  const config = (node.config ?? {}) as Record<string, unknown>;
  if (node.type === 'tool') return String(config.tool ?? '') || null;
  if (node.type === 'foreach' && config.body === 'tool') return String(config.tool ?? '') || null;
  return null;
}

function exportedAgent(agent: Agent, providers: Map<string, Provider>): ExportedAgent {
  const { providerId, createdAt: _c, updatedAt: _u, ...fields } = agent;
  const provider = providers.get(providerId);
  return provider ? { ...fields, provider: provider.name } : fields;
}

function exportedProvider(p: Provider): ExportedProvider {
  return { name: p.name, kind: p.kind, baseUrl: p.baseUrl, defaultModel: p.defaultModel };
}

function exportedTool(tool: CustomTool): ExportedTool {
  const { id: _id, createdAt: _c, updatedAt: _u, ...fields } = tool;
  return fields;
}

const workflowInput = (wf: Workflow): WorkflowInput => ({ name: wf.name, description: wf.description, nodes: wf.nodes, edges: wf.edges, settings: wf.settings });

/** Agentes, herramientas HTTP y proveedores de los que dependen unos agentes y unos workflows. */
function collectDependencies(store: Store, agentIds: Iterable<string>, workflows: WorkflowInput[]) {
  const providers = new Map(store.listProviders().map((p) => [p.id, p]));
  const agents: Agent[] = [];
  for (const id of new Set(agentIds)) {
    const agent = store.getAgent(id);
    if (agent) agents.push(agent);
  }
  const toolNames = new Set<string>(agents.flatMap((a) => a.tools));
  for (const wf of workflows) for (const node of wf.nodes) if (toolNodeName(node)) toolNames.add(toolNodeName(node)!);
  const custom = new Map(store.listCustomTools().map((t) => [t.name, t]));
  const usedProviders = new Map<string, Provider>();
  for (const agent of agents) {
    const provider = providers.get(agent.providerId);
    if (provider) usedProviders.set(provider.id, provider);
  }
  return {
    agents: agents.map((a) => exportedAgent(a, providers)),
    providers: [...usedProviders.values()].map(exportedProvider),
    tools: [...toolNames].filter((name) => custom.has(name)).map((name) => exportedTool(custom.get(name)!)),
  };
}

/** Archivo portable de un workflow: con sus subworkflows, agentes, herramientas HTTP, proveedores y disparadores. */
export function exportWorkflow(store: Store, workflow: Workflow): WorkflowExport {
  // Subworkflows, también los que usan ellos.
  const subworkflows = new Map<string, Workflow>();
  const visit = (nodes: WorkflowNode[]): void => {
    for (const node of nodes) {
      const id = nodeSubworkflowId(node);
      if (!id || id === workflow.id || subworkflows.has(id)) continue;
      const child = store.getWorkflow(id);
      if (!child) continue;
      subworkflows.set(id, child);
      visit(child.nodes);
    }
  };
  visit(workflow.nodes);
  const all = [workflowInput(workflow), ...[...subworkflows.values()].map(workflowInput)];
  const agentIds = all.flatMap((wf) => wf.nodes.filter(nodeUsesAgent).map((n) => String(n.config?.agentId ?? '')));
  const triggers = store.listTriggers(workflow.id).map(({ kind, name, intervalMinutes, time, weekdays, cron, timezone, input, enabled }) => ({
    kind,
    name,
    intervalMinutes,
    time,
    weekdays,
    cron,
    timezone,
    input,
    enabled,
  }));
  return {
    format: WORKFLOW_EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    workflow: all[0],
    ...collectDependencies(store, agentIds, all),
    subworkflows: [...subworkflows.values()].map((wf) => ({ id: wf.id, workflow: workflowInput(wf) })),
    triggers,
  };
}

/** Archivo portable de un agente suelto, con sus herramientas HTTP y su proveedor (sin clave). */
export function exportAgent(store: Store, agent: Agent): AgentExport {
  return { format: AGENT_EXPORT_FORMAT, version: EXPORT_VERSION, exportedAt: new Date().toISOString(), ...collectDependencies(store, [agent.id], []) };
}

// ---------- Importación ----------
export interface ImportDeps {
  store: Store;
  tools: ToolRegistry;
}

const comparableAgent = (a: ExportedAgent | Agent): unknown => ({
  name: a.name,
  role: a.role,
  description: a.description,
  model: a.model,
  systemPrompt: a.systemPrompt,
  temperature: a.temperature,
  maxTokens: a.maxTokens,
  maxIterations: a.maxIterations,
  tools: [...a.tools].sort(),
  thinking: a.thinking,
});
const comparableTool = (t: ExportedTool | CustomTool): unknown => ({
  description: t.description,
  parameters: t.parameters,
  method: t.method,
  urlTemplate: t.urlTemplate,
  bodyTemplate: t.bodyTemplate,
  // De las cabeceras secretas solo se compara el nombre: su valor no viaja.
  headers: Object.fromEntries(Object.entries(t.headers).map(([name, value]) => [name, t.secretHeaders.includes(name) ? '' : value])),
});
const comparableWorkflow = (w: WorkflowInput): unknown => ({ nodes: w.nodes, edges: w.edges, settings: w.settings });

function bundleParts(bundle: ExportBundle) {
  const isWorkflow = bundle.format === WORKFLOW_EXPORT_FORMAT;
  return {
    isWorkflow,
    workflow: isWorkflow ? bundle.workflow : null,
    subworkflows: (isWorkflow ? bundle.subworkflows : undefined) ?? ([] as ExportedWorkflow[]),
    triggers: (isWorkflow ? bundle.triggers : undefined) ?? [],
    agents: bundle.agents ?? [],
    providers: bundle.providers ?? [],
    tools: bundle.tools ?? [],
  };
}

/** Cómo encaja cada elemento del archivo con lo que ya existe, y qué se puede hacer con él. No cambia nada. */
export function planImport({ store, tools }: ImportDeps, bundle: ExportBundle): ImportPlan {
  const parts = bundleParts(bundle);
  const items: ImportItem[] = [];
  const warnings: string[] = [];
  const localProviders = store.listProviders();
  const targets = localProviders.map((p) => ({ id: p.id, name: p.name }));
  const defaultProvider = localProviders.find((p) => p.enabled) ?? localProviders[0];

  for (const provider of parts.providers) {
    const match = localProviders.find((p) => p.name === provider.name) ?? localProviders.find((p) => p.kind === provider.kind && sameUrl(p.baseUrl, provider.baseUrl));
    const notes: string[] = [];
    let recommended: ImportAction;
    let recommendedTargetId: string | undefined;
    let differs = false;
    if (match) {
      differs = match.kind !== provider.kind || !sameUrl(match.baseUrl, provider.baseUrl);
      if (differs) notes.push(`Aquí «${match.name}» apunta a ${match.baseUrl}; en el archivo, a ${provider.baseUrl}.`);
      recommended = 'reuse';
      recommendedTargetId = match.id;
    } else {
      const sameKind = localProviders.find((p) => p.enabled && p.kind === provider.kind) ?? localProviders.find((p) => p.kind === provider.kind);
      if (sameKind) {
        recommended = 'reuse';
        recommendedTargetId = sameKind.id;
        notes.push(`No existe aquí. Sus agentes usarán «${sameKind.name}», que es del mismo tipo, salvo que elijas crearlo.`);
      } else {
        recommended = 'create';
        notes.push(provider.kind === 'openai' ? 'Se creará sin clave de API: añádela en Ajustes antes de ejecutar sus agentes.' : `Se creará apuntando a ${provider.baseUrl}.`);
      }
    }
    items.push({
      key: providerKey(provider.name),
      kind: 'provider',
      name: provider.name,
      match: match ? { id: match.id, name: match.name } : null,
      differs,
      actions: match ? ['reuse', 'create'] : targets.length ? ['create', 'reuse'] : ['create'],
      recommended,
      targets,
      recommendedTargetId,
      notes,
    });
  }

  const localTools = new Map(store.listCustomTools().map((t) => [t.name, t]));
  const registered = new Set(tools.list().map((t) => t.name));
  for (const tool of parts.tools) {
    const match = localTools.get(tool.name);
    const notes: string[] = [];
    let actions: ImportAction[];
    let recommended: ImportAction;
    let differs = false;
    if (match) {
      differs = stable(comparableTool(match)) !== stable(comparableTool(tool));
      actions = differs ? ['reuse', 'replace'] : ['reuse'];
      recommended = 'reuse';
      if (differs) notes.push('Ya existe una herramienta con ese nombre y es distinta. Se usará la de aquí salvo que elijas sustituirla.');
    } else if (registered.has(tool.name)) {
      actions = ['skip'];
      recommended = 'skip';
      notes.push('Aquí ese nombre es de una herramienta integrada o de un servidor MCP: no se importa y se usará la de aquí.');
    } else {
      actions = ['create', 'skip'];
      recommended = 'create';
      let host = tool.urlTemplate;
      try {
        host = new URL(tool.urlTemplate.replace(/\{\{[^}]*\}\}/g, 'x')).host;
      } catch {
        /* URL con plantilla que no se puede interpretar: se enseña tal cual */
      }
      notes.push(`Hace peticiones ${tool.method} a ${host}.`);
    }
    if (tool.secretHeaders.length && recommended !== 'reuse' && recommended !== 'skip') {
      notes.push(`Lleva credenciales que no viajan en el archivo: habrá que escribir ${tool.secretHeaders.join(', ')} al editarla.`);
    }
    items.push({ key: toolKey(tool.name), kind: 'tool', name: tool.name, match: match ? { id: match.id, name: match.name } : null, differs, actions, recommended, notes });
  }

  const localAgents = store.listAgents();
  for (const agent of parts.agents) {
    const match = localAgents.find((a) => a.id === agent.id) ?? localAgents.find((a) => a.name === agent.name);
    const differs = Boolean(match) && stable(comparableAgent(match!)) !== stable(comparableAgent(agent));
    const notes: string[] = [];
    if (differs) notes.push('Ya existe un agente con ese nombre y su configuración es distinta. Se usará el de aquí salvo que elijas sustituirlo o crear una copia.');
    if (!match && !agent.provider && !defaultProvider) notes.push('No hay ningún proveedor configurado: no se podrá crear.');
    items.push({
      key: agentKey(agent.id),
      kind: 'agent',
      name: agent.name,
      match: match ? { id: match.id, name: match.name } : null,
      differs,
      actions: match ? (differs ? ['reuse', 'replace', 'create'] : ['reuse', 'create']) : ['create'],
      recommended: match ? 'reuse' : 'create',
      notes,
    });
  }

  const localWorkflows = store.listWorkflows();
  for (const sub of parts.subworkflows) {
    const match = localWorkflows.find((w) => w.id === sub.id) ?? localWorkflows.find((w) => w.name === sub.workflow.name);
    const differs = Boolean(match) && stable(comparableWorkflow(workflowInput(match!))) !== stable(comparableWorkflow(sub.workflow));
    items.push({
      key: workflowKey(sub.id),
      kind: 'workflow',
      name: sub.workflow.name,
      match: match ? { id: match.id, name: match.name } : null,
      differs,
      actions: match ? ['reuse', 'create'] : ['create'],
      // Usar uno local que es distinto cambiaría lo que hace el workflow sin avisar: por defecto se crea una copia.
      recommended: match && !differs ? 'reuse' : 'create',
      notes: differs ? ['Ya existe un workflow con ese nombre y es distinto: se creará una copia salvo que elijas usar el de aquí.'] : [],
    });
  }

  // Avisos: qué reparte el archivo que puede actuar fuera de la conversación.
  const used = new Set<string>(parts.agents.flatMap((a) => a.tools));
  for (const wf of [...(parts.workflow ? [parts.workflow] : []), ...parts.subworkflows.map((s) => s.workflow)]) {
    for (const node of wf.nodes) if (toolNodeName(node)) used.add(toolNodeName(node)!);
  }
  const sensitive = SENSITIVE_TOOLS.filter((name) => used.has(name));
  if (sensitive.length) {
    warnings.push(`Este archivo usa herramientas que actúan fuera de la conversación (${sensitive.join(', ')}). Revisa los agentes antes de ejecutarlo si no conoces su origen.`);
  }
  if (parts.triggers.length) warnings.push(`Trae ${parts.triggers.length === 1 ? 'un disparador, que se creará' : `${parts.triggers.length} disparadores, que se crearán`} en pausa.`);

  const main = parts.workflow?.name ?? parts.agents[0]?.name ?? '';
  return { kind: parts.isWorkflow ? 'workflow' : 'agent', name: main, items, warnings };
}

function uniqueName(name: string, taken: Set<string>): string {
  let candidate = name;
  for (let i = 2; taken.has(candidate); i++) candidate = `${name} (importado${i > 2 ? ` ${i - 1}` : ''})`;
  taken.add(candidate);
  return candidate;
}

/**
 * Aplica una importación. `decisions` (por clave de elemento) sustituye a la acción recomendada del plan.
 * Todo ocurre en una transacción: si algo falla no queda nada a medias.
 */
export function applyImport(deps: ImportDeps, bundle: ExportBundle, decisions: Record<string, ImportDecision> = {}): ImportResult {
  const { store, tools } = deps;
  const parts = bundleParts(bundle);
  const plan = planImport(deps, bundle);
  const decide = (key: string): ImportDecision & { item: ImportItem } => {
    const item = plan.items.find((i) => i.key === key)!;
    const chosen = decisions[key];
    if (chosen && !item.actions.includes(chosen.action)) {
      throw new HttpError(400, `«${item.name}»: la acción «${chosen.action}» no es posible (${item.actions.join(', ')}).`);
    }
    return { action: chosen?.action ?? item.recommended, targetId: chosen?.targetId ?? (chosen ? undefined : item.recommendedTargetId), item };
  };

  const result: ImportResult = {
    workflow: null,
    createdAgents: [],
    reusedAgents: [],
    replacedAgents: [],
    createdProviders: [],
    createdTools: [],
    replacedTools: [],
    createdWorkflows: [],
    triggers: 0,
    warnings: [...plan.warnings],
    issues: [],
  };

  try {
    store.transaction(() => {
      // 1) Proveedores: nombre en el archivo → proveedor local.
      const providerIds = new Map<string, string>();
      const providerNames = new Set(store.listProviders().map((p) => p.name));
      for (const provider of parts.providers) {
        const { action, targetId, item } = decide(providerKey(provider.name));
        if (action === 'reuse') {
          const target = store.getProvider(targetId ?? item.match?.id ?? '');
          if (!target) throw new HttpError(400, `«${provider.name}»: el proveedor elegido no existe.`);
          providerIds.set(provider.name, target.id);
        } else {
          const created = store.createProvider({ ...provider, name: uniqueName(provider.name, providerNames), apiKey: null, enabled: true });
          providerIds.set(provider.name, created.id);
          result.createdProviders.push(created);
          if (created.kind === 'openai') result.warnings.push(`El proveedor «${created.name}» se ha creado sin clave de API: añádela en Ajustes.`);
        }
      }
      const fallbackProvider = (): Provider | undefined => {
        const all = store.listProviders();
        return all.find((p) => p.enabled) ?? all[0];
      };

      // 2) Herramientas HTTP.
      for (const tool of parts.tools) {
        const { action, item } = decide(toolKey(tool.name));
        const { secretHeaders, ...input } = tool;
        if (action === 'create') {
          store.createCustomTool(input);
          result.createdTools.push(tool.name);
        } else if (action === 'replace' && item.match) {
          // Las cabeceras secretas llegan vacías: se conservan las que hubiera guardadas con el mismo nombre.
          store.updateCustomTool(item.match.id, input);
          result.replacedTools.push(tool.name);
        } else continue;
        if (secretHeaders.length) result.warnings.push(`La herramienta «${tool.name}» lleva credenciales que no viajan en el archivo: escribe ${secretHeaders.join(', ')} al editarla.`);
      }
      const knownTools = new Set(tools.list().map((t) => t.name));

      // 3) Agentes: id en el archivo → agente local.
      const agentIds = new Map<string, string>();
      const agentNames = new Set(store.listAgents().map((a) => a.name));
      for (const incoming of parts.agents) {
        const { action, item } = decide(agentKey(incoming.id));
        const local = item.match ? store.getAgent(item.match.id) : null;
        if (action === 'reuse' && local) {
          agentIds.set(incoming.id, local.id);
          if (!result.reusedAgents.some((a) => a.id === local.id)) result.reusedAgents.push(local);
          continue;
        }
        const { id: _id, provider: providerName, ...fields } = incoming;
        const provider = (providerName && providerIds.has(providerName) ? store.getProvider(providerIds.get(providerName)!) : null) ?? (action === 'replace' && local ? store.getProvider(local.providerId) : null) ?? fallbackProvider();
        if (!provider) {
          result.warnings.push(`No se pudo crear el agente «${incoming.name}»: no hay ningún proveedor configurado.`);
          continue;
        }
        const missing = incoming.tools.filter((t) => !knownTools.has(t));
        if (missing.length) result.warnings.push(`El agente «${incoming.name}» usaba herramientas que no existen aquí: ${missing.join(', ')}.`);
        const input = { ...fields, providerId: provider.id, model: incoming.model || provider.defaultModel, tools: incoming.tools.filter((t) => knownTools.has(t)) };
        let saved: Agent;
        if (action === 'replace' && local) {
          saved = store.updateAgent(local.id, input)!;
          result.replacedAgents.push(saved);
        } else {
          saved = store.createAgent({ ...input, name: uniqueName(incoming.name, agentNames) });
          result.createdAgents.push(saved);
        }
        if (!saved.model) result.warnings.push(`El agente «${saved.name}» no tiene modelo: asígnale uno antes de ejecutarlo.`);
        agentIds.set(incoming.id, saved.id);
      }

      // 4) Subworkflows: primero se crean (para tener sus ids) y después se reescriben las referencias entre ellos.
      const workflowIds = new Map<string, string>();
      const workflowNames = new Set(store.listWorkflows().map((w) => w.name));
      const created: Array<{ id: string; input: WorkflowInput }> = [];
      for (const sub of parts.subworkflows) {
        const { action, item } = decide(workflowKey(sub.id));
        if (action === 'reuse' && item.match) {
          workflowIds.set(sub.id, item.match.id);
          continue;
        }
        const input = { ...sub.workflow, name: uniqueName(sub.workflow.name, workflowNames) };
        const wf = store.createWorkflow(input);
        workflowIds.set(sub.id, wf.id);
        created.push({ id: wf.id, input });
      }
      const rewire = (nodes: WorkflowNode[]): WorkflowNode[] =>
        nodes.map((node) => {
          let config = node.config;
          if (nodeUsesAgent(node) && agentIds.has(String(config?.agentId))) config = { ...config, agentId: agentIds.get(String(config.agentId)) };
          const subId = nodeSubworkflowId(node);
          if (subId && workflowIds.has(subId)) config = { ...config, workflowId: workflowIds.get(subId) };
          return config === node.config ? node : { ...node, config };
        });
      for (const { id, input } of created) result.createdWorkflows.push(store.updateWorkflow(id, { ...input, nodes: rewire(input.nodes) })!);

      // 5) El workflow principal y sus disparadores (siempre en pausa: nada empieza a ejecutarse solo al importar).
      if (parts.workflow) {
        const workflow = store.createWorkflow({ ...parts.workflow, name: uniqueName(parts.workflow.name, workflowNames), nodes: rewire(parts.workflow.nodes) });
        result.workflow = workflow;
        for (const trigger of parts.triggers) {
          const input = { ...trigger, enabled: false };
          // Comprueba que el horario sigue siendo válido aquí (zona horaria, expresión cron).
          nextOccurrence(input, new Date());
          store.createTrigger(workflow.id, input, null, trigger.kind === 'webhook' ? `whsec_${randomBytes(24).toString('base64url')}` : undefined);
          result.triggers++;
        }
        if (parts.triggers.some((t) => t.kind === 'webhook')) {
          result.warnings.push('Los webhooks importados tienen un secreto nuevo: genera uno desde sus disparadores para poder usarlos.');
        }
      }
    });
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, `No se pudo importar el archivo (no se ha creado nada): ${errorMessage(err)}`);
  }

  if (result.workflow) {
    result.issues = validateWorkflow(result.workflow, {
      agentIds: store.listAgents().map((a) => a.id),
      toolNames: tools.names(),
      workflows: store.listWorkflows(),
      selfId: result.workflow.id,
    });
  }
  return result;
}
