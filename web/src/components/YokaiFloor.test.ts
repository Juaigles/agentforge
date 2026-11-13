// @vitest-environment jsdom
import type { Agent, NodeType, RunSnapshot, RunStatus, StepStatus, WorkflowNode } from '@shared/types';
import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivityLog, RunLive, StepLive } from '@/lib/run-state';
import { PLAN_SIZE } from '@/lib/yokai/assets';
import { ROOMS, seatFor } from '@/lib/yokai/map';
import type { Point } from '@/lib/yokai/types';
import { freshPinia } from '@/test/harness';
import YokaiFloor from './YokaiFloor.vue';
import YokaiSprite from './YokaiSprite.vue';

// ---------- Datos de prueba (como en choreography.test.ts) ----------
const usage = { promptTokens: 0, completionTokens: 0, llmCalls: 0, toolCalls: 0 };
const emptyLog = (): ActivityLog => ({ items: [], firstSeq: 0, counts: {}, openTools: {}, orphanResults: {} });
const node = (id: string, type: NodeType, config: Record<string, unknown> = {}): WorkflowNode => ({ id, type, label: id, position: { x: 0, y: 0 }, config });
const agentNode = (id: string, agentId: string): WorkflowNode => node(id, 'agent', { agentId, prompt: 'p' });
const agent = (id: string, color: string): Agent => ({ id, name: `Agente ${id}`, color }) as unknown as Agent;

const WF: RunSnapshot = {
  workflow: {
    nodes: [node('in', 'input'), agentNode('a1', 'ana'), agentNode('a2', 'bo'), node('t', 'tool', { tool: 'x' }), node('out', 'output')],
    edges: [],
    settings: { maxConcurrency: 1, maxDurationMs: 1, maxLlmCalls: 1, onError: 'fail', defaultRetries: 0 },
  },
  agents: { ana: agent('ana', '#ff0000'), bo: agent('bo', '#00ff00') },
};

function live(status: RunStatus, init: Record<string, { status: StepStatus; startedAt?: string }> = {}): RunLive {
  const steps: Record<string, StepLive> = {};
  for (const n of WF.workflow.nodes) {
    const i = init[n.id];
    steps[n.id] = {
      runId: 'r1',
      nodeId: n.id,
      nodeType: n.type,
      label: n.label,
      agentId: (n.config.agentId as string) ?? null,
      status: i?.status ?? 'pending',
      attempt: 1,
      input: null,
      output: null,
      error: null,
      usage: { ...usage },
      startedAt: i?.startedAt ?? null,
      finishedAt: null,
      streamText: '',
      thinkingText: '',
    };
  }
  return {
    status,
    output: null,
    error: null,
    errorI18n: null,
    startedAt: null,
    finishedAt: null,
    steps,
    order: WF.workflow.nodes.map((n) => n.id),
    activity: emptyLog(),
    lastSeq: 0,
    finalUsage: null,
  };
}
const ts = (s: number): string => `2026-01-01T00:00:${String(s).padStart(2, '0')}.000Z`;

// ---------- Utilidades ----------
let wrapper: VueWrapper | undefined;
function open(l: RunLive, selected: string | null = null): VueWrapper {
  wrapper = mount(YokaiFloor, { props: { snapshot: WF, live: l, selected }, attachTo: document.body });
  return wrapper;
}
const staffButtons = (w: VueWrapper) => w.findAll('.staff button');
/**
 * Posición pintada de un actor (la caja que va anclada a sus pies), de vuelta en píxeles de la planta y redondeada:
 * el estilo está en % y jsdom lo guarda con pocos decimales.
 */
function placed(w: VueWrapper, selector: string): Point {
  const el = w.get(selector).element as HTMLElement;
  const [x, y] = [...el.style.transform.matchAll(/(-?[\d.]+)%/g)].map((m) => Math.round((parseFloat(m[1]) / 100) * PLAN_SIZE));
  return { x, y };
}
const at = (p: Point): Point => ({ x: p.x, y: p.y });

/** requestAnimationFrame a mano: los fotogramas se ejecutan cuando el test quiere, con la hora que quiere. */
function fakeFrames() {
  let next = 1;
  const queue = new Map<number, FrameRequestCallback>();
  const request = vi.fn((cb: FrameRequestCallback) => {
    queue.set(next, cb);
    return next++;
  });
  const cancel = vi.fn((id: number) => void queue.delete(id));
  vi.stubGlobal('requestAnimationFrame', request);
  vi.stubGlobal('cancelAnimationFrame', cancel);
  return {
    request,
    cancel,
    pending: () => queue.size,
    /** Ejecuta los fotogramas pendientes con la hora dada (ms). */
    run(now: number) {
      const callbacks = [...queue.values()];
      queue.clear();
      callbacks.forEach((cb) => cb(now));
    },
  };
}

/** matchMedia de mentira con «reducir movimiento» activado o no (jsdom no lo trae). */
function setReducedMotion(on: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('prefers-reduced-motion') ? on : false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

const originalMatchMedia = window.matchMedia;
beforeEach(() => freshPinia());
afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  vi.unstubAllGlobals();
  window.matchMedia = originalMatchMedia;
  document.body.innerHTML = '';
});

describe('YokaiFloor: escena', () => {
  it('pinta un botón por agente del workflow y el mensajero, que no es interactivo', () => {
    const w = open(live('queued'));
    const buttons = staffButtons(w);
    expect(buttons).toHaveLength(2);
    expect(buttons.map((b) => b.attributes('aria-label'))).toEqual(['Agente ana — pendiente', 'Agente bo — pendiente']);
    expect(buttons.every((b) => b.attributes('type') === 'button')).toBe(true);
    expect(w.findAll('.staff .name').map((n) => n.text())).toEqual(['Agente ana', 'Agente bo']);

    const courier = w.get('.courier');
    expect(courier.attributes('aria-hidden')).toBe('true');
    expect(courier.find('button').exists()).toBe(false);
    expect(courier.getComponent(YokaiSprite).props('species')).toBe('ojo');
    // La hitodama va en su propia capa (para seguir al mensajero con inercia), decorativa.
    expect(w.get('.flame-layer').attributes('aria-hidden')).toBe('true');
    expect(w.find('.flame-layer .hitodama').exists()).toBe(true);
    // Todos llevan sombra a los pies.
    expect(w.findAll('.actor .shadow')).toHaveLength(3);

    expect(w.attributes('role')).toBe('group');
    expect(w.attributes('aria-label')).toBe('Planta de la oficina: recorrido de la ejecución');
    expect(w.findAll('.room-label')).toHaveLength(9);
    expect(w.findAll('.room-label').every((l) => l.attributes('aria-hidden') === 'true')).toBe(true);
  });

  it('cada yōkai empieza directamente en su puesto: la plantilla en la cocina, el mensajero en la recepción', () => {
    const w = open(live('queued'));
    expect(placed(w, '[data-key="a1"]')).toEqual(at(seatFor('cocina', 0)));
    expect(placed(w, '.courier')).toEqual(at(ROOMS.recepcion.anchor));
    expect(w.get('.sr-only').text()).toBe('El mensajero está en: Recepción');
  });

  it('el mensajero está en la sala del paso en curso', () => {
    const w = open(live('running', { t: { status: 'running', startedAt: ts(1) } }));
    expect(placed(w, '.courier')).toEqual(at(ROOMS.servidores.anchor));
    expect(w.get('.sr-only').text()).toBe('El mensajero está en: Servidores');
    // Al llegar muestra lo que hace (una herramienta) y mira hacia abajo.
    const sprite = w.get('.courier').getComponent(YokaiSprite);
    expect(sprite.props('activity')).toBe('tool');
    expect(sprite.props('facing')).toBe('down');
  });

  it('los de más abajo en la planta se pintan delante', () => {
    const w = open(live('running', { a1: { status: 'running', startedAt: ts(1) } }));
    const z = (sel: string) => Number((w.get(sel).element as HTMLElement).style.zIndex);
    // a1 en su cubículo (y = 490), a2 en la cocina (y = 972).
    expect(z('[data-key="a2"]')).toBeGreaterThan(z('[data-key="a1"]'));
  });
});

describe('YokaiFloor: selección', () => {
  it('clic en un yōkai emite su nodo; clic en el fondo, null', async () => {
    const w = open(live('queued'));
    await staffButtons(w)[1].trigger('click');
    expect(w.emitted('select')).toEqual([['a2']]);
    await w.get('.plan').trigger('click');
    expect(w.emitted('select')).toEqual([['a2'], [null]]);
  });

  it('aria-pressed y el anillo marcan al seleccionado', async () => {
    const w = open(live('queued'), 'a1');
    expect(staffButtons(w).map((b) => b.attributes('aria-pressed'))).toEqual(['true', 'false']);
    expect(w.get('[data-key="a1"]').classes()).toContain('selected');
    await w.setProps({ selected: 'a2' });
    expect(staffButtons(w).map((b) => b.attributes('aria-pressed'))).toEqual(['false', 'true']);
  });
});

describe('YokaiFloor: tamaño', () => {
  it('sin ResizeObserver no revienta y usa un ancho por defecto', () => {
    vi.stubGlobal('ResizeObserver', undefined);
    const w = open(live('queued'));
    expect(w.getComponent(YokaiSprite).props('size')).toBeGreaterThan(16);
  });

  it('con ResizeObserver escala los sprites y oculta los rótulos en una planta estrecha', async () => {
    let notify: ResizeObserverCallback = () => {};
    const disconnect = vi.fn();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: ResizeObserverCallback) {
          notify = cb;
        }
        observe() {}
        disconnect = disconnect;
      },
    );
    const w = open(live('queued'));
    const resize = async (width: number) => {
      notify([{ contentRect: { width } } as ResizeObserverEntry], {} as ResizeObserver);
      await w.vm.$nextTick();
    };
    await resize(PLAN_SIZE);
    expect(w.getComponent(YokaiSprite).props('size')).toBe(Math.round(128 * 0.85));
    expect(w.findAll('.room-label')).toHaveLength(9);
    await resize(360);
    expect(w.getComponent(YokaiSprite).props('size')).toBe(Math.round(128 * 0.85 * (360 / PLAN_SIZE)));
    expect(w.findAll('.room-label')).toHaveLength(0);
    w.unmount();
    wrapper = undefined;
    expect(disconnect).toHaveBeenCalled();
  });
});

describe('YokaiFloor: paseos', () => {
  it('al cambiar de sala camina por el camino con rAF, deja estela el mensajero y para el bucle al llegar', async () => {
    const frames = fakeFrames();
    const w = open(live('queued'));
    expect(frames.request).not.toHaveBeenCalled();

    await w.setProps({ live: live('running', { a1: { status: 'running', startedAt: ts(1) } }) });
    expect(frames.request).toHaveBeenCalledTimes(1);
    // Mientras camina no muestra la actividad y lleva el ciclo de pasos.
    const sprite = () => w.get('[data-key="a1"]').getComponent(YokaiSprite);
    expect(sprite().props('walking')).toBe(true);
    expect(sprite().props('activity')).toBeUndefined();
    // El mensajero también va de la recepción a los cubículos, con su estela de baldosas y el marcador del destino.
    expect(w.findAll('.trail rect').length).toBeGreaterThan(5);
    expect(w.find('.destination').exists()).toBe(true);

    frames.run(1000);
    frames.run(1050);
    await w.vm.$nextTick();
    const mid = placed(w, '[data-key="a1"]');
    expect(mid).not.toEqual(at(seatFor('cocina', 0)));
    expect(mid).not.toEqual(at(seatFor('cubiculos', 0)));

    // Fotogramas de 0,1 s hasta que llega (el camino más largo de la planta son unos pocos segundos).
    for (let now = 1150; frames.pending() && now < 60_000; now += 100) frames.run(now);
    await w.vm.$nextTick();
    expect(frames.pending()).toBe(0);
    expect(placed(w, '[data-key="a1"]')).toEqual(at(seatFor('cubiculos', 0)));
    expect(sprite().props('walking')).toBe(false);
    expect(sprite().props('facing')).toBe('down');
    expect(sprite().props('activity')).toBe('thinking');
    expect(w.find('.paths').exists()).toBe(false);
    expect(w.find('.destination').exists()).toBe(false);
  });

  it('si el destino cambia a mitad de paseo, sigue desde donde está', async () => {
    const frames = fakeFrames();
    const w = open(live('queued'));
    await w.setProps({ live: live('running', { a1: { status: 'running', startedAt: ts(1) } }) });
    frames.run(1000);
    frames.run(1100);
    await w.vm.$nextTick();
    const mid = placed(w, '[data-key="a1"]');
    await w.setProps({ live: live('running', { a1: { status: 'skipped' } }) });
    expect(placed(w, '[data-key="a1"]')).toEqual(mid);
    for (let now = 1200; frames.pending() && now < 60_000; now += 100) frames.run(now);
    await w.vm.$nextTick();
    expect(placed(w, '[data-key="a1"]')).toEqual(at(seatFor('cocina', 0)));
  });

  it('con «reducir movimiento» no hay bucle de rAF: salta al destino', async () => {
    setReducedMotion(true);
    const frames = fakeFrames();
    const w = open(live('queued'));
    await w.setProps({ live: live('running', { a1: { status: 'running', startedAt: ts(1) } }) });
    expect(frames.request).not.toHaveBeenCalled();
    expect(placed(w, '[data-key="a1"]')).toEqual(at(seatFor('cubiculos', 0)));
    const sprite = w.get('[data-key="a1"]').getComponent(YokaiSprite);
    expect(sprite.props('walking')).toBe(false);
    // El estado se sigue distinguiendo: la actividad y la etiqueta accesible.
    expect(sprite.props('activity')).toBe('thinking');
    expect(staffButtons(w)[0].attributes('aria-label')).toBe('Agente ana — en curso');
    expect(w.find('.paths').exists()).toBe(false);
    expect(w.find('.destination').exists()).toBe(false);
    // Los resaltados y el rótulo siguen ahí, quietos; no hay partículas al completar un paso.
    expect(w.get('.room-mark').attributes('data-room')).toBe('cubiculos');
    expect(w.get('.caption').text()).toContain('Paso 1 de 5');
    await w.setProps({ live: live('running', { a1: { status: 'completed', startedAt: ts(1) } }) });
    expect(w.findAll('.particle')).toHaveLength(0);
    expect(frames.request).not.toHaveBeenCalled();
    expect(w.classes()).toContain('is-reduced');
  });

  it('al desmontarse a mitad de paseo cancela el fotograma pendiente', async () => {
    const frames = fakeFrames();
    const w = open(live('queued'));
    await w.setProps({ live: live('running', { a1: { status: 'running', startedAt: ts(1) } }) });
    const id = frames.request.mock.results[0].value as number;
    w.unmount();
    wrapper = undefined;
    expect(frames.cancel).toHaveBeenCalledWith(id);
    expect(frames.pending()).toBe(0);
  });
});

/** Avanza fotogramas de 1/60 s hasta que el bucle se para (o hasta `limit` ms). */
function settle(frames: ReturnType<typeof fakeFrames>, from = 1000, limit = 60_000): void {
  for (let now = from; frames.pending() && now < limit; now += 1000 / 60) frames.run(now);
}

describe('YokaiFloor: paseo agradable', () => {
  it('sale despacio, acelera y frena al llegar (sin pasarse del destino)', async () => {
    const frames = fakeFrames();
    const w = open(live('queued'));
    await w.setProps({ live: live('running', { a1: { status: 'running', startedAt: ts(1) } }) });
    const end = at(seatFor('cubiculos', 0));
    const seen: Point[] = [];
    for (let now = 1000; frames.pending() && now < 60_000; now += 1000 / 60) {
      frames.run(now);
      await w.vm.$nextTick();
      seen.push(placed(w, '[data-key="a1"]'));
    }
    const steps = seen.map((p, i) => (i ? Math.hypot(p.x - seen[i - 1].x, p.y - seen[i - 1].y) : 0)).slice(2);
    const peak = Math.max(...steps);
    // Los primeros pasos son cortos comparados con el crucero, y los últimos también.
    expect(steps[0]).toBeLessThan(peak * 0.6);
    expect(steps.at(-2)!).toBeLessThan(peak * 0.6);
    expect(seen.at(-1)).toEqual(end);
  });

  it('al andar se balancea a saltos y suelta polvo; al llegar se queda quieto y el bucle para', async () => {
    const frames = fakeFrames();
    const w = open(live('queued'));
    await w.setProps({ live: live('running', { a1: { status: 'running', startedAt: ts(1) } }) });
    const lifts = new Set<string>();
    const sheetFrames = new Set<number | undefined>();
    let dust = 0;
    for (let now = 1000; now < 3000; now += 1000 / 60) {
      frames.run(now);
      await w.vm.$nextTick();
      lifts.add((w.get('[data-key="a1"] .lift').element as HTMLElement).style.transform);
      sheetFrames.add(w.get('[data-key="a1"]').getComponent(YokaiSprite).props('frame'));
      dust = Math.max(dust, w.findAll('.particle.is-dust').length);
    }
    expect(lifts.size).toBeGreaterThan(1);
    // El fotograma del sprite lo marca la distancia recorrida: pasa por los cuatro.
    expect([0, 1, 2, 3].every((f) => sheetFrames.has(f))).toBe(true);
    expect(dust).toBeGreaterThan(0);
    settle(frames, 3000);
    await w.vm.$nextTick();
    expect((w.get('[data-key="a1"] .lift').element as HTMLElement).style.transform).toBe('translateY(0px)');
    expect(w.get('[data-key="a1"]').getComponent(YokaiSprite).props('frame')).toBeUndefined();
    expect(frames.pending()).toBe(0);
    expect(w.findAll('.particle')).toHaveLength(0);
  });

  it('el fantasma mensajero flota y no deja polvo', async () => {
    const frames = fakeFrames();
    const w = open(live('queued'));
    expect(w.get('.courier .fx').classes()).toContain('float');
    expect(w.get('.courier .shadow').classes()).toContain('float');
    // Solo camina el mensajero (a los servidores): no aparece ni una mota.
    await w.setProps({ live: live('running', { t: { status: 'running', startedAt: ts(1) } }) });
    let dust = 0;
    for (let now = 1000; now < 3000; now += 1000 / 60) {
      frames.run(now);
      await w.vm.$nextTick();
      dust = Math.max(dust, w.findAll('.particle.is-dust').length);
    }
    expect(dust).toBe(0);
  });

  it('al terminar la ejecución la plantilla vuelve a la cocina en fila, no todos a la vez', async () => {
    const frames = fakeFrames();
    const w = open(live('running', { a1: { status: 'running', startedAt: ts(1) }, a2: { status: 'running', startedAt: ts(1) } }));
    await w.setProps({ live: live('completed', { a1: { status: 'completed', startedAt: ts(1) }, a2: { status: 'completed', startedAt: ts(1) } }) });
    frames.run(1000);
    frames.run(1150);
    await w.vm.$nextTick();
    const sprite = (key: string) => w.get(`[data-key="${key}"]`).getComponent(YokaiSprite);
    expect(sprite('a1').props('walking')).toBe(true);
    // El segundo aún espera su turno (y sigue mostrando que ha terminado).
    expect(sprite('a2').props('walking')).toBe(false);
    expect(sprite('a2').props('activity')).toBe('done');
    expect(placed(w, '[data-key="a2"]')).toEqual(at(seatFor('cubiculos', 1)));
    settle(frames, 1200);
    await w.vm.$nextTick();
    expect(placed(w, '[data-key="a2"]')).toEqual(at(seatFor('cocina', 1)));
  });
});

describe('YokaiFloor: feedback del recorrido', () => {
  const marks = (w: VueWrapper) => w.findAll('.room-mark').map((m) => [m.attributes('data-room'), m.classes().join(' ')]);
  const label = (w: VueWrapper, room: string) => w.get(`.room-label[data-room="${room}"]`).classes();

  it('resalta la sala del paso en curso y marca las de pasos hechos y fallidos en los rótulos', async () => {
    const w = open(live('running', { in: { status: 'completed', startedAt: ts(0) }, t: { status: 'running', startedAt: ts(1) } }));
    expect(marks(w)).toEqual([['servidores', 'room-mark is-active']]);
    expect(label(w, 'servidores')).toContain('is-active');
    expect(label(w, 'recepcion')).toContain('is-done');
    expect(label(w, 'correo')).toEqual(['room-label']);

    await w.setProps({ live: live('failed', { in: { status: 'completed', startedAt: ts(0) }, t: { status: 'failed', startedAt: ts(1) } }) });
    expect(marks(w)).toEqual([['servidores', 'room-mark is-failed']]);
    expect(label(w, 'servidores')).toContain('is-failed');
  });

  it('una aprobación pendiente resalta el despacho en ámbar y el mensajero espera con el sello', () => {
    const snap: RunSnapshot = { ...WF, workflow: { ...WF.workflow, nodes: [...WF.workflow.nodes, node('ok', 'approval')] } };
    const l = live('waiting');
    l.steps.ok = { ...l.steps.t, nodeId: 'ok', nodeType: 'approval', label: 'ok', status: 'waiting', startedAt: ts(3) };
    l.order.push('ok');
    wrapper = mount(YokaiFloor, { props: { snapshot: snap, live: l, selected: null }, attachTo: document.body });
    expect(marks(wrapper)).toEqual([['despacho', 'room-mark is-waiting']]);
    expect(wrapper.get('.courier').getComponent(YokaiSprite).props('activity')).toBe('waiting');
    expect(wrapper.get('.caption').text()).toBe('Paso 1 de 6 · ok: esperando aprobación');
  });

  it('el rótulo dice el paso actual (texto real, aria-live polite) y no cambia entre dos pasos', async () => {
    const w = open(live('queued'));
    const caption = () => w.get('.caption');
    expect(caption().attributes('role')).toBe('status');
    expect(caption().attributes('aria-live')).toBe('polite');
    expect(caption().text()).toBe('En cola · El mensajero espera en recepción');

    await w.setProps({ live: live('running', { in: { status: 'completed', startedAt: ts(0) }, a1: { status: 'running', startedAt: ts(1) } }) });
    expect(caption().text()).toBe('Paso 2 de 5 · a1');
    await w.setProps({ live: live('running', { in: { status: 'completed', startedAt: ts(0) }, a1: { status: 'completed', startedAt: ts(1) } }) });
    expect(caption().text()).toBe('Paso 2 de 5 · a1');
    await w.setProps({ live: live('completed', { in: { status: 'completed' }, a1: { status: 'completed' }, a2: { status: 'skipped' } }) });
    expect(caption().text()).toBe('Completada · Pasos hechos: 2 de 4');
    await w.setProps({ live: live('cancelled') });
    expect(caption().text()).toBe('Cancelada · El mensajero vuelve a recepción');
  });

  it('al llegar el mensajero, la hitodama salta al yōkai que trabaja y deja un destello', async () => {
    const frames = fakeFrames();
    const w = open(live('queued'));
    // Al empezar va en la mano del mensajero (a su lado y por encima de los pies).
    const courier = placed(w, '.courier');
    const hand = placed(w, '.flame-layer');
    expect(hand.x).toBeGreaterThan(courier.x);
    expect(hand.y).toBeLessThan(courier.y);

    await w.setProps({ live: live('running', { a1: { status: 'running', startedAt: ts(1) } }) });
    let flashes = 0;
    for (let now = 1000; frames.pending() && now < 60_000; now += 1000 / 60) {
      frames.run(now);
      await w.vm.$nextTick();
      flashes = Math.max(flashes, w.findAll('.particle.is-flash').length);
    }
    expect(flashes).toBe(1);
    // Acaba encima del yōkai de a1, en su cubículo.
    const desk = seatFor('cubiculos', 0);
    const flame = placed(w, '.flame-layer');
    expect(Math.abs(flame.x - desk.x)).toBeLessThan(40);
    expect(flame.y).toBeLessThan(desk.y - 60);
    expect(w.get('.hitodama').classes()).toContain('resting');
  });

  it('la hitodama sigue al mensajero con retardo: al andar se queda un poco atrás', async () => {
    const frames = fakeFrames();
    const w = open(live('queued'));
    await w.setProps({ live: live('running', { t: { status: 'running', startedAt: ts(1) } }) });
    let maxLag = 0;
    for (let now = 1000; now < 2500; now += 1000 / 60) {
      frames.run(now);
      await w.vm.$nextTick();
      const c = placed(w, '.courier');
      const f = placed(w, '.flame-layer');
      // Distancia de la llama a la mano (34 px a un lado y 60 px por encima de los pies).
      const lag = Math.min(Math.hypot(f.x - (c.x + 34), f.y - (c.y - 60)), Math.hypot(f.x - (c.x - 34), f.y - (c.y - 60)));
      maxLag = Math.max(maxLag, lag);
    }
    expect(maxLag).toBeGreaterThan(5);
    expect(maxLag).toBeLessThan(80);
  });

  it('al completarse un paso hay un estallido y el sello 済; al fallar, humo y sacudida', async () => {
    const frames = fakeFrames();
    const both = (a1: StepStatus, a2: StepStatus) => live('running', { a1: { status: a1, startedAt: ts(1) }, a2: { status: a2, startedAt: ts(1) } });
    const w = open(both('running', 'running'));
    await w.setProps({ live: both('completed', 'running') });
    expect(w.findAll('.particle.is-confetti').length).toBeGreaterThan(4);
    expect(w.get('.particle.is-tag').text()).toBe('済');
    await w.setProps({ live: both('completed', 'failed') });
    expect(w.findAll('.particle.is-smoke').length).toBeGreaterThan(2);
    expect(w.get('[data-key="a2"] .fx').classes()).toContain('shake');
    // Los efectos se apagan solos y el bucle se para.
    settle(frames);
    await w.vm.$nextTick();
    expect(w.findAll('.particle')).toHaveLength(0);
    expect(w.get('[data-key="a2"] .fx').classes()).not.toContain('shake');
    expect(frames.pending()).toBe(0);
  });

  it('hover o foco sobre un yōkai: tooltip con nombre y estado, y su ruta y puesto resaltados', async () => {
    const w = open(live('running', { a1: { status: 'running', startedAt: ts(1) } }));
    expect(w.find('.tip').exists()).toBe(false);
    await staffButtons(w)[0].trigger('mouseenter');
    const tip = w.get('[data-key="a1"] .tip');
    expect(tip.attributes('aria-hidden')).toBe('true');
    expect(tip.text()).toContain('Agente ana');
    expect(tip.text()).toContain('En curso');
    expect(w.findAll('.route rect').length).toBeGreaterThan(5);
    expect(w.find('.post.is-desk').exists()).toBe(true);
    await staffButtons(w)[0].trigger('mouseleave');
    expect(w.find('.tip').exists()).toBe(false);
    expect(w.find('.route').exists()).toBe(false);
    await staffButtons(w)[1].trigger('focus');
    expect(w.get('[data-key="a2"] .tip').text()).toContain('Agente bo');
    await staffButtons(w)[1].trigger('blur');
    expect(w.find('.tip').exists()).toBe(false);
  });

  it('al desmontar con efectos vivos no deja fotogramas pendientes', async () => {
    const frames = fakeFrames();
    const w = open(live('running', { a1: { status: 'running', startedAt: ts(1) } }));
    await w.setProps({ live: live('running', { a1: { status: 'completed', startedAt: ts(1) } }) });
    expect(frames.pending()).toBe(1);
    w.unmount();
    wrapper = undefined;
    expect(frames.pending()).toBe(0);
  });
});
