// Disparadores: expresiones cron con zona horaria, varios por workflow, planificador y webhooks con secreto.
// Motor y API reales; solo el LLM está guionizado.
import type { FastifyInstance } from 'fastify';
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Agent, Provider, Run, Trigger, TriggerPreview, TriggerWithSecret, Workflow } from '../../shared/types';
import { buildApp } from '../src/app';
import type { AppConfig } from '../src/config';
import { createContext, type AppContext } from '../src/context';
import { CronError, dailyCron, nextCronTime, parseCron, wallTime, zonedTimeToUtc } from '../src/engine/cron';
import { LATE_GRACE_MS, nextOccurrence, upcomingOccurrences } from '../src/engine/scheduler';
import { sleep } from '../src/util';
import { delay, ScriptedLlm, tempDir, testConfig, userText } from './helpers';

let ctx: AppContext;
let app: FastifyInstance;
const dirs: string[] = [];

async function boot(llm = new ScriptedLlm((req) => ({ content: `eco(${userText(req)})` })), dataDir = tempDir(), config: Partial<AppConfig> = {}) {
  if (!dirs.includes(dataDir)) dirs.push(dataDir);
  ctx = createContext({ ...testConfig(dataDir), ...config }, { llm, inMemory: false, retryBaseDelayMs: 5 });
  app = await buildApp(ctx);
  return { dataDir, llm };
}
async function shutdown() {
  await app?.close();
  await ctx?.close();
}
afterEach(async () => {
  await shutdown();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const post = (url: string, payload?: unknown) => app.inject({ method: 'POST', url, payload: payload ?? {} });
const put = (url: string, payload: unknown) => app.inject({ method: 'PUT', url, payload: payload as object });
const get = (url: string) => app.inject({ method: 'GET', url });
const del = (url: string) => app.inject({ method: 'DELETE', url });

async function seed(): Promise<{ provider: Provider; agent: Agent; wf: Workflow }> {
  const provider = (
    await post('/api/providers', { name: 'Local', kind: 'ollama', baseUrl: 'http://localhost:11434', defaultModel: 'modelo-local' })
  ).json() as Provider;
  const agent = (await post('/api/agents', { name: 'Redactor', role: 'escribe', providerId: provider.id, model: 'test-model' })).json() as Agent;
  const wf = (
    await post('/api/workflows', {
      name: 'Boletín',
      description: 'Resumen periódico',
      nodes: [
        { id: 'entrada', type: 'input', position: { x: 0, y: 0 }, config: {} },
        { id: 'redactar', type: 'agent', label: 'Redactar', position: { x: 200, y: 0 }, config: { agentId: agent.id, prompt: 'escribe sobre {{input}}' } },
      ],
      edges: [{ id: 'e1', source: 'entrada', target: 'redactar' }],
    })
  ).json() as Workflow;
  return { provider, agent, wf };
}
const create = async (wf: Workflow, payload: Record<string, unknown>) => (await post(`/api/workflows/${wf.id}/triggers`, payload)).json() as TriggerWithSecret;

const MIN = 60_000;
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
const next = (expression: string, from: string, zone = 'UTC') => iso(nextCronTime(parseCron(expression), Date.parse(from), zone));

describe('expresiones cron', () => {
  it('entiende listas, rangos, pasos, nombres y alias', () => {
    expect(parseCron('*/15 9-17 * * 1-5')).toMatchObject({ minutes: [0, 15, 30, 45], hours: [9, 10, 11, 12, 13, 14, 15, 16, 17] });
    expect(parseCron('5/20 0 1,15 * *').minutes).toEqual([5, 25, 45]);
    expect([...parseCron('0 0 * jan,MAR mon-fri').months]).toEqual([1, 3]);
    expect([...parseCron('0 0 * * mon-fri').daysOfWeek]).toEqual([1, 2, 3, 4, 5]);
    // 7 también es domingo.
    expect([...parseCron('0 0 * * 7').daysOfWeek]).toEqual([0]);
    expect(parseCron('@daily')).toMatchObject({ minutes: [0], hours: [0] });
    expect(parseCron('  30   8  * * *  ')).toMatchObject({ minutes: [30], hours: [8], domRestricted: false, dowRestricted: false });
  });

  it('rechaza lo que no entiende con un mensaje que dice qué campo falla', () => {
    for (const [bad, message] of [
      ['* * * *', /cinco campos/],
      ['* * * * * *', /cinco campos/],
      ['60 * * * *', /campo minuto/],
      ['* 24 * * *', /campo hora/],
      ['* * 0 * *', /día del mes/],
      ['* * * 13 *', /campo mes/],
      ['* * * * 8', /día de la semana/],
      ['*/0 * * * *', /paso/],
      ['5-1 * * * *', /al revés/],
      ['1,,2 * * * *', /vacío/],
      ['a * * * *', /campo minuto/],
      ['1-2-3 * * * *', /rango/],
    ] as Array<[string, RegExp]>) {
      expect(() => parseCron(bad), bad).toThrow(CronError);
      expect(() => parseCron(bad), bad).toThrow(message);
    }
  });

  it('calcula la siguiente ocasión en UTC', () => {
    expect(next('*/15 * * * *', '2026-03-10T10:07:00Z')).toBe('2026-03-10T10:15:00.000Z');
    // Estrictamente posterior: en el minuto exacto pasa a la siguiente.
    expect(next('*/15 * * * *', '2026-03-10T10:15:00Z')).toBe('2026-03-10T10:30:00.000Z');
    expect(next('0 9 * * 1-5', '2026-03-13T10:00:00Z')).toBe('2026-03-16T09:00:00.000Z'); // viernes tarde → lunes
    expect(next('0 0 1 * *', '2026-01-31T23:59:59Z')).toBe('2026-02-01T00:00:00.000Z');
    expect(next('0 0 29 2 *', '2026-03-01T00:00:00Z')).toBe('2028-02-29T00:00:00.000Z'); // año bisiesto
    expect(next('59 23 31 12 *', '2026-12-31T23:59:00Z')).toBe('2027-12-31T23:59:00.000Z');
    // Día del mes y día de la semana restringidos a la vez: basta con que se cumpla uno (como en cron).
    expect(next('0 0 13 * 5', '2026-02-01T00:00:00Z')).toBe('2026-02-06T00:00:00.000Z');
    expect(next('0 0 13 * 5', '2026-02-06T00:00:00Z')).toBe('2026-02-13T00:00:00.000Z');
    // Nunca se cumple.
    expect(next('0 0 30 2 *', '2026-01-01T00:00:00Z')).toBeNull();
  });

  it('respeta la zona horaria, también en verano', () => {
    expect(next('0 9 * * *', '2026-01-15T00:00:00Z', 'Europe/Madrid')).toBe('2026-01-15T08:00:00.000Z');
    expect(next('0 9 * * *', '2026-07-15T00:00:00Z', 'Europe/Madrid')).toBe('2026-07-15T07:00:00.000Z');
    expect(next('30 8 * * *', '2026-07-01T00:00:00Z', 'America/New_York')).toBe('2026-07-01T12:30:00.000Z');
    // El día de la semana es el de la zona, no el de UTC: lunes 00:30 en Tokio es domingo 15:30 UTC.
    expect(next('30 0 * * 1', '2026-03-10T00:00:00Z', 'Asia/Tokyo')).toBe('2026-03-15T15:30:00.000Z');
    // Zona con desfase de media hora.
    expect(next('0 12 * * *', '2026-03-10T00:00:00Z', 'Asia/Kolkata')).toBe('2026-03-10T06:30:00.000Z');
  });

  it('en el cambio de hora una tarea diaria se ejecuta exactamente una vez', () => {
    // Primavera (Madrid, 29-03-2026): las 02:30 no existen; se ejecuta al terminar el salto (03:30 locales).
    const spring = next('30 2 * * *', '2026-03-28T12:00:00Z', 'Europe/Madrid');
    expect(spring).toBe('2026-03-29T01:30:00.000Z');
    expect(next('30 2 * * *', spring!, 'Europe/Madrid')).toBe('2026-03-30T00:30:00.000Z');
    // Otoño (25-10-2026): las 02:30 ocurren dos veces; solo cuenta la primera.
    const autumn = next('30 2 * * *', '2026-10-24T12:00:00Z', 'Europe/Madrid');
    expect(autumn).toBe('2026-10-25T00:30:00.000Z');
    expect(next('30 2 * * *', autumn!, 'Europe/Madrid')).toBe('2026-10-26T01:30:00.000Z');
    // Entre medias, en la segunda pasada por las 02:xx, tampoco se repite.
    expect(next('30 2 * * *', '2026-10-25T01:10:00Z', 'Europe/Madrid')).toBe('2026-10-26T01:30:00.000Z');
  });

  it('convierte entre hora de pared e instante', () => {
    expect(wallTime(Date.parse('2026-07-15T07:00:00Z'), 'Europe/Madrid')).toMatchObject({ year: 2026, month: 7, day: 15, hour: 9, minute: 0 });
    expect(wallTime(Date.parse('2026-01-01T00:30:00Z'), 'America/Los_Angeles')).toMatchObject({ year: 2025, month: 12, day: 31, hour: 16, minute: 30 });
    expect(iso(zonedTimeToUtc({ year: 2026, month: 12, day: 31, hour: 23, minute: 59 }, 'Pacific/Auckland'))).toBe('2026-12-31T10:59:00.000Z');
    expect(dailyCron('07:05', [])).toBe('5 7 * * *');
    expect(dailyCron('07:05', [5, 1, 1])).toBe('5 7 * * 1,5');
    expect(dailyCron('07:05', [0, 1, 2, 3, 4, 5, 6])).toBe('5 7 * * *');
  });
});

describe('cálculo de la siguiente ocasión de un disparador', () => {
  const base = { intervalMinutes: null, time: null, weekdays: [], cron: null, timezone: null };

  it('por intervalo cuenta desde la ocasión prevista, sin acumular retraso', () => {
    const from = new Date('2026-03-10T10:00:00.000Z');
    expect(nextOccurrence({ ...base, kind: 'interval', intervalMinutes: 30 }, from)!.toISOString()).toBe('2026-03-10T10:30:00.000Z');
    // La pasada llega 4 s tarde: la siguiente sigue siendo «la prevista + 30 min».
    const late = new Date('2026-03-10T10:00:04.000Z');
    expect(nextOccurrence({ ...base, kind: 'interval', intervalMinutes: 30 }, late, from)!.toISOString()).toBe('2026-03-10T10:30:00.000Z');
    // Tras un parón largo no se recuperan las perdidas: se salta a la primera futura de la serie.
    const afterOutage = new Date('2026-03-10T13:10:00.000Z');
    expect(nextOccurrence({ ...base, kind: 'interval', intervalMinutes: 30 }, afterOutage, from)!.toISOString()).toBe('2026-03-10T13:30:00.000Z');
  });

  it('diaria sin zona: la hora local del servidor; hoy si aún no ha pasado, mañana si ya pasó', () => {
    const at = (h: number, m: number) => new Date(2026, 2, 10, h, m, 0, 0); // hora local
    const daily = (time: string, from: Date) => nextOccurrence({ ...base, kind: 'daily', time }, from);
    expect(daily('09:30', at(8, 0))).toEqual(at(9, 30));
    expect(daily('09:30', at(9, 30))).toEqual(new Date(2026, 2, 11, 9, 30));
    expect(daily('00:00', at(12, 0))).toEqual(new Date(2026, 2, 11, 0, 0));
    expect(daily('07:15', new Date(2026, 0, 31, 8, 0))).toEqual(new Date(2026, 1, 1, 7, 15));
  });

  it('diaria con días de la semana y zona; cron; webhook sin horario', () => {
    const from = new Date('2026-03-10T10:00:00Z'); // martes
    expect(nextOccurrence({ ...base, kind: 'daily', time: '09:00', weekdays: [1, 3], timezone: 'UTC' }, from)!.toISOString()).toBe('2026-03-11T09:00:00.000Z');
    expect(nextOccurrence({ ...base, kind: 'daily', time: '09:00', weekdays: [1], timezone: 'Europe/Madrid' }, from)!.toISOString()).toBe(
      '2026-03-16T08:00:00.000Z',
    );
    expect(nextOccurrence({ ...base, kind: 'cron', cron: '0 */6 * * *', timezone: 'UTC' }, from)!.toISOString()).toBe('2026-03-10T12:00:00.000Z');
    expect(nextOccurrence({ ...base, kind: 'webhook' }, from)).toBeNull();
    expect(upcomingOccurrences({ ...base, kind: 'cron', cron: '0 0 * * 0', timezone: 'UTC' }, from, 3).map((d) => d.toISOString())).toEqual([
      '2026-03-15T00:00:00.000Z',
      '2026-03-22T00:00:00.000Z',
      '2026-03-29T00:00:00.000Z',
    ]);
  });
});

describe('disparadores de un workflow', () => {
  it('admite varios por workflow; los valida, los edita y los borra', async () => {
    await boot();
    const { wf } = await seed();
    expect((await get(`/api/workflows/${wf.id}/triggers`)).json()).toEqual([]);
    expect((await get('/api/workflows/wf_no_existe/triggers')).statusCode).toBe(404);

    for (const [bad, field] of [
      [{ kind: 'interval' }, 'intervalMinutes'],
      [{ kind: 'interval', intervalMinutes: 0 }, 'intervalMinutes'],
      [{ kind: 'interval', intervalMinutes: 1.5 }, 'intervalMinutes'],
      [{ kind: 'daily' }, 'time'],
      [{ kind: 'daily', time: '25:00' }, 'time'],
      [{ kind: 'daily', time: '09:00', weekdays: [7] }, 'weekdays.0'],
      [{ kind: 'daily', time: '09:00', timezone: 'Marte/Olympus' }, 'timezone'],
      [{ kind: 'cron' }, 'cron'],
      [{ kind: 'cron', cron: 'cada lunes' }, 'cron'],
      [{ kind: 'cron', cron: '0 0 30 2 *' }, 'cron'],
      [{ kind: 'semanal', time: '09:00' }, 'kind'],
    ] as Array<[Record<string, unknown>, string]>) {
      const res = await post(`/api/workflows/${wf.id}/triggers`, bad);
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
      expect(res.json().issues[0].path, JSON.stringify(bad)).toBe(field);
    }
    expect((await post(`/api/workflows/${wf.id}/triggers`, { kind: 'cron', cron: '0 0 30 2 *' })).json().error).toMatch(/no se cumple nunca/);

    const before = Date.now();
    const every = await create(wf, { kind: 'interval', intervalMinutes: 15, input: 'noticias', time: '08:00', name: 'Cada cuarto de hora' });
    expect(every).toMatchObject({
      workflowId: wf.id,
      kind: 'interval',
      name: 'Cada cuarto de hora',
      intervalMinutes: 15,
      time: null,
      cron: null,
      timezone: null,
      weekdays: [],
      input: 'noticias',
      enabled: true,
      lastRunId: null,
      lastError: null,
    });
    expect(every.id).toMatch(/^trg_/);
    expect(every).not.toHaveProperty('secret');
    expect(Date.parse(every.nextRunAt!) - before).toBeGreaterThanOrEqual(15 * MIN - 50);
    expect(Date.parse(every.nextRunAt!) - before).toBeLessThan(15 * MIN + 5000);

    const weekly = await create(wf, { kind: 'daily', time: '07:45', weekdays: [5, 1, 1], timezone: 'Europe/Madrid', input: 'semana' });
    expect(weekly).toMatchObject({ kind: 'daily', time: '07:45', weekdays: [1, 5], timezone: 'Europe/Madrid' });
    const cron = await create(wf, { kind: 'cron', cron: '0 */6 * * *', timezone: 'UTC', enabled: false });
    expect(cron).toMatchObject({ kind: 'cron', cron: '0 */6 * * *', timezone: 'UTC', enabled: false, nextRunAt: null });

    expect((await get(`/api/workflows/${wf.id}/triggers`)).json().map((t: Trigger) => t.id)).toEqual([every.id, weekly.id, cron.id]);
    expect((await get('/api/triggers')).json()).toHaveLength(3);

    // Editar recalcula la siguiente ocasión; activar un cron la fija en un múltiplo de seis horas (UTC).
    const edited = (await put(`/api/triggers/${cron.id}`, { kind: 'cron', cron: '0 */6 * * *', timezone: 'UTC', enabled: true })).json() as Trigger;
    expect(new Date(edited.nextRunAt!).getUTCHours() % 6).toBe(0);
    expect(new Date(edited.nextRunAt!).getUTCMinutes()).toBe(0);
    expect((await put('/api/triggers/trg_no_existe', { kind: 'interval', intervalMinutes: 5 })).statusCode).toBe(404);
    // Un disparador con horario no se convierte en webhook.
    expect((await put(`/api/triggers/${cron.id}`, { kind: 'webhook' })).statusCode).toBe(400);

    expect((await del(`/api/triggers/${every.id}`)).statusCode).toBe(204);
    expect((await del(`/api/triggers/${every.id}`)).statusCode).toBe(404);
    expect((await get('/api/triggers')).json()).toHaveLength(2);
  });

  it('enseña las próximas ocasiones de un horario antes de guardarlo', async () => {
    await boot();
    const preview = (await post('/api/triggers/preview', { kind: 'cron', cron: '30 8 * * 1-5', timezone: 'Europe/Madrid' })).json() as TriggerPreview;
    expect(preview.timezone).toBe('Europe/Madrid');
    expect(preview.next).toHaveLength(5);
    for (const at of preview.next) {
      const wall = wallTime(Date.parse(at), 'Europe/Madrid');
      expect([wall.hour, wall.minute]).toEqual([8, 30]);
      expect(new Date(Date.UTC(wall.year, wall.month - 1, wall.day)).getUTCDay()).toBeGreaterThanOrEqual(1);
      expect(new Date(Date.UTC(wall.year, wall.month - 1, wall.day)).getUTCDay()).toBeLessThanOrEqual(5);
    }
    expect([...preview.next].sort()).toEqual(preview.next);
    // Sin zona se usa la del servidor; un webhook no tiene ocasiones.
    expect((await post('/api/triggers/preview', { kind: 'daily', time: '09:00' })).json().timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect((await post('/api/triggers/preview', { kind: 'webhook' })).json().next).toEqual([]);
    expect((await post('/api/triggers/preview', { kind: 'cron', cron: 'x' })).statusCode).toBe(400);
  });

  it('pone un tope al número de disparadores por workflow', async () => {
    await boot();
    const { wf } = await seed();
    for (let i = 0; i < 20; i++)
      expect((await post(`/api/workflows/${wf.id}/triggers`, { kind: 'interval', intervalMinutes: 60, enabled: false })).statusCode).toBe(201);
    const res = await post(`/api/workflows/${wf.id}/triggers`, { kind: 'interval', intervalMinutes: 60 });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/máximo 20/);
  });

  it('lanza el workflow cuando vence, con su entrada, lo marca y fija la siguiente sin acumular retraso', async () => {
    const { llm } = await boot();
    const { wf } = await seed();
    const trigger = await create(wf, { kind: 'interval', intervalMinutes: 10, input: 'economía' });
    const due = Date.parse(trigger.nextRunAt!);

    expect(ctx.scheduler.tick(due - 1000)).toEqual([]);
    expect(llm.calls).toHaveLength(0);

    const [runId] = ctx.scheduler.tick(due + 500);
    await ctx.runs.waitFor(runId);
    const run = (await get(`/api/runs/${runId}`)).json() as Run;
    expect(run).toMatchObject({ status: 'completed', kind: 'workflow', workflowId: wf.id, input: 'economía', scheduled: true, triggerKind: 'interval' });
    expect(llm.calls.map(userText)[0]).toBe('escribe sobre economía');

    const after = ctx.store.getTrigger(trigger.id)!;
    expect(after).toMatchObject({ lastRunId: runId, lastError: null });
    expect(Date.parse(after.nextRunAt!)).toBe(due + 10 * MIN);
    expect(after.lastRunAt).toBe(new Date(due + 500).toISOString());
    expect(ctx.scheduler.tick(due + 600)).toEqual([]);
    // Una ejecución manual no lleva la marca.
    const manual = (await post(`/api/workflows/${wf.id}/run`, { input: 'x' })).json() as Run;
    expect(manual).toMatchObject({ scheduled: false, triggerKind: null });
    await ctx.runs.waitFor(manual.id);
  });

  it('varios disparadores del mismo workflow vencen por separado, cada uno con su entrada', async () => {
    await boot();
    const { wf } = await seed();
    const a = await create(wf, { kind: 'interval', intervalMinutes: 5, input: 'cinco' });
    const b = await create(wf, { kind: 'interval', intervalMinutes: 20, input: 'veinte' });
    const first = ctx.scheduler.tick(Date.parse(a.nextRunAt!) + 100);
    expect(first).toHaveLength(1);
    await ctx.runs.waitFor(first[0]);
    const both = ctx.scheduler.tick(Date.parse(b.nextRunAt!) + 100);
    expect(both).toHaveLength(2);
    for (const id of both) await ctx.runs.waitFor(id);
    expect(both.map((id) => ctx.store.getRun(id)!.input).sort()).toEqual(['cinco', 'veinte']);
  });

  it('tras un apagado largo: un intervalo se ejecuta una sola vez; una hora fija que llega tarde se omite', async () => {
    await boot();
    const { wf } = await seed();
    const every = await create(wf, { kind: 'interval', intervalMinutes: 5 });
    const due = Date.parse(every.nextRunAt!);
    const late = due + 3 * 60 * MIN; // el servidor «vuelve» tres horas después
    const started = ctx.scheduler.tick(late);
    expect(started).toHaveLength(1);
    await ctx.runs.waitFor(started[0]);
    expect(ctx.scheduler.tick(late + 1000)).toEqual([]);
    expect(Date.parse(ctx.store.getTrigger(every.id)!.nextRunAt!)).toBe(late + 5 * MIN);
    await del(`/api/triggers/${every.id}`);

    const daily = await create(wf, { kind: 'daily', time: '06:00', timezone: 'UTC' });
    const at = Date.parse(daily.nextRunAt!);
    // Con poco retraso sí se ejecuta…
    const onTime = ctx.scheduler.tick(at + 10 * MIN);
    expect(onTime).toHaveLength(1);
    await ctx.runs.waitFor(onTime[0]);
    // …pero al día siguiente el servidor vuelve cinco horas tarde: no se ejecuta a deshora y queda anotado.
    const nextDay = Date.parse(ctx.store.getTrigger(daily.id)!.nextRunAt!);
    expect(nextDay).toBe(at + 24 * 60 * MIN);
    expect(ctx.scheduler.tick(nextDay + LATE_GRACE_MS + 4 * 60 * MIN)).toEqual([]);
    const skipped = ctx.store.getTrigger(daily.id)!;
    expect(skipped.lastError).toMatch(/no estaba en marcha/);
    expect(Date.parse(skipped.nextRunAt!)).toBe(nextDay + 24 * 60 * MIN);
  });

  it('no solapa ejecuciones del mismo disparador: si la anterior sigue en curso, la ocasión se omite', async () => {
    const llm = new ScriptedLlm(async (req) => {
      await sleep(5000, req.signal);
      return { content: 'x' };
    });
    await boot(llm);
    const { wf } = await seed();
    const trigger = await create(wf, { kind: 'interval', intervalMinutes: 1 });
    const due = Date.parse(trigger.nextRunAt!);
    const [first] = ctx.scheduler.tick(due);
    for (let i = 0; i < 100 && llm.calls.length < 1; i++) await delay(10);

    expect(ctx.scheduler.tick(due + MIN)).toEqual([]);
    const skipped = ctx.store.getTrigger(trigger.id)!;
    expect(skipped.lastError).toMatch(/anterior seguía en curso/);
    expect(skipped.lastRunId).toBe(first);
    expect(Date.parse(skipped.nextRunAt!)).toBe(due + 2 * MIN);
    expect((await get('/api/runs')).json().total).toBe(1);

    ctx.runs.cancel(first);
    await ctx.runs.waitFor(first);
    expect(ctx.scheduler.tick(due + 2 * MIN)).toHaveLength(1);
    expect(ctx.store.getTrigger(trigger.id)!.lastError).toBeNull();
    await shutdown(); // corta la segunda ejecución
  });

  it('no lanza un workflow con errores ni un disparador desactivado, y lo explica', async () => {
    const { llm } = await boot();
    const { wf } = await seed();
    const trigger = await create(wf, { kind: 'interval', intervalMinutes: 1 });
    const due = Date.parse(trigger.nextRunAt!);

    const broken = { ...wf, nodes: wf.nodes.map((n) => (n.id === 'redactar' ? { ...n, config: { ...n.config, agentId: 'agt_borrado' } } : n)) };
    expect((await put(`/api/workflows/${wf.id}`, broken)).statusCode).toBe(200);
    expect(ctx.scheduler.tick(due)).toEqual([]);
    expect(ctx.store.getTrigger(trigger.id)).toMatchObject({
      lastRunId: null,
      lastError: expect.stringMatching(/No se pudo lanzar: .*agente que ya no existe/),
    });
    expect((await post(`/api/triggers/${trigger.id}/run`)).statusCode).toBe(422);
    expect(llm.calls).toHaveLength(0);

    await put(`/api/workflows/${wf.id}`, wf);
    await put(`/api/triggers/${trigger.id}`, { kind: 'interval', intervalMinutes: 1, enabled: false });
    expect(ctx.scheduler.tick(due + 60 * MIN)).toEqual([]);
  });

  it('«ejecutar ahora» lanza con la entrada guardada sin mover la siguiente ocasión', async () => {
    await boot();
    const { wf } = await seed();
    expect((await post('/api/triggers/trg_no_existe/run')).statusCode).toBe(404);
    const trigger = await create(wf, { kind: 'daily', time: '06:00', input: 'diario' });
    const res = await post(`/api/triggers/${trigger.id}/run`);
    expect(res.statusCode).toBe(202);
    const run = res.json() as Run;
    await ctx.runs.waitFor(run.id);
    expect((await get(`/api/runs/${run.id}`)).json()).toMatchObject({ scheduled: true, triggerKind: 'daily', input: 'diario', status: 'completed' });
    expect(ctx.store.getTrigger(trigger.id)).toMatchObject({ nextRunAt: trigger.nextRunAt, lastRunId: run.id });
  });

  it('sobreviven a un reinicio y desaparecen al borrar el workflow', async () => {
    const { dataDir } = await boot();
    const { wf } = await seed();
    const saved = await create(wf, { kind: 'cron', cron: '30 21 * * *', timezone: 'Europe/Madrid', input: 'noche' });
    const hook = await create(wf, { kind: 'webhook', name: 'Desde fuera' });
    await shutdown();

    await boot(undefined, dataDir);
    expect((await get('/api/triggers')).json().map((t: Trigger) => t.id)).toEqual([saved.id, hook.id]);
    const [runId] = ctx.scheduler.tick(Date.parse(saved.nextRunAt!) + 1);
    await ctx.runs.waitFor(runId);
    expect(ctx.store.getRun(runId)).toMatchObject({ status: 'completed', triggerKind: 'cron' });
    // El secreto del webhook sigue valiendo tras el reinicio (se guarda cifrado con la clave de la carpeta de datos).
    expect((await app.inject({ method: 'POST', url: `/api/hooks/${hook.id}`, headers: { authorization: `Bearer ${hook.secret}` } })).statusCode).toBe(202);

    expect((await del(`/api/workflows/${wf.id}`)).statusCode).toBe(204);
    expect((await get('/api/triggers')).json()).toEqual([]);
    expect(ctx.scheduler.tick(Date.now() + 48 * 60 * MIN)).toEqual([]);
  });

  it('el temporizador real dispara sin intervención', async () => {
    await boot();
    const { wf } = await seed();
    const trigger = await create(wf, { kind: 'interval', intervalMinutes: 1 });
    // Se adelanta la ocasión guardada en lugar de esperar un minuto; el disparo lo hace el temporizador.
    ctx.store.updateTriggerState(trigger.id, { nextRunAt: new Date(Date.now() + 150).toISOString() });
    ctx.scheduler.start(50);
    let runId: string | null = null;
    for (let i = 0; i < 100 && !runId; i++) {
      await delay(20);
      runId = ctx.store.getTrigger(trigger.id)!.lastRunId;
    }
    expect(runId).toBeTruthy();
    await ctx.runs.waitFor(runId!);
    expect(ctx.store.getRun(runId!)).toMatchObject({ status: 'completed', scheduled: true });
    ctx.scheduler.stop();
  });

  it('la migración convierte la programación única de antes en un disparador', async () => {
    const { dataDir } = await boot();
    const { wf } = await seed();
    await shutdown();

    // Se devuelve la base al esquema v5 y se le pone una programación como las de entonces.
    const raw = new DatabaseSync(path.join(dataDir, 'agentforge.db'));
    raw.exec(`
      DROP INDEX idx_workflows_builtin; DROP INDEX idx_agents_builtin;
      ALTER TABLE workflows DROP COLUMN builtin; ALTER TABLE agents DROP COLUMN builtin;
      ALTER TABLE runs DROP COLUMN error_i18n; ALTER TABLE run_steps DROP COLUMN error_i18n; ALTER TABLE run_step_items DROP COLUMN error_i18n;
      DROP TABLE mcp_servers; DROP TABLE triggers; ALTER TABLE runs DROP COLUMN trigger_kind;
      CREATE TABLE schedules (workflow_id TEXT PRIMARY KEY REFERENCES workflows(id) ON DELETE CASCADE, kind TEXT NOT NULL, interval_minutes INTEGER,
        time TEXT, input TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1, next_run_at TEXT, last_run_at TEXT, last_run_id TEXT,
        last_error TEXT, updated_at TEXT NOT NULL);
      PRAGMA user_version = 5;
    `);
    raw
      .prepare('INSERT INTO schedules (workflow_id, kind, time, input, enabled, next_run_at, last_error, updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(wf.id, 'daily', '07:45', 'boletín', 1, '2030-01-01T06:45:00.000Z', 'algo falló', '2026-01-01T00:00:00.000Z');
    raw.close();

    await boot(undefined, dataDir);
    const triggers = (await get(`/api/workflows/${wf.id}/triggers`)).json() as Trigger[];
    expect(triggers).toHaveLength(1);
    expect(triggers[0]).toMatchObject({
      kind: 'daily',
      time: '07:45',
      weekdays: [],
      timezone: null,
      input: 'boletín',
      enabled: true,
      nextRunAt: '2030-01-01T06:45:00.000Z',
      lastError: 'algo falló',
      name: '',
    });
    expect(triggers[0].id).toMatch(/^trg_[0-9a-f]{16}$/);
    expect(fs.existsSync(path.join(dataDir, 'agentforge.db.v5.bak'))).toBe(true);
  });
});

describe('webhooks', () => {
  const call = (id: string, opts: { body?: string | Buffer; headers?: Record<string, string> } = {}) =>
    app.inject({ method: 'POST', url: `/api/hooks/${id}`, payload: opts.body, headers: opts.headers });
  const sign = (secret: string, body: string) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

  it('el secreto se enseña una sola vez, al crear el webhook', async () => {
    await boot();
    const { wf } = await seed();
    const hook = await create(wf, { kind: 'webhook', name: 'CI' });
    expect(hook).toMatchObject({ kind: 'webhook', name: 'CI', nextRunAt: null, enabled: true });
    expect(hook.secret).toMatch(/^whsec_[A-Za-z0-9_-]{32}$/);
    // Ni las listas ni la edición lo devuelven, y en la base de datos está cifrado.
    expect(JSON.stringify((await get('/api/triggers')).json())).not.toContain(hook.secret!);
    expect(JSON.stringify((await put(`/api/triggers/${hook.id}`, { kind: 'webhook', name: 'CI 2' })).json())).not.toContain('whsec_');
    const stored = ctx.db.prepare('SELECT secret_enc FROM triggers WHERE id = ?').get(hook.id) as { secret_enc: string };
    expect(stored.secret_enc).toMatch(/^v1:/);
    expect(stored.secret_enc).not.toContain(hook.secret!);
  });

  it('lanza el workflow con el cuerpo de la petición si el secreto es correcto', async () => {
    const { llm } = await boot();
    const { wf } = await seed();
    const hook = await create(wf, { kind: 'webhook' });

    // Texto plano con el secreto en la cabecera Authorization.
    const res = await call(hook.id, {
      body: 'la versión 2.3 ya está desplegada',
      headers: { 'content-type': 'text/plain', authorization: `Bearer ${hook.secret}` },
    });
    expect(res.statusCode).toBe(202);
    const { runId } = res.json() as { runId: string };
    await ctx.runs.waitFor(runId);
    expect(ctx.store.getRun(runId)).toMatchObject({
      status: 'completed',
      input: 'la versión 2.3 ya está desplegada',
      scheduled: false,
      triggerKind: 'webhook',
      workflowId: wf.id,
    });
    expect(userText(llm.calls[0])).toBe('escribe sobre la versión 2.3 ya está desplegada');
    expect(ctx.store.getTrigger(hook.id)).toMatchObject({ lastRunId: runId, lastError: null });

    // JSON con un campo «input»: ese es el texto. Secreto en su propia cabecera.
    const json = await call(hook.id, {
      body: JSON.stringify({ input: 'un pedido nuevo', otro: 1 }),
      headers: { 'content-type': 'application/json', 'x-agentforge-secret': hook.secret! },
    });
    expect(json.statusCode).toBe(202);
    expect(ctx.store.getRun(json.json().runId)!.input).toBe('un pedido nuevo');

    // JSON sin «input»: el cuerpo entero. Sin cuerpo: entrada vacía.
    const whole = await call(hook.id, {
      body: '{"evento":"push","rama":"main"}',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${hook.secret}` },
    });
    expect(ctx.store.getRun(whole.json().runId)!.input).toBe('{"evento":"push","rama":"main"}');
    const empty = await call(hook.id, { headers: { authorization: `Bearer ${hook.secret}` } });
    expect(empty.statusCode).toBe(202);
    expect(ctx.store.getRun(empty.json().runId)!.input).toBe('');
    // Un tipo de contenido cualquiera también vale.
    const form = await call(hook.id, {
      body: 'a=1&b=2',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Bearer ${hook.secret}` },
    });
    expect(ctx.store.getRun(form.json().runId)!.input).toBe('a=1&b=2');
    for (const r of (await get('/api/runs')).json().items as Run[]) await ctx.runs.waitFor(r.id);
  });

  it('la entrada guardada es una plantilla: {{body}} se sustituye por el cuerpo', async () => {
    await boot();
    const { wf } = await seed();
    const hook = await create(wf, { kind: 'webhook', input: 'Resume este aviso:\n{{ body }}\n(fin: {{body}})' });
    const res = await call(hook.id, { body: 'disco al 91 % y $& raro', headers: { 'content-type': 'text/plain', authorization: `Bearer ${hook.secret}` } });
    expect(ctx.store.getRun(res.json().runId)!.input).toBe('Resume este aviso:\ndisco al 91 % y $& raro\n(fin: disco al 91 % y $& raro)');
    await ctx.runs.waitFor(res.json().runId);
  });

  it('acepta una firma HMAC del cuerpo en lugar del secreto', async () => {
    await boot();
    const { wf } = await seed();
    const hook = await create(wf, { kind: 'webhook' });
    const body = '{"input":"firmado"}';
    const ok = await call(hook.id, { body, headers: { 'content-type': 'application/json', 'x-agentforge-signature': sign(hook.secret!, body) } });
    expect(ok.statusCode).toBe(202);
    await ctx.runs.waitFor(ok.json().runId);
    expect(ctx.store.getRun(ok.json().runId)!.input).toBe('firmado');
    // La firma de otro cuerpo, o hecha con otro secreto, no vale; y una firma presente manda sobre el secreto en claro.
    expect(
      (
        await call(hook.id, {
          body: '{"input":"manipulado"}',
          headers: { 'content-type': 'application/json', 'x-agentforge-signature': sign(hook.secret!, body) },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (await call(hook.id, { body, headers: { 'content-type': 'application/json', 'x-agentforge-signature': sign('whsec_otro', body) } })).statusCode,
    ).toBe(401);
    expect(
      (
        await call(hook.id, {
          body,
          headers: { 'content-type': 'application/json', 'x-agentforge-signature': 'sha256=00', authorization: `Bearer ${hook.secret}` },
        })
      ).statusCode,
    ).toBe(401);
    expect((await get('/api/runs')).json().total).toBe(1);
  });

  it('rechaza las llamadas sin secreto, con uno incorrecto, a webhooks que no existen o desactivados', async () => {
    const { llm } = await boot();
    const { wf } = await seed();
    const hook = await create(wf, { kind: 'webhook' });
    const timed = await create(wf, { kind: 'interval', intervalMinutes: 5 });

    expect((await call(hook.id, { body: 'x', headers: { 'content-type': 'text/plain' } })).statusCode).toBe(401);
    expect((await call(hook.id, { body: 'x', headers: { 'content-type': 'text/plain', authorization: 'Bearer whsec_incorrecto' } })).statusCode).toBe(401);
    expect((await call(hook.id, { headers: { authorization: 'Bearer ' } })).statusCode).toBe(401);
    // Mismo mensaje para un id que no existe y para un disparador que no es un webhook: no se revela cuáles hay.
    const unknown = await call('trg_no_existe', { headers: { authorization: `Bearer ${hook.secret}` } });
    const notHook = await call(timed.id, { headers: { authorization: `Bearer ${hook.secret}` } });
    expect([unknown.statusCode, notHook.statusCode]).toEqual([401, 401]);
    expect(unknown.json().error).toBe(notHook.json().error);
    // Solo POST.
    expect((await app.inject({ method: 'GET', url: `/api/hooks/${hook.id}`, headers: { authorization: `Bearer ${hook.secret}` } })).statusCode).toBe(404);

    await put(`/api/triggers/${hook.id}`, { kind: 'webhook', enabled: false });
    const disabled = await call(hook.id, { headers: { authorization: `Bearer ${hook.secret}` } });
    expect(disabled.statusCode).toBe(409);
    expect(disabled.json().error).toMatch(/desactivado/);
    expect(llm.calls).toHaveLength(0);
    expect((await get('/api/runs')).json().total).toBe(0);
  });

  it('regenerar el secreto invalida el anterior', async () => {
    await boot();
    const { wf } = await seed();
    const hook = await create(wf, { kind: 'webhook' });
    const timed = await create(wf, { kind: 'interval', intervalMinutes: 5 });
    expect((await post(`/api/triggers/${timed.id}/secret`)).statusCode).toBe(400);
    const renewed = (await post(`/api/triggers/${hook.id}/secret`)).json() as TriggerWithSecret;
    expect(renewed.secret).toMatch(/^whsec_/);
    expect(renewed.secret).not.toBe(hook.secret);
    expect((await call(hook.id, { headers: { authorization: `Bearer ${hook.secret}` } })).statusCode).toBe(401);
    const ok = await call(hook.id, { headers: { authorization: `Bearer ${renewed.secret}` } });
    expect(ok.statusCode).toBe(202);
    await ctx.runs.waitFor(ok.json().runId);
  });

  it('explica por qué no se pudo lanzar y rechaza cuerpos enormes', async () => {
    await boot();
    const { wf } = await seed();
    const hook = await create(wf, { kind: 'webhook' });
    const auth = { authorization: `Bearer ${hook.secret}`, 'content-type': 'text/plain' };
    expect((await call(hook.id, { body: 'x'.repeat(100_001), headers: auth })).statusCode).toBe(413);
    expect((await call(hook.id, { body: Buffer.alloc(1024 * 1024 + 1, 97), headers: auth })).statusCode).toBe(413);

    const broken = { ...wf, nodes: wf.nodes.map((n) => (n.id === 'redactar' ? { ...n, config: { ...n.config, agentId: 'agt_borrado' } } : n)) };
    await put(`/api/workflows/${wf.id}`, broken);
    const res = await call(hook.id, { body: 'x', headers: auth });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatch(/agente que ya no existe/);
    expect(ctx.store.getTrigger(hook.id)!.lastError).toMatch(/agente que ya no existe/);
  });

  it('con clave de acceso configurada, el webhook se autentica solo con su secreto; el resto de la API sigue cerrada', async () => {
    await boot(undefined, undefined, { authToken: 'una-clave-de-acceso-larga' });
    const session = { authorization: 'Bearer una-clave-de-acceso-larga' };
    const provider = (
      await app.inject({
        method: 'POST',
        url: '/api/providers',
        headers: session,
        payload: { name: 'Local', kind: 'ollama', baseUrl: 'http://localhost:11434' },
      })
    ).json() as Provider;
    const agent = (
      await app.inject({ method: 'POST', url: '/api/agents', headers: session, payload: { name: 'A', providerId: provider.id, model: 'm' } })
    ).json() as Agent;
    const wf = (
      await app.inject({
        method: 'POST',
        url: '/api/workflows',
        headers: session,
        payload: {
          name: 'W',
          nodes: [
            { id: 'entrada', type: 'input', position: { x: 0, y: 0 }, config: {} },
            { id: 'a', type: 'agent', position: { x: 1, y: 0 }, config: { agentId: agent.id, prompt: '{{input}}' } },
          ],
          edges: [{ id: 'e', source: 'entrada', target: 'a' }],
        },
      })
    ).json() as Workflow;
    // Crear el disparador exige la clave de acceso.
    expect((await post(`/api/workflows/${wf.id}/triggers`, { kind: 'webhook' })).statusCode).toBe(401);
    const hook = (
      await app.inject({ method: 'POST', url: `/api/workflows/${wf.id}/triggers`, headers: session, payload: { kind: 'webhook' } })
    ).json() as TriggerWithSecret;

    // La llamada al webhook no lleva la clave de acceso: basta su secreto. La clave de acceso NO sirve de secreto.
    const ok = await call(hook.id, { body: 'hola', headers: { 'content-type': 'text/plain', 'x-agentforge-secret': hook.secret! } });
    expect(ok.statusCode).toBe(202);
    await ctx.runs.waitFor(ok.json().runId);
    expect((await call(hook.id, { body: 'hola', headers: { 'content-type': 'text/plain', ...session } })).statusCode).toBe(401);
    // El secreto del webhook no abre el resto de la API.
    expect((await app.inject({ method: 'GET', url: '/api/triggers', headers: { authorization: `Bearer ${hook.secret}` } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: `/api/hooks/${hook.id}` })).statusCode).toBe(401);
  });
});
