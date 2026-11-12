// Mapa de la planta del Modo Yōkai: dónde está cada sala en la imagen (web/public/yokai/planta.png), dónde se coloca
// cada yōkai y por dónde camina de una sala a otra. Las coordenadas están en píxeles de la imagen (`PLAN_SIZE` de
// lado) y cada punto es donde el yōkai apoya los pies; se calibraron sobre recortes ampliados de la imagen y una
// superposición de depuración para que caigan en suelo libre (delante de los muebles, no encima).
//
// Distribución (vista desde arriba):
//   despacho   | correo    | servidores
//   impresoras | vestíbulo | cubículos
//   cocina     | recepción | reunión
// El vestíbulo es el hall central de mármol (ascensor, escalera y el cerezo) y todas las demás salas dan a él.
//
// Navegación: `WALKABLE` es la máscara de suelo transitable (rectángulos) y `NAV` un grafo de waypoints cuyas aristas
// son los pares de waypoints que se ven en línea recta sin salir de la máscara. `planPath` va en línea recta si puede
// y, si no, por el camino más corto del grafo; como entre salas solo hay suelo transitable en los pasos de las puertas,
// cualquier cambio de sala sale por la puerta de la suya, cruza el vestíbulo y entra por la de destino.
//
// Sobre las puertas: el dibujo solo tiene huecos de verdad en el despacho (una rendija entre el panel diagonal y el
// pilar), el correo (el mostrador da al vestíbulo entre dos pilares) y la recepción (umbral entre pilares, aunque detrás
// está la pared del fondo). En el resto de salas el dibujo está cerrado y el paso se ha puesto donde el muro es más
// fino y no hay muebles: junto a un pilar (impresoras, cubículos, reunión), por la esquina del chaflán (servidores) o
// por el pasillo estrecho entre el pilar y el banco y luego junto a la papelera (cocina).
import type { NodeType } from '@shared/types';
import type { Facing, Point, Rect, Room, RoomId } from './types';

const rect = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });
const pt = (x: number, y: number): Point => ({ x, y });

/**
 * Las nueve salas. La `door` es un punto del suelo del vestíbulo (dentro de su `rect`) junto al paso por el que se
 * entra en la sala, así que queda FUERA del recuadro de la propia sala; la del vestíbulo es su centro (el claro de
 * mármol bajo el cerezo).
 */
export const ROOMS: Record<RoomId, Room> = {
  despacho: {
    id: 'despacho',
    rect: rect(58, 55, 390, 365),
    anchor: pt(400, 400),
    // Delante del escritorio, junto al sillón de la derecha y junto al de la izquierda.
    seats: [pt(250, 322), pt(395, 335), pt(140, 350)],
    door: pt(458, 440),
  },
  correo: {
    id: 'correo',
    rect: rect(478, 55, 298, 250),
    anchor: pt(625, 298),
    // Ante el mostrador (que da al vestíbulo) y junto a la carretilla de paquetes.
    seats: [pt(595, 300), pt(655, 300), pt(722, 272)],
    door: pt(625, 335),
  },
  servidores: {
    id: 'servidores',
    rect: rect(810, 55, 386, 268),
    anchor: pt(1080, 300),
    // Delante de los racks y en la silla del puesto de monitores.
    seats: [pt(870, 290), pt(960, 276), pt(1140, 300)],
    door: pt(782, 384),
  },
  cubiculos: {
    id: 'cubiculos',
    rect: rect(812, 330, 384, 372),
    anchor: pt(1020, 685),
    // Una silla por cubículo: fila de arriba de izquierda a derecha y luego la de abajo.
    seats: [pt(898, 490), pt(1022, 490), pt(1138, 490), pt(900, 662), pt(1022, 662), pt(1138, 662)],
    door: pt(782, 622),
  },
  impresoras: {
    id: 'impresoras',
    rect: rect(58, 445, 380, 260),
    anchor: pt(395, 640),
    // Delante de las dos fotocopiadoras y de la destructora de papel.
    seats: [pt(130, 630), pt(225, 628), pt(330, 628)],
    door: pt(462, 622),
  },
  cocina: {
    id: 'cocina',
    rect: rect(58, 718, 330, 405),
    anchor: pt(340, 980),
    // Ante la encimera de la tetera y alrededor de la mesa baja (cojines y laterales).
    seats: [pt(265, 932), pt(175, 972), pt(250, 972), pt(175, 1082), pt(250, 1082), pt(115, 1010), pt(320, 1010)],
    door: pt(448, 716),
  },
  reunion: {
    id: 'reunion',
    rect: rect(850, 718, 346, 405),
    anchor: pt(866, 1060),
    // Las ocho sillas de la mesa redonda, en el sentido de las agujas del reloj desde la de arriba.
    seats: [pt(1000, 885), pt(1078, 915), pt(1105, 990), pt(1065, 1060), pt(1000, 1070), pt(945, 1060), pt(902, 990), pt(930, 915)],
    door: pt(796, 716),
  },
  recepcion: {
    id: 'recepcion',
    rect: rect(455, 892, 330, 310),
    anchor: pt(610, 1110),
    // Ante el mostrador: en el centro (bajo el torii) y a sus dos lados.
    seats: [pt(610, 1110), pt(486, 1098), pt(745, 1098)],
    door: pt(535, 882),
  },
  vestibulo: {
    id: 'vestibulo',
    rect: rect(448, 305, 358, 587),
    anchor: pt(625, 770),
    // Delante del ascensor, delante de la escalera y a ambos lados del cerezo.
    seats: [pt(560, 592), pt(690, 596), pt(548, 690), pt(702, 690)],
    door: pt(625, 770),
  },
};

/** Orden en que `roomAt` prueba las salas: el vestíbulo el último (sus bordes tocan los de las demás). */
const ROOM_ORDER: RoomId[] = ['despacho', 'correo', 'servidores', 'impresoras', 'cubiculos', 'cocina', 'reunion', 'recepcion', 'vestibulo'];

/** Sala donde vive cada tipo de paso de un workflow. */
const NODE_ROOM: Record<NodeType, RoomId> = {
  input: 'recepcion',
  agent: 'cubiculos',
  tool: 'servidores',
  condition: 'vestibulo',
  transform: 'impresoras',
  foreach: 'reunion',
  subworkflow: 'vestibulo', // el ascensor
  approval: 'despacho',
  output: 'correo',
};

/** Sala de los agentes sin tarea. */
export const IDLE_ROOM: RoomId = 'cocina';

export function roomForNode(type: NodeType): RoomId {
  return NODE_ROOM[type];
}

/** Puesto n-ésimo de la sala; si hay más yōkai que puestos, se da la vuelta (el 7.º cubículo es el 1.º otra vez). */
export function seatFor(room: RoomId, index: number): Point {
  const seats = ROOMS[room].seats;
  const i = ((Math.trunc(index) % seats.length) + seats.length) % seats.length;
  return seats[i];
}

const inRect = (p: Point, r: Rect): boolean => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;

/** Sala que contiene el punto (bordes incluidos), o null si cae en un muro o fuera de la planta. */
export function roomAt(p: Point): RoomId | null {
  for (const id of ROOM_ORDER) if (inRect(p, ROOMS[id].rect)) return id;
  return null;
}

// ---------- Suelo transitable ----------

/**
 * Máscara de suelo transitable: los suelos libres de cada sala (sin muebles; las sillas y cojines de los puestos sí
 * cuentan, porque el yōkai se sienta en ellos), los pasos de las puertas y el mármol del vestíbulo (sin el bloque del
 * ascensor y la escalera, las macetas, el cerezo ni los bancos). Todo tramo de `planPath` queda dentro.
 */
export const WALKABLE: Rect[] = [
  // Vestíbulo
  rect(522, 310, 206, 72), // pasillo de arriba, ante el correo
  rect(478, 356, 44, 36), // bajo el chaflán izquierdo
  rect(728, 350, 35, 42), // bajo el chaflán derecho
  rect(763, 370, 22, 22),
  rect(450, 392, 35, 100), // pasillo izquierdo (entre la pared y el farol)
  rect(450, 490, 20, 85), // … entre la pared y la maceta
  rect(768, 388, 32, 104), // pasillo derecho
  rect(779, 490, 16, 85),
  rect(448, 572, 350, 16), // franja bajo el ascensor y la escalera
  rect(448, 572, 114, 140), // a la izquierda del cerezo
  rect(688, 572, 108, 140), // a la derecha del cerezo
  rect(448, 705, 350, 22), // sobre los bancos
  rect(405, 705, 43, 22), // rincón del panel diagonal izquierdo
  rect(488, 712, 276, 180), // mitad sur, entre bancos y macetas
  // Despacho y su rendija
  rect(386, 252, 50, 170), // franja este (bajo la estantería)
  rect(132, 388, 304, 32), // franja sur (bajo los sillones)
  rect(133, 250, 27, 170), // entre la armadura y el sillón izquierdo
  rect(133, 248, 42, 70), // a la izquierda del escritorio
  rect(160, 312, 226, 9), // entre el escritorio y los sillones
  rect(222, 312, 98, 18), // delante del escritorio, entre los sillones
  rect(428, 392, 9, 40), // rendija entre el panel diagonal y el pilar
  rect(428, 426, 22, 18), // al pie del pilar, ya en el vestíbulo
  // Correo
  rect(522, 288, 214, 13), // ante el mostrador
  rect(522, 236, 22, 65), // junto a la maceta
  rect(708, 252, 22, 49), // junto a la carretilla
  rect(560, 286, 130, 26), // umbral entre los pilares
  // Servidores
  rect(818, 270, 92, 48), // ante los racks
  rect(908, 268, 132, 14), // entre los racks y la tubería
  rect(908, 306, 284, 12), // bajo la tubería
  rect(1052, 272, 56, 46), // ante la mesa de monitores
  rect(1156, 272, 34, 46),
  rect(1134, 294, 12, 14), // la silla del puesto
  rect(798, 312, 22, 35), // paso por la esquina del chaflán
  rect(788, 343, 14, 49),
  // Cubículos
  rect(822, 486, 24, 160), // franja oeste
  rect(822, 486, 370, 12), // pasillo entre las dos filas
  rect(846, 600, 32, 44), // hacia el pasillo sur, por encima de la maceta
  rect(872, 600, 8, 68),
  rect(872, 666, 280, 34), // pasillo sur
  rect(894, 656, 12, 12), // sillas de la fila de abajo
  rect(1016, 656, 12, 12),
  rect(1132, 656, 12, 12),
  rect(788, 618, 36, 16), // paso junto al pilar
  // Impresoras
  rect(110, 614, 320, 8), // ante las fotocopiadoras
  rect(110, 614, 137, 23),
  rect(295, 614, 135, 23), // ante la destructora
  rect(367, 610, 63, 95), // junto al jardín zen
  rect(426, 612, 26, 20), // paso junto al pilar
  // Cocina
  rect(60, 926, 280, 14), // ante la encimera
  rect(104, 938, 30, 182), // a la izquierda de la mesa baja
  rect(292, 936, 83, 184), // a la derecha
  rect(104, 1086, 271, 34), // por debajo
  rect(150, 938, 52, 37), // cojines
  rect(227, 938, 50, 37),
  rect(150, 1042, 52, 44),
  rect(227, 1042, 50, 44),
  rect(436, 712, 5, 180), // pasillo estrecho entre el pilar y el banco/maceta
  rect(400, 886, 42, 50), // paso por el pie del pilar
  rect(372, 932, 36, 32), // junto a la papelera
  // Reunión
  rect(878, 846, 267, 8), // bajo la pizarra
  rect(896, 846, 9, 40), // entre el farol y la silla de arriba a la izquierda
  rect(878, 880, 27, 28),
  rect(852, 882, 30, 236), // franja oeste
  rect(1110, 846, 28, 72), // franja noreste
  rect(1138, 918, 12, 172), // franja este
  rect(852, 1088, 300, 30), // franja sur
  rect(994, 846, 12, 42), // acceso a cada silla de la mesa redonda
  rect(1072, 909, 40, 12),
  rect(1099, 984, 40, 12),
  rect(1059, 1054, 12, 38),
  rect(994, 1064, 12, 28),
  rect(939, 1054, 12, 38),
  rect(878, 984, 30, 12),
  rect(898, 905, 38, 16),
  rect(798, 712, 4, 185), // pasillo estrecho entre el banco/maceta y el pilar
  rect(798, 888, 30, 20), // paso por el pie del pilar
  rect(824, 898, 40, 14),
  // Recepción
  rect(522, 880, 16, 26), // umbral entre los pilares
  rect(486, 898, 40, 30), // pared del fondo, a la izquierda del farol
  rect(478, 925, 17, 175), // entre el armario y el farol de pie
  rect(478, 1094, 282, 8), // ante el mostrador
  rect(560, 1094, 120, 106), // bajo el torii
];

/** Rejilla de cubos para no recorrer todos los rectángulos en cada consulta. */
const BUCKET = 32;
const BUCKETS: Map<number, Rect[]> = (() => {
  const map = new Map<number, Rect[]>();
  for (const r of WALKABLE)
    for (let bx = Math.floor(r.x / BUCKET); bx <= Math.floor((r.x + r.w) / BUCKET); bx++)
      for (let by = Math.floor(r.y / BUCKET); by <= Math.floor((r.y + r.h) / BUCKET); by++) {
        const key = by * 1000 + bx;
        const list = map.get(key);
        if (list) list.push(r);
        else map.set(key, [r]);
      }
  return map;
})();

/** Si el punto está en suelo transitable. */
export function isWalkable(p: Point): boolean {
  const list = BUCKETS.get(Math.floor(p.y / BUCKET) * 1000 + Math.floor(p.x / BUCKET));
  return !!list && list.some((r) => inRect(p, r));
}

/** Si el tramo recto de `a` a `b` va entero por suelo transitable (muestreado cada píxel). */
function segmentWalkable(a: Point, b: Point): boolean {
  const n = Math.max(1, Math.ceil(distance(a, b)));
  for (let i = 0; i <= n; i++) if (!isWalkable({ x: a.x + ((b.x - a.x) * i) / n, y: a.y + ((b.y - a.y) * i) / n })) return false;
  return true;
}

// ---------- Navegación ----------

export interface NavGraph {
  /** Waypoints. Los que se llaman como una sala son su `door`; `sala:n` y `sala:reposo`, sus puestos y su reposo. */
  nodes: Readonly<Record<string, Point>>;
  /** Aristas no dirigidas: los pares de waypoints que se ven en línea recta por suelo transitable. */
  edges: readonly (readonly [string, string])[];
}

/** Waypoints intermedios: recodos del vestíbulo y de cada sala, y los pasos de las puertas. */
const WAYPOINTS: Record<string, Point> = {
  'vestibulo:arribaIzq': pt(500, 372),
  'vestibulo:arribaDer': pt(745, 372),
  'vestibulo:pasilloIzq1': pt(465, 470),
  'vestibulo:pasilloIzq2': pt(460, 560),
  'vestibulo:pasilloDer1': pt(785, 470),
  'vestibulo:pasilloDer2': pt(787, 560),
  'vestibulo:cerezoIzq': pt(512, 655),
  'vestibulo:cerezoDer': pt(742, 655),
  'despacho:rendija': pt(432, 400),
  'despacho:rendija2': pt(432, 428),
  'despacho:pilar': pt(446, 440),
  'despacho:sur': pt(145, 400),
  'despacho:oeste': pt(145, 300),
  'despacho:escritorio': pt(170, 315),
  'despacho:este': pt(392, 316),
  'correo:umbral': pt(625, 312),
  'correo:este': pt(720, 294),
  'correo:oeste': pt(535, 294),
  'servidores:pasillo': pt(790, 388),
  'servidores:esquina': pt(800, 345),
  'servidores:esquina2': pt(814, 316),
  'servidores:oeste': pt(840, 300),
  'servidores:tuberia': pt(905, 312),
  'servidores:tuberia2': pt(1080, 312),
  'servidores:tuberia3': pt(1140, 312),
  'servidores:racks': pt(920, 276),
  'cubiculos:pilar': pt(790, 625),
  'cubiculos:paso': pt(834, 628),
  'cubiculos:pasillo': pt(834, 492),
  'cubiculos:enlace': pt(860, 620),
  'cubiculos:enlace2': pt(876, 650),
  'cubiculos:sur': pt(876, 684),
  'cubiculos:surEste': pt(1140, 684),
  'impresoras:pilar': pt(452, 622),
  'impresoras:paso': pt(420, 622),
  'impresoras:copias': pt(240, 618),
  'cocina:pasillo': pt(439, 720),
  'cocina:pilar': pt(439, 890),
  'cocina:muro': pt(406, 934),
  'cocina:papelera': pt(374, 962),
  'cocina:encimera': pt(320, 931),
  'cocina:encimera2': pt(120, 931),
  'cocina:cojines': pt(175, 934),
  'cocina:cojines2': pt(250, 934),
  'cocina:suroeste': pt(120, 1100),
  'cocina:sureste': pt(330, 1100),
  'reunion:pasillo': pt(800, 720),
  'reunion:pilar': pt(800, 893),
  'reunion:paso': pt(826, 905),
  'reunion:oeste': pt(866, 905),
  'reunion:farol': pt(900, 884),
  'reunion:farol2': pt(900, 906),
  'reunion:norte': pt(900, 850),
  'reunion:norte2': pt(1000, 850),
  'reunion:noreste': pt(1124, 850),
  'reunion:noreste2': pt(1120, 915),
  'reunion:este': pt(1144, 925),
  'reunion:este2': pt(1144, 990),
  'reunion:sureste': pt(1144, 1100),
  'reunion:sur': pt(1065, 1100),
  'reunion:sur2': pt(1000, 1100),
  'reunion:sur3': pt(945, 1100),
  'reunion:suroeste': pt(866, 1100),
  'reunion:oeste2': pt(866, 990),
  'recepcion:umbral': pt(530, 900),
  'recepcion:muro': pt(490, 926),
  'recepcion:mostrador': pt(486, 1098),
  'recepcion:centro': pt(610, 1098),
};

const distance = (a: Point, b: Point): number => Math.hypot(b.x - a.x, b.y - a.y);
const samePoint = (a: Point, b: Point): boolean => a.x === b.x && a.y === b.y;

const NODE_IDS: string[] = [];
const NODE_POINTS: Point[] = [];
function addNode(id: string, p: Point): void {
  NODE_IDS.push(id);
  NODE_POINTS.push(p);
}
for (const id of ROOM_ORDER) addNode(id, ROOMS[id].door);
for (const [id, p] of Object.entries(WAYPOINTS)) addNode(id, p);
for (const id of ROOM_ORDER) {
  ROOMS[id].seats.forEach((p, i) => addNode(`${id}:${i}`, p));
  addNode(`${id}:reposo`, ROOMS[id].anchor);
}

const N = NODE_IDS.length;
/** Distancias del camino más corto entre waypoints y siguiente salto (Floyd–Warshall, se calcula una vez). */
const DIST: Float64Array = new Float64Array(N * N).fill(Infinity);
const NEXT: Int32Array = new Int32Array(N * N).fill(-1);
const EDGES: [string, string][] = [];
for (let i = 0; i < N; i++) {
  DIST[i * N + i] = 0;
  NEXT[i * N + i] = i;
  for (let j = i + 1; j < N; j++) {
    if (!segmentWalkable(NODE_POINTS[i], NODE_POINTS[j])) continue;
    const d = distance(NODE_POINTS[i], NODE_POINTS[j]);
    DIST[i * N + j] = DIST[j * N + i] = d;
    NEXT[i * N + j] = j;
    NEXT[j * N + i] = i;
    EDGES.push([NODE_IDS[i], NODE_IDS[j]]);
  }
}
for (let k = 0; k < N; k++)
  for (let i = 0; i < N; i++) {
    const ik = DIST[i * N + k];
    if (ik === Infinity) continue;
    for (let j = 0; j < N; j++) {
      const d = ik + DIST[k * N + j];
      if (d < DIST[i * N + j]) {
        DIST[i * N + j] = d;
        NEXT[i * N + j] = NEXT[i * N + k];
      }
    }
  }

export const NAV: NavGraph = {
  nodes: Object.fromEntries(NODE_IDS.map((id, i) => [id, NODE_POINTS[i]])),
  edges: EDGES,
};

/** Waypoints que se ven desde un punto (se recuerdan: la planta pregunta muchas veces por los mismos puestos). */
const visibleCache = new Map<string, number[]>();
function visibleNodes(p: Point): number[] {
  const key = `${p.x},${p.y}`;
  let found = visibleCache.get(key);
  if (!found) {
    found = [];
    for (let i = 0; i < N; i++) if (segmentWalkable(p, NODE_POINTS[i])) found.push(i);
    // Un punto fuera del suelo transitable entra al grafo por el waypoint más cercano.
    if (!found.length) {
      let best = 0;
      for (let i = 1; i < N; i++) if (distance(p, NODE_POINTS[i]) < distance(p, NODE_POINTS[best])) best = i;
      found.push(best);
    }
    if (visibleCache.size >= 512) visibleCache.clear();
    visibleCache.set(key, found);
  }
  return found;
}

/**
 * Polilínea que recorre un yōkai de `from` a `to` (el primer punto es `from` y el último `to`, sin puntos repetidos
 * seguidos). Si se ven en línea recta por suelo transitable (lo normal dentro de una sala), va directo; si no, entra
 * al grafo por el waypoint visible que da el camino más corto y sale por el que mejor llega a `to`. Al cambiar de sala
 * eso supone salir por el paso de la puerta de la suya, cruzar el vestíbulo y entrar por la puerta de destino.
 */
export function planPath(from: Point, to: Point): Point[] {
  const start = pt(from.x, from.y);
  const end = pt(to.x, to.y);
  if (samePoint(start, end)) return [start];
  if (segmentWalkable(start, end)) return [start, end];
  let best = Infinity;
  let bestA = -1;
  let bestB = -1;
  const ends = visibleNodes(end);
  for (const a of visibleNodes(start)) {
    const da = distance(start, NODE_POINTS[a]);
    for (const b of ends) {
      const total = da + DIST[a * N + b] + distance(NODE_POINTS[b], end);
      if (total < best) {
        best = total;
        bestA = a;
        bestB = b;
      }
    }
  }
  const points: Point[] = [start];
  if (bestA >= 0 && best < Infinity) {
    for (let k = bestA; ; k = NEXT[k * N + bestB]) {
      points.push(pt(NODE_POINTS[k].x, NODE_POINTS[k].y));
      if (k === bestB) break;
    }
  }
  points.push(end);
  return points.filter((p, i) => i === 0 || !samePoint(p, points[i - 1]));
}

/** Hacia dónde mira un yōkai que va de `from` a `to`: el eje que más cambia manda (en empate, el horizontal). */
export function facingBetween(from: Point, to: Point): Facing {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx === 0 && dy === 0) return 'down';
  if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? 'right' : 'left';
  return dy > 0 ? 'down' : 'up';
}

/** Longitud total de una polilínea, en píxeles de la planta. */
export function pathLength(points: Point[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += distance(points[i - 1], points[i]);
  return total;
}
