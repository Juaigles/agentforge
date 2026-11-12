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
  const px = (v: string) => Math.round((parseFloat(v) / 100) * PLAN_SIZE);
  return { x: px(el.style.left), y: px(el.style.top) };
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
    expect(courier.find('.hitodama').exists()).toBe(true);

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
    // El mensajero también va de la recepción a los cubículos, con su estela.
    expect(w.find('svg.trail polyline').exists()).toBe(true);

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
    expect(w.find('svg.trail').exists()).toBe(false);
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
    expect(w.find('svg.trail').exists()).toBe(false);
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
