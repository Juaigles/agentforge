// Motor de plantillas mínimo: sustituye {{referencia}} por valores del contexto de ejecución.
// Referencias admitidas: input, upstream, date, <idNodo> y <idNodo>.output

const REF_RE = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

export const BUILTIN_REFS = new Set(['input', 'upstream', 'date']);
/** Referencias que solo existen dentro de la tarea de un nodo «para cada». */
export const FOREACH_REFS = new Set(['item', 'index', 'total']);

/** Sufijos admitidos tras el id de un nodo: su salida y, en una aprobación, el comentario de quien decidió. */
export const NODE_REF_SUFFIXES = ['.output', '.comment'];
/** Ids que un nodo no puede tener: chocarían con las referencias integradas. */
export const RESERVED_NODE_IDS = new Set([...BUILTIN_REFS, ...FOREACH_REFS, 'constructor', 'prototype', '__proto__']);

/** Devuelve las referencias (sin duplicados) usadas en una plantilla. */
export function extractRefs(template: string): string[] {
  const refs = new Set<string>();
  for (const m of template.matchAll(REF_RE)) refs.add(m[1]);
  return [...refs];
}

/** Id de nodo al que apunta una referencia, o null si es una referencia integrada. */
export function refNodeId(ref: string): string | null {
  if (BUILTIN_REFS.has(ref) || FOREACH_REFS.has(ref)) return null;
  for (const suffix of NODE_REF_SUFFIXES) if (ref.endsWith(suffix)) return ref.slice(0, -suffix.length);
  return ref;
}

/** Sustituye cada referencia usando `resolve`. Las desconocidas se sustituyen por cadena vacía. */
export function renderTemplate(template: string, resolve: (ref: string) => string | undefined): string {
  return template.replace(REF_RE, (_m, ref: string) => resolve(ref) ?? '');
}
