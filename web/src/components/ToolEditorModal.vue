<script setup lang="ts">
// Alta y edición de herramientas HTTP personalizadas.
import { extractRefs } from '@shared/template';
import type { CustomToolInput, HttpMethod, JsonSchemaProp } from '@shared/types';
import { CircleAlert, LoaderCircle, Plus, Trash2 } from 'lucide-vue-next';
import { computed, onMounted, reactive, ref } from 'vue';
import { api, ApiError, errorText } from '@/lib/api';
import AppModal from './AppModal.vue';
import Term from './Term.vue';

const props = defineProps<{ customId?: string }>();
const emit = defineEmits<{ close: []; saved: [name: string] }>();

interface ParamRow {
  key: number;
  name: string;
  type: JsonSchemaProp['type'];
  description: string;
  required: boolean;
  /** Propiedades del esquema que este editor no muestra (enum, default…) y que se conservan al guardar. */
  extra: Partial<JsonSchemaProp>;
}
interface HeaderRow {
  key: number;
  name: string;
  value: string;
}

const NAME_RE = /^[a-z][a-z0-9_]{1,48}$/;
const PARAM_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const TYPES: Array<{ value: JsonSchemaProp['type']; label: string }> = [
  { value: 'string', label: 'Texto' },
  { value: 'number', label: 'Número' },
  { value: 'integer', label: 'Entero' },
  { value: 'boolean', label: 'Sí/no' },
  { value: 'object', label: 'Objeto' },
  { value: 'array', label: 'Lista' },
];

let nextKey = 1;
const form = reactive({
  name: '',
  description: '',
  method: 'GET' as HttpMethod,
  urlTemplate: '',
  bodyTemplate: '',
  enabled: true,
  headers: [] as HeaderRow[],
  params: [] as ParamRow[],
});
const loading = ref(Boolean(props.customId));
const loadError = ref<string | null>(null);
const saving = ref(false);
const saveError = ref<string | null>(null);
const serverIssues = ref<Array<{ path: string; message: string }>>([]);
const submitted = ref(false);

const hasBody = computed(() => form.method !== 'GET' && form.method !== 'DELETE');

onMounted(async () => {
  if (!props.customId) return;
  try {
    const tool = await api.tools.getCustom(props.customId);
    form.name = tool.name;
    form.description = tool.description;
    form.method = tool.method;
    form.urlTemplate = tool.urlTemplate;
    form.bodyTemplate = tool.bodyTemplate;
    form.enabled = tool.enabled;
    form.headers = Object.entries(tool.headers ?? {}).map(([name, value]) => ({ key: nextKey++, name, value }));
    const required = new Set(tool.parameters.required ?? []);
    form.params = Object.entries(tool.parameters.properties ?? {}).map(([name, p]) => {
      const { type, description, ...extra } = p;
      return { key: nextKey++, name, type, description: description ?? '', required: required.has(name), extra };
    });
  } catch (err) {
    loadError.value = errorText(err);
  } finally {
    loading.value = false;
  }
});

const addParam = () => form.params.push({ key: nextKey++, name: '', type: 'string', description: '', required: true, extra: {} });
const addHeader = () => form.headers.push({ key: nextKey++, name: '', value: '' });

// ---------- Validación en vivo ----------
const nameError = computed(() => {
  if (!form.name) return submitted.value ? 'El nombre es obligatorio.' : '';
  return NAME_RE.test(form.name) ? '' : 'Usa minúsculas, números y guiones bajos (2-49 caracteres, empezando por letra).';
});
const descriptionError = computed(() =>
  submitted.value && form.description.trim().length < 5 ? 'Describe qué hace la herramienta: el modelo lo lee para decidir cuándo usarla.' : '',
);
const urlError = computed(() => {
  const url = form.urlTemplate.trim();
  if (!url) return submitted.value ? 'La URL es obligatoria.' : '';
  return /^https?:\/\//i.test(url) ? '' : 'Debe empezar por http:// o https://';
});
function paramError(row: ParamRow): string {
  if (!row.name) return submitted.value ? 'Falta el nombre.' : '';
  if (!PARAM_RE.test(row.name)) return 'Solo letras, números y _.';
  return form.params.some((p) => p !== row && p.name === row.name) ? 'Nombre repetido.' : '';
}
/** Huecos {{x}} usados en las plantillas que no corresponden a ningún parámetro declarado. */
const undeclared = computed(() => {
  const declared = new Set(form.params.map((p) => p.name));
  const sources = [form.urlTemplate, ...form.headers.map((h) => h.value), hasBody.value ? form.bodyTemplate : ''];
  return [...new Set(sources.flatMap(extractRefs))].filter((ref) => !declared.has(ref));
});
const issueFor = (path: string) => serverIssues.value.find((i) => i.path === path)?.message ?? '';
const valid = computed(
  () => !nameError.value && !descriptionError.value && !urlError.value && form.params.every((p) => !paramError(p)) && form.name !== '',
);

async function save(): Promise<void> {
  submitted.value = true;
  saveError.value = null;
  serverIssues.value = [];
  if (!valid.value || saving.value) return;
  const properties: Record<string, JsonSchemaProp> = {};
  for (const p of form.params) {
    properties[p.name] = { ...p.extra, type: p.type, ...(p.description.trim() ? { description: p.description.trim() } : {}) };
  }
  const headers: Record<string, string> = {};
  for (const h of form.headers) if (h.name.trim()) headers[h.name.trim()] = h.value;
  const input: CustomToolInput = {
    name: form.name,
    description: form.description.trim(),
    parameters: { type: 'object', properties, required: form.params.filter((p) => p.required).map((p) => p.name) },
    method: form.method,
    urlTemplate: form.urlTemplate.trim(),
    headers,
    bodyTemplate: hasBody.value ? form.bodyTemplate : '',
    enabled: form.enabled,
  };
  saving.value = true;
  try {
    const saved = props.customId ? await api.tools.updateCustom(props.customId, input) : await api.tools.createCustom(input);
    emit('saved', saved.name);
  } catch (err) {
    saveError.value = errorText(err);
    if (err instanceof ApiError) serverIssues.value = err.issues;
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <AppModal :title="customId ? 'Editar herramienta HTTP' : 'Nueva herramienta HTTP'" :width="720" @close="emit('close')">
    <div v-if="loading" class="col">
      <div class="skeleton" style="height: 34px" />
      <div class="skeleton" style="height: 84px" />
      <div class="skeleton" style="height: 34px" />
    </div>
    <div v-else-if="loadError" class="callout danger" role="alert"><CircleAlert /><span>{{ loadError }}</span></div>

    <form v-else class="col" style="gap: 18px" novalidate @submit.prevent="save">
      <p class="muted small">
        Conecta cualquier API <Term id="http">HTTP</Term> como herramienta. Al usarla, cada hueco de la
        <Term id="plantilla">plantilla</Term> (por ejemplo <code v-pre>{{ciudad}}</code>) se sustituye por el valor que decida el agente.
      </p>

      <div class="form-grid">
        <div class="field">
          <label for="te-name">Nombre</label>
          <input
            id="te-name"
            v-model.trim="form.name"
            class="input mono"
            type="text"
            placeholder="consultar_clima"
            autocomplete="off"
            spellcheck="false"
            :aria-invalid="!!(nameError || issueFor('name'))"
          />
          <span v-if="nameError || issueFor('name')" class="error" role="alert">{{ nameError || issueFor('name') }}</span>
          <span v-else class="hint">Identificador que verá el modelo. Sin espacios ni mayúsculas.</span>
        </div>
        <div class="field">
          <span class="label">Estado</span>
          <label class="row" style="min-height: 34px; cursor: pointer">
            <input v-model="form.enabled" class="switch" type="checkbox" />
            <span>{{ form.enabled ? 'Activada: los agentes pueden usarla' : 'Desactivada: no se ofrece a los agentes' }}</span>
          </label>
        </div>
        <div class="field span-2">
          <label for="te-desc">Descripción</label>
          <textarea
            id="te-desc"
            v-model="form.description"
            class="textarea"
            rows="2"
            style="min-height: 58px"
            placeholder="Consulta el tiempo actual de una ciudad. Úsala cuando pregunten por el clima."
            :aria-invalid="!!(descriptionError || issueFor('description'))"
          />
          <span v-if="descriptionError || issueFor('description')" class="error" role="alert">{{ descriptionError || issueFor('description') }}</span>
          <span v-else class="hint">El modelo decide cuándo llamar a la herramienta leyendo este texto.</span>
        </div>
      </div>

      <fieldset class="group">
        <legend>Petición</legend>
        <div class="request">
          <div class="field">
            <label for="te-method">Método</label>
            <select id="te-method" v-model="form.method" class="select">
              <option v-for="m in METHODS" :key="m" :value="m">{{ m }}</option>
            </select>
          </div>
          <div class="field">
            <label for="te-url">URL</label>
            <input
              id="te-url"
              v-model="form.urlTemplate"
              class="input mono"
              type="text"
              placeholder="https://api.ejemplo.com/clima?ciudad={{ciudad}}"
              autocomplete="off"
              spellcheck="false"
              :aria-invalid="!!(urlError || issueFor('urlTemplate'))"
            />
          </div>
        </div>
        <span v-if="urlError || issueFor('urlTemplate')" class="error small" role="alert">{{ urlError || issueFor('urlTemplate') }}</span>
        <span v-else class="hint small faint">Los valores insertados en la URL se codifican automáticamente.</span>

        <div class="col" style="gap: 6px">
          <div class="row between">
            <span class="label">Cabeceras</span>
            <button class="btn btn-ghost btn-sm" type="button" @click="addHeader"><Plus /> Añadir cabecera</button>
          </div>
          <p v-if="!form.headers.length" class="faint small">Sin cabeceras adicionales.</p>
          <div v-for="(h, i) in form.headers" :key="h.key" class="header-row">
            <input v-model="h.name" class="input mono" type="text" placeholder="Authorization" :aria-label="`Nombre de la cabecera ${i + 1}`" autocomplete="off" />
            <input v-model="h.value" class="input mono" type="text" placeholder="Bearer …" :aria-label="`Valor de la cabecera ${i + 1}`" autocomplete="off" />
            <button class="btn btn-ghost btn-icon" type="button" :aria-label="`Quitar la cabecera ${i + 1}`" @click="form.headers.splice(i, 1)"><Trash2 /></button>
          </div>
        </div>

        <div v-if="hasBody" class="field">
          <label for="te-body">Plantilla del cuerpo</label>
          <textarea id="te-body" v-model="form.bodyTemplate" class="textarea mono" rows="3" placeholder='{ "consulta": "{{texto}}" }' spellcheck="false" />
          <span class="hint">Si se deja vacía, se envían todos los parámetros como <Term id="json">JSON</Term>.</span>
        </div>
      </fieldset>

      <fieldset class="group">
        <legend>Parámetros</legend>
        <p class="muted small">
          Forman el <Term id="json-schema">esquema de parámetros</Term>: lo que el agente debe rellenar al llamar a la herramienta.
        </p>
        <p v-if="!form.params.length" class="faint small">Esta herramienta no recibe parámetros.</p>
        <div v-for="(p, i) in form.params" :key="p.key" class="param-row">
          <div class="field">
            <label :for="`te-pn-${p.key}`" class="tiny">Nombre</label>
            <input :id="`te-pn-${p.key}`" v-model.trim="p.name" class="input mono" type="text" placeholder="ciudad" autocomplete="off" spellcheck="false" :aria-invalid="!!paramError(p)" />
          </div>
          <div class="field">
            <label :for="`te-pt-${p.key}`" class="tiny">Tipo</label>
            <select :id="`te-pt-${p.key}`" v-model="p.type" class="select">
              <option v-for="t in TYPES" :key="t.value" :value="t.value">{{ t.label }}</option>
            </select>
          </div>
          <div class="field desc">
            <label :for="`te-pd-${p.key}`" class="tiny">Descripción</label>
            <input :id="`te-pd-${p.key}`" v-model="p.description" class="input" type="text" placeholder="Nombre de la ciudad" autocomplete="off" />
          </div>
          <label class="check req"><input v-model="p.required" type="checkbox" /><span class="small">Obligatorio</span></label>
          <button class="btn btn-ghost btn-icon" type="button" :aria-label="`Quitar el parámetro ${p.name || i + 1}`" @click="form.params.splice(i, 1)"><Trash2 /></button>
          <span v-if="paramError(p)" class="error small perr" role="alert">{{ paramError(p) }}</span>
        </div>
        <div><button class="btn btn-sm" type="button" @click="addParam"><Plus /> Añadir parámetro</button></div>
        <div v-if="undeclared.length" class="callout warning">
          <CircleAlert />
          <span>
            Las plantillas usan
            <template v-for="(u, i) in undeclared" :key="u"><template v-if="i">, </template><code v-text="`{{${u}}}`" /></template>
            pero no hay ningún parámetro con ese nombre: se sustituirá por un texto vacío.
          </span>
        </div>
      </fieldset>

      <div v-if="saveError" class="callout danger" role="alert"><CircleAlert /><span>{{ saveError }}</span></div>
    </form>

    <template #footer>
      <button class="btn" type="button" @click="emit('close')">Cancelar</button>
      <button class="btn btn-primary" type="button" :disabled="saving || loading || !!loadError" @click="save">
        <LoaderCircle v-if="saving" class="spin" />
        {{ customId ? 'Guardar cambios' : 'Crear herramienta' }}
      </button>
    </template>
  </AppModal>
</template>

<style scoped>
.group {
  margin: 0;
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}
.group legend {
  padding: 0 6px;
  font-size: 12.5px;
  font-weight: 650;
  color: var(--text-2);
}
.request {
  display: grid;
  grid-template-columns: 110px minmax(0, 1fr);
  gap: 10px;
}
.header-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr) 34px;
  gap: 8px;
}
.param-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 104px minmax(0, 1.5fr) auto 34px;
  gap: 8px;
  align-items: end;
  padding-bottom: 10px;
  border-bottom: 1px dashed var(--border);
}
.param-row .req {
  align-items: center;
  height: 34px;
}
.param-row .req input {
  margin-top: 0;
}
.perr {
  grid-column: 1 / -1;
}
@media (max-width: 640px) {
  .request {
    grid-template-columns: 1fr;
  }
  .param-row {
    grid-template-columns: minmax(0, 1fr) 104px;
  }
  .param-row .desc {
    grid-column: 1 / -1;
  }
  .param-row .btn-icon {
    justify-self: end;
  }
}
</style>
