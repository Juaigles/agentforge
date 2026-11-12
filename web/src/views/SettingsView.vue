<script setup lang="ts">
import type { BackupInfo, BackupState, DashboardStats, Provider, ProviderTestResult, SandboxStatus, Settings } from '@shared/types';
import {
  Archive,
  CircleAlert,
  Cpu,
  Database,
  Download,
  History,
  KeyRound,
  LoaderCircle,
  Pencil,
  PlugZap,
  Plus,
  RefreshCw,
  Server,
  ShieldAlert,
  Trash2,
  Upload,
} from 'lucide-vue-next';
import { computed, onMounted, reactive, ref } from 'vue';
import ProviderModal from '@/components/ProviderModal.vue';
import Term from '@/components/Term.vue';
import { api, errorText } from '@/lib/api';
import { t, tn } from '@/i18n';
import { formatBytes, formatDateTime, formatDuration, formatNumber, formatUptime } from '@/lib/format';
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
    retentionDaysDraft.value = s.retentionDays;
    retentionRunsDraft.value = s.retentionMaxRuns;
    void catalog.refreshHealth();
    if (s.allowCodeExecution) void loadSandbox();
    void loadBackups();
  } catch (err) {
    loadError.value = errorText(err);
  } finally {
    loading.value = false;
  }
}
onMounted(load);

// ---------- Proveedores ----------
const kindLabel = (kind: Provider['kind']): string => (kind === 'ollama' ? 'Ollama' : t('settings.providers.kindOpenai'));
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
  if (!p.enabled) return { tone: '', text: t('settings.providers.status.disabled') };
  if (testing.has(p.id)) return { tone: 'info', text: t('settings.providers.status.testing'), pulse: true };
  const r = testResults.get(p.id) ?? catalog.healthById.get(p.id);
  if (!r) return { tone: '', text: t('settings.providers.status.checking'), pulse: true };
  if (r.ok) return { tone: 'success', text: t('settings.providers.status.available', { models: tn('settings.counts.models', r.modelCount ?? 0), latency: formatDuration(r.latencyMs) }) };
  return { tone: 'danger', text: t('settings.providers.status.unavailable'), error: r.error ?? t('settings.providers.status.connectFailed') };
}

async function testProvider(p: Provider): Promise<void> {
  testing.add(p.id);
  try {
    const result = await api.providers.test(p.id);
    testResults.set(p.id, result);
    if (result.ok) ui.success(t('settings.providers.toast.responds', { name: p.name, models: tn('settings.counts.models', result.modelCount ?? 0), latency: formatDuration(result.latencyMs) }));
    else ui.error(t('settings.providers.toast.noResponse', { name: p.name, error: result.error ?? t('settings.providers.toast.unknownError') }));
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
    ui.success(saved.enabled ? t('settings.providers.toast.enabled', { name: saved.name }) : t('settings.providers.toast.disabled', { name: saved.name }));
    await catalog.refreshHealth(true);
  } catch (err) {
    ui.error(errorText(err));
  } finally {
    busy.delete(p.id);
  }
}

async function removeProvider(p: Provider): Promise<void> {
  const ok = await ui.confirm({
    title: t('settings.providers.confirm.deleteTitle'),
    message: t('settings.providers.confirm.deleteMessage', { name: p.name }),
    confirmLabel: t('common.actions.delete'),
    danger: true,
  });
  if (!ok) return;
  busy.add(p.id);
  try {
    await api.providers.remove(p.id);
    catalog.dropProvider(p.id);
    testResults.delete(p.id);
    ui.success(t('settings.providers.toast.deleted', { name: p.name }));
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
    retentionDaysDraft.value = settings.value.retentionDays;
    retentionRunsDraft.value = settings.value.retentionMaxRuns;
    savingSetting.value = null;
  }
}

// ---------- Retención del historial ----------
const retentionDaysDraft = ref(0);
const retentionRunsDraft = ref(0);

async function commitRetention(key: 'retentionDays' | 'retentionMaxRuns', max: number): Promise<void> {
  const draft = key === 'retentionDays' ? retentionDaysDraft : retentionRunsDraft;
  const n = draft.value === ('' as unknown) ? 0 : Math.round(Number(draft.value));
  if (!Number.isFinite(n) || n < 0 || n > max) {
    ui.error(t('settings.data.retentionInvalid', { max: formatNumber(max) }));
    draft.value = settings.value?.[key] ?? 0;
    return;
  }
  const message =
    key === 'retentionDays'
      ? n
        ? t('settings.data.retentionDays.on', { days: tn('settings.counts.days', n) })
        : t('settings.data.retentionDays.off')
      : n
        ? t('settings.data.retentionRuns.on', { runs: tn('settings.counts.finishedRuns', n) })
        : t('settings.data.retentionRuns.off');
  await updateSetting(key, n, message);
  // La retención se aplica al guardar: las cifras de la tarjeta pueden haber cambiado.
  await refreshStats();
}

function commitConcurrent(): void {
  const n = Math.round(Number(concurrentDraft.value));
  if (!Number.isFinite(n) || n < 1 || n > 10) {
    ui.error(t('settings.exec.concurrent.invalid'));
    concurrentDraft.value = settings.value?.maxConcurrentRuns ?? 3;
    return;
  }
  void updateSetting('maxConcurrentRuns', n, t('settings.exec.concurrent.saved', { count: n }));
}

async function togglePrivateNetwork(ev: Event): Promise<void> {
  const input = ev.target as HTMLInputElement;
  const next = input.checked;
  if (next) {
    const ok = await ui.confirm({
      title: t('settings.exec.privateNetwork.confirmTitle'),
      message: t('settings.exec.privateNetwork.confirmMessage'),
      confirmLabel: t('settings.exec.privateNetwork.confirmLabel'),
      danger: true,
    });
    if (!ok) {
      input.checked = false;
      return;
    }
  }
  await updateSetting('allowPrivateNetwork', next, next ? t('settings.exec.privateNetwork.on') : t('settings.exec.privateNetwork.off'));
  input.checked = settings.value?.allowPrivateNetwork ?? false;
}

async function toggleCodeExecution(ev: Event): Promise<void> {
  const input = ev.target as HTMLInputElement;
  const next = input.checked;
  if (next) {
    const ok = await ui.confirm({
      title: t('settings.exec.code.confirmTitle'),
      message: t('settings.exec.code.confirmMessage'),
      confirmLabel: t('settings.exec.code.confirmLabel'),
      danger: true,
    });
    if (!ok) {
      input.checked = false;
      return;
    }
  }
  await updateSetting('allowCodeExecution', next, next ? t('settings.exec.code.on') : t('settings.exec.code.off'));
  input.checked = settings.value?.allowCodeExecution ?? false;
  if (settings.value?.allowCodeExecution) void loadSandbox();
}

async function toggleAutoResume(ev: Event): Promise<void> {
  const input = ev.target as HTMLInputElement;
  await updateSetting(
    'autoResume',
    input.checked,
    input.checked ? t('settings.exec.autoResume.on') : t('settings.exec.autoResume.off'),
  );
  input.checked = settings.value?.autoResume ?? false;
}

// Estado real del aislamiento (lo comprueba el servidor: red del proceso y motor de contenedores).
const sandbox = ref<SandboxStatus | null>(null);
const sandboxLoading = ref(false);

async function loadSandbox(force = false): Promise<void> {
  sandboxLoading.value = true;
  try {
    sandbox.value = await api.sandboxStatus(force);
  } catch (err) {
    ui.error(errorText(err));
  } finally {
    sandboxLoading.value = false;
  }
}

const ENGINE_LABEL = { docker: 'Docker', podman: 'Podman' } as const;

async function chooseSandbox(backend: Settings['codeSandbox']): Promise<void> {
  await updateSetting('codeSandbox', backend, backend === 'container' ? t('settings.exec.sandbox.toastContainer') : t('settings.exec.sandbox.toastProcess'));
  void loadSandbox(true);
}

// ---------- Copias de seguridad ----------
const backups = ref<BackupState | null>(null);
const backupBusy = ref<string | null>(null);
const uploadInput = ref<HTMLInputElement | null>(null);

async function loadBackups(): Promise<void> {
  try {
    backups.value = await api.backups.state();
  } catch (err) {
    ui.error(errorText(err));
  }
}

async function createBackup(): Promise<void> {
  backupBusy.value = 'create';
  try {
    const backup = await api.backups.create();
    ui.success(t('settings.backups.toast.created', { size: formatBytes(backup.sizeBytes) }));
    await loadBackups();
  } catch (err) {
    ui.error(errorText(err));
  } finally {
    backupBusy.value = null;
  }
}

async function uploadBackup(ev: Event): Promise<void> {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  backupBusy.value = 'upload';
  try {
    await api.backups.upload(file);
    ui.success(t('settings.backups.toast.uploaded'));
    await loadBackups();
  } catch (err) {
    ui.error(errorText(err));
  } finally {
    backupBusy.value = null;
  }
}

function backupSummary(backup: BackupInfo): string {
  const c = backup.manifest?.counts;
  if (!c) return t('settings.backups.unreadable');
  return t('settings.backups.summary', {
    agents: tn('settings.counts.agents', c.agents),
    workflows: tn('settings.counts.workflows', c.workflows),
    runs: tn('settings.counts.runs', c.runs),
    files: tn('settings.counts.files', c.workspaceFiles),
  });
}

async function restoreBackup(backup: BackupInfo): Promise<void> {
  const ok = await ui.confirm({
    title: t('settings.backups.confirm.restoreTitle'),
    message: t('settings.backups.confirm.restoreMessage', { date: formatDateTime(backup.createdAt) }),
    confirmLabel: t('settings.backups.confirm.restoreLabel'),
    danger: true,
  });
  if (!ok) return;
  backupBusy.value = backup.name;
  try {
    await api.backups.restore(backup.name);
    ui.success(t('settings.backups.toast.restorePrepared'));
    await loadBackups();
  } catch (err) {
    ui.error(errorText(err));
  } finally {
    backupBusy.value = null;
  }
}

async function cancelRestore(): Promise<void> {
  backupBusy.value = 'cancel';
  try {
    await api.backups.cancelRestore();
    ui.success(t('settings.backups.toast.restoreCancelled'));
    await loadBackups();
  } catch (err) {
    ui.error(errorText(err));
  } finally {
    backupBusy.value = null;
  }
}

async function removeBackup(backup: BackupInfo): Promise<void> {
  const ok = await ui.confirm({
    title: t('settings.backups.confirm.deleteTitle'),
    message: t('settings.backups.confirm.deleteMessage', { date: formatDateTime(backup.createdAt) }),
    confirmLabel: t('settings.backups.confirm.deleteLabel'),
    danger: true,
  });
  if (!ok) return;
  backupBusy.value = backup.name;
  try {
    await api.backups.remove(backup.name);
    ui.success(t('settings.backups.toast.deleted'));
    await loadBackups();
  } catch (err) {
    ui.error(errorText(err));
  } finally {
    backupBusy.value = null;
  }
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
    title: t('settings.data.deleteFinished'),
    message: t('settings.data.confirmMessage', { runs: tn('settings.counts.finishedRuns', finishedRuns.value) }),
    confirmLabel: t('common.actions.delete'),
    danger: true,
  });
  if (!ok) return;
  clearing.value = true;
  try {
    const { deleted } = await api.runs.clearFinished();
    ui.success(deleted ? tn('settings.data.runsDeleted', deleted) : t('settings.data.noneFinished'));
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
        <h1>{{ t('settings.title') }}</h1>
        <i18n-t keypath="settings.subtitle" tag="p" class="subtitle" scope="global">
          <template #models><Term id="modelo">{{ t('settings.subtitleModels') }}</Term></template>
        </i18n-t>
      </div>
    </header>

    <div v-if="loadError" class="callout danger" role="alert" style="margin-bottom: 16px">
      <CircleAlert />
      <span class="grow">{{ loadError }}</span>
      <button class="btn btn-sm" type="button" :disabled="loading" @click="load"><RefreshCw :class="{ spin: loading }" /> {{ t('common.actions.retry') }}</button>
    </div>

    <div class="sections">
      <!-- 1. Proveedores -->
      <section class="card" aria-labelledby="sec-providers">
        <div class="card-head">
          <h2 id="sec-providers"><Server style="width: 16px; height: 16px" /> {{ t('settings.providers.title') }}</h2>
          <button class="btn btn-primary btn-sm" type="button" @click="modal = { provider: null }"><Plus /> {{ t('settings.providers.add') }}</button>
        </div>
        <i18n-t keypath="settings.providers.intro" tag="p" class="intro muted small" scope="global">
          <template #provider><Term id="proveedor">{{ t('settings.providers.introProvider') }}</Term></template>
          <template #ollama><Term id="ollama" /></template>
          <template #openai><Term id="openai-compatible">{{ t('settings.providers.introOpenai') }}</Term></template>
          <template #agent><Term id="agente">{{ t('settings.providers.introAgent') }}</Term></template>
        </i18n-t>

        <div v-if="loading && !catalog.loaded" class="card-pad col">
          <div class="skeleton" style="height: 64px" />
          <div class="skeleton" style="height: 64px" />
        </div>
        <div v-else-if="!catalog.providers.length" class="empty">
          <Server />
          <h3>{{ t('settings.providers.emptyTitle') }}</h3>
          <p>{{ t('settings.providers.emptyText') }}</p>
          <button class="btn btn-primary" type="button" @click="modal = { provider: null }"><Plus /> {{ t('settings.providers.add') }}</button>
        </div>
        <ul v-else class="providers">
          <li v-for="p in catalog.providers" :key="p.id" :class="{ off: !p.enabled }">
            <div class="p-main">
              <div class="row wrap" style="gap: 8px">
                <strong class="p-name">{{ p.name }}</strong>
                <span class="badge" :class="p.kind === 'ollama' ? 'accent' : 'info'">{{ kindLabel(p.kind) }}</span>
                <span v-if="p.hasApiKey" class="badge" :title="t('settings.providers.keyStoredTitle')"><KeyRound /> {{ t('settings.providers.keyStored') }}</span>
              </div>
              <div class="p-url mono truncate" :title="p.baseUrl">{{ p.baseUrl }}</div>
              <div class="row wrap small muted" style="gap: 4px 14px">
                <span class="row" style="gap: 6px" role="status">
                  <span class="dot" :class="[statusOf(p).tone, { pulse: statusOf(p).pulse }]" />
                  {{ statusOf(p).text }}
                </span>
                <span>{{ t('settings.providers.defaultModel') }} <code v-if="p.defaultModel">{{ p.defaultModel }}</code><span v-else class="faint">{{ t('settings.providers.noDefaultModel') }}</span></span>
                <span>{{ tn('settings.counts.agentsUse', agentCount.get(p.id) ?? 0) }}</span>
              </div>
              <p v-if="statusOf(p).error" class="p-error small">{{ statusOf(p).error }}</p>
            </div>
            <div class="p-actions">
              <label class="row small muted" :title="p.enabled ? t('settings.providers.disable') : t('settings.providers.enable')">
                <input
                  type="checkbox"
                  class="switch"
                  :checked="p.enabled"
                  :disabled="busy.has(p.id)"
                  :aria-label="p.enabled ? t('settings.providers.disableNamed', { name: p.name }) : t('settings.providers.enableNamed', { name: p.name })"
                  @change="toggleProvider(p)"
                />
              </label>
              <button class="btn btn-sm" type="button" :disabled="testing.has(p.id) || !p.enabled" @click="testProvider(p)">
                <LoaderCircle v-if="testing.has(p.id)" class="spin" /><PlugZap v-else /> {{ t('settings.providers.test') }}
              </button>
              <button class="btn btn-sm btn-icon" type="button" :aria-label="t('settings.providers.editNamed', { name: p.name })" :title="t('common.actions.edit')" @click="modal = { provider: p }">
                <Pencil />
              </button>
              <button
                class="btn btn-sm btn-icon btn-danger"
                type="button"
                :aria-label="t('settings.providers.deleteNamed', { name: p.name })"
                :title="t('common.actions.delete')"
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
          <h2 id="sec-exec"><ShieldAlert style="width: 16px; height: 16px" /> {{ t('settings.exec.title') }}</h2>
          <span v-if="savingSetting" class="small muted row"><LoaderCircle class="spin" style="width: 14px; height: 14px" /> {{ t('common.actions.saving') }}</span>
        </div>
        <div v-if="!settings" class="card-pad col">
          <div class="skeleton" style="height: 44px" />
          <div class="skeleton" style="height: 44px" />
          <div class="skeleton" style="height: 44px" />
        </div>
        <div v-else class="options">
          <div class="option">
            <div class="grow">
              <label class="o-title" for="set-concurrent">{{ t('settings.exec.concurrent.label') }}</label>
              <i18n-t keypath="settings.exec.concurrent.description" tag="p" class="muted small" scope="global">
                <template #concurrency><Term id="concurrencia">{{ t('settings.exec.concurrent.concurrency') }}</Term></template>
                <template #runs><Term id="ejecucion">{{ t('settings.exec.concurrent.runs') }}</Term></template>
                <template #queue><Term id="cola">{{ t('settings.exec.concurrent.queue') }}</Term></template>
              </i18n-t>
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
              <label class="o-title" for="set-autoresume">{{ t('settings.exec.autoResume.label') }}</label>
              <i18n-t keypath="settings.exec.autoResume.description" tag="p" class="muted small" scope="global">
                <template #runs><Term id="ejecucion">{{ t('settings.exec.autoResume.runs') }}</Term></template>
                <template #approval><Term id="aprobacion">{{ t('settings.exec.autoResume.approval') }}</Term></template>
              </i18n-t>
            </div>
            <input id="set-autoresume" type="checkbox" class="switch" :checked="settings.autoResume" :disabled="savingSetting === 'autoResume'" @change="toggleAutoResume" />
          </div>

          <div class="option">
            <div class="grow">
              <label class="o-title" for="set-private">{{ t('settings.exec.privateNetwork.label') }}</label>
              <i18n-t keypath="settings.exec.privateNetwork.description" tag="p" class="muted small" scope="global">
                <template #privateNetwork><Term id="red-privada">{{ t('settings.exec.privateNetwork.privateNetworkTerm') }}</Term></template>
                <template #apis><Term id="api">{{ t('settings.exec.privateNetwork.apis') }}</Term></template>
              </i18n-t>
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
              <label class="o-title" for="set-code">{{ t('settings.exec.code.label') }}</label>
              <i18n-t keypath="settings.exec.code.description" tag="p" class="muted small" scope="global">
                <template #tool><code>run_javascript</code></template>
                <template #sandbox><Term id="sandbox">{{ t('settings.exec.code.sandboxTerm') }}</Term></template>
              </i18n-t>
              <div v-if="settings.allowCodeExecution" class="sandbox" data-testid="sandbox-options">
                <div class="sandbox-head">
                  <span id="sandbox-label" class="o-title">{{ t('settings.exec.sandbox.where') }}</span>
                  <button class="btn btn-ghost btn-sm" type="button" :disabled="sandboxLoading" @click="loadSandbox(true)">
                    <RefreshCw :class="{ spin: sandboxLoading }" /> {{ t('settings.exec.sandbox.recheck') }}
                  </button>
                </div>
                <div class="sandbox-choices" role="radiogroup" aria-labelledby="sandbox-label">
                  <label class="sandbox-choice" :class="{ active: settings.codeSandbox === 'process' }">
                    <input type="radio" name="code-sandbox" value="process" :checked="settings.codeSandbox === 'process'" :disabled="savingSetting === 'codeSandbox'" @change="chooseSandbox('process')" />
                    <span class="grow">
                      <strong>{{ t('settings.exec.sandbox.processTitle') }}</strong>
                      <i18n-t keypath="settings.exec.sandbox.processText" tag="span" class="muted small" scope="global">
                        <template #node><Term id="nodejs">Node.js</Term></template>
                      </i18n-t>
                      <span v-if="sandbox" class="sandbox-status small" role="status">
                        <template v-if="sandbox.process.networkBlocked">
                          <span class="dot success" aria-hidden="true" /> {{ t('settings.exec.sandbox.processNoNetwork') }}
                        </template>
                        <template v-else>
                          <span class="dot danger" aria-hidden="true" /> {{ t('settings.exec.sandbox.processNetworkOpen') }}
                        </template>
                      </span>
                    </span>
                  </label>
                  <label class="sandbox-choice" :class="{ active: settings.codeSandbox === 'container', unavailable: sandbox && !sandbox.container.available }">
                    <input
                      type="radio"
                      name="code-sandbox"
                      value="container"
                      :checked="settings.codeSandbox === 'container'"
                      :disabled="savingSetting === 'codeSandbox' || !sandbox?.container.available"
                      @change="chooseSandbox('container')"
                    />
                    <span class="grow">
                      <strong>{{ t('settings.exec.sandbox.containerTitle') }}</strong>
                      <i18n-t keypath="settings.exec.sandbox.containerText" tag="span" class="muted small" scope="global">
                        <template #container><Term id="contenedor">{{ t('settings.exec.sandbox.containerTerm') }}</Term></template>
                      </i18n-t>
                      <span v-if="sandbox" class="sandbox-status small" role="status">
                        <template v-if="sandbox.container.available">
                          <span class="dot success" aria-hidden="true" /> {{ t('settings.exec.sandbox.engineAvailable', { engine: ENGINE_LABEL[sandbox.container.engine!], version: sandbox.container.version }) }}
                        </template>
                        <template v-else><span class="dot" aria-hidden="true" /> {{ t('settings.exec.sandbox.containerUnavailable', { error: sandbox.container.error }) }}</template>
                      </span>
                      <span v-else class="sandbox-status small muted">{{ t('settings.providers.status.checking') }}</span>
                    </span>
                  </label>
                </div>
                <div v-if="settings.codeSandbox === 'process'" class="callout warning">
                  <ShieldAlert />
                  <span>{{ t('settings.exec.sandbox.warning') }}</span>
                </div>
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

      <!-- Copias de seguridad -->
      <section class="card" aria-labelledby="sec-backups">
        <div class="card-head backups-head">
          <h2 id="sec-backups"><Archive style="width: 16px; height: 16px" /> {{ t('settings.backups.title') }}</h2>
          <div class="row" style="gap: 8px; flex-wrap: wrap">
            <input ref="uploadInput" type="file" accept=".afbackup" class="sr-only" :aria-label="t('settings.backups.fileInputLabel')" tabindex="-1" @change="uploadBackup" />
            <button class="btn btn-sm" type="button" :disabled="backupBusy !== null" @click="uploadInput?.click()">
              <LoaderCircle v-if="backupBusy === 'upload'" class="spin" /><Upload v-else /> {{ t('settings.backups.addFromFile') }}
            </button>
            <button class="btn btn-primary btn-sm" type="button" :disabled="backupBusy !== null" @click="createBackup">
              <LoaderCircle v-if="backupBusy === 'create'" class="spin" /><Plus v-else /> {{ t('settings.backups.create') }}
            </button>
          </div>
        </div>
        <div class="card-pad col" style="gap: 12px">
          <i18n-t keypath="settings.backups.description" tag="p" class="muted small" style="margin: 0" scope="global">
            <template #backup><Term id="copia-seguridad">{{ t('settings.backups.descriptionBackup') }}</Term></template>
            <template #database><Term id="base-datos">{{ t('settings.backups.descriptionDatabase') }}</Term></template>
          </i18n-t>
          <div v-if="backups?.pending" class="callout warning" role="status">
            <History />
            <i18n-t keypath="settings.backups.pending" tag="span" class="grow" scope="global">
              <template #title><strong>{{ t('settings.backups.pendingTitle') }}</strong></template>
              <template #date>{{ formatDateTime(backups.pending.manifest.createdAt) }}</template>
            </i18n-t>
            <button class="btn btn-sm" type="button" :disabled="backupBusy !== null" @click="cancelRestore">{{ t('settings.backups.cancelRestore') }}</button>
          </div>
          <div v-else-if="backups?.lastRestore" class="callout" role="status">
            <History />
            <i18n-t keypath="settings.backups.lastRestore" tag="span" class="restore-note" scope="global">
              <template #created>{{ formatDateTime(backups.lastRestore.manifest.createdAt) }}</template>
              <template #applied>{{ formatDateTime(backups.lastRestore.appliedAt) }}</template>
              <template #dir><code>{{ backups.lastRestore.replacedDir }}</code></template>
            </i18n-t>
          </div>
          <div v-if="!backups" class="skeleton" style="height: 44px" />
          <p v-else-if="!backups.backups.length" class="muted" style="margin: 0">{{ t('settings.backups.none') }}</p>
          <ul v-else class="backup-list" :aria-label="t('settings.backups.listLabel')">
            <li v-for="backup in backups.backups" :key="backup.name" class="backup">
              <div class="grow" style="min-width: 0">
                <div class="backup-title">
                  {{ formatDateTime(backup.createdAt) }}
                  <span v-if="backup.name.includes('importada')" class="badge neutral">{{ t('settings.backups.added') }}</span>
                  <span class="muted small num">{{ formatBytes(backup.sizeBytes) }}</span>
                </div>
                <div class="muted small">{{ backupSummary(backup) }}</div>
              </div>
              <div class="row" style="gap: 6px; flex-wrap: wrap">
                <a class="btn btn-sm" :href="api.backups.downloadUrl(backup.name)" :download="backup.name"><Download /> {{ t('settings.backups.download') }}</a>
                <button class="btn btn-sm" type="button" :disabled="backupBusy !== null || !backup.manifest" @click="restoreBackup(backup)">
                  <LoaderCircle v-if="backupBusy === backup.name" class="spin" /><History v-else /> {{ t('settings.backups.restore') }}
                </button>
                <button
                  class="btn btn-ghost btn-sm btn-icon"
                  type="button"
                  :aria-label="t('settings.backups.deleteDated', { date: formatDateTime(backup.createdAt) })"
                  :title="t('common.actions.delete')"
                  :disabled="backupBusy !== null"
                  @click="removeBackup(backup)"
                >
                  <Trash2 />
                </button>
              </div>
            </li>
          </ul>
        </div>
      </section>

      <div class="two">
        <!-- 3. Datos -->
        <section class="card" aria-labelledby="sec-data">
          <div class="card-head">
            <h2 id="sec-data"><Database style="width: 16px; height: 16px" /> {{ t('settings.data.title') }}</h2>
            <button class="btn btn-ghost btn-sm btn-icon" type="button" :aria-label="t('settings.data.refreshLabel')" :title="t('common.actions.refresh')" :disabled="refreshingStats" @click="refreshStats">
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
              <div><dt><Term id="base-datos">{{ t('settings.data.database') }}</Term></dt><dd class="num">{{ formatBytes(stats.system.dbSizeBytes) }}</dd></div>
              <div><dt>{{ t('settings.data.savedRuns') }}</dt><dd class="num">{{ formatNumber(stats.counts.runs) }}</dd></div>
              <div><dt>{{ t('settings.data.finished') }}</dt><dd class="num">{{ formatNumber(finishedRuns) }}</dd></div>
              <div class="wide"><dt>{{ t('settings.data.dataDir') }}</dt><dd class="mono path" :title="stats.system.dataDir">{{ stats.system.dataDir }}</dd></div>
            </dl>
            <div class="options retention">
              <div class="option">
                <div class="grow">
                  <label class="o-title" for="set-retention-days">{{ t('settings.data.retentionDays.label') }}</label>
                  <i18n-t keypath="settings.data.retentionDays.description" tag="p" class="muted small" scope="global">
                    <template #runs><Term id="ejecucion">{{ t('settings.data.retentionDays.runs') }}</Term></template>
                  </i18n-t>
                </div>
                <input
                  id="set-retention-days"
                  v-model.number="retentionDaysDraft"
                  class="input num"
                  type="number"
                  min="0"
                  max="3650"
                  step="1"
                  style="width: 92px"
                  :disabled="savingSetting === 'retentionDays'"
                  @change="commitRetention('retentionDays', 3650)"
                />
              </div>
              <div class="option">
                <div class="grow">
                  <label class="o-title" for="set-retention-runs">{{ t('settings.data.retentionRuns.label') }}</label>
                  <p class="muted small">{{ t('settings.data.retentionRuns.description') }}</p>
                </div>
                <input
                  id="set-retention-runs"
                  v-model.number="retentionRunsDraft"
                  class="input num"
                  type="number"
                  min="0"
                  max="100000"
                  step="1"
                  style="width: 92px"
                  :disabled="savingSetting === 'retentionMaxRuns'"
                  @change="commitRetention('retentionMaxRuns', 100000)"
                />
              </div>
            </div>
            <div class="card-foot">
              <p class="muted small grow">{{ t('settings.data.clearHint') }}</p>
              <button class="btn btn-danger" type="button" :disabled="clearing || !finishedRuns" @click="clearFinished">
                <LoaderCircle v-if="clearing" class="spin" /><Trash2 v-else /> {{ t('settings.data.deleteFinished') }}
              </button>
            </div>
          </template>
        </section>

        <!-- 4. Sistema -->
        <section class="card" aria-labelledby="sec-system">
          <div class="card-head">
            <h2 id="sec-system"><Cpu style="width: 16px; height: 16px" /> {{ t('settings.system.title') }}</h2>
          </div>
          <div v-if="!stats" class="card-pad col">
            <div class="skeleton" style="height: 18px" />
            <div class="skeleton" style="height: 18px" />
            <div class="skeleton" style="height: 18px" />
          </div>
          <dl v-else class="facts">
            <div><dt>{{ t('settings.system.version') }}</dt><dd class="num">{{ stats.system.version }}</dd></div>
            <div><dt><Term id="nodejs">Node.js</Term></dt><dd class="num">{{ stats.system.nodeVersion }}</dd></div>
            <div><dt>{{ t('settings.system.uptime') }}</dt><dd class="num">{{ formatUptime(stats.system.uptimeSec) }}</dd></div>
            <div><dt>{{ t('settings.system.memory') }}</dt><dd class="num">{{ formatNumber(stats.system.memoryMb) }} MB</dd></div>
            <div class="wide"><dt>{{ t('settings.system.platform') }}</dt><dd>{{ stats.system.platform }}</dd></div>
          </dl>
        </section>
      </div>
    </div>

    <ProviderModal v-if="modal" :provider="modal.provider" @close="modal = null" @saved="onSaved" />
  </div>
</template>

<style scoped>
/* En pantallas estrechas los dos botones bajan a su propia línea en lugar de empujar la página. */
.backups-head {
  flex-wrap: wrap;
  gap: 8px;
}
/* La ruta de la carpeta puede ser muy larga: se parte donde haga falta en lugar de ensanchar la página. */
.restore-note {
  min-width: 0;
  overflow-wrap: anywhere;
}
.backup-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.backup {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
}
.backup-title {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
  font-weight: 600;
}
.sandbox {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.sandbox-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}
.sandbox-choices {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr));
  gap: 10px;
}
.sandbox-choice {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 12px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  cursor: pointer;
}
.sandbox-choice.active {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.sandbox-choice.unavailable {
  cursor: default;
}
.sandbox-choice input {
  margin-top: 3px;
  accent-color: var(--accent);
}
.sandbox-choice .grow {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.sandbox-status {
  display: flex;
  align-items: baseline;
  gap: 6px;
  overflow-wrap: anywhere;
}

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
.retention {
  border-top: 1px solid var(--border);
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
