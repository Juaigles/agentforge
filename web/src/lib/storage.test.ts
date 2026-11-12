// @vitest-environment jsdom
// Acceso seguro a `localStorage`: con el almacenamiento bloqueado el navegador lanza `SecurityError`.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { safeStorage } from './storage';

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

/** Simula los «datos del sitio bloqueados»: cualquier acceso a `localStorage` lanza. */
function blockStorage(): void {
  for (const method of ['getItem', 'setItem', 'removeItem'] as const) {
    vi.spyOn(Storage.prototype, method).mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });
  }
}

describe('safeStorage', () => {
  it('lee, escribe y borra como localStorage cuando está disponible', () => {
    expect(safeStorage.get('clave')).toBeNull();
    safeStorage.set('clave', 'valor');
    expect(localStorage.getItem('clave')).toBe('valor');
    expect(safeStorage.get('clave')).toBe('valor');
    safeStorage.remove('clave');
    expect(safeStorage.get('clave')).toBeNull();
  });

  it('con el almacenamiento bloqueado no lanza: lee null y ignora escrituras y borrados', () => {
    blockStorage();
    expect(safeStorage.get('clave')).toBeNull();
    expect(() => safeStorage.set('clave', 'valor')).not.toThrow();
    expect(() => safeStorage.remove('clave')).not.toThrow();
  });
});
