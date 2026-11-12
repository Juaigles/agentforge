# Registro de cambios

Todos los cambios relevantes de AgentForge. El formato sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/)
y las versiones, [SemVer](https://semver.org/lang/es/). El proyecto no se ha publicado: las versiones marcan hitos
del desarrollo local, cada uno con sus commits. El detalle de cada hito, con lo verificado y lo que no, está en
[PROGRESS.md](PROGRESS.md) y [TEST_RESULTS.md](TEST_RESULTS.md).

## [1.0.0] — 2026-11-12 · Cierre de la primera versión

Pasada de cierre sobre el hito 5. Las baterías y la verificación con Ollama, en `TEST_RESULTS.md`.

### Añadido

- **Monitor**: los eventos de una ejecución se piden por páginas (`GET /api/runs/:id/events` con `after`, `before`
  y `limit`) y la actividad se construye de forma incremental; se muestran las entradas más recientes con «Cargar
  anteriores». El estado de los pasos lo entrega el servidor ya calculado (`lastSeq`).
- **Historial**: filtros por workflow, por agente y por intervalo de fechas, sincronizados con la dirección.
- **Editor de agentes**: «Guardar y ejecutar» en el banco de pruebas.
- **Idiomas**: los textos que escribe el servidor (errores de validación y de la API, motivo de fallo de una
  ejecución o de un paso, avisos de importación) viajan con código y parámetros y la interfaz los traduce; las
  herramientas integradas se muestran en el idioma activo.

### Cambiado

- El primer guardado de un agente o de un workflow nuevo ya no vuelve a montar la pantalla: se conservan deshacer,
  selección y foco.
- Un workflow nuevo sin tocar ya no aparece como «Sin guardar».
- El filtro «En curso» del historial incluye las ejecuciones en cola y en espera.
- `GET /api/runs/:id/stream` valida `after` y `Last-Event-ID` (400 si no son válidos).
- Esquema de la base de datos v7 (referencia traducible del error en ejecuciones, pasos y disparadores).

### Sin hacer

- Licencia MIT (`LICENSE`), declarada también en los `package.json`.

### Sin hacer

- Publicación, imagen de contenedor construida y proveedores de pago probados: ver «Pendiente y
  limitaciones» en `PROGRESS.md`.

## [0.5.0] — 2026-11-12 · Hito 5: llevarlo a primer nivel

Diez fases, cada una cerrada con sus baterías y un commit (el detalle y las excepciones, en `TEST_RESULTS.md`).

### Añadido

- **Motor**: subworkflows; «para cada» con cuerpo de agente, herramienta o subworkflow, política por elemento y
  reutilización de elementos al reintentar; nodo de aprobación humana que sobrevive a un reinicio; reanudación
  automática opcional; texto parcial de los pasos cancelados.
- **Disparadores**: intervalo, días y hora, cron con zona horaria y cambio de hora, varios por workflow, y webhooks
  con secreto propio.
- **Cliente MCP** (stdio y HTTP) como tercera fuente de herramientas.
- **Portabilidad**: exportación completa (subworkflows, herramientas HTTP, proveedores y disparadores, sin
  secretos), importación atómica con revisión previa y resolución de conflictos, agentes sueltos.
- **Copias de seguridad** y restauración desde la interfaz.
- **Interfaz**: deshacer y rehacer, copiar y pegar, ordenado automático y atajos en el constructor; manejo completo
  con teclado; guía de primeros pasos; estado real de la conexión con el servidor; filtros del historial en la
  dirección; aviso al eliminar un agente en uso.
- **Inglés además de español**, con formatos de número y fecha por idioma y selector de idioma.
- **Operación**: registro estructurado, sondas `live` y `ready`, métricas, validación de la configuración,
  bloqueo de instancia única, apagado ordenado con plazo, `Dockerfile`, especificación OpenAPI.
- **Documentación**: guía de usuario, guía de arquitectura, solución de problemas, referencia de la API, este
  registro, política de seguridad y guía de contribución.
- **Calidad**: ESLint y Prettier, cobertura con umbrales, tests de componentes de los diálogos principales (disparadores, importación, proveedor, servidores MCP y editor de herramientas), suite
  end-to-end en Chromium, Firefox y WebKit, y archivo de integración continua (sin estrenar).

### Cambiado

- **Seguridad**: clave de acceso obligatoria fuera de este equipo; comprobación de `Host` siempre activa y de
  origen; cabeceras de seguridad y CSP; límite de tasa; API keys ligadas a su dirección; cabeceras con credenciales
  cifradas; `run_javascript` sin red y con contenedor opcional; expresiones regulares de las condiciones con límite
  de tiempo.
- **Rendimiento**: estadísticas incrementales, índices, búsqueda de texto completo, retención por tandas con
  compactación, SSE con contrapresión y fragmentos agrupados.
- **Accesibilidad**: trampa de foco en los diálogos, contraste AA, anuncios para lectores de pantalla, avisos de
  error persistentes, enlace para saltar al contenido.
- La validación de workflows y los errores de la API llevan un **código estable** además del texto.
- El apagado ordenado deja las ejecuciones **interrumpidas y reanudables** (antes quedaban como canceladas).
- El agente de ejemplo «Redactor» ya no fuerza un informe ejecutivo.

### Corregido

Veintitantos defectos encontrados por los tests y por la verificación en el navegador; están numerados en
«Problemas encontrados y resueltos» y en cada fase de [PROGRESS.md](PROGRESS.md). Los más relevantes: ejecuciones
que quedaban «en curso» para siempre al cortarse el flujo en vivo, un 429 interpretado como servidor caído,
descargas canceladas en equipos cargados, orden aleatorio en listados creados en el mismo milisegundo y claves de
API enviadas a una dirección distinta de la guardada.

### Datos

El esquema de la base de datos pasa de v3 a v6. Se actualiza solo al arrancar y antes guarda una copia
(`agentforge.db.v<N>.bak`). No hay marcha atrás automática: ver «Actualizar a una versión nueva» en el README.

### Sin verificar

Ver también [docs/informe-hito5.md](docs/informe-hito5.md), con lo que sigue débil.

Proveedores de pago reales, el contenedor (Docker estaba apagado), el archivo de integración continua, un lector
de pantalla real y la revisión del inglés por una persona nativa. Lista completa en `TEST_RESULTS.md`, sección 4.

## [0.4.0] — 2026-11-10 · Hito 4: endurecimiento

- Suite end-to-end con Playwright y tests de componentes contra la API real.
- Herramientas, Ajustes y proveedores ejercitados de punta a punta.
- Glosario integrado con test de coherencia.
- Retención del historial, protección SSRF con la IP fijada, reanudación de ejecuciones interrumpidas y
  `run_javascript` en un proceso aparte.
- Nodo «para cada», exportar e importar workflows y ejecución programada.

## [0.1.0] — 2026-11-09 · Primera versión

- Servidor: persistencia en SQLite, adaptadores de Ollama y de API compatibles con OpenAI, once herramientas
  integradas y herramientas HTTP personalizadas, motor de workflows (paralelismo, ramas, reintentos, límites,
  cancelación), API REST y eventos en vivo.
- Interfaz: panel, agentes con banco de pruebas, constructor visual, monitor en vivo, herramientas y ajustes.
