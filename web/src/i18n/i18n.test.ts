// Coherencia de los idiomas: el inglés tiene exactamente las claves del español, con los mismos huecos y las
// mismas formas de plural, y toda clave que usa el código existe.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { formatDuration, formatNumber, NODE_LABEL, relativeTime, STATUS_LABEL } from '@/lib/format';
import { detectLocale, messages, setLocale, t, tn } from './index';

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Aplana un árbol de mensajes en `ruta.de.la.clave → texto`. */
function flatten(node: unknown, prefix = '', out = new Map<string, string>()): Map<string, string> {
  if (typeof node === 'string') out.set(prefix, node);
  else if (node && typeof node === 'object') for (const [key, value] of Object.entries(node)) flatten(value, prefix ? `${prefix}.${key}` : key, out);
  return out;
}
const es = flatten(messages.es);
const en = flatten(messages.en);

/** Huecos con nombre de un mensaje (`{nombre}`), sin contar los literales (`{'texto'}`). */
const placeholders = (text: string): string[] => [...text.replace(/\{'[^']*'\}/g, '').matchAll(/\{\s*([\w.]+)\s*\}/g)].map((m) => m[1]).sort();
/** Formas de plural (separadas por `|` fuera de un literal). */
const forms = (text: string): number => text.replace(/\{'[^']*'\}/g, '').split('|').length;

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'i18n' ? [] : sourceFiles(full);
    return /\.(vue|ts)$/.test(entry.name) && !entry.name.endsWith('.test.ts') ? [full] : [];
  });
}

describe('idiomas', () => {
  it('hay textos en los dos idiomas', () => {
    expect(es.size).toBeGreaterThan(40);
    expect(en.size).toBeGreaterThan(40);
  });

  it('el inglés tiene las mismas claves que el español', () => {
    expect([...es.keys()].filter((k) => !en.has(k))).toEqual([]);
    expect([...en.keys()].filter((k) => !es.has(k))).toEqual([]);
  });

  it('ningún texto está vacío', () => {
    expect([...es].filter(([, v]) => !v.trim()).map(([k]) => `es:${k}`)).toEqual([]);
    expect([...en].filter(([, v]) => !v.trim()).map(([k]) => `en:${k}`)).toEqual([]);
  });

  it('cada texto tiene los mismos huecos y las mismas formas de plural en los dos idiomas', () => {
    const different: string[] = [];
    for (const [key, text] of es) {
      const other = en.get(key);
      if (other === undefined) continue;
      if (placeholders(text).join() !== placeholders(other).join()) different.push(`${key}: huecos {${placeholders(text)}} ≠ {${placeholders(other)}}`);
      if (forms(text) !== forms(other)) different.push(`${key}: ${forms(text)} formas ≠ ${forms(other)}`);
    }
    expect(different).toEqual([]);
  });

  it('toda clave escrita en el código existe', () => {
    const missing: string[] = [];
    const pattern = /(?:\b(?:t|tn|te)\(\s*|keypath=|[A-Za-z]+Key:\s*)(['"])([a-zA-Z][\w-]*(?:\.[\w-]+)+)\1/g;
    for (const file of sourceFiles(srcDir)) {
      const text = fs.readFileSync(file, 'utf8');
      for (const match of text.matchAll(pattern)) {
        if (!es.has(match[2])) missing.push(`${path.relative(srcDir, file).replace(/\\/g, '/')}: ${match[2]}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('el idioma por defecto es el del navegador, y el elegido se recuerda', () => {
    const storage = new Map<string, string>();
    const original = {
      localStorage: Object.getOwnPropertyDescriptor(globalThis, 'localStorage'),
      navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
    };
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v) },
    });
    const browser = (language: string) => Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { language } });
    try {
      browser('es-MX');
      expect(detectLocale()).toBe('es');
      browser('en-GB');
      expect(detectLocale()).toBe('en');
      browser('fr-FR');
      expect(detectLocale()).toBe('en');
      setLocale('es');
      expect(detectLocale()).toBe('es'); // lo elegido manda sobre el navegador
      storage.set('af-locale', 'xx');
      expect(detectLocale()).toBe('en'); // un valor desconocido se ignora
    } finally {
      for (const [name, descriptor] of Object.entries(original)) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete (globalThis as Record<string, unknown>)[name];
      }
      setLocale('es', false);
    }
  });

  it('los textos, los plurales y los formatos cambian con el idioma', () => {
    try {
      setLocale('es', false);
      expect(t('common.actions.cancel')).toBe('Cancelar');
      expect(STATUS_LABEL.completed).toBe('Completado');
      expect(NODE_LABEL.foreach).toBe('Para cada');
      expect(formatNumber(1234567.5)).toBe('1.234.567,5');
      expect(formatDuration(7000)).toBe('7,0 s');
      expect(relativeTime(new Date(Date.now() - 10_000).toISOString())).toBe('ahora mismo');
      expect(relativeTime(new Date(Date.now() - 3 * 3600_000).toISOString())).toBe('hace 3 horas');

      setLocale('en', false);
      expect(t('common.actions.cancel')).toBe('Cancel');
      expect(STATUS_LABEL.completed).toBe('Completed');
      expect(NODE_LABEL.foreach).toBe('For each');
      expect(formatNumber(1234567.5)).toBe('1,234,567.5');
      expect(formatDuration(7000)).toBe('7.0 s');
      expect(relativeTime(new Date(Date.now() - 10_000).toISOString())).toBe('just now');
      expect(relativeTime(new Date(Date.now() - 3 * 3600_000).toISOString())).toBe('3 hours ago');
    } finally {
      setLocale('es', false);
    }
  });

  it('`tn` elige la forma de plural y escribe el número con el formato del idioma', () => {
    // Clave de ejemplo presente en los dos idiomas.
    try {
      setLocale('es', false);
      expect(tn('app.runningCount', 1)).toBe('1 en curso');
      expect(tn('app.providersAvailable', 2)).toBe('2 proveedores disponibles');
      setLocale('en', false);
      expect(tn('app.providersAvailable', 1)).toBe('1 provider available');
      expect(tn('app.providersAvailable', 1234)).toBe('1,234 providers available');
    } finally {
      setLocale('es', false);
    }
  });
});
