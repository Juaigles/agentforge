<script setup lang="ts">
// Servidores MCP: programas externos (o direcciones HTTP) que ofrecen herramientas a los agentes.
import type { McpServer, McpServerInput, McpStatus, McpTransport } from '@shared/types';
import { CircleAlert, LoaderCircle, Pencil, Plug, Plus, RefreshCw, ShieldAlert, Trash2 } from 'lucide-vue-next';
import { computed, onMounted, reactive, ref } from 'vue';
import { api, ApiError, errorText } from '@/lib/api';
import { plural } from '@/lib/format';
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

const STATUS: Record<McpStatus, { label: string; tone: string }> = {
  connected: { label: 'Conectado', tone: 'success' },
  connecting: { label: 'Conectando…', tone: 'info' },
  error: { label: 'Sin conexión', tone: 'danger' },
  disabled: { label: 'Desactivado', tone: '' },
};

async function reconnect(server: McpServer): Promise<void> {
  busy.value = `reconnect:${server.id}`;
  try {
    const updated = await api.mcp.reconnect(server.id);
    await load();
    emit('changed');
    if (updated.status === 'connected') ui.success(`«${server.name}» conectado: ${plural(updated.tools.length, 'herramienta', 'herramientas')}.`);
    else ui.error(`No se pudo conectar con «${server.name}»: ${updated.error ?? 'error desconocido'}`);
  } catch (err) {
    ui.error(errorText(err));
  } finally {
    busy.value = null;
  }
}

async function remove(server: McpServer): Promise<void> {
  const ok = await ui.confirm({
    title: 'Eliminar servidor MCP',
    message: `Los agentes y workflows que usen las herramientas de «${server.name}» dejarán de poder usarlas.`,
    confirmLabel: 'Eliminar servidor',
    danger: true,
  });
  if (!ok) return;
  busy.value = `remove:${server.id}`;
  try {
    await api.mcp.remove(server.id);
    await load();
    emit('changed');
    ui.success(`Servidor «${server.name}» eliminado.`);
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
    Object.assign(form, { name: server.name, transport: server.transport, command: server.command, args: server.args.join('\n'), url: server.url, enabled: server.enabled });
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
    args: isStdio ? form.args.split('\n').map((a) => a.trim()).filter(Boolean) : [],
    url: isStdio ? '' : form.url.trim(),
    enabled: form.enabled,
  };
  if (form.replaceSecrets || !current.value) {
    const pairs = parsePairs(isStdio ? form.env : form.headers, isStdio ? '=' : ':');
    if (typeof pairs === 'string') {
      fieldErrors.value = { [isStdio ? 'env' : 'headers']: isStdio ? `«${pairs}» no tiene la forma NOMBRE=valor.` : `«${pairs}» no tiene la forma Cabecera: valor.` };
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
    if (saved.status === 'connected') ui.success(`Servidor «${saved.name}» conectado: ${plural(saved.tools.length, 'herramienta disponible', 'herramientas disponibles')}.`);
    else if (saved.status === 'disabled') ui.success(`Servidor «${saved.name}» guardado, pero desactivado.`);
    else ui.error(`Servidor «${saved.name}» guardado, pero no se pudo conectar: ${saved.error ?? 'error desconocido'}`);
  } catch (err) {
    if (err instanceof ApiError && err.issues.length) fieldErrors.value = Object.fromEntries(err.issues.map((i) => [i.path, i.message]));
    else formError.value = errorText(err);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <section class="col" style="gap: 16px" aria-label="Servidores MCP">
    <div class="row wrap intro">
      <p class="muted small grow" style="margin: 0; min-width: 240px">
        Un servidor <Term id="mcp">MCP</Term> es un programa que ofrece <Term id="herramienta">herramientas</Term> ya hechas (acceso a archivos, bases de datos,
        servicios…). Al conectarlo, sus herramientas aparecen en el catálogo con el nombre <code>servidor__herramienta</code> y se pueden asignar a los agentes.
      </p>
      <button class="btn btn-primary" type="button" :disabled="loading || !!loadError" @click="openForm(null)"><Plus /> Añadir servidor MCP</button>
    </div>

    <div v-if="loading" class="skeleton" style="height: 120px; border-radius: var(--radius-lg)" />
    <div v-else-if="loadError" class="card empty">
      <CircleAlert />
      <h3>No se pudieron cargar los servidores MCP</h3>
      <p>{{ loadError }}</p>
      <button class="btn" type="button" @click="load"><RefreshCw /> Reintentar</button>
    </div>
    <div v-else-if="!servers.length" class="card empty">
      <Plug />
      <h3>Todavía no hay servidores MCP</h3>
      <p>Añade uno para dar a tus agentes herramientas de terceros sin programarlas.</p>
      <button class="btn btn-primary" type="button" @click="openForm(null)"><Plus /> Añadir servidor MCP</button>
    </div>

    <ul v-else class="servers" aria-label="Servidores MCP configurados">
      <li v-for="s in servers" :key="s.id" class="card server">
        <header class="row wrap" style="gap: 8px">
          <strong class="mono">{{ s.name }}</strong>
          <span class="badge">{{ s.transport === 'stdio' ? 'programa local' : 'HTTP' }}</span>
          <span class="badge" :class="STATUS[s.status].tone">{{ STATUS[s.status].label }}</span>
          <span class="grow" />
          <button class="btn btn-sm" type="button" :disabled="!!busy || !s.enabled" title="Vuelve a conectar y a leer la lista de herramientas" @click="reconnect(s)">
            <LoaderCircle v-if="busy === `reconnect:${s.id}`" class="spin" /><RefreshCw v-else /> Reconectar
          </button>
          <button class="btn btn-sm" type="button" :disabled="!!busy" @click="openForm(s)"><Pencil /> Editar</button>
          <button class="btn btn-ghost btn-icon btn-sm btn-danger" type="button" :disabled="!!busy" :aria-label="`Eliminar el servidor ${s.name}`" title="Eliminar" @click="remove(s)"><Trash2 /></button>
        </header>
        <code class="mono small target">{{ s.transport === 'stdio' ? [s.command, ...s.args].join(' ') : s.url }}</code>
        <p v-if="s.error" class="error-line small" role="alert"><CircleAlert /> {{ s.error }}</p>
        <p v-if="s.tools.length" class="small muted" style="margin: 0">
          {{ plural(s.tools.length, 'herramienta', 'herramientas') }}:
          <span class="tool-names">{{ s.tools.map((t) => t.name).join(', ') }}</span>
        </p>
        <p v-else-if="s.status === 'connected'" class="small muted" style="margin: 0">Conectado, pero no ofrece ninguna herramienta.</p>
      </li>
    </ul>

    <AppModal v-if="editing" :title="current ? `Editar el servidor «${current.name}»` : 'Añadir servidor MCP'" :width="600" @close="editing = null">
      <form id="mcp-form" class="col" style="gap: 16px" novalidate @submit.prevent="save">
        <div class="field">
          <label for="mcp-name">Nombre</label>
          <input id="mcp-name" v-model="form.name" class="input mono" type="text" maxlength="20" spellcheck="false" autocomplete="off" placeholder="archivos" :aria-invalid="!!fieldErrors.name" />
          <span v-if="fieldErrors.name" class="error" role="alert">{{ fieldErrors.name }}</span>
          <span v-else class="hint">Será el prefijo de sus herramientas. Minúsculas, números y «_».</span>
        </div>

        <div class="field">
          <span class="label">Cómo se conecta</span>
          <div class="segmented" role="radiogroup" aria-label="Tipo de conexión">
            <button type="button" role="radio" :aria-checked="form.transport === 'stdio'" :class="{ active: form.transport === 'stdio' }" @click="form.transport = 'stdio'">Programa en este equipo</button>
            <button type="button" role="radio" :aria-checked="form.transport === 'http'" :class="{ active: form.transport === 'http' }" @click="form.transport = 'http'">Dirección HTTP</button>
          </div>
        </div>

        <template v-if="form.transport === 'stdio'">
          <div class="callout warning small">
            <ShieldAlert />
            <span>AgentForge arrancará este programa en el equipo del servidor, con sus mismos permisos. Añade solo programas en los que confíes.</span>
          </div>
          <div class="field">
            <label for="mcp-command">Programa</label>
            <input id="mcp-command" v-model="form.command" class="input mono" type="text" spellcheck="false" autocomplete="off" placeholder="npx" :aria-invalid="!!fieldErrors.command" />
            <span v-if="fieldErrors.command" class="error" role="alert">{{ fieldErrors.command }}</span>
          </div>
          <div class="field">
            <label for="mcp-args">Argumentos <span class="muted">(uno por línea)</span></label>
            <textarea id="mcp-args" v-model="form.args" class="textarea mono" rows="3" spellcheck="false" placeholder="-y&#10;@modelcontextprotocol/server-filesystem&#10;C:\datos" />
          </div>
        </template>
        <div v-else class="field">
          <label for="mcp-url"><Term id="url">URL</Term> del servidor</label>
          <input id="mcp-url" v-model="form.url" class="input mono" type="url" spellcheck="false" autocomplete="off" placeholder="https://ejemplo.com/mcp" :aria-invalid="!!fieldErrors.url" />
          <span v-if="fieldErrors.url" class="error" role="alert">{{ fieldErrors.url }}</span>
        </div>

        <div class="field">
          <label for="mcp-secrets">
            <template v-if="form.transport === 'stdio'">Variables de entorno <span class="muted">(NOMBRE=valor, una por línea)</span></template>
            <template v-else><Term id="cabecera">Cabeceras</Term> <span class="muted">(Cabecera: valor, una por línea)</span></template>
          </label>
          <label v-if="current && savedSecrets.length" class="check small">
            <input v-model="form.replaceSecrets" type="checkbox" />
            <span>Sustituir las guardadas ({{ savedSecrets.join(', ') }})</span>
          </label>
          <textarea
            id="mcp-secrets"
            v-if="form.transport === 'stdio'"
            v-model="form.env"
            class="textarea mono"
            rows="3"
            spellcheck="false"
            :disabled="!form.replaceSecrets"
            placeholder="API_KEY=…"
            :aria-invalid="!!fieldErrors.env"
          />
          <textarea
            id="mcp-secrets"
            v-else
            v-model="form.headers"
            class="textarea mono"
            rows="3"
            spellcheck="false"
            :disabled="!form.replaceSecrets"
            placeholder="Authorization: Bearer …"
            :aria-invalid="!!fieldErrors.headers"
          />
          <span v-if="fieldErrors.env || fieldErrors.headers" class="error" role="alert">{{ fieldErrors.env || fieldErrors.headers }}</span>
          <span v-else class="hint">Se guardan <Term id="cifrado">cifradas</Term> y no se vuelven a mostrar.</span>
        </div>

        <label class="check">
          <input v-model="form.enabled" type="checkbox" class="switch" />
          <span>
            <strong>Servidor activo</strong>
            <span class="muted small" style="display: block">Desactivado, sus herramientas dejan de ofrecerse a los agentes.</span>
          </span>
        </label>

        <div v-if="formError" class="callout danger" role="alert"><CircleAlert /><span>{{ formError }}</span></div>
      </form>
      <template #footer>
        <button class="btn" type="button" @click="editing = null">Cancelar</button>
        <button class="btn btn-primary" type="submit" form="mcp-form" :disabled="saving">
          <LoaderCircle v-if="saving" class="spin" /> {{ saving ? 'Conectando…' : current ? 'Guardar y conectar' : 'Añadir y conectar' }}
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
