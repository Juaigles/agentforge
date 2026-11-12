<script setup lang="ts">
// Avisos (toasts) y diálogo de confirmación globales.
import { CircleAlert, CircleCheck, Info, X } from 'lucide-vue-next';
import { useUi } from '@/stores/ui';
import AppModal from './AppModal.vue';

const ui = useUi();
const ICONS = { success: CircleCheck, danger: CircleAlert, info: Info };
</script>

<template>
  <Teleport to="body">
    <div class="toasts" role="region" aria-label="Avisos">
      <!-- Los errores interrumpen (alert); el resto se anuncia cuando el lector termina lo que estaba diciendo. -->
      <TransitionGroup name="toast">
        <div
          v-for="t in ui.toasts"
          :key="t.id"
          class="toast"
          :class="t.tone"
          :role="t.tone === 'danger' ? 'alert' : 'status'"
          @mouseenter="ui.hold(t.id)"
          @mouseleave="ui.release(t.id)"
          @focusin="ui.hold(t.id)"
          @focusout="ui.release(t.id)"
        >
          <component :is="ICONS[t.tone]" class="icon" aria-hidden="true" />
          <span class="grow">{{ t.message }}</span>
          <RouterLink v-if="t.action" :to="t.action.to" class="action" @click="ui.dismiss(t.id)">{{ t.action.label }}</RouterLink>
          <button type="button" aria-label="Descartar aviso" @click="ui.dismiss(t.id)"><X /></button>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>

  <AppModal v-if="ui.confirmState" :title="ui.confirmState.title" :width="440" @close="ui.answer(false)">
    <p class="muted">{{ ui.confirmState.message }}</p>
    <template #footer>
      <!-- En una acción destructiva el foco cae en «Cancelar»: Intro por costumbre no debe borrar nada. -->
      <button class="btn" type="button" :autofocus="ui.confirmState.danger ? true : undefined" @click="ui.answer(false)">Cancelar</button>
      <button class="btn" :class="ui.confirmState.danger ? 'btn-danger' : 'btn-primary'" type="button" :autofocus="ui.confirmState.danger ? undefined : true" @click="ui.answer(true)">
        {{ ui.confirmState.confirmLabel ?? 'Confirmar' }}
      </button>
    </template>
  </AppModal>
</template>

<style scoped>
.toasts {
  position: fixed;
  right: 18px;
  bottom: 18px;
  z-index: 400;
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: min(380px, calc(100vw - 36px));
}
.toast {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 11px 12px;
  border-radius: var(--radius);
  background: var(--surface);
  border: 1px solid var(--border);
  border-left: 3px solid var(--info);
  box-shadow: var(--shadow-md);
  font-size: 13px;
}
.toast.success {
  border-left-color: var(--success);
}
.toast.danger {
  border-left-color: var(--danger);
}
.icon {
  width: 16px;
  height: 16px;
  flex: none;
  margin-top: 2px;
  color: var(--info);
}
.success .icon {
  color: var(--success);
}
.danger .icon {
  color: var(--danger);
}
.action {
  font-weight: 600;
}
.toast button {
  border: 0;
  background: none;
  color: var(--text-3);
  cursor: pointer;
  /* Objetivo de 24 px aunque el icono mida 14. */
  min-width: 24px;
  min-height: 24px;
  padding: 0;
  display: grid;
  place-items: center;
  border-radius: 6px;
}
.toast button svg {
  width: 14px;
  height: 14px;
}
.toast-enter-active,
.toast-leave-active {
  transition: all 0.18s ease;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
</style>
