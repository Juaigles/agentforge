// Paseo de un yōkai por la planta: lógica pura (sin Vue ni DOM) que avanza una posición a lo largo de una polilínea a
// velocidad constante. La planta llama a `advance` en cada fotograma con el tiempo transcurrido.
import { facingBetween, planPath } from './map';
import type { Facing, Point } from './types';

/** Velocidad de paseo, en píxeles de la planta por segundo (cruzar la oficina entera lleva unos 4-5 s). */
export const WALK_SPEED = 260;

export interface Walk {
  /** Camino completo: el primer punto es el origen y el último el destino. */
  path: Point[];
  /** Índice del punto donde empieza el tramo actual (el tramo va de `path[segment]` a `path[segment + 1]`). */
  segment: number;
  /** Posición actual (pies del yōkai). */
  pos: Point;
  /** Hacia dónde mira: la dirección del tramo actual. */
  facing: Facing;
  /** true cuando ya está en el último punto del camino. */
  arrived: boolean;
  /** Píxeles de la planta por segundo. */
  speed: number;
}

const distance = (a: Point, b: Point): number => Math.hypot(b.x - a.x, b.y - a.y);

/** Dirección del tramo que empieza en `segment` (o la del último tramo si ya no quedan); 'down' sin tramos. */
function segmentFacing(path: Point[], segment: number): Facing {
  if (path.length < 2) return 'down';
  const i = Math.min(segment, path.length - 2);
  return facingBetween(path[i], path[i + 1]);
}

/** Paseo que empieza en el primer punto de `path`. Un camino de un solo punto (o vacío) ya ha llegado. */
export function walkAlong(path: Point[], speed = WALK_SPEED): Walk {
  const points = path.map((p) => ({ x: p.x, y: p.y }));
  const start = points[0] ?? { x: 0, y: 0 };
  return { path: points, segment: 0, pos: { ...start }, facing: segmentFacing(points, 0), arrived: points.length < 2, speed };
}

/** Paseo desde `from` hasta `to` por las puertas y el vestíbulo (`planPath`). */
export function startWalk(from: Point, to: Point, speed = WALK_SPEED): Walk {
  return walkAlong(planPath(from, to), speed);
}

/**
 * Avanza el paseo `dtSeconds` segundos y devuelve el nuevo estado (no modifica el recibido). Cruza tantos tramos como
 * dé el tiempo y nunca se pasa del último punto; al llegar conserva la dirección del último tramo.
 */
export function advance(state: Walk, dtSeconds: number): Walk {
  if (state.arrived) return state;
  const { path } = state;
  let budget = Math.max(0, dtSeconds) * state.speed;
  let segment = state.segment;
  let pos = { ...state.pos };
  while (segment < path.length - 1) {
    const target = path[segment + 1];
    const d = distance(pos, target);
    if (budget < d) {
      const k = budget / d;
      pos = { x: pos.x + (target.x - pos.x) * k, y: pos.y + (target.y - pos.y) * k };
      return { ...state, segment, pos, facing: segmentFacing(path, segment), arrived: false };
    }
    budget -= d;
    pos = { x: target.x, y: target.y };
    segment++;
  }
  return { ...state, segment: path.length - 1, pos, facing: segmentFacing(path, segment), arrived: true };
}

/** Lo que le queda por recorrer: la posición actual y los puntos que faltan (para dibujar la estela). */
export function remainingPath(state: Walk): Point[] {
  if (state.arrived) return [state.pos];
  return [state.pos, ...state.path.slice(state.segment + 1)];
}
