import { describe, expect, it } from 'vitest';
import { te } from '@/i18n';
import type { AgentActivity } from '../agent-activity';
import { activityGlyph, activityLabelKey, backgroundPosition, bubbleSize, framePosition, PORTRAIT_CROP, portraitGeometry, sheetSize } from './sprite';

const ACTIVITIES: AgentActivity[] = ['idle', 'thinking', 'tool', 'writing', 'waiting', 'done', 'error'];

describe('posición de un cuadro en la hoja', () => {
  it('cada dirección es una fila y cada fotograma una columna, al tamaño pedido', () => {
    expect(framePosition('down')).toEqual({ x: 0, y: 0 });
    expect(framePosition('left', 0)).toEqual({ x: 0, y: -128 });
    expect(framePosition('right', 2)).toEqual({ x: -256, y: -256 });
    expect(framePosition('up', 3)).toEqual({ x: -384, y: -384 });
    expect(framePosition('up', 1, 32)).toEqual({ x: -32, y: -96 });
  });

  it('el fotograma da la vuelta al ciclo de 4', () => {
    expect(framePosition('down', 4)).toEqual(framePosition('down', 0));
    expect(framePosition('down', 5, 64)).toEqual(framePosition('down', 1, 64));
    expect(framePosition('down', -1)).toEqual(framePosition('down', 3));
  });

  it('se escribe como background-position sin «-0px»', () => {
    expect(backgroundPosition('down')).toBe('0px 0px');
    expect(backgroundPosition('right', 1, 48)).toBe('-48px -96px');
  });

  it('la hoja completa mide 4 cuadros de lado', () => {
    expect(sheetSize()).toBe(512);
    expect(sheetSize(40)).toBe(160);
  });
});

describe('burbuja de actividad', () => {
  it('cada actividad tiene su glifo, y sin actividad no hay burbuja', () => {
    expect(ACTIVITIES.map((a) => activityGlyph(a))).toEqual(['…', '考', '具', '筆', '印', '済', '災']);
    expect(activityGlyph(undefined)).toBeNull();
    expect(activityGlyph()).toBeNull();
  });

  it('cada actividad tiene un nombre accesible traducido, distinto de los demás', () => {
    const keys = ACTIVITIES.map(activityLabelKey);
    expect(new Set(keys).size).toBe(ACTIVITIES.length);
    for (const key of keys) expect(te(key), key).toBe(true);
  });

  it('el tamaño de la burbuja crece con el cuadro pero se queda entre 12 y 28 px', () => {
    expect(bubbleSize(24)).toBe(12);
    expect(bubbleSize(64)).toBe(18);
    expect(bubbleSize(400)).toBe(28);
    expect(bubbleSize(40, 0.42)).toBe(17);
  });
});

describe('retrato', () => {
  it('el recorte cae dentro del cuadro de 128 px', () => {
    for (const crop of Object.values(PORTRAIT_CROP)) {
      expect(crop.x + crop.size).toBeLessThanOrEqual(128);
      expect(crop.y + crop.size).toBeLessThanOrEqual(128);
    }
  });

  it('escala la hoja para que el recorte llene la ventana, con un lado de cuadro entero', () => {
    // Ventana de 36 px y recorte de 64: el cuadro de 128 se dibuja a 72 px (factor 0,5625).
    expect(portraitGeometry('kitsune', 36)).toEqual({ spriteSize: 72, left: -19, top: -8 });
    expect(portraitGeometry('ojo', 64)).toEqual({ spriteSize: 128, left: -32, top: -20 });
    for (const inner of [18, 24, 36]) expect(Number.isInteger(portraitGeometry('ojo', inner).spriteSize)).toBe(true);
  });
});
