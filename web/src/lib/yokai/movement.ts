// Paseo de un yōkai por la planta: lógica pura (sin Vue ni DOM) que avanza una posición a lo largo de una polilínea
// con aceleración al salir y frenada al llegar. La planta llama a `advance` en cada fotograma con el tiempo transcurrido.
//
// El avance se mide en distancia recorrida (`traveled`) sobre el camino: la posición sale de ahí, y también el paso
// (`stepIndex`) con el que la planta sincroniza el balanceo, los fotogramas del sprite y las motas de polvo.
import { facingBetween, planPath } from './map';
import type { Facing, Point } from './types';

/** Velocidad de crucero, en píxeles de la planta por segundo (cruzar la oficina entera lleva unos 5-6 s). */
export const WALK_SPEED = 210;
/** Aceleración al arrancar y deceleración al frenar, en px/s². Con 520 arranca en ~0,4 s y frena en ~0,4 s. */
export const WALK_ACCEL = 520;
/** Velocidad con la que arranca (un paso decidido, no un deslizamiento desde cero). */
const START_SPEED = 45;
/** Largo de una zancada, en píxeles de la planta: un paso cada `STRIDE` de camino. */
export const STRIDE = 30;
/**
 * Histéresis de la dirección: para cambiar de eje (de mirar a los lados a mirar arriba/abajo o al revés) el nuevo eje
 * tiene que dominar por este factor. Así en una diagonal no parpadea entre dos filas del sprite.
 */
export const FACING_HYSTERESIS = 1.35;

export interface Walk {
  /** Camino completo: el primer punto es el origen y el último el destino. */
  path: Point[];
  /** Distancia acumulada desde el origen hasta cada punto del camino. */
  cumulative: number[];
  /** Longitud total del camino. */
  length: number;
  /** Distancia recorrida hasta ahora (0 … `length`). */
  traveled: number;
  /** Índice del punto donde empieza el tramo actual (el tramo va de `path[segment]` a `path[segment + 1]`). */
  segment: number;
  /** Posición actual (pies del yōkai). */
  pos: Point;
  /** Hacia dónde mira: la dirección del movimiento, con histéresis. */
  facing: Facing;
  /** true cuando ya está en el último punto del camino. */
  arrived: boolean;
  /** Velocidad de crucero (máxima), en píxeles de la planta por segundo. */
  speed: number;
  /** Velocidad en este momento. */
  velocity: number;
}

const distance = (a: Point, b: Point): number => Math.hypot(b.x - a.x, b.y - a.y);

/**
 * Dirección con histéresis a partir del desplazamiento (dx, dy): dentro del mismo eje cambia de sentido en cuanto el
 * movimiento lo pide, pero para pasar al otro eje este tiene que dominar por `ratio`. Sin movimiento, conserva `prev`.
 */
export function facingWithHysteresis(prev: Facing, dx: number, dy: number, ratio = FACING_HYSTERESIS): Facing {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax < 1e-9 && ay < 1e-9) return prev;
  const horizontal = prev === 'left' || prev === 'right';
  const toHorizontal = horizontal ? ax * ratio >= ay : ax > ay * ratio;
  if (toHorizontal) return dx > 0 ? 'right' : dx < 0 ? 'left' : prev;
  return dy > 0 ? 'down' : dy < 0 ? 'up' : prev;
}

/** Paseo que empieza en el primer punto de `path`. Un camino de un solo punto (o vacío) ya ha llegado. */
export function walkAlong(path: Point[], speed = WALK_SPEED): Walk {
  const points = path.map((p) => ({ x: p.x, y: p.y }));
  const start = points[0] ?? { x: 0, y: 0 };
  const cumulative = [0];
  for (let i = 1; i < points.length; i++) cumulative.push(cumulative[i - 1] + distance(points[i - 1], points[i]));
  const length = cumulative[cumulative.length - 1];
  return {
    path: points,
    cumulative,
    length,
    traveled: 0,
    segment: 0,
    pos: { ...start },
    facing: points.length < 2 ? 'down' : facingBetween(points[0], points[1]),
    arrived: points.length < 2 || length === 0,
    speed,
    velocity: 0,
  };
}

/** Paseo desde `from` hasta `to` por las puertas y el vestíbulo (`planPath`). */
export function startWalk(from: Point, to: Point, speed = WALK_SPEED): Walk {
  return walkAlong(planPath(from, to), speed);
}

/** Punto del camino a `s` píxeles del origen (recortado a 0 … longitud) y el tramo donde cae. */
export function pointAt(walk: Walk, s: number, hint = 0): { pos: Point; segment: number } {
  const { path, cumulative } = walk;
  if (path.length < 2) return { pos: { ...(path[0] ?? { x: 0, y: 0 }) }, segment: 0 };
  const d = Math.min(walk.length, Math.max(0, s));
  let i = Math.min(Math.max(0, hint), path.length - 2);
  while (i > 0 && cumulative[i] > d) i--;
  while (i < path.length - 2 && cumulative[i + 1] < d) i++;
  const len = cumulative[i + 1] - cumulative[i];
  const k = len > 0 ? (d - cumulative[i]) / len : 1;
  const a = path[i];
  const b = path[i + 1];
  return { pos: { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k }, segment: i };
}

/**
 * Avanza el paseo `dtSeconds` segundos y devuelve el nuevo estado (no modifica el recibido). La velocidad sube con
 * `accel` hasta la de crucero y, cerca del final, baja lo justo para frenar en el destino (perfil trapezoidal con
 * frenada √(2·a·d)); nunca se pasa del último punto. Al llegar conserva la dirección con la que venía.
 */
export function advance(state: Walk, dtSeconds: number, accel = WALK_ACCEL): Walk {
  if (state.arrived) return state;
  const dt = Math.max(0, dtSeconds);
  if (dt === 0) return state;
  const remaining = state.length - state.traveled;
  const braking = Math.sqrt(2 * accel * remaining);
  const velocity = Math.min(state.speed, Math.max(state.velocity, START_SPEED) + accel * dt, Math.max(braking, START_SPEED * 0.5));
  const step = velocity * dt;
  if (step >= remaining - 1e-6) {
    const end = state.path[state.path.length - 1];
    return { ...state, traveled: state.length, segment: state.path.length - 1, pos: { x: end.x, y: end.y }, arrived: true, velocity: 0 };
  }
  const traveled = state.traveled + step;
  const { pos, segment } = pointAt(state, traveled, state.segment);
  // La dirección sale de la cuerda hacia un punto algo más adelante del camino (las curvas tienen tramos muy cortos y una zancada promedia los quiebros).
  const ahead = pointAt(state, traveled + STRIDE * 1.2, segment).pos;
  const facing = facingWithHysteresis(state.facing, ahead.x - pos.x, ahead.y - pos.y);
  return { ...state, traveled, segment, pos, facing, velocity };
}

/** Número de zancadas dadas: cambia cada `STRIDE` píxeles recorridos (para el balanceo y el ciclo de pasos). */
export function stepIndex(walk: Walk): number {
  return Math.floor(walk.traveled / STRIDE);
}

/** Fase dentro de la zancada actual, de 0 (pie en el suelo) a 1 (el siguiente pie en el suelo). */
export function stepPhase(walk: Walk): number {
  return (walk.traveled % STRIDE) / STRIDE;
}

/** Lo que le queda por recorrer: la posición actual y los puntos que faltan (para dibujar la estela). */
export function remainingPath(state: Walk): Point[] {
  if (state.arrived) return [state.pos];
  return [state.pos, ...state.path.slice(state.segment + 1)];
}

/**
 * Baldosas de la estela: puntos fijos del camino cada `spacing` píxeles que aún no se han pisado (la estela se va
 * consumiendo según avanza). No incluye la última, que la ocupa el marcador del destino.
 */
export function trailDots(state: Walk, spacing = 24): Point[] {
  if (state.arrived || spacing <= 0) return [];
  const dots: Point[] = [];
  let hint = state.segment;
  const first = Math.floor(state.traveled / spacing) + 1;
  for (let k = first; k * spacing < state.length - spacing * 0.6; k++) {
    const { pos, segment } = pointAt(state, k * spacing, hint);
    hint = segment;
    dots.push(pos);
  }
  return dots;
}
