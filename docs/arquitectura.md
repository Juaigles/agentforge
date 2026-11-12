# Arquitectura de AgentForge

Para quien va a leer o cambiar el código. Qué piezas hay, cómo viaja una ejecución por ellas y dónde tocar para
cada tipo de cambio. Las decisiones y su porqué están en [PLAN.md](../PLAN.md).

## Vista general

```
navegador ──HTTP/SSE──▶ servidor (un proceso de Node) ──▶ SQLite (data/agentforge.db)
   web/                    server/                    └─▶ proveedores LLM (Ollama, API compatibles con OpenAI)
                                                      └─▶ herramientas (red, archivos, proceso aislado, MCP)
        └──── shared/ (tipos, plantillas y validación de grafos: el mismo código en los dos lados) ────┘
```

Es una aplicación de **un solo proceso y un solo usuario**: no hay cola externa, ni caché, ni trabajadores. Todo
el estado duradero está en un archivo SQLite; lo que está en memoria (ejecuciones en curso, suscripciones en
vivo) se puede reconstruir tras un reinicio.

| Carpeta | Qué contiene |
|---|---|
| `shared/` | Tipos del dominio (`types.ts`), plantillas `{{ref}}` (`template.ts`), orden topológico y validación de workflows (`graph.ts`, `validation-messages.ts`) |
| `server/src/` | API, motor, herramientas, adaptadores LLM, persistencia |
| `web/src/` | Interfaz (Vue 3, Pinia, Vue Router, Vue Flow, vue-i18n) |
| `e2e/` | Suite de Playwright y servidor que simula el protocolo de Ollama y de OpenAI |
| `scripts/` | Arranque en desarrollo, prueba de carga y prueba de humo con un modelo real |
| `docs/` | Esta guía, la de usuario, la de solución de problemas y la referencia de la API |

## Servidor

### Arranque (`index.ts`, `config.ts`, `context.ts`, `app.ts`)

1. `config.ts` lee y **valida** las variables de entorno; un valor incorrecto detiene el arranque nombrando la
   variable.
2. `context.ts` crea el `AppContext`: abre la base de datos (migrando si hace falta), toma el bloqueo de
   instancia única (`agentforge.lock`), carga la clave de cifrado y construye el registro de herramientas, la
   fábrica de clientes LLM, el gestor de ejecuciones y el planificador.
3. `app.ts` monta Fastify: un gancho por petición aplica, en este orden, la comprobación de `Host`, la de
   origen (peticiones de otra web), el límite de tasa y la clave de acceso; después van las rutas y el servido de
   `web/dist`. El manejador de errores convierte cada tipo de error en una respuesta con `error` (texto) y `code`
   (estable).
4. `index.ts` gestiona el apagado ordenado: marca las ejecuciones en curso como **interrumpidas** (reanudables),
   espera con un plazo y cierra.

El `AppContext` es lo que reciben las rutas y los tests: no hay singletons globales, así que un test crea su
propio contexto con una base de datos en memoria y un proveedor LLM de guion.

### Persistencia (`db/database.ts`, `db/store.ts`)

- `node:sqlite` en modo WAL. `database.ts` tiene la lista de **migraciones** numeradas: se aplican en una
  transacción cada una, con copia previa del archivo (`agentforge.db.v<N>.bak`); una base de una versión posterior
  se rechaza.
- `Store` es la única puerta a la base de datos: todo el SQL está ahí. Devuelve objetos del dominio (`shared/types`),
  nunca filas.
- Los secretos (API keys, cabeceras con credenciales, secretos de webhooks, variables de servidores MCP) se guardan
  cifrados con AES-256-GCM (`crypto/secrets.ts`); la clave maestra es `data/secret.key`.
- Las estadísticas del panel son contadores incrementales, no consultas sobre todo el historial; la búsqueda usa un
  índice de texto completo.

### Motor (`engine/`)

Una ejecución (`run`) es o un agente suelto o un workflow.

- **`run-manager.ts`** — cola global y ciclo de vida: crea la ejecución con una **instantánea** del workflow y de
  sus agentes (lo que se ejecuta no cambia aunque se editen después), respeta el máximo de ejecuciones
  simultáneas, emite los eventos, guarda pasos y resultados, y ofrece cancelar, reintentar desde el fallo y
  reanudar tras un reinicio.
- **`workflow-engine.ts`** — recorre el grafo: lanza cada nodo cuando sus dependencias han terminado, con un
  límite de concurrencia; resuelve las plantillas; aplica reintentos con espera creciente, tiempos máximos,
  duración máxima y presupuesto de llamadas al modelo; salta las ramas no elegidas por una condición o una
  aprobación. Cada tipo de nodo tiene su función de ejecución.
- **`agent-runner.ts`** — el bucle de un agente: llamada al modelo, ejecución de las herramientas que pida,
  vuelta al modelo, hasta la respuesta final o el máximo de iteraciones. Incluye la delegación entre agentes.
- **`scheduler.ts`** y **`cron.ts`** — disparadores con horario: un temporizador revisa los vencidos y calcula la
  siguiente ocasión (intervalo, días y hora, o cron con zona horaria).
- **`regex.ts`** — las expresiones regulares de las condiciones se evalúan en un `Worker` con límite de tiempo.

Cada cosa que ocurre es un **evento** (`run.started`, `step.started`, `llm.delta`, `tool.call`, `step.finished`…).
Los eventos se guardan en la base de datos y, a la vez, se publican a quien esté escuchando.

### Tiempo real (SSE)

- `GET /api/runs/:id/stream` reproduce los eventos guardados y sigue con los nuevos; admite `Last-Event-ID` para
  reconectar sin repetir.
- `GET /api/stream/runs` avisa de cualquier cambio de estado de cualquier ejecución (lo usan el contador del menú,
  el panel y el historial).
- Los fragmentos de texto del modelo se agrupan (hasta 33 ms) para no saturar el canal.

### Modelos (`llm/`)

`LlmFactory.create(proveedor)` devuelve un cliente con dos operaciones: `chat` (con streaming y llamadas a
herramientas) y `listModels`. Hay dos adaptadores: el nativo de Ollama y el compatible con OpenAI. **Esta es la
única frontera que los tests sustituyen**: `ScriptedLlm` en los tests del servidor y un servidor HTTP que habla el
protocolo real en la suite e2e.

### Herramientas (`tools/`)

- `registry.ts` reúne tres fuentes: integradas (`builtin.ts`), HTTP personalizadas (definidas desde la interfaz) y
  las de servidores MCP (`mcp.ts`). Todas tienen la misma forma: nombre, descripción, esquema de parámetros y
  `execute`.
- `validate.ts` comprueba los argumentos contra el esquema antes de ejecutar.
- `net.ts` (`safeFetch`) es la única vía de salida a la red: bloquea redes privadas, fija la IP validada (DNS
  rebinding), limita tamaño y tiempo y retira credenciales en redirecciones a otro sitio.
- `sandbox.ts` ejecuta `run_javascript` en un proceso hijo sin red ni permisos, o en un contenedor.

### Rutas (`routes/api.ts`, `routes/schemas.ts`)

Unas ochenta rutas REST bajo `/api`. Los cuerpos se validan con esquemas Zod (`schemas.ts`). La referencia está en
[api.md](api.md) y, en formato OpenAPI, en `GET /api/openapi.json`.

## Frontend

- **`main.ts` / `App.vue` / `router.ts`** — armazón: menú, estado de conexión, selector de tema e idioma,
  anuncios para lectores de pantalla.
- **`stores/`** (Pinia): `catalog` (proveedores, agentes, herramientas, workflows y salud), `runs` (canal en vivo
  global), `ui` (avisos, confirmaciones, tema).
- **`lib/`**: `api.ts` (cliente tipado; todo `fetch` pasa por aquí), `useRunStream.ts` y `run-state.ts` (estado
  en vivo de una ejecución a partir de sus eventos), `builder.ts` (deshacer, disposición automática y conexiones
  del constructor), `flow.ts` (traducción entre el workflow y Vue Flow), `format.ts` (números, fechas y
  duraciones según el idioma), `glossary.ts`, `markdown.ts` (salida de los modelos saneada con DOMPurify),
  `a11y.ts` (foco, anuncios y asociación de campos con sus mensajes).
- **`i18n/`**: `index.ts` y un archivo de mensajes por pantalla en `es/` y `en/`. Se usa `t('ámbito.clave')`
  importado de `@/i18n`.
- **`views/`** y **`components/`**: una vista por ruta; los diálogos usan `AppModal.vue`.

El frontend no guarda estado propio del dominio: lo que muestra viene de la API y se refresca con los eventos.

## Cómo viaja una ejecución

1. La interfaz hace `POST /api/workflows/:id/run` con la entrada.
2. La ruta valida el workflow (`shared/graph.ts`, el mismo código que usa el constructor) y pide al gestor de
   ejecuciones que la cree: se guarda con su instantánea, en cola.
3. Cuando hay hueco, el motor recorre el grafo. Cada nodo de agente entra en el bucle de `agent-runner`, que
   habla con el proveedor por su adaptador y ejecuta herramientas a través del registro.
4. Cada paso emite eventos: se guardan y se envían por SSE. El monitor los aplica a su estado con el reductor de
   `run-state.ts`, el mismo que usa para reproducir una ejecución ya terminada.
5. Al terminar se guardan el resultado, el uso de tokens y los contadores del panel, y se aplica la retención.

## Dónde tocar para…

| Cambio | Archivos |
|---|---|
| Una herramienta integrada nueva | `server/src/tools/builtin.ts` (aparece sola en el catálogo, el editor y el constructor) |
| Un proveedor de otro tipo | Un adaptador en `server/src/llm/` y su alta en `llm/index.ts`; el tipo en `shared/types.ts` |
| Un tipo de nodo nuevo | `shared/types.ts` y `shared/graph.ts` (validación), `server/src/engine/workflow-engine.ts` (ejecución), `server/src/routes/schemas.ts`, y en la interfaz `lib/flow.ts`, `FlowNode.vue` y el inspector de `WorkflowBuilderView.vue`. No hay un registro único: es la limitación conocida más incómoda |
| Una columna o tabla | Una migración nueva al final de la lista de `db/database.ts` (nunca editar una existente), `Store` y los tests que fijan la versión del esquema |
| Una ruta de la API | `routes/api.ts`, su esquema en `schemas.ts`, el cliente en `web/src/lib/api.ts` y su entrada en la especificación (`server/src/openapi.ts`; un test falla si falta) |
| Un texto de la interfaz | `web/src/i18n/es/<ámbito>.ts` y `en/<ámbito>.ts` (un test exige las mismas claves) |
| Un término del glosario | `web/src/lib/glossary.ts` (español e inglés) y usarlo con `<Term id="…">` en alguna pantalla |
| Un mensaje de validación de workflows | `shared/validation-messages.ts` y `web/src/lib/validation-en.ts` |

## Pruebas

| Batería | Comando | Qué ejercita |
|---|---|---|
| Servidor | `npm test -w server` | Unidad, protocolo, motor, API, persistencia en disco y seguridad. El único doble es el proveedor LLM |
| Frontend | `npm test -w web` | Lógica y componentes montados contra la API real arrancada dentro del test |
| End-to-end | `npm run test:e2e` (Chromium) o `npm run test:e2e:all` (Chromium, Firefox y WebKit) | La interfaz real contra el servidor real, con un modelo simulado por HTTP |
| Estática | `npm run lint`, `npm run format:check`, `npm run typecheck` | ESLint, Prettier y tipos |
| Cobertura | `npm run test:coverage` | Con umbrales en `server/vitest.config.ts` y `web/vite.config.ts` |
| Carga | `npm run loadtest` | Servidor real con historiales sembrados |

La regla de las pruebas: se verifica comportamiento real. No se simulan módulos del proyecto ni respuestas; lo
que hay al otro lado de una frontera externa se sustituye por un servidor local que habla el protocolo de verdad.

## Límites del diseño

- **Un proceso, un usuario.** No hay cuentas ni permisos, ni forma de repartir el trabajo entre varias máquinas.
- **Los workflows son grafos acíclicos.** La repetición se hace con el nodo «para cada».
- **Un subworkflow es una ejecución aparte**, enlazada con la que la lanza.
- **El aislamiento de `run_javascript` en proceso no es una frontera del sistema operativo**; para código no
  confiable, el contenedor.
- La lista completa y actualizada está en «Pendiente y limitaciones» de [PROGRESS.md](../PROGRESS.md).
