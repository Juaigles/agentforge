# AgentForge — Resultados de pruebas

Todos los resultados proceden de ejecuciones reales en esta máquina
(Windows 11, Node v24.19.0, Ollama 0.40.6, modelo `qwen3.5:4b-q4_K_M`), el 2026-11-09.

## 1. Tests automatizados

Comando: `npm test` (Vitest 5).

```
servidor   Test Files  7 passed (7)     Tests  138 passed (138)
frontend   Test Files  1 passed (1)     Tests    7 passed (7)
```

`npm run typecheck` (tsc + vue-tsc): sin errores. `npm audit`: 0 vulnerabilidades.

| Archivo | Qué verifica | Dobles de prueba |
|---|---|---|
| `server/test/shared.test.ts` | Plantillas `{{ref}}`, orden topológico, ciclos, validación de workflows | Ninguno |
| `server/test/tools.test.ts` | Calculadora, validación de argumentos, confinamiento de archivos, bloqueo SSRF, `run_javascript`, herramientas HTTP personalizadas | Servidor HTTP local real |
| `server/test/llm.test.ts` | Adaptadores Ollama y OpenAI: cuerpo enviado, streaming troceado, tool-calls, errores, cancelación | Servidor HTTP local que habla el protocolo real |
| `server/test/engine.test.ts` | Secuencia, paralelismo, uniones, condiciones, reintentos, políticas de error, timeouts, límites, cancelación, delegación, memoria compartida, eventos, instantáneas, reintento desde el fallo | Solo el proveedor LLM (frontera `LlmFactory`) |
| `server/test/api.test.ts` | API HTTP, SSE (historial + directo + `Last-Event-ID`), cifrado de claves, **persistencia tras reinicio** en disco, ejecuciones interrumpidas, datos de ejemplo | Solo el proveedor LLM |
| `server/test/static.test.ts` | Servido del frontend: fallback de la SPA, caché, 404 de assets, archivos nuevos sin reiniciar | Ninguno |
| `server/test/ollama.integration.test.ts` | **Modelo real**: chat nativo, adaptador OpenAI vía `/v1`, agente con herramienta por ambos adaptadores, workflow paralelo de 3 agentes | **Ninguno** (se omite si no hay Ollama) |
| `web/src/lib/run-state.test.ts` | Reductor de eventos del monitor en vivo, emparejado de llamadas a herramientas, formato | Ninguno |

Defectos reales destapados por los tests y corregidos: puntos 4, 5, 6, 7 y 9 de `PROGRESS.md`.

## 2. Verificación con modelo real por API (`scripts/smoke.mjs`)

| Prueba | Resultado |
|---|---|
| Agente + calculadora: `(1284.50 * 1.21) / 3` | COMPLETED, 2 llamadas LLM, 1 herramienta → «518.08» (correcto) |
| Workflow «Informe de investigación multiagente» | COMPLETED en ~20 s; `investigar` y `analizar` en paralelo, `redactar` recibe ambos, `revisar` → APROBADO, rama de corrección omitida |
| Workflow «Cálculo con herramientas y archivo» | COMPLETED en 3,0 s; 2 llamadas reales a `calculator` (1554,245 y 518,08…), nodo `file_write` crea `data/workspace/resultados/calculo.md` (303 bytes, contenido comprobado) |

## 3. Verificación en el navegador (interfaz real, modelo real)

Servidor arrancado con `npm start`; interfaz en `http://127.0.0.1:4310`.

### 3.1 «Puedo crear un agente y ejecutar una tarea con un modelo real» — VERIFICADO

- Agentes → Nuevo agente: nombre «Contable», rol, instrucciones, herramienta Calculadora → Guardar.
  La URL pasó a `/agents/agt_…` y apareció el aviso «Contable guardado».
- Banco de pruebas: «Una factura tiene base imponible de 2.450,80 euros e IVA del 21 %. ¿Cuál es el total?»
  → **«El total de la factura es de 2.965,47 euros.»** (2.450,80 × 1,21 = 2.965,468), 1,2 s, 1.052 tokens,
  con la llamada a `calculator` visible en «Actividad y herramientas».

### 3.2 «Puedo crear un workflow con varios agentes y observar su ejecución» — VERIFICADO

- Workflows → Nuevo: se añadieron los agentes Contable y Redactor desde la paleta, se movió un nodo
  arrastrándolo y se crearon con el ratón las conexiones Entrada → Contable → Redactor → Salida.
  La validación pasó de «1 error» a «Válido» y `{{contable}}` apareció como referencia disponible.
- Ejecutar con «Base imponible de 980 euros con IVA del 21 %»: se guardó, navegó al monitor y terminó
  «Completado»: 3 llamadas LLM, 1 herramienta, resultado con el importe **1.185,80 €** (correcto).
- En el workflow de ejemplo se observó el monitor en vivo: barra de progreso, pasos «En curso», texto del
  modelo apareciendo en streaming y, al terminar, grafo con nodos completados y rama no tomada atenuada.

### 3.3 «Puedo reiniciar la aplicación sin perder los datos» — VERIFICADO

El proceso del servidor se mató tres veces (`taskkill /F`) y se volvió a arrancar. Tras el último reinicio
la API devolvía: 6 agentes (incluido «Contable», creado en la interfaz), 3 workflows (incluido «Factura
explicada») y las 7 ejecuciones con sus pasos, resultados y eventos; el monitor mostraba el informe completo
de una ejecución anterior al reinicio.

### 3.4 Otras comprobaciones en la interfaz

| Comprobación | Resultado |
|---|---|
| Cancelar una ejecución en curso | Con «Redactar informe» en curso → Cancelar → estado «Cancelado» en < 2 s; pasos pendientes cancelados; aviso «Ejecución cancelada por el usuario.» |
| Reintentar desde el fallo | Nueva ejecución con `retryOf`; reutilizó `tema`, `investigar`, `analizar` (eventos `step.reused`) y solo llamó al modelo para `redactar` y `revisar` (2 llamadas) → Completado |
| Banco de pruebas de herramientas | `calculator` con `round(2450.80 * 1.21, 2)` → `2965.47` en 1 ms |
| Constructor: inspector | Etiqueta, agente, plantilla, referencias insertables, reintentos y timeout por nodo |
| Móvil (375 × 812) y tema claro | 9 rutas sin desbordamiento horizontal (medido con `scrollWidth`) |
| Modo desarrollo | Vite en :5173 con proxy a la API: `/api/health` y `/api/agents` responden a través del proxy |
| Producción | `index.html` con `no-cache`; assets con `immutable`; rutas de la SPA devuelven la aplicación |
| Consola del navegador | Sin errores tras las correcciones |

## 4. No verificado

- Proveedores de pago reales (OpenAI, OpenRouter, Groq…): no se usan servicios de pago. El adaptador
  OpenAI-compatible sí está verificado contra el endpoint `/v1` de Ollama.
- Tests end-to-end automatizados del navegador: las comprobaciones de la sección 3 se hicieron conduciendo
  el navegador durante la sesión, no quedan como suite repetible.
- Navegadores distintos de Chromium.
- Cargas altas (cientos de ejecuciones simultáneas o historiales de millones de eventos).
