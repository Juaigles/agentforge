<script setup lang="ts">
// Arista del grafo en vivo: la misma curva «smoothstep» de siempre y, mientras el nodo de destino trabaja, unas
// partículas que la recorren hacia él (el testigo pasa de un paso al siguiente).
import { BaseEdge, getSmoothStepPath, type EdgeProps } from '@vue-flow/core';
import { computed } from 'vue';
import { useReducedMotion } from '@/lib/useReducedMotion';

defineOptions({ inheritAttrs: false });
const props = defineProps<EdgeProps>();

/** Partículas por arista y segundos que tarda cada una en recorrerla. */
const PARTICLES = 3;
const DURATION = 1.8;

const reduced = useReducedMotion();
const geometry = computed(() => getSmoothStepPath({ ...props }));
const flowing = computed(() => !!props.data?.flowing && !reduced.value);
</script>

<template>
  <BaseEdge
    :id="id"
    :path="geometry[0]"
    :label-x="geometry[1]"
    :label-y="geometry[2]"
    :label="label"
    :label-style="labelStyle"
    :label-show-bg="labelShowBg"
    :label-bg-style="labelBgStyle"
    :label-bg-padding="labelBgPadding"
    :label-bg-border-radius="labelBgBorderRadius"
    :marker-start="markerStart"
    :marker-end="markerEnd"
    :interaction-width="interactionWidth"
    :style="style"
  />
  <g v-if="flowing" class="particles" aria-hidden="true">
    <g v-for="i in PARTICLES" :key="i" class="particle">
      <circle r="5.5" class="glow" />
      <circle r="2.6" class="dot" />
      <animateMotion :dur="`${DURATION}s`" :begin="`${((i - 1) * DURATION) / PARTICLES}s`" repeatCount="indefinite" :path="geometry[0]" />
    </g>
  </g>
</template>

<style scoped>
.particles {
  pointer-events: none;
}
.glow {
  fill: var(--info);
  opacity: 0.22;
}
.dot {
  fill: var(--info);
}
</style>
