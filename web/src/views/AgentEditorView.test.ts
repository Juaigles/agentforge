// @vitest-environment jsdom
// Formulario de agentes contra la API real (ver src/test/harness.ts).
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { EventSource as NodeEventSource } from 'eventsource';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Router } from 'vue-router';
import { systemText, userText } from '../../../server/test/helpers';
import { setLocale } from '@/i18n';
import { installFormA11y } from '@/lib/a11y';
import { editorMount } from '@/lib/editor-mount';
import { useCatalog } from '@/stores/catalog';
import { useUi } from '@/stores/ui';
import { freshPinia, setTouchDevice, startApi, testRouter, until, type TestApi } from '@/test/harness';
import AgentEditorView from './AgentEditorView.vue';

let api: TestApi;
let wrapper: VueWrapper;
let router: Router;

const nativeEventSource = (globalThis as { EventSource?: unknown }).EventSource;
/** `EventSource` real al que se le antepone la URL del servidor del test a las rutas relativas (como el navegador). */
class TestEventSource extends NodeEventSource {
  constructor(url: string | URL, init?: ConstructorParameters<typeof NodeEventSource>[1]) {
    super(typeof url === 'string' && url.startsWith('/') ? `${api.url}${url}` : url, init);
  }
}

async function open(path: string, cameFrom?: string): Promise<void> {
  const pinia = freshPinia();
  // Las mismas rutas y el mismo envoltorio que en la aplicación (router.ts): de él depende cuándo se vuelve a
  // montar la pantalla, y a través de RouterView funcionan los guardas de ruta.
  const editor = editorMount(AgentEditorView);
  router = testRouter([
    { path: '/agents/new', component: editor },
    { path: '/agents/:id', component: editor },
  ]);
  if (cameFrom) await router.push(cameFrom);
  await router.push(path);
  wrapper = mount({ template: '<RouterView />' }, { global: { plugins: [pinia, router] }, attachTo: document.body });
  await until(() => wrapper.find('#ag-name').exists());
}

const saveButton = () => wrapper.findAll('button').find((b) => b.text().includes('Guardar'))!;
const runButton = () => wrapper.get('.playground button.btn-primary');
const field = <T extends HTMLElement = HTMLInputElement>(selector: string) => document.querySelector<T>(selector);
const toasts = () => useUi().toasts.map((t) => t.message);
const agentInput = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  role: '',
  description: '',
  color: '#6366f1',
  providerId: api.ctx.store.listProviders()[0].id,
  model: 'test-model',
  systemPrompt: '',
  temperature: 0.3,
  maxTokens: null,
  maxIterations: 4,
  tools: [],
  thinking: false,
  ...extra,
});

beforeEach(async () => {
  setTouchDevice(false);
  api = await startApi();
  api.ctx.store.createProvider({ name: 'Proveedor de prueba', kind: 'ollama', baseUrl: 'http://127.0.0.1:1', defaultModel: 'test-model' });
  (globalThis as { EventSource?: unknown }).EventSource = TestEventSource;
});
afterEach(async () => {
  wrapper?.unmount();
  document.body.innerHTML = '';
  (globalThis as { EventSource?: unknown }).EventSource = nativeEventSource;
  await api.close();
});

describe('AgentEditorView (formulario)', () => {
  it('propone el proveedor y su modelo por defecto, y carga la lista de modelos del proveedor', async () => {
    await open('/agents/new');
    const provider = api.ctx.store.listProviders()[0];
    expect((wrapper.get('#ag-provider').element as HTMLSelectElement).value).toBe(provider.id);
    await until(() => wrapper.find('select#ag-model').exists());
    expect((wrapper.get('#ag-model').element as HTMLSelectElement).value).toBe('test-model');
    // Sin guardar, el banco de pruebas no está bloqueado: avisa de que guardará antes de ejecutar.
    expect(runButton().text()).toBe('Guardar y ejecutar');
    expect(wrapper.get('.playground').text()).toContain('Lo que hay sin guardar se guarda antes de ejecutar.');
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
    const agent = api.ctx.store.createAgent(agentInput('Original', { role: 'rol', systemPrompt: 'hola', maxTokens: 800 }));
    await open(`/agents/${agent.id}`);
    expect((wrapper.get('#ag-name').element as HTMLInputElement).value).toBe('Original');
    expect((wrapper.get('#ag-maxtok').element as HTMLInputElement).value).toBe('800');
    expect(saveButton().attributes('disabled')).toBeDefined();
    expect(wrapper.text()).not.toContain('Cambios sin guardar');
    expect(runButton().text()).toBe('Ejecutar');

    await wrapper.get('#ag-maxtok').setValue('');
    await wrapper.get('#ag-name').setValue('Renombrado');
    expect(wrapper.text()).toContain('Cambios sin guardar');
    expect(runButton().text()).toBe('Guardar y ejecutar');
    await saveButton().trigger('click');
    await until(() => api.ctx.store.getAgent(agent.id)?.name === 'Renombrado');
    expect(api.ctx.store.getAgent(agent.id)?.maxTokens).toBeNull();
    await until(() => !wrapper.text().includes('Cambios sin guardar'));
    expect(runButton().text()).toBe('Ejecutar');
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

  it('con la interfaz en inglés, el error de validación del servidor sale en inglés junto a su campo y en el aviso', async () => {
    setLocale('en', false);
    try {
      await open('/agents/new');
      await until(() => wrapper.find('select#ag-model').exists());
      await wrapper.get('#ag-name').setValue('x'.repeat(81));
      await wrapper
        .findAll('button')
        .find((b) => b.text().includes('Save'))!
        .trigger('click');
      await until(() => wrapper.find('#ag-name ~ .error').exists());
      expect(wrapper.get('#ag-name ~ .error').text()).toBe('Cannot be longer than 80 characters');
      expect(toasts()).toContain('Invalid data: name: Cannot be longer than 80 characters');
      expect(api.ctx.store.listAgents()).toHaveLength(0);
    } finally {
      setLocale('es', false);
    }
  });

  it('quita al guardar las herramientas que ya no existen y avisa de ello', async () => {
    const agent = api.ctx.store.createAgent(agentInput('Con herramienta huérfana', { tools: ['calculator', 'herramienta_borrada'] }));
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

  it('«Guardar» con el nombre vacío lleva el foco al campo del nombre (el botón está fuera del formulario pero lo envía)', async () => {
    const uninstall = installFormA11y();
    try {
      await open('/agents/new');
      await until(() => wrapper.find('select#ag-model').exists());
      expect(saveButton().attributes('type')).toBe('submit');
      expect(saveButton().attributes('form')).toBe(wrapper.get('form').attributes('id'));
      saveButton().element.focus();
      await saveButton().trigger('click');
      await until(() => document.activeElement === wrapper.get('#ag-name').element);
      expect(api.ctx.store.listAgents()).toHaveLength(0);
    } finally {
      uninstall();
    }
  });

  describe('primer guardado y paso de un agente a otro', () => {
    it('el primer guardado conserva la pantalla (campos, foco y tarea escrita) y sustituye a «nuevo» en el historial', async () => {
      await open('/agents/new', '/agents');
      await until(() => wrapper.find('select#ag-model').exists());
      await wrapper.get('#ag-name').setValue('Recién creado');
      await wrapper.get('#pg-task').setValue('tarea a medias');
      const role = field('#ag-role')!;
      const task = field<HTMLTextAreaElement>('#pg-task')!;
      role.focus();
      await wrapper.get('form').trigger('submit');
      await until(() => api.ctx.store.listAgents().length === 1);
      const { id } = api.ctx.store.listAgents()[0];
      await until(() => router.currentRoute.value.path === `/agents/${id}`);
      await flushPromises();

      // Los mismos elementos del DOM: la pantalla no se ha destruido y vuelto a crear.
      expect(field('#ag-role')).toBe(role);
      expect(field('#pg-task')).toBe(task);
      expect(document.activeElement).toBe(role);
      expect(task.value).toBe('tarea a medias');
      // Y ya es el agente creado: se puede duplicar, no queda nada pendiente y guardar otra vez lo actualiza.
      expect(wrapper.find('button[aria-label="Duplicar agente"]').exists()).toBe(true);
      expect(wrapper.text()).not.toContain('Cambios sin guardar');
      await wrapper.get('#ag-role').setValue('segundo guardado');
      await wrapper.get('form').trigger('submit');
      await until(() => api.ctx.store.getAgent(id)?.role === 'segundo guardado');
      expect(api.ctx.store.listAgents()).toHaveLength(1);

      // «Atrás» no vuelve al formulario de «nuevo», sino a donde se estaba antes de abrirlo.
      await until(() => !wrapper.text().includes('Cambios sin guardar'));
      router.back();
      await until(() => router.currentRoute.value.path !== `/agents/${id}`);
      expect(router.currentRoute.value.path).toBe('/agents');
    });

    it('de un agente a otro, y de uno existente a «nuevo», la pantalla empieza limpia', async () => {
      const first = api.ctx.store.createAgent(agentInput('Primero', { role: 'rol del primero' }));
      const second = api.ctx.store.createAgent(agentInput('Segundo'));
      await open(`/agents/${first.id}`);
      await wrapper.get('#pg-task').setValue('tarea del primero');
      const before = field('#ag-name')!;

      await router.push(`/agents/${second.id}`);
      await until(() => field('#ag-name')?.value === 'Segundo');
      expect(field('#ag-name')).not.toBe(before);
      expect(field('#ag-role')!.value).toBe('');
      expect(field<HTMLTextAreaElement>('#pg-task')!.value).toBe('');

      const existing = field('#ag-name')!;
      await router.push('/agents/new');
      await until(() => field('#ag-name') !== null && field('#ag-name') !== existing);
      expect(field('#ag-name')!.value).toBe('');
      expect(wrapper.find('button[aria-label="Duplicar agente"]').exists()).toBe(false);
      expect(runButton().text()).toBe('Guardar y ejecutar');
    });

    it('tras crear un agente, «nuevo» vuelve a abrir un formulario vacío', async () => {
      await open('/agents/new');
      await until(() => wrapper.find('select#ag-model').exists());
      await wrapper.get('#ag-name').setValue('Ya creado');
      await wrapper.get('form').trigger('submit');
      await until(() => router.currentRoute.value.path.startsWith('/agents/agt_'));
      const created = field('#ag-name')!;
      await router.push('/agents/new');
      await until(() => field('#ag-name') !== null && field('#ag-name') !== created);
      expect(field('#ag-name')!.value).toBe('');
    });
  });

  describe('«Guardar y ejecutar» en el banco de pruebas', () => {
    it('con un agente nuevo: lo crea y ejecuta la tarea, sin perder lo escrito', async () => {
      await open('/agents/new');
      await until(() => wrapper.find('select#ag-model').exists());
      // Sin tarea no hay nada que ejecutar.
      expect(runButton().attributes('disabled')).toBeDefined();
      await wrapper.get('#ag-name').setValue('Probado al vuelo');
      await wrapper.get('#ag-prompt').setValue('Responde con una sola palabra.');
      await wrapper.get('#pg-task').setValue('di hola');
      const task = field<HTMLTextAreaElement>('#pg-task')!;
      expect(runButton().attributes('disabled')).toBeUndefined();
      await runButton().trigger('click');

      await until(() => api.llm.calls.length === 1);
      const [agent] = api.ctx.store.listAgents();
      expect(agent).toMatchObject({ name: 'Probado al vuelo', systemPrompt: 'Responde con una sola palabra.' });
      expect(systemText(api.llm.calls[0])).toContain('Responde con una sola palabra.');
      expect(userText(api.llm.calls[0])).toBe('di hola');
      // La respuesta llega al mismo banco de pruebas, que sigue con la tarea escrita y ya en la dirección del agente.
      await until(() => wrapper.find('.playground .answer').exists());
      expect(wrapper.get('.playground .answer').text()).toContain('ok');
      expect(router.currentRoute.value.path).toBe(`/agents/${agent.id}`);
      expect(field('#pg-task')).toBe(task);
      expect(task.value).toBe('di hola');
      await until(() => wrapper.find('.playground button.btn-primary').exists() && runButton().text() === 'Ejecutar');
      expect(api.ctx.store.listAgents()).toHaveLength(1);
    });

    it('con cambios pendientes: los guarda y ejecuta la versión que se ve en el formulario', async () => {
      const agent = api.ctx.store.createAgent(agentInput('Con cambios', { systemPrompt: 'Instrucciones antiguas.' }));
      await open(`/agents/${agent.id}`);
      expect(runButton().text()).toBe('Ejecutar');
      await wrapper.get('#ag-prompt').setValue('Instrucciones nuevas.');
      await wrapper.get('#pg-task').setValue('prueba');
      expect(runButton().text()).toBe('Guardar y ejecutar');
      await runButton().trigger('click');

      await until(() => api.llm.calls.length === 1);
      expect(systemText(api.llm.calls[0])).toContain('Instrucciones nuevas.');
      expect(systemText(api.llm.calls[0])).not.toContain('Instrucciones antiguas.');
      expect(api.ctx.store.getAgent(agent.id)?.systemPrompt).toBe('Instrucciones nuevas.');
      await until(() => wrapper.find('.playground .answer').exists());
      expect(wrapper.text()).not.toContain('Cambios sin guardar');
      expect(field<HTMLTextAreaElement>('#pg-task')!.value).toBe('prueba');
    });

    it('si no se puede guardar no ejecuta nada: señala el campo y conserva la tarea', async () => {
      await open('/agents/new');
      await until(() => wrapper.find('select#ag-model').exists());
      await wrapper.get('#pg-task').setValue('no debería lanzarse');
      await runButton().trigger('click');
      await until(() => document.activeElement === field('#ag-name'));
      expect(wrapper.text()).toContain('Ponle un nombre al agente.');
      expect(api.ctx.store.listAgents()).toHaveLength(0);
      expect(api.llm.calls).toHaveLength(0);
      expect(router.currentRoute.value.path).toBe('/agents/new');
      expect(field<HTMLTextAreaElement>('#pg-task')!.value).toBe('no debería lanzarse');
      expect(runButton().text()).toBe('Guardar y ejecutar');
    });
  });

  describe('con el servidor caído al abrir', () => {
    const mountOffline = async () => {
      const agent = api.ctx.store.createAgent(agentInput('Tardío'));
      const real = globalThis.fetch;
      globalThis.fetch = () => Promise.reject(new TypeError('fetch failed'));
      const pinia = freshPinia();
      router = testRouter([{ path: '/agents/:id', component: AgentEditorView }]);
      await router.push(`/agents/${agent.id}`);
      wrapper = mount({ template: '<RouterView />' }, { global: { plugins: [pinia, router] }, attachTo: document.body });
      await until(() => wrapper.find('[role="alert"]').exists());
      return { restore: () => (globalThis.fetch = real), catalog: useCatalog() };
    };

    it('ofrece «Reintentar», que vuelve a cargar el agente', async () => {
      const { restore } = await mountOffline();
      expect(wrapper.find('#ag-name').exists()).toBe(false);
      restore();
      await wrapper
        .findAll('button')
        .find((b) => b.text() === 'Reintentar')!
        .trigger('click');
      await until(() => wrapper.find('#ag-name').exists());
      expect((wrapper.get('#ag-name').element as HTMLInputElement).value).toBe('Tardío');
      expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    });

    it('se recupera solo cuando vuelve la conexión', async () => {
      const { restore, catalog } = await mountOffline();
      catalog.online = false;
      await flushPromises();
      restore();
      catalog.online = true;
      await until(() => wrapper.find('#ag-name').exists());
      expect((wrapper.get('#ag-name').element as HTMLInputElement).value).toBe('Tardío');
    });
  });
});
