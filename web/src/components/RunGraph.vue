<script setup lang="ts">
import { nodeSubworkflowId, nodeUsesAgent } from '@shared/graph';
// Grafo de solo lectura de una ejecución: cada nodo muestra su estado en vivo.
import type { RunSnapshot } from '@shared/types';
import { Background } from '@vue-flow/background';
import { Controls } from '@vue-flow/controls';
import { useVueFlow, VueFlow } from '@vue-flow/core';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { locale, t } from '@/i18n';
import { localizeFlow } from '@/lib/a11y';
import { NODE_LABEL, STATUS_LABEL } from '@/lib/format';
import { toFlowEdge, toFlowNode } from '@/lib/flow';
import type { RunLive } from '@/lib/run-state';
import FlowNode from './FlowNode.vue';

const props = defineProps<{ snapshot: RunSnapshot; live: RunLive; selected: string | null }>();
const emit = defineEmits<{ select: [nodeId: string | null] }>();

const flowId = `run-${Math.random().toString(36).slice(2)}`;
const { fitView, onNodesInitialized } = useVueFlow(flowId);
// Se encuadra cuando Vue Flow ya ha medido los nodos (antes, fitView no tiene dimensiones que usar).
onNodesInitialized(() => void fitView({ padding: 0.15, maxZoom: 1 }));

const nodes = computed(() =>
  props.snapshot.workflow.nodes.map((n) => {
    const agent = nodeUsesAgent(n) ? props.snapshot.agents[n.config?.agentId] : undefined;
    // El subworkflow se muestra con el nombre que tenía al lanzar la ejecución (instantánea), no con el actual.
    const childId = nodeSubworkflowId(n);
    const workflowName = childId ? props.snapshot.subworkflows?.[childId]?.name : undefined;
    const status = props.live.steps[n.id]?.status ?? 'pending';
    return {
      ...toFlowNode(n, { status, agentName: agent?.name, agentColor: agent?.color, workflowName }),
      // Lo que oye un lector de pantalla al enfocar el nodo: tipo, etiqueta y estado del paso.
      ariaLabel: t('runGraph.node', { type: NODE_LABEL[n.type], label: n.label || n.id, status: STATUS_LABEL[status].toLowerCase() }),
      domAttributes: { 'aria-roledescription': t('runGraph.stepRole') },
    };
  }),
);
const labelOf = (id: string): string => props.snapshot.workflow.nodes.find((n) => n.id === id)?.label || id;

const root = ref<HTMLElement | null>(null);
let unlocalize: (() => void) | null = null;
function localize(): void {
  unlocalize?.();
  unlocalize = root.value ? localizeFlow(root.value, t('runGraph.nodeHint'), t('runGraph.edgeHint')) : null;
}
onMounted(localize);
// Al cambiar de idioma se vuelven a escribir las ayudas que Vue Flow pinta por su cuenta.
watch(locale, localize);
onBeforeUnmount(() => unlocalize?.());
/** Intro o Espacio sobre un nodo enfocado lo selecciona (Vue Flow no emite el clic con el teclado). */
function onKey(ev: KeyboardEvent): void {
  const target = ev.target as HTMLElement;
  if ((ev.key === 'Enter' || ev.key === ' ') && target.classList.contains('vue-flow__node') && target.dataset.id) {
    ev.preventDefault();
    emit('select', target.dataset.id);
  }
}

const edges = computed(() =>
  props.snapshot.workflow.edges.map((e) => {
    const edge = toFlowEdge(e);
    const source = props.live.steps[e.source]?.status;
    const target = props.live.steps[e.target]?.status;
    const classes = [edge.class as string | undefined];
    if (target === 'running') classes.push('flowing');
    if (source === 'skipped' || target === 'skipped' || target === 'cancelled') classes.push('dimmed');
    const key = e.sourceHandle === 'true' ? 'runGraph.edgeYes' : e.sourceHandle === 'false' ? 'runGraph.edgeNo' : 'runGraph.edge';
    return { ...edge, ariaLabel: t(key, { from: labelOf(e.source), to: labelOf(e.target) }), animated: target === 'running', class: classes.filter(Boolean).join(' ') };
  }),
);
</script>

<template>
  <div ref="root" class="run-graph" role="region" :aria-label="t('runGraph.region')" @keydown.capture="onKey">
  <VueFlow
    :id="flowId"
    :nodes="nodes"
    :edges="edges"
    :nodes-draggable="false"
    :nodes-connectable="false"
    :edges-updatable="false"
    :min-zoom="0.2"
    :max-zoom="1.5"
    @node-click="emit('select', $event.node.id)"
    @pane-click="emit('select', null)"
  >
    <template #node-af="p"><FlowNode :id="p.id" :data="p.data" :selected="p.id === selected" /></template>
    <Background :gap="20" :size="1.2" />
    <Controls :show-interactive="false" position="bottom-left" />
  </VueFlow>
  </div>
</template>

<style scoped>
.run-graph {
  width: 100%;
  height: 100%;
}
</style>
