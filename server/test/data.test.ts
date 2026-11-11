// Datos y rendimiento: estadísticas incrementales, listados ligeros, búsqueda de texto completo, eventos sin
// duplicados, retención por lotes con compactación, memoria compartida persistida, agrupación de fragmentos,
// reproducción del historial por SSE, HTML a texto en tiempo lineal y copias de seguridad.
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import zlib from 'node:zlib';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { BackupState, Run, RunEvent, RunSummary } from '../../shared/types';
import { buildApp } from '../src/app';
import type { AppContext } from '../src/context';
import { LlmError } from '../src/errors';
import { htmlTitle, htmlToText } from '../src/tools/net';
import { localDate } from '../src/util';
import { addAgent, delay, edges, makeContext, node, runWorkflow, ScriptedLlm, tempDir, userText, workflow } from './helpers';

let ctx: AppContext | undefined;
let app: FastifyInstance | undefined;
const dirs: string[] = [];

afterEach(async () => {
  await app?.close();
  await ctx?.close();
  app = undefined;
  ctx = undefined;
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function boot(llm = new ScriptedLlm((req) => ({ content: `eco(${userText(req)})` })), opts: { onDisk?: boolean; dataDir?: string } = {}) {
  const dataDir = opts.dataDir ?? tempDir();
  if (!dirs.includes(dataDir)) dirs.push(dataDir);
  ctx = makeContext(llm, { dataDir, inMemory: !(opts.onDisk || opts.dataDir) });
  app = await buildApp(ctx);
  return { ctx, app, dataDir, llm };
}

const get = (url: string) => app!.inject({ method: 'GET', url });

/** Crea una ejecución ya terminada directamente en el almacén (sin motor), para preparar historiales grandes. */
function finishedRun(c: AppContext, name: string, opts: { input?: string; output?: string; status?: 'completed' | 'failed' | 'cancelled'; finishedAt?: string } = {}): string {
  const run = c.store.createRun({ kind: 'agent', workflowId: null, agentId: null, name, input: opts.input ?? '', snapshot: { workflow: { nodes: [], edges: [], settings: {} as never }, agents: {} }, steps: [] });
  c.store.updateRun(run.id, { status: 'running', startedAt: run.createdAt });
  c.store.finishRun(run.id, { status: opts.status ?? 'completed', output: opts.output ?? 'ok', finishedAt: opts.finishedAt, usage: { promptTokens: 10, completionTokens: 5, llmCalls: 1, toolCalls: 0 } });
  return run.id;
}

/** Inserta una ejecución terminada con una sola sentencia (para preparar miles dentro de una transacción). */
function finishedRunFast(c: AppContext, name: string, input: string): void {
  const now = new Date().toISOString();
  c.db
    .prepare("INSERT INTO runs (id, kind, name, status, input, output, snapshot, usage, created_at, started_at, finished_at, ended_at) VALUES (?, 'agent', ?, 'completed', ?, 'ok', '{}', '{}', ?, ?, ?, ?)")
    .run(`run_${name.replace(/\W/g, '')}`, name, input, now, now, now, now);
}

describe('paginación', () => {
  it('las páginas son estables y completas: recorrerlas devuelve cada ejecución una sola vez, en orden', async () => {
    const { ctx } = await boot();
    ctx.db.exec('BEGIN');
    for (let i = 0; i < 95; i++) finishedRunFast(ctx, `p ${String(i).padStart(3, '0')}`, 'x');
    ctx.db.exec('COMMIT');
    const seen: string[] = [];
    for (let offset = 0; ; offset += 20) {
      const page = (await get(`/api/runs?limit=20&offset=${offset}`)).json();
      expect(page.total).toBe(95);
      seen.push(...page.items.map((r: RunSummary) => r.id));
      if (page.items.length < 20) break;
    }
    expect(new Set(seen).size).toBe(95);
    // Todas se crearon en el mismo instante: el desempate por identificador mantiene el orden estable.
    expect(seen).toEqual([...seen].sort().reverse());
    const filtered = (await get('/api/runs?status=completed&kind=agent&limit=200')).json();
    expect(filtered.items).toHaveLength(95);
    expect((await get('/api/runs?status=failed')).json()).toEqual({ items: [], total: 0 });
  });
});

describe('estadísticas del panel', () => {
  it('se actualizan al terminar cada ejecución, paso y llamada a herramienta, y son acumuladas', async () => {
    const llm = new ScriptedLlm((req, i) => {
      const text = userText(req);
      if (text === 'falla') throw new LlmError('caído', { retryable: false });
      if (text === 'calcula' && !req.messages.some((m) => m.role === 'tool')) return { toolCalls: [{ id: `c${i}`, name: 'calculator', arguments: { expression: '2+2' } }] };
      return { content: `eco(${text})` };
    });
    const { ctx } = await boot(llm);
    const agent = addAgent(ctx, { name: 'Contable', tools: ['calculator'] });
    const wf = workflow([node('entrada', 'input'), node('a', 'agent', { agentId: agent.id, prompt: '{{input}}' })], edges('entrada>a'));
    expect((await get('/api/stats')).json()).toMatchObject({ llmCalls: 0, toolCalls: 0, successRate: null, avgDurationMs: null, topAgents: [], topTools: [] });

    const ok = await runWorkflow(ctx, wf, 'hola');
    await runWorkflow(ctx, wf, 'calcula');
    await runWorkflow(ctx, wf, 'falla');
    let stats = (await get('/api/stats')).json();
    expect(stats.runsByStatus).toMatchObject({ completed: 2, failed: 1 });
    expect(stats.successRate).toBeCloseTo(2 / 3);
    // 1 llamada + 2 llamadas (con herramienta) + 1 fallida que no llegó a contar tokens.
    expect(stats.llmCalls).toBe(3);
    expect(stats.toolCalls).toBe(1);
    expect(stats.tokens).toEqual({ prompt: 30, completion: 15 });
    expect(stats.avgDurationMs).toBeGreaterThanOrEqual(0);
    expect(stats.topAgents).toEqual([{ agentId: agent.id, name: 'Contable', steps: 3, completionTokens: 15 }]);
    expect(stats.topTools).toEqual([{ name: 'calculator', calls: 1 }]);
    // La serie diaria usa la fecha LOCAL: las tres ejecuciones caen en el día de hoy.
    const today = stats.daily.find((d: { date: string }) => d.date === localDate());
    expect(today).toEqual({ date: localDate(), completed: 2, failed: 1, cancelled: 0 });
    expect(stats.daily).toHaveLength(14);

    // Al borrar ejecuciones bajan los recuentos del historial, pero no lo acumulado.
    ctx.store.deleteRun(ok.id);
    stats = (await get('/api/stats')).json();
    expect(stats.counts.runs).toBe(2);
    expect(stats.runsByStatus.completed).toBe(1);
    expect(stats.llmCalls).toBe(3);
    expect(stats.tokens).toEqual({ prompt: 30, completion: 15 });
    expect(stats.topAgents[0].steps).toBe(3);
  });

  it('una ejecución no se cuenta dos veces aunque se cierre dos veces, y el agente borrado aparece como eliminado', async () => {
    const { ctx } = await boot();
    const id = finishedRun(ctx, 'una');
    ctx.store.finishRun(id, { status: 'failed', error: 'otra vez' });
    const stats = ctx.store.stats();
    expect(stats.llmCalls).toBe(1);
    expect(stats.daily.at(-1)).toMatchObject({ completed: 1, failed: 0 });

    const agent = addAgent(ctx, { name: 'Temporal' });
    await runWorkflow(ctx, workflow([node('a', 'agent', { agentId: agent.id, prompt: 'x' })], []));
    ctx.store.deleteAgent(agent.id);
    expect(ctx.store.stats().topAgents).toEqual([{ agentId: agent.id, name: '(eliminado)', steps: 1, completionTokens: 5 }]);
  });

  it('agrupa por el día local en que se creó la ejecución, no por el día UTC', async () => {
    const { ctx } = await boot();
    // Una ejecución creada a las 00:30 de hoy, hora local (en UTC puede ser todavía ayer).
    const midnight = new Date();
    midnight.setHours(0, 30, 0, 0);
    const id = finishedRun(ctx, 'madrugada');
    // Se recoloca y se recalcula el agregado como lo haría la migración (a partir de los datos).
    ctx.db.prepare('UPDATE runs SET created_at = ? WHERE id = ?').run(midnight.toISOString(), id);
    ctx.db.exec("DELETE FROM stats_daily; INSERT INTO stats_daily (date, status, runs) SELECT date(created_at, 'localtime'), status, COUNT(*) FROM runs GROUP BY 1, 2;");
    const stats = ctx.store.stats(14, midnight.getTime() + 3_600_000);
    expect(stats.daily.at(-1)).toMatchObject({ date: localDate(midnight), completed: 1 });
  });
});

describe('listados ligeros', () => {
  it('los resúmenes llevan solo el principio de la entrada y del resultado; el detalle los lleva completos', async () => {
    const long = 'x'.repeat(40_000);
    const { ctx } = await boot(new ScriptedLlm(() => ({ content: `inicio ${'y'.repeat(60_000)}` })));
    const agent = addAgent(ctx);
    const run = ctx.runs.startAgentRun(agent, `principio ${long}`);
    const published: RunSummary[] = [];
    const off = ctx.runs.subscribeRuns((r) => published.push(r));
    await ctx.runs.waitFor(run.id);
    off();

    const list = await get('/api/runs?limit=30');
    const [item] = list.json().items as RunSummary[];
    expect(item.input).toHaveLength(300);
    expect(item.input.startsWith('principio xxx')).toBe(true);
    expect(item.output).toHaveLength(300);
    expect(list.body.length).toBeLessThan(2000);
    // Tampoco viajan por el canal en vivo ni en el panel.
    expect(published.every((r) => r.input.length <= 300 && (r.output?.length ?? 0) <= 300)).toBe(true);
    expect(JSON.stringify((await get('/api/stats')).json().recentRuns).length).toBeLessThan(2000);

    const detail = (await get(`/api/runs/${run.id}`)).json() as Run;
    expect(detail.input).toHaveLength(40_010);
    expect(detail.output).toHaveLength(60_007);
    expect(detail.steps[0].output).toHaveLength(60_007);
  });
});

describe('búsqueda en el historial', () => {
  it('encuentra subcadenas en el nombre, la entrada, el resultado y el error, sin distinguir mayúsculas ni tildes', async () => {
    const { ctx } = await boot();
    finishedRun(ctx, 'Informe trimestral', { input: 'Resumen de ventas de Córdoba', output: 'Las ventas crecieron un 12 % en el tercer trimestre.' });
    finishedRun(ctx, 'Soporte', { input: 'Clasifica la incidencia', output: 'Prioridad alta: fallo de facturación' });
    const failed = finishedRun(ctx, 'Importación', { input: 'Carga el archivo', status: 'failed' });
    ctx.store.finishRun(failed, { status: 'failed', error: 'El proveedor devolvió 503 Service Unavailable' });
    const found = async (q: string) => ((await get(`/api/runs?search=${encodeURIComponent(q)}`)).json().items as RunSummary[]).map((r) => r.name).sort();

    expect(await found('trimestral')).toEqual(['Informe trimestral']); // nombre
    expect(await found('cordoba')).toEqual(['Informe trimestral']); // entrada, sin tilde
    expect(await found('CÓRDOBA')).toEqual(['Informe trimestral']);
    expect(await found('facturación')).toEqual(['Soporte']); // resultado
    expect(await found('rimest')).toEqual(['Informe trimestral']); // subcadena en mitad de palabra
    expect(await found('503 Service')).toEqual(['Importación']); // error
    expect(await found('no aparece en ninguna')).toEqual([]);
    // Con menos de tres caracteres se busca solo en el nombre.
    expect(await found('So')).toEqual(['Soporte']);
    // Los caracteres especiales de la búsqueda son texto, no sintaxis.
    expect(await found('12 %')).toEqual(['Informe trimestral']);
    expect(await found('"ventas" OR x')).toEqual([]);
    expect(await found('%')).toEqual([]);
    expect((await get('/api/runs?search=ventas&status=failed')).json().total).toBe(0);
    expect((await get('/api/runs?search=ventas&status=completed')).json().total).toBe(1);
  });

  it('con muchísimas coincidencias devuelve las más recientes y avisa de que hay más', async () => {
    const { ctx } = await boot();
    ctx.db.exec('BEGIN');
    for (let i = 0; i < 2100; i++) finishedRunFast(ctx, `lote ${String(i).padStart(4, '0')}`, 'pedido urgente');
    ctx.db.exec('COMMIT');
    const res = (await get('/api/runs?search=urgente&limit=5')).json();
    expect(res).toMatchObject({ total: 2000, capped: true });
    expect(res.items.map((r: RunSummary) => r.name)).toEqual(['lote 2099', 'lote 2098', 'lote 2097', 'lote 2096', 'lote 2095']);
    // La paginación dentro de la ventana es coherente.
    const page2 = (await get('/api/runs?search=urgente&limit=5&offset=5')).json();
    expect(page2.items.map((r: RunSummary) => r.name)).toEqual(['lote 2094', 'lote 2093', 'lote 2092', 'lote 2091', 'lote 2090']);
    // Una búsqueda con pocas coincidencias no lleva el aviso.
    expect((await get('/api/runs?search=lote 0007')).json()).toEqual({ items: [expect.objectContaining({ name: 'lote 0007' })], total: 1 });
  });

  it('el índice sigue a los cambios: una ejecución borrada deja de encontrarse y una nueva se encuentra al terminar', async () => {
    const { ctx } = await boot();
    const agent = addAgent(ctx);
    const run = ctx.runs.startAgentRun(agent, 'busca el albarán perdido');
    await ctx.runs.waitFor(run.id);
    expect((await get('/api/runs?search=albaran')).json().total).toBe(1);
    expect((await get('/api/runs?search=eco(busca')).json().total).toBe(1); // el resultado, indexado al terminar
    ctx.store.deleteRun(run.id);
    expect((await get('/api/runs?search=albaran')).json().total).toBe(0);
    expect(Number((ctx.db.prepare('SELECT COUNT(*) AS n FROM runs_fts').get() as { n: number }).n)).toBe(0);
  });
});

describe('eventos sin duplicar la salida', () => {
  it('el evento en directo lleva la salida; el guardado no, porque ya está en el paso y en la ejecución', async () => {
    const { ctx } = await boot(new ScriptedLlm(() => ({ content: 'RESULTADO-ÚNICO' })));
    const agent = addAgent(ctx);
    const run = ctx.runs.startAgentRun(agent, 'x');
    const live: RunEvent[] = [];
    const off = ctx.runs.subscribe(run.id, (ev) => live.push(ev));
    await ctx.runs.waitFor(run.id);
    off();

    expect(live.find((e) => e.type === 'step.finished')!.data.output).toBe('RESULTADO-ÚNICO');
    expect(live.find((e) => e.type === 'run.finished')!.data.output).toBe('RESULTADO-ÚNICO');
    const stored = ctx.store.listEvents(run.id);
    expect(stored.find((e) => e.type === 'step.finished')!.data).toMatchObject({ status: 'completed' });
    expect('output' in stored.find((e) => e.type === 'step.finished')!.data).toBe(false);
    expect('output' in stored.find((e) => e.type === 'run.finished')!.data).toBe(false);
    // La salida se guarda una vez por sitio: en el paso, en la ejecución y en el mensaje del modelo (la actividad).
    const dump = JSON.stringify(ctx.db.prepare('SELECT data FROM run_events WHERE run_id = ?').all(run.id));
    expect(dump.split('RESULTADO-ÚNICO')).toHaveLength(2);
    expect(ctx.store.getRun(run.id)).toMatchObject({ output: 'RESULTADO-ÚNICO', steps: [{ output: 'RESULTADO-ÚNICO' }] });
  });
});

describe('retención por lotes', () => {
  it('borra un historial grande por tandas sin bloquear, deja exactamente las más recientes y el archivo encoge', async () => {
    const { ctx } = await boot(undefined, { onDisk: true });
    const big = 'z'.repeat(20_000);
    const base = Date.now() - 1_000_000;
    for (let i = 0; i < 620; i++) finishedRun(ctx, `run-${String(i).padStart(3, '0')}`, { output: big, finishedAt: new Date(base + i * 1000).toISOString() });
    ctx.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const sizeBefore = fs.statSync(ctx.config.dbFile).size;
    expect(sizeBefore).toBeGreaterThan(10_000_000);

    ctx.store.updateSettings({ retentionMaxRuns: 20 });
    // La primera tanda es inmediata y acotada: el servidor no se queda parado borrando todo de golpe.
    const started = Date.now();
    expect(ctx.applyRetention()).toBe(100);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(ctx.store.listRuns().total).toBe(520);

    // El resto se borra solo, en segundo plano.
    for (let i = 0; i < 200 && ctx.store.listRuns().total > 20; i++) await delay(25);
    const left = ctx.store.listRuns({ limit: 200 });
    expect(left.total).toBe(20);
    expect(left.items.map((r) => r.name).sort()).toEqual(Array.from({ length: 20 }, (_, i) => `run-${600 + i}`));

    // Y el espacio vuelve al sistema de archivos sin reescribir la base entera.
    const freePages = () => Number((ctx.db.prepare('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count);
    for (let i = 0; i < 200 && freePages() > 0; i++) await delay(25);
    expect(freePages()).toBe(0);
    expect(fs.statSync(ctx.config.dbFile).size).toBeLessThan(sizeBefore / 5);
  });

  it('la retención por antigüedad y por número respeta las que están en curso y las pendientes de reanudar', async () => {
    const { ctx } = await boot();
    const old = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
    finishedRun(ctx, 'vieja', { finishedAt: old(40) });
    finishedRun(ctx, 'reciente', { finishedAt: old(1) });
    const live = ctx.store.createRun({ kind: 'agent', workflowId: null, agentId: null, name: 'en curso', input: '', snapshot: { workflow: { nodes: [], edges: [], settings: {} as never }, agents: {} }, steps: [] });
    ctx.db.prepare('UPDATE runs SET created_at = ? WHERE id = ?').run(old(90), live.id);
    const interrupted = finishedRun(ctx, 'interrumpida', { finishedAt: old(90), status: 'failed' });
    ctx.db.prepare('UPDATE runs SET interrupted = 1 WHERE id = ?').run(interrupted);

    expect(ctx.store.pruneRuns({ days: 30, maxRuns: 0 })).toBe(1);
    expect(ctx.store.listRuns().items.map((r) => r.name).sort()).toEqual(['en curso', 'interrumpida', 'reciente']);
    expect(ctx.store.pruneRuns({ days: 0, maxRuns: 1 })).toBe(0);
    finishedRun(ctx, 'nueva');
    expect(ctx.store.pruneRuns({ days: 0, maxRuns: 1 })).toBe(1);
    expect(ctx.store.listRuns().items.map((r) => r.name).sort()).toEqual(['en curso', 'interrumpida', 'nueva']);
  });
});

describe('memoria compartida persistida', () => {
  it('reintentar desde el fallo conserva lo que los pasos reutilizados guardaron en la memoria', async () => {
    let failing = true;
    const llm = new ScriptedLlm((req) => {
      const text = userText(req);
      const afterTool = req.messages.filter((m) => m.role === 'tool');
      if (text.startsWith('anota')) return afterTool.length ? { content: 'anotado' } : { toolCalls: [{ id: 'm1', name: 'memory_set', arguments: { key: 'cliente', value: 'ACME S.L.' } }] };
      if (failing) throw new LlmError('caído', { retryable: false });
      return afterTool.length ? { content: `leído: ${afterTool[0].content}` } : { toolCalls: [{ id: 'm2', name: 'memory_get', arguments: { key: 'cliente' } }] };
    });
    const { ctx } = await boot(llm, { onDisk: true });
    const writer = addAgent(ctx, { name: 'Escribe', tools: ['memory_set'] });
    const reader = addAgent(ctx, { name: 'Lee', tools: ['memory_get'] });
    const first = await runWorkflow(
      ctx,
      workflow([node('a', 'agent', { agentId: writer.id, prompt: 'anota el cliente' }), node('b', 'agent', { agentId: reader.id, prompt: 'lee {{a}}' })], edges('a>b')),
    );
    expect(first.status).toBe('failed');
    expect(ctx.store.listMemory(first.id)).toEqual([['cliente', 'ACME S.L.']]);

    failing = false;
    const retry = ctx.runs.retryRun(ctx.store.getRun(first.id)!, 'failed');
    await ctx.runs.waitFor(retry.id);
    const done = ctx.store.getRun(retry.id)!;
    expect(done.status).toBe('completed');
    // El paso «a» no se repitió, y aun así «b» encontró lo que «a» había guardado.
    expect(done.output).toContain('"found": true');
    expect(done.output).toContain('ACME S.L.');
    // Repetir TODO desde cero empieza con la memoria vacía.
    const fresh = ctx.runs.retryRun(ctx.store.getRun(first.id)!, 'all');
    expect(ctx.store.listMemory(fresh.id)).toEqual([]);
    await ctx.runs.waitFor(fresh.id);
    // La memoria se borra con la ejecución.
    ctx.store.deleteRun(first.id);
    expect(ctx.store.listMemory(first.id)).toEqual([]);
  });
});

describe('fragmentos de texto agrupados', () => {
  it('muchos fragmentos seguidos llegan en pocos eventos, completos y antes del mensaje que los cierra', async () => {
    const words = Array.from({ length: 300 }, (_, i) => `p${i} `);
    const llm = new ScriptedLlm(async (req) => {
      for (const [i, w] of words.entries()) {
        req.onDelta?.(w);
        if (i % 60 === 59) await delay(45); // el modelo hace pausas: cada tramo se emite por separado
      }
      return { content: '' };
    });
    // El doble emite `content` como un último fragmento; aquí se manda todo por onDelta y se devuelve vacío,
    // así que el agente fallaría por respuesta vacía: se usa un workflow que tolera el fallo para leer los eventos.
    const { ctx } = await boot(llm);
    const agent = addAgent(ctx);
    const run = ctx.runs.startAgentRun(agent, 'x', { defaultRetries: 0 });
    const events: RunEvent[] = [];
    const off = ctx.runs.subscribe(run.id, (ev) => events.push(ev));
    await ctx.runs.waitFor(run.id);
    off();

    const deltas = events.filter((e) => e.type === 'llm.delta');
    expect(deltas.map((e) => e.data.text).join('')).toBe(words.join(''));
    // 300 fragmentos en cinco ráfagas: llegan agrupados (del orden de una decena de eventos, no 300).
    expect(deltas.length).toBeLessThan(40);
    expect(deltas.length).toBeGreaterThanOrEqual(5);
    // El orden se conserva: todo el texto llega antes que el mensaje del modelo.
    const lastDelta = events.lastIndexOf(deltas.at(-1)!);
    expect(events.findIndex((e) => e.type === 'llm.message')).toBeGreaterThan(lastDelta);
    // Quien se conecta a mitad recibe el texto acumulado aunque aún no se haya emitido.
    expect(deltas.every((e) => e.seq === null && e.data.agentId === agent.id)).toBe(true);
  });
});

describe('reproducción del historial por SSE', () => {
  /** Lee un flujo SSE real hasta recibir el evento con el número de secuencia indicado. */
  function readStream(url: string, untilSeq: number, headers: Record<string, string> = {}): Promise<RunEvent[]> {
    return new Promise((resolve, reject) => {
      const events: RunEvent[] = [];
      const req = http.get(url, { headers }, (res) => {
        let buffer = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          buffer += chunk;
          let idx: number;
          while ((idx = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const data = /^data: (.*)$/m.exec(block)?.[1];
            if (!data || !block.includes('event: run-event')) continue;
            const ev = JSON.parse(data) as RunEvent;
            events.push(ev);
            if (ev.seq === untilSeq) {
              req.destroy();
              resolve(events);
            }
          }
        });
      });
      req.on('error', (err) => (events.length ? undefined : reject(err)));
      setTimeout(() => reject(new Error(`solo llegaron ${events.length} eventos`)), 15_000).unref();
    });
  }

  it('una ejecución con miles de eventos se entrega completa, en orden y sin duplicados, también al reconectar', async () => {
    const { ctx, app } = await boot();
    const id = finishedRun(ctx, 'larga');
    const total = 2300; // varias tandas de reproducción
    for (let i = 0; i < total; i++) ctx.store.appendEvent(id, 'llm.message', 'a', { content: `mensaje ${i}` });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

    const all = await readStream(`${base}/api/runs/${id}/stream`, total);
    expect(all.map((e) => e.seq)).toEqual(Array.from({ length: total }, (_, i) => i + 1));
    expect(all.at(-1)!.data.content).toBe(`mensaje ${total - 1}`);

    const resumed = await readStream(`${base}/api/runs/${id}/stream`, total, { 'Last-Event-ID': '2000' });
    expect(resumed).toHaveLength(300);
    expect(resumed[0].seq).toBe(2001);
    const paged = await readStream(`${base}/api/runs/${id}/stream?after=2295`, total);
    expect(paged.map((e) => e.seq)).toEqual([2296, 2297, 2298, 2299, 2300]);
  });

  it('lo que ocurre mientras se reproduce el historial no se pierde ni se repite', async () => {
    const llm = new ScriptedLlm(async (req) => {
      await delay(120);
      return { content: `eco(${userText(req)})` };
    });
    const { ctx, app } = await boot(llm);
    const agent = addAgent(ctx);
    const steps = Array.from({ length: 6 }, (_, i) => node(`n${i}`, 'agent', { agentId: agent.id, prompt: `paso ${i}` }));
    const wf = ctx.store.createWorkflow(workflow(steps, edges('n0>n1', 'n1>n2', 'n2>n3', 'n3>n4', 'n4>n5')));
    await app.listen({ port: 0, host: '127.0.0.1' });
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const run = ctx.runs.startWorkflowRun(wf, '');
    await delay(200); // ya hay historial y la ejecución sigue produciendo eventos
    const collected: RunEvent[] = [];
    await new Promise<void>((resolve, reject) => {
      const req = http.get(`${base}/api/runs/${run.id}/stream`, (res) => {
        let buffer = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          buffer += chunk;
          let idx: number;
          while ((idx = buffer.indexOf('\n\n')) >= 0) {
            const data = /^data: (.*)$/m.exec(buffer.slice(0, idx))?.[1];
            buffer = buffer.slice(idx + 2);
            if (!data) continue;
            const ev = JSON.parse(data) as RunEvent;
            collected.push(ev);
            if (ev.type === 'run.finished') {
              req.destroy();
              resolve();
            }
          }
        });
      });
      req.on('error', () => undefined);
      setTimeout(() => reject(new Error('la ejecución no terminó')), 15_000).unref();
    });
    const persisted = collected.filter((e) => e.seq !== null).map((e) => e.seq);
    expect(persisted).toEqual(ctx.store.listEvents(run.id).map((e) => e.seq));
  });
});

describe('HTML a texto', () => {
  it('quita scripts, estilos, cabecera y comentarios, y conserva el contenido y los saltos', () => {
    const html = `<!doctype html><html><head><title> Mi   página </title><style>p{color:red}</style></head>
      <body><!-- oculto --><h1>Título</h1><p>Uno &amp; dos&nbsp;&lt;tres&gt; &#233;</p><script>alert("x")</script>
      <svg><path d="M0 0"/></svg><ul><li>A</li><li>B</li></ul><noscript>sin js</noscript><p>Fin</p></body></html>`;
    expect(htmlToText(html)).toBe('Título\nUno & dos <tres> é\n\nA\nB\nFin');
    expect(htmlTitle(html)).toBe('Mi página');
    expect(htmlTitle('<p>sin título</p>')).toBeNull();
    expect(htmlTitle('<title>sin cerrar')).toBeNull();
    // Etiquetas que solo empiezan igual que un bloque omitido no se omiten.
    expect(htmlToText('<header>cabecera</header><styled>x</styled>')).toBe('cabecera x');
    expect(htmlToText('texto &#99999999; raro')).toBe('texto &#99999999; raro');
  });

  it('tarda un tiempo lineal con HTML hostil: miles de bloques sin cerrar no congelan el servidor', () => {
    for (const piece of ['<svg ', '<head', '<!-- ', '<script>x', '<title>', '<']) {
      const hostile = piece.repeat(Math.floor(1_400_000 / piece.length));
      const started = performance.now();
      htmlToText(hostile);
      htmlTitle(hostile);
      expect(performance.now() - started, piece).toBeLessThan(1500);
    }
    // Un documento grande normal tampoco: se convierte como mucho el principio.
    const big = `<p>${'palabra '.repeat(300_000)}</p>`;
    const started = performance.now();
    expect(htmlToText(big).length).toBeLessThanOrEqual(600_000);
    expect(performance.now() - started).toBeLessThan(1500);
  });
});

describe('copias de seguridad', () => {
  it('crear, listar, descargar, restaurar al reiniciar y conservar lo que había', async () => {
    const { ctx, app, dataDir } = await boot(undefined, { onDisk: true });
    const provider = ctx.store.createProvider({ name: 'Con clave', kind: 'openai', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'sk-en-la-copia' });
    const agent = addAgent(ctx, { name: 'Original', providerId: provider.id });
    const run = ctx.runs.startAgentRun(agent, 'antes de la copia');
    await ctx.runs.waitFor(run.id);
    fs.mkdirSync(path.join(ctx.config.workspaceDir, 'informes'), { recursive: true });
    fs.writeFileSync(path.join(ctx.config.workspaceDir, 'informes', 'q3.md'), '# Informe del tercer trimestre');

    const created = await app.inject({ method: 'POST', url: '/api/backups' });
    expect(created.statusCode).toBe(201);
    const backup = created.json();
    expect(backup.name).toMatch(/^agentforge-\d{8}-\d{6}\.afbackup$/);
    expect(backup.manifest).toMatchObject({ format: 'agentforge.backup', schemaVersion: 6, counts: { agents: 1, workflows: 0, runs: 1, workspaceFiles: 1 } });

    let state = (await get('/api/backups')).json() as BackupState;
    expect(state).toMatchObject({ backups: [{ name: backup.name, sizeBytes: backup.sizeBytes }], pending: null, lastRestore: null });
    // El archivo descargado es un gzip válido y no contiene la API key en claro.
    const download = await app.inject({ method: 'GET', url: `/api/backups/${backup.name}/download` });
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-disposition']).toBe(`attachment; filename="${backup.name}"`);
    const tar = zlib.gunzipSync(download.rawPayload);
    expect(tar.includes('manifest.json')).toBe(true);
    expect(tar.includes('workspace/informes/q3.md')).toBe(true);
    expect(tar.includes('# Informe del tercer trimestre')).toBe(true);
    expect(tar.includes('sk-en-la-copia')).toBe(false);

    // Después de la copia los datos cambian…
    ctx.store.deleteAgent(agent.id);
    addAgent(ctx, { name: 'Posterior', providerId: provider.id });
    fs.writeFileSync(path.join(ctx.config.workspaceDir, 'nuevo.txt'), 'creado después');
    fs.rmSync(path.join(ctx.config.workspaceDir, 'informes'), { recursive: true });

    // …se prepara la restauración: todavía no cambia nada.
    const prepared = await app.inject({ method: 'POST', url: `/api/backups/${backup.name}/restore` });
    expect(prepared.statusCode).toBe(202);
    expect(ctx.store.listAgents().map((a) => a.name)).toEqual(['Posterior']);
    state = (await get('/api/backups')).json();
    expect(state.pending).toMatchObject({ name: backup.name });

    // Al reiniciar se aplica.
    await app.close();
    await ctx.close();
    await boot(undefined, { dataDir });
    const restored = makeSure(globalCtx());
    expect(restored.restored).toMatchObject({ name: backup.name });
    expect(restored.store.listAgents().map((a) => a.name)).toEqual(['Original']);
    expect(restored.store.getRun(run.id)).toMatchObject({ status: 'completed', input: 'antes de la copia' });
    expect(restored.store.getProviderWithSecret(provider.id)!.apiKey).toBe('sk-en-la-copia');
    expect(fs.readFileSync(path.join(restored.config.workspaceDir, 'informes', 'q3.md'), 'utf8')).toBe('# Informe del tercer trimestre');
    expect(fs.existsSync(path.join(restored.config.workspaceDir, 'nuevo.txt'))).toBe(false);
    // Lo que había antes de restaurar se conserva aparte.
    const replaced = restored.restored!.replacedDir;
    expect(fs.existsSync(path.join(replaced, 'agentforge.db'))).toBe(true);
    expect(fs.readFileSync(path.join(replaced, 'workspace', 'nuevo.txt'), 'utf8')).toBe('creado después');
    state = (await get('/api/backups')).json();
    expect(state.pending).toBeNull();
    expect(state.lastRestore).toMatchObject({ name: backup.name, replacedDir: replaced });
    // Un arranque posterior ya no vuelve a restaurar.
    await shutdownCurrent();
    await boot(undefined, { dataDir });
    expect(globalCtx().restored).toBeNull();
  });

  it('una restauración preparada se puede cancelar; una copia se puede borrar', async () => {
    const { app, dataDir } = await boot(undefined, { onDisk: true });
    const backup = (await app.inject({ method: 'POST', url: '/api/backups' })).json();
    await app.inject({ method: 'POST', url: `/api/backups/${backup.name}/restore` });
    expect((await app.inject({ method: 'DELETE', url: '/api/backups/restore/pending' })).json()).toEqual({ cancelled: true });
    expect(fs.existsSync(path.join(dataDir, 'restore-pending'))).toBe(false);
    expect((await app.inject({ method: 'DELETE', url: '/api/backups/restore/pending' })).json()).toEqual({ cancelled: false });
    expect((await app.inject({ method: 'DELETE', url: `/api/backups/${backup.name}` })).statusCode).toBe(204);
    expect(((await get('/api/backups')).json() as BackupState).backups).toEqual([]);
    expect((await app.inject({ method: 'DELETE', url: `/api/backups/${backup.name}` })).statusCode).toBe(404);
  });

  it('subir una copia la valida: un archivo cualquiera se rechaza y no queda guardado', async () => {
    const { app, ctx, dataDir } = await boot(undefined, { onDisk: true });
    addAgent(ctx, { name: 'Viajero' });
    const backup = (await app.inject({ method: 'POST', url: '/api/backups' })).json();
    const bytes = fs.readFileSync(path.join(dataDir, 'backups', backup.name));
    await app.listen({ port: 0, host: '127.0.0.1' });
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const upload = (body: Buffer, type = 'application/octet-stream') => fetch(`${base}/api/backups/upload`, { method: 'POST', headers: { 'Content-Type': type }, body: new Uint8Array(body) });

    const bad = await upload(Buffer.from('esto no es una copia'));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toMatch(/no es una copia de seguridad|dañado/);
    const truncated = await upload(bytes.subarray(0, 200));
    expect(truncated.status).toBe(400);
    expect((await upload(bytes, 'text/plain')).status).toBe(415);
    expect(fs.readdirSync(path.join(dataDir, 'backups')).sort()).toEqual([backup.name]);

    const ok = await upload(bytes);
    expect(ok.status).toBe(201);
    const uploaded = (await ok.json()) as { name: string; manifest: { counts: { agents: number } } };
    expect(uploaded.name).toMatch(/-importada\.afbackup$/);
    expect(uploaded.manifest.counts.agents).toBe(1);
    expect(((await get('/api/backups')).json() as BackupState).backups).toHaveLength(2);
  });

  it('los nombres de copia no pueden apuntar fuera de la carpeta de copias', async () => {
    const { app } = await boot(undefined, { onDisk: true });
    for (const name of ['..%2F..%2Fsecret.key', 'agentforge.db', 'agentforge-20260101-000000.afbackup%00.txt']) {
      expect((await app.inject({ method: 'GET', url: `/api/backups/${name}/download` })).statusCode, name).toBe(400);
      expect((await app.inject({ method: 'POST', url: `/api/backups/${name}/restore` })).statusCode, name).toBe(400);
    }
    expect((await app.inject({ method: 'GET', url: '/api/backups/agentforge-20260101-000000.afbackup/download' })).statusCode).toBe(404);
  });
});

/** Contexto y aplicación en uso ahora mismo (dentro de un test pueden quedar ocultos por variables locales). */
const globalCtx = () => ctx!;
const makeSure = <T>(value: T): T => value;
async function shutdownCurrent(): Promise<void> {
  await app?.close();
  await ctx?.close();
  app = undefined;
  ctx = undefined;
}
