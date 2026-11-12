// @vitest-environment jsdom
// Aviso de aprobaciones pendientes contra la API real y su canal SSE `/api/stream/approvals`: el `EventSource` es
// el paquete `eventsource` (protocolo real) y el único doble es el proveedor LLM (ver src/test/harness.ts).
import { mount, type VueWrapper } from '@vue/test-utils';
import { EventSource as NodeEventSource } from 'eventsource';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { edges, node, workflow } from '../../../server/test/helpers';
import { announcement } from '@/lib/a11y';
import { useRuns } from '@/stores/runs';
import { useUi } from '@/stores/ui';
import { freshPinia, startApi, testRouter, until, type TestApi } from '@/test/harness';
import ApprovalsBanner from './ApprovalsBanner.vue';

let api: TestApi;
let wrapper: VueWrapper | undefined;
let opened: string[] = [];
let instances: NodeEventSource[] = [];
let fetched: string[] = [];
const nativeEventSource = (globalThis as { EventSource?: unknown }).EventSource;

/** `EventSource` real al que se le antepone la URL del servidor del test a las rutas relativas (como el navegador). */
class TestEventSource extends NodeEventSource {
  constructor(url: string | URL, init?: ConstructorParameters<typeof NodeEventSource>[1]) {
    super(typeof url === 'string' && url.startsWith('/') ? `${api.url}${url}` : url, init);
    opened.push(String(url));
    instances.push(this);
  }
}

beforeEach(async () => {
  opened = [];
  instances = [];
  fetched = [];
  api = await startApi();
  const inner = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    fetched.push(String(input));
    return inner(input, init);
  }) as typeof fetch;
  (globalThis as { EventSource?: unknown }).EventSource = TestEventSource;
});
afterEach(async () => {
  wrapper?.unmount();
  wrapper = undefined;
  for (const source of instances) source.close();
  (globalThis as { EventSource?: unknown }).EventSource = nativeEventSource;
  document.body.innerHTML = '';
  await api.close();
});

/** Lanza un workflow que se detiene en un nodo de aprobación. */
function startApproval(name: string) {
  const wf = api.ctx.store.createWorkflow({ ...workflow([node('e', 'input'), node('a', 'approval', { message: '¿Publicamos?' })], edges('e>a')), name });
  return api.ctx.runs.startWorkflowRun(wf, 'nota');
}
/** Espera a que el canal esté abierto y haya entregado su primera lista (la que no se anuncia). */
async function connected(): Promise<void> {
  await until(() => instances[0]?.readyState === 1);
  await new Promise((r) => setTimeout(r, 150));
}
const pendingCount = () => api.ctx.store.listApprovals({ pendingOnly: true }).length;

function mountBanner(): VueWrapper {
  const pinia = freshPinia();
  wrapper = mount(ApprovalsBanner, { global: { plugins: [pinia, testRouter()] }, attachTo: document.body });
  return wrapper;
}

describe('ApprovalsBanner', () => {
  it('usa el canal de aprobaciones y no vuelve a pedir la lista con los eventos de ejecución', async () => {
    const view = mountBanner();
    await until(() => opened.includes('/api/stream/approvals'));
    await new Promise((r) => setTimeout(r, 100));
    expect(view.find('section').exists()).toBe(false);
    expect(fetched.filter((u) => u.startsWith('/api/approvals'))).toEqual([]);

    // Un evento de ejecución cualquiera (antes provocaba `GET /api/approvals`) ya no pregunta nada.
    const runs = useRuns();
    runs.apply({ id: 'r1', status: 'running' } as never);
    runs.apply({ id: 'r1', status: 'running' } as never);
    await new Promise((r) => setTimeout(r, 400));
    expect(fetched.filter((u) => u.startsWith('/api/approvals'))).toEqual([]);
  });

  it('muestra las que ya esperaban al abrir la página, sin avisos añadidos', async () => {
    const run = startApproval('Revisión previa');
    await until(() => pendingCount() === 1);
    const view = mountBanner();
    await until(() => view.find('section').exists());
    expect(view.text()).toContain('Revisión previa');
    expect(view.find('a.run').attributes('href')).toBe(`/runs/${run.id}`);
    expect(useUi().toasts).toEqual([]);
  });

  it('una aprobación nueva aparece sola, se anuncia y genera un aviso con enlace a la ejecución', async () => {
    const view = mountBanner();
    await connected();
    const run = startApproval('Revisión nueva');
    await until(() => view.find('section').exists());

    const toasts = useUi().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({ tone: 'info', message: '«Revisión nueva» espera tu decisión.', action: { label: 'Decidir', to: `/runs/${run.id}` } });
    await until(() => announcement.value === '«Revisión nueva» espera tu decisión.');
  });

  it('decidir la retira de la lista', async () => {
    const view = mountBanner();
    await connected();
    startApproval('Revisión');
    await until(() => view.find('section').exists());

    await view
      .findAll('button')
      .find((b) => b.text().includes('Aprobar'))!
      .trigger('click');
    await until(() => !view.find('section').exists());
    expect(pendingCount()).toBe(0);
  });
});
