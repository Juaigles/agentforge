<script setup lang="ts">
// Planta animada del Modo Yōkai: la ejecución de un workflow como un recorrido por la oficina. La plantilla (un yōkai
// por paso de agente) espera en la cocina y va a su cubículo cuando le toca; el mensajero lleva la hitodama de sala en
// sala hasta el paso en curso y, al llegar, se la entrega a quien trabaja. Quién está dónde lo decide `actorsFromRun`;
// aquí solo se dibuja y se anima: el paseo (con aceleración, balanceo, sombra y polvo), la estela que le queda al
// mensajero, la llama que le sigue con inercia, los resaltados de las salas, el rótulo del paso y los efectos al
// completar o fallar un paso.
//
// Rendimiento: un único bucle de requestAnimationFrame que solo corre mientras hay algo que animar (alguien camina, la
// llama no ha llegado a su sitio o queda algún efecto vivo) y se cancela al desmontar. Los yōkai y la llama se mueven
// con transform; los efectos son animaciones CSS de transform/opacity. Con «reducir movimiento» no hay bucle: todos
// están en su sitio, sin partículas, y los resaltados son estáticos.
//
// Las coordenadas son de la imagen de la planta (PLAN_SIZE de lado) y se pintan en %, así que la escena es fluida.
import type { RunSnapshot, StepStatus } from '@shared/types';
import { computed, markRaw, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { t } from '@/i18n';
import { STATUS_LABEL } from '@/lib/format';
import type { RunLive } from '@/lib/run-state';
import { useReducedMotion } from '@/lib/useReducedMotion';
import { FRAME, FRAMES_PER_ROW, PLAN_SIZE, SPRITE_SCALE_ON_PLAN, YOKAI_ASSETS } from '@/lib/yokai/assets';
import { activeStep, actorsFromRun, roomMarks, runProgress, staffPosts, workSpot } from '@/lib/yokai/choreography';
import { planPath, roomAt, roomForNode, ROOMS } from '@/lib/yokai/map';
import { advance, STRIDE, startWalk, trailDots, walkAlong, type Walk } from '@/lib/yokai/movement';
import { activityLabelKey } from '@/lib/yokai/sprite';
import type { Actor, Facing, Point, RoomId, YokaiSpecies } from '@/lib/yokai/types';
import YokaiSprite from './YokaiSprite.vue';

const props = defineProps<{ snapshot: RunSnapshot; live: RunLive; selected: string | null }>();
const emit = defineEmits<{ select: [nodeId: string | null] }>();

/** Ancho que se supone antes de poder medir (y en entornos sin maquetación): el máximo del contenedor. */
const FALLBACK_WIDTH = 720;
/** Por debajo de este ancho los rótulos de las salas taparían demasiada planta. */
const LABELS_MIN_WIDTH = 420;
/** Desplazamiento de cada yōkai extra que comparte puesto (a partir del 7.º agente), para que no se tapen del todo. */
const SHARED_SEAT_SHIFT: Point = { x: 26, y: 6 };
/** Un fotograma más largo que esto (pestaña en segundo plano) se recorta: el paseo se ve en vez de saltar. */
const MAX_FRAME_SECONDS = 0.1;
/** Retardo entre yōkai de plantilla que salen a la vez (al terminar vuelven a la cocina en fila, no en bloque). */
const STAFF_STAGGER = 0.38;
/** Altura de un yōkai sobre la planta (px de la planta): la cabeza queda a esta distancia de los pies. */
const HEAD = FRAME * SPRITE_SCALE_ON_PLAN * 0.86;
/** La llama, a la altura de la mano del mensajero: a un lado y por encima de los pies. */
const HAND: Point = { x: 34, y: -60 };
/** Cuánto se eleva la llama sobre el puesto donde se entrega (encima del mueble). */
const DELIVER_LIFT = 74;
/** Duración y altura del salto de la llama de un sitio a otro. */
const HOP_SECONDS = 0.5;
const HOP_HEIGHT = 46;
/** Rapidez con que la llama alcanza la mano del mensajero (1/s): da la inercia, se queda un poco atrás al andar. */
const FLAME_FOLLOW = 7;
/** Especies que no andan: flotan (sin huellas ni polvo). */
const FLOATERS: ReadonlySet<YokaiSpecies> = new Set(['ojo']);
/** Especies que avanzan a saltos (el kasa-obake, un paraguas con una sola pierna): un salto cada dos zancadas. */
const HOPPERS: ReadonlySet<YokaiSpecies> = new Set(['kasa']);
/** Tope de partículas vivas (polvo, confeti, humo…) para que nada se acumule. */
const MAX_PARTICLES = 90;

const ROOM_IDS = Object.keys(ROOMS) as RoomId[];

const reduced = useReducedMotion();
const actors = computed(() => actorsFromRun(props.snapshot, props.live));
const speciesOf = computed(() => Object.fromEntries(actors.value.map((a) => [a.key, a.species])) as Record<string, YokaiSpecies>);

// ---------- Medida del contenedor ----------
const root = ref<HTMLElement | null>(null);
const measured = ref(0);
const width = computed(() => measured.value || FALLBACK_WIDTH);
/** Lado del sprite en px: un cuadro de 128 px a la escala de la planta tal y como se ve ahora. */
const spriteSize = computed(() => Math.max(16, Math.round(FRAME * SPRITE_SCALE_ON_PLAN * (width.value / PLAN_SIZE))));
const showLabels = computed(() => width.value >= LABELS_MIN_WIDTH);
/** Píxeles de pantalla por píxel de la planta. */
const scale = computed(() => width.value / PLAN_SIZE);
let observer: ResizeObserver | null = null;
onMounted(() => {
  if (!root.value) return;
  measured.value = root.value.clientWidth;
  if (typeof ResizeObserver === 'undefined') return;
  observer = new ResizeObserver((entries) => {
    const box = entries[0]?.contentRect;
    if (box) measured.value = box.width;
  });
  observer.observe(root.value);
});

// ---------- Reloj, bucle y utilidades ----------
/** Segundos de animación transcurridos (solo avanza dentro del bucle): mide la vida de los efectos. */
let clock = 0;
const canAnimate = (): boolean => !reduced.value && typeof requestAnimationFrame === 'function';
const samePoint = (a: Point, b: Point): boolean => a.x === b.x && a.y === b.y;
const dist = (a: Point, b: Point): number => Math.hypot(b.x - a.x, b.y - a.y);
const easeInOut = (x: number): number => (x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2);

// ---------- Posiciones y paseos ----------
interface Placement {
  pos: Point;
  /** Puesto al que va (o en el que está). */
  goal: Point;
  facing: Facing;
  walk: Walk | null;
  /** Segundos que espera antes de echar a andar (salida escalonada). */
  delay: number;
  /** Última zancada (o salto) en que soltó polvo. */
  stride: number;
}
const places = reactive<Record<string, Placement>>({});

/** Puesto de cada actor, desplazado un poco si otro anterior ya ocupa exactamente el mismo. */
const goals = computed(() => {
  const taken = new Map<string, number>();
  const out: Record<string, Point> = {};
  for (const a of actors.value) {
    const id = `${a.seat.x},${a.seat.y}`;
    const n = taken.get(id) ?? 0;
    taken.set(id, n + 1);
    out[a.key] = { x: a.seat.x + n * SHARED_SEAT_SHIFT.x, y: a.seat.y + n * SHARED_SEAT_SHIFT.y };
  }
  return out;
});

function sync(): void {
  const wanted = goals.value;
  for (const key of Object.keys(places)) if (!(key in wanted)) delete places[key];
  let queue = 0;
  for (const [key, goal] of Object.entries(wanted)) {
    const place = places[key];
    // Al aparecer se coloca directamente en su puesto, sin paseo.
    if (!place) {
      places[key] = { pos: { ...goal }, goal: { ...goal }, facing: 'down', walk: null, delay: 0, stride: 0 };
      continue;
    }
    if (samePoint(place.goal, goal)) continue;
    place.goal = { ...goal };
    if (!canAnimate()) {
      place.pos = { ...goal };
      place.walk = null;
      place.facing = 'down';
      continue;
    }
    // Si el destino cambia a mitad de paseo, el nuevo sale de donde está ahora. La plantilla que sale a la vez lo hace
    // en fila; el mensajero no espera a nadie.
    place.walk = markRaw(startWalk(place.pos, goal));
    place.delay = key === 'courier' ? 0 : queue++ * STAFF_STAGGER;
    place.stride = 0;
    if (place.delay === 0) place.facing = place.walk.facing;
  }
  loop();
}

/** Longitud de la zancada que marca el ritmo (polvo, balanceo) de cada especie. */
const strideOf = (species: YokaiSpecies | undefined): number => (species && HOPPERS.has(species) ? STRIDE * 2 : STRIDE);

let frame = 0;
let last = 0;
function loop(): void {
  if (frame || !canAnimate() || !needsFrame()) return;
  last = 0;
  frame = requestAnimationFrame(tick);
}
function needsFrame(): boolean {
  return Object.values(places).some((p) => p.walk) || particles.value.length > 0 || Object.keys(shakes).length > 0 || !flameSettled();
}
function tick(now: number): void {
  frame = 0;
  const dt = last ? Math.min(MAX_FRAME_SECONDS, (now - last) / 1000) : 0;
  last = now;
  clock += dt;
  for (const [key, place] of Object.entries(places)) {
    if (!place.walk) continue;
    if (place.delay > 0) {
      place.delay = Math.max(0, place.delay - dt);
      if (place.delay === 0) place.facing = place.walk.facing;
      continue;
    }
    const walk = advance(place.walk, dt);
    place.pos = walk.pos;
    const species = speciesOf.value[key];
    const floats = species ? FLOATERS.has(species) : false;
    if (walk.arrived) {
      // Al llegar mira hacia abajo (a quien mira la planta) y ya puede mostrar lo que hace.
      place.walk = null;
      place.facing = 'down';
      if (!floats) puff(walk.pos, 3);
      continue;
    }
    place.walk = markRaw(walk);
    place.facing = walk.facing;
    // Polvo a cada zancada (o al aterrizar cada salto), alternando el pie.
    const stride = Math.floor(walk.traveled / strideOf(species));
    if (!floats && stride !== place.stride) {
      place.stride = stride;
      dust(walk.pos, stride % 2 ? 1 : -1);
    }
  }
  stepFlame(dt);
  pruneEffects();
  if (needsFrame()) frame = requestAnimationFrame(tick);
}
function stop(): void {
  if (frame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
  frame = 0;
}
/** Con «reducir movimiento» (o si se activa a mitad de paseo) todos saltan a su destino y se quitan los efectos. */
function finishAll(): void {
  stop();
  for (const place of Object.values(places)) {
    place.delay = 0;
    if (!place.walk) continue;
    place.pos = { ...place.goal };
    place.walk = null;
    place.facing = 'down';
  }
  particles.value = [];
  for (const key of Object.keys(shakes)) delete shakes[key];
  snapFlame();
}

// ---------- Efectos: polvo, confeti, destellos, humo y sacudidas ----------
type ParticleKind = 'dust' | 'confetti' | 'flash' | 'spark' | 'smoke' | 'tag';
interface Particle {
  id: number;
  kind: ParticleKind;
  /** Punto de la planta donde nace. */
  at: Point;
  born: number;
  /** Vida en segundos (la duración de su animación CSS). */
  life: number;
  /** Desplazamiento final, en píxeles de la planta. */
  dx: number;
  dy: number;
  color?: string;
  text?: string;
}
const particles = ref<Particle[]>([]);
/** Sacudidas en curso: clave del actor → instante (`clock`) en que acaba. */
const shakes = reactive<Record<string, number>>({});
let nextParticle = 1;
const CONFETTI = ['#e8b64c', '#f0634d', '#fff8ec', '#5ab4ff'];

function spawn(list: Omit<Particle, 'id' | 'born'>[]): void {
  if (!canAnimate() || !list.length) return;
  const born = list.map((p) => ({ ...p, id: nextParticle++, born: clock }));
  const all = [...particles.value, ...born];
  particles.value = all.length > MAX_PARTICLES ? all.slice(all.length - MAX_PARTICLES) : all;
  loop();
}
function pruneEffects(): void {
  if (particles.value.some((p) => clock - p.born >= p.life)) particles.value = particles.value.filter((p) => clock - p.born < p.life);
  for (const [key, until] of Object.entries(shakes)) if (clock >= until) delete shakes[key];
}
/** Una mota de polvo junto al pie que se apoya. */
function dust(at: Point, side: number): void {
  spawn([{ kind: 'dust', at: { x: at.x + side * 9, y: at.y - 2 }, life: 0.55, dx: side * 7, dy: -9 }]);
}
/** Unas motas al detenerse. */
function puff(at: Point, n: number): void {
  spawn(
    Array.from({ length: n }, (_, i) => ({
      kind: 'dust' as const,
      at: { x: at.x + (i - (n - 1) / 2) * 12, y: at.y - 2 },
      life: 0.6,
      dx: (i - (n - 1) / 2) * 10,
      dy: -7,
    })),
  );
}
/** Paso completado: estallido pixelado sobrio y el sello 済 que sube y se desvanece. */
function celebrate(at: Point): void {
  const head = { x: at.x, y: at.y - HEAD };
  const bits = Array.from({ length: 10 }, (_, i) => {
    const angle = -Math.PI / 2 + ((i - 4.5) / 4.5) * (Math.PI * 0.62);
    const r = 42 + (i % 3) * 14;
    return { kind: 'confetti' as const, at: head, life: 0.85, dx: Math.cos(angle) * r, dy: Math.sin(angle) * r + 18, color: CONFETTI[i % CONFETTI.length] };
  });
  spawn([...bits, { kind: 'tag', at: { x: head.x, y: head.y - 6 }, life: 1.25, dx: 0, dy: -34, text: '済' }]);
}
/** La hitodama llega a su sitio: destello en anillo y cuatro chispas. */
function flash(at: Point): void {
  const sparks = [0, 1, 2, 3].map((i) => {
    const angle = Math.PI / 4 + (i * Math.PI) / 2;
    return { kind: 'spark' as const, at, life: 0.5, dx: Math.cos(angle) * 26, dy: Math.sin(angle) * 26 };
  });
  spawn([{ kind: 'flash', at, life: 0.6, dx: 0, dy: 0 }, ...sparks]);
}
/** Paso fallido: humo que sube y el actor que lo llevaba se sacude. */
function smoke(at: Point, actorKey: string | null): void {
  const top = { x: at.x, y: at.y - HEAD * 0.7 };
  spawn(
    Array.from({ length: 6 }, (_, i) => ({
      kind: 'smoke' as const,
      at: { x: top.x + (i - 2.5) * 10, y: top.y },
      life: 1.1 + (i % 3) * 0.15,
      dx: (i - 2.5) * 6,
      dy: -52 - (i % 2) * 14,
    })),
  );
  if (actorKey && canAnimate()) {
    shakes[actorKey] = clock + 0.5;
    loop();
  }
}

/** Dónde se nota lo que pasa en un paso: su yōkai de plantilla o, si no tiene, el mensajero (o el puesto de la sala). */
function stepSpot(nodeId: string, room: RoomId): { at: Point; key: string | null } {
  const staff = places[nodeId];
  if (staff && actors.value.some((a) => a.key === nodeId && a.kind === 'staff')) return { at: staff.pos, key: nodeId };
  const courier = places.courier;
  if (courier && roomAt(courier.pos) === room) return { at: courier.pos, key: 'courier' };
  return { at: workSpot(room), key: null };
}

/** Estado de cada paso, para detectar cuándo uno se completa o falla. */
const stepStatuses = computed(() => Object.fromEntries(Object.values(props.live.steps).map((s) => [s.nodeId, s.status])) as Record<string, StepStatus>);
watch(stepStatuses, (now, before) => {
  if (!before || !canAnimate()) return;
  for (const [nodeId, status] of Object.entries(now)) {
    if (before[nodeId] === status) continue;
    if (status !== 'completed' && status !== 'failed') continue;
    const step = props.live.steps[nodeId];
    const type = props.snapshot.workflow.nodes.find((n) => n.id === nodeId)?.type ?? step?.nodeType;
    if (!type) continue;
    const spot = stepSpot(nodeId, roomForNode(type));
    if (status === 'completed') celebrate(spot.at);
    else smoke(spot.at, spot.key);
  }
});

// ---------- La hitodama (la llama que lleva el mensajero) ----------
/**
 * Adónde va la llama: a la mano del mensajero o, cuando ha llegado a la sala del paso en curso, al yōkai que trabaja
 * (encima de su cabeza) o al puesto de la sala si el paso no es de un agente. `key` cambia cuando cambia de dueño:
 * entonces la llama salta en arco en vez de deslizarse.
 */
function flameAnchor(): { key: string; point: Point } | null {
  const courier = places.courier;
  if (!courier) return null;
  const current = activeStep(props.snapshot, props.live);
  const arrived = !courier.walk;
  if (current && arrived && actors.value.find((a) => a.kind === 'courier')?.room === current.room) {
    const staff = actors.value.some((a) => a.kind === 'staff' && a.key === current.nodeId) ? places[current.nodeId] : undefined;
    if (staff) return { key: `staff:${current.nodeId}`, point: { x: staff.pos.x - 30, y: staff.pos.y - HEAD - 6 } };
    const spot = workSpot(current.room);
    return { key: `room:${current.nodeId}`, point: { x: spot.x, y: spot.y - DELIVER_LIFT } };
  }
  const side = courier.facing === 'left' ? -1 : 1;
  return { key: 'hand', point: { x: courier.pos.x + side * HAND.x, y: courier.pos.y + HAND.y } };
}

const flame = reactive({ pos: { x: 0, y: 0 } as Point, key: '', hop: -1, from: { x: 0, y: 0 } as Point, ready: false });
function snapFlame(): void {
  const anchor = flameAnchor();
  if (!anchor) return;
  flame.pos = { ...anchor.point };
  flame.key = anchor.key;
  flame.hop = -1;
  flame.ready = true;
}
function flameSettled(): boolean {
  const anchor = flameAnchor();
  if (!anchor || !flame.ready) return true;
  return flame.hop < 0 && flame.key === anchor.key && dist(flame.pos, anchor.point) < 0.5;
}
function stepFlame(dt: number): void {
  const anchor = flameAnchor();
  if (!anchor) return;
  if (!flame.ready) return snapFlame();
  if (anchor.key !== flame.key) {
    // Cambia de dueño: salta desde donde está.
    flame.key = anchor.key;
    flame.from = { ...flame.pos };
    flame.hop = 0;
  }
  if (flame.hop >= 0) {
    flame.hop = Math.min(1, flame.hop + dt / HOP_SECONDS);
    const k = easeInOut(flame.hop);
    flame.pos = {
      x: flame.from.x + (anchor.point.x - flame.from.x) * k,
      y: flame.from.y + (anchor.point.y - flame.from.y) * k - Math.sin(Math.PI * flame.hop) * HOP_HEIGHT,
    };
    if (flame.hop >= 1) {
      flame.hop = -1;
      if (anchor.key !== 'hand') flash(anchor.point);
    }
    return;
  }
  if (anchor.key === 'hand') {
    // Sigue la mano con inercia: se queda un poco atrás al andar y alcanza al mensajero al parar.
    const k = 1 - Math.exp(-dt * FLAME_FOLLOW);
    flame.pos = { x: flame.pos.x + (anchor.point.x - flame.pos.x) * k, y: flame.pos.y + (anchor.point.y - flame.pos.y) * k };
    if (dist(flame.pos, anchor.point) < 0.5) flame.pos = { ...anchor.point };
  } else {
    flame.pos = { ...anchor.point };
  }
}
/** Cuando la llama tiene que moverse sin que nadie camine (p. ej. empieza un paso con el mensajero ya en la sala). */
const anchorKey = computed(() => flameAnchor()?.key ?? '');
watch(anchorKey, () => (canAnimate() && flame.ready ? loop() : snapFlame()));

watch(goals, sync, { immediate: true });
snapFlame();
watch(reduced, (on) => {
  if (on) finishAll();
});
onBeforeUnmount(() => {
  stop();
  observer?.disconnect();
  particles.value = [];
});

// ---------- Lo que se pinta ----------
const pct = (v: number): string => `${(v / PLAN_SIZE) * 100}%`;
const at = (p: Point) => ({ left: pct(p.x), top: pct(p.y) });
/** Desplaza una capa del tamaño de la planta hasta el punto: los % de translate son del propio elemento. */
const moveTo = (p: Point): string => `translate(${(p.x / PLAN_SIZE) * 100}%, ${(p.y / PLAN_SIZE) * 100}%)`;
const planStyle = { backgroundImage: `url("${YOKAI_ASSETS.planta}")` };

/** Nombre visible de un yōkai de plantilla: el del agente o, si ya no existe, la etiqueta del paso. */
function staffName(a: Actor): string {
  return a.name || props.snapshot.workflow.nodes.find((n) => n.id === a.key)?.label || a.key;
}
const statusText = (a: Actor): string => STATUS_LABEL[a.status].toLowerCase();

/** Balanceo al andar: 1-2 px a saltos, una zancada sí y otra no. */
const bob = computed(() => Math.max(1, Math.round(spriteSize.value / 48)));

const scene = computed(() =>
  actors.value.map((actor) => {
    const place = places[actor.key] ?? { pos: actor.seat, goal: actor.seat, facing: 'down' as Facing, walk: null, delay: 0, stride: 0 };
    const walking = !!place.walk && place.delay <= 0;
    let lift = 0;
    let shadow = 1;
    let frameIndex: number | undefined;
    if (walking && place.walk) {
      const traveled = place.walk.traveled;
      frameIndex = Math.floor(traveled / STRIDE) % FRAMES_PER_ROW;
      if (HOPPERS.has(actor.species)) {
        // El paraguas da saltitos: un arco por cada dos zancadas, en píxeles enteros.
        const hop = Math.sin((Math.PI * (traveled % (STRIDE * 2))) / (STRIDE * 2));
        lift = -Math.round(hop * spriteSize.value * 0.11);
        shadow = 1 - hop * 0.35;
      } else if (!FLOATERS.has(actor.species)) {
        lift = Math.floor(traveled / STRIDE) % 2 ? -bob.value : 0;
      }
    }
    return {
      actor,
      walking,
      facing: place.facing,
      frame: frameIndex,
      lift,
      shadow,
      floats: FLOATERS.has(actor.species),
      shaking: actor.key in shakes,
      // La burbuja de actividad sale al llegar, no por el camino.
      activity: walking ? undefined : actor.activity,
      transform: moveTo(place.pos),
      zIndex: hovered.value === actor.key ? 3000 : 10 + Math.round(place.pos.y),
    };
  }),
);

// ---------- Recorrido del mensajero ----------
const courierWalk = computed(() => places.courier?.walk ?? null);
/** Estela: baldosas del camino que le queda, que se van apagando según las pisa. */
const trail = computed(() => {
  const walk = courierWalk.value;
  if (!walk || reduced.value) return [];
  return trailDots(walk, 26).map((p, i, all) => ({ x: p.x, y: p.y, o: 0.35 + 0.6 * (1 - i / Math.max(1, all.length)) }));
});
/** Marcador del destino del mensajero mientras camina. */
const destination = computed(() => {
  const walk = courierWalk.value;
  return walk && !reduced.value ? walk.path[walk.path.length - 1] : null;
});

const flameStyle = computed(() => {
  const anchor = flameAnchor();
  if (!anchor) return null;
  const p = reduced.value || !flame.ready ? anchor.point : flame.pos;
  return { transform: moveTo(p) };
});
const flameSize = computed(() => Math.max(8, Math.round(spriteSize.value * 0.2)));
const flameResting = computed(() => anchorKey.value !== 'hand' && flame.hop < 0);

// ---------- Salas ----------
const marks = computed(() => roomMarks(props.snapshot, props.live));
/** Recuadros resaltados: la sala del paso en curso (o esperando) y las de pasos fallidos. */
const markedRooms = computed(() =>
  ROOM_IDS.filter((id) => {
    const m = marks.value[id];
    return m === 'active' || m === 'waiting' || m === 'failed';
  }).map((id) => {
    const r = ROOMS[id].rect;
    return { id, mark: marks.value[id]!, style: { left: pct(r.x), top: pct(r.y), width: pct(r.w), height: pct(r.h) } };
  }),
);

// ---------- Rótulo del paso ----------
const progress = computed(() => runProgress(props.snapshot, props.live));
/**
 * Texto del rótulo en dos líneas (cabecera corta y detalle). Solo cambia al cambiar de paso o de fase (entre dos pasos
 * sigue diciendo el último), así aria-live no repite.
 */
const caption = computed((): { head: string; body: string } => {
  const p = progress.value;
  const count = { n: p.index, total: p.total };
  switch (p.phase) {
    case 'queued':
      return { head: t('yokaiFloor.caption.queued'), body: t('yokaiFloor.caption.queuedBody') };
    case 'running':
    case 'between':
      return { head: t('yokaiFloor.caption.step', count), body: p.label };
    case 'waiting':
      return { head: t('yokaiFloor.caption.step', count), body: t('yokaiFloor.caption.waitingBody', { label: p.label }) };
    case 'completed':
      return { head: t('yokaiFloor.caption.completed'), body: t('yokaiFloor.caption.completedBody', count) };
    case 'failed':
      return { head: t('yokaiFloor.caption.failed'), body: p.label || t('yokaiFloor.caption.failedBody') };
    default:
      return { head: t('yokaiFloor.caption.cancelled'), body: t('yokaiFloor.caption.cancelledBody') };
  }
});

// ---------- Hover / foco sobre un yōkai de plantilla ----------
const hovered = ref<string | null>(null);
/** Su ruta entre la silla de la cocina y su cubículo, y los dos puestos, para que se vea dónde trabaja. */
const route = computed(() => {
  const key = hovered.value;
  if (!key) return null;
  const staff = actors.value.filter((a) => a.kind === 'staff');
  const index = staff.findIndex((a) => a.key === key);
  if (index < 0) return null;
  const posts = staffPosts(index);
  const dots = trailDots(walkAlong(planPath(posts.rest, posts.desk)), 22);
  return { color: staff[index].color, dots, desk: posts.desk, rest: posts.rest };
});
function tipLines(a: Actor): string {
  const activity = a.activity ? t(activityLabelKey(a.activity)) : '';
  return activity && activity.toLowerCase() !== statusText(a) ? `${STATUS_LABEL[a.status]} · ${activity}` : STATUS_LABEL[a.status];
}

const courier = computed(() => actors.value.find((a) => a.kind === 'courier') ?? null);
</script>

<template>
  <div
    ref="root"
    class="yokai-floor"
    :class="{ 'is-reduced': reduced }"
    role="group"
    :aria-label="t('yokaiFloor.region')"
    :style="{ '--sprite': `${spriteSize}px`, '--k': scale }"
    @click="emit('select', null)"
  >
    <div class="plan yk-pixel" :style="planStyle" aria-hidden="true" />

    <div v-for="m in markedRooms" :key="m.id" class="room-mark" :class="`is-${m.mark}`" :data-room="m.id" :style="m.style" aria-hidden="true" />

    <template v-if="showLabels">
      <span
        v-for="id in ROOM_IDS"
        :key="id"
        class="room-label"
        :class="marks[id] ? `is-${marks[id]}` : ''"
        :data-room="id"
        :style="{ left: pct(ROOMS[id].rect.x + 6), top: pct(ROOMS[id].rect.y + 6) }"
        aria-hidden="true"
        >{{ t(`yokaiFloor.rooms.${id}`) }}</span
      >
    </template>

    <svg v-if="trail.length || route" class="paths" :viewBox="`0 0 ${PLAN_SIZE} ${PLAN_SIZE}`" preserveAspectRatio="none" aria-hidden="true">
      <g v-if="route" class="route" :style="{ '--c': route.color }">
        <rect v-for="(d, i) in route.dots" :key="i" :x="d.x - 3" :y="d.y - 3" width="6" height="6" />
      </g>
      <g class="trail">
        <rect v-for="(d, i) in trail" :key="i" :x="d.x - 4" :y="d.y - 4" width="8" height="8" :style="{ opacity: d.o }" />
      </g>
    </svg>
    <span v-if="destination" class="destination" :style="at(destination)" aria-hidden="true" />
    <template v-if="route">
      <span class="post is-desk" :style="{ ...at(route.desk), '--c': route.color }" aria-hidden="true" />
      <span class="post" :style="{ ...at(route.rest), '--c': route.color }" aria-hidden="true" />
    </template>

    <template v-for="item in scene" :key="item.actor.key">
      <div
        v-if="item.actor.kind === 'staff'"
        class="actor staff"
        :class="{ selected: selected === item.actor.key, hovered: hovered === item.actor.key }"
        :data-key="item.actor.key"
        :style="{ transform: item.transform, zIndex: item.zIndex, '--c': item.actor.color, '--size': `${spriteSize}px` }"
      >
        <span class="shadow" :style="{ '--shadow': item.shadow }" aria-hidden="true" />
        <button
          class="body"
          type="button"
          :aria-label="t('yokaiFloor.staff', { name: staffName(item.actor), status: statusText(item.actor) })"
          :aria-pressed="selected === item.actor.key"
          @click.stop="emit('select', item.actor.key)"
          @mouseenter="hovered = item.actor.key"
          @mouseleave="hovered = null"
          @focus="hovered = item.actor.key"
          @blur="hovered = null"
        >
          <span class="lift" :style="{ transform: `translateY(${item.lift}px)` }">
            <span class="fx" :class="{ shake: item.shaking }">
              <YokaiSprite
                :species="item.actor.species"
                :facing="item.facing"
                :walking="item.walking"
                :frame="item.frame"
                :size="spriteSize"
                :activity="item.activity"
                :tint="item.actor.color"
              />
            </span>
          </span>
        </button>
        <span class="name truncate" aria-hidden="true">{{ staffName(item.actor) }}</span>
        <span v-if="hovered === item.actor.key" class="tip" aria-hidden="true">
          <strong>{{ staffName(item.actor) }}</strong>
          <span>{{ tipLines(item.actor) }}</span>
        </span>
      </div>
      <div
        v-else
        class="actor courier"
        :data-key="item.actor.key"
        :style="{ transform: item.transform, zIndex: item.zIndex, '--size': `${spriteSize}px` }"
        aria-hidden="true"
      >
        <span class="shadow" :class="{ float: item.floats }" aria-hidden="true" />
        <span class="body">
          <span class="lift" :style="{ transform: `translateY(${item.lift}px)` }">
            <span class="fx" :class="{ shake: item.shaking, float: item.floats }">
              <YokaiSprite
                :species="item.actor.species"
                :facing="item.facing"
                :walking="item.walking"
                :frame="item.frame"
                :size="spriteSize"
                :activity="item.activity"
                :tint="item.actor.color"
              />
            </span>
          </span>
        </span>
      </div>
    </template>

    <div v-if="flameStyle && courier" class="flame-layer" :style="flameStyle" aria-hidden="true">
      <span class="hitodama" :class="{ resting: flameResting }" :style="{ '--flame': `${flameSize}px`, '--flame-color': courier.color }" />
    </div>

    <span
      v-for="p in particles"
      :key="p.id"
      class="particle"
      :class="`is-${p.kind}`"
      :style="{
        ...at(p.at),
        '--dx': `${Math.round(p.dx * scale)}px`,
        '--dy': `${Math.round(p.dy * scale)}px`,
        '--pc': p.color,
        animationDuration: `${p.life}s`,
      }"
      aria-hidden="true"
      >{{ p.text }}</span
    >

    <p v-if="courier" class="sr-only">{{ t('yokaiFloor.courierAt', { room: t(`yokaiFloor.rooms.${courier.room}`) }) }}</p>
    <p class="caption" :class="`is-${progress.phase}`" role="status" aria-live="polite" aria-atomic="true" @click.stop>
      <span class="lamp" aria-hidden="true" />
      <span class="caption-text">
        <span class="caption-head">{{ caption.head }}</span>
        <span class="sr-only"> · </span>
        <span class="caption-body">{{ caption.body }}</span>
      </span>
    </p>
  </div>
</template>

<style scoped>
.yokai-floor {
  position: relative;
  width: 100%;
  max-width: 720px;
  margin: 0 auto;
  aspect-ratio: 1;
  overflow: hidden;
  /* Los z-index de los yōkai (según su y) no se escapan de la planta. */
  isolation: isolate;
  background: var(--surface-2);
  user-select: none;
  --courier: #5ab4ff;
  --waiting: #e8b850;
  --failed: #ff5a4d;
  --done: #e8b64c;
  --ink: rgb(14 17 36 / 0.88);
}
.plan {
  position: absolute;
  inset: 0;
  background-size: 100% 100%;
  background-repeat: no-repeat;
  image-rendering: crisp-edges;
  image-rendering: pixelated;
}

/* ---------- Salas ---------- */
/* Rótulos de sala: plaquitas pixeladas, texto claro sobre tinta (contraste muy por encima de 4,5:1). */
.room-label {
  position: absolute;
  z-index: 1;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 4px;
  background: var(--ink);
  color: #fff8ec;
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 600;
  line-height: 1.3;
  white-space: nowrap;
  pointer-events: none;
  box-shadow: 2px 2px 0 rgb(0 0 0 / 0.45);
}
/* Farolillo del rótulo: apagado no se ve; encendido (oro) en salas con pasos hechos, azul en la del paso en curso,
   ámbar si espera aprobación y rojo si un paso falló. */
.room-label::before {
  content: none;
  width: 6px;
  height: 6px;
  background: currentColor;
  box-shadow: 0 0 0 1px rgb(0 0 0 / 0.6);
}
.room-label.is-done::before {
  content: '';
  background: var(--done);
  box-shadow:
    0 0 0 1px rgb(0 0 0 / 0.6),
    0 0 6px 1px rgb(232 182 76 / 0.7);
}
.room-label.is-active {
  background: #12305a;
  box-shadow:
    2px 2px 0 rgb(0 0 0 / 0.45),
    inset 0 -2px 0 var(--courier);
}
.room-label.is-active::before {
  content: '';
  background: var(--courier);
}
.room-label.is-waiting {
  background: #4a3410;
  box-shadow:
    2px 2px 0 rgb(0 0 0 / 0.45),
    inset 0 -2px 0 var(--waiting);
}
.room-label.is-waiting::before {
  content: '';
  background: var(--waiting);
}
.room-label.is-failed {
  background: #5a1212;
}
.room-label.is-failed::before {
  content: '';
  background: var(--failed);
}

/* Recuadro de la sala resaltada: borde pixelado y un halo interior que respira despacio. */
.room-mark {
  position: absolute;
  z-index: 1;
  border: 3px solid var(--mark);
  box-shadow:
    inset 0 0 0 2px rgb(14 17 36 / 0.55),
    inset 0 0 28px 4px var(--mark-glow);
  pointer-events: none;
  animation: room-breathe 2.2s ease-in-out infinite;
}
.room-mark.is-active {
  --mark: var(--courier);
  --mark-glow: rgb(90 180 255 / 0.32);
}
.room-mark.is-waiting {
  --mark: var(--waiting);
  --mark-glow: rgb(232 184 80 / 0.32);
}
.room-mark.is-failed {
  --mark: var(--failed);
  --mark-glow: rgb(255 90 77 / 0.28);
  border-style: dashed;
  animation: none;
}
@keyframes room-breathe {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.55;
  }
}

/* ---------- Estela, destino y ruta al hacer hover ---------- */
.paths {
  position: absolute;
  inset: 0;
  z-index: 2;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
.trail rect {
  fill: var(--courier);
  stroke: rgb(14 17 36 / 0.7);
  stroke-width: 1.5;
  vector-effect: non-scaling-stroke;
}
.route rect {
  fill: var(--c);
  opacity: 0.75;
  stroke: rgb(14 17 36 / 0.7);
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
}
/* Marcador del destino: un rombo de píxeles que late donde va a parar el mensajero. */
.destination {
  position: absolute;
  z-index: 3;
  width: calc(var(--sprite) * 0.34);
  height: calc(var(--sprite) * 0.34);
  margin: calc(var(--sprite) * -0.17) 0 0 calc(var(--sprite) * -0.17);
  border: 3px solid var(--courier);
  box-shadow:
    0 0 0 2px rgb(14 17 36 / 0.6),
    inset 0 0 0 2px rgb(14 17 36 / 0.6);
  transform: scaleY(0.55) rotate(45deg);
  pointer-events: none;
  animation: destination-pulse 0.9s steps(3) infinite;
}
@keyframes destination-pulse {
  0% {
    transform: scaleY(0.55) rotate(45deg) scale(0.8);
    opacity: 1;
  }
  100% {
    transform: scaleY(0.55) rotate(45deg) scale(1.25);
    opacity: 0.45;
  }
}
/* Puestos del yōkai bajo el ratón: su cubículo (anillo lleno) y su silla de la cocina. */
.post {
  position: absolute;
  z-index: 3;
  width: calc(var(--sprite) * 0.6);
  height: calc(var(--sprite) * 0.22);
  margin: calc(var(--sprite) * -0.11) 0 0 calc(var(--sprite) * -0.3);
  border: 2px dashed var(--c);
  border-radius: 50%;
  pointer-events: none;
}
.post.is-desk {
  border-style: solid;
  border-width: 3px;
  box-shadow: 0 0 0 1px rgb(14 17 36 / 0.7);
}

/* ---------- Yōkai ---------- */
/* Cada actor es una capa del tamaño de la planta que se desplaza con transform hasta los pies del yōkai; lo que lleva
   dentro se ancla en su esquina (0, 0) y el sprite crece hacia arriba desde ahí. */
.actor {
  position: absolute;
  inset: 0;
  pointer-events: none;
  will-change: transform;
}
.actor .body {
  position: absolute;
  left: 0;
  top: calc(-1 * var(--size));
  width: var(--size);
  height: var(--size);
  transform: translateX(-50%);
}
.lift,
.fx {
  display: block;
  width: 100%;
  height: 100%;
}
.staff .body {
  display: block;
  padding: 0;
  border: 0;
  background: none;
  color: inherit;
  cursor: pointer;
  pointer-events: auto;
}
.staff .body:focus-visible {
  outline: 2px solid var(--yk-focus, var(--accent));
  outline-offset: 1px;
}
/* Sombra elíptica a los pies: los asienta en el suelo. */
.shadow {
  position: absolute;
  left: 0;
  top: 0;
  width: calc(var(--size) * 0.5);
  height: calc(var(--size) * 0.14);
  background: rgb(10 8 20 / 0.38);
  border-radius: 50%;
  transform: translate(-50%, -62%) scale(var(--shadow, 1));
  pointer-events: none;
}
/* Seleccionado: anillo a los pies del color del agente, como el cursor de un JRPG. */
.staff.selected .shadow::after,
.staff.hovered .shadow::after {
  content: '';
  position: absolute;
  inset: -4px -6px;
  border: 3px solid var(--c);
  border-radius: 50%;
  box-shadow: 0 0 0 1px rgb(14 17 36 / 0.7);
}
.staff.hovered:not(.selected) .shadow::after {
  border-style: dashed;
  border-width: 2px;
}
.name {
  position: absolute;
  top: 3px;
  left: 0;
  max-width: calc(var(--size) * 1.6);
  transform: translateX(-50%);
  padding: 0 3px;
  background: var(--ink);
  border-bottom: 2px solid var(--c);
  color: #fff8ec;
  font-family: var(--font-mono);
  font-size: 10px;
  line-height: 1.35;
  pointer-events: none;
}
/* Tooltip pixelado sobre la cabeza: nombre y estado. */
.tip {
  position: absolute;
  left: 0;
  top: calc(-1 * var(--size) - 6px);
  display: flex;
  flex-direction: column;
  min-width: 96px;
  max-width: 200px;
  transform: translate(-50%, -100%);
  padding: 3px 6px 4px;
  background: #161a33;
  color: #fff8ec;
  font-family: var(--font-mono);
  font-size: 10px;
  line-height: 1.35;
  white-space: nowrap;
  border: 2px solid var(--c);
  box-shadow:
    0 0 0 2px #05070f,
    3px 3px 0 2px rgb(0 0 0 / 0.5);
  pointer-events: none;
}
.tip strong {
  font-size: 11px;
}
.tip span {
  color: #d9d0b8;
}

/* El fantasma flota: sube y baja despacio, y su sombra se encoge cuando está más alto. */
.fx.float {
  animation: ghost-float 2.4s ease-in-out infinite;
}
.shadow.float {
  animation: ghost-shadow 2.4s ease-in-out infinite;
}
@keyframes ghost-float {
  0%,
  100% {
    transform: translateY(0);
  }
  50% {
    transform: translateY(-5px);
  }
}
@keyframes ghost-shadow {
  0%,
  100% {
    transform: translate(-50%, -62%) scale(0.9);
    opacity: 1;
  }
  50% {
    transform: translate(-50%, -62%) scale(0.72);
    opacity: 0.7;
  }
}
/* Sacudida breve al fallar un paso. */
.fx.shake {
  animation: shake 0.5s steps(8) 1;
}
@keyframes shake {
  0%,
  100% {
    transform: translateX(0);
  }
  20%,
  60% {
    transform: translateX(-3px);
  }
  40%,
  80% {
    transform: translateX(3px);
  }
}

/* ---------- La hitodama ---------- */
.flame-layer {
  position: absolute;
  inset: 0;
  z-index: 4000;
  pointer-events: none;
  will-change: transform;
}
/* Llamita azul de píxeles (silueta escalonada) con su resplandor, centrada en el punto y que parpadea. */
.hitodama {
  position: absolute;
  left: 0;
  top: 0;
  width: var(--flame);
  height: calc(var(--flame) * 4 / 3);
  margin: calc(var(--flame) * -2 / 3) 0 0 calc(var(--flame) * -0.5);
  background:
    linear-gradient(transparent 55%, #e8f6ff 55% 80%, transparent 80%) center / 34% 100% no-repeat,
    var(--flame-color);
  clip-path: polygon(
    50% 0,
    66.7% 0,
    66.7% 25%,
    83.3% 25%,
    83.3% 50%,
    100% 50%,
    100% 87.5%,
    83.3% 87.5%,
    83.3% 100%,
    16.7% 100%,
    16.7% 87.5%,
    0 87.5%,
    0 50%,
    16.7% 50%,
    16.7% 37.5%,
    33.3% 37.5%,
    33.3% 12.5%,
    50% 12.5%
  );
  filter: drop-shadow(0 0 3px var(--flame-color));
  animation: hitodama 0.9s steps(2) infinite;
}
/* Entregada: flota sobre el puesto, un poco más grande y despacio. */
.hitodama.resting {
  animation: hitodama-rest 1.6s steps(4) infinite;
}
@keyframes hitodama {
  0%,
  100% {
    transform: translateY(0);
    opacity: 1;
  }
  50% {
    transform: translateY(-2px);
    opacity: 0.75;
  }
}
@keyframes hitodama-rest {
  0%,
  100% {
    transform: translateY(0) scale(1.15);
  }
  50% {
    transform: translateY(-4px) scale(1.15);
  }
}

/* ---------- Partículas ---------- */
.particle {
  position: absolute;
  z-index: 3900;
  pointer-events: none;
  animation-timing-function: steps(6);
  animation-fill-mode: forwards;
}
.particle.is-dust {
  z-index: 5;
  width: 4px;
  height: 4px;
  margin: -2px 0 0 -2px;
  background: rgb(236 226 204 / 0.85);
  box-shadow: 0 0 0 1px rgb(60 48 30 / 0.25);
  animation-name: dust;
  animation-timing-function: steps(5);
}
@keyframes dust {
  from {
    transform: translate(0, 0) scale(1);
    opacity: 0.9;
  }
  to {
    transform: translate(var(--dx), var(--dy)) scale(0.5);
    opacity: 0;
  }
}
.particle.is-confetti {
  width: 5px;
  height: 5px;
  margin: -2px 0 0 -2px;
  background: var(--pc);
  box-shadow: 0 0 0 1px rgb(14 17 36 / 0.6);
  animation-name: confetti;
  animation-timing-function: cubic-bezier(0.2, 0.7, 0.4, 1);
}
@keyframes confetti {
  0% {
    transform: translate(0, 0);
    opacity: 1;
  }
  70% {
    opacity: 1;
  }
  100% {
    transform: translate(var(--dx), var(--dy));
    opacity: 0;
  }
}
.particle.is-tag {
  padding: 1px 3px;
  transform: translate(-50%, -50%);
  background: var(--yk-gold, #e8b64c);
  color: #2a1a0c;
  font-weight: 700;
  font-size: 12px;
  line-height: 1.1;
  box-shadow:
    0 0 0 2px #2a1a0c,
    2px 2px 0 2px rgb(0 0 0 / 0.4);
  animation-name: tag-rise;
  animation-timing-function: steps(8);
}
@keyframes tag-rise {
  0% {
    transform: translate(-50%, -50%) scale(0.6);
    opacity: 0;
  }
  15% {
    transform: translate(-50%, -50%) scale(1);
    opacity: 1;
  }
  75% {
    opacity: 1;
  }
  100% {
    transform: translate(-50%, calc(-50% + var(--dy)));
    opacity: 0;
  }
}
.particle.is-flash {
  width: calc(var(--sprite) * 0.5);
  height: calc(var(--sprite) * 0.5);
  margin: calc(var(--sprite) * -0.25) 0 0 calc(var(--sprite) * -0.25);
  border: 3px solid #e8f6ff;
  border-radius: 50%;
  box-shadow:
    0 0 10px 2px var(--courier),
    inset 0 0 8px var(--courier);
  animation-name: flash;
  animation-timing-function: steps(5);
}
@keyframes flash {
  from {
    transform: scale(0.2);
    opacity: 1;
  }
  to {
    transform: scale(1.5);
    opacity: 0;
  }
}
.particle.is-spark {
  width: 4px;
  height: 4px;
  margin: -2px 0 0 -2px;
  background: #e8f6ff;
  box-shadow: 0 0 4px var(--courier);
  animation-name: dust;
}
.particle.is-smoke {
  width: 9px;
  height: 9px;
  margin: -4px 0 0 -4px;
  background: rgb(120 116 128 / 0.85);
  box-shadow: 0 0 0 1px rgb(40 38 48 / 0.5);
  animation-name: smoke;
  animation-timing-function: steps(7);
}
@keyframes smoke {
  from {
    transform: translate(0, 0) scale(0.6);
    opacity: 0.9;
  }
  to {
    transform: translate(var(--dx), var(--dy)) scale(1.8);
    opacity: 0;
  }
}

/* ---------- Rótulo del paso ---------- */
/* En la esquina de abajo a la izquierda, sobre el borde oscuro de la planta: no tapa ninguna sala. */
.caption {
  position: absolute;
  left: 2.2%;
  bottom: 1.6%;
  z-index: 4100;
  display: flex;
  align-items: center;
  gap: 7px;
  max-width: max(26.5%, 150px);
  margin: 0;
  padding: 3px 8px 3px 7px;
  background: var(--ink);
  color: #fff8ec;
  font-family: var(--font-mono);
  line-height: 1.3;
  border-left: 3px solid var(--lamp, #8f8a7a);
  box-shadow: 2px 2px 0 rgb(0 0 0 / 0.45);
  cursor: default;
}
.caption .lamp {
  flex: none;
  width: 7px;
  height: 7px;
  background: var(--lamp, #8f8a7a);
  box-shadow: 0 0 6px var(--lamp, transparent);
}
.caption-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.caption-head {
  color: var(--lamp, #d9d0b8);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.03em;
}
.caption-body {
  overflow: hidden;
  font-size: 11px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.caption.is-running,
.caption.is-between {
  --lamp: var(--courier);
}
.caption.is-running .lamp {
  animation: room-breathe 1.2s steps(2) infinite;
}
.caption.is-waiting {
  --lamp: var(--waiting);
}
.caption.is-completed {
  --lamp: #72d184;
}
.caption.is-failed {
  --lamp: var(--failed);
}

/* Sin movimiento: nada late, nada flota, no hay partículas; los resaltados se quedan fijos. */
.is-reduced .room-mark,
.is-reduced .destination,
.is-reduced .hitodama,
.is-reduced .fx,
.is-reduced .shadow,
.is-reduced .caption .lamp {
  animation: none;
}
@media (prefers-reduced-motion: reduce) {
  .room-mark,
  .destination,
  .hitodama,
  .fx,
  .shadow,
  .caption .lamp,
  .particle {
    animation: none;
  }
  .particle {
    display: none;
  }
}
</style>
