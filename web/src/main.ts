import { createPinia } from 'pinia';
import { createApp, watch } from 'vue';
import App from './App.vue';
import { i18n } from './i18n';
import { applySkin, yokaiOn } from './lib/skin';
import { router } from './router';
import '@vue-flow/core/dist/style.css';
import '@vue-flow/core/dist/theme-default.css';
import '@vue-flow/controls/dist/style.css';
import '@vue-flow/minimap/dist/style.css';
import './styles/main.css';
import './styles/flow.css';

// Piel de la interfaz: se escribe en <html> antes de montar. La hoja del Modo Yōkai no se descarga con la piel por
// defecto: se importa (una sola vez) la primera vez que la piel es yokai, al arrancar o al activarla después. Vite
// la separa en su propio archivo CSS y la enlaza al resolverse el import.
applySkin();
let yokaiStyles: Promise<unknown> | undefined;
watch(
  yokaiOn,
  (on) => {
    // Si la carga falla (p. ej. el servidor se reinició con otra compilación), se reintenta en la próxima activación.
    if (on)
      yokaiStyles ??= import('@/styles/yokai.css').catch(() => {
        yokaiStyles = undefined;
      });
  },
  { immediate: true },
);

createApp(App).use(createPinia()).use(i18n).use(router).mount('#app');
