<script setup lang="ts">
// Servidores MCP: programas externos (o direcciones HTTP) que ofrecen herramientas a los agentes.
import type { McpServer, McpServerInput, McpStatus, McpTransport } from '@shared/types';
import { CircleAlert, LoaderCircle, Pencil, Plug, Plus, RefreshCw, ShieldAlert, Trash2 } from 'lucide-vue-next';
import { computed, onMounted, reactive, ref } from 'vue';
import { api, ApiError, errorText } from '@/lib/api';
import { serverText } from '@/lib/server-messages-en';
import { t, tn } from '@/i18n';
import { useUi } from '@/stores/ui';
import AppModal from './AppModal.vue';
import Term from './Term.vue';

const emit = defineEmits<{ changed: [] }>();
const ui = useUi();

const loading = ref(true);
const loadError = ref<string | null>(null);
const servers = ref<McpServer[]>([]);
const busy = ref<string | null>(null);

async function load(): Promise<void> {
  loadError.value = null;
  try {
    servers.value = await api.mcp.list();
  } catch (err) {
    loadError.value = errorText(err);
  } finally {
    loading.value = false;
  }
}
onMounted(load);
defineExpose({ load });

// Se guarda la clave del texto, no el texto: así el idioma puede cambiar sin recargar.
const STATUS: Record<McpStatus, { labelKey: string; tone: string }> = {
  connected: { labelKey: 'mcp.status.connected', tone: 'success' },
  connecting: { labelKey: 'mcp.status.connecting', tone: 'info' },
  error: { labelKey: 'mcp.status.error', tone: 'danger' },
  disabled: { labelKey: 'mcp.status.disabled', tone: '' },
};

async function reconnect(server: McpServer): Promise<void> {
  busy.value = `reconnect:${server.id}`;
  try {
    const updated = await api.mcp.reconnect(server.id);
    await load();
    emit('changed');
    if (updated.status === 'connected') ui.success(tn('mcp.toast.reconnected', updated.tools.length, { name: server.name }));
    else
      ui.error(
        t('mcp.toast.reconnectFailed', { name: server.name, error: updated.error ? serverText(updated.error, updated.errorI18n) : t('mcp.unknownError') }),
      );
  } catch (err) {
    ui.error(errorText(err));
  } finally {
    busy.value = null;
  }
}

async function remove(server: McpServer): Promise<void> {
  const ok = await ui.confirm({
    title: t('mcp.confirm.removeTitle'),
    message: t('mcp.confirm.removeMessage', { name: server.name }),
    confirmLabel: t('mcp.confirm.removeLabel'),
    danger: true,
  });
  if (!ok) return;
  busy.value = `remove:${server.id}`;
  try {
    await api.mcp.remove(server.id);
    await load();
    emit('changed');
    ui.success(t('mcp.toast.removed', { name: server.name }));
  } catch (err) {
    ui.error(errorText(err));
  } finally {
    busy.value = null;
  }
}

// ---------- Formulario ----------
const editing = ref<McpServer | 'new' | null>(null);
const saving = ref(false);
const fieldErrors = ref<Record<string, string>>({});
const formError = ref<string | null>(null);
const form = reactive({
  name: '',
  transport: 'stdio' as McpTransport,
  command: '',
  args: '',
  env: '',
  url: '',
  headers: '',
  /** Al editar: si no se marca, se conservan las variables o cabeceras guardadas. */
  replaceSecrets: true,
  enabled: true,
});
const current = computed(() => (editing.value && editing.value !== 'new' ? editing.value : null));
const savedSecrets = computed(() => (form.transport === 'stdio' ? (current.value?.envKeys ?? []) : (current.value?.headerKeys ?? [])));

function openForm(server: McpServer | null): void {
  fieldErrors.value = {};
  formError.value = null;
  Object.assign(form, { name: '', transport: 'stdio', command: '', args: '', env: '', url: '', headers: '', replaceSecrets: true, enabled: true });
  if (server) {
    Object.assign(form, {
      name: server.name,
      transport: server.transport,
      command: server.command,
      args: server.args.join('\n'),
      url: server.url,
      enabled: server.enabled,
    });
    form.replaceSecrets = !(server.transport === 'stdio' ? server.envKeys.length : server.headerKeys.length);
  }
  editing.value = server ?? 'new';
}

/** Interpreta «CLAVE=valor» (o «Cabecera: valor») por línea. Devuelve el mapa o el texto de la línea que no se entiende. */
function parsePairs(text: string, separator: '=' | ':'): Record<string, string> | string {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const at = line.indexOf(separator);
    if (at < 1) return line;
    out[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return out;
}

async function save(): Promise<void> {
  if (saving.value || !editing.value) return;
  fieldErrors.value = {};
  formError.value = null;
  const isStdio = form.transport === 'stdio';
  const payload: McpServerInput = {
    name: form.name.trim(),
    transport: form.transport,
    command: isStdio ? form.command.trim() : '',
    args: isStdio
      ? form.args
          .split('\n')
          .map((a) => a.trim())
          .filter(Boolean)
      : [],
    url: isStdio ? '' : form.url.trim(),
    enabled: form.enabled,
  };
  if (form.replaceSecrets || !current.value) {
    const pairs = parsePairs(isStdio ? form.env : form.headers, isStdio ? '=' : ':');
    if (typeof pairs === 'string') {
      fieldErrors.value = { [isStdio ? 'env' : 'headers']: t(isStdio ? 'mcp.form.badEnv' : 'mcp.form.badHeader', { line: pairs }) };
      return;
    }
    if (isStdio) payload.env = pairs;
    else payload.headers = pairs;
  }
  saving.value = true;
  try {
    const saved = current.value ? await api.mcp.update(current.value.id, payload) : await api.mcp.create(payload);
    editing.value = null;
    await load();
    emit('changed');
    if (saved.status === 'connected') ui.success(tn('mcp.toast.connected', saved.tools.length, { name: saved.name }));
    else if (saved.status === 'disabled') ui.success(t('mcp.toast.savedDisabled', { name: saved.name }));
    else ui.error(t('mcp.toast.savedFailed', { name: saved.name, error: saved.error ? serverText(saved.error, saved.errorI18n) : t('mcp.unknownError') }));
  } catch (err) {
    if (err instanceof ApiError && err.issues.length) fieldErrors.value = Object.fromEntries(err.issues.map((i) => [i.path, i.message]));
    else formError.value = errorText(err);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <section class="col" style="gap: 16px" :aria-label="t('mcp.sectionLabel')">
    <div class="row wrap intro">
      <i18n-t keypath="mcp.intro" tag="p" class="muted small grow" style="margin: 0; min-width: 240px" scope="global">
        <template #mcp><Term id="mcp">MCP</Term></template>
        <template #tools
          ><Term id="herramienta">{{ t('mcp.introTools') }}</Term></template
        >
        <template #pattern
          ><code>{{ t('mcp.introPattern') }}</code></template
        >
      </i18n-t>
      <button class="btn btn-primary" type="button" :disabled="loading || !!loadError" @click="openForm(null)"><Plus /> {{ t('mcp.add') }}</button>
    </div>

    <div v-if="loading" class="skeleton" style="height: 120px; border-radius: var(--radius-lg)" />
    <div v-else-if="loadError" class="card empty">
      <CircleAlert />
      <h3>{{ t('mcp.loadError') }}</h3>
      <p>{{ loadError }}</p>
      <button class="btn" type="button" @click="load"><RefreshCw /> {{ t('common.actions.retry') }}</button>
    </div>
    <div v-else-if="!servers.length" class="card empty">
      <Plug />
      <h3>{{ t('mcp.empty.title') }}</h3>
      <p>{{ t('mcp.empty.text') }}</p>
      <button class="btn btn-primary" type="button" @click="openForm(null)"><Plus /> {{ t('mcp.add') }}</button>
    </div>

    <ul v-else class="servers" :aria-label="t('mcp.listLabel')">
      <li v-for="s in servers" :key="s.id" class="card server">
        <header class="row wrap" style="gap: 8px">
          <strong class="mono">{{ s.name }}</strong>
          <span class="badge">{{ s.transport === 'stdio' ? t('mcp.transport.local') : t('mcp.transport.http') }}</span>
          <span class="badge" :class="STATUS[s.status].tone">{{ t(STATUS[s.status].labelKey) }}</span>
          <span class="grow" />
          <button class="btn btn-sm" type="button" :disabled="!!busy || !s.enabled" :title="t('mcp.reconnectTitle')" @click="reconnect(s)">
            <LoaderCircle v-if="busy === `reconnect:${s.id}`" class="spin" /><RefreshCw v-else /> {{ t('mcp.reconnect') }}
          </button>
          <button class="btn btn-sm" type="button" :disabled="!!busy" @click="openForm(s)"><Pencil /> {{ t('common.actions.edit') }}</button>
          <button
            class="btn btn-ghost btn-icon btn-sm btn-danger"
            type="button"
            :disabled="!!busy"
            :aria-label="t('mcp.deleteAria', { name: s.name })"
            :title="t('common.actions.delete')"
            @click="remove(s)"
          >
            <Trash2 />
          </button>
        </header>
        <code class="mono small target">{{ s.transport === 'stdio' ? [s.command, ...s.args].join(' ') : s.url }}</code>
        <p v-if="s.error" class="error-line small" role="alert"><CircleAlert /> {{ serverText(s.error, s.errorI18n) }}</p>
        <p v-if="s.tools.length" class="small muted" style="margin: 0">
          {{ tn('mcp.toolsCount', s.tools.length) }}:
          <span class="tool-names">{{ s.tools.map((tl) => tl.name).join(', ') }}</span>
        </p>
        <p v-else-if="s.status === 'connected'" class="small muted" style="margin: 0">{{ t('mcp.noTools') }}</p>
      </li>
    </ul>

    <AppModal
      v-if="editing"
      :title="current ? t('mcp.form.titleEdit', { name: current.name }) : t('mcp.form.titleNew')"
      :width="600"
      confirm-close
      @close="editing = null"
    >
      <form id="mcp-form" class="col" style="gap: 16px" novalidate @submit.prevent="save">
        <div class="field">
          <label for="mcp-name">{{ t('mcp.form.name') }}</label>
          <input
            id="mcp-name"
            v-model="form.name"
            class="input mono"
            type="text"
            maxlength="20"
            spellcheck="false"
            autocomplete="off"
            :placeholder="t('mcp.form.namePlaceholder')"
            :aria-invalid="!!fieldErrors.name"
          />
          <span v-if="fieldErrors.name" class="error" role="alert">{{ fieldErrors.name }}</span>
          <span v-else class="hint">{{ t('mcp.form.nameHint') }}</span>
        </div>

        <div class="field">
          <span class="label">{{ t('mcp.form.connection') }}</span>
          <div class="segmented" role="radiogroup" :aria-label="t('mcp.form.connectionType')">
            <button
              type="button"
              role="radio"
              :aria-checked="form.transport === 'stdio'"
              :class="{ active: form.transport === 'stdio' }"
              @click="form.transport = 'stdio'"
            >
              {{ t('mcp.form.stdio') }}
            </button>
            <button
              type="button"
              role="radio"
              :aria-checked="form.transport === 'http'"
              :class="{ active: form.transport === 'http' }"
              @click="form.transport = 'http'"
            >
              {{ t('mcp.form.http') }}
            </button>
          </div>
        </div>

        <template v-if="form.transport === 'stdio'">
          <div class="callout warning small">
            <ShieldAlert />
            <span>{{ t('mcp.form.stdioWarning') }}</span>
          </div>
          <div class="field">
            <label for="mcp-command">{{ t('mcp.form.command') }}</label>
            <input
              id="mcp-command"
              v-model="form.command"
              class="input mono"
              type="text"
              spellcheck="false"
              autocomplete="off"
              placeholder="npx"
              :aria-invalid="!!fieldErrors.command"
            />
            <span v-if="fieldErrors.command" class="error" role="alert">{{ fieldErrors.command }}</span>
          </div>
          <div class="field">
            <i18n-t keypath="mcp.form.argsLabel" tag="label" for="mcp-args" scope="global">
              <template #hint
                ><span class="muted">{{ t('mcp.form.argsHint') }}</span></template
              >
            </i18n-t>
            <textarea
              id="mcp-args"
              v-model="form.args"
              class="textarea mono"
              rows="3"
              spellcheck="false"
              placeholder="-y&#10;@modelcontextprotocol/server-filesystem&#10;C:\datos"
            />
          </div>
        </template>
        <div v-else class="field">
          <i18n-t keypath="mcp.form.urlLabel" tag="label" for="mcp-url" scope="global">
            <template #url><Term id="url">URL</Term></template>
          </i18n-t>
          <input
            id="mcp-url"
            v-model="form.url"
            class="input mono"
            type="url"
            spellcheck="false"
            autocomplete="off"
            :placeholder="t('mcp.form.urlPlaceholder')"
            :aria-invalid="!!fieldErrors.url"
          />
          <span v-if="fieldErrors.url" class="error" role="alert">{{ fieldErrors.url }}</span>
        </div>

        <div class="field">
          <label for="mcp-secrets">
            <i18n-t v-if="form.transport === 'stdio'" keypath="mcp.form.envLabel" tag="span" scope="global">
              <template #hint
                ><span class="muted">{{ t('mcp.form.envHint') }}</span></template
              >
            </i18n-t>
            <i18n-t v-else keypath="mcp.form.headersLabel" tag="span" scope="global">
              <template #headers
                ><Term id="cabecera">{{ t('mcp.form.headersTerm') }}</Term></template
              >
              <template #hint
                ><span class="muted">{{ t('mcp.form.headersHint') }}</span></template
              >
            </i18n-t>
          </label>
          <label v-if="current && savedSecrets.length" class="check small">
            <input v-model="form.replaceSecrets" type="checkbox" />
            <span>{{ t('mcp.form.replaceSaved', { list: savedSecrets.join(', ') }) }}</span>
          </label>
          <textarea
            v-if="form.transport === 'stdio'"
            id="mcp-secrets"
            v-model="form.env"
            class="textarea mono"
            rows="3"
            spellcheck="false"
            :disabled="!form.replaceSecrets"
            placeholder="API_KEY=…"
            :aria-invalid="!!fieldErrors.env"
          />
          <textarea
            v-else
            id="mcp-secrets"
            v-model="form.headers"
            class="textarea mono"
            rows="3"
            spellcheck="false"
            :disabled="!form.replaceSecrets"
            placeholder="Authorization: Bearer …"
            :aria-invalid="!!fieldErrors.headers"
          />
          <span v-if="fieldErrors.env || fieldErrors.headers" class="error" role="alert">{{ fieldErrors.env || fieldErrors.headers }}</span>
          <i18n-t v-else keypath="mcp.form.secretsHint" tag="span" class="hint" scope="global">
            <template #encrypted
              ><Term id="cifrado">{{ t('mcp.form.encrypted') }}</Term></template
            >
          </i18n-t>
        </div>

        <label class="check">
          <input v-model="form.enabled" type="checkbox" class="switch" />
          <span>
            <strong>{{ t('mcp.form.enabled') }}</strong>
            <span class="muted small" style="display: block">{{ t('mcp.form.enabledHint') }}</span>
          </span>
        </label>

        <div v-if="formError" class="callout danger" role="alert">
          <CircleAlert /><span>{{ formError }}</span>
        </div>
      </form>
      <template #footer>
        <button class="btn" type="button" @click="editing = null">{{ t('common.actions.cancel') }}</button>
        <button class="btn btn-primary" type="submit" form="mcp-form" :disabled="saving">
          <LoaderCircle v-if="saving" class="spin" /> {{ saving ? t('mcp.form.connecting') : current ? t('mcp.form.saveConnect') : t('mcp.form.addConnect') }}
        </button>
      </template>
    </AppModal>
  </section>
</template>

<style scoped>
.intro {
  gap: 12px 16px;
  align-items: flex-start;
}
.servers {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.server {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px 16px;
}
.target,
.tool-names {
  overflow-wrap: anywhere;
}
.error-line {
  display: flex;
  gap: 6px;
  align-items: flex-start;
  margin: 0;
  color: var(--danger);
  overflow-wrap: anywhere;
}
.error-line svg {
  width: 14px;
  height: 14px;
  flex: none;
  margin-top: 2px;
}
</style>
