// Motor de plantillas mínimo: sustituye {{referencia}} por valores del contexto de ejecución.
// Referencias admitidas: input, upstream, date, <idNodo> y <idNodo>.output

const REF_RE = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

export const BUILTIN_REFS = new Set(['input', 'upstream', 'date']);

/** Devuelve las referencias (sin duplicados) usadas en una plantilla. */
export function extractRefs(template: string): string[] {
  const refs = new Set<string>();
  for (const m of template.matchAll(REF_RE)) refs.add(m[1]);
  return [...refs];
}

/** Id de nodo al que apunta una referencia, o null si es una referencia integrada. */
export function refNodeId(ref: string): string | null {
  if (BUILTIN_REFS.has(ref)) return null;
  return ref.endsWith('.output') ? ref.slice(0, -'.output'.length) : ref;
}

/** Sustituye cada referencia usando `resolve`. Las desconocidas se sustituyen por cadena vacía. */
export function renderTemplate(template: string, resolve: (ref: string) => string | undefined): string {
  return template.replace(REF_RE, (_m, ref: string) => resolve(ref) ?? '');
}
