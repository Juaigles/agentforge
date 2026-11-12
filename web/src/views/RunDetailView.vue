<script setup lang="ts">
// Monitor de una ejecución: grafo con estados en vivo, pasos, resultado en streaming y registro de actividad.
import type { RunSummary } from '@shared/types';
import { ArrowLeft, Bot, CircleAlert, Copy, Hourglass, LayoutList, Pencil, RotateCcw, SkipForward, Square, Trash2, Workflow } from 'lucide-vue-next';
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import MarkdownView from '@/components/MarkdownView.vue';
import RunActivity from '@/components/RunActivity.vue';
import RunGraph from '@/components/RunGraph.vue';
import StatusBadge from '@/components/StatusBadge.vue';
import Term from '@/components/Term.vue';
import { t, tn } from '@/i18n';
import { announce } from '@/lib/a11y';
import { api, errorText } from '@/lib/api';
import { serverText } from '@/lib/server-messages-en';
import { elapsedMs, formatCompact, formatDateTime, formatDuration, formatNumber, NODE_LABEL, STATUS_LABEL } from '@/lib/format';
import { useRunStream } from '@/lib/useRunStream';
import { useCatalog } from '@/stores/catalog';
import { useRuns } from '@/stores/runs';
import { useUi } from '@/stores/ui';

const route = useRoute();
const router = useRouter();
const ui = useUi();
const runsStore = useRuns();
const catalog = useCatalog();

const runId = computed(() => String(route.params.id));
const { run, live, loading, error, usage, isActive, reload, hasOlder, loadingOlder, loadOlder } = useRunStream(runId);
// El reloj solo corre mientras la ejecución está en curso: con una terminada no hay nada que repintar cada 500 ms.
const now = ref(Date.now());
let ticker: ReturnType<typeof setInterval> | undefined;
watch(
  isActive,
  (active) => {
    clearInterval(ticker);
    ticker = undefined;
    if (!active) return;
    now.value = Date.now();
    ticker = setInterval(() => (now.value = Date.now()), 500);
  },
  { immediate: true },
);
onBeforeUnmount(() => clearInterval(ticker));
// Al recuperar la conexión con el servidor, una ejecución que seguía en curso (o que no llegó a cargarse) se vuelve
// a cargar: lo ocurrido mientras tanto no llegó por el flujo de eventos.
watch(
  () => catalog.online,
  (online, was) => {
    if (online && was === false && (isActive.value || error.value)) void reload();
  },
);

const selected = ref<string | null>(null);
const tab = ref<'result' | 'activity' | 'input'>('result');
const TABS = ['result', 'activity', 'input'] as const;
/** Flechas, Inicio y Fin entre pestañas (patrón de pestañas de WAI-ARIA, con `tabindex` itinerante). */
function onTabKey(event: KeyboardEvent): void {
  const index = TABS.indexOf(tab.value);
  const next =
    event.key === 'ArrowRight'
      ? (index + 1) % TABS.length
      : event.key === 'ArrowLeft'
        ? (index + TABS.length - 1) % TABS.length
        : event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? TABS.length - 1
            : -1;
  if (next < 0) return;
  event.preventDefault();
  tab.value = TABS[next];
  void nextTick(() => document.getElementById(`run-tab-${TABS[next]}`)?.focus());
}
const raw = ref(false);
const busy = ref(false);

watch(
  runId,
  (id) => {
    runsStore.watching = id;
    selected.value = null;
    tab.value = 'result';
  },
  { immediate: true },
);
onBeforeUnmount(() => (runsStore.watching = null));

const steps = computed(() => (live.value ? live.value.order.map((id) => live.value!.steps[id]) : []));

// Los cambios de estado se anuncian a los lectores de pantalla: en esta pantalla no hay aviso emergente de fin.
watch(
  () => live.value?.status,
  (status, previous) => {
    if (!status || !previous || status === previous || !live.value) return;
    const took = elapsedMs(live.value.startedAt, live.value.finishedAt, Date.now());
    const ended = ['completed', 'failed', 'cancelled'].includes(status);
    const state = STATUS_LABEL[status].toLowerCase();
    announce(
      ended && took !== null ? t('runDetail.announce.runIn', { status: state, time: formatDuration(took) }) : t('runDetail.announce.run', { status: state }),
    );
  },
);
watch(
  () => steps.value.map((s) => `${s.nodeId}:${s.status}`).join('|'),
  (current, previous) => {
    if (!previous || steps.value.length < 2) return;
    const before = new Map(previous.split('|').map((entry) => [entry.slice(0, entry.lastIndexOf(':')), entry.slice(entry.lastIndexOf(':') + 1)]));
    for (const s of steps.value) {
      const was = before.get(s.nodeId);
      if (was && was !== s.status && ['completed', 'failed', 'waiting'].includes(s.status))
        announce(t('runDetail.announce.step', { label: s.label, status: STATUS_LABEL[s.status].toLowerCase() }));
    }
    void current;
  },
);
// Una ejecución fallida se abre mostrando el paso que falló: ahí está el motivo y lo que llevaba hecho.
watch(
  () => [live.value?.status, loading.value] as const,
  ([status, isLoading]) => {
    // Mientras se carga otra ejecución (p. ej. el reintento de esta) el estado que se ve es todavía el de la anterior.
    if (isLoading || run.value?.id !== runId.value) return;
    if (status !== 'failed' || selected.value || steps.value.length < 2) return;
    const failed = steps.value.find((s) => s.status === 'failed');
    if (failed) selected.value = failed.nodeId;
  },
  { immediate: true },
);
const step = computed(() => (selected.value && live.value ? (live.value.steps[selected.value] ?? null) : null));
const labels = computed(() => Object.fromEntries(steps.value.map((s) => [s.nodeId, s.label])));
const runningSteps = computed(() => steps.value.filter((s) => s.status === 'running'));
const waitingSteps = computed(() => steps.value.filter((s) => s.status === 'waiting'));
const isWorkflow = computed(() => run.value?.kind === 'workflow');
const duration = computed(() => (live.value ? elapsedMs(live.value.startedAt, live.value.finishedAt, now.value) : null));
/** Entradas de actividad cargadas (de la selección, si la hay) para la insignia de la pestaña; el registro ya lleva la cuenta. */
const activityCount = computed(() => {
  if (!live.value) return 0;
  return selected.value ? (live.value.activity.counts[selected.value] ?? 0) : live.value.activity.items.length;
});
const olderActivity = () => loadOlder().catch((err) => ui.error(errorText(err)));
const progress = computed(() => {
  const done = steps.value.filter((s) => ['completed', 'failed', 'skipped', 'cancelled'].includes(s.status)).length;
  return { done, total: steps.value.length };
});
const canResume = computed(
  () => isWorkflow.value && !!live.value && ['failed', 'cancelled'].includes(live.value.status) && steps.value.some((s) => s.status === 'completed'),
);
const sourceExists = computed(() => {
  if (!run.value) return false;
  return run.value.workflowId ? catalog.workflows.some((w) => w.id === run.value!.workflowId) : !!run.value.agentId && catalog.agentById.has(run.value.agentId);
});
const sourceLink = computed(() => (run.value?.workflowId ? `/workflows/${run.value.workflowId}` : `/agents/${run.value?.agentId}`));

/** Texto que se muestra en la pestaña Resultado según la selección. */
const resultText = computed(() => {
  // Un paso cancelado o fallido a medias no tiene salida: se muestra lo que el modelo llevaba escrito.
  if (step.value) return step.value.output ?? (step.value.streamText || step.value.partialOutput) ?? '';
  return live.value?.output ?? '';
});
/** ¿Lo que se muestra es el texto a medias de un paso que no llegó a terminar? */
const isPartial = computed(() => !!step.value && step.value.output === null && !['running', 'waiting'].includes(step.value.status) && resultText.value !== '');

// Subejecuciones (subworkflows) que ha lanzado esta ejecución, agrupadas por el paso que las lanzó.
const children = ref<RunSummary[]>([]);
async function loadChildren(): Promise<void> {
  try {
    children.value = await api.runs.children(runId.value);
  } catch {
    /* dato secundario */
  }
}
const hasSubworkflows = computed(() => steps.value.some((s) => s.nodeType === 'subworkflow' || s.nodeType === 'foreach'));
watch(
  () => [runId.value, hasSubworkflows.value, steps.value.filter((s) => s.status === 'running' || s.status === 'completed' || s.status === 'failed').length],
  () => {
    if (hasSubworkflows.value) void loadChildren();
    else children.value = [];
  },
  { immediate: true },
);
const stepChildren = computed(() => (step.value ? children.value.filter((c) => c.parentNodeId === step.value!.nodeId) : []));
const stepDuration = (s: { startedAt: string | null; finishedAt: string | null; status: string }) =>
  s.startedAt ? formatDuration(elapsedMs(s.startedAt, s.finishedAt, s.status === 'running' ? now.value : Date.parse(s.startedAt))) : '';

async function act(fn: () => Promise<void>): Promise<void> {
  busy.value = true;
  try {
    await fn();
  } catch (err) {
    ui.error(errorText(err));
  } finally {
    busy.value = false;
  }
}
const cancel = () => act(async () => void (await api.runs.cancel(runId.value)));
const retry = (mode: 'all' | 'failed') =>
  act(async () => {
    const next = await api.runs.retry(runId.value, mode);
    await router.push(`/runs/${next.id}`);
  });
async function remove(): Promise<void> {
  const ok = await ui.confirm({
    title: t('runDetail.confirm.deleteTitle'),
    message: t('runDetail.confirm.deleteMessage'),
    confirmLabel: t('common.actions.delete'),
    danger: true,
  });
  if (!ok) return;
  await act(async () => {
    await api.runs.remove(runId.value);
    runsStore.forget(runId.value);
    await router.push('/runs');
  });
}
async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    ui.success(t('runDetail.toast.copied'));
  } catch {
    ui.error(t('runDetail.toast.copyFailed'));
  }
}
</script>

<template>
  <div class="page">
    <div v-if="error" class="card empty">
      <CircleAlert />
      <h3>{{ t('runDetail.loadError') }}</h3>
      <p>{{ error }}</p>
      <div class="row">
        <button class="btn btn-primary" type="button" @click="reload()">{{ t('common.actions.retry') }}</button>
        <RouterLink class="btn" to="/runs">{{ t('runDetail.backToRuns') }}</RouterLink>
      </div>
    </div>

    <div v-else-if="loading || !run || !live" class="card skeleton" style="height: 420px" aria-busy="true" />

    <template v-else>
      <header class="page-header">
        <div class="row" style="gap: 12px; align-items: flex-start">
          <RouterLink class="btn btn-ghost btn-icon" to="/runs" :aria-label="t('runDetail.backToRuns')"><ArrowLeft /></RouterLink>
          <div>
            <div class="row wrap">
              <component
                :is="isWorkflow ? Workflow : Bot"
                style="width: 18px; height: 18px; color: var(--text-3)"
                :aria-label="isWorkflow ? t('runDetail.kind.workflow') : t('runDetail.kind.agent')"
              />
              <h1>{{ run.name }}</h1>
              <StatusBadge :status="live.status" />
            </div>
            <p class="subtitle small">
              {{ formatDateTime(run.createdAt) }}
              <template v-if="run.triggerKind === 'webhook'"> · {{ t('runDetail.header.viaWebhook') }}</template>
              <template v-else-if="run.scheduled"> · {{ t('runDetail.header.scheduled') }}</template>
              <template v-if="run.retryOf">
                · <RouterLink :to="`/runs/${run.retryOf}`">{{ t('runDetail.header.retryOf') }}</RouterLink></template
              >
              <template v-if="run.parentRunId">
                · <RouterLink :to="`/runs/${run.parentRunId}`">{{ t('runDetail.header.childOf') }}</RouterLink></template
              >
              <template v-if="isActive && steps.length > 1"> · {{ t('runDetail.progress.text', progress) }}</template>
            </p>
          </div>
        </div>
        <div class="row wrap">
          <button v-if="isActive" class="btn btn-danger" type="button" :disabled="busy" @click="cancel"><Square /> {{ t('common.actions.cancel') }}</button>
          <template v-else>
            <button
              v-if="canResume"
              class="btn btn-primary"
              type="button"
              :disabled="busy"
              :title="t('runDetail.actions.resumeTitle')"
              @click="retry('failed')"
            >
              <SkipForward /> {{ t('runDetail.actions.resume') }}
            </button>
            <button class="btn" type="button" :disabled="busy" @click="retry('all')"><RotateCcw /> {{ t('runDetail.actions.repeat') }}</button>
            <RouterLink v-if="sourceExists" class="btn" :to="sourceLink"
              ><Pencil /> {{ isWorkflow ? t('runDetail.actions.openWorkflow') : t('runDetail.actions.openAgent') }}</RouterLink
            >
            <button
              class="btn btn-ghost btn-icon"
              type="button"
              :aria-label="t('runDetail.actions.deleteLabel')"
              :title="t('common.actions.delete')"
              :disabled="busy"
              @click="remove"
            >
              <Trash2 />
            </button>
          </template>
        </div>
      </header>

      <div
        v-if="isActive && steps.length > 1"
        class="progress"
        role="progressbar"
        :aria-valuenow="progress.done"
        aria-valuemin="0"
        :aria-valuemax="progress.total"
        :aria-valuetext="t('runDetail.progress.text', progress)"
        :aria-label="t('runDetail.progress.label')"
      >
        <span :style="{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }" />
      </div>

      <div v-if="live.error" class="callout" :class="live.status === 'cancelled' ? 'warning' : 'danger'" role="alert" style="margin-bottom: 14px">
        <CircleAlert /> <span>{{ serverText(live.error, live.errorI18n) }}</span>
      </div>

      <section class="stats card">
        <div>
          <span class="eyebrow">{{ t('runDetail.stats.duration') }}</span><strong class="num">{{ formatDuration(duration) }}</strong>
        </div>
        <div>
          <i18n-t keypath="runDetail.stats.llmCalls" tag="span" class="eyebrow" scope="global"
            ><template #llm><Term id="llm">LLM</Term></template></i18n-t
          ><strong class="num">{{ usage?.llmCalls ?? 0 }}</strong>
        </div>
        <div>
          <span class="eyebrow"
            ><Term id="herramienta">{{ t('runDetail.stats.tools') }}</Term></span
          ><strong class="num">{{ usage?.toolCalls ?? 0 }}</strong>
        </div>
        <div>
          <span class="eyebrow"
            ><Term id="tokens">{{ t('runDetail.stats.tokens') }}</Term></span
          >
          <strong
            class="num"
            :title="t('runDetail.stats.tokensTitle', { input: formatNumber(usage?.promptTokens ?? 0), output: formatNumber(usage?.completionTokens ?? 0) })"
          >
            {{ formatCompact((usage?.promptTokens ?? 0) + (usage?.completionTokens ?? 0)) }}
          </strong>
        </div>
      </section>

      <section v-if="isWorkflow" class="card graph">
        <RunGraph :snapshot="run.snapshot" :live="live" :selected="selected" @select="selected = $event" />
        <i18n-t keypath="runDetail.snapshotNote" tag="p" class="tiny faint snapshot-note" scope="global">
          <template #snapshot
            ><Term id="instantanea">{{ t('runDetail.snapshotNoteSnapshot') }}</Term></template
          >
          <template #workflow
            ><Term id="workflow">{{ t('runDetail.snapshotNoteWorkflow') }}</Term></template
          >
        </i18n-t>
      </section>

      <div class="detail">
        <nav class="card steps" :aria-label="t('runDetail.steps.label')">
          <button class="step" :class="{ active: selected === null }" type="button" :aria-pressed="selected === null" @click="selected = null">
            <LayoutList class="sum-ico" />
            <span class="grow"
              ><strong>{{ t('runDetail.steps.summary') }}</strong
              ><span class="tiny muted">{{ t('runDetail.steps.summaryHint') }}</span></span
            >
          </button>
          <button
            v-for="s in steps"
            :key="s.nodeId"
            class="step"
            :class="{ active: selected === s.nodeId }"
            type="button"
            :aria-pressed="selected === s.nodeId"
            @click="selected = s.nodeId"
          >
            <StatusBadge :status="s.status" icon-only />
            <span class="grow">
              <strong class="truncate">{{ s.label }}</strong>
              <span class="tiny muted">
                {{ NODE_LABEL[s.nodeType] }}
                <template v-if="s.attempt > 1"> · {{ t('runDetail.steps.attempt', { n: s.attempt }) }}</template>
                <template v-if="stepDuration(s)"> · {{ stepDuration(s) }}</template>
              </span>
            </span>
            <span v-if="s.usage.promptTokens + s.usage.completionTokens" class="tiny faint num">{{
              formatCompact(s.usage.promptTokens + s.usage.completionTokens)
            }}</span>
          </button>
        </nav>

        <section class="card panel">
          <div class="panel-head">
            <div class="tabs" role="tablist" :aria-label="t('runDetail.tabs.label')" @keydown="onTabKey">
              <button
                id="run-tab-result"
                class="tab"
                :class="{ active: tab === 'result' }"
                role="tab"
                aria-controls="run-panel"
                :aria-selected="tab === 'result'"
                :tabindex="tab === 'result' ? 0 : -1"
                type="button"
                @click="tab = 'result'"
              >
                {{ t('runDetail.tabs.result') }}
              </button>
              <button
                id="run-tab-activity"
                class="tab"
                :class="{ active: tab === 'activity' }"
                role="tab"
                aria-controls="run-panel"
                :aria-selected="tab === 'activity'"
                :tabindex="tab === 'activity' ? 0 : -1"
                type="button"
                @click="tab = 'activity'"
              >
                {{ t('runDetail.tabs.activity') }}
                <span class="badge" style="height: 18px" :title="hasOlder ? t('runDetail.tabs.activityPartial') : undefined"
                  >{{ activityCount }}<template v-if="hasOlder">+</template></span
                >
              </button>
              <button
                id="run-tab-input"
                class="tab"
                :class="{ active: tab === 'input' }"
                role="tab"
                aria-controls="run-panel"
                :aria-selected="tab === 'input'"
                :tabindex="tab === 'input' ? 0 : -1"
                type="button"
                @click="tab = 'input'"
              >
                {{ t('runDetail.tabs.input') }}
              </button>
            </div>
          </div>

          <div id="run-panel" class="panel-body" role="tabpanel" :aria-labelledby="`run-tab-${tab}`">
            <!-- Resultado -->
            <template v-if="tab === 'result'">
              <div v-if="step?.error" class="callout danger" role="alert">
                <CircleAlert /> <span>{{ serverText(step.error, step.errorI18n) }}</span>
              </div>

              <template v-if="resultText">
                <div class="row between">
                  <span class="eyebrow">{{
                    step
                      ? step.status === 'running'
                        ? t('runDetail.result.generating')
                        : isPartial
                          ? t('runDetail.result.partial')
                          : t('runDetail.result.stepOutput')
                      : t('runDetail.result.final')
                  }}</span>
                  <div class="row" style="gap: 4px">
                    <div class="segmented">
                      <button type="button" :class="{ active: !raw }" @click="raw = false">{{ t('runDetail.result.formatted') }}</button>
                      <button type="button" :class="{ active: raw }" @click="raw = true">{{ t('runDetail.result.plain') }}</button>
                    </div>
                    <button
                      class="btn btn-ghost btn-icon btn-sm"
                      type="button"
                      :aria-label="t('runDetail.result.copyLabel')"
                      :title="t('common.actions.copy')"
                      @click="copy(resultText)"
                    >
                      <Copy />
                    </button>
                  </div>
                </div>
                <pre v-if="raw" class="codeblock" style="max-height: none">{{ resultText }}</pre>
                <div v-else class="output">
                  <MarkdownView :source="resultText" /><span v-if="step?.status === 'running'" class="caret" aria-hidden="true" />
                </div>
              </template>

              <!-- Resumen en curso: lo que están generando ahora mismo los pasos activos -->
              <template v-else-if="!step && isActive">
                <p v-if="waitingSteps.length" class="callout warning" role="status">
                  <Hourglass />
                  <span>{{ t('runDetail.result.waitingApproval', { steps: waitingSteps.map((s) => s.label).join(t('runDetail.result.waitingJoin')) }) }}</span>
                </p>
                <p v-else-if="!runningSteps.length" class="muted row">
                  <span class="dot info pulse" /> {{ live.status === 'queued' ? t('runDetail.result.queued') : t('runDetail.result.preparing') }}
                </p>
                <div v-for="s in runningSteps" :key="s.nodeId" class="stream">
                  <button class="row stream-head" type="button" @click="selected = s.nodeId">
                    <StatusBadge status="running" icon-only /> <strong>{{ s.label }}</strong>
                    <span class="tiny muted">{{ stepDuration(s) }}</span>
                  </button>
                  <div v-if="s.streamText" class="output"><MarkdownView :source="s.streamText" /><span class="caret" aria-hidden="true" /></div>
                  <p v-else-if="s.thinkingText" class="small muted thinking">{{ s.thinkingText.slice(-300) }}</p>
                  <p v-else class="small muted">{{ t('runDetail.result.waitingModel') }}</p>
                </div>
              </template>

              <template v-else-if="step">
                <p v-if="step.status === 'running'" class="muted row">
                  <span class="dot info pulse" /> {{ step.thinkingText ? t('runDetail.result.reasoning') : t('runDetail.result.waitingModel') }}
                </p>
                <p v-else-if="step.status === 'waiting'" class="muted row">
                  <Hourglass style="width: 15px; height: 15px" /> {{ t('runDetail.result.stepWaiting') }}
                </p>
                <p v-else-if="step.status === 'pending'" class="muted">{{ t('runDetail.result.stepPending') }}</p>
                <p v-else-if="step.status === 'skipped'" class="muted">{{ t('runDetail.result.stepSkipped') }}</p>
                <p v-else-if="step.status === 'cancelled'" class="muted">{{ t('runDetail.result.stepCancelled') }}</p>
                <p v-else-if="!step.error" class="muted">{{ t('runDetail.result.stepNoOutput') }}</p>
              </template>
              <p v-else-if="!live.error" class="muted">{{ t('runDetail.result.runNoOutput') }}</p>

              <!-- Subejecuciones lanzadas por este paso (subworkflow, o «para cada» con un subworkflow por elemento) -->
              <div v-if="stepChildren.length" class="children">
                <span class="eyebrow">{{ tn('runDetail.children.title', stepChildren.length) }}</span>
                <ul>
                  <li v-for="child in stepChildren" :key="child.id">
                    <StatusBadge :status="child.status" icon-only />
                    <RouterLink :to="`/runs/${child.id}`">{{ child.name }}</RouterLink>
                    <span class="muted small truncate">{{ child.input }}</span>
                  </li>
                </ul>
              </div>
            </template>

            <!-- Actividad -->
            <RunActivity
              v-else-if="tab === 'activity'"
              :log="live.activity"
              :node-id="selected"
              :labels="labels"
              :has-older="hasOlder"
              :loading-older="loadingOlder"
              @older="olderActivity"
            />

            <!-- Entrada -->
            <template v-else>
              <i18n-t v-if="step?.nodeType === 'agent'" keypath="runDetail.input.agentTask" tag="span" class="eyebrow" scope="global">
                <template #template
                  ><Term id="plantilla">{{ t('runDetail.input.agentTaskTemplate') }}</Term></template
                >
              </i18n-t>
              <span v-else class="eyebrow">{{ step ? t('runDetail.input.stepInput') : t('runDetail.input.runInput') }}</span>
              <pre v-if="step ? step.input : run.input" class="codeblock" style="max-height: none">{{ step ? step.input : run.input }}</pre>
              <p v-else class="muted">{{ step ? t('runDetail.input.stepNone') : t('runDetail.input.runNone') }}</p>
            </template>
          </div>
        </section>
      </div>
    </template>
  </div>
</template>

<style scoped>
.children {
  margin-top: 14px;
}
.children ul {
  list-style: none;
  margin: 6px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.children li {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.children a {
  text-decoration: underline;
  flex: none;
}
.progress {
  height: 4px;
  border-radius: 2px;
  background: var(--surface-3);
  overflow: hidden;
  margin-bottom: 14px;
}
.progress span {
  display: block;
  height: 100%;
  background: var(--info);
  transition: width 0.3s ease;
}
.stats {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  margin-bottom: 14px;
}
.stats > div {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 12px 18px;
  border-right: 1px solid var(--border);
}
.stats > div:last-child {
  border-right: 0;
}
.stats strong {
  font-family: var(--font-display);
  font-size: 19px;
  font-weight: 650;
}
.snapshot-note {
  position: absolute;
  left: 12px;
  top: 8px;
  margin: 0;
  z-index: 5;
}
.graph {
  position: relative;
  height: 340px;
  margin-bottom: 14px;
  overflow: hidden;
}
.detail {
  display: grid;
  grid-template-columns: 290px minmax(0, 1fr);
  gap: 14px;
  align-items: start;
}
.steps {
  display: flex;
  flex-direction: column;
  padding: 6px;
  gap: 2px;
}
.step {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 8px 10px;
  border: 0;
  border-radius: 8px;
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  min-width: 0;
}
.step .grow {
  display: flex;
  flex-direction: column;
}
.step:hover {
  background: var(--surface-2);
}
.step.active {
  background: var(--accent-soft);
}
.sum-ico {
  width: 22px;
  height: 16px;
  color: var(--text-3);
  flex: none;
}
.panel-head {
  padding: 4px 14px 0;
}
.panel-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px 18px 20px;
  min-height: 180px;
}
.output {
  overflow-wrap: anywhere;
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
.stream {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 10px 14px 12px;
}
.stream + .stream {
  margin-top: 4px;
}
.stream-head {
  border: 0;
  background: none;
  padding: 0 0 8px;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.thinking {
  font-style: italic;
  overflow-wrap: anywhere;
}
@media (max-width: 900px) {
  .detail {
    grid-template-columns: 1fr;
  }
  .stats {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .stats > div:nth-child(2) {
    border-right: 0;
  }
  .stats > div:nth-child(-n + 2) {
    border-bottom: 1px solid var(--border);
  }
}
</style>
