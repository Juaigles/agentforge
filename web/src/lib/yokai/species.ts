// Qué especie de yōkai es cada agente. Es determinista: el mismo identificador da siempre la misma especie, así que un
// agente es el mismo yōkai en la lista, en el avatar y en la planta, sin guardar nada.
import type { YokaiSpecies } from './types';

export const YOKAI_SPECIES: readonly YokaiSpecies[] = ['kitsune', 'ojo'];

/** Especie estable para una clave (normalmente el id del agente). */
export function speciesFor(key: string): YokaiSpecies {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return YOKAI_SPECIES[hash % YOKAI_SPECIES.length];
}
