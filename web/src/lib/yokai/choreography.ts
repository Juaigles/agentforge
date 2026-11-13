// Coreografía de una ejecución en el Modo Yōkai: a partir del estado de la ejecución decide qué yōkai hay en la planta,
// en qué sala y puesto está cada uno y qué está haciendo. Es una función pura del estado: la planta la vuelve a llamar
// con cada cambio y anima el paso de un sitio a otro (con `planPath`).
//
// Semántica:
// - Plantilla (`staff`): un yōkai por cada nodo que ejecuta un agente (`nodeUsesAgent`), en el orden de los nodos del
//   workflow. Su puesto es el cubículo de su índice entre esos nodos (`seatFor('cubiculos', i)`), y en la cocina, la
//   silla de ese mismo índice.
//   · pendiente (o sin estado aún) → cocina, sin actividad;
//   · en marcha → su cubículo, con la actividad del orbe (`stepActivity`: pensando, herramienta, escribiendo);
//   · esperando → su cubículo, 'waiting';
//   · completado / fallido → se queda en su cubículo con 'done' / 'error' mientras la ejecución siga activa, y vuelve a
//     la cocina (conservando 'done' / 'error') cuando la ejecución termina;
//   · omitido / cancelado → cocina, sin actividad.
// - Mensajero (`courier`): siempre uno; va a la sala del paso que se está ejecutando (ver `courierTarget`).
//
// Casos límite:
// - Un «para cada» cuyo cuerpo es un agente cuenta como plantilla (trabaja en su cubículo), pero el mensajero va a la
//   sala de reuniones, que es donde vive el tipo de paso `foreach`.
// - Un subworkflow no tiene plantilla propia: el mensajero espera delante del ascensor del vestíbulo mientras corre.
// - Un workflow sin agentes solo tiene el mensajero.
// - Con más de 6 agentes los puestos dan la vuelta: el 7.º comparte cubículo con el 1.º (y en la cocina pasa lo mismo
//   a partir del 8.º). Quien dibuja puede desplazarlos un poco para que no se tapen del todo.
import { nodeUsesAgent } from '@shared/graph';
import type { NodeType, RunSnapshot, RunStatus, StepStatus } from '@shared/types';
import { hasOpenTool, stepActivity, type AgentActivity } from '../agent-activity';
import type { RunLive, StepLive } from '../run-state';
import { IDLE_ROOM, ROOMS, roomForNode, seatFor } from './map';
import { speciesFor } from './species';
import type { Actor, Point, RoomId } from './types';

/** Color de un agente que ya no está en la instantánea. */
const FALLBACK_COLOR = '#94a3b8';
/** Color de la hitodama, la llama azul que lleva el mensajero. */
export const COURIER_COLOR = '#5ab4ff';

const isRunFinished = (status: RunStatus): boolean => status === 'completed' || status === 'failed' || status === 'cancelled';
const isStepActive = (status: StepStatus): boolean => status === 'running' || status === 'waiting';

export interface CourierTarget {
  room: RoomId;
  seat: Point;
  activity?: AgentActivity;
}

/** Puesto del mensajero en la sala de un tipo de paso: ante el ascensor para un subworkflow; si no, el reposo de la sala. */
function courierSeat(type: NodeType | null, room: RoomId): Point {
  if (type === 'subworkflow') return ROOMS.vestibulo.seats[0];
  return ROOMS[room].anchor;
}

/** Tipo del nodo de un paso: el del workflow de la instantánea y, si no está, el que guardó el propio paso. */
function nodeTypeOf(snapshot: RunSnapshot, step: StepLive): NodeType {
  return snapshot.workflow.nodes.find((n) => n.id === step.nodeId)?.type ?? step.nodeType;
}

/** El último paso (por `key`, en ISO) entre los que cumplen el filtro; en empate, el que va después en `live.order`. */
function latestStep(live: RunLive, filter: (s: StepLive) => boolean, key: (s: StepLive) => string | null): StepLive | null {
  let best: StepLive | null = null;
  let bestKey = '';
  for (const id of live.order.length ? live.order : Object.keys(live.steps)) {
    const step = live.steps[id];
    if (!step || !filter(step)) continue;
    const k = key(step) ?? '';
    if (best === null || k >= bestKey) {
      best = step;
      bestKey = k;
    }
  }
  return best;
}

/** Destino del mensajero y el estado que muestra (el del paso que acompaña o el de la ejecución). */
function courierState(snapshot: RunSnapshot, live: RunLive): { target: CourierTarget; status: StepStatus } {
  // Paso en curso: si hay varios en paralelo, el que empezó más tarde.
  const current = latestStep(
    live,
    (s) => isStepActive(s.status),
    (s) => s.startedAt,
  );
  if (current) {
    const type = nodeTypeOf(snapshot, current);
    const room = roomForNode(type);
    const activity: AgentActivity = current.status === 'waiting' ? 'waiting' : type === 'tool' ? 'tool' : 'thinking';
    return { target: { room, seat: courierSeat(type, room), activity }, status: current.status };
  }
  switch (live.status) {
    case 'completed':
      return { target: { room: 'correo', seat: ROOMS.correo.anchor, activity: 'done' }, status: 'completed' };
    case 'failed': {
      const failed = latestStep(
        live,
        (s) => s.status === 'failed',
        (s) => s.finishedAt ?? s.startedAt,
      );
      const type = failed ? nodeTypeOf(snapshot, failed) : null;
      const room = type ? roomForNode(type) : 'recepcion';
      return { target: { room, seat: courierSeat(type, room), activity: 'error' }, status: 'failed' };
    }
    case 'cancelled':
      return { target: { room: 'recepcion', seat: ROOMS.recepcion.anchor }, status: 'cancelled' };
    default: {
      // En cola, sin empezar o entre dos pasos: espera donde terminó el último paso, o en la recepción si no hay ninguno.
      const last = latestStep(
        live,
        (s) => s.status === 'completed',
        (s) => s.finishedAt ?? s.startedAt,
      );
      if (!last) return { target: { room: 'recepcion', seat: ROOMS.recepcion.anchor }, status: 'pending' };
      const type = nodeTypeOf(snapshot, last);
      const room = roomForNode(type);
      return { target: { room, seat: courierSeat(type, room) }, status: 'pending' };
    }
  }
}

/**
 * Adónde va el mensajero:
 * - Hay pasos en curso (en marcha o esperando) → la sala del que empezó más tarde, con 'waiting' si espera una
 *   aprobación, 'tool' si es un paso de herramienta y 'thinking' en otro caso.
 * - Ninguno en curso: en cola o sin empezar → recepción (si la ejecución sigue activa entre dos pasos, se queda en la
 *   sala del último paso completado); terminada con éxito → correo ('done'); fallida → la sala del último paso que
 *   falló ('error'; recepción si no falló ningún paso concreto); cancelada → recepción.
 */
export function courierTarget(snapshot: RunSnapshot, live: RunLive): CourierTarget {
  return courierState(snapshot, live).target;
}

/** Paso en curso (el que acompaña el mensajero): si hay varios en paralelo, el que empezó más tarde; null si ninguno. */
export function activeStep(snapshot: RunSnapshot, live: RunLive): { nodeId: string; type: NodeType; status: StepStatus; room: RoomId } | null {
  const step = latestStep(
    live,
    (s) => isStepActive(s.status),
    (s) => s.startedAt,
  );
  if (!step) return null;
  const type = nodeTypeOf(snapshot, step);
  return { nodeId: step.nodeId, type, status: step.status, room: roomForNode(type) };
}

/** Puesto de trabajo y silla de descanso del yōkai de plantilla n-ésimo. */
export function staffPosts(index: number): { desk: Point; rest: Point } {
  return { desk: seatFor('cubiculos', index), rest: seatFor(IDLE_ROOM, index) };
}

/**
 * Dónde deja el mensajero la hitodama (el dato) al llegar a la sala de un paso que no tiene yōkai de plantilla: sobre
 * el mueble del primer puesto de la sala (el mostrador, el rack, el escritorio del sello…). Las coordenadas son las
 * del suelo delante del mueble; quien dibuja eleva la llama.
 */
export function workSpot(room: RoomId): Point {
  return ROOMS[room].seats[0];
}

/** Marca de una sala en la planta: la del paso en curso (o esperando aprobación) y las de pasos ya terminados. */
export type RoomMark = 'active' | 'waiting' | 'done' | 'failed';

/**
 * Marca de cada sala según los pasos que viven en ella: la del paso en curso se resalta ('active', o 'waiting' si
 * espera una aprobación); si no, 'failed' si algún paso de esa sala falló y 'done' si alguno se completó. Las salas
 * sin pasos terminados no aparecen.
 */
export function roomMarks(snapshot: RunSnapshot, live: RunLive): Partial<Record<RoomId, RoomMark>> {
  const marks: Partial<Record<RoomId, RoomMark>> = {};
  for (const step of Object.values(live.steps)) {
    if (step.status !== 'completed' && step.status !== 'failed') continue;
    const room = roomForNode(nodeTypeOf(snapshot, step));
    if (step.status === 'failed') marks[room] = 'failed';
    else if (!marks[room]) marks[room] = 'done';
  }
  const current = activeStep(snapshot, live);
  if (current) marks[current.room] = current.status === 'waiting' ? 'waiting' : 'active';
  return marks;
}

/** Progreso de la ejecución para el rótulo de la planta. */
export interface RunProgress {
  /**
   * - `queued`: aún no ha empezado ningún paso; `running` / `waiting`: hay un paso en curso (o esperando aprobación);
   * - `between`: la ejecución sigue pero entre dos pasos (se muestra el último terminado);
   * - `completed` / `failed` / `cancelled`: terminada.
   */
  phase: 'queued' | 'running' | 'waiting' | 'between' | 'completed' | 'failed' | 'cancelled';
  /** Número del paso (1 … total) que se muestra; 0 si no hay ninguno. */
  index: number;
  /** Pasos de la ejecución sin contar los omitidos. */
  total: number;
  /** Nombre del paso que se muestra ('' si no hay). */
  label: string;
  nodeId: string | null;
}

/**
 * Progreso para el rótulo «Paso 2 de 4 · …». El número del paso en curso es los pasos ya terminados más uno (con pasos
 * en paralelo cuenta el que acompaña el mensajero). Solo cambia cuando cambia de paso o de fase, nunca con la
 * actividad del paso, así que se puede anunciar con aria-live sin repetir.
 */
export function runProgress(snapshot: RunSnapshot, live: RunLive): RunProgress {
  const steps = Object.values(live.steps);
  const known = new Set([...snapshot.workflow.nodes.map((n) => n.id), ...Object.keys(live.steps)]);
  const skipped = steps.filter((s) => s.status === 'skipped').length;
  const total = Math.max(0, known.size - skipped);
  const finished = steps.filter((s) => s.status === 'completed' || s.status === 'failed').length;
  const labelOf = (step: StepLive): string => snapshot.workflow.nodes.find((n) => n.id === step.nodeId)?.label || step.label || step.nodeId;
  const current = latestStep(
    live,
    (s) => isStepActive(s.status),
    (s) => s.startedAt,
  );
  if (current) {
    return {
      phase: current.status === 'waiting' ? 'waiting' : 'running',
      index: Math.min(total, finished + 1),
      total,
      label: labelOf(current),
      nodeId: current.nodeId,
    };
  }
  const lastOf = (status: StepStatus) =>
    latestStep(
      live,
      (s) => s.status === status,
      (s) => s.finishedAt ?? s.startedAt,
    );
  if (live.status === 'completed') return { phase: 'completed', index: finished, total, label: '', nodeId: null };
  if (live.status === 'cancelled') return { phase: 'cancelled', index: finished, total, label: '', nodeId: null };
  if (live.status === 'failed') {
    const failed = lastOf('failed');
    return { phase: 'failed', index: finished, total, label: failed ? labelOf(failed) : '', nodeId: failed?.nodeId ?? null };
  }
  const last = lastOf('completed');
  if (!last) return { phase: 'queued', index: 0, total, label: '', nodeId: null };
  return { phase: 'between', index: finished, total, label: labelOf(last), nodeId: last.nodeId };
}

/** Yōkai de la ejecución: la plantilla (uno por nodo de agente, en el orden del workflow) y, al final, el mensajero. */
export function actorsFromRun(snapshot: RunSnapshot, live: RunLive): Actor[] {
  const finished = isRunFinished(live.status);
  const actors: Actor[] = snapshot.workflow.nodes.filter(nodeUsesAgent).map((node, index) => {
    const agentId: string = node.config?.agentId ?? '';
    const agent = agentId ? snapshot.agents[agentId] : undefined;
    const step = live.steps[node.id];
    const status: StepStatus = step?.status ?? 'pending';
    const atDesk = isStepActive(status) || (!finished && (status === 'completed' || status === 'failed'));
    const room: RoomId = atDesk ? 'cubiculos' : IDLE_ROOM;
    return {
      kind: 'staff',
      key: node.id,
      name: agent?.name ?? '',
      color: agent?.color ?? FALLBACK_COLOR,
      species: speciesFor(agentId || node.id),
      room,
      seat: seatFor(room, index),
      status,
      activity: stepActivity(step, hasOpenTool(live.activity, node.id)),
    };
  });
  const courier = courierState(snapshot, live);
  actors.push({
    kind: 'courier',
    key: 'courier',
    name: '', // la planta pone el rótulo traducido
    color: COURIER_COLOR,
    species: 'ojo',
    room: courier.target.room,
    seat: courier.target.seat,
    status: courier.status,
    activity: courier.target.activity,
  });
  return actors;
}
