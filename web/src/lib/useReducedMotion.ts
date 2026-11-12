// Preferencia del sistema «reducir movimiento», reactiva. Hace falta para las animaciones SMIL (<animateMotion>),
// que no obedecen a la regla de main.css: esa solo frena animaciones y transiciones CSS.
import { onBeforeUnmount, ref, type Ref } from 'vue';

export function useReducedMotion(): Ref<boolean> {
  const query = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const reduced = ref(query?.matches ?? false);
  if (query) {
    const update = (ev: MediaQueryListEvent) => (reduced.value = ev.matches);
    query.addEventListener('change', update);
    onBeforeUnmount(() => query.removeEventListener('change', update));
  }
  return reduced;
}
