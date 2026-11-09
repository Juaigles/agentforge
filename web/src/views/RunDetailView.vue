<script setup lang="ts">
// Monitor de una ejecución: grafo con estados en vivo, pasos, resultado en streaming y registro de actividad.
import { ArrowLeft, Bot, CircleAlert, Copy, LayoutList, Pencil, RotateCcw, SkipForward, Square, Trash2, Workflow } from 'lucide-vue-next';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import MarkdownView from '@/components/MarkdownView.vue';
import RunActivity from '@/components/RunActivity.vue';
import RunGraph from '@/components/RunGraph.vue';
import StatusBadge from '@/components/StatusBadge.vue';
import Term from '@/components/Term.vue';
import { api, errorText } from '@/lib/api';
import { elapsedMs, formatCompact, formatDateTime, formatDuration, formatNumber, NODE_LABEL } from '@/lib/format';
import { useNow } from '@/lib/useNow';
import { useRunStream } from '@/lib/useRunStream';
import { useCatalog } from '@/stores/catalog';
import { useRuns } from '@/stores/runs';
import { useUi } from '@/stores/ui';

const route = useRoute();
const router = useRouter();
const ui = useUi();
const runsStore = useRuns();
const catalog = useCatalog();
const now = useNow(500);

const runId = computed(() => String(route.params.id));
const { run, live, loading, error, usage, isActive } = useRunStream(runId);

const selected = ref<string | null>(null);
const tab = ref<'result' | 'activity' | 'input'>('result');
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
const step = computed(() => (selected.value && live.value ? (live.value.steps[selected.value] ?? null) : null));
const labels = computed(() => Object.fromEntries(steps.value.map((s) => [s.nodeId, s.label])));
const runningSteps = computed(() => steps.value.filter((s) => s.status === 'running'));
const isWorkflow = computed(() => run.value?.kind === 'workflow');
const duration = computed(() => (live.value ? elapsedMs(live.value.startedAt, live.value.finishedAt, now.value) : null));
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
  if (step.value) return step.value.output ?? step.value.streamText ?? '';
  return live.value?.output ?? '';
});
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
  const ok = await ui.confirm({ title: 'Eliminar ejecución', message: 'Se eliminará esta ejecución con todos sus eventos.', confirmLabel: 'Eliminar', danger: true });
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
    ui.success('Copiado al portapapeles.');
  } catch {
    ui.error('No se pudo copiar al portapapeles.');
  }
}
</script>

<template>
  <div class="page">
    <div v-if="error" class="card empty">
      <CircleAlert />
      <h3>No se pudo cargar la ejecución</h3>
      <p>{{ error }}</p>
      <RouterLink class="btn" to="/runs">Volver a ejecuciones</RouterLink>
    </div>

    <div v-else-if="loading || !run || !live" class="card skeleton" style="height: 420px" aria-busy="true" />

    <template v-else>
      <header class="page-header">
        <div class="row" style="gap: 12px; align-items: flex-start">
          <RouterLink class="btn btn-ghost btn-icon" to="/runs" aria-label="Volver a ejecuciones"><ArrowLeft /></RouterLink>
          <div>
            <div class="row wrap">
              <component :is="isWorkflow ? Workflow : Bot" style="width: 18px; height: 18px; color: var(--text-3)" :aria-label="isWorkflow ? 'Workflow' : 'Agente'" />
              <h1>{{ run.name }}</h1>
              <StatusBadge :status="live.status" />
            </div>
            <p class="subtitle small">
              {{ formatDateTime(run.createdAt) }}
              <template v-if="run.retryOf"> · <RouterLink :to="`/runs/${run.retryOf}`">reintento de una ejecución anterior</RouterLink></template>
              <template v-if="isActive && steps.length > 1"> · {{ progress.done }} de {{ progress.total }} pasos</template>
            </p>
          </div>
        </div>
        <div class="row wrap">
          <button v-if="isActive" class="btn btn-danger" type="button" :disabled="busy" @click="cancel"><Square /> Cancelar</button>
          <template v-else>
            <button v-if="canResume" class="btn btn-primary" type="button" :disabled="busy" title="Reutiliza los pasos que terminaron bien" @click="retry('failed')">
              <SkipForward /> Reintentar desde el fallo
            </button>
            <button class="btn" type="button" :disabled="busy" @click="retry('all')"><RotateCcw /> Repetir</button>
            <RouterLink v-if="sourceExists" class="btn" :to="sourceLink"><Pencil /> {{ isWorkflow ? 'Abrir workflow' : 'Abrir agente' }}</RouterLink>
            <button class="btn btn-ghost btn-icon" type="button" aria-label="Eliminar ejecución" title="Eliminar" :disabled="busy" @click="remove"><Trash2 /></button>
          </template>
        </div>
      </header>

      <div v-if="isActive && steps.length > 1" class="progress" role="progressbar" :aria-valuenow="progress.done" :aria-valuemax="progress.total" aria-label="Progreso">
        <span :style="{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }" />
      </div>

      <div v-if="live.error" class="callout" :class="live.status === 'cancelled' ? 'warning' : 'danger'" role="alert" style="margin-bottom: 14px">
        <CircleAlert /> <span>{{ live.error }}</span>
      </div>

      <section class="stats card">
        <div><span class="eyebrow">Duración</span><strong class="num">{{ formatDuration(duration) }}</strong></div>
        <div><span class="eyebrow">Llamadas al <Term id="llm">LLM</Term></span><strong class="num">{{ usage?.llmCalls ?? 0 }}</strong></div>
        <div><span class="eyebrow"><Term id="herramienta">Herramientas</Term></span><strong class="num">{{ usage?.toolCalls ?? 0 }}</strong></div>
        <div>
          <span class="eyebrow"><Term id="tokens">Tokens</Term></span>
          <strong class="num" :title="`${formatNumber(usage?.promptTokens ?? 0)} de entrada · ${formatNumber(usage?.completionTokens ?? 0)} de salida`">
            {{ formatCompact((usage?.promptTokens ?? 0) + (usage?.completionTokens ?? 0)) }}
          </strong>
        </div>
      </section>

      <section v-if="isWorkflow" class="card graph">
        <RunGraph :snapshot="run.snapshot" :live="live" :selected="selected" @select="selected = $event" />
      </section>

      <div class="detail">
        <nav class="card steps" aria-label="Pasos">
          <button class="step" :class="{ active: selected === null }" type="button" @click="selected = null">
            <LayoutList class="sum-ico" />
            <span class="grow"><strong>Resumen</strong><span class="tiny muted">Resultado final y toda la actividad</span></span>
          </button>
          <button v-for="s in steps" :key="s.nodeId" class="step" :class="{ active: selected === s.nodeId }" type="button" @click="selected = s.nodeId">
            <StatusBadge :status="s.status" icon-only />
            <span class="grow">
              <strong class="truncate">{{ s.label }}</strong>
              <span class="tiny muted">
                {{ NODE_LABEL[s.nodeType] }}
                <template v-if="s.attempt > 1"> · intento {{ s.attempt }}</template>
                <template v-if="stepDuration(s)"> · {{ stepDuration(s) }}</template>
              </span>
            </span>
            <span v-if="s.usage.promptTokens + s.usage.completionTokens" class="tiny faint num">{{ formatCompact(s.usage.promptTokens + s.usage.completionTokens) }}</span>
          </button>
        </nav>

        <section class="card panel">
          <div class="panel-head">
            <div class="tabs" role="tablist">
              <button class="tab" :class="{ active: tab === 'result' }" role="tab" :aria-selected="tab === 'result'" type="button" @click="tab = 'result'">Resultado</button>
              <button class="tab" :class="{ active: tab === 'activity' }" role="tab" :aria-selected="tab === 'activity'" type="button" @click="tab = 'activity'">
                Actividad <span class="badge" style="height: 18px">{{ live.events.filter((e) => !selected || e.nodeId === selected).length }}</span>
              </button>
              <button class="tab" :class="{ active: tab === 'input' }" role="tab" :aria-selected="tab === 'input'" type="button" @click="tab = 'input'">Entrada</button>
            </div>
          </div>

          <div class="panel-body">
            <!-- Resultado -->
            <template v-if="tab === 'result'">
              <div v-if="step?.error" class="callout danger" role="alert"><CircleAlert /> <span>{{ step.error }}</span></div>

              <template v-if="resultText">
                <div class="row between">
                  <span class="eyebrow">{{ step ? (step.status === 'running' ? 'Generando…' : 'Salida del paso') : 'Resultado final' }}</span>
                  <div class="row" style="gap: 4px">
                    <div class="segmented">
                      <button type="button" :class="{ active: !raw }" @click="raw = false">Formato</button>
                      <button type="button" :class="{ active: raw }" @click="raw = true">Texto</button>
                    </div>
                    <button class="btn btn-ghost btn-icon btn-sm" type="button" aria-label="Copiar resultado" title="Copiar" @click="copy(resultText)"><Copy /></button>
                  </div>
                </div>
                <pre v-if="raw" class="codeblock" style="max-height: none">{{ resultText }}</pre>
                <div v-else class="output"><MarkdownView :source="resultText" /><span v-if="step?.status === 'running'" class="caret" aria-hidden="true" /></div>
              </template>

              <!-- Resumen en curso: lo que están generando ahora mismo los pasos activos -->
              <template v-else-if="!step && isActive">
                <p v-if="!runningSteps.length" class="muted row"><span class="dot info pulse" /> {{ live.status === 'queued' ? 'En cola, esperando turno…' : 'Preparando el siguiente paso…' }}</p>
                <div v-for="s in runningSteps" :key="s.nodeId" class="stream">
                  <button class="row stream-head" type="button" @click="selected = s.nodeId">
                    <StatusBadge status="running" icon-only /> <strong>{{ s.label }}</strong>
                    <span class="tiny muted">{{ stepDuration(s) }}</span>
                  </button>
                  <div v-if="s.streamText" class="output"><MarkdownView :source="s.streamText" /><span class="caret" aria-hidden="true" /></div>
                  <p v-else-if="s.thinkingText" class="small muted thinking">{{ s.thinkingText.slice(-300) }}</p>
                  <p v-else class="small muted">Esperando al modelo…</p>
                </div>
              </template>

              <template v-else-if="step">
                <p v-if="step.status === 'running'" class="muted row">
                  <span class="dot info pulse" /> {{ step.thinkingText ? 'El modelo está razonando…' : 'Esperando al modelo…' }}
                </p>
                <p v-else-if="step.status === 'pending'" class="muted">Este paso todavía no ha empezado.</p>
                <p v-else-if="step.status === 'skipped'" class="muted">Este paso se omitió: pertenece a una rama no tomada o dependía de un paso fallido.</p>
                <p v-else-if="step.status === 'cancelled'" class="muted">Este paso se canceló antes de terminar.</p>
                <p v-else-if="!step.error" class="muted">Este paso no produjo salida.</p>
              </template>
              <p v-else-if="!live.error" class="muted">La ejecución no produjo ningún resultado.</p>
            </template>

            <!-- Actividad -->
            <RunActivity v-else-if="tab === 'activity'" :events="live.events" :node-id="selected" :labels="labels" />

            <!-- Entrada -->
            <template v-else>
              <span class="eyebrow">{{ step ? (step.nodeType === 'agent' ? 'Tarea enviada al agente (plantilla ya resuelta)' : 'Datos de entrada del paso') : 'Entrada de la ejecución' }}</span>
              <pre v-if="step ? step.input : run.input" class="codeblock" style="max-height: none">{{ step ? step.input : run.input }}</pre>
              <p v-else class="muted">{{ step ? 'Este paso no registró ninguna entrada.' : 'La ejecución se lanzó sin texto de entrada.' }}</p>
            </template>
          </div>
        </section>
      </div>
    </template>
  </div>
</template>

<style scoped>
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
.graph {
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
