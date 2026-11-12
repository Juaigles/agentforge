<script setup lang="ts">
// Fondo de ambiente del Modo Yōkai: la aldea embrujada de noche, con niebla que deriva, la luna que late y unas
// hitodama (llamas fantasma) flotando. Es decorativo (aria-hidden) y no recibe el ratón; lo que vaya delante se
// asegura el contraste con `dim`, una capa oscura encima. Con «reducir movimiento» todo queda quieto.
import { computed } from 'vue';
import { YOKAI_ASSETS } from '@/lib/yokai/assets';

const props = withDefaults(defineProps<{ dim?: number }>(), { dim: 0.35 });

/** Opacidad de la capa oscura, siempre entre 0 y 1. */
const shade = computed(() => (Number.isFinite(props.dim) ? Math.min(1, Math.max(0, props.dim)) : 0.35));

/**
 * Hitodama: posición en % de la imagen (las tres primeras están encima de las llamas pintadas), y duración y retardo
 * de la flotación, distintos en cada una para que no se muevan al compás.
 */
const WISPS = [
  { x: 9.8, y: 22, dur: 7.5, delay: 0 },
  { x: 75.2, y: 20.5, dur: 9, delay: -3.2 },
  { x: 63.4, y: 56.5, dur: 8.2, delay: -5.6 },
  { x: 31, y: 46, dur: 10.5, delay: -1.4 },
  { x: 88, y: 60, dur: 6.8, delay: -4.1 },
  { x: 47, y: 79, dur: 9.6, delay: -7.3 },
] as const;
</script>

<template>
  <div class="yokai-backdrop" aria-hidden="true" data-testid="yokai-backdrop">
    <!-- El escenario conserva la proporción 3:2 de la imagen y la cubre, anclado abajo: así la luna y las hitodama
         quedan siempre sobre su sitio del dibujo, mida lo que mida el contenedor. -->
    <div class="stage">
      <img class="village" :src="YOKAI_ASSETS.aldea" alt="" draggable="false" decoding="async" />
      <span class="moon" />
      <span v-for="(w, i) in WISPS" :key="i" class="wisp" :style="{ left: `${w.x}%`, top: `${w.y}%`, '--dur': `${w.dur}s`, '--delay': `${w.delay}s` }" />
    </div>
    <span class="fog fog-low" />
    <span class="fog fog-high" />
    <span class="shade" :style="{ opacity: shade }" />
  </div>
</template>

<style scoped>
.yokai-backdrop {
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
  user-select: none;
  /* Color medio de la aldea: es lo que se ve mientras carga la imagen. */
  background: #2a1a44;
  container-type: size;
}
.stage {
  position: absolute;
  left: 50%;
  bottom: 0;
  /* «cover» a mano: el escenario 3:2 es al menos tan ancho y tan alto como el contenedor. */
  width: max(100%, 150vh);
  width: max(100cqw, 150cqh);
  aspect-ratio: 3 / 2;
  transform: translateX(-50%);
}
.village {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: center bottom;
  image-rendering: crisp-edges;
  image-rendering: pixelated;
}

/* Resplandor de la luna llena (arriba a la derecha del dibujo): late muy despacio. */
.moon {
  position: absolute;
  left: 69.5%;
  top: 6.2%;
  width: 24%;
  aspect-ratio: 1;
  border-radius: 50%;
  transform: translate(-50%, -50%);
  background: radial-gradient(circle, rgb(240 228 255 / 0.4) 0%, rgb(196 168 255 / 0.16) 32%, transparent 68%);
  mix-blend-mode: screen;
  animation: moon-pulse 11s ease-in-out infinite;
}

/* Hitodama: puntito azul cian con halo que flota y parpadea. */
.wisp {
  position: absolute;
  width: 4px;
  height: 4px;
  margin: -2px 0 0 -2px;
  border-radius: 50%;
  background: #c9f6ff;
  box-shadow:
    0 0 4px 1px rgb(120 220 255 / 0.9),
    0 0 12px 4px rgb(70 150 255 / 0.4);
  animation:
    wisp-float var(--dur) ease-in-out var(--delay) infinite,
    wisp-flicker calc(var(--dur) / 3) ease-in-out var(--delay) infinite;
}
.wisp:nth-child(odd) {
  width: 3px;
  height: 3px;
}

/* Niebla: dos bandas de nubes violetas que se repiten a lo ancho y derivan en sentidos opuestos. Cada capa mide el
   doble del contenedor y avanza la mitad de su ancho (una baldosa de nubes), así que el bucle no tiene costura. */
.fog {
  position: absolute;
  left: 0;
  width: 200%;
  background-repeat: repeat-x;
  will-change: transform;
}
.fog-low {
  bottom: -4%;
  height: 46%;
  background-image:
    radial-gradient(ellipse 22% 45% at 12% 70%, rgb(150 112 214 / 0.34), transparent 70%),
    radial-gradient(ellipse 26% 38% at 48% 82%, rgb(128 94 196 / 0.3), transparent 70%),
    radial-gradient(ellipse 20% 42% at 82% 66%, rgb(160 124 222 / 0.28), transparent 70%);
  background-size: 50% 100%;
  animation: fog-left 62s linear infinite;
}
.fog-high {
  top: 26%;
  height: 40%;
  opacity: 0.8;
  background-image:
    radial-gradient(ellipse 30% 30% at 25% 50%, rgb(170 136 230 / 0.2), transparent 70%),
    radial-gradient(ellipse 24% 26% at 70% 40%, rgb(140 104 210 / 0.22), transparent 70%);
  background-size: 25% 100%;
  animation: fog-right 48s linear infinite;
}

/* Capa oscura de contraste para lo que se ponga delante. */
.shade {
  position: absolute;
  inset: 0;
  background: #0d0716;
}

@keyframes moon-pulse {
  0%,
  100% {
    opacity: 0.65;
    transform: translate(-50%, -50%) scale(0.97);
  }
  50% {
    opacity: 1;
    transform: translate(-50%, -50%) scale(1.04);
  }
}
@keyframes wisp-float {
  0%,
  100% {
    transform: translate(0, 0);
  }
  30% {
    transform: translate(3px, -8px);
  }
  65% {
    transform: translate(-2px, -3px);
  }
}
@keyframes wisp-flicker {
  0%,
  100% {
    opacity: 1;
  }
  40% {
    opacity: 0.55;
  }
  55% {
    opacity: 0.85;
  }
}
@keyframes fog-left {
  to {
    transform: translateX(-50%);
  }
}
@keyframes fog-right {
  from {
    transform: translateX(-50%);
  }
  to {
    transform: translateX(0);
  }
}

@media (prefers-reduced-motion: reduce) {
  .moon,
  .wisp,
  .fog {
    animation: none !important;
  }
  .fog-high {
    transform: translateX(-25%);
  }
}
</style>
