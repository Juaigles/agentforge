<script setup lang="ts">
// Planta animada del Modo Yōkai: la ejecución de un workflow como un recorrido por la oficina. La plantilla (un yōkai
// por paso de agente) espera en la cocina y va a su cubículo cuando le toca; el mensajero lleva la hitodama de sala en
// sala hasta el paso en curso. Quién está dónde lo decide `actorsFromRun`; aquí solo se dibuja y se anima el paseo.
// Las coordenadas son de la imagen de la planta (PLAN_SIZE de lado) y se pintan en %, así que la escena es fluida.
import type { RunSnapshot } from '@shared/types';
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { t } from '@/i18n';
import { STATUS_LABEL } from '@/lib/format';
import type { RunLive } from '@/lib/run-state';
import { useReducedMotion } from '@/lib/useReducedMotion';
import { FRAME, PLAN_SIZE, SPRITE_SCALE_ON_PLAN, YOKAI_ASSETS } from '@/lib/yokai/assets';
import { actorsFromRun } from '@/lib/yokai/choreography';
import { ROOMS } from '@/lib/yokai/map';
import { advance, remainingPath, startWalk, type Walk } from '@/lib/yokai/movement';
import type { Actor, Facing, Point, RoomId } from '@/lib/yokai/types';
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

const ROOM_IDS = Object.keys(ROOMS) as RoomId[];

const reduced = useReducedMotion();
const actors = computed(() => actorsFromRun(props.snapshot, props.live));

// ---------- Medida del contenedor ----------
const root = ref<HTMLElement | null>(null);
const measured = ref(0);
const width = computed(() => measured.value || FALLBACK_WIDTH);
/** Lado del sprite en px: un cuadro de 128 px a la escala de la planta tal y como se ve ahora. */
const spriteSize = computed(() => Math.max(16, Math.round(FRAME * SPRITE_SCALE_ON_PLAN * (width.value / PLAN_SIZE))));
const showLabels = computed(() => width.value >= LABELS_MIN_WIDTH);
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

// ---------- Posiciones y paseos ----------
interface Placement {
  pos: Point;
  /** Puesto al que va (o en el que está). */
  goal: Point;
  facing: Facing;
  walk: Walk | null;
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

const samePoint = (a: Point, b: Point): boolean => a.x === b.x && a.y === b.y;
const canAnimate = (): boolean => !reduced.value && typeof requestAnimationFrame === 'function';

function sync(): void {
  const wanted = goals.value;
  for (const key of Object.keys(places)) if (!(key in wanted)) delete places[key];
  for (const [key, goal] of Object.entries(wanted)) {
    const place = places[key];
    // Al aparecer se coloca directamente en su puesto, sin paseo.
    if (!place) {
      places[key] = { pos: { ...goal }, goal: { ...goal }, facing: 'down', walk: null };
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
    // Si el destino cambia a mitad de paseo, el nuevo sale de donde está ahora.
    place.walk = startWalk(place.pos, goal);
    place.facing = place.walk.facing;
  }
  if (Object.values(places).some((p) => p.walk)) loop();
}

let frame = 0;
let last = 0;
function loop(): void {
  if (frame || !canAnimate()) return;
  last = 0;
  frame = requestAnimationFrame(tick);
}
function tick(now: number): void {
  frame = 0;
  const dt = last ? Math.min(MAX_FRAME_SECONDS, (now - last) / 1000) : 0;
  last = now;
  let moving = false;
  for (const place of Object.values(places)) {
    if (!place.walk) continue;
    const walk = advance(place.walk, dt);
    place.pos = walk.pos;
    if (walk.arrived) {
      // Al llegar mira hacia abajo (a quien mira la planta) y ya puede mostrar lo que hace.
      place.walk = null;
      place.facing = 'down';
    } else {
      place.walk = walk;
      place.facing = walk.facing;
      moving = true;
    }
  }
  // El bucle solo sigue mientras alguien camina.
  if (moving) frame = requestAnimationFrame(tick);
}
function stop(): void {
  if (frame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
  frame = 0;
}
/** Con «reducir movimiento» (o si se activa a mitad de paseo) todos saltan a su destino. */
function finishWalks(): void {
  stop();
  for (const place of Object.values(places)) {
    if (!place.walk) continue;
    place.pos = { ...place.goal };
    place.walk = null;
    place.facing = 'down';
  }
}

watch(goals, sync, { immediate: true });
watch(reduced, (on) => {
  if (on) finishWalks();
});
onBeforeUnmount(() => {
  stop();
  observer?.disconnect();
});

// ---------- Lo que se pinta ----------
const pct = (v: number): string => `${(v / PLAN_SIZE) * 100}%`;
const planStyle = { backgroundImage: `url("${YOKAI_ASSETS.planta}")` };

/** Nombre visible de un yōkai de plantilla: el del agente o, si ya no existe, la etiqueta del paso. */
function staffName(a: Actor): string {
  return a.name || props.snapshot.workflow.nodes.find((n) => n.id === a.key)?.label || a.key;
}

const scene = computed(() =>
  actors.value.map((actor) => {
    const place = places[actor.key] ?? { pos: actor.seat, goal: actor.seat, facing: 'down' as Facing, walk: null };
    return {
      actor,
      walking: !!place.walk,
      facing: place.facing,
      // La burbuja de actividad sale al llegar, no por el camino.
      activity: place.walk ? undefined : actor.activity,
      style: { left: pct(place.pos.x), top: pct(place.pos.y), zIndex: 10 + Math.round(place.pos.y) },
    };
  }),
);

const courier = computed(() => actors.value.find((a) => a.kind === 'courier') ?? null);
/** Estela del mensajero: lo que le queda de camino, como lista de puntos del SVG. */
const trail = computed(() => {
  const walk = places.courier?.walk;
  if (!walk) return '';
  return remainingPath(walk)
    .map((p) => `${p.x},${p.y}`)
    .join(' ');
});
const flameSize = computed(() => Math.max(8, Math.round(spriteSize.value * 0.2)));
</script>

<template>
  <div ref="root" class="yokai-floor" role="group" :aria-label="t('yokaiFloor.region')" @click="emit('select', null)">
    <div class="plan yk-pixel" :style="planStyle" aria-hidden="true" />

    <template v-if="showLabels">
      <span
        v-for="id in ROOM_IDS"
        :key="id"
        class="room-label"
        :style="{ left: pct(ROOMS[id].rect.x + 6), top: pct(ROOMS[id].rect.y + 6) }"
        aria-hidden="true"
        >{{ t(`yokaiFloor.rooms.${id}`) }}</span
      >
    </template>

    <svg v-if="trail" class="trail" :viewBox="`0 0 ${PLAN_SIZE} ${PLAN_SIZE}`" preserveAspectRatio="none" aria-hidden="true">
      <polyline :points="trail" />
    </svg>

    <template v-for="item in scene" :key="item.actor.key">
      <div
        v-if="item.actor.kind === 'staff'"
        class="actor staff"
        :class="{ selected: selected === item.actor.key }"
        :data-key="item.actor.key"
        :style="{ ...item.style, '--c': item.actor.color, '--size': `${spriteSize}px` }"
      >
        <button
          class="body"
          type="button"
          :aria-label="t('yokaiFloor.staff', { name: staffName(item.actor), status: STATUS_LABEL[item.actor.status].toLowerCase() })"
          :aria-pressed="selected === item.actor.key"
          @click.stop="emit('select', item.actor.key)"
        >
          <YokaiSprite
            :species="item.actor.species"
            :facing="item.facing"
            :walking="item.walking"
            :size="spriteSize"
            :activity="item.activity"
            :tint="item.actor.color"
          />
        </button>
        <span class="name truncate" aria-hidden="true">{{ staffName(item.actor) }}</span>
      </div>
      <div
        v-else
        class="actor courier"
        :data-key="item.actor.key"
        :style="{ ...item.style, '--size': `${spriteSize}px`, '--flame': `${flameSize}px` }"
        aria-hidden="true"
      >
        <span class="body">
          <YokaiSprite
            :species="item.actor.species"
            :facing="item.facing"
            :walking="item.walking"
            :size="spriteSize"
            :activity="item.activity"
            :tint="item.actor.color"
          />
          <span class="hitodama" :class="{ still: reduced }" :style="{ '--flame-color': item.actor.color }" />
        </span>
      </div>
    </template>

    <p v-if="courier" class="sr-only">{{ t('yokaiFloor.courierAt', { room: t(`yokaiFloor.rooms.${courier.room}`) }) }}</p>
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
}
.plan {
  position: absolute;
  inset: 0;
  background-size: 100% 100%;
  background-repeat: no-repeat;
  image-rendering: crisp-edges;
  image-rendering: pixelated;
}

/* Rótulos de sala: plaquitas pixeladas, texto claro sobre tinta (contraste muy por encima de 4,5:1). */
.room-label {
  position: absolute;
  z-index: 1;
  padding: 1px 4px;
  background: rgb(14 17 36 / 0.88);
  color: #fff8ec;
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 600;
  line-height: 1.3;
  white-space: nowrap;
  pointer-events: none;
  box-shadow: 2px 2px 0 rgb(0 0 0 / 0.45);
}

.trail {
  position: absolute;
  inset: 0;
  z-index: 2;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
.trail polyline {
  fill: none;
  stroke: #5ab4ff;
  stroke-width: 3;
  stroke-dasharray: 6 6;
  stroke-linecap: square;
  stroke-linejoin: miter;
  vector-effect: non-scaling-stroke;
  opacity: 0.9;
}

/* Cada yōkai se ancla por los pies: la caja del actor no mide nada y el sprite crece hacia arriba desde ella. */
.actor {
  position: absolute;
  width: 0;
  height: 0;
}
.actor .body {
  position: absolute;
  left: 0;
  bottom: 0;
  width: var(--size);
  height: var(--size);
  transform: translateX(-50%);
}
.staff .body {
  display: block;
  padding: 0;
  border: 0;
  background: none;
  color: inherit;
  cursor: pointer;
}
.staff .body:focus-visible {
  outline: 2px solid var(--yk-focus, var(--accent));
  outline-offset: 1px;
}
/* Seleccionado: anillo a los pies del color del agente, como el cursor de un JRPG. */
.staff.selected .body::before {
  content: '';
  position: absolute;
  left: 12%;
  right: 12%;
  bottom: -4%;
  height: 22%;
  border: 3px solid var(--c);
  border-radius: 50%;
  box-shadow: 0 0 0 1px rgb(14 17 36 / 0.7);
}
.name {
  position: absolute;
  top: 3px;
  left: 0;
  max-width: calc(var(--size) * 1.6);
  transform: translateX(-50%);
  padding: 0 3px;
  background: rgb(14 17 36 / 0.88);
  border-bottom: 2px solid var(--c);
  color: #fff8ec;
  font-family: var(--font-mono);
  font-size: 10px;
  line-height: 1.35;
  pointer-events: none;
}
.courier {
  pointer-events: none;
}

/* La hitodama: llamita azul de píxeles (silueta escalonada) que flota junto al mensajero y parpadea. */
.hitodama {
  position: absolute;
  right: -4%;
  top: 22%;
  width: var(--flame);
  height: calc(var(--flame) * 4 / 3);
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
  animation: hitodama 0.9s steps(2) infinite;
}
@keyframes hitodama {
  0% {
    transform: translateY(0);
    opacity: 1;
  }
  50% {
    transform: translateY(-2px);
    opacity: 0.7;
  }
  100% {
    transform: translateY(0);
    opacity: 1;
  }
}
.hitodama.still {
  animation: none;
}
@media (prefers-reduced-motion: reduce) {
  .hitodama {
    animation: none;
  }
}
</style>
