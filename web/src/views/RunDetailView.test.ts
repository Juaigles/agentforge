// @vitest-environment jsdom
// Monitor de una ejecución terminada contra la API real: accesibilidad de pasos y pestañas, reintento de carga y reloj.
import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addAgent, edges, node, runWorkflow, workflow } from '../../../server/test/helpers';
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
