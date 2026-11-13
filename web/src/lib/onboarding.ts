// Recorrido guiado (onboarding): la lógica pura. Aquí viven el guion (pasos declarativos), el progreso que se guarda
// en el navegador y las reglas para avanzar, retroceder y reaccionar a lo que pasa de verdad en la aplicación
// (se lanzó la ejecución, llegó la aprobación, terminó). No toca Vue ni el DOM salvo `placeCard`, que solo calcula.
//
// Hay dos guiones sobre el mismo recorrido: el normal y el del Modo Yōkai. Cada paso tiene sus claves de texto y su
// ancla (`data-tour="…"` o un selector CSS) y, si en la piel yōkai cambian, las sustituye en `yokai`.
import type { RunStatus } from '@shared/types';
import type { Skin } from './skin';
import { safeStorage } from './storage';

/** Sube este número cuando el guion cambie de forma que merezca volver a ofrecerlo. */
export const TOUR_VERSION = 1;
export const TOUR_KEY = 'af-onboarding';

export type TourStatus = 'idle' | 'active' | 'completed' | 'dismissed';
/** Pantalla en la que tiene sentido un paso. `null`: cualquiera (la tarjeta va centrada). */
export type TourPage = 'dashboard' | 'agents' | 'builder' | 'run' | null;
/** Hechos reales que el recorrido observa (se quedan apuntados aunque ocurran antes de llegar a su paso). */
export type TourFact = 'runStarted' | 'approvalWaiting' | 'approvalDecided' | 'runFinished';
export type TourFacts = Record<TourFact, boolean>;

export interface TourCopy {
  titleKey?: string;
  bodyKey?: string;
  /** Valor de `data-tour` del elemento señalado; con varios, el primero que exista. */
  anchor?: string | string[];
  /** Alternativa a `anchor` para elementos que no son nuestros (nodos del lienzo, la planta…). */
  selector?: string;
}

export interface TourStep extends TourCopy {
  id: string;
  titleKey: string;
  bodyKey: string;
  page: TourPage;
  /** Qué hace avanzar el paso: el botón «Siguiente» o un hecho real. */
  advance: 'next' | TourFact;
  /** Mientras no ocurra este hecho, la tarjeta dice que está esperando (p. ej. a que llegue la aprobación). */
  waitFor?: TourFact;
  /** Un paso de evento que, aun así, se puede pasar con «Siguiente». */
  optional?: boolean;
  /** Si su ancla no está en la pantalla (p. ej. el workflow no tiene «para cada»), el paso se salta solo. */
  skipIfMissing?: boolean;
  /** Solo en estas pieles (por defecto, en las dos). */
  skins?: Skin[];
  /** Lo que cambia en la piel yōkai. */
  yokai?: TourCopy;
}

const node = (kind: string) => `.vue-flow__node .flow-node.${kind}`;

/** El guion. El orden es el del recorrido. */
export const TOUR_STEPS: TourStep[] = [
  {
    id: 'welcome',
    page: null,
    advance: 'next',
    titleKey: 'onboarding.steps.welcome.title',
    bodyKey: 'onboarding.steps.welcome.body',
    yokai: { titleKey: 'onboarding.yokai.welcome.title', bodyKey: 'onboarding.yokai.welcome.body' },
  },
  {
    id: 'dashboard',
    page: 'dashboard',
    advance: 'next',
    anchor: 'dashboard-kpis',
    titleKey: 'onboarding.steps.dashboard.title',
    bodyKey: 'onboarding.steps.dashboard.body',
    yokai: { bodyKey: 'onboarding.yokai.dashboard.body' },
  },
  {
    id: 'agents',
    page: 'agents',
    advance: 'next',
    anchor: ['agents-list', 'agents-header'],
    titleKey: 'onboarding.steps.agents.title',
    bodyKey: 'onboarding.steps.agents.body',
    yokai: { titleKey: 'onboarding.yokai.agents.title', bodyKey: 'onboarding.yokai.agents.body' },
  },
  {
    id: 'builder',
    page: 'builder',
    advance: 'next',
    anchor: 'builder-canvas',
    titleKey: 'onboarding.steps.builder.title',
    bodyKey: 'onboarding.steps.builder.body',
    yokai: { titleKey: 'onboarding.yokai.builder.title', bodyKey: 'onboarding.yokai.builder.body' },
  },
  ...(['input', 'agent', 'tool', 'condition', 'transform', 'foreach', 'approval', 'output'] as const).map((kind): TourStep => ({
    id: `node-${kind}`,
    page: 'builder',
    advance: 'next',
    selector: node(kind),
    skipIfMissing: true,
    titleKey: `onboarding.steps.node.${kind}.title`,
    bodyKey: `onboarding.steps.node.${kind}.body`,
    yokai: { bodyKey: `onboarding.yokai.node.${kind}.body` },
  })),
  {
    id: 'edges',
    page: 'builder',
    advance: 'next',
    anchor: 'builder-canvas',
    titleKey: 'onboarding.steps.edges.title',
    bodyKey: 'onboarding.steps.edges.body',
    yokai: { bodyKey: 'onboarding.yokai.edges.body' },
  },
  {
    id: 'launch',
    page: 'builder',
    advance: 'runStarted',
    anchor: ['run-launch', 'run-button'],
    titleKey: 'onboarding.steps.launch.title',
    bodyKey: 'onboarding.steps.launch.body',
    yokai: { bodyKey: 'onboarding.yokai.launch.body' },
  },
  {
    id: 'run-live',
    page: 'run',
    advance: 'next',
    anchor: 'run-graph',
    titleKey: 'onboarding.steps.runLive.title',
    bodyKey: 'onboarding.steps.runLive.body',
    yokai: { titleKey: 'onboarding.yokai.runLive.title', bodyKey: 'onboarding.yokai.runLive.body' },
  },
  {
    id: 'run-switch',
    page: 'run',
    advance: 'next',
    skins: ['yokai'],
    anchor: 'run-view-switch',
    titleKey: 'onboarding.yokai.runSwitch.title',
    bodyKey: 'onboarding.yokai.runSwitch.body',
  },
  {
    id: 'run-steps',
    page: 'run',
    advance: 'next',
    anchor: 'run-steps',
    titleKey: 'onboarding.steps.runSteps.title',
    bodyKey: 'onboarding.steps.runSteps.body',
    yokai: { bodyKey: 'onboarding.yokai.runSteps.body' },
  },
  {
    id: 'approval',
    page: 'run',
    advance: 'approvalDecided',
    waitFor: 'approvalWaiting',
    anchor: ['approvals', 'run-graph'],
    titleKey: 'onboarding.steps.approval.title',
    bodyKey: 'onboarding.steps.approval.body',
    yokai: { bodyKey: 'onboarding.yokai.approval.body' },
  },
  {
    id: 'result',
    page: 'run',
    advance: 'next',
    waitFor: 'runFinished',
    anchor: 'run-stats',
    titleKey: 'onboarding.steps.result.title',
    bodyKey: 'onboarding.steps.result.body',
    yokai: { bodyKey: 'onboarding.yokai.result.body' },
  },
  {
    id: 'finish',
    page: null,
    advance: 'next',
    titleKey: 'onboarding.steps.finish.title',
    bodyKey: 'onboarding.steps.finish.body',
    yokai: { titleKey: 'onboarding.yokai.finish.title', bodyKey: 'onboarding.yokai.finish.body' },
  },
];

// ---------- Progreso ----------

export interface TourProgress {
  version: number;
  status: TourStatus;
  /** Paso actual (por id: así sobrevive a que cambie la piel, que filtra pasos). */
  stepId: string;
  /** Tarjeta visible. Cerrarla (Esc, ×) no abandona el recorrido: se reanuda donde se quedó. */
  open: boolean;
  workflowId: string | null;
  runId: string | null;
  facts: TourFacts;
  /** Efecto máquina de escribir en el guion yōkai. */
  typewriter: boolean;
  /** Había un progreso de otra versión del guion: se puede volver a ofrecer. */
  outdated: boolean;
}

const NO_FACTS: TourFacts = { runStarted: false, approvalWaiting: false, approvalDecided: false, runFinished: false };

export function freshProgress(): TourProgress {
  return {
    version: TOUR_VERSION,
    status: 'idle',
    stepId: TOUR_STEPS[0].id,
    open: false,
    workflowId: null,
    runId: null,
    facts: { ...NO_FACTS },
    typewriter: true,
    outdated: false,
  };
}

const STATUSES: TourStatus[] = ['idle', 'active', 'completed', 'dismissed'];

/** Lee el progreso guardado. Lo ilegible se ignora; el de otra versión vuelve a «no empezado» (marcado `outdated`). */
export function parseProgress(raw: string | null): TourProgress {
  const fresh = freshProgress();
  if (!raw) return fresh;
  let data: Partial<TourProgress>;
  try {
    data = JSON.parse(raw) as Partial<TourProgress>;
  } catch {
    return fresh;
  }
  if (!data || typeof data !== 'object') return fresh;
  if (data.version !== TOUR_VERSION) return { ...fresh, outdated: true, typewriter: data.typewriter !== false };
  const facts = { ...NO_FACTS };
  for (const key of Object.keys(NO_FACTS) as TourFact[]) facts[key] = data.facts?.[key] === true;
  return {
    version: TOUR_VERSION,
    status: STATUSES.includes(data.status as TourStatus) ? (data.status as TourStatus) : 'idle',
    stepId: TOUR_STEPS.some((s) => s.id === data.stepId) ? (data.stepId as string) : fresh.stepId,
    open: data.open === true,
    workflowId: typeof data.workflowId === 'string' ? data.workflowId : null,
    runId: typeof data.runId === 'string' ? data.runId : null,
    facts,
    typewriter: data.typewriter !== false,
    outdated: false,
  };
}

export const loadProgress = (): TourProgress => parseProgress(safeStorage.get(TOUR_KEY));
export function saveProgress(progress: TourProgress): void {
  safeStorage.set(TOUR_KEY, JSON.stringify({ ...progress, outdated: undefined }));
}

// ---------- Navegación por el guion ----------

/** Pasos que se ven con una piel. */
export const stepsFor = (skin: Skin, steps: TourStep[] = TOUR_STEPS): TourStep[] => steps.filter((s) => !s.skins || s.skins.includes(skin));

/** Índice del paso actual entre los visibles; si el actual no existe en esta piel, el siguiente que sí. */
export function currentIndex(progress: TourProgress, skin: Skin, steps: TourStep[] = TOUR_STEPS): number {
  const visible = stepsFor(skin, steps);
  const at = visible.findIndex((s) => s.id === progress.stepId);
  if (at >= 0) return at;
  const full = steps.findIndex((s) => s.id === progress.stepId);
  const next = visible.findIndex((s) => steps.indexOf(s) > full);
  return next >= 0 ? next : visible.length - 1;
}

/** Textos y ancla del paso en la piel indicada. */
export function copyFor(step: TourStep, skin: Skin): Required<Pick<TourCopy, 'titleKey' | 'bodyKey'>> & { anchors: string[]; selector?: string } {
  const y = skin === 'yokai' ? step.yokai : undefined;
  const anchor = y?.anchor ?? step.anchor;
  return {
    titleKey: y?.titleKey ?? step.titleKey,
    bodyKey: y?.bodyKey ?? step.bodyKey,
    anchors: anchor === undefined ? [] : Array.isArray(anchor) ? anchor : [anchor],
    selector: y?.selector ?? (y?.anchor ? undefined : step.selector),
  };
}

/** ¿Se cumple ya el hecho? Una ejecución que termina sin pasar por la aprobación también la deja atrás. */
export function hasFact(facts: TourFacts, fact: TourFact): boolean {
  if (fact === 'approvalDecided') return facts.approvalDecided || facts.runFinished;
  if (fact === 'approvalWaiting') return facts.approvalWaiting || facts.runFinished;
  return facts[fact];
}

/** ¿Puede el usuario pasar de este paso con «Siguiente»? */
export const canAdvance = (step: TourStep, facts: TourFacts): boolean => step.advance === 'next' || !!step.optional || hasFact(facts, step.advance);

/** Cuántos pasos se avanza o retrocede, saltando los que no tienen su ancla en pantalla (`skipIfMissing`). */
export function move(
  progress: TourProgress,
  skin: Skin,
  delta: 1 | -1,
  isMissing: (step: TourStep) => boolean = () => false,
  steps: TourStep[] = TOUR_STEPS,
): TourProgress {
  const visible = stepsFor(skin, steps);
  let i = currentIndex(progress, skin, steps);
  do i += delta;
  while (i > 0 && i < visible.length - 1 && visible[i].skipIfMissing && isMissing(visible[i]));
  if (i >= visible.length) return { ...progress, status: 'completed', open: false };
  return { ...progress, stepId: visible[Math.max(0, i)].id };
}

export function start(progress: TourProgress): TourProgress {
  // Un recorrido terminado o abandonado empieza de cero; uno a medias se reanuda.
  if (progress.status === 'active') return { ...progress, open: true };
  return { ...freshProgress(), typewriter: progress.typewriter, status: 'active', open: true };
}

export const dismiss = (progress: TourProgress): TourProgress => ({ ...progress, status: 'dismissed', open: false });
export const complete = (progress: TourProgress): TourProgress => ({ ...progress, status: 'completed', open: false });
export const close = (progress: TourProgress): TourProgress => ({ ...progress, open: false });

/** Hechos que se deducen de un estado de la ejecución del recorrido. */
export function factsFromStatus(facts: TourFacts, status: RunStatus): TourFacts {
  const next = { ...facts, runStarted: true };
  if (status === 'waiting') next.approvalWaiting = true;
  // Tras estar esperando, volver a «en curso» o terminar es que alguien ya decidió.
  if (facts.approvalWaiting && status !== 'waiting') next.approvalDecided = true;
  if (status === 'completed' || status === 'failed' || status === 'cancelled') next.runFinished = true;
  return next;
}

/**
 * Aplica el estado de una ejecución al progreso: si es la del recorrido (o la primera del workflow de bienvenida
 * desde el paso de lanzarla), apunta los hechos y, si el paso actual esperaba uno de ellos, avanza.
 */
export function observeRun(
  progress: TourProgress,
  skin: Skin,
  run: { id: string; workflowId: string | null; status: RunStatus },
  steps: TourStep[] = TOUR_STEPS,
): TourProgress {
  if (progress.status !== 'active') return progress;
  const visible = stepsFor(skin, steps);
  const index = currentIndex(progress, skin, steps);
  const launchAt = visible.findIndex((s) => s.advance === 'runStarted');
  let next = progress;
  if (run.id !== progress.runId) {
    // Una ejecución nueva del workflow de bienvenida cuenta si el usuario está en el paso de lanzarla (o después).
    const isWelcome = !!progress.workflowId && run.workflowId === progress.workflowId;
    if (!isWelcome || launchAt < 0 || index < launchAt) return progress;
    if (progress.runId && index > launchAt) return progress;
    next = { ...progress, runId: run.id, facts: { ...NO_FACTS } };
  }
  const facts = factsFromStatus(next.facts, run.status);
  next = { ...next, facts };
  const step = visible[index];
  if (step && step.advance !== 'next' && hasFact(facts, step.advance)) next = move(next, skin, 1, () => false, steps);
  return next;
}

/** ¿Se ofrece el recorrido sin que el usuario lo pida? Solo la primera vez, y nunca en una sesión automatizada. */
export function shouldOffer(progress: TourProgress, ctx: { workflowCompleted: boolean; automated: boolean }): boolean {
  if (ctx.automated || progress.status !== 'idle') return false;
  return progress.outdated || !ctx.workflowCompleted;
}

/** Navegador conducido por una herramienta de pruebas (Playwright, WebDriver): el recorrido no se ofrece solo. */
export const isAutomated = (): boolean => typeof navigator !== 'undefined' && navigator.webdriver === true;

/** Ruta de la pantalla de un paso (null si falta el dato para construirla). */
export function pagePath(page: TourPage, progress: Pick<TourProgress, 'workflowId' | 'runId'>): string | null {
  switch (page) {
    case 'dashboard':
      return '/';
    case 'agents':
      return '/agents';
    case 'builder':
      return progress.workflowId ? `/workflows/${progress.workflowId}` : null;
    case 'run':
      return progress.runId ? `/runs/${progress.runId}` : null;
    default:
      return null;
  }
}

// ---------- Colocación de la tarjeta ----------

export interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}
export type Placement = 'bottom' | 'top' | 'right' | 'left' | 'center' | 'sheet';

/** Anchura a partir de la cual la tarjeta deja de ser una hoja inferior. */
export const SHEET_MAX_WIDTH = 560;

/**
 * Dónde va la tarjeta: debajo, encima, a la derecha o a la izquierda del ancla (la primera que quepa entera); sin
 * ancla o si no cabe en ningún lado, centrada abajo; en pantallas estrechas, hoja inferior.
 */
export function placeCard(
  anchor: Rect | null,
  card: { width: number; height: number },
  viewport: { width: number; height: number },
  gap = 14,
): { placement: Placement; top: number; left: number } {
  const margin = 12;
  if (viewport.width <= SHEET_MAX_WIDTH) return { placement: 'sheet', top: viewport.height - card.height, left: 0 };
  const centered = {
    placement: 'center' as const,
    top: Math.max(margin, viewport.height - card.height - 24),
    left: Math.max(margin, (viewport.width - card.width) / 2),
  };
  if (!anchor || anchor.width <= 0 || anchor.height <= 0) return centered;
  // Ancla fuera de la vista: centrada abajo.
  if (anchor.top + anchor.height < 0 || anchor.top > viewport.height || anchor.left + anchor.width < 0 || anchor.left > viewport.width) return centered;
  const clampX = (x: number) => Math.min(Math.max(margin, x), viewport.width - card.width - margin);
  const clampY = (y: number) => Math.min(Math.max(margin, y), viewport.height - card.height - margin);
  const midX = anchor.left + anchor.width / 2 - card.width / 2;
  const midY = anchor.top + anchor.height / 2 - card.height / 2;
  const below = anchor.top + anchor.height + gap;
  if (below + card.height <= viewport.height - margin) return { placement: 'bottom', top: below, left: clampX(midX) };
  const above = anchor.top - gap - card.height;
  if (above >= margin) return { placement: 'top', top: above, left: clampX(midX) };
  const right = anchor.left + anchor.width + gap;
  if (right + card.width <= viewport.width - margin) return { placement: 'right', top: clampY(midY), left: right };
  const left = anchor.left - gap - card.width;
  if (left >= margin) return { placement: 'left', top: clampY(midY), left };
  return centered;
}
