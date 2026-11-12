// @vitest-environment jsdom
// Historial de ejecuciones contra la API real: filtros en la URL y respuestas fuera de orden.
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addAgent } from '../../../server/test/helpers';
import { freshPinia, startApi, testRouter, until, type TestApi } from '@/test/harness';
import RunsView from './RunsView.vue';

let api: TestApi;
let wrapper: VueWrapper | undefined;

beforeEach(async () => {
  api = await startApi((req) => {
    if (req.messages.some((m) => m.content.includes('falla'))) throw new Error('proveedor caído');
    return { content: 'ok' };
  });
  const agent = addAgent(api.ctx, { name: 'Resumidor' });
  await api.ctx.runs.waitFor(api.ctx.runs.startAgentRun(agent, 'bien', { defaultRetries: 0 }).id);
  await api.ctx.runs.waitFor(api.ctx.runs.startAgentRun(agent, 'falla', { defaultRetries: 0 }).id);
});
afterEach(async () => {
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
});
