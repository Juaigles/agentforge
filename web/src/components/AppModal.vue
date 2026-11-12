<script lang="ts">
// Pila de diálogos abiertos (un diálogo de confirmación puede abrirse encima de otro): solo el de arriba es
// interactivo; la aplicación de detrás y los diálogos de debajo quedan inertes.
const stack: HTMLElement[] = [];
// En Safari, pulsar un botón con el ratón no le da el foco: al abrirse un diálogo el foco estaría en <body> o en
// el contenedor de la página, y al cerrarlo no volvería al botón. Se recuerda el último control pulsado.
let lastPressed: HTMLElement | null = null;
if (typeof document !== 'undefined') {
  document.addEventListener(
    'pointerdown',
    (ev) => {
      lastPressed = (ev.target as Element | null)?.closest?.<HTMLElement>('button, a[href], [role="button"], [tabindex]') ?? null;
    },
    true,
  );
}
/** Control al que se devolverá el foco al cerrar el diálogo que se está abriendo. */
function focusOrigin(): HTMLElement | null {
  const active = document.activeElement as HTMLElement | null;
  // Sin foco en un control (en <body>, o en un contenedor que envuelve al botón pulsado, como <main>): el pulsado.
  if (lastPressed?.isConnected && (!active || active === document.body || active.contains(lastPressed))) return lastPressed;
  return active && active !== document.body ? active : null;
}
function syncInert(): void {
  const app = document.getElementById('app');
  if (app) app.inert = stack.length > 0;
  stack.forEach((el, i) => {
    el.inert = i < stack.length - 1;
  });
}
</script>

<script setup lang="ts">
// Diálogo modal accesible: atrapa el foco, deja inerte lo de detrás, cierra con Esc y devuelve el foco al cerrar.
import { X } from 'lucide-vue-next';
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { t } from '@/i18n';
import { focusableIn } from '@/lib/a11y';
import { useUi } from '@/stores/ui';

const props = withDefaults(
  defineProps<{
    title: string;
    width?: number;
    /** Id del elemento que describe el diálogo (un lector de pantalla lo lee al abrirlo). */
    describedby?: string;
    /**
     * Esc y «×» piden confirmación («Descartar cambios») si hay algo sin guardar. Es opcional: en los diálogos de
     * consulta o de simple ejecución, perder lo escrito no cuesta nada.
     */
    confirmClose?: boolean;
    /** Sustituye a la detección automática de «algo escrito» (`input`/`change` dentro del diálogo). */
    dirty?: boolean;
  }>(),
  { width: 560, describedby: undefined, dirty: undefined },
);
const emit = defineEmits<{ close: [] }>();
const backdrop = ref<HTMLElement | null>(null);
const panel = ref<HTMLElement | null>(null);
const previous = focusOrigin();
/** El usuario ha escrito o cambiado algo dentro: pulsar fuera ya no cierra (se perdería lo escrito). */
const touched = ref(false);
const hasUnsaved = (): boolean => props.dirty ?? touched.value;
let asking = false;

/** Cierra el diálogo; con `confirmClose` y algo sin guardar, antes pregunta si se descarta. */
async function requestClose(): Promise<void> {
  if (props.confirmClose && hasUnsaved()) {
    if (asking) return;
    asking = true;
    const discard = await useUi().confirm({
      title: t('common.discard.title'),
      message: t('common.discard.message'),
      confirmLabel: t('common.discard.confirm'),
      danger: true,
    });
    asking = false;
    if (!discard) return;
  }
  emit('close');
}

function onKey(ev: KeyboardEvent): void {
  if (stack[stack.length - 1] !== backdrop.value) return;
  if (ev.key === 'Escape') {
    ev.stopPropagation();
    void requestClose();
    return;
  }
  if (ev.key !== 'Tab' || !panel.value) return;
  // Trampa de foco: el tabulador da la vuelta dentro del diálogo.
  const items = focusableIn(panel.value);
  if (!items.length) {
    ev.preventDefault();
    panel.value.focus();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement as HTMLElement | null;
  if (ev.shiftKey && (active === first || active === panel.value || !panel.value.contains(active))) {
    ev.preventDefault();
    last.focus();
  } else if (!ev.shiftKey && (active === last || !panel.value.contains(active))) {
    ev.preventDefault();
    first.focus();
  }
}

function onBackdrop(): void {
  if (!(props.confirmClose ? hasUnsaved() : touched.value)) emit('close');
}

onMounted(async () => {
  document.addEventListener('keydown', onKey);
  if (backdrop.value) stack.push(backdrop.value);
  syncInert();
  await nextTick();
  const first = panel.value?.querySelector<HTMLElement>(
    '[autofocus], .body input:not([type=hidden]):not([disabled]), .body textarea:not([disabled]), .body select:not([disabled])',
  );
  (first ?? panel.value)?.focus();
});
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKey);
  const at = backdrop.value ? stack.indexOf(backdrop.value) : -1;
  if (at >= 0) stack.splice(at, 1);
  syncInert();
  if (previous?.isConnected) previous.focus();
});
</script>

<template>
  <Teleport to="body">
    <div ref="backdrop" class="backdrop" @mousedown.self="onBackdrop">
      <div
        ref="panel"
        class="modal"
        role="dialog"
        aria-modal="true"
        :aria-label="title"
        :aria-describedby="describedby"
        tabindex="-1"
        :style="{ maxWidth: `${width}px` }"
        @input="touched = true"
        @change="touched = true"
      >
        <header>
          <h2>{{ title }}</h2>
          <button class="btn btn-ghost btn-icon btn-sm" type="button" :aria-label="t('common.actions.close')" @click="requestClose"><X /></button>
        </header>
        <div class="body"><slot /></div>
        <footer v-if="$slots.footer"><slot name="footer" /></footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 7vh 16px 16px;
  background: rgb(20 15 8 / 0.5);
  backdrop-filter: blur(2px);
  overflow-y: auto;
}
.modal {
  width: 100%;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  outline: none;
  animation: pop 0.14s ease-out;
}
@keyframes pop {
  from {
    opacity: 0;
    transform: translateY(6px) scale(0.985);
  }
}
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--border);
}
.body {
  padding: 18px;
}
footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 18px;
  border-top: 1px solid var(--border);
  background: var(--surface-2);
  border-radius: 0 0 var(--radius-lg) var(--radius-lg);
  flex-wrap: wrap;
}
</style>
