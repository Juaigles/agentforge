import { describe, expect, it } from 'vitest';
import { planPath, ROOMS } from './map';
import { advance, remainingPath, startWalk, walkAlong, WALK_SPEED } from './movement';

// Camino en L: 100 px a la derecha y luego 50 px hacia abajo.
const L = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 50 },
];

describe('walkAlong', () => {
  it('empieza en el primer punto, mirando en la dirección del primer tramo', () => {
    const w = walkAlong(L, 100);
    expect(w).toMatchObject({ segment: 0, pos: { x: 0, y: 0 }, facing: 'right', arrived: false, speed: 100 });
  });

  it('un camino de un solo punto ya ha llegado y mira hacia abajo', () => {
    const w = walkAlong([{ x: 5, y: 7 }]);
    expect(w).toMatchObject({ pos: { x: 5, y: 7 }, facing: 'down', arrived: true, speed: WALK_SPEED });
    expect(advance(w, 1)).toBe(w);
    expect(remainingPath(w)).toEqual([{ x: 5, y: 7 }]);
  });

  it('no comparte los puntos con el camino recibido', () => {
    const path = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ];
    const w = walkAlong(path, 10);
    advance(w, 0.5);
    expect(path[0]).toEqual({ x: 0, y: 0 });
    expect(w.pos).toEqual({ x: 0, y: 0 });
  });
});

describe('advance', () => {
  it('avanza tramo a tramo a la velocidad dada', () => {
    let w = walkAlong(L, 100);
    w = advance(w, 0.5);
    expect(w).toMatchObject({ segment: 0, pos: { x: 50, y: 0 }, facing: 'right', arrived: false });
    w = advance(w, 0.6); // 60 px: 50 hasta la esquina y 10 hacia abajo
    expect(w.segment).toBe(1);
    expect(w.pos.x).toBeCloseTo(100);
    expect(w.pos.y).toBeCloseTo(10);
    expect(w.facing).toBe('down');
    expect(w.arrived).toBe(false);
    expect(remainingPath(w)).toEqual([w.pos, { x: 100, y: 50 }]);
  });

  it('no se pasa del final y al llegar conserva la dirección del último tramo', () => {
    let w = walkAlong(L, 100);
    w = advance(w, 1.4);
    expect(w.arrived).toBe(false);
    w = advance(w, 0.2);
    expect(w).toMatchObject({ pos: { x: 100, y: 50 }, arrived: true, facing: 'down', segment: 2 });
    expect(advance(w, 5).pos).toEqual({ x: 100, y: 50 });
  });

  it('con un dt enorme cruza todos los tramos de una vez', () => {
    const w = advance(walkAlong(L, 100), 1000);
    expect(w).toMatchObject({ pos: { x: 100, y: 50 }, arrived: true });
  });

  it('un dt de cero o negativo no mueve nada', () => {
    const w = walkAlong(L, 100);
    expect(advance(w, 0).pos).toEqual({ x: 0, y: 0 });
    expect(advance(w, -1).pos).toEqual({ x: 0, y: 0 });
  });

  it('no modifica el estado recibido', () => {
    const w = walkAlong(L, 100);
    advance(w, 0.5);
    expect(w.pos).toEqual({ x: 0, y: 0 });
  });

  it('la dirección es la de cada tramo: derecha, abajo, izquierda, arriba', () => {
    const square = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
      { x: 0, y: 0 },
    ];
    let w = walkAlong(square, 10);
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      w = advance(w, 0.5);
      seen.push(w.facing);
      w = advance(w, 0.5);
    }
    expect(seen).toEqual(['right', 'down', 'left', 'up']);
    expect(w.arrived).toBe(true);
  });
});

describe('startWalk', () => {
  it('sigue el camino de planPath entre dos salas y termina en el destino', () => {
    const from = ROOMS.cocina.seats[0];
    const to = ROOMS.cubiculos.seats[0];
    const w = startWalk(from, to);
    expect(w.path).toEqual(planPath(from, to));
    expect(w.pos).toEqual(from);
    expect(advance(w, 60)).toMatchObject({ pos: to, arrived: true });
  });

  it('del mismo punto al mismo punto ya ha llegado', () => {
    const p = ROOMS.correo.anchor;
    expect(startWalk(p, p).arrived).toBe(true);
  });
});
