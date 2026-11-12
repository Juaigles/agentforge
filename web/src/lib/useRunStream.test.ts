// @vitest-environment jsdom
// Seguimiento en vivo de una ejecución (useRunStream + run-state) contra la API real: el flujo SSE lo habla un
// `EventSource` de verdad (paquete `eventsource`) y el único doble es el proveedor LLM (ver src/test/harness.ts).
import type { Run } from '@shared/types';
import { mount, type VueWrapper } from '@vue/test-utils';
import { EventSource as NodeEventSource } from 'eventsource';
import type { EventEmitter } from 'node:events';
import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defineComponent, h, toRef } from 'vue';
import { addAgent, edges, node, userText, workflow } from '../../../server/test/helpers';
import { api as client } from '@/lib/api';
import { freshPinia, startApi, until, type TestApi } from '@/test/harness';
import type { RunLive } from './run-state';
import { useRunStream } from './useRunStream';

let api: TestApi;
let wrapper: VueWrapper | undefined;
let release: () => void;
let gate: Promise<void>;
/** Conexiones SSE abiertas por la interfaz durante el test (el servidor las ve igual que un navegador). */
let opened: string[] = [];
/** Dirección a la que apuntan las rutas relativas; por defecto, la API del test. */
let base: string | null = null;
const nativeEventSource = (globalThis as { EventSource?: unknown }).EventSource;

/** `EventSource` real al que se le antepone la URL del servidor del test a las rutas relativas (como el navegador). */
class TestEventSource extends NodeEventSource {
  constructor(url: string | URL, init?: ConstructorParameters<typeof NodeEventSource>[1]) {
    const full = typeof url === 'string' && url.startsWith('/') ? `${base ?? api.url}${url}` : url;
    super(full, init);
    opened.push(String(url));
  }
}

/** Proveedor lento: las entradas con «lento» emiten un fragmento y esperan a `release()` (o a que se cancele). */
async function script(req: Parameters<Parameters<typeof startApi>[0] & object>[0]) {
  const input = userText(req);
  // Un agente con herramientas pide primero la calculadora; la respuesta (y la espera) llegan con su resultado.
  if (req.tools?.length && req.messages.at(-1)?.role !== 'tool') return { toolCalls: [{ id: 'c1', name: 'calculator', arguments: { expression: '1+1' } }] };
  if (input.includes('lento')) {
    req.onDelta?.('parte uno ');
    await Promise.race([gate, new Promise<void>((res) => req.signal?.addEventListener('abort', () => res()))]);
    if (req.signal?.aborted) throw req.signal.reason;
  }
  return { content: `final ${input}` };
}

const Probe = defineComponent({
  props: { runId: { type: String as () => string | null, default: null } },
  setup(props) {
    return useRunStream(toRef(props, 'runId'));
  },
  render: () => h('div'),
});

interface Stream {
  run: Run | null;
  live: RunLive | null;
  error: string | null;
  loading: boolean;
  isActive: boolean;
  hasOlder: boolean;
  loadingOlder: boolean;
  reload(): Promise<void>;
  loadOlder(): Promise<void>;
}
const stream = () => wrapper!.vm as unknown as Stream;
const subscribers = (runId: string) => (api.ctx.runs as unknown as { emitter: EventEmitter }).emitter.listenerCount(`run:${runId}`);
const open = (runId: string | null) => (wrapper = mount(Probe, { props: { runId } }));

/** Ejecución de un workflow agente → salida, con el prompt «Resume: {{input}}». */
function startWorkflow(input: string): Run {
  const agent = addAgent(api.ctx);
  const wf = api.ctx.store.createWorkflow(
    workflow([node('a', 'agent', { agentId: agent.id, prompt: 'Resume: {{input}}' }), node('out', 'output')], edges('a>out')),
  );
  return api.ctx.runs.startWorkflowRun(wf, input);
}

beforeEach(async () => {
  freshPinia();
  opened = [];
  gate = new Promise<void>((res) => (release = res));
  api = await startApi(script);
  (globalThis as { EventSource?: unknown }).EventSource = TestEventSource;
});
afterEach(async () => {
  release();
  wrapper?.unmount();
  wrapper = undefined;
  (globalThis as { EventSource?: unknown }).EventSource = nativeEventSource;
  await api.close();
});

describe('useRunStream: ejecuciones terminadas', () => {
  it('carga una ejecución terminada con sus pasos, salida y eventos, sin abrir ningún flujo', async () => {
    const run = startWorkflow('Ana');
    await api.ctx.runs.waitFor(run.id);
    open(run.id);
    await until(() => stream().live !== null);

    const { live } = stream();
    expect(live!.status).toBe('completed');
    expect(live!.order).toEqual(['a', 'out']);
    expect(live!.steps.a.status).toBe('completed');
    expect(live!.steps.a.input).toBe('Resume: Ana');
    expect(live!.steps.a.output).toBe('final Resume: Ana');
    expect(live!.output).toBe('final Resume: Ana');
    expect(live!.activity.items.map((i) => i.kind === 'marker' && i.text)).toEqual(
      expect.arrayContaining(['Ejecución iniciada', 'Paso iniciado', 'Paso completado', 'Ejecución completada']),
    );
    expect(live!.lastSeq).toBe(api.ctx.store.lastEventSeq(run.id));
    // Una ejecución corta cabe en la primera página: no queda nada anterior por cargar.
    expect(live!.activity.firstSeq).toBe(1);
    expect(stream().hasOlder).toBe(false);
    expect(stream().run?.id).toBe(run.id);
    expect(stream().isActive).toBe(false);
    expect(stream().loading).toBe(false);
    expect(stream().error).toBeNull();
    // Ni el cliente abrió una conexión SSE ni el servidor tiene a nadie suscrito.
    expect(opened).toEqual([]);
    expect(subscribers(run.id)).toBe(0);
  });
});

describe('useRunStream: ejecuciones en curso', () => {
  it('sigue la ejecución en directo: texto en streaming, y al terminar la salida y la entrada renderizada de cada paso', async () => {
    const run = startWorkflow('lento Ana');
    open(run.id);
    await until(() => stream().live !== null);
    // Desde el primer instante se parte de «en cola» o «en curso», nunca de un estado terminado.
    expect(['queued', 'running']).toContain(stream().live!.status);
    expect(stream().isActive).toBe(true);
    // El flujo se abre a partir del último evento que ya recoge el estado recibido, no desde el principio.
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatch(new RegExp(`^/api/runs/${run.id}/stream\\?after=\\d+$`));

    await until(() => stream().live!.steps.a.streamText.includes('parte uno'));
    expect(stream().live!.status).toBe('running');
    expect(stream().live!.steps.a.status).toBe('running');
    expect(stream().live!.steps.out.status).toBe('pending');
    expect(subscribers(run.id)).toBe(1);

    release();
    await until(() => stream().live!.status === 'completed');
    await until(() => stream().live!.steps.a.input !== null && stream().live!.output !== null);
    const { live } = stream();
    expect(live!.steps.a.status).toBe('completed');
    expect(live!.steps.a.input).toBe('Resume: lento Ana');
    expect(live!.steps.a.output).toBe('final Resume: lento Ana');
    expect(live!.steps.a.streamText).toBe('');
    expect(live!.steps.out.status).toBe('completed');
    expect(live!.output).toBe('final Resume: lento Ana');
    expect(live!.steps.a.usage.llmCalls).toBe(1);
    expect(stream().isActive).toBe(false);
    // Coincide con lo guardado por el servidor y la conexión se cierra al terminar.
    expect(live!.output).toBe(api.ctx.store.getRun(run.id)!.output);
    await until(() => subscribers(run.id) === 0);
  });

  it('cancelar a mitad deja la ejecución en «cancelled» conservando el texto parcial que se vio', async () => {
    const run = startWorkflow('lento Ana');
    open(run.id);
    await until(() => stream().live?.steps.a.streamText.includes('parte uno') ?? false);

    await client.runs.cancel(run.id);
    await until(() => stream().run?.status === 'cancelled' && stream().live?.status === 'cancelled');
    const { live } = stream();
    expect(live!.steps.a.status).toBe('cancelled');
    expect(live!.steps.a.output).toBeNull();
    expect(live!.steps.a.streamText).toContain('parte uno');
    expect(live!.output).toBeNull();
    expect(stream().isActive).toBe(false);
    await until(() => subscribers(run.id) === 0);
  });

  it('reload() vuelve a cargar la ejecución sin dejar conexiones duplicadas y recupera el texto parcial', async () => {
    const run = startWorkflow('lento Ana');
    open(run.id);
    await until(() => stream().live?.steps.a.streamText.includes('parte uno') ?? false);

    await stream().reload();
    expect(opened).toHaveLength(2);
    await until(() => stream().live?.steps.a.streamText.includes('parte uno') ?? false);
    // La conexión anterior se cerró: el servidor tiene un único suscriptor.
    await until(() => subscribers(run.id) === 1);

    release();
    await until(() => stream().live!.status === 'completed' && stream().live!.output !== null);
    // Con la ejecución ya terminada, recargar lee el estado final sin abrir otro flujo.
    await stream().reload();
    expect(opened).toHaveLength(2);
    expect(stream().live!.output).toBe('final Resume: lento Ana');
  });

  it('al desmontar el componente se cierra la conexión y dejan de llegar eventos al estado', async () => {
    const run = startWorkflow('lento Ana');
    open(run.id);
    await until(() => subscribers(run.id) === 1);
    await until(() => stream().live?.steps.a.streamText.includes('parte uno') ?? false);
    const { live } = stream();

    wrapper!.unmount();
    wrapper = undefined;
    await until(() => subscribers(run.id) === 0);

    release();
    await api.ctx.runs.waitFor(run.id);
    await new Promise((r) => setTimeout(r, 300));
    // El estado que se quedó atrás no se movió: ni run.finished ni el refresco de datos le llegaron.
    expect(live!.status).toBe('running');
    expect(live!.output).toBeNull();
  });
});

describe('useRunStream: ejecuciones largas', () => {
  /** Peticiones REST que hace la interfaz mientras dura el test. */
  function recordRequests(): { urls: string[]; restore(): void } {
    const inner = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      urls.push(String(input));
      return inner(input, init);
    }) as typeof fetch;
    return { urls, restore: () => (globalThis.fetch = inner) };
  }

  it('de una ejecución terminada con cientos de eventos solo trae la última página; lo anterior, a petición', async () => {
    const run = startWorkflow('Ana');
    await api.ctx.runs.waitFor(run.id);
    // Se alarga el historial por la misma vía que el motor (el almacén): 450 eventos en total.
    for (let seq = api.ctx.store.lastEventSeq(run.id) + 1; seq <= 450; seq++) {
      api.ctx.store.appendEvent(run.id, 'llm.message', 'a', { agent: `M${seq}`, content: 'x' });
    }
    const requests = recordRequests();
    try {
      open(run.id);
      await until(() => stream().live !== null);
      const { live } = stream();
      expect(requests.urls).toEqual([`/api/runs/${run.id}`, `/api/runs/${run.id}/events?before=451&limit=200`]);
      // El estado de los pasos es el del servidor, no el resultado de reproducir eventos.
      expect(live!.status).toBe('completed');
      expect(live!.steps.a).toMatchObject({ status: 'completed', output: 'final Resume: Ana' });
      expect(live!.lastSeq).toBe(450);
      expect(live!.activity.items).toHaveLength(200);
      expect(live!.activity.firstSeq).toBe(251);
      expect(stream().hasOlder).toBe(true);

      await stream().loadOlder();
      expect(requests.urls.at(-1)).toBe(`/api/runs/${run.id}/events?before=251&limit=200`);
      expect(live!.activity.items).toHaveLength(400);
      expect(live!.activity.firstSeq).toBe(51);
      expect(stream().hasOlder).toBe(true);

      await stream().loadOlder();
      expect(requests.urls.at(-1)).toBe(`/api/runs/${run.id}/events?before=51&limit=200`);
      expect(live!.activity.firstSeq).toBe(1);
      expect(stream().hasOlder).toBe(false);
      expect(stream().loadingOlder).toBe(false);
      // Entero y en orden: los eventos sin entrada propia (p. ej. `llm.start`) no cuentan.
      const keys = live!.activity.items.map((i) => Number(i.key.slice(1)));
      expect(keys).toEqual([...keys].sort((x, y) => x - y));
      expect(keys.at(-1)).toBe(450);
      expect(live!.activity.items[0]).toMatchObject({ kind: 'marker', text: 'Ejecución iniciada' });

      // Sin nada más antiguo, pedirlo otra vez no hace ninguna petición.
      const count = requests.urls.length;
      await stream().loadOlder();
      expect(requests.urls).toHaveLength(count);
      expect(opened).toEqual([]);
    } finally {
      requests.restore();
    }
  });

  it('abrir una ejecución a medias parte del estado del servidor (pasos, consumo) y sigue el flujo desde su último evento', async () => {
    const agent = addAgent(api.ctx, { tools: ['calculator'] });
    const wf = api.ctx.store.createWorkflow(
      workflow([node('in', 'input'), node('a', 'agent', { agentId: agent.id, prompt: 'lento {{input}}' }), node('out', 'output')], edges('in>a', 'a>out')),
    );
    const run = api.ctx.runs.startWorkflowRun(wf, 'Ana');
    // El agente ya ha usado la calculadora y espera la segunda respuesta del modelo.
    await until(() => api.ctx.store.listEvents(run.id).some((e) => e.type === 'tool.result'));
    await new Promise((r) => setTimeout(r, 50));
    const seen = api.ctx.store.lastEventSeq(run.id);

    open(run.id);
    await until(() => stream().live !== null);
    // Nada más cargar, sin esperar a ningún evento: el paso de entrada terminado y el agente en curso con su consumo.
    const { live } = stream();
    expect(live!.status).toBe('running');
    expect(live!.steps.in).toMatchObject({ status: 'completed', output: 'Ana' });
    expect(live!.steps.a).toMatchObject({ status: 'running', attempt: 1, input: 'lento Ana' });
    expect(live!.steps.a.usage).toEqual({ promptTokens: 10, completionTokens: 5, llmCalls: 1, toolCalls: 1 });
    expect(live!.steps.out.status).toBe('pending');
    expect(live!.lastSeq).toBe(seen);
    expect(opened).toEqual([`/api/runs/${run.id}/stream?after=${seen}`]);
    // El registro de actividad trae lo ya ocurrido, con la llamada emparejada con su resultado.
    expect(live!.activity.items.find((i) => i.kind === 'tool')).toMatchObject({ name: 'calculator', pending: false, ok: true });
    // Y el texto que el modelo llevaba escrito llega con la conexión.
    await until(() => stream().live!.steps.a.streamText.includes('parte uno'));

    release();
    await until(() => stream().live!.status === 'completed' && stream().live!.output !== null);
    expect(stream().live!.steps.a.usage).toEqual({ promptTokens: 20, completionTokens: 10, llmCalls: 2, toolCalls: 1 });
    expect(stream().live!.steps.out.status).toBe('completed');
    expect(stream().live!.output).toBe('final lento Ana');
    // Cada evento guardado se aplicó una sola vez: el registro no repite entradas.
    const keys = stream().live!.activity.items.map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(stream().live!.lastSeq).toBe(api.ctx.store.lastEventSeq(run.id));
  });
});

describe('useRunStream: errores y cambios de ejecución', () => {
  it('una ejecución que no existe rellena `error` y deja run y live a null', async () => {
    open('no-existe');
    await until(() => stream().error !== null);
    expect(stream().error).toMatch(/no encontrada/i);
    expect(stream().run).toBeNull();
    expect(stream().live).toBeNull();
    expect(stream().loading).toBe(false);
    expect(stream().isActive).toBe(false);
    expect(opened).toEqual([]);
  });

  it('cambiar el id dos veces seguidas deja el estado de la última ejecución (no gana la respuesta más lenta)', async () => {
    const a = api.ctx.runs.startAgentRun(addAgent(api.ctx), 'A');
    const b = api.ctx.runs.startAgentRun(addAgent(api.ctx), 'B');
    const c = api.ctx.runs.startAgentRun(addAgent(api.ctx), 'C');
    await Promise.all([a, b, c].map((r) => api.ctx.runs.waitFor(r.id)));

    open(a.id);
    await wrapper!.setProps({ runId: b.id });
    await wrapper!.setProps({ runId: c.id });
    await until(() => stream().live?.output === 'final C');
    await new Promise((r) => setTimeout(r, 100));
    expect(stream().run?.id).toBe(c.id);
    expect(stream().live!.output).toBe('final C');
    expect(stream().loading).toBe(false);
    expect(stream().error).toBeNull();
  });

  it('al cambiar de una ejecución en curso a otra, cierra la conexión anterior y lo que le pase después no afecta al estado', async () => {
    const slow = api.ctx.runs.startAgentRun(addAgent(api.ctx), 'lento A');
    const quick = api.ctx.runs.startAgentRun(addAgent(api.ctx), 'B');
    await api.ctx.runs.waitFor(quick.id);

    open(slow.id);
    await until(() => stream().live?.steps.agent.streamText.includes('parte uno') ?? false);
    await wrapper!.setProps({ runId: quick.id });
    await until(() => stream().live?.output === 'final B');
    await until(() => subscribers(slow.id) === 0);

    release();
    await api.ctx.runs.waitFor(slow.id);
    await new Promise((r) => setTimeout(r, 300));
    expect(stream().run?.id).toBe(quick.id);
    expect(stream().live!.output).toBe('final B');
  });

  it('con el id a null limpia el estado y cierra la conexión', async () => {
    const run = startWorkflow('lento Ana');
    open(run.id);
    await until(() => stream().live?.steps.a.streamText.includes('parte uno') ?? false);

    await wrapper!.setProps({ runId: null });
    expect(stream().run).toBeNull();
    expect(stream().live).toBeNull();
    await until(() => subscribers(run.id) === 0);
    await stream().reload(); // sin id no hay nada que recargar y no falla
    expect(stream().live).toBeNull();
  });
});

describe('useRunStream: cortes de conexión', () => {
  // Si se corta el flujo a mitad de la ejecución, `EventSource` reintenta en silencio y no llega ningún evento más.
  // La pantalla no debe quedarse «en curso» para siempre: al fallar el flujo se consulta el estado de la ejecución.
  // El corte lo hace un reenviador TCP real entre el navegador y la API (las peticiones REST siguen llegando).
  it('si se corta el flujo a mitad de la ejecución y esta termina, la pantalla se pone al día sin recargar', async () => {
    const sockets = new Set<net.Socket>();
    const proxy = net.createServer((client) => {
      const target = net.connect(Number(new URL(api.url).port), '127.0.0.1');
      sockets.add(client).add(target);
      client.pipe(target).pipe(client);
      for (const s of [client, target]) s.on('error', () => s.destroy());
    });
    await new Promise<void>((res) => proxy.listen(0, '127.0.0.1', res));
    base = `http://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`;
    try {
      const run = api.ctx.runs.startAgentRun(addAgent(api.ctx), 'lento A');
      open(run.id);
      await until(() => stream().live?.steps.agent.streamText.includes('parte uno') ?? false);
      expect(stream().isActive).toBe(true);
      // Se deja pasar el refresco que programa «step.started» (250 ms): es lo único que podría poner al día la pantalla.
      await new Promise((r) => setTimeout(r, 400));

      // Se corta el flujo y se cierra el reenviador: no hay forma de volver a conectar.
      for (const s of sockets) s.destroy();
      await new Promise<void>((res) => proxy.close(() => res()));
      release();
      await api.ctx.runs.waitFor(run.id);
      expect(api.ctx.store.getRun(run.id)!.status).toBe('completed');

      await until(() => stream().live?.status === 'completed', 5000);
      expect(stream().error).toBeNull();
      expect(stream().isActive).toBe(false);
      expect(stream().live!.output).toBe('final lento A');
      expect(stream().run!.status).toBe('completed');
      // Lo ocurrido con el flujo cortado también llega al registro de actividad.
      await until(() => stream().live!.activity.items.some((i) => i.kind === 'marker' && i.text === 'Ejecución completada'));
    } finally {
      for (const s of sockets) s.destroy();
      proxy.close();
      base = null;
    }
  });
});
