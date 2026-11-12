// @vitest-environment jsdom
// Store de ejecuciones en vivo contra el canal SSE real `/api/stream/runs`: el `EventSource` es el paquete
// `eventsource` (protocolo real) y el único doble es el proveedor LLM (ver src/test/harness.ts).
import type { Run, RunSummary } from '@shared/types';
import { EventSource as NodeEventSource } from 'eventsource';
import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addAgent, userText } from '../../../server/test/helpers';
import { freshPinia, startApi, until, type TestApi } from '@/test/harness';
import { useRuns } from './runs';
import { useUi } from './ui';

let api: TestApi;
let release: () => void;
let gate: Promise<void>;
/** Direcciones a las que se conectó la interfaz y conexiones vivas (para cerrarlas al terminar el test). */
let opened: string[] = [];
let instances: NodeEventSource[] = [];
/** Dirección a la que apuntan las rutas relativas; por defecto, la API del test. */
let base: string | null = null;
const nativeEventSource = (globalThis as { EventSource?: unknown }).EventSource;

/** `EventSource` real al que se le antepone la URL del servidor del test a las rutas relativas (como el navegador). */
class TestEventSource extends NodeEventSource {
  constructor(url: string | URL, init?: ConstructorParameters<typeof NodeEventSource>[1]) {
    super(typeof url === 'string' && url.startsWith('/') ? `${base ?? api.url}${url}` : url, init);
    opened.push(String(url));
    instances.push(this);
  }
}

/** Proveedor: «lento» espera a `release()` (o a que se cancele), «falla» lanza un error, el resto responde. */
async function script(req: Parameters<Parameters<typeof startApi>[0] & object>[0]) {
  const input = userText(req);
  if (input.includes('falla')) throw new Error('proveedor caído');
  if (input.includes('lento')) {
    await Promise.race([gate, new Promise<void>((res) => req.signal?.addEventListener('abort', () => res()))]);
    if (req.signal?.aborted) throw req.signal.reason;
  }
  return { content: `final ${input}` };
}

/** Lanza una ejecución de un agente sin reintentos. */
const start = (input: string): Run => api.ctx.runs.startAgentRun(addAgent(api.ctx, { name: 'Resumidor' }), input, { defaultRetries: 0 });
const summary = (id: string): RunSummary => api.ctx.store.getRunSummary(id)!;
const toasts = () => useUi().toasts.map((t) => ({ tone: t.tone, message: t.message, to: t.action?.to }));

beforeEach(async () => {
  freshPinia();
  opened = [];
  instances = [];
  base = null;
  gate = new Promise<void>((res) => (release = res));
  api = await startApi(script);
  (globalThis as { EventSource?: unknown }).EventSource = TestEventSource;
});
afterEach(async () => {
  release();
  for (const source of instances) source.close();
  (globalThis as { EventSource?: unknown }).EventSource = nativeEventSource;
  await api.close();
});

describe('conexión con el canal de ejecuciones', () => {
  it('connect() abre una sola conexión, queda «conectado» y recibe las ejecuciones activas que lanza el servidor', async () => {
    const runs = useRuns();
    expect(runs.connected).toBe(false);
    runs.connect();
    runs.connect(); // idempotente
    await until(() => runs.connected);
    expect(opened).toEqual(['/api/stream/runs']);

    const run = start('lento uno');
    await until(() => runs.known.has(run.id));
    expect(runs.active.map((r) => r.id)).toEqual([run.id]);
    expect(['queued', 'running']).toContain(runs.known.get(run.id)!.status);
    expect(runs.lastChanged?.id).toBe(run.id);
    expect(runs.version).toBeGreaterThan(0);
  });

  it('al terminar la ejecución sale de las activas y se conserva solo lo que sigue vivo', async () => {
    const runs = useRuns();
    runs.connect();
    await until(() => runs.connected);
    const run = start('lento uno');
    await until(() => runs.known.has(run.id));

    release();
    await api.ctx.runs.waitFor(run.id);
    await until(() => !runs.known.has(run.id));
    expect(runs.active).toEqual([]);
    expect(runs.lastChanged).toMatchObject({ id: run.id, status: 'completed' });
  });

  it('pasa a «sin conexión» cuando se cae el servidor y vuelve a «conectado» cuando EventSource reconecta', async () => {
    // Reenviador TCP real entre la interfaz y la API para poder cortar la conexión sin parar el servidor.
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
      const runs = useRuns();
      runs.connect();
      await until(() => runs.connected);

      for (const s of sockets) s.destroy();
      await until(() => !runs.connected);
      // El servidor retoma la conversación (`retry: 2000`) y el estado vuelve a «conectado».
      await until(() => runs.connected, 8000);
    } finally {
      for (const s of sockets) s.destroy();
      proxy.close();
    }
  }, 15_000);
});

describe('avisos al terminar una ejecución', () => {
  it('avisa con enlace cuando termina bien una ejecución que no se está mirando', async () => {
    const runs = useRuns();
    runs.connect();
    await until(() => runs.connected);
    const run = start('lento uno');
    await until(() => runs.known.has(run.id));
    expect(toasts()).toEqual([]);

    release();
    await until(() => toasts().length === 1);
    expect(toasts()).toEqual([{ tone: 'success', message: '«Resumidor» ha terminado.', to: `/runs/${run.id}` }]);
  });

  it('avisa como error cuando falla una ejecución que no se está mirando', async () => {
    const runs = useRuns();
    runs.connect();
    await until(() => runs.connected);
    const run = start('falla uno');

    await until(() => toasts().length === 1);
    expect(toasts()).toEqual([{ tone: 'danger', message: '«Resumidor» ha fallado.', to: `/runs/${run.id}` }]);
    expect(api.ctx.store.getRun(run.id)!.status).toBe('failed');
  });

  it('no avisa de la ejecución que se está mirando, y sí de otra', async () => {
    const runs = useRuns();
    runs.connect();
    await until(() => runs.connected);
    const watched = start('lento visto');
    const other = start('lento otra');
    await until(() => runs.known.has(watched.id) && runs.known.has(other.id));
    runs.watching = watched.id;

    release();
    await Promise.all([api.ctx.runs.waitFor(watched.id), api.ctx.runs.waitFor(other.id)]);
    await until(() => !runs.known.has(watched.id) && !runs.known.has(other.id));
    expect(toasts().map((t) => t.to)).toEqual([`/runs/${other.id}`]);
  });

  it('una ejecución cancelada no genera aviso', async () => {
    const runs = useRuns();
    runs.connect();
    await until(() => runs.connected);
    const run = start('lento uno');
    await until(() => runs.known.has(run.id));

    api.ctx.runs.cancel(run.id);
    await until(() => !runs.known.has(run.id));
    expect(summary(run.id).status).toBe('cancelled');
    expect(toasts()).toEqual([]);
  });
});

describe('apply, seed y forget', () => {
  it('apply registra altas y cambios mientras la ejecución sigue viva y la retira al terminar', async () => {
    const runs = useRuns();
    const run = start('lento uno');
    const queued = { ...summary(run.id), status: 'queued' as const };
    const running = { ...queued, status: 'running' as const };

    runs.apply(queued);
    expect(runs.known.get(run.id)!.status).toBe('queued');
    const afterFirst = runs.version;
    runs.apply(running);
    expect(runs.known.get(run.id)!.status).toBe('running');
    expect(runs.active).toHaveLength(1);
    expect(runs.lastChanged).toEqual(running);
    expect(runs.version).toBe(afterFirst + 1);

    release();
    await api.ctx.runs.waitFor(run.id);
    runs.apply(summary(run.id));
    expect(runs.known.has(run.id)).toBe(false);
    expect(runs.active).toEqual([]);
    expect(toasts()).toEqual([{ tone: 'success', message: '«Resumidor» ha terminado.', to: `/runs/${run.id}` }]);
  });

  it('apply con notify=false no avisa, y una ejecución terminada que no se conocía tampoco avisa', async () => {
    const runs = useRuns();
    const run = start('lento uno');
    runs.apply({ ...summary(run.id), status: 'running' });
    release();
    await api.ctx.runs.waitFor(run.id);
    runs.apply(summary(run.id), false);
    expect(runs.known.has(run.id)).toBe(false);
    expect(toasts()).toEqual([]);

    // Una ejecución que llega ya terminada (nunca se vio activa) no es un «ha terminado» para el usuario.
    const done = start('ya hecha');
    await api.ctx.runs.waitFor(done.id);
    runs.apply(summary(done.id));
    expect(toasts()).toEqual([]);
  });

  it('seed solo registra las activas, y forget las olvida y avisa a las vistas con la versión', async () => {
    const runs = useRuns();
    const slow = start('lento uno');
    const done = start('ya hecha');
    await api.ctx.runs.waitFor(done.id);
    const before = runs.version;

    runs.seed([summary(slow.id), summary(done.id)]);
    expect([...runs.known.keys()]).toEqual([slow.id]);
    expect(runs.version).toBe(before); // sembrar no es un cambio que las vistas deban refrescar

    runs.forget(slow.id);
    expect(runs.known.has(slow.id)).toBe(false);
    expect(runs.active).toEqual([]);
    expect(runs.version).toBe(before + 1);
    runs.forget('no-existe'); // olvidar lo que no se conoce no falla
    expect(runs.version).toBe(before + 2);
  });
});
