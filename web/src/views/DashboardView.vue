<script setup lang="ts">
import type { DashboardStats, RunSummary } from '@shared/types';
import { Activity, Bot, CircleAlert, Clock, Coins, Gauge, Play, Plus, RefreshCw, Square, Workflow, Wrench } from 'lucide-vue-next';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import AgentAvatar from '@/components/AgentAvatar.vue';
import StatusBadge from '@/components/StatusBadge.vue';
import Term from '@/components/Term.vue';
import { api, errorText } from '@/lib/api';
import { elapsedMs, formatBytes, formatCompact, formatDuration, formatNumber, formatUptime, plural, relativeTime } from '@/lib/format';
import { useNow } from '@/lib/useNow';
import { useCatalog } from '@/stores/catalog';
import { useRuns } from '@/stores/runs';
import { useUi } from '@/stores/ui';

const catalog = useCatalog();
const runs = useRuns();
const ui = useUi();
const router = useRouter();
const now = useNow();

const stats = ref<DashboardStats | null>(null);
const error = ref<string | null>(null);
const loading = ref(true);
let debounce: ReturnType<typeof setTimeout> | null = null;
let poll: ReturnType<typeof setInterval> | null = null;

async function load(): Promise<void> {
  try {
    stats.value = await api.stats();
    error.value = null;
  } catch (err) {
    error.value = errorText(err);
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void load();
  poll = setInterval(load, 20_000);
});
onBeforeUnmount(() => {
  if (poll) clearInterval(poll);
  if (debounce) clearTimeout(debounce);
});
// Cada cambio en una ejecución (canal SSE global) refresca las cifras.
watch(
  () => runs.version,
  () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(load, 400);
  },
);

const activeRuns = computed<RunSummary[]>(() => [...runs.active].sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
const chartMax = computed(() => Math.max(1, ...(stats.value?.daily.map((d) => d.completed + d.failed + d.cancelled) ?? [0])));
const hasHistory = computed(() => (stats.value?.daily.some((d) => d.completed + d.failed + d.cancelled > 0) ?? false));
const totalTokens = computed(() => (stats.value ? stats.value.tokens.prompt + stats.value.tokens.completion : 0));
const exampleWorkflow = computed(() => catalog.workflows[0] ?? null);
const maxAgentSteps = computed(() => Math.max(1, ...(stats.value?.topAgents.map((a) => a.steps) ?? [1])));
const maxToolCalls = computed(() => Math.max(1, ...(stats.value?.topTools.map((t) => t.calls) ?? [1])));

const dayLabel = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
const pct = (value: number, max: number) => `${(value / max) * 100}%`;
const agentColor = (id: string) => catalog.agentById.get(id)?.color;

async function cancel(run: RunSummary): Promise<void> {
  try {
    await api.runs.cancel(run.id);
    ui.info(`Cancelando «${run.name}»…`);
  } catch (err) {
    ui.error(errorText(err));
  }
}
</script>

<template>
  <div class="page">
    <header class="page-header">
      <div>
        <h1>Panel</h1>
        <p class="subtitle">Estado en vivo de tus agentes, workflows y ejecuciones.</p>
      </div>
      <div class="row wrap">
        <RouterLink class="btn" to="/agents/new"><Plus /> Nuevo agente</RouterLink>
        <RouterLink class="btn btn-primary" to="/workflows/new"><Plus /> Nuevo workflow</RouterLink>
      </div>
    </header>

    <div v-if="error" class="callout danger" style="margin-bottom: 16px" role="alert">
      <CircleAlert />
      <div class="grow">{{ error }}</div>
      <button class="btn btn-sm" type="button" @click="load"><RefreshCw /> Reintentar</button>
    </div>

    <div v-if="catalog.loaded && !catalog.providers.length" class="callout warning" style="margin-bottom: 16px">
      <CircleAlert />
      <div>
        No hay ningún <Term id="proveedor">proveedor</Term> de modelos configurado.
        <RouterLink to="/settings">Añade uno en Ajustes</RouterLink> para poder ejecutar agentes.
      </div>
    </div>

    <template v-if="stats">
      <section class="kpis" aria-label="Indicadores">
        <article class="card kpi">
          <div class="kpi-head"><Activity /> <Term id="ejecucion">Ejecuciones</Term></div>
          <div class="kpi-value num">{{ formatNumber(stats.counts.runs) }}</div>
          <div class="kpi-foot">
            <span v-if="stats.activeRuns || stats.queuedRuns" class="row" style="gap: 6px">
              <span class="dot info pulse" /> {{ stats.activeRuns }} en curso<template v-if="stats.queuedRuns"> · {{ stats.queuedRuns }} en cola</template>
            </span>
            <span v-else>Ninguna en curso</span>
          </div>
        </article>
        <article class="card kpi">
          <div class="kpi-head"><Gauge /> Tasa de éxito</div>
          <div class="kpi-value num">{{ stats.successRate === null ? '—' : `${Math.round(stats.successRate * 100)} %` }}</div>
          <div class="kpi-foot">{{ stats.runsByStatus.completed }} completadas · {{ stats.runsByStatus.failed }} fallidas</div>
        </article>
        <article class="card kpi">
          <div class="kpi-head"><Clock /> Duración media</div>
          <div class="kpi-value num">{{ formatDuration(stats.avgDurationMs) }}</div>
          <div class="kpi-foot">De las ejecuciones completadas</div>
        </article>
        <article class="card kpi">
          <div class="kpi-head"><Coins /> <Term id="tokens">Tokens</Term></div>
          <div class="kpi-value num">{{ formatCompact(totalTokens) }}</div>
          <div class="kpi-foot">{{ plural(stats.llmCalls, 'llamada al modelo', 'llamadas al modelo') }} · {{ plural(stats.toolCalls, 'herramienta', 'herramientas') }}</div>
        </article>
      </section>

      <div class="grid-main">
        <section class="card">
          <div class="card-head">
            <h2>Actividad de los últimos 14 días</h2>
            <div class="legend tiny">
              <span><i style="background: var(--success)" /> Completadas</span>
              <span><i style="background: var(--danger)" /> Fallidas</span>
              <span><i style="background: var(--text-3)" /> Canceladas</span>
            </div>
          </div>
          <div class="card-pad">
            <div v-if="hasHistory" class="chart" role="img" :aria-label="`Ejecuciones por día. Máximo diario: ${chartMax}.`">
              <div class="y-axis tiny faint num"><span>{{ chartMax }}</span><span>0</span></div>
              <div class="bars">
                <div
                  v-for="(d, i) in stats.daily"
                  :key="d.date"
                  class="day"
                  :title="`${dayLabel(d.date)}: ${d.completed} completadas, ${d.failed} fallidas, ${d.cancelled} canceladas`"
                >
                  <div class="stack">
                    <span class="seg cancelled" :style="{ height: pct(d.cancelled, chartMax) }" />
                    <span class="seg failed" :style="{ height: pct(d.failed, chartMax) }" />
                    <span class="seg completed" :style="{ height: pct(d.completed, chartMax) }" />
                  </div>
                  <span class="tiny faint x" :class="{ hide: i % 2 === 1 }">{{ dayLabel(d.date) }}</span>
                </div>
              </div>
            </div>
            <div v-else class="empty" style="padding: 28px 12px">
              <Activity />
              <h3>Aún no hay ejecuciones</h3>
              <p>Lanza un agente o un workflow y aquí verás su evolución día a día.</p>
              <RouterLink v-if="exampleWorkflow" class="btn btn-primary" :to="`/workflows/${exampleWorkflow.id}`"><Play /> Abrir «{{ exampleWorkflow.name }}»</RouterLink>
            </div>
          </div>
        </section>

        <section class="card">
          <div class="card-head">
            <h2>En curso</h2>
            <span class="badge" :class="{ info: activeRuns.length }">{{ activeRuns.length }}</span>
          </div>
          <ul v-if="activeRuns.length" class="live-list">
            <li v-for="run in activeRuns" :key="run.id">
              <RouterLink :to="`/runs/${run.id}`" class="grow live-link">
                <span class="row" style="gap: 6px">
                  <StatusBadge :status="run.status" icon-only />
                  <strong class="truncate">{{ run.name }}</strong>
                </span>
                <span class="tiny muted truncate">{{ run.input || 'Sin entrada' }}</span>
              </RouterLink>
              <span class="tiny num muted">{{ formatDuration(elapsedMs(run.startedAt, null, now)) }}</span>
              <button class="btn btn-ghost btn-icon btn-sm" type="button" :aria-label="`Cancelar ${run.name}`" title="Cancelar" @click="cancel(run)"><Square /></button>
            </li>
          </ul>
          <div v-else class="empty" style="padding: 26px 16px">
            <p>No hay nada ejecutándose ahora mismo.</p>
          </div>
          <div class="providers">
            <div class="eyebrow">Proveedores</div>
            <p v-if="!catalog.health.length" class="small faint">{{ catalog.providers.length ? 'Comprobando…' : 'Ninguno configurado' }}</p>
            <div v-for="h in catalog.health" :key="h.providerId" class="row small" :title="h.error">
              <span class="dot" :class="h.ok ? 'success' : 'danger'" />
              <span class="grow truncate">{{ h.name }}</span>
              <span class="faint num">{{ h.ok ? `${plural(h.modelCount, 'modelo', 'modelos')} · ${h.latencyMs} ms` : 'Sin conexión' }}</span>
            </div>
          </div>
        </section>
      </div>

      <section class="card" style="margin-top: 16px">
        <div class="card-head">
          <h2>Ejecuciones recientes</h2>
          <RouterLink class="btn btn-ghost btn-sm" to="/runs">Ver todas</RouterLink>
        </div>
        <div v-if="stats.recentRuns.length" class="table-wrap">
          <table class="table">
            <thead>
              <tr><th>Nombre</th><th>Estado</th><th>Entrada</th><th class="right">Duración</th><th class="right">Tokens</th><th class="right">Inicio</th></tr>
            </thead>
            <tbody>
              <tr v-for="run in stats.recentRuns" :key="run.id" class="clickable" @click="router.push(`/runs/${run.id}`)">
                <td>
                  <RouterLink :to="`/runs/${run.id}`" class="row name" @click.stop>
                    <component :is="run.kind === 'workflow' ? Workflow : Bot" class="kind" :aria-label="run.kind === 'workflow' ? 'Workflow' : 'Agente'" />
                    <strong>{{ run.name }}</strong>
                  </RouterLink>
                </td>
                <td><StatusBadge :status="run.status" /></td>
                <td class="muted"><div class="truncate" style="max-width: 320px">{{ run.input || '—' }}</div></td>
                <td class="right num">{{ formatDuration(elapsedMs(run.startedAt, run.finishedAt, now)) }}</td>
                <td class="right num">{{ formatCompact(run.usage.promptTokens + run.usage.completionTokens) }}</td>
                <td class="right muted" style="white-space: nowrap">{{ relativeTime(run.createdAt, now) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-else class="empty" style="padding: 26px"><p>Cuando ejecutes algo aparecerá aquí.</p></div>
      </section>

      <div class="grid-three">
        <section class="card card-pad">
          <h2 style="margin-bottom: 12px">Agentes más activos</h2>
          <div v-if="stats.topAgents.length" class="col" style="gap: 10px">
            <div v-for="a in stats.topAgents" :key="a.agentId" class="rank">
              <AgentAvatar :name="a.name" :color="agentColor(a.agentId)" :size="26" />
              <div class="grow">
                <div class="row between small"><span class="truncate">{{ a.name }}</span><span class="num muted">{{ plural(a.steps, 'paso', 'pasos') }}</span></div>
                <div class="meter"><span :style="{ width: pct(a.steps, maxAgentSteps), background: agentColor(a.agentId) ?? 'var(--accent)' }" /></div>
              </div>
            </div>
          </div>
          <p v-else class="small faint">Sin datos todavía.</p>
        </section>

        <section class="card card-pad">
          <h2 style="margin-bottom: 12px">Herramientas más usadas</h2>
          <div v-if="stats.topTools.length" class="col" style="gap: 10px">
            <div v-for="t in stats.topTools" :key="t.name">
              <div class="row between small"><code>{{ t.name }}</code><span class="num muted">{{ plural(t.calls, 'llamada', 'llamadas') }}</span></div>
              <div class="meter"><span :style="{ width: pct(t.calls, maxToolCalls) }" /></div>
            </div>
          </div>
          <p v-else class="small faint">Ningún agente ha usado herramientas todavía.</p>
        </section>

        <section class="card card-pad">
          <h2 style="margin-bottom: 12px">Sistema</h2>
          <div class="inventory">
            <RouterLink to="/agents"><Bot /> <strong class="num">{{ stats.counts.agents }}</strong> agentes</RouterLink>
            <RouterLink to="/workflows"><Workflow /> <strong class="num">{{ stats.counts.workflows }}</strong> workflows</RouterLink>
            <RouterLink to="/tools"><Wrench /> <strong class="num">{{ stats.counts.tools }}</strong> herramientas</RouterLink>
          </div>
          <dl class="sys small">
            <dt>Versión</dt><dd>{{ stats.system.version }} · Node {{ stats.system.nodeVersion }}</dd>
            <dt>En marcha</dt><dd>{{ formatUptime(stats.system.uptimeSec) }}</dd>
            <dt>Memoria</dt><dd>{{ stats.system.memoryMb }} MB</dd>
            <dt>Base de datos</dt><dd>{{ formatBytes(stats.system.dbSizeBytes) }}</dd>
          </dl>
        </section>
      </div>
    </template>

    <div v-else-if="loading" class="kpis" aria-busy="true">
      <div v-for="i in 4" :key="i" class="card skeleton" style="height: 112px" />
    </div>
  </div>
</template>

<style scoped>
.kpis {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 16px;
  margin-bottom: 16px;
}
.kpi {
  padding: 16px 18px;
}
.kpi-head {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--text-2);
  font-size: 12.5px;
  font-weight: 600;
}
.kpi-head svg {
  width: 15px;
  height: 15px;
  color: var(--text-3);
}
.kpi-value {
  font-family: var(--font-display);
  font-size: 30px;
  font-weight: 650;
  letter-spacing: -0.02em;
  line-height: 1.25;
  margin-top: 6px;
}
.kpi-foot {
  font-size: 12.5px;
  color: var(--text-2);
  margin-top: 2px;
}
.grid-main {
  display: grid;
  grid-template-columns: minmax(0, 1.7fr) minmax(0, 1fr);
  gap: 16px;
}
.grid-three {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
  margin-top: 16px;
}
.legend {
  display: flex;
  gap: 12px;
  color: var(--text-2);
  flex-wrap: wrap;
}
.legend span {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.legend i {
  width: 9px;
  height: 9px;
  border-radius: 2px;
}
.chart {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 8px;
}
.y-axis {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  height: 160px;
  text-align: right;
}
.bars {
  display: grid;
  grid-template-columns: repeat(14, minmax(0, 1fr));
  gap: 6px;
}
.day {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.stack {
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  width: 100%;
  max-width: 34px;
  height: 160px;
  border-radius: 5px;
  background: var(--surface-2);
  overflow: hidden;
  gap: 1px;
}
.seg.completed {
  background: var(--success);
}
.seg.failed {
  background: var(--danger);
}
.seg.cancelled {
  background: var(--text-3);
}
.day:hover .stack {
  outline: 2px solid var(--border-strong);
}
.x {
  white-space: nowrap;
}
.x.hide {
  visibility: hidden;
}
.live-list {
  list-style: none;
  margin: 0;
  padding: 6px 8px;
}
.live-list li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-radius: 8px;
}
.live-list li:hover {
  background: var(--surface-2);
}
.live-link {
  display: flex;
  flex-direction: column;
  color: inherit;
  min-width: 0;
}
.live-link:hover {
  text-decoration: none;
}
.providers {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 14px 20px 16px;
  border-top: 1px solid var(--border);
}
.name {
  color: inherit;
}
.kind {
  width: 15px;
  height: 15px;
  color: var(--text-3);
  flex: none;
}
.rank {
  display: flex;
  align-items: center;
  gap: 10px;
}
.meter {
  height: 5px;
  border-radius: 3px;
  background: var(--surface-2);
  margin-top: 4px;
  overflow: hidden;
}
.meter span {
  display: block;
  height: 100%;
  border-radius: 3px;
  background: var(--accent);
}
.inventory {
  display: grid;
  gap: 4px;
  margin-bottom: 12px;
}
.inventory a {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  margin: 0 -8px;
  border-radius: 6px;
  color: var(--text-2);
}
.inventory a:hover {
  background: var(--surface-2);
  text-decoration: none;
}
.inventory strong {
  color: var(--text);
}
.inventory svg {
  width: 15px;
  height: 15px;
  color: var(--text-3);
}
.sys {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 4px 14px;
  margin: 0;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}
.sys dt {
  color: var(--text-3);
}
.sys dd {
  margin: 0;
  text-align: right;
  color: var(--text-2);
}
@media (max-width: 1080px) {
  .kpis {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .grid-main,
  .grid-three {
    grid-template-columns: 1fr;
  }
}
@media (max-width: 520px) {
  .kpis {
    grid-template-columns: 1fr;
  }
  .x {
    display: none;
  }
}
</style>
