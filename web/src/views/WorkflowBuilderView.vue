<script setup lang="ts">
// Constructor visual de workflows: paleta → lienzo (Vue Flow) → inspector.
import { ancestorsOf, foreachBody, isBranchingNode, slugifyNodeId, topologicalOrder, validateWorkflow } from '@shared/graph';
import { DEFAULT_WORKFLOW_SETTINGS, type NodeType, type Trigger, type ValidationIssue, type WorkflowInput, type WorkflowSettings } from '@shared/types';
import { Background } from '@vue-flow/background';
import { Controls } from '@vue-flow/controls';
import { useVueFlow, VueFlow, type Connection, type Edge, type NodeChange } from '@vue-flow/core';
import { MiniMap } from '@vue-flow/minimap';
import {
  ArrowLeft,
  Bot,
  CalendarClock,
  CircleAlert,
  CircleCheck,
  Copy,
  Download,
  Flag,
  GitBranch,
  LayoutGrid,
  Link2,
  LogIn,
  Play,
  Redo2,
  Repeat,
  Save,
  Settings2,
  Shuffle,
  Trash2,
  TriangleAlert,
  Undo2,
  Unlink,
  UserCheck,
  Workflow as WorkflowIcon,
  Wrench,
} from 'lucide-vue-next';
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch, watchEffect, type Ref } from 'vue';
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router';
import AgentAvatar from '@/components/AgentAvatar.vue';
import AppModal from '@/components/AppModal.vue';
import FlowNode from '@/components/FlowNode.vue';
import TriggersModal from '@/components/TriggersModal.vue';
import Term from '@/components/Term.vue';
import { locale, t, tn } from '@/i18n';
import { announce, localizeFlow } from '@/lib/a11y';
import { api, errorText } from '@/lib/api';
import { toolDescription, toolParamDescription, toolTitle } from '@/lib/tool-text';
import { autoLayout, cloneNodes, connectionOptions, newWorkflowNodes, useHistory } from '@/lib/builder';
import { adoptRoute } from '@/lib/editor-mount';
import {
  edgeTexts,
  fromFlow,
  NODE_HINT,
  OPERATOR_KEYS,
  OPERATOR_LABEL,
  toFlowEdge,
  toFlowNode,
  type FlowNode as FlowNodeT,
  type FlowNodeData,
} from '@/lib/flow';
import { NODE_LABEL } from '@/lib/format';
import { downloadJson, exportFileName, summarizeTriggers } from '@/lib/transfer';
import { issueText } from '@/lib/validation-en';
import { useCatalog } from '@/stores/catalog';
import { useUi } from '@/stores/ui';

const route = useRoute();
const router = useRouter();
const catalog = useCatalog();
const ui = useUi();

const flowId = `builder-${Math.random().toString(36).slice(2)}`;
const { screenToFlowCoordinate, viewport, fitView, removeNodes, removeSelectedElements, onNodesInitialized, getSelectedNodes, getSelectedEdges } =
  useVueFlow(flowId);
// Encuadre inicial: solo la primera vez que Vue Flow termina de medir los nodos.
let framed = false;
onNodesInitialized(() => {
  if (framed) return;
  framed = true;
  void fitView({ padding: 0.2, maxZoom: 1 });
});

const workflowId = computed(() => (route.params.id ? String(route.params.id) : null));
const meta = reactive({ name: '', description: '' });
const settings = reactive<WorkflowSettings>({ ...DEFAULT_WORKFLOW_SETTINGS });
// Anotación explícita: inferir el tipo desenvuelto de los nodos de Vue Flow desborda al compilador.
const nodes = ref([]) as Ref<FlowNodeT[]>;
const edges = ref([]) as Ref<Edge[]>;
const selectedId = ref<string | null>(null);
const loading = ref(true);
const loadError = ref<string | null>(null);
const saving = ref(false);
const saved = ref('');
const canvas = ref<HTMLElement | null>(null);

const PALETTE: Array<{ kind: NodeType; icon: typeof Bot }> = [
  { kind: 'input', icon: LogIn },
  { kind: 'tool', icon: Wrench },
  { kind: 'condition', icon: GitBranch },
  { kind: 'foreach', icon: Repeat },
  { kind: 'subworkflow', icon: WorkflowIcon },
  { kind: 'approval', icon: UserCheck },
  { kind: 'transform', icon: Shuffle },
  { kind: 'output', icon: Flag },
];
const FOREACH_BODIES = ['agent', 'tool', 'subworkflow'] as const;
const OPERATORS = OPERATOR_KEYS;
const UNARY = new Set(['is_empty', 'not_empty']);

// ---------- Definición, cambios y validación ----------
const definition = computed<WorkflowInput>(() => ({
  name: meta.name.trim(),
  description: meta.description.trim(),
  ...fromFlow(nodes.value, edges.value),
  settings: { ...settings },
}));
const serialized = computed(() => JSON.stringify(definition.value));
const dirty = computed(() => !loading.value && serialized.value !== saved.value);

const issues = computed<ValidationIssue[]>(() =>
  validateWorkflow(definition.value, {
    agentIds: catalog.agents.map((a) => a.id),
    toolNames: catalog.enabledToolNames,
    // Los demás workflows: para comprobar los subworkflows y que no se formen ciclos entre workflows.
    workflows: catalog.workflows,
    selfId: workflowId.value,
  }),
);

/** Workflows que este puede lanzar como subworkflow (todos menos él mismo). */
const otherWorkflows = computed(() => catalog.workflows.filter((w) => w.id !== workflowId.value));
const errors = computed(() => issues.value.filter((i) => i.level === 'error'));
const warnings = computed(() => issues.value.filter((i) => i.level === 'warning'));

// El recuento de errores se refleja en cada nodo del lienzo.
watch(
  issues,
  (list) => {
    for (const n of nodes.value) {
      const count = list.filter((i) => i.nodeId === n.id && i.level === 'error').length;
      if ((n.data!.errors ?? 0) !== count) n.data!.errors = count;
    }
  },
  { immediate: true },
);

const selected = computed(() => nodes.value.find((n) => n.id === selectedId.value) ?? null);
const selectedData = computed<FlowNodeData | null>(() => selected.value?.data ?? null);
const selectedIssues = computed(() => issues.value.filter((i) => i.nodeId === selectedId.value));
watch(nodes, (list) => {
  if (selectedId.value && !list.some((n) => n.id === selectedId.value)) selectedId.value = null;
});

/** Referencias que se pueden insertar en las plantillas del nodo seleccionado. */
const availableRefs = computed(() => {
  if (!selected.value) return [];
  const def = definition.value;
  const refs: Array<{ ref: string; hint: string }> = [{ ref: 'input', hint: t('builder.refs.input') }];
  if (def.edges.some((e) => e.target === selected.value!.id)) refs.push({ ref: 'upstream', hint: t('builder.refs.upstream') });
  const ancestors = ancestorsOf(selected.value.id, def.edges);
  for (const n of def.nodes) {
    if (!ancestors.has(n.id)) continue;
    if (n.type === 'approval') refs.push({ ref: `${n.id}.comment`, hint: t('builder.refs.approvalComment', { name: n.label || n.id }) });
    else if (n.type !== 'input' && n.type !== 'condition') refs.push({ ref: n.id, hint: t('builder.refs.result', { name: n.label || n.id }) });
  }
  if (selected.value.data?.kind === 'foreach') {
    refs.unshift(
      { ref: 'item', hint: t('builder.refs.item') },
      { ref: 'index', hint: t('builder.refs.index') },
      { ref: 'total', hint: t('builder.refs.total') },
    );
  }
  return refs;
});

/** Cuerpo del «para cada» seleccionado (agente, herramienta o subworkflow). */
const selectedBody = computed(() =>
  selected.value && selectedData.value?.kind === 'foreach' ? foreachBody({ ...fromFlow([selected.value], []).nodes[0] }) : null,
);
/** Herramienta cuyos argumentos se editan: la del nodo herramienta o la del cuerpo de un «para cada». */
const selectedTool = computed(() => {
  const data = selectedData.value;
  if (!data) return undefined;
  return data.kind === 'tool' || (data.kind === 'foreach' && selectedBody.value === 'tool') ? catalog.toolByName.get(data.config.tool) : undefined;
});

function setForeachBody(body: 'agent' | 'tool' | 'subworkflow'): void {
  const data = selectedData.value;
  if (!data) return;
  data.config.body = body;
  if (body === 'tool') data.config.args ??= {};
  if (body === 'subworkflow') data.config.input ??= '{{item}}';
  if (body === 'agent') data.config.prompt ||= t('builder.defaults.foreachPrompt');
}

// ---------- Carga ----------
async function load(): Promise<void> {
  loadError.value = null;
  loading.value = true;
  try {
    await catalog.ensure();
    if (workflowId.value) {
      const wf = await api.workflows.get(workflowId.value);
      meta.name = wf.name;
      meta.description = wf.description;
      Object.assign(settings, wf.settings);
      nodes.value = wf.nodes.map((n) => toFlowNode(n));
      edges.value = wf.edges.map(toFlowEdge);
    } else {
      meta.name = t('builder.defaults.workflowName');
      nodes.value = newWorkflowNodes().map((n) => toFlowNode(n));
    }
    loading.value = false;
    await nextTick();
    // También en uno nuevo: mientras no se toque no hay cambios que perder («Guardar» sigue disponible para crearlo).
    saved.value = serialized.value;
    history.reset(serialized.value);
  } catch (err) {
    loadError.value = errorText(err);
    loading.value = false;
  }
}
onMounted(load);
// Un error de carga no es definitivo: «Reintentar», o solo cuando vuelve la conexión con el servidor.
watch(
  () => catalog.online,
  (online) => {
    if (online && loadError.value && !loading.value) void load();
  },
);

// ---------- Deshacer y rehacer ----------
// Cada estado es la definición completa serializada. Los cambios seguidos (escribir en un campo, arrastrar un
// nodo) se agrupan en un solo paso esperando a que haya una pausa.
const history = useHistory<string>();
let restoring = false;
let historyTimer: ReturnType<typeof setTimeout> | undefined;
watch(serialized, (next) => {
  if (loading.value || restoring) return;
  clearTimeout(historyTimer);
  historyTimer = setTimeout(() => history.record(next), 350);
});
/** Anota ya el cambio que estuviera esperando su pausa (antes de deshacer o de salir). */
function flushHistory(): void {
  clearTimeout(historyTimer);
  if (!loading.value) history.record(serialized.value);
}
function restore(snapshot: string | null, message: string): void {
  if (!snapshot) return;
  restoring = true;
  const def = JSON.parse(snapshot) as WorkflowInput;
  meta.name = def.name;
  meta.description = def.description;
  Object.assign(settings, def.settings);
  nodes.value = def.nodes.map((n) => toFlowNode(n));
  edges.value = def.edges.map(toFlowEdge);
  announce(message);
  void nextTick(() => {
    restoring = false;
  });
}
function undo(): void {
  flushHistory();
  restore(history.undo(), t('builder.announce.undone'));
}
function redo(): void {
  flushHistory();
  restore(history.redo(), t('builder.announce.redone'));
}

// ---------- Accesibilidad del lienzo ----------
const nodeName = (id: string): string => {
  const n = nodes.value.find((x) => x.id === id);
  return n?.data?.label || id;
};
// Nombre que oye un lector de pantalla al enfocar cada nodo: tipo, etiqueta y errores.
watchEffect(() => {
  for (const n of nodes.value) {
    const errorCount = n.data?.errors ?? 0;
    const label = `${t('builder.a11y.nodeLabel', { type: NODE_LABEL[n.data!.kind], label: n.data!.label || n.id })}${errorCount ? `, ${tn('builder.a11y.nodeErrors', errorCount)}` : ''}`;
    if (n.ariaLabel !== label) n.ariaLabel = label;
    const role = t('builder.a11y.nodeRole');
    if (n.domAttributes?.['aria-roledescription'] !== role) n.domAttributes = { ...n.domAttributes, 'aria-roledescription': role };
  }
});
watchEffect(() => {
  for (const e of edges.value) {
    // Etiqueta visible («Sí»/«No») y nombre accesible: se rehacen al cambiar el idioma o el nombre de un nodo.
    const { label, ariaLabel } = edgeTexts(e as { source: string; target: string; sourceHandle: string | null }, nodeName(e.source), nodeName(e.target));
    if (e.ariaLabel !== ariaLabel) e.ariaLabel = ariaLabel;
    if (e.label !== label) e.label = label;
  }
});
let unlocalize: (() => void) | null = null;
watch([canvas, locale], ([el]) => {
  unlocalize?.();
  unlocalize = el ? localizeFlow(el, t('builder.canvas.nodeHelp'), t('builder.canvas.edgeHelp')) : null;
});

/** Selecciona un nodo y lleva el foco a sus propiedades (alternativa de teclado al clic en el lienzo). */
function editNode(id: string): void {
  selectedId.value = id;
  void nextTick(() => document.getElementById('in-label')?.focus());
}
/** Devuelve el foco al nodo en el lienzo (Escape desde sus propiedades). */
function focusNodeOnCanvas(): void {
  if (!selectedId.value) return;
  canvas.value?.querySelector<HTMLElement>(`.vue-flow__node[data-id="${CSS.escape(selectedId.value)}"]`)?.focus();
}
/** La selección de Vue Flow (clic, teclado, selección múltiple) decide qué nodo muestra el inspector. */
function onNodesChange(changes: NodeChange[]): void {
  for (const change of changes) if (change.type === 'select' && change.selected) selectedId.value = change.id;
}
/** Deja de seleccionar nodos: el inspector vuelve a los ajustes del workflow y a la lista «Nodos». */
function deselect(): void {
  selectedId.value = null;
  removeSelectedElements();
}
/** Alternativa visible (y de teclado) a la insignia de validación para volver a los ajustes del workflow. */
function showSettings(): void {
  deselect();
  void nextTick(() => document.getElementById('wf-desc')?.focus());
}
function onCanvasKey(ev: KeyboardEvent): void {
  const target = ev.target as HTMLElement;
  if (ev.key === 'Escape' && selectedId.value) {
    // Escape en el lienzo suelta la selección (en las propiedades, devuelve el foco al nodo: ver onShortcut).
    // Se corta aquí: Vue Flow trata Escape sobre un nodo como un clic y volvería a seleccionarlo.
    ev.stopPropagation();
    deselect();
    return;
  }
  if ((ev.key === 'Enter' || ev.key === ' ') && target.classList.contains('vue-flow__node') && target.dataset.id) {
    ev.preventDefault();
    editNode(target.dataset.id);
  }
}

// ---------- Conexiones sin arrastrar ----------
const outgoing = computed(() => edges.value.filter((e) => e.source === selectedId.value));
const incoming = computed(() => edges.value.filter((e) => e.target === selectedId.value));
const connectOptions = computed(() => (selectedId.value ? connectionOptions(definition.value.nodes, definition.value.edges, selectedId.value) : []));
const connectChoice = ref('');
watch([selectedId, connectOptions], () => {
  connectChoice.value = '';
});
const optionKey = (o: { target: string; branch: string | null }): string => `${o.branch ?? ''}|${o.target}`;
const branchWord = (branch: string): string => t(branch === 'true' ? 'flow.branch.yes' : 'flow.branch.no');
const branchText = (branch: string | null | undefined): string =>
  branch === 'true' || branch === 'false' ? t('builder.connections.viaBranch', { branch: branchWord(branch) }) : '';
const branchSuffix = (branch: string | null | undefined): string =>
  branch === 'true' || branch === 'false' ? t('builder.connections.branchSuffix', { branch: branchWord(branch) }) : '';
function connectChosen(): void {
  const option = connectOptions.value.find((o) => optionKey(o) === connectChoice.value);
  if (!option || !selectedId.value) return;
  onConnect({ source: selectedId.value, target: option.target, sourceHandle: option.branch, targetHandle: null });
  announce(t('builder.announce.connected', { from: nodeName(selectedId.value), to: nodeName(option.target), branch: branchText(option.branch) }));
}
function removeEdge(edge: Edge): void {
  edges.value = edges.value.filter((e) => e.id !== edge.id);
  announce(t('builder.announce.edgeRemoved', { from: nodeName(edge.source), to: nodeName(edge.target) }));
}

// ---------- Copiar, pegar y ordenar ----------
let clipboard: { nodes: ReturnType<typeof fromFlow>['nodes']; edges: ReturnType<typeof fromFlow>['edges'] } | null = null;
let pasteCount = 0;
/** Nodos sobre los que actúan copiar y duplicar: la selección del lienzo o, si no hay, el nodo del inspector. */
function selectionIds(): string[] {
  const chosen = getSelectedNodes.value.map((n) => n.id);
  return chosen.length ? chosen : selectedId.value ? [selectedId.value] : [];
}
function copySelection(): boolean {
  const ids = new Set(selectionIds());
  if (!ids.size) return false;
  const def = definition.value;
  // Copia por valor: `fromFlow` comparte la configuración viva de los nodos, y editar el original cambiaría lo copiado.
  clipboard = JSON.parse(JSON.stringify({ nodes: def.nodes.filter((n) => ids.has(n.id)), edges: def.edges }));
  pasteCount = 0;
  ui.info(tn('builder.toast.copied', ids.size));
  return true;
}
function paste(): void {
  if (!clipboard?.nodes.length) return;
  pasteCount++;
  const copy = cloneNodes(
    clipboard.nodes,
    clipboard.edges,
    nodes.value.map((n) => n.id),
    { x: 40 * pasteCount, y: 60 * pasteCount },
  );
  nodes.value = [...nodes.value, ...copy.nodes.map((n) => toFlowNode(n))];
  edges.value = [...edges.value, ...copy.edges.map(toFlowEdge)];
  selectedId.value = copy.nodes[0].id;
  announce(tn('builder.announce.pasted', copy.nodes.length, { name: copy.nodes[0].label || copy.nodes[0].id }));
}
function tidy(): void {
  const def = definition.value;
  const positions = autoLayout(def.nodes, def.edges);
  for (const n of nodes.value) if (positions[n.id]) n.position = positions[n.id];
  void nextTick(() => fitView({ padding: 0.2, maxZoom: 1, duration: 200 }));
  announce(t('builder.announce.tidied'));
}

// ---------- Atajos de teclado ----------
function onShortcut(ev: KeyboardEvent): void {
  if (loading.value || loadError.value || document.querySelector('.backdrop')) return;
  const mod = ev.ctrlKey || ev.metaKey;
  const key = ev.key.toLowerCase();
  // Guardar funciona también mientras se escribe en un campo.
  if (mod && key === 's') {
    ev.preventDefault();
    if (!saving.value && (dirty.value || !workflowId.value)) void save();
    return;
  }
  const target = ev.target as HTMLElement | null;
  const typing = !!target?.closest('input, textarea, select, [contenteditable="true"]');
  if (typing) {
    // Escape en las propiedades de un nodo devuelve el foco al nodo en el lienzo.
    if (ev.key === 'Escape' && target?.closest('.inspector')) focusNodeOnCanvas();
    return;
  }
  if (mod && key === 'z') {
    ev.preventDefault();
    if (ev.shiftKey) redo();
    else undo();
  } else if (mod && key === 'y') {
    ev.preventDefault();
    redo();
  } else if (mod && key === 'c') {
    // Con texto seleccionado en la página, Ctrl+C copia ese texto como siempre.
    if (!window.getSelection()?.toString() && copySelection()) ev.preventDefault();
  } else if (mod && key === 'v') {
    if (clipboard) {
      ev.preventDefault();
      paste();
    }
  } else if (mod && key === 'd') {
    if (selectedId.value) {
      ev.preventDefault();
      duplicateSelected();
    }
  } else if (
    (ev.key === 'Delete' || ev.key === 'Backspace') &&
    selectedId.value &&
    !getSelectedNodes.value.length &&
    !getSelectedEdges.value.length &&
    !target?.closest('button, a')
  ) {
    // Un nodo recién añadido está seleccionado en el inspector pero no en Vue Flow: Suprimir también lo borra.
    ev.preventDefault();
    removeSelected();
  }
}
onMounted(() => document.addEventListener('keydown', onShortcut));

// Cerrar o recargar la pestaña con cambios sin guardar pide confirmación al navegador.
function onBeforeUnload(ev: BeforeUnloadEvent): void {
  if (dirty.value && !loadError.value) ev.preventDefault();
}
onMounted(() => window.addEventListener('beforeunload', onBeforeUnload));
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onShortcut);
  window.removeEventListener('beforeunload', onBeforeUnload);
  clearTimeout(historyTimer);
  unlocalize?.();
});

// ---------- Edición del grafo ----------
function addNode(kind: NodeType, position?: { x: number; y: number }, agentId?: string): void {
  const agent = agentId ? catalog.agentById.get(agentId) : undefined;
  const label =
    agent?.name ?? (kind === 'condition' ? t('builder.defaults.conditionLabel') : kind === 'approval' ? t('builder.defaults.approvalLabel') : NODE_LABEL[kind]);
  const config: Record<string, any> =
    kind === 'agent'
      ? { agentId: agentId ?? '', prompt: '{{upstream}}' }
      : kind === 'tool'
        ? { tool: '', args: {} }
        : kind === 'condition'
          ? { left: '{{upstream}}', operator: 'contains', right: '' }
          : kind === 'foreach'
            ? { body: 'agent', agentId: '', items: '{{upstream}}', prompt: t('builder.defaults.foreachPrompt'), concurrency: 2 }
            : kind === 'subworkflow'
              ? { workflowId: '', input: '{{upstream}}' }
              : kind === 'approval'
                ? { message: t('builder.defaults.approvalMessage') }
                : kind === 'transform'
                  ? { template: '{{upstream}}' }
                  : kind === 'input'
                    ? { description: '', defaultValue: '' }
                    : { template: '' };
  const id = slugifyNodeId(
    label,
    nodes.value.map((n) => n.id),
  );
  let pos = position;
  // Clic en la paleta con un nodo seleccionado: el nuevo se coloca a su derecha y se conecta a él.
  const anchor = !position ? selected.value : null;
  if (!pos && anchor) {
    pos = freeSpot({ x: anchor.position.x + 270, y: anchor.position.y });
  } else if (!pos) {
    const rect = canvas.value?.getBoundingClientRect();
    const center = rect ? screenToFlowCoordinate({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }) : { x: 200, y: 200 };
    pos = freeSpot({ x: Math.round(center.x - 104), y: Math.round(center.y - 40) });
  }
  nodes.value = [...nodes.value, toFlowNode({ id, type: kind, label, position: pos, config })];
  const anchorKind = anchor?.data?.kind;
  if (anchor && kind !== 'input' && anchorKind !== 'output') {
    // Desde una condición o una aprobación se usa la primera rama libre (sí y, si ya está ocupada, no).
    const branches = anchorKind === 'condition' || anchorKind === 'approval';
    const branch = branches ? (['true', 'false'].find((h) => !edges.value.some((e) => e.source === anchor.id && e.sourceHandle === h)) ?? null) : null;
    if (!branches || branch) onConnect({ source: anchor.id, target: id, sourceHandle: branch, targetHandle: null });
  }
  selectedId.value = id;
  const connected = edges.value.some((e) => e.source === anchor?.id && e.target === id);
  announce(connected ? t('builder.announce.addedConnected', { name: label, anchor: nodeName(anchor!.id) }) : t('builder.announce.added', { name: label }));
  void nextTick(() => ensureVisible(pos!));
}

/** Si un nodo recién añadido queda fuera de la parte visible del lienzo, se reencuadra el grafo. */
function ensureVisible(pos: { x: number; y: number }): void {
  const rect = canvas.value?.getBoundingClientRect();
  if (!rect) return;
  // Posición del nodo dentro del lienzo, en píxeles de pantalla (coordenada del grafo × zoom + desplazamiento).
  const { x: dx, y: dy, zoom } = viewport.value;
  const left = pos.x * zoom + dx;
  const top = pos.y * zoom + dy;
  const margin = 12;
  const outside = left < margin || top < margin || left + 208 * zoom > rect.width - margin || top + 84 * zoom > rect.height - margin;
  if (outside) void fitView({ padding: 0.2, maxZoom: 1, duration: 200 });
}

/** Desplaza hacia abajo una posición hasta que no pise a ningún nodo existente. */
function freeSpot(pos: { x: number; y: number }): { x: number; y: number } {
  const spot = { ...pos };
  while (nodes.value.some((n) => Math.abs(n.position.x - spot.x) < 220 && Math.abs(n.position.y - spot.y) < 90)) spot.y += 110;
  return spot;
}

// Lo que se arrastra viaja con un tipo propio y, de respaldo, como texto con un prefijo: algunos navegadores
// (WebKit) descartan los tipos que no son estándar y sin el respaldo soltar no crearía nada.
const DRAG_TYPE = 'application/agentforge-node';
const DRAG_PREFIX = 'agentforge-node:';
function onDragStart(ev: DragEvent, kind: NodeType, agentId?: string): void {
  const payload = JSON.stringify({ kind, agentId });
  ev.dataTransfer?.setData(DRAG_TYPE, payload);
  ev.dataTransfer?.setData('text/plain', DRAG_PREFIX + payload);
  if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'copy';
}
function onDrop(ev: DragEvent): void {
  const plain = ev.dataTransfer?.getData('text/plain') ?? '';
  const raw = ev.dataTransfer?.getData(DRAG_TYPE) || (plain.startsWith(DRAG_PREFIX) ? plain.slice(DRAG_PREFIX.length) : '');
  if (!raw) return;
  const { kind, agentId } = JSON.parse(raw) as { kind: NodeType; agentId?: string };
  const p = screenToFlowCoordinate({ x: ev.clientX, y: ev.clientY });
  addNode(kind, { x: p.x - 104, y: p.y - 36 }, agentId);
}

function onConnect(c: Connection): void {
  if (!c.source || !c.target || c.source === c.target) return;
  const source = nodes.value.find((n) => n.id === c.source);
  const handle = source?.data && isBranchingNode({ type: source.data.kind }) ? (c.sourceHandle === 'false' ? 'false' : 'true') : null;
  if (edges.value.some((e) => e.source === c.source && e.target === c.target && (e.sourceHandle ?? null) === handle)) return;
  const candidate = { id: `${c.source}-${handle ?? 'out'}-${c.target}`, source: c.source, target: c.target, sourceHandle: handle };
  const def = definition.value;
  if (topologicalOrder(def.nodes, [...def.edges, candidate]) === null) {
    ui.error(t('builder.toast.cycle'));
    return;
  }
  edges.value = [...edges.value, toFlowEdge(candidate)];
}

function removeSelected(): void {
  if (!selectedId.value) return;
  announce(t('builder.announce.removed', { name: nodeName(selectedId.value) }));
  removeNodes([selectedId.value]);
}

function duplicateSelected(): void {
  const src = selected.value;
  if (!src?.data) return;
  const id = slugifyNodeId(
    src.data.label || src.id,
    nodes.value.map((n) => n.id),
  );
  nodes.value = [
    ...nodes.value,
    toFlowNode({ id, type: src.data.kind, label: src.data.label, position: { x: src.position.x + 40, y: src.position.y + 60 }, config: src.data.config }),
  ];
  selectedId.value = id;
  announce(t('builder.announce.duplicated', { name: src.data.label || src.id }));
}

function insertRef(refName: string): void {
  const data = selectedData.value;
  if (!data) return;
  const token = `{{${refName}}}`;
  const el = document.activeElement;
  const key = el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement ? el.dataset.tpl : undefined;
  // Si el foco está en un campo de plantilla se inserta en el cursor; si no, al final del campo principal.
  if (key && (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement)) {
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    const next = el.value.slice(0, start) + token + el.value.slice(end);
    setTemplate(key, next);
    void nextTick(() => el.setSelectionRange(start + token.length, start + token.length));
    return;
  }
  const usesArgs = data.kind === 'tool' || (data.kind === 'foreach' && selectedBody.value === 'tool');
  if (usesArgs) return void navigator.clipboard?.writeText(token).then(() => ui.info(t('builder.toast.tokenCopied', { token })));
  const main =
    data.kind === 'agent'
      ? 'prompt'
      : data.kind === 'foreach'
        ? selectedBody.value === 'subworkflow'
          ? 'input'
          : 'prompt'
        : data.kind === 'condition'
          ? 'left'
          : data.kind === 'subworkflow'
            ? 'input'
            : data.kind === 'approval'
              ? 'message'
              : 'template';
  setTemplate(main, `${data.config[main] ?? ''}${token}`);
}
function setTemplate(key: string, value: string): void {
  const data = selectedData.value;
  if (!data) return;
  if (key.startsWith('arg:')) data.config.args = { ...data.config.args, [key.slice(4)]: value };
  else data.config[key] = value;
}

function argText(name: string): string {
  const v = selectedData.value?.config.args?.[name];
  return v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v);
}
function setArg(name: string, value: string): void {
  const data = selectedData.value;
  if (!data) return;
  const args = { ...(data.config.args ?? {}) };
  if (value === '') delete args[name];
  else args[name] = value;
  data.config.args = args;
}
function onToolChange(): void {
  const data = selectedData.value;
  if (!data) return;
  data.config.args = {};
  const tool = catalog.toolByName.get(data.config.tool);
  if (tool && (!data.label || data.label === NODE_LABEL.tool)) data.label = toolTitle(tool);
}
function onAgentChange(): void {
  const data = selectedData.value;
  const agent = data ? catalog.agentById.get(data.config.agentId) : undefined;
  if (data && agent && (!data.label || data.label === NODE_LABEL.agent || catalog.agents.some((a) => a.name === data.label))) data.label = agent.name;
}

const optionalNumber = (key: 'retries' | 'timeoutMs' | 'concurrency' | 'maxItems', scale = 1) =>
  computed({
    get: () => {
      const v = selectedData.value?.config[key];
      return v === undefined || v === null || v === '' ? '' : String(Number(v) / scale);
    },
    set: (text: string) => {
      const data = selectedData.value;
      if (!data) return;
      if (String(text).trim() === '') delete data.config[key];
      else data.config[key] = Math.max(0, Math.round(Number(text) * scale) || 0);
    },
  });
const retriesText = optionalNumber('retries');
const timeoutSecText = optionalNumber('timeoutMs', 1000);
const concurrencyText = optionalNumber('concurrency');
const maxItemsText = optionalNumber('maxItems');
const durationMin = computed({
  get: () => Math.round(settings.maxDurationMs / 6000) / 10,
  set: (v: number) => (settings.maxDurationMs = Math.max(1000, Math.round((Number(v) || 1) * 60_000))),
});

// ---------- Guardar y ejecutar ----------
async function save(): Promise<boolean> {
  if (!meta.name.trim()) {
    ui.error(t('builder.toast.nameRequired'));
    return false;
  }
  saving.value = true;
  try {
    const wf = workflowId.value ? await api.workflows.update(workflowId.value, definition.value) : await api.workflows.create(definition.value);
    catalog.setWorkflow(wf);
    saved.value = serialized.value;
    ui.success(t('builder.toast.saved'));
    // Primer guardado: la pantalla sigue montada (deshacer, selección, lienzo y foco intactos) y pasa a su dirección definitiva.
    if (!workflowId.value) await adoptRoute(router, `/workflows/${wf.id}`);
    return true;
  } catch (err) {
    ui.error(errorText(err));
    return false;
  } finally {
    saving.value = false;
  }
}

// ---------- Exportar y programar ----------
const scheduleModal = ref(false);
const triggers = ref<Trigger[]>([]);
const triggerSummary = computed(() => summarizeTriggers(triggers.value));
async function loadTriggers(): Promise<void> {
  if (!workflowId.value) return;
  try {
    triggers.value = await api.triggers.forWorkflow(workflowId.value);
  } catch {
    /* dato secundario */
  }
}
onMounted(loadTriggers);

async function exportWorkflow(): Promise<void> {
  if (!workflowId.value) return;
  try {
    // Se exporta lo guardado: los cambios pendientes se guardan antes.
    if (dirty.value && !(await save())) return;
    downloadJson(exportFileName(meta.name), await api.workflows.export(workflowId.value));
    ui.success(t('builder.toast.exported'));
  } catch (err) {
    ui.error(errorText(err));
  }
}

const runModal = ref(false);
const runInput = ref('');
const launching = ref(false);
const inputNode = computed(() => nodes.value.find((n) => n.data?.kind === 'input'));

function openRun(): void {
  if (errors.value.length) {
    ui.error(tn('builder.toast.fixErrors', errors.value.length));
    selectedId.value = errors.value.find((e) => e.nodeId)?.nodeId ?? null;
    return;
  }
  runInput.value = String(inputNode.value?.data?.config.defaultValue ?? '');
  runModal.value = true;
}

async function launch(): Promise<void> {
  launching.value = true;
  try {
    if ((dirty.value || !workflowId.value) && !(await save())) return;
    const id = workflowId.value ?? String(route.params.id);
    const run = await api.workflows.run(id, runInput.value);
    runModal.value = false;
    await router.push(`/runs/${run.id}`);
  } catch (err) {
    ui.error(errorText(err));
  } finally {
    launching.value = false;
  }
}

onBeforeRouteLeave(async (to) => {
  if (!dirty.value || loadError.value) return true;
  // Tras crear un workflow nuevo se navega a su URL definitiva: no es una salida real.
  if (to.path.startsWith('/workflows/') && serialized.value === saved.value) return true;
  return ui.confirm({
    title: t('builder.confirm.leaveTitle'),
    message: t('builder.confirm.leaveMessage'),
    confirmLabel: t('builder.confirm.leaveConfirm'),
    danger: true,
  });
});
</script>

<template>
  <div class="builder">
    <h1 class="sr-only">{{ meta.name ? t('builder.heading.named', { name: meta.name }) : t('builder.heading.untitled') }}</h1>
    <header class="bar">
      <RouterLink class="btn btn-ghost btn-icon" to="/workflows" :aria-label="t('builder.back')"><ArrowLeft /></RouterLink>
      <input v-model="meta.name" class="name" :aria-label="t('builder.name')" :placeholder="t('builder.name')" maxlength="120" />
      <div v-if="!loading && !loadError" class="row edit-tools" role="group" :aria-label="t('builder.tools.group')">
        <button
          class="btn btn-ghost btn-icon"
          type="button"
          :aria-label="t('builder.tools.undo')"
          :title="t('builder.tools.undoTitle')"
          :disabled="!history.canUndo.value"
          @click="undo"
        >
          <Undo2 />
        </button>
        <button
          class="btn btn-ghost btn-icon"
          type="button"
          :aria-label="t('builder.tools.redo')"
          :title="t('builder.tools.redoTitle')"
          :disabled="!history.canRedo.value"
          @click="redo"
        >
          <Redo2 />
        </button>
        <button
          class="btn btn-ghost btn-icon"
          type="button"
          :aria-label="t('builder.tools.tidy')"
          :title="t('builder.tools.tidyTitle')"
          :disabled="nodes.length < 2"
          @click="tidy"
        >
          <LayoutGrid />
        </button>
      </div>
      <span class="grow" />
      <span v-if="dirty" class="badge warning">{{ t('builder.badge.unsaved') }}</span>
      <button
        v-if="!loading"
        class="badge check-badge"
        :class="errors.length ? 'danger' : warnings.length ? 'warning' : 'success'"
        type="button"
        :title="t('builder.badge.viewTitle')"
        @click="selectedId = null"
      >
        <component :is="errors.length ? CircleAlert : warnings.length ? TriangleAlert : CircleCheck" />
        {{
          errors.length ? tn('builder.badge.errors', errors.length) : warnings.length ? tn('builder.badge.warnings', warnings.length) : t('builder.badge.valid')
        }}
      </button>
      <template v-if="workflowId && !loading && !loadError">
        <button
          class="btn"
          :class="{ 'btn-icon': !triggerSummary?.active }"
          type="button"
          :aria-label="t('builder.triggers.label')"
          :title="triggerSummary?.active ? t('builder.triggers.autoTitle', { text: triggerSummary.text }) : t('builder.triggers.title')"
          @click="scheduleModal = true"
        >
          <CalendarClock /><span v-if="triggerSummary?.active" class="sched-text">{{ triggerSummary.text }}</span>
        </button>
        <button class="btn btn-icon" type="button" :aria-label="t('common.actions.export')" :title="t('builder.exportTitle')" @click="exportWorkflow">
          <Download />
        </button>
      </template>
      <button class="btn" type="button" :disabled="saving || loading || (!dirty && !!workflowId)" :title="t('builder.saveTitle')" @click="save">
        <Save /> {{ saving ? t('common.actions.saving') : t('common.actions.save') }}
      </button>
      <button class="btn btn-primary" type="button" :disabled="loading || !!loadError" @click="openRun"><Play /> {{ t('common.actions.run') }}</button>
    </header>

    <div v-if="loadError" class="page">
      <div class="callout danger" role="alert"><CircleAlert /> {{ loadError }}</div>
      <button class="btn" type="button" style="margin-top: 12px" @click="load">{{ t('common.actions.retry') }}</button>
    </div>

    <div v-else class="body">
      <!-- Paleta -->
      <aside class="palette" :aria-label="t('builder.palette.label')">
        <div class="eyebrow">
          <Term id="agente">{{ t('builder.term.agents') }}</Term>
        </div>
        <p class="tiny faint">{{ t('builder.palette.dragHint') }}</p>
        <button
          v-for="agent in catalog.agents"
          :key="agent.id"
          class="pal-item"
          type="button"
          draggable="true"
          :title="agent.description || agent.role"
          @dragstart="onDragStart($event, 'agent', agent.id)"
          @click="addNode('agent', undefined, agent.id)"
        >
          <AgentAvatar :name="agent.name" :color="agent.color" :size="24" />
          <span class="truncate">{{ agent.name }}</span>
        </button>
        <RouterLink v-if="!catalog.agents.length" to="/agents/new" class="small">{{ t('builder.palette.createAgent') }}</RouterLink>

        <div class="eyebrow" style="margin-top: 14px">{{ t('builder.palette.blocks') }}</div>
        <button
          v-for="item in PALETTE"
          :key="item.kind"
          class="pal-item"
          type="button"
          draggable="true"
          :title="NODE_HINT[item.kind]"
          @dragstart="onDragStart($event, item.kind)"
          @click="addNode(item.kind)"
        >
          <span class="pal-ico"><component :is="item.icon" /></span>
          <span class="truncate">{{ NODE_LABEL[item.kind] }}</span>
        </button>
        <i18n-t keypath="builder.palette.help" tag="p" class="tiny faint help" scope="global">
          <template #node
            ><Term id="nodo">{{ t('builder.term.node') }}</Term></template
          >
          <template #condition
            ><Term id="condicion">{{ t('builder.term.condition') }}</Term></template
          >
        </i18n-t>
        <i18n-t keypath="builder.palette.shortcuts" tag="p" class="tiny faint help" scope="global">
          <template #undo
            ><kbd>{{ t('builder.keys.ctrl') }}</kbd
            >+<kbd>Z</kbd></template
          >
          <template #redo
            ><kbd>{{ t('builder.keys.ctrl') }}</kbd
            >+<kbd>{{ t('builder.keys.shift') }}</kbd
            >+<kbd>Z</kbd></template
          >
          <template #copy
            ><kbd>{{ t('builder.keys.ctrl') }}</kbd
            >+<kbd>C</kbd></template
          >
          <template #paste
            ><kbd>{{ t('builder.keys.ctrl') }}</kbd
            >+<kbd>V</kbd></template
          >
          <template #duplicate
            ><kbd>{{ t('builder.keys.ctrl') }}</kbd
            >+<kbd>D</kbd></template
          >
          <template #del
            ><kbd>{{ t('builder.keys.del') }}</kbd></template
          >
          <template #save
            ><kbd>{{ t('builder.keys.ctrl') }}</kbd
            >+<kbd>S</kbd></template
          >
        </i18n-t>
      </aside>

      <!-- Lienzo -->
      <div
        ref="canvas"
        class="canvas"
        role="region"
        :aria-label="t('builder.canvas.label')"
        aria-describedby="canvas-help"
        @dragover.prevent
        @drop.prevent="onDrop"
        @keydown.capture="onCanvasKey"
      >
        <p id="canvas-help" class="sr-only">{{ t('builder.canvas.help') }}</p>
        <div v-if="loading" class="skeleton" style="position: absolute; inset: 16px" aria-busy="true" />
        <VueFlow
          v-else
          :id="flowId"
          v-model:nodes="nodes"
          v-model:edges="edges"
          :min-zoom="0.25"
          :max-zoom="1.6"
          :delete-key-code="['Backspace', 'Delete']"
          :snap-to-grid="true"
          :snap-grid="[10, 10]"
          @connect="onConnect"
          @nodes-change="onNodesChange"
          @node-click="selectedId = $event.node.id"
          @pane-click="selectedId = null"
        >
          <template #node-af="p"><FlowNode :id="p.id" :data="p.data" :selected="p.id === selectedId" /></template>
          <Background :gap="20" :size="1.2" />
          <Controls :show-interactive="false" position="bottom-left" />
          <MiniMap pannable zoomable position="bottom-right" :width="150" :height="100" />
        </VueFlow>
      </div>

      <!-- Inspector -->
      <aside class="inspector" :aria-label="t('builder.inspector.label')">
        <template v-if="selected && selectedData">
          <div class="row between">
            <h2>{{ NODE_LABEL[selectedData.kind] }}</h2>
            <div class="row" style="gap: 2px">
              <button
                class="btn btn-ghost btn-icon btn-sm"
                type="button"
                :aria-label="t('builder.inspector.duplicate')"
                :title="t('common.actions.duplicate')"
                @click="duplicateSelected"
              >
                <Copy />
              </button>
              <button
                class="btn btn-ghost btn-icon btn-sm"
                type="button"
                :aria-label="t('builder.inspector.delete')"
                :title="t('common.actions.delete')"
                @click="removeSelected"
              >
                <Trash2 />
              </button>
            </div>
          </div>
          <button class="btn btn-sm" type="button" @click="showSettings"><Settings2 /> {{ t('builder.settings.title') }}</button>
          <p class="small muted">{{ NODE_HINT[selectedData.kind] }}.</p>

          <div v-for="(issue, i) in selectedIssues" :key="i" class="callout" :class="issue.level === 'error' ? 'danger' : 'warning'">
            <TriangleAlert /> <span>{{ issueText(issue) }}</span>
          </div>

          <div class="field">
            <label for="in-label">{{ t('builder.inspector.nodeLabel') }}</label>
            <input id="in-label" v-model="selectedData.label" class="input" maxlength="80" />
            <i18n-t keypath="builder.inspector.citedAs" tag="span" class="hint" scope="global">
              <template #id><code v-text="`{{${selected.id}}}`" /></template>
            </i18n-t>
          </div>

          <!-- Entrada -->
          <template v-if="selectedData.kind === 'input'">
            <div class="field">
              <label for="in-desc">{{ t('builder.input.asks') }}</label>
              <input id="in-desc" v-model="selectedData.config.description" class="input" :placeholder="t('builder.input.asksPlaceholder')" />
            </div>
            <div class="field">
              <label for="in-default">{{ t('builder.input.defaultValue') }}</label>
              <textarea
                id="in-default"
                v-model="selectedData.config.defaultValue"
                class="textarea"
                rows="3"
                :placeholder="t('builder.input.defaultPlaceholder')"
              />
            </div>
          </template>

          <!-- Agente -->
          <template v-else-if="selectedData.kind === 'agent'">
            <div class="field">
              <label for="in-agent"
                ><Term id="agente">{{ t('builder.agent.label') }}</Term></label
              >
              <select id="in-agent" v-model="selectedData.config.agentId" class="select" @change="onAgentChange">
                <option value="" disabled>{{ t('builder.select') }}</option>
                <option v-for="a in catalog.agents" :key="a.id" :value="a.id">{{ a.name }}{{ a.role ? ` — ${a.role}` : '' }}</option>
              </select>
              <RouterLink v-if="selectedData.config.agentId" class="hint" :to="`/agents/${selectedData.config.agentId}`">{{
                t('builder.agent.edit')
              }}</RouterLink>
            </div>
            <div class="field">
              <i18n-t keypath="builder.agent.taskLabel" tag="label" for="in-prompt" scope="global">
                <template #template
                  ><Term id="plantilla">{{ t('builder.term.template') }}</Term></template
                >
              </i18n-t>
              <textarea
                id="in-prompt"
                v-model="selectedData.config.prompt"
                data-tpl="prompt"
                class="textarea"
                rows="7"
                :placeholder="t('builder.agent.taskPlaceholder')"
              />
              <i18n-t keypath="builder.agent.taskHint" tag="span" class="hint" scope="global">
                <template #prompt
                  ><Term id="prompt">{{ t('builder.term.prompt') }}</Term></template
                >
              </i18n-t>
            </div>
          </template>

          <!-- Para cada -->
          <template v-else-if="selectedData.kind === 'foreach'">
            <div class="field">
              <i18n-t keypath="builder.foreach.itemsLabel" tag="label" for="in-items" scope="global">
                <template #template
                  ><Term id="plantilla">{{ t('builder.term.template') }}</Term></template
                >
              </i18n-t>
              <textarea
                id="in-items"
                v-model="selectedData.config.items"
                data-tpl="items"
                class="textarea"
                rows="2"
                style="min-height: 34px"
                :placeholder="t('builder.emptyUpstream')"
              />
              <i18n-t keypath="builder.foreach.itemsHint" tag="span" class="hint" scope="global">
                <template #json
                  ><Term id="json">{{ t('builder.term.json') }}</Term></template
                >
                <template #foreach
                  ><Term id="para-cada">{{ t('builder.term.forEach') }}</Term></template
                >
              </i18n-t>
            </div>
            <fieldset class="field plain">
              <legend class="label">{{ t('builder.foreach.runsWith') }}</legend>
              <div class="choices">
                <label v-for="opt in FOREACH_BODIES" :key="opt" class="choice" :class="{ active: selectedBody === opt }">
                  <input type="radio" name="foreach-body" :value="opt" :checked="selectedBody === opt" @change="setForeachBody(opt)" />
                  {{ t(`builder.foreach.body.${opt}`) }}
                </label>
              </div>
            </fieldset>

            <template v-if="selectedBody === 'agent'">
              <div class="field">
                <label for="in-agent">{{ t('builder.agent.label') }}</label>
                <select id="in-agent" v-model="selectedData.config.agentId" class="select">
                  <option value="" disabled>{{ t('builder.select') }}</option>
                  <option v-for="a in catalog.agents" :key="a.id" :value="a.id">{{ a.name }}{{ a.role ? ` — ${a.role}` : '' }}</option>
                </select>
              </div>
              <div class="field">
                <label for="in-prompt">{{ t('builder.foreach.taskLabel') }}</label>
                <textarea
                  id="in-prompt"
                  v-model="selectedData.config.prompt"
                  data-tpl="prompt"
                  class="textarea"
                  rows="6"
                  :placeholder="t('builder.foreach.taskPlaceholder')"
                />
                <i18n-t keypath="builder.foreach.taskHint" tag="span" class="hint" scope="global">
                  <template #item><code v-text="'{{item}}'" /></template>
                  <template #index><code v-text="'{{index}}'" /></template>
                  <template #total><code v-text="'{{total}}'" /></template>
                </i18n-t>
              </div>
            </template>

            <template v-else-if="selectedBody === 'tool'">
              <div class="field">
                <label for="in-tool"
                  ><Term id="herramienta">{{ t('builder.term.tool') }}</Term></label
                >
                <select id="in-tool" v-model="selectedData.config.tool" class="select" @change="selectedData.config.args = {}">
                  <option value="" disabled>{{ t('builder.select') }}</option>
                  <option v-for="tl in catalog.tools.filter((x) => x.enabled && x.name !== 'delegate_task')" :key="tl.name" :value="tl.name">
                    {{ toolTitle(tl) }} ({{ tl.name }})
                  </option>
                </select>
                <i18n-t keypath="builder.foreach.toolHint" tag="span" class="hint" scope="global">
                  <template #model
                    ><Term id="modelo">{{ t('builder.term.model') }}</Term></template
                  >
                  <template #item><code v-text="'{{item}}'" /></template>
                </i18n-t>
              </div>
            </template>

            <template v-else>
              <div class="field">
                <label for="in-subwf"
                  ><Term id="subworkflow">{{ t('builder.term.subworkflow') }}</Term></label
                >
                <select id="in-subwf" v-model="selectedData.config.workflowId" class="select">
                  <option value="" disabled>{{ t('builder.select') }}</option>
                  <option v-for="w in otherWorkflows" :key="w.id" :value="w.id">{{ w.name }}</option>
                </select>
                <span class="hint">{{ t('builder.foreach.subworkflowHint') }}</span>
              </div>
              <div class="field">
                <i18n-t keypath="builder.foreach.subInputLabel" tag="label" for="in-subinput" scope="global">
                  <template #template
                    ><Term id="plantilla">{{ t('builder.term.template') }}</Term></template
                  >
                </i18n-t>
                <textarea
                  id="in-subinput"
                  v-model="selectedData.config.input"
                  data-tpl="input"
                  class="textarea"
                  rows="2"
                  style="min-height: 34px"
                  placeholder="{{item}}"
                />
              </div>
            </template>
            <div class="form-grid" style="grid-template-columns: 1fr 1fr">
              <div class="field">
                <label for="in-conc">{{ t('builder.foreach.concurrency') }}</label>
                <input id="in-conc" v-model="concurrencyText" class="input" type="number" min="1" max="8" placeholder="2" />
              </div>
              <div class="field">
                <label for="in-max">{{ t('builder.foreach.maxItems') }}</label>
                <input id="in-max" v-model="maxItemsText" class="input" type="number" min="1" max="100" placeholder="20" />
              </div>
            </div>
            <div class="field">
              <label for="in-format">{{ t('builder.foreach.result') }}</label>
              <select
                id="in-format"
                class="select"
                :value="selectedData.config.format ?? 'sections'"
                @change="selectedData.config.format = ($event.target as HTMLSelectElement).value"
              >
                <option value="sections">{{ t('builder.foreach.resultSections') }}</option>
                <option value="json">{{ t('builder.foreach.resultJson') }}</option>
              </select>
            </div>
            <div class="field">
              <label for="in-itemerror">{{ t('builder.foreach.onError') }}</label>
              <select
                id="in-itemerror"
                class="select"
                :value="selectedData.config.onItemError ?? 'fail'"
                @change="selectedData.config.onItemError = ($event.target as HTMLSelectElement).value"
              >
                <option value="fail">{{ t('builder.foreach.onErrorFail') }}</option>
                <option value="continue">{{ t('builder.foreach.onErrorContinue') }}</option>
              </select>
              <span class="hint">{{ t('builder.foreach.retryHint') }}</span>
            </div>
          </template>

          <!-- Subworkflow -->
          <template v-else-if="selectedData.kind === 'subworkflow'">
            <div class="field">
              <label for="in-subwf"
                ><Term id="subworkflow">{{ t('builder.term.subworkflow') }}</Term></label
              >
              <select id="in-subwf" v-model="selectedData.config.workflowId" class="select">
                <option value="" disabled>{{ t('builder.select') }}</option>
                <option v-for="w in otherWorkflows" :key="w.id" :value="w.id">{{ w.name }}</option>
              </select>
              <RouterLink v-if="selectedData.config.workflowId" class="hint link" :to="`/workflows/${selectedData.config.workflowId}`">{{
                t('builder.subworkflow.open')
              }}</RouterLink>
              <span v-else-if="!otherWorkflows.length" class="hint">{{ t('builder.subworkflow.none') }}</span>
            </div>
            <div class="field">
              <i18n-t keypath="builder.subworkflow.inputLabel" tag="label" for="in-subinput" scope="global">
                <template #template
                  ><Term id="plantilla">{{ t('builder.term.template') }}</Term></template
                >
              </i18n-t>
              <textarea
                id="in-subinput"
                v-model="selectedData.config.input"
                data-tpl="input"
                class="textarea"
                rows="3"
                :placeholder="t('builder.emptyUpstream')"
              />
              <span class="hint">{{ t('builder.subworkflow.hint') }}</span>
            </div>
          </template>

          <!-- Aprobación humana -->
          <template v-else-if="selectedData.kind === 'approval'">
            <div class="field">
              <i18n-t keypath="builder.approval.label" tag="label" for="in-message" scope="global">
                <template #template
                  ><Term id="plantilla">{{ t('builder.term.template') }}</Term></template
                >
              </i18n-t>
              <textarea
                id="in-message"
                v-model="selectedData.config.message"
                data-tpl="message"
                class="textarea"
                rows="6"
                :placeholder="t('builder.approval.placeholder')"
              />
              <i18n-t keypath="builder.approval.hint" tag="span" class="hint" scope="global">
                <template #approval
                  ><Term id="aprobacion">{{ t('builder.term.approval') }}</Term></template
                >
              </i18n-t>
            </div>
            <i18n-t keypath="builder.approval.branches" tag="p" class="small muted" scope="global">
              <template #yes
                ><strong style="color: var(--success)">{{ t('flow.branch.yes') }}</strong></template
              >
              <template #no
                ><strong style="color: var(--danger)">{{ t('flow.branch.no') }}</strong></template
              >
              <template #ref><code v-text="`{{${selected.id}.comment}}`" /></template>
            </i18n-t>
            <div class="field">
              <i18n-t keypath="builder.approval.timeoutLabel" tag="label" for="in-timeout" scope="global">
                <template #timeout
                  ><Term id="timeout">{{ t('builder.term.maxWait') }}</Term></template
                >
              </i18n-t>
              <input id="in-timeout" v-model="timeoutSecText" class="input" type="number" min="0" :placeholder="t('builder.noLimit')" />
              <span class="hint">{{ t('builder.approval.timeoutHint') }}</span>
            </div>
          </template>

          <!-- Herramienta (nodo propio) -->
          <template v-else-if="selectedData.kind === 'tool'">
            <div class="field">
              <label for="in-tool"
                ><Term id="herramienta">{{ t('builder.term.tool') }}</Term></label
              >
              <select id="in-tool" v-model="selectedData.config.tool" class="select" @change="onToolChange">
                <option value="" disabled>{{ t('builder.select') }}</option>
                <option v-for="tl in catalog.tools.filter((x) => x.enabled && x.name !== 'delegate_task')" :key="tl.name" :value="tl.name">
                  {{ toolTitle(tl) }} ({{ tl.name }})
                </option>
              </select>
              <span v-if="selectedTool" class="hint">{{ toolDescription(selectedTool) }}</span>
            </div>
          </template>

          <!-- Argumentos de la herramienta (nodo herramienta o cuerpo de un «para cada») -->
          <template v-if="selectedData.kind === 'tool' || (selectedData.kind === 'foreach' && selectedBody === 'tool')">
            <template v-if="selectedTool">
              <div v-for="(prop, name) in selectedTool.parameters.properties" :key="name" class="field">
                <label :for="`arg-${name}`">
                  <code>{{ name }}</code>
                  <span v-if="selectedTool.parameters.required?.includes(String(name))" class="badge" style="height: 18px">{{
                    t('builder.tool.required')
                  }}</span>
                </label>
                <select
                  v-if="prop.type === 'boolean'"
                  :id="`arg-${name}`"
                  class="select"
                  :value="argText(String(name))"
                  @change="setArg(String(name), ($event.target as HTMLSelectElement).value)"
                >
                  <option value="">{{ t('builder.tool.default') }}</option>
                  <option value="true">{{ t('builder.tool.yes') }}</option>
                  <option value="false">{{ t('builder.tool.no') }}</option>
                </select>
                <select
                  v-else-if="prop.enum"
                  :id="`arg-${name}`"
                  class="select"
                  :value="argText(String(name))"
                  @change="setArg(String(name), ($event.target as HTMLSelectElement).value)"
                >
                  <option value="">{{ t('builder.tool.default') }}</option>
                  <option v-for="o in prop.enum" :key="String(o)" :value="String(o)">{{ o }}</option>
                </select>
                <textarea
                  v-else
                  :id="`arg-${name}`"
                  class="textarea"
                  :rows="['content', 'body', 'code', 'value', 'task'].includes(String(name)) ? 5 : 1"
                  :data-tpl="`arg:${name}`"
                  :value="argText(String(name))"
                  :placeholder="toolParamDescription(selectedTool, String(name), prop)"
                  style="min-height: 34px"
                  @input="setArg(String(name), ($event.target as HTMLTextAreaElement).value)"
                />
                <span class="hint">{{ toolParamDescription(selectedTool, String(name), prop) }}</span>
              </div>
            </template>
          </template>

          <!-- Condición -->
          <template v-if="selectedData.kind === 'condition'">
            <div class="field">
              <i18n-t keypath="builder.condition.left" tag="label" for="in-left" scope="global">
                <template #template
                  ><Term id="plantilla">{{ t('builder.term.template') }}</Term></template
                >
              </i18n-t>
              <textarea id="in-left" v-model="selectedData.config.left" data-tpl="left" class="textarea" rows="2" style="min-height: 34px" />
            </div>
            <div class="field">
              <label for="in-op">{{ t('builder.condition.operator') }}</label>
              <select id="in-op" v-model="selectedData.config.operator" class="select">
                <option v-for="value in OPERATORS" :key="value" :value="value">{{ OPERATOR_LABEL[value] }}</option>
              </select>
            </div>
            <div v-if="!UNARY.has(selectedData.config.operator)" class="field">
              <label for="in-right">{{ t('builder.condition.value') }}</label>
              <input id="in-right" v-model="selectedData.config.right" data-tpl="right" class="input" :placeholder="t('builder.condition.valuePlaceholder')" />
            </div>
            <i18n-t keypath="builder.condition.branches" tag="p" class="small muted" scope="global">
              <template #yes
                ><strong style="color: var(--success)">{{ t('flow.branch.yes') }}</strong></template
              >
              <template #no
                ><strong style="color: var(--danger)">{{ t('flow.branch.no') }}</strong></template
              >
            </i18n-t>
          </template>

          <!-- Transformación / Salida -->
          <template v-if="selectedData.kind === 'transform' || selectedData.kind === 'output'">
            <div class="field">
              <label for="in-tpl"
                ><Term id="plantilla">{{ t('builder.term.templateCap') }}</Term></label
              >
              <textarea
                id="in-tpl"
                v-model="selectedData.config.template"
                data-tpl="template"
                class="textarea"
                rows="6"
                :placeholder="selectedData.kind === 'output' ? t('builder.template.emptyOutput') : t('builder.template.text')"
              />
            </div>
          </template>

          <div v-if="selectedData.kind !== 'input'" class="refs">
            <div class="eyebrow">{{ t('builder.inspector.insertRef') }}</div>
            <div class="row wrap" style="gap: 5px">
              <button
                v-for="r in availableRefs"
                :key="r.ref"
                class="chip"
                type="button"
                :title="r.hint"
                @mousedown.prevent
                @click="insertRef(r.ref)"
                v-text="`{{${r.ref}}}`"
              />
            </div>
          </div>

          <template
            v-if="selectedData.kind === 'agent' || selectedData.kind === 'tool' || selectedData.kind === 'foreach' || selectedData.kind === 'subworkflow'"
          >
            <div class="form-grid" style="grid-template-columns: 1fr 1fr">
              <div class="field">
                <label for="in-retries"
                  ><Term id="reintento">{{ t('builder.term.retries') }}</Term></label
                >
                <input
                  id="in-retries"
                  v-model="retriesText"
                  class="input"
                  type="number"
                  min="0"
                  max="5"
                  :placeholder="t('builder.limits.retriesDefault', { value: settings.defaultRetries })"
                />
              </div>
              <div class="field">
                <i18n-t keypath="builder.limits.timeoutLabel" tag="label" for="in-timeout" scope="global">
                  <template #timeout
                    ><Term id="timeout">{{ t('builder.term.maxTime') }}</Term></template
                  >
                </i18n-t>
                <input id="in-timeout" v-model="timeoutSecText" class="input" type="number" min="0" :placeholder="t('builder.noLimit')" />
              </div>
            </div>
          </template>

          <!-- Conexiones: la alternativa a arrastrar de un punto a otro en el lienzo. -->
          <section class="connections" :aria-label="t('builder.connections.label')">
            <div class="eyebrow">{{ t('builder.connections.title') }}</div>
            <ul v-if="incoming.length || outgoing.length" class="edge-list">
              <li v-for="e in incoming" :key="e.id">
                <i18n-t keypath="builder.connections.receivesFrom" tag="span" class="small" scope="global">
                  <template #name
                    ><strong>{{ nodeName(e.source) }}</strong></template
                  >
                  <template #branch>{{ branchText(e.sourceHandle) }}</template>
                </i18n-t>
                <button
                  class="btn btn-ghost btn-icon btn-sm"
                  type="button"
                  :aria-label="t('builder.connections.removeIncoming', { name: nodeName(e.source) })"
                  :title="t('builder.connections.removeTitle')"
                  @click="removeEdge(e)"
                >
                  <Unlink />
                </button>
              </li>
              <li v-for="e in outgoing" :key="e.id">
                <i18n-t keypath="builder.connections.sendsTo" tag="span" class="small" scope="global">
                  <template #name
                    ><strong>{{ nodeName(e.target) }}</strong></template
                  >
                  <template #branch>{{ branchText(e.sourceHandle) }}</template>
                </i18n-t>
                <button
                  class="btn btn-ghost btn-icon btn-sm"
                  type="button"
                  :aria-label="t('builder.connections.removeOutgoing', { name: nodeName(e.target) })"
                  :title="t('builder.connections.removeTitle')"
                  @click="removeEdge(e)"
                >
                  <Unlink />
                </button>
              </li>
            </ul>
            <p v-else class="small faint" style="margin: 0">{{ t('builder.connections.none') }}</p>
            <div v-if="connectOptions.length" class="row connect-row">
              <select v-model="connectChoice" class="select" :aria-label="t('builder.connections.selectLabel')">
                <option value="">{{ t('builder.connections.selectPlaceholder') }}</option>
                <option v-for="o in connectOptions" :key="optionKey(o)" :value="optionKey(o)">{{ nodeName(o.target) }}{{ branchSuffix(o.branch) }}</option>
              </select>
              <button class="btn btn-sm" type="button" :disabled="!connectChoice" @click="connectChosen">
                <Link2 /> {{ t('builder.connections.connect') }}
              </button>
            </div>
          </section>
        </template>

        <!-- Ajustes del workflow -->
        <template v-else>
          <h2 class="row"><Settings2 style="width: 16px; height: 16px" /> {{ t('builder.settings.title') }}</h2>
          <div class="field">
            <label for="wf-desc">{{ t('builder.settings.description') }}</label>
            <textarea
              id="wf-desc"
              v-model="meta.description"
              class="textarea"
              rows="3"
              maxlength="2000"
              :placeholder="t('builder.settings.descriptionPlaceholder')"
            />
          </div>
          <div class="form-grid" style="grid-template-columns: 1fr 1fr">
            <div class="field">
              <label for="wf-conc"
                ><Term id="concurrencia">{{ t('builder.term.concurrency') }}</Term></label
              >
              <input id="wf-conc" v-model.number="settings.maxConcurrency" class="input" type="number" min="1" max="16" />
            </div>
            <div class="field">
              <label for="wf-retries"
                ><Term id="reintento">{{ t('builder.term.retries') }}</Term></label
              >
              <input id="wf-retries" v-model.number="settings.defaultRetries" class="input" type="number" min="0" max="5" />
            </div>
            <div class="field">
              <label for="wf-dur">{{ t('builder.settings.maxDuration') }}</label>
              <input id="wf-dur" v-model.number="durationMin" class="input" type="number" min="0.1" step="0.5" />
            </div>
            <div class="field">
              <i18n-t keypath="builder.settings.maxLlmCalls" tag="label" for="wf-calls" scope="global">
                <template #llm><Term id="llm">LLM</Term></template>
              </i18n-t>
              <input id="wf-calls" v-model.number="settings.maxLlmCalls" class="input" type="number" min="1" max="500" />
            </div>
          </div>
          <div class="field">
            <span class="label">{{ t('builder.settings.onError') }}</span>
            <div class="segmented" role="radiogroup" :aria-label="t('builder.settings.policy')">
              <button
                type="button"
                role="radio"
                :aria-checked="settings.onError === 'fail'"
                :class="{ active: settings.onError === 'fail' }"
                @click="settings.onError = 'fail'"
              >
                {{ t('builder.settings.stopAll') }}
              </button>
              <button
                type="button"
                role="radio"
                :aria-checked="settings.onError === 'continue'"
                :class="{ active: settings.onError === 'continue' }"
                @click="settings.onError = 'continue'"
              >
                {{ t('builder.settings.continueRest') }}
              </button>
            </div>
          </div>

          <div class="validation">
            <div class="eyebrow">{{ t('builder.settings.validation') }}</div>
            <p v-if="!issues.length" class="small row" style="color: var(--success)">
              <CircleCheck style="width: 15px; height: 15px" /> {{ t('builder.settings.valid') }}
            </p>
            <button
              v-for="(issue, i) in issues"
              :key="i"
              class="issue"
              :class="issue.level"
              type="button"
              :disabled="!issue.nodeId"
              @click="selectedId = issue.nodeId ?? null"
            >
              <component :is="issue.level === 'error' ? CircleAlert : TriangleAlert" />
              <span>{{ issueText(issue) }}</span>
            </button>
          </div>
          <div class="validation node-index">
            <div class="eyebrow">{{ t('builder.settings.nodes') }}</div>
            <ul class="node-list" :aria-label="t('builder.settings.nodesList')">
              <li v-for="n in nodes" :key="n.id">
                <button class="issue" type="button" @click="editNode(n.id)">
                  <span class="grow">{{ n.data!.label || n.id }}</span>
                  <span class="tiny faint">{{ NODE_LABEL[n.data!.kind] }}</span>
                </button>
              </li>
            </ul>
          </div>
          <p class="tiny faint">{{ t('builder.settings.selectHint') }}</p>
        </template>
      </aside>
    </div>

    <TriggersModal
      v-if="scheduleModal && workflowId"
      :workflow-id="workflowId"
      :workflow-name="meta.name"
      :default-input="String(inputNode?.data?.config.defaultValue ?? '')"
      @close="scheduleModal = false"
      @changed="triggers = $event"
    />

    <AppModal v-if="runModal" :title="t('builder.run.title')" @close="runModal = false">
      <div class="field">
        <label for="run-input">{{ inputNode?.data?.config.description || t('builder.run.inputFallback') }}</label>
        <textarea id="run-input" v-model="runInput" class="textarea" rows="5" :placeholder="t('builder.run.placeholder')" @keydown.ctrl.enter="launch" />
        <i18n-t keypath="builder.run.hint" tag="span" class="hint" scope="global">
          <template #nodes
            ><Term id="nodo">{{ t('builder.term.nodes') }}</Term></template
          >
          <template #input><code v-text="'{{input}}'" /></template>
        </i18n-t>
      </div>
      <p v-if="dirty" class="small muted" style="margin-top: 10px">{{ t('builder.run.pending') }}</p>
      <template #footer>
        <button class="btn" type="button" @click="runModal = false">{{ t('common.actions.cancel') }}</button>
        <button class="btn btn-primary" type="button" :disabled="launching" @click="launch">
          <Play /> {{ launching ? t('builder.run.launching') : t('common.actions.run') }}
        </button>
      </template>
    </AppModal>
  </div>
</template>

<style scoped>
.field.plain {
  border: 0;
  padding: 0;
  margin: 0;
  min-width: 0;
}
.choices {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.choice {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: 13.5px;
}
.choice.active {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.choice input {
  accent-color: var(--accent);
}
.hint.link {
  color: var(--accent);
  text-decoration: underline;
}
.builder {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  flex-wrap: wrap;
}
.sched-text {
  font-size: 12.5px;
}
.edit-tools {
  gap: 2px;
}
.connections {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}
.edge-list,
.node-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.edge-list li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  min-width: 0;
}
.edge-list li span {
  overflow-wrap: anywhere;
}
.connect-row {
  gap: 6px;
}
.connect-row .select {
  min-width: 0;
}
kbd {
  padding: 0 4px;
  border: 1px solid var(--border-strong);
  border-radius: 4px;
  background: var(--surface-2);
  font-family: var(--font-mono);
  font-size: 10.5px;
}
.name {
  flex: 1 1 220px;
  min-width: 0;
  max-width: 460px;
  height: 34px;
  padding: 0 8px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: none;
  color: var(--text);
  font-family: var(--font-display);
  font-size: 17px;
  font-weight: 650;
}
.name:hover {
  border-color: var(--border);
}
.name:focus {
  outline: none;
  border-color: var(--accent);
  background: var(--surface);
}
.check-badge {
  border: 0;
  cursor: pointer;
  font-family: inherit;
}
.body {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 196px minmax(0, 1fr) 330px;
}
.palette,
.inspector {
  background: var(--surface);
  overflow-y: auto;
  padding: 14px 12px;
  display: flex;
  flex-direction: column;
}
.palette {
  border-right: 1px solid var(--border);
  gap: 4px;
}
.inspector {
  border-left: 1px solid var(--border);
  gap: 13px;
  padding: 16px;
}
.pal-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text);
  font: inherit;
  font-size: 13px;
  font-weight: 550;
  text-align: left;
  cursor: grab;
}
.pal-item:hover {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.pal-ico {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 7px;
  background: var(--surface-2);
  color: var(--text-2);
  flex: none;
}
.pal-ico svg {
  width: 14px;
  height: 14px;
}
.help {
  margin-top: auto;
  padding-top: 14px;
}
.canvas {
  position: relative;
  min-height: 0;
  min-width: 0;
}
.refs {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.chip {
  border: 1px solid var(--border);
  background: var(--surface-2);
  color: var(--text-2);
  font-family: var(--font-mono);
  font-size: 11.5px;
  padding: 2px 7px;
  border-radius: 6px;
  cursor: pointer;
}
.chip:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.validation {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}
.issue {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  padding: 7px 9px;
  border: 0;
  border-radius: 8px;
  font: inherit;
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
  background: var(--warning-soft);
  color: var(--warning);
}
.issue.error {
  background: var(--danger-soft);
  color: var(--danger);
}
/* La lista de nodos reutiliza la forma de la lista de validación, pero no es un aviso: colores neutros. */
.node-index .issue {
  width: 100%;
  align-items: center;
  background: var(--surface-2);
  color: var(--text);
}
.node-index .issue:hover {
  background: var(--surface-3);
}
.issue:disabled {
  cursor: default;
}
.issue svg {
  width: 14px;
  height: 14px;
  flex: none;
  margin-top: 2px;
}
@media (max-width: 1100px) {
  .body {
    grid-template-columns: 170px minmax(0, 1fr);
    grid-template-rows: minmax(360px, 1fr) auto;
    overflow-y: auto;
  }
  .inspector {
    grid-column: 1 / -1;
    border-left: 0;
    border-top: 1px solid var(--border);
    overflow: visible;
  }
}
@media (max-width: 640px) {
  .body {
    grid-template-columns: 1fr;
    grid-template-rows: auto minmax(340px, 55vh) auto;
  }
  .palette {
    flex-direction: row;
    flex-wrap: wrap;
    border-right: 0;
    border-bottom: 1px solid var(--border);
    padding: 8px 10px;
  }
  .palette .eyebrow,
  .palette p {
    display: none;
  }
  .pal-item span.truncate {
    max-width: 90px;
  }
}
</style>
