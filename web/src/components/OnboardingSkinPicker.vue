<script setup lang="ts">
// Elección de la presentación en el primer paso del recorrido: dos botones con una vista previa pequeña de cada piel.
// Se cambia al momento (setSkin) y se puede volver a cambiar después con el interruptor de la barra lateral.
import { t } from '@/i18n';
import { setSkin, skin, type Skin } from '@/lib/skin';
import YokaiSprite from './YokaiSprite.vue';

const OPTIONS: Array<{ value: Skin; labelKey: string; hintKey: string }> = [
  { value: 'default', labelKey: 'onboarding.skin.normal', hintKey: 'onboarding.skin.normalHint' },
  { value: 'yokai', labelKey: 'onboarding.skin.yokai', hintKey: 'onboarding.skin.yokaiHint' },
];
</script>

<template>
  <fieldset class="skin-picker" data-testid="onboarding-skins">
    <legend>{{ t('onboarding.skin.label') }}</legend>
    <div class="options">
      <button
        v-for="option in OPTIONS"
        :key="option.value"
        type="button"
        class="option"
        :class="[`is-${option.value}`, { active: skin === option.value }]"
        :aria-pressed="skin === option.value"
        @click="setSkin(option.value)"
      >
        <!-- Vista previa decorativa: lo que importa está en el texto del botón. -->
        <span class="preview" aria-hidden="true">
          <template v-if="option.value === 'default'">
            <span class="mock-node a" />
            <span class="mock-edge" />
            <span class="mock-node b" />
          </template>
          <template v-else>
            <YokaiSprite species="kitsune" :size="40" />
            <YokaiSprite species="tanuki" :size="40" facing="left" />
          </template>
        </span>
        <span class="label">{{ t(option.labelKey) }}</span>
        <span class="hint">{{ t(option.hintKey) }}</span>
      </button>
    </div>
    <p class="later">{{ t('onboarding.skin.later') }}</p>
  </fieldset>
</template>

<style scoped>
.skin-picker {
  margin: 0;
  padding: 0;
  border: 0;
  min-width: 0;
}
legend {
  padding: 0;
  margin-bottom: 8px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-2);
}
.options {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
.option {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
  min-width: 0;
  padding: 8px;
  border: 1.5px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
  color: var(--text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.option:hover {
  border-color: var(--border-strong);
}
.option.active {
  border-color: var(--accent);
  box-shadow: inset 0 0 0 1px var(--accent);
}
.preview {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  height: 52px;
  margin-bottom: 3px;
  border-radius: var(--radius-sm);
  overflow: hidden;
}
/* La vista previa de cada piel lleva sus propios colores (no los de la piel activa), con los tokens cuando existen. */
.is-default .preview {
  background: #f6f4f0;
  border: 1px solid #e2ddd3;
}
.mock-node {
  width: 34px;
  height: 22px;
  border-radius: 5px;
  background: #ffffff;
  border: 1.5px solid #cfc8ba;
}
.mock-node.b {
  border-color: #b53c0b;
}
.mock-edge {
  width: 22px;
  height: 2px;
  background: #b53c0b;
}
.is-yokai .preview {
  /* Tatami: bandas de paja sobre el color del panel de madera de la piel. */
  background: repeating-linear-gradient(90deg, #d8c48f 0 18px, #cdb77f 18px 20px);
  border: 2px solid var(--yk-panel-border, #3d2614);
  image-rendering: pixelated;
}
.label {
  font-weight: 650;
  font-size: 13px;
}
.hint {
  font-size: 11.5px;
  color: var(--text-2);
  line-height: 1.35;
}
.later {
  margin: 8px 0 0;
  font-size: 11.5px;
  color: var(--text-2);
}
</style>
