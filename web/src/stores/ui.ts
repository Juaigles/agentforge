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

  function toast(tone: Toast['tone'], message: string, action?: Toast['action']): void {
    const id = nextId++;
    toasts.value.push({ id, tone, message, action });
    setTimeout(() => dismiss(id), tone === 'danger' ? 8000 : 4500);
  }
  function dismiss(id: number): void {
    toasts.value = toasts.value.filter((t) => t.id !== id);
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

  return { toasts, toast, dismiss, success, error, info, confirmState, confirm, answer, theme, setTheme };
});
