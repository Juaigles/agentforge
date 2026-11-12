<script setup lang="ts">
// Página «no encontrada». Con el Modo Yōkai se pinta delante de la aldea, como una caja de diálogo de RPG junto al
// fantasma del ojo, que también se ha perdido; la estructura y los textos son los mismos en las dos pieles.
import { Compass } from 'lucide-vue-next';
import YokaiBackdrop from '@/components/YokaiBackdrop.vue';
import YokaiSprite from '@/components/YokaiSprite.vue';
import { t } from '@/i18n';
import { yokaiOn } from '@/lib/skin';
</script>

<template>
  <div class="page" :class="{ 'yokai-scene': yokaiOn }">
    <YokaiBackdrop v-if="yokaiOn" :dim="0.3" />
    <div v-if="yokaiOn" class="yokai-guide" aria-hidden="true">
      <YokaiSprite species="ojo" facing="left" :size="96" activity="idle" />
    </div>
    <div class="card empty" :class="{ 'yokai-dialog': yokaiOn }">
      <Compass />
      <h1 class="empty-title">{{ t('notFound.title') }}</h1>
      <p>{{ t('notFound.text') }}</p>
      <p v-if="yokaiOn" class="yokai-line">{{ t('yokaiViews.notFound.line') }}</p>
      <RouterLink class="btn btn-primary" to="/">{{ t('notFound.back') }}</RouterLink>
    </div>
  </div>
</template>

<style scoped>
.empty-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}

/* ---------- Modo Yōkai ---------- */
.yokai-scene {
  position: relative;
  isolation: isolate;
  max-width: none;
  min-height: 100vh;
  min-height: 100dvh;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 8px 16px;
}
.yokai-scene > .yokai-backdrop {
  z-index: -1;
}
.yokai-guide {
  flex: none;
  line-height: 0;
}
/* Caja de diálogo de RPG: fondo opaco del sistema, borde de 2 px, esquinas rectas y sombra dura. */
.yokai-dialog {
  width: min(440px, 100%);
  border: 2px solid var(--text);
  border-radius: 0;
  box-shadow: 6px 6px 0 rgb(0 0 0 / 0.55);
}
.yokai-line {
  margin: 0;
  color: var(--text);
  font-style: italic;
}
</style>
