<script setup lang="ts">
// Banco de pruebas: genera un formulario a partir del esquema de la herramienta y la ejecuta de verdad.
import type { JsonSchemaProp, ToolInfo } from '@shared/types';
import { CircleAlert, CircleCheck, LoaderCircle, Play } from 'lucide-vue-next';
import { computed, reactive, ref } from 'vue';
import { t } from '@/i18n';
import { api, errorText, type ToolInvokeResult } from '@/lib/api';
import { formatDuration } from '@/lib/format';
import AppModal from './AppModal.vue';
import Term from './Term.vue';

const props = defineProps<{ tool: ToolInfo }>();
const emit = defineEmits<{ close: [] }>();

type Kind = 'text' | 'long' | 'number' | 'boolean' | 'enum' | 'json';
interface FieldDef {
  name: string;
  prop: JsonSchemaProp;
  required: boolean;
  kind: Kind;
}

const LONG_NAMES = new Set(['content', 'body', 'code', 'task', 'value']);

function kindOf(name: string, prop: JsonSchemaProp): Kind {
  if (prop.enum?.length) return 'enum';
  if (prop.type === 'boolean') return 'boolean';
  if (prop.type === 'number' || prop.type === 'integer') return 'number';
  if (prop.type === 'object' || prop.type === 'array') return 'json';
  return LONG_NAMES.has(name) ? 'long' : 'text';
}

const fields = computed<FieldDef[]>(() => {
  const required = new Set(props.tool.parameters.required ?? []);
  return Object.entries(props.tool.parameters.properties ?? {}).map(([name, prop]) => ({
    name,
    prop,
    required: required.has(name),
    kind: kindOf(name, prop),
  }));
});

// Los valores se guardan como texto (o booleano) y se convierten al tipo real al ejecutar.
const texts = reactive<Record<string, string>>({});
const flags = reactive<Record<string, boolean>>({});
for (const f of fields.value) {
  const def = f.prop.default;
  if (f.kind === 'boolean') flags[f.name] = def === true;
  else if (def === undefined || def === null) texts[f.name] = '';
  else texts[f.name] = typeof def === 'object' ? JSON.stringify(def, null, 2) : String(def);
}

const fieldErrors = reactive<Record<string, string>>({});
const running = ref(false);
const result = ref<ToolInvokeResult | null>(null);
const requestError = ref<string | null>(null);

/** Convierte el formulario en argumentos; devuelve null si hay errores de formato. */
function buildArgs(): Record<string, unknown> | null {
  for (const key of Object.keys(fieldErrors)) delete fieldErrors[key];
  const args: Record<string, unknown> = {};
  for (const f of fields.value) {
    if (f.kind === 'boolean') {
      args[f.name] = flags[f.name];
      continue;
    }
    const raw = texts[f.name] ?? '';
    if (raw.trim() === '') {
      // Los parámetros opcionales vacíos no se envían; los obligatorios los valida el servidor.
      if (f.required && f.kind !== 'text' && f.kind !== 'long') fieldErrors[f.name] = t('toolTest.errors.required');
      else if (f.required) args[f.name] = raw;
      continue;
    }
    if (f.kind === 'number') {
      const n = Number(raw.replace(',', '.'));
      if (!Number.isFinite(n)) fieldErrors[f.name] = t('toolTest.errors.notNumber');
      else if (f.prop.type === 'integer' && !Number.isInteger(n)) fieldErrors[f.name] = t('toolTest.errors.notInteger');
      else args[f.name] = n;
    } else if (f.kind === 'json') {
      try {
        const parsed: unknown = JSON.parse(raw);
        const isArray = Array.isArray(parsed);
        if (f.prop.type === 'array' ? !isArray : typeof parsed !== 'object' || parsed === null || isArray) {
          fieldErrors[f.name] = t(f.prop.type === 'array' ? 'toolTest.errors.notArray' : 'toolTest.errors.notObject');
        } else args[f.name] = parsed;
      } catch {
        fieldErrors[f.name] = t('toolTest.errors.invalidJson');
      }
    } else if (f.kind === 'enum') {
      const match = f.prop.enum!.find((v) => String(v) === raw);
      args[f.name] = match ?? raw;
    } else args[f.name] = raw;
  }
  return Object.keys(fieldErrors).length ? null : args;
}

async function run(): Promise<void> {
  const args = buildArgs();
  if (!args || running.value) return;
  running.value = true;
  requestError.value = null;
  result.value = null;
  try {
    result.value = await api.tools.invoke(props.tool.name, args);
  } catch (err) {
    requestError.value = errorText(err);
  } finally {
    running.value = false;
  }
}

// Se guardan las claves, no los textos: así el idioma puede cambiar sin recargar.
const TYPE_KEY: Record<JsonSchemaProp['type'], string> = {
  string: 'toolTest.type.string',
  number: 'toolTest.type.number',
  integer: 'toolTest.type.integer',
  boolean: 'toolTest.type.boolean',
  object: 'toolTest.type.object',
  array: 'toolTest.type.array',
};
</script>

<template>
  <AppModal :title="t('toolTest.title', { title: tool.title })" :width="640" @close="emit('close')">
    <form class="col" style="gap: 14px" @submit.prevent="run">
      <i18n-t keypath="toolTest.intro" tag="p" class="muted small" scope="global">
        <template #tool
          ><Term id="herramienta">{{ t('toolTest.introTool') }}</Term></template
        >
        <template #name
          ><code>{{ tool.name }}</code></template
        >
      </i18n-t>

      <p v-if="!fields.length" class="faint small">{{ t('toolTest.noParams') }}</p>

      <div v-for="f in fields" :key="f.name" class="field">
        <label v-if="f.kind !== 'boolean'" :for="`tt-${f.name}`">
          <code>{{ f.name }}</code>
          <span class="faint tiny">{{ t(TYPE_KEY[f.prop.type] ?? 'toolTest.type.other') }}{{ f.required ? ` · ${t('toolTest.required')}` : '' }}</span>
        </label>

        <label v-if="f.kind === 'boolean'" class="check">
          <input :id="`tt-${f.name}`" v-model="flags[f.name]" type="checkbox" />
          <span>
            <code>{{ f.name }}</code>
            <span v-if="f.prop.description" class="hint" style="display: block">{{ f.prop.description }}</span>
          </span>
        </label>
        <select v-else-if="f.kind === 'enum'" :id="`tt-${f.name}`" v-model="texts[f.name]" class="select" :aria-invalid="!!fieldErrors[f.name]">
          <option v-if="!f.required || f.prop.default === undefined" value="">{{ f.required ? t('toolTest.select') : t('toolTest.useDefault') }}</option>
          <option v-for="opt in f.prop.enum" :key="String(opt)" :value="String(opt)">{{ opt }}</option>
        </select>
        <input
          v-else-if="f.kind === 'number'"
          :id="`tt-${f.name}`"
          v-model="texts[f.name]"
          class="input"
          type="text"
          inputmode="decimal"
          autocomplete="off"
          :aria-invalid="!!fieldErrors[f.name]"
        />
        <textarea
          v-else-if="f.kind === 'long' || f.kind === 'json'"
          :id="`tt-${f.name}`"
          v-model="texts[f.name]"
          class="textarea"
          :class="{ mono: f.kind === 'json' || f.name === 'code' }"
          :rows="f.kind === 'json' ? 3 : 4"
          :placeholder="f.kind === 'json' ? (f.prop.type === 'array' ? '[ ]' : '{ }') : ''"
          spellcheck="false"
          :aria-invalid="!!fieldErrors[f.name]"
        />
        <input v-else :id="`tt-${f.name}`" v-model="texts[f.name]" class="input" type="text" autocomplete="off" :aria-invalid="!!fieldErrors[f.name]" />

        <span v-if="f.kind !== 'boolean' && f.prop.description" class="hint">{{ f.prop.description }}</span>
        <span v-if="fieldErrors[f.name]" class="error" role="alert">{{ fieldErrors[f.name] }}</span>
      </div>

      <div v-if="requestError" class="callout danger" role="alert">
        <CircleAlert /><span>{{ requestError }}</span>
      </div>

      <section v-if="result" class="col" style="gap: 6px" aria-live="polite">
        <div class="row between wrap">
          <span class="badge" :class="result.ok ? 'success' : 'danger'">
            <component :is="result.ok ? CircleCheck : CircleAlert" />
            {{ result.ok ? t('toolTest.result.ok') : t('toolTest.result.failed') }}
          </span>
          <span class="tiny faint num">{{ formatDuration(result.durationMs) }}</span>
        </div>
        <pre class="codeblock" :class="{ bad: !result.ok }">{{ result.ok ? result.result || t('toolTest.result.empty') : result.error }}</pre>
      </section>
    </form>

    <template #footer>
      <button class="btn" type="button" @click="emit('close')">{{ t('common.actions.close') }}</button>
      <button class="btn btn-primary" type="button" :disabled="running" @click="run">
        <LoaderCircle v-if="running" class="spin" /><Play v-else />
        {{ running ? t('toolTest.running') : t('common.actions.run') }}
      </button>
    </template>
  </AppModal>
</template>

<style scoped>
.codeblock.bad {
  color: var(--danger);
}
</style>
