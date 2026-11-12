<script setup lang="ts">
// Alta y edición de herramientas HTTP personalizadas.
import { extractRefs } from '@shared/template';
import { isSecretHeaderName, type CustomToolInput, type HttpMethod, type JsonSchemaProp } from '@shared/types';
import { CircleAlert, LoaderCircle, Plus, Trash2 } from 'lucide-vue-next';
import { computed, onMounted, reactive, ref } from 'vue';
import { t } from '@/i18n';
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
  /** Valores permitidos (`enum`), separados por comas. Vacío = cualquier valor. */
  enumText: string;
  /** Valor por defecto tal como lo escribe el usuario. Vacío = sin valor por defecto. */
  defaultText: string;
  /** Propiedades del esquema que este editor no muestra (p. ej. `items`) y que se conservan al guardar. */
  extra: Partial<JsonSchemaProp>;
}
interface HeaderRow {
  key: number;
  name: string;
  value: string;
  /** Tiene un valor secreto guardado (no se muestra; vacío = conservarlo). */
  saved: boolean;
}

const NAME_RE = /^[a-z][a-z0-9_]{1,48}$/;
const PARAM_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
// Se guardan las claves, no los textos: así el idioma puede cambiar sin recargar.
const TYPES: Array<{ value: JsonSchemaProp['type']; labelKey: string }> = [
  { value: 'string', labelKey: 'toolEditor.type.string' },
  { value: 'number', labelKey: 'toolEditor.type.number' },
  { value: 'integer', labelKey: 'toolEditor.type.integer' },
  { value: 'boolean', labelKey: 'toolEditor.type.boolean' },
  { value: 'object', labelKey: 'toolEditor.type.object' },
  { value: 'array', labelKey: 'toolEditor.type.array' },
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
    form.headers = Object.entries(tool.headers ?? {}).map(([name, value]) => ({
      key: nextKey++,
      name,
      value,
      saved: (tool.secretHeaders ?? []).includes(name),
    }));
    const required = new Set(tool.parameters.required ?? []);
    form.params = Object.entries(tool.parameters.properties ?? {}).map(([name, p]) => {
      const { type, description, enum: values, default: def, ...extra } = p;
      return {
        key: nextKey++,
        name,
        type,
        description: description ?? '',
        required: required.has(name),
        enumText: (values ?? []).join(', '),
        defaultText: def === undefined || def === null ? '' : typeof def === 'object' ? JSON.stringify(def) : String(def),
        extra,
      };
    });
  } catch (err) {
    loadError.value = errorText(err);
  } finally {
    loading.value = false;
  }
});

const addParam = () =>
  form.params.push({ key: nextKey++, name: '', type: 'string', description: '', required: true, enumText: '', defaultText: '', extra: {} });

// ---------- Valores permitidos y valor por defecto ----------
const isNumeric = (type: JsonSchemaProp['type']) => type === 'number' || type === 'integer';
const supportsEnum = (type: JsonSchemaProp['type']) => type === 'string' || isNumeric(type);

/** Interpreta un texto como valor del tipo indicado; lanza un mensaje legible si no encaja. */
function parseValue(type: JsonSchemaProp['type'], text: string): unknown {
  const raw = text.trim();
  if (type === 'string') return raw;
  if (isNumeric(type)) {
    const n = Number(raw.replace(',', '.'));
    if (raw === '' || !Number.isFinite(n)) throw new Error(t('toolEditor.errors.notNumber', { raw }));
    if (type === 'integer' && !Number.isInteger(n)) throw new Error(t('toolEditor.errors.notInteger', { raw }));
    return n;
  }
  if (type === 'boolean') {
    if (raw !== 'true' && raw !== 'false') throw new Error(t('toolEditor.errors.notBoolean'));
    return raw === 'true';
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(t('toolEditor.errors.invalidJson'));
  }
  const isArray = Array.isArray(parsed);
  if (type === 'array' ? !isArray : typeof parsed !== 'object' || parsed === null || isArray) {
    throw new Error(t(type === 'array' ? 'toolEditor.errors.notArray' : 'toolEditor.errors.notObject'));
  }
  return parsed;
}

interface Constraints {
  enum?: Array<string | number>;
  default?: unknown;
  enumError?: string;
  defaultError?: string;
}

/** `enum` y `default` de una fila, o el error que impide construirlos. */
function constraints(row: ParamRow): Constraints {
  const out: Constraints = {};
  if (supportsEnum(row.type) && row.enumText.trim()) {
    try {
      const values = row.enumText
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean)
        .map((v) => parseValue(row.type, v) as string | number);
      out.enum = [...new Set(values)];
    } catch (err) {
      out.enumError = t('toolEditor.errors.allowedValues', { message: (err as Error).message });
    }
  }
  if (row.defaultText.trim()) {
    try {
      out.default = parseValue(row.type, row.defaultText);
      if (out.enum && !out.enum.includes(out.default as string | number)) out.defaultError = t('toolEditor.errors.defaultNotAllowed');
    } catch (err) {
      out.defaultError = t('toolEditor.errors.defaultValue', { message: (err as Error).message });
    }
  }
  return out;
}
const addHeader = () => form.headers.push({ key: nextKey++, name: '', value: '', saved: false });

// ---------- Validación en vivo ----------
const nameError = computed(() => {
  if (!form.name) return submitted.value ? t('toolEditor.name.required') : '';
  return NAME_RE.test(form.name) ? '' : t('toolEditor.name.invalid');
});
const descriptionError = computed(() => (submitted.value && form.description.trim().length < 5 ? t('toolEditor.description.required') : ''));
const urlError = computed(() => {
  const url = form.urlTemplate.trim();
  if (!url) return submitted.value ? t('toolEditor.request.urlRequired') : '';
  return /^https?:\/\//i.test(url) ? '' : t('toolEditor.request.urlInvalid');
});
function paramError(row: ParamRow): string {
  if (!row.name) return submitted.value ? t('toolEditor.params.missingName') : '';
  if (!PARAM_RE.test(row.name)) return t('toolEditor.params.invalidName');
  if (form.params.some((p) => p !== row && p.name === row.name)) return t('toolEditor.params.duplicateName');
  const c = constraints(row);
  return c.enumError ?? c.defaultError ?? '';
}
/** Huecos {{x}} usados en las plantillas que no corresponden a ningún parámetro declarado. */
const undeclared = computed(() => {
  const declared = new Set(form.params.map((p) => p.name));
  const sources = [form.urlTemplate, ...form.headers.map((h) => h.value), hasBody.value ? form.bodyTemplate : ''];
  return [...new Set(sources.flatMap(extractRefs))].filter((ref) => !declared.has(ref));
});
const issueFor = (path: string) => serverIssues.value.find((i) => i.path === path)?.message ?? '';
const valid = computed(() => !nameError.value && !descriptionError.value && !urlError.value && form.params.every((p) => !paramError(p)) && form.name !== '');

async function save(): Promise<void> {
  submitted.value = true;
  saveError.value = null;
  serverIssues.value = [];
  if (!valid.value || saving.value) return;
  const properties: Record<string, JsonSchemaProp> = {};
  for (const p of form.params) {
    const c = constraints(p);
    properties[p.name] = {
      ...p.extra,
      type: p.type,
      ...(p.description.trim() ? { description: p.description.trim() } : {}),
      ...(c.enum?.length ? { enum: c.enum } : {}),
      ...(c.default !== undefined ? { default: c.default } : {}),
    };
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
  <AppModal :title="customId ? t('toolEditor.titleEdit') : t('toolEditor.titleNew')" :width="720" confirm-close @close="emit('close')">
    <div v-if="loading" class="col">
      <div class="skeleton" style="height: 34px" />
      <div class="skeleton" style="height: 84px" />
      <div class="skeleton" style="height: 34px" />
    </div>
    <div v-else-if="loadError" class="callout danger" role="alert">
      <CircleAlert /><span>{{ loadError }}</span>
    </div>

    <form v-else id="tool-form" class="col" style="gap: 18px" novalidate @submit.prevent="save">
      <i18n-t keypath="toolEditor.intro" tag="p" class="muted small" scope="global">
        <template #http><Term id="http">HTTP</Term></template>
        <template #template
          ><Term id="plantilla">{{ t('toolEditor.introTemplate') }}</Term></template
        >
        <template #example
          ><code>{{ t('toolEditor.introExample') }}</code></template
        >
      </i18n-t>

      <div class="form-grid">
        <div class="field">
          <label for="te-name">{{ t('toolEditor.name.label') }}</label>
          <input
            id="te-name"
            v-model.trim="form.name"
            class="input mono"
            type="text"
            :placeholder="t('toolEditor.name.placeholder')"
            autocomplete="off"
            spellcheck="false"
            :aria-invalid="!!(nameError || issueFor('name'))"
          />
          <span v-if="nameError || issueFor('name')" class="error" role="alert">{{ nameError || issueFor('name') }}</span>
          <i18n-t v-else keypath="toolEditor.name.hint" tag="span" class="hint" scope="global">
            <template #model
              ><Term id="modelo">{{ t('toolEditor.name.hintModel') }}</Term></template
            >
          </i18n-t>
        </div>
        <div class="field">
          <span class="label">{{ t('toolEditor.status.label') }}</span>
          <label class="row" style="min-height: 34px; cursor: pointer">
            <input v-model="form.enabled" class="switch" type="checkbox" />
            <span>{{ form.enabled ? t('toolEditor.status.on') : t('toolEditor.status.off') }}</span>
          </label>
        </div>
        <div class="field span-2">
          <label for="te-desc">{{ t('toolEditor.description.label') }}</label>
          <textarea
            id="te-desc"
            v-model="form.description"
            class="textarea"
            rows="2"
            style="min-height: 58px"
            :placeholder="t('toolEditor.description.placeholder')"
            :aria-invalid="!!(descriptionError || issueFor('description'))"
          />
          <span v-if="descriptionError || issueFor('description')" class="error" role="alert">{{ descriptionError || issueFor('description') }}</span>
          <span v-else class="hint">{{ t('toolEditor.description.hint') }}</span>
        </div>
      </div>

      <fieldset class="group">
        <legend>{{ t('toolEditor.request.legend') }}</legend>
        <div class="request">
          <div class="field">
            <label for="te-method"
              ><Term id="metodo-http">{{ t('toolEditor.request.method') }}</Term></label
            >
            <select id="te-method" v-model="form.method" class="select">
              <option v-for="m in METHODS" :key="m" :value="m">{{ m }}</option>
            </select>
          </div>
          <div class="field">
            <label for="te-url"><Term id="url">URL</Term></label>
            <input
              id="te-url"
              v-model="form.urlTemplate"
              class="input mono"
              type="text"
              :placeholder="t('toolEditor.request.urlPlaceholder')"
              autocomplete="off"
              spellcheck="false"
              :aria-invalid="!!(urlError || issueFor('urlTemplate'))"
            />
          </div>
        </div>
        <span v-if="urlError || issueFor('urlTemplate')" class="error small" role="alert">{{ urlError || issueFor('urlTemplate') }}</span>
        <span v-else class="hint small faint">{{ t('toolEditor.request.urlHint') }}</span>

        <div class="col" style="gap: 6px">
          <div class="row between">
            <span class="label"
              ><Term id="cabecera">{{ t('toolEditor.headers.label') }}</Term></span
            >
            <button class="btn btn-ghost btn-sm" type="button" @click="addHeader"><Plus /> {{ t('toolEditor.headers.add') }}</button>
          </div>
          <p v-if="!form.headers.length" class="faint small">{{ t('toolEditor.headers.none') }}</p>
          <i18n-t v-else-if="form.headers.some((h) => isSecretHeaderName(h.name))" keypath="toolEditor.headers.secretHint" tag="p" class="hint" scope="global">
            <template #encrypted
              ><Term id="cifrado">{{ t('toolEditor.headers.encrypted') }}</Term></template
            >
          </i18n-t>
          <div v-for="(h, i) in form.headers" :key="h.key" class="header-row">
            <input
              v-model="h.name"
              class="input mono"
              type="text"
              placeholder="Authorization"
              :aria-label="t('toolEditor.headers.nameAria', { n: i + 1 })"
              autocomplete="off"
            />
            <input
              v-model="h.value"
              class="input mono"
              type="text"
              :placeholder="h.saved && isSecretHeaderName(h.name) ? t('toolEditor.headers.savedPlaceholder') : 'Bearer …'"
              :aria-label="t('toolEditor.headers.valueAria', { n: i + 1 })"
              autocomplete="off"
            />
            <button
              class="btn btn-ghost btn-icon"
              type="button"
              :aria-label="t('toolEditor.headers.removeAria', { n: i + 1 })"
              @click="form.headers.splice(i, 1)"
            >
              <Trash2 />
            </button>
          </div>
        </div>

        <div v-if="hasBody" class="field">
          <label for="te-body">{{ t('toolEditor.body.label') }}</label>
          <textarea
            id="te-body"
            v-model="form.bodyTemplate"
            class="textarea mono"
            rows="3"
            :placeholder="t('toolEditor.body.placeholder')"
            spellcheck="false"
          />
          <i18n-t keypath="toolEditor.body.hint" tag="span" class="hint" scope="global">
            <template #json><Term id="json">JSON</Term></template>
          </i18n-t>
        </div>
      </fieldset>

      <fieldset class="group">
        <legend>{{ t('toolEditor.params.legend') }}</legend>
        <i18n-t keypath="toolEditor.params.intro" tag="p" class="muted small" scope="global">
          <template #schema
            ><Term id="json-schema">{{ t('toolEditor.params.introSchema') }}</Term></template
          >
        </i18n-t>
        <p v-if="!form.params.length" class="faint small">{{ t('toolEditor.params.none') }}</p>
        <div v-for="(p, i) in form.params" :key="p.key" class="param-row">
          <div class="field">
            <label :for="`te-pn-${p.key}`" class="tiny">{{ t('toolEditor.params.name') }}</label>
            <input
              :id="`te-pn-${p.key}`"
              v-model.trim="p.name"
              class="input mono"
              type="text"
              :placeholder="t('toolEditor.params.namePlaceholder')"
              autocomplete="off"
              spellcheck="false"
              :aria-invalid="!!paramError(p)"
            />
          </div>
          <div class="field">
            <label :for="`te-pt-${p.key}`" class="tiny">{{ t('toolEditor.params.type') }}</label>
            <select :id="`te-pt-${p.key}`" v-model="p.type" class="select">
              <option v-for="ty in TYPES" :key="ty.value" :value="ty.value">{{ t(ty.labelKey) }}</option>
            </select>
          </div>
          <div class="field desc">
            <label :for="`te-pd-${p.key}`" class="tiny">{{ t('toolEditor.params.description') }}</label>
            <input
              :id="`te-pd-${p.key}`"
              v-model="p.description"
              class="input"
              type="text"
              :placeholder="t('toolEditor.params.descriptionPlaceholder')"
              autocomplete="off"
            />
          </div>
          <label class="check req"
            ><input v-model="p.required" type="checkbox" /><span class="small">{{ t('toolEditor.params.required') }}</span></label
          >
          <button
            class="btn btn-ghost btn-icon"
            type="button"
            :aria-label="t('toolEditor.params.removeAria', { name: p.name || i + 1 })"
            @click="form.params.splice(i, 1)"
          >
            <Trash2 />
          </button>
          <div class="field penum">
            <label :for="`te-pe-${p.key}`" class="tiny">{{ t('toolEditor.params.allowed') }}</label>
            <input
              :id="`te-pe-${p.key}`"
              v-model="p.enumText"
              class="input"
              type="text"
              autocomplete="off"
              spellcheck="false"
              :disabled="!supportsEnum(p.type)"
              :placeholder="supportsEnum(p.type) ? t('toolEditor.params.allowedPlaceholder') : t('toolEditor.params.allowedNotApplicable')"
              :aria-invalid="!!constraints(p).enumError"
            />
          </div>
          <div class="field pdef">
            <label :for="`te-pv-${p.key}`" class="tiny">{{ t('toolEditor.params.defaultValue') }}</label>
            <select v-if="p.type === 'boolean'" :id="`te-pv-${p.key}`" v-model="p.defaultText" class="select">
              <option value="">{{ t('toolEditor.params.noDefault') }}</option>
              <option value="true">{{ t('toolEditor.params.yes') }}</option>
              <option value="false">{{ t('toolEditor.params.no') }}</option>
            </select>
            <input
              v-else
              :id="`te-pv-${p.key}`"
              v-model="p.defaultText"
              class="input"
              :class="{ mono: p.type === 'object' || p.type === 'array' }"
              type="text"
              autocomplete="off"
              spellcheck="false"
              :placeholder="p.type === 'object' ? '{ }' : p.type === 'array' ? '[ ]' : t('toolEditor.params.noDefault')"
              :aria-invalid="!!constraints(p).defaultError"
            />
          </div>
          <span v-if="paramError(p)" class="error small perr" role="alert">{{ paramError(p) }}</span>
        </div>
        <div>
          <button class="btn btn-sm" type="button" @click="addParam"><Plus /> {{ t('toolEditor.params.add') }}</button>
        </div>
        <div v-if="undeclared.length" class="callout warning">
          <CircleAlert />
          <i18n-t keypath="toolEditor.params.undeclared" tag="span" scope="global">
            <template #list>
              <template v-for="(u, i) in undeclared" :key="u"><template v-if="i">, </template><code v-text="`{{${u}}}`" /></template>
            </template>
          </i18n-t>
        </div>
      </fieldset>

      <div v-if="saveError" class="callout danger" role="alert">
        <CircleAlert /><span>{{ saveError }}</span>
      </div>
    </form>

    <template #footer>
      <button class="btn" type="button" @click="emit('close')">{{ t('common.actions.cancel') }}</button>
      <button class="btn btn-primary" type="submit" form="tool-form" :disabled="saving || loading || !!loadError">
        <LoaderCircle v-if="saving" class="spin" />
        {{ customId ? t('toolEditor.footer.saveEdit') : t('toolEditor.footer.create') }}
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
.param-row .penum {
  grid-column: 1 / 3;
}
.param-row .pdef {
  grid-column: 3 / -1;
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
  .param-row .desc,
  .param-row .penum,
  .param-row .pdef {
    grid-column: 1 / -1;
  }
  .param-row .btn-icon {
    justify-self: end;
  }
}
</style>
