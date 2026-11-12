// @vitest-environment jsdom
// Panel de servidores MCP contra la API real y servidores MCP reales: el de pruebas del proyecto
// (server/test/fixtures/mcp-server.mjs) arrancado como proceso hijo por stdio y servido por HTTP.
// El único doble es el proveedor LLM (`LlmFactory`), que aquí ni se usa.
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import type { McpServer, ToolInfo } from '@shared/types';
import { DOMWrapper, mount, type VueWrapper } from '@vue/test-utils';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useUi } from '@/stores/ui';
import { freshPinia, startApi, testRouter, until, type TestApi } from '@/test/harness';
// @ts-expect-error: módulo de pruebas en JavaScript, sin tipos.
import { buildServer } from '../../../server/test/fixtures/mcp-server.mjs';
import McpServersPanel from './McpServersPanel.vue';

const FIXTURE = path.resolve(import.meta.dirname, '../../../server/test/fixtures/mcp-server.mjs');
const TOOLS = ['sumar', 'get_env_value', 'buscar', 'fallar', 'lenta', 'ampliar', 'salir'];
/** Arrancar un proceso de Node y completar el protocolo MCP tarda; la prueba espera a la condición, no a un plazo fijo. */
const SLOW = 20_000;

vi.setConfig({ testTimeout: 40_000 });

let api: TestApi;
let wrapper: VueWrapper;
const httpServers: http.Server[] = [];

async function open(): Promise<void> {
  wrapper = mount(McpServersPanel, { global: { plugins: [freshPinia(), testRouter()] }, attachTo: document.body });
  await until(() => !wrapper.find('.skeleton').exists());
}
const text = () => document.body.textContent ?? '';
const toasts = () => useUi().toasts.map((t) => t.message);
const field = <T extends HTMLElement>(id: string) => new DOMWrapper<T>(document.body.querySelector<T>(`#${id}`)!);
const button = (label: string) => {
  const el = [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
  if (!el) throw new Error(`No hay un botón «${label}»`);
  return new DOMWrapper(el);
};
const submit = () => new DOMWrapper(document.body.querySelector<HTMLButtonElement>('button[type="submit"]')!);
const rows = () => [...document.body.querySelectorAll<HTMLElement>('ul.servers > li')];
const row = (name: string) => rows().find((li) => li.querySelector('header strong')?.textContent === name);
const inRow = (name: string, label: string) => {
  const el = [...(row(name)?.querySelectorAll('button') ?? [])].find((b) => b.textContent?.trim() === label);
  if (!el) throw new Error(`No hay un botón «${label}» en «${name}»`);
  return new DOMWrapper(el);
};
const badge = (name: string) => row(name)?.querySelectorAll('.badge')[1]?.textContent;
const stored = () => api.ctx.store.listMcpServers();
/** Lo que la API da de cada servidor (sin secretos, con estado y herramientas). */
const listed = () => api.ctx.mcp.list();

const apiGet = async <T>(url: string): Promise<T> => (await fetch(url)).json() as Promise<T>;
const mcpTools = async (server?: string) =>
  (await apiGet<ToolInfo[]>('/api/tools')).filter((t) => t.source === 'mcp' && (!server || t.mcpServerName === server));
const invoke = async (name: string, args: Record<string, unknown> = {}) => {
  const res = await fetch(`/api/tools/${name}/invoke`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ args }) });
  return (await res.json()) as { ok: boolean; result?: string; error?: string };
};

/** Rellena el formulario de servidor por stdio con el servidor de pruebas. */
async function fillStdio(name: string, env = '', args = FIXTURE): Promise<void> {
  await field<HTMLInputElement>('mcp-name').setValue(name);
  await field<HTMLInputElement>('mcp-command').setValue(process.execPath);
  await field<HTMLTextAreaElement>('mcp-args').setValue(args);
  if (env) await field<HTMLTextAreaElement>('mcp-secrets').setValue(env);
}
/** Da de alta un servidor stdio desde el formulario y espera a que quede conectado. */
async function addStdio(name: string, env = ''): Promise<void> {
  await button('Añadir servidor MCP').trigger('click');
  await fillStdio(name, env);
  await submit().trigger('click');
  await until(() => badge(name) === 'Conectado', SLOW);
}

/** Servidor MCP por HTTP, protegido con una cabecera «Authorization» (igual que hace server/test/mcp.test.ts). */
async function httpMcpServer(token: string): Promise<string> {
  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) return void res.writeHead(401, { 'Content-Type': 'text/plain' }).end('sin permiso');
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await buildServer().connect(transport);
    await transport.handleRequest(req, res);
  });
  httpServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
}

beforeEach(async () => {
  api = await startApi();
});
afterEach(async () => {
  wrapper?.unmount();
  document.body.innerHTML = '';
  // `api.close()` cierra el contexto del servidor y con él los procesos hijo de los servidores MCP.
  await api.close();
  for (const server of httpServers.splice(0)) await new Promise((resolve) => server.close(resolve));
});

describe('McpServersPanel · lista', () => {
  it('sin servidores muestra el estado vacío con su acción para añadir el primero', async () => {
    await open();
    expect(rows()).toHaveLength(0);
    expect(text()).toContain('Todavía no hay servidores MCP');
    // Hay dos accesos: el de la cabecera y el del estado vacío.
    expect([...document.body.querySelectorAll('button')].filter((b) => b.textContent?.trim() === 'Añadir servidor MCP')).toHaveLength(2);
    expect(stored()).toHaveLength(0);
  });

  it(
    'muestra los servidores que ya existen al abrirlo, cada uno con su estado y sus herramientas',
    async () => {
      const create = (body: object) =>
        fetch('/api/mcp/servers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      expect((await create({ name: 'apagado', transport: 'stdio', command: process.execPath, args: [FIXTURE], enabled: false })).status).toBe(201);
      expect((await create({ name: 'activo', transport: 'stdio', command: process.execPath, args: [FIXTURE] })).status).toBe(201);
      await open();

      expect(rows().map((li) => li.querySelector('header strong')!.textContent)).toEqual(['activo', 'apagado']);
      expect(text()).not.toContain('Todavía no hay servidores MCP');
      expect(badge('activo')).toBe('Conectado');
      expect(row('activo')!.textContent).toContain('7 herramientas');
      expect(row('activo')!.textContent).toContain('programa local');
      expect(row('activo')!.textContent).toContain(`${process.execPath} ${FIXTURE}`);
      expect(badge('apagado')).toBe('Desactivado');
      expect(inRow('apagado', 'Reconectar').attributes('disabled')).toBeDefined();
      expect(inRow('activo', 'Reconectar').attributes('disabled')).toBeUndefined();
    },
    SLOW,
  );
});

describe('McpServersPanel · alta por stdio', () => {
  it(
    'arranca el programa, conecta y enseña sus herramientas, que aparecen también en el catálogo',
    async () => {
      await open();
      await addStdio('eco');

      expect(stored()).toHaveLength(1);
      expect(stored()[0]).toMatchObject({ name: 'eco', transport: 'stdio', command: process.execPath, args: [FIXTURE], enabled: true });
      expect(badge('eco')).toBe('Conectado');
      expect(row('eco')!.textContent).toContain('7 herramientas');
      for (const tool of TOOLS) expect(row('eco')!.textContent).toContain(`eco__${tool}`);
      expect(toasts()).toContain('Servidor «eco» conectado: 7 herramientas disponibles.');
      expect(wrapper.emitted('changed')).toHaveLength(1);
      // El formulario se cierra al guardar.
      expect(document.body.querySelector('#mcp-form')).toBeNull();

      // Y las herramientas se pueden usar de verdad (la llamada llega al proceso hijo).
      const catalog = await mcpTools('eco');
      expect(catalog.map((t) => t.name).sort()).toEqual(TOOLS.map((t) => `eco__${t}`).sort());
      expect(await invoke('eco__sumar', { a: 2, b: 3 })).toMatchObject({ ok: true, result: '5' });
    },
    SLOW * 2,
  );

  it('un programa que no existe se guarda pero queda sin conexión y dice el motivo', async () => {
    await open();
    await button('Añadir servidor MCP').trigger('click');
    await field<HTMLInputElement>('mcp-name').setValue('fantasma');
    await field<HTMLInputElement>('mcp-command').setValue('programa-que-no-existe-agentforge');
    await submit().trigger('click');
    await until(() => badge('fantasma') === 'Sin conexión', SLOW);

    expect(stored()).toHaveLength(1);
    const alert = row('fantasma')!.querySelector('[role="alert"]')!;
    expect(alert.textContent!.length).toBeGreaterThan(5);
    expect(alert.textContent).toContain('programa-que-no-existe-agentforge');
    expect(row('fantasma')!.textContent).not.toContain('herramientas');
    await until(() => toasts().some((m) => m.startsWith('Servidor «fantasma» guardado, pero no se pudo conectar: ')));
    expect(await mcpTools('fantasma')).toEqual([]);
  });

  it('un programa que arranca y se cierra con un error muestra lo que dijo', async () => {
    await open();
    await button('Añadir servidor MCP').trigger('click');
    await fillStdio('roto', '', `${FIXTURE}\n--romper`);
    await submit().trigger('click');
    await until(() => badge('roto') === 'Sin conexión', SLOW);
    expect(row('roto')!.querySelector('[role="alert"]')!.textContent).toContain('configuración incompleta: falta la clave');
    expect(await mcpTools('roto')).toEqual([]);
  });

  it('con variables de entorno secretas: llegan al programa, no se devuelven y no se pintan', async () => {
    await open();
    await addStdio('eco', 'CLAVE_SECRETA=valor-muy-secreto\nOTRA=otro-valor');

    expect(listed()[0].envKeys).toEqual(['CLAVE_SECRETA', 'OTRA']);
    // El programa hijo las recibe…
    expect(await invoke('eco__get_env_value', { name: 'CLAVE_SECRETA' })).toMatchObject({ ok: true, result: 'valor-muy-secreto' });
    // …pero la API solo da los nombres, y la pantalla tampoco las enseña.
    const raw = await (await fetch('/api/mcp/servers')).text();
    expect(raw).not.toContain('valor-muy-secreto');
    expect(raw).not.toContain('otro-valor');
    expect(JSON.parse(raw)[0]).toMatchObject({ envKeys: ['CLAVE_SECRETA', 'OTRA'], headerKeys: [] });
    expect(JSON.parse(raw)[0]).not.toHaveProperty('env');
    expect(text()).not.toContain('valor-muy-secreto');
    // En la base de datos están cifradas.
    const stor = api.ctx.store.db.prepare('SELECT * FROM mcp_servers').get() as Record<string, unknown>;
    expect(JSON.stringify(stor)).not.toContain('valor-muy-secreto');
  });
});

describe('McpServersPanel · validación', () => {
  it('un nombre no válido, un programa vacío o una variable mal escrita se señalan en su campo sin crear nada', async () => {
    await open();
    await button('Añadir servidor MCP').trigger('click');
    await field<HTMLInputElement>('mcp-name').setValue('Mal Nombre');
    await submit().trigger('click');
    await until(() => text().includes('Usa de 2 a 20 letras minúsculas'));
    expect(field('mcp-name').attributes('aria-invalid')).toBe('true');
    expect(field('mcp-command').element.closest('.field')!.querySelector('.error')!.textContent).toBe('Indica el programa que arranca el servidor');
    expect(field('mcp-command').attributes('aria-invalid')).toBe('true');
    expect(stored()).toHaveLength(0);

    // La línea de variables sin «=» ni se envía: lo dice el propio formulario.
    await fillStdio('eco', 'esto-no-tiene-igual');
    await submit().trigger('click');
    expect(text()).toContain('«esto-no-tiene-igual» no tiene la forma NOMBRE=valor.');
    expect(stored()).toHaveLength(0);

    // Un nombre de variable que el servidor no admite.
    await field<HTMLTextAreaElement>('mcp-secrets').setValue('1MALA=x');
    await submit().trigger('click');
    await until(() => text().includes('no es un nombre de variable de entorno válido'));
    expect(stored()).toHaveLength(0);
  });

  it('una dirección HTTP que no es una URL se rechaza en su campo', async () => {
    await open();
    await button('Añadir servidor MCP').trigger('click');
    await button('Dirección HTTP').trigger('click');
    await field<HTMLInputElement>('mcp-name').setValue('remoto');
    await field<HTMLInputElement>('mcp-url').setValue('esto no es una url');
    await submit().trigger('click');
    await until(() => text().includes('Debe ser una URL http(s) válida'));
    expect(field('mcp-url').attributes('aria-invalid')).toBe('true');
    expect(stored()).toHaveLength(0);
  });

  it(
    'un nombre repetido lo rechaza el servidor (409) y lo dice en el formulario, que sigue abierto',
    async () => {
      await open();
      await addStdio('eco');
      await button('Añadir servidor MCP').trigger('click');
      await fillStdio('eco');
      await submit().trigger('click');
      await until(() => document.body.querySelector('.callout.danger') !== null);
      expect(document.body.querySelector('.callout.danger')!.textContent).toContain('Ya existe un servidor MCP llamado «eco».');
      expect(document.body.querySelector('#mcp-form')).not.toBeNull();
      expect(stored()).toHaveLength(1);
      expect(rows()).toHaveLength(1);
    },
    SLOW * 2,
  );

  it('«Cancelar» cierra el formulario sin crear nada', async () => {
    await open();
    await button('Añadir servidor MCP').trigger('click');
    await fillStdio('eco');
    await button('Cancelar').trigger('click');
    expect(document.body.querySelector('#mcp-form')).toBeNull();
    expect(stored()).toHaveLength(0);
  });
});

describe('McpServersPanel · edición', () => {
  it(
    'al editar se conservan las variables guardadas y el servidor se reconecta con el nombre nuevo',
    async () => {
      await open();
      await addStdio('eco', 'CLAVE_SECRETA=valor-muy-secreto');
      const id = stored()[0].id;

      await inRow('eco', 'Editar').trigger('click');
      expect(text()).toContain('Editar el servidor «eco»');
      expect(field<HTMLInputElement>('mcp-name').element.value).toBe('eco');
      expect(field<HTMLInputElement>('mcp-command').element.value).toBe(process.execPath);
      expect(field<HTMLTextAreaElement>('mcp-args').element.value).toBe(FIXTURE);
      // Las variables no se ven, y por defecto se conservan (la caja de texto está bloqueada y vacía).
      expect(text()).toContain('Sustituir las guardadas (CLAVE_SECRETA)');
      expect(field<HTMLTextAreaElement>('mcp-secrets').element.value).toBe('');
      expect(field<HTMLTextAreaElement>('mcp-secrets').attributes('disabled')).toBeDefined();

      await field<HTMLInputElement>('mcp-name').setValue('eco2');
      await submit().trigger('click');
      await until(() => badge('eco2') === 'Conectado', SLOW);

      expect(stored()).toHaveLength(1);
      expect(stored()[0].id).toBe(id);
      expect(row('eco')).toBeUndefined();
      // Las herramientas pasan a llamarse con el prefijo nuevo y el programa conserva la variable.
      expect((await mcpTools('eco2')).map((t) => t.name)).toContain('eco2__sumar');
      expect(await mcpTools('eco')).toEqual([]);
      expect(await invoke('eco2__get_env_value', { name: 'CLAVE_SECRETA' })).toMatchObject({ ok: true, result: 'valor-muy-secreto' });
      expect(listed()[0].envKeys).toEqual(['CLAVE_SECRETA']);
    },
    SLOW * 2,
  );

  it(
    'marcando «Sustituir las guardadas» se cambian las variables por las nuevas',
    async () => {
      await open();
      await addStdio('eco', 'CLAVE_SECRETA=valor-viejo');

      await inRow('eco', 'Editar').trigger('click');
      const replace = document.body.querySelector<HTMLInputElement>('label.check.small input')!;
      expect(replace.checked).toBe(false);
      await new DOMWrapper(replace).setValue(true);
      expect(field<HTMLTextAreaElement>('mcp-secrets').attributes('disabled')).toBeUndefined();
      await field<HTMLTextAreaElement>('mcp-secrets').setValue('CLAVE_SECRETA=valor-nuevo\nEXTRA=1');
      await submit().trigger('click');
      await until(() => listed()[0].envKeys.length === 2);
      await until(() => badge('eco') === 'Conectado', SLOW);

      expect(listed()[0].envKeys).toEqual(['CLAVE_SECRETA', 'EXTRA']);
      await until(() => toasts().filter((m) => m.startsWith('Servidor «eco» conectado')).length >= 1);
      expect(await invoke('eco__get_env_value', { name: 'CLAVE_SECRETA' })).toMatchObject({ result: 'valor-nuevo' });
    },
    SLOW * 2,
  );

  it(
    'editar un servidor para que apunte a un programa inexistente lo deja sin conexión con el motivo y sus herramientas fallan con un error claro',
    async () => {
      await open();
      await addStdio('eco');
      await inRow('eco', 'Editar').trigger('click');
      await field<HTMLInputElement>('mcp-command').setValue('programa-que-no-existe-agentforge');
      await submit().trigger('click');
      await until(() => badge('eco') === 'Sin conexión', SLOW);
      expect(row('eco')!.querySelector('[role="alert"]')!.textContent).toContain('programa-que-no-existe-agentforge');
      expect(stored()[0].command).toBe('programa-que-no-existe-agentforge');
      // Un servidor activo mantiene su última lista de herramientas conocida, pero usarlas dice por qué no se puede.
      const result = await invoke('eco__sumar', { a: 1, b: 2 });
      expect(result.ok).toBe(false);
      expect(result.error).toContain('No se pudo conectar con el servidor MCP «eco»');
    },
    SLOW * 2,
  );

  it(
    'desactivar un servidor lo desconecta y retira sus herramientas; reactivarlo las devuelve',
    async () => {
      await open();
      await addStdio('eco');
      expect(await mcpTools('eco')).toHaveLength(7);

      await inRow('eco', 'Editar').trigger('click');
      const enabled = document.body.querySelector<HTMLInputElement>('input.switch')!;
      expect(enabled.checked).toBe(true);
      await new DOMWrapper(enabled).setValue(false);
      await submit().trigger('click');
      await until(() => badge('eco') === 'Desactivado');

      expect(stored()[0].enabled).toBe(false);
      expect(toasts()).toContain('Servidor «eco» guardado, pero desactivado.');
      expect(await mcpTools('eco')).toEqual([]);
      expect(inRow('eco', 'Reconectar').attributes('disabled')).toBeDefined();

      await inRow('eco', 'Editar').trigger('click');
      const again = document.body.querySelector<HTMLInputElement>('input.switch')!;
      expect(again.checked).toBe(false);
      await new DOMWrapper(again).setValue(true);
      await submit().trigger('click');
      await until(() => badge('eco') === 'Conectado', SLOW);
      expect(stored()[0].enabled).toBe(true);
      expect(await mcpTools('eco')).toHaveLength(7);
      expect(await invoke('eco__sumar', { a: 1, b: 1 })).toMatchObject({ result: '2' });
    },
    SLOW * 2,
  );
});

describe('McpServersPanel · reconectar', () => {
  it(
    'si el programa se cae, «Reconectar» lo vuelve a arrancar y recupera las herramientas',
    async () => {
      await open();
      await addStdio('eco');

      // El programa termina por su cuenta (herramienta «salir» del servidor de pruebas).
      await invoke('eco__salir');
      await until(() => api.ctx.store.listMcpServers().length === 1);
      await vi.waitUntil(async () => (await apiGet<McpServer[]>('/api/mcp/servers'))[0].status !== 'connected', { timeout: SLOW, interval: 50 });

      await inRow('eco', 'Reconectar').trigger('click');
      await until(() => toasts().includes('«eco» conectado: 7 herramientas.'), SLOW);
      await until(() => badge('eco') === 'Conectado');
      expect((await apiGet<McpServer[]>('/api/mcp/servers'))[0].status).toBe('connected');
      expect(await invoke('eco__sumar', { a: 4, b: 5 })).toMatchObject({ ok: true, result: '9' });
      expect(wrapper.emitted('changed')!.length).toBeGreaterThanOrEqual(2);
    },
    SLOW * 2,
  );

  it('si sigue sin poder conectar avisa con el motivo', async () => {
    await open();
    await button('Añadir servidor MCP').trigger('click');
    await field<HTMLInputElement>('mcp-name').setValue('fantasma');
    await field<HTMLInputElement>('mcp-command').setValue('programa-que-no-existe-agentforge');
    await submit().trigger('click');
    await until(() => badge('fantasma') === 'Sin conexión', SLOW);

    await inRow('fantasma', 'Reconectar').trigger('click');
    await until(() => toasts().some((m) => m.startsWith('No se pudo conectar con «fantasma»: ')), SLOW);
    expect(badge('fantasma')).toBe('Sin conexión');
  });
});

describe('McpServersPanel · eliminar', () => {
  it(
    'pide confirmación; al cancelar no cambia nada y al confirmar elimina el servidor y sus herramientas del catálogo',
    async () => {
      await open();
      await addStdio('eco');
      await addStdio('otro');
      expect(await mcpTools()).toHaveLength(14);

      await new DOMWrapper(row('eco')!.querySelector<HTMLButtonElement>('button[aria-label="Eliminar el servidor eco"]')!).trigger('click');
      await until(() => useUi().confirmState !== null);
      expect(useUi().confirmState).toMatchObject({
        title: 'Eliminar servidor MCP',
        message: 'Los agentes y workflows que usen las herramientas de «eco» dejarán de poder usarlas.',
        confirmLabel: 'Eliminar servidor',
        danger: true,
      });
      useUi().answer(false);
      await new Promise((r) => setTimeout(r, 50));
      expect(stored().map((s) => s.name)).toEqual(['eco', 'otro']);
      expect(await mcpTools('eco')).toHaveLength(7);

      await new DOMWrapper(row('eco')!.querySelector<HTMLButtonElement>('button[aria-label="Eliminar el servidor eco"]')!).trigger('click');
      await until(() => useUi().confirmState !== null);
      useUi().answer(true);
      await until(() => row('eco') === undefined);

      expect(stored().map((s) => s.name)).toEqual(['otro']);
      expect(toasts()).toContain('Servidor «eco» eliminado.');
      expect(await mcpTools('eco')).toEqual([]);
      // El otro servidor sigue intacto y operativo.
      expect(await mcpTools('otro')).toHaveLength(7);
      expect(await invoke('otro__sumar', { a: 1, b: 2 })).toMatchObject({ result: '3' });
      // Y la herramienta de un servidor eliminado ya no existe.
      expect(
        (await fetch('/api/tools/eco__sumar/invoke', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"args":{"a":1,"b":2}}' }))
          .status,
      ).toBe(404);

      await new DOMWrapper(row('otro')!.querySelector<HTMLButtonElement>('button[aria-label="Eliminar el servidor otro"]')!).trigger('click');
      await until(() => useUi().confirmState !== null);
      useUi().answer(true);
      await until(() => rows().length === 0);
      expect(text()).toContain('Todavía no hay servidores MCP');
      expect(await mcpTools()).toEqual([]);
    },
    SLOW * 4,
  );
});

describe('McpServersPanel · servidor por HTTP', () => {
  it(
    'conecta por HTTP con una cabecera secreta: se guarda cifrada, no se devuelve y sin ella no hay conexión',
    async () => {
      const url = await httpMcpServer('token-http-secreto');
      await open();
      await button('Añadir servidor MCP').trigger('click');
      await button('Dirección HTTP').trigger('click');
      // Al cambiar a HTTP desaparecen el programa y sus argumentos.
      expect(document.body.querySelector('#mcp-command')).toBeNull();
      await field<HTMLInputElement>('mcp-name').setValue('remoto');
      await field<HTMLInputElement>('mcp-url').setValue(url);
      await field<HTMLTextAreaElement>('mcp-secrets').setValue('Authorization: Bearer token-http-secreto');
      await submit().trigger('click');
      await until(() => badge('remoto') === 'Conectado', SLOW);

      expect(row('remoto')!.querySelector('.badge')!.textContent).toBe('HTTP');
      expect(row('remoto')!.textContent).toContain(url);
      expect(row('remoto')!.textContent).toContain('remoto__sumar');
      expect(listed()[0]).toMatchObject({ transport: 'http', url, headerKeys: ['Authorization'] });
      expect(await invoke('remoto__sumar', { a: 20, b: 22 })).toMatchObject({ ok: true, result: '42' });
      expect(await (await fetch('/api/mcp/servers')).text()).not.toContain('token-http-secreto');
      expect(text()).not.toContain('token-http-secreto');

      // Con una cabecera equivocada, el servidor rechaza y queda sin conexión.
      await inRow('remoto', 'Editar').trigger('click');
      expect(text()).toContain('Sustituir las guardadas (Authorization)');
      await new DOMWrapper(document.body.querySelector<HTMLInputElement>('label.check.small input')!).setValue(true);
      await field<HTMLTextAreaElement>('mcp-secrets').setValue('Authorization: Bearer otro-token');
      await submit().trigger('click');
      await until(() => badge('remoto') === 'Sin conexión', SLOW);
      expect(row('remoto')!.querySelector('[role="alert"]')).not.toBeNull();
      expect((await invoke('remoto__sumar', { a: 1, b: 1 })).ok).toBe(false);
    },
    SLOW * 2,
  );
});
