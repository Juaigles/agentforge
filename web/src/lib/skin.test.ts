// @vitest-environment jsdom
// Piel de la interfaz: la preferencia se recuerda en el navegador y se refleja en <html data-skin>.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applySkin, setSkin, skin, yokaiOn } from './skin';

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.skin;
  skin.value = 'default';
});
afterEach(() => {
  setSkin('default');
  vi.restoreAllMocks();
});

describe('piel', () => {
  it('por defecto no hay preferencia guardada ni atributo en <html>', () => {
    applySkin();
    expect(yokaiOn.value).toBe(false);
    expect(document.documentElement.hasAttribute('data-skin')).toBe(false);
  });

  it('setSkin("yokai") guarda la preferencia y escribe data-skin en <html>', () => {
    setSkin('yokai');
    expect(skin.value).toBe('yokai');
    expect(yokaiOn.value).toBe(true);
    expect(localStorage.getItem('af-skin')).toBe('yokai');
    expect(document.documentElement.dataset.skin).toBe('yokai');
  });

  it('volver a la piel por defecto borra la preferencia y el atributo', () => {
    setSkin('yokai');
    setSkin('default');
    expect(yokaiOn.value).toBe(false);
    expect(localStorage.getItem('af-skin')).toBeNull();
    expect(document.documentElement.hasAttribute('data-skin')).toBe(false);
  });

  it('applySkin refleja el valor actual (es lo que se llama al arrancar)', () => {
    skin.value = 'yokai';
    applySkin();
    expect(document.documentElement.dataset.skin).toBe('yokai');
    skin.value = 'default';
    applySkin();
    expect(document.documentElement.hasAttribute('data-skin')).toBe(false);
  });

  it('al cargar, lee la preferencia guardada e ignora valores desconocidos', async () => {
    localStorage.setItem('af-skin', 'yokai');
    vi.resetModules();
    expect((await import('./skin')).skin.value).toBe('yokai');
    localStorage.setItem('af-skin', 'otra');
    vi.resetModules();
    expect((await import('./skin')).skin.value).toBe('default');
  });

  it('sin almacenamiento disponible la piel cambia igualmente (solo dura la sesión)', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('bloqueado', 'SecurityError');
    });
    expect(() => setSkin('yokai')).not.toThrow();
    expect(document.documentElement.dataset.skin).toBe('yokai');
  });
});
