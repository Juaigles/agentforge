<script setup lang="ts">
import { Activity, Bot, BookOpen, LayoutDashboard, Monitor, Moon, Settings, Sun, Unplug, Workflow, Wrench } from 'lucide-vue-next';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { LOCALES, locale, setLocale, t, tn } from '@/i18n';
import { announce, announcement, installFormA11y } from '@/lib/a11y';
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
  { to: '/', labelKey: 'app.nav.dashboard', icon: LayoutDashboard, exact: true },
  { to: '/agents', labelKey: 'app.nav.agents', icon: Bot },
  { to: '/workflows', labelKey: 'app.nav.workflows', icon: Workflow },
  { to: '/runs', labelKey: 'app.nav.runs', icon: Activity },
  { to: '/tools', labelKey: 'app.nav.tools', icon: Wrench },
  { to: '/settings', labelKey: 'app.nav.settings', icon: Settings },
];

const THEMES: Array<{ value: Theme; labelKey: string; icon: typeof Sun }> = [
  { value: 'light', labelKey: 'app.theme.light', icon: Sun },
  { value: 'system', labelKey: 'app.theme.system', icon: Monitor },
  { value: 'dark', labelKey: 'app.theme.dark', icon: Moon },
];

const providerStatus = computed(() => {
  if (!catalog.online) return { tone: 'danger', text: t('app.status.offline') };
  if (catalog.loadError && !catalog.loaded) return { tone: 'danger', text: t('app.status.offline') };
  if (!catalog.health.length) return { tone: '', text: catalog.providers.length ? t('app.status.checking') : t('app.status.noProviders') };
  const ok = catalog.health.filter((h) => h.ok).length;
  if (ok === catalog.health.length)
    return { tone: 'success', text: ok === 1 ? t('app.status.oneAvailable', { name: catalog.health[0].name }) : tn('app.providersAvailable', ok) };
  return { tone: 'danger', text: ok ? t('app.status.someAvailable', { ok, total: catalog.health.length }) : t('app.status.unavailable') };
});

/** Hasta saber si el servidor exige clave no se pinta la aplicación (ni se abren flujos que serían rechazados). */
const ready = ref(false);

onMounted(async () => {
  installFormA11y();
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
    const [running, queued, waiting] = await Promise.all([
      api.runs.list({ status: 'running' }),
      api.runs.list({ status: 'queued' }),
      api.runs.list({ status: 'waiting' }),
    ]);
    runs.seed([...running.items, ...queued.items, ...waiting.items]);
  } catch {
    /* el estado de conexión se muestra en la barra lateral y en cada vista */
  }
  void catalog.refreshHealth();
  healthTimer = setInterval(() => void catalog.refreshHealth(), 30_000);
});

// ---------- Estado real de la conexión con el servidor ----------
// El canal de eventos se corta en cuanto el servidor cae: es la señal más rápida. Se confirma con una petición
// (un corte breve del canal no es una caída) y, mientras no responda, se reintenta cada pocos segundos.
let healthTimer: ReturnType<typeof setInterval> | undefined;
let retryTimer: ReturnType<typeof setInterval> | undefined;
watch(
  () => runs.connected,
  (connected, was) => {
    if (was && !connected) void catalog.checkServer();
  },
);
watch(
  () => catalog.online,
  (online) => {
    clearInterval(retryTimer);
    if (!online) {
      announce(t('app.offline.lost'));
      retryTimer = setInterval(() => void catalog.checkServer(), 3000);
      return;
    }
    announce(t('app.offline.restored'));
    ui.success(t('app.offline.restored'));
    // Lo que cambió mientras no había conexión no llegó por el canal de eventos: se vuelve a pedir.
    void catalog.reload().catch(() => undefined);
    void catalog.refreshHealth();
  },
);
onBeforeUnmount(() => {
  clearInterval(healthTimer);
  clearInterval(retryTimer);
});
</script>

<template>
  <AccessGate v-if="authRequired" />
  <div v-else-if="ready" class="shell">
    <a class="skip-link" href="#contenido">{{ t('app.skip') }}</a>
    <aside class="sidebar">
      <RouterLink to="/" class="brand" :aria-label="t('app.brand')">
        <svg viewBox="0 0 32 32" aria-hidden="true">
          <rect width="32" height="32" rx="8" fill="var(--accent)" />
          <path d="M9 22l5-12 3 6 2-3 4 9z" fill="var(--accent-text)" />
          <circle cx="22" cy="10" r="2.2" fill="var(--accent-text)" opacity="0.7" />
        </svg>
        <span>AgentForge</span>
      </RouterLink>

      <nav :aria-label="t('app.nav.label')">
        <RouterLink
          v-for="item in NAV"
          :key="item.to"
          :to="item.to"
          class="nav-item"
          :class="{ exact: item.exact }"
          :aria-label="t(item.labelKey)"
          :title="t(item.labelKey)"
        >
          <component :is="item.icon" aria-hidden="true" />
          <span>{{ t(item.labelKey) }}</span>
          <span v-if="item.to === '/runs' && runs.active.length" class="count" :title="tn('app.runningCount', runs.active.length)">{{
            runs.active.length
          }}</span>
        </RouterLink>
      </nav>

      <div class="sidebar-foot">
        <RouterLink to="/glosario" class="nav-item subtle" :aria-label="t('app.nav.glossary')" :title="t('app.nav.glossary')"
          ><BookOpen aria-hidden="true" /><span>{{ t('app.nav.glossary') }}</span></RouterLink
        >
        <RouterLink to="/settings" class="status" :title="providerStatus.text" :aria-label="t('app.status.label', { text: providerStatus.text })">
          <span class="dot" :class="[providerStatus.tone, { pulse: !providerStatus.tone && catalog.providers.length > 0 }]" />
          <span class="truncate">{{ providerStatus.text }}</span>
        </RouterLink>
        <div class="themes" role="group" :aria-label="t('app.theme.label')">
          <button
            v-for="theme in THEMES"
            :key="theme.value"
            type="button"
            :class="{ active: ui.theme === theme.value }"
            :aria-label="t(theme.labelKey)"
            :aria-pressed="ui.theme === theme.value"
            :title="t(theme.labelKey)"
            @click="ui.setTheme(theme.value)"
          >
            <component :is="theme.icon" />
          </button>
        </div>
        <div class="themes langs" role="group" :aria-label="t('app.language')">
          <button
            v-for="l in LOCALES"
            :key="l.value"
            type="button"
            :class="{ active: locale === l.value }"
            :aria-label="l.label"
            :aria-pressed="locale === l.value"
            :title="l.label"
            :lang="l.value"
            @click="setLocale(l.value)"
          >
            {{ l.short }}
          </button>
        </div>
      </div>
    </aside>

    <main id="contenido" class="main" tabindex="-1">
      <div v-if="!catalog.online" class="offline" role="alert" data-testid="offline">
        <Unplug aria-hidden="true" />
        <div class="grow">
          <strong>{{ t('app.offline.title') }}</strong>
          {{ t('app.offline.body') }}
        </div>
        <button class="btn btn-sm" type="button" @click="catalog.checkServer()">{{ t('app.offline.retry') }}</button>
      </div>
      <InterruptedBanner />
      <ApprovalsBanner />
      <RouterView v-slot="{ Component, route }">
        <component :is="Component" :key="route.meta.keyed ? route.fullPath : undefined" />
      </RouterView>
    </main>
    <UiHost />
    <!-- Mensajes de estado para lectores de pantalla (cambio de página, acciones del constructor, fin de una ejecución). -->
    <div class="sr-only" role="status" aria-live="polite" data-testid="announcer">{{ announcement }}</div>
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
.offline {
  position: sticky;
  top: 0;
  z-index: 40;
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 10px 16px;
  background: var(--danger-soft);
  color: var(--danger);
  border-bottom: 1px solid var(--danger);
  font-size: 13px;
}
.offline svg {
  width: 18px;
  height: 18px;
  flex: none;
}
.offline .grow {
  flex: 1 1 240px;
  min-width: 0;
}
.langs button {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
}
.main:focus {
  outline: none;
}
.skip-link {
  position: absolute;
  top: 8px;
  left: 8px;
  z-index: 500;
  padding: 8px 14px;
  border-radius: var(--radius);
  background: var(--accent);
  color: var(--accent-text);
  font-weight: 600;
  transform: translateY(-200%);
}
.skip-link:focus {
  transform: none;
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
  /* El estado del servidor y el selector de tema siguen disponibles en pantallas estrechas y con zoom al 200 %:
     el estado se reduce a su punto (el texto queda en el título del enlace). */
  .brand span,
  .sidebar-foot .status .truncate,
  .nav-item.subtle span {
    display: none;
  }
  .sidebar-foot .status {
    flex: none;
    padding: 0 8px;
    min-height: 30px;
    border: 0;
    background: none;
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
