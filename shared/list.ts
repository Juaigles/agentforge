// Interpretación de listas en texto libre, para el nodo «para cada».
// Los modelos devuelven listas de muchas formas: JSON (a menudo con una frase delante o dentro de una valla de
// código), viñetas, numeradas o una por línea.

function itemsFromArray(parsed: unknown[]): string[] {
  return parsed
    .map((item) => (typeof item === 'string' ? item.trim() : item === null || item === undefined ? '' : JSON.stringify(item)))
    .filter((item) => item !== '');
}

/** Lista contenida en un valor JSON: el propio array, o el único array de un objeto como {"items": […]}. */
function listFromJson(value: unknown): string[] | null {
  if (Array.isArray(value)) return itemsFromArray(value);
  if (value && typeof value === 'object') {
    const arrays = Object.values(value).filter(Array.isArray);
    if (arrays.length === 1) return itemsFromArray(arrays[0]);
  }
  return null;
}

/** Primer bloque JSON equilibrado ([...] o {...}) dentro de un texto, respetando las cadenas. */
function firstJsonBlock(text: string): string | null {
  const start = text.search(/[[{]/);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function tryJson(text: string): string[] | null {
  try {
    return listFromJson(JSON.parse(text));
  } catch {
    // Los modelos dejan a veces una coma tras el último elemento.
    try {
      return listFromJson(JSON.parse(text.replace(/,(\s*[\]}])/g, '$1')));
    } catch {
      return null;
    }
  }
}

/**
 * Convierte un texto en una lista de elementos:
 *  - si contiene un array JSON —solo, dentro de una valla de código o precedido de una frase («Aquí tienes la
 *    lista:»)—, sus elementos (los que no son texto se serializan como JSON); también {"clave": […]};
 *  - si no, una línea por elemento, sin viñetas ("- ", "* ", "• ") ni numeración de lista ("1. ", "2) ").
 * Los elementos vacíos se descartan.
 */
export function parseList(text: string): string[] {
  const body = (text ?? '').trim();
  if (!body) return [];
  // 1) Contenido de una valla de código, si la hay; 2) el texto entero; 3) el primer bloque JSON que contenga.
  const fenced = /```[a-zA-Z0-9]*[ \t]*\r?\n([\s\S]*?)\r?\n?```/.exec(body)?.[1]?.trim();
  for (const candidate of [fenced, body]) {
    if (!candidate || !/^[[{]/.test(candidate)) continue;
    const list = tryJson(candidate);
    if (list) return list;
  }
  const block = firstJsonBlock(fenced ?? body);
  if (block && block.startsWith('[')) {
    const list = tryJson(block);
    if (list) return list;
  }
  return (fenced ?? body)
    .split(/\r?\n/)
    // Se quitan viñetas y la numeración de lista (uno o dos dígitos): «2024. Informe anual» no es un elemento numerado.
    .map((line) => line.trim().replace(/^(?:[-*•–]\s+|\d{1,2}[.)]\s+)/, '').trim())
    .filter((line) => line !== '' && !/^```/.test(line));
}
