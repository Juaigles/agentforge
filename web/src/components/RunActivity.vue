<script setup lang="ts">
// Registro de actividad de una ejecución: mensajes del modelo, llamadas a herramientas y cambios de estado.
import type { RunEvent } from '@shared/types';
import { Brain, ChevronRight, MessageSquareText, Wrench } from 'lucide-vue-next';
import { computed, reactive } from 'vue';
import { t, tn } from '@/i18n';
import { formatDuration, formatNumber, formatTime } from '@/lib/format';
import { buildActivity } from '@/lib/run-state';

const props = defineProps<{ events: RunEvent[]; nodeId?: string | null; labels?: Record<string, string> }>();
const items = computed(() => buildActivity(props.events, props.nodeId));
const expanded = reactive(new Set<string>());
const toggle = (key: string) => (expanded.has(key) ? expanded.delete(key) : expanded.add(key));
const pretty = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value, null, 2));
/** Lo que hace el modelo en un mensaje (lleva delante el espacio que lo separa del nombre del agente). */
const modelAction = (toolCount: number): string => ` ${toolCount ? tn('runActivity.asks', toolCount) : t('runActivity.answers')}`;
const where = (nodeId: string | null) => (!props.nodeId && nodeId ? (props.labels?.[nodeId] ?? nodeId) : '');
</script>

<template>
  <ol v-if="items.length" class="activity">
    <li v-for="item in items" :key="item.key" :class="[item.kind, item.kind === 'marker' ? item.tone : '']">
      <time class="tiny faint num">{{ formatTime(item.ts) }}</time>

      <div v-if="item.kind === 'marker'" class="line">
        <span class="dot" :class="item.tone" />
        <span>
          {{ item.text }}
          <span v-if="where(item.nodeId)" class="faint"> · {{ where(item.nodeId) }}</span>
          <template v-if="item.link"> · <RouterLink :to="item.link.to" class="marker-link">{{ item.link.label }}</RouterLink></template>
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
          <span v-else class="badge" :class="item.ok ? 'success' : 'danger'">{{ item.ok ? t('runActivity.ok') : t('runActivity.error') }} · {{ formatDuration(item.durationMs) }}</span>
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
  <p v-else class="faint small" style="padding: 12px 0">{{ t('runActivity.empty') }}</p>
</template>

<style scoped>
.marker-link {
  text-decoration: underline;
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
