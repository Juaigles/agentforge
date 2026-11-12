// @vitest-environment jsdom
// Revisión de una importación contra la API real (ver src/test/harness.ts). Los archivos de exportación se generan
// exportando con la API un workflow y un agente creados en el test, y se modifican para provocar cada caso.
// El único doble es el proveedor LLM.
import type { Agent, ExportBundle, ImportResult, Provider } from '@shared/types';
import { DOMWrapper, flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addAgent, edges, node, workflow } from '../../../server/test/helpers';
import { setLocale } from '@/i18n';
import { freshPinia, setTouchDevice, startApi, testRouter, until, type TestApi } from '@/test/harness';
import ImportModal from './ImportModal.vue';

let api: TestApi;
let wrapper: VueWrapper;

const SOURCE_URL = 'http://127.0.0.1:11999';
const TOOL = 'consulta_api';

interface Source {
  provider: Provider;
  agent: Agent;
  workflowId: string;
  workflowName: string;
}

const json = async <T = any>(method: string, path: string, payload?: unknown): Promise<T> => {
  const res = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: payload === undefined ? undefined : JSON.stringify(payload) });
  return (await res.json()) as T;
};

/** Crea, en «origen», un workflow con un agente, un proveedor, una herramienta HTTP con credencial y un disparador. */
async function seedSource(): Promise<Source> {
  const provider = api.ctx.store.createProvider({ name: 'Ollama fuente', kind: 'ollama', baseUrl: SOURCE_URL, defaultModel: 'test-model' });
  await json('POST', '/api/tools/custom', {
    name: TOOL,
    description: 'Consulta un dato en una API externa',
    parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
    method: 'GET',
    urlTemplate: 'https://api.ejemplo.test/buscar?q={{q}}',
    headers: { Authorization: 'Bearer credencial-secreta', 'X-Origen': 'test' },
  });
  const agent = addAgent(api.ctx, {
    name: 'Portable',
    role: 'viajero',
    systemPrompt: 'Versión del archivo.',
    providerId: provider.id,
    tools: [TOOL, 'http_request'],
  });
  const wf = api.ctx.store.createWorkflow({
    ...workflow(
      [node('entrada', 'input'), node('paso', 'agent', { agentId: agent.id, prompt: '{{entrada}}' }), node('salida', 'output', { template: '{{paso}}' })],
      edges('entrada>paso', 'paso>salida'),
    ),
    name: 'Flujo exportado',
  });
  api.ctx.store.createTrigger(
    wf.id,
    { kind: 'interval', name: '', intervalMinutes: 60, time: null, weekdays: [], cron: null, timezone: null, input: '', enabled: true },
    new Date(Date.now() + 3_600_000).toISOString(),
  );
  return { provider, agent, workflowId: wf.id, workflowName: wf.name };
}

const exportWorkflow = (id: string) => json<ExportBundle>('GET', `/api/workflows/${id}/export`);

/** Deja el servidor sin nada de lo que trae el archivo (es lo que ve quien lo importa en otra instalación). */
function wipe(source: Source): void {
  const { store } = api.ctx;
  store.deleteWorkflow(source.workflowId);
  store.deleteAgent(source.agent.id);
  for (const tool of store.listCustomTools()) store.deleteCustomTool(tool.id);
  store.deleteProvider(source.provider.id);
}

async function open(bundle: unknown, fileName = 'flujo.agentforge.json'): Promise<void> {
  wrapper = mount(ImportModal, { props: { bundle, fileName }, global: { plugins: [freshPinia(), testRouter()] }, attachTo: document.body });
  await until(() => !document.body.querySelector('.skeleton'));
}

const body = () => document.body;
const text = () => body().textContent ?? '';
const section = (title: string) => body().querySelector<HTMLElement>(`ul[aria-label="${title}"]`);
const rows = (title: string) => [...(section(title)?.querySelectorAll<HTMLElement>(':scope > li') ?? [])];
const buttons = () => [...body().querySelectorAll<HTMLButtonElement>('button')];
const importButton = () => buttons().find((b) => b.textContent?.trim() === 'Importar')!;
const cancelButton = () => buttons().find((b) => b.textContent?.trim() === 'Cancelar')!;
const choice = (name: string) => body().querySelector<HTMLSelectElement>(`select[aria-label="Qué hacer con ${name}"]`)!;
const providerChoice = (name: string) => body().querySelector<HTMLSelectElement>(`select[aria-label="Proveedor de aquí para ${name}"]`);
const optionLabels = (select: HTMLSelectElement) => [...select.options].map((o) => o.textContent?.trim());
const select = async (element: HTMLSelectElement | null, value: string) => new DOMWrapper(element!).setValue(value);
const alerts = () => [...body().querySelectorAll('[role="alert"]')].map((a) => a.textContent?.replace(/\s+/g, ' ').trim() ?? '');

/** Pulsa «Importar» y devuelve el resultado que emite el diálogo. */
async function applyImport(): Promise<ImportResult> {
  importButton().click();
  await until(() => Boolean(wrapper.emitted('done')));
  return wrapper.emitted('done')![0][0] as ImportResult;
}

beforeEach(() => {
  setTouchDevice(false);
});
beforeEach(async () => {
  api = await startApi();
});
afterEach(async () => {
  wrapper?.unmount();
  document.body.innerHTML = '';
  await api.close();
});

describe('ImportModal: todo nuevo', () => {
  it('enseña cada elemento como nuevo, no crea nada hasta pulsar «Importar» y entonces crea todo y emite el resultado', async () => {
    const source = await seedSource();
    const bundle = await exportWorkflow(source.workflowId);
    wipe(source);
    await open(bundle);

    expect(body().querySelector('[role="dialog"]')!.getAttribute('aria-label')).toBe('Importar «Flujo exportado»');
    expect(text()).toContain('Se creará el workflow Flujo exportado junto con lo que necesita.');
    expect(rows('Proveedores')).toHaveLength(1);
    expect(rows('Proveedores')[0].textContent).toContain('Ollama fuente');
    expect(rows('Proveedores')[0].textContent).toContain('Nuevo');
    expect(rows('Herramientas HTTP')[0].textContent).toContain('Nueva');
    expect(rows('Agentes')[0].textContent).toContain('Nuevo');
    expect(rows('Agentes')[0].textContent).toContain('Portable');
    // Nada que decidir: la única acción es crear.
    expect(rows('Agentes')[0].querySelector('select')).toBeNull();
    expect(rows('Agentes')[0].textContent).toContain('Crear');
    // Todavía no se ha creado nada.
    expect(api.ctx.store.listWorkflows()).toHaveLength(0);
    expect(api.ctx.store.listAgents()).toHaveLength(0);
    expect(api.ctx.store.listProviders()).toHaveLength(0);

    const result = await applyImport();
    expect(wrapper.emitted('close')).toBeUndefined();
    expect(result.workflow?.name).toBe('Flujo exportado');
    expect(result.createdAgents.map((a) => a.name)).toEqual(['Portable']);
    expect(result.createdProviders.map((p) => p.name)).toEqual(['Ollama fuente']);
    expect(result.createdTools).toEqual([TOOL]);
    expect(result.triggers).toBe(1);

    // Y está de verdad en el servidor, enlazado entre sí.
    const [provider] = api.ctx.store.listProviders();
    expect(provider).toMatchObject({ name: 'Ollama fuente', kind: 'ollama', baseUrl: SOURCE_URL });
    const [agent] = api.ctx.store.listAgents();
    expect(agent).toMatchObject({
      name: 'Portable',
      role: 'viajero',
      systemPrompt: 'Versión del archivo.',
      providerId: provider.id,
      tools: [TOOL, 'http_request'],
    });
    const [wf] = api.ctx.store.listWorkflows();
    expect(wf.id).toBe(result.workflow!.id);
    expect(wf.nodes.find((n) => n.id === 'paso')!.config.agentId).toBe(agent.id); // el id del archivo se reescribe al de aquí
    expect(api.ctx.store.listCustomTools().map((t) => t.name)).toEqual([TOOL]);
    // El disparador viaja en pausa: nada empieza a ejecutarse solo.
    expect(api.ctx.store.listTriggers(wf.id)).toMatchObject([{ kind: 'interval', intervalMinutes: 60, enabled: false, nextRunAt: null }]);
    expect(result.issues.filter((i) => i.level === 'error')).toEqual([]);
  });

  it('el archivo nunca lleva la credencial de la herramienta y la herramienta importada queda sin ella', async () => {
    const source = await seedSource();
    const bundle = await exportWorkflow(source.workflowId);
    expect(JSON.stringify(bundle)).not.toContain('credencial-secreta');
    wipe(source);
    await open(bundle);
    await applyImport();
    const [tool] = api.ctx.store.listCustomTools();
    expect(tool.headers.Authorization).toBe(''); // hay que volver a escribirla al editar la herramienta
    expect(JSON.stringify(tool)).not.toContain('credencial-secreta');
    expect(tool.headers['X-Origen']).toBe('test');
  });

  it('un agente suelto exportado se importa sin workflow y el texto de introducción lo refleja', async () => {
    const source = await seedSource();
    const bundle = await json<ExportBundle>('GET', `/api/agents/${source.agent.id}/export`);
    expect(bundle.format).toBe('agentforge.agent');
    wipe(source);
    await open(bundle, 'portable.agentforge.json');

    expect(text()).toContain('Revisa qué hacer con cada elemento del archivo');
    expect(body().querySelector('ul[aria-label="Subworkflows"]')).toBeNull();
    expect(body().querySelector('[role="dialog"]')!.getAttribute('aria-label')).toBe('Importar «Portable»');
    const result = await applyImport();
    expect(result.workflow).toBeNull();
    expect(api.ctx.store.listWorkflows()).toHaveLength(0);
    expect(api.ctx.store.listAgents().map((a) => a.name)).toEqual(['Portable']);
  });

  it('un workflow que no depende de nada se anuncia como tal y se importa solo', async () => {
    const wf = api.ctx.store.createWorkflow({ ...workflow([node('entrada', 'input'), node('salida', 'output')], edges('entrada>salida')), name: 'Solo' });
    const bundle = await exportWorkflow(wf.id);
    api.ctx.store.deleteWorkflow(wf.id);
    await open(bundle);
    expect(text()).toContain('Se creará el workflow Solo. No depende de nada más.');
    expect(body().querySelectorAll('ul[aria-label]')).toHaveLength(0);
    const result = await applyImport();
    expect(result.workflow!.name).toBe('Solo');
    expect(api.ctx.store.listWorkflows().map((w) => w.name)).toEqual(['Solo']);
  });
});

describe('ImportModal: todo ya existe', () => {
  it('reutiliza lo que hay: no duplica agentes, herramientas ni proveedores y el workflow nuevo usa el agente de aquí', async () => {
    const source = await seedSource();
    const bundle = await exportWorkflow(source.workflowId);
    await open(bundle);

    for (const title of ['Proveedores', 'Agentes', 'Herramientas HTTP']) expect(rows(title)[0].textContent).toContain('Ya existe');
    expect(choice('Portable').value).toBe('reuse');
    expect(optionLabels(choice('Portable'))).toEqual(['Usar el de aquí', 'Crear una copia']);
    expect(rows('Herramientas HTTP')[0].textContent).toContain('Usar la de aquí'); // única acción posible

    const result = await applyImport();
    expect(result.createdAgents).toHaveLength(0);
    expect(result.reusedAgents.map((a) => a.id)).toEqual([source.agent.id]);
    expect(result.createdProviders).toHaveLength(0);
    expect(result.createdTools).toHaveLength(0);
    expect(api.ctx.store.listAgents()).toHaveLength(1);
    expect(api.ctx.store.listProviders()).toHaveLength(1);
    expect(api.ctx.store.listCustomTools()).toHaveLength(1);
    // El workflow de origen sigue ahí, así que el importado lleva otro nombre y apunta al agente que ya existía.
    expect(
      api.ctx.store
        .listWorkflows()
        .map((w) => w.name)
        .sort(),
    ).toEqual(['Flujo exportado', 'Flujo exportado (importado)']);
    expect(result.workflow!.name).toBe('Flujo exportado (importado)');
    expect(result.workflow!.nodes.find((n) => n.id === 'paso')!.config.agentId).toBe(source.agent.id);
  });

  it('puede pedir una copia de lo que ya existe en lugar de reutilizarlo', async () => {
    const source = await seedSource();
    const bundle = await exportWorkflow(source.workflowId);
    await open(bundle);
    await select(choice('Portable'), 'create');
    const result = await applyImport();
    expect(result.createdAgents.map((a) => a.name)).toEqual(['Portable (importado)']);
    expect(
      api.ctx.store
        .listAgents()
        .map((a) => a.name)
        .sort(),
    ).toEqual(['Portable', 'Portable (importado)']);
    expect(result.workflow!.nodes.find((n) => n.id === 'paso')!.config.agentId).toBe(result.createdAgents[0].id);
  });
});

describe('ImportModal: existe pero es distinto', () => {
  async function openChanged(): Promise<Source> {
    const source = await seedSource();
    const bundle = await exportWorkflow(source.workflowId);
    // Después de exportar, el agente de aquí cambia y la herramienta también.
    api.ctx.store.updateAgent(source.agent.id, { ...source.agent, systemPrompt: 'Versión de aquí, retocada.' });
    const local = api.ctx.store.listCustomTools()[0];
    api.ctx.store.updateCustomTool(local.id, { ...local, description: 'Descripción retocada aquí' });
    await open(bundle);
    return source;
  }

  it('lo señala como distinto y ofrece usar el de aquí (por defecto), sustituirlo o crear una copia', async () => {
    await openChanged();
    expect(rows('Agentes')[0].textContent).toContain('Existe, pero es distinto');
    expect(rows('Agentes')[0].textContent).toContain('configuración es distinta');
    expect(choice('Portable').value).toBe('reuse'); // por defecto se respeta lo de aquí
    expect(optionLabels(choice('Portable'))).toEqual(['Usar el de aquí', 'Sustituir el de aquí', 'Crear una copia']);
    expect(rows('Herramientas HTTP')[0].textContent).toContain('Existe, pero es distinto');
    expect(optionLabels(choice(TOOL))).toEqual(['Usar la de aquí', 'Sustituir la de aquí']); // género femenino
    expect(rows('Herramientas HTTP')[0].textContent).toContain('Ya existe una herramienta con ese nombre y es distinta');
  });

  it('con «usar el de aquí» no se toca nada de lo existente', async () => {
    const source = await openChanged();
    const result = await applyImport();
    expect(result.replacedAgents).toHaveLength(0);
    expect(result.replacedTools).toHaveLength(0);
    expect(api.ctx.store.getAgent(source.agent.id)!.systemPrompt).toBe('Versión de aquí, retocada.');
    expect(api.ctx.store.listCustomTools()[0].description).toBe('Descripción retocada aquí');
    expect(api.ctx.store.listAgents()).toHaveLength(1);
  });

  it('«sustituir» pisa de verdad el agente y la herramienta de aquí con la versión del archivo', async () => {
    const source = await openChanged();
    await select(choice('Portable'), 'replace');
    await select(choice(TOOL), 'replace');
    const result = await applyImport();

    expect(result.replacedAgents.map((a) => a.id)).toEqual([source.agent.id]);
    expect(result.replacedTools).toEqual([TOOL]);
    expect(api.ctx.store.getAgent(source.agent.id)!.systemPrompt).toBe('Versión del archivo.'); // mismo agente, contenido del archivo
    expect(api.ctx.store.listAgents()).toHaveLength(1);
    const [tool] = api.ctx.store.listCustomTools();
    expect(tool.description).toBe('Consulta un dato en una API externa');
    expect(result.workflow!.nodes.find((n) => n.id === 'paso')!.config.agentId).toBe(source.agent.id);
  });

  it('«crear una copia» deja el agente de aquí como estaba y crea otro con la versión del archivo', async () => {
    const source = await openChanged();
    await select(choice('Portable'), 'create');
    const result = await applyImport();

    expect(api.ctx.store.getAgent(source.agent.id)!.systemPrompt).toBe('Versión de aquí, retocada.');
    const [copy] = result.createdAgents;
    expect(copy).toMatchObject({ name: 'Portable (importado)', systemPrompt: 'Versión del archivo.' });
    expect(copy.id).not.toBe(source.agent.id);
    expect(api.ctx.store.listAgents()).toHaveLength(2);
    expect(result.workflow!.nodes.find((n) => n.id === 'paso')!.config.agentId).toBe(copy.id);
  });

  it('un subworkflow distinto del de aquí se copia por defecto, y se puede elegir usar el de aquí', async () => {
    const child = api.ctx.store.createWorkflow({ ...workflow([node('entrada', 'input'), node('salida', 'output')], edges('entrada>salida')), name: 'Hijo' });
    const parent = api.ctx.store.createWorkflow({
      ...workflow(
        [node('entrada', 'input'), node('sub', 'subworkflow', { workflowId: child.id }), node('salida', 'output')],
        edges('entrada>sub', 'sub>salida'),
      ),
      name: 'Padre',
    });
    const bundle = await exportWorkflow(parent.id);
    api.ctx.store.deleteWorkflow(parent.id);
    // El hijo de aquí cambia después de exportar.
    api.ctx.store.updateWorkflow(child.id, {
      ...workflow([node('entrada', 'input'), node('extra', 'output'), node('salida', 'output')], edges('entrada>extra', 'entrada>salida')),
      name: 'Hijo',
    });
    await open(bundle);

    expect(rows('Subworkflows')[0].textContent).toContain('Existe, pero es distinto');
    expect(choice('Hijo').value).toBe('create'); // usar el de aquí cambiaría lo que hace el workflow: no es lo recomendado
    expect(optionLabels(choice('Hijo'))).toEqual(['Usar el de aquí', 'Crear una copia']);
    await select(choice('Hijo'), 'reuse');
    const result = await applyImport();
    expect(result.createdWorkflows).toHaveLength(0);
    expect(result.workflow!.nodes.find((n) => n.id === 'sub')!.config.workflowId).toBe(child.id);
    expect(
      api.ctx.store
        .listWorkflows()
        .map((w) => w.name)
        .sort(),
    ).toEqual(['Hijo', 'Padre']);
  });
});

describe('ImportModal: proveedor que no existe', () => {
  it('con otro proveedor del mismo tipo recomienda usarlo, y se puede elegir crear el del archivo', async () => {
    const source = await seedSource();
    const bundle = await exportWorkflow(source.workflowId);
    wipe(source);
    const local = api.ctx.store.createProvider({ name: 'Ollama local', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', defaultModel: 'test-model' });
    await open(bundle);

    const row = rows('Proveedores')[0];
    expect(row.textContent).toContain('Nuevo');
    expect(row.textContent).toContain('Sus agentes usarán «Ollama local», que es del mismo tipo');
    expect(choice('Ollama fuente').value).toBe('reuse');
    expect(providerChoice('Ollama fuente')!.value).toBe(local.id);
    expect(optionLabels(providerChoice('Ollama fuente')!)).toEqual(['Ollama local']);

    await select(choice('Ollama fuente'), 'create');
    expect(providerChoice('Ollama fuente')).toBeNull(); // al crear, ya no hay a quién enlazar
    const result = await applyImport();
    expect(result.createdProviders.map((p) => p.name)).toEqual(['Ollama fuente']);
    const created = api.ctx.store.listProviders().find((p) => p.name === 'Ollama fuente')!;
    expect(created).toMatchObject({ kind: 'ollama', baseUrl: SOURCE_URL });
    expect(api.ctx.store.listAgents()[0].providerId).toBe(created.id);
  });

  it('usar uno de aquí enlaza el agente importado con el proveedor elegido y no crea ninguno', async () => {
    const source = await seedSource();
    const bundle = await exportWorkflow(source.workflowId);
    wipe(source);
    api.ctx.store.createProvider({ name: 'Ollama local', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', defaultModel: 'test-model' });
    const other = api.ctx.store.createProvider({ name: 'Servidor del equipo', kind: 'ollama', baseUrl: 'http://127.0.0.1:11435', defaultModel: 'otro-modelo' });
    await open(bundle);

    expect(optionLabels(providerChoice('Ollama fuente')!)).toEqual(['Ollama local', 'Servidor del equipo']);
    await select(providerChoice('Ollama fuente'), other.id);
    const result = await applyImport();
    expect(result.createdProviders).toHaveLength(0);
    expect(api.ctx.store.listProviders()).toHaveLength(2);
    expect(api.ctx.store.listAgents()[0].providerId).toBe(other.id);
  });

  it('de otro tipo solo hay que crearlo (se ofrece usar uno de aquí); al elegirlo propone el primero y deja cambiarlo', async () => {
    const source = await seedSource();
    const bundle = await exportWorkflow(source.workflowId);
    wipe(source);
    const first = api.ctx.store.createProvider({ name: 'Nube A', kind: 'openai', baseUrl: 'https://a.ejemplo.test/v1', defaultModel: 'm' });
    const second = api.ctx.store.createProvider({ name: 'Nube B', kind: 'openai', baseUrl: 'https://b.ejemplo.test/v1', defaultModel: 'm' });
    await open(bundle);

    expect(choice('Ollama fuente').value).toBe('create');
    expect(optionLabels(choice('Ollama fuente'))).toEqual(['Crear', 'Usar uno de aquí']);
    expect(rows('Proveedores')[0].textContent).toContain(`Se creará apuntando a ${SOURCE_URL}`);
    expect(providerChoice('Ollama fuente')).toBeNull();

    await select(choice('Ollama fuente'), 'reuse');
    expect(providerChoice('Ollama fuente')!.value).toBe(first.id); // sin elegir, el primero
    await select(providerChoice('Ollama fuente'), second.id);
    await applyImport();
    expect(api.ctx.store.listProviders()).toHaveLength(2);
    expect(api.ctx.store.listAgents()[0].providerId).toBe(second.id);
  });

  it('sin ningún proveedor se crea el del archivo, apuntando a su dirección', async () => {
    const source = await seedSource();
    const bundle = await exportWorkflow(source.workflowId);
    wipe(source);
    await open(bundle);
    expect(choice('Ollama fuente')).toBeNull(); // sin proveedores locales no hay nada que elegir
    expect(rows('Proveedores')[0].textContent).toContain(`Se creará apuntando a ${SOURCE_URL}`);
    await applyImport();
    expect(api.ctx.store.listProviders().map((p) => p.baseUrl)).toEqual([SOURCE_URL]);
  });

  it('un proveedor con otra dirección aquí se avisa y el agente usa el de aquí salvo que se pida crearlo', async () => {
    const source = await seedSource();
    const bundle = await exportWorkflow(source.workflowId);
    wipe(source);
    api.ctx.store.createProvider({ name: 'Ollama fuente', kind: 'ollama', baseUrl: 'http://127.0.0.1:12345', defaultModel: 'test-model' });
    await open(bundle);
    expect(rows('Proveedores')[0].textContent).toContain('Existe, pero es distinto');
    expect(rows('Proveedores')[0].textContent).toContain(`Aquí «Ollama fuente» apunta a http://127.0.0.1:12345; en el archivo, a ${SOURCE_URL}.`);
    await select(choice('Ollama fuente'), 'create');
    const result = await applyImport();
    expect(result.createdProviders.map((p) => p.name)).toEqual(['Ollama fuente (importado)']);
    expect(api.ctx.store.listAgents()[0].providerId).toBe(result.createdProviders[0].id);
  });
});

describe('ImportModal: avisos', () => {
  it('avisa de las herramientas sensibles, de los disparadores en pausa y de las credenciales que hay que rellenar', async () => {
    const source = await seedSource();
    const bundle = await exportWorkflow(source.workflowId);
    wipe(source);
    await open(bundle);

    const warnings = [...body().querySelectorAll('.callout.warning')].map((w) => w.textContent!.trim());
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('herramientas que actúan fuera de la conversación (http_request)');
    expect(warnings[0]).toContain('Revisa los agentes antes de ejecutarlo si no conoces su origen');
    expect(warnings[1]).toBe('Trae un disparador, que se creará en pausa.');
    // La herramienta HTTP dice a quién llama y qué credencial falta.
    expect(rows('Herramientas HTTP')[0].textContent).toContain('Hace peticiones GET a api.ejemplo.test.');
    expect(rows('Herramientas HTTP')[0].textContent).toContain('habrá que escribir Authorization al editarla');

    const result = await applyImport();
    expect(result.warnings).toEqual(
      expect.arrayContaining([`La herramienta «${TOOL}» lleva credenciales que no viajan en el archivo: escribe Authorization al editarla.`]),
    );
  });

  it('con varios disparadores los cuenta, y con un webhook avisa de que su secreto es nuevo', async () => {
    const source = await seedSource();
    api.ctx.store.createTrigger(
      source.workflowId,
      { kind: 'webhook', name: 'Alertas', intervalMinutes: null, time: null, weekdays: [], cron: null, timezone: null, input: '', enabled: true },
      null,
      'whsec_origen',
    );
    const bundle = await exportWorkflow(source.workflowId);
    expect(JSON.stringify(bundle)).not.toContain('whsec_origen');
    wipe(source);
    await open(bundle);
    expect(text()).toContain('Trae 2 disparadores, que se crearán en pausa.');
    const result = await applyImport();
    expect(result.triggers).toBe(2);
    expect(result.warnings.join(' ')).toContain('Los webhooks importados tienen un secreto nuevo');
    const triggers = api.ctx.store.listTriggers(result.workflow!.id);
    expect(triggers.every((t) => !t.enabled)).toBe(true);
    const hook = triggers.find((t) => t.kind === 'webhook')!;
    expect(api.ctx.store.getTriggerSecret(hook.id)).toMatch(/^whsec_/);
    expect(api.ctx.store.getTriggerSecret(hook.id)).not.toBe('whsec_origen');
  });

  it('una herramienta del archivo que aquí es integrada no se importa y se explica', async () => {
    const source = await seedSource();
    const bundle = (await exportWorkflow(source.workflowId)) as any;
    bundle.tools.push({ ...bundle.tools[0], name: 'calculator', secretHeaders: [] });
    wipe(source);
    await open(bundle);
    const row = rows('Herramientas HTTP').find((r) => r.textContent!.includes('calculator'))!;
    expect(row.textContent).toContain('No importar');
    expect(row.textContent).toContain('integrada o de un servidor MCP');
    const result = await applyImport();
    expect(result.createdTools).toEqual([TOOL]);
  });

  it('avisa si no hay ningún proveedor al que atar el agente y lo deja sin crear', async () => {
    const source = await seedSource();
    const bundle = (await exportWorkflow(source.workflowId)) as any;
    delete bundle.agents[0].provider; // el archivo no dice qué proveedor usa el agente
    bundle.providers = [];
    wipe(source);
    await open(bundle);
    expect(rows('Agentes')[0].textContent).toContain('No hay ningún proveedor configurado: no se podrá crear.');
    const result = await applyImport();
    expect(result.createdAgents).toHaveLength(0);
    expect(result.warnings.join(' ')).toContain('No se pudo crear el agente «Portable»: no hay ningún proveedor configurado.');
    expect(api.ctx.store.listAgents()).toHaveLength(0);
  });
});

describe('ImportModal: archivo no válido', () => {
  it('un JSON que no es una exportación de AgentForge muestra el motivo, deshabilita «Importar» y no crea nada', async () => {
    await open({ nombre: 'cualquier cosa' }, 'otro.json');
    expect(body().querySelector('[role="dialog"]')!.getAttribute('aria-label')).toBe('Importar');
    expect(alerts()).toEqual(['No se puede importar «otro.json». El archivo no es un workflow ni un agente exportado de AgentForge.']);
    expect(importButton().disabled).toBe(true);
    importButton().click();
    await flushPromises();
    expect(wrapper.emitted('done')).toBeUndefined();
    expect(api.ctx.store.listWorkflows()).toHaveLength(0);
  });

  it('un archivo con el formato correcto pero incompleto dice qué campo falla', async () => {
    await open({ format: 'agentforge.workflow', version: 2, exportedAt: new Date().toISOString(), agents: [] }, 'incompleto.json');
    expect(alerts()[0]).toContain('No se puede importar «incompleto.json».');
    expect(alerts()[0]).toContain('workflow');
    expect(importButton().disabled).toBe(true);
    expect(api.ctx.store.listWorkflows()).toHaveLength(0);
  });

  it('un archivo de agentes sin ningún agente se rechaza', async () => {
    await open({ format: 'agentforge.agent', version: 2, exportedAt: new Date().toISOString(), agents: [] }, 'vacio.json');
    expect(alerts()[0]).toContain('El archivo no trae ningún agente');
    expect(importButton().disabled).toBe(true);
  });

  it('un valor que no es un objeto (por ejemplo, null) también se rechaza', async () => {
    await open(null, 'nulo.json');
    expect(alerts()[0]).toContain('No se puede importar «nulo.json».');
    expect(importButton().disabled).toBe(true);
  });
});

describe('ImportModal: cancelar y fallos al aplicar', () => {
  it('«Cancelar» cierra el diálogo sin crear nada, aunque se hayan cambiado las decisiones', async () => {
    const source = await seedSource();
    const bundle = await exportWorkflow(source.workflowId);
    wipe(source);
    const local = api.ctx.store.createProvider({ name: 'Ollama local', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', defaultModel: 'test-model' });
    await open(bundle);
    await select(choice('Ollama fuente'), 'create'); // una decisión cambiada que no debe aplicarse
    cancelButton().click();
    await flushPromises();
    expect(wrapper.emitted('close')).toHaveLength(1);
    expect(wrapper.emitted('done')).toBeUndefined();
    expect(api.ctx.store.listWorkflows()).toHaveLength(0);
    expect(api.ctx.store.listAgents()).toHaveLength(0);
    expect(api.ctx.store.listProviders().map((p) => p.id)).toEqual([local.id]);
    expect(api.ctx.store.listCustomTools()).toHaveLength(0);
  });

  it('si lo elegido deja de existir antes de importar, se explica, no se crea nada y se puede volver a intentar', async () => {
    const source = await seedSource();
    const bundle = await exportWorkflow(source.workflowId);
    wipe(source);
    const gone = api.ctx.store.createProvider({ name: 'Efímero', kind: 'ollama', baseUrl: 'http://127.0.0.1:11436', defaultModel: 'm' });
    await open(bundle);
    expect(providerChoice('Ollama fuente')!.value).toBe(gone.id);
    api.ctx.store.deleteProvider(gone.id); // desaparece mientras se revisa el diálogo

    importButton().click();
    await until(() => alerts().length > 0);
    expect(alerts()[0]).toContain('la acción «reuse» no es posible');
    expect(wrapper.emitted('done')).toBeUndefined();
    expect(api.ctx.store.listWorkflows()).toHaveLength(0);
    expect(api.ctx.store.listAgents()).toHaveLength(0);
    expect(api.ctx.store.listCustomTools()).toHaveLength(0); // todo o nada
    expect(importButton().disabled).toBe(false); // se puede corregir la decisión y reintentar

    await select(choice('Ollama fuente'), 'create');
    const result = await applyImport();
    expect(result.createdProviders.map((p) => p.name)).toEqual(['Ollama fuente']);
    expect(api.ctx.store.listWorkflows()).toHaveLength(1);
  });
});

describe('ImportModal: avisos y notas en el idioma de la interfaz', () => {
  afterEach(() => setLocale('es', false));

  it('en inglés traduce los avisos del plan y las notas de cada elemento; en español muestra los del servidor', async () => {
    const source = await seedSource();
    const bundle = await exportWorkflow(source.workflowId);
    wipe(source);
    setLocale('en', false);
    await open(bundle);
    const warnings = () => [...body().querySelectorAll('.callout.warning')].map((w) => w.textContent?.trim());
    expect(warnings()).toEqual([
      'This file uses tools that act outside the conversation (http_request). Review the agents before running it if you do not know where it comes from.',
      'It brings one trigger, which will be created paused.',
    ]);
    const notes = () => [...body().querySelectorAll('.note')].map((n) => n.textContent?.trim());
    expect(notes().sort()).toEqual([
      'It carries credentials that do not travel in the file: you will have to enter Authorization when editing it.',
      'It sends GET requests to api.ejemplo.test.',
      `It will be created pointing to ${SOURCE_URL}.`,
    ]);

    setLocale('es', false);
    await flushPromises();
    expect(warnings()).toEqual([
      'Este archivo usa herramientas que actúan fuera de la conversación (http_request). Revisa los agentes antes de ejecutarlo si no conoces su origen.',
      'Trae un disparador, que se creará en pausa.',
    ]);
    expect(notes()).toContain(`Se creará apuntando a ${SOURCE_URL}.`);
  });
});
