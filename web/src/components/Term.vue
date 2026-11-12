<script setup lang="ts">
// Término del glosario: muestra su definición al pasar el ratón, enfocar o tocar, y enlaza a la página Glosario.
// Dentro de un diálogo o de un formulario el clic no navega (se perdería lo escrito): muestra la definición y ofrece
// el glosario en una pestaña nueva.
import { computed, nextTick, onBeforeUnmount, ref, useId } from 'vue';
import { useRouter } from 'vue-router';
import { t } from '@/i18n';
import { glossaryEntry, type GlossaryId } from '@/lib/glossary';

const props = defineProps<{ id: GlossaryId }>();
const router = useRouter();
const entry = computed(() => glossaryEntry(props.id));
const glossaryHref = computed(() => router.resolve({ path: '/glosario', hash: `#g-${props.id}` }).href);
const tipId = useId();
const anchor = ref<HTMLElement | null>(null);
const tip = ref<HTMLElement | null>(null);
const open = ref(false);
const viaTouch = ref(false);
/** El término está dentro de un diálogo o de un formulario: navegar destruiría lo que se esté escribiendo. */
const inForm = ref(false);
const style = ref<Record<string, string>>({});

async function show(touch = false): Promise<void> {
  viaTouch.value = touch;
  inForm.value = Boolean(anchor.value?.closest('[role="dialog"], form'));
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
  // En captura: Esc cierra solo la definición, antes de que el diálogo que la contiene lo reciba y se cierre.
  document.addEventListener('keydown', onEsc, true);
  window.addEventListener('scroll', hide, true);
}
function hide(): void {
  open.value = false;
  document.removeEventListener('pointerdown', onOutside, true);
  document.removeEventListener('keydown', onEsc, true);
  window.removeEventListener('scroll', hide, true);
}
const inside = (target: EventTarget | null): boolean => target instanceof Node && Boolean(anchor.value?.contains(target) || tip.value?.contains(target));
function onOutside(ev: Event): void {
  if (!inside(ev.target)) hide();
}
function onEsc(ev: KeyboardEvent): void {
  if (ev.key !== 'Escape') return;
  ev.stopPropagation();
  hide();
}
// El puntero puede pasar del término a la definición (1.4.13: se puede recorrer sin que desaparezca).
function onLeave(ev: MouseEvent): void {
  if (!inside(ev.relatedTarget)) hide();
}
function onBlur(ev: FocusEvent): void {
  if (!inside(ev.relatedTarget)) hide();
}
function onClick(ev: MouseEvent, navigate: (e?: MouseEvent) => void): void {
  if (anchor.value?.closest('[role="dialog"], form')) {
    ev.preventDefault();
    if (!open.value) void show(window.matchMedia('(hover: none)').matches);
    return;
  }
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
      @mouseleave="onLeave"
      @focus="show()"
      @blur="onBlur"
      @click="onClick($event, navigate)"
      ><slot>{{ entry.term }}</slot></a
    >
  </RouterLink>
  <Teleport to="body">
    <div v-if="open" :id="tipId" ref="tip" class="term-tip" role="tooltip" :style="style" @mouseleave="onLeave">
      <strong>{{ entry.term }}</strong>
      <span>{{ entry.definition }}</span>
      <em v-if="viaTouch && !inForm">{{ t('term.tapAgain') }}</em>
      <a v-if="inForm" class="term-link" :href="glossaryHref" target="_blank" rel="noopener">{{ t('term.openGlossary') }}</a>
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
}
/* Franja invisible que cubre el hueco entre el término y la definición, para poder llegar a ella con el puntero. */
.term-tip::before {
  content: '';
  position: absolute;
  inset: -10px;
}
.term-tip .term-link {
  color: inherit;
  text-decoration: underline;
}
.term-tip em {
  opacity: 0.7;
  font-size: 11.5px;
}
</style>
