<script setup lang="ts">
// Franja «Plantilla de hoy» del Modo Yōkai: los agentes, como yōkai en fila sobre las baldosas de la oficina, cada uno
// con su nombre y enlace a su ficha. Los que están trabajando ahora (`activeIds`) caminan y muestran la burbuja de
// pensar; el resto, la de reposo. Solo existe con la piel yōkai: en la normal no pinta nada.
import type { Agent } from '@shared/types';
import { computed } from 'vue';
import YokaiSprite from '@/components/YokaiSprite.vue';
import { t } from '@/i18n';
import { yokaiOn } from '@/lib/skin';
import { speciesFor } from '@/lib/yokai/species';

const props = withDefaults(defineProps<{ agents: Agent[]; activeIds?: string[] }>(), { activeIds: () => [] });

/** Cuántos caben en la franja sin que deje de ser una franja. */
const MAX_SHOWN = 8;

const busy = computed(() => new Set(props.activeIds));
const staff = computed(() => props.agents.slice(0, MAX_SHOWN).map((agent) => ({ agent, species: speciesFor(agent.id), busy: busy.value.has(agent.id) })));
</script>

<template>
  <section v-if="yokaiOn && staff.length" class="yokai-roster" aria-labelledby="yokai-roster-title" data-testid="yokai-roster">
    <h2 id="yokai-roster-title" class="eyebrow roster-title">{{ t('yokaiViews.roster.title') }}</h2>
    <ul class="floor">
      <li v-for="m in staff" :key="m.agent.id">
        <RouterLink :to="`/agents/${m.agent.id}`" class="member" :class="{ busy: m.busy }">
          <span class="sprite" aria-hidden="true">
            <YokaiSprite :species="m.species" facing="down" :walking="m.busy" :size="56" :activity="m.busy ? 'thinking' : 'idle'" :tint="m.agent.color" />
          </span>
          <span class="name truncate">{{ m.agent.name }}</span>
          <span v-if="m.busy" class="sr-only">{{ t('yokaiViews.roster.busy') }}</span>
        </RouterLink>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.yokai-roster {
  margin-bottom: 22px;
}
.roster-title {
  margin: 0 0 8px;
}
/* Banda de baldosas oscuras de la oficina: rejilla de juntas sobre un suelo violeta muy oscuro, con borde y sombra
   duros, como el resto del pixel art. */
.floor {
  list-style: none;
  margin: 0;
  padding: 10px 12px 8px;
  display: flex;
  flex-wrap: wrap;
  gap: 4px 6px;
  background-color: #241c33;
  background-image:
    linear-gradient(90deg, rgb(255 255 255 / 0.06) 2px, transparent 2px), linear-gradient(rgb(0 0 0 / 0.35) 2px, transparent 2px),
    linear-gradient(135deg, rgb(255 255 255 / 0.03) 25%, transparent 25%);
  background-size:
    32px 32px,
    32px 32px,
    64px 64px;
  border: 2px solid #0f0a18;
  box-shadow:
    inset 0 4px 0 rgb(0 0 0 / 0.35),
    4px 4px 0 rgb(0 0 0 / 0.35);
}
.member {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  width: 76px;
  padding: 2px 2px 4px;
  color: #f4f0ff;
  text-decoration: none;
}
.member:hover {
  text-decoration: none;
}
.member:hover .name {
  background: #3a2d55;
}
.member:focus-visible {
  outline: 2px solid #ffd166;
  outline-offset: 0;
}
.sprite {
  display: grid;
  place-items: end center;
  width: 56px;
  height: 56px;
}
/* Nombre en una chapita opaca: el contraste no depende de las baldosas. */
.name {
  max-width: 100%;
  padding: 1px 5px;
  background: #120c1d;
  border: 1px solid #3d3156;
  font-size: 11.5px;
  font-weight: 600;
  line-height: 1.4;
}
.busy .name {
  border-color: #7fd8ff;
}
</style>
