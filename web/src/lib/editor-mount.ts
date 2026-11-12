// Montaje de las pantallas de edición (agente y workflow) dentro del router.
//
// Cada vez que se llega a un editor —otro elemento, o «nuevo»— la pantalla se monta de cero: así no arrastra el
// formulario, el historial de deshacer ni la selección del anterior. La excepción es el primer guardado: la
// pantalla que acaba de crear su elemento pasa de «…/new» a la dirección definitiva sin desmontarse (`adoptRoute`).
import { defineComponent, h, ref, watch, type Component } from 'vue';
import { useRoute, type Router } from 'vue-router';

/** Dirección que una pantalla está adoptando ahora mismo (solo mientras dura esa navegación). */
let adopting: string | null = null;

/** ¿Se está llegando a `path` porque la pantalla abierta adopta la dirección de lo que acaba de crear? */
export const isAdoption = (path: string): boolean => adopting === path;

/**
 * Cambia la dirección a la del elemento recién creado sin volver a montar la pantalla. Sustituye la entrada del
 * historial: «atrás» no vuelve a «nuevo».
 */
export async function adoptRoute(router: Router, path: string): Promise<void> {
  adopting = path;
  try {
    await router.replace(path);
  } finally {
    adopting = null;
  }
}

const mounts = new WeakMap<Component, Component>();

/**
 * Envoltorio con el que una pantalla de edición se declara en las rutas. Es el mismo para todas las rutas de la
 * pantalla (por eso el router lo reutiliza al pasar de una a otra) y decide él cuándo se monta de nuevo: en cada
 * cambio de dirección que no sea una adopción.
 */
export function editorMount(view: Component): Component {
  let mount = mounts.get(view);
  if (!mount) {
    const created: Component = defineComponent({
      name: 'EditorMount',
      setup() {
        const route = useRoute();
        const key = ref(0);
        // Síncrono: la clave tiene que estar decidida antes de que se repinte y mientras dura la navegación.
        watch(
          () => route.fullPath,
          () => {
            // Al salir hacia otra pantalla no hay nada que volver a montar.
            const stays = route.matched.some((record) => record.components?.default === created);
            if (stays && !isAdoption(route.path)) key.value++;
          },
          { flush: 'sync' },
        );
        return () => h(view, { key: key.value });
      },
    });
    mounts.set(view, created);
    mount = created;
  }
  return mount;
}
