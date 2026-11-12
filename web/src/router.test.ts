// @vitest-environment jsdom
// El router de la aplicación (rutas, título y paso del foco al contenido) con las pantallas reales contra la API
// real (ver src/test/harness.ts): el primer guardado de un agente nuevo cambia la dirección, no la página.
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { announcement } from '@/lib/a11y';
import { freshPinia, setTouchDevice, startApi, until, type TestApi } from '@/test/harness';
import { router } from './router';

let api: TestApi;
let wrapper: VueWrapper;

const field = (selector: string) => document.querySelector<HTMLInputElement>(selector);

beforeEach(async () => {
  setTouchDevice(false);
  window.scrollTo = () => {}; // jsdom no lo implementa; la ventana no es lo que se desplaza (ver router.ts)
  api = await startApi();
  api.ctx.store.createProvider({ name: 'Proveedor de prueba', kind: 'ollama', baseUrl: 'http://127.0.0.1:1', defaultModel: 'test-model' });
});
afterEach(async () => {
  wrapper?.unmount();
  document.body.innerHTML = '';
  await api.close();
});

describe('router', () => {
  it('el primer guardado de un agente nuevo adopta su dirección sin mover el foco, el desplazamiento ni anunciar otra página', async () => {
    const pinia = freshPinia();
    await router.push('/agents');
    await router.push('/agents/new');
    // Como en App.vue: el contenido se desplaza dentro de <main>, que es quien recibe el foco al cambiar de página.
    wrapper = mount(
      { template: '<main id="contenido" tabindex="-1"><RouterView /></main>' },
      { global: { plugins: [pinia, router] }, attachTo: document.body },
    );
    const main = document.getElementById('contenido')!;
    await until(() => field('#ag-name') !== null);
    expect(document.title).toBe('Nuevo agente · AgentForge');
    await flushPromises();

    await wrapper.get('#ag-name').setValue('Desde el router');
    const name = field('#ag-name')!;
    name.focus();
    main.scrollTop = 120;
    const announcedBefore = announcement.value;
    await wrapper.get('form').trigger('submit');
    await until(() => api.ctx.store.listAgents().length === 1);
    const { id } = api.ctx.store.listAgents()[0];
    await until(() => window.location.pathname === `/agents/${id}`);
    await flushPromises();

    // La dirección y el título son ya los del agente; la entrada de «nuevo» se ha sustituido en el historial.
    expect(document.title).toBe('Agente · AgentForge');
    expect(window.history.state).toMatchObject({ current: `/agents/${id}`, back: '/agents', replaced: true });
    // La pantalla es la misma: mismo campo, con el foco, y el contenido sigue donde estaba.
    expect(field('#ag-name')).toBe(name);
    expect(document.activeElement).toBe(name);
    expect(main.scrollTop).toBe(120);
    expect(announcement.value).toBe(announcedBefore);

    // En cambio, abrir otro agente sí es un cambio de página: pantalla nueva, foco al contenido y anuncio.
    const other = api.ctx.store.createAgent({ ...api.ctx.store.listAgents()[0], name: 'Otro agente' });
    await router.push(`/agents/${other.id}`);
    await until(() => field('#ag-name') !== null && field('#ag-name') !== name && field('#ag-name')!.value === 'Otro agente');
    await until(() => document.activeElement === main);
    expect(main.scrollTop).toBe(0);
    await until(() => announcement.value === 'Página: Agente');
  });
});
