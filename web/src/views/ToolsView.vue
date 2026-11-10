<script setup lang="ts">
// Herramientas: catálogo (integradas + HTTP personalizadas), banco de pruebas y archivos del espacio de trabajo.
import type { JsonSchemaProp, Settings, ToolInfo, WorkspaceFile } from '@shared/types';
import {
  CircleAlert,
  Eye,
  FileText,
  FolderOpen,
  LoaderCircle,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  ShieldAlert,
  Trash2,
  TriangleAlert,
  Wrench,
} from 'lucide-vue-next';
import { computed, onMounted, ref, watch } from 'vue';
import AppModal from '@/components/AppModal.vue';
import MarkdownView from '@/components/MarkdownView.vue';
import Term from '@/components/Term.vue';
import ToolEditorModal from '@/components/ToolEditorModal.vue';
import ToolTestModal from '@/components/ToolTestModal.vue';
import { api, errorText } from '@/lib/api';
import { formatBytes, formatDateTime, plural, relativeTime } from '@/lib/format';
import { useCatalog } from '@/stores/catalog';
import { useUi } from '@/stores/ui';

const catalog = useCatalog();
const ui = useUi();

type Tab = 'catalog' | 'files';
const tab = ref<Tab>('catalog');
const loading = ref(!catalog.loaded);
const loadError = ref<string | null>(null);
const settings = ref<Settings | null>(null);

async function load(): Promise<void> {
  loading.value = !catalog.loaded;
  loadError.value = null;
  try {
    await catalog.ensure();
    // Se refresca el catálogo de herramientas por si cambió desde otra pestaña.
    const [, s] = await Promise.all([catalog.reloadTools(), api.settings.get()]);
    settings.value = s;
  } catch (err) {
    loadError.value = errorText(err);
  } finally {
    loading.value = false;
  }
}
onMounted(load);

// ---------- Catálogo ----------
const query = ref('');
const TYPE_LABEL: Record<JsonSchemaProp['type'], string> = {
  string: 'texto',
  number: 'número',
  integer: 'entero',
  boolean: 'sí/no',
  object: 'objeto',
  array: 'lista',
};

/** Nº de agentes que tienen asignada cada herramienta. */
const usage = computed(() => {
  const counts = new Map<string, string[]>();
  for (const agent of catalog.agents) {
    for (const name of agent.tools) counts.set(name, [...(counts.get(name) ?? []), agent.name]);
  }
  return counts;
});

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return catalog.tools;
  return catalog.tools.filter((t) => [t.name, t.title, t.description, t.category].some((s) => s.toLowerCase().includes(q)));
});

const groups = computed(() => {
  const map = new Map<string, ToolInfo[]>();
  for (const t of filtered.value) map.set(t.category, [...(map.get(t.category) ?? []), t]);
  return [...map.entries()].map(([category, tools]) => ({ category, tools }));
});

const customCount = computed(() => catalog.tools.filter((t) => t.source === 'custom').length);

function paramsOf(tool: ToolInfo): Array<{ name: string; prop: JsonSchemaProp; required: boolean }> {
  const required = new Set(tool.parameters.required ?? []);
  return Object.entries(tool.parameters.properties ?? {}).map(([name, prop]) => ({ name, prop, required: required.has(name) }));
}

/** Motivo por el que una herramienta integrada no funcionará con los ajustes actuales. */
function blockedReason(tool: ToolInfo): string | null {
  if (!settings.value) return null;
  if (tool.name === 'run_javascript' && !settings.value.allowCodeExecution) return 'Desactivada en Ajustes';
  return null;
}

// ---------- Banco de pruebas y editor ----------
const testing = ref<ToolInfo | null>(null);
const editor = ref<{ customId?: string } | null>(null);

async function onSaved(name: string): Promise<void> {
  const wasEdit = Boolean(editor.value?.customId);
  editor.value = null;
  try {
    await catalog.reloadTools();
  } catch (err) {
    ui.error(errorText(err));
  }
  ui.success(wasEdit ? `Herramienta «${name}» actualizada.` : `Herramienta «${name}» creada. Ya puedes asignarla a tus agentes.`);
}

async function removeTool(tool: ToolInfo): Promise<void> {
  if (!tool.customId) return;
  const users = usage.value.get(tool.name) ?? [];
  const ok = await ui.confirm({
    title: `Eliminar «${tool.name}»`,
    message: users.length
      ? `La usan ${plural(users.length, 'agente', 'agentes')} (${users.join(', ')}). Dejará de estar disponible para ellos. Esta acción no se puede deshacer.`
      : 'La herramienta se eliminará definitivamente. Esta acción no se puede deshacer.',
    confirmLabel: 'Eliminar',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.tools.removeCustom(tool.customId);
    await catalog.reloadTools();
    ui.success(`Herramienta «${tool.name}» eliminada.`);
  } catch (err) {
    ui.error(errorText(err));
  }
}

// ---------- Archivos del espacio de trabajo ----------
const files = ref<WorkspaceFile[]>([]);
const filesLoaded = ref(false);
const filesLoading = ref(false);
const filesError = ref<string | null>(null);

async function loadFiles(): Promise<void> {
  filesLoading.value = true;
  filesError.value = null;
  try {
    files.value = (await api.workspace.files()).sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
    filesLoaded.value = true;
  } catch (err) {
    filesError.value = errorText(err);
  } finally {
    filesLoading.value = false;
  }
}
watch(tab, (t) => {
  if (t === 'files') void loadFiles();
});

const totalBytes = computed(() => files.value.reduce((sum, f) => sum + f.sizeBytes, 0));

interface OpenFile {
  path: string;
  loading: boolean;
  error: string | null;
  content: string;
  sizeBytes: number;
  truncated: boolean;
  rendered: boolean;
}
const viewing = ref<OpenFile | null>(null);
const isMarkdown = (path: string) => /\.(md|markdown)$/i.test(path);

async function openFile(file: WorkspaceFile): Promise<void> {
  const state: OpenFile = { path: file.path, loading: true, error: null, content: '', sizeBytes: file.sizeBytes, truncated: false, rendered: isMarkdown(file.path) };
  viewing.value = state;
  try {
    const res = await api.workspace.read(file.path);
    if (viewing.value?.path !== file.path) return;
    viewing.value = { ...state, loading: false, content: res.content, sizeBytes: res.sizeBytes, truncated: res.truncated };
  } catch (err) {
    if (viewing.value?.path === file.path) viewing.value = { ...state, loading: false, error: errorText(err) };
  }
}

async function removeFile(file: WorkspaceFile): Promise<void> {
  const ok = await ui.confirm({
    title: 'Eliminar archivo',
    message: `Se eliminará «${file.path}» del espacio de trabajo. Esta acción no se puede deshacer.`,
    confirmLabel: 'Eliminar',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.workspace.remove(file.path);
    if (viewing.value?.path === file.path) viewing.value = null;
    ui.success('Archivo eliminado.');
  } catch (err) {
    ui.error(errorText(err));
  }
  await loadFiles();
}
</script>

<template>
  <div class="page">
    <header class="page-header">
      <div>
        <h1>Herramientas</h1>
        <p class="subtitle">
          Una <Term id="herramienta">herramienta</Term> permite a un <Term id="agente">agente</Term> hacer operaciones reales: calcular, leer una
          web, escribir archivos o llamar a tus propias <Term id="api">APIs</Term>.
        </p>
      </div>
      <button class="btn btn-primary" type="button" :disabled="loading || !!loadError" @click="editor = {}"><Plus /> Nueva herramienta HTTP</button>
    </header>

    <div class="tabs" role="tablist" aria-label="Secciones de herramientas" style="margin-bottom: 18px">
      <button class="tab" :class="{ active: tab === 'catalog' }" type="button" role="tab" :aria-selected="tab === 'catalog'" @click="tab = 'catalog'">
        <Wrench style="width: 15px; height: 15px" /> Catálogo
        <span v-if="catalog.tools.length" class="badge">{{ catalog.tools.length }}</span>
      </button>
      <button class="tab" :class="{ active: tab === 'files' }" type="button" role="tab" :aria-selected="tab === 'files'" @click="tab = 'files'">
        <FolderOpen style="width: 15px; height: 15px" /> Archivos
        <span v-if="filesLoaded && files.length" class="badge">{{ files.length }}</span>
      </button>
    </div>

    <!-- ================= Catálogo ================= -->
    <section v-if="tab === 'catalog'" role="tabpanel" aria-label="Catálogo" class="col" style="gap: 16px">
      <div v-if="loading" class="col" style="gap: 12px">
        <div v-for="i in 3" :key="i" class="skeleton" style="height: 120px; border-radius: var(--radius-lg)" />
      </div>

      <div v-else-if="loadError" class="card empty">
        <CircleAlert />
        <h3>No se pudieron cargar las herramientas</h3>
        <p>{{ loadError }}</p>
        <button class="btn" type="button" @click="load"><RefreshCw /> Reintentar</button>
      </div>

      <template v-else>
        <div v-if="settings && !settings.allowCodeExecution" class="callout warning">
          <ShieldAlert />
          <span>
            La ejecución de código está desactivada: <code>run_javascript</code> devolverá un error hasta que la habilites en
            <RouterLink to="/settings">Ajustes</RouterLink>. Cuando se activa, el código corre en un
            <Term id="sandbox">entorno aislado</Term>.
          </span>
        </div>
        <div v-if="settings && !settings.allowPrivateNetwork" class="callout">
          <ShieldAlert />
          <span>
            Las herramientas de red (<code>web_fetch</code>, <code>http_request</code> y las personalizadas) no pueden acceder a tu
            <Term id="red-privada">red privada</Term> ni a localhost. Puedes permitirlo en <RouterLink to="/settings">Ajustes</RouterLink>.
          </span>
        </div>

        <div class="toolbar">
          <div class="search">
            <Search aria-hidden="true" />
            <input v-model="query" class="input" type="search" placeholder="Buscar por nombre o descripción…" aria-label="Buscar herramientas" />
          </div>
          <span class="muted small">
            {{ plural(catalog.tools.length - customCount, 'integrada', 'integradas') }} · {{ plural(customCount, 'personalizada', 'personalizadas') }}
          </span>
        </div>

        <div v-if="!groups.length" class="card empty">
          <Search />
          <h3>Ninguna herramienta coincide</h3>
          <p>No hay resultados para «{{ query }}».</p>
          <button class="btn" type="button" @click="query = ''">Limpiar búsqueda</button>
        </div>

        <section v-for="g in groups" :key="g.category" class="col" style="gap: 10px">
          <h2 class="eyebrow">{{ g.category }}</h2>
          <div class="tool-grid">
            <article v-for="t in g.tools" :key="t.name" class="card tool" :class="{ off: !t.enabled }">
              <header>
                <div class="grow">
                  <h3 class="truncate">{{ t.source === 'custom' ? t.name : t.title }}</h3>
                  <code class="faint">{{ t.name }}</code>
                </div>
                <div class="row" style="gap: 4px">
                  <button class="btn btn-sm" type="button" :disabled="!t.enabled" :aria-label="`Probar ${t.title}`" :title="t.enabled ? undefined : 'Actívala para probarla'" @click="testing = t">
                    <Play /> Probar
                  </button>
                  <template v-if="t.source === 'custom' && t.customId">
                    <button class="btn btn-ghost btn-icon btn-sm" type="button" :aria-label="`Editar ${t.name}`" title="Editar" @click="editor = { customId: t.customId }">
                      <Pencil />
                    </button>
                    <button class="btn btn-ghost btn-icon btn-sm btn-danger" type="button" :aria-label="`Eliminar ${t.name}`" title="Eliminar" @click="removeTool(t)">
                      <Trash2 />
                    </button>
                  </template>
                </div>
              </header>

              <div class="row wrap" style="gap: 6px">
                <span class="badge" :class="{ accent: t.source === 'custom' }">{{ t.source === 'custom' ? 'Personalizada' : 'Integrada' }}</span>
                <span v-if="t.dangerous" class="badge warning" title="Puede ejecutar acciones delicadas; revisa los ajustes de seguridad"><TriangleAlert /> Sensible</span>
                <span v-if="!t.enabled" class="badge danger">Desactivada</span>
                <span v-else-if="blockedReason(t)" class="badge danger">{{ blockedReason(t) }}</span>
                <span class="badge" :title="(usage.get(t.name) ?? []).join(', ') || 'Ningún agente la tiene asignada'">
                  {{ usage.get(t.name)?.length ? plural(usage.get(t.name)!.length, 'agente', 'agentes') : 'Sin uso' }}
                </span>
              </div>

              <p class="muted small desc">{{ t.description }}</p>

              <div v-if="paramsOf(t).length" class="params">
                <div class="eyebrow">Parámetros</div>
                <ul>
                  <li v-for="p in paramsOf(t)" :key="p.name">
                    <span class="pname">
                      <code>{{ p.name }}</code>
                      <span class="tiny faint">{{ TYPE_LABEL[p.prop.type] }}</span>
                      <span v-if="p.required" class="tiny req">obligatorio</span>
                    </span>
                    <span class="small muted">
                      {{ p.prop.description || '—' }}
                      <span v-if="p.prop.enum?.length" class="faint"> Valores: {{ p.prop.enum.join(', ') }}.</span>
                      <span v-if="p.prop.default !== undefined" class="faint"> Por defecto: {{ p.prop.default }}.</span>
                    </span>
                  </li>
                </ul>
              </div>
              <p v-else class="faint small">Sin parámetros.</p>
            </article>
          </div>
        </section>
      </template>
    </section>

    <!-- ================= Archivos ================= -->
    <section v-else role="tabpanel" aria-label="Archivos" class="col" style="gap: 14px">
      <div class="toolbar">
        <p class="muted small grow">
          Archivos del <Term id="workspace">espacio de trabajo</Term>: lo que los agentes escriben con <code>file_write</code> y pueden leer con
          <code>file_read</code>.
          <span v-if="files.length"> {{ plural(files.length, 'archivo', 'archivos') }}, {{ formatBytes(totalBytes) }} en total.</span>
        </p>
        <button class="btn" type="button" :disabled="filesLoading" @click="loadFiles">
          <RefreshCw :class="{ spin: filesLoading }" /> Actualizar
        </button>
      </div>

      <div v-if="filesError" class="card empty">
        <CircleAlert />
        <h3>No se pudieron listar los archivos</h3>
        <p>{{ filesError }}</p>
        <button class="btn" type="button" @click="loadFiles"><RefreshCw /> Reintentar</button>
      </div>
      <div v-else-if="!filesLoaded" class="col" style="gap: 8px">
        <div v-for="i in 4" :key="i" class="skeleton" style="height: 44px" />
      </div>
      <div v-else-if="!files.length" class="card empty">
        <FolderOpen />
        <h3>El espacio de trabajo está vacío</h3>
        <p>
          Aquí aparecerán los archivos que generen tus agentes. Da a un agente la herramienta <code>file_write</code> o ejecuta el workflow de
          ejemplo «Cálculo con herramientas y archivo».
        </p>
        <RouterLink class="btn" to="/workflows">Ir a workflows</RouterLink>
      </div>
      <div v-else class="card table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>Archivo</th>
              <th class="right">Tamaño</th>
              <th class="hide-sm">Modificado</th>
              <th><span class="sr-only">Acciones</span></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="f in files" :key="f.path">
              <td class="fpath">
                <button class="link" type="button" :title="`Ver ${f.path}`" @click="openFile(f)"><FileText aria-hidden="true" /><span>{{ f.path }}</span></button>
              </td>
              <td class="right num muted nowrap">{{ formatBytes(f.sizeBytes) }}</td>
              <td class="muted nowrap hide-sm" :title="formatDateTime(f.modifiedAt)">{{ relativeTime(f.modifiedAt) }}</td>
              <td class="right nowrap">
                <button class="btn btn-ghost btn-icon btn-sm" type="button" :aria-label="`Ver ${f.path}`" title="Ver contenido" @click="openFile(f)"><Eye /></button>
                <button class="btn btn-ghost btn-icon btn-sm btn-danger" type="button" :aria-label="`Eliminar ${f.path}`" title="Eliminar" @click="removeFile(f)"><Trash2 /></button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- ================= Modales ================= -->
    <ToolTestModal v-if="testing" :key="testing.name" :tool="testing" @close="testing = null" />
    <ToolEditorModal v-if="editor" :custom-id="editor.customId" @close="editor = null" @saved="onSaved" />

    <AppModal v-if="viewing" :title="viewing.path" :width="820" @close="viewing = null">
      <div v-if="viewing.loading" class="row muted"><LoaderCircle class="spin" style="width: 16px; height: 16px" /> Cargando archivo…</div>
      <div v-else-if="viewing.error" class="callout danger" role="alert"><CircleAlert /><span>{{ viewing.error }}</span></div>
      <div v-else class="col" style="gap: 10px">
        <div class="row between wrap">
          <span class="small muted num">{{ formatBytes(viewing.sizeBytes) }}</span>
          <div v-if="isMarkdown(viewing.path)" class="segmented" role="group" aria-label="Modo de visualización">
            <button type="button" :class="{ active: viewing.rendered }" :aria-pressed="viewing.rendered" @click="viewing.rendered = true">Vista previa</button>
            <button type="button" :class="{ active: !viewing.rendered }" :aria-pressed="!viewing.rendered" @click="viewing.rendered = false">Texto</button>
          </div>
        </div>
        <div v-if="viewing.truncated" class="callout warning"><TriangleAlert /><span>El archivo es muy grande: solo se muestran los primeros 500.000 caracteres.</span></div>
        <p v-if="!viewing.content" class="faint small">El archivo está vacío.</p>
        <div v-else-if="viewing.rendered" class="preview"><MarkdownView :source="viewing.content" /></div>
        <pre v-else class="codeblock" style="max-height: 60vh">{{ viewing.content }}</pre>
      </div>
      <template #footer>
        <button class="btn" type="button" @click="viewing = null">Cerrar</button>
      </template>
    </AppModal>
  </div>
</template>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.search {
  position: relative;
  flex: 1 1 260px;
  max-width: 420px;
}
.search svg {
  position: absolute;
  left: 10px;
  top: 50%;
  width: 15px;
  height: 15px;
  transform: translateY(-50%);
  color: var(--text-3);
  pointer-events: none;
}
.search .input {
  padding-left: 32px;
}
.tool-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 380px), 1fr));
  gap: 12px;
  align-items: start;
}
.tool {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px 18px;
  min-width: 0;
}
.tool.off {
  opacity: 0.72;
}
.tool header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}
.tool h3 {
  font-size: 15px;
}
.desc {
  overflow-wrap: anywhere;
}
.params {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 10px;
  border-top: 1px solid var(--border);
}
.params ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.params li {
  display: grid;
  grid-template-columns: minmax(110px, 0.8fr) minmax(0, 2fr);
  gap: 4px 12px;
  overflow-wrap: anywhere;
}
.pname {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2px 6px;
  align-content: flex-start;
}
.req {
  color: var(--accent);
  font-weight: 600;
}
.nowrap {
  white-space: nowrap;
}
.fpath {
  max-width: 0;
  width: 100%;
}
.link {
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 100%;
  padding: 0;
  border: 0;
  background: none;
  color: var(--text);
  font-family: var(--font-mono);
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
}
.link:hover {
  color: var(--accent);
}
.link svg {
  width: 15px;
  height: 15px;
  flex: none;
  color: var(--text-3);
}
.link span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.preview {
  max-height: 60vh;
  overflow: auto;
  padding: 14px 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}
@media (max-width: 600px) {
  .hide-sm {
    display: none;
  }
  .params li {
    grid-template-columns: 1fr;
  }
  .tool header {
    flex-wrap: wrap;
  }
}
</style>
