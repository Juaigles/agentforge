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
| `AGENTFORGE_LOG` | `0` | `1` para activar el log de peticiones |
| `AGENTFORGE_TEST_MODEL` | (autodetectado) | Modelo de los tests de integración |

En *Ajustes → Datos* se configura la **retención del historial**: días que se conservan las ejecuciones
terminadas y número máximo de ejecuciones guardadas (0 = sin límite, el valor por defecto). Se aplica al
arrancar, cada hora, al terminar cada ejecución y al cambiar el ajuste.

Todos los datos viven en `data/` (`agentforge.db`, `secret.key`, `workspace/`). Borrar esa carpeta deja la
aplicación como recién instalada.

## Qué incluye

- **Panel** con cifras reales: ejecuciones, tasa de éxito, duración media, tokens, actividad de 14 días,
  ejecuciones en curso (en vivo), salud de los proveedores, agentes y herramientas más usados.
- **Agentes**: editor con proveedor/modelo (lista real del proveedor), temperatura, límites, razonamiento,
  instrucciones y herramientas; **banco de pruebas** con respuesta en streaming.
- **Workflows**: constructor visual (Vue Flow) con paleta, inspector, plantillas `{{input}}`,
  `{{upstream}}`, `{{id_nodo}}`, validación en vivo (ciclos, referencias, agentes eliminados…).
  Nodos: entrada, agente, herramienta, condición (ramas sí/no), transformación y salida.
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
  src/engine    agent-runner, workflow-engine, run-manager
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

- El servidor escucha solo en `127.0.0.1` y rechaza peticiones con un `Host` ajeno (DNS rebinding).
  **No tiene autenticación**: no lo expongas a una red sin ponerle delante un proxy con control de acceso.
- Las API keys se cifran en reposo (AES-256-GCM) y la API nunca las devuelve.
- Las herramientas de red bloquean por defecto localhost y redes privadas (SSRF), también en redirecciones y
  en cualquier notación de la dirección (IPv4 mapeada en IPv6, decimal, NAT64…). La conexión se hace siempre a la
  IP que se validó (**fijación de DNS**), así que un DNS malicioso no puede cambiarla entre la comprobación y la
  conexión (DNS rebinding).
- Las herramientas de archivos están confinadas a `data/workspace`.
- `run_javascript` está desactivada por defecto. Cuando se activa, el código corre con dos capas de aislamiento:
  un contexto `node:vm` vacío (sin `require`, `process`, `fetch`, temporizadores ni `eval`) dentro de un **proceso
  hijo** lanzado con el modelo de permisos de Node (`--permission`) y sin variables de entorno, con límites de
  tiempo (5 s), memoria (64 MB) y tamaño de salida.
  **Lo que NO es:** no es un aislamiento fuerte. `node:vm` no está diseñado para código hostil; el modelo de
  permisos impide leer o escribir archivos, lanzar programas y crear workers, pero **en Node 22–24 no restringe
  la red** (un código que escapara del contexto podría hacer peticiones, incluso a tu red local); y no hay
  aislamiento del sistema operativo (contenedor, usuario sin privilegios, seccomp). Para ejecutar código de
  terceros no confiables hace falta un contenedor o una máquina virtual, que este proyecto no incluye.
- La salida de los modelos se renderiza como Markdown saneado con DOMPurify.

## Limitaciones conocidas

Ver la sección «Pendiente y limitaciones» de [PROGRESS.md](PROGRESS.md).
