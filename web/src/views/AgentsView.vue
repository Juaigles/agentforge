<script setup lang="ts">
import type { Agent, ImportResult } from '@shared/types';
import { Bot, CircleAlert, Copy, Download, Pencil, Plus, Search, Trash2, Upload, Wrench } from 'lucide-vue-next';
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import AgentAvatar from '@/components/AgentAvatar.vue';
import ImportModal from '@/components/ImportModal.vue';
import Term from '@/components/Term.vue';
import { api, errorText } from '@/lib/api';
import { serverText } from '@/lib/server-messages-en';
import { t, tn } from '@/i18n';
import { downloadJson, exportFileName, importSummary, readJsonFile } from '@/lib/transfer';
import { agentDeleteMessage, workflowsUsingAgent } from '@/lib/usage';
import { useCatalog } from '@/stores/catalog';
import { useUi } from '@/stores/ui';

const catalog = useCatalog();
const ui = useUi();
const router = useRouter();
const query = ref('');
const error = ref<string | null>(null);

onMounted(async () => {
  try {
    await catalog.reload();
  } catch (err) {
    error.value = errorText(err);
  }
});

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return catalog.agents;
  return catalog.agents.filter((a) => [a.name, a.role, a.description, a.model].some((v) => v.toLowerCase().includes(q)));
});

const usedIn = (agent: Agent) => workflowsUsingAgent(catalog.workflows, agent.id).length;
const providerName = (agent: Agent) => catalog.providerById.get(agent.providerId)?.name ?? t('agents.card.providerRemoved');
const providerMissing = (agent: Agent) => !catalog.providerById.has(agent.providerId);

// ---------- Exportar e importar ----------
const fileInput = ref<HTMLInputElement | null>(null);
const importing = ref<{ bundle: unknown; fileName: string } | null>(null);

async function exportAgent(agent: Agent): Promise<void> {
  try {
    downloadJson(exportFileName(agent.name, 'agente'), await api.transfer.exportAgent(agent.id));
    ui.success(t('agents.toast.exported', { name: agent.name }));
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
    await catalog.reload();
  } catch (err) {
    ui.error(errorText(err));
  }
  const summary = importSummary(result);
  if (result.workflow)
    ui.success(summary ? t('agents.toast.importedWith', { name: result.workflow.name, summary }) : t('agents.toast.imported', { name: result.workflow.name }));
  else ui.success(summary ? t('agents.toast.importDone', { summary }) : t('agents.toast.importNothing'));
  result.warnings.forEach((warning, i) => ui.info(serverText(warning, result.warningsI18n?.[i])));
  if (result.workflow) await router.push(`/workflows/${result.workflow.id}`);
}

async function duplicate(agent: Agent): Promise<void> {
  try {
    const copy = await api.agents.duplicate(agent.id);
    catalog.setAgent(copy);
    ui.success(t('agents.toast.created', { name: copy.name }));
    void router.push(`/agents/${copy.id}`);
  } catch (err) {
    ui.error(errorText(err));
  }
}

async function remove(agent: Agent): Promise<void> {
  const ok = await ui.confirm({
    title: t('agents.confirm.deleteTitle'),
    message: agentDeleteMessage(agent.name, workflowsUsingAgent(catalog.workflows, agent.id)),
    confirmLabel: t('agents.confirm.deleteLabel'),
    danger: true,
  });
  if (!ok) return;
  try {
    await api.agents.remove(agent.id);
    catalog.dropAgent(agent.id);
    ui.success(t('agents.toast.deleted', { name: agent.name }));
  } catch (err) {
    ui.error(errorText(err));
  }
}
</script>

<template>
  <div class="page">
    <header class="page-header">
      <div>
        <h1>{{ t('agents.title') }}</h1>
        <i18n-t keypath="agents.subtitle" tag="p" class="subtitle" scope="global">
          <template #agent
            ><Term id="agente">{{ t('agents.subtitleAgent') }}</Term></template
          >
          <template #model
            ><Term id="modelo">{{ t('agents.subtitleModel') }}</Term></template
          >
          <template #tools
            ><Term id="herramienta">{{ t('agents.subtitleTools') }}</Term></template
          >
          <template #workflow
            ><Term id="workflow">{{ t('agents.subtitleWorkflow') }}</Term></template
          >
        </i18n-t>
      </div>
      <div class="row wrap" style="gap: 8px">
        <input
          ref="fileInput"
          class="sr-only"
          type="file"
          accept=".json,application/json"
          :aria-label="t('agents.importFileLabel')"
          tabindex="-1"
          @change="onImportFile"
        />
        <button class="btn" type="button" :title="t('agents.importTitle')" @click="fileInput?.click()"><Upload /> {{ t('common.actions.import') }}</button>
        <RouterLink class="btn btn-primary" to="/agents/new"><Plus /> {{ t('agents.newAgent') }}</RouterLink>
      </div>
    </header>

    <div v-if="error" class="callout danger" role="alert"><CircleAlert /> {{ error }}</div>

    <template v-else-if="catalog.loaded">
      <div v-if="catalog.agents.length > 3" class="search">
        <Search aria-hidden="true" />
        <input v-model="query" class="input" type="search" :placeholder="t('agents.searchPlaceholder')" :aria-label="t('agents.searchLabel')" />
      </div>

      <div v-if="filtered.length" class="grid">
        <article v-for="agent in filtered" :key="agent.id" class="card agent" @click="router.push(`/agents/${agent.id}`)">
          <div class="row" style="align-items: flex-start; gap: 12px">
            <AgentAvatar :name="agent.name" :color="agent.color" :size="40" />
            <div class="grow">
              <RouterLink :to="`/agents/${agent.id}`" class="title truncate" @click.stop>{{ agent.name }}</RouterLink>
              <div class="small muted truncate">{{ agent.role || t('agents.card.noRole') }}</div>
            </div>
          </div>
          <p class="small muted desc">{{ agent.description || t('agents.card.noDescription') }}</p>
          <div class="row wrap meta">
            <span class="badge" :class="{ danger: providerMissing(agent) }" :title="providerName(agent)">{{ agent.model || t('agents.card.noModel') }}</span>
            <span class="badge"><Wrench /> {{ agent.tools.length }}</span>
            <span v-if="usedIn(agent)" class="badge accent">{{ tn('agents.card.workflows', usedIn(agent)) }}</span>
          </div>
          <footer class="row" @click.stop>
            <RouterLink class="btn btn-sm" :to="`/agents/${agent.id}`"><Pencil /> {{ t('agents.card.editAndTry') }}</RouterLink>
            <span class="grow" />
            <button
              class="btn btn-ghost btn-icon btn-sm"
              type="button"
              :aria-label="t('agents.card.exportLabel', { name: agent.name })"
              :title="t('agents.card.exportTitle')"
              @click="exportAgent(agent)"
            >
              <Download />
            </button>
            <button
              class="btn btn-ghost btn-icon btn-sm"
              type="button"
              :aria-label="t('agents.card.duplicateLabel', { name: agent.name })"
              :title="t('common.actions.duplicate')"
              @click="duplicate(agent)"
            >
              <Copy />
            </button>
            <button
              class="btn btn-ghost btn-icon btn-sm"
              type="button"
              :aria-label="t('agents.card.deleteLabel', { name: agent.name })"
              :title="t('common.actions.delete')"
              @click="remove(agent)"
            >
              <Trash2 />
            </button>
          </footer>
        </article>
      </div>

      <div v-else class="card empty">
        <Bot />
        <template v-if="catalog.agents.length">
          <h3>{{ t('agents.empty.noMatch', { query }) }}</h3>
          <button class="btn" type="button" @click="query = ''">{{ t('agents.empty.clearFilter') }}</button>
        </template>
        <template v-else>
          <h3>{{ t('agents.empty.title') }}</h3>
          <i18n-t keypath="agents.empty.text" tag="p" scope="global">
            <template #model
              ><Term id="modelo">{{ t('agents.empty.textModel') }}</Term></template
            >
            <template #tools
              ><Term id="herramienta">{{ t('agents.empty.textTools') }}</Term></template
            >
          </i18n-t>
          <RouterLink class="btn btn-primary" to="/agents/new"><Plus /> {{ t('agents.empty.create') }}</RouterLink>
        </template>
      </div>
    </template>

    <div v-else class="grid" aria-busy="true"><div v-for="i in 3" :key="i" class="card skeleton" style="height: 190px" /></div>

    <ImportModal v-if="importing" :bundle="importing.bundle" :file-name="importing.fileName" @close="importing = null" @done="onImported" />
  </div>
</template>

<style scoped>
.search {
  position: relative;
  max-width: 360px;
  margin-bottom: 16px;
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
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(290px, 1fr));
  gap: 16px;
}
.agent {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  cursor: pointer;
  transition:
    border-color 0.12s,
    box-shadow 0.12s;
}
.agent:hover {
  border-color: var(--border-strong);
  box-shadow: var(--shadow-md);
}
.title {
  display: block;
  color: var(--text);
  font-family: var(--font-display);
  font-size: 15px;
  font-weight: 650;
}
.desc {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  min-height: 2.9em;
}
.meta .badge {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
}
footer {
  margin-top: auto;
  padding-top: 12px;
  border-top: 1px solid var(--border);
  gap: 4px;
}
</style>
