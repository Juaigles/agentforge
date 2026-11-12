<script setup lang="ts">
// Orbe del agente: un círculo con sus iniciales cuya animación dice qué está haciendo (ver AgentActivity).
// Sin `activity` se queda quieto, para listas densas donde el movimiento distraería.
import type { AgentActivity } from '@/lib/agent-activity';
import { initials } from '@/lib/format';

withDefaults(defineProps<{ name: string; color?: string; size?: number; activity?: AgentActivity }>(), { color: '#6b7280', size: 32 });
</script>

<template>
  <span
    class="orb"
    :class="activity ? `is-${activity}` : 'is-still'"
    :style="{ width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.36)}px`, '--c': color }"
    aria-hidden="true"
  >
    <svg viewBox="0 0 40 40">
      <circle class="wave w1" cx="20" cy="20" r="15" />
      <circle class="wave w2" cx="20" cy="20" r="15" />
      <circle class="halo" cx="20" cy="20" r="18" />
      <circle class="ring" cx="20" cy="20" r="18" pathLength="100" />
      <g class="sats">
        <circle cx="20" cy="2.4" r="2.2" />
        <circle cx="20" cy="37.6" r="1.5" />
      </g>
      <circle class="core" cx="20" cy="20" r="14.5" />
    </svg>
    <span class="initials">{{ initials(name) }}</span>
  </span>
</template>

<style scoped>
.orb {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  color: var(--c);
}
svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
}
svg * {
  transform-box: view-box;
  transform-origin: 20px 20px;
}
.initials {
  position: relative;
  font-weight: 700;
  letter-spacing: 0.02em;
  line-height: 1;
}
.core {
  fill: color-mix(in srgb, var(--c) 16%, var(--surface));
  stroke: color-mix(in srgb, var(--c) 45%, transparent);
  stroke-width: 1;
}
.halo {
  fill: color-mix(in srgb, var(--c) 14%, transparent);
  opacity: 0;
}
.ring {
  fill: none;
  stroke: var(--c);
  stroke-width: 2.2;
  stroke-linecap: round;
  stroke-dasharray: 28 72;
  opacity: 0;
}
.sats {
  fill: var(--c);
  opacity: 0;
}
.wave {
  fill: none;
  stroke: var(--c);
  stroke-width: 1.4;
  opacity: 0;
}

/* Reposo: respira despacio. */
.is-idle .core {
  animation: breathe 4s ease-in-out infinite;
}
.is-idle .halo {
  animation: halo 4s ease-in-out infinite;
}
/* Pensando: un arco gira alrededor. */
.is-thinking .ring {
  opacity: 1;
  animation: spin 1.1s linear infinite;
}
.is-thinking .halo {
  opacity: 0.6;
}
/* Herramienta: dos satélites en órbita. */
.is-tool .sats {
  opacity: 1;
  animation: spin 1.8s linear infinite;
}
.is-tool .halo {
  opacity: 0.5;
}
/* Escribiendo: ondas que salen del centro. */
.is-writing .wave {
  animation: wave 1.6s ease-out infinite;
}
.is-writing .w2 {
  animation-delay: 0.8s;
}
.is-writing .core {
  animation: breathe 0.8s ease-in-out infinite;
}
/* Esperando a una persona: pulso lento en ámbar. */
.is-waiting {
  --c: var(--warning);
}
.is-waiting .halo {
  animation: halo 2.2s ease-in-out infinite;
}
.is-waiting .ring {
  opacity: 0.8;
  stroke-dasharray: 4 6.5;
}
/* Terminado: anillo completo, quieto. */
.is-done .ring,
.is-error .ring {
  opacity: 1;
  stroke-dasharray: none;
  stroke-width: 1.6;
}
.is-done .ring {
  stroke: var(--success);
}
.is-error .ring {
  stroke: var(--danger);
}

@keyframes breathe {
  50% {
    transform: scale(1.06);
  }
}
@keyframes halo {
  0%,
  100% {
    opacity: 0.15;
    transform: scale(0.92);
  }
  50% {
    opacity: 0.9;
    transform: scale(1.05);
  }
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
@keyframes wave {
  from {
    opacity: 0.8;
    transform: scale(1);
  }
  to {
    opacity: 0;
    transform: scale(1.45);
  }
}

/* Con «reducir movimiento» del sistema cada estado sigue distinguiéndose, pero en quieto. */
@media (prefers-reduced-motion: reduce) {
  svg * {
    animation: none !important;
  }
  .is-writing .w1 {
    opacity: 0.6;
    transform: scale(1.2);
  }
  .is-idle .halo {
    opacity: 0.4;
  }
}
</style>
