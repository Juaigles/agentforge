import { describe, expect, it } from 'vitest';
import { isWalkable, planPath, ROOMS } from './map';
import {
  advance,
  facingWithHysteresis,
  pointAt,
  remainingPath,
  startWalk,
  STRIDE,
  stepIndex,
  stepPhase,
  trailDots,
  walkAlong,
  WALK_ACCEL,
  WALK_SPEED,
  type Walk,
} from './movement';

// Camino en L: 100 px a la derecha y luego 50 px hacia abajo.
const L = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 50 },
];
const straight = (len: number) => [
  { x: 0, y: 0 },
  { x: len, y: 0 },
];

/** Avanza a fotogramas de `dt` hasta llegar (o hasta `max` segundos) y devuelve todos los estados. */
function run(w: Walk, dt = 1 / 60, max = 60): Walk[] {
  const states = [w];
  for (let t = 0; !states[states.length - 1].arrived && t < max; t += dt) states.push(advance(states[states.length - 1], dt));
  return states;
}

describe('walkAlong', () => {
  it('empieza en el primer punto, parado y mirando en la dirección del primer tramo', () => {
    const w = walkAlong(L, 100);
    expect(w).toMatchObject({ segment: 0, pos: { x: 0, y: 0 }, facing: 'right', arrived: false, speed: 100, velocity: 0, traveled: 0 });
    expect(w.length).toBe(150);
    expect(w.cumulative).toEqual([0, 100, 150]);
  });

  it('un camino de un solo punto ya ha llegado y mira hacia abajo', () => {
    const w = walkAlong([{ x: 5, y: 7 }]);
    expect(w).toMatchObject({ pos: { x: 5, y: 7 }, facing: 'down', arrived: true, speed: WALK_SPEED });
    expect(advance(w, 1)).toBe(w);
    expect(remainingPath(w)).toEqual([{ x: 5, y: 7 }]);
    expect(trailDots(w)).toEqual([]);
  });

  it('no comparte los puntos con el camino recibido', () => {
    const path = straight(10);
    const w = walkAlong(path, 10);
    advance(w, 0.5);
    expect(path[0]).toEqual({ x: 0, y: 0 });
    expect(w.pos).toEqual({ x: 0, y: 0 });
  });
});

describe('advance: aceleración y frenada', () => {
  it('arranca despacio, llega a la velocidad de crucero y frena antes del final', () => {
    const states = run(walkAlong(straight(1000), 200), 1 / 60);
    const v = states.map((s) => s.velocity);
    expect(v[1]).toBeLessThan(200 * 0.5);
    expect(Math.max(...v)).toBeCloseTo(200);
    // Las velocidades crecen al principio y decrecen al final (sin tirones).
    const peak = v.indexOf(Math.max(...v));
    for (let i = 2; i < peak; i++) expect(v[i]).toBeGreaterThanOrEqual(v[i - 1]);
    const last = states.length - 2; // el último estado (llegada) tiene velocidad 0
    expect(v[last]).toBeLessThan(80);
    expect(states.at(-1)).toMatchObject({ arrived: true, pos: { x: 1000, y: 0 }, velocity: 0 });
  });

  it('nunca se pasa del final ni retrocede, con cualquier tamaño de fotograma', () => {
    for (const dt of [1 / 144, 1 / 60, 1 / 30, 0.1, 0.37]) {
      const states = run(walkAlong(L, 210), dt);
      for (let i = 1; i < states.length; i++) {
        expect(states[i].traveled, `dt ${dt}`).toBeGreaterThanOrEqual(states[i - 1].traveled);
        expect(states[i].traveled).toBeLessThanOrEqual(150);
        expect(states[i].pos.x).toBeLessThanOrEqual(100 + 1e-9);
        expect(states[i].pos.y).toBeLessThanOrEqual(50 + 1e-9);
      }
      expect(states.at(-1)).toMatchObject({ arrived: true, pos: { x: 100, y: 50 }, segment: 2 });
    }
  });

  it('tarda lo que dicta el perfil trapezoidal (ni se arrastra al final ni va a velocidad constante)', () => {
    const len = 600;
    const states = run(walkAlong(straight(len), WALK_SPEED), 1 / 120);
    const seconds = (states.length - 1) / 120;
    const cruise = len / WALK_SPEED;
    // Acelerar y frenar añade algo de tiempo respecto a ir siempre a crucero, pero no mucho.
    expect(seconds).toBeGreaterThan(cruise);
    expect(seconds).toBeLessThan(cruise + (2 * WALK_SPEED) / WALK_ACCEL);
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
    expect(w.traveled).toBe(0);
  });

  it('la posición está siempre sobre el camino', () => {
    for (const s of run(walkAlong(L, 150), 1 / 30)) {
      const onFirst = s.pos.y === 0 && s.pos.x >= 0 && s.pos.x <= 100;
      const onSecond = Math.abs(s.pos.x - 100) < 1e-9 && s.pos.y >= 0 && s.pos.y <= 50;
      expect(onFirst || onSecond, JSON.stringify(s.pos)).toBe(true);
    }
  });
});

describe('dirección', () => {
  it('sigue los tramos: derecha, abajo, izquierda, arriba', () => {
    const square = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
      { x: 0, y: 0 },
    ];
    const seen: string[] = [];
    for (const s of run(walkAlong(square, 100), 1 / 30)) if (seen.at(-1) !== s.facing) seen.push(s.facing);
    expect(seen).toEqual(['right', 'down', 'left', 'up']);
  });

  it('en una diagonal casi a 45° no parpadea entre dos direcciones', () => {
    // Zigzag fino alrededor de la diagonal: cada tramo se inclina un poco a un lado y al otro.
    const zig = [{ x: 0, y: 0 }];
    for (let i = 1; i <= 20; i++) zig.push({ x: i * 20 + (i % 2 ? 2 : -2), y: i * 20 + (i % 2 ? -2 : 2) });
    const changes = run(walkAlong(zig, 200), 1 / 60).filter((s, i, all) => i > 0 && s.facing !== all[i - 1].facing);
    expect(changes.length).toBeLessThanOrEqual(1);
  });

  it('facingWithHysteresis: dentro del mismo eje cambia de sentido; para cambiar de eje el nuevo tiene que dominar', () => {
    expect(facingWithHysteresis('right', -5, 1)).toBe('left');
    expect(facingWithHysteresis('right', 10, 12)).toBe('right'); // el vertical domina, pero poco
    expect(facingWithHysteresis('right', 10, 20)).toBe('down');
    expect(facingWithHysteresis('up', 12, -10)).toBe('up');
    expect(facingWithHysteresis('up', 20, -10)).toBe('right');
    expect(facingWithHysteresis('left', 0, 0)).toBe('left');
  });
});

describe('zancadas, estela y puntos del camino', () => {
  it('stepIndex y stepPhase cuentan zancadas por distancia recorrida', () => {
    const w = { ...walkAlong(straight(500)), traveled: STRIDE * 2.5 };
    expect(stepIndex(w)).toBe(2);
    expect(stepPhase(w)).toBeCloseTo(0.5);
  });

  it('pointAt interpola sobre el camino y recorta a sus extremos', () => {
    const w = walkAlong(L);
    expect(pointAt(w, 50).pos).toEqual({ x: 50, y: 0 });
    expect(pointAt(w, 125)).toEqual({ pos: { x: 100, y: 25 }, segment: 1 });
    expect(pointAt(w, -10).pos).toEqual({ x: 0, y: 0 });
    expect(pointAt(w, 999).pos).toEqual({ x: 100, y: 50 });
  });

  it('la estela son baldosas fijas del camino que se consumen al pisarlas', () => {
    const w = walkAlong(straight(200));
    const all = trailDots(w, 25);
    expect(all.map((p) => p.x)).toEqual([25, 50, 75, 100, 125, 150, 175]);
    const later = trailDots({ ...w, traveled: 60, pos: { x: 60, y: 0 } }, 25);
    expect(later.map((p) => p.x)).toEqual([75, 100, 125, 150, 175]);
    expect(remainingPath({ ...w, traveled: 60, pos: { x: 60, y: 0 } })).toEqual([
      { x: 60, y: 0 },
      { x: 200, y: 0 },
    ]);
  });
});

describe('startWalk', () => {
  it('sigue el camino de planPath entre dos salas, por suelo transitable, y termina en el destino', () => {
    const from = ROOMS.cocina.seats[0];
    const to = ROOMS.cubiculos.seats[0];
    const w = startWalk(from, to);
    expect(w.path).toEqual(planPath(from, to));
    expect(w.pos).toEqual(from);
    const states = run(w);
    expect(states.at(-1)).toMatchObject({ pos: to, arrived: true });
    expect(states.every((s) => isWalkable(s.pos))).toBe(true);
  });

  it('del mismo punto al mismo punto ya ha llegado', () => {
    const p = ROOMS.correo.anchor;
    expect(startWalk(p, p).arrived).toBe(true);
  });
});
