import type { NodeType } from '@shared/types';
import { describe, expect, it } from 'vitest';
import { PLAN_SIZE } from './assets';
import {
  facingBetween,
  IDLE_ROOM,
  isWalkable,
  NAV,
  pathLength,
  planPath,
  pullString,
  ROOMS,
  roomAt,
  roomForNode,
  roundCorners,
  seatFor,
  WALKABLE,
} from './map';
import type { Point, Rect, RoomId } from './types';

const ROOM_IDS = Object.keys(ROOMS) as RoomId[];
const inside = (p: Point, r: Rect): boolean => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
const inPlan = (p: Point): boolean => p.x >= 0 && p.x <= PLAN_SIZE && p.y >= 0 && p.y <= PLAN_SIZE;
/** Comprobación independiente de la de map.ts: recorre la lista de rectángulos tal cual. */
const walkable = (p: Point): boolean => WALKABLE.some((r) => inside(p, r));

/** Reposo y puestos de una sala (los que pertenecen a la sala). */
const spots = (id: RoomId): Point[] => [ROOMS[id].anchor, ...ROOMS[id].seats];

/** Puntos intermedios de un tramo, cada `step` píxeles como mucho, extremos incluidos. */
function samples(a: Point, b: Point, step = 4): Point[] {
  const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
  return Array.from({ length: n + 1 }, (_, i) => ({ x: a.x + ((b.x - a.x) * i) / n, y: a.y + ((b.y - a.y) * i) / n }));
}

/** Todos los puntos con su sala: reposo, puerta (en el vestíbulo) y puestos de cada sala. */
const ALL_SPOTS: { room: RoomId; p: Point }[] = ROOM_IDS.flatMap((id) => [
  { room: id, p: ROOMS[id].anchor },
  { room: 'vestibulo' as RoomId, p: ROOMS[id].door },
  ...ROOMS[id].seats.map((p) => ({ room: id, p })),
]);
/**
 * Puntos para probar caminos entre todos los pares: reposo, puerta y unos cuantos puestos por sala (el primero, el
 * último y uno intermedio, que cubren los extremos de cada sala). Son deterministas.
 */
const RELEVANT: { room: RoomId; p: Point }[] = ROOM_IDS.flatMap((id) => {
  const seats = ROOMS[id].seats;
  const picked = [...new Set([0, Math.floor(seats.length / 2), seats.length - 1])].map((i) => seats[i]);
  return [{ room: id, p: ROOMS[id].anchor }, { room: 'vestibulo' as RoomId, p: ROOMS[id].door }, ...picked.map((p) => ({ room: id, p }))];
});

describe('salas de la planta', () => {
  it('tiene las nueve salas con su id y al menos un puesto', () => {
    expect([...ROOM_IDS].sort()).toEqual(['cocina', 'correo', 'cubiculos', 'despacho', 'impresoras', 'recepcion', 'reunion', 'servidores', 'vestibulo']);
    for (const id of ROOM_IDS) {
      expect(ROOMS[id].id).toBe(id);
      expect(ROOMS[id].seats.length).toBeGreaterThan(0);
    }
    expect(ROOMS.cubiculos.seats).toHaveLength(6);
  });

  it('todos los puntos caen dentro de la planta y de su sala; la puerta, en el vestíbulo', () => {
    for (const id of ROOM_IDS) {
      const room = ROOMS[id];
      const r = room.rect;
      expect(r.x >= 0 && r.y >= 0 && r.x + r.w <= PLAN_SIZE && r.y + r.h <= PLAN_SIZE, id).toBe(true);
      for (const p of spots(id)) {
        expect(inPlan(p), `${id} ${p.x},${p.y}`).toBe(true);
        expect(inside(p, r), `${id} ${p.x},${p.y}`).toBe(true);
      }
      // La puerta es suelo del vestíbulo junto al paso de la sala (queda fuera del recuadro de la sala lateral).
      expect(inPlan(room.door)).toBe(true);
      expect(inside(room.door, ROOMS.vestibulo.rect), `puerta de ${id}`).toBe(true);
      expect(roomAt(room.door)).toBe('vestibulo');
    }
    expect(ROOMS.vestibulo.door).toEqual(ROOMS.vestibulo.anchor);
  });

  it('roomAt devuelve la sala de cada reposo y puesto, y null fuera de las salas', () => {
    for (const id of ROOM_IDS) for (const p of spots(id)) expect(roomAt(p), `${id} ${p.x},${p.y}`).toBe(id);
    expect(roomAt({ x: 5, y: 5 })).toBeNull();
    expect(roomAt({ x: 1250, y: 1250 })).toBeNull();
    expect(roomAt({ x: 795, y: 40 })).toBeNull(); // muro entre el correo y los servidores
  });

  it('los recuadros de las salas no se solapan (salvo, como mucho, en un borde)', () => {
    for (const a of ROOM_IDS)
      for (const b of ROOM_IDS) {
        if (a >= b) continue;
        const ra = ROOMS[a].rect;
        const rb = ROOMS[b].rect;
        const overlapW = Math.min(ra.x + ra.w, rb.x + rb.w) - Math.max(ra.x, rb.x);
        const overlapH = Math.min(ra.y + ra.h, rb.y + rb.h) - Math.max(ra.y, rb.y);
        expect(overlapW <= 0 || overlapH <= 0, `${a} y ${b}`).toBe(true);
      }
  });
});

describe('suelo transitable', () => {
  it('cabe en la planta y contiene todos los reposos, puestos y puertas', () => {
    for (const r of WALKABLE) expect(r.w > 0 && r.h > 0 && inPlan(r) && inPlan({ x: r.x + r.w, y: r.y + r.h }), JSON.stringify(r)).toBe(true);
    for (const { room, p } of ALL_SPOTS) {
      expect(walkable(p), `${room} ${p.x},${p.y}`).toBe(true);
      expect(isWalkable(p)).toBe(true);
    }
  });

  it('isWalkable coincide con la lista de rectángulos', () => {
    const mismatches: string[] = [];
    for (let y = 0; y <= PLAN_SIZE; y += 9)
      for (let x = 0; x <= PLAN_SIZE; x += 9) if (isWalkable({ x, y }) !== walkable({ x, y })) mismatches.push(`${x},${y}`);
    expect(mismatches).toEqual([]);
  });

  it('deja fuera los muebles y muros obvios', () => {
    expect(walkable({ x: 265, y: 270 })).toBe(false); // escritorio del despacho
    expect(walkable({ x: 560, y: 470 })).toBe(false); // ascensor
    expect(walkable({ x: 625, y: 680 })).toBe(false); // maceta del cerezo
    expect(walkable({ x: 1003, y: 960 })).toBe(false); // mesa redonda
    expect(walkable({ x: 620, y: 1060 })).toBe(false); // mostrador de la recepción
    expect(walkable({ x: 446, y: 650 })).toBe(false); // muro entre impresoras y vestíbulo (fuera del paso)
  });
});

describe('roomForNode', () => {
  it('pone cada tipo de paso en su sala', () => {
    const table: Record<NodeType, RoomId> = {
      input: 'recepcion',
      agent: 'cubiculos',
      tool: 'servidores',
      condition: 'vestibulo',
      transform: 'impresoras',
      foreach: 'reunion',
      subworkflow: 'vestibulo',
      approval: 'despacho',
      output: 'correo',
    };
    for (const [type, room] of Object.entries(table)) expect(roomForNode(type as NodeType)).toBe(room);
    expect(IDLE_ROOM).toBe('cocina');
  });
});

describe('seatFor', () => {
  it('da el puesto n-ésimo y vuelve a empezar cuando se acaban', () => {
    const seats = ROOMS.cubiculos.seats;
    for (let i = 0; i < 6; i++) expect(seatFor('cubiculos', i)).toEqual(seats[i]);
    expect(seatFor('cubiculos', 6)).toEqual(seats[0]);
    expect(seatFor('cubiculos', 7)).toEqual(seats[1]);
    expect(seatFor('cubiculos', 13)).toEqual(seats[1]);
    expect(seatFor('despacho', 3)).toEqual(ROOMS.despacho.seats[0]);
    expect(seatFor('vestibulo', -1)).toEqual(ROOMS.vestibulo.seats.at(-1));
  });
});

describe('grafo de navegación', () => {
  it('sus waypoints y aristas van por suelo transitable', () => {
    const outside = Object.entries(NAV.nodes)
      .filter(([, p]) => !walkable(p))
      .map(([id]) => id);
    for (const [a, b] of NAV.edges) if (!samples(NAV.nodes[a], NAV.nodes[b]).every(walkable)) outside.push(`${a}–${b}`);
    expect(outside).toEqual([]);
  });

  it('es conexo y tiene la puerta de cada sala', () => {
    for (const id of ROOM_IDS) expect(NAV.nodes[id]).toEqual(ROOMS[id].door);
    const neighbours = new Map<string, string[]>();
    for (const [a, b] of NAV.edges) {
      neighbours.set(a, [...(neighbours.get(a) ?? []), b]);
      neighbours.set(b, [...(neighbours.get(b) ?? []), a]);
    }
    const seen = new Set(['vestibulo']);
    const queue = ['vestibulo'];
    while (queue.length) for (const next of neighbours.get(queue.shift()!) ?? []) if (!seen.has(next) && seen.add(next)) queue.push(next);
    expect(seen.size).toBe(Object.keys(NAV.nodes).length);
  });
});

describe('planPath', () => {
  it('va en línea recta si se ve el destino', () => {
    const [a, b] = ROOMS.cubiculos.seats;
    expect(planPath(a, b)).toEqual([a, b]);
    expect(planPath(a, a)).toEqual([a]);
  });

  it('rodea los muebles dentro de una sala', () => {
    // Del puesto junto a la carretilla al del mostrador: el mostrador queda en medio.
    const path = planPath(ROOMS.correo.seats[2], ROOMS.correo.seats[0]);
    expect(path.length).toBeGreaterThan(2);
  });

  it('entre salas cruza el vestíbulo', () => {
    const path = planPath(ROOMS.cocina.seats[0], ROOMS.servidores.seats[2]);
    const rooms = new Set(path.flatMap((p, i) => (i ? samples(path[i - 1], p) : [p])).map(roomAt));
    expect(rooms.has('vestibulo')).toBe(true);
    expect(path.length).toBeGreaterThan(4);
  });

  it('entre salas laterales vecinas no da la vuelta por el otro lado del vestíbulo', () => {
    const path = planPath(ROOMS.despacho.anchor, ROOMS.impresoras.anchor);
    expect(path.every((p) => p.x < 625)).toBe(true);
  });

  it('para los reposos, puertas y varios puestos de cada sala: extremos correctos, sin repetir puntos, por suelo transitable y sin cruzar salas ajenas', () => {
    // Se acumulan los fallos y se comprueba cada tramo distinto una sola vez (muchos caminos comparten los del vestíbulo).
    const problems: string[] = [];
    const segmentRooms = new Map<string, Set<RoomId | null>>();
    for (const a of RELEVANT)
      for (const b of RELEVANT) {
        const path = planPath(a.p, b.p);
        const label = `${a.room}(${a.p.x},${a.p.y}) → ${b.room}(${b.p.x},${b.p.y})`;
        const first = path[0];
        const last = path[path.length - 1];
        if (first.x !== a.p.x || first.y !== a.p.y || last.x !== b.p.x || last.y !== b.p.y) problems.push(`${label}: extremos`);
        if ((a.p.x !== b.p.x || a.p.y !== b.p.y) && !(pathLength(path) > 0)) problems.push(`${label}: longitud 0`);
        const allowed = new Set<RoomId | null>([null, 'vestibulo', a.room, b.room]);
        for (let i = 1; i < path.length; i++) {
          const s = path[i - 1];
          const t = path[i];
          if (s.x === t.x && s.y === t.y) problems.push(`${label}: punto repetido`);
          const key = `${s.x},${s.y}|${t.x},${t.y}`;
          let rooms = segmentRooms.get(key);
          if (!rooms) {
            rooms = new Set();
            for (const q of samples(s, t)) {
              if (!walkable(q)) problems.push(`${label}: (${q.x.toFixed(1)},${q.y.toFixed(1)}) fuera del suelo transitable`);
              rooms.add(roomAt(q));
            }
            segmentRooms.set(key, rooms);
          }
          for (const room of rooms) if (!allowed.has(room)) problems.push(`${label}: pasa por ${room}`);
        }
      }
    expect(problems).toEqual([]);
    expect(segmentRooms.size).toBeGreaterThan(100);
  });

  it('desde un punto fuera del suelo transitable entra al grafo por el waypoint más cercano', () => {
    const path = planPath({ x: 800, y: 40 }, ROOMS.recepcion.anchor);
    expect(path[0]).toEqual({ x: 800, y: 40 });
    expect(path.at(-1)).toEqual(ROOMS.recepcion.anchor);
    expect(path.length).toBeGreaterThan(2);
  });

  it('no devuelve referencias a los puntos del mapa (se pueden mutar sin romperlo)', () => {
    const path = planPath(ROOMS.cocina.anchor, ROOMS.correo.anchor);
    for (const p of path) p.x = -1;
    expect(Object.values(NAV.nodes).some((p) => p.x === -1)).toBe(false);
    expect(ROOMS.cocina.anchor.x).not.toBe(-1);
  });
});

/** Ángulo de giro (en grados) en cada punto interior de una polilínea. */
function turns(path: Point[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < path.length - 1; i++) {
    const a = Math.atan2(path[i].y - path[i - 1].y, path[i].x - path[i - 1].x);
    const b = Math.atan2(path[i + 1].y - path[i].y, path[i + 1].x - path[i].x);
    let d = Math.abs(b - a) * (180 / Math.PI);
    if (d > 180) d = 360 - d;
    out.push(d);
  }
  return out;
}

describe('suavizado de caminos', () => {
  it('pullString quita los waypoints que se ven en línea recta y conserva los extremos', () => {
    // Tres puntos alineados en el pasillo sur de los cubículos: el del medio sobra.
    const path = [
      { x: 880, y: 684 },
      { x: 1000, y: 684 },
      { x: 1140, y: 684 },
    ];
    expect(pullString(path)).toEqual([path[0], path[2]]);
    // Si no hay línea de visión (el mostrador del correo en medio) se queda el rodeo.
    const around = [ROOMS.correo.seats[2], { x: 720, y: 294 }, ROOMS.correo.seats[0]];
    expect(pullString(around).length).toBeGreaterThanOrEqual(2);
    expect(pullString([ROOMS.cocina.anchor])).toEqual([ROOMS.cocina.anchor]);
  });

  it('roundCorners cambia cada esquina por una curva de giros suaves y deja los extremos', () => {
    // Una L en el vestíbulo, con sitio de sobra para redondear.
    const l = [
      { x: 500, y: 760 },
      { x: 700, y: 760 },
      { x: 700, y: 860 },
    ];
    const round = roundCorners(l);
    expect(round[0]).toEqual(l[0]);
    expect(round.at(-1)).toEqual(l[2]);
    expect(round.length).toBeGreaterThan(4);
    expect(Math.max(...turns(round))).toBeLessThan(35);
    expect(pathLength(round)).toBeLessThan(pathLength(l));
  });

  it('roundCorners no redondea si la curva se saldría del suelo transitable', () => {
    // Esquina al pie del pilar de la cocina: el pasillo tiene 5 px de ancho, así que la curva grande se saldría.
    const corner = [
      { x: 439, y: 720 },
      { x: 439, y: 890 },
      { x: 410, y: 890 },
    ];
    expect(corner.every(walkable)).toBe(true);
    const round = roundCorners(corner);
    expect(round[0]).toEqual(corner[0]);
    expect(round.at(-1)).toEqual(corner[2]);
    for (let i = 1; i < round.length; i++) expect(samples(round[i - 1], round[i], 1).every(walkable)).toBe(true);
    // La curva que cabe es pequeña: no se aparta de la esquina más de unos píxeles.
    const far = Math.max(...round.map((p) => Math.min(Math.hypot(p.x - 439, p.y - 890), Math.abs(p.x - 439), Math.abs(p.y - 890))));
    expect(far).toBeLessThan(8);
  });

  it('entre salas, el camino suavizado no tiene quiebros bruscos salvo en los pasos estrechos de las puertas', () => {
    const sharp: string[] = [];
    for (const [a, b] of [
      ['cocina', 'cubiculos'],
      ['recepcion', 'servidores'],
      ['impresoras', 'reunion'],
      ['correo', 'recepcion'],
    ] as const) {
      const path = planPath(ROOMS[a].anchor, ROOMS[b].anchor);
      const big = turns(path).filter((d) => d > 60).length;
      // Como mucho un giro fuerte por puerta (la de salida y la de entrada).
      if (big > 2) sharp.push(`${a}→${b}: ${big}`);
    }
    expect(sharp).toEqual([]);
  });

  it('el camino de la cocina a los servidores va por suelo transitable y sin rodeos', () => {
    const from = ROOMS.cocina.seats[0];
    const to = ROOMS.servidores.seats[2];
    const path = planPath(from, to);
    for (let i = 1; i < path.length; i++) expect(samples(path[i - 1], path[i]).every(walkable)).toBe(true);
    // Unos 1,6 veces la distancia en línea recta como mucho (hay que salir por la puerta y cruzar el vestíbulo).
    expect(pathLength(path)).toBeLessThan(1.6 * Math.hypot(to.x - from.x, to.y - from.y));
  });
});

describe('facingBetween y pathLength', () => {
  it('mira según el eje dominante', () => {
    const o = { x: 100, y: 100 };
    expect(facingBetween(o, { x: 200, y: 120 })).toBe('right');
    expect(facingBetween(o, { x: 0, y: 90 })).toBe('left');
    expect(facingBetween(o, { x: 110, y: 300 })).toBe('down');
    expect(facingBetween(o, { x: 90, y: 0 })).toBe('up');
    expect(facingBetween(o, { x: 150, y: 150 })).toBe('right'); // empate: manda el horizontal
    expect(facingBetween(o, o)).toBe('down');
  });

  it('suma la longitud de cada tramo', () => {
    expect(pathLength([])).toBe(0);
    expect(pathLength([{ x: 1, y: 1 }])).toBe(0);
    expect(
      pathLength([
        { x: 0, y: 0 },
        { x: 3, y: 4 },
        { x: 3, y: 10 },
      ]),
    ).toBe(11);
  });
});
