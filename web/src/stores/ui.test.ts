// @vitest-environment jsdom
// Store de interfaz (avisos, confirmaciones y tema): lógica propia sin red; el reloj de los avisos usa
// temporizadores falsos de Vitest (solo el tiempo, no se sustituye ningún módulo).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshPinia } from '@/test/harness';
import { useUi } from './ui';

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  freshPinia();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('avisos', () => {
  beforeEach(() => vi.useFakeTimers());

  it('los de error no caducan; los informativos caducan a los 5 s y los que llevan enlace a los 12 s', () => {
    const ui = useUi();
    ui.error('Algo falló');
    ui.success('Hecho');
    ui.info('Mira', { label: 'Ver', to: '/runs/1' });
    expect(ui.toasts.map((t) => t.tone)).toEqual(['danger', 'success', 'info']);

    vi.advanceTimersByTime(4999);
    expect(ui.toasts).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(ui.toasts.map((t) => t.message)).toEqual(['Algo falló', 'Mira']);
    vi.advanceTimersByTime(7000);
    expect(ui.toasts.map((t) => t.message)).toEqual(['Algo falló']);
    vi.advanceTimersByTime(24 * 3600 * 1000);
    expect(ui.toasts.map((t) => t.message)).toEqual(['Algo falló']);
  });

  it('dismiss retira un aviso y sus ids no se reutilizan', () => {
    const ui = useUi();
    ui.error('Uno');
    const first = ui.toasts[0].id;
    ui.dismiss(first);
    expect(ui.toasts).toEqual([]);
    ui.error('Dos');
    expect(ui.toasts[0].id).not.toBe(first);
  });

  it('muestra como máximo 5 a la vez: los más antiguos se retiran', () => {
    const ui = useUi();
    for (let i = 1; i <= 7; i++) ui.error(`Error ${i}`);
    expect(ui.toasts.map((t) => t.message)).toEqual(['Error 3', 'Error 4', 'Error 5', 'Error 6', 'Error 7']);
  });

  it('el mismo aviso repetido no se apila y reinicia su cuenta atrás', () => {
    const ui = useUi();
    ui.success('Guardado');
    vi.advanceTimersByTime(3000);
    ui.success('Guardado');
    ui.success('Guardado');
    expect(ui.toasts).toHaveLength(1);
    // Otro tono o texto distinto sí es otro aviso.
    ui.info('Guardado');
    ui.success('Guardado otra vez');
    expect(ui.toasts).toHaveLength(3);

    vi.advanceTimersByTime(3000); // 6 s desde el primero, pero solo 3 desde su repetición
    expect(ui.toasts.map((t) => t.message)).toContain('Guardado');
    vi.advanceTimersByTime(2000);
    expect(ui.toasts).toEqual([]);
  });

  it('hold detiene la cuenta atrás y release la reanuda desde cero', () => {
    const ui = useUi();
    ui.info('Pasa el puntero');
    const { id } = ui.toasts[0];
    vi.advanceTimersByTime(4000);
    ui.hold(id);
    vi.advanceTimersByTime(60_000);
    expect(ui.toasts).toHaveLength(1);

    ui.release(id);
    vi.advanceTimersByTime(4999);
    expect(ui.toasts).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(ui.toasts).toEqual([]);
    ui.release(id); // soltar un aviso que ya no existe no falla ni lo recrea
    expect(ui.toasts).toEqual([]);
  });
});

describe('confirmaciones', () => {
  it('confirm queda abierta con sus opciones y devuelve lo que se responde con answer', async () => {
    const ui = useUi();
    const accepted = ui.confirm({ title: 'Eliminar', message: '¿Seguro?', confirmLabel: 'Eliminar', danger: true });
    expect(ui.confirmState).toMatchObject({ title: 'Eliminar', message: '¿Seguro?', confirmLabel: 'Eliminar', danger: true });
    ui.answer(true);
    await expect(accepted).resolves.toBe(true);
    expect(ui.confirmState).toBeNull();

    const refused = ui.confirm({ title: 'Otra', message: 'x' });
    ui.answer(false);
    await expect(refused).resolves.toBe(false);
    expect(ui.confirmState).toBeNull();
  });

  it('answer sin ninguna confirmación abierta no falla', () => {
    const ui = useUi();
    expect(() => ui.answer(true)).not.toThrow();
    expect(ui.confirmState).toBeNull();
  });

  it('una segunda confirmación sustituye a la primera, y la primera se resuelve con «no» en vez de quedarse esperando', async () => {
    const ui = useUi();
    const first = ui.confirm({ title: 'Primera', message: 'a' });
    const second = ui.confirm({ title: 'Segunda', message: 'b' });
    expect(ui.confirmState?.title).toBe('Segunda');
    // La primera ya no puede contestarse: quien la esperaba recibe «no» y no se queda colgado para siempre.
    await expect(first).resolves.toBe(false);
    ui.answer(true);
    await expect(second).resolves.toBe(true);
  });
});

describe('tema', () => {
  it('arranca con «system» si no hay nada guardado, y con lo guardado si lo hay', () => {
    expect(useUi().theme).toBe('system');
    localStorage.setItem('af-theme', 'dark');
    freshPinia();
    expect(useUi().theme).toBe('dark');
  });

  it('setTheme guarda la elección en localStorage y la aplica con data-theme en <html>', () => {
    const ui = useUi();
    ui.setTheme('dark');
    expect(ui.theme).toBe('dark');
    expect(localStorage.getItem('af-theme')).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    ui.setTheme('light');
    expect(localStorage.getItem('af-theme')).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('«system» borra lo guardado y quita data-theme para volver a seguir al sistema', () => {
    const ui = useUi();
    ui.setTheme('dark');
    ui.setTheme('system');
    expect(ui.theme).toBe('system');
    expect(localStorage.getItem('af-theme')).toBeNull();
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });
});

describe('con el almacenamiento del navegador bloqueado', () => {
  it('el store se crea y el tema sigue funcionando (solo durante la sesión)', () => {
    for (const method of ['getItem', 'setItem', 'removeItem'] as const) {
      vi.spyOn(Storage.prototype, method).mockImplementation(() => {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      });
    }
    try {
      const ui = useUi();
      expect(ui.theme).toBe('system');
      ui.setTheme('dark');
      expect(ui.theme).toBe('dark');
      expect(document.documentElement.dataset.theme).toBe('dark');
      ui.setTheme('system');
      expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
