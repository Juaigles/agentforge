<script setup lang="ts">
import type { RunKind, RunStatus, RunSummary } from '@shared/types';
import { Activity, Bot, CircleAlert, RefreshCw, Search, Square, Trash2, Workflow } from 'lucide-vue-next';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import StatusBadge from '@/components/StatusBadge.vue';
import Term from '@/components/Term.vue';
import { api, errorText } from '@/lib/api';
import { elapsedMs, formatCompact, formatDateTime, formatDuration, isActiveStatus, relativeTime } from '@/lib/format';
import { useNow } from '@/lib/useNow';
import { useRuns } from '@/stores/runs';
import { useUi } from '@/stores/ui';

const PAGE = 30;
/** Máximo de filas que el servidor entrega en una petición. */
const MAX_REFRESH = 200;
const STATUSES: Array<{ value: RunStatus | ''; label: string }> = [
  { value: '', label: 'Todas' },
  { value: 'running', label: 'En curso' },
  { value: 'completed', label: 'Completadas' },
  { value: 'failed', label: 'Fallidas' },
  { value: 'cancelled', label: 'Canceladas' },
];

const router = useRouter();
const runsStore = useRuns();
const ui = useUi();
const now = useNow();

const items = ref<RunSummary[]>([]);
const total = ref(0);
/** La búsqueda encontró más coincidencias de las que examina: `total` es solo la parte examinada. */
const capped = ref(false);
const status = ref<RunStatus | ''>('');
const kind = ref<RunKind | ''>('');
const search = ref('');
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
watch([status, kind], resetAndLoad);
watch(search, () => {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(resetAndLoad, 250);
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
  const ok = await ui.confirm({ title: 'Eliminar ejecución', message: `Se eliminará la ejecución de «${run.name}» con todos sus eventos.`, confirmLabel: 'Eliminar', danger: true });
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
    title: 'Vaciar historial',
    message: 'Se eliminarán todas las ejecuciones terminadas (completadas, fallidas y canceladas). Las que están en curso no se tocan.',
    confirmLabel: 'Eliminar terminadas',
    danger: true,
  });
  if (!ok) return;
  try {
    const { deleted } = await api.runs.clearFinished();
    ui.success(`${deleted} ejecuciones eliminadas.`);
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
        <h1>Ejecuciones</h1>
        <p class="subtitle">
          Historial de cada <Term id="ejecucion">ejecución</Term> de agentes y workflows. La lista se actualiza sola mediante
          <Term id="streaming">streaming</Term> de eventos.
        </p>
      </div>
      <div class="row">
        <button class="btn" type="button" :disabled="loading" @click="load()"><RefreshCw :class="{ spin: loading }" /> Actualizar</button>
        <button class="btn btn-danger" type="button" :disabled="!hasFinished" @click="clearFinished"><Trash2 /> Vaciar historial</button>
      </div>
    </header>

    <div class="filters">
      <div class="segmented" role="group" aria-label="Filtrar por estado">
        <button v-for="s in STATUSES" :key="s.value" type="button" :class="{ active: status === s.value }" :aria-pressed="status === s.value" @click="status = s.value">
          {{ s.label }}
        </button>
      </div>
      <select v-model="kind" class="select" style="width: auto" aria-label="Filtrar por tipo">
        <option value="">Agentes y workflows</option>
        <option value="workflow">Solo workflows</option>
        <option value="agent">Solo agentes</option>
      </select>
      <div class="search grow">
        <Search aria-hidden="true" />
        <input v-model="search" class="input" type="search" placeholder="Buscar por nombre, entrada o resultado…" aria-label="Buscar ejecuciones" />
      </div>
    </div>

    <div v-if="error" class="callout danger" role="alert" style="margin-bottom: 14px"><CircleAlert /> {{ error }}</div>

    <section class="card">
      <div v-if="items.length" class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>Nombre</th><th>Estado</th><th>Entrada / resultado</th><th class="right">Duración</th><th class="right"><Term id="tokens">Tokens</Term></th><th class="right">Inicio</th><th><span class="sr-only">Acciones</span></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="run in items" :key="run.id" class="clickable" @click="router.push(`/runs/${run.id}`)">
              <td>
                <RouterLink :to="`/runs/${run.id}`" class="row name" @click.stop>
                  <component :is="run.kind === 'workflow' ? Workflow : Bot" class="kind" :aria-label="run.kind === 'workflow' ? 'Workflow' : 'Agente'" />
                  <span>
                    <strong>{{ run.name }}</strong>
                    <span v-if="run.retryOf" class="badge" style="margin-left: 6px; height: 18px">reintento</span>
                    <span v-if="run.scheduled" class="badge info" style="margin-left: 6px; height: 18px" title="La lanzó la programación del workflow">programada</span>
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
                <button v-if="isActiveStatus(run.status)" class="btn btn-ghost btn-icon btn-sm" type="button" :aria-label="`Cancelar ${run.name}`" title="Cancelar" @click="cancel(run)"><Square /></button>
                <button v-else class="btn btn-ghost btn-icon btn-sm" type="button" :aria-label="`Eliminar ejecución de ${run.name}`" title="Eliminar" @click="remove(run)"><Trash2 /></button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-else-if="loading" class="skeleton" style="height: 220px; margin: 16px" aria-busy="true" />
      <div v-else class="empty">
        <Activity />
        <template v-if="filtered">
          <h3>Ninguna ejecución coincide con el filtro</h3>
          <button class="btn" type="button" @click="((status = ''), (kind = ''), (search = ''))">Quitar filtros</button>
        </template>
        <template v-else>
          <h3>Aún no hay ejecuciones</h3>
          <p>Prueba un <Term id="agente">agente</Term> desde su ficha o lanza un <Term id="workflow">workflow</Term>: su progreso aparecerá aquí en tiempo real.</p>
          <RouterLink class="btn btn-primary" to="/workflows">Ir a workflows</RouterLink>
        </template>
      </div>
    </section>

    <div v-if="items.length" class="row between" style="margin-top: 12px">
      <span class="small muted" role="status">Mostrando {{ items.length }} de {{ capped ? 'más de ' : '' }}{{ total }}{{ capped ? ' (las coincidencias más recientes)' : '' }}</span>
      <button v-if="items.length < total" class="btn" type="button" :disabled="loadingMore" @click="load(false)">{{ loadingMore ? 'Cargando…' : 'Cargar más' }}</button>
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
