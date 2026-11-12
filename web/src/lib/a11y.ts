// Accesibilidad transversal: anuncios para lectores de pantalla, asociación automática de pistas y errores con
// su campo, foco en el primer campo con error y textos en español para el lienzo de Vue Flow.
import { nextTick, ref } from 'vue';

/** Texto de la región viva global (App.vue la pinta con `role="status"`). */
export const announcement = ref('');

/** Anuncia un mensaje de estado a los lectores de pantalla sin mover el foco. */
export function announce(message: string): void {
  // Se vacía antes: así el mismo mensaje dos veces seguidas se anuncia las dos veces.
  announcement.value = '';
  void nextTick(() => {
    announcement.value = message;
  });
}

let nextId = 1;

/** Enlaza cada control de un `.field` con su pista y su mensaje de error (`aria-describedby`). */
function describeFields(root: ParentNode): void {
  for (const field of root.querySelectorAll<HTMLElement>('.field')) {
    const control = field.querySelector<HTMLElement>('input:not([type="hidden"]), select, textarea');
    if (!control) continue;
    const ids: string[] = [];
    for (const message of field.querySelectorAll<HTMLElement>('.error, .hint')) {
      // Solo los mensajes de este campo, no los de un campo anidado.
      if (message.closest('.field') !== field) continue;
      message.id ||= `af-msg-${nextId++}`;
      ids.push(message.id);
    }
    const value = ids.join(' ');
    // Un `aria-describedby` puesto a mano en la plantilla se respeta.
    if (control.dataset.afDescribed === undefined && control.hasAttribute('aria-describedby')) continue;
    if ((control.getAttribute('aria-describedby') ?? '') === value) continue;
    control.dataset.afDescribed = '';
    if (value) control.setAttribute('aria-describedby', value);
    else control.removeAttribute('aria-describedby');
  }
}

/**
 * Mantiene asociados los campos con sus mensajes en toda la aplicación (también en los diálogos) y, cuando un
 * formulario se envía y queda algún campo marcado como no válido, lleva el foco al primero.
 * Devuelve la función que lo desinstala.
 */
export function installFormA11y(root: HTMLElement = document.body): () => void {
  let scheduled = false;
  const run = (): void => {
    scheduled = false;
    describeFields(root);
  };
  const observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(run);
  });
  observer.observe(root, { childList: true, subtree: true });
  describeFields(root);

  const onSubmit = (ev: Event): void => {
    const form = ev.target as HTMLFormElement;
    // Los errores del servidor llegan un poco después del envío: se comprueba varias veces durante un momento.
    let tries = 0;
    const check = (): void => {
      if (!form.isConnected) return;
      const invalid = form.querySelector<HTMLElement>('[aria-invalid="true"]');
      if (invalid) {
        if (!form.contains(document.activeElement) || document.activeElement?.getAttribute('aria-invalid') !== 'true') invalid.focus();
        return;
      }
      if (++tries < 15) setTimeout(check, 100);
    };
    setTimeout(check, 0);
  };
  root.addEventListener('submit', onSubmit, true);
  return () => {
    observer.disconnect();
    root.removeEventListener('submit', onSubmit, true);
  };
}

const FLOW_TEXTS: Array<[selector: string, label: string]> = [
  ['.vue-flow__controls-zoomin', 'Acercar'],
  ['.vue-flow__controls-zoomout', 'Alejar'],
  ['.vue-flow__controls-fitview', 'Encuadrar todo el grafo'],
];

/**
 * Vue Flow trae sus textos de ayuda en inglés y sus botones de zoom sin nombre: se sustituyen por los nuestros.
 * `nodeHelp` y `edgeHelp` son las descripciones que oye un lector de pantalla al enfocar un nodo o una conexión.
 */
export function localizeFlow(container: HTMLElement, nodeHelp: string, edgeHelp: string): () => void {
  const apply = (): void => {
    for (const [selector, label] of FLOW_TEXTS) {
      for (const button of container.querySelectorAll<HTMLElement>(selector)) {
        if (button.getAttribute('aria-label') !== label) {
          button.setAttribute('aria-label', label);
          button.setAttribute('title', label);
        }
      }
    }
    for (const el of container.querySelectorAll<HTMLElement>('[id^="vue-flow__node-desc-"]')) if (el.textContent !== nodeHelp) el.textContent = nodeHelp;
    for (const el of container.querySelectorAll<HTMLElement>('[id^="vue-flow__edge-desc-"]')) if (el.textContent !== edgeHelp) el.textContent = edgeHelp;
    for (const el of container.querySelectorAll<HTMLElement>('.vue-flow__edge[aria-roledescription="edge"]')) el.setAttribute('aria-roledescription', 'conexión');
    for (const el of container.querySelectorAll<HTMLElement>('.vue-flow__minimap')) if (!el.hasAttribute('aria-hidden')) el.setAttribute('aria-hidden', 'true');
  };
  let scheduled = false;
  const observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      apply();
    });
  });
  observer.observe(container, { childList: true, subtree: true });
  apply();
  return () => observer.disconnect();
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Elementos que pueden recibir el foco con el tabulador dentro de `root`, en orden. */
export function focusableIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0 && !el.closest('[inert]'));
}
