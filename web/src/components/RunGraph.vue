<script setup lang="ts">
// Grafo de solo lectura de una ejecución: cada nodo muestra su estado en vivo.
import type { RunSnapshot } from '@shared/types';
import { Background } from '@vue-flow/background';
import { Controls } from '@vue-flow/controls';
import { useVueFlow, VueFlow } from '@vue-flow/core';
import { computed } from 'vue';
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
    const agent = n.type === 'agent' || n.type === 'foreach' ? props.snapshot.agents[n.config?.agentId] : undefined;
    return toFlowNode(n, { status: props.live.steps[n.id]?.status ?? 'pending', agentName: agent?.name, agentColor: agent?.color });
  }),
);

const edges = computed(() =>
  props.snapshot.workflow.edges.map((e) => {
    const edge = toFlowEdge(e);
    const source = props.live.steps[e.source]?.status;
    const target = props.live.steps[e.target]?.status;
    const classes = [edge.class as string | undefined];
    if (target === 'running') classes.push('flowing');
    if (source === 'skipped' || target === 'skipped' || target === 'cancelled') classes.push('dimmed');
    return { ...edge, animated: target === 'running', class: classes.filter(Boolean).join(' ') };
  }),
);
</script>

<template>
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
</template>
