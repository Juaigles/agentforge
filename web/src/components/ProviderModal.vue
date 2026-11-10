<script setup lang="ts">
// Alta y edición de un proveedor de modelos, con prueba de conexión sin guardar.
import type { ModelInfo, Provider, ProviderInput, ProviderKind, ProviderTestResult } from '@shared/types';
import { CircleAlert, CircleCheck, KeyRound, LoaderCircle, PlugZap } from 'lucide-vue-next';
import { computed, reactive, ref } from 'vue';
import { api, ApiError, errorText } from '@/lib/api';
import { formatDuration, plural } from '@/lib/format';
import { useCatalog } from '@/stores/catalog';
import { useUi } from '@/stores/ui';
import AppModal from './AppModal.vue';
import Term from './Term.vue';

const props = defineProps<{ provider?: Provider | null }>();
const emit = defineEmits<{ close: []; saved: [provider: Provider] }>();

const catalog = useCatalog();
const ui = useUi();
const editing = computed(() => Boolean(props.provider));

const PRESETS: Array<{ label: string; kind: ProviderKind; baseUrl: string; name: string }> = [
  { label: 'Ollama local', kind: 'ollama', baseUrl: 'http://localhost:11434', name: 'Ollama local' },
  { label: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1', name: 'OpenAI' },
  { label: 'OpenRouter', kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1', name: 'OpenRouter' },
  { label: 'Groq', kind: 'openai', baseUrl: 'https://api.groq.com/openai/v1', name: 'Groq' },
  { label: 'LM Studio', kind: 'openai', baseUrl: 'http://localhost:1234/v1', name: 'LM Studio' },
];

const form = reactive({
  name: props.provider?.name ?? '',
  kind: (props.provider?.kind ?? 'ollama') as ProviderKind,
  baseUrl: props.provider?.baseUrl ?? 'http://localhost:11434',
  apiKey: '',
  defaultModel: props.provider?.defaultModel ?? '',
  enabled: props.provider?.enabled ?? true,
});
/** Al editar: quitar la clave guardada al guardar. */
const removeKey = ref(false);
const hasSavedKey = computed(() => Boolean(props.provider?.hasApiKey) && !removeKey.value);

const saving = ref(false);
const testing = ref(false);
const testResult = ref<ProviderTestResult | null>(null);
const models = ref<ModelInfo[]>([]);
const fieldErrors = ref<Record<string, string>>({});
const formError = ref<string | null>(null);

function applyPreset(p: (typeof PRESETS)[number]): void {
  form.kind = p.kind;
  form.baseUrl = p.baseUrl;
  if (!form.name.trim() || PRESETS.some((x) => x.name === form.name)) form.name = p.name;
  testResult.value = null;
  models.value = [];
}

/** Cuerpo a enviar. `apiKey` se omite si no se ha tocado (el servidor conserva la guardada). */
function payload(): ProviderInput {
  const input: ProviderInput = {
    name: form.name.trim(),
    kind: form.kind,
    baseUrl: form.baseUrl.trim(),
    defaultModel: form.defaultModel.trim(),
    enabled: form.enabled,
  };
  if (form.apiKey) input.apiKey = form.apiKey;
  else if (removeKey.value) input.apiKey = null;
  return input;
}

function captureErrors(err: unknown): void {
  fieldErrors.value = {};
  if (err instanceof ApiError && err.issues.length) {
    for (const issue of err.issues) fieldErrors.value[issue.path] ??= issue.message;
    formError.value = null;
  } else formError.value = errorText(err);
}

async function test(): Promise<void> {
  testing.value = true;
  testResult.value = null;
  formError.value = null;
  try {
    testResult.value = await api.providers.testConfig({ ...payload(), id: props.provider?.id });
    fieldErrors.value = {};
    // La lista de modelos se pide para la configuración del formulario, esté o no guardada.
    models.value = testResult.value.ok ? await api.providers.modelsOf({ ...payload(), id: props.provider?.id }).catch(() => []) : [];
  } catch (err) {
    captureErrors(err);
  } finally {
    testing.value = false;
  }
}

async function save(): Promise<void> {
  saving.value = true;
  formError.value = null;
  try {
    const saved = props.provider ? await api.providers.update(props.provider.id, payload()) : await api.providers.create(payload());
    catalog.setProvider(saved);
    void catalog.refreshHealth(true);
    ui.success(props.provider ? `Proveedor «${saved.name}» actualizado.` : `Proveedor «${saved.name}» añadido.`);
    emit('saved', saved);
  } catch (err) {
    captureErrors(err);
  } finally {
    saving.value = false;
  }
}

const chatModels = computed(() => models.value.filter((m) => !m.capabilities || m.capabilities.includes('completion')));
</script>

<template>
  <AppModal :title="editing ? 'Editar proveedor' : 'Añadir proveedor'" :width="600" @close="emit('close')">
    <form id="provider-form" class="col" style="gap: 16px" @submit.prevent="save">
      <div class="col" style="gap: 6px">
        <span class="label">Plantillas</span>
        <div class="row wrap">
          <button v-for="p in PRESETS" :key="p.label" type="button" class="btn btn-sm" @click="applyPreset(p)">{{ p.label }}</button>
        </div>
      </div>

      <div class="form-grid">
        <div class="field">
          <label for="prv-name">Nombre</label>
          <input id="prv-name" v-model="form.name" class="input" maxlength="80" required :aria-invalid="Boolean(fieldErrors.name)" placeholder="Ollama local" />
          <span v-if="fieldErrors.name" class="error">{{ fieldErrors.name }}</span>
        </div>
        <div class="field">
          <label for="prv-kind">Tipo</label>
          <select id="prv-kind" v-model="form.kind" class="select" :aria-invalid="Boolean(fieldErrors.kind)" @change="((testResult = null), (models = []))">
            <option value="ollama">Ollama (API nativa)</option>
            <option value="openai">Compatible con OpenAI</option>
          </select>
          <span class="hint">
            <template v-if="form.kind === 'ollama'"><Term id="ollama" /> ejecuta los modelos en tu propio equipo.</template>
            <template v-else>Cualquier servicio <Term id="openai-compatible">compatible con OpenAI</Term>.</template>
          </span>
        </div>

        <div class="field span-2">
          <label for="prv-url"><Term id="base-url">URL base</Term></label>
          <input
            id="prv-url"
            v-model="form.baseUrl"
            class="input mono"
            required
            inputmode="url"
            spellcheck="false"
            :aria-invalid="Boolean(fieldErrors.baseUrl)"
            :placeholder="form.kind === 'ollama' ? 'http://localhost:11434' : 'https://api.openai.com/v1'"
            @input="((testResult = null), (models = []))"
          />
          <span v-if="fieldErrors.baseUrl" class="error">{{ fieldErrors.baseUrl }}</span>
          <span v-else-if="form.kind === 'openai'" class="hint">Incluye el sufijo de versión (normalmente <code>/v1</code>).</span>
        </div>

        <div class="field span-2">
          <label for="prv-key"><Term id="api-key">API key</Term> <span class="faint" style="font-weight: 400">(opcional)</span></label>
          <div class="row">
            <input
              id="prv-key"
              v-model="form.apiKey"
              class="input mono grow"
              type="password"
              autocomplete="off"
              spellcheck="false"
              :aria-invalid="Boolean(fieldErrors.apiKey)"
              :placeholder="hasSavedKey ? '•••• guardada — escribe para cambiarla' : form.kind === 'ollama' ? 'No suele ser necesaria' : 'sk-…'"
              @input="((removeKey = false), (testResult = null), (models = []))"
            />
            <button v-if="hasSavedKey && !form.apiKey" type="button" class="btn btn-danger" @click="removeKey = true">Quitar clave</button>
          </div>
          <span v-if="fieldErrors.apiKey" class="error">{{ fieldErrors.apiKey }}</span>
          <span v-else-if="removeKey && !form.apiKey" class="hint">
            La clave guardada se eliminará al guardar.
            <button type="button" class="linkish" @click="removeKey = false">Deshacer</button>
          </span>
          <span v-else class="hint row" style="gap: 5px"><KeyRound style="width: 12px; height: 12px" /> Se guarda cifrada y no se vuelve a mostrar.</span>
        </div>

        <div class="field span-2">
          <label for="prv-model"><Term id="modelo">Modelo</Term> por defecto <span class="faint" style="font-weight: 400">(opcional)</span></label>
          <input
            id="prv-model"
            v-model="form.defaultModel"
            class="input mono"
            list="prv-models"
            spellcheck="false"
            :aria-invalid="Boolean(fieldErrors.defaultModel)"
            placeholder="qwen3:8b"
          />
          <datalist id="prv-models">
            <option v-for="m in chatModels" :key="m.id" :value="m.id">{{ m.parameterSize ?? '' }}</option>
          </datalist>
          <span v-if="fieldErrors.defaultModel" class="error">{{ fieldErrors.defaultModel }}</span>
          <span v-else-if="chatModels.length" class="hint">{{ plural(chatModels.length, 'modelo disponible', 'modelos disponibles') }}: elige uno de la lista o escríbelo.</span>
          <span v-else class="hint">Se propone al crear agentes con este proveedor. Pulsa «Probar» para cargar la lista de modelos.</span>
        </div>

        <label class="check span-2">
          <input v-model="form.enabled" type="checkbox" />
          <span>
            <strong>Activado</strong>
            <span class="muted small" style="display: block">Los agentes de un proveedor desactivado no pueden ejecutarse.</span>
          </span>
        </label>
      </div>

      <div v-if="testing" class="callout" role="status"><LoaderCircle class="spin" /> Probando la conexión…</div>
      <div v-else-if="testResult?.ok" class="callout test-ok" role="status">
        <CircleCheck />
        <span>
          Conexión correcta: {{ plural(testResult.modelCount ?? 0, 'modelo', 'modelos') }} en {{ formatDuration(testResult.latencyMs) }}.
        </span>
      </div>
      <div v-else-if="testResult" class="callout danger" role="alert">
        <CircleAlert />
        <span>{{ testResult.error ?? 'No se pudo conectar.' }}</span>
      </div>
      <div v-if="formError" class="callout danger" role="alert"><CircleAlert /> <span>{{ formError }}</span></div>
    </form>

    <template #footer>
      <button type="button" class="btn" style="margin-right: auto" :disabled="testing || saving" @click="test">
        <LoaderCircle v-if="testing" class="spin" /><PlugZap v-else /> Probar
      </button>
      <button type="button" class="btn" @click="emit('close')">Cancelar</button>
      <button type="submit" form="provider-form" class="btn btn-primary" :disabled="saving">
        <LoaderCircle v-if="saving" class="spin" /> {{ editing ? 'Guardar cambios' : 'Añadir proveedor' }}
      </button>
    </template>
  </AppModal>
</template>

<style scoped>
.test-ok {
  background: var(--success-soft);
  border-color: transparent;
  color: var(--success);
}
.linkish {
  border: 0;
  background: none;
  padding: 0;
  font: inherit;
  color: var(--accent);
  cursor: pointer;
  text-decoration: underline;
}
</style>
