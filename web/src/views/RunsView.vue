<script setup lang="ts">
import type { RunKind, RunStatus, RunSummary } from '@shared/types';
import { Activity, Bot, CircleAlert, RefreshCw, Search, Square, Trash2, Workflow } from 'lucide-vue-next';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import StatusBadge from '@/components/StatusBadge.vue';
import Term from '@/components/Term.vue';
import { t, tn } from '@/i18n';
import { api, errorText } from '@/lib/api';
import { elapsedMs, formatCompact, formatDateTime, formatDuration, isActiveStatus, relativeTime } from '@/lib/format';
import { useNow } from '@/lib/useNow';
import { useRuns } from '@/stores/runs';
import { useUi } from '@/stores/ui';

const PAGE = 30;
/** Máximo de filas que el servidor entrega en una petición. */
const MAX_REFRESH = 200;
const STATUSES: Array<{ value: RunStatus | ''; labelKey: string }> = [
  { value: '', labelKey: 'runs.filters.all' },
  { value: 'running', labelKey: 'runs.filters.running' },
  { value: 'completed', labelKey: 'runs.filters.completed' },
  { value: 'failed', labelKey: 'runs.filters.failed' },
  { value: 'cancelled', labelKey: 'runs.filters.cancelled' },
];

const route = useRoute();
const router = useRouter();
const runsStore = useRuns();
const ui = useUi();
const now = useNow();

const items = ref<RunSummary[]>([]);
const total = ref(0);
/** La búsqueda encontró más coincidencias de las que examina: `total` es solo la parte examinada. */
const capped = ref(false);
// Los filtros viven en la URL (?estado=&tipo=&q=): se conservan al abrir una ejecución y volver, al recargar
// y al compartir o guardar el enlace.
const queryText = (value: unknown): string => (typeof value === 'string' ? value : '');
const fromQuery = <T extends string>(value: unknown, allowed: readonly T[]): T | '' => (allowed.includes(queryText(value) as T) ? (queryText(value) as T) : '');
const status = ref<RunStatus | ''>(fromQuery(route.query.estado, ['running', 'completed', 'failed', 'cancelled'] as const));
const kind = ref<RunKind | ''>(fromQuery(route.query.tipo, ['workflow', 'agent'] as const));
const search = ref(queryText(route.query.q));
function syncUrl(): void {
  const query: Record<string, string> = {};
  if (status.value) query.estado = status.value;
  if (kind.value) query.tipo = kind.value;
  if (search.value.trim()) query.q = search.value.trim();
  // `replace`: escribir en el buscador no llena el historial del navegador de pasos intermedios.
  void router.replace({ query });
}
const loading = ref(true);
const loadingMore = ref(false);
const error = ref<string | null>(null);
let searchTimer: ReturnType<typeof setTimeout> | null = null;
let liveTimer: ReturnType<typeof setTimeout> | null = null;

async function load(reset = true): Promise<void> {
  if (reset) loading.value = items.value.length === 0;
  else loadingMore.value = true;
  try {
    const res = await api.runs.list({
      status: status.value,
      kind: kind.value,
      search: search.value.trim(),
      // Al refrescar se conserva todo lo ya cargado para no perder la posición.
      // (El servidor entrega 200 como máximo: pedir más haría que la lista se encogiera sola al refrescar.)
      limit: reset ? Math.min(MAX_REFRESH, Math.max(PAGE, items.value.length)) : PAGE,
      offset: reset ? 0 : items.value.length,
    });
    items.value = reset ? res.items : [...items.value, ...res.items];
    total.value = res.total;
    capped.value = Boolean(res.capped);
    error.value = null;
  } catch (err) {
    error.value = errorText(err);
  } finally {
    loading.value = false;
    loadingMore.value = false;
  }
}

function resetAndLoad(): void {
  items.value = [];
  void load();
}
onMounted(load);
watch([status, kind], () => {
  syncUrl();
  resetAndLoad();
});
watch(search, () => {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    syncUrl();
    resetAndLoad();
  }, 250);
});
// Cualquier cambio en una ejecución (canal SSE global) refresca la lista.
watch(
  () => runsStore.version,
  () => {
    if (liveTimer) clearTimeout(liveTimer);
    liveTimer = setTimeout(() => void load(), 300);
  },
);
onBeforeUnmount(() => {
  if (searchTimer) clearTimeout(searchTimer);
  if (liveTimer) clearTimeout(liveTimer);
});

const filtered = computed(() => !!(status.value || kind.value || search.value.trim()));
const hasFinished = computed(() => items.value.some((r) => !isActiveStatus(r.status)));

async function cancel(run: RunSummary): Promise<void> {
  try {
    await api.runs.cancel(run.id);
  } catch (err) {
    ui.error(errorText(err));
  }
}

async function remove(run: RunSummary): Promise<void> {
  const ok = await ui.confirm({ title: t('runs.confirm.deleteTitle'), message: t('runs.confirm.deleteMessage', { name: run.name }), confirmLabel: t('common.actions.delete'), danger: true });
  if (!ok) return;
  try {
    await api.runs.remove(run.id);
    runsStore.forget(run.id);
    items.value = items.value.filter((r) => r.id !== run.id);
    total.value--;
  } catch (err) {
    ui.error(errorText(err));
  }
}

async function clearFinished(): Promise<void> {
  const ok = await ui.confirm({
    title: t('runs.confirm.clearTitle'),
    message: t('runs.confirm.clearMessage'),
    confirmLabel: t('runs.confirm.clearConfirm'),
    danger: true,
  });
  if (!ok) return;
  try {
    const { deleted } = await api.runs.clearFinished();
    ui.success(tn('runs.toast.cleared', deleted));
    resetAndLoad();
  } catch (err) {
    ui.error(errorText(err));
  }
}
</script>

<template>
  <div class="page">
    <header class="page-header">
      <div>
        <h1>{{ t('runs.title') }}</h1>
        <i18n-t keypath="runs.subtitle" tag="p" class="subtitle" scope="global">
          <template #run><Term id="ejecucion">{{ t('runs.subtitleRun') }}</Term></template>
          <template #streaming><Term id="streaming">{{ t('runs.subtitleStreaming') }}</Term></template>
        </i18n-t>
      </div>
      <div class="row">
        <button class="btn" type="button" :disabled="loading" @click="load()"><RefreshCw :class="{ spin: loading }" /> {{ t('runs.actions.refresh') }}</button>
        <button class="btn btn-danger" type="button" :disabled="!hasFinished" @click="clearFinished"><Trash2 /> {{ t('runs.actions.clearHistory') }}</button>
      </div>
    </header>

    <div class="filters">
      <div class="segmented" role="group" :aria-label="t('runs.filters.statusLabel')">
        <button v-for="s in STATUSES" :key="s.value" type="button" :class="{ active: status === s.value }" :aria-pressed="status === s.value" @click="status = s.value">
          {{ t(s.labelKey) }}
        </button>
      </div>
      <select v-model="kind" class="select" style="width: auto" :aria-label="t('runs.filters.kindLabel')">
        <option value="">{{ t('runs.filters.kindAll') }}</option>
        <option value="workflow">{{ t('runs.filters.kindWorkflows') }}</option>
        <option value="agent">{{ t('runs.filters.kindAgents') }}</option>
      </select>
      <div class="search grow">
        <Search aria-hidden="true" />
        <input v-model="search" class="input" type="search" :placeholder="t('runs.filters.searchPlaceholder')" :aria-label="t('runs.filters.searchLabel')" />
      </div>
    </div>

    <div v-if="error" class="callout danger" role="alert" style="margin-bottom: 14px"><CircleAlert /> {{ error }}</div>

    <section class="card">
      <div v-if="items.length" class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>{{ t('runs.table.name') }}</th><th>{{ t('runs.table.status') }}</th><th>{{ t('runs.table.inputOutput') }}</th><th class="right">{{ t('runs.table.duration') }}</th><th class="right"><Term id="tokens">{{ t('runs.table.tokens') }}</Term></th><th class="right">{{ t('runs.table.start') }}</th><th><span class="sr-only">{{ t('runs.table.actions') }}</span></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="run in items" :key="run.id" class="clickable" @click="router.push(`/runs/${run.id}`)">
              <td>
                <RouterLink :to="`/runs/${run.id}`" class="row name" @click.stop>
                  <component :is="run.kind === 'workflow' ? Workflow : Bot" class="kind" :aria-label="run.kind === 'workflow' ? t('runs.row.workflow') : t('runs.row.agent')" />
                  <span>
                    <strong>{{ run.name }}</strong>
                    <span v-if="run.retryOf" class="badge" style="margin-left: 6px; height: 18px">{{ t('runs.row.retry') }}</span>
                    <span v-if="run.parentRunId" class="badge" style="margin-left: 6px; height: 18px" :title="t('runs.row.childTitle')">{{ t('runs.row.child') }}</span>
                    <span v-if="run.triggerKind === 'webhook'" class="badge info" style="margin-left: 6px; height: 18px" :title="t('runs.row.webhookTitle')">{{ t('runs.row.webhook') }}</span>
                    <span v-else-if="run.scheduled" class="badge info" style="margin-left: 6px; height: 18px" :title="t('runs.row.scheduledTitle')">{{ t('runs.row.scheduled') }}</span>
                  </span>
                </RouterLink>
              </td>
              <td><StatusBadge :status="run.status" /></td>
              <td>
                <div class="truncate cell-text">{{ run.input || '—' }}</div>
                <div v-if="run.error" class="truncate cell-text tiny" style="color: var(--danger)">{{ run.error }}</div>
                <div v-else-if="run.output" class="truncate cell-text tiny faint">{{ run.output }}</div>
              </td>
              <td class="right num">{{ formatDuration(elapsedMs(run.startedAt, run.finishedAt, now)) }}</td>
              <td class="right num">{{ formatCompact(run.usage.promptTokens + run.usage.completionTokens) }}</td>
              <td class="right muted" style="white-space: nowrap" :title="formatDateTime(run.createdAt)">{{ relativeTime(run.createdAt, now) }}</td>
              <td class="right" @click.stop>
                <button v-if="isActiveStatus(run.status)" class="btn btn-ghost btn-icon btn-sm" type="button" :aria-label="t('runs.row.cancelLabel', { name: run.name })" :title="t('common.actions.cancel')" @click="cancel(run)"><Square /></button>
                <button v-else class="btn btn-ghost btn-icon btn-sm" type="button" :aria-label="t('runs.row.deleteLabel', { name: run.name })" :title="t('common.actions.delete')" @click="remove(run)"><Trash2 /></button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-else-if="loading" class="skeleton" style="height: 220px; margin: 16px" aria-busy="true" />
      <div v-else class="empty">
        <Activity />
        <template v-if="filtered">
          <h3>{{ t('runs.empty.noMatch') }}</h3>
          <button class="btn" type="button" @click="((status = ''), (kind = ''), (search = ''))">{{ t('runs.empty.clearFilters') }}</button>
        </template>
        <template v-else>
          <h3>{{ t('runs.empty.none') }}</h3>
          <i18n-t keypath="runs.empty.noneText" tag="p" scope="global">
            <template #agent><Term id="agente">{{ t('runs.empty.noneAgent') }}</Term></template>
            <template #workflow><Term id="workflow">{{ t('runs.empty.noneWorkflow') }}</Term></template>
          </i18n-t>
          <RouterLink class="btn btn-primary" to="/workflows">{{ t('runs.empty.goToWorkflows') }}</RouterLink>
        </template>
      </div>
    </section>

    <div v-if="items.length" class="row between" style="margin-top: 12px">
      <span class="small muted" role="status">{{ t(capped ? 'runs.footer.showingCapped' : 'runs.footer.showing', { n: items.length, total }) }}</span>
      <button v-if="items.length < total" class="btn" type="button" :disabled="loadingMore" @click="load(false)">{{ loadingMore ? t('common.actions.loading') : t('runs.footer.loadMore') }}</button>
    </div>
  </div>
</template>

<style scoped>
.filters {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}
.search {
  position: relative;
  min-width: 200px;
  max-width: 340px;
}
.search svg {
  position: absolute;
  left: 10px;
  top: 9px;
  width: 16px;
  height: 16px;
  color: var(--text-3);
}
.search .input {
  padding-left: 32px;
}
.name {
  color: inherit;
}
.name:hover {
  text-decoration: none;
}
.kind {
  width: 15px;
  height: 15px;
  color: var(--text-3);
  flex: none;
}
.cell-text {
  max-width: 360px;
}
</style>
