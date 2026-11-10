<script setup lang="ts">
// Nodo de workflow para Vue Flow. Se usa en el constructor (editable) y en el monitor (con estado).
import { Handle, Position } from '@vue-flow/core';
import { Bot, Flag, GitBranch, LogIn, Repeat, Shuffle, TriangleAlert, Wrench } from 'lucide-vue-next';
import { computed } from 'vue';
import type { FlowNodeData } from '@/lib/flow';
import { OPERATOR_LABEL } from '@/lib/flow';
import { NODE_LABEL } from '@/lib/format';
import { useCatalog } from '@/stores/catalog';
import StatusBadge from './StatusBadge.vue';

const props = defineProps<{ id: string; data: FlowNodeData; selected?: boolean }>();
const catalog = useCatalog();

const ICONS = { input: LogIn, agent: Bot, tool: Wrench, condition: GitBranch, transform: Shuffle, foreach: Repeat, output: Flag };
const TINT = { input: '#64748b', agent: '#c2410c', tool: '#0d9488', condition: '#d97706', transform: '#7c3aed', foreach: '#be185d', output: '#16a34a' };

const usesAgent = computed(() => props.data.kind === 'agent' || props.data.kind === 'foreach');
const agent = computed(() => (usesAgent.value ? catalog.agentById.get(props.data.config.agentId) : undefined));
const agentLabel = computed(() => props.data.agentName ?? agent.value?.name ?? (props.data.config.agentId ? 'Agente eliminado' : 'Sin agente asignado'));
const tint = computed(() => (props.data.kind === 'agent' ? (props.data.agentColor ?? agent.value?.color ?? TINT.agent) : TINT[props.data.kind]));

const subtitle = computed(() => {
  const c = props.data.config;
  switch (props.data.kind) {
    case 'agent':
      return agentLabel.value;
    case 'foreach':
      return `Cada elemento → ${agentLabel.value}`;
    case 'tool':
      return c.tool || 'Sin herramienta asignada';
    case 'condition':
      return `${OPERATOR_LABEL[c.operator] ?? '¿…?'}${c.right ? ` «${c.right}»` : ''}`;
    case 'input':
      return c.description || 'Texto de entrada';
    case 'transform':
      return c.template || 'Plantilla vacía';
    case 'output':
      return c.template || 'Lo que llegue de los nodos anteriores';
    default:
      return '';
  }
});
</script>

<template>
  <div class="flow-node" :class="[data.kind, data.status ? `st-${data.status}` : '', { selected, invalid: data.errors }]" :style="{ '--tint': tint }">
    <Handle v-if="data.kind !== 'input'" type="target" :position="Position.Left" />

    <div class="head">
      <span class="ico"><component :is="ICONS[data.kind]" /></span>
      <span class="type">{{ NODE_LABEL[data.kind] }}</span>
      <StatusBadge v-if="data.status && data.status !== 'pending'" :status="data.status" icon-only />
      <span v-else-if="data.errors" class="warn" :title="`${data.errors} error(es) de configuración`"><TriangleAlert /></span>
    </div>
    <div class="title">{{ data.label || id }}</div>
    <div class="sub">{{ subtitle }}</div>

    <template v-if="data.kind === 'condition'">
      <Handle id="true" type="source" :position="Position.Right" class="h-true" :style="{ top: '36%' }" />
      <Handle id="false" type="source" :position="Position.Right" class="h-false" :style="{ top: '72%' }" />
      <span class="branch yes">sí</span>
      <span class="branch no">no</span>
    </template>
    <Handle v-else-if="data.kind !== 'output'" type="source" :position="Position.Right" />
  </div>
</template>

<style scoped>
.flow-node {
  position: relative;
  width: 208px;
  padding: 10px 12px 11px;
  border-radius: 12px;
  background: var(--surface);
  border: 1px solid var(--border-strong);
  border-left: 4px solid var(--tint);
  box-shadow: var(--shadow-sm);
  text-align: left;
  transition:
    box-shadow 0.12s,
    border-color 0.12s,
    opacity 0.12s;
}
.flow-node:hover {
  box-shadow: var(--shadow-md);
}
.flow-node.selected {
  border-color: var(--tint);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--tint) 28%, transparent);
}
.flow-node.invalid:not(.selected) {
  border-color: var(--danger);
  border-left-color: var(--danger);
}
.head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}
.ico {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--tint) 16%, transparent);
  color: var(--tint);
}
.ico svg {
  width: 12px;
  height: 12px;
}
.type {
  flex: 1;
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--text-3);
}
.warn {
  display: inline-flex;
  color: var(--danger);
}
.warn svg {
  width: 14px;
  height: 14px;
}
.title {
  font-family: var(--font-display);
  font-size: 13.5px;
  font-weight: 650;
  line-height: 1.3;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sub {
  font-size: 11.5px;
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.condition {
  padding-right: 30px;
}
.branch {
  position: absolute;
  right: 10px;
  font-size: 10.5px;
  font-weight: 700;
  transform: translateY(-50%);
}
.branch.yes {
  top: 36%;
  color: var(--success);
}
.branch.no {
  top: 72%;
  color: var(--danger);
}
.h-true {
  background: var(--success);
}
.h-false {
  background: var(--danger);
}

/* Estados en el monitor de ejecuciones */
.st-running {
  border-color: var(--info);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--info) 30%, transparent);
  animation: glow 1.5s ease-in-out infinite;
}
.st-completed {
  border-color: color-mix(in srgb, var(--success) 60%, var(--border-strong));
}
.st-failed {
  border-color: var(--danger);
  background: var(--danger-soft);
}
.st-skipped,
.st-cancelled {
  opacity: 0.55;
  border-style: dashed;
}
@keyframes glow {
  50% {
    box-shadow: 0 0 0 6px color-mix(in srgb, var(--info) 12%, transparent);
  }
}
</style>
