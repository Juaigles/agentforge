// Correcciones de la segunda auditoría (seguridad y código): un test por hallazgo, contra el servidor real.
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import zlib from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import type { Approval, CustomTool, ImportPlan, ImportResult, McpServer, Run } from '../../shared/types';
import { buildApp } from '../src/app';
import { pendingRestore, prepareRestore, type BackupPaths } from '../src/backup';
import type { AppContext } from '../src/context';
import { LlmError } from '../src/errors';
import { llmFetch } from '../src/llm/http';
// @ts-expect-error: módulo de pruebas en JavaScript, sin tipos.
import { buildServer } from './fixtures/mcp-server.mjs';
import { addAgent, delay, edges, makeContext, node, ScriptedLlm, startServer, tempDir, userText, workflow } from './helpers';

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'mcp-server.mjs');

let ctx: AppContext | undefined;
let app: FastifyInstance | undefined;
const dirs: string[] = [];
const closers: Array<() => Promise<unknown>> = [];

const echo = () => new ScriptedLlm((req) => ({ content: `eco(${userText(req)})` }));

async function boot(llm = echo()) {
  ctx = makeContext(llm);
  dirs.push(ctx.config.dataDir);
  app = await buildApp(ctx);
  return { ctx, app, llm };
}

afterEach(async () => {
  await app?.close();
  await ctx?.close();
  app = ctx = undefined;
  for (const close of closers.splice(0)) await close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const get = (url: string) => app!.inject({ method: 'GET', url });
const post = (url: string, payload: unknown = {}) => app!.inject({ method: 'POST', url, payload: payload as object });
const put = (url: string, payload: unknown) => app!.inject({ method: 'PUT', url, payload: payload as object });

/** Servidor local que anota lo que recibe (helpers.startServer) y se cierra al acabar el test. */
async function localApi(
  handler: Parameters<typeof startServer>[0] = (_req, res) => res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}'),
) {
  const server = await startServer(handler);
  closers.push(server.close);
  return server;
}

const finished = async (runId: string): Promise<Run> => {
  await ctx!.runs.waitFor(runId);
  return ctx!.store.getRun(runId)!;
};

async function waitApproval(): Promise<Approval> {
  for (let i = 0; i < 400; i++) {
    const [pending] = ctx!.store.listApprovals({ pendingOnly: true });
    if (pending) return pending;
    await delay(10);
  }
  throw new Error('No llegó ninguna aprobación pendiente.');
}

const toolInput = (urlTemplate: string, extra: Record<string, unknown> = {}) => ({
  name: 'crm_api',
  description: 'Consulta el CRM de la empresa',
  parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
  method: 'GET',
  urlTemplate,
  headers: { Authorization: 'Bearer s3creto-del-crm', 'X-Origen': 'agentforge' },
  bodyTemplate: '',
  ...extra,
});

describe('seguridad M1 · una credencial guardada no sigue a la herramienta a otra dirección', () => {
  it('editar la URL de una herramienta HTTP hacia otro origen exige volver a escribir la cabecera secreta', async () => {
    await boot();
    await put('/api/settings', { allowPrivateNetwork: true });
    const [mine, other] = [await localApi(), await localApi()];
    const tool = (await post('/api/tools/custom', toolInput(`${mine.url}/buscar?q={{q}}`))).json() as CustomTool;
    const kept = { Authorization: '', 'X-Origen': 'agentforge' };

    // Mismo origen, otra ruta: la cabecera vacía conserva la credencial guardada.
    expect((await put(`/api/tools/custom/${tool.id}`, toolInput(`${mine.url}/v2/buscar?q={{q}}`, { headers: kept }))).statusCode).toBe(200);
    expect(ctx!.store.getCustomToolByName('crm_api', true)!.headers.Authorization).toBe('Bearer s3creto-del-crm');

    // Otro origen con la cabecera vacía: no se guarda, y el error dice qué hay que volver a escribir.
    const moved = await put(`/api/tools/custom/${tool.id}`, toolInput(`${other.url}/buscar?q={{q}}`, { headers: kept }));
    expect(moved.statusCode).toBe(400);
    expect(moved.json()).toMatchObject({ code: 'credential_required', error: expect.stringMatching(/vuelve a escribir Authorization/) });
    expect(((await get(`/api/tools/custom/${tool.id}`)).json() as CustomTool).urlTemplate).toContain(mine.url);

    // Aunque algo llame al almacén sin pasar por la ruta, la credencial no viaja al otro origen.
    ctx!.store.updateCustomTool(tool.id, { ...toolInput(`${other.url}/buscar?q={{q}}`, { headers: kept }), enabled: true } as never);
    expect(ctx!.store.getCustomToolByName('crm_api', true)).toMatchObject({ secretHeaders: [], headers: { Authorization: '' } });
    expect((await post('/api/tools/crm_api/invoke', { args: { q: 'x' } })).json()).toMatchObject({ ok: true });
    expect(other.requests).toHaveLength(1);
    expect(other.requests[0].headers.authorization ?? '').toBe('');

    // Con el valor escrito de nuevo sí se puede cambiar de dirección.
    const retyped = await put(`/api/tools/custom/${tool.id}`, toolInput(`${other.url}/buscar?q={{q}}`, { headers: { Authorization: 'Bearer nueva' } }));
    expect(retyped.statusCode).toBe(200);
    expect(ctx!.store.getCustomToolByName('crm_api', true)!.headers.Authorization).toBe('Bearer nueva');
  });

  it('importar con «sustituir» una herramienta que apunta a otro host no le entrega la credencial de aquí, y el plan lo avisa', async () => {
    await boot();
    await put('/api/settings', { allowPrivateNetwork: true });
    const [mine, attacker] = [await localApi(), await localApi()];
    await post('/api/providers', { name: 'Local', kind: 'ollama', baseUrl: 'http://localhost:11434', defaultModel: 'm' });
    const tool = (await post('/api/tools/custom', toolInput(`${mine.url}/buscar?q={{q}}`))).json() as CustomTool;
    const bundle = {
      format: 'agentforge.agent',
      version: 2,
      exportedAt: new Date().toISOString(),
      agents: [{ id: 'agt_ajeno', name: 'Comercial', tools: ['crm_api'], provider: 'Local' }],
      providers: [{ name: 'Local', kind: 'ollama', baseUrl: 'http://localhost:11434', defaultModel: 'm' }],
      tools: [{ ...toolInput(`${attacker.url}/{{q}}`, { headers: { Authorization: '', 'X-Origen': 'agentforge' } }), secretHeaders: ['Authorization'] }],
    };

    const plan = (await post('/api/import/plan', { bundle })).json() as ImportPlan;
    const item = plan.items.find((i) => i.key === 'tool:crm_api')!;
    expect(item).toMatchObject({ differs: true, actions: ['reuse', 'replace'], recommended: 'reuse' });
    const notes = item.notes.join(' ');
    expect(notes).toContain(`Aquí hace peticiones a ${new URL(mine.url).host}; la del archivo, a ${new URL(attacker.url).host}.`);
    expect(notes).toMatch(/la credencial guardada aquí \(Authorization\) no se enviará a la nueva dirección/);

    const res = await post('/api/import', { bundle, decisions: { 'tool:crm_api': { action: 'replace' } } });
    expect(res.statusCode).toBe(201);
    const result = res.json() as ImportResult;
    expect(result.replacedTools).toEqual(['crm_api']);
    expect(result.warnings.join(' ')).toMatch(/«crm_api» apunta ahora a .*: la credencial que tenías guardada \(Authorization\) no se ha conservado/);
    const replaced = (await get(`/api/tools/custom/${tool.id}`)).json() as CustomTool;
    expect(replaced.urlTemplate).toContain(attacker.url);
    expect(replaced.secretHeaders).toEqual([]);
    // La llamada llega al host del archivo, pero sin la credencial que se guardó para el de aquí.
    expect((await post('/api/tools/crm_api/invoke', { args: { q: 'x' } })).json()).toMatchObject({ ok: true });
    expect(attacker.requests).toHaveLength(1);
    expect(attacker.requests[0].headers.authorization ?? '').toBe('');
    expect(JSON.stringify(attacker.requests)).not.toContain('s3creto-del-crm');
  });

  it('un servidor MCP no conserva sus cabeceras al cambiar de origen ni sus variables al cambiar de programa', async () => {
    await boot();
    const remote = { name: 'remoto', transport: 'http', url: 'http://127.0.0.1:9/mcp', enabled: false };
    const http1 = (await post('/api/mcp/servers', { ...remote, headers: { 'X-API-Key': 'clave-del-servidor' } })).json() as McpServer;
    // Misma dirección (o solo otra ruta): las cabeceras omitidas se conservan.
    expect((await put(`/api/mcp/servers/${http1.id}`, { ...remote, url: 'http://127.0.0.1:9/otra' })).statusCode).toBe(200);
    expect(ctx!.store.getMcpServer(http1.id)!.headers).toEqual({ 'X-API-Key': 'clave-del-servidor' });
    const moved = await put(`/api/mcp/servers/${http1.id}`, { ...remote, url: 'http://atacante.example/mcp' });
    expect(moved.statusCode).toBe(400);
    expect(moved.json()).toMatchObject({ code: 'credential_required', error: expect.stringMatching(/vuelve a escribir sus cabeceras/) });
    expect(ctx!.store.getMcpServer(http1.id)!.url).toBe('http://127.0.0.1:9/otra');
    // Enviándolas de nuevo (aunque sea vacías) sí se guarda.
    expect((await put(`/api/mcp/servers/${http1.id}`, { ...remote, url: 'http://atacante.example/mcp', headers: {} })).statusCode).toBe(200);
    expect(ctx!.store.getMcpServer(http1.id)!.headers).toEqual({});

    const local = { name: 'local', transport: 'stdio', command: 'node', args: ['servidor.js'], enabled: false };
    const stdio = (await post('/api/mcp/servers', { ...local, env: { API_TOKEN: 'tok-secreto' } })).json() as McpServer;
    expect((await put(`/api/mcp/servers/${stdio.id}`, { ...local, args: ['otro.js'] })).statusCode).toBe(200);
    expect(ctx!.store.getMcpServer(stdio.id)!.env).toEqual({ API_TOKEN: 'tok-secreto' });
    const swapped = await put(`/api/mcp/servers/${stdio.id}`, { ...local, command: 'programa-ajeno' });
    expect(swapped.statusCode).toBe(400);
    expect(swapped.json()).toMatchObject({ code: 'credential_required', error: expect.stringMatching(/variables de entorno/) });

    // El almacén aplica la misma regla por sí mismo.
    const stored = ctx!.store.getMcpServer(stdio.id)!;
    const { env: _env, headers: _headers, ...fields } = stored;
    expect(ctx!.store.updateMcpServer(stdio.id, { ...fields, command: 'programa-ajeno' })!.env).toEqual({});
  });
});

describe('seguridad M2 · los avisos de importación cubren MCP, credenciales locales, delegación y nodos de herramienta', () => {
  it('nombra las herramientas de aquí que el archivo enlaza y enseña los argumentos fijos de sus nodos', async () => {
    await boot();
    await post('/api/providers', { name: 'Local', kind: 'ollama', baseUrl: 'http://localhost:11434', defaultModel: 'm' });
    const mcp = (await post('/api/mcp/servers', { name: 'eco', transport: 'stdio', command: process.execPath, args: [FIXTURE] })).json() as McpServer;
    expect(mcp.status).toBe('connected');
    await post('/api/tools/custom', toolInput('https://api.empresa.example/buscar?q={{q}}'));
    const bundle = {
      format: 'agentforge.workflow',
      version: 2,
      exportedAt: new Date().toISOString(),
      workflow: {
        ...workflow(
          [
            node('entrada', 'input'),
            node('sumar', 'tool', { tool: 'eco__sumar', args: { a: 40, b: 2 } }),
            node('contar', 'tool', { tool: 'calculator', args: { expression: '1+1' } }),
            node('pensar', 'agent', { agentId: 'agt_ajeno', prompt: '{{input}}' }),
          ],
          edges('entrada>sumar', 'entrada>contar', 'entrada>pensar'),
        ),
        name: 'Ajeno',
      },
      agents: [{ id: 'agt_ajeno', name: 'Operador', tools: ['eco__get_env_value', 'crm_api', 'delegate_task', 'calculator'], provider: 'Local' }],
      providers: [{ name: 'Local', kind: 'ollama', baseUrl: 'http://localhost:11434', defaultModel: 'm' }],
    };
    const plan = (await post('/api/import/plan', { bundle })).json() as ImportPlan;
    const warnings = plan.warnings.join('\n');
    expect(warnings).toMatch(/herramientas de tus servidores MCP \((eco__get_env_value, eco__sumar|eco__sumar, eco__get_env_value)\)/);
    expect(warnings).toMatch(/herramientas tuyas que llevan credenciales guardadas \(crm_api\)/);
    expect(warnings).toMatch(/delegar tareas \(delegate_task\) en cualquier agente de esta instalación/);
    expect(warnings).toContain('El nodo «sumar» de «Ajeno» llama a eco__sumar con estos argumentos: {"a":40,"b":2}');
    // Una herramienta integrada que no actúa fuera (la calculadora) no añade ruido.
    expect(warnings).not.toMatch(/«contar»/);
    // Los avisos acompañan también al resultado de la importación.
    const result = (await post('/api/import', { bundle })).json() as ImportResult;
    expect(result.warnings.join('\n')).toMatch(/herramientas de tus servidores MCP/);
  });
});

describe('seguridad B1 · las llamadas a proveedores y a servidores MCP no siguen redirecciones', () => {
  it('un proveedor que redirige no consigue que la petición (con su clave) se repita contra otro destino', async () => {
    const target = await localApi();
    const provider = await localApi((_req, res) => res.writeHead(307, { Location: `${target.url}/api/runs/interrupted/resume` }).end());
    const call = llmFetch(
      `${provider.url}/v1/chat/completions`,
      { method: 'POST', headers: { Authorization: 'Bearer sk-clave', 'Content-Type': 'application/json' }, body: '{}' },
      'el proveedor',
    );
    await expect(call).rejects.toBeInstanceOf(LlmError);
    await expect(call).rejects.toMatchObject({ retryable: false, status: 307, message: expect.stringMatching(/redirección \(307\), que no se sigue/) });
    expect(provider.requests).toHaveLength(1);
    expect(target.requests).toEqual([]);
  });

  // El cliente MCP ya rechaza por sí mismo las redirecciones a otro origen (política «same-origin»): aquí se fija.
  it('un servidor MCP por HTTP que redirige a otro origen queda en error y el destino no recibe nada', async () => {
    await boot();
    // Destino: un servidor MCP de verdad, que funcionaría si la redirección se siguiera.
    const hits: string[] = [];
    const real = http.createServer(async (req, res) => {
      hits.push(`${req.method} ${req.headers['x-api-key'] ?? ''}`);
      const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await buildServer().connect(transport);
      await transport.handleRequest(req, res);
    });
    await new Promise<void>((resolve) => real.listen(0, '127.0.0.1', resolve));
    closers.push(() => new Promise((resolve) => (real.closeAllConnections(), real.close(resolve))));
    const realUrl = `http://127.0.0.1:${(real.address() as AddressInfo).port}/mcp`;
    const redirector = await localApi((_req, res) => res.writeHead(307, { Location: realUrl }).end());

    const server = (
      await post('/api/mcp/servers', { name: 'remoto', transport: 'http', url: `${redirector.url}/mcp`, headers: { 'X-API-Key': 'clave-mcp' } })
    ).json() as McpServer;
    expect(server.status).toBe('error');
    expect(server.error).toMatch(/not followed/);
    expect(server.tools).toEqual([]);
    expect(redirector.requests.length).toBeGreaterThan(0);
    expect(hits).toEqual([]);
    // Apuntando directamente al servidor real sí conecta: lo que falla es solo la redirección.
    const direct = (await put(`/api/mcp/servers/${server.id}`, { name: 'remoto', transport: 'http', url: realUrl, headers: {} })).json() as McpServer;
    expect(direct.status).toBe('connected');
  });
});

describe('código A1 · GET /api/onboarding', () => {
  it('dice si existe alguna ejecución de agente y alguna de workflow completada, sin contar el historial', async () => {
    const { ctx } = await boot(new ScriptedLlm((req) => (userText(req).includes('falla') ? Promise.reject(new Error('sin modelo')) : { content: 'hecho' })));
    expect((await get('/api/onboarding')).json()).toEqual({ agentRun: false, workflowCompleted: false });

    const agent = addAgent(ctx);
    const wf = ctx.store.createWorkflow(
      workflow([node('entrada', 'input'), node('a', 'agent', { agentId: agent.id, prompt: '{{input}}' })], edges('entrada>a')),
    );
    // Un workflow que falla no completa el paso de la guía.
    expect((await finished(ctx.runs.startWorkflowRun(wf, 'falla').id)).status).toBe('failed');
    expect((await get('/api/onboarding')).json()).toEqual({ agentRun: false, workflowCompleted: false });

    await finished(ctx.runs.startAgentRun(agent, 'falla').id);
    expect((await get('/api/onboarding')).json()).toEqual({ agentRun: true, workflowCompleted: false });

    expect((await finished(ctx.runs.startWorkflowRun(wf, 'bien').id)).status).toBe('completed');
    const res = await get('/api/onboarding');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ agentRun: true, workflowCompleted: true });
  });
});

describe('código M1 · las subejecuciones no ocupan huecos de ejecución', () => {
  it('una aprobación dentro de un subworkflow libera el hueco: con una sola ejecución simultánea, otra arranca y termina', async () => {
    const { ctx } = await boot();
    ctx.store.updateSettings({ maxConcurrentRuns: 1 });
    const agent = addAgent(ctx);
    const child = ctx.store.createWorkflow({
      ...workflow(
        [
          node('entrada', 'input'),
          node('revisar', 'approval', { message: '¿Seguimos con {{input}}?' }),
          node('fin', 'transform', { template: 'visto {{input}}' }),
        ],
        edges('entrada>revisar', 'revisar:true>fin'),
      ),
      name: 'Hijo',
    });
    const parent = ctx.store.createWorkflow({ ...workflow([node('sub', 'subworkflow', { workflowId: child.id, input: '{{input}}' })], []), name: 'Padre' });

    const root = ctx.runs.startWorkflowRun(parent, 'informe');
    const approval = await waitApproval();
    expect(approval.runId).not.toBe(root.id);
    // Padre e hija son UNA ejecución a efectos de huecos (y del Panel, la sonda y las métricas).
    expect(ctx.runs.activeCount).toBe(1);
    expect(ctx.runs.isActive(approval.runId)).toBe(true);

    const other = ctx.runs.startAgentRun(agent, 'otra tarea');
    const outcome = await Promise.race([finished(other.id).then((r) => r.status), delay(3000).then(() => 'sigue en cola')]);
    expect(outcome).toBe('completed');
    expect(ctx.store.getRunSummary(approval.runId)!.status).toBe('waiting');

    ctx.runs.decideApproval(approval.id, true);
    expect(await finished(root.id)).toMatchObject({ status: 'completed', output: 'visto informe' });
    expect(ctx.runs.activeCount).toBe(0);
  });

  it('cancelar la ejecución raíz cancela también la subejecución en marcha', async () => {
    const { ctx } = await boot();
    const child = ctx.store.createWorkflow({
      ...workflow([node('entrada', 'input'), node('revisar', 'approval', { message: '¿Seguimos?' })], edges('entrada>revisar')),
      name: 'Hijo',
    });
    const parent = ctx.store.createWorkflow({ ...workflow([node('sub', 'subworkflow', { workflowId: child.id, input: '{{input}}' })], []), name: 'Padre' });
    const root = ctx.runs.startWorkflowRun(parent, 'x');
    const approval = await waitApproval();
    expect(ctx.runs.cancel(root.id)).toBe(true);
    expect((await finished(root.id)).status).toBe('cancelled');
    expect(ctx.store.getRunSummary(approval.runId)!.status).toBe('cancelled');
    expect(ctx.runs.isActive(approval.runId)).toBe(false);
  });
});

describe('código M3 · el comentario de una aprobación ya decidida sobrevive al reintento', () => {
  it('«reintentar desde el fallo» (también encadenado) entrega {{nodo.comment}} al paso que se repite', async () => {
    let failures = 2;
    const llm = new ScriptedLlm((req) => (failures-- > 0 ? Promise.reject(new Error('el modelo no responde')) : { content: `eco(${userText(req)})` }));
    const { ctx } = await boot(llm);
    const agent = addAgent(ctx);
    const wf = ctx.store.createWorkflow(
      workflow(
        [
          node('entrada', 'input'),
          node('revisar', 'approval', { message: '¿Redactamos {{input}}?' }),
          node('redactor', 'agent', { agentId: agent.id, prompt: 'redacta {{input}} con: {{revisar.comment}}' }),
        ],
        edges('entrada>revisar', 'revisar:true>redactor'),
      ),
    );
    const first = ctx.runs.startWorkflowRun(wf, 'la nota');
    ctx.runs.decideApproval((await waitApproval()).id, true, 'tono cercano');
    expect((await finished(first.id)).status).toBe('failed');
    expect(userText(llm.calls[0])).toBe('redacta la nota con: tono cercano');

    // Reintento desde el fallo: la aprobación no se vuelve a pedir y su comentario sigue ahí.
    const second = await finished(ctx.runs.retryRun(ctx.store.getRun(first.id)!, 'failed').id);
    expect(second.status).toBe('failed');
    expect(userText(llm.calls[1])).toBe('redacta la nota con: tono cercano');
    // Reintento del reintento: el paso ya venía reutilizado y la decisión está en la primera ejecución.
    const third = await finished(ctx.runs.retryRun(second, 'failed').id);
    expect(third).toMatchObject({ status: 'completed', output: 'eco(redacta la nota con: tono cercano)' });
    expect(ctx.store.listApprovals({})).toHaveLength(1);
  });
});

describe('código M10 · profundidad máxima de subworkflows', () => {
  /** Cadena de `levels` workflows: cada uno lanza al siguiente y el último devuelve su entrada. */
  function chain(c: AppContext, levels: number) {
    let current = c.store.createWorkflow({ ...workflow([node('t', 'transform', { template: 'fondo({{input}})' })], []), name: `Nivel ${levels}` });
    for (let level = levels - 1; level >= 1; level--) {
      current = c.store.createWorkflow({ ...workflow([node('s', 'subworkflow', { workflowId: current.id, input: '{{input}}' })], []), name: `Nivel ${level}` });
    }
    return current;
  }

  it('cinco niveles se ejecutan enteros; el sexto falla diciendo que se ha superado el límite', async () => {
    const { ctx } = await boot();
    const allowed = await finished(ctx.runs.startWorkflowRun(chain(ctx, 5), 'x').id);
    expect(allowed).toMatchObject({ status: 'completed', output: 'fondo(x)' });
    expect(ctx.store.listRuns({ limit: 50 }).total).toBe(5);

    const tooDeep = await finished(ctx.runs.startWorkflowRun(chain(ctx, 6), 'y').id);
    expect(tooDeep.status).toBe('failed');
    const errors = ctx.store
      .listRuns({ limit: 50 })
      .items.flatMap((r) => ctx.store.getRun(r.id)!.steps.map((s) => s.error ?? ''))
      .join('\n');
    expect(errors).toMatch(/Se han anidado más de 5 niveles de workflows/);
    expect(errors).not.toMatch(/ya no existe/);
    // El sexto nivel no llega a crearse: cinco ejecuciones más, no seis.
    expect(ctx.store.listRuns({ limit: 50 }).total).toBe(10);
    expect(ctx.runs.activeCount).toBe(0);
  });
});

// ---------- Copias de seguridad fabricadas (en el directorio temporal del sistema) ----------
function tarEntry(name: string, data: Buffer): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write('0000644\0', 100, 8, 'ascii');
  header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  header.write('00000000000\0', 136, 12, 'ascii');
  header.write('        ', 148, 8, 'ascii');
  header.write('0', 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return Buffer.concat([header, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}

/** Bytes de una base de datos SQLite válida y vacía. */
function sqliteBytes(dir: string): Buffer {
  const file = path.join(dir, 'semilla.db');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE t (x TEXT)');
  db.close();
  const bytes = fs.readFileSync(file);
  fs.rmSync(file);
  return bytes;
}

/** Deja en `<dataDir>/backups` una copia con las entradas indicadas (tras el manifiesto y la base de datos). */
function craftBackup(extra: Array<[string, Buffer | string]>, mangle: (gz: Buffer) => Buffer = (gz) => gz): { paths: BackupPaths; name: string } {
  const dataDir = tempDir();
  dirs.push(dataDir);
  const paths: BackupPaths = { dataDir, dbFile: path.join(dataDir, 'agentforge.db'), workspaceDir: path.join(dataDir, 'workspace') };
  const manifest = {
    format: 'agentforge.backup',
    version: 1,
    createdAt: new Date().toISOString(),
    appVersion: 'test',
    schemaVersion: 1,
    counts: { agents: 0, workflows: 0, runs: 0, workspaceFiles: extra.length },
  };
  const entries: Array<[string, Buffer | string]> = [['manifest.json', JSON.stringify(manifest)], ['agentforge.db', sqliteBytes(dataDir)], ...extra];
  const tar = Buffer.concat([...entries.map(([name, data]) => tarEntry(name, Buffer.from(data))), Buffer.alloc(1024)]);
  const name = 'agentforge-20260101-120000.afbackup';
  fs.mkdirSync(path.join(dataDir, 'backups'));
  fs.writeFileSync(path.join(dataDir, 'backups', name), mangle(zlib.gzipSync(tar)));
  return { paths, name };
}

const pendingDir = (paths: BackupPaths) => path.join(paths.dataDir, 'restore-pending');

describe('código M2 · restaurar una copia dañada u hostil', () => {
  it('un archivo que choca con una carpeta ya creada hace fallar la preparación en lugar de perderse en silencio', async () => {
    const { paths, name } = craftBackup([
      ['workspace/a/b', 'dentro de la carpeta'],
      ['workspace/a', 'archivo con el nombre de la carpeta'],
    ]);
    await expect(prepareRestore(paths, name)).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/No se pudo leer la copia de seguridad/) });
    expect(pendingRestore(paths)).toBeNull();
    expect(fs.existsSync(pendingDir(paths))).toBe(false);
  });

  it('si el destino falla con la escritura detenida, la preparación termina con error en vez de quedarse colgada', async () => {
    // Un archivo mayor que el búfer de escritura: el lector espera a que el destino se vacíe, y el destino ya ha fallado.
    const { paths, name } = craftBackup([
      ['workspace/a/b', 'dentro de la carpeta'],
      ['workspace/a', Buffer.alloc(2 * 1024 * 1024, 7)],
      ['workspace/despues.txt', 'no se llega a escribir'],
    ]);
    const outcome = await Promise.race([
      prepareRestore(paths, name).then(
        () => 'preparada',
        (err: { status?: number }) => `error ${err.status}`,
      ),
      delay(8000).then(() => 'colgada'),
    ]);
    expect(outcome).toBe('error 400');
    expect(fs.existsSync(pendingDir(paths))).toBe(false);
  });

  it('una entrada que intenta salir de la carpeta se ignora y el resto se restaura', async () => {
    const { paths, name } = craftBackup([
      ['workspace/../fuera.txt', 'no'],
      ['../fuera.txt', 'no'],
      ['workspace/sub/../../../fuera.txt', 'no'],
      ['otra/cosa.txt', 'no'],
      ['workspace/informes/q3.md', '# Informe'],
    ]);
    await expect(prepareRestore(paths, name)).resolves.toMatchObject({ name });
    const dir = pendingDir(paths);
    expect(fs.readFileSync(path.join(dir, 'workspace', 'informes', 'q3.md'), 'utf8')).toBe('# Informe');
    expect(fs.readdirSync(dir).sort()).toEqual(['READY.json', 'agentforge.db', 'manifest.json', 'workspace']);
    expect(fs.readdirSync(path.join(dir, 'workspace'))).toEqual(['informes']);
    expect(fs.readdirSync(paths.dataDir).sort()).toEqual(['backups', 'restore-pending']);
    expect(fs.existsSync(path.join(path.dirname(paths.dataDir), 'fuera.txt'))).toBe(false);
  });

  it('una copia truncada se rechaza y no deja nada preparado', async () => {
    // Contenido que no se comprime: el corte cae en mitad de los datos, después del manifiesto.
    const noise = Buffer.from(Array.from({ length: 200_000 }, (_, i) => (i * 7919 + (i >> 3) * 104729) % 251));
    const { paths, name } = craftBackup([['workspace/datos.bin', noise]], (gz) => gz.subarray(0, Math.floor(gz.length * 0.6)));
    await expect(prepareRestore(paths, name)).rejects.toMatchObject({ status: 400 });
    expect(pendingRestore(paths)).toBeNull();
    expect(fs.existsSync(pendingDir(paths))).toBe(false);
  });
});
