// Interpretación de listas en texto libre, para el nodo «para cada».
// Los modelos devuelven listas de muchas formas: JSON, viñetas, numeradas o una por línea.

/** Quita una valla de código Markdown (```json … ```) si envuelve todo el texto. */
function stripFence(text: string): string {
  const m = /^```[a-zA-Z0-9]*\s*\n([\s\S]*?)\n?```$/.exec(text.trim());
  return m ? m[1] : text;
}

/**
 * Convierte un texto en una lista de elementos:
 *  - si es un array JSON, sus elementos (los que no son texto se serializan como JSON);
 *  - si no, una línea por elemento, sin viñetas ("- ", "* ", "• ") ni numeración ("1. ", "2) ").
 * Los elementos vacíos se descartan.
 */
export function parseList(text: string): string[] {
  const body = stripFence(text ?? '').trim();
  if (!body) return [];
  if (body.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(body);
      if (Array.isArray(parsed)) {
        return parsed
          .map((item) => (typeof item === 'string' ? item.trim() : item === null || item === undefined ? '' : JSON.stringify(item)))
          .filter((item) => item !== '');
      }
    } catch {
      /* no es JSON válido: se trata como texto por líneas */
    }
  }
  return body
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^(?:[-*•–]\s+|\d+[.)]\s+)/, '').trim())
    .filter((line) => line !== '');
}
