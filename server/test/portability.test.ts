// Portabilidad: cabeceras secretas cifradas, archivo de exportación completo (sin secretos) e importación en dos
// pasos con resolución de conflictos y atómica. Motor y API reales; solo el LLM está guionizado.
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { Agent, AgentExport, CustomTool, ImportItem, ImportPlan, ImportResult, Provider, Run, Trigger, TriggerWithSecret, Workflow, WorkflowExport } from '../../shared/types';
import { isSecretHeaderName } from '../../shared/types';
import { buildApp } from '../src/app';
import type { AppContext } from '../src/context';
import { makeContext, ScriptedLlm, tempDir, userText } from './helpers';

let ctx: AppContext;
let app: FastifyInstance;
const dirs: string[] = [];
const servers: http.Server[] = [];

async function boot(dataDir = tempDir(), llm = new ScriptedLlm((req) => ({ content: `eco(${userText(req)})` }))) {
  if (!dirs.includes(dataDir)) dirs.push(dataDir);
  ctx = makeContext(llm, { dataDir, inMemory: false });
  app = await buildApp(ctx);
  return { dataDir, llm };
}
async function shutdown() {
  await app?.close();
  await ctx?.close();
}
afterEach(async () => {
  await shutdown();
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const post = (url: string, payload?: unknown) => app.inject({ method: 'POST', url, payload: payload ?? {} });
const put = (url: string, payload: unknown) => app.inject({ method: 'PUT', url, payload: payload as object });
const get = (url: string) => app.inject({ method: 'GET', url });
const list = async <T>(url: string) => (await get(url)).json() as T[];

/** API local que anota las cabeceras que recibe. */
async function echoApi(): Promise<{ url: string; seen: http.IncomingHttpHeaders[] }> {
  const seen: http.IncomingHttpHeaders[] = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers);
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

const toolInput = (extra: Record<string, unknown> = {}) => ({
  name: 'consultar_stock',
  description: 'Consulta el stock de un producto',
  parameters: { type: 'object', properties: { producto: { type: 'string' } }, required: ['producto'] },
  method: 'GET',
  urlTemplate: 'https://api.ejemplo.test/stock?p={{producto}}',
  headers: { Authorization: 'Bearer s3creto-de-la-api', 'X-Origen': 'agentforge' },
  bodyTemplate: '',
  ...extra,
});

const node = (id: string, type: string, config: Record<string, unknown> = {}) => ({ id, type, label: id, position: { x: 0, y: 0 }, config });

/** Instalación de origen: proveedor con clave, herramienta HTTP con credenciales, agente, subworkflow, workflow y disparadores. */
async function seedSource() {
  const provider = (await post('/api/providers', { name: 'Nube', kind: 'openai', baseUrl: 'https://llm.ejemplo.test/v1', apiKey: 'sk-clave-muy-secreta', defaultModel: 'modelo-nube' })).json() as Provider;
  const tool = (await post('/api/tools/custom', toolInput())).json() as CustomTool;
  const agent = (await post('/api/agents', { name: 'Almacenero', role: 'consulta stock', providerId: provider.id, model: 'modelo-nube', systemPrompt: 'Sé breve.', tools: ['consultar_stock', 'calculator'] })).json() as Agent;
  const helper = (await post('/api/agents', { name: 'Redactor', providerId: provider.id, model: 'modelo-nube' })).json() as Agent;
  const sub = (
    await post('/api/workflows', {
      name: 'Redactar aviso',
      nodes: [node('entrada', 'input'), node('escribir', 'agent', { agentId: helper.id, prompt: 'redacta: {{input}}' })],
      edges: [{ id: 'e', source: 'entrada', target: 'escribir' }],
    })
  ).json() as Workflow;
  const wf = (
    await post('/api/workflows', {
      name: 'Aviso de stock',
      description: 'Consulta y avisa',
      nodes: [
        node('entrada', 'input'),
        node('consultar', 'agent', { agentId: agent.id, prompt: 'stock de {{input}}' }),
        node('aviso', 'subworkflow', { workflowId: sub.id, input: '{{consultar}}' }),
      ],
      edges: [
        { id: 'e1', source: 'entrada', target: 'consultar' },
        { id: 'e2', source: 'consultar', target: 'aviso' },
      ],
    })
  ).json() as Workflow;
  await post(`/api/workflows/${wf.id}/triggers`, { kind: 'daily', time: '08:00', weekdays: [1, 2, 3, 4, 5], timezone: 'Europe/Madrid', input: 'tornillos', name: 'Laborables' });
  const hook = (await post(`/api/workflows/${wf.id}/triggers`, { kind: 'webhook', name: 'Desde el ERP' })).json() as TriggerWithSecret;
  return { provider, tool, agent, helper, sub, wf, hook };
}
const exportOf = async (id: string) => (await get(`/api/workflows/${id}/export`)).json() as WorkflowExport;
const planOf = async (bundle: unknown) => (await post('/api/import/plan', { bundle })).json() as ImportPlan;
const item = (plan: ImportPlan, key: string) => plan.items.find((i) => i.key === key) as ImportItem;

describe('cabeceras secretas de las herramientas HTTP', () => {
  it('reconoce por el nombre qué cabeceras llevan credenciales', () => {
    for (const name of ['Authorization', 'authorization', 'Proxy-Authorization', 'Cookie', 'X-API-Key', 'x-api_key', 'apikey', 'X-Auth-Token', 'X-Client-Secret', 'Ocp-Apim-Subscription-Key', 'X-Session-Id', 'X-Hub-Signature']) {
      expect(isSecretHeaderName(name), name).toBe(true);
    }
    for (const name of ['Accept', 'Content-Type', 'X-Origen', 'User-Agent', 'X-Request-Id', 'Accept-Language', 'X-Keyboard']) expect(isSecretHeaderName(name), name).toBe(false);
  });

  it('se guardan cifradas, no se devuelven y siguen llegando a la API al ejecutar la herramienta', async () => {
    await boot();
    const api = await echoApi();
    await put('/api/settings', { allowPrivateNetwork: true });
    const created = (await post('/api/tools/custom', toolInput({ urlTemplate: `${api.url}/stock?p={{producto}}` }))).json() as CustomTool;
    expect(created.headers).toEqual({ 'X-Origen': 'agentforge', Authorization: '' });
    expect(created.secretHeaders).toEqual(['Authorization']);
    for (const url of ['/api/tools/custom', `/api/tools/custom/${created.id}`, '/api/tools']) expect((await get(url)).body, url).not.toContain('s3creto-de-la-api');
    const stored = (ctx.db.prepare('SELECT config FROM custom_tools WHERE id = ?').get(created.id) as { config: string }).config;
    expect(stored).not.toContain('s3creto-de-la-api');
    expect(stored).toContain('v1:');

    const invoke = async () => (await post('/api/tools/consultar_stock/invoke', { args: { producto: 'tuerca' } })).json();
    expect(await invoke()).toMatchObject({ ok: true });
    expect(api.seen.at(-1)).toMatchObject({ authorization: 'Bearer s3creto-de-la-api', 'x-origen': 'agentforge' });

    // Editar sin reescribir el valor (llega vacío) lo conserva; cambiar otra cosa no lo pierde.
    const edited = (await put(`/api/tools/custom/${created.id}`, toolInput({ urlTemplate: `${api.url}/stock?p={{producto}}`, description: 'Otra descripción', headers: { Authorization: '', 'X-Origen': 'v2' } }))).json() as CustomTool;
    expect(edited.secretHeaders).toEqual(['Authorization']);
    await invoke();
    expect(api.seen.at(-1)).toMatchObject({ authorization: 'Bearer s3creto-de-la-api', 'x-origen': 'v2' });
    // Escribir uno nuevo lo sustituye.
    await put(`/api/tools/custom/${created.id}`, toolInput({ urlTemplate: `${api.url}/stock?p={{producto}}`, headers: { Authorization: 'Bearer otro' } }));
    await invoke();
    expect(api.seen.at(-1)!.authorization).toBe('Bearer otro');
    expect(api.seen.at(-1)!['x-origen']).toBeUndefined();
    // Quitar la cabecera la borra.
    const cleared = (await put(`/api/tools/custom/${created.id}`, toolInput({ urlTemplate: `${api.url}/stock?p={{producto}}`, headers: {} }))).json() as CustomTool;
    expect(cleared).toMatchObject({ headers: {}, secretHeaders: [] });
    await invoke();
    expect(api.seen.at(-1)!.authorization).toBeUndefined();
  });

  it('al arrancar cifra las credenciales que una versión anterior guardó en claro', async () => {
    const { dataDir } = await boot();
    const api = await echoApi();
    await put('/api/settings', { allowPrivateNetwork: true });
    const tool = (await post('/api/tools/custom', toolInput({ urlTemplate: `${api.url}/x`, headers: {} }))).json() as CustomTool;
    // Así guardaba las cabeceras la versión anterior: todas en claro dentro de la configuración.
    const legacy = JSON.stringify({ method: 'GET', urlTemplate: `${api.url}/x`, headers: { Authorization: 'Bearer antiguo', 'X-Origen': 'a' }, bodyTemplate: '' });
    ctx.db.prepare('UPDATE custom_tools SET config = ? WHERE id = ?').run(legacy, tool.id);
    // Antes incluso de reiniciar, la API ya no devuelve el valor.
    expect((await get(`/api/tools/custom/${tool.id}`)).body).not.toContain('Bearer antiguo');
    await shutdown();

    await boot(dataDir);
    const stored = (ctx.db.prepare('SELECT config FROM custom_tools WHERE id = ?').get(tool.id) as { config: string }).config;
    expect(stored).not.toContain('Bearer antiguo');
    expect((await get(`/api/tools/custom/${tool.id}`)).json()).toMatchObject({ headers: { 'X-Origen': 'a', Authorization: '' }, secretHeaders: ['Authorization'] });
    await post('/api/tools/consultar_stock/invoke', { args: { producto: 'x' } });
    expect(api.seen.at(-1)).toMatchObject({ authorization: 'Bearer antiguo', 'x-origen': 'a' });
  });
});

describe('exportación', () => {
  it('el archivo de un workflow lleva todo lo que necesita y ningún secreto', async () => {
    await boot();
    const { wf, sub, agent, helper, hook } = await seedSource();
    const res = await get(`/api/workflows/${wf.id}/export`);
    const bundle = res.json() as WorkflowExport;
    expect(bundle).toMatchObject({ format: 'agentforge.workflow', version: 2, workflow: { name: 'Aviso de stock' } });
    expect(bundle.agents.map((a) => [a.id, a.name, a.provider])).toEqual([
      [agent.id, 'Almacenero', 'Nube'],
      [helper.id, 'Redactor', 'Nube'],
    ]);
    expect(bundle.providers).toEqual([{ name: 'Nube', kind: 'openai', baseUrl: 'https://llm.ejemplo.test/v1', defaultModel: 'modelo-nube' }]);
    expect(bundle.tools).toHaveLength(1);
    expect(bundle.tools![0]).toMatchObject({ name: 'consultar_stock', headers: { 'X-Origen': 'agentforge', Authorization: '' }, secretHeaders: ['Authorization'], urlTemplate: 'https://api.ejemplo.test/stock?p={{producto}}' });
    expect(bundle.tools![0]).not.toHaveProperty('id');
    expect(bundle.subworkflows).toEqual([{ id: sub.id, workflow: { name: 'Redactar aviso', description: sub.description, nodes: sub.nodes, edges: sub.edges, settings: sub.settings } }]);
    expect(bundle.triggers).toEqual([
      { kind: 'daily', name: 'Laborables', intervalMinutes: null, time: '08:00', weekdays: [1, 2, 3, 4, 5], cron: null, timezone: 'Europe/Madrid', input: 'tornillos', enabled: true },
      { kind: 'webhook', name: 'Desde el ERP', intervalMinutes: null, time: null, weekdays: [], cron: null, timezone: null, input: '', enabled: true },
    ]);
    for (const secret of ['sk-clave-muy-secreta', 's3creto-de-la-api', hook.secret!, 'whsec_', 'providerId', 'apiKey']) expect(res.body, secret).not.toContain(secret);
  });

  it('el archivo de un agente suelto lleva su herramienta HTTP y su proveedor, sin clave', async () => {
    await boot();
    const { agent } = await seedSource();
    const res = await get(`/api/agents/${agent.id}/export`);
    const bundle = res.json() as AgentExport;
    expect(bundle).toMatchObject({ format: 'agentforge.agent', version: 2 });
    expect(bundle.agents).toHaveLength(1);
    expect(bundle.agents[0]).toMatchObject({ name: 'Almacenero', provider: 'Nube', tools: ['consultar_stock', 'calculator'] });
    expect(bundle.providers!.map((p) => p.name)).toEqual(['Nube']);
    expect(bundle.tools!.map((t) => t.name)).toEqual(['consultar_stock']);
    expect(res.body).not.toContain('sk-clave-muy-secreta');
    expect(res.body).not.toContain('s3creto-de-la-api');
    expect((await get('/api/agents/agt_no_existe/export')).statusCode).toBe(404);
  });
});

describe('importación', () => {
  it('en una instalación vacía crea todo lo que trae el archivo y el workflow funciona', async () => {
    await boot();
    const bundle = await exportOf((await seedSource()).wf.id);
    await shutdown();

    const { llm } = await boot();
    const plan = await planOf(bundle);
    expect(plan).toMatchObject({ kind: 'workflow', name: 'Aviso de stock' });
    expect(plan.items.map((i) => [i.key.split(':')[0], i.name, i.match, i.recommended])).toEqual([
      ['provider', 'Nube', null, 'create'],
      ['tool', 'consultar_stock', null, 'create'],
      ['agent', 'Almacenero', null, 'create'],
      ['agent', 'Redactor', null, 'create'],
      ['workflow', 'Redactar aviso', null, 'create'],
    ]);
    expect(item(plan, 'provider:Nube').notes.join(' ')).toMatch(/sin clave de API/);
    expect(item(plan, 'tool:consultar_stock').notes.join(' ')).toMatch(/peticiones GET a api\.ejemplo\.test/);
    expect(item(plan, 'tool:consultar_stock').notes.join(' ')).toMatch(/habrá que escribir Authorization/);
    expect(plan.warnings.join(' ')).toMatch(/2 disparadores, que se crearán en pausa/);
    // El plan no cambia nada.
    expect(await list('/api/agents')).toEqual([]);

    const res = await post('/api/import', { bundle });
    expect(res.statusCode).toBe(201);
    const result = res.json() as ImportResult;
    expect(result.createdProviders.map((p) => [p.name, p.kind, p.hasApiKey])).toEqual([['Nube', 'openai', false]]);
    expect(result.createdTools).toEqual(['consultar_stock']);
    expect(result.createdAgents.map((a) => a.name)).toEqual(['Almacenero', 'Redactor']);
    expect(result.createdWorkflows.map((w) => w.name)).toEqual(['Redactar aviso']);
    expect(result).toMatchObject({ reusedAgents: [], replacedAgents: [], replacedTools: [], triggers: 2 });
    expect(result.issues.filter((i) => i.level === 'error')).toEqual([]);
    expect(result.warnings.join(' ')).toMatch(/«Nube» se ha creado sin clave de API/);
    expect(result.warnings.join(' ')).toMatch(/«consultar_stock» lleva credenciales que no viajan en el archivo: escribe Authorization/);
    expect(result.warnings.join(' ')).toMatch(/webhooks importados tienen un secreto nuevo/);

    // Las referencias apuntan a lo recién creado, no a los ids de origen.
    const wf = result.workflow!;
    const almacenero = result.createdAgents[0];
    expect(almacenero).toMatchObject({ providerId: result.createdProviders[0].id, tools: ['consultar_stock', 'calculator'], model: 'modelo-nube' });
    expect(wf.nodes.find((n) => n.id === 'consultar')!.config.agentId).toBe(almacenero.id);
    expect(wf.nodes.find((n) => n.id === 'aviso')!.config.workflowId).toBe(result.createdWorkflows[0].id);
    expect(result.createdWorkflows[0].nodes.find((n) => n.id === 'escribir')!.config.agentId).toBe(result.createdAgents[1].id);
    // La herramienta existe con la cabecera secreta pendiente de rellenar.
    expect((await list<CustomTool>('/api/tools/custom'))[0]).toMatchObject({ name: 'consultar_stock', headers: { 'X-Origen': 'agentforge', Authorization: '' }, secretHeaders: [] });
    // Los disparadores llegan en pausa.
    const triggers = await list<Trigger>(`/api/workflows/${wf.id}/triggers`);
    expect(triggers.map((t) => [t.kind, t.name, t.enabled, t.nextRunAt])).toEqual([
      ['daily', 'Laborables', false, null],
      ['webhook', 'Desde el ERP', false, null],
    ]);
    expect(ctx.scheduler.tick(Date.now() + 7 * 86_400_000)).toEqual([]);

    // Y se ejecuta de principio a fin: agente → subworkflow con su agente.
    const run = (await post(`/api/workflows/${wf.id}/run`, { input: 'tornillos' })).json() as Run;
    await ctx.runs.waitFor(run.id);
    expect(ctx.store.getRun(run.id)).toMatchObject({ status: 'completed', output: 'eco(redacta: eco(stock de tornillos))' });
    expect(llm.calls).toHaveLength(2);
  });

  it('en la misma instalación reutiliza lo que ya existe y solo crea el workflow', async () => {
    await boot();
    const { wf, sub, agent, helper, provider } = await seedSource();
    const bundle = await exportOf(wf.id);
    const plan = await planOf(bundle);
    expect(plan.items.map((i) => [i.name, i.match?.id, i.differs, i.recommended])).toEqual([
      ['Nube', provider.id, false, 'reuse'],
      ['consultar_stock', expect.any(String), false, 'reuse'],
      ['Almacenero', agent.id, false, 'reuse'],
      ['Redactor', helper.id, false, 'reuse'],
      ['Redactar aviso', sub.id, false, 'reuse'],
    ]);
    const result = (await post('/api/import', { bundle })).json() as ImportResult;
    expect(result.workflow!.name).toBe('Aviso de stock (importado)');
    expect(result).toMatchObject({ createdAgents: [], createdProviders: [], createdTools: [], createdWorkflows: [], replacedAgents: [], triggers: 2 });
    expect(result.reusedAgents.map((a) => a.id)).toEqual([agent.id, helper.id]);
    expect(result.workflow!.nodes.find((n) => n.id === 'aviso')!.config.workflowId).toBe(sub.id);
    expect(await list('/api/agents')).toHaveLength(2);
    expect(await list('/api/providers')).toHaveLength(1);
    expect(await list('/api/workflows')).toHaveLength(3);
    // Otra vez: el nombre no se pisa.
    expect(((await post('/api/import', { bundle })).json() as ImportResult).workflow!.name).toBe('Aviso de stock (importado 2)');
  });

  it('señala lo que coincide pero es distinto y aplica lo que se decida con cada elemento', async () => {
    await boot();
    const { wf, sub, agent, tool } = await seedSource();
    const bundle = await exportOf(wf.id);
    // Aquí las cosas han cambiado desde que se exportó el archivo.
    await put(`/api/agents/${agent.id}`, { ...agent, systemPrompt: 'Versión local, más larga.' });
    await put(`/api/tools/custom/${tool.id}`, toolInput({ urlTemplate: 'https://api.ejemplo.test/v2/stock?p={{producto}}', headers: { Authorization: '', 'X-Origen': 'agentforge' } }));
    await put(`/api/workflows/${sub.id}`, { ...sub, nodes: sub.nodes.map((n) => (n.id === 'escribir' ? { ...n, config: { ...n.config, prompt: 'versión local: {{input}}' } } : n)) });

    const plan = await planOf(bundle);
    expect(item(plan, `agent:${agent.id}`)).toMatchObject({ differs: true, actions: ['reuse', 'replace', 'create'], recommended: 'reuse' });
    expect(item(plan, 'tool:consultar_stock')).toMatchObject({ differs: true, actions: ['reuse', 'replace'], recommended: 'reuse' });
    // Un subworkflow distinto no se usa sin avisar: por defecto se crea una copia.
    expect(item(plan, `workflow:${sub.id}`)).toMatchObject({ differs: true, actions: ['reuse', 'create'], recommended: 'create' });
    expect(item(plan, 'provider:Nube')).toMatchObject({ differs: false, recommended: 'reuse' });

    // Por defecto: se respeta lo local (agente y herramienta) y el subworkflow se copia.
    const byDefault = (await post('/api/import', { bundle })).json() as ImportResult;
    expect(byDefault.createdWorkflows.map((w) => w.name)).toEqual(['Redactar aviso (importado)']);
    expect(byDefault.workflow!.nodes.find((n) => n.id === 'aviso')!.config.workflowId).toBe(byDefault.createdWorkflows[0].id);
    expect((await get(`/api/agents/${agent.id}`)).json().systemPrompt).toBe('Versión local, más larga.');
    expect((await get(`/api/tools/custom/${tool.id}`)).json().urlTemplate).toContain('/v2/');

    // Decidiendo: sustituir el agente y la herramienta, y usar el subworkflow de aquí.
    const decided = (
      await post('/api/import', {
        bundle,
        decisions: { [`agent:${agent.id}`]: { action: 'replace' }, 'tool:consultar_stock': { action: 'replace' }, [`workflow:${sub.id}`]: { action: 'reuse' } },
      })
    ).json() as ImportResult;
    expect(decided.replacedAgents.map((a) => a.id)).toEqual([agent.id]);
    expect(decided.replacedTools).toEqual(['consultar_stock']);
    expect(decided.createdWorkflows).toEqual([]);
    expect(decided.workflow!.nodes.find((n) => n.id === 'aviso')!.config.workflowId).toBe(sub.id);
    expect((await get(`/api/agents/${agent.id}`)).json()).toMatchObject({ systemPrompt: 'Sé breve.', providerId: agent.providerId });
    const replaced = (await get(`/api/tools/custom/${tool.id}`)).json() as CustomTool;
    expect(replaced.urlTemplate).toBe('https://api.ejemplo.test/stock?p={{producto}}');
    // La credencial guardada aquí se conserva al sustituir (el archivo no la trae).
    expect(replaced.secretHeaders).toEqual(['Authorization']);
    expect(ctx.store.getCustomToolByName('consultar_stock', true)!.headers.Authorization).toBe('Bearer s3creto-de-la-api');

    // Crear una copia del agente en lugar de tocar el de aquí.
    const copied = (await post('/api/import', { bundle, decisions: { [`agent:${agent.id}`]: { action: 'create' } } })).json() as ImportResult;
    expect(copied.createdAgents.map((a) => a.name)).toEqual(['Almacenero (importado)']);
    expect(copied.workflow!.nodes.find((n) => n.id === 'consultar')!.config.agentId).toBe(copied.createdAgents[0].id);
  });

  it('proveedores: usa uno local del mismo tipo, el que se elija, o lo crea', async () => {
    await boot();
    const bundle = await exportOf((await seedSource()).wf.id);
    await shutdown();

    await boot();
    const local = (await post('/api/providers', { name: 'Mi OpenAI', kind: 'openai', baseUrl: 'https://otro.ejemplo.test/v1', apiKey: 'sk-local' })).json() as Provider;
    const ollama = (await post('/api/providers', { name: 'Ollama', kind: 'ollama', baseUrl: 'http://localhost:11434' })).json() as Provider;
    const plan = await planOf(bundle);
    expect(item(plan, 'provider:Nube')).toMatchObject({ match: null, actions: ['create', 'reuse'], recommended: 'reuse', recommendedTargetId: local.id });
    expect(item(plan, 'provider:Nube').targets!.map((t) => t.name).sort()).toEqual(['Mi OpenAI', 'Ollama']);

    const byDefault = (await post('/api/import', { bundle })).json() as ImportResult;
    expect(byDefault.createdProviders).toEqual([]);
    expect(byDefault.createdAgents.every((a) => a.providerId === local.id)).toBe(true);
    // Eligiendo otro proveedor local.
    const chosen = (await post('/api/import', { bundle, decisions: { 'provider:Nube': { action: 'reuse', targetId: ollama.id }, 'agent:x': { action: 'create' } } })).json() as ImportResult;
    expect(chosen.reusedAgents).toHaveLength(2); // los agentes ya existen de la importación anterior
    // Creándolo.
    const created = (await post('/api/import', { bundle, decisions: { 'provider:Nube': { action: 'create' } } })).json() as ImportResult;
    expect(created.createdProviders.map((p) => [p.name, p.baseUrl, p.hasApiKey])).toEqual([['Nube', 'https://llm.ejemplo.test/v1', false]]);
    expect(await list('/api/providers')).toHaveLength(3);
  });

  it('una decisión imposible o un fallo a medias no deja nada creado', async () => {
    await boot();
    const bundle = await exportOf((await seedSource()).wf.id);
    await shutdown();

    await boot();
    const counts = async () => [(await list('/api/providers')).length, (await list('/api/tools/custom')).length, (await list('/api/agents')).length, (await list('/api/workflows')).length, (await list('/api/triggers')).length];
    // Acción que el elemento no admite.
    const invalid = await post('/api/import', { bundle, decisions: { 'tool:consultar_stock': { action: 'replace' } } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error).toMatch(/«consultar_stock»: la acción «replace» no es posible/);
    expect(await counts()).toEqual([0, 0, 0, 0, 0]);

    // Fallo cuando ya se han creado el proveedor, la herramienta, los agentes y el subworkflow: dos disparadores
    // iguales no son un problema, pero un nombre de herramienta repetido dentro del archivo sí (restricción única).
    const broken = { ...bundle, tools: [...bundle.tools!, { ...bundle.tools![0] }] };
    const failed = await post('/api/import', { bundle: broken });
    expect(failed.statusCode).toBe(400);
    expect(failed.json().error).toMatch(/No se pudo importar el archivo \(no se ha creado nada\)/);
    expect(await counts()).toEqual([0, 0, 0, 0, 0]);

    // El mismo archivo, bien, sí entra entero.
    expect((await post('/api/import', { bundle })).statusCode).toBe(201);
    expect(await counts()).toEqual([1, 1, 2, 2, 2]);
  });

  it('avisa de las herramientas que actúan fuera y no importa una que choca con una integrada', async () => {
    await boot();
    const provider = (await post('/api/providers', { name: 'Local', kind: 'ollama', baseUrl: 'http://localhost:11434', defaultModel: 'm' })).json() as Provider;
    const bundle = {
      format: 'agentforge.agent',
      version: 2,
      exportedAt: new Date().toISOString(),
      agents: [{ id: 'agt_ajeno', name: 'Operador', tools: ['http_request', 'run_javascript', 'calculator', 'herramienta_fantasma'], provider: 'Local' }],
      providers: [{ name: 'Local', kind: 'ollama', baseUrl: 'http://localhost:11434', defaultModel: 'm' }],
      tools: [toolInput({ name: 'calculator', secretHeaders: [], headers: {} })],
    };
    const plan = await planOf(bundle);
    expect(plan.kind).toBe('agent');
    expect(plan.warnings.join(' ')).toMatch(/herramientas que actúan fuera de la conversación \(http_request, run_javascript\)/);
    expect(item(plan, 'tool:calculator')).toMatchObject({ actions: ['skip'], recommended: 'skip' });
    expect(item(plan, 'provider:Local')).toMatchObject({ match: { id: provider.id }, recommended: 'reuse' });

    const result = (await post('/api/import', { bundle })).json() as ImportResult;
    expect(result.workflow).toBeNull();
    expect(result.createdTools).toEqual([]);
    expect(result.createdAgents[0]).toMatchObject({ name: 'Operador', providerId: provider.id, model: 'm', tools: ['http_request', 'run_javascript', 'calculator'] });
    expect(result.warnings.join(' ')).toMatch(/«Operador» usaba herramientas que no existen aquí: herramienta_fantasma\./);
    expect(await list('/api/tools/custom')).toEqual([]);
  });

  it('un agente suelto viaja a otra instalación con su herramienta y su proveedor', async () => {
    await boot();
    const { agent } = await seedSource();
    const bundle = (await get(`/api/agents/${agent.id}/export`)).json() as AgentExport;
    // En origen: coincide con el que ya hay; se puede pedir una copia.
    expect((await planOf(bundle)).items.map((i) => [i.kind, i.recommended])).toEqual([
      ['provider', 'reuse'],
      ['tool', 'reuse'],
      ['agent', 'reuse'],
    ]);
    const copy = (await post('/api/import', { bundle, decisions: { [`agent:${agent.id}`]: { action: 'create' } } })).json() as ImportResult;
    expect(copy.createdAgents.map((a) => a.name)).toEqual(['Almacenero (importado)']);
    await shutdown();

    await boot();
    const result = (await post('/api/import', { bundle })).json() as ImportResult;
    expect(result.workflow).toBeNull();
    expect(result.createdProviders.map((p) => p.name)).toEqual(['Nube']);
    expect(result.createdTools).toEqual(['consultar_stock']);
    expect(result.createdAgents[0]).toMatchObject({ name: 'Almacenero', tools: ['consultar_stock', 'calculator'], systemPrompt: 'Sé breve.' });
  });

  it('sigue aceptando archivos de la versión 1 y rechaza lo que no es una exportación', async () => {
    await boot();
    const provider = (await post('/api/providers', { name: 'Local', kind: 'ollama', baseUrl: 'http://localhost:11434', defaultModel: 'm' })).json() as Provider;
    const v1 = {
      format: 'agentforge.workflow',
      version: 1,
      exportedAt: '2026-01-01T00:00:00.000Z',
      workflow: { name: 'Antiguo', nodes: [node('entrada', 'input'), node('paso', 'agent', { agentId: 'agt_viejo', prompt: '{{input}}' })], edges: [{ id: 'e', source: 'entrada', target: 'paso' }] },
      agents: [{ id: 'agt_viejo', name: 'Veterano', tools: ['calculator'] }],
    };
    const plan = await planOf(v1);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({ kind: 'agent', name: 'Veterano', recommended: 'create' });
    const result = (await post('/api/import', { bundle: v1 })).json() as ImportResult;
    expect(result.createdAgents[0]).toMatchObject({ name: 'Veterano', providerId: provider.id, model: 'm' });
    expect(result.issues.filter((i) => i.level === 'error')).toEqual([]);

    for (const [bad, message] of [
      [{ hola: 'mundo' }, /no es un workflow ni un agente exportado de AgentForge/],
      [undefined, /no es un workflow ni un agente exportado/],
      [{ ...v1, version: 3 }, /Versión de archivo no admitida/],
      [{ format: 'agentforge.agent', version: 2, agents: [] }, /no trae ningún agente/],
      [{ ...v1, triggers: [{ kind: 'cron', cron: 'nunca' }] }, /cinco campos/],
      [{ ...v1, providers: [{ name: 'X', kind: 'ollama', baseUrl: 'ftp://x' }] }, /URL http/],
    ] as Array<[unknown, RegExp]>) {
      for (const url of ['/api/import/plan', '/api/import']) {
        const res = await post(url, { bundle: bad });
        expect(res.statusCode, `${url} ${JSON.stringify(bad)}`).toBe(400);
        expect(res.json().error, `${url} ${JSON.stringify(bad)}`).toMatch(message);
      }
    }
    expect(await list('/api/workflows')).toHaveLength(1);
  });
});
