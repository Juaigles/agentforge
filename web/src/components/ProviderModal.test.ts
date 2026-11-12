// @vitest-environment jsdom
// Diálogo de alta y edición de un proveedor de modelos, contra la API real (ver src/test/harness.ts).
// El único doble es el proveedor LLM (`LlmFactory`); se comprueba lo que queda guardado en el almacén del servidor.
import type { Provider } from '@shared/types';
import { DOMWrapper, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LlmClient, LlmProviderConfig } from '../../../server/src/llm/types';
import { useCatalog } from '@/stores/catalog';
import { useUi } from '@/stores/ui';
import { freshPinia, startApi, testRouter, until, type TestApi } from '@/test/harness';
import ProviderModal from './ProviderModal.vue';

let api: TestApi;
let wrapper: VueWrapper;

function open(provider: Provider | null = null): void {
  wrapper = mount(ProviderModal, { props: { provider }, global: { plugins: [freshPinia(), testRouter()] }, attachTo: document.body });
}
const field = <T extends HTMLElement>(id: string) => new DOMWrapper<T>(document.body.querySelector<T>(`#${id}`)!);
const text = () => document.body.textContent ?? '';
const button = (label: string) => {
  const el = [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
  if (!el) throw new Error(`No hay un botón «${label}»`);
  return new DOMWrapper(el);
};
const submit = () => new DOMWrapper(document.body.querySelector<HTMLButtonElement>('button[type="submit"]')!);
const fill = async (values: { name?: string; url?: string; key?: string; model?: string }) => {
  if (values.name !== undefined) await field<HTMLInputElement>('prv-name').setValue(values.name);
  if (values.url !== undefined) await field<HTMLInputElement>('prv-url').setValue(values.url);
  if (values.key !== undefined) await field<HTMLInputElement>('prv-key').setValue(values.key);
  if (values.model !== undefined) await field<HTMLInputElement>('prv-model').setValue(values.model);
};
const stored = () => api.ctx.store.listProviders();
const toasts = () => useUi().toasts.map((t) => t.message);
const saved = () => wrapper.emitted('saved');
/** Texto cifrado tal cual está en la base de datos. */
const rawKey = (id: string) =>
  (api.ctx.store.db.prepare('SELECT api_key_enc FROM providers WHERE id = ?').get(id) as { api_key_enc: string | null }).api_key_enc;

/** Registra con qué configuración llama el servidor al proveedor (misma frontera LlmFactory) y lo hace responder o fallar. */
function watchProvider(opts: { down?: boolean } = {}): LlmProviderConfig[] {
  const seen: LlmProviderConfig[] = [];
  const working = api.llm.create.bind(api.llm);
  api.llm.create = (config?: LlmProviderConfig): LlmClient => {
    if (config) seen.push(config);
    const client = working();
    return {
      ...client,
      listModels: async (signal?: AbortSignal) => {
        if (opts.down) throw new Error('connect ECONNREFUSED 127.0.0.1:11434');
        return client.listModels(signal);
      },
    };
  };
  return seen;
}

beforeEach(async () => {
  api = await startApi();
});
afterEach(async () => {
  wrapper?.unmount();
  document.body.innerHTML = '';
  await api.close();
});

describe('ProviderModal · plantillas', () => {
  it('al aplicar una plantilla rellena nombre, tipo y URL', async () => {
    open();
    expect(text()).toContain('Añadir proveedor');
    await button('OpenAI').trigger('click');
    expect(field<HTMLInputElement>('prv-name').element.value).toBe('OpenAI');
    expect(field<HTMLSelectElement>('prv-kind').element.value).toBe('openai');
    expect(field<HTMLInputElement>('prv-url').element.value).toBe('https://api.openai.com/v1');

    await button('Ollama local').trigger('click');
    expect(field<HTMLInputElement>('prv-name').element.value).toBe('Ollama local');
    expect(field<HTMLSelectElement>('prv-kind').element.value).toBe('ollama');
    expect(field<HTMLInputElement>('prv-url').element.value).toBe('http://localhost:11434');
  });

  it('cambiar de plantilla sustituye el nombre de la anterior pero respeta el que escribió el usuario', async () => {
    open();
    await button('Groq').trigger('click');
    await button('LM Studio').trigger('click');
    expect(field<HTMLInputElement>('prv-name').element.value).toBe('LM Studio');
    expect(field<HTMLInputElement>('prv-url').element.value).toBe('http://localhost:1234/v1');

    await fill({ name: 'Mi servidor' });
    await button('OpenRouter').trigger('click');
    expect(field<HTMLInputElement>('prv-name').element.value).toBe('Mi servidor');
    expect(field<HTMLInputElement>('prv-url').element.value).toBe('https://openrouter.ai/api/v1');
  });

  it('una plantilla aplicada se puede guardar tal cual y queda como proveedor real', async () => {
    open();
    await button('Groq').trigger('click');
    await submit().trigger('click');
    await until(() => stored().length === 1);
    expect(stored()[0]).toMatchObject({ name: 'Groq', kind: 'openai', baseUrl: 'https://api.groq.com/openai/v1', hasApiKey: false, enabled: true });
  });
});

describe('ProviderModal · alta', () => {
  it('da de alta un proveedor sin API key: lo guarda, avisa y lo añade al catálogo', async () => {
    open();
    await fill({ name: '  Ollama de casa ', url: 'http://127.0.0.1:11434', model: 'qwen3:8b' });
    await submit().trigger('click');
    await until(() => stored().length === 1);

    expect(stored()[0]).toMatchObject({
      name: 'Ollama de casa',
      kind: 'ollama',
      baseUrl: 'http://127.0.0.1:11434',
      defaultModel: 'qwen3:8b',
      hasApiKey: false,
      enabled: true,
    });
    expect(rawKey(stored()[0].id)).toBeNull();
    await until(() => saved() !== undefined);
    expect((saved()![0][0] as Provider).id).toBe(stored()[0].id);
    expect(toasts()).toContain('Proveedor «Ollama de casa» añadido.');
    expect(useCatalog().providers.map((p) => p.id)).toContain(stored()[0].id);
  });

  it('con API key la guarda cifrada y la API nunca la devuelve, solo «hasApiKey»', async () => {
    open();
    await button('OpenAI').trigger('click');
    await fill({ key: 'sk-clave-muy-secreta-123' });
    await submit().trigger('click');
    await until(() => stored().length === 1);

    const [provider] = stored();
    expect(provider.hasApiKey).toBe(true);
    // En la base de datos hay un texto cifrado, no la clave; el motor sí puede descifrarla.
    expect(rawKey(provider.id)).toBeTruthy();
    expect(rawKey(provider.id)).not.toContain('sk-clave-muy-secreta-123');
    expect(api.ctx.store.getProviderWithSecret(provider.id)!.apiKey).toBe('sk-clave-muy-secreta-123');
    // Ni la lista ni el detalle que lee el navegador contienen la clave.
    const listed = await (await fetch('/api/providers')).text();
    expect(listed).not.toContain('sk-clave-muy-secreta-123');
    expect(JSON.parse(listed)[0]).toMatchObject({ id: provider.id, hasApiKey: true });
    expect(JSON.parse(listed)[0]).not.toHaveProperty('apiKey');
    expect(JSON.stringify(useCatalog().providers)).not.toContain('sk-clave-muy-secreta-123');
    // El campo es de tipo contraseña.
    expect(field<HTMLInputElement>('prv-key').attributes('type')).toBe('password');
  });

  it('un nombre repetido no se rechaza (el servidor no exige nombres únicos de proveedor) y se guardan los dos', async () => {
    api.ctx.store.createProvider({ name: 'Ollama local', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434' });
    open();
    await fill({ name: 'Ollama local', url: 'http://127.0.0.1:11435' });
    await submit().trigger('click');
    await until(() => stored().length === 2);
    expect(stored().map((p) => p.name)).toEqual(['Ollama local', 'Ollama local']);
    expect(text()).not.toContain('Datos no válidos');
  });
});

describe('ProviderModal · probar conexión', () => {
  it('prueba la configuración antes de guardar, carga la lista de modelos y no guarda nada', async () => {
    open();
    await button('Ollama local').trigger('click');
    expect(text()).toContain('Pulsa «Probar» para cargar la lista de modelos.');

    await button('Probar').trigger('click');
    await until(() => text().includes('Conexión correcta: 1 modelo en '));
    await until(() => text().includes('1 modelo disponible'));

    const options = [...document.body.querySelectorAll('#prv-models option')].map((o) => o.getAttribute('value'));
    expect(options).toEqual(['test-model']);
    expect(stored()).toHaveLength(0);
    expect(saved()).toBeUndefined();
  });

  it('prueba con la configuración que hay en el formulario (tipo, URL y clave tecleada)', async () => {
    const seen = watchProvider();
    open();
    await button('OpenAI').trigger('click');
    await fill({ url: 'https://api.openai.com/v1', key: 'sk-de-prueba' });
    await button('Probar').trigger('click');
    await until(() => text().includes('Conexión correcta'));
    // Una prueba para el estado de la conexión y otra para la lista de modelos, las dos con la misma configuración.
    expect(seen.length).toBeGreaterThanOrEqual(2);
    for (const config of seen) expect(config).toEqual({ kind: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-de-prueba' });
    expect(stored()).toHaveLength(0);
  });

  it('si el proveedor no responde muestra el motivo y no carga modelos', async () => {
    watchProvider({ down: true });
    open();
    await fill({ name: 'Caído' });
    await button('Probar').trigger('click');
    await until(() => document.body.querySelector('.callout.danger') !== null);
    expect(document.body.querySelector('.callout.danger')!.textContent).toContain('connect ECONNREFUSED 127.0.0.1:11434');
    expect(text()).not.toContain('Conexión correcta');
    expect(document.body.querySelectorAll('#prv-models option')).toHaveLength(0);
    expect(text()).toContain('Pulsa «Probar» para cargar la lista de modelos.');
  });

  it('cambiar la URL, el tipo o la clave descarta el resultado de la prueba anterior', async () => {
    open();
    await fill({ name: 'Cambiante' });
    await button('Probar').trigger('click');
    await until(() => text().includes('Conexión correcta'));

    await fill({ url: 'http://127.0.0.1:11999' });
    expect(text()).not.toContain('Conexión correcta');
    expect(document.body.querySelectorAll('#prv-models option')).toHaveLength(0);

    await button('Probar').trigger('click');
    await until(() => text().includes('Conexión correcta'));
    await field<HTMLSelectElement>('prv-kind').setValue('openai');
    expect(text()).not.toContain('Conexión correcta');
  });

  it('probar sin nombre también exige el nombre (la validación es la misma que al guardar) y lo señala en su campo', async () => {
    open();
    await button('Probar').trigger('click');
    await until(() => text().includes('El nombre es obligatorio'));
    expect(text()).not.toContain('Conexión correcta');
  });

  it('con datos no válidos la prueba muestra el error de validación en su campo', async () => {
    open();
    await fill({ name: 'X', url: 'esto no es una url' });
    await button('Probar').trigger('click');
    await until(() => text().includes('Debe ser una URL http(s) válida'));
    expect(field('prv-url').attributes('aria-invalid')).toBe('true');
    expect(text()).not.toContain('Conexión correcta');
  });

  it('al editar, prueba con la clave guardada sin reenviarla y se niega si la URL cambia de origen', async () => {
    const seen = watchProvider();
    const provider = api.ctx.store.createProvider({ name: 'Remoto', kind: 'openai', baseUrl: 'https://api.ejemplo.com/v1', apiKey: 'sk-guardada' });
    open(provider);

    await button('Probar').trigger('click');
    await until(() => text().includes('Conexión correcta'));
    expect(seen[0]).toEqual({ kind: 'openai', baseUrl: 'https://api.ejemplo.com/v1', apiKey: 'sk-guardada' });

    // La clave guardada no viaja a otra dirección: hay que volver a escribirla.
    await fill({ url: 'https://otra.dominio.com/v1' });
    const before = seen.length;
    await button('Probar').trigger('click');
    await until(() => text().includes('Has cambiado la dirección del proveedor'));
    expect(seen).toHaveLength(before);
  });
});

describe('ProviderModal · validación del servidor', () => {
  it('un nombre vacío se rechaza y el error aparece junto al campo, sin guardar nada', async () => {
    open();
    await fill({ name: '   ' });
    await submit().trigger('click');
    await until(() => text().includes('El nombre es obligatorio'));
    expect(field('prv-name').element.parentElement!.querySelector('.error')!.textContent).toBe('El nombre es obligatorio');
    expect(field('prv-name').attributes('aria-invalid')).toBe('true');
    expect(stored()).toHaveLength(0);
    expect(saved()).toBeUndefined();
  });

  it('una URL que no es http(s) se rechaza en su campo, y al corregirla se puede guardar', async () => {
    open();
    await fill({ name: 'Raro', url: 'ftp://servidor/v1' });
    await submit().trigger('click');
    await until(() => text().includes('Debe ser una URL http(s) válida'));
    expect(field('prv-url').element.parentElement!.querySelector('.error')!.textContent).toBe('Debe ser una URL http(s) válida');
    expect(field('prv-name').attributes('aria-invalid')).toBe('false');
    expect(stored()).toHaveLength(0);

    await fill({ url: 'http://127.0.0.1:11434' });
    await submit().trigger('click');
    await until(() => stored().length === 1);
    expect(stored()[0].baseUrl).toBe('http://127.0.0.1:11434');
  });

  it('varios campos erróneos a la vez se señalan todos', async () => {
    open();
    await fill({ name: ' ', url: 'nada' });
    await submit().trigger('click');
    await until(() => text().includes('El nombre es obligatorio') && text().includes('Debe ser una URL http(s) válida'));
  });

  it('una API key demasiado larga se rechaza en el campo de la clave', async () => {
    open();
    await fill({ name: 'Largo', key: 'k'.repeat(501) });
    await submit().trigger('click');
    await until(() => field('prv-key').element.closest('.field')!.querySelector('.error') !== null);
    expect(field('prv-key').attributes('aria-invalid')).toBe('true');
    expect(stored()).toHaveLength(0);
  });

  it('un proveedor que ya no existe al guardar la edición lo dice y no crea otro', async () => {
    const provider = api.ctx.store.createProvider({ name: 'Efímero', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434' });
    open(provider);
    api.ctx.store.deleteProvider(provider.id);
    await submit().trigger('click');
    await until(() => document.body.querySelector('.callout.danger') !== null);
    expect(document.body.querySelector('.callout.danger')!.textContent).toContain('Proveedor');
    expect(stored()).toHaveLength(0);
    expect(saved()).toBeUndefined();
  });
});

describe('ProviderModal · edición', () => {
  it('carga los datos del proveedor y, sin escribir otra clave, conserva la guardada', async () => {
    const provider = api.ctx.store.createProvider({
      name: 'Remoto',
      kind: 'openai',
      baseUrl: 'https://api.ejemplo.com/v1',
      apiKey: 'sk-conservada',
      defaultModel: 'gpt-x',
    });
    open(provider);
    expect(text()).toContain('Editar proveedor');
    expect(field<HTMLInputElement>('prv-name').element.value).toBe('Remoto');
    expect(field<HTMLSelectElement>('prv-kind').element.value).toBe('openai');
    expect(field<HTMLInputElement>('prv-url').element.value).toBe('https://api.ejemplo.com/v1');
    expect(field<HTMLInputElement>('prv-model').element.value).toBe('gpt-x');
    // La clave nunca se muestra: el campo está vacío y avisa de que hay una guardada.
    expect(field<HTMLInputElement>('prv-key').element.value).toBe('');
    expect(field<HTMLInputElement>('prv-key').attributes('placeholder')).toContain('guardada');

    const cipher = rawKey(provider.id);
    await fill({ name: 'Remoto renombrado', model: 'gpt-y' });
    await submit().trigger('click');
    await until(() => stored()[0].name === 'Remoto renombrado');

    expect(stored()[0]).toMatchObject({ id: provider.id, defaultModel: 'gpt-y', hasApiKey: true });
    expect(api.ctx.store.getProviderWithSecret(provider.id)!.apiKey).toBe('sk-conservada');
    expect(rawKey(provider.id)).toBe(cipher);
    await until(() => toasts().includes('Proveedor «Remoto renombrado» actualizado.'));
    expect(stored()).toHaveLength(1);
  });

  it('escribir una clave nueva sustituye la guardada', async () => {
    const provider = api.ctx.store.createProvider({ name: 'Remoto', kind: 'openai', baseUrl: 'https://api.ejemplo.com/v1', apiKey: 'sk-vieja' });
    open(provider);
    await fill({ key: 'sk-nueva' });
    // Al escribir una clave nueva ya no se ofrece quitar la anterior.
    expect(document.body.textContent).not.toContain('Quitar clave');
    await submit().trigger('click');
    await until(() => api.ctx.store.getProviderWithSecret(provider.id)!.apiKey === 'sk-nueva');
    expect(stored()[0].hasApiKey).toBe(true);
  });

  it('«Quitar clave» borra la clave guardada al guardar', async () => {
    const provider = api.ctx.store.createProvider({ name: 'Remoto', kind: 'openai', baseUrl: 'https://api.ejemplo.com/v1', apiKey: 'sk-borrar' });
    open(provider);
    await button('Quitar clave').trigger('click');
    expect(text()).toContain('La clave guardada se eliminará al guardar.');
    expect(text()).not.toContain('Quitar clave');
    // Todavía no se ha tocado nada en el servidor.
    expect(stored()[0].hasApiKey).toBe(true);

    await submit().trigger('click');
    await until(() => !stored()[0].hasApiKey);
    expect(rawKey(provider.id)).toBeNull();
    expect(api.ctx.store.getProviderWithSecret(provider.id)!.apiKey).toBeNull();
  });

  it('«Deshacer» tras «Quitar clave» devuelve la clave guardada y se conserva al guardar', async () => {
    const provider = api.ctx.store.createProvider({ name: 'Remoto', kind: 'openai', baseUrl: 'https://api.ejemplo.com/v1', apiKey: 'sk-sigue' });
    open(provider);
    await button('Quitar clave').trigger('click');
    await button('Deshacer').trigger('click');
    expect(text()).not.toContain('La clave guardada se eliminará al guardar.');
    expect(text()).toContain('Quitar clave');

    await fill({ name: 'Remoto 2' });
    await submit().trigger('click');
    await until(() => stored()[0].name === 'Remoto 2');
    expect(stored()[0].hasApiKey).toBe(true);
    expect(api.ctx.store.getProviderWithSecret(provider.id)!.apiKey).toBe('sk-sigue');
  });

  it('un proveedor sin clave guardada no ofrece «Quitar clave»', async () => {
    open(api.ctx.store.createProvider({ name: 'Local', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434' }));
    expect(text()).not.toContain('Quitar clave');
  });

  it('cambiar la URL a otro origen sin escribir la clave se rechaza y no mueve la clave guardada a otra dirección', async () => {
    const provider = api.ctx.store.createProvider({ name: 'Remoto', kind: 'openai', baseUrl: 'https://api.ejemplo.com/v1', apiKey: 'sk-no-viaja' });
    open(provider);
    await fill({ url: 'https://captura.ejemplo.net/v1' });
    await submit().trigger('click');
    await until(() => text().includes('Has cambiado la dirección del proveedor'));
    expect(stored()[0].baseUrl).toBe('https://api.ejemplo.com/v1');
    expect(api.ctx.store.getProviderWithSecret(provider.id)!.apiKey).toBe('sk-no-viaja');
    expect(saved()).toBeUndefined();

    // Quitando la clave (o escribiendo otra) sí se puede cambiar de dirección.
    await button('Quitar clave').trigger('click');
    await submit().trigger('click');
    await until(() => stored()[0].baseUrl === 'https://captura.ejemplo.net/v1');
    expect(stored()[0].hasApiKey).toBe(false);
  });

  it('desactiva un proveedor y lo vuelve a activar', async () => {
    const provider = api.ctx.store.createProvider({ name: 'Conmutable', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434' });
    open(provider);
    const enabled = field<HTMLInputElement>('prv-url').element.closest('form')!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(enabled.checked).toBe(true);
    await new DOMWrapper(enabled).setValue(false);
    await submit().trigger('click');
    await until(() => !stored()[0].enabled);
    await until(() => toasts().includes('Proveedor «Conmutable» actualizado.'));

    wrapper.unmount();
    document.body.innerHTML = '';
    open(stored()[0]);
    const again = document.body.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(again.checked).toBe(false);
    await new DOMWrapper(again).setValue(true);
    await submit().trigger('click');
    await until(() => stored()[0].enabled);
  });

  it('se puede dar de alta un proveedor ya desactivado', async () => {
    open();
    await fill({ name: 'Apagado' });
    await new DOMWrapper(document.body.querySelector<HTMLInputElement>('input[type="checkbox"]')!).setValue(false);
    await submit().trigger('click');
    await until(() => stored().length === 1);
    expect(stored()[0]).toMatchObject({ name: 'Apagado', enabled: false });
  });

  it('«Cancelar» cierra el diálogo sin guardar nada', async () => {
    open();
    await fill({ name: 'Descartado' });
    await button('Cancelar').trigger('click');
    expect(wrapper.emitted('close')).toHaveLength(1);
    expect(stored()).toHaveLength(0);
  });
});
