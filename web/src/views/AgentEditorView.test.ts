// @vitest-environment jsdom
// Formulario de agentes contra la API real (ver src/test/harness.ts).
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Router } from 'vue-router';
import { useUi } from '@/stores/ui';
import { freshPinia, setTouchDevice, startApi, testRouter, until, type TestApi } from '@/test/harness';
import AgentEditorView from './AgentEditorView.vue';

let api: TestApi;
let wrapper: VueWrapper;
let router: Router;

async function open(path: string): Promise<void> {
  const pinia = freshPinia();
  router = testRouter([
    { path: '/agents/new', component: AgentEditorView },
    { path: '/agents/:id', component: AgentEditorView },
  ]);
  await router.push(path);
  // Se monta a través de RouterView, como en la aplicación, para que funcionen los guardas de ruta.
  wrapper = mount({ template: '<RouterView v-slot="{ Component, route }"><component :is="Component" :key="route.fullPath" /></RouterView>' }, {
    global: { plugins: [pinia, router] },
    attachTo: document.body,
  });
  await until(() => wrapper.find('#ag-name').exists());
}

const saveButton = () => wrapper.findAll('button').find((b) => b.text().includes('Guardar'))!;
const toasts = () => useUi().toasts.map((t) => t.message);

beforeEach(async () => {
  setTouchDevice(false);
  api = await startApi();
  api.ctx.store.createProvider({ name: 'Proveedor de prueba', kind: 'ollama', baseUrl: 'http://127.0.0.1:1', defaultModel: 'test-model' });
});
afterEach(async () => {
  wrapper?.unmount();
  document.body.innerHTML = '';
  await api.close();
});

describe('AgentEditorView (formulario)', () => {
  it('propone el proveedor y su modelo por defecto, y carga la lista de modelos del proveedor', async () => {
    await open('/agents/new');
    const provider = api.ctx.store.listProviders()[0];
    expect((wrapper.get('#ag-provider').element as HTMLSelectElement).value).toBe(provider.id);
    await until(() => wrapper.find('select#ag-model').exists());
    expect((wrapper.get('#ag-model').element as HTMLSelectElement).value).toBe('test-model');
    // Sin guardar, el banco de pruebas explica por qué está bloqueado.
    expect(wrapper.text()).toContain('Guarda el agente para poder probarlo.');
  });

  it('valida en cliente y no llama al servidor si falta el nombre', async () => {
    await open('/agents/new');
    await saveButton().trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('Ponle un nombre al agente.');
    expect(wrapper.get('#ag-name').attributes('aria-invalid')).toBe('true');
    expect(api.ctx.store.listAgents()).toHaveLength(0);
  });

  it('crea el agente en el servidor con los valores del formulario y pasa a su URL definitiva', async () => {
    await open('/agents/new');
    await until(() => wrapper.find('select#ag-model').exists());
    await wrapper.get('#ag-name').setValue('Contable');
    await wrapper.get('#ag-role').setValue('experto en facturas');
    await wrapper.get('#ag-prompt').setValue('Responde en español.');
    await wrapper.get('#ag-iter').setValue('5');
    await wrapper.get('#ag-maxtok').setValue('3'); // por debajo del mínimo: se ajusta a 16
    await wrapper.get('input[type="checkbox"][value="calculator"]').setValue(true);
    await saveButton().trigger('click');
    await until(() => api.ctx.store.listAgents().length === 1);

    const saved = api.ctx.store.listAgents()[0];
    expect(saved).toMatchObject({
      name: 'Contable',
      role: 'experto en facturas',
      systemPrompt: 'Responde en español.',
      model: 'test-model',
      maxIterations: 5,
      maxTokens: 16,
      tools: ['calculator'],
      thinking: false,
    });
    await until(() => router.currentRoute.value.path === `/agents/${saved.id}`);
    expect(toasts()).toContain('«Contable» guardado.');
  });

  it('carga un agente existente, detecta cambios y los guarda; vaciar los tokens máximos vuelve al valor por defecto', async () => {
    const provider = api.ctx.store.listProviders()[0];
    const agent = api.ctx.store.createAgent({
      name: 'Original',
      role: 'rol',
      description: '',
      color: '#6366f1',
      providerId: provider.id,
      model: 'test-model',
      systemPrompt: 'hola',
      temperature: 0.3,
      maxTokens: 800,
      maxIterations: 4,
      tools: [],
      thinking: false,
    });
    await open(`/agents/${agent.id}`);
    expect((wrapper.get('#ag-name').element as HTMLInputElement).value).toBe('Original');
    expect((wrapper.get('#ag-maxtok').element as HTMLInputElement).value).toBe('800');
    expect(saveButton().attributes('disabled')).toBeDefined();
    expect(wrapper.text()).not.toContain('Cambios sin guardar');

    await wrapper.get('#ag-maxtok').setValue('');
    await wrapper.get('#ag-name').setValue('Renombrado');
    expect(wrapper.text()).toContain('Cambios sin guardar');
    expect(wrapper.text()).toContain('Guarda los cambios para probar la versión actual.');
    await saveButton().trigger('click');
    await until(() => api.ctx.store.getAgent(agent.id)?.name === 'Renombrado');
    expect(api.ctx.store.getAgent(agent.id)?.maxTokens).toBeNull();
    await until(() => !wrapper.text().includes('Cambios sin guardar'));
  });

  it('muestra en su campo los errores de validación que devuelve el servidor', async () => {
    await open('/agents/new');
    await until(() => wrapper.find('select#ag-model').exists());
    await wrapper.get('#ag-name').setValue('Con iteraciones imposibles');
    await wrapper.get('#ag-iter').setValue('500');
    await saveButton().trigger('click');
    await until(() => toasts().some((t) => t.startsWith('Datos no válidos')));
    expect(api.ctx.store.listAgents()).toHaveLength(0);
  });

  it('quita al guardar las herramientas que ya no existen y avisa de ello', async () => {
    const provider = api.ctx.store.listProviders()[0];
    const agent = api.ctx.store.createAgent({
      name: 'Con herramienta huérfana',
      role: '',
      description: '',
      color: '#6366f1',
      providerId: provider.id,
      model: 'test-model',
      systemPrompt: '',
      temperature: 0.3,
      maxTokens: null,
      maxIterations: 4,
      tools: ['calculator', 'herramienta_borrada'],
      thinking: false,
    });
    await open(`/agents/${agent.id}`);
    expect(wrapper.text()).toContain('Herramientas que ya no existen y se quitarán al guardar: herramienta_borrada.');
    await wrapper.get('#ag-role').setValue('cambio');
    await saveButton().trigger('click');
    await until(() => api.ctx.store.getAgent(agent.id)?.role === 'cambio');
    expect(api.ctx.store.getAgent(agent.id)?.tools).toEqual(['calculator']);
  });

  it('informa de un agente que no existe', async () => {
    const pinia = freshPinia();
    router = testRouter([{ path: '/agents/:id', component: AgentEditorView }]);
    await router.push('/agents/agt_no_existe');
    wrapper = mount({ template: '<RouterView />' }, { global: { plugins: [pinia, router] } });
    await until(() => wrapper.find('[role="alert"]').exists());
    expect(wrapper.get('[role="alert"]').text()).toContain('Agente');
  });
});
