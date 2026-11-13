// Contrato del Modo Yōkai: los tipos que comparten el sprite, el mapa y la planta animada. Todas las coordenadas
// están en el espacio de píxeles de la imagen de la planta (`PLAN_SIZE` × `PLAN_SIZE`), con el origen arriba a la izquierda.
import type { StepStatus } from '@shared/types';
import type { AgentActivity } from '../agent-activity';

/** Especies de yōkai disponibles: hay una hoja de sprites por cada una. */
export type YokaiSpecies = 'kitsune' | 'tengu' | 'kappa' | 'tanuki' | 'oni' | 'kasa' | 'nekomata' | 'ojo';

/** Hacia dónde mira un yōkai; cada dirección es una fila de su hoja de sprites. */
export type Facing = 'down' | 'left' | 'right' | 'up';

/** Las salas de la planta. Cada tipo de paso de un workflow vive en una (ver `roomForNode`). */
export type RoomId =
  | 'recepcion' //  entrada
  | 'cubiculos' //  agentes
  | 'servidores' // herramientas
  | 'vestibulo' //  condiciones y subworkflows (ascensor)
  | 'impresoras' // transformaciones
  | 'reunion' //    para cada (mesa redonda)
  | 'despacho' //   aprobaciones (sello hanko)
  | 'correo' //     salida
  | 'cocina'; //    descanso: agentes sin tarea

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Room {
  id: RoomId;
  /** Recuadro de la sala en la imagen. */
  rect: Rect;
  /** Punto de reposo por defecto de la sala (suelo libre). */
  anchor: Point;
  /** Puestos concretos donde se coloca un yōkai (los seis cubículos, las sillas de la reunión…). Al menos uno. */
  seats: Point[];
  /** Punto del suelo del vestíbulo, junto a la puerta de la sala, por donde se entra y se sale. */
  door: Point;
}

/**
 * Un yōkai de una ejecución: lo que necesita la planta para colocarlo y animarlo.
 * - `staff`: la plantilla, un yōkai por cada paso de agente; trabaja en su puesto cuando le toca.
 * - `courier`: el mensajero (siempre uno): el fantasma de un ojo que lleva la hitodama (la llama azul = el dato) de sala
 *   en sala hasta el paso que se está ejecutando.
 */
export interface Actor {
  kind: 'staff' | 'courier';
  /** Estable durante la ejecución: el id del nodo para `staff`, `'courier'` para el mensajero. */
  key: string;
  name: string;
  /** Color del agente (acento, p. ej. de la burbuja). */
  color: string;
  species: YokaiSpecies;
  /** Sala donde está ahora según el estado del paso. */
  room: RoomId;
  /** Puesto concreto dentro de la sala. */
  seat: Point;
  status: StepStatus;
  /** Lo que hace (pensar, escribir…); `undefined` si el orbe se quedaría quieto. */
  activity?: AgentActivity;
}
