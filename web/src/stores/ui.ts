// Estado de interfaz: avisos (toasts), diálogo de confirmación y tema.
import { defineStore } from 'pinia';
import { ref } from 'vue';

export interface Toast {
  id: number;
  tone: 'success' | 'danger' | 'info';
  message: string;
  action?: { label: string; to: string };
}

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
}

export type Theme = 'light' | 'dark' | 'system';

export const useUi = defineStore('ui', () => {
  const toasts = ref<Toast[]>([]);
  let nextId = 1;

  /** Avisos que no se muestran a la vez: los más antiguos se retiran. */
  const MAX_TOASTS = 5;
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  /**
   * Los errores no desaparecen solos (hay que leerlos y, a veces, actuar): se quedan hasta que se descartan.
   * Los que llevan un enlace duran más, y cualquiera se detiene mientras el puntero o el foco están encima.
   */
  const lifetime = (t: Pick<Toast, 'tone' | 'action'>): number => (t.tone === 'danger' ? 0 : t.action ? 12_000 : 5000);
  function schedule(id: number, ms: number): void {
    clearTimeout(timers.get(id));
    if (ms > 0) timers.set(id, setTimeout(() => dismiss(id), ms));
  }
  function toast(tone: Toast['tone'], message: string, action?: Toast['action']): void {
    // El mismo aviso repetido no se apila.
    const same = toasts.value.find((t) => t.tone === tone && t.message === message);
    if (same) return void schedule(same.id, lifetime(same));
    const id = nextId++;
    toasts.value.push({ id, tone, message, action });
    while (toasts.value.length > MAX_TOASTS) dismiss(toasts.value[0].id);
    schedule(id, lifetime({ tone, action }));
  }
  function dismiss(id: number): void {
    clearTimeout(timers.get(id));
    timers.delete(id);
    toasts.value = toasts.value.filter((t) => t.id !== id);
  }
  /** Detiene la cuenta atrás de un aviso (puntero o foco encima) y la reanuda al salir. */
  function hold(id: number): void {
    clearTimeout(timers.get(id));
  }
  function release(id: number): void {
    const t = toasts.value.find((x) => x.id === id);
    if (t) schedule(id, lifetime(t));
  }
  const success = (message: string, action?: Toast['action']) => toast('success', message, action);
  const error = (message: string) => toast('danger', message);
  const info = (message: string, action?: Toast['action']) => toast('info', message, action);

  // Confirmación basada en promesa: `if (await ui.confirm({...}))`.
  const confirmState = ref<(ConfirmOptions & { resolve: (ok: boolean) => void }) | null>(null);
  function confirm(options: ConfirmOptions): Promise<boolean> {
    return new Promise((resolve) => {
      confirmState.value = { ...options, resolve };
    });
  }
  function answer(ok: boolean): void {
    confirmState.value?.resolve(ok);
    confirmState.value = null;
  }

  const theme = ref<Theme>((localStorage.getItem('af-theme') as Theme | null) ?? 'system');
  function setTheme(next: Theme): void {
    theme.value = next;
    if (next === 'system') {
      localStorage.removeItem('af-theme');
      delete document.documentElement.dataset.theme;
    } else {
      localStorage.setItem('af-theme', next);
      document.documentElement.dataset.theme = next;
    }
  }

  return { toasts, toast, dismiss, hold, release, success, error, info, confirmState, confirm, answer, theme, setTheme };
});
