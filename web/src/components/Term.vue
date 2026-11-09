<script setup lang="ts">
// Término del glosario: muestra su definición al pasar el ratón, enfocar o tocar, y enlaza a la página Glosario.
import { computed, nextTick, onBeforeUnmount, ref, useId } from 'vue';
import { GLOSSARY, type GlossaryId } from '@/lib/glossary';

const props = defineProps<{ id: GlossaryId }>();
const entry = computed(() => GLOSSARY[props.id]);
const tipId = useId();
const anchor = ref<HTMLElement | null>(null);
const tip = ref<HTMLElement | null>(null);
const open = ref(false);
const viaTouch = ref(false);
const style = ref<Record<string, string>>({});

async function show(touch = false): Promise<void> {
  viaTouch.value = touch;
  open.value = true;
  await nextTick();
  if (!anchor.value || !tip.value) return;
  const r = anchor.value.getBoundingClientRect();
  const w = tip.value.offsetWidth;
  const h = tip.value.offsetHeight;
  const left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), window.innerWidth - w - 8);
  const above = r.top - h - 8;
  style.value = { left: `${left}px`, top: `${above > 8 ? above : r.bottom + 8}px` };
  document.addEventListener('pointerdown', onOutside, true);
  window.addEventListener('scroll', hide, true);
}
function hide(): void {
  open.value = false;
  document.removeEventListener('pointerdown', onOutside, true);
  window.removeEventListener('scroll', hide, true);
}
function onOutside(ev: Event): void {
  if (anchor.value && !anchor.value.contains(ev.target as Node)) hide();
}
function onClick(ev: MouseEvent, navigate: (e?: MouseEvent) => void): void {
  // Táctil: el primer toque muestra la definición; el segundo va al glosario.
  const touch = window.matchMedia('(hover: none)').matches;
  if (touch && !(open.value && viaTouch.value)) {
    ev.preventDefault();
    void show(true);
    return;
  }
  hide();
  navigate(ev);
}
onBeforeUnmount(hide);
</script>

<template>
  <RouterLink v-slot="{ href, navigate }" :to="{ path: '/glosario', hash: `#g-${id}` }" custom>
    <a
      ref="anchor"
      class="term"
      :href="href"
      :aria-describedby="open ? tipId : undefined"
      @mouseenter="show()"
      @mouseleave="hide"
      @focus="show()"
      @blur="hide"
      @keydown.esc="hide"
      @click="onClick($event, navigate)"
      ><slot>{{ entry.term }}</slot></a
    >
  </RouterLink>
  <Teleport to="body">
    <div v-if="open" :id="tipId" ref="tip" class="term-tip" role="tooltip" :style="style">
      <strong>{{ entry.term }}</strong>
      <span>{{ entry.definition }}</span>
      <em v-if="viaTouch">Toca otra vez para ir al glosario</em>
    </div>
  </Teleport>
</template>

<style>
.term {
  color: inherit;
  text-decoration: underline dotted var(--text-3);
  text-underline-offset: 3px;
  cursor: help;
}
.term:hover {
  text-decoration: underline dotted var(--accent);
  color: var(--accent);
}
.term-tip {
  position: fixed;
  z-index: 1000;
  width: max-content;
  max-width: min(300px, calc(100vw - 16px));
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 9px 11px;
  border-radius: 8px;
  background: var(--text);
  color: var(--bg);
  font-size: 12.5px;
  font-weight: 400;
  line-height: 1.45;
  letter-spacing: 0;
  text-transform: none;
  white-space: normal;
  box-shadow: var(--shadow-md);
  pointer-events: none;
}
.term-tip em {
  opacity: 0.7;
  font-size: 11.5px;
}
</style>
