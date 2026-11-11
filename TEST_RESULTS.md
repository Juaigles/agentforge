# AgentForge — Resultados de pruebas

Todos los resultados proceden de ejecuciones reales en esta máquina
(Windows 11, Node v24.19.0, Ollama 0.40.6, modelo `qwen3.5:4b-q4_K_M`), entre el 2026-11-09 y el 2026-11-10.

## 1. Tests automatizados

Comandos: `npm test` (Vitest 5), `npm run test:e2e` (Playwright 1.65, Chromium), `npm run typecheck`, `npm audit`.
Resultados del 2026-11-11 (hito 5, tras la fase 2):

```
servidor     Test Files  13 passed (13)   Tests  295 passed | 1 skipped (296)
frontend     Test Files  7 passed (7)     Tests   40 passed (40)
end-to-end   46 passed (2.5m)
typecheck    sin errores (tsc servidor, vue-tsc frontend, tsc e2e)
npm audit    found 0 vulnerabilities
```

El test omitido es el que ejecuta código dentro de un contenedor: se salta solo cuando no hay Docker ni Podman
en marcha, y en esta máquina Docker Desktop estaba apagado.

Punto de partida del hito 5 (commit `8bef427`, medido el 2026-11-11 antes de tocar nada): 203 de servidor, 40 de
frontend, 43 e2e, `typecheck` limpio y 0 vulnerabilidades.

| Archivo | Qué verifica | Dobles de prueba |
|---|---|---|
| `server/test/shared.test.ts` | Plantillas `{{ref}}`, orden topológico, ciclos, validación de workflows | Ninguno |
| `server/test/tools.test.ts` | Calculadora, validación de argumentos, confinamiento de archivos, bloqueo SSRF, `run_javascript`, herramientas HTTP personalizadas | Servidor HTTP local real |
| `server/test/llm.test.ts` | Adaptadores Ollama y OpenAI: cuerpo enviado, streaming troceado, tool-calls, errores, cancelación | Servidor HTTP local que habla el protocolo real |
| `server/test/engine.test.ts` | Secuencia, paralelismo, uniones, condiciones, reintentos, políticas de error, timeouts, límites, cancelación, delegación, memoria compartida, eventos, instantáneas, reintento desde el fallo | Solo el proveedor LLM (frontera `LlmFactory`) |
| `server/test/api.test.ts` | API HTTP, SSE (historial + directo + `Last-Event-ID`), cifrado de claves, **persistencia tras reinicio** en disco, ejecuciones interrumpidas, datos de ejemplo | Solo el proveedor LLM |
| `server/test/hardening.test.ts` | **SSRF**: direcciones privadas en todas sus notaciones, rechazo sin conectar, **rebinding** (dos servidores reales en 127.0.0.1/127.0.0.2 y un DNS que cambia), redirecciones, compresión, límites y cancelación. **Sandbox**: sin `require`/`process`/`eval`, bucles y memoria acotados, promesas, y segunda capa (el proceso no puede leer, escribir, lanzar programas ni crear workers). **Retención**: por antigüedad y por número, con pasos y eventos | La resolución DNS se inyecta como función (seam); los sockets y procesos son reales |
| `server/test/foreach.test.ts` | Nodo «para cada»: interpretación de listas, concurrencia y orden, lista vacía, tope, fallo y reintento por elemento, cancelación, presupuesto de llamadas, herramientas en paralelo, validación | Solo el proveedor LLM |
| `server/test/schedule-import.test.ts` | Programación (cálculo de citas, alta/validación, disparo, apagado largo, sin solapes, workflow roto, «ejecutar ahora», reinicio, temporizador real) y exportar/importar (contenido, alta de agentes, reutilización, avisos, archivos no válidos) | Solo el proveedor LLM; el reloj se pasa como argumento a `tick()` |
| `server/test/lifecycle.test.ts` | **Apagado ordenado** (en curso y en cola → interrumpidas y reanudables; plazo), respuestas comprimidas cortadas o canceladas, herramienta que ignora la cancelación, configuración de nodos fuera de rango, reintentos solo de errores transitorios, expresiones regulares catastróficas (con el bucle de eventos vivo), versión de esquema superior, copia previa a migrar, migración fallida, API key indescifrable, instancia única, validación de la configuración | Solo el proveedor LLM; servidores HTTP y procesos reales |
| `server/test/security.test.ts` | Claves ligadas a su origen (se comprueba qué cabecera llega a cada servidor), `Host` con `0.0.0.0`, clave de acceso y sesión, peticiones de otra web, límite de tasa, cabeceras y CSP, bloqueo de la propia API, redirecciones a otro origen, direcciones privadas disfrazadas, plantillas del cuerpo, cuotas, consultas no válidas, sondas de salud, **`run_javascript` sin red** (proceso real con sus argumentos y su preludio intentando conectar, resolver nombres y usar `fetch`), contenedor, y **fijación de DNS contra un servidor DNS real** | El proveedor LLM (salvo donde se usan los adaptadores reales); servidores HTTP, DNS y procesos reales |
| `server/test/data.test.ts` | Estadísticas incrementales y acumuladas (día local), paginación estable, resúmenes recortados, búsqueda de texto completo (subcadenas, tildes, caracteres especiales, ventana de 2 000), eventos sin salida duplicada, retención por tandas con el archivo encogiendo de verdad, memoria compartida tras reintentar, fragmentos agrupados y en orden, reproducción SSE de 2 300 eventos por HTTP real (también con `Last-Event-ID` y con la ejecución en marcha), HTML a texto en tiempo lineal con entradas hostiles, y copias de seguridad (crear, descargar, restaurar al reiniciar, cancelar, subir, nombres maliciosos) | Solo el proveedor LLM; base de datos en disco y HTTP reales |
| `server/test/static.test.ts` | Servido del frontend: fallback de la SPA, caché, 404 de assets, archivos nuevos sin reiniciar | Ninguno |
| `server/test/ollama.integration.test.ts` | **Modelo real**: chat nativo, adaptador OpenAI vía `/v1`, agente con herramienta por ambos adaptadores, workflow paralelo de 3 agentes | **Ninguno** (se omite si no hay Ollama) |
| `web/src/lib/run-state.test.ts` | Reductor de eventos del monitor en vivo, emparejado de llamadas a herramientas, formato | Ninguno |
| `web/src/lib/glossary.test.ts` | Coherencia del glosario: ids existentes, entradas usadas, términos fuera de botones/enlaces/código/títulos, definiciones aptas para tooltip | Ninguno (analiza las plantillas reales) |
| `web/src/lib/transfer.test.ts` | Nombre del archivo exportado y descripción de la cadencia en lenguaje natural | Ninguno |
| `web/src/components/Term.test.ts` | Tooltip del glosario: ratón, foco, Esc, clic fuera, scroll, dos toques en táctil, `aria-describedby` | `matchMedia` (jsdom no lo implementa) |
| `web/src/components/RunActivity.test.ts` | Registro de actividad: marcadores, mensajes, herramientas (OK/error/en curso), despliegue, filtro por nodo, sangría de delegados | Ninguno |
| `web/src/components/FlowNode.test.ts` | Nodo del lienzo: conexiones por tipo, subtítulos, estados, errores, datos históricos del agente | El punto de conexión de Vue Flow (necesita un lienzo real) |
| `web/src/views/AgentEditorView.test.ts` | Formulario de agentes: valores por defecto, validación, alta, edición, errores del servidor, herramientas huérfanas | Solo el proveedor LLM: usa la **API real** en memoria |
| `e2e/*.spec.ts` (46 tests) | Interfaz real en Chromium contra el servidor real; ver `e2e/README.md` | Solo el modelo: servidor HTTP local que habla el protocolo de Ollama/OpenAI |

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

| Nodo «para cada» | `workflow-builder.spec.ts`, `foreach.test.ts` | Configurado en el lienzo; lista de 6 con tope 5 → falla sin llamar al modelo; lista de 3 → 3 peticiones, una por elemento, y avance en vivo |
| Exportar / importar | `automation.spec.ts`, `schedule-import.test.ts` | Se descarga el archivo real, se borran workflow y agente, se sube el archivo y el workflow importado se ejecuta; archivos no válidos rechazados sin crear nada |
| Ejecución programada | `automation.spec.ts`, `schedule-import.test.ts` | Alta, pausa y baja desde la interfaz; «Ejecutar ahora»; y una ejecución que aparece sola al cumplirse **un minuto real** |

### 1.2 Prueba de carga (`npm run loadtest`)

`node scripts/loadtest.mjs --runs 10000,50000`: siembra una base temporal con ejecuciones sintéticas (semilla
fija, 18 KB por ejecución con sus 6 pasos y 20 eventos), arranca el servidor real sobre ella y mide por HTTP. Un
sondeador pide `/api/health` cada 20 ms: su latencia máxima es el tiempo que el servidor ha estado bloqueado.
Medido el 2026-11-11 en esta máquina (Windows 11, Node 24.19, SSD); «antes» es el commit `8bef427`.

| 50 000 ejecuciones | Antes: p50 / bloqueo máx | Después: p50 / bloqueo máx |
|---|---|---|
| `GET /api/stats` | 1 119,8 / 1 103,1 ms | 3,1 / 0,7 ms |
| Lista, 30 filas | 2,3 / 2,0 ms | 0,7 / 0,5 ms |
| Lista, 200 filas (tamaño) | 6,3 ms (522 KB) | 2,3 ms (186 KB) |
| Lista, estado = completadas | 204 / 183,6 ms | 2,2 / 0,7 ms |
| Lista, por workflow | 109,8 / 86,4 ms | 0,6 / 0,7 ms |
| Lista, por agente | 107,7 / 87,2 ms | 1,4 / 1,3 ms |
| Lista, página profunda (posición 45 000) | 313,4 / 291 ms | 0,9 / 0,6 ms |
| Interrumpidas | 188,6 / 161,2 ms | 0,3 / 0,6 ms |
| Búsqueda, término frecuente | 117,3 / 98,1 ms | 4,7 / 4,8 ms |
| Búsqueda, término inexistente | 321,4 / 320,9 ms | 0,3 / 0,6 ms |
| Inserción de eventos de 500 bytes | 2 317 por segundo | 34 540 por segundo |
| Retención sin nada que borrar | 656,3 / 646,9 ms | 1,0 / 0,3 ms |
| Retención que borra la mitad | 4 572 ms, bloqueo 4 541 ms | 21 284 ms en segundo plano, bloqueo máx 213 ms |
| Archivo tras borrar la mitad | 893 → 893 MB | 1 239 → 805 MB |
| 40 ejecuciones, 3 / 10 a la vez | 70 / 255 por minuto | 68 / 247 por minuto |
| 200 clientes SSE, retraso del texto p50 / máx | 3 / 10 ms | 33 / 56 ms |
| Memoria del servidor con 200 clientes SSE | 126 MB | 198 MB |
| Arranque (la primera vez migra el esquema) | 0,7 s | 23,4 s (una sola vez) |

| 10 000 ejecuciones | Antes | Después |
|---|---|---|
| `GET /api/stats` | 223,4 ms | 1,7 ms |
| Lista, estado = completadas | 41,6 ms | 0,8 ms |
| Página profunda (posición 9 000) | 55,7 ms | 1,0 ms |
| Búsqueda, término frecuente / inexistente | 24,3 / 59 ms | 4,4 / 0,4 ms |
| Inserción de eventos | 2 480 por segundo | 29 753 por segundo |
| Retención que borra la mitad | bloqueo 794 ms | bloqueo máx 117 ms, 250 → 160 MB |

Lo que empeora, a sabiendas: el texto del modelo llega con unos 30 ms más de retraso (los fragmentos se agrupan
en ventanas de 33 ms), el servidor usa más memoria (caché de SQLite de 32 MB), el índice de búsqueda agranda la
base, y borrar medio historial tarda más en total porque se hace por tandas sin bloquear. El bloqueo máximo
durante esa retención (213 ms) queda por encima del objetivo de 100 ms.

Comprobado con el servidor real y Ollama tras la fase 2 del hito 5 (2026-11-11, `qwen3.5:4b-q4_K_M`):

- **Migración de los datos reales** (16 ejecuciones, esquema v3 → v4): `/api/health/ready` → «esquema v4»; quedó
  `data/agentforge.db.v3.bak`; las estadísticas reconstruidas daban 39 llamadas al modelo, 7 a herramientas,
  15 233 + 7 776 tokens y el ranking Investigador (10 pasos), Analista (9), Redactor (8).
- **Ejecución nueva**: «Informe de investigación multiagente» con «Cómo afecta el teletrabajo a la productividad
  de un equipo pequeño» → **Completado** en 11 s, 4 llamadas al modelo, 2 332 tokens; las estadísticas pasaron al
  instante a 43 llamadas y 2 completadas hoy. Sus 26 eventos guardados no repiten la salida de ningún paso y el
  monitor (navegador, sin errores de consola) muestra el informe completo de 2 174 caracteres.
- **Búsqueda en el contenido**: «teletrabajo» (entrada), «PRODUCTIVIDAD de un equipo» (sin distinguir
  mayúsculas) y «Equipos Pequeños» (texto del resultado) encuentran esa ejecución; el resumen de la lista lleva
  300 caracteres del resultado.
- **Copia de seguridad** de los datos reales: 121 758 bytes, con 6 agentes, 3 workflows, 16 ejecuciones y 1
  archivo; aparece en Ajustes → Copias de seguridad con su botón «Restaurar».

Comprobado con el servidor real y Ollama tras la fase 1 del hito 5 (2026-11-11, `qwen3.5:4b-q4_K_M`):

- **Reanudación tras un corte**: «Informe de investigación multiagente» con la entrada «Ventajas e inconvenientes
  de la energía solar doméstica»; se paró el servidor con `redactar` en curso. Al arrancar, el registro anotó
  «Hay ejecuciones interrumpidas por el cierre anterior» y el Panel mostró el aviso. «Reanudar» (pulsado en el
  navegador) → ejecución **Completado**, `step.reused` para `tema`, `investigar` y `analizar`, **2 llamadas al
  modelo** e informe generado. Ese cierre fue brusco (la vista previa mata el proceso); el apagado ordenado está
  comprobado en la suite e2e con el mensaje IPC `shutdown` (código de salida 0, ejecución interrumpida y reanudada).
- **Sondas y cabeceras**: `/api/health/ready` → `ok`, esquema v3, carpeta de datos y planificador correctos; todas
  las respuestas con CSP, `X-Frame-Options: DENY` y `nosniff`; un POST con `Origin: https://evil.example` → 403;
  `Host: evil.example` → 403.
- **Entorno aislado**: `/api/sandbox/status` → `networkBlocked: true`, método `lockdown`, Node v24.19.0; contenedor
  no disponible («Docker está instalado pero su servicio no responde»). `fib(20)` → 6765 en 111 ms; un intento de
  `import("node:net")` → error, sin conexión; elegir el contenedor → 409 con el motivo.
- **Herramientas de red**, con redes privadas permitidas: `http://127.0.0.1:4310/api/settings` → «las herramientas
  no pueden llamar a la propia API de AgentForge»; `http://localhost:11434/api/version` (Ollama) → 200;
  `web_fetch` de `https://www.wikipedia.org/` → título «Wikipedia» en 218 ms.
- **Modo desarrollo**: Vite en :5173 sirve la aplicación y el código compartido; `/@fs/…/data/secret.key` y
  `/@fs/…/data/agentforge.db` → 403; consola del navegador sin errores.

Comprobado con el servidor real y Ollama tras 4.5:

- **«Para cada»**: workflow tema → Investigador («3 ejemplos, uno por línea») → para cada → salida, con «frutas
  tropicales». Resultado **Completado**, 4 llamadas al modelo; el nodo recibió `["Mango", "Piña", "Papaya"]` y
  produjo un apartado por fruta. Nota honesta: dos de las tres descripciones salieron como «informe ejecutivo»
  porque así lo ordenan las instrucciones del agente Redactor de ejemplo; es una cuestión del prompt, no del motor.
- **Programación**: «Cálculo con herramientas y archivo» programado cada minuto con «¿Cuánto es 37 * 12 + 5?».
  El temporizador lo lanzó solo: ejecución **Completado**, marcada `scheduled`, con 1 llamada real a `calculator`.
- **Exportar/importar**: el workflow de ejemplo se exportó (9 nodos, 4 agentes) y se importó como «… (importado)»
  reutilizando los 4 agentes, sin avisos ni errores de validación.

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
- **Aislamiento en contenedor**: no se ha ejecutado código dentro de un contenedor (Docker Desktop apagado). Están
  probados los argumentos de `docker run`, la detección del motor y el rechazo cuando falta.
- **Permiso de red de Node** (`--allow-net`): esta máquina tiene Node 24.19, que no lo ofrece; el camino que se
  ha probado es el del proceso que inutiliza sus API de red. Sin ese preludio el mismo proceso sí conecta (hay un
  test que lo demuestra).
- **Apagado por señal** (`SIGINT`, `SIGTERM`, `SIGBREAK`, `SIGHUP`): no se puede enviar una señal a otro proceso en
  Windows; se ha probado el mismo código por el mensaje IPC `shutdown`.
- **Rebinding contra un dominio público**: probado contra un servidor DNS local real, no contra un dominio de
  rebinding de Internet.
- **Redirección de https a http**: el rechazo está en el código pero no tiene test (haría falta un servidor TLS).
- **Clave de acceso detrás de un proxy inverso** y con `HOST=0.0.0.0` en una red real: probado con peticiones
  inyectadas y con un servidor en 127.0.0.1, no desde otro equipo.
- **Restauración sobre los datos reales**: la copia de los datos reales se creó y se listó, pero no se ha
  restaurado sobre `data/` (sí en la suite e2e y en los tests, con datos temporales).
- **Historiales de más de 50 000 ejecuciones** o con salidas grandes (la siembra usa salidas de 2 KB).
- **Navegador con respuestas muy largas**: el límite de pintado de Markdown no se ha medido con una respuesta de
  cientos de KB en un navegador real.
- **Programación diaria a una hora**: probado el cálculo de la cita y su disparo adelantando el reloj; no se ha
  esperado a una hora real ni se ha probado un cambio de hora (horario de verano).
- **Importación entre dos instalaciones físicas distintas**: probada entre dos bases de datos distintas en los
  tests, no entre dos equipos.
- Navegadores distintos de Chromium (la suite e2e solo define el proyecto Chromium).
- La suite e2e usa un modelo simulado: prueba la interfaz y el protocolo, no la calidad de las respuestas de
  un modelo real (eso lo cubren `ollama.integration.test.ts` y las comprobaciones manuales).
- El arrastre con ratón del lienzo se prueba con ratón sintético de Playwright; no se ha probado con pantalla
  táctil real ni con trackpad.
- Cargas altas: cientos de ejecuciones simultáneas o millones de eventos. La prueba de carga llega a 40
  ejecuciones (10 a la vez), 200 clientes SSE y 1 000 000 de eventos sembrados.
