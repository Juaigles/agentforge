# AgentForge — Resultados de pruebas

Todos los resultados proceden de ejecuciones reales en esta máquina
(Windows 11, Node v24.19.0, Ollama 0.40.6, modelo `qwen3.5:4b-q4_K_M`), entre el 2026-11-09 y el 2026-11-10.

## 1. Tests automatizados

Comandos: `npm test` (Vitest 5), `npm run test:e2e` (Playwright 1.65, Chromium), `npm run typecheck`, `npm audit`.
Resultados del 2026-11-10 tras el punto 4.4:

```
servidor     Test Files  8 passed (8)     Tests  172 passed (172)
frontend     Test Files  6 passed (6)     Tests   36 passed (36)
end-to-end   37 passed (1.2m)   (tras 4.1, con 21 tests: repetida dos veces seguidas, 42 passed, sin intermitencias)
typecheck    sin errores (tsc servidor, vue-tsc frontend, tsc e2e)
npm audit    found 0 vulnerabilities
```

| Archivo | Qué verifica | Dobles de prueba |
|---|---|---|
| `server/test/shared.test.ts` | Plantillas `{{ref}}`, orden topológico, ciclos, validación de workflows | Ninguno |
| `server/test/tools.test.ts` | Calculadora, validación de argumentos, confinamiento de archivos, bloqueo SSRF, `run_javascript`, herramientas HTTP personalizadas | Servidor HTTP local real |
| `server/test/llm.test.ts` | Adaptadores Ollama y OpenAI: cuerpo enviado, streaming troceado, tool-calls, errores, cancelación | Servidor HTTP local que habla el protocolo real |
| `server/test/engine.test.ts` | Secuencia, paralelismo, uniones, condiciones, reintentos, políticas de error, timeouts, límites, cancelación, delegación, memoria compartida, eventos, instantáneas, reintento desde el fallo | Solo el proveedor LLM (frontera `LlmFactory`) |
| `server/test/api.test.ts` | API HTTP, SSE (historial + directo + `Last-Event-ID`), cifrado de claves, **persistencia tras reinicio** en disco, ejecuciones interrumpidas, datos de ejemplo | Solo el proveedor LLM |
| `server/test/hardening.test.ts` | **SSRF**: direcciones privadas en todas sus notaciones, rechazo sin conectar, **rebinding** (dos servidores reales en 127.0.0.1/127.0.0.2 y un DNS que cambia), redirecciones, compresión, límites y cancelación. **Sandbox**: sin `require`/`process`/`eval`, bucles y memoria acotados, promesas, y segunda capa (el proceso no puede leer, escribir, lanzar programas ni crear workers). **Retención**: por antigüedad y por número, con pasos y eventos | La resolución DNS se inyecta como función (seam); los sockets y procesos son reales |
| `server/test/static.test.ts` | Servido del frontend: fallback de la SPA, caché, 404 de assets, archivos nuevos sin reiniciar | Ninguno |
| `server/test/ollama.integration.test.ts` | **Modelo real**: chat nativo, adaptador OpenAI vía `/v1`, agente con herramienta por ambos adaptadores, workflow paralelo de 3 agentes | **Ninguno** (se omite si no hay Ollama) |
| `web/src/lib/run-state.test.ts` | Reductor de eventos del monitor en vivo, emparejado de llamadas a herramientas, formato | Ninguno |
| `web/src/lib/glossary.test.ts` | Coherencia del glosario: ids existentes, entradas usadas, términos fuera de botones/enlaces/código/títulos, definiciones aptas para tooltip | Ninguno (analiza las plantillas reales) |
| `web/src/components/Term.test.ts` | Tooltip del glosario: ratón, foco, Esc, clic fuera, scroll, dos toques en táctil, `aria-describedby` | `matchMedia` (jsdom no lo implementa) |
| `web/src/components/RunActivity.test.ts` | Registro de actividad: marcadores, mensajes, herramientas (OK/error/en curso), despliegue, filtro por nodo, sangría de delegados | Ninguno |
| `web/src/components/FlowNode.test.ts` | Nodo del lienzo: conexiones por tipo, subtítulos, estados, errores, datos históricos del agente | El punto de conexión de Vue Flow (necesita un lienzo real) |
| `web/src/views/AgentEditorView.test.ts` | Formulario de agentes: valores por defecto, validación, alta, edición, errores del servidor, herramientas huérfanas | Solo el proveedor LLM: usa la **API real** en memoria |
| `e2e/*.spec.ts` (37 tests) | Interfaz real en Chromium contra el servidor real; ver `e2e/README.md` | Solo el modelo: servidor HTTP local que habla el protocolo de Ollama/OpenAI |

Defectos reales destapados por los tests y corregidos: puntos 4, 5, 6, 7 y 9 de `PROGRESS.md`, y los
puntos 14 a 20 (hito 4.1), todos encontrados por la suite e2e o por los tests de componentes.

### 1.1 Qué comprueba la suite end-to-end

| Requisito | Test | Evidencia que exige |
|---|---|---|
| Crear agente y ejecutarlo en el banco de pruebas | `agents.spec.ts` | Alta por formulario; el modelo pide `calculator` y la respuesta muestra `"result": 2965.468`; el proveedor recibió las instrucciones y la herramienta |
| Construir un workflow desde cero en el lienzo | `workflow-builder.spec.ts` | Nodos desde la paleta (clic y arrastre), conexiones arrastrando entre puntos, ciclo rechazado, validación «Válido», definición guardada idéntica a la construida |
| Ejecutarlo y ver el monitor en vivo | `workflow-builder.spec.ts` | Estado «En curso», barra de progreso, texto en streaming, nodo `st-running` y luego los 4 `st-completed`; el segundo agente recibe la salida del primero |
| Cancelar | `runs.spec.ts`, `agents.spec.ts` | «Cancelado» desde el monitor, la lista y el banco de pruebas; el paso siguiente nunca llega al modelo |
| Reintentar desde el fallo | `runs.spec.ts` | La nueva ejecución hace **una** sola llamada al modelo (el paso fallido) y marca el otro como reutilizado |
| Persistencia tras reiniciar | `persistence.spec.ts` | Se **mata** el proceso y se relanza: agente, workflow, ejecución, eventos y entrada intactos; la ejecución a medias queda «Fallido» por reinicio |
| Historial con filtros | `runs.spec.ts` | Estado, tipo, búsqueda por nombre y por entrada, estado vacío, borrado |
| Tema y vista móvil | `layout.spec.ts` | Tema persistente y contraste ≥ 7:1; 14 rutas × 2 temas a 375 px con `scrollWidth == clientWidth` en documento y área principal |

| Herramienta HTTP personalizada y su uso por un agente | `tools.spec.ts` | Con redes privadas bloqueadas la API local recibe 0 peticiones; al permitirlas recibe `GET /stock?producto=tuerca%20M8&almacen=sur` (valor por defecto aplicado) con la cabecera configurada |
| Editor de `enum` y valor por defecto | `tools.spec.ts`, `api.test.ts` | Esquema guardado idéntico al construido; errores por tipo; un valor no permitido se rechaza sin llegar a la API |
| Archivos del espacio de trabajo | `tools.spec.ts` | Archivo escrito por un agente con `file_write`; vista previa Markdown/texto; borrado confirmado en disco |
| Proveedores y API key | `settings.spec.ts`, `api.test.ts` | Modelos listados antes de guardar; el `PUT` de edición no contiene `apiKey`; «Quitar clave» envía `null`; un agente llama por el protocolo OpenAI con `Authorization: Bearer …` |
| Interruptores de Ajustes | `settings.spec.ts` | Con concurrencia 1 la segunda ejecución queda «En cola» y no llega al modelo; `run_javascript` y las llamadas a localhost fallan o funcionan según el interruptor |
| Eliminar ejecuciones terminadas | `settings.spec.ts` | Solo queda la ejecución en curso |

| Retención del historial | `settings.spec.ts`, `hardening.test.ts`, `api.test.ts` | Con máximo 2 quedan las dos más recientes y se sigue aplicando al terminar la siguiente; ajuste persistente |
| Reanudar tras un apagado | `persistence.spec.ts`, `api.test.ts` | Tras matar el servidor aparece el aviso; «Reanudar» crea una ejecución que solo llama al modelo para el paso inacabado; «Descartar» lo retira; aparece sin recargar; migración v1→v2 |

Comprobado a mano con el servidor real y Ollama tras 4.4:

- **Reanudación**: workflow «Informe de investigación multiagente» lanzado; con `redactar` en curso se mató el
  proceso (`taskkill /F`). Al arrancar, el Panel mostraba «Una ejecución se interrumpió al apagarse el servidor».
  «Reanudar» → nueva ejecución **Completado**, `retryOf` correcto, eventos `step.reused` para `tema`,
  `investigar` y `analizar`, **2 llamadas al modelo** (redactar y revisar) e informe final generado.
- **SSRF**: `http://localhost:11434` y `http://[::ffff:127.0.0.1]:11434` → «Acceso bloqueado a red privada o
  local»; `https://example.com/` (TLS con la IP fijada) → «Example Domain»; `https://www.wikipedia.org/`
  (respuesta comprimida) → 200 con HTML legible.
- **Sandbox**: `fib(20)` → 6765 en 62 ms con su `console.log`; `while(true){}` → cortado a los 5 s;
  `this.constructor.constructor("return process.env")()` → «Code generation from strings disallowed».

Comprobado además a mano en el navegador con Ollama real tras 4.2: «Añadir proveedor» → plantilla «Ollama local» →
«Probar» muestra «Conexión correcta: 4 modelos» y ofrece los 3 modelos de chat sin haber guardado; el editor de
herramientas muestra las filas de valores permitidos y valor por defecto (desactivadas para sí/no).

Comprobado además a mano en el navegador con el modelo real (`qwen3.5:4b-q4_K_M`) tras los cambios de 4.1:
agente «Calculista» → «El total de la factura es 2.965,47 euros», con `"result": 2965.468` en el resultado de la
herramienta; cancelar un ensayo a los 5 s deja en pantalla los 2.143 caracteres ya generados; consola sin errores.

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
- **Red desde el entorno aislado**: comprobado que con Node 24 el proceso con `--permission` **sí puede** abrir
  conexiones (`net.connect` y `fetch` a localhost funcionan); no se ha podido restringir sin dependencias externas.
- **Rebinding contra un DNS real**: el test inyecta la resolución; no se ha montado un servidor DNS ni se ha
  probado con un dominio de rebinding público.
- **Retención con historiales grandes** (decenas de miles de ejecuciones): no medido el tiempo de borrado.
- Navegadores distintos de Chromium (la suite e2e solo define el proyecto Chromium).
- La suite e2e usa un modelo simulado: prueba la interfaz y el protocolo, no la calidad de las respuestas de
  un modelo real (eso lo cubren `ollama.integration.test.ts` y las comprobaciones manuales).
- El arrastre con ratón del lienzo se prueba con ratón sintético de Playwright; no se ha probado con pantalla
  táctil real ni con trackpad.
- Cargas altas (cientos de ejecuciones simultáneas o historiales de millones de eventos).
