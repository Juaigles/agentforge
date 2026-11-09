<script setup lang="ts">
// Banco de pruebas de un agente: lanza una tarea real y muestra la respuesta en streaming.
import type { RunSummary } from '@shared/types';
import { ArrowUpRight, Play, Square } from 'lucide-vue-next';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { api, errorText } from '@/lib/api';
import { elapsedMs, formatCompact, formatDuration, relativeTime } from '@/lib/format';
import { useNow } from '@/lib/useNow';
import { useRunStream } from '@/lib/useRunStream';
import { useRuns } from '@/stores/runs';
import { useUi } from '@/stores/ui';
import MarkdownView from './MarkdownView.vue';
import RunActivity from './RunActivity.vue';
import StatusBadge from './StatusBadge.vue';

const props = defineProps<{ agentId: string | null; blocked?: string | null }>();
const ui = useUi();
const runsStore = useRuns();
const now = useNow();

const task = ref('');
const runId = ref<string | null>(null);
const starting = ref(false);
const history = ref<RunSummary[]>([]);
const { live, usage, isActive, error: streamError } = useRunStream(runId);

const step = computed(() => live.value?.steps.agent ?? null);
const text = computed(() => (live.value?.output ?? step.value?.streamText ?? '').trim());
const thinking = computed(() => step.value?.thinkingText ?? '');
const hasTools = computed(() => live.value?.events.some((e) => e.type === 'tool.call') ?? false);

async function loadHistory(): Promise<void> {
  if (!props.agentId) return;
  try {
    history.value = (await api.runs.list({ agentId: props.agentId, kind: 'agent', limit: 5 })).items;
  } catch {
    /* el historial es secundario */
  }
}
onMounted(loadHistory);
onBeforeUnmount(() => (runsStore.watching = null));
watch(isActive, (active, was) => {
  if (was && !active) void loadHistory();
});
// Mientras se mira aquí la ejecución no hace falta un aviso global al terminar.
watch(runId, (id) => (runsStore.watching = id), { immediate: true });

async function start(): Promise<void> {
  if (!props.agentId || !task.value.trim() || starting.value) return;
  starting.value = true;
  try {
    const run = await api.agents.run(props.agentId, task.value.trim());
    runId.value = run.id;
  } catch (err) {
    ui.error(errorText(err));
  } finally {
    starting.value = false;
  }
}

async function cancel(): Promise<void> {
  if (!runId.value) return;
  try {
    await api.runs.cancel(runId.value);
  } catch (err) {
    ui.error(errorText(err));
  }
}
</script>

<template>
  <section class="card playground">
    <div class="card-head">
      <h2>Banco de pruebas</h2>
      <StatusBadge v-if="live" :status="live.status" />
    </div>
    <div class="card-pad col" style="gap: 12px">
      <div class="field">
        <label for="pg-task">Tarea</label>
        <textarea
          id="pg-task"
          v-model="task"
          class="textarea"
          rows="3"
          placeholder="Escribe una tarea para comprobar cómo responde el agente…"
          :disabled="isActive"
          @keydown.ctrl.enter="start"
          @keydown.meta.enter="start"
        />
      </div>
      <div class="row wrap">
        <button v-if="!isActive" class="btn btn-primary" type="button" :disabled="!agentId || !!blocked || !task.trim() || starting" @click="start">
          <Play /> {{ starting ? 'Lanzando…' : 'Ejecutar' }}
        </button>
        <button v-else class="btn btn-danger" type="button" @click="cancel"><Square /> Cancelar</button>
        <span v-if="blocked" class="small muted">{{ blocked }}</span>
        <span v-else-if="!isActive" class="tiny faint">Ctrl + Intro</span>
        <span v-if="live?.startedAt" class="small muted num" style="margin-left: auto">
          {{ formatDuration(elapsedMs(live.startedAt, live.finishedAt, now)) }}
          <template v-if="usage"> · {{ formatCompact(usage.promptTokens + usage.completionTokens) }} tokens</template>
        </span>
      </div>

      <div v-if="streamError" class="callout danger">{{ streamError }}</div>

      <template v-if="live">
        <div v-if="live.error" class="callout danger" role="alert">{{ live.error }}</div>
        <div v-if="thinking && !text" class="thinking small"><span class="eyebrow">Razonando…</span>{{ thinking.slice(-400) }}</div>
        <div v-if="text" class="answer" aria-live="polite">
          <MarkdownView :source="text" />
          <span v-if="isActive" class="caret" aria-hidden="true" />
        </div>
        <p v-else-if="isActive && !thinking" class="small muted row"><span class="dot info pulse" /> Esperando al modelo…</p>

        <details v-if="hasTools || !isActive" class="activity">
          <summary>Actividad{{ hasTools ? ' y herramientas' : '' }}</summary>
          <RunActivity :events="live.events" node-id="agent" />
        </details>
        <RouterLink v-if="runId" class="small row" :to="`/runs/${runId}`" style="gap: 4px">Ver la ejecución completa <ArrowUpRight style="width: 13px; height: 13px" /></RouterLink>
      </template>

      <div v-if="history.length" class="history">
        <div class="eyebrow">Pruebas recientes</div>
        <RouterLink v-for="r in history" :key="r.id" :to="`/runs/${r.id}`" class="row small hist">
          <StatusBadge :status="r.status" icon-only />
          <span class="grow truncate">{{ r.input }}</span>
          <span class="faint" style="white-space: nowrap">{{ relativeTime(r.createdAt, now) }}</span>
        </RouterLink>
      </div>
    </div>
  </section>
</template>

<style scoped>
.answer {
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface-2);
  max-height: 460px;
  overflow: auto;
}
.caret {
  display: inline-block;
  width: 7px;
  height: 15px;
  margin-left: 2px;
  vertical-align: text-bottom;
  background: var(--accent);
  animation: pulse 1s steps(2) infinite;
}
.thinking {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  border-radius: var(--radius);
  border: 1px dashed var(--border-strong);
  color: var(--text-2);
  font-style: italic;
  overflow-wrap: anywhere;
}
.activity summary {
  cursor: pointer;
  font-weight: 600;
  font-size: 13px;
  color: var(--text-2);
  padding: 4px 0;
}
.activity[open] summary {
  margin-bottom: 8px;
}
.history {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}
.hist {
  color: var(--text-2);
  padding: 4px 6px;
  margin: 0 -6px;
  border-radius: 6px;
}
.hist:hover {
  background: var(--surface-2);
  text-decoration: none;
}
</style>
