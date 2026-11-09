# AgentForge — Resultados de pruebas

Todos los resultados de este documento proceden de ejecuciones reales en esta máquina
(Windows 11, Node v24.19.0, Ollama 0.40.6, modelo `qwen3.5:4b-q4_K_M`).

## 1. Tests automatizados del servidor

Comando: `npm run test -w server` (Vitest).

```
 Test Files  6 passed (6)
      Tests  133 passed (133)
   Duration  3.63s
```

| Archivo | Qué verifica | Dobles de prueba |
|---|---|---|
| `shared.test.ts` | Plantillas `{{ref}}`, orden topológico, ciclos, ancestros, validación de workflows | Ninguno |
| `tools.test.ts` | Calculadora (parser propio), validación de argumentos, sandbox de archivos (path traversal), bloqueo SSRF, `run_javascript`, herramientas HTTP personalizadas | Servidor HTTP local real |
| `llm.test.ts` | Adaptadores Ollama y OpenAI: cuerpo enviado, streaming troceado, tool-calls, clasificación de errores, cancelación | Servidor HTTP local que habla el protocolo de cable real |
| `engine.test.ts` | Motor completo: secuencia, paralelismo, uniones, condiciones, reintentos, políticas de error, timeouts, límites, cancelación, delegación, memoria compartida, eventos, instantáneas, reintento desde el fallo | Solo el proveedor LLM (guionizado en la frontera `LlmFactory`) |
| `api.test.ts` | API HTTP, SSE (historial + directo + `Last-Event-ID`), cifrado de claves, **persistencia tras reinicio** sobre SQLite en disco, ejecuciones interrumpidas, seed | Solo el proveedor LLM |
| `ollama.integration.test.ts` | **Modelo real**: chat nativo, adaptador OpenAI vía `/v1`, agente con herramienta real por ambos adaptadores, workflow paralelo de 3 agentes | **Ninguno** (se omite si no hay Ollama) |

Los tests encontraron defectos reales que se corrigieron (ver `PROGRESS.md`, puntos 4-7).

## 2. Verificación manual con modelo real (API)

Servidor arrancado con `npm run start -w server`; ejecuciones lanzadas con `scripts/smoke.mjs`.

### 2.1 Agente con herramienta

`node scripts/smoke.mjs agent "¿Cuánto es (1284.50 * 1.21) / 3? Usa la calculadora…" Analista`

```
[  4] llm.message    agent tools=calculator tokens=519/43
[  5] tool.call      agent calculator {"expression":"(1284.50 * 1.21) / 3"}
[  6] tool.result    agent ok { "expression": "(1284.50 * 1.21) / 3", "result": 518.0816666666666 }
[  8] llm.message    agent tools=- tokens=625/33
=== COMPLETED en 14.1s · uso {"promptTokens":1144,"completionTokens":76,"llmCalls":2,"toolCalls":1}
El resultado de (1284.50 * 1.21) / 3 es aproximadamente 518.08.
```

### 2.2 Workflow multiagente de ejemplo

`node scripts/smoke.mjs workflow "investigación" "Ventajas e inconvenientes del teletrabajo para una pyme de software"`

- `investigar` y `analizar` se ejecutaron en paralelo (eventos intercalados).
- `redactar` recibió ambas salidas; `revisar` respondió APROBADO; la condición saltó la rama de corrección
  (`corregir` e `informe_corregido` → `skipped`).
- Resultado: `COMPLETED en 22.3s`, 11 llamadas LLM, informe en Markdown coherente.
- Esta ejecución destapó los problemas 2 y 3 de `PROGRESS.md` (ya corregidos).

## 3. Pendiente de verificar

- Interfaz web (aún no construida).
- Reinicio de la aplicación completa con datos reales desde el navegador (la persistencia a nivel de
  servidor sí está cubierta por `api.test.ts`).
