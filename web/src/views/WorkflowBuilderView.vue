<script setup lang="ts">
// Constructor visual de workflows: paleta → lienzo (Vue Flow) → inspector.
import { ancestorsOf, slugifyNodeId, topologicalOrder, validateWorkflow } from '@shared/graph';
import { DEFAULT_WORKFLOW_SETTINGS, type NodeType, type ValidationIssue, type WorkflowInput, type WorkflowSettings } from '@shared/types';
import { Background } from '@vue-flow/background';
import { Controls } from '@vue-flow/controls';
import { useVueFlow, VueFlow, type Connection, type Edge } from '@vue-flow/core';
import { MiniMap } from '@vue-flow/minimap';
import {
  ArrowLeft,
  Bot,
  CircleAlert,
  CircleCheck,
  Copy,
  Flag,
  GitBranch,
  LogIn,
  Play,
  Save,
  Settings2,
  Shuffle,
  Trash2,
  TriangleAlert,
  Wrench,
} from 'lucide-vue-next';
import { computed, nextTick, onMounted, reactive, ref, watch, type Ref } from 'vue';
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router';
import AgentAvatar from '@/components/AgentAvatar.vue';
import AppModal from '@/components/AppModal.vue';
import FlowNode from '@/components/FlowNode.vue';
import Term from '@/components/Term.vue';
import { api, errorText } from '@/lib/api';
import { fromFlow, NODE_HINT, OPERATOR_LABEL, toFlowEdge, toFlowNode, type FlowNode as FlowNodeT, type FlowNodeData } from '@/lib/flow';
import { NODE_LABEL } from '@/lib/format';
import { useCatalog } from '@/stores/catalog';
import { useUi } from '@/stores/ui';

const route = useRoute();
const router = useRouter();
const catalog = useCatalog();
const ui = useUi();

const flowId = `builder-${Math.random().toString(36).slice(2)}`;
const { screenToFlowCoordinate, viewport, fitView, removeNodes, onNodesInitialized } = useVueFlow(flowId);
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
  { kind: 'transform', icon: Shuffle },
  { kind: 'output', icon: Flag },
];
const OPERATORS = Object.entries(OPERATOR_LABEL);
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
  validateWorkflow(definition.value, { agentIds: catalog.agents.map((a) => a.id), toolNames: catalog.enabledToolNames }),
);
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
  const refs: Array<{ ref: string; hint: string }> = [{ ref: 'input', hint: 'Texto de entrada del workflow' }];
  if (def.edges.some((e) => e.target === selected.value!.id)) refs.push({ ref: 'upstream', hint: 'Resultado de los nodos conectados a este' });
  const ancestors = ancestorsOf(selected.value.id, def.edges);
  for (const n of def.nodes) {
    if (ancestors.has(n.id) && n.type !== 'input' && n.type !== 'condition') refs.push({ ref: n.id, hint: `Resultado de «${n.label || n.id}»` });
  }
  return refs;
});

const selectedTool = computed(() => (selectedData.value?.kind === 'tool' ? catalog.toolByName.get(selectedData.value.config.tool) : undefined));

// ---------- Carga ----------
onMounted(async () => {
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
      meta.name = 'Nuevo workflow';
      nodes.value = [
        toFlowNode({ id: 'entrada', type: 'input', label: 'Entrada', position: { x: 40, y: 160 }, config: { description: '', defaultValue: '' } }),
        toFlowNode({ id: 'salida', type: 'output', label: 'Salida', position: { x: 640, y: 160 }, config: { template: '' } }),
      ];
    }
    loading.value = false;
    await nextTick();
    saved.value = workflowId.value ? serialized.value : '';
  } catch (err) {
    loadError.value = errorText(err);
    loading.value = false;
  }
});

// ---------- Edición del grafo ----------
function addNode(kind: NodeType, position?: { x: number; y: number }, agentId?: string): void {
  const agent = agentId ? catalog.agentById.get(agentId) : undefined;
  const label = agent?.name ?? (kind === 'condition' ? '¿Condición?' : NODE_LABEL[kind]);
  const config: Record<string, any> =
    kind === 'agent'
      ? { agentId: agentId ?? '', prompt: '{{upstream}}' }
      : kind === 'tool'
        ? { tool: '', args: {} }
        : kind === 'condition'
          ? { left: '{{upstream}}', operator: 'contains', right: '' }
          : kind === 'transform'
            ? { template: '{{upstream}}' }
            : kind === 'input'
              ? { description: '', defaultValue: '' }
              : { template: '' };
  const id = slugifyNodeId(label, nodes.value.map((n) => n.id));
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
    // Desde una condición se usa la primera rama libre (sí y, si ya está ocupada, no).
    const branch = anchorKind === 'condition' ? (['true', 'false'].find((h) => !edges.value.some((e) => e.source === anchor.id && e.sourceHandle === h)) ?? null) : null;
    if (anchorKind !== 'condition' || branch) onConnect({ source: anchor.id, target: id, sourceHandle: branch, targetHandle: null });
  }
  selectedId.value = id;
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

function onDragStart(ev: DragEvent, kind: NodeType, agentId?: string): void {
  ev.dataTransfer?.setData('application/agentforge-node', JSON.stringify({ kind, agentId }));
  if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'copy';
}
function onDrop(ev: DragEvent): void {
  const raw = ev.dataTransfer?.getData('application/agentforge-node');
  if (!raw) return;
  const { kind, agentId } = JSON.parse(raw) as { kind: NodeType; agentId?: string };
  const p = screenToFlowCoordinate({ x: ev.clientX, y: ev.clientY });
  addNode(kind, { x: p.x - 104, y: p.y - 36 }, agentId);
}

function onConnect(c: Connection): void {
  if (!c.source || !c.target || c.source === c.target) return;
  const source = nodes.value.find((n) => n.id === c.source);
  const handle = source?.data?.kind === 'condition' ? (c.sourceHandle === 'false' ? 'false' : 'true') : null;
  if (edges.value.some((e) => e.source === c.source && e.target === c.target && (e.sourceHandle ?? null) === handle)) return;
  const candidate = { id: `${c.source}-${handle ?? 'out'}-${c.target}`, source: c.source, target: c.target, sourceHandle: handle };
  const def = definition.value;
  if (topologicalOrder(def.nodes, [...def.edges, candidate]) === null) {
    ui.error('Esa conexión crearía un ciclo: un workflow no puede volver a un nodo anterior.');
    return;
  }
  edges.value = [...edges.value, toFlowEdge(candidate)];
}

function removeSelected(): void {
  if (selectedId.value) removeNodes([selectedId.value]);
}

function duplicateSelected(): void {
  const src = selected.value;
  if (!src?.data) return;
  const id = slugifyNodeId(src.data.label || src.id, nodes.value.map((n) => n.id));
  nodes.value = [
    ...nodes.value,
    toFlowNode({ id, type: src.data.kind, label: src.data.label, position: { x: src.position.x + 40, y: src.position.y + 60 }, config: src.data.config }),
  ];
  selectedId.value = id;
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
  const main = data.kind === 'agent' ? 'prompt' : data.kind === 'condition' ? 'left' : 'template';
  if (data.kind === 'tool') return void navigator.clipboard?.writeText(token).then(() => ui.info(`${token} copiado al portapapeles.`));
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
  if (tool && (!data.label || data.label === NODE_LABEL.tool)) data.label = tool.title;
}
function onAgentChange(): void {
  const data = selectedData.value;
  const agent = data ? catalog.agentById.get(data.config.agentId) : undefined;
  if (data && agent && (!data.label || data.label === NODE_LABEL.agent || catalog.agents.some((a) => a.name === data.label))) data.label = agent.name;
}

const optionalNumber = (key: 'retries' | 'timeoutMs', scale = 1) =>
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
const durationMin = computed({
  get: () => Math.round(settings.maxDurationMs / 6000) / 10,
  set: (v: number) => (settings.maxDurationMs = Math.max(1000, Math.round((Number(v) || 1) * 60_000))),
});

// ---------- Guardar y ejecutar ----------
async function save(): Promise<boolean> {
  if (!meta.name.trim()) {
    ui.error('Ponle un nombre al workflow.');
    return false;
  }
  saving.value = true;
  try {
    const wf = workflowId.value ? await api.workflows.update(workflowId.value, definition.value) : await api.workflows.create(definition.value);
    catalog.setWorkflow(wf);
    saved.value = serialized.value;
    ui.success('Workflow guardado.');
    if (!workflowId.value) await router.replace(`/workflows/${wf.id}`);
    return true;
  } catch (err) {
    ui.error(errorText(err));
    return false;
  } finally {
    saving.value = false;
  }
}

const runModal = ref(false);
const runInput = ref('');
const launching = ref(false);
const inputNode = computed(() => nodes.value.find((n) => n.data?.kind === 'input'));

function openRun(): void {
  if (errors.value.length) {
    ui.error(`Corrige ${errors.value.length === 1 ? 'el error' : `los ${errors.value.length} errores`} antes de ejecutar.`);
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
  return ui.confirm({ title: 'Cambios sin guardar', message: 'Si sales ahora perderás los cambios de este workflow.', confirmLabel: 'Salir sin guardar', danger: true });
});
</script>

<template>
  <div class="builder">
    <header class="bar">
      <RouterLink class="btn btn-ghost btn-icon" to="/workflows" aria-label="Volver a workflows"><ArrowLeft /></RouterLink>
      <input v-model="meta.name" class="name" aria-label="Nombre del workflow" placeholder="Nombre del workflow" maxlength="120" />
      <span class="grow" />
      <span v-if="dirty" class="badge warning">Sin guardar</span>
      <button
        v-if="!loading"
        class="badge check-badge"
        :class="errors.length ? 'danger' : warnings.length ? 'warning' : 'success'"
        type="button"
        title="Ver la validación del workflow"
        @click="selectedId = null"
      >
        <component :is="errors.length ? CircleAlert : warnings.length ? TriangleAlert : CircleCheck" />
        {{ errors.length ? `${errors.length} error${errors.length > 1 ? 'es' : ''}` : warnings.length ? `${warnings.length} aviso${warnings.length > 1 ? 's' : ''}` : 'Válido' }}
      </button>
      <button class="btn" type="button" :disabled="saving || loading || (!dirty && !!workflowId)" @click="save"><Save /> {{ saving ? 'Guardando…' : 'Guardar' }}</button>
      <button class="btn btn-primary" type="button" :disabled="loading || !!loadError" @click="openRun"><Play /> Ejecutar</button>
    </header>

    <div v-if="loadError" class="page"><div class="callout danger" role="alert"><CircleAlert /> {{ loadError }}</div></div>

    <div v-else class="body">
      <!-- Paleta -->
      <aside class="palette" aria-label="Paleta de nodos">
        <div class="eyebrow"><Term id="agente">Agentes</Term></div>
        <p class="tiny faint">Arrastra al lienzo o haz clic.</p>
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
        <RouterLink v-if="!catalog.agents.length" to="/agents/new" class="small">Crea tu primer agente</RouterLink>

        <div class="eyebrow" style="margin-top: 14px">Bloques</div>
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
        <p class="tiny faint help">Con un <Term id="nodo">nodo</Term> seleccionado, el siguiente que añadas se conecta a él (desde una <Term id="condicion">condición</Term>, a su primera rama libre). También puedes unir los puntos a mano. Supr borra el nodo o la conexión seleccionados.</p>
      </aside>

      <!-- Lienzo -->
      <div ref="canvas" class="canvas" @dragover.prevent @drop.prevent="onDrop">
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
      <aside class="inspector" aria-label="Propiedades">
        <template v-if="selected && selectedData">
          <div class="row between">
            <h2>{{ NODE_LABEL[selectedData.kind] }}</h2>
            <div class="row" style="gap: 2px">
              <button class="btn btn-ghost btn-icon btn-sm" type="button" aria-label="Duplicar nodo" title="Duplicar" @click="duplicateSelected"><Copy /></button>
              <button class="btn btn-ghost btn-icon btn-sm" type="button" aria-label="Eliminar nodo" title="Eliminar" @click="removeSelected"><Trash2 /></button>
            </div>
          </div>
          <p class="small muted">{{ NODE_HINT[selectedData.kind] }}.</p>

          <div v-for="(issue, i) in selectedIssues" :key="i" class="callout" :class="issue.level === 'error' ? 'danger' : 'warning'">
            <TriangleAlert /> <span>{{ issue.message }}</span>
          </div>

          <div class="field">
            <label for="in-label">Etiqueta</label>
            <input id="in-label" v-model="selectedData.label" class="input" maxlength="80" />
            <span class="hint">
              Otros nodos lo citan como <code v-text="`{{${selected.id}}}`" />
            </span>
          </div>

          <!-- Entrada -->
          <template v-if="selectedData.kind === 'input'">
            <div class="field">
              <label for="in-desc">Qué se pide al usuario</label>
              <input id="in-desc" v-model="selectedData.config.description" class="input" placeholder="p. ej. Tema del informe" />
            </div>
            <div class="field">
              <label for="in-default">Valor de ejemplo</label>
              <textarea id="in-default" v-model="selectedData.config.defaultValue" class="textarea" rows="3" placeholder="Se propone al ejecutar" />
            </div>
          </template>

          <!-- Agente -->
          <template v-else-if="selectedData.kind === 'agent'">
            <div class="field">
              <label for="in-agent"><Term id="agente">Agente</Term></label>
              <select id="in-agent" v-model="selectedData.config.agentId" class="select" @change="onAgentChange">
                <option value="" disabled>Selecciona…</option>
                <option v-for="a in catalog.agents" :key="a.id" :value="a.id">{{ a.name }}{{ a.role ? ` — ${a.role}` : '' }}</option>
              </select>
              <RouterLink v-if="selectedData.config.agentId" class="hint" :to="`/agents/${selectedData.config.agentId}`">Editar este agente</RouterLink>
            </div>
            <div class="field">
              <label for="in-prompt">Tarea (<Term id="plantilla">plantilla</Term>)</label>
              <textarea id="in-prompt" v-model="selectedData.config.prompt" data-tpl="prompt" class="textarea" rows="7" placeholder="Qué debe hacer el agente en este paso…" />
              <span class="hint">Es el <Term id="prompt">prompt</Term> que recibe el agente en este paso, con las referencias ya sustituidas.</span>
            </div>
          </template>

          <!-- Herramienta -->
          <template v-else-if="selectedData.kind === 'tool'">
            <div class="field">
              <label for="in-tool"><Term id="herramienta">Herramienta</Term></label>
              <select id="in-tool" v-model="selectedData.config.tool" class="select" @change="onToolChange">
                <option value="" disabled>Selecciona…</option>
                <option v-for="t in catalog.tools.filter((x) => x.enabled && x.name !== 'delegate_task')" :key="t.name" :value="t.name">{{ t.title }} ({{ t.name }})</option>
              </select>
              <span v-if="selectedTool" class="hint">{{ selectedTool.description }}</span>
            </div>
            <template v-if="selectedTool">
              <div v-for="(prop, name) in selectedTool.parameters.properties" :key="name" class="field">
                <label :for="`arg-${name}`">
                  <code>{{ name }}</code>
                  <span v-if="selectedTool.parameters.required?.includes(String(name))" class="badge" style="height: 18px">obligatorio</span>
                </label>
                <select v-if="prop.type === 'boolean'" :id="`arg-${name}`" class="select" :value="argText(String(name))" @change="setArg(String(name), ($event.target as HTMLSelectElement).value)">
                  <option value="">Por defecto</option>
                  <option value="true">Sí</option>
                  <option value="false">No</option>
                </select>
                <select v-else-if="prop.enum" :id="`arg-${name}`" class="select" :value="argText(String(name))" @change="setArg(String(name), ($event.target as HTMLSelectElement).value)">
                  <option value="">Por defecto</option>
                  <option v-for="o in prop.enum" :key="String(o)" :value="String(o)">{{ o }}</option>
                </select>
                <textarea
                  v-else
                  :id="`arg-${name}`"
                  class="textarea"
                  :rows="['content', 'body', 'code', 'value', 'task'].includes(String(name)) ? 5 : 1"
                  :data-tpl="`arg:${name}`"
                  :value="argText(String(name))"
                  :placeholder="prop.description"
                  style="min-height: 34px"
                  @input="setArg(String(name), ($event.target as HTMLTextAreaElement).value)"
                />
                <span class="hint">{{ prop.description }}</span>
              </div>
            </template>
          </template>

          <!-- Condición -->
          <template v-else-if="selectedData.kind === 'condition'">
            <div class="field">
              <label for="in-left">Texto a evaluar (<Term id="plantilla">plantilla</Term>)</label>
              <textarea id="in-left" v-model="selectedData.config.left" data-tpl="left" class="textarea" rows="2" style="min-height: 34px" />
            </div>
            <div class="field">
              <label for="in-op">Operador</label>
              <select id="in-op" v-model="selectedData.config.operator" class="select">
                <option v-for="[value, label] in OPERATORS" :key="value" :value="value">{{ label }}</option>
              </select>
            </div>
            <div v-if="!UNARY.has(selectedData.config.operator)" class="field">
              <label for="in-right">Valor</label>
              <input id="in-right" v-model="selectedData.config.right" data-tpl="right" class="input" placeholder="p. ej. APROBADO" />
            </div>
            <p class="small muted">Conecta la salida <strong style="color: var(--success)">sí</strong> y la salida <strong style="color: var(--danger)">no</strong> a los nodos de cada rama. La rama no elegida se omite.</p>
          </template>

          <!-- Transformación / Salida -->
          <template v-else>
            <div class="field">
              <label for="in-tpl"><Term id="plantilla">Plantilla</Term></label>
              <textarea
                id="in-tpl"
                v-model="selectedData.config.template"
                data-tpl="template"
                class="textarea"
                rows="6"
                :placeholder="selectedData.kind === 'output' ? 'Vacío = el resultado de los nodos conectados' : 'Texto con referencias a otros nodos'"
              />
            </div>
          </template>

          <div v-if="selectedData.kind !== 'input'" class="refs">
            <div class="eyebrow">Insertar referencia</div>
            <div class="row wrap" style="gap: 5px">
              <button v-for="r in availableRefs" :key="r.ref" class="chip" type="button" :title="r.hint" @mousedown.prevent @click="insertRef(r.ref)" v-text="`{{${r.ref}}}`" />
            </div>
          </div>

          <template v-if="selectedData.kind === 'agent' || selectedData.kind === 'tool'">
            <div class="form-grid" style="grid-template-columns: 1fr 1fr">
              <div class="field">
                <label for="in-retries"><Term id="reintento">Reintentos</Term></label>
                <input id="in-retries" v-model="retriesText" class="input" type="number" min="0" max="5" :placeholder="`${settings.defaultRetries} (por defecto)`" />
              </div>
              <div class="field">
                <label for="in-timeout"><Term id="timeout">Tiempo máx.</Term> (s)</label>
                <input id="in-timeout" v-model="timeoutSecText" class="input" type="number" min="0" placeholder="Sin límite" />
              </div>
            </div>
          </template>
        </template>

        <!-- Ajustes del workflow -->
        <template v-else>
          <h2 class="row"><Settings2 style="width: 16px; height: 16px" /> Ajustes del workflow</h2>
          <div class="field">
            <label for="wf-desc">Descripción</label>
            <textarea id="wf-desc" v-model="meta.description" class="textarea" rows="3" maxlength="2000" placeholder="Para qué sirve este workflow" />
          </div>
          <div class="form-grid" style="grid-template-columns: 1fr 1fr">
            <div class="field">
              <label for="wf-conc"><Term id="concurrencia">Concurrencia</Term></label>
              <input id="wf-conc" v-model.number="settings.maxConcurrency" class="input" type="number" min="1" max="16" />
            </div>
            <div class="field">
              <label for="wf-retries"><Term id="reintento">Reintentos</Term></label>
              <input id="wf-retries" v-model.number="settings.defaultRetries" class="input" type="number" min="0" max="5" />
            </div>
            <div class="field">
              <label for="wf-dur">Duración máx. (min)</label>
              <input id="wf-dur" v-model.number="durationMin" class="input" type="number" min="0.1" step="0.5" />
            </div>
            <div class="field">
              <label for="wf-calls">Llamadas al <Term id="llm">LLM</Term> máx.</label>
              <input id="wf-calls" v-model.number="settings.maxLlmCalls" class="input" type="number" min="1" max="500" />
            </div>
          </div>
          <div class="field">
            <span class="label">Si un nodo falla</span>
            <div class="segmented" role="radiogroup" aria-label="Política de error">
              <button type="button" role="radio" :aria-checked="settings.onError === 'fail'" :class="{ active: settings.onError === 'fail' }" @click="settings.onError = 'fail'">Detener todo</button>
              <button type="button" role="radio" :aria-checked="settings.onError === 'continue'" :class="{ active: settings.onError === 'continue' }" @click="settings.onError = 'continue'">Continuar con el resto</button>
            </div>
          </div>

          <div class="validation">
            <div class="eyebrow">Validación</div>
            <p v-if="!issues.length" class="small row" style="color: var(--success)"><CircleCheck style="width: 15px; height: 15px" /> El workflow es válido y se puede ejecutar.</p>
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
              <span>{{ issue.message }}</span>
            </button>
          </div>
          <p class="tiny faint">Selecciona un nodo del lienzo para editar sus propiedades.</p>
        </template>
      </aside>
    </div>

    <AppModal v-if="runModal" title="Ejecutar workflow" @close="runModal = false">
      <div class="field">
        <label for="run-input">{{ inputNode?.data?.config.description || 'Entrada del workflow' }}</label>
        <textarea id="run-input" v-model="runInput" class="textarea" rows="5" placeholder="Texto con el que arranca el workflow" @keydown.ctrl.enter="launch" />
        <span class="hint">Disponible en los <Term id="nodo">nodos</Term> como <code v-text="'{{input}}'" />.</span>
      </div>
      <p v-if="dirty" class="small muted" style="margin-top: 10px">Los cambios pendientes se guardarán antes de ejecutar.</p>
      <template #footer>
        <button class="btn" type="button" @click="runModal = false">Cancelar</button>
        <button class="btn btn-primary" type="button" :disabled="launching" @click="launch"><Play /> {{ launching ? 'Lanzando…' : 'Ejecutar' }}</button>
      </template>
    </AppModal>
  </div>
</template>

<style scoped>
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
