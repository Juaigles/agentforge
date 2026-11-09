<script setup lang="ts">
// Diálogo modal accesible: cierra con Esc o al pulsar fuera y devuelve el foco al cerrar.
import { X } from 'lucide-vue-next';
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';

withDefaults(defineProps<{ title: string; width?: number }>(), { width: 560 });
const emit = defineEmits<{ close: [] }>();
const panel = ref<HTMLElement | null>(null);
const previous = document.activeElement as HTMLElement | null;

function onKey(ev: KeyboardEvent): void {
  if (ev.key === 'Escape') {
    ev.stopPropagation();
    emit('close');
  }
}
onMounted(async () => {
  document.addEventListener('keydown', onKey);
  await nextTick();
  const first = panel.value?.querySelector<HTMLElement>('[autofocus], .body input:not([type=hidden]), .body textarea, .body select');
  (first ?? panel.value)?.focus();
});
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKey);
  previous?.focus?.();
});
</script>

<template>
  <Teleport to="body">
    <div class="backdrop" @mousedown.self="emit('close')">
      <div ref="panel" class="modal" role="dialog" aria-modal="true" :aria-label="title" tabindex="-1" :style="{ maxWidth: `${width}px` }">
        <header>
          <h2>{{ title }}</h2>
          <button class="btn btn-ghost btn-icon btn-sm" type="button" aria-label="Cerrar" @click="emit('close')"><X /></button>
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
