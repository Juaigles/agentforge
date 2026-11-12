# AgentForge — Plan

Plataforma web local para crear, gestionar y ejecutar sistemas de agentes de IA.

## Objetivos

1. Crear agentes (rol, modelo, instrucciones, herramientas) y ejecutarlos contra un modelo real.
2. Coordinar varios agentes en workflows (DAG) con ejecución secuencial y paralela.
3. Persistir todo (agentes, proveedores, workflows, ejecuciones, eventos) y sobrevivir a reinicios.
4. Observar las ejecuciones en tiempo real; cancelar, reintentar y limitar.
5. Funcionar 100 % en local con software libre (Ollama); APIs compatibles con OpenAI como opción.

## Arquitectura

```
shared/   Tipos del dominio, motor de plantillas {{ref}} y validación de grafos (usado por server y web)
server/   Node 24 + TypeScript (tsx) + Fastify 5 + node:sqlite
  db/        esquema, migraciones (PRAGMA user_version) y Store (repositorios)
  crypto/    cifrado AES-256-GCM de API keys en reposo
  llm/       adaptadores: Ollama nativo (/api/chat, NDJSON) y OpenAI-compatible (/chat/completions, SSE)
  tools/     registro extensible + herramientas integradas + herramientas HTTP personalizadas (BD)
  engine/    agent-runner (bucle LLM↔herramientas), workflow-engine (planificador DAG), run-manager (cola, cancelación, eventos)
  routes/    API REST + SSE
web/      Vue 3 + Vite + Pinia + Vue Router + Vue Flow
```

### Decisiones clave

| Decisión | Motivo |
|---|---|
| `node:sqlite` (integrado en Node 24) | Sin binarios nativos que compilar en Windows; SQLite con WAL es suficiente para uso local. |
| SSE en lugar de WebSocket | El flujo es unidireccional (servidor→cliente); SSE reconecta solo y admite `Last-Event-ID` para reanudar. |
| Eventos persistidos con `seq` por ejecución | El historial se reproduce igual que el directo; los *deltas* de tokens son transitorios (no se guardan). |
| Ejecución de agente = workflow de un nodo | Un único motor y un único camino de código para límites, reintentos, cancelación y eventos. |
| Snapshot del workflow y agentes en cada run | El historial es reproducible aunque luego se edite el workflow. |
| Clientes LLM propios sobre `fetch` | Control total de streaming, tool-calls y errores; sin SDKs de pago ni dependencias pesadas. |
| El servidor escucha en 127.0.0.1 | Seguridad razonable por defecto: no se expone a la red. |

### Modelo de ejecución

- Workflow = nodos (`input`, `agent`, `tool`, `condition`, `transform`, `foreach`, `subworkflow`, `approval`,
  `output`) + aristas.
- Un nodo está listo cuando todos sus padres han terminado. Se ejecuta si al menos una arista entrante está activa
  y ningún padre ha fallado; si no, se marca `skipped` (rama no tomada o dependencia fallida).
- Los nodos listos se lanzan en paralelo hasta `maxConcurrency`.
- Los resultados se comparten mediante plantillas: `{{input}}`, `{{upstream}}`, `{{id_nodo}}`.
- Límites por run: duración máxima, nº máximo de llamadas LLM, iteraciones por agente, timeout y reintentos por nodo
  (backoff exponencial). Política de error `fail` (aborta) o `continue`.
- Cancelación con `AbortController` propagado hasta el `fetch` del LLM y las herramientas.

## Tareas

- [x] T0 Inspección del entorno
- [x] T1 Base del monorepo, tipos compartidos, plantillas y validación de grafo
- [x] T2 Persistencia (SQLite + Store + cifrado de secretos)
- [x] T3 Adaptadores LLM (Ollama, OpenAI-compatible)
- [x] T4 Sistema de herramientas (integradas + HTTP personalizadas)
- [x] T5 Motor: agent-runner, workflow-engine, run-manager
- [x] T6 API REST + SSE + datos de ejemplo (seed)
- [x] T7 Tests del backend (unidad, protocolo, motor, API, persistencia)
- [x] T8 Verificación con modelo real (Ollama)
- [x] T9 Frontend: sistema de diseño, layout, API client, stores
- [x] T10 Vistas: Dashboard, Agentes (+playground), Workflows (constructor visual), Ejecuciones (monitor), Herramientas, Ajustes
- [x] T11 Verificación end-to-end en navegador + reinicio
- [x] T12 Revisión crítica, endurecimiento, documentación final

Prioridad seguida: T1→T8 (núcleo verificable) antes que la interfaz; después T9→T11; T12 continuo.

- [x] T13 Suite end-to-end (Playwright) y tests de componentes
- [x] T14 Vistas de Herramientas/Ajustes ejercitadas y completadas
- [x] T15 Glosario completo con test de coherencia
- [x] T16 Robustez: retención, SSRF con IP fijada, reanudación, sandbox en proceso aparte
- [x] T17 Nodo «para cada», exportar/importar y ejecución programada

Todas las tareas están completadas. Lo que queda fuera de alcance está en `PROGRESS.md` ("Pendiente y limitaciones").

## Hito 5 — Llevarlo a primer nivel

Punto de partida: commit `8bef427`, con 203 tests de servidor, 40 de frontend y 43 e2e (Chromium) en verde,
`typecheck` limpio y `npm audit` con 0 vulnerabilidades (medido el 2026-11-11).

### Auditoría inicial (solo lectura, siete subagentes en paralelo)

Los informes completos, con archivo y línea, están fuera del repositorio, en la carpeta de notas de la sesión
(`auditoria-*.md`). Recuento de hallazgos:

| Auditoría | Crítico | Alto | Medio | Bajo |
|---|---|---|---|---|
| Seguridad | 0 | 2 | 4 | 11 |
| Corrección y deuda técnica | 0 | 3 | 18 | 19 |
| Rendimiento y escalabilidad | 1 | 6 | 10 | 8 |
| Cobertura de tests | 3 | 10 | 18 | 8 |
| Accesibilidad WCAG 2.1 AA | 2 | 8 | 13 | 22 |
| UX y diseño | 3 | 11 | 16 | 12 |
| Documentación y operación | 1 | 8 | 14 | 10 |

Críticos y altos, agrupados por causa (varios informes señalan lo mismo):

- **Ciclo de vida de las ejecuciones.** El apagado ordenado (Ctrl+C, `SIGTERM`) deja las ejecuciones como
  «canceladas por el usuario» y no reanudables; `safeFetch` se cuelga para siempre si una respuesta comprimida se
  corta, y con ello la ejecución y el propio apagado; un `timeoutMs` fuera de rango o un error de SQLite al cerrar
  una ejecución dejan pasos «en curso» o tumban el proceso; no hay plazo de apagado ni manejadores de proceso.
- **Secretos y exposición.** `POST /api/providers/test|models` y `PUT /api/providers/:id` envían la API key
  guardada a la URL que indique quien llama; `HOST=0.0.0.0` anula la comprobación de `Host`; sin autenticación,
  `Origin`, CSP ni límite de tasa; un agente con redes privadas permitidas puede llamar a la propia API; las
  credenciales se reenvían al seguir redirecciones a otro origen; la condición `matches` admite ReDoS que congela
  el servidor; las cabeceras de las herramientas HTTP se guardan en claro.
- **Rendimiento.** `stats()` recorre `runs` tres veces por petición (0,76 s con 20 000 ejecuciones) y el panel la
  pide tras cada paso; los listados arrastran `input`/`output` completos; la retención recorre la tabla en cada
  ejecución terminada y el archivo no encoge; faltan índices; el Markdown se renderiza entero por cada token;
  expresiones regulares cuadráticas sobre HTML ajeno en `web_fetch`.
- **Pruebas.** Sin CI ni cobertura; migraciones con un único test; saneado de Markdown sin test contra XSS;
  `useRunStream`, `lib/api.ts`, cuatro modales y las vistas grandes sin tests; e2e solo en Chromium.
- **Interfaz.** Con teclado no se puede abrir un nodo ya creado ni conectar dos nodos existentes; los modales no
  atrapan el foco; `--text-3` y los bordes de campo no alcanzan el contraste AA; el constructor no tiene
  deshacer/rehacer y borra al instante; se pierde trabajo al cerrar la pestaña o un modal; la primera sesión sin
  Ollama no guía; si el servidor cae, la interfaz sigue diciendo que todo va bien; el historial no escala.
- **Documentación y operación.** Sin licencia, referencia de la API, guías de usuario, de arquitectura ni de
  solución de problemas; sin `Dockerfile`, copia de seguridad, métricas ni registro por defecto; la configuración
  no se valida; nada impide dos instancias sobre la misma carpeta de datos.

### Fases

Un solo escritor por fase (los archivos bisagra son `shared/types.ts`, `server/src/db/store.ts`,
`server/src/routes/api.ts` y `web/src/lib/api.ts`). Cada fase termina con las cuatro baterías en verde,
verificación en el navegador y con Ollama real donde aplique, `PROGRESS.md` y `TEST_RESULTS.md` con resultados
reales y un commit local.

- [x] **F1 · Fiabilidad y seguridad del servidor.** Apagado que deja las ejecuciones interrumpidas y
  reanudables, con plazo y manejadores de proceso; `safeFetch` sin cuelgues y carrera con la señal en el motor;
  configuración de nodos validada (`timeoutMs`, reintentos) y `executeNode` que nunca deja pasos huérfanos;
  consulta de `/api/runs` validada; base de datos de versión superior rechazada y copia previa a migrar; bloqueo
  de instancia única. Claves ligadas a su origen; comprobación de `Host` siempre activa con
  `AGENTFORGE_ALLOWED_HOSTS`; autenticación por token obligatoria fuera de loopback; comprobación de `Origin` y
  `Sec-Fetch-Site`; cabeceras de seguridad y CSP; límite de tasa; bloqueo de la propia API desde las herramientas;
  cabeceras retiradas en redirecciones a otro origen; `matches` evaluada en un `Worker` con límite de tiempo;
  escape JSON en `bodyTemplate`; reintentos solo de errores marcados; cuota del espacio de trabajo;
  `run_javascript` sin red (permiso de red donde exista, comprobado al arrancar, y backend de contenedor
  Docker/Podman seleccionable en Ajustes); test de rebinding contra un servidor DNS local real; configuración
  validada; registro estructurado siempre activo; salud `live`/`ready`.
  *Hecho el 2026-11-11 (detalle en `PROGRESS.md`, «Hito 5 · Fase 1»). Lo que se movió a otra fase: cifrar las
  cabeceras con credenciales de las herramientas HTTP (F5), `parseList` y el adaptador OpenAI (F3), las
  expresiones regulares cuadráticas de `web_fetch` y el resto de rendimiento (F2).*
- [x] **F2 · Datos y rendimiento.** Índices y columnas ligeras en los listados; estadísticas incrementales o
  cacheadas; retención acotada, por lotes y con `VACUUM`; `synchronous=NORMAL`; SSE con contrapresión; copia de
  seguridad y restauración de `data/` desde la interfaz; memoria compartida persistida; prueba de carga
  reproducible con cifras medidas antes y después.
  *Hecho el 2026-11-11 (detalle y cifras en `PROGRESS.md`, «Hito 5 · Fase 2»). Queda para más adelante: un tope
  global de llamadas simultáneas al modelo y de la cola, un único canal SSE compartido entre pestañas, deduplicar
  las instantáneas y un grupo de procesos precalentados para `run_javascript`.*
- [x] **F3 · Motor.** Registro de tipos de nodo con esquemas en `shared/`; identidad de paso por ruta;
  subworkflows; «para cada» con cuerpo de subworkflow o de herramienta, política por elemento y reutilización de
  elementos completados al reintentar; nodo de aprobación humana (ejecución en espera que sobrevive a un
  reinicio); texto parcial de un paso cancelado persistido; reanudación automática opcional; `parseList`
  tolerante a prosa; adaptador OpenAI que detecta respuestas cortadas; fechas en hora local.
  *Hecho el 2026-11-11 (detalle en `PROGRESS.md`, «Hito 5 · Fase 3»). No se ha hecho el registro único de
  tipos de nodo con esquemas compartidos (la configuración se valida en el servidor y en `shared/graph.ts`), ni
  la identidad de paso por ruta: un subworkflow es una ejecución propia enlazada con la que la lanza.*
- [x] **F4 · Disparadores y MCP.** Tabla de disparadores: cron, días de la semana, zona horaria, varios por
  workflow y webhooks locales con secreto; cliente MCP (stdio y HTTP) como tercera fuente de herramientas.
  *Hecho el 2026-11-11 (detalle en `PROGRESS.md`, «Hito 5 · Fase 4»). Del cliente MCP quedan fuera los recursos,
  las plantillas de prompt y el inicio de sesión OAuth; los disparadores no viajan en la exportación de un
  workflow (pasa a F5).*
- [x] **F5 · Portabilidad.** Exportar herramientas HTTP y proveedores sin claves; importación atómica con
  pantalla de resolución de conflictos; exportar e importar agentes sueltos.
  *Hecho el 2026-11-12 (detalle en `PROGRESS.md`, «Hito 5 · Fase 5»). Añadido sobre lo previsto: subworkflows y
  disparadores en el archivo, y cifrado de las cabeceras con credenciales. No viajan los servidores MCP ni el
  historial.*
- [x] **F6 · Interfaz.** Accesibilidad AA completa (constructor operable con teclado, trampa de foco, contraste,
  foco y anuncios); constructor con deshacer/rehacer, atajos, copiar/pegar y alineación automática; protección
  frente a pérdida de trabajo; primera sesión guiada; estado de conexión real; historial con filtros en la URL,
  paginación, búsqueda en el contenido y comparación de ejecuciones; pulido visual y tokens de tipografía y
  espaciado; datos de ejemplo corregidos (agente «Redactor»).
  *Hecho el 2026-11-12 (detalle en `PROGRESS.md`, «Hito 5 · Fase 6»). Resueltos los 2 críticos y los 8 altos de
  accesibilidad y los 3 críticos de UX. **No se ha hecho** y queda anotado en «Pendiente y limitaciones»: la
  comparación de ejecuciones y los filtros por workflow, agente y fecha; los tokens de tipografía y espaciado;
  el inspector superpuesto en ventanas estrechas; «guardar y ejecutar» en el banco de pruebas; el menú contextual
  del lienzo; y varios hallazgos medios y bajos de las dos auditorías (lista completa en `PROGRESS.md`).*
- [x] **F7 · Inglés además de español.** Códigos de error con parámetros desde el servidor, `vue-i18n`, formato
  dependiente del idioma y selector de idioma.
  *Hecho el 2026-11-12 (detalle en `PROGRESS.md`, «Hito 5 · Fase 7»). Toda la interfaz está en los dos idiomas
  (unas 1 330 claves en 32 ámbitos), con el glosario y la validación de workflows. **Siguen solo en español** los
  textos que escribe el servidor: mensajes concretos de error y de validación de formularios, errores de las
  ejecuciones, títulos y descripciones de las herramientas integradas, datos de ejemplo y la documentación.*
- [x] **F8 · Calidad y pruebas.** ESLint y Prettier limpios; cobertura con umbrales; tests de componentes para
  `ProviderModal`, `ToolEditorModal`, `ScheduleModal` y el constructor; tests de migraciones, de saneado de
  Markdown y de los huecos altos de la auditoría; suite e2e en Firefox y WebKit; archivo de CI listo, sin publicar.
  *Hecho el 2026-11-12 (detalle en `PROGRESS.md`, «Hito 5 · Fase 8»). `ScheduleModal` ya no existe (lo sustituyó
  `TriggersModal`, que sí tiene tests). **No se ha hecho**: tests de componente del constructor y de las vistas
  grandes (Panel, Ajustes, Herramientas, monitor), que siguen cubiertas solo por la suite e2e —de ahí que la
  cobertura medida del frontend sea del 40 %—; y el archivo de CI no se ha ejecutado nunca.*
- [x] **F9 · Operación y documentación.** Métricas, `Dockerfile` local, OpenAPI, guía de usuario, guía de
  arquitectura, solución de problemas, `CHANGELOG.md`, licencia y política de seguridad.
  *Hecho el 2026-11-12 (detalle en `PROGRESS.md`, «Hito 5 · Fase 9»). La licencia se añadió en la 1.0.0 (MIT,
  elegida por el autor). **Sin verificar**: el `Dockerfile` no se ha construido (el
  motor de Docker seguía apagado).*
- [x] **F10 · Segunda auditoría e iteración** hasta que no quede nada crítico, alto ni medio, o lo que quede sea
  imposible con las reglas del encargo.
  *Hecho el 2026-11-12 (detalle en `PROGRESS.md`, «Hito 5 · Fase 10», e informe en `docs/informe-hito5.md`).
  Cuatro auditorías nuevas: 0 críticos, 5 altos y unos 31 medios. Los 5 altos y la mayoría de los medios están
  corregidos con su test. **El objetivo no se ha alcanzado del todo**: quedan medios sin resolver (el monitor con
  ejecuciones muy largas, el remontaje al primer guardado, la deuda de estructura, lo que escribe el servidor en
  español) y casi todos los bajos. No eran imposibles con las reglas: no se han hecho.*

Condicionantes del entorno comprobados: Node 24.19 no tiene `--allow-net`, así que el permiso de red no corta
la red de `run_javascript` en esta máquina; Docker 29.7 está instalado pero su demonio estaba apagado al empezar.

## Cómo retomar el trabajo

1. `npm install && npm test && npm run test:e2e` para confirmar que el entorno funciona.
2. Leer `PROGRESS.md` (estado y limitaciones) y `git log --oneline` (hitos).
3. El punto de entrada del servidor es `server/src/index.ts`; el del frontend, `web/src/main.ts`.
