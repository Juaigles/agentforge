<script setup lang="ts">
import type { AgentInput, ModelInfo } from '@shared/types';
import { ArrowLeft, CircleAlert, Copy, RefreshCw, Save, Trash2, TriangleAlert } from 'lucide-vue-next';
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router';
import AgentAvatar from '@/components/AgentAvatar.vue';
import RunPlayground from '@/components/RunPlayground.vue';
import Term from '@/components/Term.vue';
import { api, ApiError, errorText } from '@/lib/api';
import { formatBytes } from '@/lib/format';
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

onMounted(async () => {
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
});
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
const unknownTools = computed(() => form.tools.filter((t) => !catalog.toolByName.has(t)));

const maxTokensText = computed({
  get: () => (form.maxTokens === null ? '' : String(form.maxTokens)),
  // Vue entrega un número (no un texto) en los <input type="number">.
  set: (v: string | number) => (form.maxTokens = String(v).trim() === '' ? null : Math.max(16, Math.round(Number(v)) || 16)),
});

function validate(): boolean {
  const errors: Record<string, string> = {};
  if (!form.name.trim()) errors.name = 'Ponle un nombre al agente.';
  if (!form.providerId) errors.providerId = 'Selecciona un proveedor.';
  if (!form.model.trim()) errors.model = 'Selecciona un modelo.';
  fieldErrors.value = errors;
  return !Object.keys(errors).length;
}

async function save(): Promise<boolean> {
  if (!validate()) return false;
  saving.value = true;
  try {
    const payload: AgentInput = { ...form, tools: form.tools.filter((t) => catalog.toolByName.has(t)) };
    const agent = agentId.value ? await api.agents.update(agentId.value, payload) : await api.agents.create(payload);
    catalog.setAgent(agent);
    form.tools = agent.tools;
    snapshot();
    ui.success(`«${agent.name}» guardado.`);
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
  const ok = await ui.confirm({ title: 'Eliminar agente', message: `Se eliminará «${form.name}». Esta acción no se puede deshacer.`, confirmLabel: 'Eliminar', danger: true });
  if (!ok) return;
  try {
    await api.agents.remove(agentId.value);
    catalog.dropAgent(agentId.value);
    snapshot();
    ui.success('Agente eliminado.');
    void router.push('/agents');
  } catch (err) {
    ui.error(errorText(err));
  }
}

onBeforeRouteLeave(async () => {
  if (!dirty.value || loading.value || loadError.value) return true;
  return ui.confirm({ title: 'Cambios sin guardar', message: 'Si sales ahora perderás los cambios de este agente.', confirmLabel: 'Salir sin guardar', danger: true });
});

const playgroundBlocked = computed(() => {
  if (isNew.value) return 'Guarda el agente para poder probarlo.';
  if (dirty.value) return 'Guarda los cambios para probar la versión actual.';
  return null;
});
</script>

<template>
  <div class="page">
    <header class="page-header">
      <div class="row" style="gap: 12px; align-items: center">
        <RouterLink class="btn btn-ghost btn-icon" to="/agents" aria-label="Volver a agentes"><ArrowLeft /></RouterLink>
        <AgentAvatar :name="form.name || 'Nuevo'" :color="form.color" :size="40" />
        <div>
          <h1>{{ form.name || (isNew ? 'Nuevo agente' : 'Agente') }}</h1>
          <p class="subtitle" style="margin-top: 0">{{ form.role || 'Define su papel, su modelo y sus herramientas' }}</p>
        </div>
      </div>
      <div class="row wrap">
        <span v-if="dirty && !loading" class="badge warning">Cambios sin guardar</span>
        <button v-if="!isNew" class="btn btn-ghost btn-icon" type="button" aria-label="Duplicar agente" title="Duplicar" @click="duplicate"><Copy /></button>
        <button v-if="!isNew" class="btn btn-ghost btn-icon" type="button" aria-label="Eliminar agente" title="Eliminar" @click="remove"><Trash2 /></button>
        <button class="btn btn-primary" type="button" :disabled="saving || loading || (!dirty && !isNew)" @click="save"><Save /> {{ saving ? 'Guardando…' : 'Guardar' }}</button>
      </div>
    </header>

    <div v-if="loadError" class="callout danger" role="alert"><CircleAlert /> {{ loadError }}</div>
    <div v-else-if="loading" class="card skeleton" style="height: 420px" aria-busy="true" />

    <div v-else class="layout">
      <form class="col" style="gap: 16px" novalidate @submit.prevent="save">
        <section class="card card-pad">
          <h2 class="section-title">Identidad</h2>
          <div class="form-grid">
            <div class="field">
              <label for="ag-name">Nombre</label>
              <input id="ag-name" v-model="form.name" class="input" maxlength="80" placeholder="Investigador" :aria-invalid="!!fieldErrors.name" />
              <span v-if="fieldErrors.name" class="error">{{ fieldErrors.name }}</span>
            </div>
            <div class="field">
              <label for="ag-role">Rol</label>
              <input id="ag-role" v-model="form.role" class="input" maxlength="160" placeholder="especialista en recopilar hechos" />
              <span class="hint">Se le dice al modelo: «Eres {{ form.name || '…' }}, {{ form.role || '…' }}».</span>
            </div>
            <div class="field span-2">
              <label for="ag-desc">Descripción</label>
              <input id="ag-desc" v-model="form.description" class="input" maxlength="1000" placeholder="Para qué sirve este agente (la ven otros agentes al delegar)" />
            </div>
            <div class="field span-2">
              <span class="label">Color</span>
              <div class="row wrap" role="radiogroup" aria-label="Color del agente">
                <button
                  v-for="c in COLORS"
                  :key="c"
                  type="button"
                  class="swatch"
                  :class="{ active: form.color === c }"
                  :style="{ background: c }"
                  role="radio"
                  :aria-checked="form.color === c"
                  :aria-label="`Color ${c}`"
                  @click="form.color = c"
                />
              </div>
            </div>
          </div>
        </section>

        <section class="card card-pad">
          <h2 class="section-title">Modelo</h2>
          <div v-if="!catalog.providers.length" class="callout warning">
            <TriangleAlert />
            <div>No hay proveedores configurados. <RouterLink to="/settings">Añade uno en Ajustes</RouterLink>.</div>
          </div>
          <div class="form-grid">
            <div class="field">
              <label for="ag-provider"><Term id="proveedor">Proveedor</Term></label>
              <select id="ag-provider" v-model="form.providerId" class="select" :aria-invalid="!!fieldErrors.providerId" @change="form.model = ''">
                <option value="" disabled>Selecciona…</option>
                <option v-for="p in catalog.providers" :key="p.id" :value="p.id">{{ p.name }}{{ p.enabled ? '' : ' (desactivado)' }}</option>
              </select>
              <span v-if="fieldErrors.providerId" class="error">{{ fieldErrors.providerId }}</span>
            </div>
            <div class="field">
              <label for="ag-model">
                <Term id="modelo">Modelo</Term>
                <button v-if="form.providerId" class="link-btn" type="button" title="Volver a cargar la lista" aria-label="Recargar modelos" @click="loadModels">
                  <RefreshCw :class="{ spin: modelsLoading }" />
                </button>
              </label>
              <select v-if="showSelect" id="ag-model" v-model="form.model" class="select" :aria-invalid="!!fieldErrors.model">
                <option value="" disabled>Selecciona…</option>
                <option v-if="modelMissing" :value="form.model">{{ form.model }} (no instalado)</option>
                <option v-for="m in models" :key="m.id" :value="m.id">
                  {{ m.id }}{{ m.parameterSize ? ` · ${m.parameterSize}` : '' }}{{ m.sizeBytes ? ` · ${formatBytes(m.sizeBytes)}` : '' }}
                </option>
              </select>
              <input v-else id="ag-model" v-model="form.model" class="input" placeholder="p. ej. qwen3:8b o gpt-4o-mini" :aria-invalid="!!fieldErrors.model" />
              <span v-if="fieldErrors.model" class="error">{{ fieldErrors.model }}</span>
              <span v-else-if="modelsError" class="error">No se pudo obtener la lista de modelos: {{ modelsError }}</span>
              <span v-else-if="modelMissing" class="error">Este modelo ya no está disponible en el proveedor.</span>
              <span v-else class="hint">
                <template v-if="currentModel?.capabilities">Capacidades: {{ currentModel.capabilities.join(', ') }}. </template>
                <button v-if="models.length" class="link-btn text" type="button" @click="manualModel = !manualModel">
                  {{ manualModel ? 'Elegir de la lista' : 'Escribir a mano' }}
                </button>
              </span>
            </div>

            <div class="field">
              <label for="ag-temp"><Term id="temperatura">Temperatura</Term> <span class="num value">{{ form.temperature.toFixed(1).replace('.', ',') }}</span></label>
              <input id="ag-temp" v-model.number="form.temperature" type="range" min="0" max="2" step="0.1" />
              <span class="hint row between"><span>Preciso</span><span>Creativo</span></span>
            </div>
            <div class="field">
              <label for="ag-iter"><Term id="iteraciones">Iteraciones</Term> máximas</label>
              <input id="ag-iter" v-model.number="form.maxIterations" class="input" type="number" min="1" max="30" />
              <span class="hint">Vueltas con herramientas antes de exigir la respuesta final.</span>
            </div>
            <div class="field">
              <label for="ag-maxtok"><Term id="tokens">Tokens</Term> de salida máximos</label>
              <input id="ag-maxtok" v-model="maxTokensText" class="input" type="number" min="16" placeholder="Por defecto del modelo" />
            </div>
            <div class="field">
              <span class="label"><Term id="razonamiento">Razonamiento</Term></span>
              <label class="check" style="padding-top: 6px">
                <input v-model="form.thinking" type="checkbox" class="switch" />
                <span class="small muted">Dejar que el modelo razone antes de responder (más lento).</span>
              </label>
            </div>
          </div>
          <div v-if="lacksTools" class="callout warning" style="margin-top: 14px">
            <TriangleAlert />
            <div>«{{ form.model }}» no declara soporte de herramientas: es probable que ignore las que has activado.</div>
          </div>
          <div v-if="lacksThinking" class="callout" style="margin-top: 14px">
            <TriangleAlert />
            <div>«{{ form.model }}» no soporta razonamiento; la opción se ignorará.</div>
          </div>
        </section>

        <section class="card card-pad">
          <h2 class="section-title"><Term id="prompt-sistema">Instrucciones del sistema</Term></h2>
          <div class="field">
            <label for="ag-prompt" class="sr-only">Instrucciones del sistema</label>
            <textarea
              id="ag-prompt"
              v-model="form.systemPrompt"
              class="textarea"
              rows="8"
              maxlength="20000"
              placeholder="Describe cómo debe trabajar: objetivo, formato de respuesta, tono, límites…"
            />
            <span class="hint">{{ form.systemPrompt.length.toLocaleString('es-ES') }} caracteres</span>
          </div>
        </section>

        <section class="card card-pad">
          <div class="row between" style="margin-bottom: 12px">
            <h2><Term id="herramienta">Herramientas</Term></h2>
            <span class="badge" :class="{ accent: form.tools.length }">{{ form.tools.length }} activas</span>
          </div>
          <div v-if="unknownTools.length" class="callout warning" style="margin-bottom: 12px">
            <TriangleAlert />
            <div>Herramientas que ya no existen y se quitarán al guardar: {{ unknownTools.join(', ') }}.</div>
          </div>
          <div v-for="[category, list] in toolGroups" :key="category" class="tool-group">
            <div class="eyebrow">{{ category }}</div>
            <label v-for="tool in list" :key="tool.name" class="check tool">
              <input v-model="form.tools" type="checkbox" :value="tool.name" />
              <span class="grow">
                <span class="row wrap" style="gap: 6px">
                  <strong>{{ tool.title }}</strong>
                  <code class="faint">{{ tool.name }}</code>
                  <span v-if="tool.dangerous" class="badge warning">Requiere activarla en Ajustes</span>
                  <span v-if="!tool.enabled" class="badge danger">Desactivada</span>
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
