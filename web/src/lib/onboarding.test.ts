// @vitest-environment jsdom
// Motor del recorrido guiado: guion, avance y retroceso, hechos que lo hacen avanzar, persistencia, versión y
// colocación de la tarjeta.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { te } from '@/i18n';
import {
  canAdvance,
  copyFor,
  currentIndex,
  factsFromStatus,
  freshProgress,
  loadProgress,
  move,
  observeRun,
  pagePath,
  parseProgress,
  placeCard,
  saveProgress,
  shouldOffer,
  start,
  stepsFor,
  TOUR_KEY,
  TOUR_STEPS,
  TOUR_VERSION,
  type TourProgress,
} from './onboarding';

const at = (id: string, extra: Partial<TourProgress> = {}): TourProgress => ({ ...start(freshProgress()), stepId: id, ...extra });

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe('guion', () => {
  it('los ids son únicos y todas las claves de texto existen en las dos pieles', () => {
    expect(new Set(TOUR_STEPS.map((s) => s.id)).size).toBe(TOUR_STEPS.length);
    const missing: string[] = [];
    for (const step of TOUR_STEPS)
      for (const skin of ['default', 'yokai'] as const) {
        const c = copyFor(step, skin);
        for (const key of [c.titleKey, c.bodyKey]) if (!te(key)) missing.push(`${step.id}/${skin}: ${key}`);
      }
    expect(missing).toEqual([]);
  });

  it('la piel yōkai cambia la voz y añade el paso del selector Planta/Grafo', () => {
    expect(stepsFor('yokai').length).toBe(stepsFor('default').length + 1);
    expect(stepsFor('default').some((s) => s.id === 'run-switch')).toBe(false);
    const agents = TOUR_STEPS.find((s) => s.id === 'agents')!;
    expect(copyFor(agents, 'default').bodyKey).toBe('onboarding.steps.agents.body');
    expect(copyFor(agents, 'yokai').bodyKey).toBe('onboarding.yokai.agents.body');
    // Sin variante yōkai, se usa el texto común.
    const node = TOUR_STEPS.find((s) => s.id === 'node-agent')!;
    expect(copyFor(node, 'yokai').titleKey).toBe('onboarding.steps.node.agent.title');
    expect(copyFor(node, 'yokai').selector).toContain('.flow-node.agent');
  });

  it('recorre las pantallas en orden: bienvenida, Panel, Agentes, constructor, ejecución, cierre', () => {
    const pages = stepsFor('default').map((s) => s.page);
    expect(pages[0]).toBeNull();
    expect(pages.at(-1)).toBeNull();
    const order = pages.filter((p, i) => p && p !== pages[i - 1]);
    expect(order).toEqual(['dashboard', 'agents', 'builder', 'run']);
  });
});

describe('avance y retroceso', () => {
  it('Siguiente y Atrás se mueven paso a paso; al pasar del último el recorrido queda completado', () => {
    let p = start(freshProgress());
    expect(p).toMatchObject({ status: 'active', open: true, stepId: 'welcome' });
    p = move(p, 'default', 1);
    expect(p.stepId).toBe('dashboard');
    p = move(p, 'default', -1);
    expect(p.stepId).toBe('welcome');
    p = move(p, 'default', -1); // no hay nada antes de la bienvenida
    expect(p.stepId).toBe('welcome');
    p = move(at('finish'), 'default', 1);
    expect(p).toMatchObject({ status: 'completed', open: false });
  });

  it('se salta los nodos que el workflow no tiene', () => {
    const p = move(at('node-transform'), 'default', 1, (s) => s.id === 'node-foreach');
    expect(p.stepId).toBe('node-approval');
    const back = move(at('node-approval'), 'default', -1, (s) => s.id === 'node-foreach');
    expect(back.stepId).toBe('node-transform');
  });

  it('el paso actual se conserva al cambiar de piel (y si no existe en la nueva, se usa el siguiente)', () => {
    const p = at('run-switch');
    expect(stepsFor('yokai')[currentIndex(p, 'yokai')].id).toBe('run-switch');
    expect(stepsFor('default')[currentIndex(p, 'default')].id).toBe('run-steps');
  });

  it('un paso de evento no se pasa con Siguiente hasta que ocurre (salvo que sea opcional)', () => {
    const launch = TOUR_STEPS.find((s) => s.id === 'launch')!;
    expect(canAdvance(launch, freshProgress().facts)).toBe(false);
    expect(canAdvance({ ...launch, optional: true }, freshProgress().facts)).toBe(true);
    expect(canAdvance(launch, { ...freshProgress().facts, runStarted: true })).toBe(true);
  });

  it('empezar un recorrido terminado o descartado vuelve al principio; uno a medias se reanuda', () => {
    expect(start({ ...at('agents'), status: 'completed' }).stepId).toBe('welcome');
    expect(start({ ...at('agents'), status: 'dismissed' }).stepId).toBe('welcome');
    expect(start({ ...at('agents'), open: false })).toMatchObject({ stepId: 'agents', open: true });
  });
});

describe('eventos reales', () => {
  const welcome = 'wf-bienvenida';
  const run = (status: 'running' | 'waiting' | 'completed' | 'failed', id = 'run-1', workflowId = welcome) => ({ id, workflowId, status });

  it('lanzar la ejecución avanza; llegar a la aprobación y aprobar hacen avanzar el paso de aprobación', () => {
    let p = at('launch', { workflowId: welcome });
    p = observeRun(p, 'default', run('running'));
    expect(p).toMatchObject({ stepId: 'run-live', runId: 'run-1' });
    expect(p.facts.runStarted).toBe(true);

    // La aprobación llega mientras el usuario lee otros pasos: queda apuntada, pero no salta.
    p = observeRun(p, 'default', run('waiting'));
    expect(p.stepId).toBe('run-live');
    expect(p.facts.approvalWaiting).toBe(true);

    p = { ...p, stepId: 'approval' };
    p = observeRun(p, 'default', run('running'));
    expect(p.stepId).toBe('result');
    expect(p.facts.approvalDecided).toBe(true);

    p = observeRun(p, 'default', run('completed'));
    expect(p.facts.runFinished).toBe(true);
    expect(p.stepId).toBe('result'); // el resultado se lee con calma: avanza con Siguiente
  });

  it('ignora ejecuciones de otros workflows, y las del de bienvenida antes del paso de lanzar', () => {
    const p = at('launch', { workflowId: welcome });
    expect(observeRun(p, 'default', run('running', 'x', 'otro'))).toBe(p);
    const early = at('builder', { workflowId: welcome });
    expect(observeRun(early, 'default', run('running'))).toBe(early);
    const inactive = { ...p, status: 'dismissed' as const };
    expect(observeRun(inactive, 'default', run('running'))).toBe(inactive);
  });

  it('una ejecución que termina sin pasar por la aprobación no deja el recorrido atascado', () => {
    let p = at('approval', { workflowId: welcome, runId: 'run-1', facts: factsFromStatus(freshProgress().facts, 'running') });
    p = observeRun(p, 'default', run('failed'));
    expect(p.stepId).toBe('result');
  });

  it('relanzar desde el paso de lanzar sustituye la ejecución seguida', () => {
    let p = at('launch', { workflowId: welcome, runId: 'viejo', facts: { runStarted: true, approvalWaiting: true, approvalDecided: true, runFinished: true } });
    p = observeRun(p, 'default', run('running', 'nuevo'));
    expect(p).toMatchObject({ runId: 'nuevo', stepId: 'run-live' });
    expect(p.facts).toMatchObject({ runStarted: true, approvalWaiting: false, runFinished: false });
  });
});

describe('persistencia y versión', () => {
  it('guarda y recupera el progreso en localStorage', () => {
    const p = at('node-tool', { workflowId: 'w', runId: null, typewriter: false });
    saveProgress(p);
    expect(JSON.parse(localStorage.getItem(TOUR_KEY)!)).toMatchObject({ version: TOUR_VERSION, stepId: 'node-tool' });
    expect(loadProgress()).toEqual(p);
  });

  it('lo ilegible o desconocido se ignora sin romper', () => {
    expect(parseProgress('{no es json')).toEqual(freshProgress());
    expect(parseProgress(JSON.stringify({ version: TOUR_VERSION, status: 'raro', stepId: 'no-existe' }))).toMatchObject({ status: 'idle', stepId: 'welcome' });
  });

  it('un progreso de otra versión del guion vuelve a «no empezado» y permite ofrecerlo de nuevo', () => {
    const old = parseProgress(JSON.stringify({ version: TOUR_VERSION - 1, status: 'completed', stepId: 'finish', typewriter: false }));
    expect(old).toMatchObject({ status: 'idle', outdated: true, typewriter: false });
    expect(shouldOffer(old, { workflowCompleted: true, automated: false })).toBe(true);
  });

  it('se ofrece solo la primera vez y nunca en un navegador automatizado', () => {
    const fresh = freshProgress();
    expect(shouldOffer(fresh, { workflowCompleted: false, automated: false })).toBe(true);
    expect(shouldOffer(fresh, { workflowCompleted: true, automated: false })).toBe(false);
    expect(shouldOffer(fresh, { workflowCompleted: false, automated: true })).toBe(false);
    expect(shouldOffer({ ...fresh, status: 'dismissed' }, { workflowCompleted: false, automated: false })).toBe(false);
  });

  it('construye la ruta de cada pantalla', () => {
    expect(pagePath('dashboard', { workflowId: null, runId: null })).toBe('/');
    expect(pagePath('builder', { workflowId: null, runId: null })).toBeNull();
    expect(pagePath('builder', { workflowId: 'w1', runId: null })).toBe('/workflows/w1');
    expect(pagePath('run', { workflowId: 'w1', runId: 'r1' })).toBe('/runs/r1');
  });
});

describe('colocación de la tarjeta', () => {
  const viewport = { width: 1280, height: 800 };
  const card = { width: 360, height: 200 };

  it('sin ancla, centrada abajo', () => {
    const pos = placeCard(null, card, viewport);
    expect(pos.placement).toBe('center');
    expect(pos.left).toBe((1280 - 360) / 2);
    expect(pos.top).toBe(800 - 200 - 24);
  });

  it('debajo del ancla si cabe; si no, encima; si tampoco, al lado', () => {
    expect(placeCard({ top: 100, left: 200, width: 200, height: 40 }, card, viewport).placement).toBe('bottom');
    expect(placeCard({ top: 650, left: 200, width: 200, height: 40 }, card, viewport).placement).toBe('top');
    expect(placeCard({ top: 150, left: 100, width: 300, height: 500 }, card, viewport).placement).toBe('right');
    expect(placeCard({ top: 150, left: 800, width: 400, height: 500 }, card, viewport).placement).toBe('left');
    // Un ancla que ocupa toda la pantalla: no cabe en ningún lado.
    expect(placeCard({ top: 0, left: 0, width: 1280, height: 800 }, card, viewport).placement).toBe('center');
  });

  it('no se sale de la pantalla y, con el ancla fuera de la vista, va centrada', () => {
    const pos = placeCard({ top: 100, left: 1200, width: 60, height: 30 }, card, viewport);
    expect(pos.left + card.width).toBeLessThanOrEqual(1280 - 12);
    expect(placeCard({ top: -300, left: 10, width: 60, height: 30 }, card, viewport).placement).toBe('center');
  });

  it('en pantallas estrechas es una hoja inferior', () => {
    expect(placeCard({ top: 100, left: 20, width: 60, height: 30 }, card, { width: 375, height: 812 }).placement).toBe('sheet');
  });
});
