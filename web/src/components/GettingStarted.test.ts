// @vitest-environment jsdom
// Guía de primeros pasos contra la API real (ver src/test/harness.ts). El único doble es el proveedor LLM.
import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useCatalog } from '@/stores/catalog';
import { useUi } from '@/stores/ui';
import { freshPinia, setTouchDevice, startApi, testRouter, until, type TestApi } from '@/test/harness';
import GettingStarted from './GettingStarted.vue';

let api: TestApi;
let wrapper: VueWrapper;

async function open(): Promise<void> {
  const pinia = freshPinia();
  const catalog = useCatalog();
  await catalog.reload();
  await catalog.refreshHealth(true);
  wrapper = mount(GettingStarted, { global: { plugins: [pinia, testRouter()] }, attachTo: document.body });
}
const guide = () => wrapper.find('[data-testid="guide"]');
const button = (text: string) => wrapper.findAll('button').find((b) => b.text().includes(text));

beforeEach(async () => {
  setTouchDevice(false);
  localStorage.clear();
  api = await startApi();
});
afterEach(async () => {
  wrapper?.unmount();
  document.body.innerHTML = '';
  await api.close();
});

describe('GettingStarted', () => {
  it('con el proveedor Ollama caído explica qué es, cómo instalarlo y qué modelo descargar', async () => {
    api.ctx.store.createProvider({ name: 'Ollama local', kind: 'ollama', baseUrl: 'http://127.0.0.1:1', defaultModel: 'qwen3.5:4b' });
    // El proveedor no responde: falla en la misma frontera (LlmFactory) que usa el servidor.
    api.llm.create = () => ({
      chat: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:1');
      },
      listModels: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:1');
      },
    });
    await open();
    await until(() => guide().exists());

    expect(guide().text()).toContain('0 de 3 completados');
    expect(guide().text()).toContain('«Ollama local» no responde');
    expect(guide().find('.command code').text()).toBe('ollama pull qwen3.5:4b');
    const download = guide().find('a[href="https://ollama.com/download"]');
    expect(download.exists()).toBe(true);
    expect(download.attributes('rel')).toContain('noopener');
    expect(guide().text()).toContain('compatible con OpenAI');
    expect(button('Probar conexión')).toBeDefined();
  });

  it('«Probar conexión» vuelve a comprobar el proveedor y marca el paso cuando responde', async () => {
    api.ctx.store.createProvider({ name: 'Ollama local', kind: 'ollama', baseUrl: 'http://127.0.0.1:1', defaultModel: 'test-model' });
    const working = api.llm.create.bind(api.llm);
    let down = true;
    api.llm.create = () => {
      const client = working();
      return {
        ...client,
        listModels: async (signal?: AbortSignal) => {
          if (down) throw new Error('connect ECONNREFUSED 127.0.0.1:1');
          return client.listModels(signal);
        },
      };
    };
    await open();
    await until(() => guide().exists());
    expect(guide().text()).toContain('0 de 3 completados');

    // Sigue caído: lo dice y no marca nada.
    await button('Probar conexión')!.trigger('click');
    await until(() => useUi().toasts.some((t) => t.message === 'El proveedor sigue sin responder.'));
    expect(guide().text()).toContain('0 de 3 completados');

    // Ollama arranca: el paso 1 queda hecho y desaparecen las instrucciones.
    down = false;
    await button('Probar conexión')!.trigger('click');
    await until(() => guide().text().includes('1 de 3 completados'));
    expect(guide().find('.command').exists()).toBe(false);
    expect(guide().findAll('li.done')).toHaveLength(1);
    expect(useUi().toasts.some((t) => t.message === 'Conexión con el modelo comprobada.')).toBe(true);
  });

  it('sin ningún proveedor remite a Ajustes, y «Ocultar guía» se recuerda', async () => {
    await open();
    await until(() => guide().exists());
    expect(guide().text()).toContain('No hay ningún proveedor configurado');
    expect(guide().text()).toContain('Crear un agente');
    expect(guide().text()).toContain('Crear un workflow');

    await button('Ocultar guía')!.trigger('click');
    expect(guide().exists()).toBe(false);
    wrapper.unmount();
    await open();
    await new Promise((r) => setTimeout(r, 100));
    expect(guide().exists()).toBe(false);
  });
});
