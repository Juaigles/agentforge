<script setup lang="ts">
import { nodeUsesAgent } from '@shared/graph';
import { validateWorkflow } from '@shared/graph';
import type { Trigger, Workflow } from '@shared/types';
import { Bot, CalendarClock, CircleAlert, Copy, Download, Pencil, Play, Plus, Trash2, Upload, Workflow as WorkflowIcon } from 'lucide-vue-next';
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import AgentAvatar from '@/components/AgentAvatar.vue';
import AppModal from '@/components/AppModal.vue';
import TriggersModal from '@/components/TriggersModal.vue';
import Term from '@/components/Term.vue';
import { api, errorText } from '@/lib/api';
import { plural, relativeTime } from '@/lib/format';
import { downloadJson, exportFileName, readJsonFile, summarizeTriggers } from '@/lib/transfer';
import { useCatalog } from '@/stores/catalog';
import { useUi } from '@/stores/ui';

const catalog = useCatalog();
const ui = useUi();
const router = useRouter();
const error = ref<string | null>(null);

const triggers = ref(new Map<string, Trigger[]>());
async function loadTriggers(): Promise<void> {
  try {
    const byWorkflow = new Map<string, Trigger[]>();
    for (const t of await api.triggers.list()) byWorkflow.set(t.workflowId, [...(byWorkflow.get(t.workflowId) ?? []), t]);
    triggers.value = byWorkflow;
  } catch {
    /* los disparadores son un dato secundario de la lista */
  }
}
const triggerSummary = (wf: Workflow) => summarizeTriggers(triggers.value.get(wf.id) ?? []);

onMounted(async () => {
  try {
    await catalog.reload();
    await loadTriggers();
  } catch (err) {
    error.value = errorText(err);
  }
});

// ---------- Exportar, importar y programar ----------
const scheduling = ref<Workflow | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
const importing = ref(false);

async function exportWorkflow(wf: Workflow): Promise<void> {
  try {
    downloadJson(exportFileName(wf.name), await api.workflows.export(wf.id));
    ui.success(`«${wf.name}» exportado.`);
  } catch (err) {
    ui.error(errorText(err));
  }
}

async function onImportFile(ev: Event): Promise<void> {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = ''; // permite volver a elegir el mismo archivo
  if (!file) return;
  importing.value = true;
  try {
    const result = await api.workflows.import(await readJsonFile(file));
    await catalog.reload();
    const created = result.createdAgents.length;
    ui.success(`«${result.workflow.name}» importado${created ? ` con ${plural(created, 'agente nuevo', 'agentes nuevos')}` : ''}.`);
    for (const warning of result.warnings) ui.info(warning);
    await router.push(`/workflows/${result.workflow.id}`);
  } catch (err) {
    ui.error(errorText(err));
  } finally {
    importing.value = false;
  }
}

const cards = computed(() =>
  catalog.workflows.map((wf) => {
    const agentIds = [...new Set(wf.nodes.filter(nodeUsesAgent).map((n) => String(n.config?.agentId)))];
    const issues = validateWorkflow(wf, { agentIds: catalog.agents.map((a) => a.id), toolNames: catalog.enabledToolNames });
    return {
      wf,
      agents: agentIds.map((id) => catalog.agentById.get(id)).filter((a) => !!a),
      errors: issues.filter((i) => i.level === 'error').length,
    };
  }),
);

// Ejecución rápida desde la lista
const target = ref<Workflow | null>(null);
const runInput = ref('');
const launching = ref(false);
const inputNode = computed(() => target.value?.nodes.find((n) => n.type === 'input'));

function openRun(wf: Workflow): void {
  target.value = wf;
  runInput.value = String(wf.nodes.find((n) => n.type === 'input')?.config?.defaultValue ?? '');
}
async function launch(): Promise<void> {
  if (!target.value) return;
  launching.value = true;
  try {
    const run = await api.workflows.run(target.value.id, runInput.value);
    target.value = null;
    await router.push(`/runs/${run.id}`);
  } catch (err) {
    ui.error(errorText(err));
  } finally {
    launching.value = false;
  }
}

async function duplicate(wf: Workflow): Promise<void> {
  try {
    const copy = await api.workflows.duplicate(wf.id);
    catalog.setWorkflow(copy);
    ui.success(`Se ha creado «${copy.name}».`);
  } catch (err) {
    ui.error(errorText(err));
  }
}

async function remove(wf: Workflow): Promise<void> {
  const ok = await ui.confirm({
    title: 'Eliminar workflow',
    message: `Se eliminará «${wf.name}». Sus ejecuciones anteriores se conservan en el historial.`,
    confirmLabel: 'Eliminar',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.workflows.remove(wf.id);
    catalog.dropWorkflow(wf.id);
    ui.success('Workflow eliminado.');
  } catch (err) {
    ui.error(errorText(err));
  }
}
</script>

<template>
  <div class="page">
    <header class="page-header">
      <div>
        <h1>Workflows</h1>
        <p class="subtitle">
          Un <Term id="workflow">workflow</Term> conecta <Term id="nodo">nodos</Term> en un <Term id="dag">DAG</Term>: los pasos independientes se ejecutan
          <Term id="paralelo">en paralelo</Term> y cada <Term id="agente">agente</Term> recibe los resultados de los anteriores.
        </p>
      </div>
      <div class="row wrap">
        <input ref="fileInput" class="sr-only" type="file" accept=".json,application/json" aria-label="Archivo de workflow a importar" tabindex="-1" @change="onImportFile" />
        <button class="btn" type="button" :disabled="importing" title="Importar un workflow exportado (archivo .json)" @click="fileInput?.click()"><Upload /> {{ importing ? 'Importando…' : 'Importar' }}</button>
        <RouterLink class="btn btn-primary" to="/workflows/new"><Plus /> Nuevo workflow</RouterLink>
      </div>
    </header>

    <div v-if="error" class="callout danger" role="alert"><CircleAlert /> {{ error }}</div>

    <template v-else-if="catalog.loaded">
      <div v-if="cards.length" class="grid">
        <article v-for="{ wf, agents, errors } in cards" :key="wf.id" class="card wf" @click="router.push(`/workflows/${wf.id}`)">
          <div class="row" style="gap: 10px; align-items: flex-start">
            <span class="wf-ico"><WorkflowIcon /></span>
            <div class="grow">
              <RouterLink :to="`/workflows/${wf.id}`" class="title" @click.stop>{{ wf.name }}</RouterLink>
              <div class="tiny faint">Editado {{ relativeTime(wf.updatedAt) }}</div>
            </div>
            <span v-if="errors" class="badge danger" :title="`${errors} error(es) de configuración`"><CircleAlert /> {{ errors }}</span>
          </div>
          <p class="small muted desc">{{ wf.description || 'Sin descripción.' }}</p>
          <div class="row wrap" style="gap: 6px">
            <span class="badge">{{ plural(wf.nodes.length, 'nodo', 'nodos') }}</span>
            <span class="badge"><Bot /> {{ plural(wf.nodes.filter(nodeUsesAgent).length, 'paso de agente', 'pasos de agente') }}</span>
            <span v-if="triggerSummary(wf)" class="badge" :class="triggerSummary(wf)!.active ? 'info' : ''" :title="triggerSummary(wf)!.active ? 'Se ejecuta solo' : 'Sus disparadores están desactivados'">
              <CalendarClock /> {{ triggerSummary(wf)!.text }}
            </span>
            <span class="avatars">
              <AgentAvatar v-for="a in agents.slice(0, 5)" :key="a.id" :name="a.name" :color="a.color" :size="22" :title="a.name" />
            </span>
          </div>
          <footer class="row" @click.stop>
            <button class="btn btn-primary btn-sm" type="button" :disabled="errors > 0" :title="errors ? 'Corrige los errores para poder ejecutarlo' : undefined" @click="openRun(wf)">
              <Play /> Ejecutar
            </button>
            <RouterLink class="btn btn-sm" :to="`/workflows/${wf.id}`"><Pencil /> Editar</RouterLink>
            <span class="grow" />
            <button class="btn btn-ghost btn-icon btn-sm" type="button" :aria-label="`Disparadores de ${wf.name}`" title="Disparadores: programar o lanzar con un webhook" @click="scheduling = wf"><CalendarClock /></button>
            <button class="btn btn-ghost btn-icon btn-sm" type="button" :aria-label="`Exportar ${wf.name}`" title="Exportar a un archivo" @click="exportWorkflow(wf)"><Download /></button>
            <button class="btn btn-ghost btn-icon btn-sm" type="button" :aria-label="`Duplicar ${wf.name}`" title="Duplicar" @click="duplicate(wf)"><Copy /></button>
            <button class="btn btn-ghost btn-icon btn-sm" type="button" :aria-label="`Eliminar ${wf.name}`" title="Eliminar" @click="remove(wf)"><Trash2 /></button>
          </footer>
        </article>
      </div>
      <div v-else class="card empty">
        <WorkflowIcon />
        <h3>Todavía no tienes workflows</h3>
        <p>Crea uno para coordinar varios agentes: arrastra nodos al lienzo y conéctalos. También puedes importar uno exportado.</p>
        <RouterLink class="btn btn-primary" to="/workflows/new"><Plus /> Crear workflow</RouterLink>
      </div>
    </template>

    <div v-else class="grid" aria-busy="true"><div v-for="i in 2" :key="i" class="card skeleton" style="height: 200px" /></div>

    <TriggersModal
      v-if="scheduling"
      :workflow-id="scheduling.id"
      :workflow-name="scheduling.name"
      :default-input="String(scheduling.nodes.find((n) => n.type === 'input')?.config?.defaultValue ?? '')"
      @close="scheduling = null"
      @changed="loadTriggers"
    />

    <AppModal v-if="target" :title="`Ejecutar «${target.name}»`" @close="target = null">
      <div class="field">
        <label for="wf-run-input">{{ inputNode?.config?.description || 'Entrada del workflow' }}</label>
        <textarea id="wf-run-input" v-model="runInput" class="textarea" rows="5" placeholder="Texto con el que arranca el workflow" @keydown.ctrl.enter="launch" />
      </div>
      <template #footer>
        <button class="btn" type="button" @click="target = null">Cancelar</button>
        <button class="btn btn-primary" type="button" :disabled="launching" @click="launch"><Play /> {{ launching ? 'Lanzando…' : 'Ejecutar' }}</button>
      </template>
    </AppModal>
  </div>
</template>

<style scoped>
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  gap: 16px;
}
.wf {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  cursor: pointer;
  transition:
    border-color 0.12s,
    box-shadow 0.12s;
}
.wf:hover {
  border-color: var(--border-strong);
  box-shadow: var(--shadow-md);
}
.wf-ico {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 9px;
  background: var(--accent-soft);
  color: var(--accent);
  flex: none;
}
.wf-ico svg {
  width: 18px;
  height: 18px;
}
.title {
  color: var(--text);
  font-family: var(--font-display);
  font-size: 15px;
  font-weight: 650;
}
.desc {
  display: -webkit-box;
  -webkit-line-clamp: 3;
  line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  min-height: 2.9em;
}
.avatars {
  display: inline-flex;
  gap: 3px;
  margin-left: auto;
}
footer {
  margin-top: auto;
  padding-top: 12px;
  border-top: 1px solid var(--border);
  gap: 6px;
}
@media (max-width: 420px) {
  .grid {
    grid-template-columns: 1fr;
  }
}
</style>
