# Cómo contribuir

## Preparar el entorno

```bash
npm install                 # servidor, frontend y herramientas (workspaces)
npx playwright install      # Chromium, Firefox y WebKit para la suite end-to-end
npm run dev                 # API con recarga + Vite en http://localhost:5173
```

Requisitos: Node.js 22.13 o posterior. Ollama solo hace falta para usar la aplicación y para los tests de
integración con un modelo real (se omiten solos si no está).

## Antes de dar un cambio por bueno

```bash
npm run check               # lint + formato + tipos + tests de servidor y frontend
npm run test:e2e            # suite end-to-end en Chromium (≈5 min)
npm run test:e2e:all        # la misma en Chromium, Firefox y WebKit (≈15 min)
npm run test:coverage       # cobertura; falla si baja de los umbrales
```

`npm run format` aplica Prettier. La integración continua (`.github/workflows/ci.yml`) ejecuta lo mismo.

## Reglas de las pruebas

1. **Se verifica comportamiento real.** No se simulan módulos del proyecto ni se inventan respuestas.
2. **El único doble admitido es el proveedor LLM**, en la frontera `LlmFactory` (`ScriptedLlm` en
   `server/test/helpers.ts`). Lo que hay al otro lado de cualquier otra frontera externa se sustituye por un
   **servidor local que habla el protocolo real** (HTTP, SSE, DNS, MCP).
3. Los componentes del frontend se montan contra **la API real** arrancada dentro del test
   (`web/src/test/harness.ts`).
4. Un test comprueba el **efecto**: lo que quedó guardado, lo que respondió la API, lo que se ve. No basta con que
   «se llamó a tal función».
5. Si un test destapa un defecto, se corrige el defecto, no el test.
6. No se declara que algo funciona sin haberlo ejecutado. Lo que no se ha podido verificar se anota en
   `TEST_RESULTS.md`, sección «No verificado».

## Convenciones del código

- TypeScript estricto en todo el repositorio. Comentarios, mensajes y nombres de tests **en español**;
  identificadores en inglés.
- **Textos de la interfaz**: nunca escritos en las plantillas. Van en `web/src/i18n/es/<ámbito>.ts` y
  `en/<ámbito>.ts` con las mismas claves, y se usan con `t('ámbito.clave')` o `tn('ámbito.clave', n)` importados
  de `@/i18n`. Las convenciones completas (plurales, caracteres especiales, frases con componentes) están
  resumidas en la cabecera de `web/src/i18n/index.ts` y las comprueba `web/src/i18n/i18n.test.ts`.
- **Términos técnicos**: la primera aparición en cada pantalla va con `<Term id="…">`, y la definición en
  `web/src/lib/glossary.ts` (español e inglés). Un test exige que cada término se use y que no quede dentro de un
  botón, un enlace o un título.
- **Base de datos**: los cambios de esquema son migraciones nuevas al final de la lista; nunca se edita una
  existente.
- **API**: una ruta nueva lleva su esquema de validación, su método en `web/src/lib/api.ts` y su entrada en la
  especificación OpenAPI (un test falla si falta).
- **Accesibilidad**: todo control tiene nombre accesible, se puede usar con teclado y su foco se ve. Los cambios
  de estado que no mueven el foco se anuncian con `announce()` (`web/src/lib/a11y.ts`).

## Commits

Un commit por unidad de trabajo terminada y verificada, en español, con un resumen en la primera línea y, debajo,
qué cambia y por qué. Antes de confirmar: las baterías en verde y `PROGRESS.md` / `TEST_RESULTS.md` al día con
cifras reales.

## Dónde está cada cosa

[docs/arquitectura.md](docs/arquitectura.md) explica las piezas y dónde tocar para cada tipo de cambio.
