<script setup lang="ts">
import type { AgentInput, ModelInfo } from '@shared/types';
import { ArrowLeft, CircleAlert, Copy, RefreshCw, Save, Trash2, TriangleAlert } from 'lucide-vue-next';
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router';
import AgentAvatar from '@/components/AgentAvatar.vue';
import RunPlayground from '@/components/RunPlayground.vue';
import Term from '@/components/Term.vue';
import { api, ApiError, errorText } from '@/lib/api';
import { intlLocale, t } from '@/i18n';
import { formatBytes, formatNumber } from '@/lib/format';
import { agentDeleteMessage, workflowsUsingAgent } from '@/lib/usage';
import { useCatalog } from '@/stores/catalog';
import { useRuns } from '@/stores/runs';
import { useUi } from '@/stores/ui';

const COLORS = ['#0ea5e9', '#6366f1', '#8b5cf6', '#d946ef', '#ef4444', '#f59e0b', '#10b981', '#14b8a6', '#64748b'];

const route = useRoute();
const router = useRouter();
const catalog = useCatalog();
const runsStore = useRuns();
const ui = useUi();

const agentId = computed(() => (route.params.id ? String(route.params.id) : null));
const isNew = computed(() => !agentId.value);

const form = reactive<AgentInput>({
  name: '',
  role: '',
  description: '',
  color: COLORS[1],
  providerId: '',
  model: '',
  systemPrompt: '',
  temperature: 0.7,
  maxTokens: null,
  maxIterations: 8,
  tools: [],
  thinking: false,
});
const saved = ref('');
const loading = ref(true);
const loadError = ref<string | null>(null);
const saving = ref(false);
const fieldErrors = ref<Record<string, string>>({});

const models = ref<ModelInfo[]>([]);
const modelsError = ref<string | null>(null);
const modelsLoading = ref(false);
const manualModel = ref(false);

const dirty = computed(() => JSON.stringify(form) !== saved.value);
const snapshot = () => (saved.value = JSON.stringify(form));

async function load(): Promise<void> {
  loadError.value = null;
  loading.value = true;
  try {
    await catalog.ensure();
    if (agentId.value) {
      const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = await api.agents.get(agentId.value);
      Object.assign(form, rest);
    } else {
      const provider = catalog.providers.find((p) => p.enabled) ?? catalog.providers[0];
      form.providerId = provider?.id ?? '';
      form.model = provider?.defaultModel ?? '';
      form.color = COLORS[catalog.agents.length % COLORS.length];
    }
    snapshot();
  } catch (err) {
    loadError.value = errorText(err);
  } finally {
    loading.value = false;
  }
}
onMounted(load);
// Un error de carga no es definitivo: «Reintentar», o solo cuando vuelve la conexión con el servidor.
watch(
  () => catalog.online,
  (online) => {
    if (online && loadError.value && !loading.value) void load();
  },
);
onBeforeUnmount(() => (runsStore.watching = null));

async function loadModels(): Promise<void> {
  models.value = [];
  modelsError.value = null;
  if (!form.providerId) return;
  modelsLoading.value = true;
  const requested = form.providerId;
  try {
    const list = await api.providers.models(requested);
    if (requested !== form.providerId) return;
    // Los modelos de embeddings no sirven para conversar.
    models.value = list.filter((m) => !m.capabilities || m.capabilities.includes('completion'));
    if (!form.model && models.value.length) form.model = catalog.providerById.get(requested)?.defaultModel || models.value[0].id;
  } catch (err) {
    if (requested === form.providerId) modelsError.value = errorText(err);
  } finally {
    if (requested === form.providerId) modelsLoading.value = false;
  }
}
watch(() => form.providerId, loadModels, { immediate: true });

const currentModel = computed(() => models.value.find((m) => m.id === form.model));
const modelMissing = computed(() => models.value.length > 0 && !!form.model && !currentModel.value);
const lacksTools = computed(() => form.tools.length > 0 && !!currentModel.value?.capabilities && !currentModel.value.capabilities.includes('tools'));
const lacksThinking = computed(() => form.thinking && !!currentModel.value?.capabilities && !currentModel.value.capabilities.includes('thinking'));
const showSelect = computed(() => models.value.length > 0 && !manualModel.value);

const toolGroups = computed(() => {
  const groups = new Map<string, typeof catalog.tools>();
  for (const tool of catalog.tools) {
    if (!tool.enabled && !form.tools.includes(tool.name)) continue;
    if (!groups.has(tool.category)) groups.set(tool.category, []);
    groups.get(tool.category)!.push(tool);
  }
  return [...groups.entries()];
});
const unknownTools = computed(() => form.tools.filter((name) => !catalog.toolByName.has(name)));
/** Temperatura con un decimal y la coma o el punto del idioma actual. */
const temperatureText = computed(() => form.temperature.toLocaleString(intlLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }));

const maxTokensText = computed({
  get: () => (form.maxTokens === null ? '' : String(form.maxTokens)),
  // Vue entrega un número (no un texto) en los <input type="number">.
  set: (v: string | number) => (form.maxTokens = String(v).trim() === '' ? null : Math.max(16, Math.round(Number(v)) || 16)),
});

function validate(): boolean {
  const errors: Record<string, string> = {};
  if (!form.name.trim()) errors.name = t('agentEditor.validation.name');
  if (!form.providerId) errors.providerId = t('agentEditor.validation.provider');
  if (!form.model.trim()) errors.model = t('agentEditor.validation.model');
  fieldErrors.value = errors;
  return !Object.keys(errors).length;
}

async function save(): Promise<boolean> {
  if (!validate()) return false;
  saving.value = true;
  try {
    const payload: AgentInput = { ...form, tools: form.tools.filter((name) => catalog.toolByName.has(name)) };
    const agent = agentId.value ? await api.agents.update(agentId.value, payload) : await api.agents.create(payload);
    catalog.setAgent(agent);
    form.tools = agent.tools;
    snapshot();
    ui.success(t('agentEditor.toast.saved', { name: agent.name }));
    if (!agentId.value) await router.replace(`/agents/${agent.id}`);
    return true;
  } catch (err) {
    if (err instanceof ApiError && err.issues.length) {
      fieldErrors.value = Object.fromEntries(err.issues.map((i) => [i.path, i.message]));
    }
    ui.error(errorText(err));
    return false;
  } finally {
    saving.value = false;
  }
}

async function duplicate(): Promise<void> {
  if (!agentId.value) return;
  try {
    const copy = await api.agents.duplicate(agentId.value);
    catalog.setAgent(copy);
    void router.push(`/agents/${copy.id}`);
  } catch (err) {
    ui.error(errorText(err));
  }
}

async function remove(): Promise<void> {
  if (!agentId.value) return;
  const ok = await ui.confirm({
    title: t('agentEditor.confirm.deleteTitle'),
    message: agentDeleteMessage(form.name, workflowsUsingAgent(catalog.workflows, agentId.value)),
    confirmLabel: t('agentEditor.confirm.deleteLabel'),
    danger: true,
  });
  if (!ok) return;
  try {
    await api.agents.remove(agentId.value);
    catalog.dropAgent(agentId.value);
    snapshot();
    ui.success(t('agentEditor.toast.deleted'));
    void router.push('/agents');
  } catch (err) {
    ui.error(errorText(err));
  }
}

onBeforeRouteLeave(async () => {
  if (!dirty.value || loading.value || loadError.value) return true;
  return ui.confirm({
    title: t('agentEditor.confirm.leaveTitle'),
    message: t('agentEditor.confirm.leaveMessage'),
    confirmLabel: t('agentEditor.confirm.leaveLabel'),
    danger: true,
  });
});

const playgroundBlocked = computed(() => {
  if (isNew.value) return t('agentEditor.playground.saveFirst');
  if (dirty.value) return t('agentEditor.playground.saveChanges');
  return null;
});
</script>

<template>
  <div class="page">
    <header class="page-header">
      <div class="row" style="gap: 12px; align-items: center">
        <RouterLink class="btn btn-ghost btn-icon" to="/agents" :aria-label="t('agentEditor.backLabel')"><ArrowLeft /></RouterLink>
        <AgentAvatar :name="form.name || t('agentEditor.avatarFallback')" :color="form.color" :size="40" />
        <div>
          <h1>{{ form.name || (isNew ? t('agentEditor.newTitle') : t('agentEditor.title')) }}</h1>
          <p class="subtitle" style="margin-top: 0">{{ form.role || t('agentEditor.subtitleFallback') }}</p>
        </div>
      </div>
      <div class="row wrap">
        <span v-if="dirty && !loading" class="badge warning">{{ t('agentEditor.unsaved') }}</span>
        <button
          v-if="!isNew"
          class="btn btn-ghost btn-icon"
          type="button"
          :aria-label="t('agentEditor.duplicateLabel')"
          :title="t('common.actions.duplicate')"
          @click="duplicate"
        >
          <Copy />
        </button>
        <button
          v-if="!isNew"
          class="btn btn-ghost btn-icon"
          type="button"
          :aria-label="t('agentEditor.deleteLabel')"
          :title="t('common.actions.delete')"
          @click="remove"
        >
          <Trash2 />
        </button>
        <!-- Envía el formulario (aunque el botón esté fuera de él) para que el foco vaya al primer campo con error. -->
        <button class="btn btn-primary" type="submit" form="agent-form" :disabled="saving || loading || !!loadError || (!dirty && !isNew)">
          <Save /> {{ saving ? t('common.actions.saving') : t('common.actions.save') }}
        </button>
      </div>
    </header>

    <template v-if="loadError">
      <div class="callout danger" role="alert"><CircleAlert /> {{ loadError }}</div>
      <button class="btn" type="button" style="margin-top: 12px" @click="load">{{ t('common.actions.retry') }}</button>
    </template>
    <div v-else-if="loading" class="card skeleton" style="height: 420px" aria-busy="true" />

    <div v-else class="layout">
      <form id="agent-form" class="col" style="gap: 16px" novalidate @submit.prevent="save">
        <section class="card card-pad">
          <h2 class="section-title">{{ t('agentEditor.identity.title') }}</h2>
          <div class="form-grid">
            <div class="field">
              <label for="ag-name">{{ t('agentEditor.identity.name') }}</label>
              <input
                id="ag-name"
                v-model="form.name"
                class="input"
                maxlength="80"
                :placeholder="t('agentEditor.identity.namePlaceholder')"
                :aria-invalid="!!fieldErrors.name"
              />
              <span v-if="fieldErrors.name" class="error">{{ fieldErrors.name }}</span>
            </div>
            <div class="field">
              <label for="ag-role">{{ t('agentEditor.identity.role') }}</label>
              <input id="ag-role" v-model="form.role" class="input" maxlength="160" :placeholder="t('agentEditor.identity.rolePlaceholder')" />
              <i18n-t keypath="agentEditor.identity.roleHint" tag="span" class="hint" scope="global">
                <template #model
                  ><Term id="modelo">{{ t('agentEditor.identity.roleHintModel') }}</Term></template
                >
                <template #name>{{ form.name || '…' }}</template>
                <template #role>{{ form.role || '…' }}</template>
              </i18n-t>
            </div>
            <div class="field span-2">
              <label for="ag-desc">{{ t('agentEditor.identity.description') }}</label>
              <input id="ag-desc" v-model="form.description" class="input" maxlength="1000" :placeholder="t('agentEditor.identity.descriptionPlaceholder')" />
              <i18n-t keypath="agentEditor.identity.descriptionHint" tag="span" class="hint" scope="global">
                <template #delegation
                  ><Term id="delegacion">{{ t('agentEditor.identity.descriptionHintDelegation') }}</Term></template
                >
              </i18n-t>
            </div>
            <div class="field span-2">
              <span class="label">{{ t('agentEditor.identity.color') }}</span>
              <div class="row wrap" role="radiogroup" :aria-label="t('agentEditor.identity.colorGroup')">
                <button
                  v-for="c in COLORS"
                  :key="c"
                  type="button"
                  class="swatch"
                  :class="{ active: form.color === c }"
                  :style="{ background: c }"
                  role="radio"
                  :aria-checked="form.color === c"
                  :aria-label="t('agentEditor.identity.colorLabel', { color: c })"
                  @click="form.color = c"
                />
              </div>
            </div>
          </div>
        </section>

        <section class="card card-pad">
          <h2 class="section-title">{{ t('agentEditor.model.title') }}</h2>
          <div v-if="!catalog.providers.length" class="callout warning">
            <TriangleAlert />
            <i18n-t keypath="agentEditor.model.noProviders" tag="div" scope="global">
              <template #add
                ><RouterLink to="/settings">{{ t('agentEditor.model.addOne') }}</RouterLink></template
              >
            </i18n-t>
          </div>
          <div class="form-grid">
            <div class="field">
              <label for="ag-provider"
                ><Term id="proveedor">{{ t('agentEditor.model.provider') }}</Term></label
              >
              <select id="ag-provider" v-model="form.providerId" class="select" :aria-invalid="!!fieldErrors.providerId" @change="form.model = ''">
                <option value="" disabled>{{ t('agentEditor.model.select') }}</option>
                <option v-for="p in catalog.providers" :key="p.id" :value="p.id">{{ p.name }}{{ p.enabled ? '' : t('agentEditor.model.disabled') }}</option>
              </select>
              <span v-if="fieldErrors.providerId" class="error">{{ fieldErrors.providerId }}</span>
            </div>
            <div class="field">
              <label for="ag-model">
                <Term id="modelo">{{ t('agentEditor.model.label') }}</Term>
                <button
                  v-if="form.providerId"
                  class="link-btn"
                  type="button"
                  :title="t('agentEditor.model.reloadTitle')"
                  :aria-label="t('agentEditor.model.reloadLabel')"
                  @click="loadModels"
                >
                  <RefreshCw :class="{ spin: modelsLoading }" />
                </button>
              </label>
              <select v-if="showSelect" id="ag-model" v-model="form.model" class="select" :aria-invalid="!!fieldErrors.model">
                <option value="" disabled>{{ t('agentEditor.model.select') }}</option>
                <option v-if="modelMissing" :value="form.model">{{ t('agentEditor.model.notInstalled', { model: form.model }) }}</option>
                <option v-for="m in models" :key="m.id" :value="m.id">
                  {{ m.id }}{{ m.parameterSize ? ` · ${m.parameterSize}` : '' }}{{ m.sizeBytes ? ` · ${formatBytes(m.sizeBytes)}` : '' }}
                </option>
              </select>
              <input
                v-else
                id="ag-model"
                v-model="form.model"
                class="input"
                :placeholder="t('agentEditor.model.manualPlaceholder')"
                :aria-invalid="!!fieldErrors.model"
              />
              <span v-if="fieldErrors.model" class="error">{{ fieldErrors.model }}</span>
              <span v-else-if="modelsError" class="error">{{ t('agentEditor.model.listError', { error: modelsError }) }}</span>
              <span v-else-if="modelMissing" class="error">{{ t('agentEditor.model.unavailable') }}</span>
              <span v-else class="hint">
                <template v-if="currentModel?.capabilities"
                  ><Term id="capacidades">{{ t('agentEditor.model.capabilities') }}</Term
                  >: {{ currentModel.capabilities.join(', ') }}.
                </template>
                <button v-if="models.length" class="link-btn text" type="button" @click="manualModel = !manualModel">
                  {{ manualModel ? t('agentEditor.model.pickFromList') : t('agentEditor.model.typeByHand') }}
                </button>
              </span>
            </div>

            <div class="field">
              <label for="ag-temp"
                ><Term id="temperatura">{{ t('agentEditor.model.temperature') }}</Term> <span class="num value">{{ temperatureText }}</span></label
              >
              <input id="ag-temp" v-model.number="form.temperature" type="range" min="0" max="2" step="0.1" />
              <span class="hint row between"
                ><span>{{ t('agentEditor.model.precise') }}</span
                ><span>{{ t('agentEditor.model.creative') }}</span></span
              >
            </div>
            <div class="field">
              <i18n-t keypath="agentEditor.model.maxIterations" tag="label" for="ag-iter" scope="global">
                <template #iterations
                  ><Term id="iteraciones">{{ t('agentEditor.model.iterations') }}</Term></template
                >
              </i18n-t>
              <input id="ag-iter" v-model.number="form.maxIterations" class="input" type="number" min="1" max="30" />
              <span class="hint">{{ t('agentEditor.model.iterationsHint') }}</span>
            </div>
            <div class="field">
              <i18n-t keypath="agentEditor.model.maxTokens" tag="label" for="ag-maxtok" scope="global">
                <template #tokens
                  ><Term id="tokens">{{ t('agentEditor.model.tokens') }}</Term></template
                >
              </i18n-t>
              <input id="ag-maxtok" v-model="maxTokensText" class="input" type="number" min="16" :placeholder="t('agentEditor.model.maxTokensPlaceholder')" />
            </div>
            <div class="field">
              <span class="label"
                ><Term id="razonamiento">{{ t('agentEditor.model.thinking') }}</Term></span
              >
              <label class="check" style="padding-top: 6px">
                <input v-model="form.thinking" type="checkbox" class="switch" />
                <span class="small muted">{{ t('agentEditor.model.thinkingHint') }}</span>
              </label>
            </div>
          </div>
          <div v-if="lacksTools" class="callout warning" style="margin-top: 14px">
            <TriangleAlert />
            <div>{{ t('agentEditor.model.lacksTools', { model: form.model }) }}</div>
          </div>
          <div v-if="lacksThinking" class="callout" style="margin-top: 14px">
            <TriangleAlert />
            <div>{{ t('agentEditor.model.lacksThinking', { model: form.model }) }}</div>
          </div>
        </section>

        <section class="card card-pad">
          <h2 class="section-title">{{ t('agentEditor.prompt.title') }}</h2>
          <div class="field">
            <label for="ag-prompt" class="sr-only">{{ t('agentEditor.prompt.title') }}</label>
            <textarea
              id="ag-prompt"
              v-model="form.systemPrompt"
              class="textarea"
              rows="8"
              maxlength="20000"
              :placeholder="t('agentEditor.prompt.placeholder')"
            />
            <i18n-t keypath="agentEditor.prompt.hint" tag="span" class="hint" scope="global">
              <template #prompt
                ><Term id="prompt-sistema">{{ t('agentEditor.prompt.hintPrompt') }}</Term></template
              >
              <template #count>{{ formatNumber(form.systemPrompt.length) }}</template>
            </i18n-t>
          </div>
        </section>

        <section class="card card-pad">
          <div class="row between" style="margin-bottom: 12px">
            <h2>{{ t('agentEditor.tools.title') }}</h2>
            <span class="badge" :class="{ accent: form.tools.length }">{{ t('agentEditor.tools.active', { n: form.tools.length }) }}</span>
          </div>
          <i18n-t keypath="agentEditor.tools.intro" tag="p" class="small muted" style="margin-bottom: 12px" scope="global">
            <template #tool
              ><Term id="herramienta">{{ t('agentEditor.tools.introTool') }}</Term></template
            >
            <template #memory
              ><Term id="memoria-compartida">{{ t('agentEditor.tools.introMemory') }}</Term></template
            >
          </i18n-t>
          <div v-if="unknownTools.length" class="callout warning" style="margin-bottom: 12px">
            <TriangleAlert />
            <div>{{ t('agentEditor.tools.unknown', { names: unknownTools.join(', ') }) }}</div>
          </div>
          <div v-for="[category, list] in toolGroups" :key="category" class="tool-group">
            <div class="eyebrow">{{ category }}</div>
            <label v-for="tool in list" :key="tool.name" class="check tool">
              <input v-model="form.tools" type="checkbox" :value="tool.name" />
              <span class="grow">
                <span class="row wrap" style="gap: 6px">
                  <strong>{{ tool.title }}</strong>
                  <code class="faint">{{ tool.name }}</code>
                  <span v-if="tool.dangerous" class="badge warning">{{ t('agentEditor.tools.needsEnabling') }}</span>
                  <span v-if="!tool.enabled" class="badge danger">{{ t('agentEditor.tools.disabled') }}</span>
                </span>
                <span class="small muted desc">{{ tool.description }}</span>
              </span>
            </label>
          </div>
        </section>
      </form>

      <aside class="side">
        <RunPlayground :agent-id="agentId" :blocked="playgroundBlocked" />
      </aside>
    </div>
  </div>
</template>

<style scoped>
.layout {
  display: grid;
  grid-template-columns: minmax(0, 1.25fr) minmax(320px, 1fr);
  gap: 16px;
  align-items: start;
}
.side {
  position: sticky;
  top: 16px;
}
.section-title {
  margin-bottom: 14px;
}
.swatch {
  width: 26px;
  height: 26px;
  border-radius: 8px;
  border: 2px solid transparent;
  cursor: pointer;
  outline-offset: 2px;
}
.swatch.active {
  border-color: var(--surface);
  box-shadow: 0 0 0 2px var(--text);
}
.value {
  margin-left: auto;
  color: var(--text);
}
.link-btn {
  display: inline-flex;
  border: 0;
  background: none;
  padding: 0;
  color: var(--text-3);
  cursor: pointer;
  font: inherit;
}
.link-btn:hover {
  color: var(--accent);
}
.link-btn svg {
  width: 13px;
  height: 13px;
}
.link-btn.text {
  color: var(--accent);
  font-size: 12px;
}
.tool-group {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.tool-group + .tool-group {
  margin-top: 14px;
}
.tool {
  padding: 8px 10px;
  margin: 0 -10px;
  border-radius: 8px;
}
.tool:hover {
  background: var(--surface-2);
}
.tool .desc {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
@media (max-width: 1080px) {
  .layout {
    grid-template-columns: 1fr;
  }
  .side {
    position: static;
  }
}
</style>
