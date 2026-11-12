import { describe, expect, it } from 'vitest';
import { speciesFor, YOKAI_SPECIES } from './species';

const IDS = Array.from({ length: 40 }, (_, i) => `agt_${i}`);

describe('especie de cada agente', () => {
  it('es determinista: la misma clave da siempre la misma especie', () => {
    for (const id of IDS) expect(speciesFor(id)).toBe(speciesFor(`${id}`));
    expect(IDS.map(speciesFor)).toEqual(IDS.map(speciesFor));
  });

  it('siempre es una especie conocida, también con la clave vacía', () => {
    for (const id of [...IDS, '', 'Investigador', 'ñandú 漢字']) expect(YOKAI_SPECIES).toContain(speciesFor(id));
  });

  it('en un conjunto de agentes aparecen todas las especies', () => {
    expect(new Set(IDS.map(speciesFor))).toEqual(new Set(YOKAI_SPECIES));
  });
});
