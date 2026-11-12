// «Piel» de la interfaz: la presentación normal o el Modo Yōkai (oficina de yōkai en pixel art). Es un ref de módulo
// (no un store de Pinia) para que cualquier componente la lea sin depender de que haya store, como `motion` en su día.
// La preferencia se recuerda en el navegador y se refleja en `<html data-skin="yokai">`, que es el gancho del CSS.
import { computed, ref } from 'vue';
import { safeStorage } from './storage';

export type Skin = 'default' | 'yokai';

const KEY = 'af-skin';

export const skin = ref<Skin>(safeStorage.get(KEY) === 'yokai' ? 'yokai' : 'default');
/** true con el Modo Yōkai activado. */
export const yokaiOn = computed(() => skin.value === 'yokai');

/** Escribe la piel actual en `<html>`. Se llama al arrancar y cada vez que cambia. */
export function applySkin(): void {
  if (typeof document === 'undefined') return;
  if (skin.value === 'yokai') document.documentElement.dataset.skin = 'yokai';
  else delete document.documentElement.dataset.skin;
}

export function setSkin(next: Skin): void {
  skin.value = next;
  if (next === 'yokai') safeStorage.set(KEY, 'yokai');
  else safeStorage.remove(KEY);
  applySkin();
}
