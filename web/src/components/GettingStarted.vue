<script setup lang="ts">
// Guía de primera sesión: tres pasos que se marcan solos (conectar un modelo, probar un agente, ejecutar un
// workflow). Se muestra en el Panel hasta completarla u ocultarla.
import { Check, CircleAlert, Copy, Play, RefreshCw, X } from 'lucide-vue-next';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Term from '@/components/Term.vue';
import { t } from '@/i18n';
import { api } from '@/lib/api';
import { serverText } from '@/lib/server-messages-en';
import { safeStorage } from '@/lib/storage';
import { useCatalog } from '@/stores/catalog';
import { useRuns } from '@/stores/runs';
import { useUi } from '@/stores/ui';

const HIDDEN_KEY = 'agentforge.guide.hidden';

const catalog = useCatalog();
const runs = useRuns();
const ui = useUi();

const hidden = ref(safeStorage.get(HIDDEN_KEY) === '1');
/** null mientras no se sabe (no se pinta la guía a medias para luego quitarla). */
const agentTried = ref<boolean | null>(null);
const workflowDone = ref<boolean | null>(null);
const testing = ref(false);
let timer: ReturnType<typeof setTimeout> | null = null;

async function refresh(): Promise<void> {
  // Oculta por el usuario, o con los dos hitos de ejecución ya cumplidos: no hace falta preguntar nada al servidor.
  if (hidden.value || (agentTried.value && workflowDone.value)) return;
  try {
    const milestones = await api.onboarding();
    agentTried.value = milestones.agentRun;
    workflowDone.value = milestones.workflowCompleted;
  } catch {
    /* sin conexión: el aviso general ya lo dice */
  }
}
onMounted(refresh);
// Solo cuando cambia el estado de una ejecución (no con cada paso terminado).
watch(
  () => runs.statusVersion,
  () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(refresh, 500);
  },
);
onBeforeUnmount(() => {
  if (timer) clearTimeout(timer);
});

const checking = computed(() => catalog.providers.length > 0 && !catalog.health.length);
const modelReady = computed(() => catalog.health.some((h) => h.ok));
const failing = computed(() => catalog.health.filter((h) => !h.ok));
/** Modelo que hay que descargar si el proveedor que falla es Ollama. */
const ollama = computed(() => {
  const provider = catalog.providers.find((p) => p.kind === 'ollama' && failing.value.some((h) => h.providerId === p.id));
  return provider ? { name: provider.name, command: `ollama pull ${provider.defaultModel || 'llama3.2'}` } : null;
});
const firstAgent = computed(() => catalog.agents[0] ?? null);
const firstWorkflow = computed(() => catalog.workflows[0] ?? null);

const known = computed(() => catalog.loaded && agentTried.value !== null && workflowDone.value !== null);
const doneCount = computed(() => [modelReady.value, agentTried.value, workflowDone.value].filter(Boolean).length);
const visible = computed(() => !hidden.value && known.value && doneCount.value < 3);

async function testConnection(): Promise<void> {
  testing.value = true;
  try {
    await catalog.refreshHealth(true);
    if (modelReady.value) ui.success(t('guide.toast.checked'));
    else ui.info(t('guide.toast.stillDown'));
  } finally {
    testing.value = false;
  }
}

async function copyCommand(): Promise<void> {
  if (!ollama.value) return;
  try {
    await navigator.clipboard.writeText(ollama.value.command);
    ui.success(t('guide.toast.copied'));
  } catch {
    ui.info(t('guide.toast.copyFailed'));
  }
}

function hide(): void {
  hidden.value = true;
  safeStorage.set(HIDDEN_KEY, '1');
}
</script>

<template>
  <section v-if="visible" class="card guide" aria-labelledby="guide-title" data-testid="guide">
    <div class="card-head">
      <div>
        <h2 id="guide-title">{{ t('guide.title') }}</h2>
        <p class="small muted" style="margin: 2px 0 0">{{ t('guide.progress', { done: doneCount }) }}</p>
      </div>
      <button class="btn btn-ghost btn-sm" type="button" @click="hide"><X /> {{ t('guide.hide') }}</button>
    </div>
    <ol class="steps">
      <li :class="{ done: modelReady }">
        <span class="mark" aria-hidden="true"><Check v-if="modelReady" /><template v-else>1</template></span>
        <div class="body">
          <h3>
            {{ t('guide.model.title') }} <span class="sr-only">({{ modelReady ? t('guide.done') : t('guide.pending') }})</span>
          </h3>
          <i18n-t v-if="modelReady" keypath="guide.model.ready" tag="p" class="small muted" scope="global">
            <template #provider
              ><Term id="proveedor">{{ t('guide.model.readyProvider') }}</Term></template
            >
            <template #models
              ><Term id="modelo">{{ t('guide.model.readyModels') }}</Term></template
            >
          </i18n-t>
          <p v-else-if="checking" class="small muted">{{ t('guide.model.checking') }}</p>
          <template v-else>
            <i18n-t v-if="!catalog.providers.length" keypath="guide.model.noProvider" tag="p" class="small" scope="global">
              <template #provider
                ><Term id="proveedor">{{ t('guide.model.noProviderWord') }}</Term></template
              >
              <template #add
                ><RouterLink to="/settings">{{ t('guide.model.addOne') }}</RouterLink></template
              >
            </i18n-t>
            <p v-for="h in failing" :key="h.providerId" class="small problem">
              <CircleAlert aria-hidden="true" />
              <span>{{
                h.error
                  ? t('guide.model.notRespondingWith', { name: h.name, error: serverText(h.error, h.errorI18n) })
                  : t('guide.model.notResponding', { name: h.name })
              }}</span>
            </p>
            <template v-if="ollama">
              <i18n-t keypath="guide.model.ollama" tag="p" class="small" scope="global">
                <template #ollama><Term id="ollama">Ollama</Term></template>
                <template #download
                  ><a href="https://ollama.com/download" target="_blank" rel="noopener noreferrer">{{ t('guide.model.ollamaDownload') }}</a></template
                >
              </i18n-t>
              <div class="command">
                <code>{{ ollama.command }}</code>
                <button class="btn btn-sm" type="button" @click="copyCommand"><Copy /> {{ t('common.actions.copy') }}</button>
              </div>
            </template>
            <i18n-t keypath="guide.model.remote" tag="p" class="small" scope="global">
              <template #add
                ><RouterLink to="/settings">{{ t('guide.model.remoteAdd') }}</RouterLink></template
              >
              <template #compatible
                ><Term id="openai-compatible">{{ t('guide.model.remoteCompatible') }}</Term></template
              >
            </i18n-t>
            <button class="btn btn-sm" type="button" :disabled="testing" @click="testConnection">
              <RefreshCw :class="{ spin: testing }" /> {{ testing ? t('guide.model.testing') : t('guide.model.test') }}
            </button>
          </template>
        </div>
      </li>
      <li :class="{ done: agentTried }">
        <span class="mark" aria-hidden="true"><Check v-if="agentTried" /><template v-else>2</template></span>
        <div class="body">
          <h3>
            {{ t('guide.agent.title') }} <span class="sr-only">({{ agentTried ? t('guide.done') : t('guide.pending') }})</span>
          </h3>
          <i18n-t keypath="guide.agent.text" tag="p" class="small muted" scope="global">
            <template #agent
              ><Term id="agente">{{ t('guide.agent.agentWord') }}</Term></template
            >
          </i18n-t>
          <RouterLink v-if="!agentTried && firstAgent" class="btn btn-sm" :to="`/agents/${firstAgent.id}`">{{
            t('guide.agent.open', { name: firstAgent.name })
          }}</RouterLink>
          <RouterLink v-else-if="!agentTried" class="btn btn-sm" to="/agents/new">{{ t('guide.agent.create') }}</RouterLink>
        </div>
      </li>
      <li :class="{ done: workflowDone }">
        <span class="mark" aria-hidden="true"><Check v-if="workflowDone" /><template v-else>3</template></span>
        <div class="body">
          <h3>
            {{ t('guide.workflow.title') }} <span class="sr-only">({{ workflowDone ? t('guide.done') : t('guide.pending') }})</span>
          </h3>
          <i18n-t keypath="guide.workflow.text" tag="p" class="small muted" scope="global">
            <template #workflow
              ><Term id="workflow">{{ t('guide.workflow.workflowWord') }}</Term></template
            >
          </i18n-t>
          <RouterLink v-if="!workflowDone && firstWorkflow" class="btn btn-sm" :to="`/workflows/${firstWorkflow.id}`"
            ><Play /> {{ t('guide.workflow.open', { name: firstWorkflow.name }) }}</RouterLink
          >
          <RouterLink v-else-if="!workflowDone" class="btn btn-sm" to="/workflows/new">{{ t('guide.workflow.create') }}</RouterLink>
        </div>
      </li>
    </ol>
  </section>
</template>

<style scoped>
.guide {
  margin-bottom: 16px;
}
/* Los botones llevan el nombre del agente o del workflow: si es largo, se parten en vez de salirse en el móvil. */
.body {
  min-width: 0;
}
.body .btn {
  max-width: 100%;
  white-space: normal;
  overflow-wrap: anywhere;
}
.steps {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0;
  margin: 0;
  padding: 0;
  list-style: none;
}
.steps li {
  display: flex;
  gap: 12px;
  min-width: 0;
  padding: 16px 18px;
  border-left: 1px solid var(--border);
}
.steps li:first-child {
  border-left: 0;
}
.mark {
  display: grid;
  place-items: center;
  flex: none;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  border: 1.5px solid var(--control-border);
  color: var(--text-2);
  font-size: 12.5px;
  font-weight: 600;
}
.mark svg {
  width: 15px;
  height: 15px;
}
.done .mark {
  border-color: var(--success);
  background: var(--success);
  color: var(--surface);
}
.body {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  min-width: 0;
}
.body h3 {
  margin: 2px 0 0;
  font-size: 14px;
}
.body p {
  margin: 0;
  overflow-wrap: anywhere;
}
.problem {
  display: flex;
  gap: 6px;
  color: var(--danger);
}
.problem svg {
  width: 15px;
  height: 15px;
  flex: none;
  margin-top: 2px;
}
.command {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  max-width: 100%;
}
.command code {
  padding: 5px 9px;
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  border: 1px solid var(--border);
  overflow-wrap: anywhere;
}
@media (max-width: 980px) {
  .steps {
    grid-template-columns: minmax(0, 1fr);
  }
  .steps li {
    border-left: 0;
    border-top: 1px solid var(--border);
  }
  .steps li:first-child {
    border-top: 0;
  }
}
</style>
