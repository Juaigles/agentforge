// Acceso a `localStorage` que nunca lanza: con los datos del sitio bloqueados (o en ciertos modos privados) el
// navegador lanza `SecurityError` al tocarlo, y eso no debe impedir que la aplicación arranque.
export const safeStorage = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* sin almacenamiento: la preferencia dura solo lo que dure la sesión */
    }
  },
  remove(key: string): void {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ídem */
    }
  },
};
