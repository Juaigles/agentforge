<script setup lang="ts">
// Interruptor del Modo Yōkai, en el pie de la barra lateral. El estado vive en `skin` (lib/skin.ts): aquí solo se
// lee y se cambia. Es un checkbox nativo con rol de interruptor, así que funciona con teclado (Espacio) sin más.
import { useId } from 'vue';
import { t } from '@/i18n';
import { setSkin, yokaiOn } from '@/lib/skin';

// El nombre accesible es solo «Modo Yōkai»; la pista se anuncia como descripción, no como parte del nombre.
const id = useId();
const nameId = `skin-name-${id}`;
const hintId = `skin-hint-${id}`;

function onChange(event: Event): void {
  setSkin((event.target as HTMLInputElement).checked ? 'yokai' : 'default');
}
</script>

<template>
  <label class="skin-toggle" :title="t('skin.hint')" data-testid="skin-toggle">
    <input type="checkbox" role="switch" class="switch" :checked="yokaiOn" :aria-labelledby="nameId" :aria-describedby="hintId" @change="onChange" />
    <span class="text">
      <span :id="nameId" class="name">{{ t('skin.label') }}</span>
      <span :id="hintId" class="hint">{{ t('skin.hint') }}</span>
    </span>
  </label>
</template>

<style scoped>
.skin-toggle {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 6px 8px;
  border-radius: 8px;
  cursor: pointer;
}
.skin-toggle:hover {
  background: var(--surface-2);
}
.text {
  display: flex;
  flex-direction: column;
  min-width: 0;
  line-height: 1.3;
}
.name {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text);
}
.hint {
  font-size: 11.5px;
  color: var(--text-2);
}

/* En la barra horizontal de las pantallas estrechas solo queda el interruptor; el texto sigue siendo su nombre
   accesible (se oculta a la vista, no a los lectores de pantalla) y la pista queda en el título. */
@media (max-width: 860px) {
  .skin-toggle {
    flex: none;
    padding: 0 4px;
  }
  .text {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
}
</style>
