// La piel del Modo Yōkai redefine los tokens de diseño: aquí se comprueba, con los colores reales de yokai.css, que el
// texto llega a 4,5:1 y los controles a 3:1 (WCAG 1.4.3 y 1.4.11) de día y de noche, y que los bloques de la noche
// (tema oscuro elegido y tema del sistema) están sincronizados.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./yokai.css', import.meta.url), 'utf8');

const DAY = ":root[data-skin='yokai'] {";
const NIGHT = ":root[data-skin='yokai'][data-theme='dark'] {";
const NIGHT_SYSTEM = ":root[data-skin='yokai']:not([data-theme='light']) {";

/** Tokens declarados en un bloque (`--nombre: valor;`). */
function tokens(block: string): Map<string, string> {
  const start = css.indexOf(block);
  expect(start, `falta el bloque ${block}`).toBeGreaterThanOrEqual(0);
  const body = css.slice(start + block.length, css.indexOf('}', start));
  return new Map([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}
const luminance = (hex: string): number => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const isHex = (value: string): boolean => /^#[0-9a-f]{6}$/i.test(value);

/** Texto sobre fondo: 4,5:1. */
const TEXT: Array<[string, string]> = [
  ...['--text', '--text-2', '--text-3'].flatMap((fg) => ['--bg', '--surface', '--surface-2'].map((bg): [string, string] => [fg, bg])),
  ['--text-2', '--neutral-soft'],
  ['--accent', '--bg'],
  ['--accent', '--surface'],
  ['--accent', '--accent-soft'],
  ['--accent-text', '--accent'],
  ['--accent-text', '--accent-hover'],
  ...['--success', '--danger', '--warning', '--info'].flatMap((tone): Array<[string, string]> => [
    [tone, `${tone}-soft`],
    [tone, '--surface'],
  ]),
  // Barra lateral de madera.
  ['--yk-panel-text', '--yk-panel'],
  ['--yk-panel-text', '--yk-panel-2'],
  ['--yk-panel-text-2', '--yk-panel'],
  ['--yk-panel-text-2', '--yk-panel-2'],
  ['--yk-panel-active-text', '--yk-panel-active'],
  ['--yk-on-gold', '--yk-gold'],
];
/** Controles, bordes que delimitan algo y el foco: 3:1. */
const CONTROLS: Array<[string, string]> = [
  ['--control-border', '--surface'],
  ['--control-border', '--bg'],
  ['--accent', '--surface'],
  ['--yk-edge', '--surface'],
  ['--yk-edge', '--bg'],
  ['--yk-focus', '--bg'],
  ['--yk-focus', '--surface'],
  ['--yk-panel-control', '--yk-panel'],
  ['--yk-panel-control', '--yk-panel-2'],
  ['--yk-gold', '--yk-panel'],
  ['--yk-gold', '--yk-panel-2'],
];

describe('tokens del Modo Yōkai', () => {
  it('la noche elegida y la noche del sistema declaran los mismos tokens con los mismos valores', () => {
    expect(Object.fromEntries(tokens(NIGHT_SYSTEM))).toEqual(Object.fromEntries(tokens(NIGHT)));
  });

  it('la noche redefine todos los colores del día', () => {
    const night = tokens(NIGHT);
    const colors = [...tokens(DAY)].filter(([, value]) => isHex(value)).map(([name]) => name);
    expect(colors.length).toBeGreaterThan(30);
    expect(colors.filter((name) => !night.has(name))).toEqual([]);
  });

  it('esquinas rectas y sombras duras, sin desenfoque', () => {
    const day = tokens(DAY);
    for (const radius of ['--radius-sm', '--radius', '--radius-lg']) expect(parseFloat(day.get(radius)!)).toBeLessThanOrEqual(2);
    for (const block of [DAY, NIGHT])
      for (const shadow of ['--shadow-sm', '--shadow-md', '--shadow-lg']) expect(tokens(block).get(shadow), `${block} ${shadow}`).toMatch(/^\d+px \d+px 0 #/);
  });

  for (const [mode, block] of [
    ['día', DAY],
    ['noche', NIGHT],
  ]) {
    const palette = tokens(block);
    const color = (name: string): string => {
      const value = palette.get(name);
      expect(value && isHex(value), `${mode}: ${name} = ${value}`).toBe(true);
      return value!;
    };

    it(`el texto llega a 4,5:1 sobre su fondo (${mode})`, () => {
      const failing = TEXT.filter(([fg, bg]) => contrast(color(fg), color(bg)) < 4.5).map(
        ([fg, bg]) => `${fg} sobre ${bg}: ${contrast(color(fg), color(bg)).toFixed(2)}`,
      );
      expect(failing).toEqual([]);
    });

    it(`controles, bordes de botón y foco llegan a 3:1 (${mode})`, () => {
      const failing = CONTROLS.filter(([fg, bg]) => contrast(color(fg), color(bg)) < 3).map(
        ([fg, bg]) => `${fg} sobre ${bg}: ${contrast(color(fg), color(bg)).toFixed(2)}`,
      );
      expect(failing).toEqual([]);
    });
  }
});

describe('alcance de la hoja', () => {
  it('toda regla cuelga de <html data-skin="yokai">: con la piel por defecto no cambia nada', () => {
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const selectors = [...withoutComments.matchAll(/([^{}]+)\{/g)].map((m) => m[1].trim()).filter((s) => !s.startsWith('@media'));
    const loose = selectors.flatMap((s) => s.split(',').map((part) => part.trim())).filter((s) => !s.startsWith(":root[data-skin='yokai']"));
    expect(selectors.length).toBeGreaterThan(20);
    expect(loose).toEqual([]);
  });

  it('los sprites y la planta se pintan pixelados (con crisp-edges de reserva)', () => {
    const rule = css.slice(css.indexOf("img[src*='/yokai/']"));
    const body = rule.slice(rule.indexOf('{'), rule.indexOf('}'));
    expect(body.indexOf('crisp-edges')).toBeGreaterThan(-1);
    expect(body.indexOf('pixelated')).toBeGreaterThan(body.indexOf('crisp-edges'));
  });
});
