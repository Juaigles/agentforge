// Rutas y medidas de los assets del Modo Yōkai (viven en web/public/yokai y los genera el flujo de assets-work).
import type { Facing, YokaiSpecies } from './types';

const base = (name: string): string => `${import.meta.env.BASE_URL}yokai/${name}`;

export const YOKAI_ASSETS = {
  /** Planta de la oficina vista desde arriba (cuadrada). */
  planta: base('planta.png'),
  /** Aldea embrujada nocturna (apaisada, 3:2), pensada de fondo de ambiente. */
  aldea: base('aldea.png'),
  /** Hojas de sprites: 4 columnas (fotogramas del ciclo) × 4 filas (una por dirección). */
  sprites: { kitsune: base('kitsune.png'), ojo: base('ojo.png') } satisfies Record<YokaiSpecies, string>,
} as const;

/** Lado de la imagen de la planta, en píxeles. */
export const PLAN_SIZE = 1254;
/** Lado de cada cuadro de una hoja de sprites; la hoja mide 4 × FRAME en cada eje. */
export const FRAME = 128;
export const FRAMES_PER_ROW = 4;
/** Fila de la hoja de sprites de cada dirección. */
export const FACING_ROW: Record<Facing, number> = { down: 0, left: 1, right: 2, up: 3 };
/**
 * Escala a la que se dibuja un sprite sobre la planta (1 = un cuadro de 128 px ocupa 128 px de la imagen). Con 0,85 un
 * yōkai mide unos 85 px de alto sobre la planta, la altura de una silla de oficina.
 */
export const SPRITE_SCALE_ON_PLAN = 0.85;
