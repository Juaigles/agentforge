// Textos de las herramientas para la pantalla, contra el catálogo real que entrega la API.
import type { ToolInfo } from '@shared/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { messages, setLocale } from '@/i18n';
import { startApi, type TestApi } from '@/test/harness';
import { api } from './api';
import { BUILTIN_CATEGORY, toolCategory, toolDescription, toolParamDescription, toolTitle } from './tool-text';

let testApi: TestApi;
let tools: ToolInfo[];

beforeEach(async () => {
  testApi = await startApi();
  await fetch('/api/tools/custom', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'consulta_clima',
      description: 'Consulta el clima de una ciudad',
      parameters: { type: 'object', properties: { ciudad: { type: 'string', description: 'Nombre de la ciudad' } } },
      method: 'GET',
      urlTemplate: 'https://api.ejemplo.test/clima?q={{ciudad}}',
    }),
  });
  tools = await api.tools.list();
});
afterEach(async () => {
  setLocale('es', false);
  await testApi.close();
});

const builtin = () => tools.filter((tool) => tool.source === 'builtin');
const SPANISH_LETTERS = /[áéíóúüñÁÉÍÓÚÜÑ¿¡]/;

describe('textos de las herramientas integradas', () => {
  it('la interfaz conoce todas las herramientas integradas del servidor, y solo esas', () => {
    expect(
      builtin()
        .map((tool) => tool.name)
        .sort(),
    ).toEqual(Object.keys(BUILTIN_CATEGORY).sort());
    const texts = messages.es.builtinTools as Record<string, unknown>;
    expect(Object.keys(texts).sort()).toEqual(['category', ...Object.keys(BUILTIN_CATEGORY)].sort());
  });

  it('en español son, palabra por palabra, los textos que entrega el servidor (título, categoría, descripción y parámetros)', () => {
    setLocale('es', false);
    for (const tool of builtin()) {
      expect(toolTitle(tool), tool.name).toBe(tool.title);
      expect(toolCategory(tool), tool.name).toBe(tool.category);
      expect(toolDescription(tool), tool.name).toBe(tool.description);
      for (const [name, prop] of Object.entries(tool.parameters.properties)) {
        expect(prop.description, `${tool.name}.${name}`).toBeTruthy();
        expect(toolParamDescription(tool, name, prop), `${tool.name}.${name}`).toBe(prop.description);
      }
    }
  });

  it('en inglés están traducidos por nombre de herramienta, sin restos en español; lo que recibe el modelo no cambia', () => {
    setLocale('en', false);
    const calculator = tools.find((tool) => tool.name === 'calculator')!;
    expect(toolTitle(calculator)).toBe('Calculator');
    expect(toolCategory(calculator)).toBe('Utilities');
    expect(toolDescription(calculator)).toMatch(/^Evaluates a mathematical expression/);
    expect(toolParamDescription(calculator, 'expression', calculator.parameters.properties.expression)).toBe('Mathematical expression to evaluate.');
    for (const tool of builtin()) {
      const shown = [
        toolTitle(tool),
        toolCategory(tool),
        toolDescription(tool),
        ...Object.entries(tool.parameters.properties).map(([n, p]) => toolParamDescription(tool, n, p)),
      ];
      for (const text of shown) {
        expect(text, tool.name).toBeTruthy();
        expect(SPANISH_LETTERS.test(text), `${tool.name}: ${text}`).toBe(false);
      }
      expect(toolTitle(tool), tool.name).not.toBe(tool.title);
    }
    // La descripción que lee el modelo es la del servidor, en español, sea cual sea el idioma de la interfaz.
    expect(testApi.ctx.tools.get('calculator')!.description).toMatch(/^Evalúa una expresión matemática/);
    expect(calculator.description).toMatch(/^Evalúa una expresión matemática/);
  });

  it('una herramienta personalizada conserva los textos de quien la creó; solo su categoría se rotula en el idioma activo', () => {
    const custom = tools.find((tool) => tool.name === 'consulta_clima')!;
    setLocale('en', false);
    expect(toolTitle(custom)).toBe(custom.title);
    expect(toolDescription(custom)).toBe('Consulta el clima de una ciudad');
    expect(toolParamDescription(custom, 'ciudad', custom.parameters.properties.ciudad)).toBe('Nombre de la ciudad');
    expect(toolCategory(custom)).toBe('Custom');
    setLocale('es', false);
    expect(toolCategory(custom)).toBe(custom.category);
  });

  it('una herramienta integrada que esta interfaz no conoce (servidor más reciente) se muestra con los textos del servidor', () => {
    setLocale('en', false);
    const future: ToolInfo = { ...tools[0], name: 'herramienta_nueva', title: 'Título nuevo', description: 'Descripción nueva', category: 'Categoría nueva' };
    expect([toolTitle(future), toolDescription(future), toolCategory(future)]).toEqual(['Título nuevo', 'Descripción nueva', 'Categoría nueva']);
    expect(toolParamDescription(future, 'x', { description: 'Parámetro nuevo' })).toBe('Parámetro nuevo');
  });
});
