# AgentForge

Plataforma web local para crear, gestionar y ejecutar sistemas de agentes de IA: define agentes (modelo,
instrucciones, herramientas), conéctalos en workflows visuales y observa su ejecución en tiempo real.
Funciona al 100 % en tu equipo con [Ollama](https://ollama.com); opcionalmente con cualquier API
compatible con OpenAI.

## Requisitos

- **Node.js ≥ 22.13** (probado con v24.19; usa el módulo integrado `node:sqlite`).
- **Ollama** en marcha con al menos un modelo de chat (recomendado uno con soporte de herramientas, p. ej.
  `ollama pull qwen3:8b`). Sin Ollama la aplicación arranca igual, pero no podrá ejecutar agentes hasta que
  configures un proveedor en *Ajustes*.

## Puesta en marcha

```bash
npm install        # instala servidor y frontend (workspaces)
npm run build      # compila el frontend en web/dist
npm start          # API + interfaz en http://127.0.0.1:4310
```

En el primer arranque, si la base de datos está vacía, se crean datos de ejemplo: un proveedor «Ollama
local», cinco agentes y dos workflows (el modelo se elige automáticamente: el más ligero con soporte de
herramientas que tengas instalado).

### Desarrollo

```bash
npm run dev        # API (recarga con tsx watch) + Vite en http://localhost:5173
npm test           # tests del servidor y del frontend (unidad, API y componentes)
npm run test:e2e   # tests end-to-end en Chromium (Playwright) contra el servidor real
npm run typecheck  # tsc + vue-tsc + tipos de la suite e2e
```

La suite end-to-end necesita el navegador de Playwright (`npx playwright install chromium`, solo la primera
vez). Arranca su propio servidor en un puerto libre con datos temporales y un modelo simulado determinista,
así que no toca `data/` ni necesita Ollama. Detalles en [e2e/README.md](e2e/README.md).

### Configuración (variables de entorno)

| Variable | Por defecto | Uso |
|---|---|---|
| `PORT` | `4310` | Puerto del servidor |
| `HOST` | `127.0.0.1` | Interfaz de red (solo local por defecto) |
| `AGENTFORGE_DATA_DIR` | `./data` | Base de datos, clave de cifrado y espacio de trabajo |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama usado para los datos de ejemplo |
| `AGENTFORGE_DEFAULT_MODEL` | (autodetectado) | Modelo de los agentes de ejemplo |
| `AGENTFORGE_SEED` | `1` | `0` para no crear datos de ejemplo |
| `AGENTFORGE_TOKEN` | (sin clave) | Clave de acceso a la API (16 caracteres o más). **Obligatoria si `HOST` no es local** |
| `AGENTFORGE_ALLOWED_HOSTS` | (ninguno) | Nombres adicionales por los que se llega al servidor, separados por comas (p. ej. detrás de un proxy) |
| `AGENTFORGE_LOG_LEVEL` | `info` | `silent`, `error`, `warn`, `info` o `debug` (este añade una línea por petición) |
| `AGENTFORGE_RATE_LIMIT` | `1200` | Peticiones por minuto y cliente a la API (0 = sin límite) |
| `AGENTFORGE_SHUTDOWN_GRACE_MS` | `10000` | Tiempo máximo que el apagado espera a las ejecuciones en curso |
| `AGENTFORGE_SCHEDULER_TICK_MS` | `5000` | Cada cuánto se comprueban las programaciones vencidas (mínimo 250) |
| `AGENTFORGE_TEST_MODEL` | (autodetectado) | Modelo de los tests de integración |

La configuración se valida al arrancar: un valor incorrecto detiene el servidor con un mensaje que nombra la
variable. `AGENTFORGE_LOG=0/1` se sigue aceptando (equivale a `silent`/`debug`). El registro es JSON, una línea por
suceso, por la salida estándar; las credenciales nunca se escriben.

En *Ajustes → Datos* se configura la **retención del historial**: días que se conservan las ejecuciones
terminadas y número máximo de ejecuciones guardadas (0 = sin límite, el valor por defecto). Se aplica al
arrancar, cada hora, al terminar cada ejecución y al cambiar el ajuste.

Todos los datos viven en `data/` (`agentforge.db`, `secret.key`, `workspace/`). Borrar esa carpeta deja la
aplicación como recién instalada. Solo puede usarla un servidor a la vez (`agentforge.lock`). Antes de actualizar
el esquema de la base de datos se guarda una copia (`agentforge.db.v<N>.bak`).

### Parar el servidor

Ctrl+C (o `SIGTERM`) hace un apagado ordenado: las ejecuciones en curso quedan **interrumpidas**, no canceladas,
y al volver a arrancar la interfaz ofrece reanudarlas reutilizando los pasos ya terminados. Lo mismo ocurre si el
proceso muere de golpe. Un segundo Ctrl+C fuerza la salida. Sondas para un orquestador: `GET /api/health/live`
(el proceso atiende) y `GET /api/health/ready` (base de datos, carpeta de datos y planificador; 503 si falla algo).

## Qué incluye

- **Panel** con cifras reales: ejecuciones, tasa de éxito, duración media, tokens, actividad de 14 días,
  ejecuciones en curso (en vivo), salud de los proveedores, agentes y herramientas más usados.
- **Agentes**: editor con proveedor/modelo (lista real del proveedor), temperatura, límites, razonamiento,
  instrucciones y herramientas; **banco de pruebas** con respuesta en streaming.
- **Workflows**: constructor visual (Vue Flow) con paleta, inspector, plantillas `{{input}}`,
  `{{upstream}}`, `{{id_nodo}}`, validación en vivo (ciclos, referencias, agentes eliminados…).
  Nodos: entrada, agente, herramienta, condición (ramas sí/no), **para cada** (repite una tarea con cada
  elemento de una lista, varios a la vez), transformación y salida.
- **Exportar e importar** workflows como archivos JSON (con los agentes que usan) y **ejecución programada**
  (cada cierto tiempo o a una hora fija cada día).
- **Motor**: ejecución del grafo con paralelismo y límite de concurrencia, dependencias, ramas
  condicionales, reintentos con backoff, timeout por nodo, duración máxima, límite de llamadas al modelo,
  política de error (detener/continuar), cancelación, cola global, delegación entre agentes y memoria
  compartida por ejecución.
- **Ejecuciones**: historial con filtros, monitor en vivo (grafo con estados, streaming de tokens,
  registro de actividad con llamadas a herramientas), cancelar, repetir y **reintentar desde el fallo**
  reutilizando los pasos completados. Si el servidor se apaga con ejecuciones a medias, al volver la interfaz
  ofrece **reanudarlas** (o descartarlas) desde cualquier pantalla.
- **Herramientas**: 11 integradas (calculadora, fecha, leer web, HTTP, archivos, memoria compartida,
  delegación, JavaScript aislado), herramientas HTTP personalizadas creadas desde la interfaz, banco de
  pruebas y visor del espacio de trabajo.
- **Ajustes**: proveedores (Ollama y compatibles con OpenAI) con prueba de conexión, límites y permisos.
- **Glosario** integrado: los términos técnicos muestran su definición al pasar el ratón, enfocar o tocar.

## Arquitectura

```
shared/   Tipos del dominio, plantillas {{ref}} y validación de grafos (los usan servidor y frontend)
server/   Node + TypeScript (tsx) + Fastify 5 + node:sqlite
  src/db        esquema, migraciones y Store
  src/crypto    cifrado AES-256-GCM de las API keys
  src/llm       adaptadores Ollama nativo y OpenAI-compatible (streaming + tool-calls)
  src/tools     registro, herramientas integradas, validación, protección SSRF, sandbox
  src/engine    agent-runner, workflow-engine, run-manager, scheduler
  src/routes    API REST + SSE
  test/         tests de unidad, protocolo, motor, API, persistencia e integración con Ollama
web/      Vue 3 + Vite + Pinia + Vue Router + Vue Flow
  src/**/*.test.ts   tests de lógica y de componentes (Vitest + Vue Test Utils, contra la API real)
e2e/      Suite end-to-end (Playwright) y servidor que simula el protocolo de Ollama/OpenAI
```

Decisiones y su porqué en [PLAN.md](PLAN.md); estado y problemas resueltos en [PROGRESS.md](PROGRESS.md);
evidencias de pruebas en [TEST_RESULTS.md](TEST_RESULTS.md).

### Añadir una herramienta en código

Crea un objeto `ToolDefinition` (nombre, descripción, esquema de parámetros y `execute`) y añádelo a
`BUILTIN_TOOLS` en `server/src/tools/builtin.ts`, o regístralo con `registry.register(...)`. Aparecerá en
el catálogo, en el editor de agentes y en el constructor sin tocar el frontend.

## Seguridad

- El servidor escucha solo en `127.0.0.1`. Rechaza siempre las peticiones con un `Host` que no sea suyo (DNS
  rebinding) y las que proceden de otra web (CSRF), y responde con una política de contenido estricta (CSP),
  `X-Frame-Options: DENY` y `nosniff`.
- **Para usarlo desde otros equipos** hace falta una clave de acceso: con `HOST=0.0.0.0` (o cualquier dirección que
  no sea local) el servidor **no arranca** si no se define `AGENTFORGE_TOKEN`. La interfaz la pide al entrar; los
  clientes de API la envían como `Authorization: Bearer <clave>`. Detrás de un proxy inverso, declara su nombre en
  `AGENTFORGE_ALLOWED_HOSTS`. No hay cuentas ni permisos: quien tiene la clave puede hacerlo todo.
- Las API keys de los proveedores se cifran en reposo (AES-256-GCM), la API nunca las devuelve y **no se envían a
  una dirección distinta de aquella para la que se guardaron**: si cambias la URL de un proveedor hay que volver a
  escribir la clave. Las cabeceras de las herramientas HTTP personalizadas, en cambio, se guardan en claro.
- Hay un límite de peticiones por cliente, más estricto para lo que lanza ejecuciones y para el inicio de sesión.
- Las herramientas de red bloquean por defecto localhost y redes privadas (SSRF), también en redirecciones y
  en cualquier notación de la dirección (IPv4 mapeada en IPv6, decimal, NAT64…). La conexión se hace siempre a la
  IP que se validó (**fijación de DNS**), así que un DNS malicioso no puede cambiarla entre la comprobación y la
  conexión (DNS rebinding). Al seguir una redirección hacia otro sitio no se reenvían las cabeceras de la
  herramienta (credenciales), y nunca pueden llamar a la propia API de AgentForge.
- Las herramientas de archivos están confinadas a `data/workspace`.
- `run_javascript` está desactivada por defecto. Al activarla se elige en *Ajustes* dónde corre el código:
  - **Proceso aislado** (por defecto): un contexto `node:vm` vacío (sin `require`, `process`, `fetch`,
    temporizadores ni `eval`) dentro de un **proceso hijo** lanzado con el modelo de permisos de Node
    (`--permission`) y sin variables de entorno, con límites de tiempo (5 s), memoria (64 MB) y tamaño de salida.
    El proceso **no tiene red**: donde Node ofrece permiso de red lo deniega el propio modelo de permisos; en
    Node 22–24, que no lo ofrece, el proceso inutiliza sus API de red antes de ejecutar nada. El servidor lo
    comprueba con una conexión real y Ajustes muestra el resultado.
    **Lo que NO es:** no es una frontera del sistema operativo. `node:vm` no está diseñado para código hostil.
  - **Contenedor** (Docker o Podman): el mismo programa en un contenedor sin red (`--network none`), de solo
    lectura, sin privilegios ni capacidades y con límites de memoria, CPU y procesos. Es la opción para código en
    el que no confíes. Necesita el motor en marcha y la imagen `node:24-alpine` descargada (`docker pull
    node:24-alpine`); AgentForge no la descarga por su cuenta.
- El espacio de trabajo tiene cuota: 5 MB por archivo y 100 MB en total.
- La salida de los modelos se renderiza como Markdown saneado con DOMPurify.

## Limitaciones conocidas

Ver la sección «Pendiente y limitaciones» de [PROGRESS.md](PROGRESS.md).
