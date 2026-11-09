<script setup lang="ts">
import type { DashboardStats, Provider, ProviderTestResult, Settings } from '@shared/types';
import {
  CircleAlert,
  Cpu,
  Database,
  KeyRound,
  LoaderCircle,
  Pencil,
  PlugZap,
  Plus,
  RefreshCw,
  Server,
  ShieldAlert,
  Trash2,
} from 'lucide-vue-next';
import { computed, onMounted, reactive, ref } from 'vue';
import ProviderModal from '@/components/ProviderModal.vue';
import Term from '@/components/Term.vue';
import { api, errorText } from '@/lib/api';
import { formatBytes, formatDuration, formatNumber, formatUptime, plural } from '@/lib/format';
import { useCatalog } from '@/stores/catalog';
import { useUi } from '@/stores/ui';

const catalog = useCatalog();
const ui = useUi();

const loading = ref(true);
const loadError = ref<string | null>(null);
const settings = ref<Settings | null>(null);
const stats = ref<DashboardStats | null>(null);

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = null;
  try {
    const [s, st] = await Promise.all([api.settings.get(), api.stats(), catalog.loaded ? catalog.reload() : catalog.ensure()]);
    settings.value = s;
    stats.value = st;
    concurrentDraft.value = s.maxConcurrentRuns;
    void catalog.refreshHealth();
  } catch (err) {
    loadError.value = errorText(err);
  } finally {
    loading.value = false;
  }
}
onMounted(load);

// ---------- Proveedores ----------
const KIND_LABEL = { ollama: 'Ollama', openai: 'Compatible con OpenAI' } as const;
const modal = ref<{ provider: Provider | null } | null>(null);
const testing = reactive(new Set<string>());
const busy = reactive(new Set<string>());
const testResults = reactive(new Map<string, ProviderTestResult>());

const agentCount = computed(() => {
  const counts = new Map<string, number>();
  for (const a of catalog.agents) counts.set(a.providerId, (counts.get(a.providerId) ?? 0) + 1);
  return counts;
});

/** Estado mostrado: la última prueba manual tiene prioridad sobre la comprobación periódica. */
function statusOf(p: Provider): { tone: string; text: string; error?: string; pulse?: boolean } {
  if (!p.enabled) return { tone: '', text: 'Desactivado' };
  if (testing.has(p.id)) return { tone: 'info', text: 'Probando…', pulse: true };
  const r = testResults.get(p.id) ?? catalog.healthById.get(p.id);
  if (!r) return { tone: '', text: 'Comprobando…', pulse: true };
  if (r.ok) return { tone: 'success', text: `Disponible · ${plural(r.modelCount ?? 0, 'modelo', 'modelos')} · ${formatDuration(r.latencyMs)}` };
  return { tone: 'danger', text: 'No disponible', error: r.error ?? 'No se pudo conectar.' };
}

async function testProvider(p: Provider): Promise<void> {
  testing.add(p.id);
  try {
    const result = await api.providers.test(p.id);
    testResults.set(p.id, result);
    if (result.ok) ui.success(`«${p.name}» responde: ${plural(result.modelCount ?? 0, 'modelo', 'modelos')} en ${formatDuration(result.latencyMs)}.`);
    else ui.error(`«${p.name}» no responde: ${result.error ?? 'error desconocido'}`);
    await catalog.refreshHealth(true);
  } catch (err) {
    ui.error(errorText(err));
  } finally {
    testing.delete(p.id);
  }
}

async function toggleProvider(p: Provider): Promise<void> {
  busy.add(p.id);
  try {
    // Sin `apiKey` el servidor conserva la clave guardada.
    const saved = await api.providers.update(p.id, {
      name: p.name,
      kind: p.kind,
      baseUrl: p.baseUrl,
      defaultModel: p.defaultModel,
      enabled: !p.enabled,
    });
    catalog.setProvider(saved);
    testResults.delete(p.id);
    ui.success(saved.enabled ? `«${saved.name}» activado.` : `«${saved.name}» desactivado.`);
    await catalog.refreshHealth(true);
  } catch (err) {
    ui.error(errorText(err));
  } finally {
    busy.delete(p.id);
  }
}

async function removeProvider(p: Provider): Promise<void> {
  const ok = await ui.confirm({
    title: 'Eliminar proveedor',
    message: `Se eliminará «${p.name}» y su API key guardada. Esta acción no se puede deshacer.`,
    confirmLabel: 'Eliminar',
    danger: true,
  });
  if (!ok) return;
  busy.add(p.id);
  try {
    await api.providers.remove(p.id);
    catalog.dropProvider(p.id);
    testResults.delete(p.id);
    ui.success(`Proveedor «${p.name}» eliminado.`);
    void catalog.refreshHealth(true);
    void refreshStats();
  } catch (err) {
    ui.error(errorText(err)); // p. ej. 409: lo usan agentes
  } finally {
    busy.delete(p.id);
  }
}

function onSaved(p: Provider): void {
  testResults.delete(p.id);
  modal.value = null;
  void refreshStats();
}

// ---------- Ejecución y seguridad ----------
const concurrentDraft = ref(3);
const savingSetting = ref<keyof Settings | null>(null);

async function updateSetting<K extends keyof Settings>(key: K, value: Settings[K], message: string): Promise<void> {
  if (!settings.value || settings.value[key] === value) return;
  savingSetting.value = key;
  try {
    settings.value = await api.settings.update({ [key]: value });
    ui.success(message);
  } catch (err) {
    ui.error(errorText(err));
  } finally {
    concurrentDraft.value = settings.value.maxConcurrentRuns;
    savingSetting.value = null;
  }
}

function commitConcurrent(): void {
  const n = Math.round(Number(concurrentDraft.value));
  if (!Number.isFinite(n) || n < 1 || n > 10) {
    ui.error('El número de ejecuciones simultáneas debe estar entre 1 y 10.');
    concurrentDraft.value = settings.value?.maxConcurrentRuns ?? 3;
    return;
  }
  void updateSetting('maxConcurrentRuns', n, `Ejecuciones simultáneas: ${n}.`);
}

async function togglePrivateNetwork(ev: Event): Promise<void> {
  const input = ev.target as HTMLInputElement;
  const next = input.checked;
  if (next) {
    const ok = await ui.confirm({
      title: 'Permitir redes privadas',
      message:
        'Las herramientas de red de los agentes podrán llamar a localhost y a los equipos de tu red local (router, otros servicios internos). Actívalo solo si confías en los agentes y en el contenido que leen.',
      confirmLabel: 'Permitir',
      danger: true,
    });
    if (!ok) {
      input.checked = false;
      return;
    }
  }
  await updateSetting('allowPrivateNetwork', next, next ? 'Acceso a redes privadas permitido.' : 'Acceso a redes privadas bloqueado.');
  input.checked = settings.value?.allowPrivateNetwork ?? false;
}

async function toggleCodeExecution(ev: Event): Promise<void> {
  const input = ev.target as HTMLInputElement;
  const next = input.checked;
  if (next) {
    const ok = await ui.confirm({
      title: 'Permitir ejecución de código',
      message:
        'Los agentes con la herramienta run_javascript podrán ejecutar el código que genere el modelo. El aislamiento (node:vm en un Worker) limita tiempo y memoria, pero no es una barrera de seguridad fuerte.',
      confirmLabel: 'Permitir',
      danger: true,
    });
    if (!ok) {
      input.checked = false;
      return;
    }
  }
  await updateSetting('allowCodeExecution', next, next ? 'Ejecución de código permitida.' : 'Ejecución de código desactivada.');
  input.checked = settings.value?.allowCodeExecution ?? false;
}

// ---------- Datos ----------
const clearing = ref(false);
const refreshingStats = ref(false);

async function refreshStats(): Promise<void> {
  refreshingStats.value = true;
  try {
    stats.value = await api.stats();
  } catch (err) {
    ui.error(errorText(err));
  } finally {
    refreshingStats.value = false;
  }
}

const finishedRuns = computed(() => {
  const s = stats.value?.runsByStatus;
  return s ? s.completed + s.failed + s.cancelled : 0;
});

async function clearFinished(): Promise<void> {
  const ok = await ui.confirm({
    title: 'Eliminar ejecuciones terminadas',
    message: `Se eliminarán ${plural(finishedRuns.value, 'ejecución terminada', 'ejecuciones terminadas')} con sus pasos y eventos. Las que estén en curso no se tocan. No se puede deshacer.`,
    confirmLabel: 'Eliminar',
    danger: true,
  });
  if (!ok) return;
  clearing.value = true;
  try {
    const { deleted } = await api.runs.clearFinished();
    ui.success(deleted ? `${plural(deleted, 'ejecución eliminada', 'ejecuciones eliminadas')}.` : 'No había ejecuciones terminadas.');
    await refreshStats();
  } catch (err) {
    ui.error(errorText(err));
  } finally {
    clearing.value = false;
  }
}
</script>

<template>
  <div class="page">
    <header class="page-header">
      <div>
        <h1>Ajustes</h1>
        <p class="subtitle">Conecta los servicios que ejecutan los modelos y decide los límites y permisos con los que trabajan los agentes.</p>
      </div>
    </header>

    <div v-if="loadError" class="callout danger" role="alert" style="margin-bottom: 16px">
      <CircleAlert />
      <span class="grow">{{ loadError }}</span>
      <button class="btn btn-sm" type="button" :disabled="loading" @click="load"><RefreshCw :class="{ spin: loading }" /> Reintentar</button>
    </div>

    <div class="sections">
      <!-- 1. Proveedores -->
      <section class="card" aria-labelledby="sec-providers">
        <div class="card-head">
          <h2 id="sec-providers"><Server style="width: 16px; height: 16px" /> Proveedores de modelos</h2>
          <button class="btn btn-primary btn-sm" type="button" @click="modal = { provider: null }"><Plus /> Añadir proveedor</button>
        </div>
        <p class="intro muted small">
          Un <Term id="proveedor">proveedor</Term> es el servicio que ejecuta los modelos: <Term id="ollama" /> en tu equipo o una API remota
          <Term id="openai-compatible">compatible con OpenAI</Term>. Cada <Term id="agente">agente</Term> usa uno.
        </p>

        <div v-if="loading && !catalog.loaded" class="card-pad col">
          <div class="skeleton" style="height: 64px" />
          <div class="skeleton" style="height: 64px" />
        </div>
        <div v-else-if="!catalog.providers.length" class="empty">
          <Server />
          <h3>Aún no hay proveedores</h3>
          <p>Sin un proveedor los agentes no pueden hablar con ningún modelo. Si tienes Ollama instalado, añádelo con la plantilla «Ollama local».</p>
          <button class="btn btn-primary" type="button" @click="modal = { provider: null }"><Plus /> Añadir proveedor</button>
        </div>
        <ul v-else class="providers">
          <li v-for="p in catalog.providers" :key="p.id" :class="{ off: !p.enabled }">
            <div class="p-main">
              <div class="row wrap" style="gap: 8px">
                <strong class="p-name">{{ p.name }}</strong>
                <span class="badge" :class="p.kind === 'ollama' ? 'accent' : 'info'">{{ KIND_LABEL[p.kind] }}</span>
                <span v-if="p.hasApiKey" class="badge" title="Hay una API key guardada (cifrada)"><KeyRound /> Clave guardada</span>
              </div>
              <div class="p-url mono truncate" :title="p.baseUrl">{{ p.baseUrl }}</div>
              <div class="row wrap small muted" style="gap: 4px 14px">
                <span class="row" style="gap: 6px" role="status">
                  <span class="dot" :class="[statusOf(p).tone, { pulse: statusOf(p).pulse }]" />
                  {{ statusOf(p).text }}
                </span>
                <span>Modelo por defecto: <code v-if="p.defaultModel">{{ p.defaultModel }}</code><span v-else class="faint">sin definir</span></span>
                <span>{{ plural(agentCount.get(p.id) ?? 0, 'agente lo usa', 'agentes lo usan') }}</span>
              </div>
              <p v-if="statusOf(p).error" class="p-error small">{{ statusOf(p).error }}</p>
            </div>
            <div class="p-actions">
              <label class="row small muted" :title="p.enabled ? 'Desactivar proveedor' : 'Activar proveedor'">
                <input
                  type="checkbox"
                  class="switch"
                  :checked="p.enabled"
                  :disabled="busy.has(p.id)"
                  :aria-label="`${p.enabled ? 'Desactivar' : 'Activar'} ${p.name}`"
                  @change="toggleProvider(p)"
                />
              </label>
              <button class="btn btn-sm" type="button" :disabled="testing.has(p.id) || !p.enabled" @click="testProvider(p)">
                <LoaderCircle v-if="testing.has(p.id)" class="spin" /><PlugZap v-else /> Probar conexión
              </button>
              <button class="btn btn-sm btn-icon" type="button" :aria-label="`Editar ${p.name}`" title="Editar" @click="modal = { provider: p }">
                <Pencil />
              </button>
              <button
                class="btn btn-sm btn-icon btn-danger"
                type="button"
                :aria-label="`Eliminar ${p.name}`"
                title="Eliminar"
                :disabled="busy.has(p.id)"
                @click="removeProvider(p)"
              >
                <Trash2 />
              </button>
            </div>
          </li>
        </ul>
      </section>

      <!-- 2. Ejecución y seguridad -->
      <section class="card" aria-labelledby="sec-exec">
        <div class="card-head">
          <h2 id="sec-exec"><ShieldAlert style="width: 16px; height: 16px" /> Ejecución y seguridad</h2>
          <span v-if="savingSetting" class="small muted row"><LoaderCircle class="spin" style="width: 14px; height: 14px" /> Guardando…</span>
        </div>
        <div v-if="!settings" class="card-pad col">
          <div class="skeleton" style="height: 44px" />
          <div class="skeleton" style="height: 44px" />
          <div class="skeleton" style="height: 44px" />
        </div>
        <div v-else class="options">
          <div class="option">
            <div class="grow">
              <label class="o-title" for="set-concurrent">Ejecuciones simultáneas máximas</label>
              <p class="muted small">
                Límite de <Term id="concurrencia">concurrencia</Term> global: cuántas <Term id="ejecucion">ejecuciones</Term> pueden estar en marcha a
                la vez. El resto espera en cola. Con modelos locales, un valor bajo evita saturar el equipo.
              </p>
            </div>
            <input
              id="set-concurrent"
              v-model.number="concurrentDraft"
              class="input num"
              type="number"
              min="1"
              max="10"
              step="1"
              style="width: 84px"
              :disabled="savingSetting === 'maxConcurrentRuns'"
              @change="commitConcurrent"
            />
          </div>

          <div class="option">
            <div class="grow">
              <label class="o-title" for="set-private">Permitir redes privadas</label>
              <p class="muted small">
                Por defecto, las herramientas de red no pueden llamar a una <Term id="red-privada">red privada</Term> ni a localhost. Así, una web
                maliciosa que lea un agente no puede convencerlo de consultar tu router u otros servicios internos y filtrar lo que encuentre.
                Actívalo solo si necesitas que los agentes usen APIs de tu red local.
              </p>
            </div>
            <input
              id="set-private"
              type="checkbox"
              class="switch"
              :checked="settings.allowPrivateNetwork"
              :disabled="savingSetting === 'allowPrivateNetwork'"
              @change="togglePrivateNetwork"
            />
          </div>

          <div class="option">
            <div class="grow">
              <label class="o-title" for="set-code">Permitir ejecución de código</label>
              <p class="muted small">
                Habilita la herramienta <code>run_javascript</code>, que ejecuta el código que escribe el modelo en un
                <Term id="sandbox">entorno aislado</Term> sin acceso a red, disco ni módulos, con límites de tiempo y memoria.
              </p>
              <div v-if="settings.allowCodeExecution" class="callout warning" style="margin-top: 8px">
                <ShieldAlert />
                <span>
                  El aislamiento se basa en <code>node:vm</code>, que no es una barrera de seguridad fuerte: un código hostil podría llegar a
                  escapar. Mantenlo activado solo con modelos y entradas en los que confíes.
                </span>
              </div>
            </div>
            <input
              id="set-code"
              type="checkbox"
              class="switch"
              :checked="settings.allowCodeExecution"
              :disabled="savingSetting === 'allowCodeExecution'"
              @change="toggleCodeExecution"
            />
          </div>
        </div>
      </section>

      <div class="two">
        <!-- 3. Datos -->
        <section class="card" aria-labelledby="sec-data">
          <div class="card-head">
            <h2 id="sec-data"><Database style="width: 16px; height: 16px" /> Datos</h2>
            <button class="btn btn-ghost btn-sm btn-icon" type="button" aria-label="Actualizar cifras" title="Actualizar" :disabled="refreshingStats" @click="refreshStats">
              <RefreshCw :class="{ spin: refreshingStats }" />
            </button>
          </div>
          <div v-if="!stats" class="card-pad col">
            <div class="skeleton" style="height: 18px" />
            <div class="skeleton" style="height: 18px" />
            <div class="skeleton" style="height: 18px" />
          </div>
          <template v-else>
            <dl class="facts">
              <div><dt>Base de datos</dt><dd class="num">{{ formatBytes(stats.system.dbSizeBytes) }}</dd></div>
              <div><dt>Ejecuciones guardadas</dt><dd class="num">{{ formatNumber(stats.counts.runs) }}</dd></div>
              <div><dt>Terminadas</dt><dd class="num">{{ formatNumber(finishedRuns) }}</dd></div>
              <div class="wide"><dt>Carpeta de datos</dt><dd class="mono path" :title="stats.system.dataDir">{{ stats.system.dataDir }}</dd></div>
            </dl>
            <div class="card-foot">
              <p class="muted small grow">Borra el historial de ejecuciones completadas, fallidas y canceladas. Agentes y workflows no se tocan.</p>
              <button class="btn btn-danger" type="button" :disabled="clearing || !finishedRuns" @click="clearFinished">
                <LoaderCircle v-if="clearing" class="spin" /><Trash2 v-else /> Eliminar ejecuciones terminadas
              </button>
            </div>
          </template>
        </section>

        <!-- 4. Sistema -->
        <section class="card" aria-labelledby="sec-system">
          <div class="card-head">
            <h2 id="sec-system"><Cpu style="width: 16px; height: 16px" /> Sistema</h2>
          </div>
          <div v-if="!stats" class="card-pad col">
            <div class="skeleton" style="height: 18px" />
            <div class="skeleton" style="height: 18px" />
            <div class="skeleton" style="height: 18px" />
          </div>
          <dl v-else class="facts">
            <div><dt>Versión de AgentForge</dt><dd class="num">{{ stats.system.version }}</dd></div>
            <div><dt>Node.js</dt><dd class="num">{{ stats.system.nodeVersion }}</dd></div>
            <div><dt>Tiempo en marcha</dt><dd class="num">{{ formatUptime(stats.system.uptimeSec) }}</dd></div>
            <div><dt>Memoria del servidor</dt><dd class="num">{{ formatNumber(stats.system.memoryMb) }} MB</dd></div>
            <div class="wide"><dt>Plataforma</dt><dd>{{ stats.system.platform }}</dd></div>
          </dl>
        </section>
      </div>
    </div>

    <ProviderModal v-if="modal" :provider="modal.provider" @close="modal = null" @saved="onSaved" />
  </div>
</template>

<style scoped>
.sections {
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.intro {
  padding: 12px 20px 0;
  max-width: 80ch;
}
.providers {
  list-style: none;
  margin: 0;
  padding: 6px 0 0;
}
.providers li {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 20px;
  border-bottom: 1px solid var(--border);
}
.providers li:last-child {
  border-bottom: 0;
}
.providers li.off .p-name,
.providers li.off .p-url {
  color: var(--text-3);
}
.p-main {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
  flex: 1;
}
.p-name {
  font-size: 14.5px;
}
.p-url {
  color: var(--text-2);
}
.p-error {
  color: var(--danger);
  overflow-wrap: anywhere;
}
.p-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
}
.options {
  display: flex;
  flex-direction: column;
}
.option {
  display: flex;
  align-items: flex-start;
  gap: 20px;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border);
}
.option:last-child {
  border-bottom: 0;
}
.option p {
  max-width: 78ch;
  margin-top: 3px;
}
.option .switch {
  margin-top: 2px;
}
.o-title {
  font-weight: 600;
  cursor: pointer;
}
.two {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 18px;
  align-items: start;
}
.facts {
  margin: 0;
  padding: 6px 20px 10px;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  column-gap: 20px;
}
.facts > div {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 9px 0;
  border-bottom: 1px solid var(--border);
  min-width: 0;
}
.facts > div.wide {
  grid-column: 1 / -1;
  border-bottom: 0;
}
.facts dt {
  font-size: 12px;
  color: var(--text-3);
}
.facts dd {
  margin: 0;
  font-weight: 550;
  overflow-wrap: anywhere;
}
.facts .path {
  font-weight: 400;
}
.card-foot {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
  padding: 14px 20px;
  border-top: 1px solid var(--border);
  background: var(--surface-2);
  border-radius: 0 0 var(--radius-lg) var(--radius-lg);
}
.card-foot p {
  min-width: 200px;
}

@media (max-width: 900px) {
  .two {
    grid-template-columns: 1fr;
  }
}
@media (max-width: 720px) {
  .providers li {
    flex-direction: column;
    gap: 10px;
  }
  .p-actions {
    flex-wrap: wrap;
  }
  .option {
    gap: 12px;
  }
}
@media (max-width: 420px) {
  .facts {
    grid-template-columns: 1fr;
  }
}
</style>
