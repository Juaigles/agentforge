> Generado a partir de `server/src/openapi.ts`; la especificación completa está en `GET /api/openapi.json`.

# Referencia de la API de AgentForge

Versión de la especificación: OpenAPI 3.1.0. Todas las rutas cuelgan de `/api`.

## Dirección base

`http://127.0.0.1:4310` (servidor local por defecto). Las peticiones y las respuestas son JSON (`Content-Type: application/json`), salvo los flujos de eventos, la subida y la descarga de copias y los webhooks, que lo indican.

## Autenticación

Si el servidor se arranca con la variable `AGENTFORGE_TOKEN`, toda la API exige la clave de acceso, salvo `/api/auth/*`, `/api/health/live` y los webhooks. Sin clave configurada (por defecto, escuchando solo en `127.0.0.1`) no hace falta nada.

- **Clave como cabecera:** `Authorization: Bearer <clave>`.
- **Cookie de sesión:** `POST /api/auth/login` con `{ "token": "<clave>" }` deja la cookie `af_session` (HttpOnly, SameSite=Strict, 30 días); `POST /api/auth/logout` la borra.
- **Webhooks:** no usan la clave de la interfaz, sino el secreto de su disparador (ver [Webhooks](#webhooks)).

Antes de llegar a las rutas, una petición con un `Host` no permitido o que procede de otro sitio web (protección CSRF) se rechaza con 403 (`forbidden_host` o `cross_site`).

## Errores

Toda respuesta de error es JSON con esta forma:

```json
{ "error": "Mensaje legible, en español.", "code": "not_found" }
```

En una validación (`code: "validation"`) se añade `issues`, una lista de `{ "path": "campo", "message": "motivo" }`. Algunos errores traen `details` (por ejemplo, `{ "issues": [...] }` con los problemas del grafo al lanzar un workflow con errores).

| Código | Cuándo aparece |
| --- | --- |
| `validation` | El cuerpo o los parámetros no cumplen el esquema (400). Trae `issues` con el campo y el motivo. |
| `not_found` | El recurso no existe (404). |
| `bad_request` | Petición no válida por otro motivo: conflicto con el estado actual, formato no admitido, etc. (400, 409, 415, 422…). |
| `auth_required` | Falta la clave de acceso o la sesión ha caducado (401). La interfaz muestra entonces la pantalla de entrada. |
| `invalid_token` | La clave enviada al iniciar sesión no es correcta (401). |
| `forbidden_host` | La petición llega por un nombre de servidor que no está admitido (403). Ver `AGENTFORGE_ALLOWED_HOSTS`. |
| `cross_site` | La petición procede de otro sitio web (403). |
| `api_key_required` | Se ha cambiado la dirección de un proveedor y hay que volver a escribir su API key (400). |
| `rate_limited` | Se ha superado el límite de peticiones (429). La cabecera `Retry-After` indica los segundos de espera. |
| `payload_too_large` | El cuerpo de la petición supera el tamaño máximo (413). |
| `provider_error` | El proveedor de modelos (Ollama, OpenAI…) ha fallado o no responde (502). |
| `tool_error` | Una herramienta ha rechazado sus argumentos (400). |
| `config_error` | Configuración que el usuario puede arreglar: clave que no se descifra, proveedor desactivado… (409). |
| `internal` | Error interno del servidor (500 o superior). El mensaje es genérico; el detalle queda en el registro del servidor. |

## Límite de tasa

1 200 peticiones por minuto y cliente (`AGENTFORGE_RATE_LIMIT`; 0 lo desactiva), un décimo (mínimo 30) en las rutas costosas (lanzar, probar, reintentar, invocar, reconectar y webhooks) y 10 intentos por minuto en el inicio de sesión. Al superarlo, 429 con `Retry-After`.

## Eventos en vivo

Tres rutas son flujos de eventos del servidor (`text/event-stream`, SSE) pensados para `EventSource`:

| Ruta | Evento | Contenido de `data` |
| --- | --- | --- |
| `GET /api/stream/runs` | `run` | El `RunSummary` de la ejecución que ha cambiado. |
| `GET /api/stream/approvals` | `approvals` | La lista completa de aprobaciones pendientes, al conectar y con cada cambio. |
| `GET /api/runs/{id}/stream` | `run-event` | Un `RunEvent`; su `id` SSE es su `seq`. |

Flujo de eventos del servidor (`text/event-stream`): la conexión queda abierta. Cada ~15 s llega un comentario `: ping` para mantenerla viva y el servidor sugiere reconectar a los 2 s (`retry: 2000`). Si un cliente no lee y se le acumulan más de 8 MiB, se le corta la conexión.

Para retomar el flujo de una ejecución sin perder eventos, reconecta con la cabecera `Last-Event-ID` (el navegador la envía solo) o con `?after=<seq>`: el servidor reproduce primero el historial guardado y después sigue en vivo. Los eventos transitorios (`llm.delta`, `llm.snapshot`) tienen `seq: null` y no llevan `id`. El evento `run.finished` marca el final de la ejecución; la conexión no se cierra sola.

## Sistema

Estado del servidor, sondas de salud, estadísticas y la propia especificación.

| Método | Ruta | Qué hace |
| --- | --- | --- |
| `GET` | `/api/health` | Estado del servidor y versión |
| `GET` | `/api/health/live` | Sonda de vida: el proceso atiende peticiones |
| `GET` | `/api/health/ready` | Sonda de disponibilidad: base de datos, carpeta de datos y planificador |
| `GET` | `/api/stats` | Estadísticas del panel: totales, consumo, actividad diaria y sistema |
| `GET` | `/api/onboarding` | Qué pasos de la guía de primeros pasos están ya hechos |
| `GET` | `/api/metrics` | Métricas en el formato de texto de Prometheus |
| `GET` | `/api/openapi.json` | Esta especificación OpenAPI 3.1 en JSON |

## Sesión

Inicio y cierre de sesión con la clave de acceso.

| Método | Ruta | Qué hace |
| --- | --- | --- |
| `GET` | `/api/auth/status` | Indica si el servidor exige clave y si esta petición ya está autenticada |
| `POST` | `/api/auth/login` | Inicia sesión con la clave de acceso y deja la cookie `af_session` |
| `POST` | `/api/auth/logout` | Cierra la sesión borrando la cookie `af_session` |

### `POST /api/auth/login`

Si el servidor no tiene clave configurada responde 204 sin hacer nada. Límite propio de 10 intentos por minuto y cliente.

Cuerpo JSON (`LoginInput`): Credenciales de inicio de sesión.

| Campo | Tipo | Obligatorio | Descripción y límites |
| --- | --- | --- | --- |
| `token` | `string` | sí | Clave de acceso del servidor. |

## Proveedores

Proveedores de modelos (Ollama, compatibles con OpenAI): alta, prueba y lista de modelos.

| Método | Ruta | Qué hace |
| --- | --- | --- |
| `GET` | `/api/providers` | Lista los proveedores |
| `POST` | `/api/providers` | Crea un proveedor |
| `GET` | `/api/providers/health` | Estado de conexión de los proveedores activos |
| `POST` | `/api/providers/test` | Prueba una configuración de proveedor sin guardarla |
| `POST` | `/api/providers/models` | Lista los modelos de una configuración sin guardarla |
| `PUT` | `/api/providers/{id}` | Modifica un proveedor |
| `DELETE` | `/api/providers/{id}` | Elimina un proveedor que ningún agente use |
| `POST` | `/api/providers/{id}/test` | Prueba un proveedor guardado |
| `GET` | `/api/providers/{id}/models` | Lista los modelos de un proveedor guardado |

### `POST /api/providers`

Cuerpo JSON (`ProviderInput`): Datos de un proveedor.

| Campo | Tipo | Obligatorio | Descripción y límites |
| --- | --- | --- | --- |
| `name` | `string` | sí | 1-80 caracteres |
| `kind` | `ollama` / `openai` | sí |  |
| `baseUrl` | `string` | sí | Dirección http(s) del proveedor. · 1-sin tope caracteres |
| `apiKey` | `string` o `null` | no | Clave de la API. Omitida al editar = conservar la guardada; `null` o vacía = borrarla. · 0-500 caracteres |
| `defaultModel` | `string` | no | 0-200 caracteres; por defecto `""` |
| `enabled` | `boolean` | no | por defecto `true` |

### `GET /api/providers/health`

El resultado se guarda 10 s en caché; `force=1` lo ignora.

Parámetros de consulta:

| Nombre | Tipo | Obligatorio | Descripción |
| --- | --- | --- | --- |
| `force` | `1` | no | Con `1` se ignora la caché y se vuelve a comprobar. |

### `POST /api/providers/test`

Un fallo de conexión no es un error HTTP: la respuesta es 200 con `ok: false`.

Cuerpo JSON (`ProviderProbeInput`): Configuración de un proveedor para probarla sin guardarla.

| Campo | Tipo | Obligatorio | Descripción y límites |
| --- | --- | --- | --- |
| `name` | `string` | sí | 1-80 caracteres |
| `kind` | `ollama` / `openai` | sí |  |
| `baseUrl` | `string` | sí | 1-sin tope caracteres |
| `apiKey` | `string` o `null` | no | 0-500 caracteres |
| `defaultModel` | `string` | no | 0-200 caracteres; por defecto `""` |
| `enabled` | `boolean` | no | por defecto `true` |
| `id` | `string` | no | Proveedor que se está editando: si no se envía `apiKey`, se usa su clave guardada (solo hacia el mismo origen). · 1-64 caracteres |

### `POST /api/providers/models`

Cuerpo JSON (`ProviderProbeInput`): Configuración de un proveedor para probarla sin guardarla.

| Campo | Tipo | Obligatorio | Descripción y límites |
| --- | --- | --- | --- |
| `name` | `string` | sí | 1-80 caracteres |
| `kind` | `ollama` / `openai` | sí |  |
| `baseUrl` | `string` | sí | 1-sin tope caracteres |
| `apiKey` | `string` o `null` | no | 0-500 caracteres |
| `defaultModel` | `string` | no | 0-200 caracteres; por defecto `""` |
| `enabled` | `boolean` | no | por defecto `true` |
| `id` | `string` | no | Proveedor que se está editando: si no se envía `apiKey`, se usa su clave guardada (solo hacia el mismo origen). · 1-64 caracteres |

### `PUT /api/providers/{id}`

Cuerpo JSON (`ProviderInput`): Datos de un proveedor.

| Campo | Tipo | Obligatorio | Descripción y límites |
| --- | --- | --- | --- |
| `name` | `string` | sí | 1-80 caracteres |
| `kind` | `ollama` / `openai` | sí |  |
| `baseUrl` | `string` | sí | Dirección http(s) del proveedor. · 1-sin tope caracteres |
| `apiKey` | `string` o `null` | no | Clave de la API. Omitida al editar = conservar la guardada; `null` o vacía = borrarla. · 0-500 caracteres |
| `defaultModel` | `string` | no | 0-200 caracteres; por defecto `""` |
| `enabled` | `boolean` | no | por defecto `true` |

## Agentes

Agentes: un modelo con su prompt, sus herramientas y sus límites. Se pueden ejecutar solos.

| Método | Ruta | Qué hace |
| --- | --- | --- |
| `GET` | `/api/agents` | Lista los agentes |
| `POST` | `/api/agents` | Crea un agente |
| `GET` | `/api/agents/{id}` | Obtiene un agente |
| `PUT` | `/api/agents/{id}` | Modifica un agente |
| `DELETE` | `/api/agents/{id}` | Elimina un agente que ningún workflow use |
| `POST` | `/api/agents/{id}/duplicate` | Duplica un agente (añade « (copia)» al nombre) |
| `POST` | `/api/agents/{id}/run` | Lanza el agente con una tarea |

### `POST /api/agents`

Cuerpo JSON (`AgentInput`): Datos de un agente.

| Campo | Tipo | Obligatorio | Descripción y límites |
| --- | --- | --- | --- |
| `name` | `string` | sí | 1-80 caracteres |
| `role` | `string` | no | 0-160 caracteres; por defecto `""` |
| `description` | `string` | no | 0-1000 caracteres; por defecto `""` |
| `color` | `string` | no | patrón `^#[0-9a-fA-F]{6}$`; por defecto `"#6366f1"` |
| `providerId` | `string` | sí | Proveedor existente. · 1-sin tope caracteres |
| `model` | `string` | sí | 1-200 caracteres |
| `systemPrompt` | `string` | no | 0-20000 caracteres; por defecto `""` |
| `temperature` | `number` | no | de 0 a 2; por defecto `0.7` |
| `maxTokens` | `integer` o `null` | no | de 16 a 200000; por defecto `null` |
| `maxIterations` | `integer` | no | de 1 a 30; por defecto `8` |
| `tools` | lista de `string` | no | Nombres de herramientas existentes (ver `GET /api/tools`). · 0-50 elementos; por defecto `[]` |
| `thinking` | `boolean` | no | por defecto `false` |

### `PUT /api/agents/{id}`

Cuerpo JSON (`AgentInput`): Datos de un agente.

| Campo | Tipo | Obligatorio | Descripción y límites |
| --- | --- | --- | --- |
| `name` | `string` | sí | 1-80 caracteres |
| `role` | `string` | no | 0-160 caracteres; por defecto `""` |
| `description` | `string` | no | 0-1000 caracteres; por defecto `""` |
| `color` | `string` | no | patrón `^#[0-9a-fA-F]{6}$`; por defecto `"#6366f1"` |
| `providerId` | `string` | sí | Proveedor existente. · 1-sin tope caracteres |
| `model` | `string` | sí | 1-200 caracteres |
| `systemPrompt` | `string` | no | 0-20000 caracteres; por defecto `""` |
| `temperature` | `number` | no | de 0 a 2; por defecto `0.7` |
| `maxTokens` | `integer` o `null` | no | de 16 a 200000; por defecto `null` |
| `maxIterations` | `integer` | no | de 1 a 30; por defecto `8` |
| `tools` | lista de `string` | no | Nombres de herramientas existentes (ver `GET /api/tools`). · 0-50 elementos; por defecto `[]` |
| `thinking` | `boolean` | no | por defecto `false` |

### `POST /api/agents/{id}/run`

La ejecución sigue en segundo plano: se consulta con `GET /api/runs/{id}` o se sigue en vivo con `GET /api/runs/{id}/stream`.

Cuerpo JSON (`RunInput`): Entrada de una ejecución. Para un agente no puede estar vacía.

| Campo | Tipo | Obligatorio | Descripción y límites |
| --- | --- | --- | --- |
| `input` | `string` | no | 0-100000 caracteres; por defecto `""` |

## Herramientas

Herramientas integradas, personalizadas (HTTP) y de servidores MCP.

| Método | Ruta | Qué hace |
| --- | --- | --- |
| `GET` | `/api/tools` | Lista todas las herramientas (integradas, personalizadas y de servidores MCP) |
| `GET` | `/api/tools/custom` | Lista las herramientas personalizadas |
| `POST` | `/api/tools/custom` | Crea una herramienta personalizada |
| `GET` | `/api/tools/custom/{id}` | Obtiene una herramienta personalizada |
| `PUT` | `/api/tools/custom/{id}` | Modifica una herramienta personalizada |
| `DELETE` | `/api/tools/custom/{id}` | Elimina una herramienta personalizada |
| `POST` | `/api/tools/{name}/invoke` | Ejecuta una herramienta a mano (banco de pruebas) |

### `POST /api/tools/custom`

Cuerpo JSON (`CustomToolInput`): Herramienta HTTP personalizada.

| Campo | Tipo | Obligatorio | Descripción y límites |
| --- | --- | --- | --- |
| `name` | `string` | sí | Nombre único; no puede coincidir con una herramienta integrada. · patrón `^[a-z][a-z0-9_]{1,48}$` |
| `description` | `string` | sí | 5-1000 caracteres |
| `parameters` | objeto | sí |  |
| `method` | `GET` / `POST` / `PUT` / `PATCH` / `DELETE` | no | por defecto `"GET"` |
| `urlTemplate` | `string` | sí | URL con parámetros `{{nombre}}`. · 1-2000 caracteres |
| `headers` | mapa de `string` | no | Una cabecera secreta enviada con valor vacío al editar conserva el valor guardado. · por defecto `{}` |
| `bodyTemplate` | `string` | no | 0-20000 caracteres; por defecto `""` |
| `enabled` | `boolean` | no | por defecto `true` |

### `PUT /api/tools/custom/{id}`

Una cabecera secreta enviada vacía conserva el valor guardado, salvo que `urlTemplate` apunte a otro origen: entonces hay que escribirla de nuevo o quitarla (400 `credential_required`).

Cuerpo JSON (`CustomToolInput`): Herramienta HTTP personalizada.

| Campo | Tipo | Obligatorio | Descripción y límites |
| --- | --- | --- | --- |
| `name` | `string` | sí | Nombre único; no puede coincidir con una herramienta integrada. · patrón `^[a-z][a-z0-9_]{1,48}$` |
| `description` | `string` | sí | 5-1000 caracteres |
| `parameters` | objeto | sí |  |
| `method` | `GET` / `POST` / `PUT` / `PATCH` / `DELETE` | no | por defecto `"GET"` |
| `urlTemplate` | `string` | sí | URL con parámetros `{{nombre}}`. · 1-2000 caracteres |
| `headers` | mapa de `string` | no | Una cabecera secreta enviada con valor vacío al editar conserva el valor guardado. · por defecto `{}` |
| `bodyTemplate` | `string` | no | 0-20000 caracteres; por defecto `""` |
| `enabled` | `boolean` | no | por defecto `true` |

### `POST /api/tools/{name}/invoke`

Tiene un límite de 30 s. Un fallo de la herramienta no es un error HTTP: la respuesta es 200 con `ok: false`.

Cuerpo JSON (`ToolInvokeInput`): Argumentos de la herramienta.

| Campo | Tipo | Obligatorio | Descripción y límites |
| --- | --- | --- | --- |
| `args` | objeto | no | por defecto `{}` |

## Espacio de trabajo

Archivos que los agentes crean y leen en la carpeta de trabajo.

| Método | Ruta | Qué hace |
| --- | --- | --- |
| `GET` | `/api/workspace/files` | Lista los archivos del espacio de trabajo |
| `GET` | `/api/workspace/file` | Lee un archivo (como mucho los primeros 500 000 bytes) |
| `DELETE` | `/api/workspace/file` | Elimina un archivo |

### `GET /api/workspace/file`

Parámetros de consulta:

| Nombre | Tipo | Obligatorio | Descripción |
| --- | --- | --- | --- |
| `path` | `string` | sí | Ruta relativa al espacio de trabajo. |

### `DELETE /api/workspace/file`

Parámetros de consulta:

| Nombre | Tipo | Obligatorio | Descripción |
| --- | --- | --- | --- |
| `path` | `string` | sí | Ruta relativa al espacio de trabajo. |

## Servidores MCP

Servidores del Model Context Protocol que ofrecen herramientas a los agentes.

| Método | Ruta | Qué hace |
| --- | --- | --- |
| `GET` | `/api/mcp/servers` | Lista los servidores MCP con su estado y sus herramientas |
| `POST` | `/api/mcp/servers` | Añade un servidor MCP y espera (con tope) a que conecte |
| `PUT` | `/api/mcp/servers/{id}` | Modifica un servidor MCP y vuelve a conectarlo |
| `DELETE` | `/api/mcp/servers/{id}` | Elimina un servidor MCP y desconecta |
| `POST` | `/api/mcp/servers/{id}/reconnect` | Vuelve a conectar y a leer la lista de herramientas |

### `POST /api/mcp/servers`

Cuerpo JSON (`McpServerInput`): Servidor MCP. `stdio` exige `command`; `http`, una `url` http(s).

| Campo | Tipo | Obligatorio | Descripción y límites |
| --- | --- | --- | --- |
| `name` | `string` | sí | patrón `^[a-z][a-z0-9_]{1,19}$` |
| `transport` | `stdio` / `http` | sí |  |
| `command` | `string` | no | 0-500 caracteres; por defecto `""` |
| `args` | lista de `string` | no | 0-50 elementos; por defecto `[]` |
| `env` | mapa de `string` | no | Variables de entorno (stdio). Omitido al editar = conservar las guardadas; si cambia `command` hay que enviarlas de nuevo (400 `credential_required`). |
| `url` | `string` | no | 0-2000 caracteres; por defecto `""` |
| `headers` | mapa de `string` | no | Cabeceras (http). Omitido al editar = conservar las guardadas; si cambia el origen de `url` hay que enviarlas de nuevo (400 `credential_required`). |
| `enabled` | `boolean` | no | por defecto `true` |

### `PUT /api/mcp/servers/{id}`

Cuerpo JSON (`McpServerInput`): Servidor MCP. `stdio` exige `command`; `http`, una `url` http(s).

| Campo | Tipo | Obligatorio | Descripción y límites |
| --- | --- | --- | --- |
| `name` | `string` | sí | patrón `^[a-z][a-z0-9_]{1,19}$` |
| `transport` | `stdio` / `http` | sí |  |
| `command` | `string` | no | 0-500 caracteres; por defecto `""` |
| `args` | lista de `string` | no | 0-50 elementos; por defecto `[]` |
| `env` | mapa de `string` | no | Variables de entorno (stdio). Omitido al editar = conservar las guardadas; si cambia `command` hay que enviarlas de nuevo (400 `credential_required`). |
| `url` | `string` | no | 0-2000 caracteres; por defecto `""` |
| `headers` | mapa de `string` | no | Cabeceras (http). Omitido al editar = conservar las guardadas; si cambia el origen de `url` hay que enviarlas de nuevo (400 `credential_required`). |
| `enabled` | `boolean` | no | por defecto `true` |

## Workflows

Grafos de nodos que encadenan agentes, herramientas, condiciones y aprobaciones.

| Método | Ruta | Qué hace |
| --- | --- | --- |
| `GET` | `/api/workflows` | Lista los workflows |
| `POST` | `/api/workflows` | Crea un workflow |
| `GET` | `/api/workflows/{id}` | Obtiene un workflow con sus nodos y aristas |
| `PUT` | `/api/workflows/{id}` | Modifica un workflow |
| `DELETE` | `/api/workflows/{id}` | Elimina un workflow que ningún otro use como subworkflow |
| `POST` | `/api/workflows/validate` | Valida un workflow sin guardarlo |
| `POST` | `/api/workflows/{id}/duplicate` | Duplica un workflow (añade « (copia)» al nombre) |
| `POST` | `/api/workflows/{id}/run` | Lanza un workflow con una entrada |

### `POST /api/workflows`

Cuerpo JSON (`WorkflowInput`): Definición de un workflow. Además de este esquema se comprueba el grafo con `POST /api/workflows/validate`.

| Campo | Tipo | Obligatorio | Descripción y límites |
| --- | --- | --- | --- |
| `name` | `string` | sí | 1-120 caracteres |
| `description` | `string` | no | 0-2000 caracteres; por defecto `""` |
| `nodes` | lista de objeto | sí | Hasta 100 nodos. · 0-100 elementos |
| `edges` | lista de objeto | sí | Hasta 400 aristas. · 0-400 elementos |
| `settings` | objeto | no | por defecto `{"maxConcurrency":4,"maxDurationMs":900000,"maxLlmCalls":40,"onError":"fail","defaultRetries":1}` |

### `PUT /api/workflows/{id}`

Cuerpo JSON (`WorkflowInput`): Definición de un workflow. Además de este esquema se comprueba el grafo con `POST /api/workflows/validate`.

| Campo | Tipo | Obligatorio | Descripción y límites |
| --- | --- | --- | --- |
| `name` | `string` | sí | 1-120 caracteres |
| `description` | `string` | no | 0-2000 caracteres; por defecto `""` |
| `nodes` | lista de objeto | sí | Hasta 100 nodos. · 0-100 elementos |
| `edges` | lista de objeto | sí | Hasta 400 aristas. · 0-400 elementos |
| `settings` | objeto | no | por defecto `{"maxConcurrency":4,"maxDurationMs":900000,"maxLlmCalls":40,"onError":"fail","defaultRetries":1}` |

### `POST /api/workflows/validate`

Comprueba el grafo contra los agentes, las herramientas y los demás workflows (subworkflows y ciclos). Acepta además un `id` opcional: el workflow que se está editando, para detectar que se llame a sí mismo.

Cuerpo JSON (`WorkflowInput`): Definición de un workflow. Además de este esquema se comprueba el grafo con `POST /api/workflows/validate`.

| Campo | Tipo | Obligatorio | Descripción y límites |
| --- | --- | --- | --- |
| `name` | `string` | sí | 1-120 caracteres |
| `description` | `string` | no | 0-2000 caracteres; por defecto `""` |
| `nodes` | lista de objeto | sí | Hasta 100 nodos. · 0-100 elementos |
| `edges` | lista de objeto | sí | Hasta 400 aristas. · 0-400 elementos |
| `settings` | objeto | no | por defecto `{"maxConcurrency":4,"maxDurationMs":900000,"maxLlmCalls":40,"onError":"fail","defaultRetries":1}` |

### `POST /api/workflows/{id}/run`

Se valida antes: con errores responde 422 y `details.issues` lista los problemas.

Cuerpo JSON (`RunInput`): Entrada de una ejecución. Para un agente no puede estar vacía.

| Campo | Tipo | Obligatorio | Descripción y límites |
| --- | --- | --- | --- |
| `input` | `string` | no | 0-100000 caracteres; por defecto `""` |

## Disparadores

Lo que lanza un workflow sin intervención: intervalo, hora diaria, cron o webhook.

| Método | Ruta | Qué hace |
| --- | --- | --- |
| `GET` | `/api/triggers` | Lista los disparadores de todos los workflows |
| `GET` | `/api/workflows/{id}/triggers` | Lista los disparadores de un workflow |
| `POST` | `/api/workflows/{id}/triggers` | Crea un disparador para un workflow |
| `POST` | `/api/triggers/preview` | Calcula las próximas cinco ocasiones de un horario sin guardarlo |
| `PUT` | `/api/triggers/{id}` | Modifica un disparador |
| `DELETE` | `/api/triggers/{id}` | Elimina un disparador |
| `POST` | `/api/triggers/{id}/run` | Lanza ahora un disparador con su entrada guardada |
| `POST` | `/api/triggers/{id}/secret` | Regenera el secreto de un webhook |

### `POST /api/workflows/{id}/triggers`

Un workflow admite como máximo 20. Al crear un webhook la respuesta trae su `secret`, que no se vuelve a mostrar.

Cuerpo JSON (`TriggerInput`): Disparador. `interval` exige `intervalMinutes`; `daily`, `time`; `cron`, `cron`. Un webhook no lleva horario.

| Campo | Tipo | Obligatorio | Descripción y límites |
| --- | --- | --- | --- |
| `kind` | `interval` / `daily` / `cron` / `webhook` | sí |  |
| `name` | `string` | no | 0-80 caracteres; por defecto `""` |
| `intervalMinutes` | `integer` o `null` | no | de 1 a 43200; por defecto `null` |
| `time` | `string` o `null` | no | patrón `^([01]\d\|2[0-3]):[0-5]\d$`; por defecto `null` |
| `weekdays` | lista de `integer` | no | 0-7 elementos; por defecto `[]` |
| `cron` | `string` o `null` | no | 0-200 caracteres; por defecto `null` |
| `timezone` | `string` o `null` | no | Zona horaria IANA (`Europe/Madrid`); vacía = la del equipo. · 0-64 caracteres; por defecto `null` |
| `input` | `string` | no | Entrada de cada ejecución; en un webhook, plantilla con `{{body}}`. · 0-100000 caracteres; por defecto `""` |
| `enabled` | `boolean` | no | por defecto `true` |

### `POST /api/triggers/preview`

Cuerpo JSON (`TriggerInput`): Disparador. `interval` exige `intervalMinutes`; `daily`, `time`; `cron`, `cron`. Un webhook no lleva horario.

| Campo | Tipo | Obligatorio | Descripción y límites |
| --- | --- | --- | --- |
| `kind` | `interval` / `daily` / `cron` / `webhook` | sí |  |
| `name` | `string` | no | 0-80 caracteres; por defecto `""` |
| `intervalMinutes` | `integer` o `null` | no | de 1 a 43200; por defecto `null` |
| `time` | `string` o `null` | no | patrón `^([01]\d\|2[0-3]):[0-5]\d$`; por defecto `null` |
| `weekdays` | lista de `integer` | no | 0-7 elementos; por defecto `[]` |
| `cron` | `string` o `null` | no | 0-200 caracteres; por defecto `null` |
| `timezone` | `string` o `null` | no | Zona horaria IANA (`Europe/Madrid`); vacía = la del equipo. · 0-64 caracteres; por defecto `null` |
| `input` | `string` | no | Entrada de cada ejecución; en un webhook, plantilla con `{{body}}`. · 0-100000 caracteres; por defecto `""` |
| `enabled` | `boolean` | no | por defecto `true` |

### `PUT /api/triggers/{id}`

Un webhook no se puede convertir en uno con horario, ni al revés (400).

Cuerpo JSON (`TriggerInput`): Disparador. `interval` exige `intervalMinutes`; `daily`, `time`; `cron`, `cron`. Un webhook no lleva horario.

| Campo | Tipo | Obligatorio | Descripción y límites |
| --- | --- | --- | --- |
| `kind` | `interval` / `daily` / `cron` / `webhook` | sí |  |
| `name` | `string` | no | 0-80 caracteres; por defecto `""` |
| `intervalMinutes` | `integer` o `null` | no | de 1 a 43200; por defecto `null` |
| `time` | `string` o `null` | no | patrón `^([01]\d\|2[0-3]):[0-5]\d$`; por defecto `null` |
| `weekdays` | lista de `integer` | no | 0-7 elementos; por defecto `[]` |
| `cron` | `string` o `null` | no | 0-200 caracteres; por defecto `null` |
| `timezone` | `string` o `null` | no | Zona horaria IANA (`Europe/Madrid`); vacía = la del equipo. · 0-64 caracteres; por defecto `null` |
| `input` | `string` | no | Entrada de cada ejecución; en un webhook, plantilla con `{{body}}`. · 0-100000 caracteres; por defecto `""` |
| `enabled` | `boolean` | no | por defecto `true` |

## Webhooks

Receptor de llamadas externas que lanzan un workflow, autenticado con el secreto del disparador.

| Método | Ruta | Qué hace |
| --- | --- | --- |
| `POST` | `/api/hooks/{id}` | Lanza el workflow de un disparador de tipo webhook |

### `POST /api/hooks/{id}`

No exige la clave de acceso de la interfaz: se autentica con el secreto del disparador, de una de estas formas:

- `X-AgentForge-Secret: <secreto>`.
- `Authorization: Bearer <secreto>`.
- `X-AgentForge-Signature: sha256=<firma>`: HMAC-SHA256 en hexadecimal del cuerpo en bruto, con el secreto como clave. Si viene, se usa esta y no las anteriores.

El cuerpo (hasta 1 MiB) se lee en bruto, sea del tipo que sea. La entrada de la ejecución es el campo `input` de un cuerpo JSON si es texto y, si no, el cuerpo como texto (máximo 100 000 caracteres). Si el disparador tiene una plantilla de entrada, `{{body}}` se sustituye por ese texto. Un secreto incorrecto y un webhook inexistente dan la misma respuesta 401.

Cuerpo JSON (`WebhookBody`): Cuerpo JSON de la llamada. Se admite cualquier otro tipo de contenido: se usa como texto.

| Campo | Tipo | Obligatorio | Descripción y límites |
| --- | --- | --- | --- |
| `input` | `string` | no | Si viene y es texto, es la entrada de la ejecución; si no, se usa el cuerpo entero como texto. |

## Ejecuciones

Ejecuciones de agentes y de workflows: historial, cancelación, reintento y reanudación.

| Método | Ruta | Qué hace |
| --- | --- | --- |
| `GET` | `/api/runs` | Historial de ejecuciones, con filtros y paginación |
| `DELETE` | `/api/runs` | Elimina todas las ejecuciones terminadas |
| `GET` | `/api/runs/interrupted` | Ejecuciones que un apagado dejó a medias y siguen pendientes |
| `POST` | `/api/runs/interrupted/resume` | Reanuda las ejecuciones interrumpidas indicadas (o todas) |
| `POST` | `/api/runs/interrupted/dismiss` | Descarta el aviso de reanudación: las ejecuciones quedan como fallidas |
| `GET` | `/api/runs/{id}` | Obtiene una ejecución completa, con su definición y sus pasos |
| `DELETE` | `/api/runs/{id}` | Elimina una ejecución terminada |
| `GET` | `/api/runs/{id}/events` | Eventos guardados de una ejecución, por orden |
| `POST` | `/api/runs/{id}/cancel` | Cancela una ejecución en curso |
| `POST` | `/api/runs/{id}/retry` | Reintenta una ejecución terminada, desde cero o solo lo que falló |
| `GET` | `/api/runs/{id}/children` | Subejecuciones (subworkflows) que lanzó una ejecución |
| `GET` | `/api/runs/{id}/steps/{nodeId}/items` | Resultado de cada elemento de un nodo «para cada» |

### `GET /api/runs`

Parámetros de consulta:

| Nombre | Tipo | Obligatorio | Descripción |
| --- | --- | --- | --- |
| `status` | `queued` / `running` / `waiting` / `completed` / `failed` / `cancelled` | no | Solo ejecuciones en este estado. |
| `kind` | `agent` / `workflow` | no | Solo de este tipo. |
| `workflowId` | `string` | no | Solo las de este workflow. · 0-64 caracteres |
| `agentId` | `string` | no | Solo las de este agente. · 0-64 caracteres |
| `search` | `string` | no | Texto a buscar en el nombre, la entrada, la salida y el error. · 0-200 caracteres |
| `limit` | `integer` | no | Tamaño de página (1-200; por defecto 50). · de 1 a 200 |
| `offset` | `integer` | no | Elementos a saltar (0 o más). · de 0 a sin máximo |

### `POST /api/runs/interrupted/resume`

Reutiliza los pasos que ya habían terminado y devuelve las ejecuciones nuevas.

Cuerpo JSON (opcional) (`RunIdsInput`): Ejecuciones interrumpidas a las que se aplica la acción; omitido = todas.

| Campo | Tipo | Obligatorio | Descripción y límites |
| --- | --- | --- | --- |
| `ids` | lista de `string` | no | 0-500 elementos |

### `POST /api/runs/interrupted/dismiss`

Cuerpo JSON (opcional) (`RunIdsInput`): Ejecuciones interrumpidas a las que se aplica la acción; omitido = todas.

| Campo | Tipo | Obligatorio | Descripción y límites |
| --- | --- | --- | --- |
| `ids` | lista de `string` | no | 0-500 elementos |

### `GET /api/runs/{id}/events`

Parámetros de consulta:

| Nombre | Tipo | Obligatorio | Descripción |
| --- | --- | --- | --- |
| `after` | `integer` | no | Devuelve solo eventos posteriores a este número de secuencia (0 o más). · de 0 a sin máximo |

### `POST /api/runs/{id}/retry`

Cuerpo JSON (opcional) (`RetryInput`): Cómo reintentar: `all` desde cero; `failed` reutiliza los pasos que ya terminaron bien.

| Campo | Tipo | Obligatorio | Descripción y límites |
| --- | --- | --- | --- |
| `mode` | `all` / `failed` | no | por defecto `"all"` |

## Aprobaciones

Aprobaciones humanas que detienen una ejecución hasta que alguien decide.

| Método | Ruta | Qué hace |
| --- | --- | --- |
| `GET` | `/api/approvals` | Aprobaciones pendientes o, con `runId`, todas las de una ejecución |
| `POST` | `/api/approvals/{id}/decide` | Aprueba o rechaza una aprobación pendiente |

### `GET /api/approvals`

Parámetros de consulta:

| Nombre | Tipo | Obligatorio | Descripción |
| --- | --- | --- | --- |
| `runId` | `string` | no | Si se indica, devuelve todas las aprobaciones de esa ejecución (con su decisión); si no, solo las pendientes. |

### `POST /api/approvals/{id}/decide`

Responde 409 si la aprobación ya no está pendiente (decidida, cancelada o sin ejecución esperando).

Cuerpo JSON (`ApprovalDecisionInput`): Decisión sobre una aprobación pendiente.

| Campo | Tipo | Obligatorio | Descripción y límites |
| --- | --- | --- | --- |
| `approved` | `boolean` | sí |  |
| `comment` | `string` | no | 0-2000 caracteres; por defecto `""` |

## Importación y exportación

Archivos portables de workflows y agentes; la importación se hace en dos pasos (plan y aplicación).

| Método | Ruta | Qué hace |
| --- | --- | --- |
| `GET` | `/api/workflows/{id}/export` | Exporta un workflow con los agentes, herramientas y disparadores que usa (sin claves) |
| `GET` | `/api/agents/{id}/export` | Exporta un agente con sus herramientas HTTP y su proveedor (sin claves) |
| `POST` | `/api/import/plan` | Primer paso de una importación: qué trae el archivo y cómo encaja con lo que ya hay |
| `POST` | `/api/import` | Segundo paso: aplica la importación con las decisiones tomadas |
| `POST` | `/api/workflows/import` | Importa un workflow exportado con las acciones recomendadas, sin revisión previa |

### `POST /api/import/plan`

No cambia nada.

Cuerpo JSON (`ImportPlanRequest`): 

| Campo | Tipo | Obligatorio | Descripción y límites |
| --- | --- | --- | --- |
| `bundle` | `WorkflowBundle` o `AgentBundle` | sí | Contenido del archivo exportado. |

### `POST /api/import`

Es atómica: si algo falla, no se crea nada. Las decisiones que falten usan la acción recomendada del plan.

Cuerpo JSON (`ImportRequest`): 

| Campo | Tipo | Obligatorio | Descripción y límites |
| --- | --- | --- | --- |
| `bundle` | `WorkflowBundle` o `AgentBundle` | sí | Contenido del archivo exportado. |
| `decisions` | `ImportDecisions` | no |  |

### `POST /api/workflows/import`

Pensada para automatizar y por compatibilidad; la interfaz usa `POST /api/import/plan` y `POST /api/import`.

Cuerpo JSON (`WorkflowBundle`): Archivo de workflow exportado (formato `agentforge.workflow`, versiones 1 y 2).

| Campo | Tipo | Obligatorio | Descripción y límites |
| --- | --- | --- | --- |
| `format` | `string` | sí |  |
| `version` | `number` o `number` | sí |  |
| `workflow` | objeto | sí |  |
| `agents` | lista de objeto | no | 0-100 elementos; por defecto `[]` |
| `providers` | lista de objeto | no | 0-20 elementos; por defecto `[]` |
| `tools` | lista de objeto | no | 0-100 elementos; por defecto `[]` |
| `subworkflows` | lista de objeto | no | 0-20 elementos; por defecto `[]` |
| `triggers` | lista de objeto | no | 0-20 elementos |

## Copias de seguridad

Copias completas de los datos (base de datos, clave maestra y espacio de trabajo) y su restauración.

| Método | Ruta | Qué hace |
| --- | --- | --- |
| `GET` | `/api/backups` | Lista las copias, la restauración pendiente y la última aplicada |
| `POST` | `/api/backups` | Crea una copia completa de los datos |
| `POST` | `/api/backups/upload` | Sube un archivo de copia |
| `DELETE` | `/api/backups/restore/pending` | Cancela la restauración preparada |
| `DELETE` | `/api/backups/{name}` | Elimina una copia |
| `GET` | `/api/backups/{name}/download` | Descarga el archivo de una copia |
| `POST` | `/api/backups/{name}/restore` | Valida una copia y la deja preparada para restaurarla |

### `POST /api/backups/upload`

El cuerpo es el archivo tal cual (`application/octet-stream`); se valida antes de aceptarlo y no se carga en memoria.

Cuerpo: `application/octet-stream`.

## Ajustes

Ajustes globales y estado de los aislamientos de `run_javascript`.

| Método | Ruta | Qué hace |
| --- | --- | --- |
| `GET` | `/api/settings` | Ajustes globales |
| `PUT` | `/api/settings` | Modifica los ajustes indicados |
| `GET` | `/api/sandbox/status` | Estado real de los aislamientos de `run_javascript` |

### `PUT /api/settings`

Un cambio en la retención se aplica en el momento. Elegir `codeSandbox: container` exige que haya un motor de contenedores disponible (409 si no).

Cuerpo JSON (`SettingsInput`): Cambio parcial de ajustes: solo se modifican los campos enviados.

| Campo | Tipo | Obligatorio | Descripción y límites |
| --- | --- | --- | --- |
| `maxConcurrentRuns` | `integer` | no | de 1 a 10 |
| `allowPrivateNetwork` | `boolean` | no |  |
| `allowCodeExecution` | `boolean` | no |  |
| `codeSandbox` | `process` / `container` | no |  |
| `autoResume` | `boolean` | no |  |
| `retentionDays` | `integer` | no | de 0 a 3650 |
| `retentionMaxRuns` | `integer` | no | de 0 a 100000 |

### `GET /api/sandbox/status`

Parámetros de consulta:

| Nombre | Tipo | Obligatorio | Descripción |
| --- | --- | --- | --- |
| `force` | `1` | no | Con `1` se ignora la caché y se vuelve a comprobar. |

## Eventos en vivo

Flujos de eventos del servidor (SSE) para interfaces en vivo.

| Método | Ruta | Qué hace |
| --- | --- | --- |
| `GET` | `/api/stream/approvals` | Avisa cada vez que cambia el conjunto de aprobaciones pendientes |
| `GET` | `/api/stream/runs` | Cambios de estado de todas las ejecuciones (listas y panel en vivo) |
| `GET` | `/api/runs/{id}/stream` | Eventos de una ejecución en tiempo real, con reproducción del historial |

### `GET /api/runs/{id}/stream`

Flujo de eventos del servidor (`text/event-stream`): la conexión queda abierta. Cada ~15 s llega un comentario `: ping` para mantenerla viva y el servidor sugiere reconectar a los 2 s (`retry: 2000`). Si un cliente no lee y se le acumulan más de 8 MiB, se le corta la conexión.

Evento `run-event`: `data` es un `RunEvent` y `id` su `seq`. Al conectar se reproduce primero el historial guardado, por tandas de 500, a partir del número indicado en la cabecera `Last-Event-ID` o, si no viene, en `?after=` (0 por defecto); después llegan los eventos nuevos sin perder ni repetir ninguno.
Un navegador (`EventSource`) reconecta solo y envía `Last-Event-ID` con el último `id` recibido.
Tras el historial se envían eventos `llm.snapshot` (con `seq: null` y sin `id`) con el texto que cada nodo lleva generado, y los deltas de streaming (`llm.delta`) también tienen `seq: null`.
La conexión no se cierra al terminar la ejecución: el evento `run.finished` marca el final.

Parámetros de consulta y cabeceras:

| Nombre | Tipo | Obligatorio | Descripción |
| --- | --- | --- | --- |
| `after` | `integer` | no | Devuelve solo eventos posteriores a este número de secuencia (0 o más). · de 0 a sin máximo |
| `Last-Event-ID` (cabecera) | `integer` | no | Último `seq` recibido; tiene prioridad sobre `?after=`. · de 0 a sin máximo |

## Esquemas de respuesta

Los objetos que devuelve la API (`Agent`, `Workflow`, `Run`, `RunEvent`, `Trigger`, `Settings`…) están descritos campo a campo en `components.schemas` de la especificación (`GET /api/openapi.json`).
