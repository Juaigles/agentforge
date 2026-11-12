// @vitest-environment jsdom
// Constructor de workflows contra la API real (ver src/test/harness.ts): lo que se ve al abrirlo, la vuelta a los
// ajustes del workflow y la recuperación de un error de carga.
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Router } from 'vue-router';
import { edges, node, workflow } from '../../../server/test/helpers';
import { setLocale } from '@/i18n';
import { useCatalog } from '@/stores/catalog';
import { freshPinia, setTouchDevice, startApi, testRouter, until, type TestApi } from '@/test/harness';
import WorkflowBuilderView from './WorkflowBuilderView.vue';

let api: TestApi;
let wrapper: VueWrapper;
let router: Router;

// jsdom no trae estas APIs, que Vue Flow necesita para medir el lienzo.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
class DOMMatrixStub {
  m22 = 1;
}

async function open(path: string): Promise<void> {
  const pinia = freshPinia();
  router = testRouter([
    { path: '/workflows/new', component: WorkflowBuilderView },
    { path: '/workflows/:id', component: WorkflowBuilderView },
  ]);
  await router.push(path);
  wrapper = mount({ template: '<RouterView />' }, { global: { plugins: [pinia, router] }, attachTo: document.body });
  await until(() => wrapper.find('.canvas').exists());
}
const labels = () => [...document.body.querySelectorAll('.vue-flow__node')].map((n) => n.textContent ?? '');

beforeEach(async () => {
  setTouchDevice(false);
  Object.assign(globalThis, { ResizeObserver: ResizeObserverStub, DOMMatrixReadOnly: DOMMatrixStub });
  api = await startApi();
});
afterEach(async () => {
  wrapper?.unmount();
  document.body.innerHTML = '';
  setLocale('es', false);
  await api.close();
});

describe('WorkflowBuilderView', () => {
  it('un workflow nuevo nace con los nodos «Entrada» y «Salida», y en inglés con «Input» y «Output»', async () => {
    await open('/workflows/new');
    await until(() => labels().length === 2);
    expect(labels().join('|')).toContain('Entrada');
    expect(labels().join('|')).toContain('Salida');
    wrapper.unmount();
    document.body.innerHTML = '';

    setLocale('en', false);
    await open('/workflows/new');
    await until(() => labels().length === 2);
    expect(labels().join('|')).toContain('Input');
    expect(labels().join('|')).toContain('Output');
    expect(labels().join('|')).not.toContain('Entrada');
  });

  it('con un nodo seleccionado, un botón «Ajustes del workflow» vuelve a los ajustes y lleva el foco a ellos', async () => {
    await open('/workflows/new');
    await until(() => labels().length === 2);
    const inspector = () => document.body.querySelector('.inspector')!;
    expect(inspector().querySelector('#wf-desc')).not.toBeNull();

    document.body.querySelector<HTMLElement>('.vue-flow__node')!.click();
    await until(() => inspector().querySelector('#in-label') !== null);
    expect(inspector().querySelector('#wf-desc')).toBeNull();

    const back = [...inspector().querySelectorAll('button')].find((b) => b.textContent?.includes('Ajustes del workflow'))!;
    expect(back).toBeDefined();
    back.click();
    await until(() => inspector().querySelector('#wf-desc') !== null);
    await until(() => document.activeElement === inspector().querySelector('#wf-desc'));
    // Sin nodo seleccionado el botón no se ofrece (ya se está en los ajustes).
    expect([...inspector().querySelectorAll('button')].some((b) => b.textContent?.includes('Ajustes del workflow'))).toBe(false);
  });

  it('Escape en el lienzo deja de seleccionar el nodo y vuelve a los ajustes', async () => {
    await open('/workflows/new');
    await until(() => labels().length === 2);
    const first = document.body.querySelector<HTMLElement>('.vue-flow__node')!;
    first.click();
    await until(() => document.body.querySelector('.inspector #in-label') !== null);
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await until(() => document.body.querySelector('.inspector #wf-desc') !== null);
  });

  it('copiar y pegar conserva la configuración tal como estaba al copiar, aunque se edite el original después', async () => {
    await open('/workflows/new');
    await until(() => labels().length === 2);
    const first = document.body.querySelector<HTMLElement>('.vue-flow__node')!;
    first.click();
    await until(() => document.body.querySelector('#in-desc') !== null);
    const field = () => document.body.querySelector<HTMLInputElement>('#in-desc')!;
    field().value = 'Tema del informe';
    field().dispatchEvent(new Event('input', { bubbles: true }));
    await flushPromises();

    const key = (k: string) => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: k, ctrlKey: true, bubbles: true, cancelable: true }));
    key('c');
    // El original se edita después de copiar: lo pegado no debe cambiar.
    field().value = 'Otro tema';
    field().dispatchEvent(new Event('input', { bubbles: true }));
    await flushPromises();
    key('v');
    await until(() => labels().length === 3);
    await until(() => document.body.querySelector<HTMLInputElement>('#in-desc')?.value === 'Tema del informe');
  });

  it('muestra «Reintentar» si falla la carga y se recupera solo al volver la conexión', async () => {
    const wf = api.ctx.store.createWorkflow({
      ...workflow([node('entrada', 'input'), node('salida', 'output', { template: '{{entrada}}' })], edges('entrada>salida')),
      name: 'Persistido',
    });
    const real = globalThis.fetch;
    globalThis.fetch = () => Promise.reject(new TypeError('fetch failed'));
    const pinia = freshPinia();
    router = testRouter([{ path: '/workflows/:id', component: WorkflowBuilderView }]);
    await router.push(`/workflows/${wf.id}`);
    wrapper = mount({ template: '<RouterView />' }, { global: { plugins: [pinia, router] }, attachTo: document.body });
    await until(() => wrapper.find('[role="alert"]').exists());
    expect(wrapper.find('.canvas').exists()).toBe(false);

    // Con la conexión de vuelta, «Reintentar» carga el workflow.
    globalThis.fetch = real;
    await wrapper
      .findAll('button')
      .find((b) => b.text() === 'Reintentar')!
      .trigger('click');
    await until(() => wrapper.find('.canvas').exists());
    await until(() => (wrapper.get('input[aria-label="Nombre del workflow"]').element as HTMLInputElement).value === 'Persistido');
    wrapper.unmount();

    // Segunda vez: sin pulsar nada, al volver la conexión.
    globalThis.fetch = () => Promise.reject(new TypeError('fetch failed'));
    const catalog2 = (wrapper = mount({ template: '<RouterView />' }, { global: { plugins: [freshPinia(), router] }, attachTo: document.body }));
    await until(() => catalog2.find('[role="alert"]').exists());
    const catalog = useCatalog();
    catalog.online = false;
    await flushPromises();
    globalThis.fetch = real;
    catalog.online = true;
    await until(() => wrapper.find('.canvas').exists());
  });
});
