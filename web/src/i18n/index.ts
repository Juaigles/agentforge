// Idiomas de la interfaz. Los textos viven en `es/<ámbito>.ts` y `en/<ámbito>.ts` (un archivo por pantalla o
// componente); la clave de un texto es `<ámbito>.<ruta>`. El español es el idioma de referencia y el de reserva.
import { computed } from 'vue';
import { createI18n } from 'vue-i18n';

export type Locale = 'es' | 'en';
export const LOCALES: Array<{ value: Locale; label: string; short: string }> = [
  { value: 'es', label: 'Español', short: 'ES' },
  { value: 'en', label: 'English', short: 'EN' },
];
const STORAGE_KEY = 'af-locale';

type Messages = Record<string, unknown>;
function collect(modules: Record<string, unknown>): Messages {
  const out: Messages = {};
  for (const [file, messages] of Object.entries(modules)) out[file.replace(/^.*\/([^/]+)\.ts$/, '$1')] = messages;
  return out;
}
export const messages: Record<Locale, Messages> = {
  es: collect(import.meta.glob('./es/*.ts', { eager: true, import: 'default' })),
  en: collect(import.meta.glob('./en/*.ts', { eager: true, import: 'default' })),
};

const isLocale = (value: unknown): value is Locale => value === 'es' || value === 'en';

/** Idioma guardado por el usuario o, si no ha elegido, el del navegador (español salvo que pida otro idioma). */
export function detectLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isLocale(saved)) return saved;
  } catch {
    /* almacenamiento no disponible */
  }
  const preferred = typeof navigator === 'undefined' ? 'es' : (navigator.language ?? 'es').toLowerCase();
  return preferred.startsWith('es') ? 'es' : 'en';
}

export const i18n = createI18n({
  legacy: false,
  locale: detectLocale(),
  fallbackLocale: 'es',
  messages: messages as never,
  // Una clave que falta se ve en pantalla tal cual y la detecta el test de coherencia; no hace falta ruido en consola.
  missingWarn: false,
  fallbackWarn: false,
});

// Vista mínima de la instancia global: los tipos de vue-i18n intentan deducir todas las claves de los mensajes
// y, con catálogos de este tamaño, el compilador se rinde («excessively deep»).
interface GlobalI18n {
  t(key: string, ...args: unknown[]): string;
  te(key: string, locale?: string): boolean;
  locale: { value: string };
}
const global = i18n.global as unknown as GlobalI18n;

/** Texto traducido. Es reactivo: lo que se pinta con él cambia al cambiar de idioma. */
export const t = (key: string, ...args: unknown[]): string => global.t(key, ...args);
/** ¿Existe la clave en el idioma actual (o en el de reserva)? */
export const te = (key: string): boolean => global.te(key) || global.te(key, 'es');

const numberFormats = new Map<string, Intl.NumberFormat>();
/** Etiqueta BCP 47 con la que se formatean números y fechas en el idioma actual. */
export const intlLocale = (): string => (global.locale.value === 'en' ? 'en-US' : 'es-ES');
export function formatCount(n: number): string {
  const tag = intlLocale();
  let nf = numberFormats.get(tag);
  if (!nf) numberFormats.set(tag, (nf = new Intl.NumberFormat(tag)));
  return nf.format(n);
}

/** Texto con plural: la clave tiene la forma «{n} paso | {n} pasos» y `n` se escribe con el formato del idioma. */
export function tn(key: string, n: number, named: Record<string, unknown> = {}): string {
  return t(key, { ...named, n: formatCount(n) }, n);
}

export const locale = computed<Locale>(() => (isLocale(global.locale.value) ? global.locale.value : 'es'));

export function setLocale(next: Locale, persist = true): void {
  global.locale.value = next;
  if (typeof document !== 'undefined') document.documentElement.lang = next;
  if (!persist) return;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* almacenamiento no disponible */
  }
}

if (typeof document !== 'undefined') document.documentElement.lang = locale.value;
