// @vitest-environment jsdom
// Monitor de una ejecución terminada contra la API real: accesibilidad de pasos y pestañas, reintento de carga y reloj.
import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addAgent, edges, node, runWorkflow, workflow } from '../../../server/test/helpers';
import RunGraph from '@/components/RunGraph.vue';
import YokaiFloor from '@/components/YokaiFloor.vue';
import { setLocale } from '@/i18n';
import { setSkin, skin, type Skin } from '@/lib/skin';
import { useCatalog } from '@/stores/catalog';
import { freshPinia, startApi, testRouter, until, type TestApi } from '@/test/harness';
import RunDetailView from './RunDetailView.vue';

let api: TestApi;
let wrapper: VueWrapper | undefined;

beforeEach(async () => {
  api = await startApi();
});
afterEach(async () => {
  vi.restoreAllMocks();
  wrapper?.unmount();
  wrapper = undefined;
  document.body.innerHTML = '';
  await api.close();
});

/** El grafo (Vue Flow) necesita ResizeObserver, que jsdom no trae: se sustituye solo él. */
async function open(id: string) {
  const pinia = freshPinia();
  const router = testRouter([{ path: '/runs/:id', component: RunDetailView }]);
  await router.push(`/runs/${id}`);
  await router.isReady();
  wrapper = mount(RunDetailView, { global: { plugins: [pinia, router], stubs: { RunGraph: true } }, attachTo: document.body });
}
const tab = (name: string) => wrapper!.find(`#run-tab-${name}`);

describe('RunDetailView: accesibilidad', () => {
  it('expone el paso seleccionado y enlaza cada pestaña con su panel, con flechas entre pestañas', async () => {
    const agent = addAgent(api.ctx);
    const run = await runWorkflow(api.ctx, workflow([node('e', 'input'), node('a', 'agent', { agentId: agent.id, prompt: 'hola' })], edges('e>a')));
    await open(run.id);
    await until(() => wrapper!.find('nav.steps').exists());

    const steps = wrapper!.findAll('nav.steps button.step');
    expect(steps.length).toBeGreaterThan(1);
    expect(steps[0].attributes('aria-pressed')).toBe('true');
    await steps[1].trigger('click');
    expect(steps[1].attributes('aria-pressed')).toBe('true');
    expect(steps[0].attributes('aria-pressed')).toBe('false');

    const panel = wrapper!.find('[role="tabpanel"]');
    expect(panel.attributes('id')).toBe('run-panel');
    expect(panel.attributes('aria-labelledby')).toBe('run-tab-result');
    expect(tab('result').attributes('aria-controls')).toBe('run-panel');
    expect(tab('result').attributes('tabindex')).toBe('0');
    expect(tab('activity').attributes('tabindex')).toBe('-1');

    await tab('result').trigger('keydown', { key: 'ArrowRight' });
    expect(tab('activity').attributes('aria-selected')).toBe('true');
    expect(panel.attributes('aria-labelledby')).toBe('run-tab-activity');
    await tab('activity').trigger('keydown', { key: 'ArrowLeft' });
    await tab('result').trigger('keydown', { key: 'ArrowLeft' });
    expect(tab('input').attributes('aria-selected')).toBe('true');
  });
});

describe('RunDetailView: errores de carga', () => {
  it('ofrece «Reintentar» y se recupera cuando vuelve la conexión', async () => {
    const run = await runWorkflow(api.ctx, workflow([node('e', 'input'), node('o', 'output')], edges('e>o')));
    const inner = globalThis.fetch;
    let down = true;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (down && String(input).startsWith('/api/runs/')) throw new TypeError('fetch failed');
      return inner(input, init);
    }) as typeof fetch;
    await open(run.id);
    await until(() => wrapper!.text().includes('Reintentar'));

    down = false;
    await wrapper!
      .findAll('button')
      .find((b) => b.text() === 'Reintentar')!
      .trigger('click');
    await until(() => wrapper!.find('nav.steps').exists());

    // Y sin pulsar nada: al volver la conexión (catalog.online false → true) la vista se recarga sola.
    down = true;
    wrapper!.unmount();
    await open(run.id);
    await until(() => wrapper!.text().includes('Reintentar'));
    down = false;
    const catalog = useCatalog();
    catalog.online = false;
    await wrapper!.vm.$nextTick();
    catalog.online = true;
    await until(() => wrapper!.find('nav.steps').exists());
  });
});

describe('RunDetailView: reloj', () => {
  it('con la ejecución terminada no deja ningún temporizador de 500 ms repintando', async () => {
    const run = await runWorkflow(api.ctx, workflow([node('e', 'input'), node('o', 'output')], edges('e>o')));
    const spy = vi.spyOn(globalThis, 'setInterval');
    await open(run.id);
    await until(() => wrapper!.find('nav.steps').exists());
    expect(spy.mock.calls.filter(([, ms]) => ms === 500)).toEqual([]);
  });
});

describe('RunDetailView: ejecuciones largas', () => {
  it('la actividad pinta las últimas 100 entradas y «Cargar anteriores» trae el resto por páginas', async () => {
    const agent = addAgent(api.ctx);
    const run = await runWorkflow(api.ctx, workflow([node('e', 'input'), node('a', 'agent', { agentId: agent.id, prompt: 'hola' })], edges('e>a')));
    // 450 eventos en total, añadidos por la misma vía que el motor (el almacén).
    for (let seq = api.ctx.store.lastEventSeq(run.id) + 1; seq <= 450; seq++) {
      api.ctx.store.appendEvent(run.id, 'llm.message', 'a', { agent: `M${seq}`, content: 'x' });
    }
    const requested: string[] = [];
    const inner = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      requested.push(String(input));
      return inner(input, init);
    }) as typeof fetch;
    const eventRequests = () => requested.filter((url) => url.includes('/events'));

    await open(run.id);
    await until(() => wrapper!.find('nav.steps').exists());
    // Los pasos vienen ya calculados del servidor, aunque solo se haya traído la última página de eventos.
    expect(eventRequests()).toEqual([`/api/runs/${run.id}/events?before=451&limit=200`]);
    expect(wrapper!.findAll('nav.steps button.step .badge').map((b) => b.attributes('title'))).toEqual(['Completado', 'Completado']);

    // La insignia cuenta lo cargado y avisa de que hay más.
    expect(tab('activity').get('.badge').text()).toBe('200+');
    await tab('activity').trigger('click');
    const entries = () => wrapper!.findAll('.activity > li').length;
    /** El botón «Cargar anteriores» (mientras carga sigue ahí, deshabilitado). */
    const older = () => wrapper!.findAll('.older button')[0];
    expect(entries()).toBe(100);
    expect(wrapper!.findAll('.activity > li').at(-1)!.text()).toContain('M450');

    // Primero se enseña lo que ya estaba cargado; después se pide la página anterior.
    await older()!.trigger('click');
    expect(entries()).toBe(200);
    expect(eventRequests()).toHaveLength(1);
    await older()!.trigger('click');
    await until(() => entries() === 300);
    expect(eventRequests().at(-1)).toBe(`/api/runs/${run.id}/events?before=251&limit=200`);
    expect(tab('activity').get('.badge').text()).toBe('400+');

    // Hasta el principio: el botón desaparece y la insignia deja de avisar.
    expect(older()!.text()).toBe('Cargar anteriores');
    await older()!.trigger('click');
    expect(entries()).toBe(400);
    await older()!.trigger('click');
    await until(() => !older());
    expect(wrapper!.findAll('.activity > li')[0].text()).toContain('Ejecución iniciada');
    expect(tab('activity').get('.badge').text()).not.toContain('+');
    expect(eventRequests().at(-1)).toBe(`/api/runs/${run.id}/events?before=51&limit=200`);

    // Con un paso elegido (la entrada: iniciado y completado), la lista y la insignia son las de ese paso.
    await wrapper!.findAll('nav.steps button.step')[1].trigger('click');
    expect(entries()).toBe(2);
    expect(tab('activity').get('.badge').text()).toBe('2');
  });
});

describe('RunDetailView: Modo Yōkai', () => {
  let previous: Skin;
  beforeEach(() => {
    previous = skin.value;
    localStorage.removeItem('af-run-view');
  });
  afterEach(() => {
    setSkin(previous);
    localStorage.removeItem('af-run-view');
  });

  async function agentRun() {
    const agent = addAgent(api.ctx, { name: 'Redactor' });
    return runWorkflow(api.ctx, workflow([node('e', 'input'), node('a', 'agent', { agentId: agent.id, prompt: 'hola' })], edges('e>a')));
  }
  const switchButtons = () => wrapper!.findAll('.view-switch button');

  it('con la piel normal no hay selector ni planta: solo el grafo de siempre', async () => {
    setSkin('default');
    const run = await agentRun();
    await open(run.id);
    await until(() => wrapper!.find('section.graph').exists());
    const graph = wrapper!.get('section.graph');
    expect(graph.classes()).toEqual(['card', 'graph']);
    expect(wrapper!.find('.view-switch').exists()).toBe(false);
    expect(wrapper!.findComponent(YokaiFloor).exists()).toBe(false);
    expect(wrapper!.findComponent(RunGraph).exists()).toBe(true);
    expect(graph.find('.snapshot-note').exists()).toBe(true);
  });

  it('con el Modo Yōkai muestra la planta por defecto, alterna al grafo y recuerda la elección', async () => {
    setSkin('yokai');
    const run = await agentRun();
    await open(run.id);
    await until(() => wrapper!.find('section.graph').exists());
    expect(switchButtons().map((b) => b.text())).toEqual(['Planta', 'Grafo']);
    expect(switchButtons().map((b) => b.attributes('aria-pressed'))).toEqual(['true', 'false']);
    expect(wrapper!.get('section.graph').classes()).toContain('is-floor');
    const floor = wrapper!.getComponent(YokaiFloor);
    expect(floor.findAll('.staff button').map((b) => b.attributes('aria-label'))).toEqual(['Redactor — completado']);
    expect(wrapper!.findComponent(RunGraph).exists()).toBe(false);
    expect(wrapper!.find('.snapshot-note').exists()).toBe(true);

    // Elegir un yōkai selecciona su paso, igual que en el grafo.
    await floor.get('.staff button').trigger('click');
    expect(wrapper!.findAll('nav.steps button.step')[2].attributes('aria-pressed')).toBe('true');
    expect(floor.get('.staff button').attributes('aria-pressed')).toBe('true');

    await switchButtons()[1].trigger('click');
    expect(switchButtons().map((b) => b.attributes('aria-pressed'))).toEqual(['false', 'true']);
    expect(wrapper!.findComponent(YokaiFloor).exists()).toBe(false);
    expect(wrapper!.findComponent(RunGraph).exists()).toBe(true);
    expect(wrapper!.get('section.graph').classes()).not.toContain('is-floor');
    expect(localStorage.getItem('af-run-view')).toBe('graph');
  });
});

describe('RunDetailView: motivo del fallo en el idioma de la interfaz', () => {
  afterEach(() => setLocale('es', false));

  /** Ejecución de un agente sin modelo: falla con un error de configuración (texto del servidor con código). */
  async function failedRun() {
    const agent = addAgent(api.ctx, { name: 'Redactor', model: ' ' });
    return runWorkflow(api.ctx, workflow([node('e', 'input'), node('Resumir', 'agent', { agentId: agent.id, prompt: 'hola' })], edges('e>Resumir')));
  }
  const alerts = () => wrapper!.findAll('[role="alert"]').map((a) => a.text());

  it('en inglés traduce el motivo de la ejecución y el del paso; en español muestra el texto guardado, sin recargar', async () => {
    const run = await failedRun();
    setLocale('en', false);
    await open(run.id);
    await until(() => alerts().length > 0);
    expect(alerts()[0]).toBe('Node "Resumir" failed: Agent "Redactor" has no model configured.');
    await wrapper!
      .findAll('nav.steps button.step')
      .find((b) => b.text().includes('Resumir'))!
      .trigger('click');
    expect(alerts()).toContain('Agent "Redactor" has no model configured.');
    // En el registro de actividad, el detalle de cada evento también.
    await tab('activity').trigger('click');
    await until(() => wrapper!.text().includes('has no model configured'));
    expect(wrapper!.text()).not.toContain('no tiene modelo configurado');

    setLocale('es', false);
    await until(() => alerts()[0].startsWith('El nodo'));
    expect(alerts()[0]).toBe('El nodo "Resumir" falló: El agente «Redactor» no tiene modelo configurado.');
  });

  it('una ejecución anterior a los códigos (sin referencia guardada) se muestra con su texto, también en inglés', async () => {
    const run = await failedRun();
    api.ctx.db.exec(
      "UPDATE runs SET error_i18n = NULL; UPDATE run_steps SET error_i18n = NULL; DELETE FROM run_events WHERE type IN ('step.finished', 'run.finished')",
    );
    setLocale('en', false);
    await open(run.id);
    await until(() => alerts().length > 0);
    expect(alerts()[0]).toBe('El nodo "Resumir" falló: El agente «Redactor» no tiene modelo configurado.');
  });
});
