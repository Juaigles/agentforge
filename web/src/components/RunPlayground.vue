<script setup lang="ts">
// Banco de pruebas de un agente: lanza una tarea real y muestra la respuesta en streaming.
import type { RunSummary } from '@shared/types';
import { ArrowUpRight, Play, Square } from 'lucide-vue-next';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { announce } from '@/lib/a11y';
import { t } from '@/i18n';
import { api, errorText } from '@/lib/api';
import { serverText } from '@/lib/server-messages-en';
import { elapsedMs, formatCompact, formatDuration, relativeTime } from '@/lib/format';
import { useNow } from '@/lib/useNow';
import { useRunStream } from '@/lib/useRunStream';
import { useRuns } from '@/stores/runs';
import { useUi } from '@/stores/ui';
import MarkdownView from './MarkdownView.vue';
import RunActivity from './RunActivity.vue';
import StatusBadge from './StatusBadge.vue';
import Term from './Term.vue';

const props = defineProps<{
  agentId: string | null;
  blocked?: string | null;
  /** Si hay algo sin guardar: lo guarda antes de ejecutar y dice si se pudo. Con un agente nuevo, además lo crea. */
  saveFirst?: (() => Promise<boolean>) | null;
}>();
const ui = useUi();
const runsStore = useRuns();
const now = useNow();

const task = ref('');
const runId = ref<string | null>(null);
const starting = ref(false);
const history = ref<RunSummary[]>([]);
const { live, usage, isActive, error: streamError, hasOlder, loadingOlder, loadOlder } = useRunStream(runId);

const step = computed(() => live.value?.steps.agent ?? null);
const text = computed(() => (live.value?.output ?? step.value?.streamText ?? '').trim());
const thinking = computed(() => step.value?.thinkingText ?? '');
const hasTools = computed(() => (usage.value?.toolCalls ?? 0) > 0);
const olderActivity = () => loadOlder().catch((err) => ui.error(errorText(err)));

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
  if ((!props.agentId && !props.saveFirst) || !task.value.trim() || starting.value) return;
  starting.value = true;
  try {
    if (props.saveFirst && !(await props.saveFirst())) return;
    if (!props.agentId) return;
    const run = await api.agents.run(props.agentId, task.value.trim());
    runId.value = run.id;
  } catch (err) {
    ui.error(errorText(err));
  } finally {
    starting.value = false;
  }
}

// El final de la respuesta se anuncia una vez; el texto en streaming no es una región viva (se releería entero).
watch(
  () => live.value?.status,
  (status, previous) => {
    if (!status || status === previous || !previous) return;
    if (status === 'completed') announce(t('playground.announce.completed'));
    else if (status === 'failed') announce(t('playground.announce.failed'));
    else if (status === 'cancelled') announce(t('playground.announce.cancelled'));
  },
);

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
      <h2>{{ t('playground.title') }}</h2>
      <StatusBadge v-if="live" :status="live.status" />
    </div>
    <div class="card-pad col" style="gap: 12px">
      <div class="field">
        <label for="pg-task">{{ t('playground.task') }}</label>
        <textarea
          id="pg-task"
          v-model="task"
          class="textarea"
          rows="3"
          :placeholder="t('playground.taskPlaceholder')"
          :disabled="isActive"
          @keydown.ctrl.enter="start"
          @keydown.meta.enter="start"
        />
      </div>
      <div class="row wrap">
        <button
          v-if="!isActive"
          class="btn btn-primary"
          type="button"
          :disabled="(!agentId && !saveFirst) || !!blocked || !task.trim() || starting"
          @click="start"
        >
          <Play /> {{ starting ? t('playground.starting') : saveFirst ? t('playground.saveAndRun') : t('common.actions.run') }}
        </button>
        <button v-else class="btn btn-danger" type="button" @click="cancel"><Square /> {{ t('common.actions.cancel') }}</button>
        <span v-if="blocked" class="small muted">{{ blocked }}</span>
        <span v-else-if="saveFirst && !isActive" class="small muted">{{ t('playground.savesFirst') }}</span>
        <span v-else-if="!isActive" class="tiny faint">{{ t('playground.shortcut') }}</span>
        <span v-if="live?.startedAt" class="small muted num" style="margin-left: auto">
          {{ formatDuration(elapsedMs(live.startedAt, live.finishedAt, now)) }}
          <template v-if="usage">
            · {{ formatCompact(usage.promptTokens + usage.completionTokens) }} <Term id="tokens">{{ t('playground.tokens') }}</Term></template
          >
        </span>
      </div>

      <div v-if="streamError" class="callout danger">{{ streamError }}</div>

      <template v-if="live">
        <div v-if="live.error" class="callout danger" role="alert">{{ serverText(live.error, live.errorI18n) }}</div>
        <div v-if="thinking && !text" class="thinking small">
          <span class="eyebrow">{{ t('playground.reasoning') }}</span>{{ thinking.slice(-400) }}
        </div>
        <div v-if="text" class="answer">
          <MarkdownView :source="text" />
          <span v-if="isActive" class="caret" aria-hidden="true" />
        </div>
        <p v-else-if="isActive && !thinking" class="small muted row"><span class="dot info pulse" /> {{ t('playground.waitingModel') }}</p>

        <details v-if="hasTools || !isActive" class="activity">
          <summary>{{ hasTools ? t('playground.activityTools') : t('playground.activity') }}</summary>
          <RunActivity :log="live.activity" node-id="agent" :has-older="hasOlder" :loading-older="loadingOlder" @older="olderActivity" />
        </details>
        <RouterLink v-if="runId" class="small row" :to="`/runs/${runId}`" style="gap: 4px"
          >{{ t('playground.viewFull') }} <ArrowUpRight style="width: 13px; height: 13px"
        /></RouterLink>
      </template>

      <div v-if="history.length" class="history">
        <div class="eyebrow">{{ t('playground.recent') }}</div>
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
