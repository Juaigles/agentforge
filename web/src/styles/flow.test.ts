// El lienzo debe distinguirse del fondo (WCAG 1.4.11, 3:1): se calcula con los colores reales de los dos temas.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const main = readFileSync(new URL('./main.css', import.meta.url), 'utf8');
const flow = readFileSync(new URL('./flow.css', import.meta.url), 'utf8');

/** Valor de un token dentro del bloque de un tema (`:root {` o `:root[data-theme='dark'] {`). */
function token(block: string, name: string): string {
  const start = main.indexOf(block);
  const body = main.slice(start, main.indexOf('}', start));
  const at = body.indexOf(`${name}:`);
  return body.slice(at + name.length + 1, body.indexOf(';', at)).trim();
}
const luminance = (hex: string): number => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
/** Token del que toma el color una propiedad de una regla de flow.css (`var(--token)`). */
function usedToken(selector: string, property: string): string {
  const start = flow.indexOf(`${selector} {`);
  const rule = flow.slice(start, flow.indexOf('}', start));
  const at = rule.indexOf(`${property}: var(`);
  return rule.slice(at + property.length + 6, rule.indexOf(')', at));
}

describe('contraste de las conexiones del lienzo', () => {
  const parts: Array<[string, string]> = [
    ['.vue-flow__edge-path', 'stroke'],
    ['.vue-flow__arrowhead polyline', 'fill'],
    ['.vue-flow__handle', 'background'],
  ];
  for (const [theme, block] of [
    ['claro', ':root {'],
    ['oscuro', ":root[data-theme='dark'] {"],
  ]) {
    it(`conexiones, puntas de flecha y puntos de conexión llegan a 3:1 sobre el fondo (tema ${theme})`, () => {
      for (const [selector, property] of parts) {
        const name = usedToken(selector, property);
        expect(contrast(token(block, name), token(block, '--bg')), `${selector} (${name})`).toBeGreaterThanOrEqual(3);
      }
    });
  }
});
