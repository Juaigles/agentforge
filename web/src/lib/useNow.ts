import { onBeforeUnmount, ref, type Ref } from 'vue';

/** Reloj reactivo para mostrar tiempos transcurridos que avanzan solos. */
export function useNow(intervalMs = 1000): Ref<number> {
  const now = ref(Date.now());
  const timer = setInterval(() => (now.value = Date.now()), intervalMs);
  onBeforeUnmount(() => clearInterval(timer));
  return now;
}
