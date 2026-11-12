<script setup lang="ts">
import { nodeUsesAgent } from '@shared/graph';
import { validateWorkflow } from '@shared/graph';
import type { ImportResult, Trigger, Workflow } from '@shared/types';
import { Bot, CalendarClock, CircleAlert, Copy, Download, Pencil, Play, Plus, Trash2, Upload, Workflow as WorkflowIcon } from 'lucide-vue-next';
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import AgentAvatar from '@/components/AgentAvatar.vue';
import AppModal from '@/components/AppModal.vue';
import ImportModal from '@/components/ImportModal.vue';
import TriggersModal from '@/components/TriggersModal.vue';
import Term from '@/components/Term.vue';
import { api, errorText } from '@/lib/api';
import { serverText } from '@/lib/server-messages-en';
import { relativeTime } from '@/lib/format';
import { t, tn } from '@/i18n';
import { downloadJson, exportFileName, importSummary, readJsonFile, summarizeTriggers } from '@/lib/transfer';
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
    for (const trigger of await api.triggers.list()) byWorkflow.set(trigger.workflowId, [...(byWorkflow.get(trigger.workflowId) ?? []), trigger]);
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
/** Archivo elegido, ya leído, a la espera de revisar la importación. */
const importing = ref<{ bundle: unknown; fileName: string } | null>(null);

async function exportWorkflow(wf: Workflow): Promise<void> {
  try {
    downloadJson(exportFileName(wf.name), await api.workflows.export(wf.id));
    ui.success(t('workflows.toast.exported', { name: wf.name }));
  } catch (err) {
    ui.error(errorText(err));
  }
}

async function onImportFile(ev: Event): Promise<void> {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = ''; // permite volver a elegir el mismo archivo
  if (!file) return;
  try {
    importing.value = { bundle: await readJsonFile(file), fileName: file.name };
  } catch (err) {
    ui.error(errorText(err));
  }
}

async function onImported(result: ImportResult): Promise<void> {
  importing.value = null;
  try {
    await Promise.all([catalog.reload(), loadTriggers()]);
  } catch (err) {
    ui.error(errorText(err));
  }
  const summary = importSummary(result);
  if (result.workflow)
    ui.success(
      summary ? t('workflows.toast.importedWith', { name: result.workflow.name, summary }) : t('workflows.toast.imported', { name: result.workflow.name }),
    );
  else ui.success(summary ? t('workflows.toast.importDone', { summary }) : t('workflows.toast.importNothingNew'));
  result.warnings.forEach((warning, i) => ui.info(serverText(warning, result.warningsI18n?.[i])));
  await router.push(result.workflow ? `/workflows/${result.workflow.id}` : '/agents');
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
    ui.success(t('workflows.toast.created', { name: copy.name }));
  } catch (err) {
    ui.error(errorText(err));
  }
}

async function remove(wf: Workflow): Promise<void> {
  const ok = await ui.confirm({
    title: t('workflows.confirm.deleteTitle'),
    message: t('workflows.confirm.deleteMessage', { name: wf.name }),
    confirmLabel: t('common.actions.delete'),
    danger: true,
  });
  if (!ok) return;
  try {
    await api.workflows.remove(wf.id);
    catalog.dropWorkflow(wf.id);
    ui.success(t('workflows.toast.deleted'));
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
        <i18n-t keypath="workflows.subtitle" tag="p" class="subtitle" scope="global">
          <template #workflow
            ><Term id="workflow">{{ t('workflows.subtitleWorkflow') }}</Term></template
          >
          <template #nodes
            ><Term id="nodo">{{ t('workflows.subtitleNodes') }}</Term></template
          >
          <template #dag
            ><Term id="dag">{{ t('workflows.subtitleDag') }}</Term></template
          >
          <template #parallel
            ><Term id="paralelo">{{ t('workflows.subtitleParallel') }}</Term></template
          >
          <template #agent
            ><Term id="agente">{{ t('workflows.subtitleAgent') }}</Term></template
          >
        </i18n-t>
      </div>
      <div class="row wrap">
        <input
          ref="fileInput"
          class="sr-only"
          type="file"
          accept=".json,application/json"
          :aria-label="t('workflows.importFileLabel')"
          tabindex="-1"
          @change="onImportFile"
        />
        <button class="btn" type="button" :title="t('workflows.importTitle')" @click="fileInput?.click()"><Upload /> {{ t('common.actions.import') }}</button>
        <RouterLink class="btn btn-primary" to="/workflows/new"><Plus /> {{ t('workflows.newWorkflow') }}</RouterLink>
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
              <div class="tiny faint">{{ t('workflows.edited', { time: relativeTime(wf.updatedAt) }) }}</div>
            </div>
            <span v-if="errors" class="badge danger" :title="t('workflows.configErrors', { n: errors })"><CircleAlert /> {{ errors }}</span>
          </div>
          <p class="small muted desc">{{ wf.description || t('workflows.noDescription') }}</p>
          <div class="row wrap" style="gap: 6px">
            <span class="badge">{{ tn('workflows.nodeCount', wf.nodes.length) }}</span>
            <span class="badge"><Bot /> {{ tn('workflows.agentStepCount', wf.nodes.filter(nodeUsesAgent).length) }}</span>
            <span
              v-if="triggerSummary(wf)"
              class="badge"
              :class="triggerSummary(wf)!.active ? 'info' : ''"
              :title="triggerSummary(wf)!.active ? t('workflows.triggersActive') : t('workflows.triggersOff')"
            >
              <CalendarClock /> {{ triggerSummary(wf)!.text }}
            </span>
            <span class="avatars">
              <AgentAvatar v-for="a in agents.slice(0, 5)" :key="a.id" :name="a.name" :color="a.color" :size="22" :title="a.name" />
            </span>
          </div>
          <footer class="row" @click.stop>
            <button
              class="btn btn-primary btn-sm"
              type="button"
              :disabled="errors > 0"
              :title="errors ? t('workflows.fixErrors') : undefined"
              @click="openRun(wf)"
            >
              <Play /> {{ t('common.actions.run') }}
            </button>
            <RouterLink class="btn btn-sm" :to="`/workflows/${wf.id}`"><Pencil /> {{ t('common.actions.edit') }}</RouterLink>
            <span class="grow" />
            <button
              class="btn btn-ghost btn-icon btn-sm"
              type="button"
              :aria-label="t('workflows.triggersAria', { name: wf.name })"
              :title="t('workflows.triggersTitle')"
              @click="scheduling = wf"
            >
              <CalendarClock />
            </button>
            <button
              class="btn btn-ghost btn-icon btn-sm"
              type="button"
              :aria-label="t('workflows.exportAria', { name: wf.name })"
              :title="t('workflows.exportTitle')"
              @click="exportWorkflow(wf)"
            >
              <Download />
            </button>
            <button
              class="btn btn-ghost btn-icon btn-sm"
              type="button"
              :aria-label="t('workflows.duplicateAria', { name: wf.name })"
              :title="t('common.actions.duplicate')"
              @click="duplicate(wf)"
            >
              <Copy />
            </button>
            <button
              class="btn btn-ghost btn-icon btn-sm"
              type="button"
              :aria-label="t('workflows.deleteAria', { name: wf.name })"
              :title="t('common.actions.delete')"
              @click="remove(wf)"
            >
              <Trash2 />
            </button>
          </footer>
        </article>
      </div>
      <div v-else class="card empty">
        <WorkflowIcon />
        <h3>{{ t('workflows.empty.title') }}</h3>
        <p>{{ t('workflows.empty.text') }}</p>
        <RouterLink class="btn btn-primary" to="/workflows/new"><Plus /> {{ t('workflows.empty.create') }}</RouterLink>
      </div>
    </template>

    <div v-else class="grid" aria-busy="true"><div v-for="i in 2" :key="i" class="card skeleton" style="height: 200px" /></div>

    <ImportModal v-if="importing" :bundle="importing.bundle" :file-name="importing.fileName" @close="importing = null" @done="onImported" />

    <TriggersModal
      v-if="scheduling"
      :workflow-id="scheduling.id"
      :workflow-name="scheduling.name"
      :default-input="String(scheduling.nodes.find((n) => n.type === 'input')?.config?.defaultValue ?? '')"
      @close="scheduling = null"
      @changed="loadTriggers"
    />

    <AppModal v-if="target" :title="t('workflows.run.title', { name: target.name })" @close="target = null">
      <div class="field">
        <label for="wf-run-input">{{ inputNode?.config?.description || t('workflows.run.inputDefault') }}</label>
        <textarea id="wf-run-input" v-model="runInput" class="textarea" rows="5" :placeholder="t('workflows.run.placeholder')" @keydown.ctrl.enter="launch" />
      </div>
      <template #footer>
        <button class="btn" type="button" @click="target = null">{{ t('common.actions.cancel') }}</button>
        <button class="btn btn-primary" type="button" :disabled="launching" @click="launch">
          <Play /> {{ launching ? t('workflows.run.launching') : t('common.actions.run') }}
        </button>
      </template>
    </AppModal>
  </div>
</template>

<style scoped>
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(340px, 100%), 1fr));
  gap: 16px;
}
.wf {
  min-width: 0;
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
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
