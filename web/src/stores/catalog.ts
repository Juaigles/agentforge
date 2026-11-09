// Catálogo: proveedores, agentes, herramientas y workflows. Se carga una vez y se mantiene al día tras cada cambio.
import type { Agent, Provider, ProviderHealth, ToolInfo, Workflow } from '@shared/types';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { api } from '@/lib/api';

export const useCatalog = defineStore('catalog', () => {
  const providers = ref<Provider[]>([]);
  const agents = ref<Agent[]>([]);
  const tools = ref<ToolInfo[]>([]);
  const workflows = ref<Workflow[]>([]);
  const health = ref<ProviderHealth[]>([]);
  const loaded = ref(false);
  const loadError = ref<string | null>(null);
  let loading: Promise<void> | null = null;

  async function reload(): Promise<void> {
    try {
      const [p, a, t, w] = await Promise.all([api.providers.list(), api.agents.list(), api.tools.list(), api.workflows.list()]);
      providers.value = p;
      agents.value = a;
      tools.value = t;
      workflows.value = w;
      loaded.value = true;
      loadError.value = null;
    } catch (err) {
      loadError.value = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  /** Carga el catálogo si aún no está cargado (las llamadas simultáneas comparten la misma petición). */
  function ensure(): Promise<void> {
    if (loaded.value) return Promise.resolve();
    loading ??= reload().finally(() => (loading = null));
    return loading;
  }

  async function refreshHealth(force = false): Promise<void> {
    try {
      health.value = await api.providers.health(force);
    } catch {
      /* el aviso de conexión ya lo muestra la carga del catálogo */
    }
  }

  const agentById = computed(() => new Map(agents.value.map((a) => [a.id, a])));
  const providerById = computed(() => new Map(providers.value.map((p) => [p.id, p])));
  const toolByName = computed(() => new Map(tools.value.map((t) => [t.name, t])));
  const healthById = computed(() => new Map(health.value.map((h) => [h.providerId, h])));
  const enabledToolNames = computed(() => tools.value.filter((t) => t.enabled).map((t) => t.name));

  function upsert<T extends { id: string }>(list: T[], item: T): T[] {
    const i = list.findIndex((x) => x.id === item.id);
    return i >= 0 ? list.map((x) => (x.id === item.id ? item : x)) : [...list, item];
  }
  const setAgent = (a: Agent) => (agents.value = upsert(agents.value, a));
  const dropAgent = (id: string) => (agents.value = agents.value.filter((a) => a.id !== id));
  const setWorkflow = (w: Workflow) => (workflows.value = upsert(workflows.value, w));
  const dropWorkflow = (id: string) => (workflows.value = workflows.value.filter((w) => w.id !== id));
  const setProvider = (p: Provider) => (providers.value = upsert(providers.value, p));
  const dropProvider = (id: string) => (providers.value = providers.value.filter((p) => p.id !== id));
  const reloadTools = async () => (tools.value = await api.tools.list());

  return {
    providers,
    agents,
    tools,
    workflows,
    health,
    loaded,
    loadError,
    reload,
    ensure,
    refreshHealth,
    agentById,
    providerById,
    toolByName,
    healthById,
    enabledToolNames,
    setAgent,
    dropAgent,
    setWorkflow,
    dropWorkflow,
    setProvider,
    dropProvider,
    reloadTools,
  };
});
