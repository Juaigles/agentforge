// @vitest-environment jsdom
// Historial de ejecuciones contra la API real: filtros (estado, workflow, agente, fechas) en la URL y respuestas fuera de orden.
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Agent, Run } from '@shared/types';
import { addAgent, edges, node, workflow } from '../../../server/test/helpers';
import { freshPinia, startApi, testRouter, until, type TestApi } from '@/test/harness';
import RunsView from './RunsView.vue';

let api: TestApi;
let wrapper: VueWrapper | undefined;
let agent: Agent;
/** Las dos ejecuciones de partida: una completada y una fallida del agente «Resumidor». */
let okRun: Run;
let failedRun: Run;
/** Suelta a los modelos que esperan (las entradas con «espera»). */
let release: () => void;

beforeEach(async () => {
  const gate = new Promise<void>((resolve) => (release = resolve));
  api = await startApi(async (req) => {
    if (req.messages.some((m) => m.content.includes('falla'))) throw new Error('proveedor caído');
    if (req.messages.some((m) => m.content.includes('espera'))) {
      await Promise.race([gate, new Promise<void>((resolve) => req.signal?.addEventListener('abort', () => resolve()))]);
    }
    return { content: 'ok' };
  });
  agent = addAgent(api.ctx, { name: 'Resumidor' });
  okRun = api.ctx.runs.startAgentRun(agent, 'bien', { defaultRetries: 0 });
  await api.ctx.runs.waitFor(okRun.id);
  failedRun = api.ctx.runs.startAgentRun(agent, 'falla', { defaultRetries: 0 });
  await api.ctx.runs.waitFor(failedRun.id);
});
afterEach(async () => {
  release();
  wrapper?.unmount();
  wrapper = undefined;
  document.body.innerHTML = '';
  await api.close();
});

async function open(path: string) {
  const pinia = freshPinia();
  const router = testRouter([{ path: '/runs', component: RunsView }]);
  await router.push(path);
  await router.isReady();
  wrapper = mount(RunsView, { global: { plugins: [pinia, router] }, attachTo: document.body });
  return router;
}
const rows = () => wrapper!.findAll('tbody tr').length;
const control = (label: string) => wrapper!.get(`[aria-label="${label}"]`);
const optionTexts = (label: string) =>
  control(label)
    .findAll('option')
    .map((o) => o.text());
/** Campo de fecha por el texto de su etiqueta visible. */
const dateInput = (label: string) =>
  wrapper!
    .findAll('fieldset.dates label')
    .find((l) => l.get('span').text() === label)!
    .get('input');
const filter = (label: string) => wrapper!.findAll('.segmented button').find((b) => b.text() === label)!;

describe('RunsView', () => {
  it('navegar a /runs estando en /runs?estado=failed reaplica los filtros (la URL manda)', async () => {
    const router = await open('/runs?estado=failed');
    await until(() => rows() === 1);
    expect(filter('Fallidas').attributes('aria-pressed')).toBe('true');

    await router.push('/runs');
    await until(() => rows() === 2);
    expect(filter('Todas').attributes('aria-pressed')).toBe('true');
    expect(router.currentRoute.value.query).toEqual({});
  });

  it('una respuesta atrasada del filtro anterior no pisa la del filtro vigente', async () => {
    await open('/runs');
    await until(() => rows() === 2);
    const inner = globalThis.fetch;
    // La petición del filtro «Fallidas» tarda más que la siguiente (la de «Todas»).
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('status=failed')) await new Promise((r) => setTimeout(r, 400));
      return inner(input, init);
    }) as typeof fetch;

    await filter('Fallidas').trigger('click');
    await filter('Canceladas').trigger('click');
    await filter('Todas').trigger('click');
    await new Promise((r) => setTimeout(r, 700));
    await flushPromises();
    expect(filter('Todas').attributes('aria-pressed')).toBe('true');
    expect(rows()).toBe(2);
  });

  it('«En curso» incluye también las ejecuciones que esperan en la cola', async () => {
    api.ctx.store.updateSettings({ maxConcurrentRuns: 1 });
    const running = api.ctx.runs.startAgentRun(agent, 'espera uno');
    const queued = api.ctx.runs.startAgentRun(agent, 'espera dos');
    await until(() => api.ctx.store.getRunSummary(running.id)!.status === 'running');
    expect(api.ctx.store.getRunSummary(queued.id)!.status).toBe('queued');

    await open('/runs?estado=running');
    await until(() => rows() === 2);
    expect(filter('En curso').attributes('aria-pressed')).toBe('true');
    const badges = wrapper!.findAll('tbody tr').map((tr) => tr.findAll('td')[1].text());
    expect(badges.sort()).toEqual(['En cola', 'En curso']);
    expect(wrapper!.text()).toContain('Mostrando 2 de 2');
  });

  it('filtra por workflow y por agente desde sus desplegables y lo deja en la URL', async () => {
    const wf = api.ctx.store.createWorkflow({ ...workflow([node('in', 'input'), node('out', 'output')], edges('in>out')), name: 'Informe semanal' });
    await api.ctx.runs.waitFor(api.ctx.runs.startWorkflowRun(wf, 'x').id);
    const other = addAgent(api.ctx, { name: 'Traductor' });
    await api.ctx.runs.waitFor(api.ctx.runs.startAgentRun(other, 'bien').id);

    const router = await open('/runs');
    await until(() => rows() === 4);
    // Los nombres salen del catálogo, por orden alfabético.
    await until(() => optionTexts('Filtrar por agente').length === 3);
    expect(optionTexts('Filtrar por workflow')).toEqual(['Todos los workflows', 'Informe semanal']);
    expect(optionTexts('Filtrar por agente')).toEqual(['Todos los agentes', 'Resumidor', 'Traductor']);

    await control('Filtrar por workflow').setValue(wf.id);
    await until(() => rows() === 1);
    expect(wrapper!.find('tbody tr').text()).toContain('Informe semanal');
    expect(router.currentRoute.value.query).toEqual({ workflow: wf.id });

    // Una ejecución es de un workflow o de un agente: elegir agente quita el filtro de workflow.
    await control('Filtrar por agente').setValue(agent.id);
    await until(() => rows() === 2);
    expect(router.currentRoute.value.query).toEqual({ agente: agent.id });
    expect((control('Filtrar por workflow').element as HTMLSelectElement).value).toBe('');

    // Se combina con el estado.
    await filter('Fallidas').trigger('click');
    await until(() => rows() === 1);
    expect(router.currentRoute.value.query).toEqual({ agente: agent.id, estado: 'failed' });
    await control('Filtrar por agente').setValue('');
    await filter('Todas').trigger('click');
    await until(() => rows() === 4);
    expect(router.currentRoute.value.query).toEqual({});
  });

  it('abre con los filtros de la URL; un workflow que ya no existe se puede ver y quitar', async () => {
    const wf = api.ctx.store.createWorkflow({ ...workflow([node('in', 'input'), node('out', 'output')], edges('in>out')), name: 'Informe semanal' });
    await api.ctx.runs.waitFor(api.ctx.runs.startWorkflowRun(wf, 'x').id);

    await open(`/runs?workflow=${wf.id}&estado=completed`);
    await until(() => rows() === 1);
    await until(() => optionTexts('Filtrar por workflow').length === 2);
    expect((control('Filtrar por workflow').element as HTMLSelectElement).value).toBe(wf.id);
    wrapper!.unmount();

    const router = await open('/runs?workflow=wf_que_no_existe');
    await until(() => wrapper!.text().includes('Ninguna ejecución coincide con el filtro'));
    await until(() => optionTexts('Filtrar por workflow').includes('Workflow eliminado'));
    expect((control('Filtrar por workflow').element as HTMLSelectElement).value).toBe('wf_que_no_existe');
    await wrapper!
      .findAll('button')
      .find((b) => b.text() === 'Quitar filtros')!
      .trigger('click');
    await until(() => rows() === 3);
    expect(router.currentRoute.value.query).toEqual({});
    expect(optionTexts('Filtrar por workflow')).not.toContain('Workflow eliminado');
  });

  it('filtra por intervalo de fechas (días locales, ambos incluidos) y lo deja en la URL', async () => {
    // La completada, el 3 de marzo a mediodía; la fallida, el 7 de marzo a las 23:30 (hora local).
    const setCreated = (run: Run, date: Date) => api.ctx.db.prepare('UPDATE runs SET created_at = ? WHERE id = ?').run(date.toISOString(), run.id);
    setCreated(okRun, new Date(2026, 2, 3, 12, 0));
    setCreated(failedRun, new Date(2026, 2, 7, 23, 30));

    // El último día del intervalo cuenta entero: las 23:30 del día 7 entran con «hasta» el 7.
    const router = await open('/runs?desde=2026-03-05&hasta=2026-03-07');
    await until(() => rows() === 1);
    expect(wrapper!.find('tbody tr').text()).toContain('proveedor caído');
    expect((dateInput('Desde').element as HTMLInputElement).value).toBe('2026-03-05');
    expect((dateInput('Hasta').element as HTMLInputElement).value).toBe('2026-03-07');
    // Cada campo acota al otro para que el intervalo no se pueda invertir desde el selector.
    expect(dateInput('Desde').attributes('max')).toBe('2026-03-07');
    expect(dateInput('Hasta').attributes('min')).toBe('2026-03-05');

    await dateInput('Hasta').setValue('2026-03-06');
    await until(() => wrapper!.text().includes('Ninguna ejecución coincide con el filtro'));
    expect(router.currentRoute.value.query).toEqual({ desde: '2026-03-05', hasta: '2026-03-06' });

    await dateInput('Desde').setValue('');
    await dateInput('Hasta').setValue('2026-03-03');
    await until(() => rows() === 1);
    expect(wrapper!.find('tbody tr').text()).not.toContain('proveedor caído');
    expect(router.currentRoute.value.query).toEqual({ hasta: '2026-03-03' });

    await dateInput('Hasta').setValue('');
    await until(() => rows() === 2);
    expect(router.currentRoute.value.query).toEqual({});
  });

  it('una fecha no válida en la URL se ignora en lugar de pedir un filtro imposible', async () => {
    const requested: string[] = [];
    const inner = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      requested.push(String(input));
      return inner(input, init);
    }) as typeof fetch;
    await open('/runs?desde=ayer&hasta=2026-02-31');
    await until(() => rows() === 2);
    expect((dateInput('Desde').element as HTMLInputElement).value).toBe('');
    expect((dateInput('Hasta').element as HTMLInputElement).value).toBe('');
    const lists = requested.filter((url) => url.startsWith('/api/runs?'));
    expect(lists.length).toBeGreaterThan(0);
    expect(lists.every((url) => !url.includes('from=') && !url.includes('to='))).toBe(true);
  });
});
