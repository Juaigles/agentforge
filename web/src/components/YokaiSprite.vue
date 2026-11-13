<script setup lang="ts">
// Un yōkai dibujado con su hoja de sprites (4 fotogramas × 4 direcciones). Es decorativo (aria-hidden): el nombre
// accesible lo pone quien lo usa. El tamaño se cambia con background-size para que el pixel art siga nítido.
import { computed } from 'vue';
import type { AgentActivity } from '@/lib/agent-activity';
import { YOKAI_ASSETS } from '@/lib/yokai/assets';
import { activityGlyph, backgroundPosition, bubbleSize, sheetSize } from '@/lib/yokai/sprite';
import type { Facing, YokaiSpecies } from '@/lib/yokai/types';

// `frame` fija el fotograma del ciclo desde fuera (la planta lo sincroniza con la distancia recorrida, así los pies
// no patinan): con él no corre la animación CSS del ciclo.
const props = withDefaults(
  defineProps<{ species: YokaiSpecies; facing?: Facing; walking?: boolean; frame?: number; size?: number; activity?: AgentActivity; tint?: string }>(),
  { facing: 'down', walking: false, frame: undefined, size: 128 },
);

const glyph = computed(() => activityGlyph(props.activity));
const bubble = computed(() => bubbleSize(props.size));
const stepped = computed(() => props.frame !== undefined);

const sheetStyle = computed(() => ({
  backgroundImage: `url("${YOKAI_ASSETS.sprites[props.species]}")`,
  backgroundSize: `${sheetSize(props.size)}px ${sheetSize(props.size)}px`,
  backgroundPosition: backgroundPosition(props.facing, props.frame ?? 0, props.size),
  '--sheet': `${sheetSize(props.size)}px`,
}));
</script>

<template>
  <span
    class="yokai-sprite"
    :class="[`is-${species}`, `facing-${facing}`, { 'is-walking': walking && !stepped }]"
    :style="{ width: `${size}px`, height: `${size}px` }"
    aria-hidden="true"
  >
    <span class="sheet" :style="sheetStyle" />
    <span
      v-if="glyph"
      class="bubble"
      :class="`is-${activity}`"
      :style="{ width: `${bubble}px`, height: `${bubble}px`, fontSize: `${Math.round(bubble * 0.62)}px`, '--tint': tint ?? 'var(--text-3)' }"
      >{{ glyph }}</span
    >
  </span>
</template>

<style scoped>
.yokai-sprite {
  position: relative;
  display: inline-block;
  flex: none;
  /* Contexto de apilado propio: la burbuja se pone por encima del sprite sin competir con el resto de la página. */
  isolation: isolate;
  pointer-events: none;
  user-select: none;
}
.sheet {
  position: absolute;
  inset: 0;
  background-repeat: no-repeat;
  image-rendering: crisp-edges;
  image-rendering: pixelated;
}
/* Caminar: recorre los 4 fotogramas de la fila a saltos (sin interpolar entre cuadros). */
.is-walking .sheet {
  animation: yokai-walk 0.5s steps(4) infinite;
}
@keyframes yokai-walk {
  from {
    background-position-x: 0;
  }
  to {
    background-position-x: calc(-1 * var(--sheet));
  }
}

/* Burbuja de pensamiento pixelada: el borde se hace con sombras en los cuatro lados, que dejan las esquinas
   «mordidas» como en un JRPG, y la cola con dos cuadraditos. */
.bubble {
  position: absolute;
  top: 0;
  right: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  transform: translate(25%, -25%);
  background: var(--surface);
  color: var(--text);
  font-weight: 700;
  line-height: 1;
  box-shadow:
    0 -2px 0 0 var(--tint),
    0 2px 0 0 var(--tint),
    -2px 0 0 0 var(--tint),
    2px 0 0 0 var(--tint);
}
.bubble::before,
.bubble::after {
  content: '';
  position: absolute;
  background: var(--tint);
}
.bubble::before {
  left: 2px;
  bottom: -5px;
  width: 3px;
  height: 3px;
}
.bubble::after {
  left: -1px;
  bottom: -8px;
  width: 2px;
  height: 2px;
}
.bubble.is-error {
  color: var(--danger);
}
/* Esperando una aprobación: el sello 印 late despacio, a saltos (como un cursor de JRPG que pide atención). */
.bubble.is-waiting {
  animation: yokai-stamp 1.2s steps(2, jump-none) infinite;
}
@keyframes yokai-stamp {
  0%,
  100% {
    transform: translate(25%, -25%) scale(1);
  }
  50% {
    transform: translate(25%, -35%) scale(1.15);
  }
}

@media (prefers-reduced-motion: reduce) {
  .is-walking .sheet,
  .bubble.is-waiting {
    animation: none;
  }
}
</style>
