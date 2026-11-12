import { nextTick, watch } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import { locale, t } from './i18n';
import { announce } from './lib/a11y';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: () => import('@/views/DashboardView.vue'), meta: { titleKey: 'app.titles.dashboard' } },
    { path: '/agents', component: () => import('@/views/AgentsView.vue'), meta: { titleKey: 'app.titles.agents' } },
    { path: '/agents/new', component: () => import('@/views/AgentEditorView.vue'), meta: { titleKey: 'app.titles.newAgent', keyed: true } },
    { path: '/agents/:id', component: () => import('@/views/AgentEditorView.vue'), meta: { titleKey: 'app.titles.agent', keyed: true } },
    { path: '/workflows', component: () => import('@/views/WorkflowsView.vue'), meta: { titleKey: 'app.titles.workflows' } },
    { path: '/workflows/new', component: () => import('@/views/WorkflowBuilderView.vue'), meta: { titleKey: 'app.titles.newWorkflow', keyed: true } },
    { path: '/workflows/:id', component: () => import('@/views/WorkflowBuilderView.vue'), meta: { titleKey: 'app.titles.workflow', keyed: true } },
    { path: '/runs', component: () => import('@/views/RunsView.vue'), meta: { titleKey: 'app.titles.runs' } },
    { path: '/runs/:id', component: () => import('@/views/RunDetailView.vue'), meta: { titleKey: 'app.titles.run' } },
    { path: '/tools', component: () => import('@/views/ToolsView.vue'), meta: { titleKey: 'app.titles.tools' } },
    { path: '/settings', component: () => import('@/views/SettingsView.vue'), meta: { titleKey: 'app.titles.settings' } },
    { path: '/glosario', component: () => import('@/views/GlossaryView.vue'), meta: { titleKey: 'app.titles.glossary' } },
    { path: '/:pathMatch(.*)*', component: () => import('@/views/NotFoundView.vue'), meta: { titleKey: 'app.titles.notFound' } },
  ],
  scrollBehavior(to, _from, saved) {
    if (saved) return saved;
    if (to.hash) return { el: to.hash, top: 80, behavior: 'smooth' };
    return { top: 0 };
  },
});

const pageTitle = (key: unknown): string => (typeof key === 'string' ? t(key) : 'AgentForge');

// El título de la pestaña sigue al idioma.
watch(locale, () => {
  document.title = `${pageTitle(router.currentRoute.value.meta.titleKey)} · AgentForge`;
});

router.afterEach((to, from) => {
  const title = pageTitle(to.meta.titleKey);
  document.title = `${title} · AgentForge`;
  // Primera carga, o solo cambia el ancla o la consulta (filtros): ni se mueve el foco ni se anuncia nada.
  if (!from.matched.length || to.path === from.path) return;
  void nextTick(() => {
    const main = document.getElementById('contenido');
    if (!main) return;
    // El contenido se desplaza dentro de <main>, no en la ventana: cada página empieza arriba.
    if (!to.hash) main.scrollTop = 0;
    // El foco pasa al contenido nuevo: quien usa teclado no vuelve a recorrer el menú, y un lector de pantalla
    // sabe que la página ha cambiado.
    main.focus({ preventScroll: true });
    announce(t('app.pageAnnouncement', { title }));
  });
});
