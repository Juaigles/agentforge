<script setup lang="ts">
// Registro de actividad de una ejecución: mensajes del modelo, llamadas a herramientas y cambios de estado.
import { Brain, ChevronRight, MessageSquareText, Wrench } from 'lucide-vue-next';
import { computed, nextTick, reactive, ref, watch } from 'vue';
import { t, tn } from '@/i18n';
import { formatDuration, formatNumber, formatTime } from '@/lib/format';
import type { ActivityItem, ActivityLog } from '@/lib/run-state';

/** Entradas que se pintan de entrada y que añade cada «Cargar anteriores»: una ejecución larga no pinta miles de filas. */
const WINDOW = 100;

const props = defineProps<{
  /** Registro de actividad ya construido (se amplía solo con cada evento). */
  log: ActivityLog;
  nodeId?: string | null;
  labels?: Record<string, string>;
  /** Quedan eventos más antiguos en el servidor que aún no están en el registro. */
  hasOlder?: boolean;
  loadingOlder?: boolean;
}>();
const emit = defineEmits<{ older: [] }>();

const visible = ref(WINDOW);
watch(
  () => props.nodeId,
  () => (visible.value = WINDOW),
);
/** Las últimas `visible` entradas (del nodo elegido, si lo hay): solo se recorre el final del registro. */
const shown = computed(() => {
  const all = props.log.items;
  if (!props.nodeId) return all.slice(Math.max(0, all.length - visible.value));
  const picked: ActivityItem[] = [];
  for (let i = all.length - 1; i >= 0 && picked.length < visible.value; i--) if (all[i].nodeId === props.nodeId) picked.push(all[i]);
  return picked.reverse();
});
/** Entradas ya cargadas que no se están pintando. */
const hidden = computed(() => (props.nodeId ? (props.log.counts[props.nodeId] ?? 0) : props.log.items.length) - shown.value.length);
const canShowOlder = computed(() => hidden.value > 0 || !!props.hasOlder);

const list = ref<HTMLElement | null>(null);
const olderButton = ref<HTMLButtonElement | null>(null);
function showOlder(): void {
  // Si lo cargado no da para otra tanda, se pide además la página anterior al servidor.
  if (hidden.value < WINDOW && props.hasOlder) emit('older');
  visible.value += WINDOW;
}
// Al cargar lo último el botón desaparece: el foco pasa a la lista para no perderse al principio de la página.
watch(
  canShowOlder,
  (can) => {
    if (can || document.activeElement !== olderButton.value) return;
    void nextTick(() => list.value?.focus());
  },
  { flush: 'pre' },
);
const expanded = reactive(new Set<string>());
const toggle = (key: string) => (expanded.has(key) ? expanded.delete(key) : expanded.add(key));
const pretty = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value, null, 2));
/** Lo que hace el modelo en un mensaje (lleva delante el espacio que lo separa del nombre del agente). */
const modelAction = (toolCount: number): string => ` ${toolCount ? tn('runActivity.asks', toolCount) : t('runActivity.answers')}`;
const where = (nodeId: string | null) => (!props.nodeId && nodeId ? (props.labels?.[nodeId] ?? nodeId) : '');
</script>

<template>
  <div v-if="canShowOlder" class="older">
    <button ref="olderButton" class="btn btn-sm" type="button" :disabled="loadingOlder" @click="showOlder">
      {{ loadingOlder ? t('common.actions.loading') : t('runActivity.older') }}
    </button>
    <span class="tiny muted" role="status">{{ tn('runActivity.showing', shown.length) }}</span>
  </div>
  <ol v-if="shown.length" ref="list" class="activity" tabindex="-1" :aria-label="t('runActivity.label')">
    <li v-for="item in shown" :key="item.key" :class="[item.kind, item.kind === 'marker' ? item.tone : '']">
      <time class="tiny faint num">{{ formatTime(item.ts) }}</time>

      <div v-if="item.kind === 'marker'" class="line">
        <span class="dot" :class="item.tone" />
        <span>
          {{ item.text }}
          <span v-if="where(item.nodeId)" class="faint"> · {{ where(item.nodeId) }}</span>
          <template v-if="item.link">
            · <RouterLink :to="item.link.to" class="marker-link">{{ item.link.label }}</RouterLink></template
          >
        </span>
        <p v-if="item.detail" class="detail">{{ item.detail }}</p>
      </div>

      <div v-else-if="item.kind === 'message'" class="entry" :style="{ marginLeft: `${item.depth * 16}px` }">
        <button class="head" type="button" :aria-expanded="expanded.has(item.key)" @click="toggle(item.key)">
          <ChevronRight class="chev" :class="{ open: expanded.has(item.key) }" />
          <MessageSquareText class="ico" />
          <span class="grow truncate">
            <strong>{{ item.agent || t('runActivity.model') }}</strong>
            <span class="muted">
              {{ modelAction(item.toolCount) }}
            </span>
            <span v-if="where(item.nodeId)" class="faint"> · {{ where(item.nodeId) }}</span>
          </span>
          <span class="tiny faint num">{{ t('runActivity.tokens', { n: formatNumber(item.tokens) }) }}</span>
        </button>
        <div v-if="expanded.has(item.key)" class="content">
          <template v-if="item.thinking">
            <div class="eyebrow row"><Brain style="width: 12px; height: 12px" /> {{ t('runActivity.reasoning') }}</div>
            <pre class="codeblock thinking">{{ item.thinking }}</pre>
          </template>
          <pre v-if="item.content" class="codeblock">{{ item.content }}</pre>
          <p v-else-if="!item.thinking" class="faint small">{{ t('runActivity.noText') }}</p>
        </div>
      </div>

      <div v-else class="entry" :style="{ marginLeft: `${item.depth * 16}px` }">
        <button class="head" type="button" :aria-expanded="expanded.has(item.key)" @click="toggle(item.key)">
          <ChevronRight class="chev" :class="{ open: expanded.has(item.key) }" />
          <Wrench class="ico" />
          <span class="grow truncate">
            <code>{{ item.name }}</code>
            <span v-if="where(item.nodeId)" class="faint"> · {{ where(item.nodeId) }}</span>
          </span>
          <span v-if="item.pending" class="badge info">{{ t('common.status.running') }}</span>
          <span v-else class="badge" :class="item.ok ? 'success' : 'danger'"
            >{{ item.ok ? t('runActivity.ok') : t('runActivity.error') }} · {{ formatDuration(item.durationMs) }}</span
          >
        </button>
        <div v-if="expanded.has(item.key)" class="content">
          <div class="eyebrow">{{ t('runActivity.arguments') }}</div>
          <pre class="codeblock">{{ pretty(item.args) }}</pre>
          <template v-if="!item.pending">
            <div class="eyebrow">{{ t('runActivity.result') }}</div>
            <pre class="codeblock" :class="{ bad: !item.ok }">{{ item.result }}</pre>
          </template>
        </div>
      </div>
    </li>
  </ol>
  <p v-else class="faint small" style="padding: 12px 0">{{ canShowOlder ? t('runActivity.emptyLoaded') : t('runActivity.empty') }}</p>
</template>

<style scoped>
.marker-link {
  text-decoration: underline;
}
.older {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.activity:focus {
  outline: none;
}
.activity {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
li {
  display: grid;
  grid-template-columns: 62px minmax(0, 1fr);
  gap: 8px;
  align-items: start;
}
time {
  padding-top: 5px;
}
.line {
  display: grid;
  grid-template-columns: 8px minmax(0, 1fr);
  column-gap: 8px;
  align-items: center;
  padding: 3px 0;
  font-size: 13px;
  color: var(--text-2);
}
.line .dot.warning {
  background: var(--warning);
}
.line .dot.neutral {
  background: var(--text-3);
}
.detail {
  grid-column: 2;
  font-size: 12.5px;
  color: var(--text-2);
  overflow-wrap: anywhere;
}
.danger .detail {
  color: var(--danger);
}
.entry {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
  min-width: 0;
}
.head {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  padding: 6px 9px;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.head:hover {
  background: var(--surface-2);
}
.chev {
  width: 13px;
  height: 13px;
  flex: none;
  color: var(--text-3);
  transition: transform 0.12s;
}
.chev.open {
  transform: rotate(90deg);
}
.ico {
  width: 14px;
  height: 14px;
  flex: none;
  color: var(--text-3);
}
.content {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px 10px;
  border-top: 1px solid var(--border);
}
.codeblock {
  max-height: 260px;
}
.codeblock.bad {
  color: var(--danger);
}
.thinking {
  color: var(--text-2);
  font-style: italic;
}
@media (max-width: 560px) {
  li {
    grid-template-columns: minmax(0, 1fr);
    gap: 0;
  }
  time {
    padding-top: 0;
  }
}
</style>
