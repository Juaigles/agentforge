<script setup lang="ts">
import { Activity, Bot, BookOpen, LayoutDashboard, Monitor, Moon, Settings, Sun, Workflow, Wrench } from 'lucide-vue-next';
import { computed, onMounted, ref } from 'vue';
import { api, authRequired } from '@/lib/api';
import AccessGate from '@/components/AccessGate.vue';
import ApprovalsBanner from '@/components/ApprovalsBanner.vue';
import InterruptedBanner from '@/components/InterruptedBanner.vue';
import UiHost from '@/components/UiHost.vue';
import { useCatalog } from '@/stores/catalog';
import { useRuns } from '@/stores/runs';
import { useUi, type Theme } from '@/stores/ui';

const catalog = useCatalog();
const runs = useRuns();
const ui = useUi();

const NAV = [
  { to: '/', label: 'Panel', icon: LayoutDashboard, exact: true },
  { to: '/agents', label: 'Agentes', icon: Bot },
  { to: '/workflows', label: 'Workflows', icon: Workflow },
  { to: '/runs', label: 'Ejecuciones', icon: Activity },
  { to: '/tools', label: 'Herramientas', icon: Wrench },
  { to: '/settings', label: 'Ajustes', icon: Settings },
];

const THEMES: Array<{ value: Theme; label: string; icon: typeof Sun }> = [
  { value: 'light', label: 'Tema claro', icon: Sun },
  { value: 'system', label: 'Tema del sistema', icon: Monitor },
  { value: 'dark', label: 'Tema oscuro', icon: Moon },
];

const providerStatus = computed(() => {
  if (catalog.loadError) return { tone: 'danger', text: 'Servidor sin conexión' };
  if (!catalog.health.length) return { tone: '', text: catalog.providers.length ? 'Comprobando modelos…' : 'Sin proveedores' };
  const ok = catalog.health.filter((h) => h.ok).length;
  if (ok === catalog.health.length) return { tone: 'success', text: ok === 1 ? `${catalog.health[0].name} disponible` : `${ok} proveedores disponibles` };
  return { tone: 'danger', text: ok ? `${ok} de ${catalog.health.length} proveedores disponibles` : 'Proveedor no disponible' };
});

/** Hasta saber si el servidor exige clave no se pinta la aplicación (ni se abren flujos que serían rechazados). */
const ready = ref(false);

onMounted(async () => {
  try {
    const status = await api.auth.status();
    if (status.required && !status.authenticated) authRequired.value = true;
  } catch {
    /* sin conexión: la aplicación se muestra y cada vista informa del error */
  }
  ready.value = true;
  if (authRequired.value) return;
  runs.connect();
  try {
    await catalog.ensure();
    // Las ejecuciones que ya estaban en marcha al abrir la página también se siguen en vivo.
    const [running, queued, waiting] = await Promise.all([api.runs.list({ status: 'running' }), api.runs.list({ status: 'queued' }), api.runs.list({ status: 'waiting' })]);
    runs.seed([...running.items, ...queued.items, ...waiting.items]);
  } catch {
    /* el estado de conexión se muestra en la barra lateral y en cada vista */
  }
  void catalog.refreshHealth();
  setInterval(() => void catalog.refreshHealth(), 30_000);
});
</script>

<template>
  <AccessGate v-if="authRequired" />
  <div v-else-if="ready" class="shell">
    <aside class="sidebar">
      <RouterLink to="/" class="brand" aria-label="AgentForge, ir al panel">
        <svg viewBox="0 0 32 32" aria-hidden="true">
          <rect width="32" height="32" rx="8" fill="var(--accent)" />
          <path d="M9 22l5-12 3 6 2-3 4 9z" fill="var(--accent-text)" />
          <circle cx="22" cy="10" r="2.2" fill="var(--accent-text)" opacity="0.7" />
        </svg>
        <span>AgentForge</span>
      </RouterLink>

      <nav aria-label="Principal">
        <RouterLink v-for="item in NAV" :key="item.to" :to="item.to" class="nav-item" :class="{ exact: item.exact }" :aria-label="item.label" :title="item.label">
          <component :is="item.icon" aria-hidden="true" />
          <span>{{ item.label }}</span>
          <span v-if="item.to === '/runs' && runs.active.length" class="count" :title="`${runs.active.length} en curso`">{{ runs.active.length }}</span>
        </RouterLink>
      </nav>

      <div class="sidebar-foot">
        <RouterLink to="/glosario" class="nav-item subtle" aria-label="Glosario" title="Glosario"><BookOpen aria-hidden="true" /><span>Glosario</span></RouterLink>
        <RouterLink to="/settings" class="status" :title="providerStatus.text">
          <span class="dot" :class="[providerStatus.tone, { pulse: !providerStatus.tone && catalog.providers.length > 0 }]" />
          <span class="truncate">{{ providerStatus.text }}</span>
        </RouterLink>
        <div class="themes" role="group" aria-label="Tema">
          <button
            v-for="t in THEMES"
            :key="t.value"
            type="button"
            :class="{ active: ui.theme === t.value }"
            :aria-label="t.label"
            :aria-pressed="ui.theme === t.value"
            :title="t.label"
            @click="ui.setTheme(t.value)"
          >
            <component :is="t.icon" />
          </button>
        </div>
      </div>
    </aside>

    <main class="main">
      <InterruptedBanner />
      <ApprovalsBanner />
      <RouterView v-slot="{ Component, route }">
        <component :is="Component" :key="route.meta.keyed ? route.fullPath : undefined" />
      </RouterView>
    </main>
    <UiHost />
  </div>
</template>

<style scoped>
.shell {
  display: grid;
  grid-template-columns: var(--sidebar-w) minmax(0, 1fr);
  height: 100%;
}
.sidebar {
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding: 16px 12px 12px;
  background: var(--surface);
  border-right: 1px solid var(--border);
  min-height: 0;
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 8px;
  color: var(--text);
  font-family: var(--font-display);
  font-size: 16px;
  font-weight: 700;
  letter-spacing: -0.01em;
}
.brand:hover {
  text-decoration: none;
}
.brand svg {
  width: 28px;
  height: 28px;
}
nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
}
.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 36px;
  padding: 0 10px;
  border-radius: 8px;
  color: var(--text-2);
  font-weight: 550;
}
.nav-item:hover {
  background: var(--surface-2);
  color: var(--text);
  text-decoration: none;
}
.nav-item svg {
  width: 17px;
  height: 17px;
  flex: none;
}
.nav-item.router-link-active:not(.exact),
.nav-item.router-link-exact-active {
  background: var(--accent-soft);
  color: var(--accent);
}
.nav-item.subtle {
  font-weight: 500;
  font-size: 13px;
}
.count {
  margin-left: auto;
  min-width: 20px;
  height: 20px;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--info);
  color: var(--surface);
  font-size: 11.5px;
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.sidebar-foot {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.status {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  color: var(--text-2);
  font-size: 12.5px;
}
.status:hover {
  text-decoration: none;
  border-color: var(--border-strong);
}
.themes {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 2px;
  padding: 3px;
  border-radius: 8px;
  background: var(--surface-2);
}
.themes button {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 26px;
  border: 0;
  border-radius: 6px;
  background: none;
  color: var(--text-3);
  cursor: pointer;
}
.themes button.active {
  background: var(--surface);
  color: var(--text);
  box-shadow: var(--shadow-sm);
}
.themes svg {
  width: 14px;
  height: 14px;
}
.main {
  min-width: 0;
  overflow-y: auto;
}

@media (max-width: 860px) {
  .shell {
    grid-template-columns: 1fr;
    grid-template-rows: auto minmax(0, 1fr);
  }
  .sidebar {
    flex-direction: row;
    align-items: center;
    gap: 6px;
    padding: 8px 10px;
    border-right: 0;
    border-bottom: 1px solid var(--border);
    overflow-x: auto;
  }
  .brand span,
  .sidebar-foot .status,
  .sidebar-foot .themes,
  .nav-item.subtle span {
    display: none;
  }
  nav {
    flex-direction: row;
  }
  .nav-item {
    padding: 0 9px;
  }
  .nav-item span:not(.count) {
    display: none;
  }
  .sidebar-foot {
    flex-direction: row;
  }
}
</style>
