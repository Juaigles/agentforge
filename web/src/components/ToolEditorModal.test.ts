// @vitest-environment jsdom
// Editor de herramientas HTTP personalizadas contra la API real (ver src/test/harness.ts). El único doble es el proveedor LLM.
import { DOMWrapper, flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installFormA11y } from '@/lib/a11y';
import { freshPinia, startApi, testRouter, until, type TestApi } from '@/test/harness';
import ToolEditorModal from './ToolEditorModal.vue';

let api: TestApi;
let wrapper: VueWrapper;

async function open(customId?: string): Promise<void> {
  const pinia = freshPinia();
  wrapper = mount(ToolEditorModal, { props: { customId }, global: { plugins: [pinia, testRouter()] }, attachTo: document.body });
  await until(() => document.body.querySelector('#te-name') !== null || document.body.querySelector('.callout.danger') !== null);
}

// El modal se teletransporta a <body>: se busca ahí, no en el wrapper.
const $ = (selector: string) => new DOMWrapper(document.body.querySelector(selector) as HTMLElement);
const $$ = (selector: string) => [...document.body.querySelectorAll(selector)].map((el) => new DOMWrapper(el as HTMLElement));
const exists = (selector: string) => document.body.querySelector(selector) !== null;
const button = (text: string) => $$('button').find((b) => b.text().includes(text))!;
const bodyText = () => document.body.textContent ?? '';
const saved = () => (wrapper.emitted('saved') ?? []) as string[][];

/** Rellena el mínimo para poder crear: nombre, descripción y URL. */
async function fillBasics(name = 'consultar_clima', url = 'https://api.ejemplo.com/clima'): Promise<void> {
  await $('#te-name').setValue(name);
  await $('#te-desc').setValue('Consulta el tiempo actual de una ciudad.');
  await $('#te-url').setValue(url);
}
/** Añade un parámetro y devuelve sus campos. */
async function addParam(name: string, opts: { type?: string; description?: string; allowed?: string; def?: string; required?: boolean } = {}) {
  await button('Añadir parámetro').trigger('click');
  const rows = $$('.param-row');
  const row = rows[rows.length - 1].element;
  const field = (prefix: string) => new DOMWrapper(row.querySelector(`[id^="te-${prefix}-"]`) as HTMLElement);
  await field('pn').setValue(name);
  if (opts.type) await field('pt').setValue(opts.type);
  if (opts.description) await field('pd').setValue(opts.description);
  if (opts.allowed !== undefined) await field('pe').setValue(opts.allowed);
  if (opts.def !== undefined) await field('pv').setValue(opts.def);
  if (opts.required === false) await new DOMWrapper(row.querySelector('input[type="checkbox"]') as HTMLElement).setValue(false);
  return { row, field };
}
async function addHeader(name: string, value: string): Promise<void> {
  await button('Añadir cabecera').trigger('click');
  const n = $$('.header-row').length;
  await $(`input[aria-label="Nombre de la cabecera ${n}"]`).setValue(name);
  await $(`input[aria-label="Valor de la cabecera ${n}"]`).setValue(value);
}
async function submit(label = 'Crear herramienta'): Promise<void> {
  await button(label).trigger('click');
  await flushPromises();
}

beforeEach(async () => {
  api = await startApi();
});
afterEach(async () => {
  wrapper?.unmount();
  document.body.innerHTML = '';
  await api.close();
});

describe('ToolEditorModal: alta', () => {
  it('crea una herramienta mínima (nombre, descripción, método y URL) y lo que queda guardado es lo escrito', async () => {
    await open();
    expect(bodyText()).toContain('Nueva herramienta HTTP');
    await fillBasics();
    await submit();
    await until(() => saved().length === 1);

    expect(saved()[0]).toEqual(['consultar_clima']);
    const tools = api.ctx.store.listCustomTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      name: 'consultar_clima',
      description: 'Consulta el tiempo actual de una ciudad.',
      method: 'GET',
      urlTemplate: 'https://api.ejemplo.com/clima',
      bodyTemplate: '',
      enabled: true,
      headers: {},
    });
    expect(tools[0].parameters).toEqual({ type: 'object', properties: {}, required: [] });
  });

  it('guarda el método elegido y la herramienta desactivada', async () => {
    await open();
    await fillBasics();
    await $('#te-method').setValue('DELETE');
    await $('input.switch').setValue(false);
    expect(bodyText()).toContain('Desactivada: no se ofrece a los agentes');
    await submit();
    await until(() => saved().length === 1);
    expect(api.ctx.store.listCustomTools()[0]).toMatchObject({ method: 'DELETE', enabled: false });
  });

  it('con GET no hay plantilla de cuerpo y con POST sí; al volver a GET no se guarda el cuerpo escrito', async () => {
    await open();
    expect(exists('#te-body')).toBe(false);
    await $('#te-method').setValue('POST');
    expect(exists('#te-body')).toBe(true);
    await $('#te-body').setValue('{ "consulta": "x" }');
    await $('#te-method').setValue('GET');
    expect(exists('#te-body')).toBe(false);
    await fillBasics();
    await submit();
    await until(() => saved().length === 1);
    expect(api.ctx.store.listCustomTools()[0].bodyTemplate).toBe('');
  });

  it('guarda la plantilla del cuerpo en POST con su parámetro, sin avisar de huecos sin declarar', async () => {
    await open();
    await fillBasics('enviar_mensaje', 'https://api.ejemplo.com/mensajes');
    await $('#te-method').setValue('POST');
    await $('#te-body').setValue('{ "texto": "{{texto}}" }');
    // Mientras falta el parámetro, avisa.
    expect(bodyText()).toContain('{{texto}}');
    expect(exists('.callout.warning')).toBe(true);
    await addParam('texto', { description: 'Mensaje a enviar' });
    expect(exists('.callout.warning')).toBe(false);
    await submit();
    await until(() => saved().length === 1);
    const tool = api.ctx.store.listCustomTools()[0];
    expect(tool).toMatchObject({ method: 'POST', bodyTemplate: '{ "texto": "{{texto}}" }' });
    expect(tool.parameters.properties.texto).toEqual({ type: 'string', description: 'Mensaje a enviar' });
  });
});

describe('ToolEditorModal: parámetros', () => {
  it('añade parámetros con tipo, obligatorio, valores permitidos y valor por defecto, y guarda el esquema resultante', async () => {
    await open();
    await fillBasics('buscar', 'https://api.ejemplo.com/buscar?q={{q}}&n={{n}}&idioma={{idioma}}');
    await addParam('q', { description: 'Texto a buscar' });
    await addParam('n', { type: 'integer', def: '10', required: false });
    await addParam('idioma', { allowed: 'es, en, fr', def: 'es', required: false });
    await submit();
    await until(() => saved().length === 1);

    const tool = api.ctx.store.listCustomTools()[0];
    expect(tool.parameters).toEqual({
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Texto a buscar' },
        n: { type: 'integer', default: 10 },
        idioma: { type: 'string', enum: ['es', 'en', 'fr'], default: 'es' },
      },
      required: ['q'],
    });
  });

  it('un parámetro nuevo es obligatorio por defecto', async () => {
    await open();
    await fillBasics();
    await addParam('ciudad');
    await submit();
    await until(() => saved().length === 1);
    expect(api.ctx.store.listCustomTools()[0].parameters.required).toEqual(['ciudad']);
  });

  it('los valores permitidos numéricos se guardan como números y el booleano ofrece «Sí/No» como valor por defecto', async () => {
    await open();
    await fillBasics();
    await addParam('limite', { type: 'number', allowed: '1, 2.5, 3.5', def: '2.5' });
    await addParam('activo', { type: 'boolean', def: 'true' });
    await submit();
    await until(() => saved().length === 1);
    const props = api.ctx.store.listCustomTools()[0].parameters.properties;
    expect(props.limite).toEqual({ type: 'number', enum: [1, 2.5, 3.5], default: 2.5 });
    expect(props.activo).toEqual({ type: 'boolean', default: true });
  });

  it('los valores permitidos no se pueden usar con un tipo que no los admite (el campo queda desactivado)', async () => {
    await open();
    const { field } = await addParam('opciones', { type: 'array' });
    expect((field('pe').element as HTMLInputElement).disabled).toBe(true);
    expect((field('pe').element as HTMLInputElement).placeholder).toBe('No aplica a este tipo');
  });

  it('el valor por defecto de un objeto o lista se guarda como JSON', async () => {
    await open();
    await fillBasics();
    await addParam('filtros', { type: 'object', def: '{"activo": true}', required: false });
    await addParam('etiquetas', { type: 'array', def: '["a","b"]', required: false });
    await submit();
    await until(() => saved().length === 1);
    const props = api.ctx.store.listCustomTools()[0].parameters.properties;
    expect(props.filtros).toEqual({ type: 'object', default: { activo: true } });
    expect(props.etiquetas).toEqual({ type: 'array', default: ['a', 'b'] });
  });

  it('avisa en el parámetro de un valor permitido que no es del tipo, de un por defecto fuera de la lista y de un JSON roto, y no guarda', async () => {
    await open();
    await fillBasics();
    await addParam('n', { type: 'integer', allowed: '1, dos' });
    expect(bodyText()).toContain('Valores permitidos: «dos» no es un número.');
    await addParam('modo', { allowed: 'a, b', def: 'c' });
    expect(bodyText()).toContain('El valor por defecto debe ser uno de los valores permitidos.');
    await addParam('datos', { type: 'object', def: '[1]' });
    expect(bodyText()).toContain('Valor por defecto: Debe ser un objeto JSON');
    await addParam('lista', { type: 'array', def: '{no json' });
    expect(bodyText()).toContain('Valor por defecto: No es JSON válido.');

    await submit();
    expect(saved()).toHaveLength(0);
    expect(api.ctx.store.listCustomTools()).toHaveLength(0);
    expect($('#te-pn-' + $$('.param-row')[0].element.querySelector('input')!.id.split('-').pop()).attributes('aria-invalid')).toBe('true');
  });

  it('quita un parámetro y ya no se guarda', async () => {
    await open();
    await fillBasics();
    await addParam('uno');
    await addParam('dos');
    await $('button[aria-label="Quitar el parámetro uno"]').trigger('click');
    expect($$('.param-row')).toHaveLength(1);
    await submit();
    await until(() => saved().length === 1);
    expect(Object.keys(api.ctx.store.listCustomTools()[0].parameters.properties)).toEqual(['dos']);
  });

  it('señala un nombre de parámetro repetido, uno con caracteres no válidos y uno vacío al guardar', async () => {
    await open();
    await fillBasics();
    await addParam('ciudad');
    await addParam('ciudad');
    expect(bodyText()).toContain('Nombre repetido.');
    await addParam('mal nombre');
    expect(bodyText()).toContain('Solo letras, números y _.');
    await button('Añadir parámetro').trigger('click');
    expect(bodyText()).not.toContain('Falta el nombre.');
    await submit();
    expect(bodyText()).toContain('Falta el nombre.');
    expect(api.ctx.store.listCustomTools()).toHaveLength(0);
  });
});

describe('ToolEditorModal: huecos {{x}} sin parámetro', () => {
  it('avisa de los huecos de la URL sin parámetro declarado y deja de avisar al declararlos', async () => {
    await open();
    await $('#te-url').setValue('https://api.ejemplo.com/{{recurso}}?q={{texto}}');
    const warning = () => document.body.querySelector('.callout.warning')?.textContent ?? '';
    expect(warning()).toContain('{{recurso}}');
    expect(warning()).toContain('{{texto}}');
    expect(warning()).toContain('se sustituirá por un texto vacío');

    await addParam('recurso');
    expect(warning()).not.toContain('{{recurso}}');
    expect(warning()).toContain('{{texto}}');
    await addParam('texto');
    expect(exists('.callout.warning')).toBe(false);
  });

  it('también detecta huecos del cuerpo (solo con un método con cuerpo) y de los valores de las cabeceras', async () => {
    await open();
    await $('#te-method').setValue('POST');
    await $('#te-body').setValue('{ "a": "{{cuerpo}}" }');
    expect(document.body.querySelector('.callout.warning')?.textContent).toContain('{{cuerpo}}');
    await addHeader('X-Usuario', '{{usuario}}');
    expect(document.body.querySelector('.callout.warning')?.textContent).toContain('{{usuario}}');
    // Con GET el cuerpo no se envía, así que su hueco ya no cuenta.
    await $('#te-method').setValue('GET');
    const text = document.body.querySelector('.callout.warning')?.textContent ?? '';
    expect(text).not.toContain('{{cuerpo}}');
    expect(text).toContain('{{usuario}}');
  });

  it('avisar no impide guardar: el servidor admite la herramienta', async () => {
    await open();
    await fillBasics('con_hueco', 'https://api.ejemplo.com/{{nada}}');
    await submit();
    await until(() => saved().length === 1);
    expect(api.ctx.store.getCustomToolByName('con_hueco')?.urlTemplate).toBe('https://api.ejemplo.com/{{nada}}');
  });
});

describe('ToolEditorModal: cabeceras', () => {
  it('guarda cabeceras normales en claro y una credencial cifrada: la API devuelve solo su nombre', async () => {
    await open();
    await fillBasics();
    await addHeader('Accept', 'application/json');
    expect(bodyText()).not.toContain('se guardan cifradas');
    await addHeader('Authorization', 'Bearer super-secreto-123');
    expect(bodyText()).toContain('se guardan cifradas');
    await submit();
    await until(() => saved().length === 1);

    const fromApi = await (await fetch('/api/tools/custom')).json();
    expect(fromApi[0].secretHeaders).toEqual(['Authorization']);
    expect(fromApi[0].headers).toEqual({ Accept: 'application/json', Authorization: '' });
    expect(JSON.stringify(fromApi)).not.toContain('super-secreto-123');
    // El servidor sí la conoce para ejecutar la herramienta.
    expect(api.ctx.store.getCustomToolByName('consultar_clima', true)?.headers.Authorization).toBe('Bearer super-secreto-123');
  });

  it('quita una cabecera y no se guarda; una sin nombre se ignora', async () => {
    await open();
    await fillBasics();
    await addHeader('X-Uno', '1');
    await addHeader('X-Dos', '2');
    await button('Añadir cabecera').trigger('click');
    await $('button[aria-label="Quitar la cabecera 1"]').trigger('click');
    await submit();
    await until(() => saved().length === 1);
    expect(api.ctx.store.listCustomTools()[0].headers).toEqual({ 'X-Dos': '2' });
  });
});

describe('ToolEditorModal: validación en vivo', () => {
  it('no molesta antes de tocar un campo: ni errores ni campos marcados al abrir', async () => {
    await open();
    expect(exists('.error')).toBe(false);
    expect($('#te-name').attributes('aria-invalid')).toBe('false');
    expect($('#te-url').attributes('aria-invalid')).toBe('false');
    expect(bodyText()).toContain('Identificador que verá el modelo.');
  });

  it('en cuanto se escribe un nombre no válido lo dice, sin pulsar Crear; al corregirlo, desaparece', async () => {
    await open();
    await $('#te-name').setValue('Mal Nombre');
    expect(bodyText()).toContain('Usa minúsculas, números y guiones bajos');
    expect($('#te-name').attributes('aria-invalid')).toBe('true');
    await $('#te-name').setValue('buen_nombre');
    expect(bodyText()).not.toContain('Usa minúsculas, números y guiones bajos');
    expect($('#te-name').attributes('aria-invalid')).toBe('false');
  });

  it('una URL que no empieza por http(s):// se marca nada más escribirla; la descripción y el nombre vacíos solo al guardar', async () => {
    await open();
    await $('#te-url').setValue('ftp://servidor');
    expect(bodyText()).toContain('Debe empezar por http:// o https://');
    expect(bodyText()).not.toContain('El nombre es obligatorio.');
    expect(bodyText()).not.toContain('Describe qué hace la herramienta');

    await submit();
    expect(bodyText()).toContain('El nombre es obligatorio.');
    expect(bodyText()).toContain('Describe qué hace la herramienta: el modelo lo lee');
    expect(saved()).toHaveLength(0);
    expect(api.ctx.store.listCustomTools()).toHaveLength(0);
  });

  it('con todo vacío, Crear pide cada campo obligatorio y no llama al servidor', async () => {
    await open();
    await submit();
    expect(bodyText()).toContain('El nombre es obligatorio.');
    expect(bodyText()).toContain('La URL es obligatoria.');
    expect(api.ctx.store.listCustomTools()).toHaveLength(0);
  });
});

describe('ToolEditorModal: errores del servidor', () => {
  it('rechaza un nombre repetido y lo dice al usuario sin cerrar el editor ni duplicar la herramienta', async () => {
    api.ctx.store.createCustomTool({
      name: 'consultar_clima',
      description: 'Ya existente',
      parameters: { type: 'object', properties: {} },
      method: 'GET',
      urlTemplate: 'https://api.ejemplo.com/otra',
      headers: {},
      bodyTemplate: '',
      enabled: true,
    });
    await open();
    await fillBasics();
    await submit();
    await until(() => exists('.callout.danger'));
    expect(document.body.querySelector('.callout.danger')?.textContent).toContain('Ya existe una herramienta llamada "consultar_clima".');
    expect(saved()).toHaveLength(0);
    expect(api.ctx.store.listCustomTools()).toHaveLength(1);
    expect(api.ctx.store.listCustomTools()[0].description).toBe('Ya existente');
    // El botón vuelve a estar disponible para corregir y reintentar.
    expect((button('Crear herramienta').element as HTMLButtonElement).disabled).toBe(false);
    await $('#te-name').setValue('consultar_clima_2');
    await submit();
    await until(() => saved().length === 1);
    expect(api.ctx.store.listCustomTools().map((t) => t.name)).toEqual(['consultar_clima', 'consultar_clima_2']);
  });

  it('rechaza un nombre que pisa una herramienta integrada', async () => {
    const builtin = (await (await fetch('/api/tools')).json()).find(
      (t: { name: string; kind?: string }) => t.name === 'calculator' || t.name === 'get_current_time',
    );
    expect(builtin, 'hay alguna herramienta integrada conocida').toBeDefined();
    await open();
    await fillBasics(builtin.name);
    await submit();
    await until(() => exists('.callout.danger'));
    expect(document.body.querySelector('.callout.danger')?.textContent).toContain(`"${builtin.name}" es el nombre de una herramienta integrada.`);
    expect(api.ctx.store.listCustomTools()).toHaveLength(0);
  });

  it('muestra en su campo el error de validación que detecta el servidor y no cierra el editor', async () => {
    await open();
    await fillBasics();
    // La URL pasa la comprobación del navegador pero el servidor limita su longitud a 2000 caracteres.
    await $('#te-url').setValue(`https://api.ejemplo.com/${'a'.repeat(2100)}`);
    await submit();
    await until(() => exists('.callout.danger'));
    expect(bodyText()).toMatch(/urlTemplate/);
    expect($('#te-url').attributes('aria-invalid')).toBe('true');
    expect(saved()).toHaveLength(0);
    expect(api.ctx.store.listCustomTools()).toHaveLength(0);
  });

  it('abrir una herramienta que no existe muestra el error y bloquea el botón de guardar', async () => {
    await open('tool_inexistente');
    await until(() => exists('.callout.danger'));
    expect(document.body.querySelector('.callout.danger')?.textContent).toContain('Herramienta no encontrada');
    expect(exists('#te-name')).toBe(false);
    expect((button('Guardar cambios').element as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('ToolEditorModal: edición', () => {
  function seed() {
    return api.ctx.store.createCustomTool({
      name: 'buscar_pedidos',
      description: 'Busca pedidos por cliente.',
      parameters: {
        type: 'object',
        properties: {
          cliente: { type: 'string', description: 'Id del cliente', enum: ['a', 'b'], default: 'a' },
          etiquetas: { type: 'array', description: 'Etiquetas', items: { type: 'string' } },
          limite: { type: 'integer', default: 5 },
        },
        required: ['cliente'],
      },
      method: 'POST',
      urlTemplate: 'https://api.ejemplo.com/pedidos/{{cliente}}',
      headers: { Authorization: 'Bearer original', Accept: 'application/json' },
      bodyTemplate: '{ "etiquetas": {{etiquetas}} }',
      enabled: false,
    });
  }

  it('carga la herramienta guardada en el formulario', async () => {
    const tool = seed();
    await open(tool.id);
    expect(bodyText()).toContain('Editar herramienta HTTP');
    expect(($('#te-name').element as HTMLInputElement).value).toBe('buscar_pedidos');
    expect(($('#te-method').element as HTMLSelectElement).value).toBe('POST');
    expect(($('#te-url').element as HTMLInputElement).value).toBe('https://api.ejemplo.com/pedidos/{{cliente}}');
    expect(($('#te-body').element as HTMLTextAreaElement).value).toBe('{ "etiquetas": {{etiquetas}} }');
    expect(bodyText()).toContain('Desactivada');
    expect($$('.param-row')).toHaveLength(3);
    const [cliente] = $$('.param-row');
    expect((cliente.element.querySelector('[id^="te-pe-"]') as HTMLInputElement).value).toBe('a, b');
    expect((cliente.element.querySelector('[id^="te-pv-"]') as HTMLInputElement).value).toBe('a');
  });

  it('al guardar conserva las propiedades del esquema que no edita (items de una lista) y las que no se tocan', async () => {
    const tool = seed();
    await open(tool.id);
    await $('#te-desc').setValue('Busca pedidos por cliente y estado.');
    await submit('Guardar cambios');
    await until(() => saved().length === 1);

    const after = api.ctx.store.getCustomTool(tool.id)!;
    expect(after.description).toBe('Busca pedidos por cliente y estado.');
    expect(after.parameters.properties.etiquetas).toEqual({ type: 'array', description: 'Etiquetas', items: { type: 'string' } });
    expect(after.parameters.properties.cliente).toEqual({ type: 'string', description: 'Id del cliente', enum: ['a', 'b'], default: 'a' });
    expect(after.parameters.properties.limite).toEqual({ type: 'integer', default: 5 });
    expect(after.parameters.required).toEqual(['cliente']);
    expect(after.enabled).toBe(false);
    // Es la misma herramienta, no una copia.
    expect(api.ctx.store.listCustomTools()).toHaveLength(1);
  });

  it('conserva los items también al cambiar otras propiedades del mismo parámetro', async () => {
    const tool = seed();
    await open(tool.id);
    const row = $$('.param-row')[1].element;
    await new DOMWrapper(row.querySelector('[id^="te-pd-"]') as HTMLElement).setValue('Etiquetas del pedido');
    await new DOMWrapper(row.querySelector('input[type="checkbox"]') as HTMLElement).setValue(true);
    await submit('Guardar cambios');
    await until(() => saved().length === 1);
    const props = api.ctx.store.getCustomTool(tool.id)!.parameters;
    expect(props.properties.etiquetas).toEqual({ type: 'array', description: 'Etiquetas del pedido', items: { type: 'string' } });
    expect(props.required).toEqual(['cliente', 'etiquetas']);
  });

  it('una credencial guardada no se muestra y, si se deja el valor vacío, se conserva; si se escribe otro, se sustituye', async () => {
    const tool = seed();
    await open(tool.id);
    const value = () => $('input[aria-label="Valor de la cabecera 2"]').element as HTMLInputElement;
    expect(($('input[aria-label="Nombre de la cabecera 2"]').element as HTMLInputElement).value).toBe('Authorization');
    expect(value().value).toBe('');
    expect(value().placeholder).toBe('Guardado. Escribe para cambiarlo');
    expect(bodyText()).not.toContain('Bearer original');

    await submit('Guardar cambios');
    await until(() => saved().length === 1);
    expect(api.ctx.store.getCustomToolByName('buscar_pedidos', true)?.headers.Authorization).toBe('Bearer original');
    expect(api.ctx.store.getCustomToolByName('buscar_pedidos')?.secretHeaders).toEqual(['Authorization']);

    // (Las cabeceras en claro van primero y las cifradas después.)
    // Ahora se cambia el valor.
    wrapper.unmount();
    document.body.innerHTML = '';
    await open(tool.id);
    await $('input[aria-label="Valor de la cabecera 2"]').setValue('Bearer nuevo');
    await submit('Guardar cambios');
    await until(() => saved().length === 1);
    expect(api.ctx.store.getCustomToolByName('buscar_pedidos', true)?.headers.Authorization).toBe('Bearer nuevo');
  });

  it('se puede renombrar la herramienta a un nombre libre y a su propio nombre, pero no al de otra', async () => {
    const tool = seed();
    api.ctx.store.createCustomTool({
      name: 'otra_herramienta',
      description: 'Otra herramienta',
      parameters: { type: 'object', properties: {} },
      method: 'GET',
      urlTemplate: 'https://api.ejemplo.com/x',
      headers: {},
      bodyTemplate: '',
      enabled: true,
    });
    await open(tool.id);
    await $('#te-name').setValue('otra_herramienta');
    await submit('Guardar cambios');
    await until(() => exists('.callout.danger'));
    expect(document.body.querySelector('.callout.danger')?.textContent).toContain('Ya existe una herramienta llamada "otra_herramienta".');
    expect(api.ctx.store.getCustomTool(tool.id)?.name).toBe('buscar_pedidos');

    await $('#te-name').setValue('buscar_pedidos');
    await submit('Guardar cambios');
    await until(() => saved().length === 1);
    expect(saved()[0]).toEqual(['buscar_pedidos']);

    wrapper.unmount();
    document.body.innerHTML = '';
    await open(tool.id);
    await $('#te-name').setValue('buscar_pedidos_v2');
    await submit('Guardar cambios');
    await until(() => saved().length === 1);
    expect(api.ctx.store.getCustomTool(tool.id)?.name).toBe('buscar_pedidos_v2');
  });

  it('cancelar cierra sin guardar nada', async () => {
    const tool = seed();
    await open(tool.id);
    await $('#te-desc').setValue('Cambio que no se guarda');
    await button('Cancelar').trigger('click');
    expect(wrapper.emitted('close')).toHaveLength(1);
    expect(api.ctx.store.getCustomTool(tool.id)?.description).toBe('Busca pedidos por cliente.');
  });
});

describe('ToolEditorModal: foco al guardar con errores', () => {
  it('«Crear herramienta» con el nombre vacío lleva el foco al campo del nombre (el botón del pie envía el formulario)', async () => {
    const uninstall = installFormA11y();
    try {
      await open();
      const create = button('Crear herramienta');
      expect(create.attributes('type')).toBe('submit');
      create.element.focus();
      await create.trigger('click');
      await until(() => document.activeElement === $('#te-name').element);
      expect($('#te-name').attributes('aria-invalid')).toBe('true');
    } finally {
      uninstall();
    }
  });
});
