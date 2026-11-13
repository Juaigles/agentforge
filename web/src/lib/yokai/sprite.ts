// Geometría de las hojas de sprites del Modo Yōkai, para pintarlas con CSS (background-image + background-position) y
// que el pixel art siga nítido a cualquier tamaño: se escala con background-size, nunca con transform.
import type { AgentActivity } from '../agent-activity';
import { FACING_ROW, FRAME, FRAMES_PER_ROW } from './assets';
import type { Facing, YokaiSpecies } from './types';

/** Lado de la hoja completa (en píxeles de pantalla) cuando cada cuadro mide `size`. */
export function sheetSize(size: number = FRAME): number {
  return size * FRAMES_PER_ROW;
}

/**
 * Desplazamiento de fondo (negativo, en píxeles) que deja a la vista el cuadro `frame` de la fila de `facing` cuando
 * cada cuadro se dibuja con lado `size`. El fotograma da la vuelta: 4 es el 0, -1 es el 3.
 */
export function framePosition(facing: Facing, frame = 0, size: number = FRAME): { x: number; y: number } {
  const col = ((Math.trunc(frame) % FRAMES_PER_ROW) + FRAMES_PER_ROW) % FRAMES_PER_ROW;
  // `|| 0` evita el -0, que acabaría escrito como «-0px».
  return { x: -col * size || 0, y: -FACING_ROW[facing] * size || 0 };
}

/** Lo mismo que `framePosition`, ya escrito como valor de `background-position`. */
export function backgroundPosition(facing: Facing, frame = 0, size: number = FRAME): string {
  const { x, y } = framePosition(facing, frame, size);
  return `${x}px ${y}px`;
}

/** Glifo de la burbuja de pensamiento de cada actividad (kanji de la tarea, en el tono de la oficina feudal). */
const GLYPH: Record<AgentActivity, string> = {
  thinking: '考', // pensar
  tool: '具', // herramienta
  writing: '筆', // pincel de escribir
  waiting: '印', // sello: espera la aprobación
  done: '済', // terminado
  error: '災', // desgracia
  idle: '…',
};

/** Glifo de la burbuja, o `null` si no hay actividad (sin burbuja). */
export function activityGlyph(activity?: AgentActivity): string | null {
  return activity ? GLYPH[activity] : null;
}

/** Clave i18n del nombre accesible de cada actividad (para quien ponga el texto alternativo de un yōkai). */
const LABEL_KEY: Record<AgentActivity, string> = {
  idle: 'yokaiSprite.activity.idle',
  thinking: 'yokaiSprite.activity.thinking',
  tool: 'yokaiSprite.activity.tool',
  writing: 'yokaiSprite.activity.writing',
  waiting: 'yokaiSprite.activity.waiting',
  done: 'yokaiSprite.activity.done',
  error: 'yokaiSprite.activity.error',
};

export function activityLabelKey(activity: AgentActivity): string {
  return LABEL_KEY[activity];
}

/**
 * Lado de la burbuja de pensamiento para un cuadro (o retrato) de lado `size`: proporcional, pero nunca menor de
 * 12 px (el glifo dejaría de leerse) ni mayor de 28 px (taparía al personaje).
 */
export function bubbleSize(size: number, ratio = 0.28): number {
  return Math.min(28, Math.max(12, Math.round(size * ratio)));
}

/**
 * Recorte del retrato (cara y torso) dentro del cuadro 0 de la fila 'down' de cada hoja, en píxeles de la hoja
 * original (cuadro de 128). Medido con Pillow sobre la caja del canal alfa:
 * - kitsune: personaje en x 32–111, y 14–116; la cabeza con las orejas ocupa x 36–100, y 14–70.
 * - ojo: personaje en x 30–98, y 10–111; la llama arriba (y 10–35), el ojo hacia y 40–60.
 */
export const PORTRAIT_CROP: Record<YokaiSpecies, { x: number; y: number; size: number }> = {
  kitsune: { x: 34, y: 14, size: 64 },
  tengu: { x: 31, y: 7, size: 64 },
  kappa: { x: 32, y: 12, size: 64 },
  tanuki: { x: 32, y: 8, size: 64 },
  oni: { x: 37, y: 13, size: 64 },
  kasa: { x: 32, y: 6, size: 64 },
  nekomata: { x: 42, y: 15, size: 64 },
  ojo: { x: 32, y: 20, size: 64 },
};

/**
 * Cómo colocar la hoja dentro de una ventana cuadrada de lado `inner` para que se vea el recorte del retrato:
 * el lado de cuadro con que dibujar el sprite y su desplazamiento (negativo) dentro de la ventana.
 */
export function portraitGeometry(species: YokaiSpecies, inner: number): { spriteSize: number; left: number; top: number } {
  const crop = PORTRAIT_CROP[species];
  // Un lado de cuadro entero mantiene los píxeles de la hoja alineados con los de la pantalla.
  const spriteSize = Math.max(1, Math.round((FRAME * inner) / crop.size));
  const k = spriteSize / FRAME;
  return { spriteSize, left: -Math.round(crop.x * k) || 0, top: -Math.round(crop.y * k) || 0 };
}
