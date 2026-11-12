<script setup lang="ts">
// Herramientas: catálogo (integradas, de servidores MCP y HTTP personalizadas), banco de pruebas, servidores MCP y archivos.
import type { JsonSchemaProp, Settings, ToolInfo, WorkspaceFile } from '@shared/types';
import {
  CircleAlert,
  Eye,
  FileText,
  FolderOpen,
  LoaderCircle,
  Pencil,
  Play,
  Plug,
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
import McpServersPanel from '@/components/McpServersPanel.vue';
import Term from '@/components/Term.vue';
import ToolEditorModal from '@/components/ToolEditorModal.vue';
import ToolTestModal from '@/components/ToolTestModal.vue';
import { api, errorText } from '@/lib/api';
import { t, tn } from '@/i18n';
import { formatBytes, formatDateTime, relativeTime } from '@/lib/format';
import { useCatalog } from '@/stores/catalog';
import { useUi } from '@/stores/ui';

const catalog = useCatalog();
const ui = useUi();

type Tab = 'catalog' | 'mcp' | 'files';
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
// Se guardan las claves, no los textos: así el idioma puede cambiar sin recargar.
const TYPE_KEY: Record<JsonSchemaProp['type'], string> = {
  string: 'tools.type.string',
  number: 'tools.type.number',
  integer: 'tools.type.integer',
  boolean: 'tools.type.boolean',
  object: 'tools.type.object',
  array: 'tools.type.array',
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
  return catalog.tools.filter((tool) => [tool.name, tool.title, tool.description, tool.category].some((s) => s.toLowerCase().includes(q)));
});

const groups = computed(() => {
  const map = new Map<string, ToolInfo[]>();
  for (const tool of filtered.value) map.set(tool.category, [...(map.get(tool.category) ?? []), tool]);
  return [...map.entries()].map(([category, tools]) => ({ category, tools }));
});

const customCount = computed(() => catalog.tools.filter((tool) => tool.source === 'custom').length);
const mcpCount = computed(() => catalog.tools.filter((tool) => tool.source === 'mcp').length);
const SOURCE_KEY: Record<ToolInfo['source'], string> = { builtin: 'tools.source.builtin', custom: 'tools.source.custom', mcp: 'tools.source.mcp' };

/** Un servidor MCP ha cambiado: sus herramientas se vuelven a leer. */
async function onMcpChanged(): Promise<void> {
  try {
    await catalog.reloadTools();
  } catch (err) {
    ui.error(errorText(err));
  }
}

function paramsOf(tool: ToolInfo): Array<{ name: string; prop: JsonSchemaProp; required: boolean }> {
  const required = new Set(tool.parameters.required ?? []);
  return Object.entries(tool.parameters.properties ?? {}).map(([name, prop]) => ({ name, prop, required: required.has(name) }));
}

/** Motivo por el que una herramienta integrada no funcionará con los ajustes actuales. */
function blockedReason(tool: ToolInfo): string | null {
  if (!settings.value) return null;
  if (tool.name === 'run_javascript' && !settings.value.allowCodeExecution) return t('tools.blocked.codeDisabled');
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
  ui.success(t(wasEdit ? 'tools.toast.updated' : 'tools.toast.created', { name }));
}

async function removeTool(tool: ToolInfo): Promise<void> {
  if (!tool.customId) return;
  const users = usage.value.get(tool.name) ?? [];
  const ok = await ui.confirm({
    title: t('tools.confirm.removeTitle', { name: tool.name }),
    message: users.length ? tn('tools.confirm.usedBy', users.length, { users: users.join(', ') }) : t('tools.confirm.unused'),
    confirmLabel: t('common.actions.delete'),
    danger: true,
  });
  if (!ok) return;
  try {
    await api.tools.removeCustom(tool.customId);
    await catalog.reloadTools();
    ui.success(t('tools.toast.removed', { name: tool.name }));
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
watch(tab, (value) => {
  if (value === 'files') void loadFiles();
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
  const state: OpenFile = {
    path: file.path,
    loading: true,
    error: null,
    content: '',
    sizeBytes: file.sizeBytes,
    truncated: false,
    rendered: isMarkdown(file.path),
  };
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
    title: t('tools.confirm.removeFileTitle'),
    message: t('tools.confirm.removeFileMessage', { path: file.path }),
    confirmLabel: t('common.actions.delete'),
    danger: true,
  });
  if (!ok) return;
  try {
    await api.workspace.remove(file.path);
    if (viewing.value?.path === file.path) viewing.value = null;
    ui.success(t('tools.toast.fileRemoved'));
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
        <h1>{{ t('tools.title') }}</h1>
        <i18n-t keypath="tools.subtitle" tag="p" class="subtitle" scope="global">
          <template #tool
            ><Term id="herramienta">{{ t('tools.subtitleTool') }}</Term></template
          >
          <template #agent
            ><Term id="agente">{{ t('tools.subtitleAgent') }}</Term></template
          >
          <template #api
            ><Term id="api">{{ t('tools.subtitleApi') }}</Term></template
          >
        </i18n-t>
      </div>
      <button class="btn btn-primary" type="button" :disabled="loading || !!loadError" @click="editor = {}"><Plus /> {{ t('tools.newHttp') }}</button>
    </header>

    <div class="tabs" role="tablist" :aria-label="t('tools.tabs.label')" style="margin-bottom: 18px">
      <button
        id="tools-tab-catalog"
        class="tab"
        :class="{ active: tab === 'catalog' }"
        type="button"
        role="tab"
        aria-controls="tools-panel-catalog"
        :aria-selected="tab === 'catalog'"
        @click="tab = 'catalog'"
      >
        <Wrench style="width: 15px; height: 15px" /> {{ t('tools.tabs.catalog') }}
        <span v-if="catalog.tools.length" class="badge">{{ catalog.tools.length }}</span>
      </button>
      <button
        id="tools-tab-mcp"
        class="tab"
        :class="{ active: tab === 'mcp' }"
        type="button"
        role="tab"
        aria-controls="tools-panel-mcp"
        :aria-selected="tab === 'mcp'"
        @click="tab = 'mcp'"
      >
        <Plug style="width: 15px; height: 15px" /> {{ t('tools.tabs.mcp') }}
      </button>
      <button
        id="tools-tab-files"
        class="tab"
        :class="{ active: tab === 'files' }"
        type="button"
        role="tab"
        aria-controls="tools-panel-files"
        :aria-selected="tab === 'files'"
        @click="tab = 'files'"
      >
        <FolderOpen style="width: 15px; height: 15px" /> {{ t('tools.tabs.files') }}
        <span v-if="filesLoaded && files.length" class="badge">{{ files.length }}</span>
      </button>
    </div>

    <!-- ================= Servidores MCP ================= -->
    <div v-if="tab === 'mcp'" id="tools-panel-mcp" role="tabpanel" aria-labelledby="tools-tab-mcp">
      <McpServersPanel @changed="onMcpChanged" />
    </div>

    <!-- ================= Catálogo ================= -->
    <section v-if="tab === 'catalog'" id="tools-panel-catalog" role="tabpanel" aria-labelledby="tools-tab-catalog" class="col" style="gap: 16px">
      <div v-if="loading" class="col" style="gap: 12px">
        <div v-for="i in 3" :key="i" class="skeleton" style="height: 120px; border-radius: var(--radius-lg)" />
      </div>

      <div v-else-if="loadError" class="card empty">
        <CircleAlert />
        <h3>{{ t('tools.loadError') }}</h3>
        <p>{{ loadError }}</p>
        <button class="btn" type="button" @click="load"><RefreshCw /> {{ t('common.actions.retry') }}</button>
      </div>

      <template v-else>
        <div v-if="settings && !settings.allowCodeExecution" class="callout warning">
          <ShieldAlert />
          <i18n-t keypath="tools.callout.codeDisabled" tag="span" scope="global">
            <template #code><code>run_javascript</code></template>
            <template #settings
              ><RouterLink to="/settings">{{ t('tools.callout.settings') }}</RouterLink></template
            >
            <template #sandbox
              ><Term id="sandbox">{{ t('tools.callout.sandbox') }}</Term></template
            >
          </i18n-t>
        </div>
        <div v-if="settings && !settings.allowPrivateNetwork" class="callout">
          <ShieldAlert />
          <i18n-t keypath="tools.callout.network" tag="span" scope="global">
            <template #fetch><code>web_fetch</code></template>
            <template #http><code>http_request</code></template>
            <template #privateNetwork
              ><Term id="red-privada">{{ t('tools.callout.privateNetwork') }}</Term></template
            >
            <template #settings
              ><RouterLink to="/settings">{{ t('tools.callout.settings') }}</RouterLink></template
            >
          </i18n-t>
        </div>

        <div class="toolbar">
          <div class="search">
            <Search aria-hidden="true" />
            <input v-model="query" class="input" type="search" :placeholder="t('tools.search.placeholder')" :aria-label="t('tools.search.aria')" />
          </div>
          <span class="muted small">
            {{ tn('tools.counts.builtin', catalog.tools.length - customCount - mcpCount) }} · {{ tn('tools.counts.custom', customCount) }}
            <template v-if="mcpCount"> · {{ t('tools.counts.fromMcp', { n: mcpCount }) }}</template>
          </span>
        </div>

        <div v-if="!groups.length" class="card empty">
          <Search />
          <h3>{{ t('tools.noMatch.title') }}</h3>
          <p>{{ t('tools.noMatch.text', { query }) }}</p>
          <button class="btn" type="button" @click="query = ''">{{ t('tools.noMatch.clear') }}</button>
        </div>

        <section v-for="g in groups" :key="g.category" class="col" style="gap: 10px">
          <h2 class="eyebrow">{{ g.category }}</h2>
          <div class="tool-grid">
            <article v-for="tool in g.tools" :key="tool.name" class="card tool" :class="{ off: !tool.enabled }">
              <header>
                <div class="grow">
                  <h3 class="truncate">{{ tool.source === 'custom' ? tool.name : tool.title }}</h3>
                  <code class="faint">{{ tool.name }}</code>
                </div>
                <div class="row" style="gap: 4px">
                  <button
                    class="btn btn-sm"
                    type="button"
                    :disabled="!tool.enabled"
                    :aria-label="t('tools.card.testAria', { title: tool.title })"
                    :title="tool.enabled ? undefined : t('tools.card.enableToTest')"
                    @click="testing = tool"
                  >
                    <Play /> {{ t('tools.card.test') }}
                  </button>
                  <template v-if="tool.source === 'custom' && tool.customId">
                    <button
                      class="btn btn-ghost btn-icon btn-sm"
                      type="button"
                      :aria-label="t('tools.card.editAria', { name: tool.name })"
                      :title="t('common.actions.edit')"
                      @click="editor = { customId: tool.customId }"
                    >
                      <Pencil />
                    </button>
                    <button
                      class="btn btn-ghost btn-icon btn-sm btn-danger"
                      type="button"
                      :aria-label="t('tools.card.deleteAria', { name: tool.name })"
                      :title="t('common.actions.delete')"
                      @click="removeTool(tool)"
                    >
                      <Trash2 />
                    </button>
                  </template>
                </div>
              </header>

              <div class="row wrap" style="gap: 6px">
                <span class="badge" :class="{ accent: tool.source !== 'builtin' }">{{ t(SOURCE_KEY[tool.source]) }}</span>
                <span v-if="tool.dangerous" class="badge warning" :title="t('tools.card.sensitiveTitle')"
                  ><TriangleAlert /> {{ t('tools.card.sensitive') }}</span
                >
                <span v-if="!tool.enabled" class="badge danger">{{ t('tools.card.disabled') }}</span>
                <span v-else-if="blockedReason(tool)" class="badge danger">{{ blockedReason(tool) }}</span>
                <span class="badge" :title="(usage.get(tool.name) ?? []).join(', ') || t('tools.card.noAgentTitle')">
                  {{ usage.get(tool.name)?.length ? tn('tools.card.agents', usage.get(tool.name)!.length) : t('tools.card.unused') }}
                </span>
              </div>

              <p class="muted small desc">{{ tool.description }}</p>

              <div v-if="paramsOf(tool).length" class="params">
                <div class="eyebrow">{{ t('tools.params.title') }}</div>
                <ul>
                  <li v-for="p in paramsOf(tool)" :key="p.name">
                    <span class="pname">
                      <code>{{ p.name }}</code>
                      <span class="tiny faint">{{ t(TYPE_KEY[p.prop.type] ?? 'tools.type.other') }}</span>
                      <span v-if="p.required" class="tiny req">{{ t('tools.params.required') }}</span>
                    </span>
                    <span class="small muted">
                      {{ p.prop.description || '—' }}
                      <span v-if="p.prop.enum?.length" class="faint"> {{ t('tools.params.values', { list: p.prop.enum.join(', ') }) }}</span>
                      <span v-if="p.prop.default !== undefined" class="faint"> {{ t('tools.params.defaultValue', { value: p.prop.default }) }}</span>
                    </span>
                  </li>
                </ul>
              </div>
              <p v-else class="faint small">{{ t('tools.card.noParams') }}</p>
            </article>
          </div>
        </section>
      </template>
    </section>

    <!-- ================= Archivos ================= -->
    <section v-else-if="tab === 'files'" id="tools-panel-files" role="tabpanel" aria-labelledby="tools-tab-files" class="col" style="gap: 14px">
      <div class="toolbar">
        <i18n-t keypath="tools.files.intro" tag="p" class="muted small grow" scope="global">
          <template #workspace
            ><Term id="workspace">{{ t('tools.files.workspace') }}</Term></template
          >
          <template #write><code>file_write</code></template>
          <template #read><code>file_read</code></template>
          <template #summary>
            <span v-if="files.length"> {{ t('tools.files.summary', { count: tn('tools.files.count', files.length), size: formatBytes(totalBytes) }) }}</span>
          </template>
        </i18n-t>
        <button class="btn" type="button" :disabled="filesLoading" @click="loadFiles">
          <RefreshCw :class="{ spin: filesLoading }" /> {{ t('common.actions.refresh') }}
        </button>
      </div>

      <div v-if="filesError" class="card empty">
        <CircleAlert />
        <h3>{{ t('tools.files.loadError') }}</h3>
        <p>{{ filesError }}</p>
        <button class="btn" type="button" @click="loadFiles"><RefreshCw /> {{ t('common.actions.retry') }}</button>
      </div>
      <div v-else-if="!filesLoaded" class="col" style="gap: 8px">
        <div v-for="i in 4" :key="i" class="skeleton" style="height: 44px" />
      </div>
      <div v-else-if="!files.length" class="card empty">
        <FolderOpen />
        <h3>{{ t('tools.files.emptyTitle') }}</h3>
        <i18n-t keypath="tools.files.emptyText" tag="p" scope="global">
          <template #write><code>file_write</code></template>
        </i18n-t>
        <RouterLink class="btn" to="/workflows">{{ t('tools.files.goWorkflows') }}</RouterLink>
      </div>
      <div v-else class="card table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>{{ t('tools.files.colFile') }}</th>
              <th class="right">{{ t('tools.files.colSize') }}</th>
              <th class="hide-sm">{{ t('tools.files.colModified') }}</th>
              <th>
                <span class="sr-only">{{ t('tools.files.colActions') }}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="f in files" :key="f.path">
              <td class="fpath">
                <button class="link" type="button" :title="t('tools.files.view', { path: f.path })" @click="openFile(f)">
                  <FileText aria-hidden="true" /><span>{{ f.path }}</span>
                </button>
              </td>
              <td class="right num muted nowrap">{{ formatBytes(f.sizeBytes) }}</td>
              <td class="muted nowrap hide-sm" :title="formatDateTime(f.modifiedAt)">{{ relativeTime(f.modifiedAt) }}</td>
              <td class="right nowrap">
                <button
                  class="btn btn-ghost btn-icon btn-sm"
                  type="button"
                  :aria-label="t('tools.files.view', { path: f.path })"
                  :title="t('tools.files.viewContent')"
                  @click="openFile(f)"
                >
                  <Eye />
                </button>
                <button
                  class="btn btn-ghost btn-icon btn-sm btn-danger"
                  type="button"
                  :aria-label="t('tools.card.deleteAria', { name: f.path })"
                  :title="t('common.actions.delete')"
                  @click="removeFile(f)"
                >
                  <Trash2 />
                </button>
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
      <div v-if="viewing.loading" class="row muted"><LoaderCircle class="spin" style="width: 16px; height: 16px" /> {{ t('tools.files.loading') }}</div>
      <div v-else-if="viewing.error" class="callout danger" role="alert">
        <CircleAlert /><span>{{ viewing.error }}</span>
      </div>
      <div v-else class="col" style="gap: 10px">
        <div class="row between wrap">
          <span class="small muted num">{{ formatBytes(viewing.sizeBytes) }}</span>
          <div v-if="isMarkdown(viewing.path)" class="segmented" role="group" :aria-label="t('tools.files.viewMode')">
            <button type="button" :class="{ active: viewing.rendered }" :aria-pressed="viewing.rendered" @click="viewing.rendered = true">
              {{ t('tools.files.preview') }}
            </button>
            <button type="button" :class="{ active: !viewing.rendered }" :aria-pressed="!viewing.rendered" @click="viewing.rendered = false">
              {{ t('tools.files.text') }}
            </button>
          </div>
        </div>
        <div v-if="viewing.truncated" class="callout warning">
          <TriangleAlert /><span>{{ t('tools.files.truncated') }}</span>
        </div>
        <p v-if="!viewing.content" class="faint small">{{ t('tools.files.empty') }}</p>
        <div v-else-if="viewing.rendered" class="preview"><MarkdownView :source="viewing.content" /></div>
        <pre v-else class="codeblock" style="max-height: 60vh">{{ viewing.content }}</pre>
      </div>
      <template #footer>
        <button class="btn" type="button" @click="viewing = null">{{ t('common.actions.close') }}</button>
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
  background: var(--surface-2);
  border-style: dashed;
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
