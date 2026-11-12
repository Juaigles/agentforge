<script setup lang="ts">
// Nodo de workflow para Vue Flow. Se usa en el constructor (editable) y en el monitor (con estado).
import { Handle, Position } from '@vue-flow/core';
import { foreachBody } from '@shared/graph';
import { Bot, Flag, GitBranch, LogIn, Repeat, Shuffle, TriangleAlert, UserCheck, Workflow, Wrench } from 'lucide-vue-next';
import { computed } from 'vue';
import { t, tn } from '@/i18n';
import type { FlowNodeData } from '@/lib/flow';
import { OPERATOR_LABEL } from '@/lib/flow';
import { NODE_LABEL } from '@/lib/format';
import { useCatalog } from '@/stores/catalog';
import AgentAvatar from './AgentAvatar.vue';
import StatusBadge from './StatusBadge.vue';

const props = defineProps<{ id: string; data: FlowNodeData; selected?: boolean }>();
const catalog = useCatalog();

const ICONS = {
  input: LogIn,
  agent: Bot,
  tool: Wrench,
  condition: GitBranch,
  transform: Shuffle,
  foreach: Repeat,
  subworkflow: Workflow,
  approval: UserCheck,
  output: Flag,
};
const TINT = {
  input: '#64748b',
  agent: '#c2410c',
  tool: '#0d9488',
  condition: '#d97706',
  transform: '#7c3aed',
  foreach: '#be185d',
  subworkflow: '#2563eb',
  approval: '#b45309',
  output: '#16a34a',
};

const body = computed(() =>
  props.data.kind === 'foreach' ? foreachBody({ id: props.id, type: 'foreach', label: '', position: { x: 0, y: 0 }, config: props.data.config }) : null,
);
const usesAgent = computed(() => props.data.kind === 'agent' || body.value === 'agent');
const workflowName = computed(() => {
  const id = props.data.config.workflowId;
  if (!id) return t('flowNode.noWorkflow');
  return props.data.workflowName ?? catalog.workflows.find((w) => w.id === id)?.name ?? t('flowNode.workflowDeleted');
});
/** Nodos con dos salidas: condición (sí / no) y aprobación (aprobado / rechazado). */
const branching = computed(() => props.data.kind === 'condition' || props.data.kind === 'approval');
const agent = computed(() => (usesAgent.value ? catalog.agentById.get(props.data.config.agentId) : undefined));
const agentLabel = computed(
  () => props.data.agentName ?? agent.value?.name ?? (props.data.config.agentId ? t('flowNode.agentDeleted') : t('flowNode.noAgent')),
);
const tint = computed(() => (props.data.kind === 'agent' ? (props.data.agentColor ?? agent.value?.color ?? TINT.agent) : TINT[props.data.kind]));

const subtitle = computed(() => {
  const c = props.data.config;
  switch (props.data.kind) {
    case 'agent':
      return agentLabel.value;
    case 'foreach':
      return t('flowNode.forEach', {
        target: body.value === 'tool' ? c.tool || t('flowNode.noToolShort') : body.value === 'subworkflow' ? workflowName.value : agentLabel.value,
      });
    case 'subworkflow':
      return workflowName.value;
    case 'approval':
      return c.message || t('flowNode.noApprovalText');
    case 'tool':
      return c.tool || t('flowNode.noTool');
    case 'condition':
      return `${OPERATOR_LABEL[c.operator] ?? t('flowNode.unknownOperator')}${c.right ? ` ${t('flowNode.rightValue', { value: c.right })}` : ''}`;
    case 'input':
      return c.description || t('flowNode.inputText');
    case 'transform':
      return c.template || t('flowNode.emptyTemplate');
    case 'output':
      return c.template || t('flowNode.outputDefault');
    default:
      return '';
  }
});
</script>

<template>
  <div class="flow-node" :class="[data.kind, data.status ? `st-${data.status}` : '', { selected, invalid: data.errors }]" :style="{ '--tint': tint }">
    <Handle v-if="data.kind !== 'input'" type="target" :position="Position.Left" />

    <div class="head">
      <AgentAvatar v-if="usesAgent && data.status" :name="agentLabel" :color="tint" :size="22" :activity="data.activity" />
      <span v-else class="ico"><component :is="ICONS[data.kind]" /></span>
      <span class="type">{{ NODE_LABEL[data.kind] }}</span>
      <StatusBadge v-if="data.status && data.status !== 'pending'" :status="data.status" icon-only />
      <span v-else-if="data.errors" class="warn" :title="tn('flowNode.configErrors', data.errors)">
        <TriangleAlert aria-hidden="true" /><span class="sr-only">{{ tn('flowNode.configErrors', data.errors) }}</span>
      </span>
    </div>
    <div class="title">{{ data.label || id }}</div>
    <div class="sub">{{ subtitle }}</div>

    <template v-if="branching">
      <Handle id="true" type="source" :position="Position.Right" class="h-true" :style="{ top: '36%' }" />
      <Handle id="false" type="source" :position="Position.Right" class="h-false" :style="{ top: '72%' }" />
      <span class="branch yes">{{ t('flowNode.yes') }}</span>
      <span class="branch no">{{ t('flowNode.no') }}</span>
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
/* Omitido o cancelado: borde discontinuo y fondo apagado. Sin opacidad, que dejaba el texto sin contraste. */
.st-skipped,
.st-cancelled {
  background: var(--surface-2);
  border-style: dashed;
}
@keyframes glow {
  50% {
    box-shadow: 0 0 0 6px color-mix(in srgb, var(--info) 12%, transparent);
  }
}
</style>
