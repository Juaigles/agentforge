import { nextTick } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import { announce } from './lib/a11y';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: () => import('@/views/DashboardView.vue'), meta: { title: 'Panel' } },
    { path: '/agents', component: () => import('@/views/AgentsView.vue'), meta: { title: 'Agentes' } },
    { path: '/agents/new', component: () => import('@/views/AgentEditorView.vue'), meta: { title: 'Nuevo agente', keyed: true } },
    { path: '/agents/:id', component: () => import('@/views/AgentEditorView.vue'), meta: { title: 'Agente', keyed: true } },
    { path: '/workflows', component: () => import('@/views/WorkflowsView.vue'), meta: { title: 'Workflows' } },
    { path: '/workflows/new', component: () => import('@/views/WorkflowBuilderView.vue'), meta: { title: 'Nuevo workflow', keyed: true } },
    { path: '/workflows/:id', component: () => import('@/views/WorkflowBuilderView.vue'), meta: { title: 'Workflow', keyed: true } },
    { path: '/runs', component: () => import('@/views/RunsView.vue'), meta: { title: 'Ejecuciones' } },
    { path: '/runs/:id', component: () => import('@/views/RunDetailView.vue'), meta: { title: 'Ejecución' } },
    { path: '/tools', component: () => import('@/views/ToolsView.vue'), meta: { title: 'Herramientas' } },
    { path: '/settings', component: () => import('@/views/SettingsView.vue'), meta: { title: 'Ajustes' } },
    { path: '/glosario', component: () => import('@/views/GlossaryView.vue'), meta: { title: 'Glosario' } },
    { path: '/:pathMatch(.*)*', component: () => import('@/views/NotFoundView.vue'), meta: { title: 'No encontrado' } },
  ],
  scrollBehavior(to, _from, saved) {
    if (saved) return saved;
    if (to.hash) return { el: to.hash, top: 80, behavior: 'smooth' };
    return { top: 0 };
  },
});

router.afterEach((to, from) => {
  const title = String(to.meta.title ?? 'AgentForge');
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
    announce(`Página: ${title}`);
  });
});
