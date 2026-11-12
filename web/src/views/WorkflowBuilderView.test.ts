// @vitest-environment jsdom
// Constructor de workflows contra la API real (ver src/test/harness.ts): lo que se ve al abrirlo, la vuelta a los
// ajustes del workflow y la recuperación de un error de carga.
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Router } from 'vue-router';
import { edges, node, workflow } from '../../../server/test/helpers';
import { setLocale } from '@/i18n';
import { editorMount } from '@/lib/editor-mount';
import { useCatalog } from '@/stores/catalog';
import { useUi } from '@/stores/ui';
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

async function open(path: string, cameFrom?: string): Promise<void> {
  const pinia = freshPinia();
  // Las mismas rutas y el mismo envoltorio que en la aplicación (router.ts): de él depende cuándo se vuelve a
  // montar la pantalla.
  const builder = editorMount(WorkflowBuilderView);
  router = testRouter([
    { path: '/workflows/new', component: builder },
    { path: '/workflows/:id', component: builder },
  ]);
  if (cameFrom) await router.push(cameFrom);
  await router.push(path);
  wrapper = mount({ template: '<RouterView />' }, { global: { plugins: [pinia, router] }, attachTo: document.body });
  await until(() => wrapper.find('.canvas').exists());
}
const labels = () => [...document.body.querySelectorAll('.vue-flow__node')].map((n) => n.textContent ?? '');
const button = (label: string) => document.body.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const nameField = () => document.body.querySelector<HTMLInputElement>('input[aria-label="Nombre del workflow"]')!;
const unsaved = () => [...document.body.querySelectorAll('.bar .badge')].some((b) => b.textContent?.includes('Sin guardar'));
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
function type(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

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

  it('un workflow nuevo sin tocar no figura como «Sin guardar» ni pide confirmación al salir; en cuanto se toca, sí', async () => {
    await open('/workflows/new');
    await until(() => labels().length === 2);
    // Se deja pasar el tiempo en que Vue Flow mide los nodos y el historial anota cambios: nada de eso cuenta.
    await pause(500);
    expect(unsaved()).toBe(false);
    // Aun así se puede guardar: es la forma de crearlo.
    const save = [...document.body.querySelectorAll<HTMLButtonElement>('.bar button')].find((b) => b.textContent?.includes('Guardar'))!;
    expect(save.disabled).toBe(false);
    await router.push('/workflows');
    expect(router.currentRoute.value.path).toBe('/workflows');
    expect(useUi().confirmState).toBeNull();
    wrapper.unmount();
    document.body.innerHTML = '';

    await open('/workflows/new');
    await until(() => labels().length === 2);
    type(nameField(), 'Con un cambio');
    await until(unsaved);
    const leaving = router.push('/workflows');
    await until(() => useUi().confirmState !== null);
    expect(useUi().confirmState!.title).toBe('Cambios sin guardar');
    useUi().answer(false);
    await leaving;
    expect(router.currentRoute.value.path).toBe('/workflows/new');
    expect(nameField().value).toBe('Con un cambio');
  });

  it('el primer guardado conserva la pantalla: deshacer, selección, lienzo y foco, ya en la dirección del workflow creado', async () => {
    await open('/workflows/new', '/workflows');
    await until(() => labels().length === 2);
    // Un nodo nuevo queda seleccionado; se le cambia la etiqueta y se espera a que el historial lo anote.
    [...document.body.querySelectorAll<HTMLButtonElement>('.palette .pal-item')].find((b) => b.textContent?.includes('Transformación'))!.click();
    await until(() => document.body.querySelector('#in-label') !== null);
    const label = document.body.querySelector<HTMLInputElement>('#in-label')!;
    await until(() => !button('Deshacer').disabled);
    await pause(400); // los cambios seguidos se agrupan en un solo paso: añadir y renombrar van por separado
    type(label, 'Resumen');
    await pause(400);
    const firstNode = document.body.querySelector('.vue-flow__node')!;
    const pane = document.body.querySelector<HTMLElement>('.vue-flow__transformationpane')!;
    const transform = pane.style.transform;
    label.focus();

    // Ctrl+S con el foco en un campo: se crea el workflow.
    label.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }));
    await until(() => api.ctx.store.listWorkflows().length === 1);
    const { id } = api.ctx.store.listWorkflows()[0];
    await until(() => router.currentRoute.value.path === `/workflows/${id}`);
    await flushPromises();

    // Los mismos elementos del DOM: la pantalla no se ha destruido y vuelto a crear.
    expect(document.body.querySelector('.vue-flow__node')).toBe(firstNode);
    expect(document.body.querySelector('.vue-flow__transformationpane')).toBe(pane);
    expect(pane.style.transform).toBe(transform);
    expect(document.body.querySelector('#in-label')).toBe(label);
    expect(document.activeElement).toBe(label);
    expect(label.value).toBe('Resumen');
    expect(labels()).toHaveLength(3);
    expect(unsaved()).toBe(false);
    // Ya es un workflow guardado: aparecen programar y exportar.
    expect(button('Exportar')).not.toBeNull();

    // El historial sigue ahí: deshacer devuelve la etiqueta anterior y deja cambios pendientes sobre lo guardado.
    expect(button('Deshacer').disabled).toBe(false);
    button('Deshacer').click();
    await until(() => document.body.querySelector<HTMLInputElement>('#in-label')?.value === 'Transformación');
    await until(unsaved);
    // Guardar de nuevo actualiza el mismo workflow, no crea otro.
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }));
    await until(() => api.ctx.store.getWorkflow(id)?.nodes.some((n) => n.label === 'Transformación') === true);
    expect(api.ctx.store.listWorkflows()).toHaveLength(1);

    // «Atrás» no vuelve a «nuevo», sino a donde se estaba antes de abrirlo.
    await until(() => !unsaved());
    router.back();
    await until(() => router.currentRoute.value.path !== `/workflows/${id}`);
    expect(router.currentRoute.value.path).toBe('/workflows');
  });

  it('de un workflow a otro, y de uno existente a «nuevo», la pantalla empieza limpia', async () => {
    const first = api.ctx.store.createWorkflow({
      ...workflow(
        [node('entrada', 'input'), node('paso', 'transform', { template: '{{entrada}}' }), node('salida', 'output')],
        edges('entrada>paso', 'paso>salida'),
      ),
      name: 'Primero',
    });
    const second = api.ctx.store.createWorkflow({
      ...workflow([node('entrada', 'input'), node('salida', 'output', { template: '{{entrada}}' })], edges('entrada>salida')),
      name: 'Segundo',
    });
    await open(`/workflows/${first.id}`);
    await until(() => labels().length === 3);
    document.body.querySelector<HTMLElement>('.vue-flow__node')!.click();
    await until(() => document.body.querySelector('#in-label') !== null);
    const before = nameField();

    await router.push(`/workflows/${second.id}`);
    await until(() => nameField() !== null && nameField() !== before && nameField().value === 'Segundo');
    await until(() => labels().length === 2);
    // Sin la selección ni el historial del anterior.
    expect(document.body.querySelector('#in-label')).toBeNull();
    expect(document.body.querySelector('#wf-desc')).not.toBeNull();
    expect(button('Deshacer').disabled).toBe(true);
    expect(unsaved()).toBe(false);

    const existing = nameField();
    await router.push('/workflows/new');
    await until(() => nameField() !== null && nameField() !== existing && nameField().value === 'Nuevo workflow');
    await until(() => labels().length === 2);
    expect(button('Deshacer').disabled).toBe(true);
    expect(document.body.querySelector('button[aria-label="Exportar"]')).toBeNull();
    expect(unsaved()).toBe(false);
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
